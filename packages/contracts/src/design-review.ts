// Design review stage (designs-2026-10-30/design-review-stage.md 3.1 and 3.5; owner decisions 2026-11-03 in DECISIONS.md "Design review stage").
// A task that needs design decisions gets its design checked by fresh-context reviewers before a person approves it. These are the stored shapes only. Browser-safe.
// Reviewers resolve their model through the existing `plan_check` stage (strongest, different from the planner): STAGE_IDS is unchanged on purpose, because adding a stage
// changes the digest of every recorded model-choice approval.
import { z } from "zod";
import { sha256Hex } from "./web-hash.js";

const PlainLine = (max: number) => z.string().min(1).max(max).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must be plain text");
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Instant = z.string().datetime({ offset: true });
const Usd = z.number().min(0).max(10_000);

/** Why Understand says a task does or doesn't need design review. Fixed codes; the plain line beside them is model words, shown through plainLine. */
export const DESIGN_REASONS = [
  "new_api", "api_change", "data_model", "cross_repo_or_service", "new_dependency", "auth", "money", "pii", "infrastructure",
  "small_change", "bug_fix",
] as const;
export const DesignReasonSchema = z.enum(DESIGN_REASONS);
export type DesignReason = z.infer<typeof DesignReasonSchema>;
export const DESIGN_REASONS_MAX = 4;
export const DESIGN_NOTE_MAX = 200;

/** A design touching any of these needs the project's high-risk approver (3.8). Code decides this; model text can only add reasons, never remove them. */
export const DESIGN_REVIEW_HIGH_RISK_REASONS: readonly DesignReason[] = ["data_model", "auth", "money", "pii", "cross_repo_or_service", "infrastructure"];
export function isHighRiskDesign(reasons: readonly DesignReason[]): boolean {
  return reasons.some((reason) => DESIGN_REVIEW_HIGH_RISK_REASONS.includes(reason));
}

/** The optional field on Understand's `ready` answer. Absent (an older worker) reads as "not needed". */
export const IntentDesignSchema = z.object({
  needed: z.boolean(),
  reasons: z.array(DesignReasonSchema).max(DESIGN_REASONS_MAX),
  note: PlainLine(DESIGN_NOTE_MAX),
}).strict();
export type IntentDesign = z.infer<typeof IntentDesignSchema>;

export const DESIGN_REVIEW_MODES = ["auto", "always", "never"] as const;
export const DESIGN_REVIEW_TIERS = ["light", "standard", "thorough"] as const;
export const DesignReviewTierSchema = z.enum(DESIGN_REVIEW_TIERS);
export type DesignReviewTier = z.infer<typeof DesignReviewTierSchema>;
export const DESIGN_REVIEW_CAP_MIN_USD = 0.5;
export const DESIGN_REVIEW_CAP_MAX_USD = 100;
export const DESIGN_REVIEW_APPROVERS_MAX = 10;

export const DesignReviewApproverSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("maintainers") }).strict(),
  z.object({ kind: z.literal("people"), memberIds: z.array(z.string().min(1).max(100)).min(1).max(DESIGN_REVIEW_APPROVERS_MAX) }).strict(),
  /** Only where the install allows it; the broker refuses it elsewhere. */
  z.object({ kind: z.literal("group"), groupId: z.string().min(1).max(100) }).strict(),
]);
export type DesignReviewApprover = z.infer<typeof DesignReviewApproverSchema>;

/** The project's "How we work" setting for design review. */
export const DesignReviewSettingSchema = z.object({
  mode: z.enum(DESIGN_REVIEW_MODES),
  tier: DesignReviewTierSchema,
  allowSkip: z.boolean(),
  capUsdPerTask: z.number().min(DESIGN_REVIEW_CAP_MIN_USD).max(DESIGN_REVIEW_CAP_MAX_USD),
  highRiskApprover: DesignReviewApproverSchema,
}).strict();
export type DesignReviewSetting = z.infer<typeof DesignReviewSettingSchema>;

