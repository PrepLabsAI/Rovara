// The reviewer floor's view of a change, beside the records it leaves: the patch text and its digest are taken here, from the files of the gate's own read (`readTierInput`), in the one canonical form the merge
// gate digests. No caller outside the tier's own modules builds or digests a patch: it hands over what the read gave it.
import type { WorkflowFlow } from "@agentx/contracts";
import { canonicalPatchText, fitFlow, patchDigestOf, reviewerFloorRecorded, type DiffInput } from "./change-tier.js";

/** What the reviewer is given of a change: its paths and its patch text, exactly as `readReviewInput` gives them (the same read, so the facts of the head are not read twice). */
export function reviewTextOf(diff: DiffInput): { files: string[]; patchText: string } {
  return { files: diff.files.map((file) => file.path), patchText: canonicalPatchText(diff.files) };
}

/** True when no answered questions are on the record for exactly this head and this patch. */
export const floorOwed = (flow: WorkflowFlow | undefined, headSha: string, patchText: string): boolean => !reviewerFloorRecorded(flow, headSha, patchDigestOf(patchText));

/** The record without any review record of this head: a review of the head found something that must be fixed, so no review of it stands (a failure is never overwritten by a later clean pass). */
export function withoutTierReviews(flow: WorkflowFlow, headSha: string): WorkflowFlow {
  const kept = (flow.quickChecks ?? []).filter((check) => !(check.detail?.startsWith("tier_review ") === true && check.detail.endsWith(` head=${headSha}`)));
  return kept.length === (flow.quickChecks ?? []).length ? flow : fitFlow({ ...flow, quickChecks: kept });
}
