// Spec 052 Task 6: the batch watcher. The broker cannot post to Slack, so the Slack service polls the
// broker's list of batches every 30 seconds and posts in each batch's thread: progress when its
// counts change (at most once per 5 minutes, plus once for each model that finishes), and the
// summary table once the batch has ended and its results are written (Ruling 11).
//
// What has been posted is kept on the batch record, through the broker, and each post is claimed
// there first, against the revision the watcher read: a restarted watcher posts nothing twice, and of
// two watchers that read the same state only one posts. A post whose claim succeeded but whose
// Slack call failed is lost for progress (the next change posts again); a summary claim expires
// after 10 minutes, so another pass posts the summary then.
//
// A batch started from the CLI has a placeholder thread: the watcher opens a thread for it in the
// batch's channel with a start message, and records that thread before posting in it (Ruling 19).
import type { EvalBatchThreadResult, EvalBatchWatchChange, EvalBatchWatched, EvalBatchWatchUpdateResult, EvalBatchModelSummary } from "@agentx/contracts";
import { batchStartMessage, modelLabel, usd } from "./eval-batch-command.js";
import { escapeText } from "./slack-format.js";

export const EVAL_BATCH_WATCH_POLL_MS = 30_000;
export const EVAL_BATCH_PROGRESS_INTERVAL_MS = 5 * 60_000;
/** A summary claimed this long ago and still not posted is taken over: its watcher stopped or its post failed. */
export const EVAL_BATCH_SUMMARY_CLAIM_MS = 10 * 60_000;

export interface EvalBatchWatchApi {
  listBatches: () => Promise<EvalBatchWatched[]>;
  /** Records the thread opened for a batch whose record names a placeholder; `recorded` is false when another thread is recorded. */
  recordThread: (batch: EvalBatchWatched, threadTs: string) => Promise<EvalBatchThreadResult>;
  /** Records a post (or a claim on one), only if the watch state is still at `revision`. */
  updateWatch: (batch: EvalBatchWatched, revision: number, change: EvalBatchWatchChange) => Promise<EvalBatchWatchUpdateResult>;
}

export interface EvalBatchSlack {
  /** Posts in the thread, or with no thread a new message in the channel; answers the message's timestamp. */
  post(channelId: string, threadTs: string | undefined, text: string): Promise<string>;
  delete(channelId: string, ts: string): Promise<void>;
}

type Log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;

export interface EvalBatchWatcherDependencies {
  api: EvalBatchWatchApi;
  slack: EvalBatchSlack;
  now?: () => number;
  log?: Log;
  /** Failures: a batch the watcher could not post for, or a list it could not read. */
  logError: Log;
}

const TERMINAL = new Set<EvalBatchWatched["status"]>(["DONE", "STOPPED", "CAPPED"]);

/** Placeholders begin with 00, real Slack timestamps with 1 (eval-batch-admin.ts). */
function isPlaceholderThreadTs(threadTs: string): boolean {
  return threadTs.startsWith("00");
}

/** Polls every 30 seconds until the signal aborts. Never throws: every failure is logged as an error. */
export async function runEvalBatchWatcher(dependencies: EvalBatchWatcherDependencies & {
  signal: AbortSignal;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  intervalMilliseconds?: number;
}): Promise<void> {
  const sleep = dependencies.sleep ?? abortableSleep;
  while (!dependencies.signal.aborted) {
    await watchEvalBatchesOnce(dependencies);
    if (dependencies.signal.aborted) break;
    await sleep(dependencies.intervalMilliseconds ?? EVAL_BATCH_WATCH_POLL_MS, dependencies.signal);
  }
}

/** One pass over the broker's batches; one batch's failure is logged and the others still get their posts. */
export async function watchEvalBatchesOnce(dependencies: EvalBatchWatcherDependencies): Promise<void> {
  let batches: EvalBatchWatched[];
  try {
    batches = await dependencies.api.listBatches();
  } catch (error) {
    dependencies.logError("eval_batch_watch.list_failed", { error: errorMessage(error) });
    return;
  }
  for (const batch of batches) {
    try {
      await watchBatch(dependencies, batch);
    } catch (error) {
      dependencies.logError("eval_batch_watch.batch_failed", { batchId: batch.batchId, error: errorMessage(error) });
    }
  }
}

async function watchBatch(dependencies: EvalBatchWatcherDependencies, listed: EvalBatchWatched): Promise<void> {
  let batch = listed;
  if (isPlaceholderThreadTs(batch.thread.threadTs)) {
    const opened = await openThread(dependencies, batch);
    if (opened === undefined) return;
    batch = { ...batch, thread: opened };
  }
  const now = dependencies.now?.() ?? Date.now();
  if (TERMINAL.has(batch.status)) {
    await postSummary(dependencies, batch, now);
    return;
  }
  await postProgress(dependencies, batch, now);
}

/** Ruling 19: posts the start message in the batch's channel and records its thread; undefined when another watcher's thread won. */
async function openThread(dependencies: EvalBatchWatcherDependencies, batch: EvalBatchWatched): Promise<EvalBatchWatched["thread"] | undefined> {
  const { channelId } = batch.thread;
  const threadTs = await dependencies.slack.post(channelId, undefined, batchStartMessage(batch, "cli"));
  const result = await dependencies.api.recordThread(batch, threadTs);
  if (result.recorded) {
    dependencies.log?.("eval_batch_watch.thread_opened", { batchId: batch.batchId, threadTs });
    return result.thread;
  }
  // Another watcher opened the batch's thread first: this opener is removed, so the channel shows one.
  dependencies.log?.("eval_batch_watch.thread_lost_race", { batchId: batch.batchId, threadTs, recorded: result.thread.threadTs });
  try {
    await dependencies.slack.delete(channelId, threadTs);
  } catch (error) {
    dependencies.logError("eval_batch_watch.opener_delete_failed", { batchId: batch.batchId, threadTs, error: errorMessage(error) });
  }
  return undefined;
}

