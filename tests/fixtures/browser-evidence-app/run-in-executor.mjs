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
      const started = await startProjectApp({ command: "node ../server.mjs", cwd: `/fixture/${side}`, port, readyPath: "/health", timeoutMs, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" } });
      if (started.status === "ready") apps.set(side, started.app);
      return started.status;
    },
    async stop(side) { await apps.get(side)?.stop(); apps.delete(side); },
  },
});
const shot = (s) => ({ sha256: s.sha256, bytes: s.bytes.byteLength, jpeg: s.bytes[0] === 0xff && s.bytes[1] === 0xd8 && s.bytes[2] === 0xff });
const view = (run) => ({ notRun: run.notRun ?? null, routes: run.routes.map((r) => (r.status === "shown" ? { route: r.route, status: r.status, before: shot(r.before), after: shot(r.after), consoleErrors: r.consoleErrors } : r)) });
let exitCode = 0;
try {
  const changed = await runBrowserEvidence({ isolation: "sandbox", routes: ["/checkout", "/missing"], notShown: [], moreNotShown: 0, maskSelectors: [], driver });
  const masked = await runBrowserEvidence({ isolation: "sandbox", routes: ["/masked-a", "/masked-b", "/email-a", "/email-b"], notShown: [], moreNotShown: 0, maskSelectors: [], driver });
  process.stdout.write(`${JSON.stringify({ changed: view(changed), masked: view(masked) })}\n`);
} catch (error) {
  process.stderr.write(`browser evidence run failed: ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  clearTimeout(timer);
  await chromium.close();
}
process.exit(exitCode);
