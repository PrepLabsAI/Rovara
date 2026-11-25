import { change, when, type TransactItem } from "@agentx/contracts";
import { toDocument } from "./records.js";
import type { TaskFlowDeps } from "./deps.js";
import { stageAudit } from "./admission.js";
import { chargeMarkerKey, taskIndexKey, taskKey } from "./keys.js";
import { releaseItems } from "./limits.js";
import { readTask } from "./reads.js";
import { isTerminalStatus, readOperation } from "./results.js";
import { closeClaimItems, closeReceiptItem, saveCloseReceipt, type AcceptedClose } from "./close-recovery-state.js";
import { mergeCloseConditions } from "./close-conditions.js";
import { workspaceKeys } from "./workspace-location.js";
import { iso } from "./support.js";
import { TASK_END_WAIT_MS, callTaskEndSeam, taskEndKey, taskEndRow, within } from "./task-end.js";
import { runWatchKey } from "./run-watch-rows.js";
import { projectClosedSession } from "./close-recovery-projection.js";

/** The provider owns the atomic destruction boundary and its durable replay tombstone. No proof, no destruction. */
export async function destroyAcceptedClose(deps: TaskFlowDeps, op: AcceptedClose): Promise<boolean> {
  const a = op.closeAcceptance;
  if (a.receipts["terminate"] !== undefined) return true;
  const provider = deps.closeInspection;
  if (provider?.destroyRetained === undefined) return false;
  if (!(await deps.store.transact([...await closeClaimItems(deps, op), { kind: "check", key: { pk: op.pk, sk: op.sk }, condition: when.eq("closeAcceptance", toDocument(op.closeAcceptance)) }])).applied) return false;
  const machineIds = [...new Set([a.original.workspace.machine?.machineId, a.original.run?.machineId].filter((id): id is string => id !== undefined))];
  if (!await provider.destroyRetained({ ...a.inspection, effectId: a.effectIds.terminate, machineIds })) return false;
  return saveCloseReceipt(deps, op, "terminate", "destroyed");
}

/** Admission and second-review adapters are idempotent on reservation ID; exceptions leave the receipt pending. */
export async function releaseCloseReservations(deps: TaskFlowDeps, op: AcceptedClose): Promise<boolean> {
  const a = op.closeAcceptance;
  if (a.receipts["reservations"] !== undefined) return true;
  for (const id of new Set([a.original.workspace.machineReservationId, a.original.admissionReservationId, a.original.run?.secondReviewPlan?.reservationId])) {
    if (id !== undefined) await deps.admission.release(id);
  }
  if (a.original.run !== undefined) {
    await deps.secondReview?.operationEnded(a.original.run);
    deps.onOperationEnded?.(a.original.run.id);
  }
  return saveCloseReceipt(deps, op, "reservations");
}

/** Closure, both operation completions, slot counters, pointer and audit have one commit point. */
export async function finalizeAcceptedClose(deps: TaskFlowDeps, op: AcceptedClose): Promise<boolean> {
  const a = op.closeAcceptance;
  if (a.phase === "closed" || a.phase === "complete") return true;
  if (a.receipts["account"] === undefined || a.receipts["terminate"] === undefined || a.receipts["reservations"] === undefined) return false;
  const task = await readTask(deps, a.taskId);
  if (task === undefined) return false;
  const at = iso(deps), location = await workspaceKeys(deps, op.workspaceId);
  const slot = task.releasedAt === undefined && await deps.store.get(chargeMarkerKey(task.charge, task.taskId)) !== undefined;
  const items: TransactItem[] = [
    ...await closeClaimItems(deps, op),
    { kind: "update", key: taskKey(task.taskId), condition: when.notExists("closedAt"), ops: [change.set("closedAt", at), change.set("updatedAt", at), ...(slot ? [change.set("releasedAt", at)] : [])] },
    { kind: "update", key: location.workspaceKey, ops: [change.set("status", "CLOSED"), change.set("activeOperationId", null), change.set("closedAt", at), change.set("updatedAt", at)] },
    { kind: "update", key: location.taskPointerKey(), condition: when.eq("closeOperationId", op.id), ops: [change.set("cancelledAt", at), change.remove("pendingPrompt"), change.remove("pendingWorkflowMode")] },
    ...(slot ? releaseItems(task.charge, task.taskId) : []),
    ...stageAudit(deps, { eventId: `task.closed:${task.taskId}`, actor: { type: "person", id: a.actorId }, action: "task.closed", subject: { type: "task", id: task.taskId }, details: { project: task.project } }),
  ];
  const run = a.original.run === undefined ? undefined : await readOperation(deps, op.workspaceId, a.original.run.id);
  if (run !== undefined) {
    if (!isTerminalStatus(run.status)) items.push({ kind: "update", key: location.operationKey(run.id), condition: when.and(when.eq("fence", run.fence), when.eq("status", run.status)), ops: [change.set("status", "INTERRUPTED"), change.set("error", "the task was closed"), change.set("updatedAt", at)] });
    items.push({ kind: "delete", key: runWatchKey(deps.companyId, op.workspaceId, run.id) });
  }
  const receipt = closeReceiptItem(op, { ...a, phase: "closed", receipts: { ...a.receipts, finish: iso(deps) } }, at);
  if (receipt.kind !== "update") return false;
  items.push({ ...receipt, ops: [...receipt.ops, change.set("status", "SUCCEEDED")] });
  return (await deps.store.transact(mergeCloseConditions(items))).applied;
}

export async function projectClosedTask(deps: TaskFlowDeps, op: AcceptedClose): Promise<boolean> {
  const task = await readTask(deps, op.closeAcceptance.taskId);
  if (task?.closedAt === undefined) return false;
  await deps.store.update({ key: taskIndexKey(task.developerId, task.createdAt, task.taskId), ops: [change.set("status", "CLOSED"), change.set("updatedAt", task.closedAt)], condition: when.present() });
  await projectClosedSession(deps, task);
  return saveCloseReceipt(deps, op, "projection");
}

/**
 * Unlike the best-effort legacy helper, pending host cleanup must keep this resume delivery retryable. A host that did not get its notice through (`"pending"`, or no answer within `TASK_END_WAIT_MS`) does not hold
 * the close: the marker stays in the due-time index and `reconcileTaskEnds` sends it again.
 */
export async function notifyClosedTask(deps: TaskFlowDeps, op: AcceptedClose): Promise<boolean> {
  const a = op.closeAcceptance, key = taskEndKey(a.taskId);
  if (deps.taskEnded !== undefined) {
    await deps.store.put({ item: taskEndRow(deps, a.taskId, "closed", a.acceptedAt), condition: when.absent() });
    if ((await deps.store.get(key))?.["notifiedAt"] === undefined) await within(callTaskEndSeam(deps, a.taskId), TASK_END_WAIT_MS);
  }
  return saveCloseReceipt(deps, op, "notify");
}

export async function recordClosedCost(deps: TaskFlowDeps, op: AcceptedClose): Promise<boolean> {
  const task = await readTask(deps, op.closeAcceptance.taskId);
  if (task?.closedAt === undefined) return false;
  await deps.onTaskClosed?.(task, task.closedAt);
  return saveCloseReceipt(deps, op, "cost", "complete");
}
