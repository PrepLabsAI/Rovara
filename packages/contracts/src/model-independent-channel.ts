// TE-R2 part A (M2, release 0.5.19; DECISIONS 161, 166b): the Rovara-side CHANNEL, the only file besides R1's `model-reply-store-rules.ts` (`decisionForEntry`) that calls `createRovaraIndependentDecision`.
//
// IT IS NOT IN THE PUBLIC INDEX. `@agentx/contracts` exports neither `acceptAgentReply` nor `createRovaraIndependentDecision`; both live behind the subpath `@agentx/contracts/independent-channel` (`independent-channel.ts`), which only the
// broker (and the reply store's own test kit) may import. A guard (`tests/unit/model-independent-mint-kit.ts`, read with the TypeScript parser) fails on any other mention of either name or of this module, in any .ts, .mts, .cts, .tsx,
// .js, .mjs or .cjs file of packages, scripts and infra. The worker only ever receives RESOLVED sets, never a decision.
//
// `acceptAgentReply` turns one validated agent answer into the entry R1's `putIndependentOverlay` takes: `{reply, decision}`.
//   * THE MATCH IS COMPUTED BY CODE from the brief: `operation`, `model` (when the brief has one) and `promptSha256`, all exact. Never `promptContains`, never a `sequence`. The agent writes only `response`.
//   * The brief must be one `extractReplyBrief` or `parseReplyBrief` made (a spread copy or a hand-made look-alike is refused: `not_a_brief`).
//   * The response is re-checked here, not trusted from the caller: `ModelReplyResponseSchema` and the brief's shape; `usage` is Rovara's. A reply that does not fit is `bad_shape`.
//   * A reply that repeats the request (its text, a JSON string value or a tool argument of 6+ characters appears verbatim in the prompt, a tool description or a schema's prose) is `reply_echoes_request`: not counted.
//   * A prompt hash that was seen with two shape digests in the batch (`promptsWithConflictingShapes`) is `shape_conflict`: a reply's match has no shape field, so such a prompt is not counted.
//   * The label for what this makes is `INDEPENDENT_REPLY_CAVEAT`: "written without seeing the tests", never "proven". The same independent reply may serve other tasks of the project later (it joins the project set after a merge,
//     keeps its label and its content hash): that reuse is intended.
//   * The id is `ind-<first 12 hex of promptSha256>`; when that id is taken (`takenIds`), `-2`, `-3` ... up to `-9`.
//   * The decision is `createRovaraIndependentDecision(modelReplyEntrySha256(reply))`, bound to this reply's content.
// `reportIndependentIntake` turns what R1's `putIndependentOverlay` answered into an honest report: what the STORE says it stored (never the number sent), each skipped reply with its fixed reason (today `already_in_overlay`: this content
// is already in the task's overlay, or the coding agent wrote it, so it keeps the provenance it was first written with and is not counted again), anything unexplained, and a refusal word. Part B's agent step and the PR's evidence use it.
// PURE: no I/O. Independence is NOT proven by any of this: see `model-reply-leak-screen.ts` for what the screens do not catch.
import { checkReplyShape, replyEchoesRequest, withComputedUsage } from "./model-reply-agent.js";
import { isReplyBrief, replyAgentCanAnswer, type ReplyBrief } from "./model-reply-brief.js";
import { ModelReplyResponseSchema, ModelReplySetFileSchema, createRovaraIndependentDecision, modelReplyEntrySha256, type IndependentReplyDecision, type ModelReplyFileEntry } from "./model-reply-set.js";
import { REPLY_SKIP_REASONS, type ReplySkipReason, type ReplyStoreWord } from "./model-reply-store.js";

export type ChannelRefusal = "not_a_brief" | "bad_shape" | "reply_echoes_request" | "shape_conflict" | "no_id";

/** What an independent reply is, in words (code, never data). Not "proven": the screens lower the risk of smuggling and prove nothing. */
export const INDEPENDENT_REPLY_CAVEAT = "written without seeing the tests; the checks lower the risk of a leak and do not prove independence";
export type AcceptedAgentReply = { readonly ok: true; readonly reply: ModelReplyFileEntry; readonly decision: IndependentReplyDecision } | { readonly ok: false; readonly reason: ChannelRefusal };

/** The id an independent reply gets for a prompt hash: `ind-<12 hex>`, or `ind-<12 hex>-<n>` (2 to 9) when taken; undefined when all are taken. */
export function independentReplyId(promptSha256: string, takenIds: ReadonlySet<string>): string | undefined {
  const base = `ind-${promptSha256.slice(0, 12)}`;
  if (!takenIds.has(base)) return base;
  for (let n = 2; n <= 9; n += 1) if (!takenIds.has(`${base}-${n}`)) return `${base}-${n}`;
  return undefined;
}

/** The match for a brief, by code: exact operation, the model when known, the exact prompt hash. */
export function matchForBrief(brief: ReplyBrief): ModelReplyFileEntry["match"] {
  return { operation: brief.operation, ...(brief.model === undefined ? {} : { model: brief.model }), promptSha256: brief.promptSha256 };
}

/**
 * The ids a new independent reply must not take: the head's ids (any provenance) and the overlay's INDEPENDENT ids. A `task_made` overlay id is never taken into account: the coding agent chooses those, and could otherwise use
 * up the independent id range (R1 gives a clashing id its own derived edit id anyway).
 */
