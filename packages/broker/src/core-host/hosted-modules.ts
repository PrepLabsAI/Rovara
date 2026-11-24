// Engine host (lane E2, step 5): the security-list points a deployed install fills for the FIRST staging run, as adapter modules for BOTH roots (the broker's, aws/core-engine-root.ts, and the
// dispatcher's `extraModules`). None is ever `isDefault` (the registry's NEVER_DEFAULT rule refuses laptop defaults on these points), and none falls back to a laptop rule.
//
//   admission   An allow-list of company ids (the founders' test company on staging) and two dollar caps, per task and per company per UTC day, read from the core's own cost ledger
//               (core/cost/ledger.ts: the task's total and the company's day row) until the Cloud gateway holds money. Any other company is refused with fixed words.
//               The day cap is a HELD allowance (lane L8, core/cost/holds.ts): an admission that may spend takes a hold on the company's day in the same transaction as the change
//               (`stage()`, a task start: the path's planning allowance, never more than the task cap) or in its own (`admit()`: the estimate, or a fixed amount for a model call of
//               unknown cost), so concurrent starts see each other. Booked usage (core-host/usage-booking.ts, from the workers' usage reports) draws the task's hold down; `settle`
//               keeps the actual cost (all of the hold when the cost is unknown), `release` gives the rest back, and the hold sweep (`createHostedHoldSweep`) gives back a hold nobody
//               closed. The task cap is checked on the task's booked spend, in the same transaction. So the adapter declares `enforcesCost: true`.
//               L2-5 (b): with a project task-cap reader (`projectTaskCap`, the project's own per-task limit `model_budget_usd`), the task cap of a task is the install's cap lowered to
//               its project's limit when one is set; a limit that cannot be read refuses (spend unknown), never falls back to the install's cap.
//   metering    The price table over the catalog's list prices (the capped price for a reservation). A model no table prices is charged a cautious fixed price, never $0
//               (`UNKNOWN_MODEL_PRICE`, DEC 172/216); a cost the provider reported that is higher than the table's is charged instead. No call is made on Rovara's account here:
//               metering only prices usage the company's own provider reported.
//   identity    Code's own sign-in decides who the caller is (the broker verifies the token); this point only names a person of a company, from MEMBERSHIP (R4's reader), never from a claim.
//               It authenticates no credential itself.
//   audit-sink  Code's audit records: the `AUDIT` rows of the company's own partition (the document audit sink), read back by lane AU's company audit read.
//
//   approvers   Switch-on lane L2a (core-host/hosted-approvers.ts): the task owner, as the broker's existing rule, with a proof of one act by the signed-in person, bound to its card, and
//               its one-time part claimed in the company's partition. Built after identity (it names people through that point). A host without the proof key (the dispatcher, which
//               decides nothing for a person) refuses every proof.
//
// Not here: `model-keys` (lane L2b). It stays empty, so the registry refuses the switch by name.
import auditSinkPlugin from "@agentx/local-adapters/audit-sink";
import { bedrockProfileListPrice, listPricesPerMillion, rateQuoteUsageMicros } from "@agentx/model-runtime/catalog";
import {
  IMPLICIT_COMPANY_ID, OrgIdSchema, OrgRoleSchema, change, when,
  type Admission, type AdmissionDecision, type AdmissionRequest, type Cost, type DocumentStore, type IdentityProvider, type MeterResult, type Metering, type ModelPrice, type ModelUsage, type OrgId, type OrgRole, type Principal,
  type RateQuoteV1, type RunUsageCallV1, type TransactItem,
} from "@agentx/contracts";
import { companyDayKey, createCostLedger, costPartition, utcDayOf, type CostLedger } from "../core/cost/ledger.js";
import { CALL_HOLD_SECONDS, TASK_HOLD_SECONDS, closeHold, createLedgerHolds, dayRoomCondition, companyOfReservation, holdItems, holdStateOf, openHoldRoom, planHoldClose, readDayLoad, reservationIdOf, sweepExpiredHolds } from "../core/cost/holds.js";
import { RUN_START_ACTION, type MoneyStop, type SpendStopCode } from "../core/task-flow/money-stop.js";
import { readTask, workspaceOperations } from "../core/task-flow/reads.js";
import { DEFAULT_PLANNING_LIMIT_USD } from "../core/cost/limits.js";
import type { CoreService } from "./core-runtime.js";
import { costMicrosOf, createModelPrices, type ModelPrices } from "../core/cost/price-table.js";
import { createHostedApprovers, approvalProofKeyOf, type HostedChatApproval } from "./hosted-approvers.js";
import { GITHUB_LINK_PROVIDER, githubLinkReaderOver, type GithubLinkReader } from "../core/people/github-links.js";
import { coreAdapter, type CoreAdapterModule } from "./registry.js";

/** The identity adapter's name on a deployed install: the principals it names were signed in by Code's own sign-in. */
export const HOSTED_IDENTITY_PROVIDER = "rovara-sign-in";
const OWNER = "E2 step 5 (the first staging run)";

// ---- settings (the function's environment)

/** The per-task cap in whole dollars. Default 5. */
export const CORE_TASK_CAP_VARIABLE = "ROVARA_CORE_TASK_CAP_USD";
/** The per-company, per-UTC-day cap in whole dollars. Default 25. */
export const CORE_COMPANY_DAY_CAP_VARIABLE = "ROVARA_CORE_COMPANY_DAY_CAP_USD";
export const DEFAULT_TASK_CAP_USD = 5;
export const DEFAULT_COMPANY_DAY_CAP_USD = 25;
/** The highest cap either setting may hold, in dollars: a typo of extra digits refuses instead of lifting the cap. */
const CAP_MAX_USD = 1_000;

export interface HostedAdmissionSettings {
  taskCapMicros: number;
  companyDayCapMicros: number;
}

