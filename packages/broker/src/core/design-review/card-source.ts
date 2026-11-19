// Design review stage: the card SOURCES for a design under review. Pure: a stored `WorkflowDesignReview` (and the design's `touches[]`) in, a pending `DecisionItem` out, for the
// projector (`decisions/project.ts`) to make a card from. Two sources:
//   - `designApproveItem`: the existing `approve_design` card, now with the evidence chips (reviewers verified, open blockers, disagreements, cost) and the Disagreements group. Its tier is NOT set here: the
//     projector asks `riskTierOf`, which reads the facts below. Model text never sets it.
//   - `designQuestionsItem`: ONE `answer_question` card per round with up to three questions, each with what is unclear, short cited evidence, the options with consequences, and the recommendation with why.
// Every line a model wrote (a finding's text, a question) is passed through `plainLine` by the projector; nothing here is executed or followed.
import { createHash } from "node:crypto";
import { CODE_CITATION_UNCHECKED, DESIGN_REVIEW_QUESTIONS_MAX, codeCitationInPacket, designFindingIsSourceOnly, designReviewDisagreements, type CitablePacketItem, type DesignCitation, type DesignFinding, type DesignQuestion, type DesignReason, type WorkflowDesignReview } from "@agentx/contracts";
import type { DecisionItem, ItemBase } from "../decisions/project.js";
import { plainLine } from "../decisions/text.js";
import { TIER_REVIEWERS, reviewersForRound } from "./estimate.js";
import type { DesignCardFacts } from "./risk.js";

/**
 * What the approver is shown, from the stored review. The reviewer counts are the LAST round's (`planned` is what that round meant to run: round 1 of Thorough is four, since Zoom-out runs only after round 1;
 * a review that never ran has no round and reads "did not run"). The FINDINGS are read across EVERY round (M6): a finding is followed by its fingerprint to its latest appearance, and it is an OPEN blocker or major
 * when that appearance has no settled resolution AND, if it was last seen in an earlier round, no later round could have confirmed it fixed. A later round confirms a fix only when a reviewer of the same role
 * (or, for a finding Rovara added itself, any reviewer) was VERIFIED in it and did not raise the finding again; a later round whose reviewer failed verification or did not run confirms nothing, so an earlier
 * blocker stays on the card. A DISAGREEMENT is a finding the planner contested or declined at its latest appearance, settled or not: the approver sees every place the planner and a reviewer differ.
 */
export function designCardFactsOf(review: WorkflowDesignReview, touches: readonly DesignReason[]): DesignCardFacts {
  const round = review.rounds.at(-1);
  const planned = round === undefined ? TIER_REVIEWERS[review.tier].length : reviewersForRound(review.tier, round.round).length;
  const verified = round === undefined ? 0 : round.reviewers.filter((run) => run.verified).length;
  // A finding is followed by its fingerprint to the LATEST round that has it; only that appearance counts (every finding of that round with that fingerprint, so a round with two the same keeps both).
  const lastRound = new Map<string, number>();
  review.rounds.forEach((each, index) => { for (const finding of each.findings) lastRound.set(finding.fingerprint, index); });
  const entries = review.rounds.flatMap((each, index) => each.findings
    .filter((finding) => lastRound.get(finding.fingerprint) === index)
    .map((finding) => ({ index, finding, resolution: each.resolutions.find((resolution) => resolution.findingId === finding.id) })));
  const confirmedFixed = (entry: { index: number; finding: DesignFinding }): boolean => review.rounds.slice(entry.index + 1).some((later) => {
    const roles = entry.finding.fromReviewers;
    return later.reviewers.some((run) => run.verified && (roles.length === 0 || roles.includes(run.role)));
  });
  const open = entries.filter((entry) => (entry.finding.severity === "blocker" || entry.finding.severity === "major")
    && !(entry.resolution?.settled === true)
    && (entry.index === review.rounds.length - 1 || !confirmedFixed(entry)));
  const differ = designReviewDisagreements(review).flatMap((entry) => {
    const finding = review.rounds[entry.round - 1]?.findings.find((candidate) => candidate.id === entry.findingId);
    return finding === undefined ? [] : [{ section: finding.section, text: finding.text, kind: entry.kind }];
  });
  return {
    reasons: review.reasons,
    touches,
    reviewers: { planned, verified },
    blockers: open.filter((entry) => entry.finding.severity === "blocker").map((entry) => ({ section: entry.finding.section, text: entry.finding.text, ...(designFindingIsSourceOnly(entry.finding) ? { sourceOnly: true as const } : {}) })),
    majors: open.filter((entry) => entry.finding.severity === "major").length,
    disagreements: differ,
    ...(review.spentUsd > 0 ? { costUsd: review.spentUsd } : {}),
  };
}