/** Owner decisions 2026-11-03: auto, Standard (3 reviewers), Skip allowed, maintainers approve high-risk designs. Cost limit per task $15 (owner 2026-11-06, raised from $10 after FU3 made estimates honest; review spend stays inside the task run limit). Stored settings keep their own value. */
export const DESIGN_REVIEW_DEFAULT_SETTING: Readonly<DesignReviewSetting> = Object.freeze({
  mode: "auto", tier: "standard", allowSkip: true, capUsdPerTask: 15, highRiskApprover: Object.freeze({ kind: "maintainers" as const }),
});

/** Owner Q7: at most 2 review rounds and 2 planner revisions per design. */
export const DESIGN_REVIEW_ROUNDS_MAX = 2;
export const DESIGN_REVIEW_REVISIONS_MAX = 2;
export const DESIGN_REVIEW_QUESTIONS_MAX = 3;
export const DESIGN_REVIEW_REVIEWERS_MAX = 5;
export const DESIGN_REVIEW_FINDINGS_MAX = 30;
export const DESIGN_REVIEW_PACKET_ITEMS_MAX = 40;

export const DESIGN_SECTIONS = ["§1", "§2", "§3", "§4", "§5", "§6", "§7", "§8"] as const;
export const DesignSectionSchema = z.enum(DESIGN_SECTIONS);

export const REVIEWER_ROLES = ["comprehension", "critic", "codebase", "zoom_out", "critic_b"] as const;
export const ReviewerRoleSchema = z.enum(REVIEWER_ROLES);
export type ReviewerRole = z.infer<typeof ReviewerRoleSchema>;

/** Where a finding or a resolution points: a design section, a line of code at a pinned commit, or a source item the reviewer was given. */
/** The same shape as a lesson's code citation (lessons.ts), kept here so this browser-safe file pulls in nothing else: the drift check can later read both alike. */
export const DesignCodeCitationSchema = z.object({
  kind: z.literal("code"),
  repo: z.string().min(1).max(200),
  path: z.string().min(1).max(500),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  anchor: z.string().min(1).max(300),
  commit: z.string().regex(/^[a-f0-9]{7,64}$/),
}).strict().refine((citation) => citation.endLine >= citation.startLine, { message: "endLine is before startLine", path: ["endLine"] });
export const DesignCitationSchema = z.union([
  z.object({ kind: z.literal("design"), section: DesignSectionSchema }).strict(),
  DesignCodeCitationSchema,
  z.object({ kind: z.literal("source"), ref: z.string().min(1).max(300), digest: Digest }).strict(),
]);
export type DesignCitation = z.infer<typeof DesignCitationSchema>;

export const DesignModelRefSchema = z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict();

export const PACKET_ITEM_KINDS = ["design", "requirements", "repo_file", "meta_repo_file", "mcp_item"] as const;
export const ReviewerPacketItemSchema = z.object({
  kind: z.enum(PACKET_ITEM_KINDS),
  ref: z.string().min(1).max(500),
  /** A commit sha for repository items, the fetch time for an MCP item. */
  commitOrFetchedAt: z.string().min(1).max(64),
  digest: Digest,
  bytes: z.number().int().min(0).max(5_000_000),
}).strict();

/** Why the broker voided a reviewer's result (3.4 step 4). Fixed codes only. */
export const REVIEWER_VERIFY_FAILURES = ["packet_digest_mismatch", "session_reused", "tool_not_read_only", "model_key_mismatch", "first_call_mismatch", "no_usage_record", "unreadable_output", "timeout"] as const;

/**
 * What proved a verified reviewer's input (3.4, DR-FU2). "proxy_first_call": the packet digest matched AND the model proxy's own count of the key's first call was within tolerance of the
 * packet. "digest_only": only the packet digest was checked (no proxy first-call reader is installed yet). A verified run must say which; the card words come from `INPUT_PROOF_SENTENCES`.
 */
