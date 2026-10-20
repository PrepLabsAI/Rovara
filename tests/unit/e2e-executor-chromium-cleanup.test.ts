import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { launchLocalChromium, readProcessTable, removeDirectoryWithRetries, type ProcessTable } from "../../packages/verifier/src/executor/local-browser.js";
import { fakeChromium as createFakeChromium } from "../support/fake-chromium.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

const fakeChromium = async (behaviour: "listen" | "no-usable-sandbox" | "orphan-writer") => { const fake = await createFakeChromium(behaviour); dirs.push(fake.directory); return fake; };
const downloadDir = async () => { const dir = join(await mkdtemp(join(tmpdir(), "cleanup-downloads-")), "d"); dirs.push(dir); return dir; };
const exists = (path: string) => access(path).then(() => true, () => false);
const enotempty = (path: string) => Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`), { code: "ENOTEMPTY" });
/** The profile directory the fake browser was told to use. */
async function profileOf(fake: Awaited<ReturnType<typeof fakeChromium>>): Promise<string> {
  const [args] = await fake.launches();
  return args!.find((arg) => arg.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
}

describe("removing a directory a browser may still be writing to", () => {
  it("tries again after ENOTEMPTY and reports success", async () => {
    const calls: string[] = []; const pauses: number[] = [];
    const failure = await removeDirectoryWithRetries("/profile", { remove: async (path) => { calls.push(path); if (calls.length === 1) throw enotempty(path); },
      sleep: async (milliseconds) => { pauses.push(milliseconds); } });
    expect(failure).toBeNull();
    expect(calls).toEqual(["/profile", "/profile"]);
    expect(pauses).toHaveLength(1);
  });

  it("gives up after a bounded number of attempts and returns the error instead of throwing it", async () => {
    let calls = 0;
    const failure = await removeDirectoryWithRetries("/profile", { remove: async (path) => { calls += 1; throw enotempty(path); }, sleep: async () => undefined, attempts: 3 });
    expect(calls).toBe(3);
    expect(failure?.message).toContain("ENOTEMPTY");
  });

  it("asks fs.rm itself to retry too, and removes a real directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleanup-real-"));
    let options: unknown;
    expect(await removeDirectoryWithRetries(dir, { remove: async (path, given) => { options = given; await rm(path, given); } })).toBeNull();
    expect(options).toMatchObject({ recursive: true, force: true });
    expect(typeof (options as { maxRetries?: unknown }).maxRetries).toBe("number");
    expect(typeof (options as { retryDelay?: unknown }).retryDelay).toBe("number");
    expect(await exists(dir)).toBe(false);
  });
});

describe("closing the executor's Chromium", () => {
  it("removes the profile after ENOTEMPTY once, with the same outcome and no diagnostic", async () => {
    const fake = await fakeChromium("listen");
    const diagnostics: string[] = []; let removals = 0;
    const browser = await launchLocalChromium({ downloadDir: await downloadDir(), signal: new AbortController().signal, executablePath: fake.executable,
      onCleanupDiagnostic: (message) => { diagnostics.push(message); }, sleep: async () => undefined,
      removeDirectory: async (path, options) => { removals += 1; if (removals === 1) throw enotempty(path); await rm(path, options); } });
    const profile = await profileOf(fake);
    await expect(browser.close()).resolves.toBeUndefined();
    expect(removals).toBe(2);
    expect(diagnostics).toEqual([]);
    expect(await exists(profile)).toBe(false);
  });

  it("never throws when the profile cannot be removed: the failure is recorded as a cleanup diagnostic", async () => {
    const fake = await fakeChromium("listen");
    const diagnostics: string[] = [];
    const browser = await launchLocalChromium({ downloadDir: await downloadDir(), signal: new AbortController().signal, executablePath: fake.executable,
      onCleanupDiagnostic: (message) => { diagnostics.push(message); }, sleep: async () => undefined,
      removeDirectory: async (path) => { throw enotempty(path); } });
    const profile = await profileOf(fake);
    await expect(browser.close()).resolves.toBeUndefined();
    await expect(browser.close()).resolves.toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^chromium cleanup diagnostic: could not remove the profile directory .*ENOTEMPTY/);
    expect(diagnostics[0]).toContain(profile);
    await rm(profile, { recursive: true, force: true });
  });

  it("keeps the real launch error when the cleanup after it fails too", async () => {
    const fake = await fakeChromium("no-usable-sandbox");
    const diagnostics: string[] = [];
    await expect(launchLocalChromium({ downloadDir: await downloadDir(), signal: new AbortController().signal, executablePath: fake.executable,
      onCleanupDiagnostic: (message) => { diagnostics.push(message); }, sleep: async () => undefined,
      removeDirectory: async (path) => { throw enotempty(path); } })).rejects.toThrow(/No usable sandbox/);
    expect(diagnostics.some((line) => line.includes("ENOTEMPTY"))).toBe(true);
    await rm(await profileOf(fake), { recursive: true, force: true });
  });

  it("a diagnostic sink that throws does not turn a cleanup problem into a failure", async () => {
    const fake = await fakeChromium("listen");
    const browser = await launchLocalChromium({ downloadDir: await downloadDir(), signal: new AbortController().signal, executablePath: fake.executable,
      onCleanupDiagnostic: () => { throw new Error("the sink is broken"); }, sleep: async () => undefined, removeDirectory: async (path) => { throw enotempty(path); } });
    const profile = await profileOf(fake);
    await expect(browser.close()).resolves.toBeUndefined();
    await rm(profile, { recursive: true, force: true });
  });

  it("waits for the browser's helper processes to exit before it removes the profile they write into", async () => {
    const fake = await fakeChromium("orphan-writer");
    const diagnostics: string[] = [];
    const browser = await launchLocalChromium({ downloadDir: await downloadDir(), signal: new AbortController().signal, executablePath: fake.executable,
      onCleanupDiagnostic: (message) => { diagnostics.push(message); } });
    const profile = await profileOf(fake);
    const helper = await fake.helperPid();
    expect(helper).not.toBeNull();
    expect((await readProcessTable()).has(helper!)).toBe(true);
    await browser.close();
    // The main process exits on SIGTERM at once while its helper keeps writing for a while; close() returns only after the helper is gone, so nothing
    // is left writing and the whole profile directory is removed.
    const entry = (await readProcessTable()).get(helper!);
    expect(entry === undefined || entry.zombie).toBe(true);
    expect(await exists(profile)).toBe(false);
    expect(diagnostics).toEqual([]);
  });
});

describe("reading the process table", () => {
  it("records each process's parent, zombie state and start time from procfs", async () => {
    const root = await mkdtemp(join(tmpdir(), "fake-proc-")); dirs.push(root);
    // "pid (comm) state ppid ..." with field 22 (the start time) after seventeen filler fields; the command name holds a space and a parenthesis.
    const stat = (pid: number, state: string, ppid: number, start: number) => `${pid} (we ird) name) ${state} ${ppid} ${Array(17).fill("0").join(" ")} ${start} 0 0\n`;
    for (const [pid, text] of [[12, stat(12, "S", 1, 98765)], [13, stat(13, "Z", 12, 98770)]] as const) { await mkdir(join(root, String(pid))); await writeFile(join(root, String(pid), "stat"), text); }
    await mkdir(join(root, "self")); // not a process
    expect([...(await readProcessTable(root))]).toEqual([[12, { ppid: 1, zombie: false, start: "98765" }], [13, { ppid: 12, zombie: true, start: "98770" }]]);
  });
});

describe("waiting for the browser's processes before removing the profile", () => {
  const entry = (ppid: number, start: string, zombie = false) => ({ ppid, zombie, start });

  it("neither waits for nor signals a pid that another process has reused since it was recorded", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const fake = await fakeChromium("listen");
    const diagnostics: string[] = [];
    let mainPid = 0; let reads = 0;
    const browser = await launchLocalChromium({ downloadDir: await downloadDir(), signal: new AbortController().signal, executablePath: fake.executable,
      onCleanupDiagnostic: (message) => { diagnostics.push(message); }, sleep: async () => undefined,
      readProcesses: async (): Promise<ProcessTable> => {
        reads += 1;
        // The first read (before SIGTERM) shows helper 9001 below the browser. Afterwards 9001 is a different, unrelated process: another start time, parent 1.
        return new Map([[mainPid, entry(1, "main")], [9001, reads === 1 ? entry(mainPid, "helper-start") : entry(1, "somebody-else")]]);
      } });
    mainPid = browser.pid;
    await browser.close();
    expect(diagnostics).toEqual([]);
    expect(kill.mock.calls.filter(([pid]) => pid === 9001)).toEqual([]);
    expect(reads).toBe(2); // the snapshot, then one look that found nothing of the browser left
  });

  it("still waits for, kills and reports a helper that keeps its pid and start time", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const fake = await fakeChromium("listen");
    const diagnostics: string[] = [];
    let mainPid = 0; let clock = 0;
    const browser = await launchLocalChromium({ downloadDir: await downloadDir(), signal: new AbortController().signal, executablePath: fake.executable,
      onCleanupDiagnostic: (message) => { diagnostics.push(message); }, now: () => clock, sleep: async (milliseconds) => { clock += milliseconds; },
      readProcesses: async () => new Map([[mainPid, entry(1, "main")], [9001, entry(mainPid, "helper-start")]]) });
    mainPid = browser.pid;
    await browser.close();
    expect(kill.mock.calls.filter(([pid]) => pid === 9001)).toEqual([[9001, "SIGKILL"]]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("9001");
    // 3 s of looks, the kill, then 2 s more: the look counts and the times agree when the table is fast.
    expect(clock).toBeGreaterThanOrEqual(5_000);
    expect(clock).toBeLessThan(8_000);
  });

  it("stops at the wall-clock ceiling however few looks a slow process table allowed", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const fake = await fakeChromium("listen");
    const diagnostics: string[] = [];
    let mainPid = 0; let clock = 0; let reads = 0;
    const browser = await launchLocalChromium({ downloadDir: await downloadDir(), signal: new AbortController().signal, executablePath: fake.executable,
      onCleanupDiagnostic: (message) => { diagnostics.push(message); }, now: () => clock, sleep: async () => undefined,
      readProcesses: async () => { reads += 1; clock += 5_000; return new Map([[mainPid, entry(1, "main")], [9001, entry(mainPid, "helper-start")]]); } });
    mainPid = browser.pid;
    await browser.close();
    // Every read takes 5 s: without the ceiling the 120 looks of the graceful wait would take ten minutes.
    expect(reads).toBeLessThanOrEqual(6);
    expect(diagnostics).toHaveLength(1);
  });
});
