// Design review stage, DR6 (designs-2026-10-30/design-review-stage.md 3.2, 3.5, 3.7, 3.13): the workflow's moves while a design is reviewed by fresh-context reviewers.
//
// The design review runs in the existing plan-check stage (PLAN_CRITIQUE) on the DESIGN document of a Full task, with a `designReview` record beside `critique` on the snapshot:
//
//   enableDesignReview            PLAN/READY (no design yet)  ->  same place, path FULL, review "estimating" (cap stored)
//                                 or a Quick plan's PLAN_REVIEW/WAITING card, by a person ("Design first")  ->  PLAN/READY on the Full path
//   submitWorkflowArtifact        a design document           ->  PLAN_CRITIQUE/READY            (task-workflow-node.ts: `planCritiqued`)
//   holdDesignReviewForCost       PLAN_CRITIQUE/READY         ->  PLAN_CRITIQUE/WAITING          "waiting_cost": a person decides the spend
//   startDesignReview             READY (or WAITING, approved) ->  PLAN_CRITIQUE/RUNNING         "running"; refuses without room under the stored cap
//   retryDesignReview             RUNNING                     ->  PLAN_CRITIQUE/READY            the model could not be used; try the next
//   raiseDesignReviewCap /        waiting_cost, a cap stop, or not run ->  READY "estimating"     a person raises the cap or picks a lower tier (recorded)
//   lowerDesignReviewTier
//   retryDesignReviewNotRun       PLAN_REVIEW/WAITING, not run ->  PLAN_CRITIQUE/READY "estimating" a person's one-tap Retry review (bounded)
//   resumeBlockedDesignReview     BLOCKED in PLAN_CRITIQUE / PLAN -> READY (or WAITING for answers)  the plan check's Retry, for the design review
//   submitDesignReview            RUNNING                     ->  PLAN/READY "resolving"         the planner resolves each finding
//                                                              or PLAN_REVIEW/WAITING            nothing left to resolve, cap reached, or no reviewer gave a result
//   askDesignQuestions            PLAN/RUNNING "resolving"    ->  PLAN/WAITING "waiting_answers" one card, at most 3 questions
//   answerDesignQuestions         PLAN/WAITING (parked or not) ->  PLAN/READY "resolving"
//   parkDesignReview              PLAN/WAITING, 7 days        ->  same place, parked           (3.7; nothing spends, nothing is approved)
//   resumeParkedDesignReview      parked                      ->  same place, waiting again    the clock starts over
//   closeParkedDesignReview       parked 30 days              ->  CLOSED/COMPLETE "not decided"
//   resolveDesignReview           PLAN/RUNNING "resolving"    ->  PLAN_CRITIQUE/READY "estimating" (round 2 of the revised design)
//                                                              or PLAN_REVIEW/WAITING "done"
//   skipDesignReview              the cost hold, or PLAN/READY before a design  ->  PLAN_REVIEW/WAITING (or the same place)  "not_run: skipped", decidedBy person_skip with who
//   closeDesignReview             any step (a BLOCKED one too) that is not waiting for a person's answer -> PLAN_REVIEW/WAITING (the approve_design card)
//
// Bounds: at most DESIGN_REVIEW_ROUNDS_MAX rounds and DESIGN_REVIEW_REVISIONS_MAX planner revisions, one question card per round with at most DESIGN_REVIEW_QUESTIONS_MAX questions.
// Nothing here approves anything: every path ends at PLAN_REVIEW/WAITING, where `decideWorkflow` needs a person. The reviewers' and the planner's words are untrusted data: they are
// parsed with the strict DR1 schemas, and code (never a model) decides the fingerprint of a finding, whether a resolution is settled, and where the workflow goes next.
import { z } from "zod";
import {
  DESIGN_DROPPED_FINDINGS_MAX, DESIGN_LOST_FINDING_ID_PREFIX, DESIGN_REVIEW_APPROVALS_MAX, DESIGN_REVIEW_CAP_MAX_USD, DESIGN_REVIEW_FINDINGS_MAX, DESIGN_REVIEW_CAP_MIN_USD, DESIGN_REVIEW_CLOSE_AFTER_PARKED_MS, DESIGN_REVIEW_NOT_RUN_REASONS, DESIGN_REVIEW_PARK_AFTER_MS, DESIGN_REVIEW_QUESTIONS_MAX,
  DESIGN_REVIEW_RETRIES_MAX, DESIGN_REVIEW_REVISIONS_MAX, DESIGN_REVIEW_ROUNDS_MAX, DESIGN_REVIEW_TIERS, DESIGN_REASONS_MAX, DESIGN_NOTE_MAX, DesignAnswerSchema, DesignFindingSchema,
  DesignModelRefSchema, DesignQuestionSchema, designFindingFingerprint, DesignReasonSchema, DesignReviewActorSchema, DesignReviewRoundSchema, DesignReviewTierSchema, FindingResolutionSchema, ReviewerRunSchema,
  WorkflowDesignReviewSchema,
  type DesignFinding, type DesignReviewActor, type DesignReviewApproval, type DesignReviewRound, type DesignReviewTier, type FindingResolution, type ReviewerRun, type WorkflowDesignReview,
} from "./design-review.js";
import { addDesignUsd, designReviewCapRoom, designRoundHasResult, designRoundResolved, designReviewRevisionsUsed, designWaitOf, resolutionOf, type DesignWait } from "./design-review-state.js";
import { redactText } from "./redaction.js";
import { ActorIdSchema, WorkflowArtifactSchema } from "./task-workflow.js";
import { WorkflowSnapshotSchema, WorkflowTransitionError, type WorkflowArtifact, type WorkflowSnapshot } from "./task-workflow-node.js";

const fail = (message: string): WorkflowTransitionError => new WorkflowTransitionError(message);

/** What a person's free-text answer to a design question may hold. */
const DESIGN_ANSWER_TEXT_MAX = 500;
/** The most the stored review may weigh as JSON. A task's whole record is limited to 400 KB, and the review shares it with everything else; an over-large review is refused, not trimmed. */
export const DESIGN_REVIEW_RECORD_MAX_BYTES = 150_000;
const SETTLED_NOTE = "Settled in an earlier round; raised again.";
/** Why a task whose design nobody decided was closed (30 days parked, 3.7). Fixed text: no model words. */
export const DESIGN_NOT_DECIDED_MESSAGE = "Closed: nobody decided the design.";
const SEVERITY_RANK = { nit: 0, major: 1, blocker: 2 } as const;


// ---- shared guards

interface Located { current: WorkflowSnapshot; review: WorkflowDesignReview }

function parsed(input: unknown): WorkflowSnapshot {
  const snapshot = WorkflowSnapshotSchema.safeParse(input);
  if (!snapshot.success) throw fail("workflow snapshot is invalid");
  return snapshot.data;
}

/** The workflow at the design review: at the revision that was read, in the DESIGN phase of a Full task, at this stage and state, with the review in one of these statuses. */
function located(input: unknown, expectedRevision: number, where: { stage: WorkflowSnapshot["stage"]; states: readonly WorkflowSnapshot["state"][]; statuses: readonly WorkflowDesignReview["status"][] }): Located {
  const current = parsed(input);
  if (current.revision !== expectedRevision) throw fail("workflow revision is stale");
  const review = current.designReview;
  if (review === undefined || current.reviewPhase !== "DESIGN" || current.path !== "FULL" || current.stage !== where.stage || !where.states.includes(current.state) || !where.statuses.includes(review.status)) {
    throw fail("the workflow is not at that step of the design review");
  }
  return { current, review };
}

