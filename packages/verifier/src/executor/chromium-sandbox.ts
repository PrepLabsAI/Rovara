import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChromiumSandboxAttestationSchema, evaluateChromiumSandbox, type ChromiumSandboxAttestation, type ChromiumSandboxProcess, type ChromiumSandboxVerdict } from "@agentx/contracts";

const LIST_TIMEOUT_MS = 15_000;
const POLL_MS = 100;

/** The Chromium processes the browser reports through DevTools: its own pid (null when it names none) and every renderer's. */
export type ChromiumProcessListing = Readonly<{ browserPid: number | null; rendererPids: readonly number[] }>;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Asks a running Chromium for its renderer processes over its browser DevTools endpoint: opens a blank tab, so a renderer exists, and polls
 * `SystemInfo.getProcessInfo` until one shows. The pids are those of the browser's own PID namespace, which is the namespace this process reads `/proc` in.
 */
export async function listChromiumProcesses(cdpEndpoint: string, signal: AbortSignal, timeoutMs = LIST_TIMEOUT_MS): Promise<ChromiumProcessListing> {
  const socket = new WebSocket(cdpEndpoint);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  const failAll = (error: Error) => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
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
  socket.addEventListener("close", () => failAll(new Error("DevTools connection closed")));
  socket.addEventListener("error", () => failAll(new Error("DevTools connection failed")));
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const expired = () => (deadline.reason instanceof Error ? deadline.reason : new Error("listing Chromium's processes was cancelled or timed out"));
  // A cancelled or timed-out listing rejects every call still waiting for a reply, so none can hang past the deadline.
  const onDeadline = () => failAll(expired());
  deadline.addEventListener("abort", onDeadline, { once: true });
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => new Promise<T>((resolve, reject) => {
    if (deadline.aborted) { reject(expired()); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  let targetId: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      if (deadline.aborted) { reject(expired()); return; }
      if (socket.readyState === WebSocket.OPEN) { resolve(); return; }
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("DevTools connection failed")), { once: true });
      deadline.addEventListener("abort", () => reject(expired()), { once: true });
    });
    const created = await call<{ targetId?: string }>("Target.createTarget", { url: "about:blank" });
    targetId = created.targetId;
    for (;;) {
      const info = await call<{ processInfo?: { type?: string; id?: number }[] }>("SystemInfo.getProcessInfo");
      const processes = info.processInfo ?? [];
      const rendererPids = processes.filter((item) => item.type === "renderer" && Number.isInteger(item.id) && item.id! > 0).map((item) => item.id!);
      if (rendererPids.length > 0) {
        const browser = processes.find((item) => item.type === "browser");
        return { browserPid: browser && Number.isInteger(browser.id) && browser.id! > 0 ? browser.id! : null, rendererPids };
      }
      if (deadline.aborted) throw new Error("no renderer process showed up in Chromium's process list");
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, POLL_MS); deadline.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
    }
  } finally {
    deadline.removeEventListener("abort", onDeadline);
    // The blank tab only made a renderer exist; the browser is left as it was found.
    if (targetId !== undefined && socket.readyState === WebSocket.OPEN) await call("Target.closeTarget", { targetId }).catch(() => undefined);
    socket.close();
  }
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
  /** Test seam: one look at the browser. The default is `inspectChromiumSandbox`. */ inspect?: (input: InspectChromiumSandboxInput) => Promise<ChromiumSandboxAttestation> }>): Promise<SettledChromiumSandbox> {
  const inspect = options.inspect ?? inspectChromiumSandbox;
  const end = Date.now() + options.settleMs;
  let last: SettledChromiumSandbox | null = null;
  let lastError: unknown = null;
  for (;;) {
    try {
      const attestation = await inspect(input);
      const verdict = evaluateChromiumSandbox(attestation);
      last = { attestation, verdict };
      if (verdict.sandboxed) return last;
    } catch (error) { lastError = error; }
    if (Date.now() >= end || input.signal.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 200));
  }
  if (last !== null) return last;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
