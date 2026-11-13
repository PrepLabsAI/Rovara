// The model-based floor of the change tier. A list of words and paths can never name all sensitive CODE, so the one strongest-available reviewer that a small change already gets (a reviewer that runs for every small code change)
// is also asked a FIXED set of yes/no questions. Any yes raises the tier to risky: only up, recorded with the reviewer's reason, and the merge then needs the risky review to have run on the current head. The deterministic
// lists stay the first floor; this is the second, and it can only add.
//
// This file is the hook and the record. The reviewer itself (a model call) is supplied by the caller through `TierReviewer`; nothing here calls a model, so it is testable with a fake.
import { FLOW_REASON_PATH_MAX, type WorkflowFlow } from "@agentx/contracts";
import { recordCatch, recordGrowth, recordTier, tierRank, type ChangeTier, type TierReason } from "./change-tier.js";

/** The questions, in the words the reviewer is given. Fixed: a reviewer's own sense of "sensitive" is never the rule. */
export const TIER_QUESTIONS: ReadonlyArray<{ id: string; text: string }> = [
  { id: "auth", text: "Does the change touch authentication, sign-in, sessions, tokens, keys or cryptography?" },
  { id: "money", text: "Does the change touch money, pricing, plans or billing?" },
  { id: "permissions", text: "Does the change touch permissions, roles, access checks or impersonation?" },
  { id: "deletion", text: "Does the change delete data, or do anything that cannot be undone?" },
  { id: "checks", text: "Does the change touch CI or the build, or weaken a test or any other check?" },
  { id: "dependencies", text: "Does the change touch dependencies, or where packages or installs come from?" },
  { id: "infra", text: "Does the change touch infrastructure, IAM or deployment?" },
  { id: "agent_instructions", text: "Does the change touch instructions or prompts that tell an AI agent what to do?" },
];

export interface TierReviewAnswer {
  /** One of `TIER_QUESTIONS`. */
  id: string;
  yes: boolean;
  /** Why, in the reviewer's words (shown as untrusted text: cut and made plain here). */
  reason?: string | undefined;
}

export interface TierReviewer {
  /** The strongest-available reviewer answers every question about the change. A reviewer that cannot answer throws. */
  answer(input: { questions: typeof TIER_QUESTIONS; files: readonly string[]; patchText?: string | undefined }): Promise<readonly TierReviewAnswer[]>;
}

/** The text a reviewer is given: the fixed questions and how to answer. The files and the patch come after, from the caller. */
export function tierReviewPrompt(): string {
  return [
    "Answer each question about the change with yes or no and, for a yes, one short reason. Answer every question. Reply with JSON only: an array of {\"id\": string, \"yes\": boolean, \"reason\": string}.",
    ...TIER_QUESTIONS.map((question) => `${question.id}: ${question.text}`),
  ].join("\n");
}

/** A reviewer's reason as one plain line: no control characters, cut to the reason field's limit. */
const plainReason = (text: string | undefined): string | undefined => {
  const plain = (text ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, Math.min(200, FLOW_REASON_PATH_MAX));
  return plain === "" ? undefined : plain;
};

export interface ReviewerFloorResult {
  /** False when the reviewer could not answer (it threw): the tier is unchanged and nothing is recorded as asked. */
  ran: boolean;
  /** The tier after the floor: the given one, or risky with the reviewer's reasons in front. Never lower. */
  tier: ChangeTier;
  raised: boolean;
  /** The questions answered yes (an unanswered question counts as yes). */
  yes: string[];
}

/**
 * Asks the reviewer the fixed questions about the change and applies the answers as a floor. A yes, or a question left unanswered, raises the tier to risky; the reviewer's reason goes in front of the tier's own reasons as
 * `reviewer_<id>`. A reviewer that throws changes nothing (a provider outage is a notice, never a verdict). The result is the tier to record with `recordReviewerFloor`.
 */
export async function applyReviewerFloor(input: { tier: ChangeTier; reviewer: TierReviewer; files: readonly string[]; patchText?: string | undefined }): Promise<ReviewerFloorResult> {
  let answers: readonly TierReviewAnswer[];
  try {
    answers = await input.reviewer.answer({ questions: TIER_QUESTIONS, files: input.files, patchText: input.patchText });
  } catch {
    return { ran: false, tier: input.tier, raised: false, yes: [] };
  }
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const yes = TIER_QUESTIONS.filter((question) => byId.get(question.id)?.yes !== false).map((question) => question.id);
  if (yes.length === 0) return { ran: true, tier: input.tier, raised: false, yes };
  const reasons: TierReason[] = yes.map((id) => {
    const answered = byId.get(id);
    const reason = answered === undefined ? "the reviewer gave no answer to this question" : plainReason(answered.reason);
    return { code: `reviewer_${id}`, ...(reason === undefined ? {} : { path: reason }) };
  });
  const level = tierRank(input.tier.level) >= tierRank("risky") ? input.tier.level : "risky";
  const seen = new Set<string>();
  const merged = [...reasons, ...input.tier.reasons].filter((reason) => { const key = `${reason.code}\u0000${reason.path ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 50);
  return { ran: true, tier: { ...input.tier, level, reasons: merged }, raised: tierRank(level) > tierRank(input.tier.level), yes };
}

/** The `flow` record after the reviewer floor: the raised tier recorded only-up with the growth, and one catch counter for the question step (findings = questions answered yes). Unchanged when the reviewer did not run. */
export function recordReviewerFloor(flow: WorkflowFlow | undefined, result: ReviewerFloorResult, at: string): WorkflowFlow | undefined {
  if (!result.ran) return flow;
  const before = flow?.tier?.level;
  const recorded = recordTier(flow, result.tier);
  const grown = result.raised && before !== undefined ? recordGrowth(recorded.flow, before, recorded.tier.level, at) : result.raised ? recordGrowth(recorded.flow, "small", recorded.tier.level, at) : recorded.flow;
  return recordCatch(grown, { step: "tier_questions", findings: result.yes.length, mustFix: result.yes.length });
}