function moved(current: WorkflowSnapshot, next: { stage: WorkflowSnapshot["stage"]; state: WorkflowSnapshot["state"]; review: WorkflowDesignReview; artifacts?: WorkflowArtifact[]; now: string }): WorkflowSnapshot {
  const record = WorkflowDesignReviewSchema.safeParse(next.review);
  if (!record.success) throw fail("the design review record is invalid");
  // Spend only goes up, and the cap changes only through a person's recorded raise: no move may lower either.
  if (current.designReview !== undefined && (record.data.spentUsd < current.designReview.spentUsd
    || (current.designReview.capUsd !== undefined && (record.data.capUsd ?? 0) < current.designReview.capUsd))) throw fail("the design review's spend and cap never go down");
  const { blockReason: _blockReason, ...unblocked } = current;
  void _blockReason;
  return WorkflowSnapshotSchema.parse({
    ...unblocked, revision: current.revision + 1, stage: next.stage, state: next.state, designReview: record.data,
    ...(next.artifacts === undefined ? {} : { artifacts: next.artifacts }), updatedAt: next.now,
  });
}

const latestDesign = (workflow: WorkflowSnapshot): WorkflowArtifact | undefined => workflow.artifacts.filter((artifact) => artifact.type === "design").at(-1);
const lastRound = (review: WorkflowDesignReview): DesignReviewRound | undefined => review.rounds.at(-1);
const withLastRound = (review: WorkflowDesignReview, round: DesignReviewRound): DesignReviewRound[] => [...review.rounds.slice(0, -1), round];
const addUsd = addDesignUsd;

/** A spend delta a closing or retrying step adds for what its reviewers already cost (m1): finite and not negative, so the total only goes up. */
function spendDelta(value: number | undefined): number {
  const delta = value ?? 0;
  if (!Number.isFinite(delta) || delta < 0 || delta > 10_000) throw fail("the spend to add is invalid");
  return delta;
}

function actorOf(by: unknown): DesignReviewActor {
  const actor = DesignReviewActorSchema.safeParse(by);
  if (!actor.success || !ActorIdSchema.safeParse(actor.data.actorId).success) throw fail("the person is invalid");
  return actor.data;
}

function approvalsWith(review: WorkflowDesignReview, approval: DesignReviewApproval): DesignReviewApproval[] {
  const approvals = [...(review.approvals ?? []), approval];
  if (approvals.length > DESIGN_REVIEW_APPROVALS_MAX) throw fail("the design review has too many recorded approvals");
  return approvals;
}

// ---- switching it on

const StartSchema = z.object({
  decidedBy: z.enum(["auto", "always", "person"]),
  reasons: z.array(DesignReasonSchema).max(DESIGN_REASONS_MAX),
  note: z.string().min(1).max(DESIGN_NOTE_MAX).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must be plain text").optional(),
  tier: DesignReviewTierSchema,
  /** The cost cap for this task: the project setting's `capUsdPerTask`. Stored on the review and checked before every round. */
  capUsd: z.number().min(DESIGN_REVIEW_CAP_MIN_USD).max(DESIGN_REVIEW_CAP_MAX_USD),
  /** The person who pressed Design first (the broker authenticated them). Required when `decidedBy` is "person". */
  by: DesignReviewActorSchema.optional(),
}).strict().refine((start) => start.decidedBy !== "person" || start.by !== undefined, { message: "a person's decision names the person", path: ["by"] });
export type DesignReviewStart = z.input<typeof StartSchema>;

/**
 * Design review is ON for this task. The caller has already resolved the mode (the person's words, the project setting, Understand's reading); this records it and the cost cap, and it forces
 * the Full path (a task that was Quick becomes Full and starts at the requirements, as the person is told). Allowed in a version 2 workflow whose sequence has a plan check step (the design
 * review runs in that step), in two places:
 * - while the task is ready to plan (PLAN/READY), before any design or plan exists, in the requirements or design phase (or still Quick);
 * - Q4's one-tap "Design first" on a Quick plan's card (PLAN_REVIEW/WAITING): only a person (`decidedBy: "person"`, recorded with who), no design yet. The task goes back to PLAN/READY on the Full
 *   path at the requirements; the Quick plan stays on the task as history and its plan check is dropped. Nothing is approved by this.
 * With it OFF nothing changes anywhere: the snapshot has no `designReview`.
 */
export function enableDesignReview(currentInput: unknown, input: { expectedRevision: number; start: DesignReviewStart; now: string }): WorkflowSnapshot {
  const current = parsed(currentInput);
  if (current.revision !== input.expectedRevision) throw fail("workflow revision is stale");
  const start = StartSchema.safeParse(input.start);
  if (!start.success) throw fail("the design review start is invalid");
  if (current.designReview !== undefined) throw fail("design review is already on for this task");
  const fromQuickCard = current.stage === "PLAN_REVIEW" && current.state === "WAITING" && current.path === "QUICK" && current.reviewPhase === undefined;
  if (current.definitionVersion !== "1.1.0" || current.artifacts.some((artifact) => artifact.type === "design")) {
    throw fail("design review can be switched on only while the task is ready to plan, before any design exists");
  }
  if (fromQuickCard) {
    if (start.data.decidedBy !== "person" || !current.artifacts.some((artifact) => artifact.type === "plan")) throw fail("Design first on a Quick plan is a person's choice");
  } else {
    const phaseOk = current.path === "QUICK" || current.reviewPhase === "REQUIREMENTS" || current.reviewPhase === "DESIGN";
    if (current.stage !== "PLAN" || current.state !== "READY" || !phaseOk || current.artifacts.some((artifact) => artifact.type === "plan")) {
      throw fail("design review can be switched on only while the task is ready to plan, before any design exists");
    }
  }
  if (current.program?.steps.some((step) => step.kind === "plan_critic") !== true) throw fail("this sequence has no plan check step to review the design in");
  const intent = current.intent;
  const assessment = intent?.assessment?.kind === "ready" ? { ...intent.assessment, path: "FULL" as const } : intent?.assessment;
  const { by, ...recorded } = start.data;
  const review: WorkflowDesignReview = {
    ...recorded, ...(by === undefined ? {} : { startedBy: by }), ...(fromQuickCard ? { fromQuick: true as const } : {}), status: "estimating", spentUsd: 0, rounds: [],
  };
  const { critique: _quickCheck, ...withoutCheck } = current;
  void _quickCheck;
  return WorkflowSnapshotSchema.parse({
    ...(fromQuickCard ? withoutCheck : current), revision: current.revision + 1, path: "FULL", stage: "PLAN", state: "READY",
    reviewPhase: current.path === "FULL" ? current.reviewPhase : "REQUIREMENTS", designReview: review,
    ...(intent === undefined || assessment === undefined ? {} : { intent: { ...intent, assessment } }), updatedAt: input.now,
  });
}

// ---- before the reviewers run

/** The estimate is over the cap, or there is no price: a person decides the spend (the approve_spend card). Nothing runs until they do. */
export function holdDesignReviewForCost(currentInput: unknown, input: { expectedRevision: number; estimateUsd?: number; now: string }): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN_CRITIQUE", states: ["READY"], statuses: ["estimating"] });
  return moved(current, { stage: "PLAN_CRITIQUE", state: "WAITING", review: { ...review, status: "waiting_cost", ...(input.estimateUsd === undefined ? {} : { estimateUsd: input.estimateUsd }) }, now: input.now });
}

