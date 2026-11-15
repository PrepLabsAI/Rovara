// The actual cost of a task (lane L6b, inventory B9): what the model calls it made cost, from the Metering seam. Code prices tokens times a price table (Cloud reads the proxy keys' spend); the ledger is the
// part both need: it records each usage once, keeps the task's running total, and says plainly when a call could not be priced. It decides nothing: no limit, no pause. Whether a run may go on is the Admission seam's.
//
// Layout, in the task's own company-scoped partition:
//   `ORG#<c>#COST#<taskId>` / `ENTRY#<entryId>`   one per recorded usage (tokens, the cost the adapter charged, or no cost); written once, so a usage told twice counts once whatever the adapter does
//   `ORG#<c>#COST#<taskId>` / `TOTAL`             the running total, changed in the same transaction as the entry that changed it
//   `ORG#<c>#COST_DAY` / `DAY#<yyyy-mm-dd>`        the company's spend on one UTC day (the day the usage was recorded), changed in the same transaction: dollars in `usdMicros`, and a count of
//                                                  the entries it could not add (`uncountedEntries`: no price, or another currency), so a reader holding a daily cap knows the figure is a floor
import { INDEX_EXPIRY_ATTRIBUTE, companyScoped, when, type Cost, type DocumentStore, type MeterEntry, type MeterResult, type Metering, type ModelUsage, type StoredDocument } from "@agentx/contracts";

const ENTRY_KEPT_SECONDS = 400 * 86_400;

export interface TaskCost {
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

export interface CostLedger {
  /** Records one usage. Telling it again (the same `entryId` for the same company, under any task) records nothing more and answers the first answer. */
  recordUsage(entry: MeterEntry): Promise<MeterResult & { counted: boolean }>;
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

export function createCostLedger(deps: { store: DocumentStore; metering: Metering; now?: () => Date }): CostLedger {
  const now = deps.now ?? (() => new Date());

  async function recordUsage(entry: MeterEntry, attempt = 0): Promise<MeterResult & { counted: boolean }> {
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
    const at = now();
    const total = await deps.store.get({ pk: partition, sk: "TOTAL" });
    const currency = typeof total?.["currency"] === "string" ? total["currency"] : undefined;
    // One currency per task: a usage in another one is kept as an entry but cannot be added to the total, and counts as unpriced there.
    const adds = result.cost !== null && (currency === undefined || currency === result.cost.currency);
    const entryDoc: StoredDocument = {
      ...entryKey, entityType: "COST_ENTRY", companyId: entry.companyId, taskId: entry.taskId, entryId: entry.entryId, at: entry.at, provider: entry.usage.provider, modelId: entry.usage.modelId,
      tokensInput: tokens.input, tokensOutput: tokens.output, tokensCacheRead: tokens.cacheRead, tokensCacheWrite: tokens.cacheWrite, source: result.source,
      ...(result.cost === null ? {} : { micros: result.cost.micros, currency: result.cost.currency }), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at.getTime() / 1000) + ENTRY_KEPT_SECONDS,
    };
    const committed = await deps.store.transact([
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
          { op: "add", path: ["entries"], amount: 1 }, { op: "add", path: ["unpricedEntries"], amount: adds ? 0 : 1 }, { op: "set", path: ["updatedAt"], value: at.toISOString() },
        ],
        // The total's currency was read above: the update holds only while it is still what that read saw.
        condition: currency === undefined ? when.notExists("currency") : when.eq("currency", currency),
      },
      // The company's day: only a dollar cost is added; any other usage is counted as one the figure leaves out. Written with no expiry, like the total.
      {
        kind: "update", key: companyDayKey(entry.companyId, utcDayOf(at)),
        ops: [
          { op: "setIfAbsent", path: ["entityType"], value: "COST_DAY" }, { op: "setIfAbsent", path: ["companyId"], value: entry.companyId }, { op: "setIfAbsent", path: ["day"], value: utcDayOf(at) },
          { op: "add", path: ["usdMicros"], amount: result.cost !== null && result.cost.currency === "USD" ? result.cost.micros : 0 },
          { op: "add", path: ["entries"], amount: 1 }, { op: "add", path: ["uncountedEntries"], amount: result.cost !== null && result.cost.currency === "USD" ? 0 : 1 },
        ],
      },
    ]);
    if (committed.applied) return { ...result, counted: true };
    // Lost to the same usage told at the same time (its entry is there now), or to the first usage that fixed the currency: tell the first case as already counted, and ask again for the second.
    if (await deps.store.get(onceKey) !== undefined) return { ...result, counted: false };
    if (attempt >= 3) throw new Error("the cost of this usage could not be recorded");
    return recordUsage(entry, attempt + 1);
  }

  return {
    price: (usage) => deps.metering.price(usage),
    recordUsage: (entry) => recordUsage(entry),
    async companyDayCost(companyId, day) {
      const row = await deps.store.get(companyDayKey(companyId, day));
      const number = (name: string): number => (row !== undefined && typeof row[name] === "number" && natural(row[name]) ? row[name] : 0);
      // A row whose figures do not read is no figure: every entry of it is counted as left out, so a cap reader holds back.
      const readable = row === undefined || ["usdMicros", "entries", "uncountedEntries"].every((name) => typeof row[name] === "number" && natural(row[name] as number));
      return readable ? { day, usdMicros: number("usdMicros"), entries: number("entries"), uncountedEntries: number("uncountedEntries") } : { day, usdMicros: number("usdMicros"), entries: 1, uncountedEntries: 1 };
    },
    async taskCost(companyId, taskId) {
      const total = await deps.store.get({ pk: costPartition(companyId, taskId), sk: "TOTAL" });
      if (total === undefined) return emptyCost(taskId);
      const number = (name: string): number => (typeof total[name] === "number" ? total[name] : 0);
      return {
        taskId, currency: typeof total["currency"] === "string" ? total["currency"] : undefined, micros: number("micros"),
        tokens: { input: number("tokensInput"), output: number("tokensOutput"), cacheRead: number("tokensCacheRead"), cacheWrite: number("tokensCacheWrite") },
        entries: number("entries"), unpricedEntries: number("unpricedEntries"), ...(typeof total["updatedAt"] === "string" ? { updatedAt: total["updatedAt"] } : {}),
      };
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
