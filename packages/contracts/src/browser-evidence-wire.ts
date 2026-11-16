// TE-H1 browser evidence, slice 2: what the worker, the broker and the pages agree on once the capture is wired (DEC 241). Slice 1 (browser-evidence.ts) holds the setting, the recipe, the masks,
// the caps and the pack's `visual` check; this file adds only the wiring around them:
//   - the worker feature `task.browserEvidence.v1` and the invocation payload field (the recipe), so an older worker is refused cleanly;
//   - the chunked `browser-evidence` callback's single upload: one byte string of at most `BROWSER_EVIDENCE_UPLOAD_MAX_BYTES` (a small header, the JPEGs and, from slice 4, the videos of failed pages), decoded and checked whole
//     (`checkedBrowserEvidenceCaptured`) before anything of it is stored;
//   - the download rule for a v2 pack's pairs (an image is served only when the task's CURRENT pack names it), the task page's before/after panel, and the pack read back as the outcome
//     the pull request's text lines are written from;
//   - the fixed words Cloud answers with while browser evidence is not on Cloud.
// Browser-safe and pure: nothing here imports a Node module.
import { z } from "zod";
import {
  BrowserEvidenceSignInValuesSchema, BROWSER_EVIDENCE_CHECK_ID, BROWSER_EVIDENCE_NOT_PROOF_WORDS, BROWSER_EVIDENCE_VIDEO_CHECK_ID, BROWSER_EVIDENCE_VIDEO_MAX_BYTES, BROWSER_EVIDENCE_VIDEO_NOT_KEPT_REASONS, BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS, BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES, BROWSER_EVIDENCE_NOT_RUN_REASONS, BROWSER_EVIDENCE_NOT_RUN_WORDS, BROWSER_EVIDENCE_NOT_SHOWN_REASONS, BROWSER_EVIDENCE_NOT_SHOWN_WORDS, BROWSER_EVIDENCE_RUN_BY_WORDS,
  BROWSER_EVIDENCE_TOTAL_MAX_BYTES, BrowserEvidenceRecipeSchema, checkedBrowserEvidenceCaptured, isBrowserEvidenceRoute,
  type BrowserEvidenceCaptured, type BrowserEvidenceIsolation, type BrowserEvidenceNotRunReason, type BrowserEvidenceNotShownReason, type BrowserEvidenceOutcome, type BrowserEvidenceRecipe, type BrowserEvidenceVideoNotKeptReason,
} from "./browser-evidence.js";
import type { ArtifactRef, EvidencePackV2, EvidencePackV2Read } from "./evidence.js";

// ---- the feature and the payload

/** The worker feature that runs browser evidence in a CHECKS run (it reads `browserEvidence`). The broker sends the field only to a worker whose /ping lists it, and never drops it: an older worker is refused the step. */
export const BROWSER_EVIDENCE_FEATURE = "task.browserEvidence.v1" as const;
/** Slice 4: a recipe with `video` is sent only to a worker whose /ping lists this (an older worker's strict parse would refuse the field and the whole step); it is withheld with `task.browserEvidence.v1` when the executor image is not on the host. */
export const BROWSER_EVIDENCE_VIDEO_FEATURE = "task.browserEvidenceVideo.v1" as const;
/** The invocation payload's field: the project's recipe, as the owner set it. Strict, so a worker that reads it reads exactly what was validated. */
export const BrowserEvidencePayloadSchema = BrowserEvidenceRecipeSchema;
export type BrowserEvidencePayload = BrowserEvidenceRecipe;
/** Cloud's answer while browser evidence is not on Cloud (DEFERRED 1b-X5): fixed words, no echo of anything the caller sent. */
export const BROWSER_EVIDENCE_NOT_ON_CLOUD = "Browser evidence is not on Cloud yet";

// ---- the sign-in callback (slice 3)

/** The callback action a CHECKS run asks for the project's saved sign-in with, only when its recipe has a sign-in. The broker answers from the company's secret store, never from the request. */
export const BROWSER_EVIDENCE_SIGN_IN_ACTION = "browser-evidence-sign-in" as const;
/** The broker's answer: the saved values (read at that moment, never kept by the worker beyond the run), or `not_set` when nothing is saved. Fixed shape: no secret is ever in an error. */
export const BrowserEvidenceSignInAnswerSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), values: BrowserEvidenceSignInValuesSchema }).strict(),
  z.object({ status: z.literal("not_set") }).strict(),
]);
export type BrowserEvidenceSignInAnswer = z.infer<typeof BrowserEvidenceSignInAnswerSchema>;

