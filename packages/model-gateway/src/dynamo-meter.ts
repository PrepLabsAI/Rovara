import { validRouteClass, validCustomerSource, receiptCustomerSource, sourceStopKey, stoppedBy, readSourceStop, validClear, type RouteClass, type CustomerSource, type SourceStop, type ClearSourceStop } from "./source-stop.js";
import { validProvisionalContext, historyOutput, neverConfirmedReceipt, provisionalEstimate, USAGE_WAIT_MS, type ProvisionalContext, type ProvisionalEstimate } from "./provisional.js";
import { chargeValue, chargeReceiptContent, type ApplyChargeResult, type ChargeReceiptV1, type SettleV2 } from "./charge-receipt.js";
import { checkReceiptScope, estimatedReceipt, readSettlementReceipt, receiptIdentity, receiptRevision } from "./charge-settlement.js";
import { randomUUID } from "node:crypto";
import { AwsNotSentError } from "./aws.js";
import { validCaps, type Caps } from "./caps.js";
import { GATEWAY_COMPANY_KEY_PREFIX, GATEWAY_LEDGER_INDEXES, GATEWAY_METER_INDEXES, GATEWAY_OPEN_PARTITION, GATEWAY_PENDING_PARTITION } from "./deploy.js";
import { CALL_HARD_CEILING_MS } from "./provider.js";
import { TransactionRefused, type Dynamo, type Expr, type Item, type Plain, type TransactAction } from "./dynamo.js";
import type { EndedTaskRecorder, EndedTasks } from "./ended.js";
import { checkRunReceipt, RUN_CALLS_MAX, runKeyPrefix, startedBeforeIndex, SWEEP_AFTER_MAX_MS, validLine, validRunScope } from "./meter.js";
import type { BillLine, CorrectionInput, CorrectionResult, EstimatedCall, EstimatedSettlement, ExpiryInput, Meter, MeterItem, MeterRow, MeterScope, Reservation, ReserveInput, ReserveResult, RunChargesRead, RunScope } from "./meter.js";
import { COMPANY, PERSON, PROJECT, TASK, TASK_TOKEN_SECONDS, record, whole } from "./model-gateway-token.js";
import type { PendingPage } from "./pending-page.js";
import { CORRECTION_RUN_MAX, CORRECTION_RUN_MS, DAY_MS, PENDING_RETENTION_DAYS } from "./price-constants.js";
import { priceKey, validEntry, type PriceKey } from "./price-snapshot.js";
import { hasUsage, validUsage } from "./reported-cost.js";
import { MEDIA_USAGE_KEYS, type TokenUsage } from "./usage.js";

/**
 * The DynamoDB Meter (meter.ts's contract; runMeterConformance and runMeterDeadlineConformance hold it to InMemoryMeter).
 *
 *   meter table   CO#[iss,cid] / ROW#[item...]   spend rows (task; person, project, company per month)
 *                 CO#[iss,cid] / HOLD#<id>       one per reservation: open, then settled (kept, never deleted)
 *                 CO#[iss,cid] / RUN#[task,run]#<id>  one per reservation made for a run (ReserveInput.run), written in the SAME transaction as its hold:
 *                                                the run's calls are the items under one prefix (runCharges). Calls held before this item existed have none.
 *                 CO#META#run-index / SINCE      one per environment, written once (markRunIndex): when those items began. Its key starts with the company prefix, so the serving role's grant covers it.
 *   ledger table  CO#[iss,cid] / CALL#<id>       one per settled call; an estimated call is "pending" (in both pending
 *                                                indexes) until corrected or expired
 *   markers table CO#[iss,cid] / INFLIGHT        the company's one estimated-price call in flight (expires)
 *                 CO#[iss,cid] / ENDED#<task>    an ended task (written by the task-ended notice, task-ended-notice.ts; expires)
 *
 * Every write that moves money is one conditional transaction, so two servers never lose or double an update: a reservation
 * adds to each row only while the row is still under its cap; a settle moves a hold to spend only while the hold is open; a
 * correction applies only while the ledger row is still pending at the version it read. Nothing here deletes a meter or
 * ledger row (the serving role has no DeleteItem there); only the in-flight marker is deleted.
 */
export interface DynamoMeterTables { meter: string; ledger: string; markers: string }
export interface DynamoMeterOptions {
  db: Dynamo; tables: DynamoMeterTables; now?: () => number;
  /**
   * DEC 228c, the product meter only: the AGENT meter's meter and markers tables. Every hold of this meter also takes the agent
   * meter's company row (`Caps.combinedCompanyMonth`, one combined company monthly cap) in the same conditional transaction, and
   * the company's one overrun-capable call in flight is the agent markers table's INFLIGHT item, shared by both routes.
   */
  combinedCompany?: { meter: string; markers: string };
  /** Test seam (the conformance's pause before commit). */
  beforeWrite?: (operation: "settle" | "correct" | "expire", rows?: MeterRow[]) => void | Promise<void>;
}

export const companyPartition = (iss: string, cid: string): string => `${GATEWAY_COMPANY_KEY_PREFIX}${JSON.stringify([iss, cid])}`;
const INFLIGHT = "INFLIGHT";
const MAX = Number.MAX_SAFE_INTEGER;
const SETTLE_ATTEMPTS = 6;
const CORRECT_ATTEMPTS = 3;
/** Jittered exponential pause between conditional retries (contention on one company's rows), at most ~0.8 s. */
const backoff = (attempt: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, Math.floor(Math.random() * 25 * 2 ** Math.min(attempt, 5))); });
const pad = (n: number): string => String(n).padStart(16, "0");
const pendingKeyAt = (key: string, settledAt: number, callKey: string): string => `${key}|${pad(settledAt)}|${callKey}`;
const pendingAt = (settledAt: number, callKey: string): string => `${pad(settledAt)}|${callKey}`;
const openAt = (createdAt: number, pk: string, id: string): string => `${pad(createdAt)}|${pk}|${id}`;
/** A hold is swept only well after its call must have ended: the one-hour call ceiling plus fifteen minutes. */
export const HOLD_SWEEP_AGE_MS = CALL_HARD_CEILING_MS + 15 * 60_000;
export const HOLD_SWEEP_MAX = 100;

/** `combined`: the agent meter's company row (DynamoMeterOptions.combinedCompany), in the agent meter table. */
interface Target { sk: string; item: MeterItem; cap?: number; combined?: true }
interface Hold { routeClass?: RouteClass; customerSource?: CustomerSource; provisional?: ProvisionalContext; cutoffAt?: number; charge?: ReserveInput["charge"]; scope: MeterScope; month: string; estimate: number; targets: Target[]; status: string; line?: BillLine; review?: string }