const wholeDollars = (raw: string | undefined, fallback: number): number | undefined => {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[1-9][0-9]{0,3}$/u.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return value <= CAP_MAX_USD ? value : undefined;
};

/** The admission's settings, or a fixed problem (never the value read). Every company with its own id may start work (DEC 229a; #1275 removed the allow-list), under the caps. */
export function readHostedAdmissionSettings(env: NodeJS.ProcessEnv): { settings: HostedAdmissionSettings } | { problem: string } {
  const task = wholeDollars(env[CORE_TASK_CAP_VARIABLE], DEFAULT_TASK_CAP_USD);
  const day = wholeDollars(env[CORE_COMPANY_DAY_CAP_VARIABLE], DEFAULT_COMPANY_DAY_CAP_USD);
  if (task === undefined || day === undefined) return { problem: "a spend cap is not a whole number of dollars from 1 to 1000" };
  return { settings: { taskCapMicros: task * 1_000_000, companyDayCapMicros: day * 1_000_000 } };
}

// ---- admission

export const COMPANY_NOT_ALLOWED = "This company cannot start work on this install.";
export const COMPANY_DAY_CAP_REACHED = "This company has reached today's spending limit on this install. Try again tomorrow (UTC).";
export const TASK_CAP_REACHED = "This task has reached its spending limit on this install.";
/** L2-5 (b): the task cap that bound was its project's own per-task limit: who can raise it. */
export const PROJECT_TASK_CAP_REACHED = "This task has reached its project's per-task spending limit. A project admin, or a company owner or admin, can raise it in the project's settings.";
export const SPEND_UNKNOWN = "Today's spending could not be worked out, so nothing new was started. Try again later, or ask whoever runs the install.";

const refuse = (code: string, message: string): AdmissionDecision => ({ allowed: false, code, message });

export interface HostedAdmissionOptions {
  settings: HostedAdmissionSettings;
  /** The store the holds and the day rows live in (the registry's). */
  store: DocumentStore;
  /** The task totals, from a ledger that keeps holds (`createHostedLedger`). */
  ledger: Pick<CostLedger, "taskCost">;
  now: () => Date;
  /**
   * The per-run dollar stop is wired on this install (the root books usage as runs report it and stops a run at a cap, the flow's `moneyStop`, and the dispatcher gates each model run).
   * Only then does the adapter declare `enforcesCost: true`, so work with no one present starts only where a run is also stopped at its cap. Absent or false: `enforcesCost` is false and
   * `automation.run` is refused.
   */
  runStopWired?: boolean;
  /** L2-5 (b): the project's own per-task limit (see `ProjectTaskCap`). Absent: every task has the install's cap, exactly as before. */
  projectTaskCap?: ProjectTaskCap | undefined;
}

/**
 * L2-5 (b): a project's own per-task limit in micros (the resolved `model_budget_usd`), or undefined when the project sets none. Throws when it cannot be read: the caller then refuses
 * (spend unknown), it never falls back to the install's cap alone.
 */
export type ProjectTaskCap = (companyId: string, project: string) => Promise<number | undefined>;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/**
 * The cap that applies to one task: the install's task cap, lowered to the project's own per-task limit when the project sets one. The project is the request's (a start names it; the
 * task row may not exist yet), else the task's own row, which must be this company's. Without a reader: the install's cap, nothing read. Throws when the project or its limit cannot be read.
 */
export async function taskCapOf(deps: { store: DocumentStore; settings: HostedAdmissionSettings; projectTaskCap?: ProjectTaskCap | undefined }, companyId: string, taskId: string, projectName?: string): Promise<{ micros: number; project: boolean }> {
  const install = deps.settings.taskCapMicros;
  if (deps.projectTaskCap === undefined) return { micros: install, project: false };
  // The task's own row names its project; the request's name is used only for a start (its row is written in the same transaction), and must agree with the row when both exist.
  const task = await readTask({ store: deps.store }, taskId);
  let project: string;
  if (task !== undefined) {
    if (task.companyId !== companyId || typeof task.project !== "string" || !PROJECT_NAME.test(task.project) || (projectName !== undefined && projectName !== task.project)) throw new Error("the task's project is unknown");
    project = task.project;
  } else {
    if (typeof projectName !== "string" || !PROJECT_NAME.test(projectName)) throw new Error("the task's project is unknown");
    project = projectName;
  }
  const limit = await deps.projectTaskCap(companyId, project);
  if (limit === undefined) return { micros: install, project: false };
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("the project's limit is not readable");
  return limit < install ? { micros: limit, project: true } : { micros: install, project: false };
}

/**
 * L4-TA6: the cap one task is held to now, in dollars, for the flow's `taskCapUsd` (automatic fixing holds its rounds to it): the very value Admission, the per-run stop and the owner's round read (`taskCapOf`: the install's
 * task cap lowered to the project's own per-task limit), read fresh on every call for ONE company. No caps on this install (`settings` undefined), a task of another company, or a project or limit that cannot be read: throws,
 * so the flow asks the owner; it never answers a larger or invented figure.
 */
export function hostedTaskCapUsd(deps: { store: DocumentStore; companyId: string; settings: HostedAdmissionSettings | undefined; projectTaskCap?: ProjectTaskCap | undefined }): (task: { companyId: string; taskId: string; project: string }) => Promise<number> {
  return async (task) => {
    if (deps.settings === undefined || task.companyId !== deps.companyId) throw new Error("the task cap is unavailable");
    const cap = await taskCapOf({ store: deps.store, settings: deps.settings, projectTaskCap: deps.projectTaskCap }, deps.companyId, task.taskId, task.project);
    return cap.micros / 1_000_000;
  };
}

/** What a model call of unknown cost holds (an Ask, a diagnosis): never nothing, so a full day refuses it. */
export const UNKNOWN_CALL_HOLD_MICROS = 1_000_000;

