// Spec 052: batches of eval runs. A batch records its queue of (task, model, repeat) runs and feeds
// them, one at a time, into the single-run path (startSwebenchRun, the run record, launch.json and
// the eval state machine), while a slot is free and the next start fits the batch's cost cap.
//
// The batch record is one item, rewritten whole under a version check: every change (a claim, a
// run's end, a stop) reads the record, changes it and writes it back only if no other change came
// first, so two top-ups at once can never both claim the last slot or the last run that fits the cap.
import { createHash, randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { thinkingLevelRefusal, thinkingLevelSupport } from "@agentx/model-runtime/thinking-levels";
import {
  EvalBatchFileSchema,
  EvalBatchRecordSchema,
  EvalBatchSummarySchema,
  EvalRunMeasureSchema,
  SWEBENCH_TERMINAL_STATUSES,
  agentXError,
  slackThreadSubject,
  summarize,
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
/**
 * Ruling 5: the runner halts only after a turn crosses its ceiling, so each run in flight (and the
 * next start) reserves its ceiling plus this margin.
 */
export const EVAL_BATCH_RESERVE_MARGIN = 1.1;
/** Ruling 4: run ends that provably used no model tokens, charged nothing when they report no cost. */
const NO_TOKEN_FAILURES: readonly RegExp[] = [/^the eval instance could not be (?:launched|recorded)\b/, /^the run could not start:/];

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
  return prices === undefined ? undefined : runCostFromPrices(prices);
}

/** The reference mix priced at these list prices, in USD per million tokens; undefined when nothing is priced. */
export function runCostFromPrices(prices: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | undefined {
  if (prices.input <= 0 && prices.output <= 0) return undefined;
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
  const reservation = runReservationUsd(ceiling);
  if (file.costCapUsd < reservation) {
    throw agentXError("CONFIG_INVALID", `the cost cap of $${file.costCapUsd} is below one run's reservation of $${reservation} (its ceiling of $${ceiling} in this channel, plus 10%), so no run could start; raise the cap`);
  }
  // The run fields an image parses are known only for the current image, from the record its
  // release wrote (swebench-settings.ts); a run is never launched on an image whose fields are guessed.
  if (file.runnerImage !== undefined && file.runnerImage !== deployment.runnerImage) {
    throw agentXError("CONFIG_INVALID", `the runner image ${file.runnerImage} is not the current one, so its run features are not known; release it as the current runner image first, or pin the current runner image (${deployment.runnerImage})`);
  }
  const runnerImage = deployment.runnerImage;
  const runnerFeatures = [...deployment.runnerFeatures];
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

/** A batch the top-up could not fill: its top-up failed, or a run could not be started. */
export interface EvalBatchTopUpFailure { batchId: string; error: string }

/**
 * FR-006: fills each running batch's free slots. One batch's failure is logged and leaves the others
 * to fill; the failures are returned, so the tick can fail and its alarm see them (Ruling 14).
 * `maxStarts` bounds the starts of one call, so a runner's callback that tops up inline stays well
 * inside its 30-second timeout; the tick fills the rest.
 */
export async function topUpBatches(dependencies: EvalBatchDependencies, options: { maxStarts?: number } = {}): Promise<{ failures: EvalBatchTopUpFailure[] }> {
  const budget = { starts: options.maxStarts ?? Number.POSITIVE_INFINITY };
  const failures: EvalBatchTopUpFailure[] = [];
  for (const batchId of await activeBatchIds(dependencies)) {
    if (budget.starts <= 0) break;
    try {
      await topUpBatch(dependencies, batchId, budget, failures);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("eval_batch.top_up_failed", { batchId, error: message });
      failures.push({ batchId, error: message });
    }
  }
  return { failures };
}

async function topUpBatch(dependencies: EvalBatchDependencies, batchId: string, budget: { starts: number }, failures: EvalBatchTopUpFailure[]): Promise<void> {
  const stored = await readStored(dependencies, batchId);
  if (stored === undefined) {
    // An index item with no batch behind it.
    await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: activeKey(batchId) }));
    return;
  }
  // An ended batch stays listed until the tick has written its results (finalizeBatch).
  if (TERMINAL_BATCH.has(stored.record.status)) return;
  const deployment = await dependencies.deployment();
  if (deployment === undefined) {
    failures.push({ batchId, error: "eval runs are not installed in this deployment, so the batch cannot start its runs" });
    return;
  }
  await recoverStaleClaims(dependencies, stored);
  while (budget.starts > 0) {
    // The counter read only saves a pointless claim: the start takes its slot atomically.
    const free = await swebenchSlotsInUse(dependencies) < deployment.settings.maxConcurrentEvals;
    const claim = await mutate<{ index: number; attempt: number; claimedAt: string } | undefined>(dependencies, batchId, (draft, at) => {
      if (!free || draft.status !== "RUNNING") return none();
      const inFlight = inFlightCount(draft);
      if (inFlight >= (draft.file.concurrency ?? Number.POSITIVE_INFINITY) || !nextStartFits(draft, inFlight)) return none();
      const entry = draft.queue.find((candidate) => candidate.state === "QUEUED");
      if (entry === undefined) return none();
      entry.state = "STARTING";
      entry.claimedAt = at;
      return { value: { index: entry.index, attempt: entry.attempt, claimedAt: at }, write: true };
    });
    if (claim?.value === undefined) return;
    budget.starts -= 1;
    if (!await startClaimed(dependencies, claim.stored, claim.value, failures)) return;
  }
}