type CardBase = Omit<ItemBase, "details" | "answeredByRule" | "outcome">;

/** The `approve_design` item for a design under review. `files` are the paths the design says it changes (§6); `review` the facts above. */
export function designApproveItem(base: CardBase & { files: readonly string[]; review: DesignCardFacts }): DecisionItem {
  const { files, review, contentVersion, ...rest } = base;
  return { ...rest, contentVersion: designContentVersion(contentVersion, review), kind: "approve_design", files, review };
}

/**
 * The version a person's look at the card is bound to: the source's own version (the design digest) AND a short hash of the open blockers and majors and how the review went (H1). A reason given for one
 * blocker is bound to that look; a second blocker, a changed one or a re-run review makes a different version, so the earlier look and reason are worth nothing and the card is loaded again. Bounded to the 100
 * characters a content version may have.
 */
export function designContentVersion(sourceVersion: string, review: DesignCardFacts): string {
  const facts = createHash("sha256").update(JSON.stringify([review.blockers, review.majors, review.reviewers, review.disagreements, review.reasons, review.touches])).digest("hex").slice(0, 16);
  const head = sourceVersion.length > 80 ? createHash("sha256").update(sourceVersion).digest("hex").slice(0, 32) : sourceVersion;
  return `${head}:b${String(review.blockers.length)}:${facts}`;
}

/** A code citation that matched a repository file the reviewer was given reads as a path; any other is "a path at the pinned commit, not checked": Rovara never looked it up (N5). */
export function citationText(citation: DesignCitation, packetItems: readonly CitablePacketItem[] = []): string {
  switch (citation.kind) {
    case "design": return `design ${citation.section}`;
    case "code": return `${citation.path}:${String(citation.startLine)}${codeCitationInPacket(citation, packetItems) ? "" : ` (${CODE_CITATION_UNCHECKED})`}`;
    case "source": return `source ${citation.ref}`;
  }
}

/**
 * ONE card for a round's questions: the item is an `answer_question` with a batch of up to three, each question one detail group the person reads. Zero questions, or more than three, make no card
 * (undefined): the batch is bounded and a broken one is dropped, never trimmed to something the reviewers did not ask.
 */
export function designQuestionsItem(base: CardBase & { designTitle: string; questions: readonly DesignQuestion[]; /** The round's packet items: a code citation that matches one is shown plainly, every other as not checked. */ packetItems?: readonly CitablePacketItem[] }): DecisionItem | undefined {
  const { designTitle, questions, packetItems, ...rest } = base;
  if (questions.length === 0 || questions.length > DESIGN_REVIEW_QUESTIONS_MAX) return undefined;
  const details = questions.map((question, index) => ({
    title: plainLine(`${String(index + 1)}. ${question.unclear}`, 60),
    lines: [
      plainLine(`Unclear because: ${question.unclear}`, 200),
      ...(question.evidence.length === 0 ? [] : [plainLine(`Evidence: ${question.evidence.map((citation) => citationText(citation, packetItems)).join("; ")}`, 200)]),
      ...question.options.map((option) => plainLine(`${option.id}) ${option.label}: ${option.consequence}`, 200)),
      plainLine(`Recommended: ${question.recommended}. Why: ${question.why}`, 200),
    ],
  }));
  return { ...rest, kind: "answer_question", question: plainLine(`Design questions for "${designTitle}" (${String(questions.length)})`, 160), index: 1, of: 1, batch: { count: questions.length }, details };
}
