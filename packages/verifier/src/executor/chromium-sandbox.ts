import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChromiumSandboxAttestationSchema, evaluateChromiumSandbox, type ChromiumSandboxAttestation, type ChromiumSandboxProcess, type ChromiumSandboxVerdict } from "@agentx/contracts";

const LIST_TIMEOUT_MS = 15_000;
const POLL_MS = 100;

/** The Chromium processes the browser reports through DevTools: its own pid (null when it names none) and every renderer's. */
export type ChromiumProcessListing = Readonly<{ browserPid: number | null; rendererPids: readonly number[] }>;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Resolves after `ms`, or at once when `signal` aborts; the one listener it adds is removed either way. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export type ChromiumProcessLister = Readonly<{ list(): Promise<ChromiumProcessListing>; close(): Promise<void> }>;

/**
 * A DevTools session that lists a running Chromium's processes. It opens one blank tab, so a renderer exists, and keeps that tab and the connection for every
 * `list()`, which polls `SystemInfo.getProcessInfo` until a renderer shows (at most `listTimeoutMs`). Looking again therefore sees the same renderers instead of
 * spawning a new one each time. The pids are those of the browser's own PID namespace, which is the namespace this process reads `/proc` in. Every wait is
 * bounded: a reply that never comes, a cancelled `signal` and a connection that never opens each reject, and `close()` removes the blank tab (best effort).
 */
export function openChromiumProcessLister(cdpEndpoint: string, signal: AbortSignal, listTimeoutMs = LIST_TIMEOUT_MS): ChromiumProcessLister {
  const socket = new WebSocket(cdpEndpoint);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  let targetId: string | undefined;
  const stopped = () => (signal.reason instanceof Error ? signal.reason : new Error("listing Chromium's processes was cancelled"));
  const failAll = (error: Error) => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  let rejectOpen: (error: Error) => void = () => undefined;
  const opened = new Promise<void>((resolve, reject) => { rejectOpen = reject; socket.addEventListener("open", () => resolve(), { once: true }); });
  opened.catch(() => undefined);
  // One listener for the whole session; everything waiting is rejected when the caller stops, and none of it can hang past that.
  const onAbort = () => { failAll(stopped()); rejectOpen(stopped()); };
  signal.addEventListener("abort", onAbort, { once: true });
  socket.addEventListener("message", (event) => {
    try {
      const reply = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof reply.id !== "number") return;
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      if (reply.error) entry.reject(new Error(`DevTools ${reply.error.message ?? "error"}`)); else entry.resolve(reply.result);
    } catch { /* not a reply */ }
  });
  socket.addEventListener("close", () => { failAll(new Error("DevTools connection closed")); rejectOpen(new Error("DevTools connection closed")); });
  socket.addEventListener("error", () => { failAll(new Error("DevTools connection failed")); rejectOpen(new Error("DevTools connection failed")); });
  const call = <T>(method: string, params: Record<string, unknown>, timeoutMs: number, ignoreAbort = false): Promise<T> => new Promise<T>((resolve, reject) => {
    if (signal.aborted && !ignoreAbort) { reject(stopped()); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools ${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value as T); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });

  async function list(): Promise<ChromiumProcessListing> {
    const end = Date.now() + listTimeoutMs;
    const connectTimer = new AbortController();
    const connectTimeout = setTimeout(() => connectTimer.abort(), listTimeoutMs);
    try {
      await Promise.race([opened, new Promise<never>((_, reject) => connectTimer.signal.addEventListener("abort", () => reject(new Error("timed out connecting to DevTools")), { once: true }))]);
    } finally { clearTimeout(connectTimeout); }
    if (targetId === undefined) targetId = (await call<{ targetId?: string }>("Target.createTarget", { url: "about:blank" }, listTimeoutMs)).targetId;
    for (;;) {
      const info = await call<{ processInfo?: { type?: string; id?: number }[] }>("SystemInfo.getProcessInfo", {}, Math.max(1, end - Date.now()));
      const processes = info.processInfo ?? [];
      const rendererPids = processes.filter((item) => item.type === "renderer" && Number.isInteger(item.id) && item.id! > 0).map((item) => item.id!);
      if (rendererPids.length > 0) {
        const browser = processes.find((item) => item.type === "browser");
        return { browserPid: browser && Number.isInteger(browser.id) && browser.id! > 0 ? browser.id! : null, rendererPids };
      }
      if (signal.aborted) throw stopped();
      if (Date.now() >= end) throw new Error("no renderer process showed up in Chromium's process list");
      await pause(POLL_MS, signal);
    }
  }

  async function close(): Promise<void> {
    signal.removeEventListener("abort", onAbort);
    // The blank tab only made a renderer exist; the browser is left as it was found. Closing it is attempted even after the caller stopped.
    if (targetId !== undefined && socket.readyState === WebSocket.OPEN) await call("Target.closeTarget", { targetId }, 2_000, true).catch(() => undefined);
    socket.close();
  }
  return { list, close };
}

/** One listing in a session of its own: connect, list, close. */
export async function listChromiumProcesses(cdpEndpoint: string, signal: AbortSignal, timeoutMs = LIST_TIMEOUT_MS): Promise<ChromiumProcessListing> {
  const lister = openChromiumProcessLister(cdpEndpoint, signal, timeoutMs);
  try { return await lister.list(); } finally { await lister.close(); }
}

