// Design review stage, DR6 (designs-2026-10-30/design-review-stage.md 3.2): the pure reads of a stored design review. Browser-safe: the task page, the cards and the workflow's transitions
// (task-workflow-design-review.ts) all read the review through these, so "is it on", "what stays settled" and "what is still in dispute" have one answer.
// Nothing here approves anything. Every list below is derived from the stored rounds, so there is nothing to keep in step.
import {
  DESIGN_REVIEW_EARLIER_MAX, DESIGN_REVIEW_EARLIER_MAX_BYTES, DESIGN_REVIEW_REARMS_MAX, DESIGN_REVIEW_ROUNDS_MAX,
  type DesignFinding, type DesignReviewActor, type DesignReviewRound, type EarlierDesignReview, type FindingResolution, type WorkflowDesignReview,
} from "./design-review.js";

/** The review is switched on and waits for its first design: the only state in which a submitted design document is admitted to the review. */
export function designReviewAwaitsDesign(review: WorkflowDesignReview | undefined): boolean {
  return review !== undefined && review.status === "estimating" && review.rounds.length === 0;
}

/** The review has begun and has not ended: any status but the three that ended it. */
export function designReviewActive(review: WorkflowDesignReview | undefined): boolean {
  return review !== undefined && review.status !== "done" && review.status !== "not_run" && review.status !== "stopped_at_cap";
}

/** Whether a workflow's plan-check stage is the design review's, not the plan check's. A design is only reviewed in the DESIGN phase of a Full task. */
export function workflowIsDesignReviewing(workflow: { designReview?: WorkflowDesignReview | undefined; reviewPhase?: string | undefined }): boolean {
  return workflow.designReview !== undefined && workflow.reviewPhase === "DESIGN";
}

/** Money is kept to the micro-dollar: no floating-point drift can push a total over a cap or under zero. */
export const addDesignUsd = (a: number, b: number): number => Math.round((a + b) * 1e6) / 1e6;

export type DesignReviewCapRoom =
  | { kind: "fits"; roomUsd: number }
  | { kind: "no_cap" }
  /** Nothing is left under the cap. */
  | { kind: "at_cap" }
  /** The estimate is known and is more than what is left under the cap: a person raises the cap or picks a lower tier. */
  | { kind: "over_cap"; roomUsd: number }
  /** There is no price: a person's one tap approves the spend (the cap still holds). */
  | { kind: "no_price"; roomUsd: number };

/**
 * Whether a round may start under the cap stored on the review (3.2: spend never exceeds the cap; 3.6: no price needs a tap). `estimateUsd` is what the round or rounds still to run are
 * expected to cost; spend so far is already in `spentUsd`. The broker reads this to choose between starting and holding for the cost card; `startDesignReview` enforces it.
 */
export function designReviewCapRoom(review: Pick<WorkflowDesignReview, "capUsd" | "spentUsd" | "estimateUsd">, estimateUsd?: number): DesignReviewCapRoom {
  if (review.capUsd === undefined) return { kind: "no_cap" };
  const roomUsd = addDesignUsd(review.capUsd, -review.spentUsd);
  if (roomUsd <= 0) return { kind: "at_cap" };
  const estimate = estimateUsd ?? review.estimateUsd;
  if (estimate === undefined) return { kind: "no_price", roomUsd };
  return estimate > roomUsd + 1e-9 ? { kind: "over_cap", roomUsd } : { kind: "fits", roomUsd };
}

const SENT_BACK_TEXT_MAX = 160;
const clip = (text: string, max: number): string => Array.from(text).slice(0, max).join("");

/** What is kept of a review whose design was sent back: the paid reviewers and the findings with what was done about them, without the packets, files read or citations. */
function archivedReview(review: WorkflowDesignReview, sentBack: { at: string; by: DesignReviewActor }): EarlierDesignReview {
  return {
    sentBackBy: sentBack.by, sentBackAt: sentBack.at, spentUsd: review.spentUsd,
    rounds: review.rounds.map((round) => ({
      round: round.round, designDigest: round.designDigest,
      reviewers: round.reviewers.map((run) => ({
        role: run.role, model: run.model, sessionId: run.sessionId, modelKeyId: run.modelKeyId, packetDigest: run.packetDigest, verified: run.verified,
        ...(run.verifyFailure === undefined ? {} : { verifyFailure: run.verifyFailure }), tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: run.costUsd,
      })),
      findings: round.findings.map((finding) => {
        const resolution = resolutionOf(round, finding.id);
        return {
          id: finding.id, severity: finding.severity, section: finding.section, fingerprint: finding.fingerprint, text: clip(finding.text, SENT_BACK_TEXT_MAX),
          ...(resolution === undefined ? {} : { action: resolution.action, settled: resolution.settled }),
        };
      }),
    })),
  };
}