// ---- the callback's upload

/** The room the header of an upload may take (the run's rows, never the pictures). */
export const BROWSER_EVIDENCE_UPLOAD_HEADER_MAX_BYTES = 64 * 1024;
/** The most one upload holds: the run's picture budget (4 MiB), its video budget (4 MiB) and its header. The broker refuses an `init` over this before it keeps a byte. */
export const BROWSER_EVIDENCE_UPLOAD_MAX_BYTES = BROWSER_EVIDENCE_TOTAL_MAX_BYTES + BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES + BROWSER_EVIDENCE_UPLOAD_HEADER_MAX_BYTES;
const UPLOAD_MAGIC = new Uint8Array([0x52, 0x42, 0x45, 0x31]); // "RBE1"
const SHA = /^[a-f0-9]{64}$/u;
const INVALID_UPLOAD = "browser evidence upload is not valid";

type HeaderShot = { sha256: string; bytes: number };
/** The header: the captured run with each picture's (and video's) bytes replaced by its size (the bytes follow the header, in the order of the routes: before, after, then the page's video). */
type HeaderVideo = { video?: HeaderShot; videoNotKept?: BrowserEvidenceVideoNotKeptReason };
type UploadHeader = Omit<BrowserEvidenceCaptured, "routes"> & { routes: Array<({ route: string; status: "not_run"; reason: BrowserEvidenceNotRunReason } & HeaderVideo) | ({ route: string; status: "shown"; before: HeaderShot; after: HeaderShot; consoleErrors: { before: number; after: number } } & HeaderVideo)> };

/** The run as one byte string: `RBE1`, the header's length (4 bytes, big endian), the header (JSON), then the pictures. Throws on a run `checkedBrowserEvidenceCaptured` refuses. */
export function encodeBrowserEvidenceUpload(captured: BrowserEvidenceCaptured): Uint8Array {
  const checked = checkedBrowserEvidenceCaptured(captured);
  const pictures: Uint8Array[] = [];
  const header: UploadHeader = {
    ...checked,
    routes: checked.routes.map((row) => {
      const { video, ...rest } = row;
      const tail: HeaderVideo = video === undefined ? {} : { video: { sha256: video.sha256, bytes: video.bytes.byteLength } };
      if (row.status !== "shown") { if (video !== undefined) pictures.push(video.bytes); return { ...rest, ...tail } as UploadHeader["routes"][number]; }
      pictures.push(row.before.bytes, row.after.bytes);
      if (video !== undefined) pictures.push(video.bytes);
      return { ...rest, before: { sha256: row.before.sha256, bytes: row.before.bytes.byteLength }, after: { sha256: row.after.sha256, bytes: row.after.bytes.byteLength }, ...tail } as UploadHeader["routes"][number];
    }),
  };
  const text = new TextEncoder().encode(JSON.stringify(header));
  const total = UPLOAD_MAGIC.byteLength + 4 + text.byteLength + pictures.reduce((sum, picture) => sum + picture.byteLength, 0);
  if (text.byteLength > BROWSER_EVIDENCE_UPLOAD_HEADER_MAX_BYTES || total > BROWSER_EVIDENCE_UPLOAD_MAX_BYTES) throw new Error(INVALID_UPLOAD);
  const out = new Uint8Array(total);
  out.set(UPLOAD_MAGIC, 0);
  new DataView(out.buffer).setUint32(UPLOAD_MAGIC.byteLength, text.byteLength, false);
  let at = UPLOAD_MAGIC.byteLength + 4;
  out.set(text, at);
  at += text.byteLength;
  for (const picture of pictures) { out.set(picture, at); at += picture.byteLength; }
  return out;
}

const HeaderShotSchema = z.object({ sha256: z.string().regex(SHA), bytes: z.number().int().positive().max(BROWSER_EVIDENCE_TOTAL_MAX_BYTES) }).strict();
const HeaderVideoSchema = z.object({ sha256: z.string().regex(SHA), bytes: z.number().int().positive().max(BROWSER_EVIDENCE_VIDEO_MAX_BYTES) }).strict();