export const INPUT_PROOFS = ["proxy_first_call", "digest_only"] as const;
export const InputProofSchema = z.enum(INPUT_PROOFS);
export type InputProof = z.infer<typeof InputProofSchema>;
/** The one fixed sentence for each proof. The card shows these and nothing that sounds stronger: "digest_only" never says the proxy confirmed anything. */
export const INPUT_PROOF_SENTENCES: Readonly<Record<InputProof, string>> = Object.freeze({
  digest_only: "verified by the digest of the packet the worker fetched; what the model was sent and the proxy's first-call size were not checked",
  proxy_first_call: "verified by the digest of the packet the worker fetched and the proxy's first call",
});
export function inputProofSentence(proof: InputProof): string {
  return INPUT_PROOF_SENTENCES[proof];
}
/** The label for `ReviewerRun.filesRead` on the card: the worker's own list, not something Rovara checked (never use it as citation proof). */
export const FILES_READ_LABEL = "reported by the worker";

/**
 * The Light tier runs one Critic "with the comprehension paraphrase in its prompt" (design-review-stage.md 3.4). That Critic has its own registered prompt, with this id, which asks for the paraphrase.
 * The prompt id is bound into the packet digest, so it is the one signal that cannot be forged by the worker: whoever reads that Critic's answer reads it with the paraphrase, and no other reviewer does.
 */
export const LIGHT_CRITIC_PROMPT_ID = "design-review-critic-light";
export function lightCriticWritesParaphrase(role: ReviewerRole, promptId: string): boolean {
  return role === "critic" && promptId === LIGHT_CRITIC_PROMPT_ID;
}

/** One reviewer's run: what it was given and what it cost. This record is the fresh-context evidence on the decision card. */
export const ReviewerRunSchema = z.object({
  role: ReviewerRoleSchema,
  promptId: z.string().min(1).max(100),
  promptVersion: z.number().int().min(1),
  promptDigest: Digest,
  model: DesignModelRefSchema,
  sourceId: z.string().min(1).max(100),
  sessionId: z.string().min(1).max(200),
  modelKeyId: z.string().min(1).max(200),
  packetDigest: Digest,
  packet: z.array(ReviewerPacketItemSchema).max(DESIGN_REVIEW_PACKET_ITEMS_MAX),
  /** The worker's own list of files it says it read (`FILES_READ_LABEL`). Plain text only. */
  filesRead: z.array(PlainLine(500)).max(200),
  verified: z.boolean(),
  verifyFailure: z.enum(REVIEWER_VERIFY_FAILURES).optional(),
  /** Required when `verified`: what proved the input. Absent when not verified. */
  inputProof: InputProofSchema.optional(),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  costUsd: Usd,
  startedAt: Instant,
  endedAt: Instant,
  /** Comprehension only (and the Light tier's Critic, whose prompt asks for it): "what this proposes", shown to the approver next to the request. */
  paraphrase: z.string().min(1).max(1500).optional(),
}).strict().superRefine((run, context) => {
  if (run.paraphrase !== undefined && run.role !== "comprehension" && !lightCriticWritesParaphrase(run.role, run.promptId)) context.addIssue({ code: "custom", path: ["paraphrase"], message: "only the comprehension reviewer (or the Light tier's Critic) writes a paraphrase" });
  if (!run.verified && run.verifyFailure === undefined) context.addIssue({ code: "custom", path: ["verifyFailure"], message: "an unverified run says why" });
  if (run.verified && run.verifyFailure !== undefined) context.addIssue({ code: "custom", path: ["verifyFailure"], message: "a verified run has no failure" });
  if (run.verified && run.inputProof === undefined) context.addIssue({ code: "custom", path: ["inputProof"], message: "a verified run says what proved its input" });
  if (!run.verified && run.inputProof !== undefined) context.addIssue({ code: "custom", path: ["inputProof"], message: "an unverified run has no input proof" });
});
export type ReviewerRun = z.infer<typeof ReviewerRunSchema>;

export const DESIGN_FINDING_SEVERITIES = ["blocker", "major", "nit"] as const;
const SEVERITY_ORDER: Record<(typeof DESIGN_FINDING_SEVERITIES)[number], number> = { blocker: 0, major: 1, nit: 2 };

/** A finding's text with case, spacing and punctuation taken out: the form in which two texts are "the same words". */
export function normalizedFindingText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * A reviewer's own finding, as it was written, kept on the merged finding it was grouped into (M3). The merge step cannot touch these: they are copied by code from the raw findings, so the card can
 * expand a merged finding to the reviewers' words, and the identity of the finding across rounds (`designFindingFingerprint`) is taken from them, never from the merge model's wording (M4).
 */
