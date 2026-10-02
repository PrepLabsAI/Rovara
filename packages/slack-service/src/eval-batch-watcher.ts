// Spec 052 Task 6: the batch watcher. The broker cannot post to Slack, so the Slack service polls the
// broker's list of batches every 30 seconds and posts in each batch's thread: progress when its
// counts change (at most once per 5 minutes, plus once for each model that finishes), and the
// summary table once the batch has ended and its results are written (Ruling 11).
//
// What has been posted is kept on the batch record, through the broker, and each post is claimed
// there first, against the revision the watcher read: a restarted watcher posts nothing twice, and of
// two watchers that read the same state only one posts.
//
// A batch started from the CLI has a placeholder thread: the watcher opens a thread for it in the
// batch's channel with a start message, and records that thread before posting in it (Ruling 19).
// The opener is claimed before it is posted and its timestamp stored after, so a failed thread
// record retries the record, never the post (Ruling 24).
//
// What remains (Ruling 22, as reviewed): a claimed progress post whose Slack call fails is lost,
// with any "is done" line it carried; the next change posts again. A crash between a post and its
// record (the opener's timestamp, or the summary's) leaves the post unrecorded: once its claim is 10
// minutes old another pass posts it again. Within one process the timestamp is kept in memory, so a
// failed record is retried without posting again.
//
// Rulings 24 and 26: an ended batch Slack can never post for (a permanent error,
// PERMANENT_SLACK_ERRORS) is dropped from the watcher's list, logged as an error. A running batch is
// never dropped. After any other failure the batch is left alone for 10 minutes.
import type {
  EvalBatchModelSummary,
  EvalBatchThreadResult,
  EvalBatchWatchChange,
  EvalBatchWatched,
  EvalBatchWatchUpdateResult,
} from "@agentx/contracts";
import { batchStartMessage, modelLabel, usd } from "./eval-batch-command.js";
import { escapeText } from "./slack-format.js";

export const EVAL_BATCH_WATCH_POLL_MS = 30_000;
export const EVAL_BATCH_PROGRESS_INTERVAL_MS = 5 * 60_000;
/** An opener or summary claimed this long ago and still not recorded is taken over: its watcher stopped or its post failed. */
export const EVAL_BATCH_CLAIM_MS = 10 * 60_000;
/** Ruling 24: after a failure, a batch's next attempt waits at least this long. */
export const EVAL_BATCH_FAILURE_BACKOFF_MS = 10 * 60_000;

/**
 * Rulings 24 and 26: Slack errors no retry can fix for this batch's channel: the channel is gone or
 * archived, or the workspace no longer grants access. `not_in_channel` and `restricted_action` are
 * not here, since an admin can fix them, nor is a token or rate error, which is the deployment's.
 * Even these drop only an ended batch; a running one is backed off.
 */
export const PERMANENT_SLACK_ERRORS: readonly string[] = ["channel_not_found", "is_archived", "channel_is_archived", "team_access_not_granted"];

/**
 * A Slack Web API answer with `ok: false`, carrying Slack's error code. Its message and name are the
 * ones the service's posts always threw, so the processor's refusal check and logs are unchanged.
 */
export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string) {
    super(`Slack ${method} failed: ${code}`);
  }
}

export interface EvalBatchWatchList {
  batches: EvalBatchWatched[];
  dropped?: Array<{ batchId: string; reason: string }> | undefined;
}

export interface EvalBatchWatchApi {
  listBatches: () => Promise<EvalBatchWatchList>;
  /** Records the thread opened for a batch whose record names a placeholder; `recorded` is false when another thread is recorded. */
  recordThread: (batch: EvalBatchWatched, threadTs: string) => Promise<EvalBatchThreadResult>;
  /** Records a post (or a claim on one), only if the watch state is still at `revision`. */
  updateWatch: (batch: EvalBatchWatched, revision: number, change: EvalBatchWatchChange) => Promise<EvalBatchWatchUpdateResult>;
  /** Ruling 24: gives up on the batch's thread for good. */
  dropWatch: (batch: EvalBatchWatched, reason: string) => Promise<{ dropped: boolean }>;
}

