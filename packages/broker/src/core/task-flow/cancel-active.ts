// Internal completion shared by a person's Stop and the idle watchdog, AFTER the cancellation claim.
import type { TaskFlowDeps } from "./deps.js";
import type { OperationRecord, WorkspaceRecord } from "./records.js";
import { fromDocument } from "./records.js";
import { askWorkerToFlush, endUnflushed } from "./money-stop.js";
import { recordOperationResult } from "./results.js";
import { blockStoppedStep } from "./stopped-step.js";
import { readWorkspace } from "./stage-machine.js";
import { workspaceKeys } from "./workspace-location.js";

export async function finishCancellation(deps: TaskFlowDeps, taskId: string, workspace: WorkspaceRecord, operation: OperationRecord, reason: string): Promise<{ nothingRunning: boolean }> {
  const location = await workspaceKeys(deps, workspace.id);
  // A deployed install (money-stop.ts): the worker is asked to stop and send what it spent, and its end is waited for a bounded time, before the machine is stopped. A run whose end did not
  // come keeps its task's whole hold as spent, marked estimated. Without `moneyStop` this is "nothing_to_flush" and the Stop is as before.
  const flushed = await askWorkerToFlush(deps, workspace, operation);
  // The machine keeps its volume; the next step wakes it. A machine that is already gone is the same as one stopped.
  const current = await readWorkspace(deps, workspace.id);
  if (workspace.machine !== undefined && current?.activeOperationId === operation.id && current.fence === operation.fence) await deps.machines.stop(workspace.machine.machineId).catch(() => undefined);
  if (flushed === "not_flushed") await endUnflushed(deps, operation);
  await recordOperationResult(deps, { workspaceId: workspace.id, operationId: operation.id, fence: operation.fence, status: "CANCELLED" });
  // A run that finished on its own while its worker was asked to stop (it SUCCEEDED or FAILED during the wait) was not stopped: its end already made the task's next move, which the
  // Stop does not undo.
  if (flushed === "flushed") {
    const ended = fromDocument<OperationRecord>(await deps.store.get(location.operationKey(operation.id)));
    if (ended?.status === "SUCCEEDED" || ended?.status === "FAILED") return { nothingRunning: false };
  }
  // A workflow step that was stopped has nothing running: it waits for the owner's Retry.
  await blockStoppedStep(deps, taskId, operation, reason);
  return { nothingRunning: false };
}
