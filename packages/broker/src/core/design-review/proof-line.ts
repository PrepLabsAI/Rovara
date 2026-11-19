// Design review stage: the ONE design line of a pull request's Proof section.
// It says, in fixed words and counts only: how many of the planned reviewers were verified (coverage all / partial / none), what proved their input (the fixed `inputProofSentence`, the weakest one when
// they differ), who approved and at what risk tier, and, when the design was approved with an open blocker, the approver's one-line reason. No finding text, no question, no reviewer wording, no
// paraphrase: the pull request is public to the repository's readers, and findings stay on the task page.
// The approver's label and the reason are people's words: both go through `inertLine`.
import { inputProofSentence, type InputProof, type WorkflowDesignReview } from "@agentx/contracts";
import { inertLine } from "../proof/inert-text.js";
import { reviewersForRound } from "./estimate.js";
import { designNotRunLine } from "./not-run.js";
import { reviewCoverage } from "./risk.js";
import type { ApprovedDesignText } from "./proof-links.js";

export const PROOF_APPROVER_MAX = 60;
export const PROOF_REASON_MAX = 200;

/** What the approval recorded (the broker's own commit of the approval, not the request). `reason` is the cleaned one-line reason, present only when blockers were open. */
export interface DesignProofApproval {
  approverLabel: string;
  tier: "low" | "medium" | "high";
  openBlockers: number;
  reason?: string | undefined;
}

/** What the Proof section reads about design review. Absent (design review off, or the design not approved): the section is exactly what it was. */
export interface ProofDesignContext {
  /** The approved design: the digest the approval named and the text that hashes to it. Links point only at sections of this text. */
  approved: ApprovedDesignText;
  /** The stored review (rounds, reviewers). Absent: no review ran, so the line says coverage none. */
  review: WorkflowDesignReview | undefined;
  approval: DesignProofApproval;
}

export type DesignCoverage = "all" | "partial" | "none";

export interface DesignProofFacts {
  coverage: DesignCoverage;
  planned: number;
  verified: number;
  rounds: number;
  /** Undefined when no reviewer was verified. */
  inputProof: InputProof | undefined;
}

/** The counts the line is made of, read from the LAST round that ran (as the approve card reads them). */
export function designProofFacts(review: WorkflowDesignReview | undefined): DesignProofFacts {
  const round = review?.rounds.at(-1);
  if (review === undefined || round === undefined) return { coverage: "none", planned: 0, verified: 0, rounds: 0, inputProof: undefined };
  const planned = reviewersForRound(review.tier, round.round).length;
  const verifiedRuns = round.reviewers.filter((run) => run.verified);
  const coverage = reviewCoverage({ planned, verified: verifiedRuns.length });
  // The weakest proof wins: one run checked only by packet digest means the line says so.
  const inputProof: InputProof | undefined = verifiedRuns.length === 0 ? undefined : verifiedRuns.every((run) => run.inputProof === "proxy_first_call") ? "proxy_first_call" : "digest_only";
  return { coverage, planned, verified: verifiedRuns.length, rounds: review.rounds.length, inputProof };
}

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? "" : "s"}`;

/** The words for an approval with open blockers. Kept equal to the approve handler's `designApprovalProofLine` (a test pins it) without pulling the decision modules into the pull request code. */
export function openBlockerWords(openBlockers: number, reason: string | undefined): string | undefined {
  if (openBlockers <= 0) return undefined;
  const clean = reason === undefined ? "" : inertLine(reason, PROOF_REASON_MAX);
  return clean === ""
    ? `Design approved with ${plural(openBlockers, "open blocker")}; no reason was recorded.`
    : `Design approved with ${plural(openBlockers, "open blocker")}: ${clean}`;
}

/** The one Proof line about design review. Counts, fixed sentences and two people's words (approver, reason); nothing a reviewer or a model wrote. */
export function designProofLine(design: ProofDesignContext): string {
  const facts = designProofFacts(design.review);
  const notRun = designNotRunLine(design.review);
  const reviewed = notRun !== undefined
    ? notRun.slice(0, -1)
    : facts.coverage === "none"
      ? "Design review: no reviewer was verified"
      : `Design review: coverage ${facts.coverage} (${String(facts.verified)} of ${plural(facts.planned, "reviewer")}, ${plural(facts.rounds, "round")}), ${inputProofSentence(facts.inputProof ?? "digest_only")}`;
  const approver = inertLine(design.approval.approverLabel, PROOF_APPROVER_MAX);
  const approved = `Approved by ${approver === "" ? "an approver" : approver} (${design.approval.tier} risk).`;
  const blockers = openBlockerWords(design.approval.openBlockers, design.approval.reason);
  return [`${reviewed}.`, approved, ...(blockers === undefined ? [] : [blockers])].join(" ");
}

/** The spec pull request's one line of counts: "Design reviewed: 3 reviewers, 0 open blockers". Counts only; the findings stay on the task page. */
export function designReviewedLine(review: WorkflowDesignReview | undefined, openBlockers: number): string {
  return `Design reviewed: ${plural(designProofFacts(review).verified, "reviewer")}, ${plural(Math.max(0, openBlockers), "open blocker")}`;
}