/**
 * The run an upload holds, checked whole: the magic, the header's size, every picture's size and the byte string's end agreeing, and then `checkedBrowserEvidenceCaptured` (the run's shape, each picture
 * within the screenshot cap, all within the run's budget, each video a WebM within the video caps and only on a page that failed). Throws one fixed sentence otherwise; nothing of a refused upload is returned. A picture's digest is checked where it is stored.
 */
export function decodeBrowserEvidenceUpload(bytes: Uint8Array): BrowserEvidenceCaptured {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < UPLOAD_MAGIC.byteLength + 4 || bytes.byteLength > BROWSER_EVIDENCE_UPLOAD_MAX_BYTES || !UPLOAD_MAGIC.every((value, index) => bytes[index] === value)) throw new Error(INVALID_UPLOAD);
    const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(UPLOAD_MAGIC.byteLength, false);
    const start = UPLOAD_MAGIC.byteLength + 4;
    if (headerLength === 0 || headerLength > BROWSER_EVIDENCE_UPLOAD_HEADER_MAX_BYTES || start + headerLength > bytes.byteLength) throw new Error(INVALID_UPLOAD);
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, start + headerLength)));
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { routes?: unknown }).routes)) throw new Error(INVALID_UPLOAD);
    const header = parsed as { routes: unknown[] };
    let at = start + headerLength;
    const take = (size: number): Uint8Array => {
      const out = bytes.slice(at, at + size);
      at += size;
      if (out.byteLength !== size) throw new Error(INVALID_UPLOAD);
      return out;
    };
    const routes = header.routes.map((row: unknown) => {
      if (typeof row !== "object" || row === null) return row;
      const entry = row as { status?: unknown; before?: unknown; after?: unknown; video?: unknown };
      const pictures: Record<string, unknown> = {};
      if (entry.status === "shown") {
        const before = HeaderShotSchema.parse(entry.before);
        const after = HeaderShotSchema.parse(entry.after);
        pictures["before"] = { sha256: before.sha256, bytes: take(before.bytes) };
        pictures["after"] = { sha256: after.sha256, bytes: take(after.bytes) };
      } else if (entry.status !== "not_run") return row;
      // The video's bytes follow the page's pictures, in the same order the header names them.
      if (entry.video !== undefined) {
        const video = HeaderVideoSchema.parse(entry.video);
        pictures["video"] = { sha256: video.sha256, bytes: take(video.bytes) };
      }
      return { ...row, ...pictures };
    });
    // Not one byte more than the header says, or the upload carries something nobody checked.
    if (at !== bytes.byteLength) throw new Error(INVALID_UPLOAD);
    return checkedBrowserEvidenceCaptured({ ...(parsed), routes });
  } catch { throw new Error(INVALID_UPLOAD); }
}

// ---- the download rule for a v2 pack's pairs

type PackLike = Pick<EvidencePackV2, "candidate" | "checks"> | Pick<EvidencePackV2Read, "candidate" | "checks">;
type PairCheck = { id: string; kind: string; pairs?: ReadonlyArray<{ id: string; before?: ArtifactRef | undefined; after?: ArtifactRef | undefined }> | undefined };

/** The browser-evidence check of a v2 pack: the one check of that id and the `visual` kind. Anything else is not a browser-evidence check, whatever it is called. */
function browserEvidenceCheckOf(pack: PackLike | undefined): PairCheck | undefined {
  if (pack === undefined || !Array.isArray(pack.checks)) return undefined;
  const found = (pack.checks as readonly PairCheck[]).find((entry) => entry.id === BROWSER_EVIDENCE_CHECK_ID && entry.kind === "visual");
  return found;
}

/**
 * The pictures the task's CURRENT v2 pack names as before and after pairs of its browser-evidence check, and nothing else (the download rule): only for exactly this candidate (a pack for other code names
 * nothing), only JPEG refs, only the check of that id and kind. A digest the store happens to hold, or one another check of the pack names, is never served by this answer.
 */
export function browserEvidenceServableImages(pack: PackLike | undefined, candidateDigest: string | undefined): ArtifactRef[] {
  if (pack === undefined || candidateDigest === undefined || pack.candidate?.digest !== candidateDigest) return [];
  const check = browserEvidenceCheckOf(pack);
  if (check?.pairs === undefined) return [];
  const out: ArtifactRef[] = [];
  for (const pair of check.pairs) {
    for (const ref of [pair.before, pair.after]) if (ref !== undefined && ref.kind === "jpeg" && SHA.test(ref.sha256) && !out.some((held) => held.sha256 === ref.sha256)) out.push(ref);
  }
  return out;
}

