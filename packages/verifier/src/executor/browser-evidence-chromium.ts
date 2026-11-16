// TE-H1 browser evidence: the real driver. The project's own start command starts the app (in its own process group, so stopping it stops only what it started; a start command that
// daemonizes out of the group is left to the sandbox's own teardown), and a headless Chromium (the executor's `launchLocalChromium`, its own sandbox on) opens each route on the app's
// origin only (`http://127.0.0.1:<port>`; any other origin is aborted before and during the load; WebSockets are not routed, which the sandbox's network walls cover).
//
// Masking, in this order, around the one JPEG: every frame's text, open shadow roots, form values, placeholders, image alt text and title are scrubbed (contracts' text masks); the
// page's own scripts are stopped (CDP `Emulation.setScriptExecutionDisabled`; this stops timers, frames and event handlers but not a promise continuation already queued); the
// network is then cut (the context goes offline), so no late answer can bring new data; everything is scrubbed again; a verify pass re-reads it all (each text node, field and alt, and the joined
// visible text of the page and of each shadow root, which catches a secret split over several nodes); the masked elements are painted over and the picture taken; and the verify pass
// runs AGAIN after the picture: raw text that reached the paint is still in the page then (nothing rewrites it back to masked), so any match means the picture is dropped ("withheld").
// Not reachable by any text scrub, and so left to mask selectors: canvas (masked by default), images' own pixels, CSS generated content, closed shadow roots, and out-of-process frames
// (another origin's frames are aborted). Every step is bounded by the page's time; the context is closed after each page, which also ends a renderer that is still busy.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  BROWSER_EVIDENCE_TEXT_MASK, BROWSER_EVIDENCE_TEXT_MASKS, BROWSER_EVIDENCE_TEXT_SCAN_MAX, browserEvidenceSecretMasks, isBrowserEvidenceRoute,
  type BrowserEvidenceExecutorSignIn, type BrowserEvidenceSignInValues,
} from "@agentx/contracts";
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
const CLOSE_MS = 5_000;
/** One step of a sign-in (a field that is not there, a button that does nothing) and the wait for the signed-in page: past these it is a sign-in that did not work, not a run that ran out of time. */
const SIGN_IN_STEP_MS = 5_000;
const SIGN_IN_WAIT_MS = 6_000;
/** The page's nodes and form fields read at most, and its characters in all; a page with more is not photographed. */
const PAGE_NODES_MAX = 50_000;
const PAGE_CHARS_MAX = 2_000_000;

const pause = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });

// ---- the app

export type ProjectApp = Readonly<{ stop(): Promise<void> }>;
export type ProjectAppStart = { status: "ready"; app: ProjectApp } | { status: "app_did_not_start" | "time_limit" };

/** Whether anything accepts a TCP connection on the loopback port (any listener, whatever it answers). */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Whether the app answers HTTP on the loopback port at this path (any status below 500). */
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
 * `http://127.0.0.1:<port><readyPath>` answers. Refuses a port anything already listens on (it would photograph another program). An app that exits, or does not answer within
 * `timeoutMs`, is stopped and reported; `stop` ends the whole group and waits for it.
 */