async function postProgress(dependencies: EvalBatchWatcherDependencies, batch: EvalBatchWatched, now: number): Promise<void> {
  const { watch } = batch;
  if (batch.finished === (watch.progressFinished ?? 0) && batch.resolved === (watch.progressResolved ?? 0)) return;
  const announced = watch.modelsAnnounced ?? [];
  const newlyEnded = batch.models.flatMap((entry, index) => (entry.ended && !announced.includes(index) ? [index] : []));
  const last = watch.progressPostedAt === undefined ? undefined : Date.parse(watch.progressPostedAt);
  if (newlyEnded.length === 0 && last !== undefined && now - last < EVAL_BATCH_PROGRESS_INTERVAL_MS) return;
  const claimed = await dependencies.api.updateWatch(batch, watch.revision, {
    progressPostedAt: new Date(now).toISOString(),
    progressFinished: batch.finished,
    progressResolved: batch.resolved,
    modelsAnnounced: [...announced, ...newlyEnded],
  });
  if (!claimed.updated) return;
  await inThread(dependencies, batch, progressMessage(batch, newlyEnded));
}

async function postSummary(dependencies: EvalBatchWatcherDependencies, batch: EvalBatchWatched, now: number): Promise<void> {
  const { watch } = batch;
  if (watch.summaryPostedAt !== undefined || !batch.resultsWritten || batch.summary === undefined) return;
  if (watch.summaryClaimedAt !== undefined && now - Date.parse(watch.summaryClaimedAt) < EVAL_BATCH_SUMMARY_CLAIM_MS) return;
  const claimed = await dependencies.api.updateWatch(batch, watch.revision, { summaryClaimedAt: new Date(now).toISOString() });
  if (!claimed.updated) return;
  await inThread(dependencies, batch, summaryMessage(batch));
  const posted = await dependencies.api.updateWatch(batch, claimed.watch.revision, { summaryPostedAt: new Date(now).toISOString() });
  if (!posted.updated) dependencies.logError("eval_batch_watch.summary_record_failed", { batchId: batch.batchId });
}

/** Never with a placeholder: a CLI batch's thread is opened and recorded first. */
async function inThread(dependencies: EvalBatchWatcherDependencies, batch: EvalBatchWatched, text: string): Promise<void> {
  if (isPlaceholderThreadTs(batch.thread.threadTs)) throw new Error(`batch ${batch.batchId} has no Slack thread yet`);
  await dependencies.slack.post(batch.thread.channelId, batch.thread.threadTs, text);
}

/** "12/72 done, 7 resolved, $41.20 spent", and a line for each model that has just finished. */
export function progressMessage(batch: EvalBatchWatched, endedModels: readonly number[] = []): string {
  return [
    `Batch progress: ${batch.finished}/${batch.runs} done, ${batch.resolved} resolved, ${usd(batch.spentUsd)} spent of the ${usd(batch.costCapUsd)} cap.`,
    ...endedModels.map((index) => {
      const entry = batch.models[index]!;
      return `${modelLabel(entry.model)} is done: ${entry.finished} runs, ${entry.resolved} resolved.`;
    }),
  ].join("\n");
}

/** FR-010: the batch's end, its per-model table from summary.json, and where its CSV is. */
export function summaryMessage(batch: EvalBatchWatched): string {
  const totals = `${batch.finished}/${batch.runs} runs finished, ${batch.resolved} resolved, ${usd(batch.spentUsd)} spent of the ${usd(batch.costCapUsd)} cap`;
  const opening = batch.status === "STOPPED"
    ? `Eval batch \`${batch.batchId}\` was stopped: ${totals}.`
    : batch.status === "CAPPED"
      ? `Eval batch \`${batch.batchId}\` stopped at its cost cap: ${totals}; ${batch.notStarted} run${batch.notStarted === 1 ? "" : "s"} did not start.`
      : `Eval batch \`${batch.batchId}\` is done: ${totals}.`;
  const models = batch.summary?.models ?? [];
  const rows = [
    ["Model", "Graded", "Resolved", "Rate (95% CI)", "Failed", "Cost", "Per solved"],
    ...models.map((model) => [
      summaryModelName(model),
      String(model.runs),
      String(model.resolved),
      model.rate === null ? "-" : `${percent(model.rate)}% (${percent(model.wilsonLow ?? 0)}-${percent(model.wilsonHigh ?? 0)}%)`,
      String(model.failed),
      `${usd(model.totalCostUsd)}${model.unpricedRuns > 0 ? "*" : ""}`,
      model.costPerSolvedUsd === null ? "-" : usd(model.costPerSolvedUsd),
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const table = rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd());
  return [
    opening,
    ...(models.length === 0 ? ["No run has a result row, so there is no table."] : ["```", ...table, "```"]),
    ...(models.some((model) => model.unpricedRuns > 0) ? ["* includes runs that reported no cost, charged at their ceiling."] : []),
    `Results: \`evals/batches/${batch.batchId}/results.csv\` in the artifact bucket; \`agentx admin eval batch results ${batch.batchId} --csv\` downloads it.`,
  ].join("\n");
}

function summaryModelName(model: EvalBatchModelSummary): string {
  const name = `${model.provider}/${model.modelId}${model.thinkingLevel === undefined ? "" : ` ${model.thinkingLevel}`}${model.routing === undefined ? "" : ` via ${model.routing.only.join(", ")}`}`;
  return escapeText(name);
}

function percent(value: number): number {
  return Math.round(value * 100);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