/** The ref a request for `sha256` may be served, or undefined (see `browserEvidenceServableImages`). */
export function servableBrowserEvidenceImage(pack: PackLike | undefined, candidateDigest: string | undefined, sha256: string): ArtifactRef | undefined {
  return browserEvidenceServableImages(pack, candidateDigest).find((ref) => ref.sha256 === sha256);
}

/** The video check of a v2 pack: the one check of that id and the `visual` kind (slice 4). Anything else is not one, whatever it is called. */
function browserEvidenceVideoCheckOf(pack: PackLike | undefined): PairCheck | undefined {
  if (pack === undefined || !Array.isArray(pack.checks)) return undefined;
  return (pack.checks as readonly PairCheck[]).find((entry) => entry.id === BROWSER_EVIDENCE_VIDEO_CHECK_ID && entry.kind === "visual");
}

/**
 * The videos the task's CURRENT v2 pack names as the `after` of its browser-evidence video check, and nothing else (the download rule, as for pictures): only for exactly this candidate, only WebM refs within the video cap,
 * only the check of that id and kind. A video the store happens to hold, or one another check names, is never served by this answer.
 */
export function browserEvidenceServableVideos(pack: PackLike | undefined, candidateDigest: string | undefined): ArtifactRef[] {
  if (pack === undefined || candidateDigest === undefined || pack.candidate?.digest !== candidateDigest) return [];
  const check = browserEvidenceVideoCheckOf(pack);
  if (check?.pairs === undefined) return [];
  const out: ArtifactRef[] = [];
  for (const pair of check.pairs) {
    const ref = pair.after;
    if (ref !== undefined && ref.kind === "webm" && ref.bytes > 0 && ref.bytes <= BROWSER_EVIDENCE_VIDEO_MAX_BYTES && SHA.test(ref.sha256) && !out.some((held) => held.sha256 === ref.sha256)) out.push(ref);
  }
  return out;
}

/** The video a request for `sha256` may be served, or undefined (see `browserEvidenceServableVideos`). */
export function servableBrowserEvidenceVideo(pack: PackLike | undefined, candidateDigest: string | undefined, sha256: string): ArtifactRef | undefined {
  return browserEvidenceServableVideos(pack, candidateDigest).find((ref) => ref.sha256 === sha256);
}

// ---- the task page's panel and the pack read back as an outcome

export type BrowserEvidencePanel = {
  runBy: string;
  notProof: string;
  pairs: Array<{ route: string; before: string; after: string }>;
  /** Slice 4: the videos of failed pages (the route and the digest the download route takes). Present only when the run kept one. */
  videos?: Array<{ route: string; sha256: string }>;
  /** Rows of "not shown" and "not run", each one fixed line. */
  notes: string[];
};

const notRunReasonOf = (words: string): BrowserEvidenceNotRunReason | undefined => BROWSER_EVIDENCE_NOT_RUN_REASONS.find((reason) => BROWSER_EVIDENCE_NOT_RUN_WORDS[reason] === words);
const notShownReasonOf = (words: string): BrowserEvidenceNotShownReason | undefined => BROWSER_EVIDENCE_NOT_SHOWN_REASONS.find((reason) => BROWSER_EVIDENCE_NOT_SHOWN_WORDS[reason] === words);
const isolationOf = (value: unknown): BrowserEvidenceIsolation | undefined => (value === "sandbox" || value === "developer_machine" ? value : undefined);
const CHECK_LABEL = "Browser evidence";
const VIDEO_CHECK_LABEL = "Browser evidence video";
const MORE_ROW = new RegExp(`^${CHECK_LABEL}: (\\d{1,7}) more changed pages$`, "u");

/**
 * A v2 pack's browser evidence read back as the outcome its pull request lines are written from (`browserEvidenceLines`): the pairs, and the not-run and not-shown rows by their fixed words. Strict: a row
 * whose words are none of the fixed words, a route that is not a route, or a producer that is not Rovara's sandbox or a developer machine reads as NO outcome (the page and the pull request then say nothing),
 * never as a guess. Undefined too for a pack for other code or with no such check. Console error counts are not kept in a pack, so they read as none.
 */
