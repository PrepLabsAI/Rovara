// Track record (v1.2, slice 1): one sample is one confident claim in one round of one task, scored later against what happened. Ids, enums and timestamps only: no code,
// no model text, no secrets. A sample is kept per org, project and stage (`OUTCOME#`), and a copy is written under its score time (`OUTCOME_SCORED#`) so the rate reads
// exactly the last 30 days by when a sample was scored, not by when it was made (a long-lived pull request is scored long after it was created).
import { z } from "zod";

export const OUTCOME_CLAIMS = ["plan_ready", "review_pass:CRITIC", "review_pass:SECURITY", "proves_change", "risk_low"] as const;
export const OutcomeClaimSchema = z.enum(OUTCOME_CLAIMS);
export type OutcomeClaim = z.infer<typeof OutcomeClaimSchema>;

/** pending: not known yet. held / not_held: the outcome matched / contradicted the claim. closed_unmerged: the PR closed without merging. no_outcome: nothing to score against. */
export const OUTCOME_STATES = ["pending", "held", "not_held", "closed_unmerged", "no_outcome"] as const;
export const OutcomeStateSchema = z.enum(OUTCOME_STATES);
export type OutcomeState = z.infer<typeof OutcomeStateSchema>;

/** Fixed codes for why a sample ended as it did; never free text. */
export const OUTCOME_REASONS = [
  "plan_approved", "plan_skipped", "plan_changes_requested", "plan_rejected",
  "merged_no_changes_requested", "merged_without_person_review", "changes_requested_by_person", "feedback_round_approved",
  "ci_passing", "ci_failing", "ci_none", "ci_pending", "proof_unavailable",
  "closed_unmerged", "task_closed", "superseded",
  // `code_host_unavailable`: the pull request could not be read from its code host (any host). `github_unavailable` is the word earlier versions wrote for the same thing; it is still read, never written.
  "code_host_unavailable", "github_unavailable",
] as const;
export const OutcomeReasonSchema = z.enum(OUTCOME_REASONS);
export type OutcomeReason = z.infer<typeof OutcomeReasonSchema>;

/** The stage a claim is kept under: the recipe step the claim is about (`risk` is no step: it is recorded for the task owner's private view only). */
export const OUTCOME_STAGES = ["plan_critic", "review", "check", "risk"] as const;
export const OutcomeStageSchema = z.enum(OUTCOME_STAGES);
export type OutcomeStage = z.infer<typeof OutcomeStageSchema>;

export function outcomeStageOf(claim: OutcomeClaim): OutcomeStage {
  return claim === "plan_ready" ? "plan_critic" : claim === "proves_change" ? "check" : claim === "risk_low" ? "risk" : "review";
}

/** The rate counts samples scored in this many days. */
export const OUTCOME_WINDOW_DAYS = 30;
/** Below this many held plus not held, the card says "Not enough history yet". */
export const OUTCOME_ENOUGH_SAMPLES = 10;
/** A rate reads at most this many items of one stage (the newest by score time); past it the rate is "based on the latest 2000". */
export const OUTCOME_READ_CAP = 2000;
/** One page of the rate's read. */
export const OUTCOME_READ_PAGE = 500;
/** A scored sample and its copy are kept this many days after `scoredAt`. */
export const OUTCOME_SCORED_KEPT_DAYS = 180;
/** A sample not yet scored is kept this many days after `createdAt`, so one that is never scored still goes away. */
export const OUTCOME_PENDING_KEPT_DAYS = 365;

const Segment = z.string().min(1).max(200).regex(/^[^#\p{Cc}\p{Cf}]+$/u);

export const OutcomeSampleKeySchema = z.object({ pk: z.string().min(1).max(512), sk: z.string().min(1).max(512) }).strict();
export type OutcomeSampleKey = z.infer<typeof OutcomeSampleKeySchema>;

export const OutcomePullRequestSchema = z.object({
  repositoryId: z.string().min(1).max(200),
  number: z.number().int().positive(),
  mergeCommit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  mergedAt: z.string().datetime().optional(),
}).strict();
export type OutcomePullRequest = z.infer<typeof OutcomePullRequestSchema>;

/** One sample as the writer gives it (`recordOutcomeSample`). The keys, the entity type and the expiry are added by the store. */
export const OutcomeSampleSchema = z.object({
  orgId: z.string().regex(/^org_[0-9a-z]{20}$/),
  project: Segment,
  stage: OutcomeStageSchema,
  taskId: Segment,
  claim: OutcomeClaimSchema,
  /** `workflowRevision` for a plan, the first 16 characters of the candidate digest for a review, proof or risk claim. */
  round: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  state: OutcomeStateSchema,
  reason: OutcomeReasonSchema.optional(),
  unreviewedMerge: z.literal(true).optional(),
  pr: OutcomePullRequestSchema.optional(),
  agent: z.object({ id: z.string().min(1).max(100), version: z.string().min(1).max(40), digest: z.string().min(1).max(100) }).strict(),
  model: z.string().min(1).max(300),
  createdAt: z.string().datetime(),
  scoredAt: z.string().datetime().optional(),
}).strict().superRefine((sample, context) => {
  if (outcomeStageOf(sample.claim) !== sample.stage) context.addIssue({ code: "custom", path: ["stage"], message: "the stage is the one the claim is kept under" });
  if ((sample.state === "pending") !== (sample.scoredAt === undefined)) context.addIssue({ code: "custom", path: ["scoredAt"], message: "a sample has a score time exactly when it is scored" });
});
export type OutcomeSample = z.infer<typeof OutcomeSampleSchema>;

/** What a score changes on a pending sample. */
export const OutcomeScoreSchema = z.object({
  state: OutcomeStateSchema.exclude(["pending"]),
  reason: OutcomeReasonSchema,
  scoredAt: z.string().datetime(),
  unreviewedMerge: z.literal(true).optional(),
  pr: OutcomePullRequestSchema.optional(),
}).strict();
export type OutcomeScore = z.infer<typeof OutcomeScoreSchema>;

/** What the card reads: counts only. The rate is held ÷ (held + notHeld). */
export interface OutcomeRate {
  held: number;
  notHeld: number;
  closedUnmerged: number;
  noOutcome: number;
  /** Held samples that were merged with no review by a person (already counted in `held`). */
  unreviewedMerges: number;
  /** More than `OUTCOME_READ_CAP` items were scored in the window: the figures are for the newest ones. */
  capped: boolean;
  enough: boolean;
}
