import { chargeValue, parseChargeReceiptV1, parseTaskMoneyV1, type DocumentStore, type MoneyField, type TaskMoneyV1 } from "@agentx/contracts";
import { costPartition } from "./ledger.js";
import { workspaceKey } from "../task-flow/keys.js";
import { workspaceOperations } from "../task-flow/reads.js";
import type { TaskRecord } from "../task-flow/records.js";

const available = <T>(value: T): MoneyField<T> => ({ state: "available", value });
const unknown = (reason: "not_measured" | "unreadable" | "restricted" = "not_measured"): MoneyField<never> => ({ state: "unavailable", reason });
const natural = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** One company-scoped read. Access is checked by the caller before this service is entered.
 * Existing engine holds are admission/planning room, not financial reservations. The pilot
 * has no authenticated gateway coverage/headroom feed yet: hosted money remains partial.
 */
export async function readTaskMoney(input: {
  store: DocumentStore; companyId: string; task: Pick<TaskRecord, "taskId" | "companyId" | "workspaceId" | "updatedAt" | "createdAt" | "closedAt" | "workflow"> & { status?: string };
  hosted?: boolean; revealPayer?: boolean; taskMaximumMicros?: number;
}): Promise<TaskMoneyV1> {
  const { task, store, companyId } = input;
  const terminal = task.closedAt !== undefined || task.workflow?.state === "COMPLETE" || ["CLOSED", "CANCELLED"].includes(task.status ?? "");
  const base: TaskMoneyV1 = {
    version: 1, taskId: task.taskId, currency: "USD", revision: 0, asOf: task.updatedAt,
    state: "unavailable", spentMicros: unknown(), finalMicros: unknown(), estimatedMicros: unknown(), heldMicros: unknown(), unpricedCalls: unknown(), awaitingUsageCalls: unknown(), awaitingUsageMicros: unknown(), payer: unknown("restricted"), allocations: [],
    coverage: { expectedCalls: unknown(), finalCalls: 0, estimatedCalls: 0, awaitingUsageCalls: 0, incompatibleCurrencyCalls: 0 },
    stop: { taskMaximumMicros: natural(input.taskMaximumMicros) ? available(input.taskMaximumMicros) : unknown(), nextCallAvailableMicros: unknown(), limits: [], coverage: "partial", bindingScope: unknown() },
    terminal, finality: "unavailable",
  };
  if (task.companyId !== companyId) return base;
  let unreadable = structuredClone(base);
  unreadable.spentMicros = unknown("unreadable");
  try {
    const pk = costPartition(companyId, task.taskId);
    const total = await store.get({ pk, sk: "TOTAL" });
    if (natural(total?.["revision"])) base.revision = total["revision"];
    if (typeof total?.["updatedAt"] === "string" && !Number.isNaN(Date.parse(total["updatedAt"])) && new Date(total["updatedAt"]).toISOString() === total["updatedAt"]) base.asOf = total["updatedAt"];
    unreadable = structuredClone(base);
    unreadable.spentMicros = unknown("unreadable");
    if (total !== undefined && (total["companyId"] !== undefined && total["companyId"] !== companyId || total["taskId"] !== undefined && total["taskId"] !== task.taskId || total["revision"] !== undefined && !natural(total["revision"]))) return unreadable;
    const entries = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const read = await store.query({ pk, sk: { op: "beginsWith", prefix: "ENTRY#" }, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
      entries.push(...read.items); cursor = read.cursor;
      if (cursor === undefined) break;
    }
    if (cursor !== undefined) return unreadable;
    if (entries.some(entry => entry["companyId"] !== undefined && entry["companyId"] !== companyId || entry["taskId"] !== undefined && entry["taskId"] !== task.taskId)) return unreadable;
    const after = await store.get({ pk, sk: "TOTAL" });
    if (JSON.stringify(total) !== JSON.stringify(after)) return base;
    const workspace = await store.get(workspaceKey(companyId, task.workspaceId));
    const operations = workspace === undefined ? undefined : await workspaceOperations({ store, companyId }, task.workspaceId);
    // Only a terminal, idle local workspace with no operation history proves no spend.
    // Non-task stages may call models too; completion alone does not prove booking.
    const provenEmpty = input.hosted !== true && terminal && workspace?.["companyId"] === companyId && workspace["activeOperationId"] === null && operations?.length === 0 && entries.length === 0;
    if (entries.length === 0 && !provenEmpty) return base;
    let final = 0, estimated = 0, awaiting = 0, unpriced = 0, unknownAwaiting = false;
    const receipts = entries.flatMap(entry => {
      const receipt = parseChargeReceiptV1(entry["receipt"]);
      return receipt === undefined ? [] : [receipt];
    });
    if (receipts.some(r => r.companyId !== companyId || r.taskId !== task.taskId)) return base;
    const receiptOperations = new Set(receipts.map(r => r.operationId));
    const seen = new Set<string>();
    for (const entry of entries) {
      const receipt = parseChargeReceiptV1(entry["receipt"]);
      if (entry["receipt"] !== undefined && receipt === undefined) return base;
      if (receipt !== undefined) {
        const id = JSON.stringify([receipt.issuer, receipt.callId]);
        if (seen.has(id)) return base; // conflicting duplicate representations cannot be summed
        seen.add(id);
        const amount = chargeValue(receipt.amountMicros);
        if (receipt.status === "final") { base.coverage.finalCalls++; final += amount ?? 0; }
        else { base.coverage.estimatedCalls++; estimated += amount ?? 0; }
        if (receipt.status === "awaiting_usage") { base.coverage.awaitingUsageCalls++; awaiting += amount ?? 0; unknownAwaiting ||= amount === undefined; }
        if (amount === undefined) unpriced++;
        if (input.revealPayer === true && base.allocations.length < 100) base.allocations.push({ payer: available(receipt.payer), usageValueMicros: receipt.amountMicros, rovaraChargeMicros: receipt.billableMicros, billing: receipt.billing });
      } else {
        // A worker aggregate and gateway receipts can describe the same calls. Prefer receipts;
        // leave coverage partial rather than adding that aggregate again.
        if ([...receiptOperations].some(id => typeof entry["entryId"] === "string" && (entry["entryId"].startsWith(`usage:${id}:`) || entry["entryId"].startsWith(`usage-checkpoint:${id}:`)))) continue;
        const calls = natural(entry["usageMissingCalls"]) && entry["usageMissingCalls"] > 0 ? entry["usageMissingCalls"] : 1;
        base.coverage.estimatedCalls += calls;
        const amount = entry["currency"] === "USD" && natural(entry["micros"]) ? entry["micros"] : undefined;
        estimated += amount ?? 0;
        if (entry["currency"] !== undefined && entry["currency"] !== "USD") base.coverage.incompatibleCurrencyCalls += calls;
        if (amount === undefined) unpriced += calls;
        if (entry["chargeStatus"] === "awaiting_usage") { base.coverage.awaitingUsageCalls += calls; awaiting += amount ?? 0; unknownAwaiting ||= amount === undefined; }
      }
    }
    // All unknown-value calls means unavailable money, never a fabricated exact zero.
    const knownCalls = base.coverage.finalCalls + base.coverage.estimatedCalls - unpriced;
    const hasAmount = provenEmpty || knownCalls > 0;
    base.spentMicros = hasAmount ? available(final + estimated) : unknown();
    base.finalMicros = hasAmount ? available(final) : unknown();
    base.estimatedMicros = hasAmount ? available(estimated) : unknown();
    base.heldMicros = input.hosted === true ? unknown() : available(0);
    base.unpricedCalls = available(unpriced);
    base.awaitingUsageCalls = available(base.coverage.awaitingUsageCalls);
    base.awaitingUsageMicros = unknownAwaiting || !hasAmount ? unknown() : available(awaiting);
    if (receipts.length > 100) base.allocations = [];
    if (base.allocations.length > 0) {
      const payers = base.allocations.flatMap(a => a.payer.state === "available" ? [a.payer.value] : []);
      base.payer = payers.every(p => JSON.stringify(p) === JSON.stringify(payers[0])) ? available(payers[0]!) : available({ kind: "mixed", name: "Multiple payers" });
    }
    base.state = provenEmpty ? "current" : hasAmount ? "partial" : "unavailable";
    if (provenEmpty) { base.coverage.expectedCalls = available(0); base.stop.coverage = "complete"; }
    base.finality = provenEmpty && terminal ? "final" : hasAmount ? "provisional" : "unavailable";
    return parseTaskMoneyV1(base) ?? unreadable;
  } catch {
    return unreadable;
  }
}
