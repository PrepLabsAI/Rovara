// The actual cost of a task (lane L6b, inventory B9): what the model calls it made cost, from the Metering seam. Code prices tokens times a price table (Cloud reads the proxy keys' spend); the ledger is the
// part both need: it records each usage once, keeps the task's running total, and says plainly when a call could not be priced. It decides nothing: no limit, no pause. Whether a run may go on is the Admission seam's.
//
// Layout, in the task's own company-scoped partition:
//   `ORG#<c>#COST#<taskId>` / `ENTRY#<entryId>`   one per recorded usage (tokens, the cost the adapter charged, or no cost); written once, so a usage told twice counts once whatever the adapter does
//   `ORG#<c>#COST#<taskId>` / `TOTAL`             the running total, changed in the same transaction as the entry that changed it
//   `ORG#<c>#COST_DAY` / `DAY#<yyyy-mm-dd>`        the company's spend on one UTC day (the day the usage was recorded), changed in the same transaction: dollars in `usdMicros`, and a count of
//                                                  the entries it could not add (`uncountedEntries`: no price, or another currency), so a reader holding a daily cap knows the figure is a floor
import { INDEX_EXPIRY_ATTRIBUTE, companyScoped, when, type ApplyChargeResult, type Cost, type DocumentStore, type MeterEntry, type MeterResult, type Metering, type ModelUsage, type StoredDocument, type TransactItem, type UpdateOp } from "@agentx/contracts";

import { applyChargeReceipt } from "./charge-ledger.js";

const ENTRY_KEPT_SECONDS = 400 * 86_400;

export interface TaskCost {
  /** Receipt-aware coverage; absent on historical rows (legacy_unknown). */
  chargeRevision?: number;
  provisionalCalls?: number;
  legacyUnknownEntries?: number;
  taskId: string;
  currency: string | undefined;
  /** The priced part, in millionths of the currency. */
  micros: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** How many usages were recorded, and how many of them no price covers (an unknown model): the total is then a floor, and the figure says so. */
  entries: number;
  unpricedEntries: number;
  updatedAt?: string;
}

/** Explicit provisional accounting for engine fallbacks and calls with no recoverable usage. */
export interface UsageAccounting {
  status: "estimated" | "awaiting_usage";
  /** One unpriced entry can carry several missing calls from a session. */
  missingCalls?: number;
}

export interface CostLedger {
  /** Applies an authenticated charge receipt, replacing the earlier revision atomically. */
  applyChargeReceipt(receipt: unknown): Promise<ApplyChargeResult>;
  /** Records one usage. Telling it again (the same `entryId` for the same company, under any task) records nothing more and answers the first answer. */
  recordUsage(entry: MeterEntry, accounting?: UsageAccounting): Promise<MeterResult & { counted: boolean }>;
  /** The task's total so far (zero when nothing was recorded). */
  taskCost(companyId: string, taskId: string): Promise<TaskCost>;
  /** What this usage would cost, without recording it. */
  price(usage: ModelUsage): Promise<Cost | null>;
  /** The company's spend on one UTC day (`yyyy-mm-dd`), as recorded through this ledger (zero when nothing was). */
  companyDayCost(companyId: string, day: string): Promise<CompanyDayCost>;
}

/** The company's spend on one UTC day. `uncountedEntries` above zero: some usage that day has no dollar figure, so `usdMicros` is a floor. */
export interface CompanyDayCost {
  day: string;
  usdMicros: number;
  entries: number;
  uncountedEntries: number;
}

/**
 * Spend holds (core/cost/holds.ts), on an install whose admission holds part of a company's day for work it admitted (a deployed install; the laptop keeps none). With them, every booked
 * dollar is also added to the day row's `loadMicros` (what a cap reads), and a task's booked dollars are drawn down from the task's own open hold, so the day counts them once.
 */
