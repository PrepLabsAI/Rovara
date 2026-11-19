// Receipt replacement uses the existing task entry, company entry-once guard, task total and original company-day row.
// The immutable ADJUST row and all accounting deltas commit together; adapter pricing is never consulted for a receipt.
import { createHash } from "node:crypto";
import { chargeReceiptContent, chargeValue, companyScoped, parseChargeReceiptV1, when, type ApplyChargeResult, type ChargeReceiptV1, type DocumentStore, type JsonValue, type StoredDocument, type TransactItem, type UpdateOp } from "@agentx/contracts";
import { companyDayKey, costPartition, taskCostFromTotal, type LedgerHolds } from "./ledger.js";

import { estimatePathOf, recordRunCost, runCostInputOf } from "./estimate.js";

const value = (r: ChargeReceiptV1 | undefined): number => r === undefined ? 0 : chargeValue(r.amountMicros) ?? 0;
const unpriced = (r: ChargeReceiptV1 | undefined): number => r?.amountMicros.state === "unavailable" ? 1 : 0;
const portion = (r: ChargeReceiptV1 | undefined, status: "final" | "estimated" | "awaiting_usage"): number => r !== undefined && (status === "estimated" ? r.status !== "final" : r.status === status) ? value(r) : 0;
const tokens = (r: ChargeReceiptV1 | undefined): number[] => {
  const u = r === undefined ? undefined : chargeValue(r.usage);
  return u === undefined ? [0, 0, 0, 0] : [u.input, u.output, u.cacheRead, u.cacheWrite5m + u.cacheWrite1h + u.cacheWriteUnknown];
};
/** Financial corrections cannot rewrite the original admission identity or periods. */
const identity = (r: ChargeReceiptV1): string => chargeReceiptContent({ issuer: r.issuer, companyId: r.companyId, project: r.project, taskId: r.taskId, operationId: r.operationId, callId: r.callId, originalReservationMicros: r.originalReservationMicros, model: r.model, source: r.source, payer: r.payer, requesterId: r.requesterId, billing: r.billing, occurredAt: r.occurredAt, accountingDay: r.accountingDay, accountingMonth: r.accountingMonth });
const snapshot = (row: StoredDocument | undefined) => row === undefined ? when.absent() : when.eq("revision", row["revision"] ?? 0);

