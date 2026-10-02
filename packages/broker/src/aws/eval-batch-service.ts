// Spec 052 Task 6: what the Slack service's eval batch routes do. The Slack form starts a batch in
// its thread (FR-002, FR-003). The batch watcher lists the batches it posts for, opens the thread of
// a batch started from the CLI (Ruling 19), and records what it has posted, so a restarted watcher
// posts nothing twice. The broker checks the Slack orchestrator role; this module checks that a
// batch is the caller's: in its channel (or thread) and of the project the channel serves.
import { catalogModel } from "@agentx/model-runtime/catalog";
import {
  AgentXError,
  EVAL_BATCH_COST_CAP_MAX_USD,
  EVAL_BATCH_COST_CAP_MIN_USD,
  EVAL_BATCH_SLACK_MAX_RUNS,
  EvalBatchSlackStartRequestSchema,
  EvalBatchSummarySchema,
  EvalBatchThreadRequestSchema,
  EvalBatchWatchUpdateRequestSchema,
  agentXError,
  slackThreadSubject,
  type EvalBatchEntry,
  type EvalBatchModel,
  type EvalBatchRecord,
  type EvalBatchSlackStartResult,
  type EvalBatchSummary,
  type EvalBatchWatched,
  type EvalRunMeasure,
  type ModelIdentifier,
  type SlackThread,
  type ThinkingLevel,
} from "@agentx/contracts";
import { ZodError } from "zod";
import {
  EVAL_BATCH_RESERVE_MARGIN,
  createBatch,
  evalBatchResultsKeys,
  getBatch,
  getBatchWithProject,
  isBatchActiveListed,
  listBatchMeasures,
  recordBatchThread,
  unwatchBatch,
  updateBatchWatch,
  watchedBatchIds,
  type EvalBatchDependencies,
} from "./eval-batch.js";
import { evalBatchIdFor, isPlaceholderThreadTs, readObject } from "./eval-batch-admin.js";
import { getSwebenchChannel, type SwebenchSlackContext } from "./swebench.js";

const TERMINAL: ReadonlySet<EvalBatchRecord["status"]> = new Set(["DONE", "STOPPED", "CAPPED"]);
const ENDED_ENTRY: ReadonlySet<EvalBatchEntry["state"]> = new Set(["DONE", "FAILED", "CANCELLED"]);
const OPEN_ENTRY: ReadonlySet<EvalBatchEntry["state"]> = new Set(["QUEUED", "STARTING", "RUNNING"]);

/**
 * FR-002: the Slack form's batch, built as a batch file would be: the project's thinking level for
 * each model (else the runtime's own default for it), the deployment's OpenRouter providers for an
 * OpenRouter model, `cheapest-first`, the deployment's concurrency, and, with no cap given, enough
 * cap for every run's reservation. Its ID is derived from the definition, the channel and the
 * thread, so a redelivered event finds the batch it created. FR-003 refusals are answered with
 * their reason, for the thread.
 */
export async function startSlackBatch(dependencies: EvalBatchDependencies, context: SwebenchSlackContext, value: unknown): Promise<EvalBatchSlackStartResult> {
  const request = EvalBatchSlackStartRequestSchema.parse(value);
  try {
    const runs = request.instanceIds.length * request.models.length * request.repeats;
    if (runs > EVAL_BATCH_SLACK_MAX_RUNS) return refused(`${runs} runs is more than the ${EVAL_BATCH_SLACK_MAX_RUNS} a Slack message may start; use a batch file for more.`);
    const deployment = await dependencies.deployment();
    if (deployment === undefined) return refused("Eval runs are not installed in this deployment. Ask an administrator to deploy the eval stack and runner image.");
    const channel = await getSwebenchChannel(dependencies, context.thread.teamId, context.thread.channelId);
    if (channel === undefined) return refused("Eval runs are not enabled in this channel. An administrator can enable them with `agentx admin eval enable`.");
    const providers = deployment.environment.AGENTX_OPENROUTER_PROVIDERS?.split(",").filter((slug) => slug.length > 0) ?? [];
    const models: EvalBatchModel[] = [];
    for (const requested of request.models) {
      const selection = await context.projectModel(requested);
      const thinkingLevel = selection?.thinkingLevel ?? runtimeThinkingLevel(requested);
      if (thinkingLevel === undefined) {
        return refused(`${requested.provider}/${requested.modelId} has no thinking level in the project's model settings, and the model catalog does not know it; set one in the project, or start the batch from a file`);
      }
      models.push({
        provider: requested.provider,
        modelId: requested.modelId,
        thinkingLevel,
        ...(requested.provider === "openrouter" && providers.length > 0 ? { routing: { only: providers } } : {}),
      });
    }
    const file = {
      benchmark: request.dataset,
      tasks: request.instanceIds,
      models,
      repeats: request.repeats,
      costCapUsd: request.costCapUsd ?? defaultCapUsd(runs, channel.maxCostUsd),
    };
    const batchId = evalBatchIdFor(file, context.thread.teamId, context.thread.channelId, `slack:${context.thread.threadTs}`);
    const existing = await getBatch(dependencies, batchId);
    if (existing !== undefined) return { outcome: "STARTED", created: false, batch: await batchWatchView(dependencies, existing) };
    const record = await createBatch(dependencies, context, file, { batchId });
    return { outcome: "STARTED", created: true, batch: await batchWatchView(dependencies, record) };
  } catch (error) {
    if (error instanceof ZodError) return refused(error.issues.map((issue) => issue.message).join("; "));
    if (error instanceof AgentXError && (error.code === "CONFIG_INVALID" || error.code === "IDEMPOTENCY_CONFLICT")) {
      return refused(error.message.slice(`${error.code}: `.length));
    }
    throw error;
  }
}

