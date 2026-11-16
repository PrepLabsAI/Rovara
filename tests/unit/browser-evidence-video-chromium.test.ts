// TE-H1 slice 4 in a real Chromium (skipped where none is installed; the CI linux-runtime job runs the same path inside the executor image): the candidate's page is recorded, and the recording is kept only for a page
// that failed or showed errors, as a real WebM within the cap. A page withheld for what it showed takes every video of the run with it. Nothing is recorded unless the run asks.
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, BROWSER_EVIDENCE_VIDEO_MAX_BYTES, type BrowserEvidenceExecutorSignIn, type BrowserEvidenceSignInValues } from "../../packages/contracts/src/index.js";
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

const driverFor = (port: number) => {
  const apps = new Map<string, ProjectApp>();
  return createChromiumEvidenceDriver({
    browser: browser!, origin: `http://127.0.0.1:${port}`,
    app: {
      async start(side, timeoutMs) {
        const started = await startProjectApp({ command, cwd: join(FIXTURE, side), port, readyPath: "/health", timeoutMs, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(side === "after" ? { BE_REGRESS: "1" } : {}) } });
        if (started.status === "ready") apps.set(side, started.app);
        return started.status;
      },
      async stop(side) { await apps.get(side)?.stop(); apps.delete(side); },
    },
  });
};
const base = { isolation: "sandbox" as const, notShown: [], moreNotShown: 0, maskSelectors: [...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS] };
const scratchEntries = () => readdirSync(tmpdir()).filter((name) => name.startsWith("rovara-be-video-"));

