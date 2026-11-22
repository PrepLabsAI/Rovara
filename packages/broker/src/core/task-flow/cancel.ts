import { taskKey } from "./keys.js";
import { workspaceKeys } from "./workspace-location.js";
import { change, when } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { finishCancellation } from "./cancel-active.js";
import { readTask } from "./reads.js";
import { fromDocument, type OperationRecord, type WorkspaceRecord } from "./records.js";
import { iso } from "./support.js";

/** Cancels the active operation. The host must authorize the caller before invoking this task-level action. */
export async function cancelTask(deps: TaskFlowDeps, taskId: string): Promise<{ nothingRunning: boolean; message?: string }> {
  const task = await readTask(deps, taskId);
  if (task === undefined || task.closedAt !== undefined || task.closeOperationId !== undefined) return { nothingRunning: true };
  const location = await workspaceKeys({ store: deps.store, companyId: task.companyId }, task.workspaceId);
  const workspace = fromDocument<WorkspaceRecord>(await deps.store.get(location.workspaceKey));
  if (workspace === undefined || workspace.activeOperationId === null) return { nothingRunning: true };
  const operation = fromDocument<OperationRecord>(await deps.store.get(location.operationKey(workspace.activeOperationId)));
  if (operation === undefined) return { nothingRunning: true };
  // The stop is asked for first, so the result that follows reads as a stop the flow asked for and not as the worker giving up on its own.
  const stopped = await deps.store.transact([
    { kind: "check", key: taskKey(task.taskId), condition: when.notExists("closeOperationId") },
    { kind: "update",
    key: location.operationKey(operation.id), ops: [change.set("status", "CANCEL_REQUESTED"), change.set("updatedAt", iso(deps))],
    condition: when.and(when.eq("fence", operation.fence), when.not(when.or(when.eq("status", "SUCCEEDED"), when.eq("status", "FAILED"), when.eq("status", "CANCELLED"), when.eq("status", "INTERRUPTED")))),
    },
  ]);
  if (!stopped.applied) return { nothingRunning: true };
  return finishCancellation(deps, taskId, workspace, operation, "You stopped this step. Retry to run it again.");
}