export const RawFindingRecordSchema = z.object({
  rawId: z.string().min(1).max(64),
  role: ReviewerRoleSchema,
  severity: z.enum(DESIGN_FINDING_SEVERITIES),
  text: z.string().min(1).max(500),
}).strict();
export type RawFindingRecord = z.infer<typeof RawFindingRecordSchema>;

/** The id prefix of the broker's own finding for a reviewer finding that could not be read (own-findings.ts). A requirement id (letters, digits, . _ -) can never make an id with this "~", so no other own finding can clash with it. */
export const DESIGN_LOST_FINDING_ID_PREFIX = "rovara~lost-";

export const DesignFindingSchema = z.object({
  id: z.string().min(1).max(64),
  severity: z.enum(DESIGN_FINDING_SEVERITIES),
  section: DesignSectionSchema,
  text: z.string().min(1).max(500),
  citations: z.array(DesignCitationSchema).min(1).max(5),
  /** "rovara": a finding the broker adds itself with no model involved (a requirement with no §3 section, a design over the size cap). Absent means "reviewers". */
  origin: z.enum(["reviewers", "rovara"]).optional(),
  fromReviewers: z.array(ReviewerRoleSchema).max(DESIGN_REVIEW_REVIEWERS_MAX),
  rawIds: z.array(z.string().min(1).max(64)).max(DESIGN_REVIEW_REVIEWERS_MAX * 15),
  /** The reviewers' own words for every raw finding in `rawIds` (same ids). Absent only on a finding Rovara adds itself, or one stored before this field. */
  rawFindings: z.array(RawFindingRecordSchema).max(DESIGN_REVIEW_REVIEWERS_MAX * 15).optional(),
  fingerprint: Digest,
}).strict().superRefine((finding, context) => {
  const byRovara = finding.origin === "rovara";
  if (byRovara && (finding.fromReviewers.length > 0 || finding.rawIds.length > 0)) context.addIssue({ code: "custom", path: ["origin"], message: "a finding Rovara adds names no reviewer" });
  if (!byRovara && (finding.fromReviewers.length === 0 || finding.rawIds.length === 0)) context.addIssue({ code: "custom", path: ["fromReviewers"], message: "a reviewer finding names its reviewers and raw findings" });
  const raw = finding.rawFindings;
  if (raw === undefined) return;
  // What the merge step may and may not have done is checked on the stored shape too, so a finding built any other way is held to the same rules.
  const ids = raw.map((entry) => entry.rawId);
  if (ids.length !== finding.rawIds.length || new Set(ids).size !== ids.length || finding.rawIds.some((id) => !ids.includes(id))) {
    context.addIssue({ code: "custom", path: ["rawFindings"], message: "the raw findings are the ones named in rawIds" });
    return;
  }
  if (raw.length === 0) return;
  const top = raw.reduce((highest, entry) => (SEVERITY_ORDER[entry.severity] < SEVERITY_ORDER[highest] ? entry.severity : highest), raw[0]!.severity);
  if (finding.severity !== top) context.addIssue({ code: "custom", path: ["severity"], message: "a finding keeps the highest severity of its raw findings" });
  const own = normalizedFindingText(finding.text);
  if (!raw.some((entry) => entry.severity === top && normalizedFindingText(entry.text) === own)) context.addIssue({ code: "custom", path: ["text"], message: "a finding's text is one of its highest-severity raw findings" });
  if (!finding.fromReviewers.every((role) => raw.some((entry) => entry.role === role)) || !raw.every((entry) => finding.fromReviewers.includes(entry.role))) context.addIssue({ code: "custom", path: ["fromReviewers"], message: "the reviewers are the raw findings' reviewers" });
});
export type DesignFinding = z.infer<typeof DesignFindingSchema>;

