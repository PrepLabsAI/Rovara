// Fix with agent: the ErrorRef a task view carries, so the app can offer "Fix with agent" for an error it shows. Fixed codes and ids only: the failure's message and the block reason's text
// are never copied. A task that shows no error has no reference, and a view with no reference shows no button.
import { taskFailureErrorRef, workflowBlockErrorRef, type DeveloperTaskView, type ErrorRef } from "@agentx/contracts";

/**
 * The reference for the error a task view shows, or undefined:
 *  - a blocked step gives `workflow_block` (the code is the fixed sentence's key, or the general code when the reason is not one of the fixed sentences);
 *  - otherwise a failed or interrupted task gives `operation_failed` (its failure category, and the failed operation's id when it has one).
 * A task that ended because its creator was removed has nothing to fix, so no reference.
 */
export function taskViewErrorRef(input: {
  taskId: string; status: DeveloperTaskView["status"]; workflow: { state: string; blockReason?: string | undefined } | undefined;
  failure: DeveloperTaskView["failure"]; operationId: string | undefined; creatorRemoved: boolean; at: string;
}): ErrorRef | undefined {
  if (input.creatorRemoved) return undefined;
  if (input.workflow?.state === "BLOCKED" && input.status !== "SUCCEEDED" && input.status !== "CLOSED" && input.status !== "CANCELLED") {
    return workflowBlockErrorRef({ taskId: input.taskId, blockReason: input.workflow.blockReason, at: input.at });
  }
  if ((input.status === "FAILED" || input.status === "INTERRUPTED") && input.failure !== undefined) {
    return taskFailureErrorRef({ taskId: input.taskId, failure: input.failure, operationId: input.operationId, at: input.at });
  }
  return undefined;
}
