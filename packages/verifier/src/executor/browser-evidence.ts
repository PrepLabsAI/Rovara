// TE-H1 browser evidence: the runner. For each picked route it takes one screenshot on the base code ("before") and one on the candidate ("after"), through a driver that starts the
// project's app in the sandbox and drives a headless Chromium (browser-evidence-chromium.ts; tests use a fake). It holds the run to one time limit (every driver call is raced against
// the time left, so a page that never answers cannot hold the run) and one byte budget, keeps each screenshot within the e2e capture cap, and always stops the app it started (that wait
// is bounded too). A page that cannot be shown is "Not run" with a fixed reason. The masking itself is the driver's (scrub, freeze, scrub again, verify, then the picture); the
// credential scan of the JPEG bytes here is defence in depth only: rendered text becomes compressed pixels, so it rarely sees one.
// Nothing here decides whether a change is proven: the result is visual evidence only (contracts/browser-evidence.ts).
import { createHash } from "node:crypto";
import {
  BROWSER_EVIDENCE_ISOLATIONS, BROWSER_EVIDENCE_MASK_SELECTORS_MAX, BROWSER_EVIDENCE_NOT_SHOWN_MAX, BROWSER_EVIDENCE_NOT_SHOWN_REASONS, BROWSER_EVIDENCE_PAGE_MS, BROWSER_EVIDENCE_ROUTES_MAX, BROWSER_EVIDENCE_RUN_MS, BROWSER_EVIDENCE_TOTAL_MAX_BYTES,
  BROWSER_EVIDENCE_VIDEOS_MAX, BROWSER_EVIDENCE_VIDEO_MAX_BYTES, BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES,
  browserEvidenceVideoEligible, isBrowserEvidenceRoute, isWebm, withDefaultMasks,
  type BrowserEvidenceCaptured, type BrowserEvidenceIsolation, type BrowserEvidenceNotRunReason, type BrowserEvidenceNotShown, type BrowserEvidenceRouteResult, type BrowserEvidenceShot, type BrowserEvidenceVideoNotKeptReason,
} from "@agentx/contracts";
import { CAPTURE_SCREENSHOT_MAX_BYTES } from "./capture.js";

export type BrowserEvidenceSide = "before" | "after";
export type { BrowserEvidenceCaptured };
/**
 * What the driver may answer for one page: the JPEG and its console error count, or one of these fixed reasons. Anything else is read as `capture_failed`. With `video` asked for (the candidate's side of a recipe
 * that says its app shows fixture data only), an answer may also carry the recording of that page's load, or the fixed reason there is none; the runner keeps it only for a page that failed or showed errors.
 */
export type BrowserEvidenceVideoAnswer = { video?: Uint8Array; videoNotKept?: "over_size_cap" | "not_recorded" | "withheld" };
export type BrowserEvidenceCaptureAnswer = ({ ok: true; bytes: Uint8Array; consoleErrors: number } | { ok: false; reason: "page_did_not_load" | "time_limit" | "capture_failed" | "masked_content" }) & BrowserEvidenceVideoAnswer;
export type BrowserEvidenceDriver = Readonly<{
  /** Starts the project's app for this side (the base checkout or the candidate) and waits until it answers. Anything but "ready" means it did not start. */
  startApp(side: BrowserEvidenceSide, options: { timeoutMs: number }): Promise<"ready" | "app_did_not_start" | "time_limit" | "sign_in_failed">;
  /** Opens one route of the app, masks it and takes one JPEG. */
  capture(side: BrowserEvidenceSide, route: string, options: { maskSelectors: readonly string[]; timeoutMs: number; video?: true }): Promise<BrowserEvidenceCaptureAnswer>;
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
  /** Slice 4: the recipe says its app shows fixture data only and asks for a video of a failed page. The candidate's side is recorded; nothing is recorded otherwise. */
  video?: boolean;
  driver: BrowserEvidenceDriver;
  /** The run's credential scan (the executor's `CredentialRedactor`) over the JPEG bytes (and a video's): defence in depth only (see the file header). */
  redactor?: Readonly<{ contains(bytes: Uint8Array): boolean }>;
  now?: () => number;
  /** Lower limits for this run; the built-in limits are the most a caller can get. */
  limits?: Readonly<{ runMs?: number; pageMs?: number; totalBytes?: number }>;
}>;

const INVALID = "browser evidence input is not valid";
const SIDES: readonly BrowserEvidenceSide[] = ["before", "after"];
const DRIVER_REASONS = new Set(["page_did_not_load", "time_limit", "capture_failed", "masked_content"]);
const isJpeg = (bytes: Uint8Array) => bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** How long `stopApp` may take, whatever is left of the run: the app is always asked to stop, and the run never waits on it for longer. */
export const BROWSER_EVIDENCE_STOP_MS = 10_000;
const TIMED_OUT = Symbol("timed out");
const FAILED = Symbol("failed");
/** The work's answer, `FAILED` when it throws or rejects, or `TIMED_OUT` once `ms` have passed. */
async function within<T>(work: () => Promise<T>, ms: number): Promise<T | typeof TIMED_OUT | typeof FAILED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let started: Promise<T | typeof FAILED>;
    try { started = work().catch((): typeof FAILED => FAILED); } catch { started = Promise.resolve(FAILED); }
    return await Promise.race<T | typeof TIMED_OUT | typeof FAILED>([started, new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, ms)); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
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

