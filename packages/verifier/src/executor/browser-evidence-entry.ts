// TE-H1 browser evidence, slice 2: the capture program that runs in a container of the executor image (DEC 241a). The worker starts the project's app in the TASK SANDBOX through its own runners (R56: project commands run only
// there) and then starts this program with `--network container:<sandbox>`, so the two share ONE network namespace and nothing else: no mount, no environment, no other network. Here the app is reached on `127.0.0.1:<port>`, which is the
// sandbox's own loopback; Chromium (the executor's own, with its sandbox on, under the pinned seccomp profile) opens each page through the same driver slice 1 built and tested (browser-evidence-chromium.ts: masking, freezing, the
// verify passes), and the program prints one JSON line for the app's state and one per page. It starts no app and writes no file. The worker holds the result to the run's caps again (the runner) before anything is kept.
import { realpathSync } from "node:fs";
import type { Browser } from "playwright-core";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import {
  BrowserEvidenceExecutorLineSchema, BROWSER_EVIDENCE_EXECUTOR_OUTPUT_MAX_BYTES, BROWSER_EVIDENCE_EXECUTOR_VIDEO_OUTPUT_MAX_BYTES, BROWSER_EVIDENCE_SIGN_IN_ENV, BROWSER_EVIDENCE_VIDEOS_MAX, BROWSER_EVIDENCE_VIDEO_MAX_BYTES, BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES,
  browserEvidenceVideoEligible, decodeBrowserEvidenceExecutorPlan, decodeBrowserEvidenceSignInEnv, isWebm, withDefaultMasks,
  type BrowserEvidenceExecutorLine, type BrowserEvidenceExecutorPlan,
} from "@agentx/contracts";
import type { BrowserEvidenceDriver } from "./browser-evidence.js";

const READY_POLL_MS = 200;
const PROBE_TIMEOUT_MS = 1_000;
const pause = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });

/** Whether the app answers HTTP on the shared loopback at this path (any status below 500). */
function answers(port: number, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = request({ host: "127.0.0.1", port, path, method: "GET", timeout: PROBE_TIMEOUT_MS }, (response) => { response.resume(); resolve((response.statusCode ?? 500) < 500); });
    probe.once("timeout", () => { probe.destroy(); resolve(false); });
    probe.once("error", () => resolve(false));
    probe.end();
  });
}

export type CaptureDeps = Readonly<{
  /** Waits until the app answers, for at most `timeoutMs`. */
  waitReady(input: { port: number; readyPath: string; timeoutMs: number }): Promise<"ready" | "app_did_not_start" | "time_limit">;
  driver: Pick<BrowserEvidenceDriver, "capture"> & Readonly<{ signIn?: (options: { timeoutMs: number }) => Promise<"ok" | "sign_in_failed" | "time_limit"> }>;
  now?: () => number;
}>;

export const defaultWaitReady: CaptureDeps["waitReady"] = async (input) => {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (await answers(input.port, input.readyPath)) return "ready";
    await pause(READY_POLL_MS);
  }
  return "time_limit";
};

/**
 * The lines for one side of one run: the app's state (waited for within the run's time), then, only when it is ready, one row per page, each within the page's time and what is left of the run's. Every line is checked against its
 * schema and the whole output against its byte bound before it is returned, so a driver that answers oddly can only make a page "capture_failed", never print something the worker would have to guess about.
 */
