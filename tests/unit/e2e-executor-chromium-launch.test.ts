import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { launchLocalChromium } from "../../packages/verifier/src/executor/local-browser.js";
import { fakeChromium as createFakeChromium } from "../support/fake-chromium.js";

const dirs: string[] = [];
const fakeChromium = async (behaviour: "listen" | "no-usable-sandbox") => { const fake = await createFakeChromium(behaviour); dirs.push(fake.directory); return fake; };
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("launching the executor's Chromium", () => {
  it("never passes --no-sandbox (Chromium's own sandbox must engage) and keeps DevTools on loopback", async () => {
    const fake = await fakeChromium("listen");
    const downloads = join(await mkdtemp(join(tmpdir(), "launch-downloads-")), "d"); dirs.push(downloads);
    const browser = await launchLocalChromium({ downloadDir: downloads, signal: new AbortController().signal, executablePath: fake.executable });
    try {
      const [args] = await fake.launches();
      expect(args).toBeDefined();
      expect(args!.filter((arg) => /sandbox/i.test(arg))).toEqual([]);
      expect(args).toContain("--remote-debugging-address=127.0.0.1");
      expect(args).toContain("--remote-debugging-port=0");
      expect(browser.cdpEndpoint).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
    } finally { await browser.close(); }
  });

  it("fails closed when Chromium cannot start its sandbox: one launch, the reason in the error, no fallback to an unsandboxed browser", async () => {
    const fake = await fakeChromium("no-usable-sandbox");
    const downloads = join(await mkdtemp(join(tmpdir(), "launch-downloads-")), "d"); dirs.push(downloads);
    await expect(launchLocalChromium({ downloadDir: downloads, signal: new AbortController().signal, executablePath: fake.executable })).rejects.toThrow(/No usable sandbox/);
    const launches = await fake.launches();
    expect(launches).toHaveLength(1);
    expect(launches.flat().filter((arg) => /sandbox/i.test(arg))).toEqual([]);
  });
});
