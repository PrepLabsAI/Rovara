// Internal completion shared by a person's Stop and the idle watchdog, AFTER the cancellation claim.
import type { TaskFlowDeps } from "./deps.js";
import type { OperationRecord, WorkspaceRecord } from "./records.js";
import { fromDocument } from "./records.js";
import { askWorkerToFlush, endUnflushed } from "./money-stop.js";
import { recordOperationResult } from "./results.js";
import { blockStoppedStep } from "./stopped-step.js";
import { readWorkspace } from "./stage-machine.js";
import { log } from "./support.js";
import { workspaceKeys } from "./workspace-location.js";

export async function finishCancellation(deps: TaskFlowDeps, taskId: string, workspace: WorkspaceRecord, operation: OperationRecord, reason: string, expectedOperationId?: string): Promise<{ nothingRunning: boolean }> {
  const location = await workspaceKeys(deps, workspace.id);
  // A deployed install (money-stop.ts): the worker is asked to stop and send what it spent, and its end is waited for a bounded time, before the machine is stopped. A run whose end did not
  // come is marked unflushed (nothing is booked; its actual figure is settled from the gateway's record on the next spend read). Without `moneyStop` this is "nothing_to_flush" and the Stop is as before.
  const flushed = await askWorkerToFlush(deps, workspace, operation);
  // The machine keeps its volume (the instance ends; Retry wakes it on the same volume). A machine that is already gone is the same as one stopped.
  const current = await readWorkspace(deps, workspace.id);
  if (expectedOperationId !== undefined && (current?.activeOperationId !== operation.id || current.fence !== operation.fence)) {
    if (flushed === "not_flushed") await endUnflushed(deps, operation);
    return { nothingRunning: false };
  }
  if (workspace.machine !== undefined && current?.activeOperationId === operation.id && current.fence === operation.fence) {
    // Best effort: a stop that fails leaves the worker to the idle reaper. Logged, so a Stop that did not end its machine is visible.
    await deps.machines.stop(workspace.machine.machineId).then(
      () => log(deps, { event: "task_flow.machine_stop_requested", workspaceId: workspace.id, operationId: operation.id }),
      (error: unknown) => log(deps, { event: "task_flow.stop_machine_failed", workspaceId: workspace.id, operationId: operation.id, error: error instanceof Error ? error.name : "unknown" }),
    );
  }
  if (flushed === "not_flushed") await endUnflushed(deps, operation);
  await recordOperationResult(deps, { workspaceId: workspace.id, operationId: operation.id, fence: operation.fence, status: "CANCELLED" });
  // A run that finished on its own while its worker was asked to stop (it SUCCEEDED or FAILED during the wait) was not stopped: its end already made the task's next move, which the
  // Stop does not undo.
  if (flushed === "flushed") {
    const ended = fromDocument<OperationRecord>(await deps.store.get(location.operationKey(operation.id)));
    if (ended?.status === "SUCCEEDED" || ended?.status === "FAILED") return { nothingRunning: false };
  }
  // A workflow step that was stopped has nothing running: it waits for the owner's Retry.
  if (expectedOperationId === undefined) await blockStoppedStep(deps, taskId, operation, reason);
  return { nothingRunning: false };
}