type VideoKept = { video: BrowserEvidenceShot } | { notKept: BrowserEvidenceVideoNotKeptReason };

/**
 * One candidate-side answer's video, for a page whose result is one a video may be kept for (a page that failed, or that showed errors): the recording held to being a WebM within the per-video cap and free of
 * the run's credentials, or the fixed reason there is none. A page that is not eligible keeps nothing (a recording of a healthy page is simply dropped), and a page withheld for what it showed is never eligible.
 * Never throws and never keeps the driver's own words.
 */
function keepVideo(answer: unknown, shown: Kept | BrowserEvidenceNotRunReason, redactor: BrowserEvidenceRunInput["redactor"]): VideoKept | undefined {
  const eligible = typeof shown === "string" ? browserEvidenceVideoEligible({ status: "not_run", reason: shown }) : browserEvidenceVideoEligible({ status: "shown", consoleErrors: { after: shown.consoleErrors } });
  if (!eligible) return undefined;
  const given = typeof answer === "object" && answer !== null ? answer as Record<string, unknown> : {};
  const bytes = given["video"];
  if (bytes === undefined) {
    const said = given["videoNotKept"];
    return { notKept: said === "over_size_cap" || said === "withheld" ? said : "not_recorded" };
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || !isWebm(bytes)) return { notKept: "not_recorded" };
  if (bytes.byteLength > BROWSER_EVIDENCE_VIDEO_MAX_BYTES) return { notKept: "over_size_cap" };
  try {
    if (redactor?.contains(bytes) === true) return { notKept: "withheld" };
  } catch { return { notKept: "withheld" }; }
  const copy = Uint8Array.from(bytes);
  return { video: { bytes: copy, sha256: sha256Of(copy) } };
}

/**
 * Runs the before and after screenshots. The base code's app is started, every route photographed and the app stopped; then the same for the candidate. Bounded: at most five routes, one
 * time limit for the whole run (a route reached after it is "Not run: time limit"), each page at most `BROWSER_EVIDENCE_PAGE_MS` and never more than what is left, and one byte budget
 * for everything kept (a route whose pair would pass it is "Not run: over the size cap"). An app that does not start on either side means no page is shown. Refuses input it was not built for.
 */
