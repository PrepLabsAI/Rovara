// Lane L6a, task flow core: closing a task, minimally: the task is closed, its workspace is closed under a new fence (so a late callback is
// refused), a job still running is ended as interrupted, the workspace slot is given back once, and the machine is terminated. Cloud's
// `developer-tasks/close.ts` also asks the worker to discard unpublished work and checks the task's pull requests first; that is a gap
// (it needs the close operation and the code host, which later lanes bring).
import { agentXError, change, when, type TransactItem } from "@agentx/contracts";
import { stageAudit } from "./admission.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { releaseItems } from "./limits.js";
import { operationKey, taskIndexKey, taskKey, taskPointerKey, workspaceKey } from "./keys.js";
import { loadOwnedTask, readTask, taskViewOf, type TaskView } from "./reads.js";
import { isTerminalStatus, readOperation, syncTaskIndex } from "./results.js";
import { readWorkspace } from "./stage-machine.js";
import { iso, log } from "./support.js";
import { DocumentStoreError } from "@agentx/contracts";

const CLOSE_ATTEMPTS = 3;

export async function closeTask(deps: TaskFlowDeps, caller: TaskCaller, taskId: string): Promise<TaskView> {
  let task = await loadOwnedTask(deps, caller, taskId);
  for (let attempt = 1; task.closedAt === undefined && attempt <= CLOSE_ATTEMPTS; attempt += 1) {
    const now = iso(deps);
    const workspace = await readWorkspace(deps, task.workspaceId);
    const active = workspace?.activeOperationId == null ? undefined : await readOperation(deps, workspace.id, workspace.activeOperationId);
    const items: TransactItem[] = [
      { kind: "update", key: taskKey(task.taskId), ops: [change.set("closedAt", now), change.set("updatedAt", now)], condition: when.notExists("closedAt") },
      // The slot goes back once: the marker of the charge must still be there. A task whose slot was already released has none.
      ...(task.releasedAt === undefined ? releaseItems(task.charge, task.taskId) : []),
      { kind: "update", key: taskPointerKey(task.workspaceId), ops: [change.set("cancelledAt", now), change.remove("pendingPrompt"), change.remove("pendingWorkflowMode")] },
      ...stageAudit(deps, { eventId: `task.closed:${task.taskId}`, actor: { type: "person", id: caller.principal.personId }, action: "task.closed", subject: { type: "task", id: task.taskId }, details: { project: task.project } }),
    ];
    if (workspace !== undefined) {
      items.push({
        kind: "update", key: workspaceKey(workspace.id),
        ops: [change.set("status", "CLOSED"), change.set("activeOperationId", null), change.set("closedAt", now), change.set("fence", workspace.fence + 1), change.set("updatedAt", now)],
        condition: when.eq("fence", workspace.fence),
      });
    }
    if (active !== undefined && !isTerminalStatus(active.status)) {
      items.push({
        kind: "update", key: operationKey(active.workspaceId, active.id), ops: [change.set("status", "INTERRUPTED"), change.set("error", "the task was closed"), change.set("updatedAt", now)],
        condition: when.and(when.eq("status", active.status), when.eq("fence", active.fence)),
      });
    }
    let applied;
    try {
      applied = await deps.store.transact(items);
    } catch (error) {
      if (error instanceof DocumentStoreError && error.code === "conflict") throw agentXError("WORKSPACE_BUSY", "Rovara could not close the task just now; try again");
      throw error;
    }
    if (applied.applied) {
      await deps.store.update({ key: taskIndexKey(task.developerId, task.createdAt, task.taskId), ops: [change.set("status", "CLOSED"), change.set("updatedAt", now)], condition: when.present() });
      await stopMachine(deps, workspace?.machine?.machineId, workspace?.machineReservationId);
    }
    const fresh = await readTask(deps, taskId);
    if (fresh === undefined) throw agentXError("TASK_NOT_FOUND", "no such task");
    task = fresh;
  }
  if (task.closedAt === undefined) throw agentXError("WORKSPACE_BUSY", "Rovara could not close the task just now; try again");
  await syncTaskIndex(deps, task.workspaceId);
  return taskViewOf(deps, task);
}

/** The machine is not needed any more. A failure leaves a machine the adapter's own idle rules reap; it never reopens the task. */
async function stopMachine(deps: TaskFlowDeps, machineId: string | undefined, reservationId: string | undefined): Promise<void> {
  try {
    if (machineId !== undefined) await deps.machines.terminate(machineId);
    if (reservationId !== undefined) await deps.admission.release(reservationId);
  } catch (error) {
    log(deps, { event: "task_flow.stop_machine_failed", error: error instanceof Error ? error.name : "unknown" });
  }
}
