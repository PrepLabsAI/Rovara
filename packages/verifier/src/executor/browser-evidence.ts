// TE-H1 browser evidence: the runner. For each picked route it takes one screenshot on the base code ("before") and one on the candidate ("after"), through a driver that starts the
// project's app in the sandbox and drives a headless Chromium (browser-evidence-chromium.ts; tests use a fake). It holds the run to one time limit and one byte budget, keeps each
// screenshot within the e2e capture cap, drops one that carries a known credential, and always stops the app it started. A page that cannot be shown is "Not run" with a fixed reason.
// Nothing here decides whether a change is proven: the result is visual evidence only (contracts/browser-evidence.ts).
import { createHash } from "node:crypto";
import {
  BROWSER_EVIDENCE_ISOLATIONS, BROWSER_EVIDENCE_NOT_SHOWN_MAX, BROWSER_EVIDENCE_PAGE_MS, BROWSER_EVIDENCE_ROUTES_MAX, BROWSER_EVIDENCE_RUN_MS, BROWSER_EVIDENCE_TOTAL_MAX_BYTES,
  isBrowserEvidenceRoute, withDefaultMasks,
  type BrowserEvidenceCaptured, type BrowserEvidenceIsolation, type BrowserEvidenceNotRunReason, type BrowserEvidenceNotShown, type BrowserEvidenceRouteResult, type BrowserEvidenceShot,
} from "@agentx/contracts";
import { CAPTURE_SCREENSHOT_MAX_BYTES } from "./capture.js";

export type BrowserEvidenceSide = "before" | "after";
export type { BrowserEvidenceCaptured };
/** What the driver may answer for one page: the JPEG and its console error count, or one of these fixed reasons. Anything else is read as `capture_failed`. */
export type BrowserEvidenceCaptureAnswer = { ok: true; bytes: Uint8Array; consoleErrors: number } | { ok: false; reason: "page_did_not_load" | "time_limit" | "capture_failed" };
export type BrowserEvidenceDriver = Readonly<{
  /** Starts the project's app for this side (the base checkout or the candidate) and waits until it answers. Anything but "ready" means it did not start. */
  startApp(side: BrowserEvidenceSide, options: { timeoutMs: number }): Promise<"ready" | "app_did_not_start" | "time_limit">;
  /** Opens one route of the app, masks it and takes one JPEG. */
  capture(side: BrowserEvidenceSide, route: string, options: { maskSelectors: readonly string[]; timeoutMs: number }): Promise<BrowserEvidenceCaptureAnswer>;
  /** Stops what `startApp` started for this side. Called once after every `startApp`, whatever it answered. */
  stopApp(side: BrowserEvidenceSide): Promise<void>;
}>;

export type BrowserEvidenceRunInput = Readonly<{
  isolation: BrowserEvidenceIsolation;
  /** The picked routes (`pickChangedRoutes`), at most `BROWSER_EVIDENCE_ROUTES_MAX`. */
  routes: readonly string[];
  notShown: readonly BrowserEvidenceNotShown[];
  moreNotShown: number;
  /** Extra selectors to paint over; the defaults are always added. */
  maskSelectors: readonly string[];
  driver: BrowserEvidenceDriver;
  /** The run's credential scan (the executor's `CredentialRedactor`): a screenshot it finds a credential in is not kept. */
  redactor?: Readonly<{ contains(bytes: Uint8Array): boolean }>;
  now?: () => number;
  /** Lower limits for this run; the built-in limits are the most a caller can get. */
  limits?: Readonly<{ runMs?: number; pageMs?: number; totalBytes?: number }>;
}>;

const INVALID = "browser evidence input is not valid";
const SIDES: readonly BrowserEvidenceSide[] = ["before", "after"];
const DRIVER_REASONS = new Set(["page_did_not_load", "time_limit", "capture_failed"]);
const isJpeg = (bytes: Uint8Array) => bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const lower = (given: number | undefined, most: number) => (typeof given === "number" && Number.isFinite(given) && given > 0 ? Math.min(given, most) : most);

type Kept = BrowserEvidenceShot & { consoleErrors: number };

/** One driver answer, held to what it says it is. Never throws; never keeps the driver's own words. */
function keepShot(answer: unknown, redactor: BrowserEvidenceRunInput["redactor"]): Kept | BrowserEvidenceNotRunReason {
  if (typeof answer !== "object" || answer === null) return "capture_failed";
  const { ok, bytes, consoleErrors, reason } = answer as Record<string, unknown>;
  if (ok === false) return typeof reason === "string" && DRIVER_REASONS.has(reason) ? (reason as BrowserEvidenceNotRunReason) : "capture_failed";
  if (ok !== true || !(bytes instanceof Uint8Array) || bytes.byteLength === 0 || !Number.isInteger(consoleErrors) || (consoleErrors as number) < 0 || (consoleErrors as number) > 1_000_000) return "capture_failed";
  if (!isJpeg(bytes)) return "capture_failed";
  if (bytes.byteLength > CAPTURE_SCREENSHOT_MAX_BYTES) return "over_size_cap";
  try {
    if (redactor?.contains(bytes) === true) return "masked_content";
  } catch { return "masked_content"; }
  const copy = Uint8Array.from(bytes);
  return { bytes: copy, sha256: sha256Of(copy), consoleErrors: consoleErrors as number };
}