/**
 * B2-m6: a round that a person's approval of an UNPRICED run started from the cost hold is held again (the gate now finds an estimate over the cap, which an approval never lifts). The hold stays at PLAN_CRITIQUE/WAITING
 * "waiting_cost" but is recorded afresh, at a new revision and with the estimate the gate found: the approval named the old revision, so it is not carried over or used up in silence, the card shows the new figure, and a new
 * tap (a raise, a lower tier or a skip) is what goes on. It records no approval.
 */
export function reholdDesignReviewForCost(currentInput: unknown, input: { expectedRevision: number; estimateUsd?: number; now: string }): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN_CRITIQUE", states: ["WAITING"], statuses: ["waiting_cost"] });
  const { estimateUsd: _earlier, ...kept } = review;
  void _earlier;
  return moved(current, { stage: "PLAN_CRITIQUE", state: "WAITING", review: { ...kept, status: "waiting_cost", ...(input.estimateUsd === undefined ? {} : { estimateUsd: input.estimateUsd }) }, now: input.now });
}

/**
 * The reviewers start: from READY, or from the cost hold once a person approved the spend. Round 1 and round 2 start the same way. The cost cap stored on the review is checked HERE, before
 * any round, whoever calls:
 * - no cap on the record, or nothing left under it: refused;
 * - `estimateUsd` (what the round or rounds still to run are expected to cost; the stored estimate is used when none is given) is more than what is left under the cap: refused. A person
 *   raises the cap or picks a lower tier (`raiseDesignReviewCap`, `lowerDesignReviewTier`); an approval of the spend never lifts the cap;
 * - no price known: a person's one tap is needed (`costApproved`, who approved it is recorded), and the cap still holds.
 * From the cost hold `costApproved` is always needed.
 */
export function startDesignReview(
  currentInput: unknown,
  input: { expectedRevision: number; estimateUsd?: number; costApproved?: { by: { actorId: string }; approvedUsd?: number }; now: string },
): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN_CRITIQUE", states: ["READY", "WAITING"], statuses: ["estimating", "waiting_cost"] });
  if ((review.status === "estimating") !== (current.state === "READY")) throw fail("the workflow is not at that step of the design review");
  if (review.rounds.length >= DESIGN_REVIEW_ROUNDS_MAX) throw fail("the design review has used its rounds");
  if (input.estimateUsd !== undefined && (!Number.isFinite(input.estimateUsd) || input.estimateUsd < 0 || input.estimateUsd > 10_000)) throw fail("the estimate is invalid");
  const room = designReviewCapRoom(review, input.estimateUsd);
  if (room.kind === "no_cap") throw fail("the design review has no cost cap recorded");
  if (room.kind === "at_cap") throw fail("the design review is at its cost cap");
  if (room.kind === "over_cap") throw fail("the estimate is over the cost cap: a person raises the cap or picks a lower tier");
  const approval = input.costApproved === undefined ? undefined : { by: actorOf(input.costApproved.by), approvedUsd: input.costApproved.approvedUsd };
  if (approval?.approvedUsd !== undefined && (!Number.isFinite(approval.approvedUsd) || approval.approvedUsd < 0 || approval.approvedUsd > 10_000)) throw fail("the approved spend is invalid");
  if ((review.status === "waiting_cost" || room.kind === "no_price") && approval === undefined) throw fail(review.status === "waiting_cost" ? "the design review is waiting for the spend to be approved" : "there is no price: a person approves the spend first");
  const estimate = input.estimateUsd ?? review.estimateUsd;
  if (approval?.approvedUsd !== undefined && estimate !== undefined && estimate > approval.approvedUsd + 1e-9) throw fail("the approved spend is less than the estimate");
  const { notRunReason: _reason, ...kept } = review;
  void _reason;
  const approvals = approval === undefined ? review.approvals : approvalsWith(review, { kind: "spend", by: approval.by, at: input.now, ...(approval.approvedUsd === undefined ? {} : { approvedUsd: approval.approvedUsd }) });
  return moved(current, {
    stage: "PLAN_CRITIQUE", state: "RUNNING",
    review: { ...kept, status: "running", ...(input.estimateUsd === undefined ? {} : { estimateUsd: input.estimateUsd }), ...(approvals === undefined ? {} : { approvals }) }, now: input.now,
  });
}

/**
 * The reviewers' model could not be used (the account has no access to it): the same round is tried again on the next model. The caller bounds the attempts; this only moves the workflow.
 * `addedSpendUsd` is what the reviewers of the failed attempt already cost (a lost run still spent it): it is added to the total, which only goes up.
 */
export function retryDesignReview(currentInput: unknown, input: { expectedRevision: number; addedSpendUsd?: number; now: string }): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN_CRITIQUE", states: ["RUNNING"], statuses: ["running"] });
  return moved(current, { stage: "PLAN_CRITIQUE", state: "READY", review: { ...review, status: "estimating", spentUsd: addUsd(review.spentUsd, spendDelta(input.addedSpendUsd)) }, now: input.now });
}

// ---- a person changes the cap or the tier, or asks to review again

/** The last round that gave no reviewer a result is dropped when a review is tried again (it only holds the failure; its cost stays in the total). Rounds that remain must all be resolved. */
function roundsToKeep(review: WorkflowDesignReview): DesignReviewRound[] | undefined {
  const last = review.rounds.at(-1);
  const kept = last !== undefined && !designRoundHasResult(last) ? review.rounds.slice(0, -1) : review.rounds;
  return kept.length < DESIGN_REVIEW_ROUNDS_MAX && kept.every(designRoundResolved) ? kept : undefined;
}

/**
 * Where a review that stopped short can be reviewed again, and what it becomes:
 * - the cost hold (PLAN_CRITIQUE/WAITING) -> PLAN_CRITIQUE/READY;
 * - a re-armed review waiting for its next design (PLAN/READY, no round, stopped or not run) -> PLAN/READY, awaiting that design;
 * - the design on the person's card (PLAN_REVIEW/WAITING) whose earlier rounds are all resolved, with a design to review -> PLAN_CRITIQUE/READY.
 * Anything else (a review in progress, one with unresolved findings, one with its rounds used) is refused.
 */
function reopened(current: WorkflowSnapshot, review: WorkflowDesignReview, change: Partial<WorkflowDesignReview>, now: string): WorkflowSnapshot {
  // A person's Skip stands: a raised cap, a lower tier or a retry does not bring the review back (m7).
  if (review.decidedBy === "person_skip") throw fail("the design review was skipped by a person");
  const { estimateUsd: _estimate, notRunReason: _reason, ...kept } = review;
  void _estimate;
  void _reason;
  const reset = { ...kept, ...change, status: "estimating" as const };
  if (current.stage === "PLAN_CRITIQUE" && current.state === "WAITING" && review.status === "waiting_cost") return moved(current, { stage: "PLAN_CRITIQUE", state: "READY", review: reset, now });
  if (current.stage === "PLAN" && current.state === "READY" && review.rounds.length === 0 && (review.status === "stopped_at_cap" || review.status === "not_run")) {
    return moved(current, { stage: "PLAN", state: "READY", review: reset, now });
  }
  if (current.stage === "PLAN_REVIEW" && current.state === "WAITING" && (review.status === "stopped_at_cap" || review.status === "not_run" || (review.status === "done" && review.notRunReason !== undefined))) {
    const rounds = roundsToKeep(review);
    if (rounds === undefined || latestDesign(current) === undefined) throw fail("the design review cannot be run again from here");
    // Paying again to read the design the last round already read, with a result, buys nothing (money N9): a changed design is needed.
    const lastRead = rounds.at(-1);
    if (lastRead !== undefined && designRoundHasResult(lastRead) && lastRead.designDigest === latestDesign(current)!.sha256) throw fail("the design is the one the last round already reviewed");
    return moved(current, { stage: "PLAN_CRITIQUE", state: "READY", review: { ...reset, rounds }, now });
  }
  throw fail("the design review cannot be run again from here");
}

