import { readTask } from "./reads.js";
import { OUTBOX_PENDING_INDEX, change, companyScoped, when, type TransactItem, type Queue, type ReceivedMessage } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { toDocument, type OperationRecord, type WorkspaceRecord } from "./records.js";
import { workspaceKeys } from "./workspace-location.js";
import { closeOperationId } from "./close-acceptance-record.js";
import { dispatchQueueName, hashJson, iso } from "./support.js";
import { prepareCloseInspection } from "./close-inspection.js";
import { readWorkspace } from "./stage-machine.js";

/** Pure transaction planning at a quiescent lifecycle boundary, never called by GET/confirmation planning. */
export async function planClosePreparation(deps: TaskFlowDeps, workspace: WorkspaceRecord, expected: Pick<WorkspaceRecord, "status" | "activeOperationId"> = workspace, options: { wake?: boolean } = {}): Promise<TransactItem[]> {
  // `wake`: the instance is gone (the close's check asked for it): the preparation starts it, so the machine need not be READY now.
  if (workspace.legacyCloseClaim !== undefined || workspace.status !== "READY" || workspace.activeOperationId !== null || workspace.machine === undefined || (options.wake !== true && !await deps.closeInspection?.ready?.(workspace.id))) return [];
  const location = await workspaceKeys(deps, workspace.id), at = iso(deps), fence = workspace.fence + 1;
  const id = closeOperationId(deps.companyId, workspace.id, `preflight:${fence}`);
  const operation: OperationRecord = { ...location.operationKey(id), entityType: "OPERATION", companyId: deps.companyId, orgId: deps.companyId, id, workspaceId: workspace.id,
    kind: "close", status: "ACCEPTED", requestId: id, payloadHash: hashJson({ kind: "close-preflight", workspaceId: workspace.id, fence }), fence,
    eventSequence: 0, createdAt: at, updatedAt: at, closePreflight: { schemaVersion: 1 }, dispatch: { kind: "task", projectRevision: workspace.projectRevision, payload: {} } };
  return [
    { kind: "update", key: location.workspaceKey, condition: when.and(when.notExists("legacyCloseClaim"), when.eq("companyId", deps.companyId), when.eq("status", expected.status), when.eq("activeOperationId", expected.activeOperationId), when.eq("fence", workspace.fence)), ops: [change.set("status", "READY"), change.set("activeOperationId", id), change.set("fence", fence), change.set("updatedAt", at)] },
    { kind: "put", item: toDocument(operation), condition: when.absent() },
    // The existing durable close delivery/backstop is also used while preparation is pending.
    deps.outbox.stage({ id, companyId: deps.companyId, queue: dispatchQueueName(deps), attributes: { kind: "close" }, body: { v: 1, companyId: deps.companyId, workspaceId: workspace.id, operationId: id, resumeClose: true } }),
  ];
}

export function preparationDeliveryItem(deps: TaskFlowDeps, op: OperationRecord, dead = false): TransactItem {
  return { kind: "update", key: { pk: companyScoped(deps.companyId, `OUTBOX#${op.id}`), sk: "OUTBOX" }, condition: when.and(when.eq("companyId", deps.companyId), when.eq("body.operationId", op.id)),
    ops: [change.set("status", dead ? "DEAD" : "QUEUED"), change.set(deps.store.ttlAttribute ?? "expiresAt", Math.floor((deps.now?.() ?? new Date()).getTime() / 1000) + 7 * 86400), change.remove(OUTBOX_PENDING_INDEX.partitionAttribute), change.remove(OUTBOX_PENDING_INDEX.sortAttribute!)] };
}