export function browserEvidenceOutcomeOfPack(pack: PackLike | undefined, candidateDigest: string | undefined): BrowserEvidenceOutcome | undefined {
  if (pack === undefined || candidateDigest === undefined || pack.candidate?.digest !== candidateDigest) return undefined;
  const check = browserEvidenceCheckOf(pack);
  const producer = (pack as { producer?: { isolation?: unknown } }).producer;
  const isolation = isolationOf(producer?.isolation);
  if (check === undefined || isolation === undefined || (check as { runBy?: unknown }).runBy !== "rovara") return undefined;
  const durationMs = (check as { durationMs?: unknown }).durationMs;
  if (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs < 0) return undefined;
  const routes: BrowserEvidenceOutcome["routes"] = [];
  const notShown: BrowserEvidenceOutcome["notShown"] = [];
  let moreNotShown = 0;
  let notRun: BrowserEvidenceNotRunReason | undefined;
  for (const pair of check.pairs ?? []) {
    if (!isBrowserEvidenceRoute(pair.id) || pair.before?.kind !== "jpeg" || pair.after?.kind !== "jpeg") return undefined;
    routes.push({ route: pair.id, status: "shown", before: pair.before, after: pair.after, consoleErrors: { before: 0, after: 0 } });
  }
  const rows = (pack as { notTested?: ReadonlyArray<{ what?: unknown; reason?: unknown }> }).notTested ?? [];
  const videoNotKept = new Map<string, BrowserEvidenceVideoNotKeptReason>();
  const VIDEO_ROW = `${VIDEO_CHECK_LABEL}: `;
  for (const row of rows) {
    if (typeof row.what !== "string") continue;
    // A video's "not kept" row: its words are the fixed ones or the pack reads as NO outcome.
    if (row.what.startsWith(VIDEO_ROW)) {
      const route = row.what.slice(VIDEO_ROW.length);
      const reason = typeof row.reason === "string" && row.reason.startsWith("Not kept: ") ? BROWSER_EVIDENCE_VIDEO_NOT_KEPT_REASONS.find((code) => BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS[code] === (row.reason as string).slice("Not kept: ".length)) : undefined;
      if (!isBrowserEvidenceRoute(route) || reason === undefined || videoNotKept.has(route)) return undefined;
      videoNotKept.set(route, reason);
      continue;
    }
    if (row.what !== CHECK_LABEL && !row.what.startsWith(`${CHECK_LABEL}: `)) continue;
    const reason = typeof row.reason === "string" ? row.reason : "";
    const more = MORE_ROW.exec(row.what);
    if (more !== null) {
      if (reason !== `Not shown: ${BROWSER_EVIDENCE_NOT_SHOWN_WORDS.over_route_cap}`) return undefined;
      moreNotShown = Number(more[1]);
      continue;
    }
    const route = row.what === CHECK_LABEL ? undefined : row.what.slice(CHECK_LABEL.length + 2);
    if (reason.startsWith("Not run: ")) {
      const code = notRunReasonOf(reason.slice("Not run: ".length));
      if (code === undefined) return undefined;
      if (route === undefined) { notRun = code; continue; }
      if (!isBrowserEvidenceRoute(route)) return undefined;
      routes.push({ route, status: "not_run", reason: code });
    } else if (reason.startsWith("Not shown: ")) {
      const code = notShownReasonOf(reason.slice("Not shown: ".length));
      if (code === undefined || route === undefined || !isBrowserEvidenceRoute(route)) return undefined;
      notShown.push({ route, reason: code });
    } else return undefined;
  }
  // Slice 4: the videos, each onto the page it is of. A video of a page the outcome does not have, one that is not a WebM, or a page with both a video and a reason there is none is no outcome at all.
  const videoCheck = browserEvidenceVideoCheckOf(pack);
  const videos = new Map<string, ArtifactRef>();
  for (const pair of videoCheck?.pairs ?? []) {
    if (!isBrowserEvidenceRoute(pair.id) || pair.after?.kind !== "webm" || pair.before !== undefined || videos.has(pair.id)) return undefined;
    videos.set(pair.id, pair.after);
  }
  for (const [route, video] of videos) {
    const at = routes.findIndex((row) => row.route === route);
    if (at < 0 || videoNotKept.has(route)) return undefined;
    routes[at] = { ...routes[at]!, video };
  }
  for (const [route, reason] of videoNotKept) {
    const at = routes.findIndex((row) => row.route === route);
    if (at < 0) return undefined;
    routes[at] = { ...routes[at]!, videoNotKept: reason };
  }
  if (routes.length === 0 && notRun === undefined && notShown.length === 0 && moreNotShown === 0) return undefined;
  return { isolation, durationMs, routes, notShown, moreNotShown, ...(notRun === undefined ? {} : { notRun }) };
}

