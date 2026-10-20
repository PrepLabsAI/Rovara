import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateChromiumSandbox } from "../../packages/contracts/src/index.js";
import { attestWhenSettled, inspectChromiumSandbox, listChromiumProcesses, openChromiumProcessLister, readChromiumProcessFacts } from "../../packages/verifier/src/executor/chromium-sandbox.js";

const runId = "7f1d1c6e-4f43-4d5c-9b8f-2a6f3c0a9d11";
const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

/** What the kernel shows for a process: the `status` lines that matter, and the user namespace's uid_map. */
async function fakeProc(processes: Record<number, { nspid: number[]; seccompFilters: number | null; uidMap: string }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fake-proc-")); dirs.push(root);
  for (const [pid, facts] of Object.entries(processes)) {
    await mkdir(join(root, pid));
    await writeFile(join(root, pid, "status"), ["Name:\tchrome", `Pid:\t${pid}`, `NSpid:\t${facts.nspid.join("\t")}`, "Seccomp:\t2",
      ...(facts.seccompFilters === null ? [] : [`Seccomp_filters:\t${facts.seccompFilters}`]), "Speculation_Store_Bypass:\tthread vulnerable"].join("\n") + "\n");
    await writeFile(join(root, pid, "uid_map"), facts.uidMap);
  }
  return root;
}
const container = { nspid: [40], seccompFilters: 1, uidMap: "         0          0 4294967295\n" };
const sandboxed = { nspid: [77, 3], seccompFilters: 2, uidMap: "      1000       1000          1\n" };
/** The settle time is measured on this clock, which moves only when the code under test pauses between looks: how many looks fit in it never depends on machine load. */
const settleClock = () => { let elapsed = 0; return { now: () => elapsed, sleep: async (milliseconds: number) => { elapsed += milliseconds; } }; };
const listing = (renderers: number[], browser = 40) => async () => ({ browserPid: browser, rendererPids: renderers });

describe("reading what the kernel shows about a Chromium process", () => {
  it("reads the PID namespace depth, the seccomp filter count and a normalised uid_map", async () => {
    const procRoot = await fakeProc({ 40: container, 77: sandboxed });
    expect(await readChromiumProcessFacts(77, procRoot)).toEqual({ pid: 77, nsPidDepth: 2, seccompFilters: 2, uidMap: "1000 1000 1" });
    expect(await readChromiumProcessFacts(40, procRoot)).toEqual({ pid: 40, nsPidDepth: 1, seccompFilters: 1, uidMap: "0 0 4294967295" });
  });

  it("fails closed when the kernel does not report the filter count (Linux before 5.9) instead of guessing", async () => {
    const procRoot = await fakeProc({ 40: { ...container, seccompFilters: null } });
    await expect(readChromiumProcessFacts(40, procRoot)).rejects.toThrow(/Seccomp_filters/);
  });

  it("fails closed when there is no procfs entry at all, as on a platform without /proc", async () => {
    await expect(readChromiumProcessFacts(40, join(tmpdir(), "no-such-proc-root"))).rejects.toThrow(/cannot read/);
  });
});

describe("inspecting a launched Chromium", () => {
  const base = { cdpEndpoint: "ws://127.0.0.1:1/devtools/browser/x", browserPid: 1, runId, groupId: "group-1", signal: new AbortController().signal };

  it("attests a sandboxed browser, and the evaluator accepts it", async () => {
    const procRoot = await fakeProc({ 40: container, 77: sandboxed, 78: sandboxed });
    const attestation = await inspectChromiumSandbox({ ...base, procRoot, listProcesses: listing([77, 78]) });
    expect(attestation).toEqual({ schemaVersion: "e2e-executor-chromium-sandbox/v1", runId, groupId: "group-1", browser: { pid: 40, nsPidDepth: 1, seccompFilters: 1, uidMap: "0 0 4294967295" },
      renderers: [{ pid: 77, nsPidDepth: 2, seccompFilters: 2, uidMap: "1000 1000 1" }, { pid: 78, nsPidDepth: 2, seccompFilters: 2, uidMap: "1000 1000 1" }] });
    expect(evaluateChromiumSandbox(attestation)).toEqual({ sandboxed: true });
  });

  it("negative control: a --no-sandbox renderer is an ordinary child of the browser and the evaluator refuses it", async () => {
    const procRoot = await fakeProc({ 40: container, 77: container });
    const attestation = await inspectChromiumSandbox({ ...base, procRoot, listProcesses: listing([77]) });
    expect(evaluateChromiumSandbox(attestation)).toMatchObject({ sandboxed: false });
  });

  it("skips a renderer that exited before it could be read, and attests nothing when none is left", async () => {
    const procRoot = await fakeProc({ 40: container, 77: sandboxed });
    expect((await inspectChromiumSandbox({ ...base, procRoot, listProcesses: listing([77, 99]) })).renderers.map((item) => item.pid)).toEqual([77]);
    const none = await inspectChromiumSandbox({ ...base, procRoot, listProcesses: listing([99]) });
    expect(evaluateChromiumSandbox(none)).toEqual({ sandboxed: false, reason: "no-renderer-observed" });
  });

  it("uses the browser the DevTools endpoint reports, and falls back to the launched pid when it reports none", async () => {
    const procRoot = await fakeProc({ 40: container, 77: sandboxed });
    expect((await inspectChromiumSandbox({ ...base, browserPid: 40, procRoot, listProcesses: async () => ({ browserPid: null, rendererPids: [77] }) })).browser.pid).toBe(40);
    expect((await inspectChromiumSandbox({ ...base, browserPid: 5, procRoot, listProcesses: listing([77]) })).browser.pid).toBe(40);
  });
});

