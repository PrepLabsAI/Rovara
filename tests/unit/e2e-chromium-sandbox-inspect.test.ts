import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateChromiumSandbox } from "../../packages/contracts/src/index.js";
import { inspectChromiumSandbox, readChromiumProcessFacts } from "../../packages/verifier/src/executor/chromium-sandbox.js";

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
