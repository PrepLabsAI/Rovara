// Runs INSIDE the executor image (tests/linux/browser-evidence.test.ts): the image's own verifier build, its sandboxed Chromium, no network. The fixture app is started with its
// start command for each side, the runner takes the before and after screenshots, and this prints what it got as one JSON line (digests and sizes, never the bytes).
import { runBrowserEvidence } from "/opt/agentx/packages/verifier/dist/executor/browser-evidence.js";
import { createChromiumEvidenceDriver, openEvidenceChromium, startProjectApp } from "/opt/agentx/packages/verifier/dist/executor/browser-evidence-chromium.js";

const port = 4321;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("browser evidence run timed out")), 240_000);
const chromium = await openEvidenceChromium({ signal: controller.signal });
const apps = new Map();
const driver = createChromiumEvidenceDriver({
  browser: chromium.browser,
  origin: `http://127.0.0.1:${port}`,
  app: {
    async start(side, timeoutMs) {
      const started = await startProjectApp({ command: "node ../server.mjs", cwd: `/fixture/${side}`, port, readyPath: "/health", timeoutMs, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...(side === "after" ? { BE_REGRESS: "1" } : {}) } });
      if (started.status === "ready") apps.set(side, started.app);
      // A start that fails says why on stderr (the test shows it): what the shell sees, and what the start command prints when run once by hand.
      else {
        const { spawnSync } = await import("node:child_process");
        const probe = spawnSync("/bin/sh", ["-c", "id; command -v node; ls -ld /fixture /fixture/" + side + "; timeout 2 node ../server.mjs; echo exit=$?"], { cwd: `/fixture/${side}`, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", PORT: String(port + 1) }, encoding: "utf8", timeout: 10_000 });
        process.stderr.write(`app did not start (${side}, ${started.status}): ${probe.stdout}${probe.stderr}\n`);
      }
      return started.status;
    },
    async stop(side) { await apps.get(side)?.stop(); apps.delete(side); },
  },
});
const shot = (s) => ({ sha256: s.sha256, bytes: s.bytes.byteLength, jpeg: s.bytes[0] === 0xff && s.bytes[1] === 0xd8 && s.bytes[2] === 0xff });
// Slice 4: a recording is shown as its size and whether it starts like a WebM (never the bytes).
const clip = (v) => ({ bytes: v.bytes.byteLength, webm: v.bytes[0] === 0x1a && v.bytes[1] === 0x45 && v.bytes[2] === 0xdf && v.bytes[3] === 0xa3 });
const videoOf = (r) => (r.video === undefined ? {} : { video: clip(r.video) });
const view = (run) => ({ notRun: run.notRun ?? null, routes: run.routes.map((r) => (r.status === "shown" ? { route: r.route, status: r.status, before: shot(r.before), after: shot(r.after), consoleErrors: r.consoleErrors, ...videoOf(r), ...(r.videoNotKept === undefined ? {} : { videoNotKept: r.videoNotKept }) } : { route: r.route, status: r.status, reason: r.reason, ...videoOf(r), ...(r.videoNotKept === undefined ? {} : { videoNotKept: r.videoNotKept }) })) });
let exitCode = 0;
try {
  const changed = await runBrowserEvidence({ isolation: "sandbox", routes: ["/checkout", "/missing"], notShown: [], moreNotShown: 0, maskSelectors: [], driver });
  const masked = await runBrowserEvidence({ isolation: "sandbox", routes: ["/masked-a", "/masked-b", "/email-a", "/email-b"], notShown: [], moreNotShown: 0, maskSelectors: [], driver });
  const withVideo = await runBrowserEvidence({ isolation: "sandbox", routes: ["/regress", "/checkout", "/regress-ok"], notShown: [], moreNotShown: 0, maskSelectors: [], driver, video: true });
  process.stdout.write(`${JSON.stringify({ changed: view(changed), masked: view(masked), withVideo: view(withVideo) })}\n`);
} catch (error) {
  process.stderr.write(`browser evidence run failed: ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  clearTimeout(timer);
  await chromium.close();
}
process.exit(exitCode);