/** Keeps the archive inside its count and its bytes: the oldest review goes first; a lone review that is still too big loses its findings (the reviewers and what they cost stay). */
function boundedArchive(archive: readonly EarlierDesignReview[]): EarlierDesignReview[] {
  let kept = archive.slice(-DESIGN_REVIEW_EARLIER_MAX);
  const weight = (list: readonly EarlierDesignReview[]): number => new TextEncoder().encode(JSON.stringify(list)).length;
  while (kept.length > 1 && weight(kept) > DESIGN_REVIEW_EARLIER_MAX_BYTES) kept = kept.slice(1);
  if (weight(kept) > DESIGN_REVIEW_EARLIER_MAX_BYTES) kept = kept.map((entry) => ({ ...entry, rounds: entry.rounds.map((round) => ({ ...round, findings: [] })) }));
  return kept;
}

/**
 * A person asked for changes to the design: it is reviewed afresh (two new rounds), and what it cost stays counted toward the task's cap. The paid rounds of the design that was sent
 * back are archived on the record (bounded), not thrown away, so "what did we pay for" and the proof line keep their source.
 * - A review that stopped at the cost cap (or has no room left under it) stays stopped: only a person's raised cap or lower tier opens it again.
 * - After DESIGN_REVIEW_REARMS_MAX re-reviews the review does not run again: it is "not run" (`rearm_limit`) until a person changes the cap or the tier.
 * - Only a review a person or the setting asked for is re-armed; one that was skipped or never on is left as it is.
 */
export function rearmedDesignReview(review: WorkflowDesignReview, sentBack: { at: string; by: DesignReviewActor }): WorkflowDesignReview {
  if (review.decidedBy !== "auto" && review.decidedBy !== "always" && review.decidedBy !== "person") return review;
  const { estimateUsd: _estimate, notRunReason: _reason, waiting: _waiting, ...kept } = review;
  void _estimate;
  void _reason;
  void _waiting;
  const earlierReviews = boundedArchive(review.rounds.length === 0 ? review.earlierReviews ?? [] : [...(review.earlierReviews ?? []), archivedReview(review, sentBack)]);
  const base = { ...kept, rounds: [], ...(earlierReviews.length === 0 ? {} : { earlierReviews }) };
  const used = review.rearms ?? 0;
  if (review.status === "stopped_at_cap" || (review.capUsd !== undefined && review.spentUsd >= review.capUsd)) return { ...base, status: "stopped_at_cap", rearms: used };
  if (used >= DESIGN_REVIEW_REARMS_MAX) return { ...base, status: "not_run", notRunReason: "rearm_limit", rearms: used };
  return { ...base, status: "estimating", rearms: used + 1 };
}

/** A finding and what the planner did with it, for one round. */
export function resolutionOf(round: DesignReviewRound, findingId: string): FindingResolution | undefined {
  return round.resolutions.find((resolution) => resolution.findingId === findingId);
}

/** Every finding of the round has a resolution. */
export function designRoundResolved(round: DesignReviewRound): boolean {
  return round.findings.every((finding) => resolutionOf(round, finding.id) !== undefined);
}

/** Whether a round has a reviewer whose result counts (the broker verified it was fresh and read-only). */
export function designRoundHasResult(round: DesignReviewRound): boolean {
  return round.reviewers.some((run) => run.verified);
}

/** The finding of an earlier round with the same fingerprint (section plus normalised text), if the round raised it before: the card shows "raised again". */
export function designFindingRaisedBefore(review: Pick<WorkflowDesignReview, "rounds">, roundNumber: number, finding: Pick<DesignFinding, "fingerprint">): DesignFinding | undefined {
  for (const round of review.rounds) {
    if (round.round >= roundNumber) break;
    const earlier = round.findings.find((candidate) => candidate.fingerprint === finding.fingerprint);
    if (earlier !== undefined) return earlier;
  }
  return undefined;
}

export const DESIGN_DISAGREEMENT_KINDS = ["contested", "unresolved", "unchecked_fix", "oscillation"] as const;
export type DesignDisagreementKind = (typeof DESIGN_DISAGREEMENT_KINDS)[number];

export interface DesignDisagreement {
  round: 1 | 2;
  findingId: string;
  severity: "blocker" | "major";
  /**
   * contested: the planner contested a blocker with evidence (both sides are shown);
   * unresolved: nobody resolved it (the review stopped at the cost cap, the planner's revision failed, or the loop ended);
   * unchecked_fix: the planner says it fixed it in the last round, and no reviewer read the fix;
   * oscillation: fixing it would undo an earlier fix, so the loop ended and a person decides.
   */
  kind: DesignDisagreementKind;
  raisedAgain: boolean;
}