/** Starts a claimed entry's run; false when no run started and topping up should stop for now. */
async function startClaimed(dependencies: EvalBatchDependencies, stored: Stored, claim: { index: number; attempt: number; claimedAt: string }, failures: EvalBatchTopUpFailure[]): Promise<boolean> {
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
    // Ruling 5's margin is the batch's: the runner keeps the channel's ceiling.
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
      const message = error instanceof Error ? error.message : String(error);
      log("eval_batch.start_failed", { batchId: record.batchId, runId, error: message });
      failures.push({ batchId: record.batchId, error: `run ${runId} could not start: ${message}` });
      // A run the start recorded has ended FAILED (it could not be launched): its end is recorded,
      // and retried as the infrastructure's. Otherwise the claim is given back.
      const run = await readRun(dependencies, runId);
      // The claim's own timestamp: a slow start never gives back a newer claim on the entry.
      if (run !== undefined) await adopt(dependencies, record.batchId, claim, run);
      else await releaseClaim(dependencies, record.batchId, claim);
      return false;
    }
    if (started.outcome === "REFUSED") {
      // No free slot is the normal wait; any other refusal is a deployment fault that stalls the batch.
      if (started.reason !== "RUN_ACTIVE") {
        log("eval_batch.start_refused", { batchId: record.batchId, runId, reason: started.reason });
        failures.push({ batchId: record.batchId, error: `run ${runId} was refused: ${started.reason}` });
      }
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
 * FR-006 to FR-008, FR-010: a batch run has ended. Its charge is added to the batch's spend and a
 * measure row written for it, whatever its end. An infrastructure failure on the first attempt is
 * queued again as attempt 2, under a new run ID, and its row says RETRIED; a graded run is never
 * queued again. Repeating it changes nothing, and writes a row that was lost.
 *
 * Ruling 4: a run that reported no cost is charged the per-run ceiling the runner enforces, unless
 * its end provably used no tokens (it was never launched or started, or was cancelled before the
 * runner started), so a run with an unknown cost can never take the batch past its cap.
 */
export async function recordBatchRunEnd(dependencies: EvalBatchDependencies, run: SwebenchRun): Promise<void> {
  if (run.batchId === undefined || !SWEBENCH_TERMINAL_STATUSES.has(run.status)) return;
  const batchId = run.batchId;
  const ended = await mutate<RecordedEnd | undefined>(dependencies, batchId, (draft) => {
    const entry = draft.queue.find((candidate) => IN_FLIGHT.has(candidate.state) && evalBatchRunId(batchId, candidate.index, candidate.attempt) === run.runId);
    const charge = chargeOf(run, draft.perRunCeilingUsd ?? draft.file.costCapUsd);
    if (entry === undefined) return { value: recordedEnd(draft, run, charge), write: false };
    draft.spentUsd = roundUsd(draft.spentUsd + charge.chargedUsd);
    delete entry.claimedAt;
    const attempt = entry.attempt;
    if (run.status === "FAILED" && attempt === 1 && draft.status === "RUNNING" && isInfrastructureFailure(run.error)) {
      const snapshot = structuredClone(entry);
      entry.state = "QUEUED";
      entry.attempt = 2;
      delete entry.runId;
      return { value: { entry: snapshot, attempt, outcome: "RETRIED", charge }, write: true };
    }
    entry.state = run.status === "SUCCEEDED" ? "DONE" : run.status === "FAILED" ? "FAILED" : "CANCELLED";
    entry.runId = run.runId;
    return { value: { entry: structuredClone(entry), attempt, outcome: outcomeOf(run), charge }, write: true };
  });
  const end = ended?.value;
  if (end === undefined) return;
  await putMeasure(dependencies, measureOf(batchId, run, end));
}

type MeasureOutcome = EvalRunMeasure["outcome"];
interface Charge { costUsd: number | null; chargedUsd: number; costEstimated: boolean }
interface RecordedEnd { entry: EvalBatchEntry; attempt: number; outcome: MeasureOutcome; charge: Charge }

function outcomeOf(run: SwebenchRun): MeasureOutcome {
  return run.status === "SUCCEEDED" ? "GRADED" : run.status === "FAILED" ? "FAILED" : "CANCELLED";
}

/** A run end already recorded, so its row can be written again: an earlier attempt was RETRIED. */
function recordedEnd(record: EvalBatchRecord, run: SwebenchRun, charge: Charge): RecordedEnd | undefined {
  for (const entry of record.queue) {
    for (let attempt = 1; attempt <= entry.attempt; attempt += 1) {
      if (evalBatchRunId(record.batchId, entry.index, attempt) !== run.runId) continue;
      if (attempt < entry.attempt) return { entry: structuredClone(entry), attempt, outcome: "RETRIED", charge };
      if (entry.runId === run.runId && !IN_FLIGHT.has(entry.state)) return { entry: structuredClone(entry), attempt, outcome: outcomeOf(run), charge };
    }
  }
  return undefined;
}

/** Ruling 4: the run's reported cost; else 0 for an end that used no tokens; else the per-run ceiling, marked estimated. */
function chargeOf(run: SwebenchRun, ceiling: number): Charge {
  const reported = run.result?.usage.costUsd ?? run.usage?.costUsd ?? null;
  // Ruling 17: rounded once, as spend is, so the rows' charges sum exactly to the spend. The row
  // keeps the reported cost as it came.
  if (reported !== null) return { costUsd: reported, chargedUsd: roundUsd(reported), costEstimated: false };
  const usedNoTokens = (run.status === "CANCELLED" && run.runnerStartedAt === undefined)
    || (run.status === "FAILED" && NO_TOKEN_FAILURES.some((pattern) => pattern.test(run.error ?? "")));
  if (usedNoTokens) return { costUsd: 0, chargedUsd: 0, costEstimated: false };
  return { costUsd: null, chargedUsd: ceiling, costEstimated: true };
}

function measureOf(batchId: string, run: SwebenchRun, end: RecordedEnd): EvalRunMeasure {
  const { entry, charge } = end;
  const result = run.status === "SUCCEEDED" ? run.result : undefined;
  const tokens = result?.usage.tokens ?? run.usage?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return EvalRunMeasureSchema.parse({
    batchId,
    runId: run.runId,
    instanceId: run.instanceId,
    provider: entry.model.provider,
    modelId: entry.model.modelId,
    thinkingLevel: entry.model.thinkingLevel,
    ...(entry.model.routing === undefined ? {} : { routing: entry.model.routing }),
    repeat: entry.repeat,
    attempt: end.attempt,
    outcome: end.outcome,
    ...(end.outcome === "GRADED" && result !== undefined ? { resolved: result.resolved } : {}),
    ...(end.outcome !== "GRADED" && run.error !== undefined ? { error: run.error } : {}),
    ...(result?.secbench === undefined ? {} : { secbench: result.secbench }),
    ...(result?.failToPass === undefined ? {} : { failToPass: result.failToPass }),
    ...(result?.passToPass === undefined ? {} : { passToPass: result.passToPass }),
    ...(result === undefined ? {} : { stopReason: result.stopReason }),
    agentSeconds: result?.agentSeconds ?? 0,
    tokens,
    costUsd: charge.costUsd,
    chargedUsd: charge.chargedUsd,
    ...(charge.costEstimated ? { costEstimated: true } : {}),
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
    // An ended batch stays listed until its results are written; there is nothing left to stop.
    const current = await getBatch(dependencies, item.batchId);
    if (current === undefined || TERMINAL_BATCH.has(current.status)) continue;
    if (await stopBatch(dependencies, item.batchId, requester) !== undefined) first ??= item.batchId;
  }
  return first;
}

// --- The tick's work on one batch ------------------------------------------------------------------

/**
 * FR-006: records the ends of the batch's runs that the state machine ended (time limit, instance
 * lost, cancel) without the runner's callback, which is the broker's only other way to hear of them.
 * Returns how many it recorded.
 */
export async function recordMissedRunEnds(dependencies: EvalBatchDependencies, batchId: string): Promise<number> {
  const record = await getBatch(dependencies, batchId);
  if (record === undefined) return 0;
  let recorded = 0;
  for (const entry of record.queue) {
    if (!IN_FLIGHT.has(entry.state)) continue;
    const run = await readRun(dependencies, entry.runId ?? evalBatchRunId(batchId, entry.index, entry.attempt));
    if (run === undefined || !SWEBENCH_TERMINAL_STATUSES.has(run.status)) continue;
    log("eval_batch.missed_end", { batchId, runId: run.runId, status: run.status });
    await recordBatchRunEnd(dependencies, run);
    recorded += 1;
  }
  return recorded;
}

/**
 * Ruling 8: rebuilds every terminal row the batch should have and does not, from its record and its
 * runs' records. A crash between a write of the record and the write of its row loses the row; this
 * writes it again, keyed by its run ID (which names the entry and the attempt), with the charge the
 * record's spend already holds (Ruling 4), so the rows' charges still sum to the spend. The rows:
 * an attempt that was retried (RETRIED), the entry's last attempt once its run has ended, and a
 * retry that never started (Ruling 7). An attempt that never ran, or is still running, has none.
 * Returns how many it rebuilt.
 */
export async function reconcileBatchRows(dependencies: EvalBatchDependencies, batchId: string): Promise<number> {
  return (await rebuildRows(dependencies, batchId)).rebuilt;
}

/** Ruling 8's rebuild; `unrecoverable` names the rows it could not rebuild, since their runs are missing or not ended. */
async function rebuildRows(dependencies: EvalBatchDependencies, batchId: string): Promise<{ rebuilt: number; unrecoverable: string[] }> {
  const unrecoverable: string[] = [];
  const record = await getBatch(dependencies, batchId);
  if (record === undefined) return { rebuilt: 0, unrecoverable };
  const written = new Set((await listBatchMeasures(dependencies, batchId)).map((measure) => measure.runId));
  let rebuilt = 0;
  for (const entry of record.queue) {
    for (let attempt = 1; attempt <= entry.attempt; attempt += 1) {
      const runId = evalBatchRunId(batchId, entry.index, attempt);
      if (written.has(runId)) continue;
      const last = attempt === entry.attempt;
      if (last && (entry.state === "QUEUED" || IN_FLIGHT.has(entry.state))) continue;
      if (last && entry.runId === undefined) {
        if (!isUnstartedRetry(entry)) continue;
        await putMeasure(dependencies, unstartedRetryMeasure(batchId, entry));
      } else {
        const run = await readRun(dependencies, runId);
        if (run === undefined || !SWEBENCH_TERMINAL_STATUSES.has(run.status)) {
          log("eval_batch.row_unrecoverable", { batchId, runId, index: entry.index, attempt, status: run?.status ?? null });
          unrecoverable.push(runId);
          continue;
        }
        await recordBatchRunEnd(dependencies, run);
      }
      log("eval_batch.row_rebuilt", { batchId, runId, index: entry.index, attempt });
      rebuilt += 1;
    }
  }
  return { rebuilt, unrecoverable };
}

/** Where a batch's results are written in the artifact bucket (FR-010). */
export function evalBatchResultsKeys(batchId: string): { csv: string; summary: string } {
  return { csv: `evals/batches/${batchId}/results.csv`, summary: `evals/batches/${batchId}/summary.json` };
}

/**
 * FR-010: once a batch has ended, rebuilds its lost rows (Ruling 8), writes results.csv and
 * summary.json, and takes it off the active list. Until the last step succeeds the batch stays
 * listed, so the next tick does it all again and writes the same files. `finalized` is false while
 * the batch has not ended.
 *
 * Ruling 14: a row that cannot be rebuilt, or rows whose charges do not sum to the spend, mean the
 * results are wrong. The files are still written, but the batch stays listed and this throws, so
 * every tick fails and the alarm fires until an operator resolves it (and removes the
 * `EVAL_BATCHES#ACTIVE` item by hand if the results are to stand).
 */
export async function finalizeBatch(dependencies: EvalBatchDependencies, batchId: string): Promise<{ finalized: boolean; rowsRebuilt: number }> {
  const record = await getBatch(dependencies, batchId);
  if (record === undefined || !TERMINAL_BATCH.has(record.status)) return { finalized: false, rowsRebuilt: 0 };
  const { rebuilt: rowsRebuilt, unrecoverable } = await rebuildRows(dependencies, batchId);
  const measures = orderedMeasures(record, await listBatchMeasures(dependencies, batchId));
  const charged = roundUsd(measures.reduce((sum, measure) => sum + measure.chargedUsd, 0));
  const problems: string[] = [];
  if (unrecoverable.length > 0) problems.push(`the rows of runs ${unrecoverable.join(", ")} are lost and cannot be rebuilt`);
  if (Math.abs(charged - record.spentUsd) > 1e-6) {
    log("eval_batch.charges_differ_from_spend", { batchId, chargedUsd: charged, spentUsd: record.spentUsd });
    problems.push(`the rows charge $${charged} but the batch spent $${record.spentUsd}`);
  }
  const keys = evalBatchResultsKeys(batchId);
  await dependencies.s3.send(new PutObjectCommand({
    Bucket: dependencies.artifactBucketName,
    Key: keys.csv,
    Body: evalBatchResultsCsv(record, measures),
    ContentType: "text/csv; charset=utf-8",
  }));
  const summary = EvalBatchSummarySchema.parse({ batchId, models: summarize(measures) });
  await dependencies.s3.send(new PutObjectCommand({
    Bucket: dependencies.artifactBucketName,
    Key: keys.summary,
    Body: `${JSON.stringify(summary, null, 2)}\n`,
    ContentType: "application/json",
  }));
  if (problems.length > 0) throw new Error(`batch ${batchId}'s results are incomplete: ${problems.join("; ")}`);
  await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: activeKey(batchId) }));
  log("eval_batch.results_written", { batchId, status: record.status, rows: measures.length, rowsRebuilt, spentUsd: record.spentUsd });
  return { finalized: true, rowsRebuilt };
}

