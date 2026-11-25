import { usageEstimated } from "./price-tiers.js";
import { record, whole } from "./model-gateway-token.js";
import { openRouterDecimal } from "./openrouter-policy.js";
import { mediaEstimated, mediaPriced, usageCost } from "./estimate.js";
import type { ResolvedPrice } from "./price.js";
import { MEDIA_USAGE_KEYS, type TokenUsage } from "./usage.js";
/** Assumed OpenRouter final usage.cost USD shape; verify on staging before routing OpenRouter. */
export function parseReportedCost(provider: string, value: unknown): number | undefined {
  if (provider !== "openrouter") return undefined;
  const u = record(value); const cost = u?.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined;
  const details = u?.cost_details === undefined ? undefined : record(u.cost_details);
  if (u?.cost_details !== undefined && details === undefined) return undefined;
  const upstream = details?.upstream_inference_cost;
  if (upstream !== undefined && (typeof upstream !== "number" || !Number.isFinite(upstream) || upstream < 0)) return undefined;
  try {
    const total = openRouterDecimal(String(cost));
    const providerCost = typeof upstream === "number" ? openRouterDecimal(String(upstream)) : 0n;
    const amount = total > providerCost ? total : providerCost;
    const micros = Number((amount + 999_999_999_999n) / 1_000_000_000_000n);
    return whole(micros) && micros > 0 ? micros : undefined;
  } catch { return undefined; }
}
/** Known debit floor survives malformed ancillary evidence; it is never discarded or capped. */
export function reportedCostFloor(value: unknown): number | undefined {
 const u = record(value); const details = record(u?.cost_details);
 let floor = 0;
 for (const value of [u?.cost, details?.upstream_inference_cost]) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
  try {
   const n = Number((openRouterDecimal(String(value)) + 999_999_999_999n) / 1_000_000_000_000n);
   if (whole(n)) floor = Math.max(floor, n);
  } catch { /* An unreadable component never removes readable money. */ }
 }
 return floor > 0 ? floor : undefined;
}
export function validUsage(value: unknown): value is TokenUsage {
  const u = record(value);
  if (u === undefined || ![u.input, u.output, u.cacheRead, u.cacheWrite].every((n) => whole(n) && n <= 1_000_000_000)) return false;
  // Media counts are parts of input and cacheRead: each whole, and never more than the total they belong to.
  if (!MEDIA_USAGE_KEYS.every((k) => u[k] === undefined || (whole(u[k]) && u[k] <= 1_000_000_000))) return false;
  if (Number(u.audioInput ?? 0) + Number(u.videoInput ?? 0) > Number(u.input) || Number(u.audioCacheRead ?? 0) + Number(u.videoCacheRead ?? 0) > Number(u.cacheRead)) return false;
  if (u.cacheWrite5m === undefined && u.cacheWrite1h === undefined) return true;
  return whole(u.cacheWrite5m) && whole(u.cacheWrite1h) && u.cacheWrite5m + u.cacheWrite1h === u.cacheWrite;
}
export function hasUsage(usage: TokenUsage): boolean { return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0; }
export function settleChargeAmount(input: { reportedCostMicros?: number; retainMissingUsage?: boolean; failedWithReportedCost?: boolean; usage?: TokenUsage; price: ResolvedPrice; reservationMicros: number }): { actualMicros: number; estimated: boolean; status: "final" | "estimated" | "awaiting_usage"; reason: "rated_usage" | "reported_cost" | "derived_rate" | "missing_usage"; usage?: TokenUsage } {
  // A FAILED call (a broken stream) that RECEIVED the provider's complete, final reported cost (OpenRouter's usage chunk) AT OR BELOW the hold settles at that cost;
  // nothing reconciles a failed call later, so the hold must not be kept when the money is known. Above the hold it falls through to the rule below (the known
  // debit, estimated, above the hold), so the customer's caps count the whole known spend and the over-reservation alarm and source stop still fire.
  if (input.failedWithReportedCost === true && whole(input.reportedCostMicros) && input.reportedCostMicros > 0 && input.reportedCostMicros <= input.reservationMicros) {
    return { actualMicros: input.reportedCostMicros, estimated: false, status: "final", reason: "reported_cost" };
  }
  if (input.retainMissingUsage) {
    // Incomplete billing evidence keeps the fee-inclusive hold AND every known debit.
    // Valid tokens remain a lower bound even when the provider omits its total cost.
    const usage = validUsage(input.usage) && hasUsage(input.usage) ? input.usage : undefined;
    const tokenCost = usage === undefined ? 0 : usageCost(usage, input.price, mediaPriced(usage, input.price) ? undefined : "cautious");
    const floor = Math.max(input.reservationMicros, whole(input.reportedCostMicros) ? input.reportedCostMicros : 0, tokenCost);
    // Receipt v1 requires awaiting_usage.amount === reservation. Above the hold remains estimated.
    return floor > input.reservationMicros ? { actualMicros: floor, estimated: true, status: "estimated", reason: "derived_rate", ...(usage === undefined ? {} : { usage: { ...usage } }) } : { actualMicros: floor, estimated: true, status: "awaiting_usage", reason: "missing_usage" };
  }
  if (!validUsage(input.usage) || !hasUsage(input.usage)) {
    if (whole(input.reportedCostMicros) && input.reportedCostMicros > 0) return { actualMicros: input.reportedCostMicros, estimated: false, status: "final", reason: "reported_cost" };
    return { actualMicros: input.reservationMicros, estimated: true, status: "awaiting_usage", reason: "missing_usage" };
  }
  // Reported audio or video tokens with no price for them (REVIEW-1 M1): the cautious media rate, never below the hold, flagged
  // estimated with the usage so a correction row is written; above the hold it is an over-reservation (DEC 165).
  if (!mediaPriced(input.usage, input.price)) return { actualMicros: Math.max(input.reservationMicros, 1, usageCost(input.usage, input.price, "cautious")), estimated: true, status: "estimated", reason: "derived_rate", usage: { ...input.usage } };
  const tokenCost = Math.max(1, usageCost(input.usage, input.price));
  if (whole(input.reportedCostMicros) && input.reportedCostMicros > 0) {
    if ((!input.price.knownTokenPrice && input.price.estimated && !input.price.operatorReview) || input.reportedCostMicros >= tokenCost) return { actualMicros: input.reportedCostMicros, estimated: false, status: "final", reason: "reported_cost" };
  }
  const estimated = usageEstimated(input.price, input.usage) || mediaEstimated(input.usage, input.price);
  return { actualMicros: tokenCost, estimated, status: estimated ? "estimated" : "final", reason: estimated ? "derived_rate" : "rated_usage", ...(estimated ? { usage: { ...input.usage } } : {}) };
}

/** Legacy envelope retained for strict readers; missing usage is always provisional. */
export function settleAmount(input: Parameters<typeof settleChargeAmount>[0]): { actualMicros: number; estimated: boolean; usage?: TokenUsage } {
  if (!validUsage(input.usage) || !hasUsage(input.usage)) return { actualMicros: input.reservationMicros, estimated: true };
  const { actualMicros, estimated, usage } = settleChargeAmount(input);
  return { actualMicros, estimated, ...(usage === undefined ? {} : { usage }) };
}
