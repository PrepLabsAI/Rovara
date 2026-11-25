// The product route's whole-stage eval hold (Code #683 EvalModelAccess; DEC 165, 203, 228c). Code's final-check eval holds the
// WHOLE estimate of a stage before its first call, runs the stage's calls under that one hold, and releases it once:
//
//   POST /v1/product/eval/hold     {grant, calls, costMicros}                 -> {scope, calls, costMicros, expiresAt}
//   POST /v1/product/gemini/...    (x-rovara-eval-scope: <scope>)             -> an event stream: one head, chunks, one settle
//   POST /v1/product/eval/release  {scope, calls, costMicros, unknown}        -> {released}
//
// All three carry the same TC-1 task token. The hold is ONE meter reservation of the whole cost against the product rows and the
// combined company row (company room, project month room), checked against the approved project eval budget and the grant,
// after re-reading the approval, the approver's current role and the product-key connection. A refusal holds nothing. The scope
// is opaque, bound to install, company, project and task: any other caller's lookup is the same "not found" as a missing one.
// Each call under the scope reserves nothing new on the meter; it is admitted against the stage's own count and spend.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { validCaps, type Caps, type CapsSource } from "./caps.js";
import type { EstimatedSettlement, Meter, MeterItem, MeterScope, Reservation, ReserveInput, ReserveResult } from "./meter.js";
import { record, TASK_TOKEN_SECONDS, whole, type TaskClaims } from "./model-gateway-token.js";
import { CALL_HARD_CEILING_MS } from "./provider.js";
import type { GatewaySink, ProductControl, RouteRefusal } from "./server.js";

/** DEC 203: an approved project eval budget of about 400 calls and $4, per stage run; configurable per project. */
export const EVAL_DEFAULT_BUDGET = Object.freeze({ calls: 400, costMicros: 4_000_000 });
/** How long a stage may stay open. After it, the stage refuses calls and is released at its counted spend (whole hold if a call is open). */
export const EVAL_STAGE_MS = 4 * 60 * 60_000;
/** The longest a call waits for its turn when it may pass the held cost (it then runs alone). */
export const EVAL_STAGE_WAIT_MS = 120_000;
export const EVAL_OPEN_STAGES_PER_COMPANY = 8;
export const EVAL_OPEN_STAGES_MAX = 2_000;
/** Conditional-write attempts per stage change before answering busy (a lost race re-reads and tries again). */
const STORE_ATTEMPTS = 25;
/** How long a parent settle may hold its lease before another task may take it over. */
const SETTLE_LEASE_MS = 60_000;
/** A call admitted this long ago with no settle (its task died) is counted at its whole estimate by the sweep. */
export const EVAL_DEAD_CALL_MS = CALL_HARD_CEILING_MS + 15 * 60_000;
const DEAD_CALL_MS = EVAL_DEAD_CALL_MS;
/** A company slot outlives its stage by as long as a call admitted at the deadline may still run. */
const SLOT_GRACE_MS = EVAL_DEAD_CALL_MS;
const WAITER_GRACE_MS = 5_000;
const POLL_MS = 1_000;
const SWEEP_PER_PASS = 100;
export const EVAL_SCOPE_HEADER = "x-rovara-eval-scope";
export const EVAL_HOLD_PATH = "/v1/product/eval/hold";
export const EVAL_RELEASE_PATH = "/v1/product/eval/release";
export const EVAL_HOLD_REFUSED = "the eval budget could not be held";
export const EVAL_STAGE_SPENT = "the eval stage's held budget is used up";
export const EVAL_ALREADY_RELEASED = "the eval hold was already released";
/**
 * PRODUCT-EVAL-APPROVER-REREAD: an approval source answers this when the project HAS an approval that no longer counts (older than
 * its freshness window, or its approver was withdrawn). The hold answers EVAL_APPROVAL_STALE_CODE so the app asks for it again.
 */
export const EVAL_APPROVAL_STALE = "stale" as const;
export const EVAL_APPROVAL_STALE_CODE = "eval_approval_stale";
export const EVAL_APPROVAL_STALE_MESSAGE = "the eval spend approval is no longer current; approve it again";
export const EVAL_CLASSES = ["ok", "rate_limit", "quota", "overloaded", "cap", "key_refused", "provider_error", "refused"] as const;
export type EvalCallClass = typeof EVAL_CLASSES[number];
export type EvalRole = "owner" | "admin" | "maintainer";
const ROLES: readonly string[] = ["owner", "admin", "maintainer"];

/** Code's EvalSpendGrant, as sent: validated field by field at runtime. */
export interface EvalGrant {
  company: string; project: string; selection: string; role: EvalRole; inputsDigest: string;
  provider: "customer"; connected: boolean; maxCalls: number; maxCostMicros: number;
}
/** The persisted, approved eval spend for a project (Code's EVAL_SPEND_APPROVAL), as the gateway re-reads it at hold time. */
export interface EvalApproval {
  selection: string; inputsDigest: string; maxCalls: number; maxCostMicros: number;
  /** When set, every call of a stage must name this model. */
  model?: string;
  approver: { personId: string; provider: string };
}
export interface EvalApprovalSource {
  /**
   * The project's current approved eval spend; undefined when none or rejected; EVAL_APPROVAL_STALE when one is recorded but no
   * longer counts (too old, or its approver withdrawn: approve again). A failed read throws (503, nothing held).
   */
  current(iss: string, cid: string, project: string, signal?: AbortSignal): Promise<EvalApproval | typeof EVAL_APPROVAL_STALE | undefined>;
  /** The approver's CURRENT role in that project (membership re-read, never cached); undefined when no longer a member. */
  roleOf(iss: string, cid: string, project: string, approver: EvalApproval["approver"], signal?: AbortSignal): Promise<EvalRole | undefined>;
}
export interface ProductEvalOptions {
  approvals: EvalApprovalSource;
  /** The approved project eval budget; default EVAL_DEFAULT_BUDGET. */
  budget?: (iss: string, cid: string, project: string) => Promise<{ calls: number; costMicros: number }>;
  now?: () => number;
  stageMs?: number;
  waitMs?: number;
  /** Where stages live. Deployed: the shared DynamoDB stage table (DynamoEvalStageStore), so any gateway task serves any stage call. Default: this process only. */
  store?: EvalStageStore;
}
/** What the hold needs from the product route (createProductRoutes supplies it). */
export interface ProductEvalContext {
  meter: Meter;
  caps: CapsSource;
  /** The project's own product key is connected (only its install, company and project are read). */
  connected(scope: Pick<TaskClaims, "iss" | "cid" | "pid">, signal: AbortSignal): Promise<boolean>;
  blocked(claims: TaskClaims): Promise<boolean>;
  block(claims: TaskClaims): Promise<void>;
}