export async function runBrowserEvidence(input: BrowserEvidenceRunInput): Promise<BrowserEvidenceCaptured> {
  const { routes, driver } = input;
  // Runtime checks of what TypeScript promises: `Array.isArray` on a typed list would widen it to any[], so the list is read as unknown first.
  const notShownInput: unknown = input.notShown;
  const notShownOk = Array.isArray(notShownInput) && notShownInput.length <= BROWSER_EVIDENCE_NOT_SHOWN_MAX && notShownInput.every((row: unknown) => typeof row === "object" && row !== null
    && isBrowserEvidenceRoute((row as { route?: unknown }).route) && (BROWSER_EVIDENCE_NOT_SHOWN_REASONS as readonly unknown[]).includes((row as { reason?: unknown }).reason));
  const notShown: readonly BrowserEvidenceNotShown[] = input.notShown;
  if (!(BROWSER_EVIDENCE_ISOLATIONS as readonly string[]).includes(input.isolation) || !Array.isArray(routes) || routes.length === 0 || routes.length > BROWSER_EVIDENCE_ROUTES_MAX
    || !routes.every(isBrowserEvidenceRoute) || new Set(routes).size !== routes.length || !notShownOk
    || !Number.isInteger(input.moreNotShown) || input.moreNotShown < 0 || input.moreNotShown > 1_000_000
    || !Array.isArray(input.maskSelectors) || input.maskSelectors.length > BROWSER_EVIDENCE_MASK_SELECTORS_MAX) throw new Error(INVALID);
  const now = input.now ?? Date.now;
  const started = now();
  const deadline = started + lower(input.limits?.runMs, BROWSER_EVIDENCE_RUN_MS);
  const pageMs = lower(input.limits?.pageMs, BROWSER_EVIDENCE_PAGE_MS);
  const totalBytes = lower(input.limits?.totalBytes, BROWSER_EVIDENCE_TOTAL_MAX_BYTES);
  const maskSelectors = withDefaultMasks(input.maskSelectors);
  const failed = new Map<string, BrowserEvidenceNotRunReason>();
  const kept: Record<BrowserEvidenceSide, Map<string, Kept>> = { before: new Map(), after: new Map() };
  // Slice 4: only a run that asks (the recipe's fixture-data choice) records, and only the candidate's side. `leaked`: a page of either side was withheld for what it showed.
  const wantVideo = input.video === true;
  const videos = new Map<string, VideoKept>();
  let leaked = false;
  const base = { isolation: input.isolation, notShown: notShown.map((row) => ({ route: row.route, reason: row.reason })), moreNotShown: input.moreNotShown };
  const fail = (route: string, reason: BrowserEvidenceNotRunReason) => { if (!failed.has(route)) failed.set(route, reason); };

  for (const side of SIDES) {
    const pending = routes.filter((route) => !failed.has(route));
    if (pending.length === 0) break;
    if (deadline - now() <= 0) { for (const route of pending) fail(route, "time_limit"); break; }
    try {
      const left = deadline - now();
      let starting: Promise<unknown> | undefined;
      const answer = await within(() => { starting = driver.startApp(side, { timeoutMs: left }); return starting; }, left);
      // A start that answers after the run gave up on it has started an app nobody would stop: it is stopped as soon as that start settles (bounded like every stop).
      if (answer === TIMED_OUT && starting !== undefined) void starting.then(() => within(() => driver.stopApp(side), BROWSER_EVIDENCE_STOP_MS), () => undefined);
      const ready = answer === "ready";
      // A sign-in that did not work is said as such (the recipe's own fault to fix); every other answer is an app that did not start.
      if (!ready) return { ...base, durationMs: Math.max(0, now() - started), routes: [], notRun: answer === "sign_in_failed" ? "sign_in_failed" : "app_did_not_start" };
      for (const route of pending) {
        const left = deadline - now();
        const recording = wantVideo && side === "after";
        if (left <= 0) { fail(route, "time_limit"); continue; }
        const answer = await within(() => driver.capture(side, route, { maskSelectors, timeoutMs: Math.min(pageMs, left), ...(recording ? { video: true as const } : {}) }), Math.min(pageMs, left));
        const shot = answer === TIMED_OUT ? "time_limit" : keepShot(answer, input.redactor);
        if (shot === "masked_content") leaked = true;
        if (typeof shot === "string") fail(route, shot);
        else kept[side].set(route, shot);
        // The recording of the candidate's page: kept only for a page that failed to load or showed errors; one that left none says "not recorded".
        if (recording) {
          // A page whose text a mask had to rewrite (the driver says "withheld") was not showing fixture data only, healthy or not: the run drops every video.
          if (typeof answer === "object" && answer !== null && (answer as { videoNotKept?: unknown }).videoNotKept === "withheld") leaked = true;
          const video = answer === TIMED_OUT || answer === FAILED ? keepVideo({}, shot, input.redactor) : keepVideo(answer, shot, input.redactor);
          if (video !== undefined) videos.set(route, video);
        }
      }
    } finally {
      // Always asked, never waited on past its bound: a stop that fails or hangs changes no result.
      await within(() => driver.stopApp(side), BROWSER_EVIDENCE_STOP_MS);
    }
  }

  let used = 0;
  let videosKept = 0;
  let videoBytes = 0;
  const results: Array<BrowserEvidenceRouteResult<BrowserEvidenceShot>> = routes.map((route) => {
    const before = kept.before.get(route);
    const after = kept.after.get(route);
    const reason = failed.get(route);
    let result: BrowserEvidenceRouteResult<BrowserEvidenceShot>;
    if (reason !== undefined || before === undefined || after === undefined) result = { route, status: "not_run", reason: reason ?? "capture_failed" };
    else if (used + before.bytes.byteLength + after.bytes.byteLength > totalBytes) result = { route, status: "not_run", reason: "over_size_cap" };
    else {
      used += before.bytes.byteLength + after.bytes.byteLength;
      result = { route, status: "shown", before: { sha256: before.sha256, bytes: before.bytes }, after: { sha256: after.sha256, bytes: after.bytes }, consoleErrors: { before: before.consoleErrors, after: after.consoleErrors } };
    }
    // The video belongs to the page's FINAL result, and only when that result is one a video may be kept for (a page whose pair was dropped over the byte budget, say, is not).
    const found = videos.get(route);
    if (found === undefined || !browserEvidenceVideoEligible(result)) return result;
    // One page withheld for what it showed, on either side (or one whose text a mask had to rewrite), takes every video of the run with it.
    if (leaked) return { ...result, videoNotKept: "withheld" };
    if ("video" in found) {
      if (videosKept + 1 > BROWSER_EVIDENCE_VIDEOS_MAX || videoBytes + found.video.bytes.byteLength > BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES) return { ...result, videoNotKept: "over_size_cap" };
      videosKept += 1;
      videoBytes += found.video.bytes.byteLength;
      return { ...result, video: found.video };
    }
    return { ...result, videoNotKept: found.notKept };
  });
  return { ...base, durationMs: Math.max(0, now() - started), routes: results };
}