export interface LedgerHolds {
  /** The steps that draw `usdMicros` of the task's booked usage from its open hold, and how much they take off which day's holds. No hold, or nothing left in it: no steps. */
  drawdown(input: { companyId: string; taskId: string; total: StoredDocument | undefined; usdMicros: number }): Promise<{ items: TransactItem[]; day?: { day: string; micros: number } }>;
}

/** The UTC day of a time, as the company-day row names it. */
export const utcDayOf = (at: Date): string => at.toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
export const companyDayKey = (companyId: string, day: string): { pk: string; sk: string } => {
  if (!DAY.test(day)) throw new Error("a day is yyyy-mm-dd");
  return { pk: companyScoped(companyId, "COST_DAY"), sk: `DAY#${day}` };
};

export const costPartition = (companyId: string, taskId: string): string => companyScoped(companyId, `COST#${taskId}`);

function emptyCost(taskId: string): TaskCost {
  return { taskId, currency: undefined, micros: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, entries: 0, unpricedEntries: 0 };
}

const natural = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export function createCostLedger(deps: { store: DocumentStore; metering: Metering; now?: () => Date; holds?: LedgerHolds }): CostLedger {
  const now = deps.now ?? (() => new Date());

  async function recordUsage(entry: MeterEntry, accounting?: UsageAccounting, attempt = 0): Promise<MeterResult & { counted: boolean }> {
    const calls = accounting?.missingCalls ?? 1;
    if (!natural(calls) || calls < 1 || (accounting?.missingCalls !== undefined && accounting.status !== "awaiting_usage")) throw new Error("invalid provisional usage");
    const tokens = entry.usage.tokens;
    if (entry.taskId === undefined || ![tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite].every(natural)) throw new Error("a usage names its task and counts its tokens in whole numbers");
    const partition = costPartition(entry.companyId, entry.taskId);
    const entryKey = { pk: partition, sk: `ENTRY#${entry.entryId}` };
    // One usage is one usage in the company: told again under another task it is still counted once.
    const onceKey = { pk: companyScoped(entry.companyId, "COST_ENTRY"), sk: entry.entryId };
    const earlier = await deps.store.get(onceKey);
    if (earlier !== undefined) {
      const cost = typeof earlier["micros"] === "number" && typeof earlier["currency"] === "string" ? { micros: earlier["micros"], currency: earlier["currency"] } : null;
      return { cost, source: earlier["source"] === "price-table" || earlier["source"] === "provider-reported" ? earlier["source"] : "unknown", counted: false };
    }
    // The adapter prices it (and may remember the entry itself); the ledger keeps the answer.
    const result = await deps.metering.record(entry);
    if (result.cost !== null && (!natural(result.cost.micros) || result.cost.currency === "")) throw new Error("the metering adapter answered a cost that is not a whole amount");
    if (accounting?.status === "awaiting_usage" && result.cost !== null) throw new Error("missing usage has no dollar amount");
    const at = now();
    const total = await deps.store.get({ pk: partition, sk: "TOTAL" });
    const currency = typeof total?.["currency"] === "string" ? total["currency"] : undefined;
    // One currency per task: a usage in another one is kept as an entry but cannot be added to the total, and counts as unpriced there.
    const adds = result.cost !== null && (currency === undefined || currency === result.cost.currency);
    const entryDoc: StoredDocument = {
      ...entryKey, entityType: "COST_ENTRY", companyId: entry.companyId, taskId: entry.taskId, entryId: entry.entryId, at: entry.at, provider: entry.usage.provider, modelId: entry.usage.modelId,
      tokensInput: tokens.input, tokensOutput: tokens.output, tokensCacheRead: tokens.cacheRead, tokensCacheWrite: tokens.cacheWrite, source: result.source, chargeStatus: accounting?.status ?? "estimated", reason: accounting?.status === "awaiting_usage" ? "missing_usage" : "legacy_unknown",
      ...(accounting?.missingCalls === undefined ? {} : { usageMissingCalls: accounting.missingCalls }),
      ...(result.cost === null ? {} : { micros: result.cost.micros, currency: result.cost.currency }), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at.getTime() / 1000) + ENTRY_KEPT_SECONDS,
    };
    const usdMicros = result.cost !== null && result.cost.currency === "USD" ? result.cost.micros : 0;
    const today = utcDayOf(at);
    // With holds: the booked dollars join the day's load, less what they draw from the task's own hold (that part was on the load already). Without: the row is written as it always was.
    const drawn = deps.holds === undefined ? undefined : await deps.holds.drawdown({ companyId: entry.companyId, taskId: entry.taskId, total, usdMicros });
    const drawnToday = drawn?.day !== undefined && drawn.day.day === today ? drawn.day.micros : 0;
    const loadOps: UpdateOp[] = drawn === undefined ? [] : [
      { op: "add", path: ["loadMicros"], amount: usdMicros - drawnToday },
      ...(drawnToday > 0 ? [{ op: "add" as const, path: ["reservedMicros"] as const, amount: -drawnToday }] : []),
    ];
    const otherDay: TransactItem[] = drawn?.day !== undefined && drawn.day.day !== today && drawn.day.micros > 0
      ? [{ kind: "update", key: companyDayKey(entry.companyId, drawn.day.day), ops: [{ op: "add", path: ["reservedMicros"], amount: -drawn.day.micros }, { op: "add", path: ["loadMicros"], amount: -drawn.day.micros }], condition: when.present() }]
      : [];
    const committed = await deps.store.transact([
      ...(drawn?.items ?? []),
      ...otherDay,
      { kind: "put", item: entryDoc, condition: when.absent() },
      { kind: "put", item: { ...onceKey, entityType: "COST_ENTRY_ONCE", taskId: entry.taskId, source: result.source, ...(result.cost === null ? {} : { micros: result.cost.micros, currency: result.cost.currency }), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at.getTime() / 1000) + ENTRY_KEPT_SECONDS }, condition: when.absent() },
      {
        kind: "update", key: { pk: partition, sk: "TOTAL" },
        ops: [
          { op: "setIfAbsent", path: ["entityType"], value: "COST_TOTAL" }, { op: "setIfAbsent", path: ["taskId"], value: entry.taskId }, { op: "setIfAbsent", path: ["companyId"], value: entry.companyId },
          ...(adds && currency === undefined ? [{ op: "set" as const, path: ["currency"] as const, value: result.cost!.currency }] : []),
          { op: "add", path: ["micros"], amount: adds ? result.cost!.micros : 0 },
          { op: "add", path: ["tokensInput"], amount: tokens.input }, { op: "add", path: ["tokensOutput"], amount: tokens.output },
          { op: "add", path: ["tokensCacheRead"], amount: tokens.cacheRead }, { op: "add", path: ["tokensCacheWrite"], amount: tokens.cacheWrite },
          { op: "add", path: ["revision"], amount: 1 }, { op: "add", path: ["entries"], amount: calls }, { op: "add", path: ["unpricedEntries"], amount: adds ? 0 : calls },
          ...(accounting === undefined ? [] : [{ op: "add" as const, path: ["provisionalCalls"] as const, amount: calls }]), { op: "set", path: ["updatedAt"], value: at.toISOString() },
        ],
        // The total's currency was read above: the update holds only while it is still what that read saw.
        condition: currency === undefined ? when.notExists("currency") : when.eq("currency", currency),
      },
      // The company's day: only a dollar cost is added; any other usage is counted as one the figure leaves out. Written with no expiry, like the total.
      {
        kind: "update", key: companyDayKey(entry.companyId, today),
        ops: [
          { op: "setIfAbsent", path: ["entityType"], value: "COST_DAY" }, { op: "setIfAbsent", path: ["companyId"], value: entry.companyId }, { op: "setIfAbsent", path: ["day"], value: today },
          { op: "add", path: ["usdMicros"], amount: usdMicros },
          { op: "add", path: ["entries"], amount: calls }, { op: "add", path: ["uncountedEntries"], amount: result.cost !== null && result.cost.currency === "USD" ? 0 : calls },
          ...loadOps,
        ],
      },
    ]);
    if (committed.applied) return { ...result, counted: true };
    // Lost to the same usage told at the same time (its entry is there now), to the first usage that fixed the currency, or to another booking that drew the same hold: tell the first case as
    // already counted, and ask again for the others.
    if (await deps.store.get(onceKey) !== undefined) return { ...result, counted: false };
    if (attempt >= 3) throw new Error("the cost of this usage could not be recorded");
    return recordUsage(entry, accounting, attempt + 1);
  }

  return {
    applyChargeReceipt: (receipt) => applyChargeReceipt(deps, receipt),
    price: (usage) => deps.metering.price(usage),
    recordUsage: (entry, accounting) => recordUsage(entry, accounting),
    async companyDayCost(companyId, day) {
      const row = await deps.store.get(companyDayKey(companyId, day));
      const number = (name: string): number => (row !== undefined && typeof row[name] === "number" && natural(row[name]) ? row[name] : 0);
      // A row whose figures do not read is no figure: every entry of it is counted as left out, so a cap reader holds back.
      const readable = row === undefined || ["usdMicros", "entries", "uncountedEntries"].every((name) => typeof row[name] === "number" && natural(row[name]));
      return readable ? { day, usdMicros: number("usdMicros"), entries: number("entries"), uncountedEntries: number("uncountedEntries") } : { day, usdMicros: number("usdMicros"), entries: 1, uncountedEntries: 1 };
    },
    async taskCost(companyId, taskId) {
      return taskCostFromTotal(taskId, await deps.store.get({ pk: costPartition(companyId, taskId), sk: "TOTAL" }));
    },
  };
}

