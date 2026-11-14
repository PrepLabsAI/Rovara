// Live interaction F1: the ErrorRef of a blocked step. Kept apart from live-interaction.ts because it reads the fixed block sentences in task-workflow.ts, and the task view, the session view
// and the project list (which carry an ErrorRef) are imported by that file's own import graph: the schema file stays a leaf.
import { errorRefOf, type ErrorRef } from "./live-interaction.js";
import { WORKFLOW_BLOCK_REASONS } from "./task-workflow.js";

/**
 * The fixed code of a blocked step: the key of the sentence in `WORKFLOW_BLOCK_REASONS` it carries, in upper snake case (`liveSteerReapprovalRevise` is `LIVE_STEER_REAPPROVAL_REVISE`). A reason that is not
 * one of the fixed sentences (it may carry a name or a message from outside) gives the general code: the text is never turned into a code.
 */
export function workflowBlockCode(blockReason: string | undefined): string {
  if (blockReason === undefined) return "WORKFLOW_BLOCKED";
  const found = Object.entries(WORKFLOW_BLOCK_REASONS).find(([, sentence]) => sentence === blockReason);
  return found === undefined ? "WORKFLOW_BLOCKED" : found[0].replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase();
}

/** A blocked step: the task, why (as a fixed code) and when. */
export function workflowBlockErrorRef(input: { taskId: string; blockReason: string | undefined; at: string }): ErrorRef | undefined {
  return errorRefOf({ kind: "workflow_block", code: workflowBlockCode(input.blockReason), subject: { taskId: input.taskId }, at: input.at });
}
