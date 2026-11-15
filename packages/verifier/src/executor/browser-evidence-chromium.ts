// TE-H1 browser evidence: the real driver. The project's own start command starts the app (in its own process group, so stopping it stops only what it started), and a headless
// Chromium (the executor's `launchLocalChromium`, its own sandbox on) opens each route on the app's origin only, scrubs secrets and personal data from the page's text and form values,
// paints over the masked elements and takes one JPEG at the quality the e2e capture uses. Any other origin is refused before and during the load.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { BROWSER_EVIDENCE_TEXT_MASK, BROWSER_EVIDENCE_TEXT_MASKS, BROWSER_EVIDENCE_TEXT_SCAN_MAX, isBrowserEvidenceRoute } from "@agentx/contracts";
import type { BrowserEvidenceCaptureAnswer, BrowserEvidenceDriver, BrowserEvidenceSide } from "./browser-evidence.js";
import { launchLocalChromium } from "./local-browser.js";

/** The e2e capture's JPEG quality and screenshot timeout (web-runtime.ts). */
const SCREENSHOT_QUALITY = 70;
const SCREENSHOT_TIMEOUT_MS = 5_000;
const VIEWPORT = { width: 1280, height: 720 } as const;
const READY_POLL_MS = 200;
const PROBE_TIMEOUT_MS = 1_000;
const STOP_GRACE_MS = 3_000;
const STOP_KILLED_MS = 2_000;
/** The page's text nodes and form fields scrubbed at most; a page with more is not photographed. */
const SCRUB_NODES_MAX = 50_000;

const pause = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });

// ---- the app

export type ProjectApp = Readonly<{ stop(): Promise<void> }>;
export type ProjectAppStart = { status: "ready"; app: ProjectApp } | { status: "app_did_not_start" | "time_limit" };

/** Whether anything answers HTTP on the loopback port at this path (any status below 500). */
function answers(port: number, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = request({ host: "127.0.0.1", port, path, method: "GET", timeout: PROBE_TIMEOUT_MS }, (response) => { response.resume(); resolve((response.statusCode ?? 500) < 500); });
    probe.once("timeout", () => { probe.destroy(); resolve(false); });
    probe.once("error", () => resolve(false));
    probe.end();
  });
}

/**
 * Starts the project's app with its own start command (`/bin/sh -c`, inside the sandbox, in `cwd`, with only `env` and `PORT`), in a new process group, and waits until
 * `http://127.0.0.1:<port><readyPath>` answers. Refuses a port something else already answers on (it would photograph another program). An app that exits, or does not answer within
 * `timeoutMs`, is stopped and reported; `stop` ends the whole group and waits for it.
 */
export async function startProjectApp(input: { command: string; cwd: string; port: number; readyPath?: string | undefined; timeoutMs: number; env: Readonly<Record<string, string>> }): Promise<ProjectAppStart> {
  const readyPath = input.readyPath ?? "/";
  if (typeof input.command !== "string" || input.command.length === 0 || !Number.isInteger(input.port) || input.port < 1_024 || input.port > 65_535 || !isBrowserEvidenceRoute(readyPath)) return { status: "app_did_not_start" };
  if (await answers(input.port, readyPath)) return { status: "app_did_not_start" };
  let child: ChildProcess;
  try {
    child = spawn("/bin/sh", ["-c", input.command], { cwd: input.cwd, env: { ...input.env, PORT: String(input.port) }, detached: true, stdio: "ignore" });
  } catch { return { status: "app_did_not_start" }; }
  let exited = false;
  const exit = new Promise<void>((resolve) => { child.once("exit", () => { exited = true; resolve(); }); child.once("error", () => { exited = true; resolve(); }); });
  const signalGroup = (signal: NodeJS.Signals) => { if (child.pid !== undefined) { try { process.kill(-child.pid, signal); } catch { /* the group is already gone */ } } };
  const stop = async (): Promise<void> => {
    // The group, not only the shell: the app the shell started is in it. Only this group, never by name.
    signalGroup("SIGTERM");
    if (!exited) await Promise.race([exit, pause(STOP_GRACE_MS)]);
    signalGroup("SIGKILL");
    if (!exited) await Promise.race([exit, pause(STOP_KILLED_MS)]);
  };
  const deadline = Date.now() + Math.max(0, input.timeoutMs);
  while (Date.now() < deadline) {
    if (exited) { await stop(); return { status: "app_did_not_start" }; }
    if (await answers(input.port, readyPath)) {
      if (exited) { await stop(); return { status: "app_did_not_start" }; }
      return { status: "ready", app: Object.freeze({ stop }) };
    }
    await pause(READY_POLL_MS);
  }
  await stop();
  return { status: "time_limit" };
}

// ---- the page

/**
 * Runs IN THE PAGE: replaces every text mask in the page's text nodes, form values and placeholders, and in the document title. False when the page has more nodes than it scrubs (it is then
 * not photographed). Self-contained: it gets the mask sources as its argument.
 */
