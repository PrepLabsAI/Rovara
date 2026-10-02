// Spec 052: batches of eval runs. A batch records its queue of (task, model, repeat) runs and feeds
// them, one at a time, into the single-run path (startSwebenchRun, the run record, launch.json and
// the eval state machine), while a slot is free and the next start fits the batch's cost cap.
//
// The batch record is one item, rewritten whole under a version check: every change (a claim, a
// run's end, a stop) reads the record, changes it and writes it back only if no other change came
// first, so two top-ups at once can never both claim the last slot or the last run that fits the cap.
import { createHash, randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { thinkingLevelRefusal, thinkingLevelSupport } from "@agentx/model-runtime/thinking-levels";
import {
  EvalBatchFileSchema,
  EvalBatchRecordSchema,
  EvalRunMeasureSchema,
  SWEBENCH_TERMINAL_STATUSES,
  agentXError,
  slackThreadSubject,
  swebenchInstanceIdFits,
  type EvalBatchEntry,
  type EvalBatchRecord,
  type EvalRunMeasure,
  type ModelIdentifier,
  type ModelSelection,
  type SlackRequester,
  type SlackThread,
  type SwebenchDataset,
  type SwebenchRun,
  type TaskUsageTelemetry,
} from "@agentx/contracts";
import {
  getSwebenchChannel,
  isConditionFailure,
  readRun,
  requestCancel,
  startSwebenchRun,
  swebenchSlotsInUse,
  type SwebenchDependencies,
  type SwebenchSlackContext,
} from "./swebench.js";

/** What a failed run's report says it used, when it says. */
type RunUsage = Pick<TaskUsageTelemetry, "tokens" | "costUsd">;

export interface EvalBatchDependencies extends SwebenchDependencies {
  /** A run's estimated cost in USD, for ordering; undefined when the model cannot be priced. Defaults to list prices. */
  estimateRunCostUsd?: (model: ModelIdentifier) => number | undefined;
  /** The instance IDs of a dataset, the population a `sample` is drawn from; absent, a batch must list its tasks. */
  datasetInstanceIds?: (dataset: SwebenchDataset) => Promise<readonly string[]>;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * The token mix a cost estimate prices (FR-001 `cheapest-first`): one measured SEC-bench run of
 * spec 046's pilot, 16.9M cached reads, 101k output and 167k cache writes, with uncached input
 * negligible beside them. Only the order of the models matters, so one fixed mix serves all.
 */
export const EVAL_BATCH_REFERENCE_TOKENS = Object.freeze({ input: 0, output: 101_000, cacheRead: 16_900_000, cacheWrite: 167_000 });

/** A claim (QUEUED to STARTING) that recorded no run within this long was left by a top-up that stopped; it is recovered. */
export const EVAL_BATCH_STALE_CLAIM_MS = 5 * 60_000;

/**
 * FR-008: the failures that are the infrastructure's, not the agent's or the task's, recognised by
 * the error text the state machine, the broker and the runner write. Such a run is retried once.
 */
export const EVAL_BATCH_INFRASTRUCTURE_FAILURES: readonly RegExp[] = [
  // The state machine: the instance could not be launched or recorded, or it was lost.
  /^the eval instance could not be (?:launched|recorded)\b/,
  /^the eval instance stopped \(.+\) without reporting a result/,
  // The broker: launch.json or the execution could not be started.
  /^the run could not start:/,
  // The runner: the task image could not be pulled.
  /\bcould not pull\b/,
  // The runner: the model could not be reached with the deployment's access.
  /\bAccessDeniedException\b/,
  /\bdon't have access to the model\b/i,
  /\bmodel access\b/i,
  /\bOpenRouter credentials? could not be (?:loaded|initialized)\b/,
];

const ACTIVE_PK = "EVAL_BATCHES#ACTIVE";
const STORAGE_ONLY = ["pk", "sk", "entityType", "projectName", "runnerFeatures"];
const TERMINAL_BATCH = new Set<EvalBatchRecord["status"]>(["DONE", "STOPPED", "CAPPED"]);
const IN_FLIGHT = new Set<EvalBatchEntry["state"]>(["STARTING", "RUNNING"]);
/** A record write that lost a race is tried again this many times in all. */
const WRITE_ATTEMPTS = 8;
/** A start refused by a transaction conflict on the slot counter is tried this many times in all. */
const START_ATTEMPTS = 3;
const BACKOFF_MS = 25;
/** OpenRouter provider slugs, as the runner's routing accepts them (model-runtime openRouterRouting). */
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9_/-]{0,79}$/;
const THINKING_FEATURE = "model.thinkingLevel";

export function evalBatchKey(batchId: string) {
  return { pk: `EVAL_BATCH#${batchId}`, sk: "META" };
}

function measureKey(batchId: string, runId: string) {
  return { pk: `EVAL_BATCH#${batchId}`, sk: `MEASURE#${runId}` };
}

function activeKey(batchId: string) {
  return { pk: ACTIVE_PK, sk: `BATCH#${batchId}` };
}

/** The run ID of an entry's attempt: a UUID derived from the batch, the entry and the attempt, so a repeated start finds its run. */
export function evalBatchRunId(batchId: string, index: number, attempt: number): string {
  const bytes = createHash("sha256").update(`agentx eval batch run v1:${batchId}:${index}:${attempt}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isInfrastructureFailure(error: string | undefined): boolean {
  return error !== undefined && EVAL_BATCH_INFRASTRUCTURE_FAILURES.some((pattern) => pattern.test(error));
}

/**
 * A run's estimated cost: the catalog's list prices times the reference token mix. A model without
 * a cache price pays input price for cached tokens. Undefined for a model the catalog does not know
 * or lists at no price, since nothing could order or cap it.
 */
export function defaultRunCostEstimate(model: ModelIdentifier): number | undefined {
  const prices = listPricesPerMillion(model);
  if (prices === undefined || (prices.input <= 0 && prices.output <= 0)) return undefined;
  const cacheRead = prices.cacheRead > 0 ? prices.cacheRead : prices.input;
  const cacheWrite = prices.cacheWrite > 0 ? prices.cacheWrite : prices.input;
  const tokens = EVAL_BATCH_REFERENCE_TOKENS;
  const usd = (tokens.input * prices.input + tokens.output * prices.output + tokens.cacheRead * cacheRead + tokens.cacheWrite * cacheWrite) / 1_000_000;
  return roundUsd(usd);
}

/**
 * FR-001: a seeded sample of a dataset's instances. The population's order does not matter. With
 * strata (project names, such as `django` or `njs`), the draw takes from each stratum in turn, so
 * the count is split as evenly as the strata allow.
 */
export function drawSample(population: readonly string[], sample: { count: number; seed: number | string; strata?: readonly string[] | undefined }): string[] {
  const shuffled = seededShuffle([...new Set(population)].sort(), String(sample.seed));
  if (sample.strata === undefined) return shuffled.slice(0, sample.count);
  const groups = sample.strata.map((stratum) => shuffled.filter((id) => projectOf(id) === stratum.toLowerCase()));
  const drawn: string[] = [];
  for (let round = 0; drawn.length < sample.count && groups.some((group) => group.length > round); round += 1) {
    for (const group of groups) {
      const id = group[round];
      if (id !== undefined && drawn.length < sample.count) drawn.push(id);
    }
  }
  return drawn;
}

/** `django__django-11099` and `instance_django__django-…` are django's; `njs.cve-2022-32414` is njs's. */
function projectOf(instanceId: string): string {
  return (instanceId.replace(/^instance_/, "").split(/__|\./)[0] ?? "").toLowerCase();
}

function seededShuffle<T>(items: T[], seed: string): T[] {
  let state = createHash("sha256").update(`agentx eval batch sample v1:${seed}`).digest().readUInt32BE(0);
  // mulberry32: small, fast and the same everywhere.
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [items[index], items[other]] = [items[other]!, items[index]!];
  }
  return items;
}

/**
 * FR-001 to FR-004: validates a batch file, checks every model is approved for the channel's
 * project and can be priced, draws a sample once, expands and orders the queue, pins the runner
 * image, and records the batch. Its runs start at the next top-up.
 */
export async function createBatch(
  dependencies: EvalBatchDependencies,
  context: SwebenchSlackContext,
  value: unknown,
  options: { batchId?: string } = {},
): Promise<EvalBatchRecord> {
  const file = EvalBatchFileSchema.parse(value);
  const deployment = await dependencies.deployment();
  if (deployment === undefined) throw agentXError("CONFIG_INVALID", "Eval runs are not installed in this deployment. Ask an administrator to deploy the eval stack and runner image.");
  const channel = await getSwebenchChannel(dependencies, context.thread.teamId, context.thread.channelId);
  if (channel === undefined) throw agentXError("CONFIG_INVALID", "Eval runs are not enabled in this channel. An administrator can enable them with `agentx admin eval enable`.");
  const ceiling = channel.maxCostUsd;
  if (file.costCapUsd < ceiling) {
    throw agentXError("CONFIG_INVALID", `the cost cap of $${file.costCapUsd} is below one run's ceiling of $${ceiling} in this channel, so no run could start; raise the cap`);
  }
  const runnerImage = file.runnerImage ?? deployment.runnerImage;
  // The current image's features are recorded by its release; a file's own image is one released
  // since spec 053, which every batch needs for its explicit thinking level.
  const runnerFeatures = runnerImage === deployment.runnerImage ? [...deployment.runnerFeatures] : [THINKING_FEATURE];
  if (!runnerFeatures.includes(THINKING_FEATURE)) {
    throw agentXError("CONFIG_INVALID", "the runner image cannot set a model's thinking level; release a newer runner image before running a batch");
  }
  const estimate = dependencies.estimateRunCostUsd ?? defaultRunCostEstimate;
  const estimates = new Map<string, number>();
  for (const model of file.models) {
    const name = `${model.provider}/${model.modelId}`;
    await context.projectModel({ provider: model.provider, modelId: model.modelId });
    const support = thinkingLevelSupport(model, model.thinkingLevel);
    if (!support.ok) throw agentXError("CONFIG_INVALID", thinkingLevelRefusal(name, model.thinkingLevel, support.supported));
    if (model.routing !== undefined) {
      if (model.provider !== "openrouter") throw agentXError("CONFIG_INVALID", `${name}: a provider pin applies to OpenRouter models only`);
      if (!model.routing.only.every((slug) => PROVIDER_SLUG.test(slug))) throw agentXError("CONFIG_INVALID", `${name}: OpenRouter providers must be provider slugs, such as \`fireworks\``);
    }
    const usd = estimate(model);
    if (usd === undefined || !Number.isFinite(usd) || usd < 0) throw agentXError("CONFIG_INVALID", `the cost of ${name} cannot be estimated, so the batch cannot be ordered; choose a model the catalog prices`);
    estimates.set(name, usd);
  }
  const tasks = file.tasks ?? await sampledTasks(dependencies, file.benchmark, file.sample!);
  const listed: Array<Omit<EvalBatchEntry, "index">> = [];
  for (const task of tasks) {
    for (const model of file.models) {
      for (let repeat = 1; repeat <= file.repeats; repeat += 1) {
        listed.push({ task, model, repeat, attempt: 1, state: "QUEUED", estimatedCostUsd: estimates.get(`${model.provider}/${model.modelId}`)! });
      }
    }
  }
  // Array.prototype.sort is stable: equal estimates keep the listed order.
  const ordered = file.order === "cheapest-first" ? [...listed].sort((left, right) => left.estimatedCostUsd! - right.estimatedCostUsd!) : listed;
  const queue = ordered.map((entry, index) => ({ ...entry, index }));
  const at = now(dependencies).toISOString();
  const batchId = options.batchId ?? randomUUID();
  const record = EvalBatchRecordSchema.parse({
    batchId,
    file: { ...file, runnerImage },
    createdBy: context.requester,
    thread: context.thread,
    status: "RUNNING",
    version: 0,
    perRunCeilingUsd: ceiling,
    queue,
    spentUsd: 0,
    counts: countsOf(queue),
    createdAt: at,
    updatedAt: at,
  });
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: dependencies.tableName,
            Item: { ...evalBatchKey(batchId), entityType: "EVAL_BATCH", projectName: context.projectName, runnerFeatures, ...record },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: dependencies.tableName,
            Item: { ...activeKey(batchId), entityType: "EVAL_BATCH_ACTIVE", batchId, threadSubject: slackThreadSubject(context.thread), createdAt: at },
          },
        },
      ],
    }));
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
    // A repeated request: the batch it already created.
    const existing = await getBatch(dependencies, batchId);
    if (existing === undefined || slackThreadSubject(existing.thread) !== slackThreadSubject(context.thread)) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "this batch ID belongs to another thread's batch");
    }
    return existing;
  }
  return record;
}