export async function runCapture(plan: BrowserEvidenceExecutorPlan, deps: CaptureDeps): Promise<BrowserEvidenceExecutorLine[]> {
  const now = deps.now ?? Date.now;
  const deadline = now() + plan.runMs;
  const lines: BrowserEvidenceExecutorLine[] = [];
  const status = await deps.waitReady({ port: plan.port, readyPath: plan.readyPath ?? "/", timeoutMs: Math.max(1, deadline - now()) });
  // An app behind a login: signed in once, before any page, within the run's time. A sign-in that did not work is the run's only line after the app's own: no page is taken signed out and shown as signed in.
  let signed: "ok" | "sign_in_failed" | "time_limit" | undefined;
  if (status === "ready" && plan.signIn !== undefined) {
    try { signed = deps.driver.signIn === undefined ? "sign_in_failed" : await deps.driver.signIn({ timeoutMs: Math.max(1, Math.min(plan.pageMs, deadline - now())) }); } catch { signed = "sign_in_failed"; }
    if (signed === "time_limit") { lines.push({ t: "app", status: "time_limit" }); return lines; }
    if (signed !== "ok") { lines.push({ t: "app", status: "sign_in_failed" }); return lines; }
  }
  lines.push({ t: "app", status });
  if (status !== "ready") return lines;
  const maskSelectors = withDefaultMasks(plan.maskSelectors);
  const recording = plan.video === true;
  const taken: Array<{ line: BrowserEvidenceExecutorLine; video?: Uint8Array }> = [];
  for (const route of plan.routes) {
    const left = deadline - now();
    let line: BrowserEvidenceExecutorLine = { t: "shot", route, ok: false, reason: "time_limit" };
    let video: Uint8Array | undefined;
    if (left > 0) {
      try {
        const answer = await deps.driver.capture("after", route, { maskSelectors, timeoutMs: Math.min(plan.pageMs, left), ...(recording ? { video: true as const } : {}) });
        if (answer.ok) line = { t: "shot", route, ok: true, consoleErrors: answer.consoleErrors, jpegBase64: Buffer.from(answer.bytes).toString("base64") };
        else line = { t: "shot", route, ok: false, reason: answer.reason };
        // A page the driver calls "withheld" (a mask had to rewrite its text, or it could not be read) was not showing fixture data only, healthy or not: the line says so, and it takes every recording of this side with it.
        if (recording && answer.videoNotKept === "withheld") line = { ...line, videoNotKept: "withheld" };
        // A recording is believed only when the plan asked for one, and only for a page that failed to load or showed errors (the same rule the runner holds it to).
        else if (recording && videoAllowed(line)) {
          const asked: unknown = answer.video;
          if (asked instanceof Uint8Array) {
            if (asked.byteLength > BROWSER_EVIDENCE_VIDEO_MAX_BYTES) line = { ...line, videoNotKept: "over_size_cap" };
            else if (asked.byteLength === 0 || !isWebm(asked)) line = { ...line, videoNotKept: "not_recorded" };
            else video = asked;
          } else if (answer.videoNotKept === "over_size_cap") line = { ...line, videoNotKept: "over_size_cap" };
        }
      } catch { line = { t: "shot", route, ok: false, reason: "capture_failed" }; video = undefined; }
    }
    taken.push({ line, ...(video === undefined ? {} : { video }) });
  }
  // One page withheld for what it showed takes every recording of this side with it (a recording cannot be masked, and a page that showed a secret in an app said to hold fixture data only means none can be trusted).
  const leaked = taken.some((row) => row.line.t === "shot" && ((!row.line.ok && row.line.reason === "masked_content") || row.line.videoNotKept === "withheld"));
  let videos = 0;
  let videoBytes = 0;
  let printed = 0;
  for (const row of taken) {
    let line = row.line;
    if (row.video !== undefined && line.t === "shot") {
      if (leaked) line = { ...line, videoNotKept: "withheld" };
      else if (videos + 1 > BROWSER_EVIDENCE_VIDEOS_MAX || videoBytes + row.video.byteLength > BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES) line = { ...line, videoNotKept: "over_size_cap" };
      else { videos += 1; videoBytes += row.video.byteLength; line = { ...line, videoBase64: Buffer.from(row.video).toString("base64") }; }
    }
    // A line that does not fit its schema (a picture over the cap, a count out of range) is a failed capture, not a guess.
    if (!BrowserEvidenceExecutorLineSchema.safeParse(line).success) line = { t: "shot", route: line.t === "shot" ? line.route : "/", ok: false, reason: "capture_failed" };
    // The program never prints more than the bound it is held to: a page that would pass it is "capture_failed".
    const size = Buffer.byteLength(JSON.stringify(line), "utf8") + 1;
    if (printed + size > (recording ? BROWSER_EVIDENCE_EXECUTOR_VIDEO_OUTPUT_MAX_BYTES : BROWSER_EVIDENCE_EXECUTOR_OUTPUT_MAX_BYTES)) line = { t: "shot", route: line.t === "shot" ? line.route : "/", ok: false, reason: "capture_failed" };
    printed += Buffer.byteLength(JSON.stringify(line), "utf8") + 1;
    lines.push(line);
  }
  return lines;
}