/** results.csv's columns, in order (FR-010). */
export const EVAL_BATCH_RESULTS_COLUMNS = [
  "batchId", "runId", "instanceId", "provider", "modelId", "thinkingLevel", "routing", "repeat", "attempt", "outcome",
  "resolved", "error", "secbenchStrict", "secbenchMedium", "secbenchGenerous", "secbenchFailedStep",
  "failToPassPassed", "failToPassTotal", "passToPassPassed", "passToPassTotal", "stopReason", "agentSeconds", "toolCalls",
  "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens",
  "costUsd", "chargedUsd", "costEstimated", "imageDigest", "claimCheck",
] as const;

/**
 * results.csv (RFC 4180): a header and one row per measure, in queue order then attempt, CRLF line
 * ends. A field with a comma, a double quote or a line break is quoted, with its quotes doubled. An
 * absent value is empty; a pin's providers are joined with `|`; claim-check fields are JSON.
 */
export function evalBatchResultsCsv(record: EvalBatchRecord, measures: readonly EvalRunMeasure[]): string {
  const rows = orderedMeasures(record, measures).map((measure) => {
    const values: Record<(typeof EVAL_BATCH_RESULTS_COLUMNS)[number], CsvValue> = {
      batchId: measure.batchId,
      runId: measure.runId,
      instanceId: measure.instanceId,
      provider: measure.provider,
      modelId: measure.modelId,
      thinkingLevel: measure.thinkingLevel,
      routing: measure.routing?.only.join("|"),
      repeat: measure.repeat,
      attempt: measure.attempt,
      outcome: measure.outcome,
      resolved: measure.resolved,
      error: measure.error,
      secbenchStrict: measure.secbench?.strict,
      secbenchMedium: measure.secbench?.medium,
      secbenchGenerous: measure.secbench?.generous,
      secbenchFailedStep: measure.secbench?.failedStep,
      failToPassPassed: measure.failToPass?.passed,
      failToPassTotal: measure.failToPass?.total,
      passToPassPassed: measure.passToPass?.passed,
      passToPassTotal: measure.passToPass?.total,
      stopReason: measure.stopReason,
      agentSeconds: measure.agentSeconds,
      toolCalls: measure.toolCalls,
      inputTokens: measure.tokens.input,
      outputTokens: measure.tokens.output,
      cacheReadTokens: measure.tokens.cacheRead,
      cacheWriteTokens: measure.tokens.cacheWrite,
      totalTokens: measure.tokens.total,
      costUsd: measure.costUsd,
      chargedUsd: measure.chargedUsd,
      costEstimated: measure.costEstimated === true,
      imageDigest: measure.imageDigest,
      claimCheck: measure.claimCheck === undefined ? undefined : JSON.stringify(measure.claimCheck),
    };
    return EVAL_BATCH_RESULTS_COLUMNS.map((column) => csvField(values[column]));
  });
  return [[...EVAL_BATCH_RESULTS_COLUMNS], ...rows].map((fields) => `${fields.join(",")}\r\n`).join("");
}

