// Spec 052 Task 6: what the Slack service's eval batch routes do. The Slack form starts a batch in
// its thread (FR-002, FR-003). The batch watcher lists the batches it posts for, opens the thread of
// a batch started from the CLI (Ruling 19), and records what it has posted, so a restarted watcher
// posts nothing twice. The broker checks the Slack orchestrator role; this module checks that a
// batch is the caller's: in its channel (or thread) and of the project the channel serves.
import { createHash } from "node:crypto";
import { catalogModel } from "@agentx/model-runtime/catalog";
import {
  AgentXError,
  EVAL_BATCH_COST_CAP_MAX_USD,
  EVAL_BATCH_COST_CAP_MIN_USD,
  EVAL_BATCH_SLACK_MAX_RUNS,
  EvalBatchSlackStartRequestSchema,
  EvalBatchSummarySchema,
  EvalBatchThreadRequestSchema,
  EvalBatchWatchDropRequestSchema,
  EvalBatchWatchUpdateRequestSchema,
  agentXError,
  slackThreadSubject,
  type EvalBatchEntry,
  type EvalBatchModel,
  type EvalBatchRecord,
  type EvalBatchSlackStartRequest,
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
  dropBatchWatch,
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
import { isPlaceholderThreadTs, readObject } from "./eval-batch-admin.js";
import { getSwebenchChannel, type SwebenchSlackContext } from "./swebench.js";

const TERMINAL: ReadonlySet<EvalBatchRecord["status"]> = new Set(["DONE", "STOPPED", "CAPPED"]);
/** Ruling 24: a batch that ended this long ago and still has no summary posted is dropped from the watcher's list. */
export const EVAL_BATCH_WATCH_MAX_AGE_MS = 7 * 86_400_000;
const OPEN_ENTRY: ReadonlySet<EvalBatchEntry["state"]> = new Set(["QUEUED", "STARTING", "RUNNING"]);

/**
 * FR-002: the Slack form's batch, built as a batch file would be: the project's thinking level for
 * each model (else the runtime's own default for it), the deployment's OpenRouter providers for an
 * OpenRouter model, `cheapest-first`, the deployment's concurrency, and, with no cap given, enough
 * cap for every run's reservation. Ruling 23: its ID is derived from the form as received and the
 * thread, before any default is resolved, so a redelivered event finds the batch it created even
 * if the project's or the channel's settings changed meanwhile. FR-003 refusals are answered with
 * their reason, for the thread.
 */
export async function startSlackBatch(dependencies: EvalBatchDependencies, context: SwebenchSlackContext, value: unknown): Promise<EvalBatchSlackStartResult> {
  const request = EvalBatchSlackStartRequestSchema.parse(value);
  const batchId = slackFormBatchId(request, context.thread);
  const existing = await getBatch(dependencies, batchId);
  if (existing !== undefined) return { outcome: "STARTED", created: false, batch: await batchWatchView(dependencies, existing) };
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

/**
 * Ruling 23: the form as received (the dataset, the instances, the model names as typed, the repeats
 * and the cap if given) and its thread, hashed to a UUID. Model names are compared ignoring case and
 * spacing; nothing resolved from the project or the deployment is part of it.
 */
export function slackFormBatchId(request: EvalBatchSlackStartRequest, thread: SlackThread): string {
  const selectors = request.selectors.map((selector) => selector.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"));
  const form = [request.dataset, request.instanceIds, selectors, request.repeats ?? 1, request.costCapUsd ?? null];
  const bytes = createHash("sha256").update(JSON.stringify(["agentx eval batch slack v1", form, thread.teamId, thread.channelId, thread.threadTs])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

/** Records the list could not read, logged once per process rather than on every 30-second list. */
const reportedUnreadable = new Set<string>();
/** Ruling 26: running batches whose channel is unbound or rebound, logged once until they are listed again. */
const reportedUnavailable = new Set<string>();

/**
 * The batches the watcher posts for, from creation until their summary is posted. Ruling 24: an
 * ended batch whose channel was unbound or now serves another project, or that ended more than 7
 * days ago, is dropped from the list for good, logged as an error and named in `dropped` for the
 * watcher to log. Ruling 26: a batch that has not ended is never dropped; while its channel is
 * unbound or rebound it is left out and logged as an error once, and watched again once the channel
 * serves its project again.
 * One that cannot be read is logged as an error once and left out, so one broken record never hides
 * the others.
 */
export async function listWatchedBatches(
  dependencies: EvalBatchDependencies,
  channelProject: (teamId: string, channelId: string) => Promise<string | undefined>,
): Promise<{ batches: EvalBatchWatched[]; dropped: Array<{ batchId: string; reason: "channel_unbound" | "channel_moved" | "ended_over_7_days" }> }> {
  const batches: EvalBatchWatched[] = [];
  const dropped: Array<{ batchId: string; reason: "channel_unbound" | "channel_moved" | "ended_over_7_days" }> = [];
  const nowMs = (dependencies.now?.() ?? new Date()).getTime();
  for (const batchId of await watchedBatchIds(dependencies)) {
    try {
      const stored = await getBatchWithProject(dependencies, batchId);
      if (stored === undefined || stored.record.watch?.summaryPostedAt !== undefined || stored.record.watch?.droppedAt !== undefined) {
        // Its summary is posted or it was dropped (and taking it off the list failed then), or it is gone.
        await unwatchBatch(dependencies, batchId);
        continue;
      }
      const { record } = stored;
      const project = await channelProject(record.thread.teamId, record.thread.channelId);
      const ended = TERMINAL.has(record.status);
      const reason = project === undefined ? "channel_unbound"
        : project !== stored.projectName ? "channel_moved"
        : ended && record.finishedAt !== undefined && nowMs - Date.parse(record.finishedAt) > EVAL_BATCH_WATCH_MAX_AGE_MS ? "ended_over_7_days"
        : undefined;
      if (reason !== undefined && !ended) {
        if (!reportedUnavailable.has(batchId)) {
          reportedUnavailable.add(batchId);
          logError("eval_batch_watch.channel_unavailable", { batchId, reason, projectName: stored.projectName });
        }
        continue;
      }
      reportedUnavailable.delete(batchId);
      if (reason !== undefined) {
        await unwatchBatch(dependencies, batchId);
        logError("eval_batch_watch.dropped", { batchId, reason, projectName: stored.projectName });
        dropped.push({ batchId, reason });
        continue;
      }
      batches.push(await batchWatchView(dependencies, record));
    } catch (error) {
      if (!reportedUnreadable.has(batchId)) {
        reportedUnreadable.add(batchId);
        logError("eval_batch_watch.unreadable", { batchId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { batches, dropped };
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
    finished: record.queue.filter(ranAndEnded).length,
    resolved: resolvedRows.length,
    notStarted: record.counts.notStarted,
    spentUsd: record.spentUsd,
    models: record.file.models.map((model) => {
      const key = modelKey(model);
      const entries = record.queue.filter((entry) => modelKey(entry.model) === key);
      return {
        model,
        runs: entries.length,
        finished: entries.filter(ranAndEnded).length,
        resolved: resolvedRows.filter((measure) => measureKey(measure) === key).length,
        ended: !entries.some((entry) => OPEN_ENTRY.has(entry.state)),
      };
    }),
    watch: record.watch ?? { revision: 0 },
    resultsWritten,
    ...(summary === undefined ? {} : { summary }),
  };
}

/** An entry whose run ended: graded, failed, or cancelled after its run existed. An entry cancelled while queued never ran. */
function ranAndEnded(entry: EvalBatchEntry): boolean {
  return entry.state === "DONE" || entry.state === "FAILED" || (entry.state === "CANCELLED" && entry.runId !== undefined);
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
  const record = await requireInScope(dependencies, scope, batchId, "thread");
  // Ruling 26: only an ended batch's watch ends; a batch never leaves its ended status.
  if ((change.summaryPostedAt !== undefined || change.droppedAt !== undefined) && !TERMINAL.has(record.status)) {
    throw agentXError("CONFIG_INVALID", `batch ${batchId} has not ended (${record.status}), so its summary or drop cannot be recorded`);
  }
  const result = await updateBatchWatch(dependencies, batchId, revision, change);
  if (result === undefined) throw agentXError("NOT_FOUND", `batch ${batchId} not found`);
  return result;
}

/** Ruling 24: the watcher gave up on the batch's thread; from the batch's own thread. */
export async function dropWatchedBatch(dependencies: EvalBatchDependencies, scope: EvalBatchServiceScope, batchId: string, value: unknown) {
  const { reason } = EvalBatchWatchDropRequestSchema.parse(value);
  const record = await requireInScope(dependencies, scope, batchId, "thread");
  // Ruling 26: a batch that has not ended is never dropped.
  if (!TERMINAL.has(record.status)) throw agentXError("CONFIG_INVALID", `batch ${batchId} has not ended (${record.status}), so it cannot be dropped`);
  const result = await dropBatchWatch(dependencies, batchId, reason);
  if (result === undefined) throw agentXError("NOT_FOUND", `batch ${batchId} not found`);
  logError("eval_batch_watch.dropped", { batchId, reason });
  return result;
}

function logError(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ component: "broker", level: "error", event, ...fields }));
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ component: "broker", event, ...fields }));
}
