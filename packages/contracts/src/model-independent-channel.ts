// TE-R2 part A (M2, release 0.5.19; DECISIONS 161, 166b): the Rovara-side CHANNEL, the only file besides R1's `model-reply-store-rules.ts` (`decisionForEntry`) that calls `createRovaraIndependentDecision`. A guard test greps the repo
// for any other caller (allow-list: this file, R1's rules file, tests). Nothing in `packages/worker/src/` imports this file or the function (a test): the worker only ever receives RESOLVED sets, never a decision.
//
// `acceptAgentReply` turns one validated agent answer into the entry R1's `putIndependentOverlay` takes: `{reply, decision}`.
//   * THE MATCH IS COMPUTED BY CODE from the brief: `operation`, `model` (when the brief has one) and `promptSha256`, all exact. Never `promptContains`, never a `sequence`. The agent writes only `response`.
//   * The brief must be one `extractReplyBrief` or `parseReplyBrief` made (a spread copy or a hand-made look-alike is refused: `not_a_brief`).
//   * The response is re-checked here, not trusted from the caller: `ModelReplyResponseSchema` and the brief's shape; `usage` is Rovara's. A reply that does not fit is `bad_shape`.
//   * The id is `ind-<first 12 hex of promptSha256>`; when that id is taken (`takenIds`), `-2`, `-3` ... up to `-9`.
//   * The decision is `createRovaraIndependentDecision(modelReplyEntrySha256(reply))`, bound to this reply's content.
// `reportIndependentIntake` turns what R1's `putIndependentOverlay` answered into an honest report: what the STORE says it stored (never the number sent), each skipped reply with its fixed reason (today `already_in_overlay`: this content
// is already in the task's overlay, or the coding agent wrote it, so it keeps the provenance it was first written with and is not counted again), anything unexplained, and a refusal word. Part B's agent step and the PR's evidence use it.
// PURE: no I/O. Independence is NOT proven by any of this: see `model-reply-leak-screen.ts` for what the screens do not catch.
import { checkReplyShape, withComputedUsage } from "./model-reply-agent.js";
import { isReplyBrief, replyAgentCanAnswer, type ReplyBrief } from "./model-reply-brief.js";
import { ModelReplyResponseSchema, ModelReplySetFileSchema, createRovaraIndependentDecision, modelReplyEntrySha256, type IndependentReplyDecision, type ModelReplyFileEntry } from "./model-reply-set.js";
import { REPLY_SKIP_REASONS, type ReplySkipReason, type ReplyStoreWord } from "./model-reply-store.js";

export type ChannelRefusal = "not_a_brief" | "bad_shape" | "no_id";
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

export function acceptAgentReply(brief: ReplyBrief, response: unknown, takenIds: ReadonlySet<string> = new Set()): AcceptedAgentReply {
  if (!isReplyBrief(brief) || !replyAgentCanAnswer(brief)) return { ok: false, reason: "not_a_brief" };
  const parsed = ModelReplyResponseSchema.safeParse(response);
  if (!parsed.success || !checkReplyShape(brief, parsed.data)) return { ok: false, reason: "bad_shape" };
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
  /** Replies sent to the store. */
  readonly attempted: number;
  /** Replies the store says it stored as independent: the store's own count, clamped to what was sent. Never the number sent. */
  readonly stored: number;
  readonly skipped: readonly { readonly id: string; readonly reason: ReplySkipReason }[];
  /** Sent, but neither stored nor skipped with a known reason (a store that answered something this code does not know): never counted, always shown. */
  readonly unexplained: number;
  /** The store's refusal word when the whole call was refused (nothing stored). */
  readonly refused?: ReplyStoreWord | undefined;
}

type PutResult = { readonly ok: true; readonly stored: number; readonly skipped?: readonly { readonly id: string; readonly reason: string }[] } | { readonly ok: false; readonly word: ReplyStoreWord };

export function reportIndependentIntake(attempted: number, put: PutResult): IndependentIntakeReport {
  if (!put.ok) return { attempted, stored: 0, skipped: [], unexplained: 0, refused: put.word };
  const known: ReadonlySet<string> = new Set(REPLY_SKIP_REASONS);
  const skipped = (put.skipped ?? []).filter((entry): entry is { id: string; reason: ReplySkipReason } => known.has(entry.reason)).map((entry) => ({ id: entry.id, reason: entry.reason }));
  const stored = Number.isSafeInteger(put.stored) ? Math.max(0, Math.min(put.stored, attempted)) : 0;
  return { attempted, stored, skipped, unexplained: Math.max(0, attempted - stored - skipped.length) };
}

/** One plain sentence for the PR and the evidence: counts only, from the report. */
export function independentIntakeSentence(report: IndependentIntakeReport): string {
  if (report.refused !== undefined) return `no independent replies stored: the reply store refused them (${report.refused})`;
  const parts = [`${report.stored} of ${report.attempted} independent replies stored and counted`];
  if (report.skipped.length > 0) parts.push(`${report.skipped.length} not stored again (${INDEPENDENT_SKIP_WORDS.already_in_overlay})`);
  if (report.unexplained > 0) parts.push(`${report.unexplained} not stored and not counted`);
  return parts.join("; ");
}