type CsvValue = string | number | boolean | null | undefined;

function csvField(value: CsvValue): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

/** Rows in queue order, then attempt; a row no entry names (none should) goes last, by run ID. */
function orderedMeasures(record: EvalBatchRecord, measures: readonly EvalRunMeasure[]): EvalRunMeasure[] {
  const position = new Map<string, number>();
  for (const entry of record.queue) {
    for (let attempt = 1; attempt <= entry.attempt; attempt += 1) position.set(evalBatchRunId(record.batchId, entry.index, attempt), entry.index * 2 + attempt);
  }
  const at = (measure: EvalRunMeasure) => position.get(measure.runId) ?? Number.POSITIVE_INFINITY;
  return [...measures].sort((left, right) => at(left) - at(right) || left.runId.localeCompare(right.runId));
}

/**
 * The single-run module's hooks, bound to these dependencies: a stop stops the thread's batch, and
 * a run's end is recorded in its batch and the freed slot filled. Hooks already given are kept.
 */
export function withEvalBatches<T extends EvalBatchDependencies>(dependencies: T): T {
  const wired: T = { ...dependencies };
  wired.stopBatchForThread ??= (thread, requester) => stopBatchForThread(wired, thread, requester);
  // One slot was freed, so the callback starts at most one run; the tick fills anything else.
  wired.onRunEnded ??= async (run) => {
    await recordBatchRunEnd(wired, run);
    await topUpBatches(wired, { maxStarts: 1 });
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
    await writeUnstartedRetryRows(dependencies, stored.record, next);
    // The batch stays on the active list until the tick has rebuilt any lost row and written its
    // results (finalizeBatch, Ruling 8).
    if (TERMINAL_BATCH.has(next.status) && !TERMINAL_BATCH.has(stored.record.status)) {
      log("eval_batch.ended", { batchId, status: next.status, spentUsd: next.spentUsd, counts: next.counts });
    }
    return { record: next, value, stored: { ...stored, record: next } };
  }
}

