// Lane L6a, task flow core: closing a task, minimally: the task is closed, its workspace is closed under a new fence (so a late callback is
// refused), a job still running is ended as interrupted, the workspace slot is given back once, and the machine is terminated. Cloud's
// `developer-tasks/close.ts` also asks the worker to discard unpublished work and checks the task's pull requests first; that is a gap
// (it needs the close operation and the code host, which later lanes bring).
import { agentXError, change, when, type TransactItem } from "@agentx/contracts";
import { releaseAdmission, stageAudit } from "./admission.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { releaseItems } from "./limits.js";
import { chargeMarkerKey, operationKey, taskIndexKey, taskKey, taskPointerKey, workspaceKey } from "./keys.js";
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
    // The slot goes back once: the marker of the charge must still be there. A task with none (its slot was released, or it was charged in Cloud's
    // older form) is closed all the same, and has no slot to give back.
    const holdsSlot = task.releasedAt === undefined && await deps.store.get(chargeMarkerKey(task.charge, task.taskId)) !== undefined;
    if (!holdsSlot && task.releasedAt === undefined) log(deps, { event: "task_flow.close_without_slot", taskId: task.taskId });
    const items: TransactItem[] = [
      { kind: "update", key: taskKey(task.taskId), ops: [change.set("closedAt", now), change.set("updatedAt", now), ...(holdsSlot ? [change.set("releasedAt", now)] : [])], condition: when.notExists("closedAt") },
      ...(holdsSlot ? releaseItems(task.charge, task.taskId) : []),
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
      // The workspace is read again once it is closed: a dispatch may have recorded a machine after the first read, and nothing records one on a closed workspace.
      const closed = await readWorkspace(deps, task.workspaceId);
      await stopMachines(deps, [workspace?.machine?.machineId, closed?.machine?.machineId], [workspace?.machineReservationId, closed?.machineReservationId, task.admissionReservationId]);
    }
    const fresh = await readTask(deps, taskId);
    if (fresh === undefined) throw agentXError("TASK_NOT_FOUND", "no such task");
    task = fresh;
  }
  if (task.closedAt === undefined) throw agentXError("WORKSPACE_BUSY", "Rovara could not close the task just now; try again");
  await syncTaskIndex(deps, task.workspaceId);
  return taskViewOf(deps, task);
}

/**
 * The machine is not needed any more, and the allowances held for the task go back. Each step is tried on its own: a machine that will not terminate
 * does not keep an allowance held. A failure leaves a machine the adapter's own idle rules reap; it never reopens the task. (`Admission.settle` takes
 * tokens and cost, not machine time, so the reservations are released; the machine time actually used is a port gap.)
 */
async function stopMachines(deps: TaskFlowDeps, machineIds: ReadonlyArray<string | undefined>, reservationIds: ReadonlyArray<string | undefined>): Promise<void> {
  for (const machineId of new Set(machineIds)) {
    if (machineId === undefined) continue;
    try {
      await deps.machines.terminate(machineId);
    } catch (error) {
      log(deps, { event: "task_flow.terminate_machine_failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }
  for (const reservationId of new Set(reservationIds)) await releaseAdmission(deps, reservationId);
}
