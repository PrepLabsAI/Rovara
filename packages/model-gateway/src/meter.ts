import { validRouteClass, validCustomerSource, receiptCustomerSource, stoppedBy, validClear, type RouteClass, type CustomerSource, type SourceStop, type ClearSourceStop } from "./source-stop.js";
import { validProvisionalContext, historyOutput, neverConfirmedReceipt, provisionalEstimate, USAGE_WAIT_MS, type ProvisionalContext, type ProvisionalEstimate } from "./provisional.js";
import { chargeValue, chargeReceiptContent, type ApplyChargeResult, type ChargeReceiptV1, type SettleV2 } from "./charge-receipt.js";
import { checkReceiptScope, estimatedReceipt, readSettlementReceipt, receiptIdentity, receiptRevision } from "./charge-settlement.js";
import { comparePosition, pendingPage, type PendingPage, type PendingPosition } from "./pending-page.js";
import { PENDING_RETENTION_DAYS, DAY_MS, CORRECTION_RUN_MS } from "./price-constants.js";
import { CALL_HARD_CEILING_MS } from "./provider.js";
import { hasUsage, validUsage } from "./reported-cost.js";
import type { TokenUsage } from "./usage.js";
import type { PriceKind, PriceOrigin } from "./price.js";
import { priceKey, validEntry, type PriceKey } from "./price-snapshot.js";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { validCaps, type Caps } from "./caps.js";
import { COMPANY, PERSON, PROJECT, TASK, TASK_TOKEN_SECONDS, record, whole } from "./model-gateway-token.js";
/** The furthest ahead a hold may ask the sweep to wait (ReserveInput.sweepAfter). */
export const SWEEP_AFTER_MAX_MS = 24 * 60 * 60_000;
export interface MeterScope { iss: string; cid: string; pid: string; tid: string; per?: string }
/**
 * `upkeep` (lead 4 L4-E, DEC 254z(2)): the project's monthly row for AI spend whose origin is nightly upkeep. It is an ADDITIONAL row of such a
 * call (the task, person, project and company rows still count it), present only when the call's caps carry `upkeepMonth`, so it can only tighten.
 */
export type MeterItem = "task" | "person" | "project" | "company" | "upkeep";
export interface MeterRow { item: MeterItem; company: string; spentMicros: number; estimatedMicros: number; reservedMicros: number; committed: number; overrun: boolean; provisionalMicros?: number; overrunOwner?: string }
export interface Reservation { readonly id: string; readonly appliedMaxOutputTokens?: number }
export type ReserveResult = { ok: true; reservation: Reservation } | { ok: false; reason: "cap" | "overrun"; item: MeterItem; held: boolean } | { ok: false; reason: "busy"; overrunInFlight?: true };
export interface ReserveInput {
  /** One shared in-flight slot per company/source, with a human-cleared stop per route class. */
  customerSource?: CustomerSource;
  routeClass?: RouteClass;
  scope: MeterScope; caps: Caps; estimateMicros: number; appliedMaxOutputTokens?: number;
  provisional?: ProvisionalContext;
  /** Internal price kind from the admitted guard; absent on legacy chat holds. */
  charge?: { receipt: ChargeReceiptV1; requestFingerprint: string; kind?: PriceKind };
  /** Omit only when usage is bounded by the priced hold. All times are integer seconds. */
  overrun?: { deadlineSeconds: number; tokenExpiresSeconds: number };
  /**
   * A long hold (an eval stage, product-eval.ts): epoch milliseconds before which the open-hold sweep must not close it. At most
   * a day ahead. Omitted: the sweep's usual age applies.
   */
  sweepAfter?: number;
  /**
   * DEC 240b: this call is charged by Rovara to the company (Rovara's AI). Kept on the hold and written onto the call's ledger row
   * when it settles (or is swept), in the same transaction, so every settled Rovara's AI call is exactly one billable line.
   */
  line?: BillLine;
  /**
   * DEC 254zzz41: this hold is a review session's whole ceiling; `jti` names its session item (reviewer-grants.ts) in the markers table. Only the hold sweep reads it: a hold
   * whose gateway task died is then settled at what the session really debited, not at the whole ceiling. Absent: every other hold, as before.
   */
  review?: { jti: string };
  /**
   * GATEWAY-RUN-CHARGES-ROUTE: the run (the task token's `op`) this call belongs to. The hold is then findable by (company, task, run) in the SAME transaction that takes it, so a read
   * of one run's charges (`runCharges`) can never miss a call that holds money. Absent: the hold is not part of any run's record (an eval stage's, the checks').
   */
  run?: { operationId: string };
}
/**
 * One billable line (DEC 240b). `charge` "customer": on the company's bill; "exempt": the operator-named founders' test company
 * (never inferred). The amount is the call's settled cost on the same ledger row (list price, the Bedrock rows, dearest-of).
 */
export interface BillLine { source: "rovara_ai"; charge: "customer" | "exempt"; model: string }
export const BILL_LINE_MODEL = /^[a-z0-9][a-z0-9.:-]{0,119}$/u;
export function validLine(value: unknown): value is BillLine {
  const v = record(value);
  return v !== undefined && Object.keys(v).length === 3 && v.source === "rovara_ai" && (v.charge === "customer" || v.charge === "exempt") && typeof v.model === "string" && BILL_LINE_MODEL.test(v.model);
}
/** A settled call that carries a billable line (InMemoryMeter.billedCalls; the Dynamo ledger row holds the same fields). */
export interface BilledCall extends MeterScope { callKey: string; month: string; line: BillLine; settledMicros: number; estimated: boolean }
export interface Meter {
  /**
   * DEC 228c: true when this meter's holds ALSO count against the agent meter's company row (one combined company monthly cap,
   * `Caps.combinedCompanyMonth`) and share its one-overrun-call-in-flight marker. The product meter must; the agent meter is the
   * partner and leaves it unset.
   */
  readonly combinedCompany?: boolean;
  reserve(input: ReserveInput): Promise<ReserveResult>;
  /** Optional negotiated receipt capability; legacy adapters retain settle. */
  settleV2?(input: SettleV2): Promise<void>;
  applyChargeReceipt?(receipt: ChargeReceiptV1): Promise<ApplyChargeResult>;
  settle(reservation: Reservation, actualMicros: number, estimated?: EstimatedSettlement): Promise<void>;
  pendingKeys(limit: number, cursor?: string): Promise<PendingPage<PriceKey>>;
  pendingFor(key: PriceKey, limit: number, cursor?: string): Promise<PendingPage<EstimatedCall>>;
  pendingExpired(now: number, limit: number, cursor?: string): Promise<PendingPage<EstimatedCall>>;
  expire(input: ExpiryInput): Promise<CorrectionResult>;
  /** Complete or fail within signal's remaining time (and at most CORRECTION_RUN_MS).
   * Never acknowledge an unconfirmed transaction as success: return unknown; retries use status=pending. */
  correct(input: CorrectionInput): Promise<CorrectionResult>;
  /** The rows this call's scope counts on, this month. `upkeep: true` adds the project's upkeep row (zero when it has none yet). */
  read(scope: MeterScope, options?: { upkeep?: true }): Promise<readonly MeterRow[]>;
  /**
   * GATEWAY-RUN-CHARGES-ROUTE: every call held for one run (`ReserveInput.run`) of one task of one company, as the gateway's own charge receipts. `{ found: false }` only when no call was ever held for the
   * run. Throws when any part does not read (a call with no receipt, a record of another company, task or run, too many calls): a figure is never built from part of a run.
   */
  runCharges?(scope: RunScope, operationId: string): Promise<RunChargesRead>;
}
export interface RunScope { iss: string; cid: string; tid: string }
/** `complete`: no call of the run holds an open reservation. `receipts` has one (the latest revision) per call, an open call's as the hold wrote it (`awaiting_usage`). */
export type RunChargesRead = { found: false } | { found: true; complete: boolean; receipts: ChargeReceiptV1[]; indexedSince: number; startedBeforeIndex: boolean };
/**
 * Indexing of a run's holds began at `indexedSince` (epoch ms; a per-environment marker, dynamo-meter.ts `markRunIndex`). A run whose calls from before then are not in the index, so a run whose EARLIEST indexed call is
 * at or before `indexedSince` plus this much (one call's longest life, CALL_HARD_CEILING_MS, and the sweep's quarter hour; it also covers serving tasks of the older version still draining) may have spent more than it shows:
 * it is read as `startedBeforeIndex`, never as complete. A run that began earlier and made its first indexed call later is the reader's to catch: it compares the operation's own start with `indexedSince`.
 */
