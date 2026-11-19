// Design review stage: what the broker makes of a worker's design-review result, as a pure function (the wiring that calls it is).
// The worker's own findings are early feedback and are never believed. The broker works from the uploaded ANSWERS:
//   0. the loop is over the BINDING's reviewers (roles and key slots the broker stored): a result with a duplicate, extra or mismatched reviewer is refused as a whole and fails closed, never throws;
//   1. only reviewers that verify.ts VERIFIED, that answered with no failure or status problem count; a voided reviewer's findings are dropped before anything else, and one voided reviewer never turns the round into an error;
//   2. each counted answer is read again (`readDesignReview`); one that cannot be read counts as "gave no result", with the others still counting;
//   3. every citation is checked against THAT reviewer's own packet items and the round's pins (`filterReviewerCitations`);
//   4. what is left is merged: the merge model's grouping is used only if it passes every merge check over exactly this set of findings, otherwise the code-only merge (`mergeDesignFindings`).
// Rovara's own findings (own-findings.ts) are added by the caller with `withOwnFindings`.
import {
  filterReviewerCitations, lightCriticWritesParaphrase, mergeDesignFindings,
  readDesignReview, type CitablePacketItem, type DesignFinding, type DesignReviewBinding, type DesignReviewWorkerResult, type DroppedCitation, type DroppedFinding, type PinnedCommits, type RawDesignFinding, type ReviewerRole,
} from "@agentx/contracts";
import type { ReviewerVerifyFailure, VerifyResult } from "./verify.js";

export interface RoundReviewerState {
  role: ReviewerRole;
  /** The reviewer was verified, answered, had no failure or status problem, AND its answer could be read. Only then are its findings used. */
  counted: boolean;
  /**
   * What goes into `ReviewerRun.verified`: the same as `counted`. A reviewer that verify.ts accepted but whose answer was missing, unreadable or flagged by the worker is NOT verified here
   * (N5): a round whose reviewers all gave nothing must not read as a clean review.
   */
  verified: boolean;
  /** Set when `verified` is false: the fixed code for `ReviewerRun.verifyFailure`. An answer that could not be used is `unreadable_output`. */
  verifyFailure?: ReviewerVerifyFailure;
  /** Why the reviewer was not counted, in more detail than `verifyFailure`: a verify failure code, or one of the answer problems. */
  notUsed?: ReviewerVerifyFailure | "no_answer" | "worker_flagged" | "result_refused";
  /** Carried from verify.ts untouched, so the card can say "verified by the digest of the packet the worker fetched" when the proxy did not confirm the first call. */
  inputProof?: Extract<VerifyResult, { verified: true }>["inputProof"];
  paraphrase?: string;
}

/** Why the worker's whole result was refused (N3). Every reviewer then counts as having given no result. */
export type RoundResultRefusal = "duplicate_role" | "unknown_role" | "key_slot_mismatch" | "merge_failed";

export interface AssembledRound {
  findings: DesignFinding[];
  omitted: number;
  mergeSource: "model" | "code";
  mergeFallback?: string;
  reviewers: RoundReviewerState[];
  droppedCitations: DroppedCitation[];
  droppedFindings: DroppedFinding[];
  /** The part of `droppedFindings` the READER dropped (an invalid field or no citation of an allowed shape), as opposed to the citation check (a citation that names nothing the reviewer was given: a finding that counts for nothing). */
  readDroppedFindings: DroppedFinding[];
  /** Findings a reader could not use at all (no readable severity or section): a count, kept on the round. */
  unreadableFindings: number;
  /** Of those, how many may have been blockers (severity blocker or unreadable). With the dropped blockers they become an open blocker of the round (own-findings.ts), so a lost blocker is never a clean review. */
  unreadableMaybeBlockers: number;
  /** Present when the result was refused as a whole; the findings are then empty. */
  refused?: RoundResultRefusal;
}

/** The first thing wrong with how a result's reviewers line up with the binding's, or undefined. A result may hold fewer reviewers than the binding (a missing one gave no result), never more or different ones. */
export function resultRefusalOf(binding: Pick<DesignReviewBinding, "reviewers">, result: Pick<DesignReviewWorkerResult, "reviewers">): Exclude<RoundResultRefusal, "merge_failed"> | undefined {
  const slots = new Map(binding.reviewers.map((entry) => [entry.role, entry.keySlot] as const));
  const seen = new Set<ReviewerRole>();
  for (const outcome of result.reviewers) {
    if (!slots.has(outcome.role)) return "unknown_role";
    if (seen.has(outcome.role)) return "duplicate_role";
    seen.add(outcome.role);
    if (slots.get(outcome.role) !== outcome.keySlot) return "key_slot_mismatch";
  }
  return undefined;
}

