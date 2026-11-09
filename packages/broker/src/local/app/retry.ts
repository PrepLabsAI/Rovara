// Lane L9-wire: the retry of a blocked Understand or Plan step. L6a leaves "the retry entry point for a BLOCKED Understand/Plan" to the sessions (L6b): a blocked step becomes READY again at the next
// revision, with a dispatch row in the same commit, and the row is run at once (the recovery sweep does it otherwise).
import { WorkflowSnapshotSchema, agentXError } from "@agentx/contracts";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { dispatchRowItem } from "../../core/task-flow/dispatch-rows.js";
import { readTask } from "../../core/task-flow/reads.js";
import { commitWorkflow, runDispatchRow } from "../../core/task-flow/stage-machine.js";
import { iso } from "../../core/task-flow/support.js";

export const NOTHING_TO_RETRY_STEP = "There is nothing to retry: the task is not blocked at a step Rovara can run again.";

export async function retryBlockedStep(deps: TaskFlowDeps, taskId: string): Promise<void> {
  const task = await readTask(deps, taskId);
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.state !== "BLOCKED" || (workflow.stage !== "UNDERSTAND" && workflow.stage !== "PLAN")) {
    throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY_STEP);
  }
  const now = iso(deps);
  const { blockReason: _blockReason, ...rest } = workflow;
  void _blockReason;
  const next = WorkflowSnapshotSchema.parse({ ...rest, revision: workflow.revision + 1, state: "READY", updatedAt: now });
  const kind = workflow.stage === "UNDERSTAND" ? "UNDERSTAND" as const : "PLAN" as const;
  if (!(await commitWorkflow(deps, task, next, [dispatchRowItem(deps, taskId, next.revision, kind, now)]))) throw agentXError("CONFIG_INVALID", "The task changed while you were retrying. Read it again.");
  await runDispatchRow(deps, { taskId, workflowRevision: next.revision, kind });
}
