import type { ChargeReceiptV1 } from "./charge-receipt.js";
import { chargeValue } from "./charge-receipt.js";
import { OPENROUTER_RELAXED_TARIFF_MODELS } from "./openrouter-policy.js";
import { customerSourceOverage } from "./charge-settlement.js";
import { COMPANY, record, whole } from "./model-gateway-token.js";
export type CustomerSource = "bedrock_byo" | "openrouter";
export const validCustomerSource = (source: unknown): source is CustomerSource => source === "bedrock_byo" || source === "openrouter";
export type RouteClass = "product" | "agent";
/** `legacy` explicitly selects the pre-migration, class-less stop for operator clear only. */
export type ClearRouteClass = RouteClass | "legacy";
export const validRouteClass = (value: unknown): value is RouteClass => value === "product" || value === "agent";
export const sourceStopKey = (source: CustomerSource, routeClass?: RouteClass): string => `SOURCESTOP#${source}${routeClass === undefined ? "" : `#${routeClass}`}`;
export interface SourceStop {
  routeClass?: RouteClass; source: CustomerSource; stopped: boolean; stopId?: string; stoppedAt?: number; callId?: string; costMicros?: number; heldMicros?: number; inFlight?: string;
  clearedBy?: string; clearedAt?: number; clearReason?: string;
}
export interface ClearSourceStop { iss: string; cid: string; source: CustomerSource; routeClass: ClearRouteClass; expectedStopId: string; actor: string; reason: string }
export function validClear(input: ClearSourceStop): boolean {
  return record(input) !== undefined && typeof input.iss === "string" && input.iss.length > 0 && input.iss.length <= 2048 && COMPANY.test(input.cid) && validCustomerSource(input.source) && (validRouteClass(input.routeClass) || input.routeClass === "legacy") && typeof input.expectedStopId === "string" && input.expectedStopId.length > 0 && input.expectedStopId.length <= 128 && typeof input.actor === "string" && /^arn:aws(?:-us-gov|-cn)?:iam::[0-9]{12}:user\/[A-Za-z0-9+=,.@_/-]{1,128}$/u.test(input.actor) && typeof input.reason === "string" && input.reason.trim().length > 0 && input.reason.length <= 1000 && ![...input.reason].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
export function receiptCustomerSource(r: ChargeReceiptV1 | undefined): CustomerSource | undefined {
  return r?.billing !== "external_provider" ? undefined : r.model.provider === "bedrock" ? "bedrock_byo" : r.model.provider === "openrouter" ? "openrouter" : undefined;
}
export function stoppedBy(r: ChargeReceiptV1 | undefined, now: number, routeClass?: RouteClass, noWriteRoute = false): SourceStop | undefined {
  const source = receiptCustomerSource(r);
  // The reviewed no-write models never request writes (the relaxed list, and any route admitted with the no-write basis: `noWriteRoute`, an ABSENT
  // write price): provisional write evidence violates their bound, even when the known debit is below the hold. Reuse the durable overrun stop, so the
  // route is refused afterwards. A priced-write route (no basis) keeps latching only on an overrun.
  const u = r === undefined ? undefined : chargeValue(r.usage);
  const unexpectedWrite = source === "openrouter" && r !== undefined && r.status !== "final" && (noWriteRoute || Object.hasOwn(OPENROUTER_RELAXED_TARIFF_MODELS, r.model.modelId)) && u !== undefined && u.cacheWrite5m + u.cacheWrite1h + u.cacheWriteUnknown > 0;
  if (source === undefined || (!customerSourceOverage(r) && !unexpectedWrite)) return undefined;
  return { ...(routeClass === undefined ? {} : { routeClass }), source, stopped: true, stopId: `${r!.callId}:${r!.revision}`, stoppedAt: now, callId: r!.callId, costMicros: chargeValue(r!.amountMicros)!, heldMicros: chargeValue(r!.originalReservationMicros)! };
}
/** A malformed source row fails closed; no month or TTL belongs on this record. */
export function readSourceStop(value: unknown, source: CustomerSource, routeClass?: RouteClass): SourceStop | undefined {
  if (value === undefined) return undefined;
  const v = record(value);
  if (v === undefined || v.source !== source || v.routeClass !== routeClass || typeof v.stopped !== "boolean" || (v.inFlight !== undefined && typeof v.inFlight !== "string") || (v.stopped && (typeof v.stopId !== "string" || !whole(v.stoppedAt)))) throw new Error("source stop unavailable");
  return v as unknown as SourceStop;
}
