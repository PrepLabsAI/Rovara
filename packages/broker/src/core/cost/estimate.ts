// What a run is expected to cost, from the cost of the runs before it (lane L6b, inventory B9). The estimate is the read-only half of the hosted product's spend module: it reads the history of finished
// runs and returns a range and the limit that follows. Budgets, approval thresholds, top-ups and payers stay in Cloud (decision 41); in Code the allowance is the Admission seam's.
//
// `estimateRun` reads the newest `ESTIMATE_HISTORY_SIZE` costs of runs of one project, agent and path (`RUN_COST` items, written by `recordRunCost` when a run merged or finished). With
// `ESTIMATE_MIN_SAMPLES` of them the range is their p50 and p80 by nearest rank, each rounded up to fifty cents; with fewer it is the default for the path. The run limit is the high end times the
// multiplier (`RUN_LIMIT_MULTIPLIER`, the hosted product's company setting is a plain option here), never more than `MAX_RUN_LIMIT_USD`.
import {
  DEFAULT_RUN_ESTIMATE_USD, ESTIMATE_HISTORY_SIZE, ESTIMATE_MIN_SAMPLES, INDEX_EXPIRY_ATTRIBUTE, MAX_RUN_LIMIT_USD, ROVARA_CODE_AGENT_ID, RUN_LIMIT_MULTIPLIER, runCostKey, when,
  type AgentId, type DocumentStore, type OrgId, type RunEstimate, type TransactItem,
} from "@agentx/contracts";

/** The kinds of run an estimate is kept for: a workflow task by its path, a task with no workflow, and an agent-step run. */
export type EstimatePath = "QUICK" | "FULL" | "TASK" | "AGENT";

const HALF_DOLLAR = 0.5;

/** An amount of dollars with float noise taken off (1.5000000000000002 is 1.5). */
export const cleanUsd = (value: number): number => Math.round(value * 1e6) / 1e6;

/** `value` rounded up to the next fifty cents, and never less than fifty cents (a run is never expected to cost nothing). */
const roundUpToHalf = (value: number): number => Math.max(HALF_DOLLAR, Math.ceil(cleanUsd(value) * 2) / 2);

/** The `percent`th percentile by nearest rank: the `ceil(percent × n / 100)`-th smallest. Whole percents keep the product exact. */
function nearestRank(sorted: readonly number[], percent: number): number {
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((percent * sorted.length) / 100)));
  return sorted[rank - 1]!;
}

const isCost = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export interface EstimateDependencies {
  store: Pick<DocumentStore, "query">;
  /** The run limit is the high end times this. Default `RUN_LIMIT_MULTIPLIER`. */
  runLimitMultiplier?: number;
}

export interface EstimateRunInput {
  orgId: OrgId;
  project: string;
  agentId: AgentId;
  path: EstimatePath;
  /** The agent's cap on one run; `stopAtUsd` is the smaller of it and the run limit. */
  maxPerRunUsd?: number;
}

/** The estimate of a run of this agent on this project. An unreadable history is an error, never a quieter default. */
export async function estimateRun(deps: EstimateDependencies, input: EstimateRunInput): Promise<RunEstimate> {
  const key = runCostKey(input.orgId, input.project, input.agentId, input.path, "2000-01-01T00:00:00.000Z", "-");
  const page = await deps.store.query({ pk: key.pk, descending: true, limit: ESTIMATE_HISTORY_SIZE });
  const costs = page.items.map((item) => item["costUsd"]).filter(isCost).slice(0, ESTIMATE_HISTORY_SIZE);
  const history = costs.length >= ESTIMATE_MIN_SAMPLES;
  const sorted = [...costs].sort((a, b) => a - b);
  const lowUsd = history ? roundUpToHalf(nearestRank(sorted, 50)) : DEFAULT_RUN_ESTIMATE_USD[input.path].lowUsd;
  const highUsd = history ? roundUpToHalf(nearestRank(sorted, 80)) : DEFAULT_RUN_ESTIMATE_USD[input.path].highUsd;
  const runLimitUsd = Math.min(MAX_RUN_LIMIT_USD, Math.ceil(cleanUsd(highUsd * (deps.runLimitMultiplier ?? RUN_LIMIT_MULTIPLIER))));
  return {
    lowUsd, highUsd, runLimitUsd,
    stopAtUsd: input.maxPerRunUsd === undefined ? runLimitUsd : Math.min(runLimitUsd, input.maxPerRunUsd),
    basis: history ? "history" : "default",
    samples: costs.length,
  };
}

/** The estimate path of a task: its workflow's, else a task with no workflow's. */
export const estimatePathOf = (task: { workflow?: { path?: string } | undefined }): EstimatePath => {
  const path = task.workflow?.path;
  return path === "QUICK" || path === "FULL" ? path : "TASK";
};