function validScope(value: unknown): value is MeterScope {
  const s = record(value);
  return s !== undefined && typeof s.iss === "string" && s.iss.length > 0 && s.iss.length <= 2048 && typeof s.cid === "string" && COMPANY.test(s.cid) && typeof s.pid === "string" && PROJECT.test(s.pid) && typeof s.tid === "string" && TASK.test(s.tid) && (s.per === undefined || (typeof s.per === "string" && PERSON.test(s.per)));
}
function targetsFor(scope: MeterScope, caps: Caps, month: string, combined = false): Target[] {
  const sk = (...parts: string[]) => `ROW#${JSON.stringify(parts)}`;
  const withCap = (target: Target, cap: number | undefined): Target => cap === undefined ? target : { ...target, cap };
  return [
    withCap({ sk: sk("task", scope.tid), item: "task" }, caps.task),
    ...(scope.per === undefined ? [] : [withCap({ sk: sk("person", scope.per, month), item: "person" }, caps.personMonth)]),
    withCap({ sk: sk("project", scope.pid, month), item: "project" }, caps.projectMonth),
    // Only a call of nightly-upkeep origin carries this cap (L4-E): its project row of upkeep spend, in addition to the rows above and below.
    ...(caps.upkeepMonth === undefined ? [] : [withCap({ sk: sk("upkeep", scope.pid, month), item: "upkeep" }, caps.upkeepMonth)]),
    withCap({ sk: sk("company", month), item: "company" }, caps.companyMonth),
    // The agent meter's own company row key, in the agent meter table.
    ...(combined ? [withCap({ sk: sk("company", month), item: "company", combined: true }, caps.combinedCompanyMonth)] : []),
  ];
}
const scopeFields = (scope: MeterScope): Item => ({ iss: scope.iss, cid: scope.cid, pid: scope.pid, tid: scope.tid, ...(scope.per === undefined ? {} : { per: scope.per }) });
const targetsPlain = (targets: readonly Target[]): Plain => targets.map((t) => ({ sk: t.sk, item: t.item, ...(t.cap === undefined ? {} : { cap: t.cap }), ...(t.combined === true ? { combined: true } : {}) }));
/** `combined`: whether this meter combines; a stored combined target on a meter that does not is unreadable (fail closed). */
function readTargets(value: unknown, combined = false): Target[] | undefined {
  if (!Array.isArray(value) || value.length < 3 || value.length > (combined ? 7 : 6)) return undefined;
  const targets: Target[] = [];
  for (const entry of value) {
    const t = record(entry);
    if (t === undefined || typeof t.sk !== "string" || !t.sk.startsWith("ROW#") || !["task", "person", "project", "upkeep", "company"].includes(t.item as string) || (t.cap !== undefined && !whole(t.cap))) return undefined;
    if (t.combined !== undefined && (t.combined !== true || !combined || t.item !== "company")) return undefined;
    targets.push({ sk: t.sk, item: t.item as MeterItem, ...(t.cap === undefined ? {} : { cap: t.cap }), ...(t.combined === true ? { combined: true as const } : {}) });
  }
  return targets;
}
function readHold(item: Item | undefined, combined: boolean): Hold | undefined {
  if (item === undefined) return undefined;
  const scope = { iss: item.iss, cid: item.cid, pid: item.pid, tid: item.tid, ...(item.per === undefined ? {} : { per: item.per }) };
  const targets = readTargets(item.targets, combined);
  if (!validScope(scope) || targets === undefined || typeof item.month !== "string" || !whole(item.estimateMicros) || typeof item.status !== "string") throw new Error("settlement unavailable");
  // A billable line (DEC 240b) that does not read keeps the hold open (the sweep retries): it is never dropped from the ledger row.
  if (item.provisional !== undefined && !validProvisionalContext(item.provisional)) throw new Error("settlement unavailable");
  if (item.line !== undefined && !validLine(item.line)) throw new Error("settlement unavailable");
  if (item.review !== undefined && !(typeof item.review === "string" && /^[0-9a-f-]{36}$/u.test(item.review))) throw new Error("settlement unavailable");
  if (item.routeClass !== undefined && !validRouteClass(item.routeClass)) throw new Error("settlement unavailable");
  if (item.customerSource !== undefined && !validCustomerSource(item.customerSource)) throw new Error("settlement unavailable");
  return { ...(item.routeClass === undefined ? {} : { routeClass: item.routeClass }), ...(item.customerSource === undefined ? {} : { customerSource: item.customerSource }), ...(item.provisional === undefined ? {} : { provisional: item.provisional as unknown as ProvisionalContext }), ...(whole(item.cutoffAt) ? { cutoffAt: item.cutoffAt } : {}), ...(item.charge === undefined ? {} : { charge: JSON.parse(JSON.stringify(item.charge)) as NonNullable<ReserveInput["charge"]> }), scope, month: item.month, estimate: item.estimateMicros, targets, status: item.status, ...(item.review === undefined ? {} : { review: item.review }), ...(item.line === undefined ? {} : { line: { source: item.line.source, charge: item.line.charge, model: item.line.model } }) };
}
function rowOf(item: Item | undefined, target: Target, company: string): MeterRow {
  if (item === undefined) return { item: target.item, company, spentMicros: 0, estimatedMicros: 0, reservedMicros: 0, committed: 0, overrun: false };
  const row = { item: item.item, company: item.company, spentMicros: item.spentMicros, estimatedMicros: item.estimatedMicros, reservedMicros: item.reservedMicros, committed: item.committed, overrun: item.overrun };
  if (row.item !== target.item || typeof row.company !== "string" || ![row.spentMicros, row.estimatedMicros, row.reservedMicros, row.committed].every(whole) || typeof row.overrun !== "boolean") throw new Error("meter unavailable");
  if (item.provisionalMicros !== undefined && !whole(item.provisionalMicros)) throw new Error("meter unavailable");
  return { ...row, ...(typeof item.overrunOwner === "string" ? { overrunOwner: item.overrunOwner } : {}), ...(item.provisionalMicros === undefined ? {} : { provisionalMicros: item.provisionalMicros }) } as MeterRow;
}
function usagePlain(usage: EstimatedSettlement["usage"] & object): Item {
  return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, ...(usage.cacheWrite5m === undefined ? {} : { cacheWrite5m: usage.cacheWrite5m }), ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
    // Audio and video parts (DEC 228e): a correction re-prices them at their own rates, so they are kept.
    ...Object.fromEntries(MEDIA_USAGE_KEYS.filter((k) => usage[k] !== undefined).map((k) => [k, usage[k]!])) };
}
/** A pending ledger row back to the EstimatedCall shape (the meter's fields only; keys, targets and index attributes dropped). */
function toCall(item: Item): EstimatedCall {
  const scope = { iss: item.iss, cid: item.cid, pid: item.pid, tid: item.tid, ...(item.per === undefined ? {} : { per: item.per }) };
  if (!validScope(scope) || typeof item.callKey !== "string" || typeof item.month !== "string" || typeof item.provider !== "string" || typeof item.model !== "string" || (item.kind !== "chat" && item.kind !== "embedding") || !validUsage(item.usage) || !whole(item.settledMicros) || !whole(item.settledAt) || !["pending", "corrected", "expired"].includes(item.status as string)) throw new Error("pending unavailable");
  const optional = ["priceVersion", "correctedFrom", "correctedTo", "correctedAt", "expiredAt"] as const;
  const call: EstimatedCall = { ...scope, callKey: item.callKey, month: item.month, provider: item.provider, model: item.model, kind: item.kind, usage: { ...(item.usage as unknown as TokenUsage) }, settledMicros: item.settledMicros, status: item.status as EstimatedCall["status"], settledAt: item.settledAt };
  for (const name of optional) { const v = item[name]; if (v !== undefined) { if (!whole(v)) throw new Error("pending unavailable"); call[name] = v; } }
  if (typeof item.deltaMicros === "number" && Number.isSafeInteger(item.deltaMicros)) call.deltaMicros = item.deltaMicros;
  if (item.chargeStatus === "awaiting_usage" || item.chargeStatus === "estimated") call.chargeStatus = item.chargeStatus;
  if (["input_actual", "input_bytes_bound", "reservation"].includes(item.estimateBasis as string)) call.estimateBasis = item.estimateBasis as ProvisionalEstimate["estimateBasis"];
  if (item.outputEstimateBasis === "p90_history" || item.outputEstimateBasis === "max_output") call.outputEstimateBasis = item.outputEstimateBasis;
  if (item.estimateStatus === "estimated") call.estimateStatus = "estimated";
  if (item.neverConfirmed === true) call.neverConfirmed = true;
  if (item.capExceeded === true) call.capExceeded = true;
  if (typeof item.runId === "string") call.runId = item.runId;
  const origin = record(item.priceSource);
  if (origin !== undefined && typeof origin.source === "string" && ["litellm", "aws", "override"].includes(origin.source) && whole(origin.fetchedAt)) call.priceSource = { source: origin.source as "litellm" | "aws" | "override", fetchedAt: origin.fetchedAt };
  return call;
}
function parseCallKey(callKey: string): { pk: string; sk: string; iss: string; cid: string } | undefined {
  let parsed: unknown; try { parsed = JSON.parse(callKey); } catch { return undefined; }
  if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((part) => typeof part === "string") || JSON.stringify(parsed) !== callKey) return undefined;
  const [iss, cid, id] = parsed as [string, string, string];
  if (iss.length === 0 || iss.length > 2048 || !COMPANY.test(cid) || !/^[0-9a-f-]{36}$/u.test(id)) return undefined;
  return { pk: companyPartition(iss, cid), sk: `CALL#${id}`, iss, cid };
}
/** The ledger item's key: exactly the table's key attributes. DynamoDB refuses a key with any other attribute ("The number of conditions on the keys is invalid"), so the parsed call key (iss, cid too) is never passed as one. */
const ledgerKey = (where: { pk: string; sk: string }): { pk: string; sk: string } => ({ pk: where.pk, sk: where.sk });