/**
 * A person raises the cost cap for this task (the approve_spend card's "raise the cap", or after a cost stop). The new cap must be higher and inside the limits; who raised it is recorded.
 * Re-reviews and retries start counting again. The review goes back to "estimating" and the cap check runs again when it starts.
 */
export function raiseDesignReviewCap(currentInput: unknown, input: { expectedRevision: number; capUsd: number; by: { actorId: string }; estimateUsd?: number; now: string }): WorkflowSnapshot {
  const current = parsed(currentInput);
  if (current.revision !== input.expectedRevision) throw fail("workflow revision is stale");
  const review = current.designReview;
  if (review === undefined || current.reviewPhase !== "DESIGN" || review.capUsd === undefined) throw fail("the workflow is not at that step of the design review");
  const cap = z.number().min(DESIGN_REVIEW_CAP_MIN_USD).max(DESIGN_REVIEW_CAP_MAX_USD).safeParse(input.capUsd);
  if (!cap.success || cap.data <= review.capUsd) throw fail("the new cap must be higher than the current one, inside the limits");
  const by = actorOf(input.by);
  return reopened(current, review, {
    capUsd: cap.data, rearms: 0, retries: 0, approvals: approvalsWith(review, { kind: "raise_cap", by, at: input.now, fromUsd: review.capUsd, capUsd: cap.data }),
    ...(input.estimateUsd === undefined ? {} : { estimateUsd: input.estimateUsd }),
  }, input.now);
}

/** A person picks a lower tier (fewer reviewers) so the estimate fits (the approve_spend card's "run at the next lower tier"); who chose it is recorded. `estimateUsd` is the new, lower estimate. */
export function lowerDesignReviewTier(currentInput: unknown, input: { expectedRevision: number; tier: DesignReviewTier; by: { actorId: string }; estimateUsd?: number; now: string }): WorkflowSnapshot {
  const current = parsed(currentInput);
  if (current.revision !== input.expectedRevision) throw fail("workflow revision is stale");
  const review = current.designReview;
  if (review === undefined || current.reviewPhase !== "DESIGN") throw fail("the workflow is not at that step of the design review");
  const tier = DesignReviewTierSchema.safeParse(input.tier);
  if (!tier.success || DESIGN_REVIEW_TIERS.indexOf(tier.data) >= DESIGN_REVIEW_TIERS.indexOf(review.tier)) throw fail("the new tier must be lower than the current one");
  const by = actorOf(input.by);
  return reopened(current, review, {
    tier: tier.data, rearms: 0, retries: 0, approvals: approvalsWith(review, { kind: "lower_tier", by, at: input.now, from: review.tier, tier: tier.data }),
    ...(input.estimateUsd === undefined ? {} : { estimateUsd: input.estimateUsd }),
  }, input.now);
}

/**
 * "Retry review" (3.13), the one tap after a review that did not run (`not_run`, or `done` with the reason set for a later round): the design was fine, the review failed, so the same design is reviewed
 * again and the planner is not asked to redo it. At most DESIGN_REVIEW_RETRIES_MAX times; after that a person raises the cap or picks a lower tier. What the failed attempt cost stays counted and the
 * cap check runs again when it starts. A review that stopped at the cap, or hit the re-review limit, is not retried: those need a raised cap or a lower tier.
 */
export function retryDesignReviewNotRun(currentInput: unknown, input: { expectedRevision: number; by: { actorId: string }; estimateUsd?: number; now: string }): WorkflowSnapshot {
  const current = parsed(currentInput);
  if (current.revision !== input.expectedRevision) throw fail("workflow revision is stale");
  const review = current.designReview;
  if (review === undefined || !notRunRetryable(current, review)) throw fail("only a design review that did not run can be retried");
  actorOf(input.by);
  if ((review.retries ?? 0) >= DESIGN_REVIEW_RETRIES_MAX) throw fail("the review has been retried as often as allowed: a person raises the cap or picks a lower tier");
  return reopened(current, review, { retries: (review.retries ?? 0) + 1, ...(input.estimateUsd === undefined ? {} : { estimateUsd: input.estimateUsd }) }, input.now);
}

/** The state `retryDesignReviewNotRun` accepts: a review that did not run (not one a person skipped, and not the re-review limit), with the design on the person's card. */
function notRunRetryable(current: WorkflowSnapshot, review: WorkflowDesignReview): boolean {
  return current.reviewPhase === "DESIGN" && current.path === "FULL" && current.stage === "PLAN_REVIEW" && current.state === "WAITING"
    && review.notRunReason !== undefined && review.notRunReason !== "rearm_limit" && review.notRunReason !== "skipped" && review.decidedBy !== "person_skip" && (review.status === "not_run" || review.status === "done");
}

/**
 * The "Retry review" offer for the task page, by the SAME rule as `retryDesignReviewNotRun` (the route re-checks it on every press): undefined when the review is not one that did not run (a skip, the re-review
 * limit, a cap stop, a review that ran or is running); otherwise whether a retry is left and how many.
 */
export function designReviewRetryOffer(currentInput: unknown): { allowed: boolean; retriesLeft: number } | undefined {
  const current = WorkflowSnapshotSchema.safeParse(currentInput);
  const review = current.success ? current.data.designReview : undefined;
  if (!current.success || review === undefined || !notRunRetryable(current.data, review)) return undefined;
  const retriesLeft = Math.max(0, DESIGN_REVIEW_RETRIES_MAX - (review.retries ?? 0));
  return { allowed: retriesLeft > 0, retriesLeft };
}

// ---- a person skips

/**
 * A person chose Skip on the spend card (the cost hold, or the cost question before a design exists). Records `decidedBy: "person_skip"` with who (`skippedBy`), the fixed reason `skipped`, and ends the review without
 * running it: from the cost hold (PLAN_CRITIQUE/WAITING, "waiting_cost") the design goes to the person's card (PLAN_REVIEW/WAITING; "not run" before any round, "done" after one); from PLAN/READY, before a
 * design exists, the task goes on to its design with the review off. Nothing here approves anything. The skip stands: `retryDesignReviewNotRun`, a raised cap and a lower tier refuse it, and a REQUEST_CHANGES
 * does not re-arm it (`rearmedDesignReview`). The caller (the spend handler) has already applied the skip rules for this person.
 */