/** The total as dollars when it is in dollars; undefined for another currency (a surface then shows the currency, not a wrong "$"). */
export function costUsdOf(cost: Pick<TaskCost, "micros" | "currency">): number | undefined {
  if (cost.currency !== undefined && cost.currency !== "USD") return undefined;
  return cost.micros / 1_000_000;
}

/** A cost as a person reads it: "$1.23", or "$1.23 so far, N calls not priced" when some call has no price. */
export function costLine(cost: TaskCost): string {
  const usd = costUsdOf(cost);
  const amount = usd === undefined ? `${(cost.micros / 1_000_000).toFixed(2)} ${cost.currency ?? ""}`.trim() : `$${usd.toFixed(2)}`;
  if (cost.unpricedEntries === 0) return amount;
  return `${amount} so far, ${String(cost.unpricedEntries)} ${cost.unpricedEntries === 1 ? "call" : "calls"} not priced`;
}

/** A task's cost from its stored `TOTAL` row (zero when there is none). The one reading of that row: the ledger's own `taskCost` and the cost report both use it. */
export function taskCostFromTotal(taskId: string, total: StoredDocument | undefined): TaskCost {
  if (total === undefined) return emptyCost(taskId);
  const number = (name: string): number => (typeof total[name] === "number" ? total[name] : 0);
  return {
    ...(typeof total["chargeEntries"] === "number" ? { chargeRevision: number("revision"), provisionalCalls: number("provisionalCalls"), legacyUnknownEntries: Math.max(0, number("entries") - number("chargeEntries")) } : {}),
    ...(typeof total["provisionalCalls"] === "number" ? { provisionalCalls: number("provisionalCalls") } : {}),
    taskId, currency: typeof total["currency"] === "string" ? total["currency"] : undefined, micros: number("micros"),
    tokens: { input: number("tokensInput"), output: number("tokensOutput"), cacheRead: number("tokensCacheRead"), cacheWrite: number("tokensCacheWrite") },
    entries: number("entries"), unpricedEntries: number("unpricedEntries"), ...(typeof total["updatedAt"] === "string" ? { updatedAt: total["updatedAt"] } : {}),
  };
}

export { readTaskMoney } from "./task-money.js";
