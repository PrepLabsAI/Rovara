import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChromiumSandboxAttestationSchema, type ChromiumSandboxAttestation, type ChromiumSandboxProcess } from "@agentx/contracts";

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
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  let targetId: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) { resolve(); return; }
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("DevTools connection failed")), { once: true });
      deadline.addEventListener("abort", () => reject(new Error("timed out connecting to DevTools")), { once: true });
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
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
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