export function skipDesignReview(currentInput: unknown, input: { expectedRevision: number; by: { actorId: string }; now: string }): WorkflowSnapshot {
  const current = parsed(currentInput);
  if (current.revision !== input.expectedRevision) throw fail("workflow revision is stale");
  const review = current.designReview;
  const atCostHold = current.reviewPhase === "DESIGN" && current.stage === "PLAN_CRITIQUE" && current.state === "WAITING" && review?.status === "waiting_cost";
  const beforeDesign = current.stage === "PLAN" && current.state === "READY" && review?.status === "estimating" && review.rounds.length === 0 && latestDesign(current) === undefined;
  if (review === undefined || current.path !== "FULL" || (!atCostHold && !beforeDesign)) throw fail("the design review cannot be skipped from here");
  const by = actorOf(input.by);
  const { estimateUsd: _estimate, waiting: _waiting, ...kept } = review;
  void _estimate;
  void _waiting;
  const skipped: WorkflowDesignReview = { ...kept, decidedBy: "person_skip", skippedBy: by, status: review.rounds.length > 0 ? "done" : "not_run", notRunReason: "skipped" };
  return atCostHold ? moved(current, { stage: "PLAN_REVIEW", state: "WAITING", review: skipped, now: input.now }) : moved(current, { stage: "PLAN", state: "READY", review: skipped, now: input.now });
}

// ---- after BLOCKED

/**
 * The plan check's Retry for a design review that BLOCKED (a rule file that could not be verified, a leftover process, a planner run that failed or ran out of budget): BLOCKED goes back to
 * READY (WAITING when it was waiting for answers) and the block's reason is cleared. A review in the plan check step is "estimating" again, so the cost cap is checked when it starts; one in the
 * planner's step keeps "resolving". Spend is kept. Nothing is approved. (`closeDesignReview` also ends a blocked review.)
 */
export function resumeBlockedDesignReview(currentInput: unknown, input: { expectedRevision: number; addedSpendUsd?: number; now: string }): WorkflowSnapshot {
  const current = parsed(currentInput);
  if (current.revision !== input.expectedRevision) throw fail("workflow revision is stale");
  const found = current.designReview;
  if (found === undefined || current.reviewPhase !== "DESIGN" || current.path !== "FULL" || current.state !== "BLOCKED") throw fail("the design review is not blocked");
  // What the reviewers of a round that blocked while running already cost is added, as close and retry do; the total only goes up (money N6).
  const review: WorkflowDesignReview = { ...found, spentUsd: addUsd(found.spentUsd, spendDelta(input.addedSpendUsd)) };
  if (current.stage === "PLAN_CRITIQUE" && (review.status === "estimating" || review.status === "running" || review.status === "waiting_cost")) {
    return moved(current, { stage: "PLAN_CRITIQUE", state: "READY", review: { ...review, status: "estimating" }, now: input.now });
  }
  if (current.stage === "PLAN" && review.status === "resolving") return moved(current, { stage: "PLAN", state: "READY", review, now: input.now });
  if (current.stage === "PLAN" && review.status === "waiting_answers") return moved(current, { stage: "PLAN", state: "WAITING", review, now: input.now });
  if (current.stage === "PLAN" && review.status === "estimating" && review.rounds.length === 0) return moved(current, { stage: "PLAN", state: "READY", review, now: input.now });
  throw fail("the design review is not blocked");
}

// ---- a round's result

type NotRunReason = (typeof DESIGN_REVIEW_NOT_RUN_REASONS)[number];

/** Why no reviewer gave a result: an integrity failure outranks a timeout, which outranks a worker that failed. */
function whyNoResult(runs: readonly ReviewerRun[]): NotRunReason {
  if (runs.some((run) => run.verifyFailure !== undefined && run.verifyFailure !== "timeout" && run.verifyFailure !== "unreadable_output")) return "inputs_unverified";
  if (runs.some((run) => run.verifyFailure === "timeout")) return "timeout";
  return "worker_failed";
}

function sizeChecked(review: WorkflowDesignReview): WorkflowDesignReview {
  if (new TextEncoder().encode(JSON.stringify(review)).length > DESIGN_REVIEW_RECORD_MAX_BYTES) throw fail("the design review record is too large to keep");
  return review;
}

/**
 * One round's result: the reviewers' runs (with whether each was verified fresh and read-only), the merged findings, and what the round spent. Only verified reviewers count: a finding
 * from any other is refused. Where it goes next:
 * - no reviewer gave a result: the person decides (PLAN_REVIEW). The first round is `not_run` with the reason; a later round leaves the review `done` with `notRunReason` set;
 * - the cost cap was reached (`stoppedAtCap`, or the round took the total past the cap stored on the review): `stopped_at_cap`, the findings go to the person unresolved;
 * - no findings, or the loop ended early (a finding of round 2 would undo an earlier fix: `undoesEarlierFix`): `done`, the person decides;
 * - otherwise the planner resolves each finding (PLAN/READY, "resolving"). A finding that an earlier round's contest or decline already settled stays settled (it is carried over, and the
 *   planner is not asked about it again) only when the new finding is no more severe than the one that was settled and the same resolution would be allowed for it (a comprehension finding is never
 *   settled by a contest, a blocker never by a decline or by a lesser finding's resolution); anything else is open for the planner. If nothing is left for the planner, the review is `done`.
 * - two findings of one round may not share a fingerprint (the merge step dedupes exact duplicates), and an oscillation names the round-1 finding it undoes, which must have been fixed.
 */