/**
 * What the approver sees under "Disagreements" once the review is over: every blocker or major of the last round that has a result, unless it was fixed and read again, or answered by a
 * person, plus every contested blocker. A contested major is settled (3.2 lists contested blockers only). A nit is never listed. An empty list is also the answer while the review is still
 * running: the list belongs to a review that has ended. The card is at least medium risk while this list has anything in it.
 */
export function designReviewDisagreements(review: WorkflowDesignReview | undefined): DesignDisagreement[] {
  if (review === undefined || (review.status !== "done" && review.status !== "stopped_at_cap")) return [];
  const round = [...review.rounds].reverse().find(designRoundHasResult);
  if (round === undefined) return [];
  const found: DesignDisagreement[] = [];
  for (const finding of round.findings) {
    if (finding.severity === "nit") continue;
    const resolution = resolutionOf(round, finding.id);
    let kind: DesignDisagreementKind | undefined;
    if (round.oscillation?.includes(finding.id) === true && resolution === undefined) kind = "oscillation";
    else if (resolution === undefined) kind = "unresolved";
    else if (resolution.action === "fixed") kind = "unchecked_fix";
    else if (resolution.action === "contested" && finding.severity === "blocker") kind = "contested";
    if (kind !== undefined) found.push({ round: round.round, findingId: finding.id, severity: finding.severity, kind, raisedAgain: designFindingRaisedBefore(review, round.round, finding) !== undefined });
  }
  return found;
}

/** How many planner revisions the review has used: one for each round whose findings the planner resolved. Never more than DESIGN_REVIEW_ROUNDS_MAX. */
export function designReviewRevisionsUsed(review: Pick<WorkflowDesignReview, "rounds">): number {
  return Math.min(DESIGN_REVIEW_ROUNDS_MAX, review.rounds.filter((round) => round.findings.length > 0 && designRoundResolved(round)).length);
}

/** The three places a design review waits on people (3.7): the question card, the cost hold's card, and the design card's decision. */
export type DesignWaitKind = "answers" | "cost" | "decision";
export interface DesignWait {
  kind: DesignWaitKind;
  /** When this wait began (or began again, after a person resumed it): the clock for the reminders and the park. */
  since: string;
  parkedAt?: string;
  closedAt?: string;
  resumedBy?: { actorId: string };
}

/**
 * Which wait on people a workflow is in right now, or undefined. Pure, browser-safe, and read from the snapshot alone: the answers wait is PLAN/WAITING with the review "waiting_answers" (its record is
 * `waiting`); the cost hold is PLAN_CRITIQUE/WAITING "waiting_cost"; the decision is PLAN_REVIEW/WAITING once the review has ended ("done", "not_run" or "stopped_at_cap"), in the design phase of a Full task.
 * The last two keep a record only once parked or resumed, and only the one that names this very revision counts (a record from an earlier wait is ignored), so they start at the workflow's `updatedAt`.
 */
export function designWaitOf(workflow: {
  stage: string; state: string; revision: number; updatedAt: string; path?: string | undefined; reviewPhase?: string | undefined; designReview?: WorkflowDesignReview | undefined;
}): DesignWait | undefined {
  const review = workflow.designReview;
  if (review === undefined || workflow.path !== "FULL" || workflow.reviewPhase !== "DESIGN" || workflow.state !== "WAITING") return undefined;
  const carry = (wait: NonNullable<WorkflowDesignReview["waiting"]>): Pick<DesignWait, "parkedAt" | "closedAt" | "resumedBy"> => ({
    ...(wait.parkedAt === undefined ? {} : { parkedAt: wait.parkedAt }), ...(wait.closedAt === undefined ? {} : { closedAt: wait.closedAt }), ...(wait.resumedBy === undefined ? {} : { resumedBy: wait.resumedBy }),
  });
  if (workflow.stage === "PLAN" && review.status === "waiting_answers") {
    const wait = review.waiting;
    return wait === undefined || wait.closedAt !== undefined ? undefined : { kind: "answers", since: wait.since, ...carry(wait) };
  }
  const kind: DesignWaitKind | undefined = workflow.stage === "PLAN_CRITIQUE" && review.status === "waiting_cost" ? "cost"
    : workflow.stage === "PLAN_REVIEW" && (review.status === "done" || review.status === "not_run" || review.status === "stopped_at_cap") ? "decision" : undefined;
  if (kind === undefined) return undefined;
  const wait = review.waiting;
  if (wait !== undefined && wait.revision === workflow.revision && wait.closedAt === undefined) return { kind, since: wait.since, ...carry(wait) };
  return { kind, since: workflow.updatedAt };
}