export async function applyChargeReceipt(deps: { store: DocumentStore; now?: () => Date; holds?: LedgerHolds }, input: unknown): Promise<ApplyChargeResult> {
  const r = parseChargeReceiptV1(input);
  if (r === undefined) throw new Error("invalid charge receipt");
  const id = `charge:${createHash("sha256").update(JSON.stringify([r.issuer, r.companyId, r.callId])).digest("hex")}`;
  const pk = costPartition(r.companyId, r.taskId);
  const onceKey = { pk: companyScoped(r.companyId, "COST_ENTRY"), sk: id };
  const entryKey = { pk, sk: `ENTRY#usage-charge:${r.operationId}:${id}` };
  const content = chargeReceiptContent(r);
  const refreshHistory = async (): Promise<void> => {
    const task = await deps.store.get({ pk: `DEVTASK#${r.taskId}`, sk: "META" });
    if (task === undefined || (task["companyId"] ?? task["orgId"]) !== r.companyId || typeof task["project"] !== "string" || typeof task["runCostRecordedAt"] !== "string") return;
    const cost = taskCostFromTotal(r.taskId, await deps.store.get({ pk, sk: "TOTAL" }));
    const workflow = task["workflow"] as { path?: string } | undefined;
    await recordRunCost({ store: deps.store }, { orgId: r.companyId, project: task["project"], taskId: r.taskId, path: estimatePathOf({ ...(workflow === undefined ? {} : { workflow }) }), endedAt: task["runCostRecordedAt"], ...(typeof task["purpose"] === "string" ? { purpose: task["purpose"] } : {}), ...runCostInputOf(cost) });
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const earlier = await deps.store.get(onceKey);
    const old = earlier === undefined ? undefined : parseChargeReceiptV1(earlier["receipt"]);
    if (earlier !== undefined && old === undefined) throw new Error("unreadable charge revision");
    if (old !== undefined) {
      if (identity(old) !== identity(r)) throw new Error("charge identity changed");
      if (old.revision === r.revision) {
        if (chargeReceiptContent(old) !== content) throw new Error("conflicting charge revision");
        await refreshHistory();
        return { callId: r.callId, appliedRevision: old.revision, result: "duplicate", deltaMicros: 0 };
      }
      if (old.revision > r.revision) {
        const prior = await deps.store.get({ pk, sk: `ADJUST#${id}#${r.revision}` });
        if (prior !== undefined && chargeReceiptContent(prior["receipt"]) !== content) throw new Error("conflicting charge revision");
        await refreshHistory();
        return { callId: r.callId, appliedRevision: old.revision, result: "older", deltaMicros: 0 };
      }
    }
    const totalKey = { pk, sk: "TOTAL" }, dayKey = companyDayKey(r.companyId, r.accountingDay);
    const [total, day] = await Promise.all([deps.store.get(totalKey), deps.store.get(dayKey)]);
    if (total?.["currency"] !== undefined && total["currency"] !== "USD") throw new Error("incompatible charge currency");
    const delta = value(r) - value(old), first = old === undefined;
    const oldTokens = tokens(old), newTokens = tokens(r);
    const deltas: Record<string, number> = {
      micros: delta, entries: first ? 1 : 0, unpricedEntries: unpriced(r) - unpriced(old), chargeEntries: first ? 1 : 0,
      finalMicros: portion(r, "final") - portion(old, "final"), estimatedMicros: portion(r, "estimated") - portion(old, "estimated"), awaitingUsageMicros: portion(r, "awaiting_usage") - portion(old, "awaiting_usage"),
      awaitingUsageCalls: Number(r.status === "awaiting_usage") - Number(old?.status === "awaiting_usage"),
      provisionalCalls: Number(r.status !== "final") - Number(old !== undefined && old.status !== "final"),
      ...Object.fromEntries(["tokensInput", "tokensOutput", "tokensCacheRead", "tokensCacheWrite"].map((k, i) => [k, newTokens[i]! - oldTokens[i]!])),
    };
    const checked = (row: StoredDocument | undefined, key: string, diff: number): number => {
      const before = row?.[key] ?? 0;
      if (typeof before !== "number" || !Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(before + diff) || before + diff < 0) throw new Error("charge accounting unavailable");
      return before + diff;
    };
    for (const [k, diff] of Object.entries(deltas)) checked(total, k, diff);
    checked(day, "usdMicros", delta); checked(day, "uncountedEntries", unpriced(r) - unpriced(old));
    const drawn = first && deps.holds !== undefined ? await deps.holds.drawdown({ companyId: r.companyId, taskId: r.taskId, total, usdMicros: value(r) }) : undefined;
    const sameDay = drawn?.day?.day === r.accountingDay ? drawn.day.micros : 0;
    checked(day, "loadMicros", delta - sameDay);
    const ops: UpdateOp[] = Object.entries(deltas).map(([k, amount]) => ({ op: "add", path: [k], amount }));
    const at = (deps.now?.() ?? new Date()).toISOString();
    const receiptJson = r as unknown as JsonValue;
    const entry: StoredDocument = { ...entryKey, entityType: "COST_ENTRY", companyId: r.companyId, taskId: r.taskId, entryId: id, operationId: r.operationId, at: r.occurredAt, provider: r.model.provider, modelId: r.model.modelId, revision: r.revision, receipt: receiptJson, chargeStatus: r.status, reason: r.reason, source: "unknown", currency: "USD", ...(r.amountMicros.state === "available" ? { micros: r.amountMicros.value } : {}), ...Object.fromEntries(["tokensInput", "tokensOutput", "tokensCacheRead", "tokensCacheWrite"].map((k, i) => [k, newTokens[i]!])) };
    const actions: TransactItem[] = [
      ...(drawn?.items ?? []),
      ...(drawn?.day !== undefined && drawn.day.day !== r.accountingDay && drawn.day.micros > 0 ? [{ kind: "update" as const, key: companyDayKey(r.companyId, drawn.day.day), ops: [{ op: "add" as const, path: ["reservedMicros"] as const, amount: -drawn.day.micros }, { op: "add" as const, path: ["loadMicros"] as const, amount: -drawn.day.micros }], condition: when.present() }] : []),
      { kind: "put", item: entry, condition: earlier === undefined ? when.absent() : when.eq("revision", old!.revision) },
      { kind: "put", item: { ...onceKey, entityType: "COST_ENTRY_ONCE", taskId: r.taskId, revision: r.revision, receipt: receiptJson }, condition: snapshot(earlier) },
      { kind: "put", item: { pk, sk: `ADJUST#${id}#${r.revision}`, entityType: "COST_ADJUSTMENT", receipt: receiptJson, deltaMicros: delta, recordedAt: at }, condition: when.absent() },
      { kind: "update", key: totalKey, condition: total === undefined ? when.absent() : when.and(...["revision", "currency", ...Object.keys(deltas)].map(k => total[k] === undefined ? when.notExists(k) : when.eq(k, total[k]))), ops: [...ops, { op: "set", path: ["revision"], value: Number(total?.["revision"] ?? 0) + 1 }, { op: "setIfAbsent", path: ["entityType"], value: "COST_TOTAL" }, { op: "setIfAbsent", path: ["taskId"], value: r.taskId }, { op: "setIfAbsent", path: ["companyId"], value: r.companyId }, { op: "setIfAbsent", path: ["currency"], value: "USD" }, { op: "set", path: ["updatedAt"], value: at }] },
      { kind: "update", key: dayKey, condition: day === undefined ? when.absent() : when.and(when.eq("usdMicros", day["usdMicros"] ?? 0), when.eq("entries", day["entries"] ?? 0), when.eq("uncountedEntries", day["uncountedEntries"] ?? 0)), ops: [
        { op: "setIfAbsent", path: ["entityType"], value: "COST_DAY" }, { op: "setIfAbsent", path: ["companyId"], value: r.companyId }, { op: "setIfAbsent", path: ["day"], value: r.accountingDay },
        { op: "add", path: ["usdMicros"], amount: delta }, { op: "add", path: ["entries"], amount: first ? 1 : 0 }, { op: "add", path: ["uncountedEntries"], amount: unpriced(r) - unpriced(old) }, { op: "add", path: ["loadMicros"], amount: delta - sameDay },
        ...(sameDay > 0 ? [{ op: "add" as const, path: ["reservedMicros"] as const, amount: -sameDay }] : []),
      ] },
    ];
    if ((await deps.store.transact(actions)).applied) {
      await refreshHistory();
      return { callId: r.callId, appliedRevision: r.revision, result: "applied", deltaMicros: delta };
    }
  }
  throw new Error("charge revision could not be recorded");
}