export function submitDesignReview(
  currentInput: unknown,
  input: {
    expectedRevision: number; designDigest: string; reviewers: readonly unknown[]; findings: readonly unknown[]; mergeModel?: unknown; mergeCostUsd?: number;
    undoesEarlierFix?: readonly { findingId: string; earlierFindingId: string }[]; stoppedAtCap?: true; droppedFindings?: readonly unknown[]; unreadableFindings?: number; now: string;
  },
): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN_CRITIQUE", states: ["RUNNING"], statuses: ["running"] });
  if (review.rounds.length >= DESIGN_REVIEW_ROUNDS_MAX) throw fail("the design review has used its rounds");
  const design = latestDesign(current);
  if (design === undefined || design.sha256 !== input.designDigest) throw fail("the reviewers did not read the current design");
  if (review.capUsd === undefined) throw fail("the design review has no cost cap recorded");
  const roundNumber = (review.rounds.length + 1) as 1 | 2;

  const runs = z.array(ReviewerRunSchema).safeParse(input.reviewers);
  const found = z.array(DesignFindingSchema).safeParse(input.findings);
  const mergeModel = input.mergeModel === undefined ? undefined : DesignModelRefSchema.safeParse(input.mergeModel);
  if (!runs.success || !found.success || (mergeModel !== undefined && !mergeModel.success)) throw fail("the design review result is invalid");
  if (new Set(runs.data.map((run) => run.role)).size !== runs.data.length) throw fail("a reviewer role ran twice in one round");
  const mergeCost = input.mergeCostUsd ?? 0;
  if (!Number.isFinite(mergeCost) || mergeCost < 0 || mergeCost > 10_000) throw fail("the design review result is invalid");

  const verifiedRoles = new Set(runs.data.filter((run) => run.verified).map((run) => run.role));
  const ids = new Set<string>();
  const rawIds = new Set<string>();
  const findings: DesignFinding[] = found.data.map((finding) => {
    if (ids.has(finding.id)) throw fail("two findings share an id");
    ids.add(finding.id);
    for (const raw of finding.rawIds) {
      if (rawIds.has(raw)) throw fail("a reviewer's finding was merged into two findings");
      rawIds.add(raw);
    }
    if (finding.fromReviewers.some((role) => !verifiedRoles.has(role))) throw fail("a finding came from a reviewer whose result does not count");
    return { ...finding, fingerprint: designFindingFingerprint(finding) };
  });
  if (new Set(findings.map((finding) => finding.fingerprint)).size !== findings.length) throw fail("two findings of one round share a fingerprint: the merge step dedupes exact duplicates");
  // An oscillation names the finding of this round that would undo an earlier fix AND the round-1 finding it undoes; that one must have been fixed.
  const undoes = z.array(z.object({ findingId: z.string().min(1).max(64), earlierFindingId: z.string().min(1).max(64) }).strict()).max(DESIGN_REVIEW_FINDINGS_MAX).safeParse(input.undoesEarlierFix ?? []);
  if (!undoes.success) throw fail("the finding that undoes an earlier fix is invalid");
  const roundOne = review.rounds[0];
  if (undoes.data.length > 0 && (roundNumber === 1 || roundOne === undefined
    || undoes.data.some((link) => !ids.has(link.findingId) || !roundOne.findings.some((candidate) => candidate.id === link.earlierFindingId) || resolutionOf(roundOne, link.earlierFindingId)?.action !== "fixed"))) {
    throw fail("only a finding of a later round can undo an earlier fix, and that fix must be one round 1 made");
  }
  const oscillation = [...new Set(undoes.data.map((link) => link.findingId))];
  // A contest or a decline from an earlier round stays settled when the same finding comes back (by fingerprint), if the new finding is no more severe than the settled one and the same
  // resolution would be allowed for it now. A nit's decline never settles a blocker; a contest never settles a comprehension finding.
  const carried: FindingResolution[] = [];
  for (const finding of findings) {
    for (const earlier of review.rounds) {
      const before = earlier.findings.find((candidate) => candidate.fingerprint === finding.fingerprint);
      const resolution = before === undefined ? undefined : resolutionOf(earlier, before.id);
      if (before === undefined || resolution === undefined || !resolution.settled || (resolution.action !== "contested" && resolution.action !== "declined")) continue;
      if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[before.severity]) continue;
      const settledAgain: FindingResolution = { findingId: finding.id, action: resolution.action, ...(resolution.evidence === undefined ? {} : { evidence: resolution.evidence }), note: SETTLED_NOTE, settled: true };
      if (resolutionProblem(settledAgain, finding, earlier, false) !== undefined) continue;
      carried.push(settledAgain);
      break;
    }
  }

  const round = DesignReviewRoundSchema.safeParse({
    round: roundNumber, designDigest: input.designDigest, reviewers: runs.data, findings, resolutions: carried,
    ...(oscillation.length === 0 ? {} : { oscillation }), ...(mergeModel?.success === true ? { mergeModel: mergeModel.data } : {}),
    ...((input.droppedFindings ?? []).length === 0 ? {} : { droppedFindings: input.droppedFindings }),
    ...(input.unreadableFindings === undefined || input.unreadableFindings <= 0 ? {} : { unreadableFindings: Math.min(input.unreadableFindings, DESIGN_DROPPED_FINDINGS_MAX) }),
    // The review's estimate at this round's start is kept on the round: the review's own is cleared when the round resolves.
    ...(review.estimateUsd === undefined ? {} : { estimateUsd: review.estimateUsd }),
  });
  if (!round.success) throw fail("the design review result is invalid");
  const spentUsd = addUsd(addUsd(review.spentUsd, runs.data.reduce((sum, run) => addUsd(sum, run.costUsd), 0)), mergeCost);
  const base: WorkflowDesignReview = { ...review, spentUsd, rounds: [...review.rounds, round.data] };
  const end = (status: WorkflowDesignReview["status"], extra: Partial<WorkflowDesignReview> = {}): WorkflowSnapshot =>
    moved(current, { stage: "PLAN_REVIEW", state: "WAITING", review: sizeChecked({ ...base, status, ...extra }), now: input.now });

  if (!designRoundHasResult(round.data)) {
    const reason = whyNoResult(runs.data);
    return review.rounds.length === 0 ? end("not_run", { notRunReason: reason }) : end("done", { notRunReason: reason });
  }
  // A round that found nothing is a finished review even when it took the total past the cap: there is nothing left to pay for, and "stopped at the cap" would let a raised cap buy the same read again (money N9).
  if (findings.length === 0) return end("done");
  if (input.stoppedAtCap === true || spentUsd > review.capUsd) return end("stopped_at_cap");
  if (oscillation.length > 0 || designRoundResolved(round.data)) return end("done");
  return moved(current, { stage: "PLAN", state: "READY", review: sizeChecked({ ...base, status: "resolving" }), now: input.now });
}

// ---- the planner's side

/**
 * The planner cannot resolve every finding without a person (it would otherwise guess): it asks. One question card per round, one to DESIGN_REVIEW_QUESTIONS_MAX questions. The workflow
 * waits (PLAN/WAITING, "waiting_answers") and nothing runs or spends until `answerDesignQuestions`. Nobody approves or answers for the person.
 */
export function askDesignQuestions(currentInput: unknown, input: { expectedRevision: number; questions: readonly unknown[]; now: string }): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN", states: ["RUNNING"], statuses: ["resolving"] });
  const round = lastRound(review);
  if (round === undefined || round.questions !== undefined) throw fail("a round asks one question card");
  if (review.rounds.length >= DESIGN_REVIEW_ROUNDS_MAX) throw fail("the last round does not ask: it is fixed or contested only");
  const questions = z.array(DesignQuestionSchema).min(1).max(DESIGN_REVIEW_QUESTIONS_MAX).safeParse(input.questions);
  if (!questions.success || new Set(questions.data.map((question) => question.id)).size !== questions.data.length) throw fail("the design questions are invalid");
  return moved(current, {
    stage: "PLAN", state: "WAITING", review: { ...review, status: "waiting_answers", waiting: { since: input.now }, rounds: withLastRound(review, { ...round, questions: questions.data }) }, now: input.now,
  });
}

function cleanText(text: string): string {
  return Array.from(redactText(text).replace(/\r\n?/gu, "\n").replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" ? "\n" : " ")).trim()).slice(0, DESIGN_ANSWER_TEXT_MAX).join("");
}

/**
 * A person answered the question card. Every question needs one answer (an option of that question, words, or both), the answers are cleaned (credentials redacted, control characters made
 * spaces) and kept with who gave them, and the planner runs again to resolve the findings (PLAN/READY). `by` is the person the broker authenticated and allowed (the requester, or the
 * high-risk approver for a high-risk question); nothing from the answer's own words says who they are.
 */
export function answerDesignQuestions(
  currentInput: unknown,
  input: { expectedRevision: number; answers: readonly unknown[]; by: { actorId: string }; now: string },
): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN", states: ["WAITING"], statuses: ["waiting_answers"] });
  const round = lastRound(review);
  const questions = round?.questions;
  if (round === undefined || questions === undefined || round.answers !== undefined) throw fail("the workflow is not waiting for answers");
  const actor = ActorIdSchema.safeParse(input.by.actorId);
  const answers = z.array(DesignAnswerSchema).safeParse(input.answers);
  if (!actor.success || !answers.success) throw fail("the design answers are invalid");
  const byId = new Map(questions.map((question) => [question.id, question]));
  if (answers.data.length !== byId.size || new Set(answers.data.map((answer) => answer.questionId)).size !== answers.data.length || answers.data.some((answer) => !byId.has(answer.questionId))) {
    throw fail("every question needs exactly one answer");
  }
  const cleaned = answers.data.map((answer) => {
    if (answer.optionId !== undefined && byId.get(answer.questionId)?.options.some((option) => option.id === answer.optionId) !== true) throw fail("an answer is not one of the question's options");
    const text = answer.text === undefined ? undefined : cleanText(answer.text);
    if (answer.optionId === undefined && (text === undefined || text === "")) throw fail("each answer picks an option or says something");
    return { questionId: answer.questionId, ...(answer.optionId === undefined ? {} : { optionId: answer.optionId }), ...(text === undefined || text === "" ? {} : { text }) };
  });
  const ordered = questions.map((question) => cleaned.find((answer) => answer.questionId === question.id)!);
  const record = { ...round, answers: { by: { actorId: actor.data }, at: input.now, answers: ordered } };
  const { waiting: _waiting, ...answered } = review;
  void _waiting;
  return moved(current, { stage: "PLAN", state: "READY", review: { ...answered, status: "resolving", rounds: withLastRound(review, record) }, now: input.now });
}