export class DynamoMeter implements Meter {
  readonly #db: Dynamo;
  readonly #t: DynamoMeterTables;
  readonly #now: () => number;
  readonly #beforeWrite: NonNullable<DynamoMeterOptions["beforeWrite"]>;
  /** Where each reservation this process made lives. A reservation is settled by the process that made it (server.ts's finally). */
  readonly #holds = new WeakMap<object, { pk: string; id: string }>();
  /** Where the next hold sweep resumes (an open-holds index position); undefined: from the oldest. */
  #sweepAfter: string | undefined;
  /** This process has seen the run-index marker (markRunIndex). */
  #runIndexMarked = false;
  readonly #combined: { meter: string; markers: string } | undefined;
  constructor(options: DynamoMeterOptions) {
    this.#db = options.db; this.#t = options.tables; this.#now = options.now ?? Date.now; this.#beforeWrite = options.beforeWrite ?? (() => undefined);
    const combined = options.combinedCompany;
    if (combined !== undefined && (typeof combined.meter !== "string" || typeof combined.markers !== "string" || combined.meter.length === 0 || combined.markers.length === 0 || combined.meter === options.tables.meter)) throw new Error("meter unavailable");
    this.#combined = combined === undefined ? undefined : { meter: combined.meter, markers: combined.markers };
  }
  get combinedCompany(): boolean { return this.#combined !== undefined; }
  /** The agent meter tables this meter combines with (startServe checks them against its own). */
  combinedTables(): { meter: string; markers: string } | undefined { return this.#combined === undefined ? undefined : { ...this.#combined }; }
  /** Its own tables (startServe refuses two meters that would share rows, holds or a ledger). */
  ownTables(): DynamoMeterTables { return { ...this.#t }; }
  /** The overrun-in-flight marker's table: the agent markers table when combined (one per company across both routes). */
  get #markers(): string { return this.#combined?.markers ?? this.#t.markers; }
  #table(target: Target): string {
    if (target.combined !== true) return this.#t.meter;
    if (this.#combined === undefined) throw new Error("meter unavailable");
    return this.#combined.meter;
  }
  #month(): string { return new Date(this.#now()).toISOString().slice(0, 7); }
  async #rows(pk: string, targets: readonly Target[]): Promise<Array<Item | undefined>> {
    return Promise.all(targets.map((target) => this.#db.get(this.#table(target), { pk, sk: target.sk })));
  }

  get #sourceTable(): string { return this.#combined?.meter ?? this.#t.meter; }
  async sourceStop(iss: string, cid: string, source: CustomerSource, routeClass?: RouteClass): Promise<SourceStop | undefined> {
    return readSourceStop(await this.#db.get(this.#sourceTable, { pk: companyPartition(iss, cid), sk: sourceStopKey(source, routeClass) }, { consistent: true }), source, routeClass);
  }
  /** Called only by the interactive operator CLI, never by gateway routes or corrections. */

  async clearSourceStop(input: ClearSourceStop): Promise<boolean> {
    if (!validClear(input)) throw new Error("operator clear refused");
    const pk = companyPartition(input.iss, input.cid), at = this.#now();
    try {
      await this.#db.transact([
        { kind: "Update", table: this.#sourceTable, key: { pk, sk: sourceStopKey(input.source, input.routeClass === "legacy" ? undefined : input.routeClass) },
          condition: e => `${e.name("stopped")} = ${e.value(true)} AND ${e.name("stopId")} = ${e.value(input.expectedStopId)} AND attribute_not_exists(${e.name("inFlight")})`,
          update: e => `SET ${e.name("stopped")} = ${e.value(false)}, ${e.name("clearedBy")} = ${e.value(input.actor)}, ${e.name("clearedAt")} = ${e.value(at)}, ${e.name("clearReason")} = ${e.value(input.reason)}` },
        ...(input.routeClass === "legacy" ? [] : [{ kind: "Update" as const, table: this.#sourceTable, key: { pk, sk: sourceStopKey(input.source) }, condition: (e: Expr) => `attribute_exists(${e.name("pk")}) AND attribute_not_exists(${e.name("inFlight")})`, update: (e: Expr) => `SET ${e.name("source")} = ${e.value(input.source)}` }]),
        { kind: "Put", table: this.#t.ledger, item: { pk, sk: `SOURCESTOPCLEAR#${input.source}#${input.routeClass}#${input.expectedStopId}`, source: input.source, routeClass: input.routeClass, stopId: input.expectedStopId, actor: input.actor, at, reason: input.reason }, condition: e => `attribute_not_exists(${e.name("pk")})` },
      ], randomUUID()); return true;
    } catch (error) { if (error instanceof TransactionRefused) return false; throw error; }
  }
  #sourceSettlement(actions: TransactAction[], pk: string, receipt?: ChargeReceiptV1, source?: CustomerSource, owner?: string, routeClass?: RouteClass, noWriteRoute = false): void {
    const stop = stoppedBy(receipt, this.#now(), routeClass, noWriteRoute);
    const customerSource = source ?? stop?.source;
    if (customerSource === undefined) return;
    // The class-less record retains the one company/source slot and any legacy latch.
    if (owner !== undefined || (stop !== undefined && routeClass === undefined)) actions.push({ kind: "Update", table: this.#sourceTable, key: { pk, sk: sourceStopKey(customerSource) },
      ...(owner === undefined ? {} : { condition: (e: Expr) => `${e.name("inFlight")} = ${e.value(owner)}` }),
      update: e => `SET ${e.name("source")} = ${e.value(customerSource)}${stop === undefined || routeClass !== undefined ? "" : Object.entries(stop).filter(([key]) => key !== "source").map(([key, value]) => `, ${e.name(key)} = ${e.value(value as Plain)}`).join("")}${owner === undefined ? "" : ` REMOVE ${e.name("inFlight")}`}` });
    if (stop !== undefined && routeClass !== undefined) actions.push({ kind: "Update", table: this.#sourceTable, key: { pk, sk: sourceStopKey(customerSource, routeClass) },
      update: e => `SET ${Object.entries(stop).map(([key, value]) => `${e.name(key)} = ${e.value(value as Plain)}`).join(", ")}` });
  }
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    if (record(input) === undefined || !validScope(input.scope) || !validCaps(input.caps) || !whole(input.estimateMicros)) return { ok: false, reason: "busy" };
    const { scope, caps, estimateMicros } = input;
    if (input.routeClass !== undefined && !validRouteClass(input.routeClass)) return { ok: false, reason: "busy" };
    if (input.customerSource !== undefined && !validCustomerSource(input.customerSource)) return { ok: false, reason: "busy" };
    const customerSource = input.customerSource ?? receiptCustomerSource(input.charge?.receipt);
    if (customerSource !== undefined && (!validRouteClass(input.routeClass) || !validCustomerSource(customerSource) || (input.charge !== undefined && receiptCustomerSource(input.charge.receipt) !== customerSource))) return { ok: false, reason: "busy" };
    if (input.appliedMaxOutputTokens !== undefined && (!whole(input.appliedMaxOutputTokens) || input.appliedMaxOutputTokens < 1)) return { ok: false, reason: "busy" };
    if (input.provisional !== undefined && !validProvisionalContext(input.provisional)) return { ok: false, reason: "busy" };
    if (input.line !== undefined && !validLine(input.line)) return { ok: false, reason: "busy" };
    if (input.review !== undefined && !(typeof input.review.jti === "string" && /^[0-9a-f-]{36}$/u.test(input.review.jti))) return { ok: false, reason: "busy" };
    if (input.run !== undefined && (!validRunScope(input.scope, input.run.operationId) || (input.charge !== undefined && input.charge.receipt.operationId !== input.run.operationId))) return { ok: false, reason: "busy" };
    // Fail closed: a combined meter without the combined company cap holds nothing.
    if (this.#combined !== undefined && caps.combinedCompanyMonth === undefined) return { ok: false, reason: "busy" };
    // The environment's "runs are indexed since" marker exists before the first run item does (a failure here never refuses the call: the next reserve, or the first read of a run, writes it).
    if (input.run !== undefined && !this.#runIndexMarked) { try { await this.markRunIndex(); this.#runIndexMarked = true; } catch { /* retried */ } }
    const now = this.#now();
    if (input.sweepAfter !== undefined && (!whole(input.sweepAfter) || input.sweepAfter > now + SWEEP_AFTER_MAX_MS)) return { ok: false, reason: "busy" };
    // The sweep reads a hold's age from openFrom: a long hold (an eval stage) is not swept before its own end.
    const openFrom = Math.max(now, input.sweepAfter ?? now); const clock = Math.floor(now / 1000);
    let expiresSeconds: number | undefined;
    if (input.overrun !== undefined) {
      const marker = record(input.overrun);
      if (marker === undefined || !whole(marker.deadlineSeconds) || !whole(marker.tokenExpiresSeconds)) return { ok: false, reason: "busy" };
      expiresSeconds = Math.min(marker.deadlineSeconds, marker.tokenExpiresSeconds, clock + TASK_TOKEN_SECONDS);
      if (expiresSeconds <= clock) return { ok: false, reason: "busy" };
    }
    const pk = companyPartition(scope.iss, scope.cid);
    const month = this.#month();
    const items = targetsFor(scope, caps, month, this.#combined !== undefined);
    // Existing ROW/task kind with a reserved key tuple, no monthly suffix or TTL.
    if (input.charge?.receipt.model.provider === "openrouter") items.push({ sk: `ROW#${JSON.stringify(["task", "", "openrouter", input.charge.receipt.source.id])}`, item: "task" });
    const id = input.charge?.receipt.callId ?? randomUUID();
    if (input.charge !== undefined) {
      try { const r = readSettlementReceipt(input.charge.receipt); checkReceiptScope(r, scope, id, estimateMicros, month); if (r.status !== "awaiting_usage" || !/^[0-9a-f-]{36}$/u.test(id) || !/^[a-f0-9]{64}$/u.test(input.charge.requestFingerprint)) return { ok: false, reason: "busy" }; } catch { return { ok: false, reason: "busy" }; }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let stored: Array<Item | undefined>;
      try { stored = await this.#rows(pk, items); } catch { return { ok: false, reason: "busy" }; }
      if (customerSource !== undefined) {
        let stop, classStop; try { stop = await this.sourceStop(scope.iss, scope.cid, customerSource); classStop = await this.sourceStop(scope.iss, scope.cid, customerSource, input.routeClass); } catch { return { ok: false, reason: "busy" }; }
        if (stop?.stopped === true || classStop?.stopped === true) return { ok: false, reason: "overrun", item: "company", held: false };
        if (stop?.inFlight !== undefined) return { ok: false, reason: "busy", overrunInFlight: true };
      }
      let blocked: Extract<ReserveResult, { reason: "cap" | "overrun" }> | undefined;
      for (const [i, target] of items.entries()) {
        let row: MeterRow;
        try { row = rowOf(stored[i], target, scope.cid); } catch { return { ok: false, reason: "busy" }; }
        if (row.company !== scope.cid) return { ok: false, reason: "busy" };
        if (row.overrun) return { ok: false, reason: "overrun", item: target.item, held: false };
        if (!Number.isSafeInteger(row.committed + estimateMicros)) return { ok: false, reason: "busy" };
        if (target.cap !== undefined && (target.cap - estimateMicros < 0 || row.committed > target.cap - estimateMicros)) {
          const held = row.spentMicros <= target.cap - estimateMicros;
          if (blocked === undefined || !held) blocked = { ok: false, reason: "cap", item: target.item, held };
        }
      }
      if (blocked !== undefined) return blocked;
      if (expiresSeconds !== undefined) {
        let marker: Item | undefined;
        try { marker = await this.#db.get(this.#markers, { pk, sk: INFLIGHT }); } catch { return { ok: false, reason: "busy" }; }
        // Expiry frees only the marker; an unreadable marker counts as live.
        if (marker !== undefined && !(whole(marker.expiresSeconds) && marker.expiresSeconds <= clock)) return { ok: false, reason: "busy", overrunInFlight: true };
      }
      const actions: TransactAction[] = items.map((target, i): TransactAction => {
        const limit = Math.min(target.cap === undefined ? MAX : target.cap - estimateMicros, MAX - estimateMicros);
        if (stored[i] === undefined) {
          return { kind: "Update", table: this.#table(target), key: { pk, sk: target.sk },
            update: (e) => `SET ${e.name("item")} = ${e.value(target.item)}, ${e.name("company")} = ${e.value(scope.cid)}, ${e.name("spentMicros")} = ${e.value(0)}, ${e.name("estimatedMicros")} = ${e.value(0)}, ${e.name("reservedMicros")} = ${e.value(estimateMicros)}, ${e.name("committed")} = ${e.value(estimateMicros)}, ${e.name("overrun")} = ${e.value(false)}`,
            condition: (e) => `attribute_not_exists(${e.name("pk")})` };
        }
        return { kind: "Update", table: this.#table(target), key: { pk, sk: target.sk },
          update: (e) => `SET ${e.name("reservedMicros")} = ${e.name("reservedMicros")} + ${e.value(estimateMicros)}, ${e.name("committed")} = ${e.name("committed")} + ${e.value(estimateMicros)}`,
          condition: (e) => `${e.name("company")} = ${e.value(scope.cid)} AND ${e.name("overrun")} = ${e.value(false)} AND ${e.name("committed")} <= ${e.value(limit)}` };
      });
      actions.push({ kind: "Put", table: this.#t.meter, condition: (e) => `attribute_not_exists(${e.name("pk")})`, item: {
        ...(input.provisional === undefined ? {} : { provisional: JSON.parse(JSON.stringify(input.provisional)) as Plain }),
        ...(input.charge === undefined ? {} : { charge: JSON.parse(JSON.stringify(input.charge)) as Plain }),
        ...(customerSource === undefined ? {} : { customerSource }), ...(input.routeClass === undefined ? {} : { routeClass: input.routeClass }),
        pk, sk: `HOLD#${id}`, status: "open", ...scopeFields(scope), month, estimateMicros, targets: targetsPlain(items), createdAt: now,
        // In the open-holds index until settled, so the sweep can close a hold whose settle failed.
        openAll: GATEWAY_OPEN_PARTITION, openAt: openAt(openFrom, pk, id), ...(openFrom === now ? {} : { openFrom }),
        ...(input.appliedMaxOutputTokens === undefined ? {} : { appliedMaxOutputTokens: input.appliedMaxOutputTokens }),
        ...(input.line === undefined ? {} : { line: { source: input.line.source, charge: input.line.charge, model: input.line.model } }),
        ...(input.review === undefined ? {} : { review: input.review.jti }),
      } });
      // The run's index item: in the hold's own transaction, so a hold that exists is always found by its run (GATEWAY-RUN-CHARGES-ROUTE). Read tolerantly: only `callId` is read.
      if (input.run !== undefined) actions.push({ kind: "Put", table: this.#t.meter, item: { pk, sk: `${runKeyPrefix(scope.tid, input.run.operationId)}${id}`, callId: id, createdAt: now }, condition: (e) => `attribute_not_exists(${e.name("pk")})` });
      if (expiresSeconds !== undefined) {
        const expires = expiresSeconds;
        actions.push({ kind: "Put", table: this.#markers, item: { pk, sk: INFLIGHT, owner: id, expiresSeconds: expires, expiresAt: expires },
          condition: (e) => `attribute_not_exists(${e.name("pk")}) OR ${e.name("expiresSeconds")} <= ${e.value(clock)}` });
      }
      if (customerSource !== undefined) {
        // Updates deliberately use existing write permissions (no new ConditionCheckItem grant).
        actions.push({ kind: "Update", table: this.#sourceTable, key: { pk, sk: sourceStopKey(customerSource) },
          update: e => `SET ${e.name("source")} = ${e.value(customerSource)}, ${e.name("stopped")} = ${e.value(false)}, ${e.name("inFlight")} = ${e.value(id)}`,
          condition: e => `attribute_not_exists(${e.name("pk")}) OR (${e.name("stopped")} = ${e.value(false)} AND attribute_not_exists(${e.name("inFlight")}))` });
        actions.push({ kind: "Update", table: this.#sourceTable, key: { pk, sk: sourceStopKey(customerSource, input.routeClass) },
          update: e => `SET ${e.name("source")} = ${e.value(customerSource)}, ${e.name("routeClass")} = ${e.value(input.routeClass!)}, ${e.name("stopped")} = ${e.value(false)}`,
          condition: e => `attribute_not_exists(${e.name("pk")}) OR ${e.name("stopped")} = ${e.value(false)}` });
      }
      try { await this.#db.transact(actions, randomUUID()); }
      catch (error) {
        if (error instanceof TransactionRefused) continue;
        // Outcome unknown even after the same-token retry: the hold itself says whether it applied. If it did, the call
        // goes ahead on it (and is settled as usual), so no applied hold is left without an owner.
        let applied: Item | undefined;
        try { applied = await this.#db.get(this.#t.meter, { pk, sk: `HOLD#${id}` }); } catch { return { ok: false, reason: "busy" }; }
        if (applied === undefined) return { ok: false, reason: "busy" };
      }
      const reservation = Object.freeze({ id, ...(input.appliedMaxOutputTokens === undefined ? {} : { appliedMaxOutputTokens: input.appliedMaxOutputTokens }) });
      this.#holds.set(reservation, { pk, id });
      return { ok: true, reservation };
    }
    return { ok: false, reason: "busy" };
  }

  /**
   * One run's calls (Meter.runCharges): the `RUN#` items under the run's prefix name every hold taken for it; each hold says whether the call is still open (its receipt is then the hold's own, `awaiting_usage`),
   * else the ledger row holds the call's latest receipt. Every read is consistent. A hold with no index item cannot exist (one transaction); an index item with no hold, a closed hold with no ledger receipt, or a
   * receipt that is not this run's makes the whole read unreadable (a throw), never a smaller figure.
   */
  async runCharges(scope: RunScope, operationId: string): Promise<RunChargesRead> {
    if (!validRunScope(scope, operationId)) throw new Error("run charges unavailable");
    const pk = companyPartition(scope.iss, scope.cid), low = runKeyPrefix(scope.tid, operationId);
    const since = await this.markRunIndex();
    const rows = await this.#db.query(this.#t.meter, { limit: RUN_CALLS_MAX + 1, key: (e) => `${e.name("pk")} = ${e.value(pk)} AND ${e.name("sk")} BETWEEN ${e.value(low)} AND ${e.value(`${low.slice(0, -1)}$`)}` });
    if (rows.length === 0) return { found: false };
    if (rows.length > RUN_CALLS_MAX) throw new Error("run charges unavailable");
    const ids = rows.map((row) => { const id = row.callId; if (typeof id !== "string" || !/^[0-9a-f-]{36}$/u.test(id) || row.sk !== `${low}${id}`) throw new Error("run charges unavailable"); return id; });
    const created = rows.map((row) => row.createdAt);
    if (!created.every(whole)) throw new Error("run charges unavailable");
    const first = Math.min(...created);
    let complete = true;
    const receipts: ChargeReceiptV1[] = [];
    for (let at = 0; at < ids.length; at += 8) {
      receipts.push(...await Promise.all(ids.slice(at, at + 8).map(async (id) => {
        const hold = readHold(await this.#db.get(this.#t.meter, { pk, sk: `HOLD#${id}` }), this.#combined !== undefined);
        if (hold === undefined || hold.scope.iss !== scope.iss || hold.scope.cid !== scope.cid || hold.scope.tid !== scope.tid) throw new Error("run charges unavailable");
        if (hold.status === "open") {
          // Still open (or a settle that has not landed): the run is not complete.
          if (hold.charge === undefined) throw new Error("run charges unavailable");
          complete = false;
          return checkRunReceipt(readSettlementReceipt(hold.charge.receipt), scope, operationId, id);
        }
        const call = await this.#db.get(this.#t.ledger, { pk, sk: `CALL#${id}` });
        if (call === undefined || call.receipt === undefined) throw new Error("run charges unavailable");
        return checkRunReceipt(readSettlementReceipt(call.receipt), scope, operationId, id);
      })));
    }
    return { found: true, complete, receipts, indexedSince: since, startedBeforeIndex: startedBeforeIndex(first, since) };
  }

  /**
   * When `RUN#` indexing began in this environment: the marker item, written once, by the first reserve for a run (and, failing that, by the first read of a run), never overwritten. A marker that does not
   * read is unreadable (a throw): a run is never read without knowing from when its record can be trusted.
   */
  async markRunIndex(): Promise<number> {
    const key = { pk: `${GATEWAY_COMPANY_KEY_PREFIX}META#run-index`, sk: "SINCE" };
    let marker = await this.#db.get(this.#t.meter, key);
    if (marker === undefined) { await this.#db.put(this.#t.meter, { ...key, since: this.#now() }, (e) => `attribute_not_exists(${e.name("pk")})`); marker = await this.#db.get(this.#t.meter, key); }
    if (marker === undefined || !whole(marker.since)) throw new Error("run charges unavailable");
    return marker.since;
  }

  /**
   * A handle for a hold this meter took in ANOTHER gateway task (an eval stage's parent or company marker, product-eval.ts): the
   * shared stage table keeps only the hold's id. Settle then closes it only while it is open, in this company's partition, as
   * for any hold; an id that names no hold of this company closes nothing.
   */
  adopt(iss: string, cid: string, reservation: Reservation): Reservation {
    if (record(reservation) === undefined || typeof reservation.id !== "string" || !/^[0-9a-f-]{36}$/u.test(reservation.id) || typeof iss !== "string" || typeof cid !== "string" || !COMPANY.test(cid)) throw new Error("settlement unavailable");
    const handle = Object.freeze({ id: reservation.id, ...(reservation.appliedMaxOutputTokens === undefined ? {} : { appliedMaxOutputTokens: reservation.appliedMaxOutputTokens }) });
    this.#holds.set(handle, { pk: companyPartition(iss, cid), id: reservation.id });
    return handle;
  }

  async settle(reservation: Reservation, actualMicros: number, estimated?: EstimatedSettlement, receipt?: ChargeReceiptV1): Promise<void> {
    if (record(reservation) === undefined || typeof reservation.id !== "string") throw new Error("settlement unavailable");
    await this.#beforeWrite("settle");
    const where = this.#holds.get(reservation);
    if (where === undefined || where.id !== reservation.id) return; // Not a reservation of this meter: nothing to close.
    const { pk, id } = where;
    const hold = readHold(await this.#db.get(this.#t.meter, { pk, sk: `HOLD#${id}` }), this.#combined !== undefined);
    if (hold === undefined || hold.status !== "open") return; // Already closed; ledger and rows stay untouched.
    if (!whole(actualMicros)) throw new Error("settlement unavailable");
    if (estimated !== undefined && (!validEntry({ ...estimated, inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }) || !whole(estimated.settledAt) || (estimated.priceVersion !== undefined && !whole(estimated.priceVersion)) || (estimated.usage !== undefined && !validUsage(estimated.usage)) || actualMicros < 1)) throw new Error("settlement unavailable");
    if (receipt !== undefined) checkReceiptScope(receipt, hold.scope, id, hold.estimate, hold.month);
    await this.#close(pk, id, hold, actualMicros, estimated, false, receipt);
  }

  /**
   * One hold to spend, in one conditional transaction (the hold must still be open). `swept`: closed by the sweep at the hold's
   * own estimate because its call's settle never landed; counted as estimated, never at $0.
   */
  async #close(pk: string, id: string, hold: Hold, actualMicros: number, estimated: EstimatedSettlement | undefined, swept: boolean, receipt?: ChargeReceiptV1, provisional?: ProvisionalEstimate, noWriteRoute = false): Promise<"closed" | "already"> {
    if (hold.charge !== undefined && receipt === undefined) {
      if (!swept) throw new Error("charge receipt required");
      receipt = { ...readSettlementReceipt(hold.charge.receipt), recordedAt: new Date(this.#now()).toISOString() };
      estimated = estimatedReceipt(receipt, hold.charge.kind);
    }
    const held = provisional !== undefined;
    const spend = held ? 0 : actualMicros;
    const release = hold.estimate - (held ? actualMicros : 0);
    const extraEstimated = held || (estimated === undefined && !swept) ? 0 : actualMicros;
    const callKey = JSON.stringify([hold.scope.iss, hold.scope.cid, id]);
    const now = this.#now();
    const pending = estimated;
    const ledger: Item = {
      ...(provisional === undefined ? {} : { ...provisional, estimateStatus: "estimated", provisionalHeld: true, cutoffAt: now }),
      ...(receipt === undefined ? { chargeStatus: estimated === undefined && !swept ? "legacy_unknown" : "estimated", reason: "legacy_unknown" } : { receipt: JSON.parse(JSON.stringify(receipt)) as Plain, kind: hold.charge?.kind ?? estimated?.kind ?? "chat", revision: receipt.revision, chargeStatus: receipt.status, reason: receipt.reason }),
      ...(hold.charge === undefined ? {} : { requestFingerprint: hold.charge.requestFingerprint }),
      ...(hold.routeClass === undefined ? {} : { routeClass: hold.routeClass }), pk, sk: `CALL#${id}`, callKey, ...scopeFields(hold.scope), month: hold.month, settledMicros: actualMicros, estimated: estimated !== undefined || swept, targets: targetsPlain(hold.targets),
      ...(swept ? { swept: true } : {}),
      // An estimate settled without usage (failed-call.ts) is never re-priced by a correction: it stays what it was settled at.
      ...(receipt?.neverConfirmed === true ? { neverConfirmed: true } : {}),
      // The billable line (DEC 240b) lands with the call's settled cost, in the same transaction that closes the hold.
      ...(hold.line === undefined ? {} : { line: { source: hold.line.source, charge: hold.line.charge, model: hold.line.model } }),
      settledAt: pending === undefined ? now : pending.settledAt,
      ...(!pending ? {} : {
        provider: pending.provider, model: pending.model, kind: pending.kind, usage: usagePlain(pending.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), status: "pending",
        chargeStatus: pending.usage === undefined || !hasUsage(pending.usage) ? "awaiting_usage" : "estimated",
        ...(pending.priceVersion === undefined ? {} : { priceVersion: pending.priceVersion }),
        pendingAll: GATEWAY_PENDING_PARTITION, pendingKeyAt: pendingKeyAt(priceKey(pending), pending.settledAt, callKey), pendingAt: pendingAt(pending.settledAt, callKey),
      }),
    };
    const holdIndex = hold.targets.length; const ledgerIndex = holdIndex + 1;
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      if (attempt > 0) await backoff(attempt);
      const stored = await this.#rows(pk, hold.targets);
      const actions: TransactAction[] = hold.targets.map((target, i): TransactAction => {
        const row = rowOf(stored[i], target, hold.scope.cid);
        if (stored[i] === undefined || row.company !== hold.scope.cid || ![row.committed - hold.estimate + actualMicros, row.spentMicros + spend, row.estimatedMicros + extraEstimated].every(whole) || row.reservedMicros < hold.estimate) throw new Error("settlement unavailable");
        const capOverrun = target.cap !== undefined && row.spentMicros + spend > target.cap;
        const overrun = row.overrun || capOverrun;
        const overrunOwner = capOverrun ? estimated !== undefined && (!row.overrun || row.overrunOwner === callKey) ? callKey : "" : row.overrunOwner;
        const delta = actualMicros - hold.estimate;
        return { kind: "Update", table: this.#table(target), key: { pk, sk: target.sk },
          update: (e) => `SET ${e.name("spentMicros")} = ${e.name("spentMicros")} + ${e.value(spend)}, ${e.name("estimatedMicros")} = ${e.name("estimatedMicros")} + ${e.value(extraEstimated)}, ${e.name("reservedMicros")} = ${e.name("reservedMicros")} - ${e.value(release)}, ${e.name("committed")} = ${e.name("committed")} + ${e.value(delta)}${held && target.item === "company" ? `, ${e.name("provisionalMicros")} = if_not_exists(${e.name("provisionalMicros")}, ${e.value(0)}) + ${e.value(actualMicros)}` : ""}${overrun ? `, ${e.name("overrun")} = ${e.value(true)}` : ""}${overrunOwner === undefined ? "" : `, ${e.name("overrunOwner")} = ${e.value(overrunOwner)}`}`,
          // Bounds that keep every value a whole safe integer; and, when this settle does not set the overrun flag, that a
          // concurrent settle has not pushed the row past its cap meanwhile (then this one re-reads and sets it).
          condition: (e) => [
            `${e.name("company")} = ${e.value(hold.scope.cid)}`, `${e.name("overrun")} = ${e.value(row.overrun)}`, row.overrunOwner === undefined ? `attribute_not_exists(${e.name("overrunOwner")})` : `${e.name("overrunOwner")} = ${e.value(row.overrunOwner)}`, `${e.name("reservedMicros")} >= ${e.value(hold.estimate)}`,
            `${e.name("spentMicros")} <= ${e.value(MAX - actualMicros)}`, `${e.name("estimatedMicros")} <= ${e.value(MAX - extraEstimated)}`,
            `${e.name("committed")} >= ${e.value(Math.max(0, -delta))}`, `${e.name("committed")} <= ${e.value(MAX - Math.max(0, delta))}`,
            ...(overrun || target.cap === undefined ? [] : [`${e.name("spentMicros")} <= ${e.value(target.cap - actualMicros)}`]),
          ].join(" AND ") };
      });
      actions.push({ kind: "Update", table: this.#t.meter, key: { pk, sk: `HOLD#${id}` },
        update: (e) => `SET ${e.name("status")} = ${e.value(held ? "cut_off" : "settled")}, ${e.name("actualMicros")} = ${e.value(actualMicros)}, ${e.name("closedAt")} = ${e.value(now)}${held ? `, ${e.name("cutoffAt")} = ${e.value(now)}` : ""}${swept ? `, ${e.name("swept")} = ${e.value(true)}` : ""} ${held ? "" : `REMOVE ${e.name("openAll")}, ${e.name("openAt")}`}`,
        condition: (e) => `${e.name("status")} = ${e.value("open")}` });
      actions.push({ kind: "Put", table: this.#t.ledger, item: ledger, condition: (e) => `attribute_not_exists(${e.name("pk")})` });
      this.#sourceSettlement(actions, pk, receipt, hold.customerSource, hold.customerSource === undefined ? undefined : id, hold.routeClass, noWriteRoute);
      if (receipt !== undefined) actions.push({ kind: "Put", table: this.#t.ledger, item: { pk, sk: `ADJUST#${id}#${receipt.revision}`, receipt: JSON.parse(JSON.stringify(receipt)) as Plain, deltaMicros: actualMicros }, condition: e => `attribute_not_exists(${e.name("pk")})` });
      try { await this.#db.transact(actions, randomUUID()); }
      catch (error) {
        if (!(error instanceof TransactionRefused)) throw new Error("settlement unavailable", { cause: error });
        if (error.conditionFailed(holdIndex) || error.conditionFailed(ledgerIndex)) return "already"; // Closed by another settle.
        continue;
      }
      // The marker goes only if this reservation still owns it; a crash here leaves it to expire (at most the token's lifetime).
      try { await this.#db.delete(this.#markers, { pk, sk: INFLIGHT }, (e) => `${e.name("owner")} = ${e.value(id)}`); } catch { /* It expires. */ }
      return "closed";
    }
    throw new Error("settlement unavailable");
  }

  async settleV2(input: SettleV2): Promise<void> {
    const r = readSettlementReceipt(input.receipt);
    if (input.reservationId !== r.callId || r.revision !== 1) throw new Error("invalid charge settlement");
    const pk = companyPartition(r.issuer, r.companyId), key = { pk, sk: `CALL#${r.callId}` };
    const old = await this.#db.get(this.#t.ledger, key);
    if (old !== undefined) { receiptRevision(readSettlementReceipt(old.receipt), r); return; }
    const hold = readHold(await this.#db.get(this.#t.meter, { pk, sk: `HOLD#${r.callId}` }), this.#combined !== undefined);
    if (hold === undefined || hold.status !== "open") throw new Error("charge reservation missing");
    checkReceiptScope(r, hold.scope, r.callId, hold.estimate, hold.month);
    if (hold.charge !== undefined && receiptIdentity(hold.charge.receipt) !== receiptIdentity(r)) throw new Error("charge identity changed");
    const outputs = r.status === "awaiting_usage" && hold.provisional !== undefined ? await this.#history(pk, r) : [];
    const provisional = r.status === "awaiting_usage" && hold.provisional !== undefined ? provisionalEstimate(hold.estimate, hold.provisional, outputs, input.actualInputTokens) : undefined;
    await this.#close(pk, r.callId, hold, provisional?.amountMicros ?? chargeValue(r.amountMicros)!, estimatedReceipt(r, hold.charge?.kind), false, r, provisional, input.noWriteRoute === true);
    // A concurrent winner must have persisted this exact receipt.
    const after = await this.#db.get(this.#t.ledger, key);
    if (after === undefined || chargeReceiptContent(after.receipt) !== chargeReceiptContent(r)) throw new Error("conflicting charge settlement");
  }
  async #history(pk: string, receipt: ChargeReceiptV1): Promise<number[]> {
    // One bounded sample of at most 200 CALL rows, filtered to this issuer+company+provider+model.
    // Random call IDs make this a lexical window, not the most recent calls; other
    // models share the window. Sparse samples keep R instead of walking the ledger.
    const outputs: number[] = [];
    const page = await this.#db.query(this.#t.ledger, { limit: 200, descending: true, key: e => `${e.name("pk")} = ${e.value(pk)} AND ${e.name("sk")} BETWEEN ${e.value("CALL#")} AND ${e.value("CALL$")}` });
    for (const item of page) {
      if (item.receipt === undefined) {
        if (item.iss === receipt.issuer && item.cid === receipt.companyId && item.provider === receipt.model.provider && item.model === receipt.model.modelId && item.chargeStatus !== "awaiting_usage" && validUsage(item.usage) && hasUsage(item.usage)) outputs.push(item.usage.output);
        continue;
      }
      const r = readSettlementReceipt(item.receipt), output = historyOutput(r);
      if (r.issuer === receipt.issuer && r.companyId === receipt.companyId && r.model.provider === receipt.model.provider && r.model.modelId === receipt.model.modelId && output !== undefined) outputs.push(output);
    }
    return outputs;
  }
  async applyChargeReceipt(input: ChargeReceiptV1): Promise<ApplyChargeResult> {
    const r = readSettlementReceipt(input), pk = companyPartition(r.issuer, r.companyId), key = { pk, sk: `CALL#${r.callId}` };
    for (let attempt = 0; attempt < CORRECT_ATTEMPTS; attempt++) {
      const stored = await this.#db.get(this.#t.ledger, key);
      if (stored === undefined) throw new Error("charge receipt missing");
      const old = readSettlementReceipt(stored.receipt), result = receiptRevision(old, r);
      if (result !== "applied") {
        if (result === "older") {
          const prior = await this.#db.get(this.#t.ledger, { pk, sk: `ADJUST#${r.callId}#${r.revision}` });
          if (prior !== undefined && chargeReceiptContent(prior.receipt) !== chargeReceiptContent(r)) throw new Error("conflicting charge revision");
        }
        return { callId: r.callId, appliedRevision: old.revision, result, deltaMicros: 0 };
      }
      const targets = readTargets(stored.targets, this.#combined !== undefined);
      if (targets === undefined) throw new Error("charge targets unreadable");
      if (!whole(stored.settledMicros)) throw new Error("charge accounting unavailable");
      const priorAmount = stored.settledMicros, amount = chargeValue(r.amountMicros)!;
      const held = stored.provisionalHeld === true;
      const delta = amount - priorAmount, spendDelta = held ? amount : delta, release = held ? priorAmount : 0;
      const provisionalDelta = stored.estimateBasis === undefined ? 0 : (r.status === "final" ? 0 : amount) - (old.status === "final" ? 0 : priorAmount);
      const estimatedDelta = (r.status === "final" ? 0 : chargeValue(r.amountMicros)!) - (old.status === "final" || held ? 0 : priorAmount);
      const rows = await this.#rows(pk, targets);
      const actions: TransactAction[] = targets.map((t, i) => {
        const row = rowOf(rows[i], t, r.companyId);
        if (row.company !== r.companyId || ![row.spentMicros + spendDelta, row.committed + delta, row.estimatedMicros + estimatedDelta, row.reservedMicros - release, ...(t.item === "company" ? [(row.provisionalMicros ?? 0) + provisionalDelta] : [])].every(whole)) throw new Error("charge accounting unavailable");
        return { kind: "Update", table: this.#table(t), key: { pk, sk: t.sk }, condition: e => `${e.name("overrun")} = ${e.value(row.overrun)} AND ` + ["spentMicros", "estimatedMicros", "reservedMicros", "committed"].map(k => `${e.name(k)} = ${e.value(row[k as "spentMicros" | "estimatedMicros" | "reservedMicros" | "committed"])}`).join(" AND "),
          update: e => `SET ${e.name("spentMicros")} = ${e.value(row.spentMicros + spendDelta)}, ${e.name("estimatedMicros")} = ${e.value(row.estimatedMicros + estimatedDelta)}, ${e.name("reservedMicros")} = ${e.value(row.reservedMicros - release)}, ${e.name("committed")} = ${e.value(row.committed + delta)},${t.item === "company" && stored.estimateBasis !== undefined ? ` ${e.name("provisionalMicros")} = ${e.value((row.provisionalMicros ?? 0) + provisionalDelta)},` : ""} ${e.name("overrun")} = ${e.value(row.overrun || (t.cap !== undefined && row.spentMicros + spendDelta > t.cap))}${t.cap !== undefined && row.spentMicros + spendDelta > t.cap ? `, ${e.name("overrunOwner")} = ${e.value("")}` : ""}` };
      });
      if (stored.routeClass !== undefined && !validRouteClass(stored.routeClass)) throw new Error("charge class unreadable");
      this.#sourceSettlement(actions, pk, r, undefined, undefined, stored.routeClass);
      if (held) actions.push({ kind: "Update", table: this.#t.meter, key: { pk, sk: `HOLD#${r.callId}` }, condition: e => `${e.name("status")} = ${e.value("cut_off")}`, update: e => `SET ${e.name("status")} = ${e.value("settled")}, ${e.name("actualMicros")} = ${e.value(amount)}, ${e.name("closedAt")} = ${e.value(this.#now())} REMOVE ${e.name("openAll")}, ${e.name("openAt")}` });
      const pending = estimatedReceipt(r, stored.kind === "embedding" ? "embedding" : "chat");
      const pendingFields: Item = pending === undefined ? {} : { provider: pending.provider, model: pending.model, kind: pending.kind, usage: usagePlain(pending.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), settledAt: Date.parse(r.occurredAt), pendingAll: GATEWAY_PENDING_PARTITION, pendingKeyAt: pendingKeyAt(priceKey(pending), Date.parse(r.occurredAt), JSON.stringify([r.issuer, r.companyId, r.callId])), pendingAt: pendingAt(Date.parse(r.occurredAt), JSON.stringify([r.issuer, r.companyId, r.callId])) };
      actions.push({ kind: "Update", table: this.#t.ledger, key, condition: e => `${e.name("revision")} = ${e.value(old.revision)}`, update: e => `SET ${e.name("provisionalHeld")} = ${e.value(false)}, ${e.name("neverConfirmed")} = ${e.value(r.neverConfirmed === true)}, ${e.name("receipt")} = ${e.value(JSON.parse(JSON.stringify(r)) as Plain)}, ${e.name("revision")} = ${e.value(r.revision)}, ${e.name("settledMicros")} = ${e.value(chargeValue(r.amountMicros)!)}, ${e.name("estimated")} = ${e.value(r.status !== "final")}, ${e.name("chargeStatus")} = ${e.value(r.status)}, ${e.name("reason")} = ${e.value(r.reason)}, ${e.name("status")} = ${e.value(r.status === "final" ? "corrected" : "pending")}${r.status === "final" ? ` ${this.#closePending(e)}` : Object.entries(pendingFields).map(([k, v]) => `, ${e.name(k)} = ${e.value(v)}`).join("")}` });
      actions.push({ kind: "Put", table: this.#t.ledger, item: { pk, sk: `ADJUST#${r.callId}#${r.revision}`, receipt: JSON.parse(JSON.stringify(r)) as Plain, deltaMicros: delta }, condition: e => `attribute_not_exists(${e.name("pk")})` });
      try { await this.#db.transact(actions, randomUUID()); return { callId: r.callId, appliedRevision: r.revision, result: "applied", deltaMicros: delta }; }
      catch (error) { if (!(error instanceof TransactionRefused)) throw error; }
    }
    throw new Error("charge revision busy");
  }

  /**
   * Closes holds left open past HOLD_SWEEP_AGE_MS (their call's settle failed, or its process stopped): each is settled at its
   * own reserved estimate (at least 1 micro-dollar, never $0, DEC 172), marked estimated and swept, in the same conditional
   * transaction as a settle, so a late settle and the sweep cannot both apply. Bounded: at most `limit` holds per run, oldest first.
   */
  async sweepOpenHolds(now: number, limit: number): Promise<{ swept: number; already: number; failed: number; more: boolean }> {
    if (!whole(now) || !whole(limit) || limit < 1 || limit > HOLD_SWEEP_MAX) throw new Error("sweep unavailable");
    const before = now - HOLD_SWEEP_AGE_MS;
    const report = { swept: 0, already: 0, failed: 0, more: false };
    if (before <= 0) return report;
    const index = GATEWAY_METER_INDEXES.openHolds;
    // Resume after the last hold this meter looked at, so holds that cannot be closed never block newer ones; a pass that
    // reaches the end starts again from the oldest.
    const after = this.#sweepAfter !== undefined && this.#sweepAfter < pad(before) ? this.#sweepAfter : undefined;
    const found = (await this.#db.query(this.#t.meter, { index: index.name, limit: limit + 2, key: (e) => after === undefined
      ? `${e.name(index.partitionKey)} = ${e.value(GATEWAY_OPEN_PARTITION)} AND ${e.name(index.sortKey)} < ${e.value(pad(before))}`
      : `${e.name(index.partitionKey)} = ${e.value(GATEWAY_OPEN_PARTITION)} AND ${e.name(index.sortKey)} BETWEEN ${e.value(after)} AND ${e.value(pad(before))}` }))
      .filter((item) => item.openAt !== after);
    report.more = found.length > limit;
    const page = found.slice(0, limit);
    const last = page.at(-1)?.openAt;
    this.#sweepAfter = report.more && typeof last === "string" ? last : undefined;
    for (const item of page) {
      try {
        if (typeof item.pk !== "string" || !item.pk.startsWith(GATEWAY_COMPANY_KEY_PREFIX) || typeof item.sk !== "string" || !/^HOLD#[0-9a-f-]{36}$/u.test(item.sk) || !whole(item.createdAt) || item.createdAt >= before || (item.openFrom !== undefined && (!whole(item.openFrom) || item.openFrom >= before))) { report.failed++; continue; }
        const id = item.sk.slice("HOLD#".length);
        // Re-read consistently: the index is eventually consistent, the decision is made from the table.
        const hold = readHold(await this.#db.get(this.#t.meter, { pk: item.pk, sk: item.sk }), this.#combined !== undefined);
        if (hold?.status === "cut_off" && hold.cutoffAt !== undefined) {
          if (now - hold.cutoffAt < USAGE_WAIT_MS) continue;
          const call = await this.#db.get(this.#t.ledger, { pk: item.pk, sk: `CALL#${id}` });
          if (call?.provisionalHeld !== true) { report.already++; continue; }
          await this.applyChargeReceipt(neverConfirmedReceipt(readSettlementReceipt(call.receipt), Number(call.settledMicros), now));
          report.swept++; continue;
        }
        if (hold === undefined || hold.status !== "open" || companyPartition(hold.scope.iss, hold.scope.cid) !== item.pk) { report.already++; continue; }
        // A review session's hold (DEC 254zzz41) is settled at what its session really debited, never above its ceiling (the hold): only a session that cannot be read costs the whole ceiling.
        const recovery = hold.charge !== undefined && hold.provisional !== undefined ? provisionalEstimate(hold.estimate, hold.provisional, await this.#history(item.pk, hold.charge.receipt)) : undefined;
        const result = await this.#close(item.pk, id, hold, recovery?.amountMicros ?? (hold.review === undefined ? Math.max(1, hold.estimate) : await this.#reviewTotal(item.pk, hold.review, hold.estimate, id)), undefined, true, undefined, recovery);
        if (result === "closed") report.swept++; else report.already++;
      } catch { report.failed++; report.more = true; }
    }
    return report;
  }

  /** What a review session debited (its item in the markers table, this company's partition), closing the session so no later call can debit it; the whole hold when it cannot be read. */
  async #reviewTotal(pk: string, jti: string, estimate: number, holdId: string): Promise<number> {
    const key = { pk, sk: `REVGRANT#${jti}` };
    try {
      const item = await this.#db.get(this.#markers, key);
      if (item === undefined || !whole(item.debitedMicros) || !whole(item.ceilingMicros) || item.ceilingMicros !== estimate || item.debitedMicros > estimate) return Math.max(1, estimate);
      // Another hold (the loser of a race between two first calls) took the jti's session: this hold carried no call of it, and the session is not ours to close (never $0, DEC 172).
      if (item.holdId !== holdId) return 1;
      if (item.status === "open") await this.#db.update(this.#markers, key, (e) => `SET ${e.name("status")} = ${e.value("closed")}`, (e) => `${e.name("status")} = ${e.value("open")} AND ${e.name("debitedMicros")} = ${e.value(item.debitedMicros as number)}`);
      // The close is conditional on the total read: a debit that lands in between leaves the session open, and then the whole hold is the safe answer.
      const after = await this.#db.get(this.#markers, key);
      if (after === undefined || after.status !== "closed" || !whole(after.debitedMicros) || after.debitedMicros > estimate) return Math.max(1, estimate);
      return Math.max(1, after.debitedMicros);
    } catch { return Math.max(1, estimate); }
  }

  async #beforeTransaction(operation: "correct" | "expire", input: ExpiryInput, rows?: MeterRow[]): Promise<boolean> {
    if (input.signal?.aborted) return false;
    let abort!: () => void;
    const stopped = new Promise<false>((resolve) => { abort = () => resolve(false); });
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, CORRECTION_RUN_MS);
    try {
      const ready = await Promise.race([Promise.resolve(this.#beforeWrite(operation, rows)).then(() => true), stopped]);
      return ready && !input.signal?.aborted;
    } catch { return false; }
    finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); }
  }
  #validTransaction(input: unknown): input is ExpiryInput {
    const v = record(input);
    return v !== undefined && typeof v.callKey === "string" && v.callKey.length > 0 && v.callKey.length <= 4096 && whole(v.now) && typeof v.runId === "string" && v.runId.length > 0 && v.runId.length <= 512 && (v.signal === undefined || v.signal instanceof AbortSignal);
  }
  /** One write bounded by the caller's signal and CORRECTION_RUN_MS: a result never acknowledged is "unknown". */
  #bounded(signal: AbortSignal | undefined): { signal: AbortSignal; done(): void } {
    const controller = new AbortController(); const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(abort, CORRECTION_RUN_MS);
    return { signal: controller.signal, done: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
  }
  /** Leaving pending: the call drops out of both pending indexes. */
  #closePending(e: Expr): string { return `REMOVE ${e.name("pendingAll")}, ${e.name("pendingKeyAt")}, ${e.name("pendingAt")}`; }

  async expire(input: ExpiryInput): Promise<CorrectionResult> {
    if (!this.#validTransaction(input)) return { status: "busy" };
    if (!await this.#beforeTransaction("expire", input) || input.signal?.aborted) return { status: "unknown" };
    const where = parseCallKey(input.callKey); if (where === undefined) return { status: "missing" };
    const bound = this.#bounded(input.signal);
    try {
      let item: Item | undefined;
      try { item = await this.#db.get(this.#t.ledger, ledgerKey(where), { signal: bound.signal }); } catch { return { status: "unknown" }; }
      if (item === undefined || item.status === undefined) return { status: "missing" };
      if (item.status !== "pending") return { status: "already" };
      if (item.chargeStatus === "awaiting_usage") {
        if (item.unresolvedAt === undefined) await this.#db.update(this.#t.ledger, ledgerKey(where), e => `SET ${e.name("unresolvedAt")} = ${e.value(input.now)}`, e => `${e.name("status")} = ${e.value("pending")} AND attribute_not_exists(${e.name("unresolvedAt")})`, { signal: bound.signal });
        return { status: "busy" };
      }
      if (!whole(item.settledAt) || input.now - item.settledAt <= PENDING_RETENTION_DAYS * DAY_MS) return { status: item.neverConfirmed === true ? "already" : "busy" };
      const applied = await this.#db.update(this.#t.ledger, ledgerKey(where),
        (e) => `SET ${e.name("status")} = ${e.value("expired")}, ${e.name("expiredAt")} = ${e.value(input.now)}, ${e.name("runId")} = ${e.value(input.runId)} ${this.#closePending(e)}`,
        (e) => `${e.name("status")} = ${e.value("pending")}`, { signal: bound.signal });
      return applied ? { status: "expired" } : { status: "already" };
    } catch { return { status: "unknown" }; }
    finally { bound.done(); }
  }

  async correct(input: CorrectionInput): Promise<CorrectionResult> {
    const origin = record(record(input)?.priceSource);
    if (!this.#validTransaction(input) || (input.priceVersion !== undefined && (!whole(input.priceVersion) || typeof input.estimated !== "boolean")) || (input.estimated !== undefined && (!whole(input.priceVersion) || typeof input.estimated !== "boolean")) || !whole(input.realMicros) || input.realMicros < 1 || !validCaps(input.caps) || !whole(input.now) || typeof input.runId !== "string" || input.runId.length === 0 || input.runId.length > 512 || origin === undefined || typeof origin.source !== "string" || !["litellm", "aws", "override"].includes(origin.source) || !whole(origin.fetchedAt)) return { status: "busy" };
    const where = parseCallKey(input.callKey);
    let observedRows: MeterRow[] | undefined;
    if (where !== undefined) {
      try {
        const observed = await this.#db.get(this.#t.ledger, ledgerKey(where));
        const targets = observed === undefined ? undefined : readTargets(observed.targets, this.#combined !== undefined);
        if (targets !== undefined) observedRows = (await this.#rows(where.pk, targets)).map((row, i) => rowOf(row, targets[i]!, where.cid));
      } catch { observedRows = undefined; }
    }
    if (!await this.#beforeTransaction("correct", input, observedRows) || input.signal?.aborted) return { status: "unknown" };
    if (where === undefined) return { status: "missing" };
    const bound = this.#bounded(input.signal);
    try {
      // Re-read after the hook: every decision below is from this read, and the transaction applies only if it still holds.
      let item: Item | undefined;
      try { item = await this.#db.get(this.#t.ledger, ledgerKey(where), { signal: bound.signal }); } catch { return { status: "unknown" }; }
      if (item === undefined || item.status === undefined) return { status: "missing" };
      if (item.status !== "pending") return { status: "already" };
      if (item.neverConfirmed === true) return { status: "already" };
      if (item.chargeStatus === "awaiting_usage" || item.receipt !== undefined) return { status: "busy" };
      let call: EstimatedCall; const targets = readTargets(item.targets, this.#combined !== undefined);
      try { call = toCall(item); } catch { return { status: "busy" }; }
      if (targets === undefined || call.cid !== where.cid || call.iss !== where.iss) return { status: "busy" };
      const expire = input.now - call.settledAt > PENDING_RETENTION_DAYS * DAY_MS;
      if (!expire && (input.priceVersion ?? 0) <= (call.priceVersion ?? 0)) return { status: "already" };
      const ledgerGuard = (e: Expr) => [`${e.name("status")} = ${e.value("pending")}`, `${e.name("settledMicros")} = ${e.value(call.settledMicros)}`,
        call.priceVersion === undefined ? `attribute_not_exists(${e.name("priceVersion")})` : `${e.name("priceVersion")} = ${e.value(call.priceVersion)}`].join(" AND ");
      if (expire) {
        const applied = await this.#db.update(this.#t.ledger, ledgerKey(where),
          (e) => `SET ${e.name("status")} = ${e.value("expired")}, ${e.name("expiredAt")} = ${e.value(input.now)}, ${e.name("runId")} = ${e.value(input.runId)} ${this.#closePending(e)}`,
          ledgerGuard, { signal: bound.signal });
        return applied ? { status: "expired" } : { status: "busy" };
      }
      const deltaMicros = input.realMicros - call.settledMicros;
      const estimatedDelta = input.estimated === true ? deltaMicros : -call.settledMicros;
      let capExceeded = false;
      // A settle in the same company between this read and the write moves the rows: re-read and try again (bounded).
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0) await backoff(attempt);
        if (bound.signal.aborted) return { status: "unknown" };
        let stored: Array<Item | undefined>;
        try { stored = await this.#rows(where.pk, targets); } catch { return { status: "unknown" }; }
        const rows: MeterRow[] = [];
        for (const [i, target] of targets.entries()) {
          let row: MeterRow; try { row = rowOf(stored[i], target, call.cid); } catch { return { status: "busy" }; }
          if (stored[i] === undefined || row.company !== call.cid || ![row.spentMicros + deltaMicros, row.committed + deltaMicros, row.estimatedMicros + estimatedDelta].every((value) => whole(value) && value < MAX) || row.estimatedMicros + estimatedDelta > row.spentMicros + deltaMicros) return { status: "busy" };
          rows.push(row);
        }
        const capFor = { task: input.caps.task, person: input.caps.personMonth, project: input.caps.projectMonth, upkeep: input.caps.upkeepMonth, company: input.caps.companyMonth };
        capExceeded = false;
        const actions: TransactAction[] = targets.map((target, i): TransactAction => {
          const row = rows[i]!; const spentMicros = row.spentMicros + deltaMicros; // The upkeep row's cap is not in the corrections' caps (they carry no origin): the one stored with the hold applies.
          const cap = target.combined === true ? input.caps.combinedCompanyMonth : target.item === "upkeep" ? capFor.upkeep ?? target.cap : capFor[target.item];
          if (deltaMicros > 0 && cap !== undefined && row.committed + deltaMicros > cap) capExceeded = true;
          return { kind: "Update", table: this.#table(target), key: { pk: where.pk, sk: target.sk },
            update: (e) => `SET ${e.name("spentMicros")} = ${e.name("spentMicros")} + ${e.value(deltaMicros)}, ${e.name("committed")} = ${e.name("committed")} + ${e.value(deltaMicros)}, ${e.name("estimatedMicros")} = ${e.name("estimatedMicros")} + ${e.value(estimatedDelta)}${cap === undefined ? "" : `, ${e.name("overrun")} = ${e.value((row.overrun && row.overrunOwner !== input.callKey) || spentMicros > cap)}${spentMicros > cap && !row.overrun ? `, ${e.name("overrunOwner")} = ${e.value(input.callKey)}` : ""}`}`,
            // The spend and estimated parts as read (so the overrun flag and the estimated <= spent rule hold); committed may
            // have moved with other calls' holds, but stays a whole safe integer.
            condition: (e) => [`${e.name("company")} = ${e.value(call.cid)}`, `${e.name("overrun")} = ${e.value(row.overrun)}`, row.overrunOwner === undefined ? `attribute_not_exists(${e.name("overrunOwner")})` : `${e.name("overrunOwner")} = ${e.value(row.overrunOwner)}`, `${e.name("spentMicros")} = ${e.value(row.spentMicros)}`, `${e.name("estimatedMicros")} = ${e.value(row.estimatedMicros)}`,
              `${e.name("committed")} >= ${e.value(Math.max(0, -deltaMicros))}`, `${e.name("committed")} < ${e.value(MAX - Math.max(0, deltaMicros))}`].join(" AND ") };
        });
        const stillPending = input.estimated === true;
        actions.push({ kind: "Update", table: this.#t.ledger, key: ledgerKey(where), condition: ledgerGuard,
          update: (e) => `SET ${[
            `${e.name("status")} = ${e.value(stillPending ? "pending" : "corrected")}`, `${e.name("settledMicros")} = ${e.value(input.realMicros)}`,
            ...(input.priceVersion === undefined ? [] : [`${e.name("priceVersion")} = ${e.value(input.priceVersion)}`]),
            `${e.name("correctedFrom")} = ${e.value(call.settledMicros)}`, `${e.name("correctedTo")} = ${e.value(input.realMicros)}`, `${e.name("deltaMicros")} = ${e.value(deltaMicros)}`,
            `${e.name("correctedAt")} = ${e.value(input.now)}`, `${e.name("runId")} = ${e.value(input.runId)}`,
            `${e.name("priceSource")} = ${e.value({ source: origin.source as string, fetchedAt: origin.fetchedAt as number })}`,
            ...(capExceeded ? [`${e.name("capExceeded")} = ${e.value(true)}`] : []),
          ].join(", ")}${stillPending ? "" : ` ${this.#closePending(e)}`}` });
        try { await this.#db.transact(actions, randomUUID(), { signal: bound.signal }); }
        catch (error) {
          if (!(error instanceof TransactionRefused)) return { status: "unknown" };
          // The ledger row moved (another run corrected it) or the retries are spent: busy, retried by a later run.
          if (error.conditionFailed(targets.length) || attempt + 1 >= CORRECT_ATTEMPTS) return { status: "busy" };
          continue;
        }
        break;
      }
      return { status: "corrected", deltaMicros, ...(capExceeded ? { capExceeded: true } : {}) };
    } catch { return { status: "unknown" }; }
    finally { bound.done(); }
  }

  /** Distinct price keys with a pending call, in price-key order. The cursor is the last key handed out. */
  async pendingKeys(limit: number, cursor?: string): Promise<PendingPage<PriceKey>> {
    if (!whole(limit) || limit < 1 || limit > CORRECTION_RUN_MAX) throw new Error("pending unavailable");
    let after = " ";
    if (cursor !== undefined) {
      let parsed: unknown; try { if (typeof cursor !== "string" || cursor.length > 8192) throw new Error(); parsed = JSON.parse(cursor); } catch { throw new Error("pending unavailable"); }
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== "keys" || typeof parsed[1] !== "string" || parsed[1].length === 0) throw new Error("pending unavailable");
      // "}" sorts after the "|" that ends every index value of that key, and a key's JSON is never a prefix of another's.
      after = `${parsed[1]}}`;
    }
    const index = GATEWAY_LEDGER_INDEXES.pendingByKey;
    const next = async (): Promise<PriceKey | undefined> => {
      const [item] = await this.#db.query(this.#t.ledger, { index: index.name, limit: 1, key: (e) => `${e.name(index.partitionKey)} = ${e.value(GATEWAY_PENDING_PARTITION)} AND ${e.name(index.sortKey)} > ${e.value(after)}` });
      if (item === undefined) return undefined;
      if (typeof item.provider !== "string" || typeof item.model !== "string" || typeof item.pendingKeyAt !== "string") throw new Error("pending unavailable");
      const key = { provider: item.provider, model: item.model };
      if (!item.pendingKeyAt.startsWith(`${priceKey(key)}|`)) throw new Error("pending unavailable");
      after = `${priceKey(key)}}`; return key;
    };
    const items: PriceKey[] = [];
    while (items.length < limit) { const key = await next(); if (key === undefined) return { items }; items.push(key); }
    const more = await next();
    return { items, ...(more === undefined ? {} : { cursor: JSON.stringify(["keys", priceKey(items.at(-1)!)]) }) };
  }

  async pendingFor(key: PriceKey, limit: number, cursor?: string): Promise<PendingPage<EstimatedCall>> {
    if (!validEntry({ ...key, kind: "chat", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 })) throw new Error("pending unavailable");
    if (!whole(limit) || limit < 1 || limit > CORRECTION_RUN_MAX) throw new Error("pending unavailable");
    const id = priceKey(key);
    const position = parsePosition(cursor, id);
    const after = position === undefined ? `${id}|` : pendingKeyAt(id, position[0], position[1]);
    const index = GATEWAY_LEDGER_INDEXES.pendingByKey;
    const found = await this.#db.query(this.#t.ledger, { index: index.name, limit: limit + 1, key: (e) => `${e.name(index.partitionKey)} = ${e.value(GATEWAY_PENDING_PARTITION)} AND ${e.name(index.sortKey)} > ${e.value(after)}` });
    const mine = found.filter((item) => typeof item.pendingKeyAt === "string" && item.pendingKeyAt.startsWith(`${id}|`)).map(toCall);
    const items = mine.slice(0, limit); const last = items.at(-1);
    return { items, ...(mine.length > limit && last !== undefined ? { cursor: JSON.stringify([id, last.settledAt, last.callKey]) } : {}) };
  }

  async pendingExpired(now: number, limit: number, cursor?: string): Promise<PendingPage<EstimatedCall>> {
    if (!whole(now) || !whole(limit) || limit < 1 || limit > CORRECTION_RUN_MAX) throw new Error("pending unavailable");
    const before = now - PENDING_RETENTION_DAYS * DAY_MS;
    const position = parsePosition(cursor, "expiry");
    if (before <= 0 || (position !== undefined && position[0] >= before)) return { items: [] };
    const index = GATEWAY_LEDGER_INDEXES.pendingByAge;
    const low = position === undefined ? undefined : pendingAt(position[0], position[1]);
    // pad(before) sorts below every value at that millisecond, so BETWEEN/< keep settledAt < before only.
    const found = await this.#db.query(this.#t.ledger, { index: index.name, limit: limit + 2, key: (e) => low === undefined
      ? `${e.name(index.partitionKey)} = ${e.value(GATEWAY_PENDING_PARTITION)} AND ${e.name(index.sortKey)} < ${e.value(pad(before))}`
      : `${e.name(index.partitionKey)} = ${e.value(GATEWAY_PENDING_PARTITION)} AND ${e.name(index.sortKey)} BETWEEN ${e.value(low)} AND ${e.value(pad(before))}` });
    const calls = found.filter((item) => item.pendingAt !== low).map(toCall).filter((call) => call.settledAt < before);
    const items = calls.slice(0, limit); const last = items.at(-1);
    return { items, ...(calls.length > limit && last !== undefined ? { cursor: JSON.stringify(["expiry", last.settledAt, last.callKey]) } : {}) };
  }

  async read(scope: MeterScope, options?: { upkeep?: true }): Promise<readonly MeterRow[]> {
    if (!validScope(scope)) throw new Error("meter unavailable");
    const pk = companyPartition(scope.iss, scope.cid);
    const targets = targetsFor(scope, { task: 0, projectMonth: 0, ...(options?.upkeep === true ? { upkeepMonth: 0 } : {}) }, this.#month());
    const stored = await this.#rows(pk, targets);
    return targets.map((target, i) => rowOf(stored[i], target, scope.cid));
  }
}

function parsePosition(cursor: string | undefined, scope: string): readonly [number, string] | undefined {
  if (cursor === undefined) return undefined;
  let parsed: unknown;
  try { if (typeof cursor !== "string" || cursor.length > 8192) throw new Error(); parsed = JSON.parse(cursor); } catch { throw new Error("pending unavailable"); }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== scope || !whole(parsed[1]) || typeof parsed[2] !== "string" || parsed[2].length === 0 || parsed[2].length > 4096) throw new Error("pending unavailable");
  return [parsed[1], parsed[2]];
}

/**
 * How long an ended-task row is kept (DynamoDB TTL on `expiresAt`, epoch seconds). A task token lives TASK_TOKEN_SECONDS (900 s) and a call at most
 * CALL_HARD_CEILING_MS, so no call of an ended task can still be admitted or streaming a day after its end; seven days is the margin for a
 * notice that is redelivered late (it only writes the row again: the task is still ended).
 */
export const ENDED_TASK_RETENTION_SECONDS = 7 * 24 * 3600;

/**
 * The ended-task list in the markers table. A read that fails throws, and the server stops the call (fail closed).
 * Readers look only at whether the row exists (every other attribute is ignored), so the row may grow new attributes.
 */
export class DynamoEndedTasks implements EndedTasks, EndedTaskRecorder {
  constructor(private readonly db: Dynamo, private readonly table: string, private readonly now: () => number = Date.now) {}
  /**
   * Records that a task ended: one conditional put that only writes where no row exists, so a repeat notice changes nothing (not even the expiry) and
   * a task is never un-ended. Returns whether this call wrote the row. A fault throws (the notice is then answered 503 and sent again).
   */
  async record(issuer: string, company: string, task: string, signal?: AbortSignal): Promise<boolean> {
    if (typeof issuer !== "string" || issuer.length === 0 || issuer.length > 2048 || !COMPANY.test(company) || !TASK.test(task)) throw new AwsNotSentError();
    const at = this.now();
    return this.db.put(this.table, { pk: companyPartition(issuer, company), sk: `ENDED#${task}`, task, endedAt: at, expiresAt: Math.floor(at / 1000) + ENDED_TASK_RETENTION_SECONDS }, (e) => `attribute_not_exists(${e.name("pk")})`, signal === undefined ? {} : { signal });
  }
  async isEnded(issuer: string, company: string, task: string, signal?: AbortSignal): Promise<boolean> {
    if (typeof issuer !== "string" || issuer.length === 0 || issuer.length > 2048 || !COMPANY.test(company) || !TASK.test(task)) throw new AwsNotSentError();
    const item = await this.db.get(this.table, { pk: companyPartition(issuer, company), sk: `ENDED#${task}` }, { consistent: false, ...(signal === undefined ? {} : { signal }) });
    return item !== undefined;
  }
}