/** The task page's panel from the outcome: who ran it, that it is not proof, each shown pair by the digests of its pictures, and one fixed line for everything not shown. */
export function browserEvidencePanelOf(outcome: BrowserEvidenceOutcome | undefined): BrowserEvidencePanel | undefined {
  if (outcome === undefined) return undefined;
  const videos = outcome.routes.flatMap((row) => (row.video === undefined ? [] : [{ route: row.route, sha256: row.video.sha256 }]));
  const notes: string[] = [
    ...(outcome.notRun === undefined ? [] : [`Not run: ${BROWSER_EVIDENCE_NOT_RUN_WORDS[outcome.notRun]}`]),
    ...outcome.routes.flatMap((row) => (row.status === "not_run" ? [`${row.route}: Not run: ${BROWSER_EVIDENCE_NOT_RUN_WORDS[row.reason]}`] : [])),
    ...outcome.notShown.map((row) => `${row.route}: Not shown: ${BROWSER_EVIDENCE_NOT_SHOWN_WORDS[row.reason]}`),
    ...(outcome.moreNotShown > 0 ? [`${String(outcome.moreNotShown)} more changed pages not shown: ${BROWSER_EVIDENCE_NOT_SHOWN_WORDS.over_route_cap}`] : []),
    ...outcome.routes.flatMap((row) => (row.videoNotKept === undefined ? [] : [`${row.route}: Video not kept: ${BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS[row.videoNotKept]}`])),
  ];
  return {
    runBy: BROWSER_EVIDENCE_RUN_BY_WORDS[outcome.isolation],
    notProof: BROWSER_EVIDENCE_NOT_PROOF_WORDS,
    pairs: outcome.routes.flatMap((row) => (row.status === "shown" ? [{ route: row.route, before: row.before.sha256, after: row.after.sha256 }] : [])),
    ...(videos.length === 0 ? {} : { videos }),
    notes,
  };
}

// ---- the executor container's plan and answer (worker <-> the capture program in the executor image)

/** The capture program in the executor image (`packages/verifier/src/executor/browser-evidence-entry.ts`, built into the image the way `entry.js` is). */
export const BROWSER_EVIDENCE_EXECUTOR_ENTRY = "/opt/agentx/packages/verifier/dist/executor/browser-evidence-entry.js";
/** The most the capture program prints for one side: five pictures at the screenshot cap, in base64, and their small rows. A run that prints more is cut and read as not run. */
export const BROWSER_EVIDENCE_EXECUTOR_OUTPUT_MAX_BYTES = 4 * 1_048_576;
/** The same for the candidate's side of a recipe with `video` (slice 4): the pictures' bound and the run's video budget in base64. Only that side's plan asks for video, and only that side gets this bound. */
export const BROWSER_EVIDENCE_EXECUTOR_VIDEO_OUTPUT_MAX_BYTES = BROWSER_EVIDENCE_EXECUTOR_OUTPUT_MAX_BYTES + Math.ceil(BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES / 3) * 4 + 4_096;
const VIDEO_BASE64_MAX = Math.ceil(BROWSER_EVIDENCE_VIDEO_MAX_BYTES / 3) * 4 + 8;
const PLAIN_LINE = /^[^\p{Cc}\p{Cf}]*$/u;
const RouteField = z.string().refine(isBrowserEvidenceRoute, "a path on the app's own origin");

