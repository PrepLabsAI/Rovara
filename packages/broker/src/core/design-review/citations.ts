// Design review stage: the citation check, as the broker applies it. The function is pure and lives in contracts (design-review-citations.ts) because the worker runs the same check for early feedback
// and cannot import from the broker. The broker applies it to the answers it reads itself and the packets it built, never to what the worker says it kept.
// Wiring: after `readDesignReview` of each reviewer's uploaded answer, call `filterReviewerCitations(raw, packetsByRole)` with `packetsByRole` made from each BuiltPacket's `items`, then merge what is left
// (`mergeDesignFindings`), then add the findings of `own-findings.ts`. Record `droppedFindings` on the task so the card can say "N findings were not used: no citation matched what the reviewer was given".
// For the planner's answer (resolve and question evidence) the broker calls `checkPlannerEvidence` below, once per planner answer, and refuses the answer when it says `ok: false`.
import {
  checkResolveCitations, type CitablePacketItem, type DesignQuestion, type DesignResolutionDraft, type PinnedCommits, type ResolveCitationResult, type ReviewerPackets, type ReviewerRole,
} from "@agentx/contracts";

export {
  CITATION_DROP_REASONS, CODE_CITATION_UNCHECKED, checkResolveCitations, citationProblem, codeCitationInPacket, codeCitationLinkPath, filterReviewerCitations,
  type CitablePacketItem, type CitationDropReason, type CitationFilterResult, type DroppedCitation, type DroppedFinding, type PinnedCommits, type ResolveCitationResult, type ReviewerPackets,
} from "@agentx/contracts";

/** Every item any reviewer of the round was given, each once (the planner reads the same design and sources). */
export function roundItemsOf(packets: ReviewerPackets): CitablePacketItem[] {
  const lists: Array<readonly CitablePacketItem[] | undefined> = packets instanceof Map ? [...(packets as ReadonlyMap<ReviewerRole, readonly CitablePacketItem[]>).values()] : (Object.values(packets) as Array<readonly CitablePacketItem[] | undefined>);
  const seen = new Set<string>();
  const items: CitablePacketItem[] = [];
  for (const list of lists) for (const item of list ?? []) {
    const key = `${item.kind}\n${item.ref}\n${item.commitOrFetchedAt}\n${item.digest}`;
    if (!seen.has(key)) { seen.add(key); items.push(item); }
  }
  return items;
}

export type PlannerEvidenceCheck =
  | { ok: true; resolutions: DesignResolutionDraft[]; questions: DesignQuestion[]; droppedCitations: number }
  /** The planner "contested" findings whose evidence has no design or code citation left once the check ran (a source alone cannot argue a finding away). The caller refuses the answer. */
  | { ok: false; uncontestable: string[]; droppedCitations: number };

/**
 * The one call for the planner side (B2). Checks every resolution's and every question's evidence against ALL the round's items and the BROKER's pins (never the worker's), drops a citation that fails,
 * and says `ok: false` with the finding ids when a contest is left with nothing but sources. It never throws and never keeps a citation it could not check.
 */
export function checkPlannerEvidence(input: { resolutions: readonly DesignResolutionDraft[]; questions: readonly DesignQuestion[]; packets: ReviewerPackets; pins: PinnedCommits }): PlannerEvidenceCheck {
  const checked: ResolveCitationResult = checkResolveCitations({ resolutions: input.resolutions, questions: input.questions, items: roundItemsOf(input.packets), pins: input.pins });
  if (checked.uncontestable.length > 0) return { ok: false, uncontestable: checked.uncontestable, droppedCitations: checked.droppedCitations };
  return { ok: true, resolutions: checked.resolutions, questions: checked.questions, droppedCitations: checked.droppedCitations };
}