/** The cost ledger a deployed install books into: it keeps holds, so a booked dollar is on the day's load once. */
export function createHostedLedger(deps: { store: DocumentStore; metering: Metering; now?: () => Date }): CostLedger {
  return createCostLedger({ ...deps, holds: createLedgerHolds(deps.store) });
}

/**
 * What a request holds on the company's day, in micros: its dollar estimate; for a task start, its path's planning allowance (a Quick path the small one, any other the full one), never
 * more than the task cap or the day cap; for a model call of unknown cost, `UNKNOWN_CALL_HOLD_MICROS`. Anything else (a machine start) holds nothing and is a gate: it needs the day below its cap.
 */
function holdMicrosOf(request: AdmissionRequest, estimate: Cost | undefined, settings: HostedAdmissionSettings, taskCapMicros: number): number {
  if (estimate !== undefined) return estimate.micros;
  if (request.action === "task.start") return Math.min(DEFAULT_PLANNING_LIMIT_USD[request.taskStart?.path === "QUICK" ? "QUICK" : "FULL"] * 1_000_000, taskCapMicros, settings.companyDayCapMicros);
  if (request.action === "model.call") return Math.min(UNKNOWN_CALL_HOLD_MICROS, settings.companyDayCapMicros);
  return 0;
}

/** The staging admission (see the file comment). */
export function createHostedAdmission(options: HostedAdmissionOptions): Admission {
  const { settings, ledger, store } = options;
  // Any well-formed company id of its own; the implicit laptop company never.
  const isAllowed = (companyId: string): boolean => OrgIdSchema.safeParse(companyId).success && companyId !== IMPLICIT_COMPANY_ID;

  /**
   * The decision and, when allowed, the steps that take its hold and keep both caps at commit, with the reservation id when it holds something. Any spend that cannot be read as dollars
   * refuses.
   */
  async function decide(request: AdmissionRequest): Promise<{ decision: AdmissionDecision; items: TransactItem[] }> {
    if (typeof request?.companyId !== "string" || !isAllowed(request.companyId)) return { decision: refuse("company_not_allowed", COMPANY_NOT_ALLOWED), items: [] };
    const companyId = request.companyId;
    const estimate: Cost | undefined = request.estimate?.cost;
    if (estimate !== undefined && (estimate === null || typeof estimate !== "object" || estimate.currency !== "USD" || !Number.isSafeInteger(estimate.micros) || estimate.micros < 0)) {
      return { decision: refuse("spend_unknown", SPEND_UNKNOWN), items: [] };
    }
    if (typeof request.idempotencyKey !== "string" || request.idempotencyKey === "") return { decision: refuse("spend_unknown", SPEND_UNKNOWN), items: [] };
    const taskId = request.subject?.type === "task" && typeof request.subject.id === "string" && request.subject.id !== "" ? request.subject.id : undefined;
    // L2-5 (b): the task's cap (the install's, or its project's own per-task limit when lower). A limit that cannot be read refuses.
    let taskCap: { micros: number; project: boolean } = { micros: settings.taskCapMicros, project: false };
    if (taskId !== undefined) {
      try { taskCap = await taskCapOf({ store, settings, projectTaskCap: options.projectTaskCap }, companyId, taskId, request.projectName); }
      catch { return { decision: refuse("spend_unknown", SPEND_UNKNOWN), items: [] }; }
    }
    const asked = holdMicrosOf(request, estimate, settings, taskCap.micros);
    // Within a cap: spend plus what is held AT MOST the cap. A task's booked spend holding nothing more needs it BELOW the task cap; the day holding nothing more (a machine start of work
    // already admitted, whose own hold may be what fills the day) needs it at most AT the day cap.
    const fits = (spent: number, cap: number): boolean => (asked === 0 ? spent < cap : spent + asked <= cap);
    const dayFits = (spent: number): boolean => spent + asked <= settings.companyDayCapMicros;
    const holdOn = (path: string, cap: number) => (asked === 0 ? when.lt(path, cap) : when.lte(path, cap - asked));
    const at = options.now();
    const day = utcDayOf(at);
    const load = await readDayLoad(store, companyId, day);
    if (load === "unknown") return { decision: refuse("spend_unknown", SPEND_UNKNOWN), items: [] };
    if (!dayFits(load)) return { decision: refuse("company_day_cap", COMPANY_DAY_CAP_REACHED), items: [] };
    // A task start's hold is the task's own: the task's booked usage draws it down (the total names it).
    const ownsHold = asked > 0 && request.action === "task.start" && taskId !== undefined;
    const reservationId = asked > 0 ? reservationIdOf(companyId, request.idempotencyKey) : undefined;
    const items: TransactItem[] = reservationId === undefined
      ? [{ kind: "check", key: companyDayKey(companyId, day), condition: dayRoomCondition(settings.companyDayCapMicros, 0) }]
      : holdItems({ companyId, reservationId, action: request.action, taskId: ownsHold ? taskId : undefined, day, micros: asked, capMicros: settings.companyDayCapMicros, nowSeconds: Math.floor(at.getTime() / 1000), holdSeconds: ownsHold ? TASK_HOLD_SECONDS : CALL_HOLD_SECONDS });
    if (taskId !== undefined) {
      const task = await ledger.taskCost(companyId, taskId);
      if (task.unpricedEntries > 0 || (task.currency !== undefined && task.currency !== "USD")) return { decision: refuse("spend_unknown", SPEND_UNKNOWN), items: [] };
      if (!fits(task.micros, taskCap.micros)) return { decision: refuse("task_cap", taskCap.project ? PROJECT_TASK_CAP_REACHED : TASK_CAP_REACHED), items: [] };
      const totalKey = { pk: costPartition(companyId, taskId), sk: "TOTAL" };
      const underCap = when.or(when.absent(), when.and(holdOn("micros", taskCap.micros), when.eq("unpricedEntries", 0)));
      items.push(ownsHold
        ? {
          kind: "update", key: totalKey, condition: underCap,
          ops: [
            change.setIfAbsent("entityType", "COST_TOTAL"), change.setIfAbsent("taskId", taskId), change.setIfAbsent("companyId", companyId),
            change.setIfAbsent("micros", 0), change.setIfAbsent("entries", 0), change.setIfAbsent("unpricedEntries", 0), change.set("holdId", reservationId!),
          ],
        }
        : { kind: "check", key: totalKey, condition: underCap });
    }
    return { decision: reservationId === undefined ? { allowed: true } : { allowed: true, reservationId }, items };
  }

  /**
   * An earlier ask with the same key took its hold: while it is open, the same decision and nothing held again. Once it was settled or given back, the key's allowance is spent: the ask is
   * refused (a new ask needs a new key), never answered "allowed" with nothing held.
   */
  const heldBefore = async (request: AdmissionRequest): Promise<AdmissionDecision | undefined> => {
    if (typeof request?.companyId !== "string" || !isAllowed(request.companyId) || typeof request.idempotencyKey !== "string" || request.idempotencyKey === "") return undefined;
    const reservationId = reservationIdOf(request.companyId, request.idempotencyKey);
    const held = await holdStateOf(store, reservationId);
    if (held === undefined) return undefined;
    return held.state === "open" ? { allowed: true, reservationId } : refuse("reservation_closed", RESERVATION_CLOSED);
  };

  const runStopWired = options.runStopWired === true;
  return {
    // A held day cap with usage booking (see the file comment), and a run stopped at its cap: only when the per-run stop is wired.
    enforcesCost: runStopWired,
    async admit(request) {
      // Work with no one present starts only where a run is also stopped at its cap (until then unattended triggers stay off).
      if (request?.action === "automation.run" && !runStopWired) return refuse("run_stop_not_wired", RUN_STOP_NOT_WIRED);
      // A model run about to be dispatched (the per-run stop's gate): holds nothing, refused where the stop would stop it at once.
      if (request?.action === RUN_START_ACTION) {
        if (typeof request.companyId !== "string" || !isAllowed(request.companyId)) return refuse("company_not_allowed", COMPANY_NOT_ALLOWED);
        const taskId = request.subject?.type === "task" && typeof request.subject.id === "string" && request.subject.id !== "" ? request.subject.id : undefined;
        if (taskId === undefined) return refuse("spend_unknown", SPEND_UNKNOWN);
        const state = await runSpendState({ store, ledger, settings, now: options.now, projectTaskCap: options.projectTaskCap }, request.companyId, taskId, request.projectName);
        if (state === "within") return { allowed: true };
        // The project's own limit was the one reached: its words say who can raise it.
        if (state === "task_cap" && options.projectTaskCap !== undefined) {
          const cap = await taskCapOf({ store, settings, projectTaskCap: options.projectTaskCap }, request.companyId, taskId, request.projectName).catch(() => undefined);
          if (cap?.project === true) return refuse("task_cap", PROJECT_TASK_CAP_REACHED);
        }
        return runStopRefusal(state);
      }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const earlier = await heldBefore(request);
        if (earlier !== undefined) return earlier;
        const { decision, items } = await decide(request);
        // A refusal, or a gate that holds nothing, writes nothing.
        if (!decision.allowed || decision.reservationId === undefined) return decision;
        if ((await store.transact(items)).applied) return decision;
        // Lost to the same key (its hold is there now: answered above on the next turn) or to another hold that filled the day (decided again).
      }
      throw new Error("the spend hold could not be taken");
    },
    async stage(request) {
      if (request?.action === "automation.run" && !runStopWired) return { decision: refuse("run_stop_not_wired", RUN_STOP_NOT_WIRED), items: [] };
      const earlier = await heldBefore(request);
      if (earlier !== undefined) return { decision: earlier, items: [] };
      const { decision, items } = await decide(request);
      return { decision, items: decision.allowed ? items : [] };
    },
    // What the work cost: a dollar figure is kept (less what booked usage drew already); anything else keeps the whole hold, never $0.
    async settle(reservationId, actual) {
      const cost = actual?.cost;
      const actualMicros = cost !== undefined && cost !== null && cost.currency === "USD" && Number.isSafeInteger(cost.micros) && cost.micros >= 0 ? cost.micros : undefined;
      await closeHold(store, reservationId, { kind: "settle", actualMicros }, options.now);
    },
    async release(reservationId) {
      await releaseOrKeep(store, reservationId, options.now);
    },
  };
}

