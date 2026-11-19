// Design review stage (money): what the planner's resolve run may spend. The resolve run is an ordinary planning run in the task's own conversation, so it has the task's normal key; while it runs for a design review
// its key is also held to what is left under the REVIEW's cap, and its measured spend is added to the review's `spentUsd` when it ends (`designResolveOutcome`). Pure: this reads no store.
import { addDesignUsd, workflowIsDesignReviewing, type WorkflowSnapshot } from "@agentx/contracts";

/** The two facts of an operation that make it a design review's planner run. */
export interface PlannerRunFacts { workflowMode?: string | undefined; planRevision?: boolean | undefined }

/**
 * The most a planner resolve run may spend: the review's cap less what the review has spent so far. `undefined` when the workflow is not standing at a design review's resolve run (any other key is minted as before, with
 * no new ceiling). 0 when the cap is spent (or has no record): no key is minted, and the run ends as "ran out of budget", which sends the design to the person as reviewed. The same figure is the charge of a run whose
 * spend could not be measured, so an unreadable meter never lets a planner run go uncounted.
 */
export function plannerRunRoomUsd(workflow: WorkflowSnapshot | undefined, operation?: PlannerRunFacts): number | undefined {
  const review = workflow?.designReview;
  if (workflow === undefined || review === undefined || !workflowIsDesignReviewing(workflow) || workflow.stage !== "PLAN" || workflow.state !== "RUNNING" || review.status !== "resolving") return undefined;
  if (operation !== undefined && (operation.workflowMode !== "PLAN" || operation.planRevision !== true)) return undefined;
  return review.capUsd === undefined ? 0 : Math.max(0, addDesignUsd(review.capUsd, -review.spentUsd));
}