describe.skipIf(!haveChromium)("browser evidence video on failure in a real Chromium", () => {
  it("keeps a real WebM of a page that failed and of a page with errors, and none of a healthy page, and leaves no scratch behind", async () => {
    const port = await freePort();
    const scratchBefore = scratchEntries().length;
    const got = await runBrowserEvidence({ ...base, routes: ["/regress", "/checkout", "/regress-ok"], driver: driverFor(port), video: true });
    const row = (route: string) => got.routes.find((entry) => entry.route === route) as { status: string; video?: { sha256: string; bytes: Uint8Array }; videoNotKept?: string };
    expect(row("/regress")).toMatchObject({ status: "not_run", reason: "page_did_not_load" });
    expect(row("/checkout").status).toBe("shown");
    expect(row("/regress-ok").status).toBe("shown");
    for (const route of ["/regress", "/checkout"]) {
      const kept = row(route);
      // A recording is kept, or the page says why not (never silence): where recording works it is a real WebM within the cap.
      if (kept.video === undefined) throw new Error(`${route} has no video: ${kept.videoNotKept ?? "no reason"}`);
      expect([...kept.video.bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
      expect(kept.video.bytes.byteLength).toBeLessThanOrEqual(BROWSER_EVIDENCE_VIDEO_MAX_BYTES);
    }
    expect(Object.keys(row("/regress-ok"))).not.toContain("video");
    expect(Object.keys(row("/regress-ok"))).not.toContain("videoNotKept");
    expect(scratchEntries().length).toBe(scratchBefore);
  }, 180_000);

  it("records nothing when the run does not ask: no video, no reason, nothing in the scratch folder", async () => {
    const port = await freePort();
    const driver = driverFor(port);
    expect(await driver.startApp("after", { timeoutMs: 20_000 })).toBe("ready");
    try {
      const answer = await driver.capture("after", "/regress", { maskSelectors: [], timeoutMs: 10_000 });
      expect(answer.ok).toBe(false);
      expect(Object.keys(answer)).not.toContain("video");
      expect(Object.keys(answer)).not.toContain("videoNotKept");
    } finally { await driver.stopApp("after"); }
  }, 120_000);

  it("a page withheld for what it showed takes the video of the failed page with it", async () => {
    const port = await freePort();
    const got = await runBrowserEvidence({ ...base, routes: ["/regress", "/split"], driver: driverFor(port), video: true });
    expect(got.routes.find((entry) => entry.route === "/split")).toEqual({ route: "/split", status: "not_run", reason: "masked_content" });
    const missing = got.routes.find((entry) => entry.route === "/regress") as { video?: unknown; videoNotKept?: string };
    expect(missing.video).toBeUndefined();
    expect(missing.videoNotKept).toBe("withheld");
  }, 180_000);

  // A screenshot of these pages is masked, so it is shown; a RECORDING of them is not masked, so they are not fixture-only pages and no video of the run is kept.
  it.each([
    ["an email address in the page's text (the scrub rewrote it)", "/email-a"],
    ["an element the app itself marks as private", "/masked-a"],
    ["an email address in a field", "/signin"],
  ])("a healthy page with %s takes the video of a failed page with it, though its own picture is shown", async (_name, leaky) => {
    const port = await freePort();
    const got = await runBrowserEvidence({ ...base, routes: ["/regress", leaky], driver: driverFor(port), video: true });
    expect(got.routes.find((entry) => entry.route === leaky)?.status).toBe("shown");
    const failed = got.routes.find((entry) => entry.route === "/regress") as { video?: unknown; videoNotKept?: string };
    expect(failed.video).toBeUndefined();
    expect(failed.videoNotKept).toBe("withheld");
  }, 180_000);

  it("a failed page whose error page shows an address is withheld, and takes the other videos with it; the same failure with a plain error page keeps its video", async () => {
    const port = await freePort();
    const got = await runBrowserEvidence({ ...base, routes: ["/regress", "/regress-leaky"], driver: driverFor(port), video: true });
    for (const route of ["/regress", "/regress-leaky"]) {
      const row = got.routes.find((entry) => entry.route === route) as { status: string; reason?: string; video?: unknown; videoNotKept?: string };
      expect(row, route).toMatchObject({ status: "not_run", reason: "page_did_not_load", videoNotKept: "withheld" });
      expect(row.video, route).toBeUndefined();
    }
    // Positive control: the plain failure alone keeps its recording.
    const plain = await runBrowserEvidence({ ...base, routes: ["/regress"], driver: driverFor(await freePort()), video: true });
    expect((plain.routes[0] as { video?: unknown }).video).toBeDefined();
  }, 180_000);

  it("a page whose script never yields ends at its time, with the app stopped, and no recording of it is kept (its text was never read, so nothing says it held no secret)", async () => {
    const port = await freePort();
    const started = Date.now();
    const got = await runBrowserEvidence({ ...base, routes: ["/regress-busy"], driver: driverFor(port), video: true, limits: { pageMs: 4_000 } });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(got.routes[0]).toEqual({ route: "/regress-busy", status: "not_run", reason: "time_limit" });
  }, 120_000);

  it("an app behind a login is never recorded, even if a caller asks (the typed account would be in the video)", async () => {
    const port = await freePort();
    const apps = new Map<string, ProjectApp>();
    const form: BrowserEvidenceExecutorSignIn = { path: "/login", usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button[type=submit]", successPath: "/dashboard" };
    // Built at runtime: a fixture that looks like a real credential is refused by the public repository's push protection.
    const values: BrowserEvidenceSignInValues = { username: ["tester", "ada", "7"].join("-"), password: ["pw", "Zq7", "Lm2", "Xv9"].join("-") };
    const driver = createChromiumEvidenceDriver({
      browser: browser!, origin: `http://127.0.0.1:${port}`, signIn: { form, values },
      app: {
        async start(side, timeoutMs) {
          const started = await startProjectApp({ command, cwd: join(FIXTURE, side), port, readyPath: "/health", timeoutMs, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", BE_USER: values.username, BE_PASS: values.password, BE_REGRESS: "1" } });
          if (started.status === "ready") apps.set(side, started.app);
          return started.status;
        },
        async stop(side) { await apps.get(side)?.stop(); apps.delete(side); },
      },
    });
    expect(await driver.startApp("after", { timeoutMs: 20_000 })).toBe("ready");
    try {
      expect(await driver.signIn({ timeoutMs: 15_000 })).toBe("ok");
      const answer = await driver.capture("after", "/regress", { maskSelectors: [...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, "#email", "#password"], timeoutMs: 10_000, video: true });
      expect(answer.ok).toBe(false);
      expect(Object.keys(answer)).not.toContain("video");
      expect(Object.keys(answer)).not.toContain("videoNotKept");
    } finally { await driver.stopApp("after"); }
  }, 120_000);

  it("recording never costs the pictures: a browser that cannot record (no encoder, a refused write) still gives every screenshot, and the failed page says its video was not recorded", async () => {
    const port = await freePort();
    const apps = new Map<string, ProjectApp>();
    // The same Chromium, except that a context that asks to record fails the way a missing encoder does.
    const noEncoder = { newContext: (options?: Parameters<Browser["newContext"]>[0]) => (options?.recordVideo === undefined ? browser!.newContext(options) : Promise.reject(new Error("ffmpeg is not installed at /secret/path"))) };
    const driver = createChromiumEvidenceDriver({
      browser: noEncoder, origin: `http://127.0.0.1:${port}`,
      app: {
        async start(side, timeoutMs) {
          const started = await startProjectApp({ command, cwd: join(FIXTURE, side), port, readyPath: "/health", timeoutMs, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(side === "after" ? { BE_REGRESS: "1" } : {}) } });
          if (started.status === "ready") apps.set(side, started.app);
          return started.status;
        },
        async stop(side) { await apps.get(side)?.stop(); apps.delete(side); },
      },
    });
    const got = await runBrowserEvidence({ ...base, routes: ["/regress", "/checkout", "/regress-ok"], driver, video: true });
    const row = (route: string) => got.routes.find((entry) => entry.route === route) as { status: string; video?: unknown; videoNotKept?: string };
    expect(row("/regress-ok").status).toBe("shown");
    expect(row("/checkout").status).toBe("shown");
    expect(row("/checkout").videoNotKept).toBe("not_recorded");
    expect(row("/regress")).toMatchObject({ status: "not_run", reason: "page_did_not_load", videoNotKept: "not_recorded" });
    expect(JSON.stringify(got.routes)).not.toContain("secret");
  }, 180_000);
});
