/** ChargeReceiptV1: contracts/shared/charge-receipt.v1.json is canonical in Code and Cloud. */
export type ChargeField<T> = { state: "available"; value: T } | { state: "unavailable"; reason: "not_measured" | "missing_price" | "unreadable" | "restricted" | "legacy_data" | "not_applicable" };
export type ChargeStatus = "final" | "estimated" | "awaiting_usage";
export type ChargeReason = "reported_cost" | "rated_usage" | "derived_rate" | "missing_usage" | "confirmed_not_sent" | "legacy_unknown";
export interface ChargeUsageV1 { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; cacheWriteUnknown: number }
export interface ChargeReceiptV1 {
  version: 1; issuer: string; companyId: string; project: string; taskId: string; operationId: string; callId: string;
  providerRequestId: ChargeField<string>; revision: number; replacesRevision: number | null;
  neverConfirmed?: true;
  status: ChargeStatus; reason: ChargeReason; currency: "USD";
  amountMicros: ChargeField<number>; originalReservationMicros: ChargeField<number>;
  usage: ChargeField<ChargeUsageV1>; usageComplete: boolean;
  price: ChargeField<{ authority: "gateway" | "local_provider"; version: string; hash: string; fetchedAt: string }>;
  model: { provider: string; modelId: string };
  source: { kind: "rovara_ai" | "company_key"; id: string; name: string; provider: string; connectionRevision: string };
  payer: { kind: "member" | "project" | "agent" | "chain"; id: string; name: string } | { kind: "mixed"; name: string };
  requesterId: ChargeField<string>; billing: "customer" | "exempt" | "external_provider";
  billableMicros: ChargeField<number>; providerCostMicros: ChargeField<number>;
  occurredAt: string; accountingDay: string; accountingMonth: string; recordedAt: string;
}
export interface SettleV2 { reservationId: string; receipt: ChargeReceiptV1 }
export interface ApplyChargeResult { callId: string; appliedRevision: number; result: "applied" | "duplicate" | "older"; deltaMicros: number }
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const keys = (v: Record<string, unknown>, names: string): boolean => Object.keys(v).sort().join(",") === names.split(" ").sort().join(",");
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 2048;
const natural = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const iso = (v: unknown): v is string => text(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const field = (v: unknown, valid: (v: unknown) => boolean): boolean => {
  const f = object(v); if (f === undefined) return false;
  return f.state === "available" ? keys(f, "state value") && valid(f.value) : keys(f, "state reason") && f.state === "unavailable" && ["not_measured", "missing_price", "unreadable", "restricted", "legacy_data", "not_applicable"].includes(f.reason as string);
};
export const chargeValue = <T>(f: ChargeField<T>): T | undefined => f.state === "available" ? f.value : undefined;
/** Strict bounded reader; legacy estimated:false is deliberately not a receipt. */
export function parseChargeReceiptV1(value: unknown): ChargeReceiptV1 | undefined {
  const r = object(value);
  if (r === undefined || !keys(Object.fromEntries(Object.entries(r).filter(([key]) => key !== "neverConfirmed")), "version issuer companyId project taskId operationId callId providerRequestId revision replacesRevision status reason currency amountMicros originalReservationMicros usage usageComplete price model source payer requesterId billing billableMicros providerCostMicros occurredAt accountingDay accountingMonth recordedAt")) return undefined;
  if (r.version !== 1 || r.currency !== "USD" || !["issuer", "companyId", "project", "taskId", "operationId", "callId"].every(k => text(r[k])) || !natural(r.revision) || r.revision < 1 || (r.revision === 1 ? r.replacesRevision !== null : r.replacesRevision !== r.revision - 1)) return undefined;
  if (!["final", "estimated", "awaiting_usage"].includes(r.status as string) || !["reported_cost", "rated_usage", "derived_rate", "missing_usage", "confirmed_not_sent", "legacy_unknown"].includes(r.reason as string) || !["customer", "exempt", "external_provider"].includes(r.billing as string) || typeof r.usageComplete !== "boolean") return undefined;
  if (!iso(r.occurredAt) || !iso(r.recordedAt) || r.accountingDay !== r.occurredAt.slice(0, 10) || r.accountingMonth !== r.accountingDay.slice(0, 7)) return undefined;
  if (!["amountMicros", "originalReservationMicros", "billableMicros", "providerCostMicros"].every(k => field(r[k], natural)) || !field(r.providerRequestId, text) || !field(r.requesterId, text)) return undefined;
  if (!field(r.usage, v => { const u = object(v); return u !== undefined && keys(u, "input output cacheRead cacheWrite5m cacheWrite1h cacheWriteUnknown") && Object.values(u).every(natural) && Number.isSafeInteger(Object.values(u).reduce<number>((a, n) => a + Number(n), 0)); })) return undefined;
  if (!field(r.price, v => { const p = object(v); return p !== undefined && keys(p, "authority version hash fetchedAt") && ["gateway", "local_provider"].includes(p.authority as string) && text(p.version) && text(p.hash) && iso(p.fetchedAt); })) return undefined;
  const m = object(r.model), s = object(r.source), p = object(r.payer);
  if (m === undefined || !keys(m, "provider modelId") || !Object.values(m).every(text) || s === undefined || !keys(s, "kind id name provider connectionRevision") || !["rovara_ai", "company_key"].includes(s.kind as string) || !Object.values(s).every(text) || p === undefined || !text(p.name) || (p.kind === "mixed" ? !keys(p, "kind name") : !keys(p, "kind id name") || !["member", "project", "agent", "chain"].includes(p.kind as string) || !text(p.id))) return undefined;
  if (r.neverConfirmed !== undefined && r.neverConfirmed !== true) return undefined;
  const receipt = r as unknown as ChargeReceiptV1;
  const amount = chargeValue(receipt.amountMicros), reservation = chargeValue(receipt.originalReservationMicros), billable = chargeValue(receipt.billableMicros);
  if (receipt.usageComplete && receipt.usage.state !== "available") return undefined;
  if (receipt.status === "awaiting_usage" && (receipt.reason !== "missing_usage" || amount !== reservation || (receipt.billing === "customer" && billable !== undefined))) return undefined;
  if (receipt.status === "estimated" && !["derived_rate", "legacy_unknown"].includes(receipt.reason) && !(receipt.reason === "missing_usage" && receipt.neverConfirmed === true)) return undefined;
  if (receipt.neverConfirmed === true && (receipt.status !== "estimated" || receipt.reason !== "missing_usage" || receipt.usageComplete || amount === undefined || reservation === undefined || amount > reservation)) return undefined;
  if (receipt.status === "final" && (amount === undefined || !["reported_cost", "rated_usage", "confirmed_not_sent"].includes(receipt.reason))) return undefined;
  if (receipt.reason === "confirmed_not_sent" && (receipt.status !== "final" || amount !== 0)) return undefined;
  if (receipt.reason === "rated_usage" && (!receipt.usageComplete || receipt.price.state !== "available")) return undefined;
  if (receipt.reason === "reported_cost" && receipt.providerCostMicros.state !== "available") return undefined;
  if (receipt.billing !== "customer" && billable !== undefined && billable !== 0) return undefined;
  if (receipt.billing === "customer" && billable !== undefined && (receipt.status !== "final" || receipt.reason === "reported_cost")) return undefined;
  return structuredClone(receipt);
}
/** Content comparison independent of property order, used for immutable revision conflict detection. */
export function chargeReceiptContent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(chargeReceiptContent).join(",")}]`;
  const v = object(value);
  return v === undefined ? JSON.stringify(value) : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${chargeReceiptContent(v[k])}`).join(",")}}`;
}
