import { change, when, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { dispatchQueueName, iso, log } from "./support.js";
import { reportsUsage } from "./money-stop.js";
import { isTerminalStatus, readOperation } from "./results.js";
import { workspaceKeys } from "./workspace-location.js";
import { closeClaimItems, closeReceiptItem, saveCloseReceipt, type AcceptedClose } from "./close-recovery-state.js";
import type { CloseAcceptance } from "./close-acceptance-record.js";

/** The cancel intent, run status and phase receipt commit together. Its stable outbox ID survives a crash before relay. */
export async function flushAcceptedClose(deps: TaskFlowDeps, op: AcceptedClose): Promise<boolean> {
  const a = op.closeAcceptance;
  if (a.receipts["flush"] !== undefined) return relayCloseFlush(deps, op);
  const run = a.original.run === undefined ? undefined : await readOperation(deps, op.workspaceId, a.original.run.id);
  if (a.original.run !== undefined && (run === undefined || run.fence !== a.original.run.fence)) return false;
  const items: TransactItem[] = [];
  if (deps.moneyStop !== undefined && run !== undefined && reportsUsage(run) && !isTerminalStatus(run.status)) {
    const location = await workspaceKeys(deps, op.workspaceId);
    items.push(
      { kind: "update", key: location.operationKey(run.id), condition: when.and(when.eq("fence", run.fence), when.eq("status", run.status)), ops: [change.set("status", "CANCEL_REQUESTED"), change.set("updatedAt", iso(deps))] },
      deps.outbox.stage({ id: a.effectIds.cancel, companyId: deps.companyId, queue: dispatchQueueName(deps), attributes: { kind: "cancel" }, body: { v: 1, companyId: deps.companyId, workspaceId: op.workspaceId, operationId: run.id, cancel: a.effectIds.cancel } }),
    );
  }
  if (!await saveCloseReceipt(deps, op, "flush", "flushing", items)) return false;
  return relayCloseFlush(deps, op);
}

/** Relay only after the durable flush commit; exact replay also repairs a crash before this hand-over. */
async function relayCloseFlush(deps: TaskFlowDeps, op: AcceptedClose): Promise<boolean> {
  await deps.outbox.relay({ companyId: deps.companyId, ids: [op.closeAcceptance.effectIds.cancel, op.id] })
    .catch((error: unknown) => log(deps, { event: "task_flow.relay_failed", error: error instanceof Error ? error.name : "unknown" }));
  return true;
}

/** Freeze the money outcome with the hold transaction; a retry cannot recompute a smaller/larger balance. */
export async function planCloseAccounting(deps: TaskFlowDeps, op: AcceptedClose): Promise<boolean> {
  const a = op.closeAcceptance;
  if (a.accounting !== undefined) return true;
  const run = a.original.run === undefined ? undefined : await readOperation(deps, op.workspaceId, a.original.run.id);
  if (a.original.run !== undefined && (run === undefined || run.fence !== a.original.run.fence)) return false;
  const at = iso(deps);
  let accounting: NonNullable<CloseAcceptance["accounting"]>, items: readonly TransactItem[] = [];
  if (deps.moneyStop === undefined || run === undefined || !reportsUsage(run)) accounting = { mode: "none" };
  else if (isTerminalStatus(run.status) && run.status !== "INTERRUPTED" && run.usageUnflushed !== true) accounting = { mode: "flushed" };
  else {
    if (Date.parse(at) < Date.parse(a.flushDeadline) || deps.moneyStop.planUnflushed === undefined || deps.moneyStop.applyUnflushed === undefined) return false;
    const decision = await deps.moneyStop.planUnflushed(a.original.admissionReservationId, { operationId: run.id, taskId: a.taskId });
    accounting = { mode: "unflushed", plan: decision.plan }; items = decision.items;
  }
  const location = await workspaceKeys(deps, op.workspaceId);
  return (await deps.store.transact([
    ...await closeClaimItems(deps, op), ...items,
    ...(run === undefined ? [] : [{ kind: "check" as const, key: location.operationKey(run.id), condition: when.and(when.eq("status", run.status), when.eq("fence", run.fence)) }]),
    closeReceiptItem(op, { ...a, accounting }, at),
  ])).applied;
}

export async function accountAcceptedClose(deps: TaskFlowDeps, op: AcceptedClose): Promise<boolean> {
  const a = op.closeAcceptance;
  if (a.receipts["account"] !== undefined) return true;
  if (a.accounting === undefined) return false;
  const items: TransactItem[] = [];
  if (a.accounting.mode === "unflushed") {
    if (a.original.run === undefined || deps.moneyStop?.applyUnflushed === undefined) return false;
    await deps.moneyStop.applyUnflushed(a.accounting.plan, { operationId: a.original.run.id, taskId: a.taskId });
    items.push({ kind: "update", key: (await workspaceKeys(deps, op.workspaceId)).operationKey(a.original.run.id), condition: when.eq("fence", a.original.run.fence), ops: [change.set("usageUnflushed", true)] });
  }
  return saveCloseReceipt(deps, op, "account", "accounted", items);
}
