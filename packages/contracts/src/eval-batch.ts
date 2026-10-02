// Spec 052: batches of eval runs, several at once. The batch file, its record, the per-run measures
// and the per-model summary.
import { z } from "zod";
import { ModelSelectionSchema, ThinkingLevelSchema } from "./models.js";
import { SlackRequesterSchema, SlackThreadSchema } from "./slack.js";
import {
  SwebenchDatasetSchema,
  SwebenchInstanceIdSchema,
  SwebenchLaunchSchema,
  SwebenchStopReasonSchema,
  SecbenchVerdictSchema,
  swebenchFamily,
  swebenchInstanceIdFits,
  type SwebenchDataset,
} from "./swebench.js";

export const EVAL_BATCH_MAX_RUNS = 500;
export const EVAL_BATCH_SLACK_MAX_RUNS = 20;
export const EVAL_BATCH_COST_CAP_MIN_USD = 1;
export const EVAL_BATCH_COST_CAP_MAX_USD = 1_000;

/** OpenRouter provider pin. */
export const EvalBatchRoutingSchema = z.object({ only: z.array(z.string().min(1).max(80)).min(1).max(8) }).strict();
/** A batch model: spec 053's selection with the thinking level explicit (FR-001) and an optional provider pin. */
export const EvalBatchModelSchema = ModelSelectionSchema.extend({
  thinkingLevel: ThinkingLevelSchema,
  routing: EvalBatchRoutingSchema.optional(),
}).strict();

const modelKey = (m: { provider: string; modelId: string; thinkingLevel?: string | undefined; routing?: { only: string[] } | undefined }) =>
  JSON.stringify([m.provider, m.modelId, m.thinkingLevel ?? null, m.routing?.only ?? null]);

const RUNNER_IMAGE = SwebenchLaunchSchema.shape.runnerImage;

export const EvalBatchSampleSchema = z.object({
  count: z.number().int().min(1).max(EVAL_BATCH_MAX_RUNS),
  seed: z.union([z.number().int(), z.string().min(1).max(64)]),
  strata: z.array(z.string().min(1).max(64)).min(1).max(4).optional(),
}).strict();

export const EvalBatchFileSchema = z.object({
  benchmark: SwebenchDatasetSchema,
  tasks: z.array(SwebenchInstanceIdSchema).min(1).max(EVAL_BATCH_MAX_RUNS).optional(),
  sample: EvalBatchSampleSchema.optional(),
  models: z.array(EvalBatchModelSchema).min(1).max(16),
  repeats: z.number().int().min(1).max(5).default(1),
  order: z.enum(["cheapest-first", "as-listed"]).default("cheapest-first"),
  concurrency: z.number().int().min(1).max(6).optional(),
  costCapUsd: z.number().finite().min(EVAL_BATCH_COST_CAP_MIN_USD).max(EVAL_BATCH_COST_CAP_MAX_USD),
  runnerImage: RUNNER_IMAGE.optional(),
}).strict().superRefine((file, context) => {
  if ((file.tasks === undefined) === (file.sample === undefined)) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "name either `tasks` or `sample`, not both and not neither" });
  }
  for (const [index, task] of (file.tasks ?? []).entries()) {
    if (!swebenchInstanceIdFits(file.benchmark, task)) {
      context.addIssue({ code: "custom", path: ["tasks", index], message: `“${task}” does not fit the ${file.benchmark} dataset` });
    }
  }
  const seen = new Set<string>();
  for (const [index, task] of (file.tasks ?? []).entries()) {
    if (seen.has(task)) context.addIssue({ code: "custom", path: ["tasks", index], message: `“${task}” is listed twice` });
    seen.add(task);
  }
  const seenModels = new Set<string>();
  for (const [index, entry] of file.models.entries()) {
    const key = modelKey(entry);
    if (seenModels.has(key)) context.addIssue({ code: "custom", path: ["models", index], message: `${entry.provider}/${entry.modelId} is listed twice with the same settings` });
    seenModels.add(key);
  }
  const taskCount = file.tasks?.length ?? file.sample?.count ?? 0;
  const runs = taskCount * file.models.length * file.repeats;
  if (runs > EVAL_BATCH_MAX_RUNS) {
    context.addIssue({ code: "custom", path: ["models"], message: `${runs} runs exceed the ${EVAL_BATCH_MAX_RUNS}-run limit` });
  }
});

export const EvalBatchStatusSchema = z.enum(["QUEUED", "RUNNING", "STOPPING", "DONE", "STOPPED", "CAPPED"]);
export const EvalBatchEntryStateSchema = z.enum(["QUEUED", "STARTING", "RUNNING", "DONE", "FAILED", "CANCELLED", "NOT_STARTED"]);

export const EvalBatchEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  task: SwebenchInstanceIdSchema,
  model: EvalBatchModelSchema,
  repeat: z.number().int().min(1).max(5),
  /** 1, or 2 after the one retry of an infrastructure failure (FR-008). */
  attempt: z.number().int().min(1).max(2),
  state: EvalBatchEntryStateSchema,
  runId: z.string().uuid().optional(),
  /** When a tick claimed the entry (QUEUED to STARTING); a STARTING entry with no runId past a deadline is reclaimed. */
  claimedAt: z.string().datetime().optional(),
  /** Estimated cost of this run, used for ordering and the cap (FR-001, FR-007). */
  estimatedCostUsd: z.number().nonnegative().optional(),
}).strict();