export const RESERVATION_CLOSED = "This request's spending allowance was already used or given back. Ask again as a new request.";
export const RUN_STOP_NOT_WIRED = "This install does not stop a run at its spending limit yet, so nothing is started on its own.";

/** Where a task's run stands against the caps, for the per-run stop: `within`, or the cap it reached (or `spend_unknown` when its spend cannot be read as dollars). */
export type RunSpendState = "within" | SpendStopCode;

/**
 * The per-run stop's reading (lane core-money-stop), after each booking of a run's usage and before each model run is dispatched:
 *   - the task's booked spend at or past the task cap: `task_cap`;
 *   - the company's day at or past its cap (booked dollars, what settles kept and the open holds of the day): `company_day_cap`, unless the task's own open hold still has room (what it
 *     spends there was promised to it when it started, so another task's hold never stops it);
 *   - spend that cannot be read as dollars (the task's or the day's), or a read that fails: `spend_unknown` (fails closed).
 */
export async function runSpendState(deps: { store: DocumentStore; ledger: Pick<CostLedger, "taskCost">; settings: HostedAdmissionSettings; now: () => Date; projectTaskCap?: ProjectTaskCap | undefined }, companyId: string, taskId: string, projectName?: string): Promise<RunSpendState> {
  try {
    const task = await deps.ledger.taskCost(companyId, taskId);
    if (task.unpricedEntries > 0 || (task.currency !== undefined && task.currency !== "USD")) return "spend_unknown";
    // L2-5 (b): the task's cap is its project's own per-task limit when that is lower (read now, so a lowered limit stops the run at its next booking); unreadable is spend unknown.
    if (task.micros >= (await taskCapOf(deps, companyId, taskId, projectName)).micros) return "task_cap";
    const load = await readDayLoad(deps.store, companyId, utcDayOf(deps.now()));
    if (load === "unknown") return "spend_unknown";
    if (load < deps.settings.companyDayCapMicros) return "within";
    // The task's own hold counts only when it is this company's and on today (a hold of an earlier day promised nothing on this one).
    const total = await deps.store.get({ pk: costPartition(companyId, taskId), sk: "TOTAL" });
    const holdId = total?.["holdId"];
    return companyOfReservation(holdId) === companyId && (await openHoldRoom(deps.store, holdId, utcDayOf(deps.now()))) > 0 ? "within" : "company_day_cap";
  } catch {
    return "spend_unknown";
  }
}

