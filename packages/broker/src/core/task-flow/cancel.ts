import { change, when } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { operationKey, workspaceKey } from "./keys.js";
import { askWorkerToFlush, endUnflushed } from "./money-stop.js";
import { readTask } from "./reads.js";
import { fromDocument, type OperationRecord, type WorkspaceRecord } from "./records.js";
import { recordOperationResult } from "./results.js";
import { blockStoppedStep } from "./stopped-step.js";
import { iso } from "./support.js";

/** Cancels the active operation. The host must authorize the caller before invoking this task-level action. */
export async function cancelTask(deps: TaskFlowDeps, taskId: string): Promise<{ nothingRunning: boolean; message?: string }> {
  const task = await readTask(deps, taskId);
  if (task === undefined || task.closedAt !== undefined) return { nothingRunning: true };
  const workspace = fromDocument<WorkspaceRecord>(await deps.store.get(workspaceKey(task.workspaceId)));
  if (workspace === undefined || workspace.activeOperationId === null) return { nothingRunning: true };
  const operation = fromDocument<OperationRecord>(await deps.store.get(operationKey(workspace.id, workspace.activeOperationId)));
  if (operation === undefined) return { nothingRunning: true };
  // The stop is asked for first, so the result that follows reads as a stop the flow asked for and not as the worker giving up on its own.
  await deps.store.update({
    key: operationKey(workspace.id, operation.id), ops: [change.set("status", "CANCEL_REQUESTED"), change.set("updatedAt", iso(deps))],
    condition: when.and(when.eq("fence", operation.fence), when.not(when.or(when.eq("status", "SUCCEEDED"), when.eq("status", "FAILED"), when.eq("status", "CANCELLED"), when.eq("status", "INTERRUPTED")))),
  });
  // A deployed install (money-stop.ts): the worker is asked to stop and send what it spent, and its end is waited for a bounded time, before the machine is stopped. A run whose end did not
  // come keeps its task's whole hold as spent, marked estimated. Without `moneyStop` this is "nothing_to_flush" and the Stop is as before.
  const flushed = await askWorkerToFlush(deps, workspace, operation);
  // The machine keeps its volume; the next step wakes it. A machine that is already gone is the same as one stopped.
  if (workspace.machine !== undefined) await deps.machines.stop(workspace.machine.machineId).catch(() => undefined);
  if (flushed === "not_flushed") await endUnflushed(deps, operation);
  await recordOperationResult(deps, { workspaceId: workspace.id, operationId: operation.id, fence: operation.fence, status: "CANCELLED" });
  // A run that finished on its own while its worker was asked to stop (it SUCCEEDED or FAILED during the wait) was not stopped: its end already made the task's next move, which the
  // Stop does not undo.
  if (flushed === "flushed") {
    const ended = fromDocument<OperationRecord>(await deps.store.get(operationKey(workspace.id, operation.id)));
    if (ended?.status === "SUCCEEDED" || ended?.status === "FAILED") return { nothingRunning: false };
  }
  // A workflow step that was stopped has nothing running: it waits for the owner's Retry.
  await blockStoppedStep(deps, taskId, operation, "You stopped this step. Retry to run it again.");
  return { nothingRunning: false };
}