export const DESIGN_QUESTION_IDS = ["q1", "q2", "q3"] as const;
export const FindingResolutionSchema = z.object({
  findingId: z.string().min(1).max(64),
  action: z.enum(["fixed", "contested", "asked", "declined"]),
  evidence: z.array(DesignCitationSchema).max(3).optional(),
  note: z.string().max(300),
  settled: z.boolean(),
  questionId: z.enum(DESIGN_QUESTION_IDS).optional(),
}).strict().superRefine((resolution, context) => {
  if (resolution.action === "contested" && (resolution.evidence ?? []).length === 0) context.addIssue({ code: "custom", path: ["evidence"], message: "a contested finding needs evidence" });
  if (resolution.action === "asked" && resolution.questionId === undefined) context.addIssue({ code: "custom", path: ["questionId"], message: "an asked finding names its question" });
});
export type FindingResolution = z.infer<typeof FindingResolutionSchema>;

export const DesignQuestionSchema = z.object({
  id: z.enum(DESIGN_QUESTION_IDS),
  unclear: PlainLine(200),
  evidence: z.array(DesignCitationSchema).max(3),
  options: z.array(z.object({ id: z.string().min(1).max(16), label: PlainLine(80), consequence: PlainLine(120) }).strict()).min(2).max(4),
  recommended: z.string().min(1).max(16),
  why: PlainLine(160),
}).strict().superRefine((question, context) => {
  const ids = question.options.map((option) => option.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["options"], message: "option ids are used once" });
  if (!ids.includes(question.recommended)) context.addIssue({ code: "custom", path: ["recommended"], message: "the recommended answer must be one of the options" });
});
export type DesignQuestion = z.infer<typeof DesignQuestionSchema>;

/** A person's answer to one design question (DR6): an option of that question, words, or both. Cleaned by the transition that records it. */
export const DesignAnswerSchema = z.object({
  questionId: z.enum(DESIGN_QUESTION_IDS),
  optionId: z.string().min(1).max(16).optional(),
  text: z.string().min(1).max(500).optional(),
}).strict().refine((answer) => answer.optionId !== undefined || answer.text !== undefined, { message: "an answer picks an option or says something" });
export type DesignAnswer = z.infer<typeof DesignAnswerSchema>;

/**
 * A reviewer finding the broker did not use because no citation of it matched what the reviewer was given (3.12 item 5): kept as a role, a severity and a section only, so the card can say "N findings were not used", blockers included
 * (a blocker that was dropped is the one a person most needs to know about). The words of the finding are not kept.
 */
export const DroppedDesignFindingSchema = z.object({ role: ReviewerRoleSchema, severity: z.enum(DESIGN_FINDING_SEVERITIES), section: DesignSectionSchema }).strict();
export type DroppedDesignFinding = z.infer<typeof DroppedDesignFindingSchema>;
export const DESIGN_DROPPED_FINDINGS_MAX = DESIGN_REVIEW_REVIEWERS_MAX * 15;

export const DesignReviewRoundSchema = z.object({
  round: z.union([z.literal(1), z.literal(2)]),
  designDigest: Digest,
  reviewers: z.array(ReviewerRunSchema).max(DESIGN_REVIEW_REVIEWERS_MAX),
  findings: z.array(DesignFindingSchema).max(DESIGN_REVIEW_FINDINGS_MAX),
  resolutions: z.array(FindingResolutionSchema).max(DESIGN_REVIEW_FINDINGS_MAX),
  questions: z.array(DesignQuestionSchema).max(DESIGN_REVIEW_QUESTIONS_MAX).optional(),
  /** DR6: the one set of answers to this round's question card, with the person the broker authenticated. */
  answers: z.object({ by: z.object({ actorId: z.string().min(1).max(128) }).strict(), at: Instant, answers: z.array(DesignAnswerSchema).min(1).max(DESIGN_REVIEW_QUESTIONS_MAX) }).strict().optional(),
  /** DR6: findings (by id) of a later round that would undo an earlier fix. They end the loop early and go to the card (the oscillation rule). */
  oscillation: z.array(z.string().min(1).max(64)).max(DESIGN_REVIEW_FINDINGS_MAX).optional(),
  mergeModel: DesignModelRefSchema.optional(),
  /** The reviewers' findings that were left out because no citation held (broker-made, never the worker's list). Absent in a round recorded before this field. */
  droppedFindings: z.array(DroppedDesignFindingSchema).max(DESIGN_DROPPED_FINDINGS_MAX).optional(),
  /** How many findings a reader could not use at all (no readable severity or section, not an object): a count only, there is nothing else to keep. Absent when none, and in a round recorded before this field. */
  unreadableFindings: z.number().int().min(1).max(DESIGN_DROPPED_FINDINGS_MAX).optional(),
  /**
   * What the review's estimate was when this round was recorded: the estimate made at the round's start, for the rounds then still to run (round 1 of two covers both, round 2 only itself). The review's own
   * `estimateUsd` is cleared when the round resolves (round 2 is priced afresh), so this copy is what lets a finished review show "estimated $x, spent $y". Absent in a round recorded before this field, and
   * when the round ran unpriced.
   */
  estimateUsd: Usd.optional(),
}).strict();
export type DesignReviewRound = z.infer<typeof DesignReviewRoundSchema>;