/** A DevTools endpoint that completes the WebSocket handshake and then never answers, as a wedged browser does. */
async function silentDevTools(): Promise<{ url: string; close(): Promise<void> }> {
  const sockets: Duplex[] = [];
  const server: Server = createServer();
  server.on("upgrade", (request, socket) => {
    sockets.push(socket);
    const accept = createHash("sha1").update(`${String(request.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `ws://127.0.0.1:${port}/devtools/browser/x`, close: async () => { sockets.forEach((socket) => socket.destroy()); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

describe("listing Chromium's processes against a browser that stops answering", () => {
  it("rejects a call that is waiting for a reply when the deadline passes, instead of hanging", async () => {
    const devtools = await silentDevTools();
    try {
      const started = Date.now();
      await expect(listChromiumProcesses(devtools.url, new AbortController().signal, 300)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally { await devtools.close(); }
  });

  it("rejects when the caller aborts, and at once when it already has", async () => {
    const devtools = await silentDevTools();
    try {
      const controller = new AbortController();
      const waiting = listChromiumProcesses(devtools.url, controller.signal, 60_000);
      setTimeout(() => controller.abort(new Error("executor cancelled")), 200);
      await expect(waiting).rejects.toThrow("executor cancelled");
      await expect(listChromiumProcesses(devtools.url, AbortSignal.abort(new Error("already cancelled")), 60_000)).rejects.toThrow("already cancelled");
    } finally { await devtools.close(); }
  });
});

describe("settling on a verdict about a browser whose renderers are still starting", () => {
  const input = { cdpEndpoint: "ws://127.0.0.1:1/x", browserPid: 1, runId, groupId: "group-1", signal: new AbortController().signal };
  const attestation = (sandboxed: boolean) => ({ schemaVersion: "e2e-executor-chromium-sandbox/v1" as const, runId, groupId: "group-1", browser: { pid: 40, nsPidDepth: 1, seccompFilters: 1, uidMap: "0 0 4294967295" },
    renderers: [sandboxed ? { pid: 77, nsPidDepth: 2, seccompFilters: 2, uidMap: "0 1000 1" } : { pid: 77, nsPidDepth: 1, seccompFilters: 1, uidMap: "0 0 4294967295" }] });
  const sequence = (steps: (boolean | Error)[]) => {
    let calls = 0;
    return { inspect: async () => { const step = steps[Math.min(calls, steps.length - 1)]!; calls += 1; if (step instanceof Error) throw step; return attestation(step); }, calls: () => calls };
  };
  const options = (inspect: () => Promise<ReturnType<typeof attestation>>, settleMs = 1_000) => ({ settleMs, pollMs: 5, inspect: inspect as never, clock: settleClock() });

  it("waits for a renderer that has not installed its seccomp filter yet and accepts it once it shows", async () => {
    const run = sequence([false, false, true]);
    const result = await attestWhenSettled(input, options(run.inspect));
    expect(result.verdict).toEqual({ sandboxed: true });
    expect(run.calls()).toBe(3);
  });

  it("retries a failed read too, such as a renderer that vanished or a DevTools reply that was late", async () => {
    const run = sequence([new Error("DevTools connection closed"), true]);
    expect((await attestWhenSettled(input, options(run.inspect))).verdict).toEqual({ sandboxed: true });
  });

  it("gives up after the settle time and reports the last facts, never accepting a renderer that never shows a sandbox", async () => {
    const run = sequence([false]);
    const result = await attestWhenSettled(input, options(run.inspect, 100));
    expect(result.verdict).toMatchObject({ sandboxed: false });
    expect(run.calls()).toBeGreaterThan(1);
  });

  it("throws the last error when nothing could ever be read", async () => {
    await expect(attestWhenSettled(input, options(sequence([new Error("cannot read /proc/40/status")]).inspect, 50))).rejects.toThrow("cannot read /proc/40/status");
  });

  it("stops waiting the moment the caller aborts instead of finishing the settle time", async () => {
    const controller = new AbortController();
    const run = sequence([false]);
    // The caller cancels right after the first look (no timer), so the abort can never land before the look or after the settle time.
    const inspect = async () => { const attestation = await run.inspect(); controller.abort(new Error("executor cancelled")); return attestation; };
    const started = Date.now();
    const result = await attestWhenSettled({ ...input, signal: controller.signal }, { settleMs: 30_000, pollMs: 10_000, inspect, clock: settleClock() });
    expect(result.verdict).toMatchObject({ sandboxed: false });
    expect(run.calls()).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("looks exactly once when there is no time to settle", async () => {
    const run = sequence([false]);
    expect((await attestWhenSettled(input, options(run.inspect, 0))).verdict).toMatchObject({ sandboxed: false });
    expect(run.calls()).toBe(1);
  });
});

/** A DevTools endpoint that answers the three calls the lister makes and counts them: one browser (pid 40) and one renderer (pid 77). */
async function answeringDevTools(): Promise<{ url: string; methods: string[]; close(): Promise<void> }> {
  const sockets: Duplex[] = []; const methods: string[] = [];
  const server: Server = createServer();
  const frame = (text: string) => { const body = Buffer.from(text); return Buffer.concat([Buffer.from(body.length < 126 ? [0x81, body.length] : [0x81, 126, body.length >> 8, body.length & 255]), body]); };
  server.on("upgrade", (request, socket) => {
    sockets.push(socket); socket.on("error", () => undefined);
    const accept = createHash("sha1").update(`${String(request.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (chunk: Buffer) => {
      // Client frames are masked text frames of fewer than 65,536 bytes: read the length, unmask, answer by method.
      if ((chunk[0]! & 0x0f) !== 1) return;
      let length = chunk[1]! & 0x7f; let offset = 2;
      if (length === 126) { length = chunk.readUInt16BE(2); offset = 4; }
      const mask = chunk.subarray(offset, offset + 4); const payload = Buffer.from(chunk.subarray(offset + 4, offset + 4 + length)).map((byte, index) => byte ^ mask[index % 4]!);
      const { id, method } = JSON.parse(Buffer.from(payload).toString("utf8")) as { id: number; method: string };
      methods.push(method);
      const result = method === "Target.createTarget" ? { targetId: "blank-1" }
        : method === "SystemInfo.getProcessInfo" ? { processInfo: [{ type: "browser", id: 40 }, { type: "renderer", id: 77 }] } : {};
      socket.write(frame(JSON.stringify({ id, result })));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/x`, methods,
    close: async () => { sockets.forEach((socket) => socket.destroy()); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

describe("a DevTools session that lists Chromium's processes", () => {
  it("opens one blank tab for every look in the session, and closes it at the end", async () => {
    const devtools = await answeringDevTools();
    try {
      const lister = openChromiumProcessLister(devtools.url, new AbortController().signal, 5_000);
      for (let look = 0; look < 3; look += 1) expect(await lister.list()).toEqual({ browserPid: 40, rendererPids: [77] });
      await lister.close();
      expect(devtools.methods.filter((method) => method === "Target.createTarget")).toHaveLength(1);
      expect(devtools.methods.filter((method) => method === "SystemInfo.getProcessInfo")).toHaveLength(3);
      expect(devtools.methods.at(-1)).toBe("Target.closeTarget");
    } finally { await devtools.close(); }
  });

  it("settles over one session: a look that finds the renderer unsandboxed does not open another tab", async () => {
    const devtools = await answeringDevTools();
    const procRoot = await fakeProc({ 40: container, 77: container });
    try {
      const result = await attestWhenSettled({ cdpEndpoint: devtools.url, browserPid: 40, runId, groupId: "group-1", signal: new AbortController().signal, procRoot }, { settleMs: 300, pollMs: 20, clock: settleClock() });
      expect(result.verdict).toMatchObject({ sandboxed: false });
      expect(devtools.methods.filter((method) => method === "Target.createTarget")).toHaveLength(1);
      expect(devtools.methods.filter((method) => method === "SystemInfo.getProcessInfo").length).toBeGreaterThan(2);
    } finally { await devtools.close(); }
  });

  it("does not stack abort listeners over many waits on one signal", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on("warning", onWarning);
    const devtools = await answeringDevTools();
    try {
      const controller = new AbortController();
      const lister = openChromiumProcessLister(devtools.url, controller.signal, 5_000);
      for (let look = 0; look < 30; look += 1) await lister.list();
      await lister.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(warnings).not.toContain("MaxListenersExceededWarning");
    } finally { process.off("warning", onWarning); await devtools.close(); }
  });
});