async function sampledTasks(dependencies: EvalBatchDependencies, dataset: SwebenchDataset, sample: NonNullable<EvalBatchRecord["file"]["sample"]>): Promise<string[]> {
  if (dependencies.datasetInstanceIds === undefined) {
    throw agentXError("CONFIG_INVALID", "drawing a sample is not available in this deployment; list the tasks in the batch file");
  }
  const population = (await dependencies.datasetInstanceIds(dataset)).filter((id) => swebenchInstanceIdFits(dataset, id));
  const drawn = drawSample(population, sample);
  if (drawn.length < sample.count) {
    throw agentXError("CONFIG_INVALID", `the sample asks for ${sample.count} tasks, but only ${drawn.length} are available${sample.strata === undefined ? "" : " in its strata"}`);
  }
  return drawn;
}

export async function getBatch(dependencies: EvalBatchDependencies, batchId: string): Promise<EvalBatchRecord | undefined> {
  return (await readStored(dependencies, batchId))?.record;
}

/** FR-010: the batch's measures, one per finished run. */
export async function listBatchMeasures(dependencies: EvalBatchDependencies, batchId: string): Promise<EvalRunMeasure[]> {
  const measures: EvalRunMeasure[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await dependencies.documentClient.send(new QueryCommand({
      TableName: dependencies.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :measure)",
      ExpressionAttributeValues: { ":pk": evalBatchKey(batchId).pk, ":measure": "MEASURE#" },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }));
    for (const item of page.Items ?? []) measures.push(EvalRunMeasureSchema.parse(withoutKeys(item, ["pk", "sk", "entityType"])));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return measures;
}