/** The refusal of a model run the per-run stop would stop at once. */
const runStopRefusal = (state: SpendStopCode): AdmissionDecision =>
  state === "task_cap" ? refuse("task_cap", TASK_CAP_REACHED) : state === "company_day_cap" ? refuse("company_day_cap", COMPANY_DAY_CAP_REACHED) : refuse("spend_unknown", SPEND_UNKNOWN);

/** The provider an estimate of a stopped run's unreported usage is booked under (its own meter charges the estimate itself). */
export const UNFLUSHED_ESTIMATE_PROVIDER = "rovara-unflushed-estimate";
/** The entry id of that estimate: one per run, so a second try books nothing more, and the run then counts as booked (`runsOwed`). */
export const unflushedEntryId = (operationId: string): string => `usage:${operationId}:unflushed`;

/** What a stopped run's unreported usage is estimated at when no open hold is left to keep: a full start's planning allowance, never more than the task cap. */
export function unflushedEstimateMicros(settings: HostedAdmissionSettings | undefined): number {
  const full = DEFAULT_PLANNING_LIMIT_USD.FULL * 1_000_000;
  return settings === undefined ? full : Math.min(full, settings.taskCapMicros);
}

/**
 * The flow's money stop on a deployed install, for one company: a run stopped before its usage arrived keeps its task's whole start hold as spent, marked estimated (core/cost/holds.ts
 * `closeHold`). When no hold with room is left (it was closed by an earlier stop, released, swept, or used up), a fixed estimate is booked on the task instead
 * (`usage:<operation>:unflushed`, `unflushedEstimateMicros`), so unknown spend is never $0. A hold of another company is never touched; the estimate is booked under this company.
 */