export function takenIdsForChannel(headEntries: readonly { readonly id: string }[], overlayEntries: readonly { readonly id: string; readonly provenance: string }[]): Set<string> {
  return new Set([...headEntries.map((entry) => entry.id), ...overlayEntries.filter((entry) => entry.provenance === "independent").map((entry) => entry.id)]);
}

export function acceptAgentReply(brief: ReplyBrief, response: unknown, takenIds: ReadonlySet<string> = new Set(), shapeConflicts: ReadonlySet<string> = new Set()): AcceptedAgentReply {
  if (!isReplyBrief(brief) || !replyAgentCanAnswer(brief)) return { ok: false, reason: "not_a_brief" };
  if (shapeConflicts.has(brief.promptSha256)) return { ok: false, reason: "shape_conflict" };
  const parsed = ModelReplyResponseSchema.safeParse(response);
  if (!parsed.success || !checkReplyShape(brief, parsed.data)) return { ok: false, reason: "bad_shape" };
  if (replyEchoesRequest(brief, parsed.data)) return { ok: false, reason: "reply_echoes_request" };
  const id = independentReplyId(brief.promptSha256, takenIds);
  if (id === undefined) return { ok: false, reason: "no_id" };
  const reply: ModelReplyFileEntry = { id, match: matchForBrief(brief), response: withComputedUsage(brief, parsed.data) };
  // The schema is the last word: an operation of the family, a valid id and match, bounded sizes.
  if (!ModelReplySetFileSchema.safeParse({ version: 1, family: brief.family, replies: [reply] }).success) return { ok: false, reason: "bad_shape" };
  return { ok: true, reply, decision: createRovaraIndependentDecision(modelReplyEntrySha256(reply)) };
}

/** The fixed words for a skipped reply (code, never data). */
export const INDEPENDENT_SKIP_WORDS: Readonly<Record<ReplySkipReason, string>> = {
  already_in_overlay: "this reply's content is already in the task's replies, so it keeps the label it was first stored with and is not counted again",
};

export interface IndependentIntakeReport {
  /** Distinct replies sent to the store (derived from the ids sent, never passed in). */
  readonly attempted: number;
  /** Replies the store says it stored as independent: the store's own count, clamped to what was sent. Never the number sent. */
  readonly stored: number;
  /** Skipped replies: ids that were sent, listed once, with a reason this code knows. */
  readonly skipped: readonly { readonly id: string; readonly reason: ReplySkipReason }[];
  /** Sent, but neither stored nor skipped with a known reason: never counted, always shown. */
  readonly unexplained: number;
  /** The store's answer did not add up (a count above what was sent, a skip that was not sent, a repeated or unknown skip, stored plus skipped not equal to sent). Shown, never hidden. */
  readonly inconsistent: boolean;
  /** The store's refusal word when the whole call was refused (nothing stored). */
  readonly refused?: ReplyStoreWord | undefined;
}

type PutResult = { readonly ok: true; readonly stored: number; readonly skipped?: readonly { readonly id: string; readonly reason: string }[] } | { readonly ok: false; readonly word: ReplyStoreWord };

/** What the store answered for the replies whose ids were sent, as an honest report (see the file header). */
export function reportIndependentIntake(sentIds: readonly string[], put: PutResult): IndependentIntakeReport {
  const sent = new Set(sentIds);
  const attempted = sent.size;
  if (!put.ok) return { attempted, stored: 0, skipped: [], unexplained: 0, inconsistent: false, refused: put.word };
  const known: ReadonlySet<string> = new Set(REPLY_SKIP_REASONS);
  const raw = put.skipped ?? [];
  const skipped: { id: string; reason: ReplySkipReason }[] = [];
  const listed = new Set<string>();
  for (const entry of raw) {
    if (!sent.has(entry.id) || listed.has(entry.id) || !known.has(entry.reason)) continue;
    listed.add(entry.id);
    skipped.push({ id: entry.id, reason: entry.reason as ReplySkipReason });
  }
  const storedValid = Number.isSafeInteger(put.stored) && put.stored >= 0 && put.stored <= attempted;
  const stored = storedValid ? put.stored : Number.isSafeInteger(put.stored) ? Math.max(0, Math.min(put.stored, attempted)) : 0;
  const unexplained = Math.max(0, attempted - stored - skipped.length);
  const inconsistent = !storedValid || skipped.length !== raw.length || stored + skipped.length !== attempted;
  return { attempted, stored, skipped, unexplained, inconsistent };
}

/** One plain sentence for the PR and the evidence: counts only, from the report. */
export function independentIntakeSentence(report: IndependentIntakeReport): string {
  if (report.refused !== undefined) return `no independent replies stored: the reply store refused them (${report.refused})`;
  const parts = [`${report.stored} of ${report.attempted} replies stored as independent`];
  if (report.skipped.length > 0) parts.push(`${report.skipped.length} not stored again (${INDEPENDENT_SKIP_WORDS.already_in_overlay})`);
  if (report.unexplained > 0) parts.push(`${report.unexplained} not stored and not counted`);
  if (report.inconsistent) parts.push("the store's answer did not add up, so only the count it can be trusted for is shown");
  return parts.join("; ");
}