/** Whether a page's line is one a recording may be kept for (`browserEvidenceVideoEligible`): a page that failed, or showed errors. */
function videoAllowed(line: BrowserEvidenceExecutorLine): boolean {
  if (line.t !== "shot") return false;
  return line.ok ? browserEvidenceVideoEligible({ status: "shown", consoleErrors: { after: line.consoleErrors } }) : browserEvidenceVideoEligible({ status: "not_run", reason: line.reason });
}

/**
 * The executor's Chromium for THIS program, driven over a PIPE (`--remote-debugging-pipe`, Playwright's own launch), never over a DevTools port. This container shares the task sandbox's network namespace, so a TCP debugging port on its loopback
 * would be reachable by whatever runs in the sandbox (the project's own app, a daemon a test left behind) and would hand it the browser: its masked pages, its other origins. With a pipe there is no address to connect to at all. Chromium's own sandbox
 * stays on (`chromiumSandbox: true`: the pinned seccomp profile lets it create its namespaces), and it sees only what it needs of the environment.
 */
async function openPipeChromium(): Promise<{ browser: Browser; close(): Promise<void> }> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: chromium.executablePath(), headless: false, chromiumSandbox: true, timeout: 30_000,
    args: ["--headless=new", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions",
      "--metrics-recording-only", "--mute-audio", "--password-store=basic", "--use-mock-keychain"],
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["TMPDIR"] ?? "/tmp", TMPDIR: process.env["TMPDIR"] ?? "/tmp", LANG: "C.UTF-8", ...(process.env["PLAYWRIGHT_BROWSERS_PATH"] === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: process.env["PLAYWRIGHT_BROWSERS_PATH"] }) },
  });
  return { browser, close: () => browser.close().catch(() => undefined) };
}

/** The program: the plan is the one argument; the output is the lines; anything wrong is one fixed sentence on stderr and exit code 2. */
async function main(): Promise<void> {
  const plan = decodeBrowserEvidenceExecutorPlan(process.argv[2]);
  if (plan === undefined || process.argv.length !== 3) { process.stderr.write("browser evidence plan is not valid\n"); process.exit(2); }
  // The saved sign-in's values come in one environment variable, read once and removed at once: nothing started from here (Chromium has its own environment) can read it, and nothing prints it.
  const raw = process.env[BROWSER_EVIDENCE_SIGN_IN_ENV];
  delete process.env[BROWSER_EVIDENCE_SIGN_IN_ENV];
  const values = raw === undefined ? undefined : decodeBrowserEvidenceSignInEnv(raw);
  // A plan with a sign-in and no valid values, or values with no plan to use them, is refused before any browser starts.
  if ((plan.signIn === undefined) !== (raw === undefined) || (raw !== undefined && values === undefined)) { process.stderr.write("browser evidence sign-in is not valid\n"); process.exit(2); }
  const { createChromiumEvidenceDriver } = await import("./browser-evidence-chromium.js");
  const timer = setTimeout(() => { process.stderr.write("browser evidence run timed out\n"); process.exit(1); }, plan.runMs + 20_000);
  const chromium = await openPipeChromium();
  let code = 0;
  try {
    const driver = createChromiumEvidenceDriver({ browser: chromium.browser, origin: `http://127.0.0.1:${String(plan.port)}`, app: { start: () => Promise.resolve("ready" as const), stop: () => Promise.resolve() },
      ...(plan.signIn === undefined || values === undefined ? {} : { signIn: { form: plan.signIn, values } }) });
    for (const line of await runCapture(plan, { waitReady: defaultWaitReady, driver })) process.stdout.write(`${JSON.stringify(line)}\n`);
  } catch {
    process.stderr.write("browser evidence capture failed\n");
    code = 1;
  } finally {
    clearTimeout(timer);
    await chromium.close();
  }
  process.exit(code);
}

// Runs only as the program itself, never when a test or the worker imports `runCapture`.
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && (() => { try { return realpathSync(process.argv[1]) === realpathSync(thisFile); } catch { return false; } })()) void main();