/** What the worker tells the capture program (one command-line argument): the app's port, the pages, the elements to paint over, and the time. Everything is bounded; nothing else crosses. */
const SelectorField = z.string().min(1).max(200).regex(PLAIN_LINE);
/** How the capture program signs in (never the values: those come in its environment, `BROWSER_EVIDENCE_SIGN_IN_ENV`). */
export const BrowserEvidenceExecutorSignInSchema = z.object({
  path: RouteField, usernameSelector: SelectorField, passwordSelector: SelectorField, submitSelector: SelectorField,
  successPath: RouteField.optional(), successSelector: SelectorField.optional(),
}).strict().refine((signIn) => signIn.successPath !== undefined || signIn.successSelector !== undefined, "a signed-in page is told by a page or an element");
export type BrowserEvidenceExecutorSignIn = z.infer<typeof BrowserEvidenceExecutorSignInSchema>;
/** The one environment variable the capture container may have: base64url of the sign-in's JSON (`{ username, password }`). The program reads it once and removes it. */
export const BROWSER_EVIDENCE_SIGN_IN_ENV = "ROVARA_BE_SIGNIN" as const;
export const BROWSER_EVIDENCE_SIGN_IN_ENV_MAX = 1_536;
/** The sign-in's values as the environment variable carries them. Throws on values that are not a valid sign-in. */
export function encodeBrowserEvidenceSignInEnv(values: unknown): string {
  const checked = BrowserEvidenceSignInValuesSchema.parse(values);
  const bytes = new TextEncoder().encode(JSON.stringify({ username: checked.username, password: checked.password }));
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  const text = btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  if (text.length > BROWSER_EVIDENCE_SIGN_IN_ENV_MAX) throw new Error("browser evidence sign-in is too long");
  return text;
}
/** The values an environment variable holds, or undefined when it is not exactly a valid sign-in. */
export function decodeBrowserEvidenceSignInEnv(text: unknown): z.infer<typeof BrowserEvidenceSignInValuesSchema> | undefined {
  if (typeof text !== "string" || text.length === 0 || text.length > BROWSER_EVIDENCE_SIGN_IN_ENV_MAX || !/^[A-Za-z0-9_-]+$/u.test(text)) return undefined;
  try {
    const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const parsed = BrowserEvidenceSignInValuesSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

export const BrowserEvidenceExecutorPlanSchema = z.object({
  port: z.number().int().min(1_024).max(65_535),
  readyPath: RouteField.optional(),
  signIn: BrowserEvidenceExecutorSignInSchema.optional(),
  routes: z.array(RouteField).min(1).max(5),
  maskSelectors: z.array(z.string().min(1).max(200).regex(PLAIN_LINE)).max(20),
  runMs: z.number().int().min(1_000).max(120_000),
  pageMs: z.number().int().min(1_000).max(15_000),
  /** Slice 4: record each page's load and send back the video of a page that failed. Only for the candidate's side of a recipe that asks for it; absent: nothing is recorded. */
  video: z.literal(true).optional(),
}).strict();
export type BrowserEvidenceExecutorPlan = z.infer<typeof BrowserEvidenceExecutorPlanSchema>;

/** One line the capture program prints (JSON, one object per line): first the app's state, then one row per page. A picture is base64 of a JPEG within the cap; the worker checks its bytes again. */
const VideoFields = { videoBase64: z.string().min(4).max(VIDEO_BASE64_MAX).optional(), videoNotKept: z.enum(BROWSER_EVIDENCE_VIDEO_NOT_KEPT_REASONS).optional() };
export const BrowserEvidenceExecutorLineSchema = z.union([
  z.object({ t: z.literal("app"), status: z.enum(["ready", "app_did_not_start", "time_limit", "sign_in_failed"]) }).strict(),
  z.object({ t: z.literal("shot"), route: RouteField, ok: z.literal(true), consoleErrors: z.number().int().min(0).max(1_000_000), jpegBase64: z.string().min(4).max(Math.ceil(BROWSER_EVIDENCE_TOTAL_MAX_BYTES / 8 * 4 / 3) + 8), ...VideoFields }).strict(),
  z.object({ t: z.literal("shot"), route: RouteField, ok: z.literal(false), reason: z.enum(["page_did_not_load", "time_limit", "capture_failed", "masked_content"]), ...VideoFields }).strict(),
]);
export type BrowserEvidenceExecutorLine = z.infer<typeof BrowserEvidenceExecutorLineSchema>;

/** The plan as the one argument the capture program is started with (base64url of its JSON). */
export function encodeBrowserEvidenceExecutorPlan(plan: BrowserEvidenceExecutorPlan): string {
  const checked = BrowserEvidenceExecutorPlanSchema.parse(plan);
  const bytes = new TextEncoder().encode(JSON.stringify(checked));
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
/** The plan an argument holds, or undefined when it is not exactly a plan (too long, not base64url, not JSON, any key or value outside the schema). */
export function decodeBrowserEvidenceExecutorPlan(argument: unknown): BrowserEvidenceExecutorPlan | undefined {
  if (typeof argument !== "string" || argument.length === 0 || argument.length > 16_384 || !/^[A-Za-z0-9_-]+$/u.test(argument)) return undefined;
  try {
    const padded = argument.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = BrowserEvidenceExecutorPlanSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}