export const DESIGN_REVIEW_DECIDED_BY = ["auto", "always", "person", "person_skip", "never"] as const;
export const DESIGN_REVIEW_STATUSES = ["estimating", "waiting_cost", "running", "resolving", "waiting_answers", "done", "not_run", "stopped_at_cap"] as const;
/**
 * `rearm_limit`: a person sent the design back more often than the re-review bound allows; they raise the cap or pick a lower tier to review again.
 * `skipped`: a person chose Skip on the spend card (`skipDesignReview`); the review is not retried, re-armed or reopened by a raise or a lower tier.
 */
export const DESIGN_REVIEW_NOT_RUN_REASONS = ["no_model_source", "no_verified_model", "cost_declined", "timeout", "worker_failed", "inputs_unverified", "rearm_limit", "skipped", "cancelled", "task_limit", "switched_off"] as const;

/** Re-reviews after a person sent a design back (REQUEST_CHANGES) before a person must raise the cap or pick a lower tier; and retries of a review that did not run. Both reset on such a change. */
export const DESIGN_REVIEW_REARMS_MAX = 2;
export const DESIGN_REVIEW_RETRIES_MAX = 2;
/** Archived reviews of designs that were sent back (oldest dropped first) and the bytes they may weigh, so the record stays inside its 150 KB limit. */
export const DESIGN_REVIEW_EARLIER_MAX = 4;
export const DESIGN_REVIEW_EARLIER_MAX_BYTES = 40_000;
export const DESIGN_REVIEW_APPROVALS_MAX = 20;
/** 3.7: a wait for answers is parked after 7 days and closed as "not decided" after 30 days parked. */
export const DESIGN_REVIEW_PARK_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const DESIGN_REVIEW_CLOSE_AFTER_PARKED_MS = 30 * 24 * 60 * 60 * 1000;
/** 3.7 / Q5 (DR10): the reminders to the people a design waits on, after 24 hours and after 72 hours of waiting. */
export const DESIGN_REVIEW_REMIND_AFTER_HOURS = [24, 72] as const;

/** The person a transition names, as the broker authenticated them (the same shape as `answers.by`). */
export const DesignReviewActorSchema = z.object({ actorId: z.string().min(1).max(128) }).strict();
export type DesignReviewActor = z.infer<typeof DesignReviewActorSchema>;
const CapUsd = z.number().min(DESIGN_REVIEW_CAP_MIN_USD).max(DESIGN_REVIEW_CAP_MAX_USD);

/** Money and tier decisions a person made, in order. The cap and the tier change only through these. */
export const DesignReviewApprovalSchema = z.discriminatedUnion("kind", [
  /** One tap on the spend: required when there is no price. It never lifts the cap. */
  z.object({ kind: z.literal("spend"), by: DesignReviewActorSchema, at: Instant, approvedUsd: Usd.optional() }).strict(),
  z.object({ kind: z.literal("raise_cap"), by: DesignReviewActorSchema, at: Instant, fromUsd: CapUsd, capUsd: CapUsd }).strict(),
  z.object({ kind: z.literal("lower_tier"), by: DesignReviewActorSchema, at: Instant, from: DesignReviewTierSchema, tier: DesignReviewTierSchema }).strict(),
]);
export type DesignReviewApproval = z.infer<typeof DesignReviewApprovalSchema>;

