import { feedbackCiFailuresDigest, recordWorkflowFeedbackCiFailures } from "@agentx/contracts";
import type { MergeActionDecider, RegisterMergeActionDecider } from "../branch-sync/merge-action.js";

/** Maintain the owner's card, even at autonomy run; selection always remains the owner's. */
export const feedbackDecider: MergeActionDecider = async ({ item, workflow, now }) => {
  if (workflow.feedbackReview?.status !== "PENDING" || workflow.feedbackReview.reviewRef.status !== "COMPLETE") return undefined;
  const digest = feedbackCiFailuresDigest(item.failingChecks);
  if (workflow.feedbackCiFailures?.digest === digest || (workflow.feedbackCiFailures === undefined && item.failingChecks.length === 0)) return undefined;
  const next = recordWorkflowFeedbackCiFailures(workflow, { checks: item.failingChecks, now: new Date(now).toISOString() });
  return { slot: "feedback", workflow: next, steps: [], milestones: [] };
};

let installed: (() => void) | undefined;
export function installFeedbackDecider(register: RegisterMergeActionDecider): void {
  installed ??= register("feedback", feedbackDecider);
}