function scrubInPage(arg: { masks: ReadonlyArray<{ source: string; flags: string }>; mask: string; maxText: number; maxNodes: number }): boolean {
  const patterns = arg.masks.map((item) => new RegExp(item.source, item.flags));
  const scrub = (text: string): string => {
    if (text.length > arg.maxText) return arg.mask;
    let out = text;
    for (const pattern of patterns) out = out.replace(pattern, arg.mask);
    return out;
  };
  // This package has no DOM types: the page's document is described by the little this function touches. 4 is NodeFilter.SHOW_TEXT.
  type Field = { value?: unknown; placeholder?: unknown };
  const doc = (globalThis as unknown as { document: { documentElement: unknown; title: string; createTreeWalker(root: unknown, show: number): { nextNode(): { nodeValue: string | null } | null };
    querySelectorAll(selector: string): ArrayLike<Field> } }).document;
  let nodes = 0;
  const walker = doc.createTreeWalker(doc.documentElement, 4);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes += 1;
    if (nodes > arg.maxNodes) return false;
    const before = node.nodeValue ?? "";
    const after = scrub(before);
    if (after !== before) node.nodeValue = after;
  }
  for (const field of Array.from(doc.querySelectorAll("input, textarea"))) {
    nodes += 1;
    if (nodes > arg.maxNodes) return false;
    if (typeof field.value === "string" && field.value !== "") field.value = scrub(field.value);
    if (typeof field.placeholder === "string" && field.placeholder !== "") field.placeholder = scrub(field.placeholder);
  }
  doc.title = scrub(doc.title);
  return true;
}

export type ChromiumEvidenceDriverInput = Readonly<{
  /** A Chromium the caller owns (`openEvidenceChromium`, or a launched one in tests). */
  browser: Pick<Browser, "newContext">;
  /** The app's origin, `http://127.0.0.1:<port>`: the only origin a page may load from. */
  origin: string;
  app: Readonly<{ start(side: BrowserEvidenceSide, timeoutMs: number): Promise<"ready" | "app_did_not_start" | "time_limit">; stop(side: BrowserEvidenceSide): Promise<void> }>;
}>;

/** The driver `runBrowserEvidence` uses in the sandbox and on a laptop. */
export function createChromiumEvidenceDriver(input: ChromiumEvidenceDriverInput): BrowserEvidenceDriver {
  const origin = new URL(input.origin).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d{4,5}$/u.test(origin)) throw new Error("browser evidence opens only the app on the loopback address");
  return Object.freeze({
    startApp: (side: BrowserEvidenceSide, options: { timeoutMs: number }) => input.app.start(side, options.timeoutMs),
    stopApp: (side: BrowserEvidenceSide) => input.app.stop(side),
    async capture(_side: BrowserEvidenceSide, route: string, options: { maskSelectors: readonly string[]; timeoutMs: number }): Promise<BrowserEvidenceCaptureAnswer> {
      if (!isBrowserEvidenceRoute(route)) return { ok: false, reason: "page_did_not_load" };
      const url = new URL(route, origin);
      if (url.origin !== origin) return { ok: false, reason: "page_did_not_load" };
      const deadline = Date.now() + Math.max(1, options.timeoutMs);
      const left = () => Math.max(1, deadline - Date.now());
      let context: Awaited<ReturnType<Browser["newContext"]>>;
      try {
        context = await input.browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block", acceptDownloads: false });
      } catch { return { ok: false, reason: "capture_failed" }; }
      try {
        // Only the app's own origin is loaded: anything else (a font, an analytics call, a redirect away) is aborted.
        await context.route("**/*", (routed) => (new URL(routed.request().url()).origin === origin ? routed.continue() : routed.abort("blockedbyclient")));
        const page: Page = await context.newPage();
        let consoleErrors = 0;
        page.on("console", (message) => { if (message.type() === "error") consoleErrors += 1; });
        page.on("pageerror", () => { consoleErrors += 1; });
        try {
          const response = await page.goto(url.href, { waitUntil: "load", timeout: left() });
          if (response === null || response.status() >= 400 || new URL(page.url()).origin !== origin) return { ok: false, reason: "page_did_not_load" };
        } catch (error) {
          return { ok: false, reason: error instanceof Error && error.name === "TimeoutError" ? "time_limit" : "page_did_not_load" };
        }
        try {
          const scrubbed = await page.evaluate(scrubInPage, { masks: BROWSER_EVIDENCE_TEXT_MASKS.map((item) => ({ ...item })), mask: BROWSER_EVIDENCE_TEXT_MASK, maxText: BROWSER_EVIDENCE_TEXT_SCAN_MAX, maxNodes: SCRUB_NODES_MAX });
          if (scrubbed !== true) return { ok: false, reason: "capture_failed" };
          const bytes = await page.screenshot({
            type: "jpeg", quality: SCREENSHOT_QUALITY, timeout: Math.min(SCREENSHOT_TIMEOUT_MS, left()), animations: "disabled", caret: "hide",
            mask: options.maskSelectors.map((selector) => page.locator(selector)), maskColor: "#5c5c5c",
          });
          return { ok: true, bytes: Uint8Array.from(bytes), consoleErrors };
        } catch (error) {
          return { ok: false, reason: error instanceof Error && error.name === "TimeoutError" ? "time_limit" : "capture_failed" };
        }
      } finally {
        await context.close().catch(() => undefined);
      }
    },
  });
}

/** The executor's Chromium (its own sandbox on, DevTools on loopback), connected for the driver. `close` ends the browser and removes its scratch. */
export async function openEvidenceChromium(input: { signal: AbortSignal }): Promise<{ browser: Browser; close(): Promise<void> }> {
  const downloads = await mkdtemp(join(tmpdir(), "rovara-evidence-"));
  let local: Awaited<ReturnType<typeof launchLocalChromium>> | undefined;
  try {
    local = await launchLocalChromium({ downloadDir: downloads, signal: input.signal });
    const browser = await chromium.connectOverCDP(local.cdpEndpoint);
    const opened = local;
    return {
      browser,
      async close() {
        await browser.close().catch(() => undefined);
        await opened.close().catch(() => undefined);
        await rm(downloads, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await local?.close().catch(() => undefined);
    await rm(downloads, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