/** What is kept of the paid rounds when a person sends a design back: who ran, what each cost and what was found. Not the packets or the files read. */
export const ArchivedReviewerSchema = z.object({
  role: ReviewerRoleSchema, model: DesignModelRefSchema, sessionId: z.string().min(1).max(200), modelKeyId: z.string().min(1).max(200), packetDigest: Digest,
  verified: z.boolean(), verifyFailure: z.enum(REVIEWER_VERIFY_FAILURES).optional(), tokensIn: z.number().int().min(0), tokensOut: z.number().int().min(0), costUsd: Usd,
}).strict();
export const ArchivedFindingSchema = z.object({
  id: z.string().min(1).max(64), severity: z.enum(DESIGN_FINDING_SEVERITIES), section: DesignSectionSchema, fingerprint: Digest, text: z.string().min(1).max(160),
  action: z.enum(["fixed", "contested", "asked", "declined"]).optional(), settled: z.boolean().optional(),
}).strict();
export const ArchivedRoundSchema = z.object({
  round: z.union([z.literal(1), z.literal(2)]), designDigest: Digest,
  reviewers: z.array(ArchivedReviewerSchema).max(DESIGN_REVIEW_REVIEWERS_MAX), findings: z.array(ArchivedFindingSchema).max(DESIGN_REVIEW_FINDINGS_MAX),
}).strict();
export const EarlierDesignReviewSchema = z.object({
  sentBackBy: DesignReviewActorSchema, sentBackAt: Instant,
  /** The review's total spend when the design was sent back. */
  spentUsd: Usd, rounds: z.array(ArchivedRoundSchema).max(DESIGN_REVIEW_ROUNDS_MAX),
}).strict();
export type EarlierDesignReview = z.infer<typeof EarlierDesignReviewSchema>;

/**
 * A wait on people (3.7): when it began, when it was parked (7 days), who resumed it, and when it was closed as not decided (30 days parked). A wait for answers always has one. The other two waits (the cost
 * hold, and the design card's decision) have one only once they are parked or resumed (DR10), and it names the workflow `revision` it belongs to: a record for any other revision is history and is never read.
 */
export const DesignReviewWaitSchema = z.object({
  since: Instant, parkedAt: Instant.optional(), resumedBy: DesignReviewActorSchema.optional(), closedAt: Instant.optional(), revision: z.number().int().min(1).optional(),
}).strict();

/** Beside `critique` on the workflow snapshot (wired in DR6). */
export const WorkflowDesignReviewSchema = z.object({
  decidedBy: z.enum(DESIGN_REVIEW_DECIDED_BY),
  reasons: z.array(DesignReasonSchema).max(DESIGN_REASONS_MAX),
  note: PlainLine(DESIGN_NOTE_MAX).optional(),
  status: z.enum(DESIGN_REVIEW_STATUSES),
  tier: DesignReviewTierSchema,
  estimateUsd: Usd.optional(),
  spentUsd: Usd,
  /** The cost cap for this task, stored when the review starts (the setting's, or a person's raised one). Spend never goes past it; only a person's raise changes it. */
  capUsd: CapUsd.optional(),
  /** The person who asked for design first, and whether it came from a Quick plan's card (the earlier plan stays on the task as history). */
  startedBy: DesignReviewActorSchema.optional(),
  /** The person who chose Skip on the spend card (`decidedBy` is then "person_skip"). */
  skippedBy: DesignReviewActorSchema.optional(),
  fromQuick: z.literal(true).optional(),
  approvals: z.array(DesignReviewApprovalSchema).max(DESIGN_REVIEW_APPROVALS_MAX).optional(),
  rearms: z.number().int().min(0).max(DESIGN_REVIEW_REARMS_MAX).optional(),
  retries: z.number().int().min(0).max(DESIGN_REVIEW_RETRIES_MAX).optional(),
  earlierReviews: z.array(EarlierDesignReviewSchema).max(DESIGN_REVIEW_EARLIER_MAX).optional(),
  waiting: DesignReviewWaitSchema.optional(),
  rounds: z.array(DesignReviewRoundSchema).max(DESIGN_REVIEW_ROUNDS_MAX),
  notRunReason: z.enum(DESIGN_REVIEW_NOT_RUN_REASONS).optional(),
}).strict().superRefine((review, context) => {
  review.rounds.forEach((round, index) => {
    if (round.round !== index + 1) context.addIssue({ code: "custom", path: ["rounds", index, "round"], message: "rounds are numbered 1, 2 in order" });
  });
  if (review.status === "not_run" && review.notRunReason === undefined) context.addIssue({ code: "custom", path: ["notRunReason"], message: "a review that did not run says why" });
  if (review.decidedBy === "person_skip" && review.skippedBy === undefined) context.addIssue({ code: "custom", path: ["skippedBy"], message: "a skip names the person who chose it" });
  if (review.waiting !== undefined && review.status !== "waiting_answers" && review.waiting.revision === undefined) context.addIssue({ code: "custom", path: ["waiting"], message: "only a wait for answers has a wait record without a revision" });
});
export type WorkflowDesignReview = z.infer<typeof WorkflowDesignReviewSchema>;