export function createHostedMoneyStop(deps: { store: DocumentStore; companyId: string; settings?: HostedAdmissionSettings | undefined; now: () => Date }, timing: Pick<MoneyStop, "flushWaitMs" | "pollMs" | "sleep"> = {}): MoneyStop {
  // The estimate's own meter: it charges the figure the estimate carries, and nothing draws a hold (the run's hold is closed first).
  const estimates = createCostLedger({
    store: deps.store, now: deps.now, holds: createLedgerHolds(deps.store),
    metering: { async price() { return null; }, async record(entry) { return { cost: entry.usage.provider === UNFLUSHED_ESTIMATE_PROVIDER ? entry.reportedCost ?? null : null, source: "unknown" }; } },
  });
  return {
    ...timing,
    async planUnflushed(reservationId, mark) {
      const covered = (await deps.store.query({ pk: costPartition(deps.companyId, mark.taskId), sk: { op: "beginsWith", prefix: `ENTRY#usage-charge:${mark.operationId}:` }, limit: 1 })).items.length > 0;
      const ours = companyOfReservation(reservationId) === deps.companyId;
      const hold = await planHoldClose(deps.store, ours ? reservationId : undefined, covered ? { kind: "release" } : { kind: "settle", actualMicros: undefined, estimated: { operationId: mark.operationId } }, deps.now);
      return { items: hold.items, plan: { schemaVersion: 1, at: deps.now().toISOString(), covered, restMicros: covered ? 0 : Math.max(0, unflushedEstimateMicros(deps.settings) - hold.remaining) } };
    },
    async applyUnflushed(plan, mark) {
      await estimates.recordUsage({
        companyId: deps.companyId, entryId: unflushedEntryId(mark.operationId), at: plan.at, taskId: mark.taskId,
        usage: { provider: UNFLUSHED_ESTIMATE_PROVIDER, modelId: plan.covered ? "unavailable" : "estimate", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        ...(plan.covered ? {} : { reportedCost: { micros: plan.restMicros, currency: "USD" } }),
      }, { status: plan.covered ? "awaiting_usage" : "estimated" });
    },
    async keepWholeHold(reservationId, mark) {
      // What the run's unreported spend is kept at: never less than the fixed estimate. The hold's room is kept first (the whole hold, as spent); what the room does not cover is booked
      // as the estimate entry. A hold its checkpoints nearly used up thus never keeps only its last cents for a call that was still going.
      // A receipt-covered operation already books each recoverable per-call R. An unflushed tail without
      // coverage proof has no recoverable R: mark it unavailable before releasing the engine planning hold.
      // This blocks admission and avoids adding a fabricated Full-planning amount to the known calls.
      const covered = await deps.store.query({ pk: costPartition(deps.companyId, mark.taskId), sk: { op: "beginsWith", prefix: `ENTRY#usage-charge:${mark.operationId}:` }, limit: 1 });
      if (covered.items.length > 0) {
        await estimates.recordUsage({ companyId: deps.companyId, entryId: unflushedEntryId(mark.operationId), at: deps.now().toISOString(), taskId: mark.taskId, usage: { provider: UNFLUSHED_ESTIMATE_PROVIDER, modelId: "unavailable", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }, { status: "awaiting_usage" });
        if (companyOfReservation(reservationId) === deps.companyId) await closeHold(deps.store, reservationId, { kind: "release" }, deps.now);
        return;
      }
      const ours = companyOfReservation(reservationId) === deps.companyId;
      const room = ours ? await openHoldRoom(deps.store, reservationId) : 0;
      if (ours) await closeHold(deps.store, reservationId, { kind: "settle", actualMicros: undefined, estimated: { operationId: mark.operationId } }, deps.now);
      // Keep an estimated marker even when the hold covered all of it: the task total must
      // not look exact simply because no additional dollars needed booking.
      const rest = Math.max(0, unflushedEstimateMicros(deps.settings) - room);
      await estimates.recordUsage({
        companyId: deps.companyId, entryId: unflushedEntryId(mark.operationId), at: deps.now().toISOString(), taskId: mark.taskId,
        usage: { provider: UNFLUSHED_ESTIMATE_PROVIDER, modelId: "estimate", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        reportedCost: { micros: rest, currency: "USD" },
      }, { status: "estimated" });
    },
  };
}

/** Whether the queue cancel path's fast relay (lane L9, the State table stream to the outbox relay) is deployed: the infra sets this variable to `on` with it. */
export const CORE_OUTBOX_STREAM_RELAY_VARIABLE = "ROVARA_CORE_OUTBOX_STREAM_RELAY";
/**
 * Whether the per-run stop is wired on this function: the queue cancel path is (this code), so it is the fast relay that decides. Until L9 lands this is false, so `automation.run` stays
 * refused (`run_stop_not_wired`); Stop and close still keep the whole hold as estimated spend when the worker's end is late (over-counts, never under).
 */
export function runStopWiredFrom(env: NodeJS.ProcessEnv): boolean {
  return env[CORE_OUTBOX_STREAM_RELAY_VARIABLE]?.trim() === "on";
}

/** The most of a task's runs `runsOwed` reads the ledger for; a task with more unfinished or failed runs is taken as owing. */
const OWED_RUNS_MAX = 50;

/**
 * Whether a run of the task may have spent without its usage being booked: a model run (any step but the checks) that did not succeed and has no booked usage entry. Its worker reports
 * usage only at the end of a run, so a run stopped, closed, lost or still going has none yet. Anything that cannot be read is taken as owing.
 */
export async function runsOwed(store: DocumentStore, companyId: string, taskId: string): Promise<boolean> {
  try {
    const task = await readTask({ store }, taskId);
    if (task === undefined) return false;
    if (task.companyId !== companyId) return true;
    const runs = (await workspaceOperations({ store, companyId }, task.workspaceId))
      .filter((operation) => operation.kind === "task" && operation.workflowMode !== "CHECKS" && operation.status !== "SUCCEEDED");
    if (runs.length > OWED_RUNS_MAX) return true;
    for (const run of runs) {
      // A run whose usage never arrived (`usageUnflushed`) is booked only by its estimate; any other by an end report or an estimate (a checkpoint is not an end: `usage-checkpoint:`).
      if (run.usageUnflushed === true) {
        if (await store.get({ pk: costPartition(companyId, taskId), sk: `ENTRY#${unflushedEntryId(run.id)}` }) === undefined) return true;
        continue;
      }
      const booked = await store.query({ pk: costPartition(companyId, taskId), sk: { op: "beginsWith", prefix: `ENTRY#usage:${run.id}:` }, limit: 1 });
      if (booked.items.length === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Gives a hold back, except a task's own hold while a run of the task may have spent without its usage booked (`runsOwed`): that one is settled with the actual unknown, so it keeps what it
 * still holds (never $0 for a run whose spend was not reported).
 */
export async function releaseOrKeep(store: DocumentStore, reservationId: unknown, now: () => Date): Promise<void> {
  const held = await holdStateOf(store, reservationId);
  if (held === undefined || held.state !== "open") return;
  const keep = held.taskId !== undefined && await runsOwed(store, held.companyId, held.taskId);
  await closeHold(store, reservationId, keep ? { kind: "settle", actualMicros: undefined } : { kind: "release" }, now);
}

/** The admission's own sweep (the `admission-hold-sweep` job): gives back the company's holds that are past their time. */
export function createHostedHoldSweep(deps: { store: DocumentStore; companyId: OrgId; now: () => Date }): CoreService {
  return {
    async pass({ budgetMs }) {
      return await sweepExpiredHolds(deps.store, deps.companyId, { budgetMs, now: deps.now, close: (reservationId) => releaseOrKeep(deps.store, reservationId, deps.now) });
    },
  };
}

// ---- metering

/**
 * What a model no table prices is charged, per million tokens (USD micros): a cautious fixed price (a top-tier frontier model's list price; not the catalog's maximum). Never $0: an
 * unknown model is assumed expensive, so a cap holds back rather than letting it run free (DEC 172/216).
 */
export const UNKNOWN_MODEL_PRICE: ModelPrice = Object.freeze({
  inputMicrosPerMillionTokens: 15_000_000,
  outputMicrosPerMillionTokens: 75_000_000,
  cacheReadMicrosPerMillionTokens: 1_500_000,
  cacheWriteMicrosPerMillionTokens: 18_750_000,
});

/** The rate quote of a company's source for one model, or undefined (no reader, no quote: the table prices). */
export type HostedRateQuote = (companyId: string, model: string) => Promise<RateQuoteV1 | undefined>;

/** The usages a booking names that are no model's: an unreadable report and an estimate of a stopped run. They have no gateway rate. */
const isInternalUsage = (provider: string): boolean => provider.startsWith("rovara-") && provider !== "rovara-route";

/**
 * What a CAP or hold must assume for a Claude model served through the gateway: never below the geography profile (`us.`) row the gateway can settle at, and cache writes at the 1 hour rate (twice the input
 * rate), which the catalog's single write rate (5 minutes) leaves out. Only holds and caps read this, and only because no company is known there to read a source-bound quote for; it is never a floor on a booked
 * usage, so it cannot raise a figure the worker priced exactly (a company's own key, say).
 */
function gatewayCapPrice(model: { provider: string; modelId: string }, price: ModelPrice): ModelPrice {
  if (!/claude/iu.test(model.modelId) || (model.provider !== "anthropic" && model.provider !== "amazon-bedrock")) return price;
  const profile = model.provider === "anthropic" ? bedrockProfileListPrice(model) : undefined;
  const input = Math.max(price.inputMicrosPerMillionTokens, profile === undefined ? 0 : Math.round(profile.input * 1_000_000));
  const read = price.cacheReadMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens;
  const write = price.cacheWriteMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens;
  return {
    inputMicrosPerMillionTokens: input,
    outputMicrosPerMillionTokens: Math.max(price.outputMicrosPerMillionTokens, profile === undefined ? 0 : Math.round(profile.output * 1_000_000)),
    cacheReadMicrosPerMillionTokens: Math.max(read, profile === undefined ? 0 : Math.round(profile.cacheRead * 1_000_000)),
    cacheWriteMicrosPerMillionTokens: Math.max(write, profile === undefined ? 0 : Math.round(profile.cacheWrite * 1_000_000), input * 2),
  };
}

/**
 * The staging meter: the catalog's prices; an unknown model at `UNKNOWN_MODEL_PRICE`. Stateless: the ledger counts each usage once.
 * Task cost truth: a booked usage is priced at the SOURCE-BOUND rate quote of the gateway when one can be read (`options.rateQuote`: the rates the gateway settles it at, with its bands and cache-write rates), else
 * at the table; the worker's own figure still wins when it is higher. Holds and caps (`price`) assume the dearer geography row (`gatewayCapPrice`).
 */
export function createHostedMetering(prices: ModelPrices = createModelPrices({ providers: () => [], catalog: listPricesPerMillion }), options: { rateQuote?: HostedRateQuote | undefined } = {}): Metering {
  const cautious = (usage: ModelUsage): Cost => ({ micros: costMicrosOf(UNKNOWN_MODEL_PRICE, usage.tokens), currency: "USD" });
  return {
    async price(usage) {
      const found = prices.findCap({ provider: usage.provider, modelId: usage.modelId });
      return found === undefined ? cautious(usage) : { micros: costMicrosOf(found.currency === "USD" ? gatewayCapPrice(usage, found.price) : found.price, usage.tokens), currency: found.currency };
    },
    async record(entry) {
      const found = prices.find({ provider: entry.usage.provider, modelId: entry.usage.modelId });
      const quote = options.rateQuote === undefined || isInternalUsage(entry.usage.provider) ? undefined : await options.rateQuote(entry.companyId, entry.usage.modelId).catch(() => undefined);
      const calls = (entry as { runUsageCalls?: readonly RunUsageCallV1[] }).runUsageCalls?.flatMap((call) => call.usage.state === "available" ? [{ input: call.usage.value.input, output: call.usage.value.output, cacheRead: call.usage.value.cacheRead, cacheWrite: call.usage.value.cacheWrite5m + call.usage.value.cacheWrite1h + call.usage.value.cacheWriteUnknown }] : []);
      const table: MeterResult = quote !== undefined ? { cost: { micros: rateQuoteUsageMicros(quote, entry.usage.tokens, calls), currency: "USD" }, source: "price-table" }
        : found === undefined ? { cost: cautious(entry.usage), source: "unknown" } : { cost: { micros: costMicrosOf(found.price, entry.usage.tokens), currency: found.currency }, source: "price-table" };
      // The provider's own figure is charged when it is the higher dollar amount: a price table that is behind never makes the cost smaller than what was billed.
      const reported = entry.reportedCost;
      const readable = reported !== undefined && reported !== null && reported.currency === "USD" && Number.isSafeInteger(reported.micros) && reported.micros >= 0;
      return readable && table.cost?.currency === "USD" && reported.micros > table.cost.micros ? { cost: { micros: reported.micros, currency: "USD" }, source: "provider-reported" } : table;
    },
  };
}

// ---- identity

/** What membership says about a person (R4's reader): their company and live role. Undefined: not a member of any company. */
export type MembershipOf = (personId: string) => Promise<{ companyId: string; role: OrgRole } | undefined>;

export interface HostedIdentityOptions {
  membershipOf: MembershipOf;
  /** The person's display name (the sign-in record). Undefined: the person is not known. */
  displayNameOf: (personId: string) => Promise<string | undefined>;
  /**
   * L4-GH: the GitHub accounts members linked to themselves (core/people/github-links.ts). With it, the identity point links code host accounts to people (`externalAccounts`): it resolves
   * `{ provider: "github", tenant: "" }` accounts under the asking company and a person's own account (`accountsOf`). Absent: it links none (as before).
   */
  githubLinks?: GithubLinkReader;
}

/** The deployed identity point: names a member of a company; authenticates nothing (Code's sign-in does). */
export function createHostedIdentity(options: HostedIdentityOptions): IdentityProvider {
  const links = options.githubLinks;
  async function getPrincipal(companyId: string, personId: string): Promise<Principal | undefined> {
    if (typeof personId !== "string" || personId === "" || !OrgIdSchema.safeParse(companyId).success) return undefined;
    const membership = await options.membershipOf(personId);
    if (membership === undefined || membership.companyId !== companyId || !OrgRoleSchema.safeParse(membership.role).success) return undefined;
    const displayName = await options.displayNameOf(personId);
    if (displayName === undefined) return undefined;
    return { companyId, personId, displayName, roles: [membership.role], provider: HOSTED_IDENTITY_PROVIDER };
  }
  return {
    capabilities: { interactiveSignIn: false, externalAccounts: links !== undefined },
    async authenticate() {
      return { ok: false, reason: "refused" };
    },
    // L4-GH: a GitHub account is a member only through a link row under THIS company, and the person is then read live in this company (a removed member, or one now in another company, is nobody).
    async resolveExternalAccount(companyId, account) {
      if (links === undefined || account.provider !== GITHUB_LINK_PROVIDER || account.tenant !== "") return undefined;
      const company = OrgIdSchema.safeParse(companyId);
      if (!company.success) return undefined;
      const personId = await links.personOf(company.data, account.accountId);
      if (personId === undefined) return undefined;
      const person = await getPrincipal(company.data, personId);
      return person !== undefined && person.companyId === company.data && person.personId === personId ? person : undefined;
    },
    getPrincipal,
    ...(links === undefined ? {} : {
      async accountsOf(companyId: string, personId: string) {
        const company = OrgIdSchema.safeParse(companyId);
        if (!company.success || await getPrincipal(company.data, personId) === undefined) return [];
        const accountId = await links.accountOf(company.data, personId);
        return accountId === undefined ? [] : [{ provider: GITHUB_LINK_PROVIDER, tenant: "", accountId }];
      },
    }),
  };
}

// ---- the modules

export interface HostedSecurityInputs {
  env: NodeJS.ProcessEnv;
  identity: HostedIdentityOptions;
  /** The meter's prices (tests). Absent: the catalog's. */
  prices?: ModelPrices;
  /** The gateway's rate quote for a company's source and model (task cost truth): the booking floor of a hosted usage. Absent: the table prices. */
  rateQuote?: HostedRateQuote | undefined;
  /** The install's callback signing key, from which the approval proof key is derived (the broker). Absent: the approvers point refuses every proof (the dispatcher). */
  callbackSigningKey?: string;
  /** The root wires the per-run stop (see `HostedAdmissionOptions.runStopWired`). */
  runStopWired?: boolean;
  /**
   * Who may decide a core task as its owner (web task channel C6): the deployment's live owner rule (the task's own person, or a People co-owner, each under the live proof) over this company's own
   * store. Absent: only the task's own person (the dispatcher decides nothing for a person).
   */
  taskOwner?: (input: { companyId: OrgId; store: DocumentStore; principal: Principal; task: { taskId: string; developerId: string; project: string } }) => Promise<boolean>;
  /** L2-5 (b): the project's own per-task limit (see `HostedAdmissionOptions.projectTaskCap`). */
  projectTaskCap?: ProjectTaskCap | undefined;
  /** HW5b: the chat a press may approve a low or medium risk plan in (see `HostedChatApproval`). Absent (the dispatcher): the approvers point takes the page's proof alone. */
  chat?: HostedChatApproval | undefined;
}

/**
 * The step 5 modules, in build order (metering before admission, which reads the ledger over the registry's store and meter). The admission module refuses to build without an allow-list,
 * so the whole registry is refused (the switch then serves nothing) rather than run with every company let in.
 */
export function hostedSecurityModules(inputs: HostedSecurityInputs): CoreAdapterModule[] {
  return [
    coreAdapter({ point: "metering", name: "hosted-price-table", owner: OWNER, create: () => createHostedMetering(inputs.prices, { rateQuote: inputs.rateQuote }) }),
    coreAdapter({
      point: "admission", name: "hosted-allow-list", owner: OWNER,
      create: (context, registry) => {
        const read = readHostedAdmissionSettings(inputs.env);
        if ("problem" in read) throw new Error(`the core engine's admission cannot be built: ${read.problem}`);
        const store = registry.require("storage");
        const ledger = createHostedLedger({ store, metering: registry.require("metering"), now: context.now });
        return createHostedAdmission({ settings: read.settings, store, ledger, now: context.now, ...(inputs.runStopWired === true ? { runStopWired: true } : {}), ...(inputs.projectTaskCap === undefined ? {} : { projectTaskCap: inputs.projectTaskCap }) });
      },
    }),
    coreAdapter({ point: "identity", name: HOSTED_IDENTITY_PROVIDER, owner: OWNER, create: (_context, registry) => createHostedIdentity({ ...inputs.identity, githubLinks: githubLinkReaderOver(registry.require("storage")) }) }),
    coreAdapter({
      point: "approvers", name: "hosted-step-up", owner: "switch-on lane L2a",
      create: (context, registry) => createHostedApprovers({
        store: registry.require("storage"), identity: registry.require("identity"), now: context.now,
        ...(inputs.callbackSigningKey === undefined ? {} : { key: approvalProofKeyOf(inputs.callbackSigningKey) }),
        ...(inputs.taskOwner === undefined ? {} : { taskOwner: (asked: { companyId: OrgId; principal: Principal; task: { taskId: string; developerId: string; project: string } }) => inputs.taskOwner!({ ...asked, store: registry.require("storage") }) }),
        ...(inputs.chat === undefined ? {} : { chat: inputs.chat }),
      }),
    }),
    coreAdapter({
      point: "audit-sink", name: "document", owner: OWNER,
      create: (context, registry) => auditSinkPlugin.create({ defaultCompanyId: context.installCompanyId, settings: {}, registry: registry, now: context.now }),
    }),
  ];
}

/** Lane L2b (DEC 236): the model-keys point (the keys live in the model gateway), for the dispatcher's `extraModules` next to the step 5 points. */
export { gatewayModelKeysModules } from "./gateway-model-access.js";
