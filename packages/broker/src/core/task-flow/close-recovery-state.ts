import { mergeCloseConditions } from "./close-conditions.js";
import { OUTBOX_PENDING_INDEX, change, companyScoped, when, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import type { CloseAcceptance } from "./close-acceptance-record.js";
import { taskKey } from "./keys.js";
import { readOperation } from "./results.js";
import { readTask } from "./reads.js";
import { toDocument, type OperationRecord } from "./records.js";
import { workspaceKeys } from "./workspace-location.js";
import { iso } from "./support.js";

export type AcceptedClose = OperationRecord & { closeAcceptance: CloseAcceptance };

export async function readAcceptedClose(deps: TaskFlowDeps, workspaceId: string, operationId: string): Promise<AcceptedClose | undefined> {
  const op = await readOperation(deps, workspaceId, operationId);
  return op?.kind === "close" && op.closeAcceptance?.schemaVersion === 1 && op.workspaceId === workspaceId ? op as AcceptedClose : undefined;
}

/** Only the immutable original run gets the accounting-only old-fence exception. */
export async function acceptedCloseForRun(deps: TaskFlowDeps, run: OperationRecord): Promise<AcceptedClose | undefined> {
  const location = await workspaceKeys(deps, run.workspaceId);
  const pointer = await deps.store.get(location.taskPointerKey());
  if (typeof pointer?.["taskId"] !== "string") return undefined;
  const task = await readTask(deps, pointer["taskId"]);
  if (task?.closeOperationId === undefined || task.companyId !== deps.companyId || task.workspaceId !== run.workspaceId) return undefined;
  const op = await readAcceptedClose(deps, run.workspaceId, task.closeOperationId);
  const original = op?.closeAcceptance.original.run;
  return original?.id === run.id && original.fence === run.fence && original.companyId === run.companyId ? op : undefined;
}

/** Every phase receipt is conditional on this accepted claim, including the inspection identity. */
export async function closeClaimItems(deps: TaskFlowDeps, op: AcceptedClose): Promise<TransactItem[]> {
  const a = op.closeAcceptance, location = await workspaceKeys(deps, op.workspaceId);
  const closed = a.phase === "closed" || a.phase === "complete";
  return [
    { kind: "check", key: taskKey(a.taskId), condition: when.and(when.eq("companyId", deps.companyId), when.eq("workspaceId", op.workspaceId), when.eq("closeOperationId", op.id)) },
    { kind: "check", key: location.workspaceKey, condition: when.and(when.eq("companyId", deps.companyId), when.eq("status", closed ? "CLOSED" : "CLOSING"), when.eq("activeOperationId", closed ? null : op.id), when.eq("fence", op.fence), when.eq("ownerKey", a.original.workspace.ownerKey), a.original.workspace.machine === undefined ? when.notExists("machine") : when.eq("machine", toDocument(a.original.workspace.machine))) },
    { kind: "check", key: location.taskPointerKey(), condition: when.and(when.or(when.notExists("companyId"), when.eq("companyId", deps.companyId)), when.eq("taskId", a.taskId), when.eq("closeOperationId", op.id)) },
    { kind: "check", key: location.operationKey(a.inspection.operationId), condition: when.and(when.eq("companyId", deps.companyId), when.eq("status", "SUCCEEDED"), when.eq("fence", a.inspection.fence), when.eq("result.closeInspection", toDocument(a.inspection))) },
  ];
}

export function closeReceiptItem(op: AcceptedClose, next: CloseAcceptance, at: string): TransactItem {
  return { kind: "update", key: { pk: op.pk, sk: op.sk }, condition: when.and(when.eq("companyId", op.companyId), when.eq("closeAcceptance", toDocument(op.closeAcceptance))), ops: [change.set("closeAcceptance", toDocument(next)), change.set("updatedAt", at)] };
}

export async function saveCloseReceipt(deps: TaskFlowDeps, op: AcceptedClose, receipt: string, phase = op.closeAcceptance.phase, extra: TransactItem[] = []): Promise<boolean> {
  const at = iso(deps);
  return (await deps.store.transact(mergeCloseConditions([
    ...await closeClaimItems(deps, op), ...extra,
    closeReceiptItem(op, { ...op.closeAcceptance, phase, receipts: { ...op.closeAcceptance.receipts, [receipt]: at } }, at),
  ]))).applied;
}

/** Called AFTER queue acknowledgement. A crash before this commit leaves the timed outbox backstop alive. */
export async function closeDeliveryReceipt(deps: TaskFlowDeps, op: AcceptedClose): Promise<void> {
  if (op.closeAcceptance.receipts["delivery"] !== undefined) return;
  await saveCloseReceipt(deps, op, "delivery", "complete", [{
    kind: "update", key: { pk: companyScoped(deps.companyId, `OUTBOX#${op.id}`), sk: "OUTBOX" },
    condition: when.and(when.eq("companyId", deps.companyId), when.eq("body.operationId", op.id)),
    ops: [change.set("status", "QUEUED"), change.set(deps.store.ttlAttribute ?? "expiresAt", Math.floor((deps.now?.() ?? new Date()).getTime() / 1000) + 7 * 86400), change.remove(OUTBOX_PENDING_INDEX.partitionAttribute), change.remove(OUTBOX_PENDING_INDEX.sortAttribute!)],
  }]);
}

/** After one day held, retire the timed redrive before the final delivery goes to the existing alarmed DLQ.
 * The immutable acceptance and workspace claim remain intact for an operator's explicit redrive.
 */
export async function retireCloseDelivery(deps: TaskFlowDeps, op: OperationRecord): Promise<void> {
  const acceptedAt = op.closeAcceptance?.acceptedAt;
  const now = deps.now?.() ?? new Date();
  if (acceptedAt === undefined || now.getTime() - Date.parse(acceptedAt) < 24 * 3600 * 1000) return;
  await deps.store.update({
    key: { pk: companyScoped(deps.companyId, `OUTBOX#${op.id}`), sk: "OUTBOX" },
    condition: when.and(when.eq("companyId", deps.companyId), when.eq("body.operationId", op.id), when.eq("status", "PENDING")),
    ops: [change.set("status", "DEAD"), change.set(deps.store.ttlAttribute ?? "expiresAt", Math.floor(now.getTime() / 1000) + 7 * 86400), change.remove(OUTBOX_PENDING_INDEX.partitionAttribute), change.remove(OUTBOX_PENDING_INDEX.sortAttribute!)],
  });
}
