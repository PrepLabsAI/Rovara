import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { launchLocalChromium, readProcessTable, removeDirectoryWithRetries } from "../../packages/verifier/src/executor/local-browser.js";
import { fakeChromium as createFakeChromium } from "../support/fake-chromium.js";

const dirs: string[] = [];
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