export async function runClosePreparation(deps: TaskFlowDeps, queue: Queue, message: ReceivedMessage, op: OperationRecord): Promise<"delivered" | "retried" | "failed"> {
  if (op.status === "SUCCEEDED" || op.status === "FAILED" || op.status === "INTERRUPTED") { await queue.ack(message.receiptHandle); return "delivered"; }
  const workspace = await readWorkspace(deps, op.workspaceId), location = await workspaceKeys(deps, op.workspaceId);
  const owned = workspace !== undefined && workspace.status === "READY" && workspace.fence === op.fence && workspace.activeOperationId === op.id;
  // A machine whose instance is gone is started first (the check of a stopped task): the preparation waits for it, and gives up (releasing the workspace) only when the budget runs out.
  const awake = owned && op.closePreflight?.target === undefined ? await wakeForCheck(deps, op.workspaceId) : "ready";
  if (awake === "waking") return retryPreparation(deps, queue, message, op, WAKE_ATTEMPTS);
  // Before a target is captured, unsupported workers can safely retain legacy behavior. Afterwards an intent may exist: hold it.
  if (!owned || (op.closePreflight?.target === undefined && !await deps.closeInspection?.ready?.(op.workspaceId, true))) {
    const items: TransactItem[] = [{ kind: "update", key: location.operationKey(op.id), condition: when.and(when.eq("status", op.status), when.eq("closePreflight", toDocument(op.closePreflight!))), ops: [change.set("status", "INTERRUPTED")] }, preparationDeliveryItem(deps, op)];
    if (owned) items.push({ kind: "update", key: location.workspaceKey, condition: when.and(when.eq("fence", op.fence), when.eq("activeOperationId", op.id)), ops: [change.set("activeOperationId", null)] });
    if ((await deps.store.transact(items)).applied) { await queue.ack(message.receiptHandle); return "failed"; }
  } else {
    if (op.status === "ACCEPTED") await deps.store.update({ key: location.operationKey(op.id), condition: when.and(when.eq("status", "ACCEPTED"), when.eq("fence", op.fence)), ops: [change.set("status", "RUNNING")] });
    if (await prepareCloseInspection(deps, op.workspaceId, op.id)) { await queue.ack(message.receiptHandle); return "delivered"; }
  }
  return retryPreparation(deps, queue, message, op);
}

/** Receives a preparation gets while it waits for a woken machine (30 s apart): above a measured cold start of the machine. */
const WAKE_ATTEMPTS = 20;

/** Starts the machine of a workspace whose instance is gone; `ready` when nothing needed starting or it is up now. A provider without `wake` (or that throws) leaves the old behaviour. */
async function wakeForCheck(deps: TaskFlowDeps, workspaceId: string): Promise<"ready" | "waking"> {
  const provider = deps.closeInspection;
  if (provider?.wake === undefined) return "ready";
  try { return (await provider.wake(workspaceId)) === "waking" ? "waking" : "ready"; } catch { return "ready"; }
}

async function retryPreparation(deps: TaskFlowDeps, queue: Queue, message: ReceivedMessage, op: OperationRecord, limit = 5): Promise<"retried" | "failed"> {
  if (message.receiveCount > limit) {
    // No retention target was captured: nothing is held for a person to decide, so the hold on the workspace is released (the person presses Close again for a new check). A captured target is kept held.
    if (op.closePreflight?.target === undefined && await releasePreparation(deps, op)) { await queue.ack(message.receiptHandle); return "failed"; }
    if ((deps.now?.() ?? new Date()).getTime() - Date.parse(op.createdAt) >= 86400_000) await deps.store.transact([preparationDeliveryItem(deps, op, true)]);
    await queue.deadLetter(message.receiptHandle, "close_preparation_pending");
    return "retried";
  }
  await queue.changeVisibility(message.receiptHandle, 30);
  return "retried";
}

/** Ends a preparation that captured no target and gives the workspace back (the operation INTERRUPTED, the hold cleared, its delivery done). False when it moved meanwhile. */
async function releasePreparation(deps: TaskFlowDeps, op: OperationRecord): Promise<boolean> {
  const location = await workspaceKeys(deps, op.workspaceId);
  return (await deps.store.transact([
    { kind: "update", key: location.operationKey(op.id), condition: when.and(when.eq("kind", "close"), when.eq("fence", op.fence), when.notExists("closePreflight.target"), when.or(when.eq("status", "ACCEPTED"), when.eq("status", "RUNNING"))), ops: [change.set("status", "INTERRUPTED")] },
    { kind: "update", key: location.workspaceKey, condition: when.and(when.eq("companyId", deps.companyId), when.eq("fence", op.fence), when.eq("activeOperationId", op.id)), ops: [change.set("activeOperationId", null)] },
    preparationDeliveryItem(deps, op),
  ])).applied;
}

/** Plain runs have no workflow follow-up; retention and their terminal workspace release commit together. */
export async function plainClosePreparationItems(deps: TaskFlowDeps, workspace: WorkspaceRecord, operation: OperationRecord): Promise<TransactItem[]> {
  if (operation.kind === "prepare" || operation.closePreflight !== undefined || operation.closeAcceptance !== undefined) return [];
  const pointer = await deps.store.get((await workspaceKeys(deps, workspace.id)).taskPointerKey());
  const task = typeof pointer?.["taskId"] === "string" ? await readTask(deps, pointer["taskId"]) : undefined;
  if (task === undefined || task.workflow !== undefined || task.purpose !== undefined || task.closedAt !== undefined || task.closeOperationId !== undefined) return [];
  return planClosePreparation(deps, { ...workspace, status: "READY", activeOperationId: null }, workspace);
}
