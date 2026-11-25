import { createHash, randomUUID } from "node:crypto";
import type { ChargeField, ChargeReceiptV1 } from "./charge-receipt.js";
import { hasUsage, settleChargeAmount } from "./reported-cost.js";
import type { ResolvedPrice } from "./price.js";
import type { TaskClaims } from "./model-gateway-token.js";
import type { TokenUsage } from "./usage.js";
export type ChargeSource = Pick<ChargeReceiptV1, "source" | "billing">;
const missing = <T>(): ChargeField<T> => ({ state: "unavailable", reason: "not_measured" });
const available = <T>(value: T): ChargeField<T> => ({ state: "available", value });
export function initialCharge(claims: TaskClaims, model: ChargeReceiptV1["model"], context: ChargeSource, reservation: number, at: number, price: ResolvedPrice): ChargeReceiptV1 {
  const payer = claims.pay, id = payer.kind === "member" ? payer.developerId : payer.kind === "project" ? payer.project : payer.kind === "agent" ? payer.agentId : payer.chainId;
  const time = new Date(at).toISOString();
  return { version: 1, issuer: claims.iss, companyId: claims.cid, project: claims.pid, taskId: claims.tid, operationId: claims.op, callId: randomUUID(), providerRequestId: missing(), revision: 1, replacesRevision: null,
    status: "awaiting_usage", reason: "missing_usage", currency: "USD", amountMicros: available(reservation), originalReservationMicros: available(reservation), usage: missing(), usageComplete: false,
    price: available({ authority: "gateway", version: String(price.priceVersion ?? 0), hash: createHash("sha256").update(JSON.stringify(price)).digest("hex"), fetchedAt: time }), model, ...context,
    payer: { kind: payer.kind, id, name: id }, requesterId: claims.per === undefined ? missing() : available(claims.per), billableMicros: context.billing === "customer" ? missing() : available(0), providerCostMicros: missing(), occurredAt: time, accountingDay: time.slice(0, 10), accountingMonth: time.slice(0, 7), recordedAt: time };
}
export function finishCharge(initial: ChargeReceiptV1, input: { usage?: TokenUsage; reportedCostMicros?: number; retainMissingUsage?: boolean; failedWithReportedCost?: boolean; customerPriceAuthorized?: boolean; price: ResolvedPrice; notSent: boolean; now: number; failedMicros?: number }): ChargeReceiptV1 {
  const reservation = initial.originalReservationMicros.state === "available" ? initial.originalReservationMicros.value : undefined;
  if (reservation === undefined) throw new Error("charge reservation unavailable");
  // A call that failed after it was sent, with no usage (failed-call.ts): an estimate below the hold, never final. Real evidence can still revise it.
  if (input.failedMicros !== undefined && input.failedMicros > 0 && !input.notSent) {
    return { ...initial, status: "estimated", reason: "missing_usage", neverConfirmed: true, amountMicros: available(Math.min(reservation, input.failedMicros)), usageComplete: false, usage: missing(), providerCostMicros: missing(),
      billableMicros: initial.billing === "customer" ? missing() : available(0), recordedAt: new Date(input.now).toISOString() };
  }
  const amount = settleChargeAmount({ ...input, reservationMicros: reservation });
  const u = input.usage;
  return { ...initial, status: input.notSent ? "final" : amount.status, reason: input.notSent ? "confirmed_not_sent" : amount.reason, amountMicros: available(input.notSent ? 0 : amount.actualMicros),
    usageComplete: amount.status !== "awaiting_usage" && u !== undefined && hasUsage(u),
    usage: u === undefined ? missing() : available({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite5m: u.cacheWrite5m ?? 0, cacheWrite1h: u.cacheWrite1h ?? 0, cacheWriteUnknown: u.cacheWrite5m === undefined && u.cacheWrite1h === undefined ? u.cacheWrite : 0 }),
    providerCostMicros: input.reportedCostMicros === undefined ? missing() : available(input.reportedCostMicros),
    // Only measured usage at the authorized customer tariff is billable. Missing usage and provider-only money stay unavailable.
    billableMicros: input.notSent || initial.billing !== "customer" ? available(0) : input.customerPriceAuthorized === true && amount.reason === "rated_usage" ? available(amount.actualMicros) : missing(), recordedAt: new Date(input.now).toISOString() };
}