/**
 * One call under a stage. `marker`: the company's one overrun-capable-call-in-flight marker, taken on the real meter by a call
 * that may pass the hold. `claiming`: admitted, still waiting for that marker (nothing sent yet). `startedAt`: when it was
 * admitted; a call older than the call ceiling whose settle never came (its process died) is counted at its whole estimate by
 * the sweep.
 */
export interface SubCall { estimate: number; exclusive: boolean; claiming?: true; marker?: Reservation; startedAt: number }
/**
 * A stage, as stored (EvalStageStore): plain data only, so any gateway task can read it and change it with a conditional write.
 */
export interface EvalStage {
  readonly id: string; readonly iss: string; readonly cid: string; readonly pid: string; readonly tid: string;
  readonly heldCalls: number; readonly heldCost: number; readonly deadline: number; readonly model?: string;
  /** The parent hold on the real meter (its id; settled from any task through Meter.adopt). */
  readonly reservation: Reservation;
  /** open: takes calls. stopped: takes none (its hold was passed, it was released, or it expired). */
  status: "open" | "stopped";
  /** The caller's one release was accepted. */
  callerReleased: boolean;
  /**
   * The parent hold on the real meter: settled exactly once, only when no call of the stage is open. "settling" is a lease
   * (`settlingBy` until `settlingUntil`): a task that died while settling leaves it to the next one (the meter's settle closes
   * only an open hold, so a second settle changes nothing).
   */
  parent: "held" | "settling" | "settled";
  settlingBy?: string; settlingUntil?: number;
  settledMicros: number;
  /** Settle the parent at no less than the whole hold (the caller said unknown, or it closed with a call open). */
  keepWhole: boolean;
  /** A caller's report, up to the hold: the parent never settles below it. */
  reportedFloor: number;
  /** Company markers kept by a call that passed the hold, given back only after the parent (and so the overshoot) is settled. */
  heldMarkers: Reservation[];
  dispatched: number; spent: number; inFlight: number; inFlightCost: number; exclusive: boolean; estimatedAny: boolean;
  /** Admitted calls still waiting for the company marker: counted open, but nothing has been sent for them yet. */
  claiming: number;
  /** Calls waiting for their turn to run alone (id -> until, epoch ms): while any live one waits, no call joins (first come, first served). */
  waiting: Record<string, number>;
  subs: Record<string, SubCall>;
}
export interface StageSettle { costMicros: number; estimated: boolean; overrun: boolean }
/** A stage's address: its company and its random id. */
export interface StageRef { iss: string; cid: string; id: string }
/**
 * Where stages live (B8, PRODUCT-EVAL-STAGE-STORE): shared by every gateway task, so a hold, a call and the release may each land
 * on a different task. Every change is a conditional write on the stage's version (no lost update between tasks).
 */
export interface EvalStageStore {
  get(ref: StageRef): Promise<{ version: number; stage: EvalStage } | undefined>;
  /** Create (expected 0: only when absent) or replace at exactly `expected`. False when the condition failed; throws when unknown. */
  put(stage: EvalStage, expected: number): Promise<boolean>;
  /** The company's open-stage slots (stage id -> until, epoch ms): the per-company open-stage limit, shared by every task. */
  slots(iss: string, cid: string): Promise<{ version: number; open: Record<string, number> }>;
  putSlots(iss: string, cid: string, open: Record<string, number>, expected: number): Promise<boolean>;
  /**
   * Stages whose parent is not settled and that are due for the sweep (evalStageSweepAt at or before `before`): stopped ones first (a
   * release whose settle failed, an overrun), then by deadline. At most `limit`.
   */
  due(before: number, limit: number): Promise<StageRef[]>;
}
/**
 * When the sweep should look at a stage: at once once stopped (its parent may need a settle retry); else at its deadline, or
 * sooner when a call admitted under it may belong to a task that died (its start plus EVAL_DEAD_CALL_MS), so a dead call never
 * holds an open stage's turn until the deadline.
 */
