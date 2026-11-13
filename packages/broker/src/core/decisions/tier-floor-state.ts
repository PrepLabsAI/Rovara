// Whether the reviewer's questions are still owed for a head and a patch, read from the record the floor leaves. The patch's digest is taken here, beside the records, so no caller outside the tier's own
// modules ever digests a patch: the caller hands over the patch text `readReviewInput` gave it, unchanged.
import type { WorkflowFlow } from "@agentx/contracts";
import { patchDigestOf, reviewerFloorRecorded } from "./change-tier.js";

/** True when no answered questions are on the record for exactly this head and this patch. */
export const floorOwed = (flow: WorkflowFlow | undefined, headSha: string, patchText: string): boolean => !reviewerFloorRecorded(flow, headSha, patchDigestOf(patchText));