/** FR-006: fills each running batch's free slots. One batch's failure is logged and leaves the others to fill. */
export async function topUpBatches(dependencies: EvalBatchDependencies): Promise<void> {
  for (const batchId of await activeBatchIds(dependencies)) {
    try {
      await topUpBatch(dependencies, batchId);
    } catch (error) {
      log("eval_batch.top_up_failed", { batchId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function topUpBatch(dependencies: EvalBatchDependencies, batchId: string): Promise<void> {
  const stored = await readStored(dependencies, batchId);
  if (stored === undefined || TERMINAL_BATCH.has(stored.record.status)) {
    // Its index item outlived the batch (the delete after its last write failed).
    await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: activeKey(batchId) }));
    return;
  }
  const deployment = await dependencies.deployment();
  if (deployment === undefined) return;
  await recoverStaleClaims(dependencies, stored);
  for (;;) {
    // The counter read only saves a pointless claim: the start takes its slot atomically.
    const free = await swebenchSlotsInUse(dependencies) < deployment.settings.maxConcurrentEvals;
    const claim = await mutate<{ index: number; attempt: number } | undefined>(dependencies, batchId, (draft, at) => {
      if (!free || draft.status !== "RUNNING") return none();
      const inFlight = inFlightCount(draft);
      if (inFlight >= (draft.file.concurrency ?? Number.POSITIVE_INFINITY) || !nextStartFits(draft, inFlight)) return none();
      const entry = draft.queue.find((candidate) => candidate.state === "QUEUED");
      if (entry === undefined) return none();
      entry.state = "STARTING";
      entry.claimedAt = at;
      return { value: { index: entry.index, attempt: entry.attempt }, write: true };
    });
    if (claim?.value === undefined) return;
    if (!await startClaimed(dependencies, claim.stored, claim.value)) return;
  }
}

/** Starts a claimed entry's run; false when no run started and topping up should stop for now. */
async function startClaimed(dependencies: EvalBatchDependencies, stored: Stored, claim: { index: number; attempt: number }): Promise<boolean> {
  const { record } = stored;
  const entry = record.queue.find((candidate) => candidate.index === claim.index)!;
  const runId = evalBatchRunId(record.batchId, claim.index, claim.attempt);
  const model: ModelSelection = { provider: entry.model.provider, modelId: entry.model.modelId, thinkingLevel: entry.model.thinkingLevel };
  const context: SwebenchSlackContext = {
    thread: record.thread,
    requester: record.createdBy,
    projectName: stored.projectName,
    // Approved when the batch was created; the batch runs what it recorded.
    projectModel: async () => model,
  };
  const request = { requestId: runId, dataset: record.file.benchmark, instanceId: entry.task, model };
  const options = {
    batchId: record.batchId,
    runnerImage: record.file.runnerImage!,
    runnerFeatures: stored.runnerFeatures,
    ...(record.perRunCeilingUsd === undefined ? {} : { maxCostUsd: record.perRunCeilingUsd }),
    ...(entry.model.routing === undefined ? {} : { openRouterProviders: entry.model.routing.only }),
  };
  for (let attempt = 1; ; attempt += 1) {
    let started: Awaited<ReturnType<typeof startSwebenchRun>>;
    try {
      started = await startSwebenchRun(dependencies, context, request, options);
    } catch (error) {
      if (isTransactionConflict(error) && attempt < START_ATTEMPTS) {
        await sleep(dependencies, BACKOFF_MS * attempt * (1 + Math.random()));
        continue;
      }
      log("eval_batch.start_failed", { batchId: record.batchId, runId, error: error instanceof Error ? error.message : String(error) });
      // A run the start recorded has ended FAILED (it could not be launched): its end is recorded,
      // and retried as the infrastructure's. Otherwise the claim is given back.
      const run = await readRun(dependencies, runId);
      if (run !== undefined) await adopt(dependencies, record.batchId, claim, run);
      else await releaseClaim(dependencies, record.batchId, claim);
      return false;
    }
    if (started.outcome === "REFUSED") {
      if (started.reason !== "RUN_ACTIVE") log("eval_batch.start_refused", { batchId: record.batchId, runId, reason: started.reason });
      await releaseClaim(dependencies, record.batchId, claim);
      return false;
    }
    await adopt(dependencies, record.batchId, claim, started.run);
    return true;
  }
}

/**
 * Records that an entry's run exists: the entry is RUNNING with its run ID. A batch stopped
 * meanwhile cancels the run, and a run that has already ended is recorded as ended.
 */
async function adopt(dependencies: EvalBatchDependencies, batchId: string, claim: { index: number; attempt: number }, run: SwebenchRun): Promise<void> {
  const adopted = await mutate<boolean | undefined>(dependencies, batchId, (draft) => {
    const entry = draft.queue.find((candidate) => candidate.index === claim.index);
    if (entry === undefined || entry.attempt !== claim.attempt || (entry.state !== "STARTING" && entry.state !== "QUEUED")) return none();
    entry.state = "RUNNING";
    entry.runId = run.runId;
    delete entry.claimedAt;
    return { value: draft.status !== "RUNNING", write: true };
  });
  if (adopted === undefined) return;
  if (adopted.value === true) await requestCancel(dependencies, run.runId, adopted.record.createdBy);
  const current = await readRun(dependencies, run.runId);
  if (current !== undefined && SWEBENCH_TERMINAL_STATUSES.has(current.status)) await recordBatchRunEnd(dependencies, current);
}

/** Gives a claim back: QUEUED again, or CANCELLED when the batch is stopping. Only the same claim is given back. */
async function releaseClaim(dependencies: EvalBatchDependencies, batchId: string, claim: { index: number; attempt: number; claimedAt?: string }): Promise<void> {
  await mutate(dependencies, batchId, (draft) => {
    const entry = draft.queue.find((candidate) => candidate.index === claim.index);
    if (entry === undefined || entry.attempt !== claim.attempt || entry.state !== "STARTING") return none();
    if (claim.claimedAt !== undefined && entry.claimedAt !== claim.claimedAt) return none();
    entry.state = draft.status === "STOPPING" ? "CANCELLED" : "QUEUED";
    delete entry.claimedAt;
    return { value: undefined, write: true };
  });
}

/** A claim left by a top-up that stopped before recording its run: adopted if the run exists, else given back. */
async function recoverStaleClaims(dependencies: EvalBatchDependencies, stored: Stored): Promise<void> {
  const batchId = stored.record.batchId;
  const cutoff = now(dependencies).getTime() - EVAL_BATCH_STALE_CLAIM_MS;
  const stale = stored.record.queue.filter((entry) => entry.state === "STARTING" && entry.runId === undefined
    && (entry.claimedAt === undefined || Date.parse(entry.claimedAt) < cutoff));
  for (const entry of stale) {
    const claim = { index: entry.index, attempt: entry.attempt, ...(entry.claimedAt === undefined ? {} : { claimedAt: entry.claimedAt }) };
    const run = await readRun(dependencies, evalBatchRunId(batchId, entry.index, entry.attempt));
    log("eval_batch.stale_claim", { batchId, index: entry.index, attempt: entry.attempt, adopted: run !== undefined });
    if (run !== undefined) await adopt(dependencies, batchId, claim, run);
    else await releaseClaim(dependencies, batchId, claim);
  }
}

/**
 * FR-006 to FR-008, FR-010: a batch run has ended. Its cost is added to the batch's spend and its
 * measures recorded. An infrastructure failure on the first attempt is queued again as attempt 2,
 * under a new run ID, and its measures are not recorded, so the results hold one row per entry; a
 * graded run is never queued again. Repeating it changes nothing.
 */
export async function recordBatchRunEnd(dependencies: EvalBatchDependencies, run: SwebenchRun, usage?: RunUsage): Promise<void> {
  if (run.batchId === undefined || !SWEBENCH_TERMINAL_STATUSES.has(run.status)) return;
  const batchId = run.batchId;
  const costUsd = run.result?.usage.costUsd ?? (run.status === "FAILED" ? usage?.costUsd ?? null : null);
  const ended = await mutate<EvalBatchEntry | undefined>(dependencies, batchId, (draft) => {
    const entry = draft.queue.find((candidate) => IN_FLIGHT.has(candidate.state) && evalBatchRunId(batchId, candidate.index, candidate.attempt) === run.runId);
    if (entry === undefined) {
      // Already recorded: its measures are written again if that write was lost.
      const recorded = draft.queue.find((candidate) => candidate.runId === run.runId && !IN_FLIGHT.has(candidate.state) && candidate.state !== "QUEUED");
      return { value: recorded === undefined ? undefined : structuredClone(recorded), write: false };
    }
    draft.spentUsd = roundUsd(draft.spentUsd + (costUsd ?? 0));
    delete entry.claimedAt;
    if (run.status === "FAILED" && entry.attempt === 1 && draft.status === "RUNNING" && isInfrastructureFailure(run.error)) {
      entry.state = "QUEUED";
      entry.attempt = 2;
      delete entry.runId;
      return { value: undefined, write: true };
    }
    entry.state = run.status === "SUCCEEDED" ? "DONE" : run.status === "FAILED" ? "FAILED" : "CANCELLED";
    entry.runId = run.runId;
    return { value: structuredClone(entry), write: true };
  });
  const entry = ended?.value;
  // A cancelled run has no result to measure.
  if (entry === undefined || run.status === "CANCELLED") return;
  const measure = measureOf(batchId, entry, run, usage, costUsd);
  try {
    await dependencies.documentClient.send(new PutCommand({
      TableName: dependencies.tableName,
      Item: { ...measureKey(batchId, run.runId), entityType: "EVAL_BATCH_MEASURE", ...measure },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
  }
}

function measureOf(batchId: string, entry: EvalBatchEntry, run: SwebenchRun, usage: RunUsage | undefined, costUsd: number | null): EvalRunMeasure {
  const result = run.result;
  const tokens = result?.usage.tokens ?? (run.status === "FAILED" ? usage?.tokens : undefined) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return EvalRunMeasureSchema.parse({
    batchId,
    runId: run.runId,
    instanceId: run.instanceId,
    provider: entry.model.provider,
    modelId: entry.model.modelId,
    thinkingLevel: entry.model.thinkingLevel,
    ...(entry.model.routing === undefined ? {} : { routing: entry.model.routing }),
    repeat: entry.repeat,
    outcome: run.status === "SUCCEEDED" ? "GRADED" : "FAILED",
    resolved: result?.resolved ?? false,
    ...(result?.secbench === undefined ? {} : { secbench: result.secbench }),
    ...(result?.failToPass === undefined ? {} : { failToPass: result.failToPass }),
    ...(result?.passToPass === undefined ? {} : { passToPass: result.passToPass }),
    ...(result === undefined ? {} : { stopReason: result.stopReason }),
    agentSeconds: result?.agentSeconds ?? 0,
    tokens,
    costUsd,
    imageDigest: result?.imageDigest ?? "",
  });
}

/**
 * FR-009: stops a batch. Queued runs are cancelled, runs in flight are asked to stop through the
 * single-run stop, and the batch is STOPPED once they have ended. Stopping a stopped batch changes nothing.
 */
export async function stopBatch(dependencies: EvalBatchDependencies, batchId: string, requester: SlackRequester): Promise<EvalBatchRecord | undefined> {
  const stopped = await mutate(dependencies, batchId, (draft) => {
    if (draft.status !== "RUNNING" && draft.status !== "QUEUED") return none();
    draft.status = "STOPPING";
    for (const entry of draft.queue) if (entry.state === "QUEUED") entry.state = "CANCELLED";
    return { value: undefined, write: true };
  });
  if (stopped === undefined) return undefined;
  // A STARTING entry's run may exist already: its run ID is known. One that does not yet exist is
  // cancelled by the top-up that starts it, which finds the batch stopping.
  for (const entry of stopped.record.queue) {
    if (IN_FLIGHT.has(entry.state)) await requestCancel(dependencies, entry.runId ?? evalBatchRunId(batchId, entry.index, entry.attempt), requester);
  }
  return stopped.record;
}

/** Task 2's hook: a stop in a batch's thread stops the batch. Returns the first batch it stopped. */
export async function stopBatchForThread(dependencies: EvalBatchDependencies, thread: SlackThread, requester: SlackRequester): Promise<string | undefined> {
  const subject = slackThreadSubject(thread);
  let first: string | undefined;
  for (const item of await activeItems(dependencies)) {
    if (item.threadSubject !== subject || typeof item.batchId !== "string") continue;
    if (await stopBatch(dependencies, item.batchId, requester) !== undefined) first ??= item.batchId;
  }
  return first;
}

/**
 * The single-run module's hooks, bound to these dependencies: a stop stops the thread's batch, and
 * a run's end is recorded in its batch and the freed slot filled. Hooks already given are kept.
 */
export function withEvalBatches<T extends EvalBatchDependencies>(dependencies: T): T {
  const wired: T = { ...dependencies };
  wired.stopBatchForThread ??= (thread, requester) => stopBatchForThread(wired, thread, requester);
  wired.onRunEnded ??= async (run, result) => {
    await recordBatchRunEnd(wired, run, result.usage);
    await topUpBatches(wired);
  };
  return wired;
}

// --- The record --------------------------------------------------------------------------------

interface Stored {
  record: EvalBatchRecord;
  projectName: string;
  runnerFeatures: string[];
}

async function readStored(dependencies: EvalBatchDependencies, batchId: string): Promise<Stored | undefined> {
  const response = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: evalBatchKey(batchId), ConsistentRead: true }));
  const item = response.Item as Record<string, unknown> | undefined;
  if (item === undefined) return undefined;
  return {
    record: EvalBatchRecordSchema.parse(withoutKeys(item, STORAGE_ONLY)),
    projectName: String(item.projectName),
    runnerFeatures: Array.isArray(item.runnerFeatures) ? item.runnerFeatures.filter((feature): feature is string => typeof feature === "string") : [],
  };
}

type Change<T> = (draft: EvalBatchRecord, at: string) => { value: T; write: boolean };

function none(): { value: undefined; write: false } {
  return { value: undefined, write: false };
}

/**
 * Reads the record, applies a change to a copy, settles the batch's status, and writes it back only
 * if its version is still the one read; a write that lost the race is tried again on a fresh read.
 * Undefined when the batch does not exist.
 */
async function mutate<T>(dependencies: EvalBatchDependencies, batchId: string, change: Change<T>): Promise<{ record: EvalBatchRecord; value: T; stored: Stored } | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    const stored = await readStored(dependencies, batchId);
    if (stored === undefined) return undefined;
    const draft = structuredClone(stored.record);
    const at = now(dependencies).toISOString();
    const { value, write } = change(draft, at);
    const settled = settle(draft, at);
    if (!write && !settled) return { record: stored.record, value, stored };
    const next = EvalBatchRecordSchema.parse({ ...draft, version: stored.record.version + 1, counts: countsOf(draft.queue), updatedAt: at });
    try {
      await dependencies.documentClient.send(new PutCommand({
        TableName: dependencies.tableName,
        Item: { ...evalBatchKey(batchId), entityType: "EVAL_BATCH", projectName: stored.projectName, runnerFeatures: stored.runnerFeatures, ...next },
        ConditionExpression: "#version = :version",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":version": stored.record.version },
      }));
    } catch (error) {
      if (!isConditionFailure(error) || attempt >= WRITE_ATTEMPTS) throw error;
      await sleep(dependencies, BACKOFF_MS * (1 + Math.random()));
      continue;
    }
    if (TERMINAL_BATCH.has(next.status) && !TERMINAL_BATCH.has(stored.record.status)) {
      log("eval_batch.ended", { batchId, status: next.status, spentUsd: next.spentUsd, counts: next.counts });
      await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: activeKey(batchId) }));
    }
    return { record: next, value, stored: { ...stored, record: next } };
  }
}