export function evalStageSweepAt(stage: Pick<EvalStage, "status" | "deadline" | "subs">): number {
  if (stage.status === "stopped") return 0;
  return Math.min(stage.deadline, ...Object.values(stage.subs).map((sub) => sub.startedAt + EVAL_DEAD_CALL_MS));
}
/** One process's stages (tests, a laptop, and the default when no shared store is given). */
export class InMemoryEvalStageStore implements EvalStageStore {
  readonly #stages = new Map<string, { version: number; stage: EvalStage }>();
  readonly #slots = new Map<string, { version: number; open: Record<string, number> }>();
  #key(ref: StageRef): string { return JSON.stringify([ref.iss, ref.cid, ref.id]); }
  async get(ref: StageRef): Promise<{ version: number; stage: EvalStage } | undefined> { const row = this.#stages.get(this.#key(ref)); return row === undefined ? undefined : structuredClone(row); }
  async put(stage: EvalStage, expected: number): Promise<boolean> {
    const key = this.#key(stage); const row = this.#stages.get(key);
    if ((row?.version ?? 0) !== expected) return false;
    this.#stages.set(key, { version: expected + 1, stage: structuredClone(stage) });
    return true;
  }
  async slots(iss: string, cid: string): Promise<{ version: number; open: Record<string, number> }> { return structuredClone(this.#slots.get(JSON.stringify([iss, cid])) ?? { version: 0, open: {} }); }
  async putSlots(iss: string, cid: string, open: Record<string, number>, expected: number): Promise<boolean> {
    const key = JSON.stringify([iss, cid]);
    if ((this.#slots.get(key)?.version ?? 0) !== expected) return false;
    this.#slots.set(key, { version: expected + 1, open: structuredClone(open) });
    return true;
  }
  async due(before: number, limit: number): Promise<StageRef[]> {
    return [...this.#stages.values()].filter((row) => row.stage.parent !== "settled" && evalStageSweepAt(row.stage) <= before).sort((a, b) => evalStageSweepAt(a.stage) - evalStageSweepAt(b.stage)).slice(0, limit).map((row) => ({ iss: row.stage.iss, cid: row.stage.cid, id: row.stage.id }));
  }
  /** Settled stages are dropped as the DynamoDB table's TTL drops them: after the deadline plus EVAL_DEAD_CALL_MS. */
  forget(now: number): void { for (const [key, row] of this.#stages) if (row.stage.parent === "settled" && row.stage.deadline + EVAL_DEAD_CALL_MS <= now) this.#stages.delete(key); }
}

const refusal = (status: number, code: string, message: string): { status: number; body: Record<string, unknown> } => ({ status, body: { error: { type: code, message } } });
const HOLD_REFUSED = refusal(422, "eval_hold_refused", EVAL_HOLD_REFUSED);
const APPROVAL_STALE = refusal(422, EVAL_APPROVAL_STALE_CODE, EVAL_APPROVAL_STALE_MESSAGE);
const UNAVAILABLE = refusal(503, "unavailable", "model access unavailable");
const NOT_FOUND = refusal(404, "not_found", "not found");
const BUSY = refusal(429, "busy", "too many eval stages are open; try again later");
const SCOPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SELECTION_MAX = 512;
const positive = (v: unknown): v is number => whole(v) && v >= 1;
/** A read bounded by the request's signal (its deadline or disconnect): an abort is a failed read (503, nothing held). */
function raced<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(new Error("aborted")); }
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => { void operation.catch(() => undefined); reject(new Error("aborted")); };
    signal.addEventListener("abort", stop, { once: true });
    operation.then((value) => { signal.removeEventListener("abort", stop); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", stop); reject(error instanceof Error ? error : new Error("read failed")); });
  });
}
const exactKeys = (r: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(r).length === keys.length && keys.every((k) => Object.hasOwn(r, k));

/** Runtime check of Code's grant: every field, no other key. */
export function readGrant(value: unknown): EvalGrant | undefined {
  const g = record(value);
  if (g === undefined || !exactKeys(g, ["company", "project", "selection", "role", "inputsDigest", "provider", "connected", "maxCalls", "maxCostMicros"])) return undefined;
  if (typeof g.company !== "string" || typeof g.project !== "string" || typeof g.selection !== "string" || g.selection.length === 0 || g.selection.length > SELECTION_MAX) return undefined;
  if (typeof g.role !== "string" || !ROLES.includes(g.role) || typeof g.inputsDigest !== "string" || !DIGEST.test(g.inputsDigest)) return undefined;
  if (g.provider !== "customer" || g.connected !== true || !positive(g.maxCalls) || !positive(g.maxCostMicros)) return undefined;
  return g as unknown as EvalGrant;
}
function validApproval(a: unknown): a is EvalApproval {
  const r = record(a); const approver = record(r?.approver);
  return r !== undefined && approver !== undefined && typeof r.selection === "string" && typeof r.inputsDigest === "string" && positive(r.maxCalls) && positive(r.maxCostMicros)
    && (r.model === undefined || typeof r.model === "string") && typeof approver.personId === "string" && typeof approver.provider === "string";
}

/**
 * The stages, in a store every gateway task shares (EvalStageStore; DynamoDB deployed, dynamo-eval-stages.ts): a hold, its calls
 * and its release may each reach a different task behind the load balancer. Every change is a conditional write on the stage's
 * version, retried on a lost race from a fresh read, and every money step (the parent hold, a company marker, the parent settle)
 * happens on the meter outside those writes, ordered so that a task dying between steps leaves the hold to the sweep at its whole
 * estimate, never below. Waiting for a turn polls the store (at most once a second); a wake from this task only makes it sooner.
 */
export class ProductEvalStages {
  readonly #store: EvalStageStore;
  readonly #options: ProductEvalOptions;
  readonly #now: () => number;
  readonly #stageMs: number;
  readonly #waitMs: number;
  /** Holds being made in this task right now (the overall limit: EVAL_OPEN_STAGES_MAX per task). */
  #pendingHolds = 0;
  /** This task's waiters per stage (a local wake only shortens the poll). */
  readonly #waiters = new Map<string, Array<() => void>>();
  #context: ProductEvalContext | undefined;
  constructor(options: ProductEvalOptions) {
    this.#options = options; this.#now = options.now ?? Date.now;
    this.#store = options.store ?? new InMemoryEvalStageStore();
    this.#stageMs = positive(options.stageMs) ? Math.min(options.stageMs, 24 * 60 * 60_000) : EVAL_STAGE_MS;
    this.#waitMs = positive(options.waitMs) ? options.waitMs : EVAL_STAGE_WAIT_MS;
  }
  /** Set once by createProductRoutes. */
  bind(context: ProductEvalContext): void { if (this.#context !== undefined) throw new Error("eval stages already bound"); this.#context = context; }
  #key(ref: StageRef): string { return JSON.stringify([ref.iss, ref.cid, ref.id]); }
  /** The meter's own handle for a stored reservation (DynamoMeter settles only holds it knows; Meter.adopt names one by id). */
  #held(stage: { iss: string; cid: string }, reservation: Reservation): Reservation {
    const meter = this.#context?.meter as (Meter & { adopt?: (iss: string, cid: string, r: Reservation) => Reservation }) | undefined;
    return meter?.adopt?.(stage.iss, stage.cid, reservation) ?? reservation;
  }
  #claims(stage: EvalStage): TaskClaims { return { iss: stage.iss, cid: stage.cid, pid: stage.pid, tid: stage.tid } as TaskClaims; }
  #meterScope(stage: EvalStage): MeterScope { return { iss: stage.iss, cid: stage.cid, pid: stage.pid, tid: `eval.${stage.id}` }; }

  /**
   * Read, change, write at the read version; on a lost race, again from a fresh read. `change` returns its result and whether the
   * stage changed; it runs on a fresh copy each attempt, so it must only change that copy. Undefined: no such stage.
   */
  async #mutate<T>(ref: StageRef, change: (stage: EvalStage) => { result: T; write: boolean }): Promise<{ result: T; stage: EvalStage } | undefined> {
    for (let attempt = 0; attempt < STORE_ATTEMPTS; attempt++) {
      const row = await this.#store.get(ref);
      if (row === undefined) return undefined;
      const { result, write } = change(row.stage);
      if (!write) return { result, stage: row.stage };
      if (await this.#store.put(row.stage, row.version)) return { result, stage: row.stage };
      await new Promise((resolve) => { setTimeout(resolve, Math.floor(Math.random() * 20 * 2 ** Math.min(attempt, 4))); });
    }
    throw new Error("eval stage busy");
  }
  async #mutateSlots(iss: string, cid: string, change: (open: Record<string, number>, now: number) => boolean): Promise<boolean> {
    for (let attempt = 0; attempt < STORE_ATTEMPTS; attempt++) {
      const row = await this.#store.slots(iss, cid);
      const now = this.#now();
      // Slots past their time are dropped (a task that died while holding never blocks the company for longer than a stage).
      for (const [id, until] of Object.entries(row.open)) if (until <= now) delete row.open[id];
      if (!change(row.open, now)) return false;
      if (await this.#store.putSlots(iss, cid, row.open, row.version)) return true;
      await new Promise((resolve) => { setTimeout(resolve, Math.floor(Math.random() * 20 * 2 ** Math.min(attempt, 4))); });
    }
    throw new Error("eval stage busy");
  }

  /** The stage for this caller, or undefined: missing, another company's, another project's and another task's are one answer. */
  async find(claims: TaskClaims, id: string | undefined): Promise<EvalStage | undefined> {
    if (typeof id !== "string" || !SCOPE.test(id)) return undefined;
    const row = await this.#store.get({ iss: claims.iss, cid: claims.cid, id });
    const stage = row?.stage;
    return stage !== undefined && stage.iss === claims.iss && stage.cid === claims.cid && stage.pid === claims.pid && stage.tid === claims.tid ? stage : undefined;
  }

  control(path: string): ProductControl | undefined {
    if (path === EVAL_HOLD_PATH) return { control: true, handle: (claims, body, signal) => this.hold(claims, body, signal) };
    // A release only gives budget back: it is taken after the task ended too.
    if (path === EVAL_RELEASE_PATH) return { control: true, afterTaskEnd: true, handle: (claims, body) => this.release(claims, body) };
    return undefined;
  }

  /**
   * DEC 253k: may this approver's stored approval spend now? (eval-authority.ts, Code's `eval-reservation` adapter.) The same
   * re-reads as a hold, without a grant or a budget: the project's stored approval counts now (fresh, not withdrawn), it names
   * exactly this approver (person and identity provider), that approver's role still allows it (roleOf, re-read), and the
   * project's own product key is connected (re-read). Answers the role, or undefined for any "no" (none, stale, withdrawn, another
   * approver, no role, not connected). Throws when anything can't be read (the caller answers 503): never a guess.
   */
  async authority(scope: { iss: string; cid: string; pid: string }, approver: EvalApproval["approver"], signal: AbortSignal): Promise<{ role: EvalRole } | undefined> {
    const context = this.#context; if (context === undefined) throw new Error("eval stages not bound");
    const approval = await raced(this.#options.approvals.current(scope.iss, scope.cid, scope.pid, signal), signal);
    if (approval === undefined || approval === EVAL_APPROVAL_STALE) return undefined;
    if (!validApproval(approval)) throw new Error("approval unreadable");
    if (approval.approver.personId !== approver.personId || approval.approver.provider !== approver.provider) return undefined;
    const role = await raced(this.#options.approvals.roleOf(scope.iss, scope.cid, scope.pid, { personId: approval.approver.personId, provider: approval.approver.provider }, signal), signal);
    if (role === undefined || !ROLES.includes(role)) return undefined;
    if ((await raced(context.connected({ iss: scope.iss, cid: scope.cid, pid: scope.pid }, signal), signal)) !== true) return undefined;
    return { role };
  }

  /**
   * L4-T3: is the project's own product key connected right now? (eval-cap.ts adds it to Code's cap read, so a card can say "connect your AI" instead of "not approved".) The same re-read the authority and the hold
   * make (`context.connected`), for this install, company and project only. Undefined when the stages are not bound; a read that fails or is aborted throws (the caller leaves the answer out).
   */
  async connected(scope: { iss: string; cid: string; pid: string }, signal: AbortSignal): Promise<boolean | undefined> {
    const context = this.#context; if (context === undefined) return undefined;
    return (await raced(context.connected({ iss: scope.iss, cid: scope.cid, pid: scope.pid }, signal), signal)) === true;
  }

  async hold(claims: TaskClaims, body: unknown, signal: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> {
    const context = this.#context; if (context === undefined) return UNAVAILABLE;
    if (this.#pendingHolds >= EVAL_OPEN_STAGES_MAX) return BUSY;
    this.#pendingHolds++;
    try { return await this.#hold(context, claims, body, signal); }
    finally { this.#pendingHolds--; }
  }
  async #hold(context: ProductEvalContext, claims: TaskClaims, body: unknown, signal: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> {
    const input = record(body);
    if (input === undefined || !exactKeys(input, ["grant", "calls", "costMicros"]) || !positive(input.calls) || !positive(input.costMicros)) return HOLD_REFUSED;
    const calls = input.calls; const costMicros = input.costMicros;
    const grant = readGrant(input.grant);
    // The grant must be this token's company and project.
    if (grant === undefined || grant.company !== claims.cid || grant.project !== claims.pid) return HOLD_REFUSED;
    if (calls > grant.maxCalls || costMicros > grant.maxCostMicros) return HOLD_REFUSED;
    let approval: EvalApproval | typeof EVAL_APPROVAL_STALE | undefined; let role: EvalRole | undefined; let budget: { calls: number; costMicros: number }; let connected: boolean;
    try {
      if (await raced(context.blocked(claims), signal)) return HOLD_REFUSED;
      approval = await raced(this.#options.approvals.current(claims.iss, claims.cid, claims.pid, signal), signal);
      if (approval === undefined) return HOLD_REFUSED;
      // Recorded, but no longer counted (stale or withdrawn): refused, and the app is told to ask for the approval again.
      if (approval === EVAL_APPROVAL_STALE) return APPROVAL_STALE;
      if (!validApproval(approval)) return UNAVAILABLE;
      // The grant must be exactly the approved spend: selection, inputs, and the confirmed ceilings.
      if (approval.selection !== grant.selection || approval.inputsDigest !== grant.inputsDigest || approval.maxCalls !== grant.maxCalls || approval.maxCostMicros !== grant.maxCostMicros) return HOLD_REFUSED;
      // The approver's role from the approval source on every hold, not the role in Code's grant (deployed: eval-approvals.ts, the
      // role Cloud checked with Code when the approval was recorded, counted for 15 minutes unless withdrawn: PRODUCT-EVAL-APPROVER-REREAD).
      role = await raced(this.#options.approvals.roleOf(claims.iss, claims.cid, claims.pid, { personId: approval.approver.personId, provider: approval.approver.provider }, signal), signal);
      if (role === undefined || !ROLES.includes(role)) return HOLD_REFUSED;
      budget = await raced((this.#options.budget ?? (async () => EVAL_DEFAULT_BUDGET))(claims.iss, claims.cid, claims.pid), signal);
      if (!positive(budget.calls) || !positive(budget.costMicros)) return UNAVAILABLE;
      if (calls > budget.calls || costMicros > budget.costMicros) return HOLD_REFUSED;
      // The product key connection, re-read now.
      connected = await raced(context.connected(claims, signal), signal);
    } catch { return UNAVAILABLE; }
    if (!connected) return HOLD_REFUSED;

    let caps: Caps;
    try { caps = await raced(context.caps.capsFor({ iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid }, signal), signal); } catch { return UNAVAILABLE; }
    // The reads above are bounded by the request's deadline; the writes below are not raced (their outcome must be known).
    if (signal.aborted) return UNAVAILABLE;
    if (!validCaps(caps) || caps.companyMonth === undefined || caps.combinedCompanyMonth === undefined) return UNAVAILABLE;
    const id = randomUUID();
    const now = this.#now(); const deadline = now + this.#stageMs;
    // The company's open-stage limit: a slot is taken (one conditional write, shared by every task) before any money moves, and
    // given back when the parent hold is settled (or when its time is up).
    let slotted: boolean;
    try { slotted = await this.#mutateSlots(claims.iss, claims.cid, (open) => { if (Object.keys(open).length >= EVAL_OPEN_STAGES_PER_COMPANY) return false; open[id] = deadline + SLOT_GRACE_MS; return true; }); }
    catch { return UNAVAILABLE; }
    if (!slotted) return BUSY;
    const freeSlot = async (): Promise<void> => { try { await this.#mutateSlots(claims.iss, claims.cid, (open) => { if (!Object.hasOwn(open, id)) return false; delete open[id]; return true; }); } catch { /* It expires. */ } };
    // The stage's own task row is the stage itself (its cap is the held cost); the project, product-ceiling and combined company
    // rows are the month's. One conditional reservation: all of them or none.
    const scope: MeterScope = { iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: `eval.${id}` };
    let reserved: ReserveResult;
    try { reserved = await context.meter.reserve({ scope, caps: { ...caps, task: costMicros }, estimateMicros: costMicros, sweepAfter: deadline }); } catch { await freeSlot(); return UNAVAILABLE; }
    if (!reserved.ok) {
      await freeSlot();
      if (reserved.reason === "busy") return UNAVAILABLE;
      if (reserved.reason === "cap" && reserved.held) return refusal(429, "budget_held", "budget is held by another call");
      return refusal(422, "budget_exceeded", EVAL_HOLD_REFUSED);
    }
    const stage: EvalStage = {
      id, iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid, heldCalls: calls, heldCost: costMicros, deadline,
      ...(approval.model === undefined ? {} : { model: approval.model }),
      reservation: { id: reserved.reservation.id, ...(reserved.reservation.appliedMaxOutputTokens === undefined ? {} : { appliedMaxOutputTokens: reserved.reservation.appliedMaxOutputTokens }) },
      status: "open", callerReleased: false, parent: "held", settledMicros: 0, keepWhole: false, reportedFloor: 0, heldMarkers: [],
      dispatched: 0, spent: 0, inFlight: 0, inFlightCost: 0, exclusive: false, estimatedAny: false, claiming: 0, waiting: {}, subs: {},
    };
    let stored: boolean;
    try { stored = await this.#store.put(stage, 0); } catch { stored = false; }
    if (!stored) {
      // The stage was never stored (or its outcome is unknown): give the whole hold back at once if nothing could have used it.
      // An unknown store outcome keeps the hold for the sweep instead (a stored stage may be in use).
      try { if ((await this.#store.get(stage)) === undefined) { await context.meter.settle(reserved.reservation, 0); await freeSlot(); } } catch { /* The open-hold sweep closes it at its whole estimate. */ }
      return UNAVAILABLE;
    }
    return { status: 200, body: { scope: id, calls, costMicros, expiresAt: deadline } };
  }

  async release(claims: TaskClaims, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const input = record(body);
    if (input === undefined || !exactKeys(input, ["scope", "calls", "costMicros", "unknown"]) || !whole(input.calls) || !whole(input.costMicros) || typeof input.unknown !== "boolean") return refusal(400, "invalid_request", "request not allowed");
    let found: EvalStage | undefined;
    try { found = await this.find(claims, input.scope as string | undefined); } catch { return UNAVAILABLE; }
    if (found === undefined) return NOT_FOUND;
    const ref: StageRef = found;
    const costMicros = input.costMicros; const unknown = input.unknown;
    let accepted: { result: "ok" | "again" | "settling"; stage: EvalStage } | undefined;
    try {
      accepted = await this.#mutate(ref, (stage) => {
        if (stage.callerReleased) return { result: "again" as const, write: false };
        // The parent is being settled right now (by the last call or the maintenance pass): try again in a moment.
        if (this.#settling(stage)) return { result: "settling" as const, write: false };
        stage.callerReleased = true; stage.status = "stopped";
        // The gateway's own count is the record; a caller's higher report is honoured only up to the hold (never past it on its word).
        stage.reportedFloor = Math.max(stage.reportedFloor, Math.min(costMicros, stage.heldCost));
        // Unknown, or a call still open: the whole hold stays spent (more if the stage's one call over took more). The parent is
        // settled when the last open call settles, so that call's real cost is counted too.
        if (unknown || stage.inFlight - stage.claiming > 0) stage.keepWhole = true;
        return { result: "ok" as const, write: true };
      });
    } catch { return UNAVAILABLE; }
    if (accepted === undefined) return NOT_FOUND;
    if (accepted.result === "again") return refusal(409, "already_released", EVAL_ALREADY_RELEASED);
    if (accepted.result === "settling") return UNAVAILABLE;
    this.#wake(ref);
    let stage = accepted.stage;
    if (stage.parent === "held" && stage.inFlight === 0) {
      const settled = await this.#finalize(ref);
      if (settled === undefined) {
        // Not settled: the caller may release again (the maintenance pass also retries).
        try { await this.#mutate(ref, (s) => { if (s.parent === "settled" || !s.callerReleased) return { result: undefined, write: false }; s.callerReleased = false; return { result: undefined, write: true }; }); } catch { /* The sweep settles it. */ }
        return UNAVAILABLE;
      }
      stage = settled;
    }
    return { status: 200, body: { released: stage.parent === "settled" ? Math.max(0, stage.heldCost - stage.settledMicros) : 0 } };
  }

  #settling(stage: EvalStage): boolean { return stage.parent === "settling" && (stage.settlingUntil ?? 0) > this.#now(); }

  /**
   * Settles the parent hold exactly once, and only when no call of the stage is open: at the stage's counted spend, never below
   * the caller's (capped) report, and at least the whole hold when `keepWhole`. Then gives back any company marker kept for the
   * overshoot and the company slot. Returns the settled stage, or undefined when not settled now (a failed settle leaves the
   * parent held for a retry: release again, or the maintenance pass). Calls are no longer admitted (the stage is stopped), so
   * the amount cannot change between the lease and the settle.
   */
  async #finalize(ref: StageRef): Promise<EvalStage | undefined> {
    const context = this.#context; if (context === undefined) return undefined;
    const lease = randomUUID();
    let taken: { result: "go" | "done" | "no"; stage: EvalStage } | undefined;
    try {
      taken = await this.#mutate(ref, (stage) => {
        if (stage.parent === "settled") return { result: "done" as const, write: false };
        if (stage.status !== "stopped" || stage.inFlight > 0 || this.#settling(stage)) return { result: "no" as const, write: false };
        stage.parent = "settling"; stage.settlingBy = lease; stage.settlingUntil = this.#now() + SETTLE_LEASE_MS;
        return { result: "go" as const, write: true };
      });
    } catch { return undefined; }
    if (taken === undefined || taken.result === "no") return undefined;
    if (taken.result === "done") return taken.stage;
    const stage = taken.stage;
    const final = Math.max(stage.spent, stage.reportedFloor, stage.keepWhole ? stage.heldCost : 0);
    const estimated = stage.estimatedAny || stage.keepWhole;
    try {
      await context.meter.settle(this.#held(stage, stage.reservation), final, estimated && final >= 1 ? { provider: "gemini", model: stage.model ?? "eval-stage", kind: "chat", settledAt: this.#now() } : undefined);
    } catch {
      try { await this.#mutate(ref, (s) => { if (s.parent !== "settling" || s.settlingBy !== lease) return { result: undefined, write: false }; s.parent = "held"; delete s.settlingBy; delete s.settlingUntil; return { result: undefined, write: true }; }); } catch { /* The lease runs out. */ }
      return undefined;
    }
    let done: { result: Reservation[]; stage: EvalStage } | undefined;
    try {
      done = await this.#mutate(ref, (s) => {
        if (s.parent === "settled") return { result: [] as Reservation[], write: false };
        s.parent = "settled"; s.settledMicros = final; delete s.settlingBy; delete s.settlingUntil;
        return { result: s.heldMarkers.splice(0), write: true };
      });
    } catch { return undefined; }
    if (done === undefined) return undefined;
    for (const marker of done.result) { try { await context.meter.settle(this.#held(stage, marker), 0); } catch { /* It expires. */ } }
    try { await this.#mutateSlots(stage.iss, stage.cid, (open) => { if (!Object.hasOwn(open, stage.id)) return false; delete open[stage.id]; return true; }); } catch { /* It expires. */ }
    return done.stage;
  }

  /**
   * The maintenance pass, over the shared store: an expired stage stops (keeping the whole hold if a call is still open); a call
   * whose settle never came within the call ceiling (its task died) is counted at its whole estimate and the stage keeps its
   * whole hold; every stopped stage with no call open whose parent is not settled yet is settled (a retry after a failed settle
   * too). Settled stages are forgotten by the store after their deadline (DynamoDB TTL).
   */
  async sweep(now: number = this.#now()): Promise<{ released: number; failed: number }> {
    const report = { released: 0, failed: 0 };
    let due: StageRef[];
    try { due = await this.#store.due(now, SWEEP_PER_PASS); } catch { return { released: 0, failed: 1 }; }
    for (const ref of due) {
      try {
        const swept = await this.#mutate(ref, (stage) => {
          let write = false;
          if (stage.parent !== "settled" && stage.deadline <= now && stage.status === "open") { stage.status = "stopped"; if (stage.inFlight - stage.claiming > 0) stage.keepWhole = true; write = true; }
          for (const [id, sub] of Object.entries(stage.subs)) {
            if (sub.startedAt + DEAD_CALL_MS > now) continue;
            // Its task died with the call open: the call may have spent its whole estimate, so it counts in full.
            delete stage.subs[id]; stage.inFlight--; stage.inFlightCost -= sub.estimate; stage.spent += sub.estimate; stage.keepWhole = true;
            if (sub.claiming === true) stage.claiming--;
            if (sub.exclusive) stage.exclusive = false;
            if (sub.marker !== undefined) stage.heldMarkers.push(sub.marker);
            write = true;
          }
          return { result: undefined, write };
        });
        const stage = swept?.stage;
        if (stage === undefined || stage.parent === "settled" || stage.status !== "stopped" || stage.inFlight > 0) continue;
        if ((await this.#finalize(ref)) !== undefined) report.released++; else report.failed++;
      } catch { report.failed++; }
    }
    (this.#store as { forget?: (at: number) => void }).forget?.(now);
    return report;
  }

  /** The per-call meter of one request under a stage: reserves nothing on the real meter. */
  callMeter(found: EvalStage): Meter & { settled(): StageSettle | undefined } {
    const ref: StageRef = { iss: found.iss, cid: found.cid, id: found.id };
    let mine: { id: string } | undefined; let result: StageSettle | undefined;
    const unavailable = async (): Promise<never> => { throw new Error("meter unavailable"); };
    return {
      reserve: async (input: ReserveInput): Promise<ReserveResult> => {
        if (mine !== undefined || record(input) === undefined || !whole(input.estimateMicros)) return { ok: false, reason: "busy" };
        let admitted: ReserveResult;
        try { admitted = await this.#admit(ref, input.estimateMicros, input.overrun); } catch { return { ok: false, reason: "busy" }; }
        if (!admitted.ok) return admitted;
        mine = { id: admitted.reservation.id }; return admitted;
      },
      settle: async (reservation: Reservation, actualMicros: number, estimated?: EstimatedSettlement) => {
        if (mine === undefined || reservation.id !== mine.id) return;
        const id = mine.id;
        const done = await this.#mutate(ref, (stage) => {
          const sub = stage.subs[id];
          // Gone: the sweep already counted it at its whole estimate (its task was taken for dead), or it was settled.
          if (sub === undefined) return { result: undefined, write: false };
          delete stage.subs[id];
          const actual = whole(actualMicros) ? actualMicros : sub.estimate;
          stage.inFlight--; stage.inFlightCost -= sub.estimate; stage.spent += actual;
          if (sub.exclusive) stage.exclusive = false;
          const overrun = stage.spent > stage.heldCost;
          if (estimated !== undefined) stage.estimatedAny = true;
          let free: Reservation | undefined;
          if (sub.marker !== undefined) {
            // A call that passed the hold keeps the company marker until its overshoot is on the meter (the parent settled), so no
            // other call of the company may pass a cap meanwhile (DEC 165, 228c). Otherwise the marker goes with the call.
            if (overrun) stage.heldMarkers.push(sub.marker); else free = sub.marker;
          }
          // DEC 165: the call that passed the held cost is the last; the stage and the task's product calls stop.
          const block = overrun && stage.status === "open";
          if (block) stage.status = "stopped";
          return { result: { settle: { costMicros: actual, estimated: estimated !== undefined, overrun }, free, block }, write: true };
        });
        const outcome = done?.result;
        if (outcome === undefined) return;
        result = outcome.settle;
        if (outcome.free !== undefined) { try { await this.#context?.meter.settle(this.#held(found, outcome.free), 0); } catch { /* It expires. */ } }
        if (outcome.block) void this.#context?.block(this.#claims(found)).catch(() => undefined);
        this.#wake(ref);
        // The last open call of a stopped stage settles its parent, with every call's real cost counted.
        if (done!.stage.status === "stopped" && done!.stage.inFlight === 0) await this.#finalize(ref);
      },
      settled: () => result,
      pendingKeys: unavailable, pendingFor: unavailable, pendingExpired: unavailable, expire: unavailable, correct: unavailable, read: unavailable,
    };
  }

  /**
   * Admission under the stage: refused once closed, past its deadline, at its held call count, or once its spend reached the held
   * cost. A call that fits (spend + open calls' holds + its own hold within the held cost, and bounded by its price) runs at once;
   * one that may pass the held cost runs only ALONE, so the stage passes its hold by at most that one call (DEC 165). Each step is
   * one conditional write on the shared stage, so two tasks admitting at once can never both run "alone" or both take the last call.
   */
  async #admit(ref: StageRef, estimate: number, overrun: ReserveInput["overrun"]): Promise<ReserveResult> {
    const spentUp: ReserveResult = { ok: false, reason: "cap", item: "task", held: false };
    const overrunCapable = overrun !== undefined;
    // Waiting is measured on the process's monotonic clock, not the meter clock.
    const giveUp = performance.now() + this.#waitMs;
    const waiter = randomUUID();
    let waitingMyTurn = false; let markerBusy = false;
    try {
    for (;;) {
      const now = this.#now();
      type Step = { kind: "spent" } | { kind: "busy" } | { kind: "go" | "claim"; id: string } | { kind: "wait"; queued: boolean };
      const step = await this.#mutate<Step>(ref, (stage) => {
        if (stage.status !== "open" || now >= stage.deadline || stage.dispatched >= stage.heldCalls || stage.spent >= stage.heldCost) {
          const had = Object.hasOwn(stage.waiting, waiter); delete stage.waiting[waiter];
          return { result: { kind: "spent" as const }, write: had };
        }
        if (!Number.isSafeInteger(stage.spent + stage.inFlightCost + estimate)) return { result: { kind: "busy" as const }, write: false };
        // A call that may pass the hold runs ALONE: nothing joins it while it is open (or waiting for the company marker), and
        // nothing jumps ahead of one waiting for its turn (REVIEW recheck M1). A waiter whose time is up (its task died) is ignored.
        const mine = Object.hasOwn(stage.waiting, waiter);
        const othersWaiting = Object.entries(stage.waiting).filter(([id, until]) => id !== waiter && until > now).length;
        const fits = !overrunCapable && !stage.exclusive && othersWaiting === 0 && stage.spent + stage.inFlightCost + estimate <= stage.heldCost;
        if (fits || (stage.inFlight === 0 && (othersWaiting === 0 || mine))) {
          delete stage.waiting[waiter];
          for (const [id, until] of Object.entries(stage.waiting)) if (until <= now) delete stage.waiting[id];
          const id = randomUUID();
          stage.dispatched++; stage.inFlight++; stage.inFlightCost += estimate;
          stage.subs[id] = { estimate, exclusive: !fits, startedAt: now, ...(fits ? {} : { claiming: true as const }) };
          if (!fits) { stage.exclusive = true; stage.claiming++; }
          return { result: { kind: fits ? "go" as const : "claim" as const, id }, write: true };
        }
        const fitsAlone = !overrunCapable && stage.spent + stage.inFlightCost + estimate <= stage.heldCost;
        if (!fitsAlone && !mine) { stage.waiting[waiter] = now + this.#waitMs + WAITER_GRACE_MS; return { result: { kind: "wait" as const, queued: true }, write: true }; }
        return { result: { kind: "wait" as const, queued: mine }, write: false };
      });
      if (step === undefined) return spentUp;
      const r = step.result;
      if (r.kind === "spent") { waitingMyTurn = false; return spentUp; }
      if (r.kind === "busy") return { ok: false, reason: "busy" };
      if (r.kind === "go") { waitingMyTurn = false; return { ok: true, reservation: Object.freeze({ id: r.id }) }; }
      if (r.kind === "claim") {
        waitingMyTurn = false;
        const stage = step.stage;
        // A call that may pass the hold also takes the company's one overrun-capable-call-in-flight marker (DEC 165, 228c):
        // across the agent route, ordinary product calls and every stage, at most one call at a time may pass a cap.
        const marker = await this.#marker(stage, overrun);
        // Re-checked after the await: the stage may have been released, stopped or expired meanwhile.
        const after = await this.#mutate(ref, (s) => {
          const sub = s.subs[r.id];
          if (sub === undefined) return { result: "gone" as const, write: false };
          delete sub.claiming; s.claiming--;
          const stillOpen = s.status === "open" && this.#now() < s.deadline;
          if (marker.ok && stillOpen) { sub.marker = { id: marker.reservation.id }; return { result: "run" as const, write: true }; }
          delete s.subs[r.id]; s.dispatched--; s.inFlight--; s.inFlightCost -= estimate; s.exclusive = false;
          return { result: stillOpen ? "retry" as const : "closed" as const, write: true };
        }).catch(() => undefined);
        if (after?.result === "run") return { ok: true, reservation: Object.freeze({ id: r.id }) };
        if (marker.ok) { try { await this.#context?.meter.settle(marker.reservation, 0); } catch { /* It expires. */ } }
        this.#wake(ref);
        if (after === undefined) return { ok: false, reason: "busy" };
        if (after.result === "gone") return spentUp;
        if (after.result === "closed" || marker.ok) { if (after.stage.status === "stopped" && after.stage.inFlight === 0) await this.#finalize(ref); return spentUp; }
        // The company is already past a cap (or the meter refuses): nothing more under this stage.
        if (marker.reason !== "busy") return spentUp;
        if (!marker.overrunInFlight) return { ok: false, reason: "busy" };
        // The company marker is busy elsewhere: retry on the timer only (a wake from this stage would not free it).
        markerBusy = true;
      } else {
        if (r.kind === "wait") waitingMyTurn = r.queued;
      }
      const left = giveUp - performance.now();
      // Waited for its turn too long: answered like any call behind another company call that may pass a cap (429, retry).
      if (left <= 0) return { ok: false, reason: "busy", overrunInFlight: true };
      const timerOnly = markerBusy; markerBusy = false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(left, POLL_MS));
        function done(): void { clearTimeout(timer); resolve(); }
        if (!timerOnly) { const list = this.#waiters.get(this.#key(ref)) ?? []; list.push(done); this.#waiters.set(this.#key(ref), list); }
      });
    }
    } finally {
      if (waitingMyTurn) {
        try { await this.#mutate(ref, (s) => { if (!Object.hasOwn(s.waiting, waiter)) return { result: undefined, write: false }; delete s.waiting[waiter]; return { result: undefined, write: true }; }); } catch { /* It expires. */ }
        this.#wake(ref);
      }
    }
  }
  /** A zero-cost hold on the real meter carrying the company's in-flight marker; it moves no money. */
  async #marker(stage: EvalStage, overrun: ReserveInput["overrun"]): Promise<ReserveResult> {
    const context = this.#context; if (context === undefined) return { ok: false, reason: "busy" };
    const clock = Math.floor(this.#now() / 1000);
    const open = Number.MAX_SAFE_INTEGER;
    try {
      return await context.meter.reserve({ scope: this.#meterScope(stage), caps: { task: open, projectMonth: open, companyMonth: open, combinedCompanyMonth: open }, estimateMicros: 0,
        overrun: overrun ?? { deadlineSeconds: clock + Math.floor(CALL_HARD_CEILING_MS / 1000), tokenExpiresSeconds: clock + TASK_TOKEN_SECONDS } });
    } catch { return { ok: false, reason: "busy" }; }
  }
  #wake(ref: StageRef): void { const key = this.#key(ref); const waiters = this.#waiters.get(key) ?? []; this.#waiters.delete(key); for (const w of waiters) w(); }
}

/** The settle class of one call under a stage, from how the core ended it. */
export function evalClassOf(outcome: { completed: boolean; code?: string }): EvalCallClass {
  if (outcome.completed) return "ok";
  switch (outcome.code) {
    case "budget_exceeded": case "budget_held": case "busy": return "cap";
    case "product_key_refused": return "key_refused";
    case "provider_limited": return "rate_limit";
    case "provider_quota": return "quota";
    case "provider_overloaded": return "overloaded";
    case undefined: case "provider_error": case "provider_refused": return "provider_error";
    default: return "refused";
  }
}
const REFUSAL_WORD: Partial<Record<EvalCallClass, string>> = { cap: "cap", key_refused: "key_refused", rate_limit: "rate_limit", quota: "quota", overloaded: "overloaded" };
const enc = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`);
const WRITE_MS = 10_000;
async function bounded(write: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([write.then(() => true, () => false), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), WRITE_MS); })]); }
  finally { clearTimeout(timer); }
}

/**
 * The answer of one call under a stage, as events (NDJSON, one per line): exactly one head (the call's status and content type),
 * its bytes as chunks (base64), then exactly one settle. The HTTP status is always 200 once the first event is written; a
 * cut-off is a settle that is not ok, never a clean end.
 */
export class EvalEventSink implements GatewaySink {
  #headSent = false; #cut = false; #status = 0; #broken = false;
  constructor(private readonly real: GatewaySink) {}
  #open(): void { if (!this.#headSent) { this.#headSent = true; this.real.head(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" }); } }
  head(status: number, headers: Readonly<Record<string, string>>): void {
    this.#open(); this.#status = status;
    const type = headers["content-type"];
    void this.#write({ kind: "head", status, headers: type === undefined ? [] : [["content-type", type]] });
  }
  #pending: Promise<void> = Promise.resolve();
  #write(event: unknown): Promise<void> {
    this.#pending = this.#pending.then(async () => { if (this.#broken) throw new Error("response unavailable"); if (!(await bounded(this.real.write(enc(event))))) { this.#broken = true; throw new Error("response unavailable"); } });
    return this.#pending;
  }
  async write(bytes: Uint8Array): Promise<void> { await this.#write({ kind: "chunk", b64: Buffer.from(bytes).toString("base64") }); }
  end(): void { /* The settle line ends the stream. */ }
  destroy(): void { this.#cut = true; }
  get cut(): boolean { return this.#cut; }
  /** The one settle line, after the core settled the call. */
  async close(outcome: { completed: boolean; code?: string }, settled: StageSettle | undefined): Promise<void> {
    await this.#pending.catch(() => undefined);
    const cls = this.#cut ? "provider_error" : evalClassOf(outcome);
    if (!this.#headSent) { this.#open(); this.#status = 502; await this.#write({ kind: "head", status: 502, headers: [] }).catch(() => undefined); }
    const word = REFUSAL_WORD[cls];
    const ok = await this.#write({ kind: "settle", status: this.#status, class: cls, ...(word === undefined || cls === "ok" ? {} : { refusal: word }), costMicros: settled?.costMicros ?? 0, estimated: settled?.estimated ?? false, ...(settled?.overrun === true ? { overrun: true } : {}) }).then(() => true, () => false);
    if (ok) this.real.end(); else this.real.destroy();
  }
}
export type { RouteRefusal, MeterItem };