function refused(message: string): EvalBatchSlackStartResult {
  return { outcome: "REFUSED", message };
}

/** The level the runtime runs a model at when none is set (pi-session.ts): medium for a reasoning model, else off. */
function runtimeThinkingLevel(model: ModelIdentifier): ThinkingLevel | undefined {
  const known = catalogModel(model);
  if (known === undefined) return undefined;
  return known.reasoning ? "medium" : "off";
}

/** Every run's reservation (its ceiling plus 10%), in whole cents, within the allowed caps. */
function defaultCapUsd(runs: number, ceilingUsd: number): number {
  const reserved = Math.ceil(runs * ceilingUsd * EVAL_BATCH_RESERVE_MARGIN * 100 - 1e-6) / 100;
  return Math.min(EVAL_BATCH_COST_CAP_MAX_USD, Math.max(EVAL_BATCH_COST_CAP_MIN_USD, reserved));
}

/**
 * The batches the watcher posts for, from creation until their summary is posted. A batch whose
 * channel now serves another project is left out, and one that cannot be read is logged and left
 * out, so one broken record never hides the others.
 */
export async function listWatchedBatches(
  dependencies: EvalBatchDependencies,
  channelProject: (teamId: string, channelId: string) => Promise<string | undefined>,
): Promise<{ batches: EvalBatchWatched[] }> {
  const batches: EvalBatchWatched[] = [];
  for (const batchId of await watchedBatchIds(dependencies)) {
    try {
      const stored = await getBatchWithProject(dependencies, batchId);
      if (stored === undefined || stored.record.watch?.summaryPostedAt !== undefined) {
        // Its summary is posted (and taking it off the list failed then), or it is gone.
        await unwatchBatch(dependencies, batchId);
        continue;
      }
      const { thread } = stored.record;
      if (await channelProject(thread.teamId, thread.channelId) !== stored.projectName) {
        log("eval_batch_watch.channel_moved", { batchId, projectName: stored.projectName });
        continue;
      }
      batches.push(await batchWatchView(dependencies, stored.record));
    } catch (error) {
      log("eval_batch_watch.unreadable", { batchId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { batches };
}

/** A batch as the watcher and the start message see it. Ruling 11: it has ended by its status; its results are written once the tick took it off the active list. */
export async function batchWatchView(dependencies: EvalBatchDependencies, record: EvalBatchRecord): Promise<EvalBatchWatched> {
  const measures = await listBatchMeasures(dependencies, record.batchId);
  const resolvedRows = measures.filter((measure) => measure.outcome === "GRADED" && measure.resolved === true);
  let resultsWritten = TERMINAL.has(record.status) && !await isBatchActiveListed(dependencies, record.batchId);
  let summary: EvalBatchSummary | undefined;
  if (resultsWritten && record.watch?.summaryPostedAt === undefined) {
    const body = await readObject(dependencies, evalBatchResultsKeys(record.batchId).summary);
    if (body === undefined) {
      log("eval_batch_watch.summary_missing", { batchId: record.batchId });
      resultsWritten = false;
    } else {
      summary = EvalBatchSummarySchema.parse(JSON.parse(body));
    }
  }
  return {
    batchId: record.batchId,
    thread: record.thread,
    createdBy: record.createdBy,
    status: record.status,
    benchmark: record.file.benchmark,
    tasks: record.file.tasks?.length ?? record.file.sample?.count ?? 0,
    repeats: record.file.repeats,
    costCapUsd: record.file.costCapUsd,
    ...(record.perRunCeilingUsd === undefined ? {} : { perRunCeilingUsd: record.perRunCeilingUsd }),
    runs: record.queue.length,
    finished: record.queue.filter((entry) => ENDED_ENTRY.has(entry.state)).length,
    resolved: resolvedRows.length,
    notStarted: record.counts.notStarted,
    spentUsd: record.spentUsd,
    models: record.file.models.map((model) => {
      const key = modelKey(model);
      const entries = record.queue.filter((entry) => modelKey(entry.model) === key);
      return {
        model,
        runs: entries.length,
        finished: entries.filter((entry) => ENDED_ENTRY.has(entry.state)).length,
        resolved: resolvedRows.filter((measure) => measureKey(measure) === key).length,
        ended: !entries.some((entry) => OPEN_ENTRY.has(entry.state)),
      };
    }),
    watch: record.watch ?? { revision: 0 },
    resultsWritten,
    ...(summary === undefined ? {} : { summary }),
  };
}

function modelKey(model: EvalBatchModel): string {
  return JSON.stringify([model.provider, model.modelId, model.thinkingLevel, model.routing?.only ?? null]);
}

function measureKey(measure: EvalRunMeasure): string {
  return JSON.stringify([measure.provider, measure.modelId, measure.thinkingLevel, measure.routing?.only ?? null]);
}

/** The caller: the Slack thread it acts for, and the project that thread's channel serves. */
export interface EvalBatchServiceScope {
  thread: SlackThread;
  projectName: string;
}

/** The batch, if it is in the caller's channel (or, with `thread`, its very thread) and of the channel's project; else not found. */
async function requireInScope(dependencies: EvalBatchDependencies, scope: EvalBatchServiceScope, batchId: string, match: "channel" | "thread"): Promise<EvalBatchRecord> {
  const stored = await getBatchWithProject(dependencies, batchId);
  const thread = stored?.record.thread;
  const inScope = stored !== undefined && thread !== undefined
    && stored.projectName === scope.projectName
    && thread.teamId === scope.thread.teamId
    && thread.channelId === scope.thread.channelId
    && (match === "channel" || slackThreadSubject(thread) === slackThreadSubject(scope.thread));
  if (!inScope) throw agentXError("NOT_FOUND", `batch ${batchId} not found in this thread`);
  return stored.record;
}

/**
 * Ruling 19: records the thread the watcher opened for a CLI batch. The caller acts for the batch's
 * placeholder thread; once the batch has a real thread, every later caller is told which, and records nothing.
 */
export async function recordWatchedBatchThread(dependencies: EvalBatchDependencies, scope: EvalBatchServiceScope, batchId: string, value: unknown) {
  const { threadTs } = EvalBatchThreadRequestSchema.parse(value);
  if (isPlaceholderThreadTs(threadTs)) throw agentXError("CONFIG_INVALID", "a batch's thread must be a posted Slack message, not a placeholder");
  const record = await requireInScope(dependencies, scope, batchId, "channel");
  if (!isPlaceholderThreadTs(record.thread.threadTs)) return { recorded: false, thread: record.thread };
  if (record.thread.threadTs !== scope.thread.threadTs) throw agentXError("NOT_FOUND", `batch ${batchId} not found in this thread`);
  const result = await recordBatchThread(dependencies, batchId, scope.thread.threadTs, threadTs);
  if (result === undefined) throw agentXError("NOT_FOUND", `batch ${batchId} not found`);
  return result;
}

/** Records what the watcher posted in the batch's thread, against the revision it read. */
export async function updateWatchedBatch(dependencies: EvalBatchDependencies, scope: EvalBatchServiceScope, batchId: string, value: unknown) {
  const { revision, change } = EvalBatchWatchUpdateRequestSchema.parse(value);
  await requireInScope(dependencies, scope, batchId, "thread");
  const result = await updateBatchWatch(dependencies, batchId, revision, change);
  if (result === undefined) throw agentXError("NOT_FOUND", `batch ${batchId} not found`);
  return result;
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ component: "broker", event, ...fields }));
}