/**
 * Runs the before and after screenshots. The base code's app is started, every route photographed and the app stopped; then the same for the candidate. Bounded: at most five routes, one
 * time limit for the whole run (a route reached after it is "Not run: time limit"), each page at most `BROWSER_EVIDENCE_PAGE_MS` and never more than what is left, and one byte budget
 * for everything kept (a route whose pair would pass it is "Not run: over the size cap"). An app that does not start on either side means no page is shown. Refuses input it was not built for.
 */
export async function runBrowserEvidence(input: BrowserEvidenceRunInput): Promise<BrowserEvidenceCaptured> {
  const { routes, driver } = input;
  if (!(BROWSER_EVIDENCE_ISOLATIONS as readonly string[]).includes(input.isolation) || !Array.isArray(routes) || routes.length === 0 || routes.length > BROWSER_EVIDENCE_ROUTES_MAX
    || !routes.every(isBrowserEvidenceRoute) || new Set(routes).size !== routes.length || !Array.isArray(input.notShown) || input.notShown.length > BROWSER_EVIDENCE_NOT_SHOWN_MAX
    || !Number.isInteger(input.moreNotShown) || input.moreNotShown < 0) throw new Error(INVALID);
  const now = input.now ?? Date.now;
  const started = now();
  const deadline = started + lower(input.limits?.runMs, BROWSER_EVIDENCE_RUN_MS);
  const pageMs = lower(input.limits?.pageMs, BROWSER_EVIDENCE_PAGE_MS);
  const totalBytes = lower(input.limits?.totalBytes, BROWSER_EVIDENCE_TOTAL_MAX_BYTES);
  const maskSelectors = withDefaultMasks(input.maskSelectors);
  const failed = new Map<string, BrowserEvidenceNotRunReason>();
  const kept: Record<BrowserEvidenceSide, Map<string, Kept>> = { before: new Map(), after: new Map() };
  const base = { isolation: input.isolation, notShown: input.notShown.map((row) => ({ ...row })), moreNotShown: input.moreNotShown };
  const fail = (route: string, reason: BrowserEvidenceNotRunReason) => { if (!failed.has(route)) failed.set(route, reason); };

  for (const side of SIDES) {
    const pending = routes.filter((route) => !failed.has(route));
    if (pending.length === 0) break;
    if (deadline - now() <= 0) { for (const route of pending) fail(route, "time_limit"); break; }
    let ready = false;
    try {
      try { ready = (await driver.startApp(side, { timeoutMs: deadline - now() })) === "ready"; } catch { ready = false; }
      if (!ready) return { ...base, durationMs: Math.max(0, now() - started), routes: [], notRun: "app_did_not_start" };
      for (const route of pending) {
        const left = deadline - now();
        if (left <= 0) { fail(route, "time_limit"); continue; }
        let answer: unknown;
        try { answer = await driver.capture(side, route, { maskSelectors, timeoutMs: Math.min(pageMs, left) }); } catch { answer = undefined; }
        const shot = keepShot(answer, input.redactor);
        if (typeof shot === "string") fail(route, shot);
        else kept[side].set(route, shot);
      }
    } finally {
      try { await driver.stopApp(side); } catch { /* the driver's stop is its own; a failure there changes no result */ }
    }
  }

  let used = 0;
  const results: Array<BrowserEvidenceRouteResult<BrowserEvidenceShot>> = routes.map((route) => {
    const before = kept.before.get(route);
    const after = kept.after.get(route);
    const reason = failed.get(route);
    if (reason !== undefined || before === undefined || after === undefined) return { route, status: "not_run", reason: reason ?? "capture_failed" };
    if (used + before.bytes.byteLength + after.bytes.byteLength > totalBytes) return { route, status: "not_run", reason: "over_size_cap" };
    used += before.bytes.byteLength + after.bytes.byteLength;
    return { route, status: "shown", before: { sha256: before.sha256, bytes: before.bytes }, after: { sha256: after.sha256, bytes: after.bytes }, consoleErrors: { before: before.consoleErrors, after: after.consoleErrors } };
  });
  return { ...base, durationMs: Math.max(0, now() - started), routes: results };
}