// ---- no answer, no approval (3.7 / Q5): park at 7 days, close at 30 days parked, resume on a person's word. The reminders are DR10's sweep (broker); none of these answers, approves or spends. They work on all three waits on
// people (`designWaitOf`): the question card, the cost hold and the design card's decision. A wait for answers keeps its record from the start; the other two get one when they are parked, bound to the revision it made.

function waitingOnPeople(currentInput: unknown, expectedRevision: number): { current: WorkflowSnapshot; review: WorkflowDesignReview; wait: DesignWait } {
  const current = parsed(currentInput);
  if (current.revision !== expectedRevision) throw fail("workflow revision is stale");
  const wait = designWaitOf(current);
  if (wait === undefined || current.designReview === undefined) throw fail("the workflow is not at that step of the design review");
  return { current, review: current.designReview, wait };
}

/** The wait record of the snapshot a move is about to make. A wait for answers has none of the revision; the others name the new revision, so they are read only while the workflow stays there. */
const waitRecord = (wait: DesignWait, current: WorkflowSnapshot, record: NonNullable<WorkflowDesignReview["waiting"]>): NonNullable<WorkflowDesignReview["waiting"]> =>
  wait.kind === "answers" ? record : { ...record, revision: current.revision + 1 };

/**
 * The wait on people has lasted DESIGN_REVIEW_PARK_AFTER_MS (7 days): the task is parked ("Paused: waiting for the design decision"). The stage and state do not change; the record says it is parked, so the
 * broker releases the model keys and nothing spends. Refused before the time is up. Any eligible person can then resume it, or answer or decide, from the card.
 */
export function parkDesignReview(currentInput: unknown, input: { expectedRevision: number; now: string }): WorkflowSnapshot {
  const { current, review, wait } = waitingOnPeople(currentInput, input.expectedRevision);
  if (wait.parkedAt !== undefined) throw fail("the design review is already parked");
  if (!(Date.parse(input.now) - Date.parse(wait.since) >= DESIGN_REVIEW_PARK_AFTER_MS)) throw fail("the wait for answers has not lasted long enough to park");
  const waiting = waitRecord(wait, current, { since: wait.since, ...(wait.resumedBy === undefined ? {} : { resumedBy: wait.resumedBy }), parkedAt: input.now });
  return moved(current, { stage: current.stage, state: "WAITING", review: { ...review, waiting }, now: input.now });
}

/** A person resumes a parked design review without answering or deciding: it waits again and the clock starts over. Who resumed it is recorded. */
export function resumeParkedDesignReview(currentInput: unknown, input: { expectedRevision: number; by: { actorId: string }; now: string }): WorkflowSnapshot {
  const { current, review, wait } = waitingOnPeople(currentInput, input.expectedRevision);
  if (wait.parkedAt === undefined) throw fail("the design review is not parked");
  const by = actorOf(input.by);
  return moved(current, { stage: current.stage, state: "WAITING", review: { ...review, waiting: waitRecord(wait, current, { since: input.now, resumedBy: by }) }, now: input.now });
}

/**
 * Nobody answered or decided for DESIGN_REVIEW_CLOSE_AFTER_PARKED_MS (30 days parked): the task is closed as "not decided" (CLOSED/COMPLETE, outcome CLOSED). The design, findings and questions stay on the record.
 * It records no decision and approves nothing. Refused before the time is up.
 */
export function closeParkedDesignReview(currentInput: unknown, input: { expectedRevision: number; now: string }): WorkflowSnapshot {
  const { current, review, wait } = waitingOnPeople(currentInput, input.expectedRevision);
  if (wait.parkedAt === undefined) throw fail("the design review is not parked");
  if (!(Date.parse(input.now) - Date.parse(wait.parkedAt) >= DESIGN_REVIEW_CLOSE_AFTER_PARKED_MS)) throw fail("the design review has not been parked long enough to close");
  const record = WorkflowDesignReviewSchema.safeParse({ ...review, waiting: waitRecord(wait, current, { since: wait.since, ...(wait.resumedBy === undefined ? {} : { resumedBy: wait.resumedBy }), parkedAt: wait.parkedAt, closedAt: input.now }) });
  if (!record.success) throw fail("the design review record is invalid");
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED", blockReason: DESIGN_NOT_DECIDED_MESSAGE, designReview: record.data, updatedAt: input.now });
}

/** Why a resolution is refused, or undefined when it may stand. Pure; the last round has only the two ways of answering a finding that cannot lose information: fix it or contest it with evidence. */
function resolutionProblem(resolution: FindingResolution, finding: DesignFinding, round: DesignReviewRound, lastRoundOfReview: boolean): string | undefined {
  const comprehension = finding.fromReviewers.includes("comprehension");
  if (resolution.action === "contested" && comprehension) return "a finding that the design was not understood cannot be contested";
  // A finding the reader could not show cannot be argued away: nobody can say what it claimed. A fix still settles it once a later round has looked again.
  if (resolution.action === "contested" && finding.origin === "rovara" && finding.id.startsWith(DESIGN_LOST_FINDING_ID_PREFIX)) return "a finding that could not be read cannot be contested";
  if (resolution.action === "declined" && (finding.severity !== "nit" || comprehension)) return "only a nit that is not about understanding may be declined";
  if (lastRoundOfReview && (resolution.action === "asked" || resolution.action === "declined")) return "the last round is fixed or contested only";
  if (resolution.action === "asked") {
    if (round.questions === undefined || round.answers === undefined) return "a finding can be asked about only after the question card was answered";
    if (resolution.questionId === undefined || !round.questions.some((question) => question.id === resolution.questionId)) return "an asked finding must name a question of this round";
  } else if (resolution.questionId !== undefined) return "only an asked finding names a question";
  return undefined;
}