/**
 * The batch's status from its queue: DONE when nothing is queued or in flight; CAPPED when nothing
 * is in flight and the next run would not fit the cap, its queued runs NOT_STARTED; STOPPED when a
 * stopping batch has nothing in flight. True when it changed.
 */
function settle(draft: EvalBatchRecord, at: string): boolean {
  const inFlight = inFlightCount(draft);
  const queued = draft.queue.filter((entry) => entry.state === "QUEUED").length;
  let status = draft.status;
  if (draft.status === "STOPPING" && inFlight === 0) status = "STOPPED";
  if (draft.status === "RUNNING" && inFlight === 0) {
    if (queued === 0) status = "DONE";
    else if (!nextStartFits(draft, 0)) {
      status = "CAPPED";
      for (const entry of draft.queue) if (entry.state === "QUEUED") entry.state = "NOT_STARTED";
    }
  }
  if (status === draft.status) return false;
  draft.status = status;
  draft.finishedAt = at;
  return true;
}

function inFlightCount(record: EvalBatchRecord): number {
  return record.queue.filter((entry) => IN_FLIGHT.has(entry.state)).length;
}

/** FR-007: a start fits while spent + inFlight × perRunCeiling + perRunCeiling ≤ costCapUsd. */
function nextStartFits(record: EvalBatchRecord, inFlight: number): boolean {
  const ceiling = record.perRunCeilingUsd ?? record.file.costCapUsd;
  return record.spentUsd + (inFlight + 1) * ceiling <= record.file.costCapUsd + 1e-9;
}

