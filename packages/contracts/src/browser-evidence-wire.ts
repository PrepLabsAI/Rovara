// TE-H1 browser evidence, slice 2: what the worker, the broker and the pages agree on once the capture is wired (DEC 241). Slice 1 (browser-evidence.ts) holds the setting, the recipe, the masks,
// the caps and the pack's `visual` check; this file adds only the wiring around them:
//   - the worker feature `task.browserEvidence.v1` and the invocation payload field (the recipe), so an older worker is refused cleanly;
//   - the chunked `browser-evidence` callback's single upload: one byte string of at most `BROWSER_EVIDENCE_UPLOAD_MAX_BYTES` (a small header and the JPEGs), decoded and checked whole
//     (`checkedBrowserEvidenceCaptured`) before anything of it is stored;
//   - the download rule for a v2 pack's pairs (an image is served only when the task's CURRENT pack names it), the task page's before/after panel, and the pack read back as the outcome
//     the pull request's text lines are written from;
//   - the fixed words Cloud answers with while browser evidence is not on Cloud.
// Browser-safe and pure: nothing here imports a Node module.
import { z } from "zod";
import {
  BROWSER_EVIDENCE_CHECK_ID, BROWSER_EVIDENCE_NOT_PROOF_WORDS, BROWSER_EVIDENCE_NOT_RUN_REASONS, BROWSER_EVIDENCE_NOT_RUN_WORDS, BROWSER_EVIDENCE_NOT_SHOWN_REASONS, BROWSER_EVIDENCE_NOT_SHOWN_WORDS, BROWSER_EVIDENCE_RUN_BY_WORDS,
  BROWSER_EVIDENCE_TOTAL_MAX_BYTES, BrowserEvidenceRecipeSchema, checkedBrowserEvidenceCaptured, isBrowserEvidenceRoute,
  type BrowserEvidenceCaptured, type BrowserEvidenceIsolation, type BrowserEvidenceNotRunReason, type BrowserEvidenceNotShownReason, type BrowserEvidenceOutcome, type BrowserEvidenceRecipe,
} from "./browser-evidence.js";
import type { ArtifactRef, EvidencePackV2, EvidencePackV2Read } from "./evidence.js";

// ---- the feature and the payload

/** The worker feature that runs browser evidence in a CHECKS run (it reads `browserEvidence`). The broker sends the field only to a worker whose /ping lists it, and never drops it: an older worker is refused the step. */
export const BROWSER_EVIDENCE_FEATURE = "task.browserEvidence.v1" as const;
/** The invocation payload's field: the project's recipe, as the owner set it. Strict, so a worker that reads it reads exactly what was validated. */
export const BrowserEvidencePayloadSchema = BrowserEvidenceRecipeSchema;
export type BrowserEvidencePayload = BrowserEvidenceRecipe;
/** Cloud's answer while browser evidence is not on Cloud (DEFERRED 1b-X5): fixed words, no echo of anything the caller sent. */
export const BROWSER_EVIDENCE_NOT_ON_CLOUD = "Browser evidence is not on Cloud yet";

// ---- the callback's upload

/** The room the header of an upload may take (the run's rows, never the pictures). */
export const BROWSER_EVIDENCE_UPLOAD_HEADER_MAX_BYTES = 64 * 1024;
/** The most one upload holds: the run's picture budget (4 MiB) and its header. The broker refuses an `init` over this before it keeps a byte. */
export const BROWSER_EVIDENCE_UPLOAD_MAX_BYTES = BROWSER_EVIDENCE_TOTAL_MAX_BYTES + BROWSER_EVIDENCE_UPLOAD_HEADER_MAX_BYTES;
const UPLOAD_MAGIC = new Uint8Array([0x52, 0x42, 0x45, 0x31]); // "RBE1"
const SHA = /^[a-f0-9]{64}$/u;
const INVALID_UPLOAD = "browser evidence upload is not valid";