export function assembleRoundFindings(input: {
  /** The binding the BROKER stored for this round. The loop is over its reviewers, never over the worker's list (N3). */
  binding: Pick<DesignReviewBinding, "reviewers">;
  result: Pick<DesignReviewWorkerResult, "reviewers" | "merge">;
  /** What verify.ts decided, by role. A reviewer with no entry is not verified. */
  verification: ReadonlyMap<ReviewerRole, VerifyResult>;
  /** The items of the packet the broker built for each reviewer. */
  packets: ReadonlyMap<ReviewerRole, readonly CitablePacketItem[]>;
  pins: PinnedCommits;
  /**
   * The id of the role prompt the broker built into each reviewer's packet (`BuiltPacket.rolePrompt.id`). The Light tier's Critic prompt asks for the paraphrase, so that answer is read with it;
   * every other answer is read without. A role with no entry is read as its role says.
   */
  promptIds?: ReadonlyMap<ReviewerRole, string>;
}): AssembledRound {
  const refusedAll = (refused: RoundResultRefusal): AssembledRound => ({
    findings: [], omitted: 0, mergeSource: "code", mergeFallback: "result_refused", droppedCitations: [], droppedFindings: [], readDroppedFindings: [], unreadableFindings: 0, unreadableMaybeBlockers: 0, refused,
    reviewers: input.binding.reviewers.map((entry) => ({ role: entry.role, counted: false, verified: false, verifyFailure: "unreadable_output", notUsed: "result_refused" })),
  });
  const refusal = resultRefusalOf(input.binding, input.result);
  if (refusal !== undefined) return refusedAll(refusal);

  const outcomes = new Map(input.result.reviewers.map((outcome) => [outcome.role, outcome] as const));
  const reviewers: RoundReviewerState[] = [];
  const raw: RawDesignFinding[] = [];
  // Findings a reader could not use (an invalid field, no readable text): listed with the ones the citation check drops, so the card says so.
  const readDropped: DroppedFinding[] = [];
  const readDroppedCitations: DroppedCitation[] = [];
  let unreadableFindings = 0;
  let unreadableMaybeBlockers = 0;
  for (const entry of input.binding.reviewers) {
    const outcome = outcomes.get(entry.role);
    const unused = (notUsed: NonNullable<RoundReviewerState["notUsed"]>, verifyFailure: ReviewerVerifyFailure): void => { reviewers.push({ role: entry.role, counted: false, verified: false, verifyFailure, notUsed }); };
    const verdict = input.verification.get(entry.role);
    if (outcome === undefined || verdict === undefined) { unused("no_answer", "unreadable_output"); continue; }
    if (!verdict.verified) { unused(verdict.failure, verdict.failure); continue; }
    // The worker's own signals may only lower the result, never raise it (N1): a reviewer it flagged (a timeout, a mismatch, a stopped stage) is not counted even if an answer and a report exist.
    if (outcome.status !== "answered" || outcome.failure !== undefined) {
      // A reviewer the worker found unreadable (every finding lost, even after the retry) is not counted, but its answer is read ONCE MORE for one purpose: the blockers it lost. Those become open blockers of the
      // broker's own, so a hostile or mistaken answer cannot make a blocker disappear by making it unreadable. This can only lower the result: nothing else of that answer is used.
      if (outcome.failure === "unreadable" && outcome.answer !== undefined) {
        const lost = readDesignReview(outcome.answer, entry.role, { withParaphrase: lightCriticWritesParaphrase(entry.role, input.promptIds?.get(entry.role) ?? "") });
        if (lost.ok) { readDropped.push(...lost.dropped); unreadableFindings += lost.unusable; unreadableMaybeBlockers += lost.unusableMaybeBlocker; }
      }
      unused("worker_flagged", "unreadable_output");
      continue;
    }
    if (outcome.answer === undefined) { unused("no_answer", "unreadable_output"); continue; }
    const read = readDesignReview(outcome.answer, entry.role, { withParaphrase: lightCriticWritesParaphrase(entry.role, input.promptIds?.get(entry.role) ?? "") });
    if (!read.ok) { unused("unreadable_output", "unreadable_output"); continue; }
    readDropped.push(...read.dropped);
    readDroppedCitations.push(...read.droppedCitations);
    unreadableFindings += read.unusable;
    unreadableMaybeBlockers += read.unusableMaybeBlocker;
    // A reviewer whose findings were ALL lost is not a clean review ("nothing found"): it did not give a result.
    if (read.findings.length === 0 && read.dropped.length + read.unusable > 0) { unused("unreadable_output", "unreadable_output"); continue; }
    raw.push(...read.findings);
    reviewers.push({ role: entry.role, verified: true, inputProof: verdict.inputProof, counted: true, ...(read.paraphrase === undefined ? {} : { paraphrase: read.paraphrase }) });
  }
  const cited = filterReviewerCitations(raw, input.packets, input.pins);
  // A merge answer that was made over a different set of findings (for example one that included a voided reviewer's) fails the merge checks and falls back to the code-only merge.
  // Raw findings keep their reviewer's words through the merge (`rawFindings` on each merged finding), and only a verified, counted reviewer's findings are merged at all.
  const verifiedRoles = new Set(reviewers.filter((reviewer) => reviewer.counted).map((reviewer) => reviewer.role));
  try {
    const merged = mergeDesignFindings(cited.findings, input.result.merge.answer, { verifiedRoles });
    return {
      findings: merged.findings, omitted: merged.omitted, mergeSource: merged.source, ...(merged.fallback === undefined ? {} : { mergeFallback: merged.fallback }),
      reviewers, droppedCitations: [...readDroppedCitations, ...cited.droppedCitations], droppedFindings: [...readDropped, ...cited.droppedFindings], readDroppedFindings: readDropped, unreadableFindings, unreadableMaybeBlockers,
    };
  } catch {
    // The merge contract throws on a caller bug (two different findings with one id). The round fails closed: nothing counts, and nothing is thrown out of the assembly.
    return refusedAll("merge_failed");
  }
}