function countsOf(queue: readonly Pick<EvalBatchEntry, "state">[]): EvalBatchRecord["counts"] {
  const count = (state: EvalBatchEntry["state"]) => queue.filter((entry) => entry.state === state).length;
  return {
    queued: count("QUEUED"),
    starting: count("STARTING"),
    running: count("RUNNING"),
    done: count("DONE"),
    failed: count("FAILED"),
    cancelled: count("CANCELLED"),
    notStarted: count("NOT_STARTED"),
  };
}

async function activeItems(dependencies: EvalBatchDependencies): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await dependencies.documentClient.send(new QueryCommand({
      TableName: dependencies.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :batch)",
      ExpressionAttributeValues: { ":pk": ACTIVE_PK, ":batch": "BATCH#" },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }));
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return items;
}

async function activeBatchIds(dependencies: EvalBatchDependencies): Promise<string[]> {
  return (await activeItems(dependencies)).map((item) => item.batchId).filter((batchId): batchId is string => typeof batchId === "string");
}

/** A transaction cancelled by another write to one of its items (the slot counter), not by a failed condition. */
function isTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return false;
  const reasons = (error as Error & { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
  return Array.isArray(reasons) && reasons.some((reason) => reason?.Code === "TransactionConflict") && !isConditionFailure(error);
}

function withoutKeys(item: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key)));
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sleep(dependencies: EvalBatchDependencies, milliseconds: number): Promise<void> {
  return dependencies.sleep?.(milliseconds) ?? new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function now(dependencies: Pick<EvalBatchDependencies, "now">): Date {
  return dependencies.now?.() ?? new Date();
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ component: "broker", event, ...fields }));
}