/**
 * What `/proc/<pid>` shows for one process, as the contracts name it. Anything the kernel does not show (no procfs, a kernel older than Linux 5.9 without
 * `Seccomp_filters`) throws: an unverifiable sandbox is not a sandbox.
 */
export async function readChromiumProcessFacts(pid: number, procRoot = "/proc"): Promise<ChromiumSandboxProcess> {
  const read = async (file: string): Promise<string> => {
    try { return await readFile(join(procRoot, String(pid), file), "utf8"); }
    catch (error) { throw Object.assign(new Error(`cannot read ${procRoot}/${pid}/${file}: ${message(error)}`), { code: (error as NodeJS.ErrnoException).code }); }
  };
  const status = await read("status");
  const line = (name: string) => status.split("\n").find((item) => item.startsWith(`${name}:`))?.slice(name.length + 1).trim();
  const nspid = line("NSpid");
  const filters = line("Seccomp_filters");
  if (nspid === undefined || !/^\d+(\s+\d+)*$/.test(nspid)) throw new Error(`${procRoot}/${pid}/status does not report NSpid`);
  if (filters === undefined || !/^\d+$/.test(filters)) throw new Error(`${procRoot}/${pid}/status does not report Seccomp_filters (the kernel must be Linux 5.9 or newer)`);
  const uidMap = (await read("uid_map")).trim().split("\n").map((row) => row.trim().split(/\s+/).join(" ")).join(";");
  return { pid, nsPidDepth: nspid.split(/\s+/).length, seccompFilters: Number(filters), uidMap };
}

export type InspectChromiumSandboxInput = Readonly<{ cdpEndpoint: string; /** The pid the executor launched; used when DevTools names no browser process. */ browserPid: number;
  runId: string; groupId: string; signal: AbortSignal;
  /** Test seams: another procfs, and a process listing that does not need a live browser. */
  procRoot?: string; listProcesses?: (cdpEndpoint: string, signal: AbortSignal) => Promise<ChromiumProcessListing> }>;

/**
 * Looks at the renderer processes of a launched Chromium and records what the kernel shows about them next to what it shows about the browser. It judges
 * nothing: `evaluateChromiumSandbox` does, and the same bytes are what the registrar re-judges for the `chromium-sandbox-v1` qualification probe.
 */
export async function inspectChromiumSandbox(input: InspectChromiumSandboxInput): Promise<ChromiumSandboxAttestation> {
  const listing = await (input.listProcesses ?? listChromiumProcesses)(input.cdpEndpoint, input.signal);
  const procRoot = input.procRoot ?? "/proc";
  const browser = await readChromiumProcessFacts(listing.browserPid ?? input.browserPid, procRoot);
  const renderers: ChromiumSandboxProcess[] = [];
  for (const pid of listing.rendererPids) {
    try { renderers.push(await readChromiumProcessFacts(pid, procRoot)); }
    // A renderer that exited since the listing says nothing either way; one that cannot be read for another reason does.
    catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
  }
  return ChromiumSandboxAttestationSchema.parse({ schemaVersion: "e2e-executor-chromium-sandbox/v1", runId: input.runId, groupId: input.groupId, browser, renderers });
}

export type SettledChromiumSandbox = Readonly<{ attestation: ChromiumSandboxAttestation; verdict: ChromiumSandboxVerdict }>;

/**
 * A renderer is listed by the browser as soon as it exists, which can be before it has installed its own seccomp filter, so one look can catch a sandboxed
 * renderer half-started. This looks again, every `pollMs` for up to `settleMs`, until the evaluator accepts what it sees; a renderer that never shows a
 * sandbox is still refused, with the last facts seen. A read that fails is retried the same way and its last error thrown if nothing was ever read.
 */
export async function attestWhenSettled(input: InspectChromiumSandboxInput, options: Readonly<{ settleMs: number; pollMs?: number;
  /** Test seam: one look at the browser. The default is `inspectChromiumSandbox` over one DevTools session shared by every look. */ inspect?: (input: InspectChromiumSandboxInput) => Promise<ChromiumSandboxAttestation> }>): Promise<SettledChromiumSandbox> {
  // One session, one blank tab for every look: a freshly spawned renderer is not caught half-started again each time.
  const lister = options.inspect === undefined && input.listProcesses === undefined ? openChromiumProcessLister(input.cdpEndpoint, input.signal, Math.max(1_000, options.settleMs)) : null;
  const inspect = options.inspect ?? (lister === null ? inspectChromiumSandbox : (request: InspectChromiumSandboxInput) => inspectChromiumSandbox({ ...request, listProcesses: () => lister.list() }));
  const end = Date.now() + options.settleMs;
  let last: SettledChromiumSandbox | null = null;
  let lastError: unknown = null;
  try {
    for (;;) {
      try {
        const attestation = await inspect(input);
        const verdict = evaluateChromiumSandbox(attestation);
        last = { attestation, verdict };
        if (verdict.sandboxed) return last;
      } catch (error) { lastError = error; }
      if (Date.now() >= end || input.signal.aborted) break;
      await pause(Math.min(options.pollMs ?? 200, Math.max(0, end - Date.now())), input.signal);
    }
  } finally { await lister?.close(); }
  if (last !== null) return last;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