export const RUN_INDEX_GRACE_MS = CALL_HARD_CEILING_MS + 15 * 60_000;
export const startedBeforeIndex = (earliestCallAt: number, indexedSince: number): boolean => earliestCallAt <= indexedSince + RUN_INDEX_GRACE_MS;
/** The most calls one run's read serves; a run with more is unreadable (a 503), never a partial figure. */
export const RUN_CALLS_MAX = 500;
const RUN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** The run's calls are found under this key prefix (the meter table's `RUN#<json [task, run]>#<call id>` items; the last character is "#", the range's end is the same text with "$"). */
export const runKeyPrefix = (taskId: string, operationId: string): string => `RUN#${JSON.stringify([taskId, operationId])}#`;
export const validRunScope = (scope: unknown, operationId: unknown): scope is RunScope => {
  const s = record(scope);
  return s !== undefined && typeof s.iss === "string" && s.iss.length > 0 && s.iss.length <= 2048 && typeof s.cid === "string" && COMPANY.test(s.cid) && typeof s.tid === "string" && TASK.test(s.tid) && typeof operationId === "string" && RUN_UUID.test(operationId);
};
/** One call's receipt must be this run's own (company, task, run, call): anything else makes the whole read unreadable. */
export function checkRunReceipt(r: ChargeReceiptV1, scope: RunScope, operationId: string, callId: string): ChargeReceiptV1 {
  if (r.issuer !== scope.iss || r.companyId !== scope.cid || r.taskId !== scope.tid || r.operationId !== operationId || r.callId !== callId) throw new Error("run charges unavailable");
  return r;
}
export interface EstimatedSettlement { provider: string; model: string; kind: PriceKind; usage?: TokenUsage; settledAt: number; priceVersion?: number }
export interface EstimatedCall extends MeterScope {
  callKey: string; month: string; provider: string; model: string; kind: PriceKind; usage: TokenUsage;
  estimateBasis?: ProvisionalEstimate["estimateBasis"]; outputEstimateBasis?: ProvisionalEstimate["outputEstimateBasis"]; estimateStatus?: "estimated"; neverConfirmed?: true;
  chargeStatus?: "estimated" | "awaiting_usage"; unresolvedAt?: number; settledMicros: number; status: "pending" | "corrected" | "expired"; settledAt: number;
  priceVersion?: number; capExceeded?: true; correctedFrom?: number; correctedTo?: number; deltaMicros?: number; correctedAt?: number; expiredAt?: number; runId?: string; priceSource?: PriceOrigin;
}
export interface ExpiryInput { callKey: string; runId: string; now: number; signal?: AbortSignal }
export interface CorrectionInput extends ExpiryInput { realMicros: number; caps: Caps; priceSource: PriceOrigin; priceVersion?: number; estimated?: boolean }
export type CorrectionResult = { status: "corrected"; deltaMicros: number; capExceeded?: true } | { status: "already" | "missing" | "expired" | "busy" | "unknown" };
export function costView(rows: readonly MeterRow[]): Array<{ item: MeterItem; spentMicros: number; estimated: boolean }> {
  return rows.map((row) => ({ item: row.item, spentMicros: row.spentMicros, estimated: row.estimatedMicros > 0 }));
}
/** `combined`: the partner (agent) meter's company row, the one combined company monthly cap (DEC 228c). */
interface Target { key: string; item: MeterItem; cap: number | undefined; combined?: true }
interface Open { routeClass?: RouteClass; customerSource?: CustomerSource; provisional?: ProvisionalContext; charge?: ReserveInput["charge"]; month: string; appliedMaxOutputTokens?: number; scope: MeterScope; estimate: number; targets: Target[]; line?: BillLine }
function validScope(value: unknown): value is MeterScope {
  const s = record(value);
  return s !== undefined && typeof s.iss === "string" && s.iss.length > 0 && s.iss.length <= 2048 && typeof s.cid === "string" && COMPANY.test(s.cid) && typeof s.pid === "string" && PROJECT.test(s.pid) && typeof s.tid === "string" && TASK.test(s.tid) && (s.per === undefined || (typeof s.per === "string" && PERSON.test(s.per)));
}
function targets(scope: MeterScope, caps: Caps, month: string, combined = false): Target[] {
  const key = (kind: MeterItem, ...parts: string[]) => JSON.stringify([scope.iss, scope.cid, kind, ...parts]);
  return [
    { key: key("task", scope.tid), item: "task", cap: caps.task },
    ...(scope.per === undefined ? [] : [{ key: key("person", scope.per, month), item: "person" as const, cap: caps.personMonth }]),
    { key: key("project", scope.pid, month), item: "project", cap: caps.projectMonth },
    ...(caps.upkeepMonth === undefined ? [] : [{ key: key("upkeep", scope.pid, month), item: "upkeep" as const, cap: caps.upkeepMonth }]),
    { key: key("company", month), item: "company", cap: caps.companyMonth },
    // The same key as the partner's own company row: the partner's map holds it.
    ...(combined ? [{ key: key("company", month), item: "company" as const, cap: caps.combinedCompanyMonth, combined: true as const }] : []),
  ];
}
export interface InMemoryMeterOptions {
  /** When indexing of runs began (RunChargesRead.indexedSince). Default: when this meter was made. */
  runIndexSince?: number;
  /** DEC 228c: the agent meter whose company row and overrun marker this (product) meter's holds also take. */
  combineCompanyWith?: InMemoryMeter;
}
/** Conditional transaction fake: no await between checking all rows and writing all rows. Conflict hook writes nothing. */
export class InMemoryMeter implements Meter {
  readonly #sourceStops = new Map<string, SourceStop>();
  get #stops(): Map<string, SourceStop> { return this.#partner === undefined ? this.#sourceStops : this.#partner.#sourceStops; }
  #sourceKey(iss: string, cid: string, source: CustomerSource, routeClass?: RouteClass): string { return JSON.stringify([iss, cid, source, routeClass ?? "legacy"]); }
  async sourceStop(iss: string, cid: string, source: CustomerSource, routeClass?: RouteClass): Promise<SourceStop | undefined> { const row = this.#stops.get(this.#sourceKey(iss, cid, source, routeClass)); return row === undefined ? undefined : { ...row }; }

  async clearSourceStop(input: ClearSourceStop): Promise<boolean> {
    if (!validClear(input)) throw new Error("operator clear refused");
    const key = this.#sourceKey(input.iss, input.cid, input.source, input.routeClass === "legacy" ? undefined : input.routeClass), row = this.#stops.get(key);
    if (row?.stopped !== true || row.stopId !== input.expectedStopId || row.inFlight !== undefined || this.#stops.get(this.#sourceKey(input.iss, input.cid, input.source))?.inFlight !== undefined) return false;
    this.#stops.set(key, { ...row, stopped: false, clearedBy: input.actor, clearedAt: this.now(), clearReason: input.reason }); return true;
  }
  #latch(receipt: ChargeReceiptV1 | undefined, routeClass?: RouteClass, noWriteRoute = false): void { const stop = stoppedBy(receipt, this.now(), routeClass, noWriteRoute); if (stop !== undefined) { const key = this.#sourceKey(receipt!.issuer, receipt!.companyId, stop.source, routeClass); this.#stops.set(key, { ...this.#stops.get(key), ...stop }); } }
  readonly #rows = new Map<string, MeterRow>();
  readonly #open = new Map<string, Open>();
  readonly #ledger = new Map<string, { call: EstimatedCall; targets: Target[] }>();
  readonly #pending = new Map<string, string[]>();
  readonly #keyOrder: string[] = [];
  readonly #expiryOrder: string[] = [];
  readonly #ownInFlight = new Map<string, { owner: string; expiresSeconds: number }>();
  readonly #partner: InMemoryMeter | undefined;
  readonly #receipts = new Map<string, { routeClass?: RouteClass; receipt: ChargeReceiptV1; kind: PriceKind; targets: Target[]; amount: number; held: boolean; cutoffAt?: number; provisional?: ProvisionalEstimate; neverConfirmed?: true }>();
  readonly #adjustments = new Map<string, { receipt: ChargeReceiptV1; deltaMicros: number }>();
  readonly #billed = new Map<string, BilledCall>();
  /** GATEWAY-RUN-CHARGES-ROUTE: the calls held for each run, by JSON [iss, cid, task, run] (the Dynamo meter's `RUN#` items). */
  readonly #runs = new Map<string, { ids: string[]; first: number }>();
  readonly #runIndexSince: number;
  constructor(private readonly now: () => number = Date.now, private readonly conflict: () => boolean = () => false, private readonly beforeWrite: (operation: "settle" | "correct" | "expire", rows?: MeterRow[]) => void | Promise<void> = () => undefined, options: InMemoryMeterOptions = {}) {
    if (options.combineCompanyWith !== undefined && (options.combineCompanyWith === this || options.combineCompanyWith.#partner !== undefined)) throw new Error("meter unavailable");
    this.#partner = options.combineCompanyWith;
    this.#runIndexSince = options.runIndexSince ?? this.now();
  }
  get combinedCompany(): boolean { return this.#partner !== undefined; }
  /** One overrun-capable call in flight per company across BOTH meters when combined. */
  get #inFlight(): Map<string, { owner: string; expiresSeconds: number }> { return this.#partner === undefined ? this.#ownInFlight : this.#partner.#ownInFlight; }
  #month(): string { return new Date(this.now()).toISOString().slice(0, 7); }
  #store(target: Target): Map<string, MeterRow> { return target.combined === true && this.#partner !== undefined ? this.#partner.#rows : this.#rows; }
  #row(target: Target, scope: MeterScope): MeterRow { return this.#store(target).get(target.key) ?? { item: target.item, company: scope.cid, spentMicros: 0, estimatedMicros: 0, reservedMicros: 0, committed: 0, overrun: false }; }
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    if (record(input) === undefined || !validScope(input.scope) || !validCaps(input.caps) || !whole(input.estimateMicros)) return { ok: false, reason: "busy" };
    const { scope, caps, estimateMicros } = input;
    if (input.routeClass !== undefined && !validRouteClass(input.routeClass)) return { ok: false, reason: "busy" };
    if (input.customerSource !== undefined && !validCustomerSource(input.customerSource)) return { ok: false, reason: "busy" };
    const customerSource = input.customerSource ?? receiptCustomerSource(input.charge?.receipt);
    if (customerSource !== undefined && (!validRouteClass(input.routeClass) || !validCustomerSource(customerSource) || (input.charge !== undefined && receiptCustomerSource(input.charge.receipt) !== customerSource))) return { ok: false, reason: "busy" };
    if (input.appliedMaxOutputTokens !== undefined && (!whole(input.appliedMaxOutputTokens) || input.appliedMaxOutputTokens < 1)) return { ok: false, reason: "busy" };
    if (input.sweepAfter !== undefined && (!whole(input.sweepAfter) || input.sweepAfter > this.now() + SWEEP_AFTER_MAX_MS)) return { ok: false, reason: "busy" };
    if (input.provisional !== undefined && !validProvisionalContext(input.provisional)) return { ok: false, reason: "busy" };
    if (input.line !== undefined && !validLine(input.line)) return { ok: false, reason: "busy" };
    if (input.review !== undefined && !(typeof input.review.jti === "string" && /^[0-9a-f-]{36}$/u.test(input.review.jti))) return { ok: false, reason: "busy" };
    if (input.run !== undefined && (!validRunScope(input.scope, input.run.operationId) || (input.charge !== undefined && input.charge.receipt.operationId !== input.run.operationId))) return { ok: false, reason: "busy" };
    // Fail closed: a combined meter without the combined company cap holds nothing.
    if (this.#partner !== undefined && caps.combinedCompanyMonth === undefined) return { ok: false, reason: "busy" };
    const clock = Math.floor(this.now() / 1000);
    let expiresSeconds: number | undefined;
    if (input.overrun !== undefined) {
      const marker = record(input.overrun);
      if (marker === undefined || !whole(marker.deadlineSeconds) || !whole(marker.tokenExpiresSeconds)) return { ok: false, reason: "busy" };
      expiresSeconds = Math.min(marker.deadlineSeconds, marker.tokenExpiresSeconds, clock + TASK_TOKEN_SECONDS);
      if (expiresSeconds <= clock) return { ok: false, reason: "busy" };
    }
    const companyKey = JSON.stringify([scope.iss, scope.cid]);
    const month = this.#month();
    if (input.charge !== undefined) {
      try { const r = readSettlementReceipt(input.charge.receipt); checkReceiptScope(r, scope, r.callId, estimateMicros, month); if (r.status !== "awaiting_usage" || !/^[0-9a-f-]{36}$/u.test(r.callId) || !/^[a-f0-9]{64}$/u.test(input.charge.requestFingerprint) || this.#open.has(r.callId)) return { ok: false, reason: "busy" }; } catch { return { ok: false, reason: "busy" }; }
    }
    const items = targets(scope, caps, month, this.#partner !== undefined);
    // Existing spend-row kind, reserved non-task key: source quarantine survives month/task changes.
    // Review clears this row's sticky overrun explicitly; key rotation does not clear it.
    if (input.charge?.receipt.model.provider === "openrouter") items.push({ key: JSON.stringify([scope.iss, scope.cid, "task", "", "openrouter", input.charge.receipt.source.id]), item: "task", cap: undefined });
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.conflict()) continue;
      const sourceKey = customerSource === undefined ? undefined : this.#sourceKey(scope.iss, scope.cid, customerSource);
      const sourceStop = sourceKey === undefined ? undefined : this.#stops.get(sourceKey);
      const classStop = customerSource === undefined ? undefined : this.#stops.get(this.#sourceKey(scope.iss, scope.cid, customerSource, input.routeClass));
      if (sourceStop?.stopped === true || classStop?.stopped === true) return { ok: false, reason: "overrun", item: "company", held: false };
      if (sourceStop?.inFlight !== undefined) return { ok: false, reason: "busy", overrunInFlight: true };
      let blocked: Extract<ReserveResult, { reason: "cap" | "overrun" }> | undefined;
      for (const target of items) {
        const row = this.#row(target, scope);
        if (row.company !== scope.cid) return { ok: false, reason: "busy" };
        if (row.overrun) return { ok: false, reason: "overrun", item: target.item, held: false };
        if (!Number.isSafeInteger(row.committed + estimateMicros)) return { ok: false, reason: "busy" };
        if (target.cap !== undefined && (target.cap - estimateMicros < 0 || row.committed > target.cap - estimateMicros)) {
          const held = row.spentMicros <= target.cap - estimateMicros;
          // A permanent cap refusal takes precedence over a temporary hold on another item.
          if (blocked === undefined || !held) blocked = { ok: false, reason: "cap", item: target.item, held };
        }
      }
      if (blocked !== undefined) return blocked;
      const marker = this.#inFlight.get(companyKey);
      // Expiry frees ONLY the concurrency marker. Open reservations and their rows stay.
      if (marker !== undefined && marker.expiresSeconds <= clock) this.#inFlight.delete(companyKey);
      if (expiresSeconds !== undefined && this.#inFlight.has(companyKey)) return { ok: false, reason: "busy", overrunInFlight: true };
      const reservation = Object.freeze({ id: input.charge?.receipt.callId ?? randomUUID(), ...(input.appliedMaxOutputTokens === undefined ? {} : { appliedMaxOutputTokens: input.appliedMaxOutputTokens }) });
      for (const target of items) { const row = this.#row(target, scope); this.#store(target).set(target.key, { ...row, reservedMicros: row.reservedMicros + estimateMicros, committed: row.committed + estimateMicros }); }
      if (expiresSeconds !== undefined) this.#inFlight.set(companyKey, { owner: reservation.id, expiresSeconds });
      if (input.run !== undefined) { const runKey = JSON.stringify([scope.iss, scope.cid, scope.tid, input.run.operationId]); const at = this.#runs.get(runKey); this.#runs.set(runKey, { ids: [...(at?.ids ?? []), reservation.id], first: at?.first ?? this.now() }); }
      if (customerSource !== undefined && sourceKey !== undefined) this.#stops.set(sourceKey, { source: customerSource, stopped: false, ...sourceStop, inFlight: reservation.id });
      this.#open.set(reservation.id, { ...(input.routeClass === undefined ? {} : { routeClass: input.routeClass }), ...(customerSource === undefined ? {} : { customerSource }), ...(input.provisional === undefined ? {} : { provisional: structuredClone(input.provisional) }), ...(input.charge === undefined ? {} : { charge: structuredClone(input.charge) }), month, ...(input.appliedMaxOutputTokens === undefined ? {} : { appliedMaxOutputTokens: input.appliedMaxOutputTokens }), scope: { ...scope }, estimate: estimateMicros, targets: items, ...(input.line === undefined ? {} : { line: { ...input.line } }) });
      return { ok: true, reservation };
    }
    return { ok: false, reason: "busy" };
  }
  async settle(reservation: Reservation, actualMicros: number, estimated?: EstimatedSettlement, receipt?: ChargeReceiptV1, provisional?: ProvisionalEstimate, noWriteRoute = false): Promise<void> {
    if (record(reservation) === undefined || typeof reservation.id !== "string") throw new Error("settlement unavailable");
    await this.beforeWrite("settle");
    const open = this.#open.get(reservation.id);
    if (open === undefined) return; // Already closed; ledger and rows stay untouched.
    if (!whole(actualMicros)) throw new Error("settlement unavailable");
    if (open.charge !== undefined && receipt === undefined) throw new Error("charge receipt required");
    if (receipt !== undefined) { checkReceiptScope(receipt, open.scope, reservation.id, open.estimate, open.month); if (open.charge !== undefined && receiptIdentity(open.charge.receipt) !== receiptIdentity(receipt)) throw new Error("charge identity changed"); }
    if (estimated !== undefined && (!validEntry({ ...estimated, inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }) || !whole(estimated.settledAt) || (estimated.priceVersion !== undefined && !whole(estimated.priceVersion)) || (estimated.usage !== undefined && !validUsage(estimated.usage)) || (actualMicros < 1 && provisional === undefined))) throw new Error("settlement unavailable");
    const held = provisional !== undefined;
    const extraEstimated = held || estimated === undefined ? 0 : actualMicros;
    const spend = held ? 0 : actualMicros;
    const release = open.estimate - (held ? actualMicros : 0);
    // All validation, ledger insertion and row writes below are one synchronous transaction.
    for (const t of open.targets) {
      const row = this.#row(t, open.scope);
      if (![row.committed - open.estimate + actualMicros, row.spentMicros + spend, row.estimatedMicros + extraEstimated].every(whole) || row.reservedMicros < open.estimate) throw new Error("settlement unavailable");
    }
    for (const target of open.targets) {
      const row = this.#row(target, open.scope); const spentMicros = row.spentMicros + spend;
      this.#store(target).set(target.key, { ...row, ...(target.item === "company" && held ? { provisionalMicros: (row.provisionalMicros ?? 0) + actualMicros } : {}), spentMicros, estimatedMicros: row.estimatedMicros + extraEstimated, reservedMicros: row.reservedMicros - release, committed: row.committed - open.estimate + actualMicros, overrun: row.overrun || (target.cap !== undefined && spentMicros > target.cap), ...(target.cap !== undefined && spentMicros > target.cap ? { overrunOwner: estimated !== undefined && (!row.overrun || row.overrunOwner === JSON.stringify([open.scope.iss, open.scope.cid, reservation.id])) ? JSON.stringify([open.scope.iss, open.scope.cid, reservation.id]) : "" } : {}) });
    }
    if (open.line !== undefined) {
      const callKey = JSON.stringify([open.scope.iss, open.scope.cid, reservation.id]);
      this.#billed.set(callKey, { ...open.scope, callKey, month: open.month, line: { ...open.line }, settledMicros: actualMicros, estimated: estimated !== undefined });
    }
    if (estimated !== undefined) {
      const callKey = JSON.stringify([open.scope.iss, open.scope.cid, reservation.id]);
      const call: EstimatedCall = { ...(provisional === undefined ? {} : { estimateBasis: provisional.estimateBasis, outputEstimateBasis: provisional.outputEstimateBasis, estimateStatus: "estimated" }), ...(receipt?.neverConfirmed === true ? { neverConfirmed: true as const } : {}), ...open.scope, callKey, month: open.month, provider: estimated.provider, model: estimated.model, kind: estimated.kind, usage: { ...(estimated.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) }, chargeStatus: estimated.usage === undefined || !hasUsage(estimated.usage) ? "awaiting_usage" : "estimated", settledAt: estimated.settledAt, settledMicros: actualMicros, ...(estimated.priceVersion === undefined ? {} : { priceVersion: estimated.priceVersion }), status: "pending" };
      this.#ledger.set(callKey, { call, targets: open.targets.map((t) => ({ ...t })) });
      this.#insertPending(call);
    }
    if (receipt !== undefined) {
      const callKey = JSON.stringify([receipt.issuer, receipt.companyId, receipt.callId]);
      this.#receipts.set(callKey, { ...(open.routeClass === undefined ? {} : { routeClass: open.routeClass }), receipt: structuredClone(receipt), kind: open.charge?.kind ?? estimated?.kind ?? "chat", targets: open.targets, amount: actualMicros, held, ...(provisional === undefined ? {} : { provisional, cutoffAt: this.now() }) });
      this.#adjustments.set(`${callKey}:${receipt.revision}`, { receipt: structuredClone(receipt), deltaMicros: actualMicros });
    }
    this.#latch(receipt, open.routeClass, noWriteRoute);
    if (open.customerSource !== undefined) { const key = this.#sourceKey(open.scope.iss, open.scope.cid, open.customerSource), row = this.#stops.get(key); if (row?.inFlight === reservation.id) { const next = { ...row }; delete next.inFlight; this.#stops.set(key, next); } }
    this.#open.delete(reservation.id);
    const companyKey = JSON.stringify([open.scope.iss, open.scope.cid]);
    if (this.#inFlight.get(companyKey)?.owner === reservation.id) this.#inFlight.delete(companyKey);
  }
  async runCharges(scope: RunScope, operationId: string): Promise<RunChargesRead> {
    if (!validRunScope(scope, operationId)) throw new Error("run charges unavailable");
    const run = this.#runs.get(JSON.stringify([scope.iss, scope.cid, scope.tid, operationId]));
    if (run === undefined || run.ids.length === 0) return { found: false };
    const ids = run.ids;
    if (ids.length > RUN_CALLS_MAX) throw new Error("run charges unavailable");
    let complete = true;
    const receipts = ids.map((id) => {
      const open = this.#open.get(id);
      if (open !== undefined) { complete = false; if (open.charge === undefined) throw new Error("run charges unavailable"); return checkRunReceipt(structuredClone(open.charge.receipt), scope, operationId, id); }
      const stored = this.#receipts.get(JSON.stringify([scope.iss, scope.cid, id]));
      if (stored === undefined) throw new Error("run charges unavailable");
      return checkRunReceipt(structuredClone(stored.receipt), scope, operationId, id);
    });
    return { found: true, complete, receipts, indexedSince: this.#runIndexSince, startedBeforeIndex: startedBeforeIndex(run.first, this.#runIndexSince) };
  }
  async settleV2(input: SettleV2): Promise<void> {
    const r = readSettlementReceipt(input.receipt);
    if (input.reservationId !== r.callId || r.revision !== 1) throw new Error("invalid charge settlement");
    const old = this.#receipts.get(JSON.stringify([r.issuer, r.companyId, r.callId]));
    if (old !== undefined) { receiptRevision(old.receipt, r); return; }
    if (!this.#open.has(input.reservationId)) throw new Error("charge reservation missing");
    const open = this.#open.get(input.reservationId)!;
    const outputs = [...this.#receipts.values()].flatMap(({ receipt }) => receipt.issuer === r.issuer && receipt.companyId === r.companyId && receipt.model.provider === r.model.provider && receipt.model.modelId === r.model.modelId && historyOutput(receipt) !== undefined ? [historyOutput(receipt)!] : []);
    for (const { call } of this.#ledger.values()) if (!this.#receipts.has(call.callKey) && call.iss === r.issuer && call.cid === r.companyId && call.provider === r.model.provider && call.model === r.model.modelId && call.chargeStatus !== "awaiting_usage" && hasUsage(call.usage)) outputs.push(call.usage.output);
    const provisional = r.status === "awaiting_usage" && open.provisional !== undefined ? provisionalEstimate(open.estimate, open.provisional, outputs, input.actualInputTokens) : undefined;
    await this.settle({ id: input.reservationId }, provisional?.amountMicros ?? chargeValue(r.amountMicros)!, estimatedReceipt(r, open.charge?.kind), r, provisional, input.noWriteRoute === true);
  }
  async applyChargeReceipt(input: ChargeReceiptV1): Promise<ApplyChargeResult> {
    const r = readSettlementReceipt(input);
    const callKey = JSON.stringify([r.issuer, r.companyId, r.callId]);
    const stored = this.#receipts.get(callKey);
    if (stored === undefined) throw new Error("charge receipt missing");
    const result = receiptRevision(stored.receipt, r);
    if (result !== "applied") {
      const prior = this.#adjustments.get(`${callKey}:${r.revision}`);
      if (result === "older" && prior !== undefined && chargeReceiptContent(prior.receipt) !== chargeReceiptContent(r)) throw new Error("conflicting charge revision");
      return { callId: r.callId, appliedRevision: stored.receipt.revision, result, deltaMicros: 0 };
    }
    const old = stored.receipt, amount = chargeValue(r.amountMicros)!, delta = amount - stored.amount;
    const spendDelta = stored.held ? amount : delta;
    const release = stored.held ? stored.amount : 0;
    const provisionalDelta = stored.provisional === undefined ? 0 : (r.status === "final" ? 0 : amount) - (old.status === "final" ? 0 : stored.amount);
    const estimatedDelta = (r.status === "final" ? 0 : chargeValue(r.amountMicros)!) - (old.status === "final" || stored.held ? 0 : stored.amount);
    // No await between CAS observation and all row/receipt writes.
    if (this.conflict()) throw new Error("charge revision busy");
    for (const t of stored.targets) {
      const row = this.#row(t, { iss: r.issuer, cid: r.companyId, pid: r.project, tid: r.taskId });
      if (![row.spentMicros + spendDelta, row.committed + delta, row.estimatedMicros + estimatedDelta, row.reservedMicros - release, ...(t.item === "company" ? [(row.provisionalMicros ?? 0) + provisionalDelta] : [])].every(whole)) throw new Error("charge accounting unavailable");
    }
    for (const t of stored.targets) {
      const scope = { iss: r.issuer, cid: r.companyId, pid: r.project, tid: r.taskId }, row = this.#row(t, scope);
      this.#store(t).set(t.key, { ...row, spentMicros: row.spentMicros + spendDelta, reservedMicros: row.reservedMicros - release, ...(t.item === "company" && stored.provisional !== undefined ? { provisionalMicros: (row.provisionalMicros ?? 0) + provisionalDelta } : {}), committed: row.committed + delta, estimatedMicros: row.estimatedMicros + estimatedDelta, overrun: row.overrun || (t.cap !== undefined && row.spentMicros + spendDelta > t.cap), ...(t.cap !== undefined && row.spentMicros + spendDelta > t.cap ? { overrunOwner: "" } : {}) });
    }
    this.#latch(r, stored.routeClass);
    const pending = this.#ledger.get(callKey);
    if (pending?.call.status === "pending") this.#removePending(pending.call);
    const estimate = estimatedReceipt(r, stored.kind);
    if (estimate !== undefined) {
      const call: EstimatedCall = { ...(stored.provisional === undefined ? {} : { estimateBasis: stored.provisional.estimateBasis, outputEstimateBasis: stored.provisional.outputEstimateBasis, estimateStatus: "estimated" }), ...(r.neverConfirmed === true ? { neverConfirmed: true } : {}), iss: r.issuer, cid: r.companyId, pid: r.project, tid: r.taskId, callKey, month: r.accountingMonth, provider: r.model.provider, model: r.model.modelId, kind: estimate.kind, usage: estimate.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, chargeStatus: r.status === "awaiting_usage" ? "awaiting_usage" : "estimated", settledAt: Date.parse(r.occurredAt), settledMicros: chargeValue(r.amountMicros)!, status: "pending" };
      this.#ledger.set(callKey, { call, targets: stored.targets }); this.#insertPending(call);
    } else if (pending !== undefined) pending.call = { ...pending.call, settledMicros: chargeValue(r.amountMicros)!, status: "corrected" };
    const billed = this.#billed.get(callKey);
    if (billed !== undefined) this.#billed.set(callKey, { ...billed, settledMicros: chargeValue(r.amountMicros)!, estimated: r.status !== "final" });
    stored.receipt = structuredClone(r); stored.amount = amount; stored.held = false;
    this.#adjustments.set(`${callKey}:${r.revision}`, { receipt: structuredClone(r), deltaMicros: delta });
    return { callId: r.callId, appliedRevision: r.revision, result: "applied", deltaMicros: delta };
  }
  async sweepOpenHolds(now: number, limit: number): Promise<{ swept: number; already: number; failed: number; more: boolean }> {
    let swept = 0;
    for (const stored of this.#receipts.values()) {
      if (swept >= limit) return { swept, already: 0, failed: 0, more: true };
      if (!stored.held || stored.cutoffAt === undefined || now - stored.cutoffAt < USAGE_WAIT_MS) continue;
      await this.applyChargeReceipt(neverConfirmedReceipt(stored.receipt, stored.amount, now));
      stored.neverConfirmed = true; swept++;
    }
    return { swept, already: 0, failed: 0, more: false };
  }
  #insertPending(call: EstimatedCall): void {
    const callKey = call.callKey;
      const key = priceKey(call); const pending = this.#pending.get(key) ?? [];
      // Keep oldest first at write time; reads take bounded prefixes without scanning the ledger.
      const index = pending.findIndex((id) => comparePosition(this.#callPosition(id), [call.settledAt, callKey]) > 0);
      const expiryIndex = this.#expiryOrder.findIndex((id) => comparePosition(this.#callPosition(id), [call.settledAt, callKey]) > 0);
      this.#expiryOrder.splice(expiryIndex < 0 ? this.#expiryOrder.length : expiryIndex, 0, callKey);
      pending.splice(index < 0 ? pending.length : index, 0, callKey); this.#pending.set(key, pending); this.#orderKey(key);
  }
  #orderKey(key: string): void {
    const previous = this.#keyOrder.indexOf(key); if (previous >= 0) this.#keyOrder.splice(previous, 1);
    const first = this.#pending.get(key)?.[0]; if (first === undefined) { this.#pending.delete(key); return; }
    const at = this.#keyOrder.findIndex((k) => comparePosition(this.#keyPosition(k), this.#keyPosition(key)) > 0);
    this.#keyOrder.splice(at < 0 ? this.#keyOrder.length : at, 0, key);
  }
  #callPosition = (id: string): PendingPosition => [this.#ledger.get(id)!.call.settledAt, id];
  #keyPosition = (key: string): PendingPosition => [this.#ledger.get(this.#pending.get(key)![0]!)!.call.settledAt, key];
  async pendingKeys(limit: number, cursor?: string): Promise<PendingPage<PriceKey>> {
    return pendingPage(this.#keyOrder, this.#keyPosition, (key) => {
      const call = this.#ledger.get(this.#pending.get(key)![0]!)!.call; return { provider: call.provider, model: call.model };
    }, "keys", limit, cursor);
  }
  async pendingFor(key: PriceKey, limit: number, cursor?: string): Promise<PendingPage<EstimatedCall>> {
    if (!validEntry({ ...key, kind: "chat", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 })) throw new Error("pending unavailable");
    const id = priceKey(key);
    return pendingPage(this.#pending.get(id) ?? [], this.#callPosition, (callKey) => structuredClone(this.#ledger.get(callKey)!.call), id, limit, cursor);
  }
  async pendingExpired(now: number, limit: number, cursor?: string): Promise<PendingPage<EstimatedCall>> {
    if (!whole(now)) throw new Error("pending unavailable");
    return pendingPage(this.#expiryOrder, this.#callPosition, (id) => structuredClone(this.#ledger.get(id)!.call), "expiry", limit, cursor, now - PENDING_RETENTION_DAYS * DAY_MS);
  }
  #removePending(call: EstimatedCall): void {
    const key = priceKey(call); const pending = this.#pending.get(key)!;
    pending.splice(pending.indexOf(call.callKey), 1); this.#orderKey(key);
    this.#expiryOrder.splice(this.#expiryOrder.indexOf(call.callKey), 1);
  }
  #validTransaction(input: unknown): input is ExpiryInput {
    const v = record(input);
    return v !== undefined && typeof v.callKey === "string" && v.callKey.length > 0 && v.callKey.length <= 4096 && whole(v.now) && typeof v.runId === "string" && v.runId.length > 0 && v.runId.length <= 512 && (v.signal === undefined || v.signal instanceof AbortSignal);
  }
  async #beforeTransaction(operation: "correct" | "expire", input: ExpiryInput, rows?: MeterRow[]): Promise<boolean> {
    if (input.signal?.aborted) return false;
    let abort!: () => void;
    const stopped = new Promise<false>((resolve) => { abort = () => resolve(false); });
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, CORRECTION_RUN_MS);
    try {
      const ready = await Promise.race([Promise.resolve(this.beforeWrite(operation, rows)).then(() => true), stopped]);
      return ready && !input.signal?.aborted;
    } catch { return false; }
    finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); }
  }
  async expire(input: ExpiryInput): Promise<CorrectionResult> {
    if (!this.#validTransaction(input)) return { status: "busy" };
    if (!await this.#beforeTransaction("expire", input) || input.signal?.aborted) return { status: "unknown" };
    const ledger = this.#ledger.get(input.callKey); if (ledger === undefined) return { status: "missing" };
    const { call } = ledger; if (call.status !== "pending") return { status: "already" };
    if (call.chargeStatus === "awaiting_usage") { call.unresolvedAt ??= input.now; return { status: "busy" }; }
    if (input.now - call.settledAt <= PENDING_RETENTION_DAYS * DAY_MS) return { status: call.neverConfirmed === true ? "already" : "busy" };
    if (this.conflict()) return { status: "busy" };
    ledger.call = { ...call, status: "expired", expiredAt: input.now, runId: input.runId };
    this.#removePending(call); return { status: "expired" };
  }
  ledger(callKey: string): EstimatedCall | undefined { const row = this.#ledger.get(callKey); return row === undefined ? undefined : structuredClone(row.call); }
  async correct(input: CorrectionInput): Promise<CorrectionResult> {
    const origin = record(record(input)?.priceSource);
    if (!this.#validTransaction(input) || (input.priceVersion !== undefined && (!whole(input.priceVersion) || typeof input.estimated !== "boolean")) || (input.estimated !== undefined && (!whole(input.priceVersion) || typeof input.estimated !== "boolean")) || !whole(input.realMicros) || input.realMicros < 1 || !validCaps(input.caps) || !whole(input.now) || typeof input.runId !== "string" || input.runId.length === 0 || input.runId.length > 512 || origin === undefined || typeof origin.source !== "string" || !["litellm", "aws", "override"].includes(origin.source) || !whole(origin.fetchedAt)) return { status: "busy" };
    const observed = this.#ledger.get(input.callKey);
    // Fake-adapter fault injection: the trusted hook can corrupt an item to prove underflow refusal.
    if (!await this.#beforeTransaction("correct", input, observed?.targets.map((target) => this.#row(target, observed.call))) || input.signal?.aborted) return { status: "unknown" };
    // Re-read after the race hook. No await until every row and the ledger have committed.
    const ledger = this.#ledger.get(input.callKey); if (ledger === undefined) return { status: "missing" };
    const { call } = ledger; if (call.status !== "pending") return { status: "already" };
    if (call.neverConfirmed === true) return { status: "already" };
    if (call.chargeStatus === "awaiting_usage" || this.#receipts.has(input.callKey)) return { status: "busy" };
    if (this.conflict()) return { status: "busy" };
    const expire = input.now - call.settledAt > PENDING_RETENTION_DAYS * DAY_MS;
    if (!expire && (input.priceVersion ?? 0) <= (call.priceVersion ?? 0)) return { status: "already" };
    const deltaMicros = input.realMicros - call.settledMicros;
    const estimatedDelta = input.estimated === true ? deltaMicros : -call.settledMicros;
    let capExceeded = false;
    if (!expire) {
      for (const target of ledger.targets) {
        const row = this.#row(target, call);
        if (row.company !== call.cid || ![row.spentMicros + deltaMicros, row.committed + deltaMicros, row.estimatedMicros + estimatedDelta].every((value) => whole(value) && value < Number.MAX_SAFE_INTEGER) || row.estimatedMicros + estimatedDelta > row.spentMicros + deltaMicros) return { status: "busy" };
      }
      const capFor = { task: input.caps.task, person: input.caps.personMonth, project: input.caps.projectMonth, upkeep: input.caps.upkeepMonth, company: input.caps.companyMonth };
      for (const target of ledger.targets) {
        const row = this.#row(target, call); const spentMicros = row.spentMicros + deltaMicros; // The upkeep row's cap is not in the corrections' caps (they carry no origin): the one stored with the hold applies.
        const cap = target.combined === true ? input.caps.combinedCompanyMonth : target.item === "upkeep" ? capFor.upkeep ?? target.cap : capFor[target.item];
        if (deltaMicros > 0 && cap !== undefined && row.committed + deltaMicros > cap) capExceeded = true;
        this.#store(target).set(target.key, { ...row, spentMicros, committed: row.committed + deltaMicros, estimatedMicros: row.estimatedMicros + estimatedDelta, overrun: cap === undefined ? row.overrun : (row.overrun && row.overrunOwner !== input.callKey) || spentMicros > cap, ...(cap !== undefined && spentMicros > cap && !row.overrun ? { overrunOwner: input.callKey } : {}) });
      }
    }
    ledger.call = expire ? { ...call, status: "expired", expiredAt: input.now, runId: input.runId } : { ...call, status: input.estimated === true ? "pending" : "corrected", settledMicros: input.realMicros, ...(input.priceVersion === undefined ? {} : { priceVersion: input.priceVersion }), correctedFrom: call.settledMicros, correctedTo: input.realMicros, deltaMicros, correctedAt: input.now, runId: input.runId, priceSource: { ...input.priceSource }, ...(capExceeded ? { capExceeded: true } : {}) };
    if (expire || input.estimated !== true) this.#removePending(call);
    return expire ? { status: "expired" } : { status: "corrected", deltaMicros, ...(capExceeded ? { capExceeded: true } : {}) };
  }
  /** The billable lines of this company's settled calls (DEC 240b), oldest first. */
  billedCalls(iss: string, cid: string): BilledCall[] { return [...this.#billed.values()].filter((c) => c.iss === iss && c.cid === cid).map((c) => structuredClone(c)); }
  async read(scope: MeterScope, options?: { upkeep?: true }): Promise<readonly MeterRow[]> {
    if (!validScope(scope)) throw new Error("meter unavailable");
    return targets(scope, { task: 0, projectMonth: 0, ...(options?.upkeep === true ? { upkeepMonth: 0 } : {}) }, this.#month()).map((t) => ({ ...this.#row(t, scope) }));
  }
}
/** Adapter-neutral executable contract. No test runner dependency; adapters must also run conflict-injection proofs. */
export async function runMeterConformance(factory: (clock: () => number) => Meter): Promise<string[]> {
  const scope = { iss: "https://install.example/v1/auth", cid: `org_${"a".repeat(20)}`, pid: "web", tid: "task_1" };
  const caps = { task: 100, projectMonth: 100, companyMonth: 100 };
  let clock = Date.UTC(2026, 0, 1);
  const meter = factory(() => clock);
  const reserved = await meter.reserve({ scope, caps, estimateMicros: 60 }); assert(reserved.ok);
  assert((await meter.read(scope)).every((r) => r.reservedMicros === 60 && r.spentMicros === 0));
  assert(!(await meter.reserve({ scope, caps, estimateMicros: 60 })).ok);
  assert((await meter.read(scope)).every((r) => r.reservedMicros === 60));
  await meter.settle(reserved.reservation, 101);
  assert((await meter.read(scope)).every((r) => r.spentMicros === 101 && r.overrun));
  await meter.settle(reserved.reservation, 50); assert((await meter.read(scope)).every((r) => r.spentMicros === 101));
  assert(!(await meter.reserve({ scope: { ...scope, tid: "task_2" }, caps, estimateMicros: 1 })).ok);
  assert((await meter.reserve({ scope: { ...scope, cid: `org_${"b".repeat(20)}` }, caps, estimateMicros: 1 })).ok);
  assert(!(await meter.read(scope)).some((r) => r.item === "person"));
  const marked = factory(() => clock);
  const args = { scope, caps, estimateMicros: 40, overrun: { deadlineSeconds: clock / 1000 + 10, tokenExpiresSeconds: clock / 1000 + 900 } };
  const old = await marked.reserve(args); assert(old.ok);
  assert.deepEqual(await marked.reserve(args), { ok: false, reason: "busy", overrunInFlight: true });
  // A bounded priced call is not serialized behind an estimated call.
  const priced = await marked.reserve({ scope, caps, estimateMicros: 10 }); assert(priced.ok);
  await marked.settle(priced.reservation, 10);
  clock += 10_000;
  const newer = await marked.reserve({ ...args, overrun: { ...args.overrun, deadlineSeconds: clock / 1000 + 10 } }); assert(newer.ok);
  assert((await marked.read(scope)).every((r) => r.reservedMicros === 80 && r.spentMicros === 10));
  await marked.settle(old.reservation, 40);
  assert.deepEqual(await marked.reserve({ ...args, estimateMicros: 1, overrun: { ...args.overrun, deadlineSeconds: clock / 1000 + 10 } }), { ok: false, reason: "busy", overrunInFlight: true });
  await marked.settle(newer.reservation, 70);
  assert((await marked.read(scope)).every((r) => r.reservedMicros === 0 && r.spentMicros === 120 && r.overrun));
  const corrections = factory(() => clock);
  const e = await corrections.reserve({ scope, caps, estimateMicros: 90 }); assert(e.ok);
  await corrections.settle(e.reservation, 80, { provider: "anthropic", model: "model", kind: "chat", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, settledAt: clock });
  assert((await corrections.read(scope)).every((r) => r.estimatedMicros === 80));
  const pending = await corrections.pendingFor({ provider: "anthropic", model: "model" }, 10); assert.equal(pending.items.length, 1);
  const correction = { callKey: pending.items[0]!.callKey, realMicros: 20, caps, priceVersion: 1, estimated: false, priceSource: { source: "litellm" as const, fetchedAt: clock }, runId: "conformance", now: clock };
  assert.deepEqual(await corrections.correct(correction), { status: "corrected", deltaMicros: -60 });
  assert.deepEqual(await corrections.correct(correction), { status: "already" });
  assert((await corrections.read(scope)).every((r) => r.spentMicros === 20 && r.estimatedMicros === 0 && r.committed === 20));
  assert((await corrections.reserve({ scope, caps, estimateMicros: 80 })).ok);
  const partials = factory(() => clock);
  const held = await partials.reserve({ scope, caps, estimateMicros: 90 }); assert(held.ok);
  await partials.settle(held.reservation, 80, { provider: "anthropic", model: "model", kind: "chat", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, settledAt: clock });
  const partialCall = (await partials.pendingFor({ provider: "anthropic", model: "model" }, 1)).items[0]!;
  const partial = { ...correction, callKey: partialCall.callKey, realMicros: 60, priceVersion: 1, estimated: true };
  assert.deepEqual(await partials.correct(partial), { status: "corrected", deltaMicros: -20 });
  assert.deepEqual(await partials.correct(partial), { status: "already" });
  assert((await partials.read(scope)).every((r) => r.spentMicros === 60 && r.estimatedMicros === 60));
  assert.equal((await partials.pendingFor({ provider: "anthropic", model: "model" }, 1)).items[0]!.settledMicros, 60);
  assert.deepEqual(await partials.correct({ ...partial, realMicros: 70, priceVersion: 2 }), { status: "corrected", deltaMicros: 10 });
  assert.deepEqual(await partials.correct(partial), { status: "already" });
  assert.deepEqual(await partials.correct({ ...partial, realMicros: 50, priceVersion: 3, estimated: false }), { status: "corrected", deltaMicros: -20 });
  assert((await partials.read(scope)).every((r) => r.spentMicros === 50 && r.estimatedMicros === 0));
  assert.equal((await partials.pendingKeys(1)).items.length, 0);
  return ["partial versioned correction", "atomic estimated ledger", "idempotent correction", "correction frees budget", "one overrun in flight", "marker expiry keeps hold", "atomic hold", "cap subtraction", "no partial write", "overrun settle", "closed settle", "company ceiling", "isolation", "optional person"];
}
/** Adapter conformance with a pause BEFORE commit. Implementations inject their transaction seam,
 * cancel it on signal, and enforce pending-status CAS when the same call is retried. */
export async function runMeterDeadlineConformance(factory: (clock: () => number, beforeWrite: (operation: "settle" | "correct" | "expire") => Promise<void>) => Meter): Promise<string[]> {
  const now = Date.UTC(2026, 3, 1);
  const scope = { iss: "https://install.example/v1/auth", cid: `org_${"a".repeat(20)}`, pid: "web", tid: "task_1" };
  const caps = { task: 100, projectMonth: 100, companyMonth: 100 };
  for (const operation of ["correct", "expire"] as const) {
    let release!: () => void; let enter!: () => void; let hang = true;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const meter = factory(() => now, async (op) => { if (op === operation && hang) { enter(); await new Promise<void>((resolve) => { release = resolve; }); } });
    const reserved = await meter.reserve({ scope, caps, estimateMicros: 80 }); assert(reserved.ok);
    await meter.settle(reserved.reservation, 80, { provider: "anthropic", model: "model", kind: "chat", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, settledAt: operation === "expire" ? now - 63 * DAY_MS : now });
    const page = await meter.pendingFor({ provider: "anthropic", model: "model" }, 1); assert.equal(page.items.length, 1);
    const controller = new AbortController();
    const input = { callKey: page.items[0]!.callKey, now, runId: "conformance", signal: controller.signal };
    const correction = { ...input, realMicros: 20, caps, priceVersion: 1, estimated: false, priceSource: { source: "litellm" as const, fetchedAt: now } };
    const pending = operation === "correct" ? meter.correct(correction) : meter.expire(input);
    await entered; controller.abort();
    assert.deepEqual(await pending, { status: "unknown" });
    release(); await Promise.resolve();
    assert((await meter.read(scope)).every((row) => row.spentMicros === 80 && row.estimatedMicros === 80));
    assert.equal((await meter.pendingFor({ provider: "anthropic", model: "model" }, 1)).items.length, 1);
    hang = false; const signal = new AbortController().signal;
    const retried = operation === "correct" ? await meter.correct({ ...correction, signal }) : await meter.expire({ ...input, signal });
    assert.equal(retried.status, operation === "correct" ? "corrected" : "expired");
    assert.equal((await meter.pendingFor({ provider: "anthropic", model: "model" }, 1)).items.length, 0);
  }
  return ["bounded correction transaction", "no late correction write", "bounded expiry transaction", "no late expiry write"];
}

export * from "./charge-receipt.js";