/**
 * The planner's resolution of the round's findings (PLAN/RUNNING, "resolving"): exactly one for each finding the round did not already settle. Each is fixed (the design changed: a new design
 * document must come with it), contested (with evidence; never a comprehension finding), asked (after the question card was answered) or declined (a nit only). In the last round only fixed
 * or contested are allowed. Code sets `settled` (contested, declined and asked are settled; a fix is not, and stays open until a reviewer reads it again); the planner's value is ignored.
 * Where it goes next: a fixed or asked blocker or major (3.2 as changed 2026-11-03: an asked one whose answer changed the design deserves a second read too), with a round left AND a changed design
 * document, sends the revised design to its second round (PLAN_CRITIQUE/READY, "estimating"; the broker passes a fresh estimate for it); anything else, including an answer that left the design as it
 * was, ends at the person (PLAN_REVIEW). Disagreements are never resolved here: a contested blocker is listed for the approver (`designReviewDisagreements`).
 */
export function resolveDesignReview(
  currentInput: unknown,
  input: { expectedRevision: number; resolutions: readonly unknown[]; /** B2-m1: findings the planner answered in a way this round does not allow (asked or declined in the last round). They get no resolution and stay open, listed for the person as unresolved; only the last round may leave findings open. */ leaveOpen?: readonly string[]; artifact?: unknown; now: string },
): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN", states: ["RUNNING"], statuses: ["resolving"] });
  const round = lastRound(review);
  if (round === undefined || designReviewRevisionsUsed(review) >= DESIGN_REVIEW_REVISIONS_MAX || designRoundResolved(round)) throw fail("there is nothing for the planner to resolve");
  const resolutions = z.array(FindingResolutionSchema).safeParse(input.resolutions);
  if (!resolutions.success) throw fail("the resolutions are invalid");
  const finalRound = review.rounds.length >= DESIGN_REVIEW_ROUNDS_MAX;
  const open = new Set(input.leaveOpen ?? []);
  if (open.size > 0 && !finalRound) throw fail("only the last round leaves findings open");
  const unanswered = round.findings.filter((finding) => resolutionOf(round, finding.id) === undefined);
  if ([...open].some((id) => unanswered.every((finding) => finding.id !== id))) throw fail("a finding left open is not an open finding of the round");
  const pending = unanswered.filter((finding) => !open.has(finding.id));
  const byFinding = new Map(resolutions.data.map((resolution) => [resolution.findingId, resolution]));
  if (byFinding.size !== resolutions.data.length || byFinding.size !== pending.length || pending.some((finding) => !byFinding.has(finding.id))) {
    throw fail("every open finding needs exactly one resolution");
  }
  const settled: FindingResolution[] = [];
  for (const finding of pending) {
    const resolution = byFinding.get(finding.id)!;
    const problem = resolutionProblem(resolution, finding, round, finalRound);
    if (problem !== undefined) throw fail(problem);
    settled.push({ ...resolution, settled: resolution.action !== "fixed" });
  }
  // A fix changes the design, so it needs a changed document. An answered question may change it (the planner revises) or may not ("keep it as it is"): then no cosmetic edit is forced.
  const mustChangeDesign = settled.some((resolution) => resolution.action === "fixed");
  const previous = latestDesign(current);
  let artifacts = current.artifacts;
  let revised = false;
  if (input.artifact !== undefined || mustChangeDesign) {
    const artifact = WorkflowArtifactSchema.safeParse(input.artifact);
    if (!artifact.success || artifact.data.type !== "design" || previous === undefined || artifact.data.sha256 === previous.sha256) throw fail(mustChangeDesign ? "a fixed finding needs a changed design document" : "the design document is invalid");
    artifacts = [...current.artifacts, artifact.data];
    revised = true;
  }
  const resolved: DesignReviewRound = { ...round, resolutions: [...round.resolutions, ...settled] };
  const { estimateUsd: _roundOneEstimate, ...withoutEstimate } = review;
  void _roundOneEstimate;
  // The estimate on the record was for the rounds then to run: round 2 is priced afresh when it starts.
  const next: WorkflowDesignReview = { ...withoutEstimate, rounds: withLastRound(review, resolved) };
  const revisedForRound2 = !finalRound && revised && round.findings.some((finding) => {
    const resolution = resolutionOf(resolved, finding.id);
    return finding.severity !== "nit" && (resolution?.action === "fixed" || resolution?.action === "asked");
  });
  return revisedForRound2
    ? moved(current, { stage: "PLAN_CRITIQUE", state: "READY", review: sizeChecked({ ...next, status: "estimating" }), artifacts, now: input.now })
    : moved(current, { stage: "PLAN_REVIEW", state: "WAITING", review: sizeChecked({ ...next, status: "done" }), artifacts, now: input.now });
}

// ---- ending it

/**
 * The review ends and the design goes to the person (PLAN_REVIEW/WAITING, the approve_design card) with whatever was found. Allowed from any step except while a person's answer is owed
 * (no answer, no approval: that wait is parked and closed by its own timers, never ended here) and from PLAN while the planner has not resolved (its revision failed: the design goes as
 * reviewed, findings unresolved). A BLOCKED step ends here too, as the plan check's does (the block's reason is cleared), so a blocked review is never stuck; `resumeBlockedDesignReview` is the other way out.
 * - `addedSpendUsd` adds what the reviewers of a round that was killed (the stage timeout, a lost run) already cost, so spend toward the cap is not under-counted.
 * - `not_run` needs a reason; with no round recorded the review is `not_run`, with one it stays `done` and `notRunReason` says the later round did not run;
 * - `stopped_at_cap` is the cost cap reached before or between rounds;
 * - `finished` ends a review that has at least one round.
 */
export function closeDesignReview(
  currentInput: unknown,
  input: { expectedRevision: number; outcome: "finished" | "stopped_at_cap" | "not_run"; notRunReason?: NotRunReason; addedSpendUsd?: number; now: string },
): WorkflowSnapshot {
  const current = parsed(currentInput);
  if (current.revision !== input.expectedRevision) throw fail("workflow revision is stale");
  const review = current.designReview;
  const at = current.stage === "PLAN_CRITIQUE" ? ["READY", "RUNNING", "WAITING", "BLOCKED"] : current.stage === "PLAN" ? ["READY", "RUNNING", "BLOCKED"] : [];
  const waitingForAnswers = review?.status === "waiting_answers";
  if (review === undefined || current.reviewPhase !== "DESIGN" || !at.includes(current.state) || waitingForAnswers
    || (current.stage === "PLAN" && review.status !== "resolving") || (current.stage === "PLAN_CRITIQUE" && review.status === "resolving")) {
    throw fail("the workflow is not at a step where the design review can end");
  }
  const reason = input.notRunReason === undefined ? undefined : z.enum(DESIGN_REVIEW_NOT_RUN_REASONS).safeParse(input.notRunReason);
  if (input.outcome === "not_run" ? reason?.success !== true : input.notRunReason !== undefined) throw fail("a review that did not run says why, and no other end does");
  if (input.outcome === "finished" && review.rounds.length === 0) throw fail("a review with no round did not finish");
  const { estimateUsd: _estimate, ...withoutEstimate } = review;
  void _estimate;
  const kept = { ...withoutEstimate, spentUsd: addUsd(review.spentUsd, spendDelta(input.addedSpendUsd)) };
  const later = review.rounds.length > 0;
  const next: WorkflowDesignReview = input.outcome === "stopped_at_cap" ? { ...kept, status: "stopped_at_cap" }
    : input.outcome === "finished" ? { ...kept, status: "done" }
      : { ...kept, status: later ? "done" : "not_run", notRunReason: reason!.data! };
  return moved(current, { stage: "PLAN_REVIEW", state: "WAITING", review: next, now: input.now });
}
