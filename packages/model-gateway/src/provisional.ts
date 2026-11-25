import { estimateCall } from "./estimate.js";
import { validPrice, type ResolvedPrice } from "./price.js";
import { whole, record } from "./model-gateway-token.js";
import type { ChargeReceiptV1 } from "./charge-receipt.js";
/** DEC 254zzz69/70: kept on the existing hold/CALL, never a separate record kind. */
export interface ProvisionalContext { requestBytes: number; toolInputAllowanceTokens?: number; maxOutputTokens: number; price: ResolvedPrice }
export interface ProvisionalEstimate { amountMicros: number; estimateBasis: "input_actual" | "input_bytes_bound" | "reservation"; outputEstimateBasis: "p90_history" | "max_output" }
export function validProvisionalContext(value: unknown): value is ProvisionalContext {
  const v = record(value), p = record(v?.price);
  return v !== undefined && whole(v.requestBytes) && (v.toolInputAllowanceTokens === undefined || whole(v.toolInputAllowanceTokens)) && whole(v.maxOutputTokens) && v.maxOutputTokens > 0 && p !== undefined && typeof p.estimated === "boolean" && validPrice({ ...p, estimated: false }, Number.MAX_SAFE_INTEGER);
}
export const USAGE_WAIT_MS = 24 * 60 * 60_000;
export function provisionalEstimate(reservation: number, context: ProvisionalContext, outputs: readonly number[], actualInputTokens?: number): ProvisionalEstimate {
  if (!whole(reservation) || !validProvisionalContext(context) || (actualInputTokens !== undefined && !whole(actualInputTokens)) || !outputs.every(whole)) throw new Error("provisional estimate unavailable");
  if (outputs.length < 20) return { amountMicros: reservation, estimateBasis: "reservation", outputEstimateBasis: "max_output" };
  const sorted = [...outputs].sort((a, b) => a - b);
  const p90 = sorted[Math.ceil(sorted.length * 0.9) - 1]!;
  const amount = estimateCall(actualInputTokens ?? context.requestBytes, p90, context.price, actualInputTokens === undefined ? context.toolInputAllowanceTokens ?? 0 : 0);
  return { amountMicros: Math.min(reservation, amount), estimateBasis: actualInputTokens === undefined ? "input_bytes_bound" : "input_actual", outputEstimateBasis: "p90_history" };
}
export function historyOutput(receipt: ChargeReceiptV1): number | undefined {
  return receipt.status !== "awaiting_usage" && receipt.usageComplete && receipt.usage.state === "available" ? receipt.usage.value.output : undefined;
}
/** Local clock settlement is explicitly estimated; only later provider evidence can make it final. */
export function neverConfirmedReceipt(old: ChargeReceiptV1, amount: number, now: number): ChargeReceiptV1 {
  return { ...old, revision: old.revision + 1, replacesRevision: old.revision, status: "estimated", reason: "missing_usage", neverConfirmed: true, amountMicros: { state: "available", value: amount }, recordedAt: new Date(now).toISOString() };
}