export interface EvalBatchSlack {
  /** Posts in the thread, or with no thread a new message in the channel; answers the message's timestamp. */
  post(channelId: string, threadTs: string | undefined, text: string): Promise<string>;
  delete(channelId: string, ts: string): Promise<void>;
}

type Log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;

/** What one watcher process remembers between passes: back-offs, and posts made but not yet recorded. */
export interface EvalBatchWatcherState {
  retryAt: Map<string, number>;
  openers: Map<string, string>;
  summaries: Map<string, string>;
}

export function createEvalBatchWatcherState(): EvalBatchWatcherState {
  return { retryAt: new Map(), openers: new Map(), summaries: new Map() };
}

export interface EvalBatchWatcherDependencies {
  api: EvalBatchWatchApi;
  slack: EvalBatchSlack;
  now?: () => number;
  log?: Log;
  /** Failures: a batch the watcher could not post for, or a list it could not read. */
  logError: Log;
  /** Kept across passes by runEvalBatchWatcher; a pass without it remembers nothing. */
  state?: EvalBatchWatcherState;
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
  const watching = { ...dependencies, state: dependencies.state ?? createEvalBatchWatcherState() };
  while (!dependencies.signal.aborted) {
    await watchEvalBatchesOnce(watching);
    if (dependencies.signal.aborted) break;
    await sleep(dependencies.intervalMilliseconds ?? EVAL_BATCH_WATCH_POLL_MS, dependencies.signal);
  }
}

/** One pass over the broker's batches; one batch's failure is logged and the others still get their posts. */
export async function watchEvalBatchesOnce(dependencies: EvalBatchWatcherDependencies): Promise<void> {
  const state = dependencies.state ?? createEvalBatchWatcherState();
  let list: EvalBatchWatchList;
  try {
    list = await dependencies.api.listBatches();
  } catch (error) {
    dependencies.logError("eval_batch_watch.list_failed", { error: errorMessage(error) });
    return;
  }
  for (const { batchId, reason } of list.dropped ?? []) {
    dependencies.logError("eval_batch_watch.dropped", { batchId, reason });
    forget(state, batchId);
  }
  for (const listed of list.batches) {
    const now = dependencies.now?.() ?? Date.now();
    const retryAt = state.retryAt.get(listed.batchId);
    if (retryAt !== undefined && now < retryAt) continue;
    // The batch as this pass last knew it: its thread once opened.
    const current = { batch: listed };
    try {
      await watchBatch(dependencies, state, current, now);
      state.retryAt.delete(listed.batchId);
    } catch (error) {
      if (error instanceof SlackApiError && PERMANENT_SLACK_ERRORS.includes(error.code) && TERMINAL.has(current.batch.status)) {
        const reason = `slack:${error.code}`;
        try {
          await dependencies.api.dropWatch(current.batch, reason);
          dependencies.logError("eval_batch_watch.dropped", { batchId: listed.batchId, reason });
          forget(state, listed.batchId);
          continue;
        } catch (dropError) {
          dependencies.logError("eval_batch_watch.drop_failed", { batchId: listed.batchId, reason, error: errorMessage(dropError) });
        }
      } else {
        dependencies.logError("eval_batch_watch.batch_failed", { batchId: listed.batchId, error: errorMessage(error) });
      }
      state.retryAt.set(listed.batchId, now + EVAL_BATCH_FAILURE_BACKOFF_MS);
    }
  }
}

function forget(state: EvalBatchWatcherState, batchId: string): void {
  state.retryAt.delete(batchId);
  state.openers.delete(batchId);
  state.summaries.delete(batchId);
}

async function watchBatch(dependencies: EvalBatchWatcherDependencies, state: EvalBatchWatcherState, current: { batch: EvalBatchWatched }, now: number): Promise<void> {
  if (isPlaceholderThreadTs(current.batch.thread.threadTs)) {
    const opened = await openThread(dependencies, state, current.batch, now);
    if (opened === undefined) return;
    current.batch = { ...current.batch, thread: opened.thread, watch: opened.watch };
  }
  const { batch } = current;
  if (TERMINAL.has(batch.status)) {
    await postSummary(dependencies, state, batch, now);
    return;
  }
  await postProgress(dependencies, batch, now);
}

