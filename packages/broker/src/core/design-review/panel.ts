// Design review stage: what the owner's plan page shows of a design review, from the stored review alone. Pure: a workflow in, a view out. Fixed words are Rovara's; a finding's text, a question and its options are model
// words (the page shows them as untrusted text, and the contract has already cleaned them to one plain line). Nothing here is believed by the broker: the tier, the blockers and the coverage are worked out by code from codes and counts.
import { designWaitOf, type WorkflowSnapshot } from "@agentx/contracts";
import type { DesignReviewPanelView } from "../local-pages/views.js";
import { designChoiceLabel, designChoicesOf } from "./choice-subject.js";
import { designCardFactsOf } from "./card-source.js";
import { designNotRunLine } from "./not-run.js";
import { reviewCoverage } from "../decisions/design-facts.js";

const STATUS_WORDS: Record<string, string> = {
  estimating: "Getting ready to review the design.", waiting_cost: "Waiting for your choice about what the review may cost.", running: "Fresh reviewers are reading the design.", resolving: "The planner is answering the reviewers' findings.",
  waiting_answers: "Waiting for your answers to the design questions.", done: "The design was reviewed.", stopped_at_cap: "The review stopped at its cost limit.",
};
const usd = (value: number): string => `$${value.toFixed(2)}`;

/** The panel for a task with a design review, or undefined. `offer` is the approval request the cost hold's choices are made under. */
export function designPanelOf(workflow: WorkflowSnapshot, options: { allowSkip: boolean; unpricedNote?: string; holdOffer?: { requestId: string; revision: number; artifactDigest: string } }): DesignReviewPanelView | undefined {
  const review = workflow.designReview;
  if (review === undefined) return undefined;
  const facts = designCardFactsOf(review, []);
  const coverage = reviewCoverage(facts.reviewers);
  const status = designNotRunLine(review) ?? (STATUS_WORDS[review.status] ?? "");
  const lines: string[] = [];
  if (review.rounds.length > 0) {
    lines.push(coverage === "all" ? `${String(facts.reviewers.verified)} fresh reviewers read it and each was checked.` : coverage === "partial" ? `${String(facts.reviewers.verified)} of ${String(facts.reviewers.planned)} reviewers could be checked, so the review ran only in part.` : "No reviewer could be checked.");
    lines.push(`${String(facts.blockers.length)} open ${facts.blockers.length === 1 ? "blocker" : "blockers"}, ${String(facts.majors)} open major ${facts.majors === 1 ? "finding" : "findings"}, ${String(facts.disagreements.length)} ${facts.disagreements.length === 1 ? "place" : "places"} where the planner and a reviewer differ.`);
  }
  if (review.spentUsd > 0) lines.push(`Spent so far: ${usd(review.spentUsd)}${review.capUsd === undefined ? "" : ` of a ${usd(review.capUsd)} limit`}${review.approvals?.some((approval) => approval.kind === "spend") === true ? " (counted at an assumed price)" : ""}.`);
  const round = review.rounds.at(-1);
  const findings: DesignReviewPanelView["findings"] = (round?.findings ?? []).map((finding) => {
    const resolution = round?.resolutions.find((entry) => entry.findingId === finding.id);
    const open = (finding.severity === "blocker" || finding.severity === "major") && resolution?.settled !== true;
    return {
      severity: finding.severity, section: finding.section, text: finding.text, from: finding.origin === "rovara" ? "Rovara's own check" : finding.fromReviewers.join(", "), open,
      ...(resolution === undefined ? {} : { resolution: `the planner ${resolution.action === "fixed" ? "fixed it" : resolution.action === "contested" ? "contested it" : resolution.action === "asked" ? "asked about it" : "declined it"}` }),
    };
  }).sort((left, right) => Number(right.open) - Number(left.open));
  const choices = designChoicesOf(workflow, { allowSkip: options.allowSkip });
  const hold = choices.length === 0 || options.holdOffer === undefined ? undefined : {
    why: review.estimateUsd === undefined ? "The price of the model is not known" : `The review is estimated at ${usd(review.estimateUsd)}, over the ${usd(review.capUsd ?? 0)} limit`,
    ...(review.estimateUsd === undefined && options.unpricedNote !== undefined ? { note: options.unpricedNote } : {}),
    offer: { ...options.holdOffer, kind: "design" as const },
    choices: choices.map((choice) => ({ choice: choice.choice, label: designChoiceLabel(choice) })),
  };
  const wait = designWaitOf(workflow);
  return {
    status, facts: lines, findings,
    ...(hold === undefined ? {} : { hold }),
    ...(wait?.parkedAt === undefined ? {} : { parked: { revision: workflow.revision } }),
    ...(workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING" && workflow.reviewPhase === "DESIGN" && facts.blockers.length > 0 ? { blockerReasonNeeded: true } : {}),
  };
}

/** The question card of a review that waits for answers, as the page's questions form takes it (the same form Understand's questions use). */
export function designQuestionsOf(workflow: WorkflowSnapshot): { round: number; items: Array<{ id: string; text: string; options: Array<{ id: string; label: string }> }> } | undefined {
  const review = workflow.designReview;
  const round = review?.rounds.at(-1);
  if (review?.status !== "waiting_answers" || round?.questions === undefined) return undefined;
  return { round: round.round, items: round.questions.map((question) => ({ id: question.id, text: `${question.unclear} (recommended: ${question.options.find((option) => option.id === question.recommended)?.label ?? question.recommended}; ${question.why})`, options: question.options.map((option) => ({ id: option.id, label: `${option.label}: ${option.consequence}` })) })) };
}
