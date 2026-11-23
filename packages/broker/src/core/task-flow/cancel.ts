import { taskKey } from "./keys.js";
import { workspaceKeys } from "./workspace-location.js";
import { blockWorkflow, change, when } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { finishCancellation } from "./cancel-active.js";
import { readTask } from "./reads.js";
import { fromDocument, type OperationRecord, type WorkspaceRecord } from "./records.js";
import { iso } from "./support.js";
import { commitWorkflow } from "./stage-machine.js";
import { resolveRowItem } from "./dispatch-rows.js";

async function stopQueuedChecks(deps: TaskFlowDeps, task: NonNullable<Awaited<ReturnType<typeof readTask>>>, workspace: WorkspaceRecord, location: Awaited<ReturnType<typeof workspaceKeys>>) {
  // A managed round may still be due, before the dispatcher has acquired a worker. Stop invalidates that
  // revision atomically with its due row, so recovery and an admission already being prepared cannot revive it.
  const workflow = task.workflow;
  if (workflow?.stage === "VERIFY" && workflow.state === "WAITING" && workflow.e2e?.required === true) {
    const stopped = blockWorkflow(workflow, "You stopped the checks. Retry to run them again.", iso(deps));
    const applied = await commitWorkflow(deps, task, stopped, [resolveRowItem(deps, task.taskId, workflow.revision),
      { kind: "check", key: location.workspaceKey, condition: when.and(when.eq("activeOperationId", null), when.eq("fence", workspace.fence)) }]);
    return { nothingRunning: !applied };
  }
  return { nothingRunning: true };
}

/** Cancels the active operation. The host must authorize the caller before invoking this task-level action. */
export async function cancelTask(deps: TaskFlowDeps, taskId: string, expectedOperationId?: string): Promise<{ nothingRunning: boolean; message?: string }> {
  const task = await readTask(deps, taskId);
  if (task === undefined || task.closedAt !== undefined || task.closeOperationId !== undefined) return { nothingRunning: true };
  const location = await workspaceKeys({ store: deps.store, companyId: task.companyId }, task.workspaceId);
  const workspace = fromDocument<WorkspaceRecord>(await deps.store.get(location.workspaceKey));
  if (workspace === undefined || (expectedOperationId !== undefined && workspace.activeOperationId !== expectedOperationId)) return { nothingRunning: true };
  if (workspace.activeOperationId === null) {
    return stopQueuedChecks(deps, task, workspace, location);
  }
  const operation = fromDocument<OperationRecord>(await deps.store.get(location.operationKey(workspace.activeOperationId)));
  if (operation === undefined || ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(operation.status)) return { nothingRunning: true };
  // The stop is asked for first, so the result that follows reads as a stop the flow asked for and not as the worker giving up on its own.
  const stopped = await deps.store.transact([
    { kind: "check", key: taskKey(task.taskId), condition: when.notExists("closeOperationId") },
    { kind: "update",
    key: location.operationKey(operation.id), ops: [change.set("status", "CANCEL_REQUESTED"), change.set("updatedAt", iso(deps))],
    condition: when.and(when.eq("fence", operation.fence), when.not(when.or(when.eq("status", "SUCCEEDED"), when.eq("status", "FAILED"), when.eq("status", "CANCELLED"), when.eq("status", "INTERRUPTED")))),
    },
  ]);
  if (!stopped.applied) return { nothingRunning: true };
  return finishCancellation(deps, taskId, workspace, operation, "You stopped this step. Retry to run it again.", expectedOperationId);
}