/**
 * Ruling 19: posts the start message in the batch's channel and records its thread; undefined when
 * another watcher holds the opener or its thread won. Ruling 24: the opener is claimed first, and
 * its timestamp stored on the record (and in memory) before the thread is recorded, so a failed
 * record is retried with the same opener.
 */
async function openThread(
  dependencies: EvalBatchWatcherDependencies,
  state: EvalBatchWatcherState,
  batch: EvalBatchWatched,
  now: number,
): Promise<{ thread: EvalBatchWatched["thread"]; watch: EvalBatchWatched["watch"] } | undefined> {
  const { channelId } = batch.thread;
  let { watch } = batch;
  let threadTs = watch.openerTs ?? state.openers.get(batch.batchId);
  if (threadTs === undefined) {
    if (watch.openerClaimedAt !== undefined && now - Date.parse(watch.openerClaimedAt) < EVAL_BATCH_CLAIM_MS) return undefined;
    const claimed = await dependencies.api.updateWatch(batch, watch.revision, { openerClaimedAt: new Date(now).toISOString() });
    if (!claimed.updated) return undefined;
    watch = claimed.watch;
    threadTs = await dependencies.slack.post(channelId, undefined, batchStartMessage(batch, "cli"));
    state.openers.set(batch.batchId, threadTs);
    try {
      const stored = await dependencies.api.updateWatch(batch, watch.revision, { openerTs: threadTs });
      if (stored.updated) watch = stored.watch;
    } catch (error) {
      // Kept in memory: this process records the same opener on its next pass.
      dependencies.logError("eval_batch_watch.opener_store_failed", { batchId: batch.batchId, threadTs, error: errorMessage(error) });
    }
  }
  const result = await dependencies.api.recordThread(batch, threadTs);
  state.openers.delete(batch.batchId);
  // A repeated record of this opener (the first answer was lost) finds it recorded.
  if (result.recorded || result.thread.threadTs === threadTs) {
    dependencies.log?.("eval_batch_watch.thread_opened", { batchId: batch.batchId, threadTs });
    return { thread: result.thread, watch };
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

/** Claim, post, then record the summary with its timestamp; a post this process made but could not record is recorded, not posted again. */
async function postSummary(dependencies: EvalBatchWatcherDependencies, state: EvalBatchWatcherState, batch: EvalBatchWatched, now: number): Promise<void> {
  const { watch } = batch;
  if (watch.summaryPostedAt !== undefined) {
    state.summaries.delete(batch.batchId);
    return;
  }
  let summaryTs = state.summaries.get(batch.batchId);
  let revision = watch.revision;
  if (summaryTs === undefined) {
    if (!batch.resultsWritten || batch.summary === undefined) return;
    if (watch.summaryClaimedAt !== undefined && now - Date.parse(watch.summaryClaimedAt) < EVAL_BATCH_CLAIM_MS) return;
    const claimed = await dependencies.api.updateWatch(batch, revision, { summaryClaimedAt: new Date(now).toISOString() });
    if (!claimed.updated) return;
    revision = claimed.watch.revision;
    summaryTs = await inThread(dependencies, batch, summaryMessage(batch));
    state.summaries.set(batch.batchId, summaryTs);
  }
  const posted = await dependencies.api.updateWatch(batch, revision, { summaryPostedAt: new Date(now).toISOString(), summaryTs });
  if (posted.updated || posted.watch.summaryPostedAt !== undefined) {
    state.summaries.delete(batch.batchId);
    return;
  }
  // Another write came first; the next pass records it against the newer revision.
  dependencies.logError("eval_batch_watch.summary_record_failed", { batchId: batch.batchId });
}

/** Never with a placeholder: a CLI batch's thread is opened and recorded first. */
async function inThread(dependencies: EvalBatchWatcherDependencies, batch: EvalBatchWatched, text: string): Promise<string> {
  if (isPlaceholderThreadTs(batch.thread.threadTs)) throw new Error(`batch ${batch.batchId} has no Slack thread yet`);
  return dependencies.slack.post(batch.thread.channelId, batch.thread.threadTs, text);
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
    `Results: \`evals/batches/${batch.batchId}/results.csv\` in the artifact bucket; \`agentx admin eval batch results ${batch.batchId} --csv <path>\` downloads it.`,
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