export async function startProjectApp(input: { command: string; cwd: string; port: number; readyPath?: string | undefined; timeoutMs: number; env: Readonly<Record<string, string>> }): Promise<ProjectAppStart> {
  const readyPath = input.readyPath ?? "/";
  if (typeof input.command !== "string" || input.command.length === 0 || !Number.isInteger(input.port) || input.port < 1_024 || input.port > 65_535 || !isBrowserEvidenceRoute(readyPath)) return { status: "app_did_not_start" };
  if (await listening(input.port)) return { status: "app_did_not_start" };
  let child: ChildProcess;
  try {
    child = spawn("/bin/sh", ["-c", input.command], { cwd: input.cwd, env: { ...input.env, PORT: String(input.port) }, detached: true, stdio: "ignore" });
  } catch { return { status: "app_did_not_start" }; }
  let exited = false;
  child.once("exit", () => { exited = true; });
  child.once("error", () => { exited = true; });
  const groupAlive = () => { if (child.pid === undefined) return false; try { process.kill(-child.pid, 0); return true; } catch { return false; } };
  const signalGroup = (signal: NodeJS.Signals) => { if (child.pid !== undefined) { try { process.kill(-child.pid, signal); } catch { /* the group is already gone */ } } };
  // Waits until nothing of the group is left (not only its leader, the shell): the app the shell started can outlive the shell by a moment, and the next side must find the port free.
  const groupGone = async (ms: number): Promise<void> => {
    const end = Date.now() + ms;
    while (groupAlive() && Date.now() < end) await pause(25);
  };
  const stop = async (): Promise<void> => {
    // The group, not only the shell: the app the shell started is in it. Only this group, never by name; never signalled again once it is gone (its id could be reused).
    if (!groupAlive()) return;
    signalGroup("SIGTERM");
    await groupGone(STOP_GRACE_MS);
    if (groupAlive()) signalGroup("SIGKILL");
    await groupGone(STOP_KILLED_MS);
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

type PageArg = { masks: ReadonlyArray<{ source: string; flags: string; label?: boolean }>; mask: string; maxText: number; maxNodes: number; maxChars: number; verify: boolean; maskedSelector: string };
type PageVerdict = "clean" | "dirty" | "too_large";

/**
 * Runs IN THE PAGE (each frame). `verify: false` replaces every text mask in the text nodes (light DOM and open shadow roots), form values, placeholders and the title. `verify: true`
 * changes nothing and says "dirty" when any of them, or the joined visible text of the page or of a shadow root, still matches a mask (fields inside a masked element and hidden fields
 * are not read: they are painted over, or never shown). "too_large" past the node or character budget. Self-contained: everything it uses is in its argument. This package has no DOM
 * types, so the document is described by the little this function touches (1 and 4 are ELEMENT_NODE and SHOW_ELEMENT|SHOW_TEXT's text bit).
 */
function maskPage(arg: PageArg): PageVerdict {
  type Field = { value?: unknown; placeholder?: unknown; type?: unknown; closest?(selector: string): unknown; getAttribute?(name: string): string | null; setAttribute?(name: string, value: string): void; complete?: unknown; naturalWidth?: unknown };
  type Child = { nodeType: number; nodeValue: string | null; innerText?: unknown };
  type Root = { querySelectorAll(selector: string): ArrayLike<Field>; childNodes?: ArrayLike<Child> };
  type Node = { nodeType: number; nodeValue: string | null; shadowRoot?: Root | null; parentNode?: { nodeName?: string } | null };
  type Doc = Root & { documentElement: unknown; title: string; body: { innerText?: unknown } | null; createTreeWalker(root: unknown, show: number): { nextNode(): Node | null } };
  const doc = (globalThis as unknown as { document: Doc }).document;
  const patterns = arg.masks.map((item) => new RegExp(item.source, item.flags));
  const plain = arg.masks.filter((item) => item.label !== true).map((item) => new RegExp(item.source, item.flags));
  const labelled = arg.masks.filter((item) => item.label === true).map((item) => new RegExp(item.source, item.flags));
  const hits = (text: string): boolean => text.length > arg.maxText || patterns.some((pattern) => text.search(pattern) !== -1);
  // Joined text may be long: it is read in overlapping windows (the character budget already bounds it), so a long page is not withheld for its length alone.
  const joinedHits = (text: string, among: RegExp[]): boolean => {
    for (let start = 0; start < text.length; start += arg.maxText - 1_000) {
      const window = text.slice(start, start + arg.maxText);
      if (among.some((pattern) => window.search(pattern) !== -1)) return true;
      if (start + arg.maxText >= text.length) break;
    }
    return false;
  };
  const scrub = (text: string): string => {
    if (text.length > arg.maxText) return arg.mask;
    let out = text;
    for (const pattern of patterns) out = out.replace(pattern, arg.mask);
    return out;
  };
  const masked = (field: Field): boolean => { try { return arg.maskedSelector !== "" && typeof field.closest === "function" && field.closest(arg.maskedSelector) !== null; } catch { return false; } };
  const unseen = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  let nodes = 0;
  let chars = 0;
  const pending: unknown[] = [doc.documentElement];
  const roots: Array<{ root: Root; joined: string[] }> = [{ root: doc, joined: [] }];
  while (pending.length > 0) {
    const top = pending.pop();
    const walker = doc.createTreeWalker(top, 5);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      nodes += 1;
      if (nodes > arg.maxNodes) return "too_large";
      if (node.nodeType === 1) {
        const shadow = node.shadowRoot;
        if (shadow !== null && shadow !== undefined) { pending.push(shadow); roots.push({ root: shadow, joined: [] }); }
        continue;
      }
      if (unseen.has(node.parentNode?.nodeName ?? "")) continue;
      const text = node.nodeValue ?? "";
      chars += text.length;
      if (chars > arg.maxChars) return "too_large";
      if (arg.verify) { if (hits(text)) return "dirty"; continue; }
      const out = scrub(text);
      if (out !== text) node.nodeValue = out;
    }
  }
  for (const { root } of roots) {
    for (const field of Array.from(root.querySelectorAll("input, textarea"))) {
      nodes += 1;
      if (nodes > arg.maxNodes) return "too_large";
      if (field.type === "hidden") continue;
      for (const key of ["value", "placeholder"] as const) {
        const text = field[key];
        if (typeof text !== "string" || text === "") continue;
        chars += text.length;
        if (chars > arg.maxChars) return "too_large";
        if (arg.verify) { if (!masked(field) && hits(text)) return "dirty"; } else field[key] = scrub(text);
      }
    }
  }
  // Alt text is painted in place of an image that does not load (and another origin's images are aborted): scrubbed, verified, and blanked for a broken image.
  for (const { root } of roots) {
    for (const image of Array.from(root.querySelectorAll("img[alt], input[alt], area[alt]"))) {
      nodes += 1;
      if (nodes > arg.maxNodes) return "too_large";
      const alt = image.getAttribute?.("alt") ?? "";
      chars += alt.length;
      if (chars > arg.maxChars) return "too_large";
      if (alt === "") continue;
      if (arg.verify) { if (!masked(image) && hits(alt)) return "dirty"; continue; }
      const broken = image.complete === true && image.naturalWidth === 0;
      image.setAttribute?.("alt", broken ? "" : scrub(alt));
    }
  }
  if (!arg.verify) { doc.title = scrub(doc.title); return "clean"; }
  if (hits(doc.title)) return "dirty";
  // The page's text as it is composed on screen (shadow roots in place of their hosts' children, slotted nodes where their slot is, hidden elements left out, whitespace
  // collapsed, a line break at every block edge and <br>), read whole so a secret split over several elements is seen. Two views from one walk: `shown`, everything as rendered, for
  // the ordinary masks; and `labels`, for the labelled masks, where a form field is a marker line, a link or a button is its own line (its text kept) and a label's edges start a line.
  type El = Child & { tagName?: string; getAttribute?(name: string): string | null; shadowRoot?: { childNodes: ArrayLike<Child> } | null; childNodes?: ArrayLike<Child>; assignedNodes?(options: { flatten: boolean }): ArrayLike<Child> };
  const view = globalThis as unknown as { getComputedStyle(element: unknown): { display: string; visibility: string; whiteSpace?: string } };
  const skipped = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE"]);
  // In the label view: a form field is a line of its own holding only a marker (too short to be a value), so a "Password:" label is never "followed" across its own field; a link
  // or a button is a line of its own WITH its text, so a value inside one (a click-to-copy key, a key that is a link) is still read as the line after its label.
  const fields = new Set(["SELECT", "INPUT", "TEXTAREA"]);
  const lines = new Set(["A", "BUTTON", "SUMMARY"]);
  let shown = "";
  let labels = "";
  // A second label view, `inline`: the same, except links and buttons do not break lines, so a label beside a button ("API key: [Hide key] abcd1234"), a value inside a link with
  // more text, or a label that is itself a link is read on one line. The labelled masks run over both views.
  let inline = "";
  let walked = 0;
  let tooLarge = false;
  const walk = (node: El, visible: boolean, pre: boolean): void => {
    if (tooLarge) return;
    walked += 1;
    if (walked > arg.maxNodes || shown.length > arg.maxChars) { tooLarge = true; return; }
    if (node.nodeType === 3) {
      if (!visible) return;
      // Whitespace as it is rendered: collapsed, except where the element keeps it (pre), so numbers on separate lines stay on separate lines.
      const text = pre ? (node.nodeValue ?? "") : (node.nodeValue ?? "").replace(/[ \t\n\r\f]+/gu, " ");
      shown += text;
      labels += text;
      inline += text;
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    const tag = node.tagName ?? "";
    if (skipped.has(tag)) return;
    let block = false;
    let seen = visible;
    let keep = pre;
    if (node.nodeType === 1) {
      const style = view.getComputedStyle(node);
      if (style.display === "none") return;
      seen = style.visibility !== "hidden" && style.visibility !== "collapse";
      block = !style.display.startsWith("inline") && style.display !== "contents";
      keep = typeof style.whiteSpace === "string" ? style.whiteSpace.startsWith("pre") || style.whiteSpace === "break-spaces" : pre;
    }
    if (tag === "BR") { shown += "\n"; labels += "\n"; inline += "\n"; return; }
    const field = fields.has(tag);
    const line = lines.has(tag) || node.getAttribute?.("role") === "button";
    const edge = block || line || tag === "LABEL";
    if (block) shown += "\n";
    if (field) { labels += "\n\u25aa\n"; inline += "\n\u25aa\n"; }
    else { if (edge) labels += "\n"; if (block || tag === "LABEL") inline += "\n"; }
    const slotted = tag === "SLOT" && typeof node.assignedNodes === "function" ? Array.from(node.assignedNodes({ flatten: true })) : [];
    const children = node.shadowRoot ? Array.from(node.shadowRoot.childNodes) : slotted.length > 0 ? slotted : Array.from(node.childNodes ?? []);
    for (const child of children) walk(child, seen, keep);
    if (block) shown += "\n";
    if (edge || field) labels += "\n";
    if (block || tag === "LABEL" || field) inline += "\n";
  };
  walk(doc.documentElement as El, true, false);
  if (tooLarge) return "too_large";
  // Empty lines left by nested block edges are folded, so a <dt> label and its <dd> value are on neighbouring lines.
  if (joinedHits(shown, plain) || joinedHits(labels.replace(/(?:[^\S\n]*\n)+/gu, "\n"), labelled) || joinedHits(inline.replace(/(?:[^\S\n]*\n)+/gu, "\n"), labelled)) return "dirty";
  return "clean";
}

export type ChromiumEvidenceDriverInput = Readonly<{
  /** A Chromium the caller owns (`openEvidenceChromium`, or a launched one in tests). */
  browser: Pick<Browser, "newContext">;
  /** The app's origin, `http://127.0.0.1:<port>`: the only origin a page may load from. */
  origin: string;
  app: Readonly<{ start(side: BrowserEvidenceSide, timeoutMs: number): Promise<"ready" | "app_did_not_start" | "time_limit">; stop(side: BrowserEvidenceSide): Promise<void> }>;
  /**
   * Slice 3, an app behind a login: the form and the saved values. `signIn()` opens the login page in a scratch browser context, fills the two fields, presses the button and waits for the signed-in page; the session
   * (in memory only) is then the starting point of every page. Both values are also masks of the page's own text, in every encoding an app may echo them in, so a page that shows the account never shows it.
   */
  signIn?: Readonly<{ form: BrowserEvidenceExecutorSignIn; values: BrowserEvidenceSignInValues }>;
}>;

/** The driver `runBrowserEvidence` uses, and, when the recipe has a sign-in, the one step that signs in before any page is taken. */
export type ChromiumEvidenceDriver = BrowserEvidenceDriver & Readonly<{ signIn(options: { timeoutMs: number }): Promise<"ok" | "sign_in_failed" | "time_limit"> }>;

class StepTimeout extends Error { override name = "TimeoutError"; }
/** The work, or a `StepTimeout` once `ms` have passed. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StepTimeout()), Math.max(1, ms)); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
const timedOut = (error: unknown) => error instanceof Error && error.name === "TimeoutError";
const originOf = (url: string): string | undefined => { try { return new URL(url).origin; } catch { return undefined; } };

/** The driver `runBrowserEvidence` uses in the sandbox and on a laptop. */
export function createChromiumEvidenceDriver(input: ChromiumEvidenceDriverInput): ChromiumEvidenceDriver {
  const origin = new URL(input.origin).origin;
  if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/u.test(origin)) throw new Error("browser evidence opens only the app on the loopback address");
  // The signed-in session of this run: set once by `signIn`, in memory only, and never read by anything but the contexts of this driver. `undefined`: no sign-in was asked for or none worked.
  let session: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined;
  const secretMasks = input.signIn === undefined ? [] : browserEvidenceSecretMasks(input.signIn.values);
  /** Only the app's own origin is loaded: anything else (a font, an analytics call, a redirect away, a third-party frame) is aborted. */
  const onlyOwnOrigin = (context: BrowserContext, ms: () => number) => bounded(context.route("**/*", (routed) => (originOf(routed.request().url()) === origin ? routed.continue() : routed.abort("blockedbyclient"))), ms());
  return Object.freeze({
    startApp: (side: BrowserEvidenceSide, options: { timeoutMs: number }) => input.app.start(side, options.timeoutMs),
    stopApp: (side: BrowserEvidenceSide) => input.app.stop(side),
    async signIn(options: { timeoutMs: number }): Promise<"ok" | "sign_in_failed" | "time_limit"> {
      const sign = input.signIn;
      // No sign-in asked for, or values that would not mask (a value that is not a valid sign-in value never reaches a form): nothing is typed anywhere.
      if (sign === undefined || secretMasks.length === 0) return "sign_in_failed";
      const deadline = Date.now() + Math.max(1, options.timeoutMs);
      const left = () => Math.max(1, deadline - Date.now());
      let context: BrowserContext | undefined;
      try {
        context = await bounded(input.browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block", acceptDownloads: false }), left());
        await onlyOwnOrigin(context, left);
        const page: Page = await bounded(context.newPage(), left());
        const response = await bounded(page.goto(new URL(sign.form.path, origin).href, { waitUntil: "load", timeout: left() }), left());
        if (response === null || response.status() >= 400 || originOf(page.url()) !== origin) return "sign_in_failed";
        // Each field must be there and shown: a form that is not what the recipe says is a sign-in that did not work, never a guess at another field.
        const user = page.locator(sign.form.usernameSelector).first();
        const password = page.locator(sign.form.passwordSelector).first();
        const step = () => Math.min(left(), SIGN_IN_STEP_MS);
        const wait = () => Math.min(left(), SIGN_IN_WAIT_MS);
        await bounded(user.fill(sign.values.username, { timeout: step() }), left());
        await bounded(password.fill(sign.values.password, { timeout: step() }), left());
        await bounded(page.locator(sign.form.submitSelector).first().click({ timeout: step() }), left());
        if (sign.form.successPath !== undefined) {
          const wanted = sign.form.successPath;
          await bounded(page.waitForURL((url) => url.origin === origin && url.pathname === wanted, { timeout: wait() }), left());
        } else await bounded(page.locator(sign.form.successSelector!).first().waitFor({ state: "visible", timeout: wait() }), left());
        // Still on the app, and not back on the login page: that is the one thing a bad password leaves behind.
        if (originOf(page.url()) !== origin || new URL(page.url()).pathname === sign.form.path) return "sign_in_failed";
        session = await bounded(context.storageState(), left());
        return "ok";
      } catch (error) {
        // Never the error's own words: a failure message from a page or a driver can quote what was typed. Only the run's own time running out is "time limit"; a step or a wait that ended first is a sign-in that did not work.
        return timedOut(error) && Date.now() >= deadline - 250 ? "time_limit" : "sign_in_failed";
      } finally {
        if (context !== undefined) await bounded(context.close(), CLOSE_MS).catch(() => undefined);
      }
    },
    async capture(_side: BrowserEvidenceSide, route: string, options: { maskSelectors: readonly string[]; timeoutMs: number }): Promise<BrowserEvidenceCaptureAnswer> {
      if (!isBrowserEvidenceRoute(route)) return { ok: false, reason: "page_did_not_load" };
      const url = new URL(route, origin);
      if (url.origin !== origin) return { ok: false, reason: "page_did_not_load" };
      const deadline = Date.now() + Math.max(1, options.timeoutMs);
      const left = () => Math.max(1, deadline - Date.now());
      let context: BrowserContext | undefined;
      try {
        // A run with a sign-in that did not work (or was never made) takes no page: a signed-out page photographed as the signed-in one would be a false picture.
        if (input.signIn !== undefined && session === undefined) return { ok: false, reason: "capture_failed" };
        context = await bounded(input.browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block", acceptDownloads: false, ...(session === undefined ? {} : { storageState: session }) }), left());
        await onlyOwnOrigin(context, left);
        const page: Page = await bounded(context.newPage(), left());
        // The page's own errors only: a console error about a request Rovara blocked (another origin) is not the change's.
        let consoleErrors = 0;
        page.on("console", (message) => { if (message.type() === "error" && originOf(message.location().url) === origin) consoleErrors += 1; });
        page.on("pageerror", () => { consoleErrors += 1; });
        try {
          const response = await bounded(page.goto(url.href, { waitUntil: "load", timeout: left() }), left());
          if (response === null || response.status() >= 400 || originOf(page.url()) !== origin) return { ok: false, reason: "page_did_not_load" };
          // Sent back to the login page: the session did not hold, and the login form is not the picture of this page.
          if (input.signIn !== undefined && url.pathname !== input.signIn.form.path && new URL(page.url()).pathname === input.signIn.form.path) return { ok: false, reason: "capture_failed" };
        } catch (error) {
          return { ok: false, reason: timedOut(error) ? "time_limit" : "page_did_not_load" };
        }
        const arg = (verify: boolean): PageArg => ({ masks: [...BROWSER_EVIDENCE_TEXT_MASKS.map((item) => ({ ...item })), ...secretMasks], mask: BROWSER_EVIDENCE_TEXT_MASK, maxText: BROWSER_EVIDENCE_TEXT_SCAN_MAX,
          maxNodes: PAGE_NODES_MAX, maxChars: PAGE_CHARS_MAX, verify, maskedSelector: options.maskSelectors.join(", ") });
        // Every frame the page has: the app's own (and about:/srcdoc ones) are read; a frame of another origin was aborted, so it shows only the browser's error page.
        const everyFrame = async (verify: boolean): Promise<PageVerdict> => {
          for (const frame of page.frames()) {
            // Every frame is read, whatever its address (an aborted frame shows the browser's error page, which reads fine); a frame that cannot be read means no picture.
            let verdict: PageVerdict;
            try { verdict = await bounded(frame.evaluate(maskPage, arg(verify)), left()); } catch (error) {
              if (timedOut(error)) throw error;
              return "too_large";
            }
            if (verdict !== "clean") return verdict;
          }
          return "clean";
        };
        try {
          if ((await everyFrame(false)) !== "clean") return { ok: false, reason: "capture_failed" };
          // Freeze, then cut the network: the page's own scripts stop, so no re-render can bring the raw text back, and no late answer brings new data; then scrub what changed since, and verify.
          const session = await bounded(context.newCDPSession(page), left());
          await bounded(session.send("Emulation.setScriptExecutionDisabled", { value: true }), left());
          // Offline only once frozen: the app's own "offline" handlers cannot run and paint a banner into the picture.
          await bounded(context.setOffline(true), left());
          if ((await everyFrame(false)) !== "clean") return { ok: false, reason: "capture_failed" };
          const verdict = await everyFrame(true);
          if (verdict === "dirty") return { ok: false, reason: "masked_content" };
          if (verdict !== "clean") return { ok: false, reason: "capture_failed" };
          const bytes = await bounded(page.screenshot({
            type: "jpeg", quality: SCREENSHOT_QUALITY, timeout: Math.min(SCREENSHOT_TIMEOUT_MS, left()), animations: "disabled", caret: "hide",
            mask: options.maskSelectors.map((selector) => page.locator(selector)), maskColor: "#5c5c5c",
          }), left());
          // Again after the picture: a continuation that ran between the verify pass and the paint left its raw text in the page.
          const after = await everyFrame(true);
          if (after === "dirty") return { ok: false, reason: "masked_content" };
          if (after !== "clean") return { ok: false, reason: "capture_failed" };
          return { ok: true, bytes: Uint8Array.from(bytes), consoleErrors };
        } catch (error) {
          return { ok: false, reason: timedOut(error) ? "time_limit" : "capture_failed" };
        }
      } catch (error) {
        return { ok: false, reason: timedOut(error) ? "time_limit" : "capture_failed" };
      } finally {
        // Closing the context also ends a renderer that is still busy (a page whose script never yields).
        if (context !== undefined) await bounded(context.close(), CLOSE_MS).catch(() => undefined);
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