/** What the task page reads (full reads, Rovara Code version 2 only). The same shape: nothing in it is secret, and every model word is shown as inert text. */
export const DesignReviewViewSchema = WorkflowDesignReviewSchema;
export type DesignReviewView = WorkflowDesignReview;

/** A playbook with no setting runs the owner's defaults. */
export function designReviewSettingOf(playbook: { designReview?: DesignReviewSetting | undefined }): DesignReviewSetting {
  return playbook.designReview ?? DESIGN_REVIEW_DEFAULT_SETTING;
}

/**
 * The identity of one reviewer's finding: a hash of its section and its text with case, spacing and punctuation taken out.
 */
function rawFindingFingerprint(section: string, text: string): string {
  return sha256Hex(JSON.stringify([section, normalizedFindingText(text)]));
}

/**
 * The reviewers' fingerprints behind a finding, sorted and each once. They come from the raw findings (the reviewers' own words, grouped by the merge step), and from the finding's own
 * section and text only when it has no raw findings (a finding Rovara adds, or one stored before raw findings were kept). The merge model's wording is never a source.
 */
export function designRawFingerprints(finding: { section: string; text: string; rawFindings?: readonly { text: string }[] | undefined }): string[] {
  const raw = finding.rawFindings ?? [];
  const prints = raw.length === 0 ? [rawFindingFingerprint(finding.section, finding.text)] : raw.map((entry) => rawFindingFingerprint(finding.section, entry.text));
  return [...new Set(prints)].sort();
}

/**
 * The identity of a finding across rounds and in the merge step's exact-duplicate check (M4). Code computes it from the reviewers' raw findings: one raw finding gives that finding's own
 * fingerprint (section + normalised words); a group gives a hash of the sorted set of its members' fingerprints. A model can neither hide a new finding behind an old fingerprint (adding
 * the new raw finding to the group changes the set) nor choose the words the identity is taken from (the merge text is display only).
 * Interface for the carry-over of settled resolutions: equality of this value means the same set of raw findings; `designFindingCoveredBy` is the "every new raw finding was in the earlier
 * one" test; the carry-over adds its own checks (severity, role) on top.
 */
export function designFindingFingerprint(finding: { section: string; text: string; rawFindings?: readonly { text: string }[] | undefined }): string {
  const prints = designRawFingerprints(finding);
  return prints.length === 1 ? prints[0]! : sha256Hex(JSON.stringify(["group", prints]));
}

/** True when every raw finding of `next` was already a raw finding of `earlier` (same section and words): nothing new is hidden in `next`. */
export function designFindingCoveredBy(next: { section: string; text: string; rawFindings?: readonly { text: string }[] | undefined }, earlier: { section: string; text: string; rawFindings?: readonly { text: string }[] | undefined }): boolean {
  const known = new Set(designRawFingerprints(earlier));
  return designRawFingerprints(next).every((print) => known.has(print));
}
