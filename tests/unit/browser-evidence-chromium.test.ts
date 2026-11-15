// TE-H1 slice 1 in a real Chromium (skipped where none is installed; the CI linux-runtime job runs the same path inside the executor image, tests/linux/browser-evidence.test.ts).
// The project's own start command starts the fixture app for the base code and for the candidate; the runner opens the changed pages and keeps masked JPEGs within the e2e cap.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES } from "../../packages/contracts/src/browser-evidence.js";
import { runBrowserEvidence } from "../../packages/verifier/src/executor/browser-evidence.js";
import { createChromiumEvidenceDriver, startProjectApp, type ProjectApp } from "../../packages/verifier/src/executor/browser-evidence-chromium.js";

const haveChromium = existsSync(chromium.executablePath());
const FIXTURE = join(process.cwd(), "tests/fixtures/browser-evidence-app");
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});
const command = `"${process.execPath}" ../server.mjs`;

let browser: Browser | undefined;
beforeAll(async () => { if (haveChromium) browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const driverFor = (port: number, startCommand = command) => {
  const apps = new Map<string, ProjectApp>();
  return createChromiumEvidenceDriver({
    browser: browser!,
    origin: `http://127.0.0.1:${port}`,
    app: {
      async start(side, timeoutMs) {
        const started = await startProjectApp({ command: startCommand, cwd: join(FIXTURE, side), port, readyPath: "/health", timeoutMs, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
        if (started.status === "ready") apps.set(side, started.app);
        return started.status;
      },
      async stop(side) { await apps.get(side)?.stop(); apps.delete(side); },
    },
  });
};

describe.skipIf(!haveChromium)("browser evidence in a real Chromium", () => {
  it("starts the app for each side, shows the changed page before and after, and says Not run for a page that does not load", async () => {
    const port = await freePort();
    const got = await runBrowserEvidence({ isolation: "sandbox", routes: ["/checkout", "/missing"], notShown: [], moreNotShown: 0, maskSelectors: [...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS], driver: driverFor(port) });
    expect(got.notRun).toBeUndefined();
    const [checkout, missing] = got.routes;
    expect(missing).toEqual({ route: "/missing", status: "not_run", reason: "page_did_not_load" });
    expect(checkout?.status).toBe("shown");
    if (checkout?.status !== "shown") return;
    for (const shot of [checkout.before, checkout.after]) {
      expect([...shot.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect(shot.bytes.byteLength).toBeLessThanOrEqual(BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES);
    }
    expect(checkout.before.sha256).not.toBe(checkout.after.sha256);
    expect(checkout.consoleErrors).toEqual({ before: 0, after: 1 });
  }, 120_000);

  it("masks: two pages that differ only in masked elements, or only in an email in their text, give the same picture", async () => {
    const port = await freePort();
    const got = await runBrowserEvidence({ isolation: "sandbox", routes: ["/masked-a", "/masked-b", "/email-a", "/email-b"], notShown: [], moreNotShown: 0, maskSelectors: [...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS], driver: driverFor(port) });
    const shaOf = (route: string) => { const row = got.routes.find((r) => r.route === route); if (row?.status !== "shown") throw new Error(`${route} was not shown`); return row.after.sha256; };
    expect(shaOf("/masked-a")).toBe(shaOf("/masked-b"));
    expect(shaOf("/email-a")).toBe(shaOf("/email-b"));
    // Positive control: the driver itself with no masks gives two different pictures of the same two pages, so the equality above comes from the masking.
    const driver = driverFor(port);
    expect(await driver.startApp("after", { timeoutMs: 20_000 })).toBe("ready");
    try {
      const a = await driver.capture("after", "/masked-a", { maskSelectors: [], timeoutMs: 10_000 });
      const b = await driver.capture("after", "/masked-b", { maskSelectors: [], timeoutMs: 10_000 });
      if (!a.ok || !b.ok) throw new Error("the unmasked pages did not load");
      expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(false);
    } finally { await driver.stopApp("after"); }
  }, 120_000);

  it("masks text the page re-renders after load, text in an open shadow root and text in a same-origin frame", async () => {
    const port = await freePort();
    const got = await runBrowserEvidence({ isolation: "sandbox", routes: ["/late-a", "/late-b", "/shadow-a", "/shadow-b"], notShown: [], moreNotShown: 0, maskSelectors: [], driver: driverFor(port) });
    const frames = await runBrowserEvidence({ isolation: "sandbox", routes: ["/frame-a", "/frame-b"], notShown: [], moreNotShown: 0, maskSelectors: [], driver: driverFor(port) });
    const shaOf = (run: typeof got, route: string) => { const row = run.routes.find((r) => r.route === route); if (row?.status !== "shown") throw new Error(`${route} was not shown: ${JSON.stringify(row)}`); return row.after.sha256; };
    expect(shaOf(got, "/late-a")).toBe(shaOf(got, "/late-b"));
    expect(shaOf(got, "/shadow-a")).toBe(shaOf(got, "/shadow-b"));
    expect(shaOf(frames, "/frame-a")).toBe(shaOf(frames, "/frame-b"));
  }, 120_000);

  it("keeps no picture of a secret split over several elements, and a page whose script never yields ends at its time and the app is stopped", async () => {
    const port = await freePort();
    const started = Date.now();
    const got = await runBrowserEvidence({ isolation: "sandbox", routes: ["/split", "/busy"], notShown: [], moreNotShown: 0, maskSelectors: [], driver: driverFor(port), limits: { pageMs: 4_000 } });
    expect(got.routes).toEqual([{ route: "/split", status: "not_run", reason: "masked_content" }, { route: "/busy", status: "not_run", reason: "time_limit" }]);
    expect(Date.now() - started).toBeLessThan(60_000);
    // Both sides' apps were stopped: nothing listens on the port any more.
    const again = driverFor(port);
    expect(await again.startApp("before", { timeoutMs: 20_000 })).toBe("ready");
    await again.stopApp("before");
  }, 120_000);

  it("an app whose start command fails or never answers is Not run, and its process is gone", async () => {
    const port = await freePort();
    const failed = await runBrowserEvidence({ isolation: "sandbox", routes: ["/checkout"], notShown: [], moreNotShown: 0, maskSelectors: [], driver: driverFor(port, `"${process.execPath}" -e "process.exit(3)"`) });
    expect(failed.notRun).toBe("app_did_not_start");
    const scratch = await mkdtemp(join(tmpdir(), "rovara-be-"));
    try {
      const pidFile = join(scratch, "pid");
      const silent = await startProjectApp({ command: `echo $$ > "${pidFile}"; exec "${process.execPath}" -e "setInterval(() => {}, 1000)"`, cwd: FIXTURE, port, readyPath: "/health", timeoutMs: 1_500, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      expect(silent.status).toBe("time_limit");
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, 60_000);

  it("never opens another origin, even when a route tries to", async () => {
    const port = await freePort();
    const driver = driverFor(port);
    expect(await driver.startApp("before", { timeoutMs: 20_000 })).toBe("ready");
    try {
      expect(await driver.capture("before", "//example.com/", { maskSelectors: [], timeoutMs: 5_000 })).toEqual({ ok: false, reason: "page_did_not_load" });
    } finally { await driver.stopApp("before"); }
  }, 60_000);
});