/**
 * Ruling 7: a retry (attempt 2) that the cap or a stop kept from starting ends its entry's chain with
 * a FAILED row naming why, charged $0 for the attempt that never ran, so every entry's chain ends in
 * a terminal row and the rows' charges still sum to the spend. Written once, by the write that moved it.
 */
async function writeUnstartedRetryRows(dependencies: EvalBatchDependencies, before: EvalBatchRecord, after: EvalBatchRecord): Promise<void> {
  for (const entry of after.queue) {
    if (!isUnstartedRetry(entry)) continue;
    // Only the write that moved it there (from QUEUED, or from RUNNING in the same write that requeued it).
    if (before.queue.find((candidate) => candidate.index === entry.index)?.state === entry.state) continue;
    await putMeasure(dependencies, unstartedRetryMeasure(after.batchId, entry));
  }
}

/** A retry (attempt 2) that never got a run, now NOT_STARTED or CANCELLED: a retry that ran has its own row. */
function isUnstartedRetry(entry: EvalBatchEntry): boolean {
  return entry.attempt === 2 && entry.runId === undefined && (entry.state === "NOT_STARTED" || entry.state === "CANCELLED");
}

/** Ruling 7's row for a retry that never started: FAILED, charged $0, naming the cap or the stop. */
function unstartedRetryMeasure(batchId: string, entry: EvalBatchEntry): EvalRunMeasure {
  return EvalRunMeasureSchema.parse({
    batchId,
    runId: evalBatchRunId(batchId, entry.index, entry.attempt),
    instanceId: entry.task,
    provider: entry.model.provider,
    modelId: entry.model.modelId,
    thinkingLevel: entry.model.thinkingLevel,
    ...(entry.model.routing === undefined ? {} : { routing: entry.model.routing }),
    repeat: entry.repeat,
    attempt: entry.attempt,
    outcome: "FAILED",
    error: entry.state === "NOT_STARTED" ? "the retry did not start: the batch's cost cap was reached" : "the retry did not start: the batch was stopped",
    agentSeconds: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: 0,
    chargedUsd: 0,
    imageDigest: "",
  });
}

/** Writes a run end's row once: a row already written is left as it is. */
async function putMeasure(dependencies: EvalBatchDependencies, measure: EvalRunMeasure): Promise<void> {
  try {
    await dependencies.documentClient.send(new PutCommand({
      TableName: dependencies.tableName,
      Item: { ...measureKey(measure.batchId, measure.runId), entityType: "EVAL_BATCH_MEASURE", ...measure },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
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

/** FR-007 with Ruling 5: a start fits while spent + (inFlight + 1) × perRunCeiling × 1.1 ≤ costCapUsd. */
function nextStartFits(record: EvalBatchRecord, inFlight: number): boolean {
  const reservation = runReservationUsd(record.perRunCeilingUsd ?? record.file.costCapUsd);
  return record.spentUsd + (inFlight + 1) * reservation <= record.file.costCapUsd + 1e-9;
}

/** One run's reservation, rounded as spend is: the same figure for the create-time refusal and every start. */
function runReservationUsd(ceiling: number): number {
  return roundUsd(ceiling * EVAL_BATCH_RESERVE_MARGIN);
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

export async function activeBatchIds(dependencies: EvalBatchDependencies): Promise<string[]> {
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