export const EvalBatchRecordSchema = z.object({
  batchId: z.string().uuid(),
  file: EvalBatchFileSchema,
  createdBy: SlackRequesterSchema,
  thread: SlackThreadSchema,
  status: EvalBatchStatusSchema,
  /** Bumped by every conditional claim of the queue. */
  version: z.number().int().nonnegative().default(0),
  /** The per-run cost ceiling the cap math reserves for each run in flight (FR-007). */
  perRunCeilingUsd: z.number().positive().optional(),
  queue: z.array(EvalBatchEntrySchema).max(EVAL_BATCH_MAX_RUNS * 2),
  spentUsd: z.number().nonnegative(),
  counts: z.object({
    queued: z.number().int().nonnegative(),
    starting: z.number().int().nonnegative().default(0),
    running: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    notStarted: z.number().int().nonnegative(),
  }).strict(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
}).strict();

/**
 * One CSV row: a run's end and its measures (spec 052 FR-010). Every run end has a row: GRADED,
 * FAILED, CANCELLED, or RETRIED (an infrastructure failure whose entry ran again as attempt 2).
 * `resolved` is present on GRADED rows only, so no other row can be counted as unresolved.
 */
export const EvalRunMeasureSchema = z.object({
  batchId: z.string().uuid(),
  runId: z.string().uuid(),
  instanceId: SwebenchInstanceIdSchema,
  provider: z.string().min(1).max(128),
  modelId: z.string().min(1).max(256),
  thinkingLevel: ThinkingLevelSchema.optional(),
  routing: EvalBatchRoutingSchema.optional(),
  repeat: z.number().int().min(1).max(5),
  attempt: z.number().int().min(1).max(2),
  outcome: z.enum(["GRADED", "FAILED", "CANCELLED", "RETRIED"]),
  resolved: z.boolean().optional(),
  /** Why a run that was not graded ended: the run's error. */
  error: z.string().max(2_000).optional(),
  secbench: SecbenchVerdictSchema.optional(),
  failToPass: z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict().optional(),
  passToPass: z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict().optional(),
  stopReason: SwebenchStopReasonSchema.optional(),
  agentSeconds: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative().optional(),
  tokens: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  /** The cost the run reported; null when it reported none. */
  costUsd: z.number().nonnegative().nullable(),
  /**
   * What the run counted against the batch's cap: its reported cost, or, when it reported none,
   * the per-run ceiling (Ruling 4, `costEstimated`), or 0 for an end that provably used no tokens.
   * The rows' charges sum to the batch's spend.
   */
  chargedUsd: z.number().nonnegative(),
  costEstimated: z.boolean().optional(),
  imageDigest: z.string().max(256),
  /** Spec 051's claim-and-check fields, when present. */
  claimCheck: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
}).strict().refine((measure) => (measure.outcome === "GRADED") === (measure.resolved !== undefined), {
  path: ["resolved"],
  message: "`resolved` is set on graded rows only",
});

export const EvalBatchModelSummarySchema = z.object({
  provider: z.string().min(1).max(128),
  modelId: z.string().min(1).max(256),
  thinkingLevel: ThinkingLevelSchema.optional(),
  routing: EvalBatchRoutingSchema.optional(),
  /** Graded runs: the denominator of the rate. */
  runs: z.number().int().nonnegative(),
  /** Runs that ended FAILED, counted separately (spec 046 R-4). */
  failed: z.number().int().nonnegative(),
  /** Runs cancelled by a stop. */
  cancelled: z.number().int().nonnegative(),
  /** Infrastructure failures whose entry ran again. */
  retried: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  /** Null when no run was graded, so an all-failed model never reads as 0% solved. */
  rate: z.number().min(0).max(1).nullable(),
  wilsonLow: z.number().min(0).max(1).nullable(),
  wilsonHigh: z.number().min(0).max(1).nullable(),
  /** Every row's charge, as the cap counted it. */
  totalCostUsd: z.number().nonnegative(),
  /** Rows that reported no cost; each is charged at the per-run ceiling (or 0 when it used no tokens), so the total is an estimate when this is above 0. */
  unpricedRuns: z.number().int().nonnegative(),
  /** Null when no task was solved. */
  costPerSolvedUsd: z.number().nonnegative().nullable(),
}).strict();

export const EvalBatchSummarySchema = z.object({
  batchId: z.string().uuid().optional(),
  models: z.array(EvalBatchModelSummarySchema),
}).strict();

export type EvalBatchModel = z.infer<typeof EvalBatchModelSchema>;
export type EvalBatchFile = z.infer<typeof EvalBatchFileSchema>;
export type EvalBatchEntry = z.infer<typeof EvalBatchEntrySchema>;
export type EvalBatchRecord = z.infer<typeof EvalBatchRecordSchema>;
export type EvalRunMeasure = z.infer<typeof EvalRunMeasureSchema>;
export type EvalBatchModelSummary = z.infer<typeof EvalBatchModelSummarySchema>;
export type EvalBatchSummary = z.infer<typeof EvalBatchSummarySchema>;

/** The Slack message `eval batch <benchmark> <dataset> <ids…> models <a, b…> [repeats N] [cap $X]` (FR-002). */
export type EvalBatchCommand =
  | { kind: "batch"; dataset: SwebenchDataset; instanceIds: string[]; modelSelectors: string[]; repeats: number; costCapUsd?: number }
  | { kind: "invalid"; message: string };

const BATCH_COMMAND = /^eval\s+batch\b(.*)$/isu;
const BATCH_USAGE = "Use `eval batch <swebench|secbench> <dataset> <instance-id…> models <a, b…> [repeats N] [cap $X]`.";

export function parseEvalBatchCommand(text: string): EvalBatchCommand | undefined {
  const command = text.replace(/^\s*<@[A-Z0-9]+>\s*/iu, "").trim().replace(/[.!?]+$/u, "");
  const match = BATCH_COMMAND.exec(command);
  if (!match) return undefined;
  const invalid = (message: string): EvalBatchCommand => ({ kind: "invalid", message: `${message} ${BATCH_USAGE}` });
  const rest = (match[1] ?? "").trim().split(/\s+/u).filter((word) => word.length > 0);
  const benchmark = rest[0]?.toLowerCase();
  if (benchmark === undefined) return invalid("Tell me which benchmark, dataset and instances to run.");
  if (benchmark !== "swebench" && benchmark !== "secbench") return invalid(`Unknown benchmark “${rest[0]}”.`);
  const datasetWord = rest[1]?.toLowerCase();
  if (datasetWord === undefined) return invalid("Tell me which dataset to run.");
  const dataset = benchmark === "secbench"
    ? (datasetWord === "patch" ? "secbench-patch" : undefined)
    : SwebenchDatasetSchema.safeParse(datasetWord).data;
  if (dataset === undefined || (benchmark === "swebench") === (swebenchFamily(dataset) === "secbench")) {
    return invalid(`Unknown dataset “${rest[1]}”.`);
  }
  const body = rest.slice(2);
  const modelsAt = body.findIndex((word) => word.toLowerCase() === "models");
  if (modelsAt < 0) return invalid("Tell me which models to compare after `models`.");
  const instanceIds = body.slice(0, modelsAt);
  if (instanceIds.length === 0) return invalid("Tell me which instances to run.");
  for (const id of instanceIds) {
    if (!SwebenchInstanceIdSchema.safeParse(id).success || !swebenchInstanceIdFits(dataset, id)) {
      return invalid(`“${id}” is not an instance ID of the ${datasetWord} dataset.`);
    }
  }
  let tail = body.slice(modelsAt + 1);
  let repeats = 1;
  let costCapUsd: number | undefined;
  let sawRepeats = false;
  let sawCap = false;
  // Options come last: `repeats N` and `cap $X`, in either order.
  for (let pass = 0; pass < 3; pass += 1) {
    const last2 = tail.slice(-2);
    const key = last2[0]?.toLowerCase();
    if (last2.length === 2 && key === "repeats") {
      if (sawRepeats) return invalid("`repeats` appears twice.");
      sawRepeats = true;
      if (!/^\d+$/u.test(last2[1] ?? "") || Number(last2[1]) < 1 || Number(last2[1]) > 5) return invalid("`repeats` takes a number from 1 to 5.");
      repeats = Number(last2[1]);
      tail = tail.slice(0, -2);
    } else if (last2.length === 2 && key === "cap") {
      if (sawCap) return invalid("`cap` appears twice.");
      sawCap = true;
      const cap = /^\$?(\d+(?:\.\d+)?)$/u.exec(last2[1] ?? "");
      const value = cap ? Number(cap[1]) : Number.NaN;
      if (!(value >= EVAL_BATCH_COST_CAP_MIN_USD && value <= EVAL_BATCH_COST_CAP_MAX_USD)) {
        return invalid(`\`cap\` takes a dollar amount from ${EVAL_BATCH_COST_CAP_MIN_USD} to ${EVAL_BATCH_COST_CAP_MAX_USD.toLocaleString("en-US")}.`);
      }
      costCapUsd = value;
      tail = tail.slice(0, -2);
    }
  }
  const modelSelectors = tail.join(" ").split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  if (modelSelectors.length === 0) return invalid("Tell me which models to compare after `models`.");
  const runs = instanceIds.length * modelSelectors.length * repeats;
  if (runs > EVAL_BATCH_SLACK_MAX_RUNS) {
    return invalid(`${runs} runs is more than the ${EVAL_BATCH_SLACK_MAX_RUNS} a Slack message may start; use a batch file for more.`);
  }
  return { kind: "batch", dataset, instanceIds, modelSelectors, repeats, ...(costCapUsd === undefined ? {} : { costCapUsd }) };
}