type HeaderShot = { sha256: string; bytes: number };
/** The header: the captured run with each picture's bytes replaced by its size (the bytes follow the header, before then after, in the order of the routes). */
type UploadHeader = Omit<BrowserEvidenceCaptured, "routes"> & { routes: Array<{ route: string; status: "not_run"; reason: BrowserEvidenceNotRunReason } | { route: string; status: "shown"; before: HeaderShot; after: HeaderShot; consoleErrors: { before: number; after: number } }> };

/** The run as one byte string: `RBE1`, the header's length (4 bytes, big endian), the header (JSON), then the pictures. Throws on a run `checkedBrowserEvidenceCaptured` refuses. */
export function encodeBrowserEvidenceUpload(captured: BrowserEvidenceCaptured): Uint8Array {
  const checked = checkedBrowserEvidenceCaptured(captured);
  const pictures: Uint8Array[] = [];
  const header: UploadHeader = {
    ...checked,
    routes: checked.routes.map((row) => {
      if (row.status !== "shown") return row;
      pictures.push(row.before.bytes, row.after.bytes);
      return { route: row.route, status: "shown" as const, before: { sha256: row.before.sha256, bytes: row.before.bytes.byteLength }, after: { sha256: row.after.sha256, bytes: row.after.bytes.byteLength }, consoleErrors: row.consoleErrors };
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

/**
 * The run an upload holds, checked whole: the magic, the header's size, every picture's size and the byte string's end agreeing, and then `checkedBrowserEvidenceCaptured` (the run's shape, each picture
 * within the screenshot cap, all within the run's budget). Throws one fixed sentence otherwise; nothing of a refused upload is returned. A picture's digest is checked where it is stored.
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
    const routes = header.routes.map((row: unknown) => {
      if (typeof row !== "object" || row === null || (row as { status?: unknown }).status !== "shown") return row;
      const shown = row as { before?: unknown; after?: unknown };
      const before = HeaderShotSchema.parse(shown.before);
      const after = HeaderShotSchema.parse(shown.after);
      const beforeBytes = bytes.slice(at, at + before.bytes);
      at += before.bytes;
      const afterBytes = bytes.slice(at, at + after.bytes);
      at += after.bytes;
      if (beforeBytes.byteLength !== before.bytes || afterBytes.byteLength !== after.bytes) throw new Error(INVALID_UPLOAD);
      return { ...row, before: { sha256: before.sha256, bytes: beforeBytes }, after: { sha256: after.sha256, bytes: afterBytes } };
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

// ---- the task page's panel and the pack read back as an outcome

export type BrowserEvidencePanel = {
  runBy: string;
  notProof: string;
  pairs: Array<{ route: string; before: string; after: string }>;
  /** Rows of "not shown" and "not run", each one fixed line. */
  notes: string[];
};

const notRunReasonOf = (words: string): BrowserEvidenceNotRunReason | undefined => BROWSER_EVIDENCE_NOT_RUN_REASONS.find((reason) => BROWSER_EVIDENCE_NOT_RUN_WORDS[reason] === words);
const notShownReasonOf = (words: string): BrowserEvidenceNotShownReason | undefined => BROWSER_EVIDENCE_NOT_SHOWN_REASONS.find((reason) => BROWSER_EVIDENCE_NOT_SHOWN_WORDS[reason] === words);
const isolationOf = (value: unknown): BrowserEvidenceIsolation | undefined => (value === "sandbox" || value === "developer_machine" ? value : undefined);
const CHECK_LABEL = "Browser evidence";
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
  for (const row of rows) {
    if (typeof row.what !== "string" || (row.what !== CHECK_LABEL && !row.what.startsWith(`${CHECK_LABEL}: `))) continue;
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
  if (routes.length === 0 && notRun === undefined && notShown.length === 0 && moreNotShown === 0) return undefined;
  return { isolation, durationMs, routes, notShown, moreNotShown, ...(notRun === undefined ? {} : { notRun }) };
}

/** The task page's panel from the outcome: who ran it, that it is not proof, each shown pair by the digests of its pictures, and one fixed line for everything not shown. */
export function browserEvidencePanelOf(outcome: BrowserEvidenceOutcome | undefined): BrowserEvidencePanel | undefined {
  if (outcome === undefined) return undefined;
  const notes: string[] = [
    ...(outcome.notRun === undefined ? [] : [`Not run: ${BROWSER_EVIDENCE_NOT_RUN_WORDS[outcome.notRun]}`]),
    ...outcome.routes.flatMap((row) => (row.status === "not_run" ? [`${row.route}: Not run: ${BROWSER_EVIDENCE_NOT_RUN_WORDS[row.reason]}`] : [])),
    ...outcome.notShown.map((row) => `${row.route}: Not shown: ${BROWSER_EVIDENCE_NOT_SHOWN_WORDS[row.reason]}`),
    ...(outcome.moreNotShown > 0 ? [`${String(outcome.moreNotShown)} more changed pages not shown: ${BROWSER_EVIDENCE_NOT_SHOWN_WORDS.over_route_cap}`] : []),
  ];
  return {
    runBy: BROWSER_EVIDENCE_RUN_BY_WORDS[outcome.isolation],
    notProof: BROWSER_EVIDENCE_NOT_PROOF_WORDS,
    pairs: outcome.routes.flatMap((row) => (row.status === "shown" ? [{ route: row.route, before: row.before.sha256, after: row.after.sha256 }] : [])),
    notes,
  };
}

// ---- the executor container's plan and answer (worker <-> the capture program in the executor image)

/** The capture program in the executor image (`packages/verifier/src/executor/browser-evidence-entry.ts`, built into the image the way `entry.js` is). */
export const BROWSER_EVIDENCE_EXECUTOR_ENTRY = "/opt/agentx/packages/verifier/dist/executor/browser-evidence-entry.js";
/** The most the capture program prints for one side: five pictures at the screenshot cap, in base64, and their small rows. A run that prints more is cut and read as not run. */
export const BROWSER_EVIDENCE_EXECUTOR_OUTPUT_MAX_BYTES = 4 * 1_048_576;
const PLAIN_LINE = /^[^\p{Cc}\p{Cf}]*$/u;
const RouteField = z.string().refine(isBrowserEvidenceRoute, "a path on the app's own origin");

/** What the worker tells the capture program (one command-line argument): the app's port, the pages, the elements to paint over, and the time. Everything is bounded; nothing else crosses. */
export const BrowserEvidenceExecutorPlanSchema = z.object({
  port: z.number().int().min(1_024).max(65_535),
  readyPath: RouteField.optional(),
  routes: z.array(RouteField).min(1).max(5),
  maskSelectors: z.array(z.string().min(1).max(200).regex(PLAIN_LINE)).max(20),
  runMs: z.number().int().min(1_000).max(120_000),
  pageMs: z.number().int().min(1_000).max(15_000),
}).strict();
export type BrowserEvidenceExecutorPlan = z.infer<typeof BrowserEvidenceExecutorPlanSchema>;

/** One line the capture program prints (JSON, one object per line): first the app's state, then one row per page. A picture is base64 of a JPEG within the cap; the worker checks its bytes again. */
export const BrowserEvidenceExecutorLineSchema = z.union([
  z.object({ t: z.literal("app"), status: z.enum(["ready", "app_did_not_start", "time_limit"]) }).strict(),
  z.object({ t: z.literal("shot"), route: RouteField, ok: z.literal(true), consoleErrors: z.number().int().min(0).max(1_000_000), jpegBase64: z.string().min(4).max(Math.ceil(BROWSER_EVIDENCE_TOTAL_MAX_BYTES / 8 * 4 / 3) + 8) }).strict(),
  z.object({ t: z.literal("shot"), route: RouteField, ok: z.literal(false), reason: z.enum(["page_did_not_load", "time_limit", "capture_failed", "masked_content"]) }).strict(),
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
