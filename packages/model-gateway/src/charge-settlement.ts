import { chargeReceiptContent, chargeValue, parseChargeReceiptV1, type ChargeReceiptV1 } from "./charge-receipt.js";
import type { EstimatedSettlement, MeterScope } from "./meter.js";
export function receiptIdentity(r: ChargeReceiptV1): string {
  return chargeReceiptContent({ issuer: r.issuer, companyId: r.companyId, project: r.project, taskId: r.taskId, operationId: r.operationId, callId: r.callId, originalReservationMicros: r.originalReservationMicros, model: r.model, source: r.source, payer: r.payer, requesterId: r.requesterId, billing: r.billing, occurredAt: r.occurredAt, accountingDay: r.accountingDay, accountingMonth: r.accountingMonth });
}
export function readSettlementReceipt(input: unknown): ChargeReceiptV1 {
  const r = parseChargeReceiptV1(input);
  if (r === undefined || chargeValue(r.amountMicros) === undefined) throw new Error("invalid charge receipt");
  return r;
}
/** Customer-paid provider costs are recorded in full and latch admission closed above the hold. */
export function customerSourceOverage(r: ChargeReceiptV1 | undefined): boolean {
  return r !== undefined && r.billing === "external_provider" && (r.model.provider === "bedrock" || r.model.provider === "openrouter") && (chargeValue(r.amountMicros) ?? 0) > (chargeValue(r.originalReservationMicros) ?? Number.MAX_SAFE_INTEGER);
}
export function checkReceiptScope(r: ChargeReceiptV1, scope: MeterScope, id: string, estimate: number, month: string): void {
  if (r.revision !== 1 || r.issuer !== scope.iss || r.companyId !== scope.cid || r.project !== scope.pid || r.taskId !== scope.tid || r.callId !== id || chargeValue(r.originalReservationMicros) !== estimate || r.accountingMonth !== month) throw new Error("charge receipt scope mismatch");
}
export function estimatedReceipt(r: ChargeReceiptV1, kind: EstimatedSettlement["kind"] = "chat"): EstimatedSettlement | undefined {
  if (r.status === "final") return undefined;
  const u = chargeValue(r.usage);
  return { provider: r.model.provider, model: r.model.modelId, kind, settledAt: Date.parse(r.occurredAt), ...(u === undefined ? {} : { usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite5m + u.cacheWrite1h + u.cacheWriteUnknown, ...(u.cacheWriteUnknown > 0 ? {} : { cacheWrite5m: u.cacheWrite5m, cacheWrite1h: u.cacheWrite1h }) } }) };
}
export function receiptRevision(old: ChargeReceiptV1, next: ChargeReceiptV1): "duplicate" | "older" | "applied" {
  if (receiptIdentity(old) !== receiptIdentity(next)) throw new Error("charge identity changed");
  if (old.revision === next.revision) {
    if (chargeReceiptContent(old) !== chargeReceiptContent(next)) throw new Error("conflicting charge revision");
    return "duplicate";
  }
  return old.revision > next.revision ? "older" : "applied";
}