/**
 * The run limit a task's plan carries: its estimate (the task's own `runEstimate`, else one worked out now), which a start that asked for a lower limit may only lower. What a person may
 * accept (the hosted product's tiers) is not here: in Code the Admission seam decides whether a run may start.
 */
export async function planRunLimit(deps: EstimateDependencies, task: { orgId: OrgId; project: string; agentId?: AgentId; workflow?: { path?: string } | undefined; runEstimate?: { runLimitUsd: number } | undefined; requestedRunLimitUsd?: number | undefined; maxPerRunUsd?: number | undefined }): Promise<number> {
  const estimated = task.runEstimate?.runLimitUsd ?? (await estimateRun(deps, {
    orgId: task.orgId, project: task.project, agentId: task.agentId ?? ROVARA_CODE_AGENT_ID, path: estimatePathOf(task),
    ...(task.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: task.maxPerRunUsd }),
  })).runLimitUsd;
  return task.requestedRunLimitUsd === undefined ? estimated : Math.min(estimated, task.requestedRunLimitUsd);
}

// ---- the cost of a finished run

/** How long a run's cost is kept; the newest twenty are read, so older ones only matter for an agent that has rarely run. */
const RUN_COST_KEPT_SECONDS = 365 * 24 * 60 * 60;

export interface RecordRunCostInput {
  orgId: OrgId;
  project: string;
  taskId: string;
  /** The agent of the run. Default Rovara Code. */
  agentId?: AgentId;
  path: EstimatePath;
  endedAt: string;
  /** What the run cost, in dollars (the cost ledger's total for the task). */
  costUsd: number;
  /** A task with a purpose (a setup draft, a diagnosis) never feeds the estimates. */
  purpose?: string | undefined;
  /** The cost is a floor (a call had no price, or the money is not in dollars): the run is marked but never teaches the estimator, which would otherwise think runs cheap. */
  partial?: true | undefined;
}

/**
 * Writes what a run that merged or finished cost, for the next estimate: the `RUN_COST` item and the task's `runCostRecordedAt` mark, in one transaction, so a run is counted once however often
 * its end is told. A run that spent nothing writes only the mark. The task is the document at `{ pk: "DEVTASK#<taskId>", sk: "META" }` (the task flow lane's record, as in the hosted product).
 */
export async function recordRunCost(deps: { store: Pick<DocumentStore, "transact" | "get"> }, input: RecordRunCostInput): Promise<"recorded" | "already_recorded" | "skipped"> {
  if (input.purpose !== undefined) return "skipped";
  if (!isCost(input.costUsd)) throw new Error("a run's cost is a finite amount of dollars, not less than nothing");
  const taskKey = { pk: `DEVTASK#${input.taskId}`, sk: "META" };
  const agentId = input.agentId ?? ROVARA_CODE_AGENT_ID;
  const mark: TransactItem = {
    kind: "update", key: taskKey, ops: [{ op: "set", path: ["runCostRecordedAt"], value: input.endedAt }],
    condition: when.and(when.present(), when.or(when.eq("companyId", input.orgId), when.eq("orgId", input.orgId)), when.notExists("runCostRecordedAt")),
  };
  const item: TransactItem = {
    kind: "put",
    item: {
      ...runCostKey(input.orgId, input.project, agentId, input.path, input.endedAt, input.taskId), entityType: "RUN_COST",
      orgId: input.orgId, project: input.project, agentId, path: input.path, taskId: input.taskId, endedAt: input.endedAt, costUsd: input.costUsd,
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(input.endedAt) / 1000) + RUN_COST_KEPT_SECONDS,
    },
    condition: when.absent(),
  };
  const feeds = input.costUsd > 0 && input.partial !== true;
  const result = await deps.store.transact(feeds ? [item, mark] : [mark]);
  if (result.applied) return feeds ? "recorded" : "skipped";
  // The mark is the claim: another end got there first when it is on the task now. Anything else (a task that does not exist, a lost race on the item) is for the next end to tell again.
  const fresh = await deps.store.get(taskKey);
  if (fresh?.["runCostRecordedAt"] !== undefined) return "already_recorded";
  throw new Error("the run's cost could not be recorded");
}

/** What to record for a run from the cost ledger's total: the dollars, and whether they are a floor (some call unpriced, or not in dollars). Undefined dollars (another currency) cannot feed an estimate in dollars. */
export function runCostInputOf(cost: { micros: number; currency: string | undefined; unpricedEntries: number }): { costUsd: number; partial?: true } {
  const inDollars = cost.currency === undefined || cost.currency === "USD";
  return { costUsd: inDollars ? cost.micros / 1_000_000 : 0, ...(!inDollars || cost.unpricedEntries > 0 ? { partial: true as const } : {}) };
}
