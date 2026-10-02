// Issue 195: a cancel that never reaches the worker never holds a workspace for good. Stopping a
// task moves it to CANCEL_REQUESTED and queues a cancel operation; if that cancel is lost (its
// dispatch failed, or its worker is gone), the task stays CANCEL_REQUESTED and its workspace stays
// busy. Each reconciler run checks the workspaces it already lists:
// - a task CANCEL_REQUESTED over STUCK_CANCEL_MS whose compute is gone is ended as the lost-compute
//   path ends work, and its workspace freed;
// - one whose compute is alive has its cancel queued again, once, in the reconciler's own process
//   through the cancel route's requestCancellation: the retry is recorded on the operation first
//   (cancelRetriedAt), so a crash or a failed retry can never retry it twice;
// - a retried one still CANCEL_REQUESTED STUCK_CANCEL_RETRY_MS later is ended INTERRUPTED, and its
//   workspace freed.
// - issue 202: a task whose cancel failed, first or retried (the result marks it INTERRUPTED but
//   leaves it holding the workspace, as the worker may still run it), has its workspace freed only
//   on evidence that nothing runs there: at once when its compute is gone; when this run's ping
//   found the worker idle, FAILED_CANCEL_GRACE_MS after the cancel failed (STUCK_CANCEL_RETRY_MS
//   after the retry, for one this sweep retried); never while the worker answers busy, which is
//   logged and counted for the alarm once STUCK_CANCEL_RETRY_MS has passed, on every run. The
//   same rule holds for an AI tool's developer task. A Slack thread is told in plain words.
// A cancel operation for the task that is still live and changed within STUCK_CANCEL_MS counts as
// progressing, so a live worker's task is neither retried nor interrupted while it moves.
// Operations not CANCEL_REQUESTED, and cancels within their limit, are never touched. A task an AI
// tool started (a developer task) keeps today's lost-compute rule only: ended when its compute is
// gone, never retried or interrupted while its compute is alive.
//
// Every write is conditioned on the operation still being in the state read (CANCEL_REQUESTED, or
// for a release INTERRUPTED and not yet released) under the fence read, and on the workspace still
// being held by it, so a cancel result that lands first stands.
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, WorkspaceInstanceSchema, workspaceRecordFields } from "@agentx/contracts";
import { taskPointerKey } from "../developer/task-records.js";
import { getItem, requestCancellation, type CancellationDependencies } from "./cancellation.js";
import { releaseFailedPreparation } from "./failed-preparation.js";
import {
  FAILED_CANCEL_GRACE_MS,
  FAILED_CANCEL_RELEASED_MESSAGE,
  releaseFailedCancelWorkspace,
  releasedStatus,
  type FailedCancelReleaseReason,
} from "./failed-cancel-release.js";
import type { SlackThreadPlace } from "./unwaited-tasks.js";

export { FAILED_CANCEL_GRACE_MS, FAILED_CANCEL_RELEASED_MESSAGE } from "./failed-cancel-release.js";

type Client = { send(command: unknown): Promise<unknown> };

/** Owner decision, 2026-10-01: a cancel normally finishes in seconds. */
export const STUCK_CANCEL_MS = 30 * 60_000;
/** How long a re-queued cancel gets before the task is ended as interrupted. */
export const STUCK_CANCEL_RETRY_MS = 30 * 60_000;
export const STUCK_CANCEL_LOST_MESSAGE = "RUNTIME_UNAVAILABLE: workspace compute was lost before the cancel finished; the task was stopped";
export const STUCK_CANCEL_INTERRUPTED_MESSAGE = "the cancel did not reach the worker, even after a retry; the task was stopped and its workspace freed";

/** What the reconciler knows of a workspace's compute this run. "unknown": starting or stopping. */
export type StuckCancelCompute = "alive" | "gone" | "unknown";
/** Issue 202: a live worker's answer to this run's ping: idle (Healthy) or busy (HealthyBusy). */
export type StuckCancelWorker = "idle" | "busy";
/** `worker` only for alive compute whose ping answered this run. */
export interface StuckCancelCandidate { workspaceId: string; compute: StuckCancelCompute; worker?: StuckCancelWorker }

export type StuckCancelRetry =
  | { outcome: "REQUEUED"; cancelOperationId: string }
  | { outcome: "SKIPPED"; reason: string };

export interface StuckCancelDependencies {
  client: Client;
  tableName: string;
  /** Queues the cancel again (createCancelRetrier). Absent where the reconciler has no signing key (legacy). */
  retryCancel?: (workspaceId: string, operationId: string) => Promise<StuckCancelRetry>;
  /** Issue 202: tells a Slack thread its workspace is free again. Absent where the reconciler has no Slack token (legacy). */
  postNote?: (thread: SlackThreadPlace, text: string) => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
}

/** Operation IDs per action; `failed` also holds a workspace ID when its check failed before an operation was read. */
export interface StuckCancelSweepResult {
  retried: string[];
  ended: string[];
  interrupted: string[];
  /** Alive compute and no way to re-queue (legacy): logged and counted only. */
  unretried: string[];
  failed: string[];
}

interface StuckOperation {
  kind?: unknown;
  status?: unknown;
  fence?: unknown;
  updatedAt?: unknown;
  cancelRetriedAt?: unknown;
  closePreviousStatus?: unknown;
  error?: unknown;
}

export async function sweepStuckCancels(
  dependencies: StuckCancelDependencies,
  candidates: Iterable<StuckCancelCandidate>,
  now: Date,
): Promise<StuckCancelSweepResult> {
  const log = dependencies.log ?? (() => undefined);
  const result: StuckCancelSweepResult = { retried: [], ended: [], interrupted: [], unretried: [], failed: [] };
  for (const candidate of candidates) {
    try {
      await settle(dependencies, candidate, now, result, log);
    } catch (error) {
      // The error's name only: never a message that could carry stored data.
      result.failed.push(candidate.workspaceId);
      log({ event: "stuck_cancel.check_failed", workspaceId: candidate.workspaceId, errorName: error instanceof Error ? error.name : "unknown" });
    }
  }
  return result;
}

async function settle(
  dependencies: StuckCancelDependencies,
  { workspaceId, compute, worker }: StuckCancelCandidate,
  at: Date,
  result: StuckCancelSweepResult,
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  if (compute === "unknown") return;
  const { client, tableName } = dependencies;
  const get = async (key: { pk: string; sk: string }) => ((await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  const workspace = await get({ pk: `WORKSPACE#${workspaceId}`, sk: "META" });
  const operationId = workspace?.activeOperationId;
  if (typeof operationId !== "string") return;
  const operation = await get({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` }) as StuckOperation | undefined;
  // Issue 202: a cancel failed (the worker no longer knew the task, say). The result marked the task
  // INTERRUPTED but, as for any failed cancel, left it holding the workspace, since the worker may
  // still run it. Freed only when nothing can run there; a busy worker keeps it.
  if (operation?.status === "INTERRUPTED" && typeof operation.fence === "number" && typeof operation.updatedAt === "string") {
    const retried = typeof operation.cancelRetriedAt === "string";
    const failedAt = Math.max(retried ? Date.parse(operation.cancelRetriedAt as string) : 0, Date.parse(operation.updatedAt));
    const waited = at.getTime() - failedAt;
    let reason: FailedCancelReleaseReason;
    if (compute === "gone") {
      reason = "compute-gone";
    } else if (worker === "idle") {
      // A retried one keeps #200's retry limit (30 minutes from when its retried cancel failed),
      // longer than the 10 minutes a first failed cancel waits.
      if (!(waited > (retried ? STUCK_CANCEL_RETRY_MS : FAILED_CANCEL_GRACE_MS))) return;
      reason = "worker-idle";
    } else {
      // Busy: never freed on time alone. Unknown (the ping failed): the ping-failure rule replaces
      // the worker, and a later run finds its compute gone.
      if (worker === "busy" && waited > STUCK_CANCEL_RETRY_MS) {
        result.failed.push(operationId);
        log({ event: "stuck_cancel.held_busy", workspaceId, operationId });
      }
      return;
    }
    if (!(await releaseFailedCancelWorkspace(client, tableName, { workspaceId, operationId }, operation, reason, at))) {
      log({ event: "stuck_cancel.skipped", workspaceId, operationId, reason: "changed" });
      return;
    }
    result.interrupted.push(operationId);
    log({ event: "stuck_cancel.released", workspaceId, operationId, reason });
    if (dependencies.postNote !== undefined) await noteRelease(dependencies, workspace!, { workspaceId, operationId }, log);
    return;
  }
  if (operation?.status !== "CANCEL_REQUESTED" || typeof operation.fence !== "number" || typeof operation.updatedAt !== "string") return;
  const now = at.getTime();
  const requestedAt = Date.parse(operation.updatedAt);
  const retriedAt = typeof operation.cancelRetriedAt === "string" ? Date.parse(operation.cancelRetriedAt) : undefined;
  const ids = { workspaceId, operationId };

  if (retriedAt === undefined && !(now - requestedAt > STUCK_CANCEL_MS)) return;
  if (compute === "gone") {
    if (await end(dependencies, ids, operation, at, "FAILED", STUCK_CANCEL_LOST_MESSAGE)) {
      result.ended.push(operationId);
      log({ event: "stuck_cancel.ended", ...ids, reason: "compute-gone" });
    } else {
      log({ event: "stuck_cancel.skipped", ...ids, reason: "changed" });
    }
    return;
  }
  // Compute is alive. A developer task keeps today's rule: only lost compute ends it.
  if (await get(taskPointerKey(workspaceId)) !== undefined) return;
  // A cancel operation for it that moved within the limit is still progressing.
  if (await cancelProgressing(dependencies, ids, now)) return;
  if (retriedAt !== undefined) {
    // Timed from the retry, or from a newer cancel request made after it.
    if (!(now - Math.max(retriedAt, requestedAt) > STUCK_CANCEL_RETRY_MS)) return;
    if (await end(dependencies, ids, operation, at, "INTERRUPTED", STUCK_CANCEL_INTERRUPTED_MESSAGE)) {
      result.interrupted.push(operationId);
      log({ event: "stuck_cancel.interrupted", ...ids });
    } else {
      log({ event: "stuck_cancel.skipped", ...ids, reason: "changed" });
    }
    return;
  }
  if (dependencies.retryCancel === undefined) {
    result.unretried.push(operationId);
    log({ event: "stuck_cancel.retry_unavailable", ...ids });
    return;
  }
  if (!(await claimRetry(dependencies, ids, operation, at))) {
    // Asked again, or finished, since it was read: the next run looks again.
    log({ event: "stuck_cancel.skipped", ...ids, reason: "changed" });
    return;
  }
  let retry: StuckCancelRetry;
  try {
    retry = await dependencies.retryCancel(workspaceId, operationId);
  } catch (error) {
    // The retry stays recorded, so it is never tried again; the retry limit ends the task.
    result.failed.push(operationId);
    // The cancel path's refusals (STALE_FENCE, WORKSPACE_BUSY) share a name; their code is a fixed
    // value, never stored data, so it is logged too.
    log({ event: "stuck_cancel.retry_failed", ...ids, errorName: error instanceof Error ? error.name : "unknown", ...(error instanceof AgentXError ? { errorCode: error.code } : {}) });
    return;
  }
  if (retry.outcome === "REQUEUED") {
    result.retried.push(operationId);
    log({ event: "stuck_cancel.retried", ...ids, cancelOperationId: retry.cancelOperationId });
  } else {
    // A lost race (finished, not active, not CANCEL_REQUESTED) is routine. A fence that moved without
    // the active operation, or a retry not recorded first, should never happen: counted as a
    // failure so the alarm sees it.
    if (UNEXPECTED_SKIPS.has(retry.reason)) result.failed.push(operationId);
    log({ event: "stuck_cancel.retry_skipped", ...ids, reason: retry.reason });
  }
}

const UNEXPECTED_SKIPS: ReadonlySet<string> = new Set(["fence-changed", "not-claimed"]);

const LIVE_CANCEL = new Set(["ACCEPTED", "DISPATCHING", "RUNNING"]);

/** Whether any cancel operation of this target is still live and changed within STUCK_CANCEL_MS. */
async function cancelProgressing(
  { client, tableName }: StuckCancelDependencies,
  { workspaceId, operationId }: { workspaceId: string; operationId: string },
  now: number,
): Promise<boolean> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :operation)",
      FilterExpression: "kind = :cancel AND targetOperationId = :target",
      ExpressionAttributeValues: { ":pk": `WORKSPACE#${workspaceId}`, ":operation": "OPERATION#", ":cancel": "cancel", ":target": operationId },
      ConsistentRead: true,
      ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
    })) as { Items?: Array<{ status?: unknown; updatedAt?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const cancel of page.Items ?? []) {
      if (LIVE_CANCEL.has(String(cancel.status)) && typeof cancel.updatedAt === "string" && !(now - Date.parse(cancel.updatedAt) > STUCK_CANCEL_MS)) return true;
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return false;
}

/** Records the one retry on the operation, only if nothing changed since it was read. */
async function claimRetry(
  { client, tableName }: StuckCancelDependencies,
  { workspaceId, operationId }: { workspaceId: string; operationId: string },
  operation: StuckOperation,
  at: Date,
): Promise<boolean> {
  try {
    await client.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` },
      UpdateExpression: "SET cancelRetriedAt = :now",
      ConditionExpression: "#status = :cancelRequested AND fence = :fence AND updatedAt = :seen AND attribute_not_exists(cancelRetriedAt)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":now": at.toISOString(), ":cancelRequested": "CANCEL_REQUESTED", ":fence": operation.fence, ":seen": operation.updatedAt },
    }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/**
 * Tells the workspace's Slack thread, if it has one, that its workspace is free again. A note that
 * could not be posted is logged by its error name only, and never undoes the release.
 */
async function noteRelease(
  dependencies: StuckCancelDependencies,
  workspace: Record<string, unknown>,
  ids: { workspaceId: string; operationId: string },
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  try {
    if (typeof workspace.ownerKey !== "string") return;
    const record = ((await dependencies.client.send(new GetCommand({ TableName: dependencies.tableName, Key: { pk: `SLACK_THREAD#${workspace.ownerKey}`, sk: "META" }, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
    // An API, CLI or AI-tool workspace has no thread; a thread now bound to another workspace is not this one's.
    // A closed thread takes no more requests, so it is not told (as failed-preparation.ts skips it).
    if (record === undefined || record.workspaceId !== ids.workspaceId || record.closedAt != null) return;
    const parts = typeof record.thread === "string" ? record.thread.split("/") : [];
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      log({ event: "stuck_cancel.note_skipped", ...ids, reason: "thread-record-unreadable" });
      return;
    }
    await dependencies.postNote!({ channelId: parts[1]!, threadTs: parts[2]! }, FAILED_CANCEL_RELEASED_MESSAGE);
  } catch (error) {
    // Logged, not counted: the release stands, and the task's status carries the same message.
    log({ event: "stuck_cancel.note_failed", ...ids, errorName: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * Ends the operation and frees its workspace in one transaction, as failActiveOperation does for
 * lost compute (the same released status), but only for this operation while it is still
 * CANCEL_REQUESTED under the fence read. False when a result or another writer got there first.
 */
async function end(
  { client, tableName }: StuckCancelDependencies,
  { workspaceId, operationId }: { workspaceId: string; operationId: string },
  operation: StuckOperation,
  at: Date,
  status: "FAILED" | "INTERRUPTED",
  error: string,
): Promise<boolean> {
  const released = releasedStatus(operation);
  const now = at.toISOString();
  try {
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName,
        Key: { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` },
        UpdateExpression: "SET #status = :status, updatedAt = :now, #result = :result, #error = :error",
        ConditionExpression: "#status = :cancelRequested AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status", "#result": "result", "#error": "error" },
        ExpressionAttributeValues: { ":status": status, ":now": now, ":result": null, ":error": error, ":cancelRequested": "CANCEL_REQUESTED", ":fence": operation.fence },
      } },
      { Update: {
        TableName: tableName,
        Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" },
        UpdateExpression: "SET #status = :released, updatedAt = :now REMOVE activeOperationId",
        ConditionExpression: "activeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":released": released, ":now": now, ":operation": operationId, ":fence": operation.fence },
      } },
    ] }));
    if (released === "PREPARATION_FAILED") await releaseFailedPreparation(client, tableName, workspaceId);
    return true;
  } catch (failure) {
    if (failure instanceof Error && failure.name === "TransactionCanceledException") return false;
    throw failure;
  }
}

/**
 * The production retryCancel: queues the cancel again in the reconciler's own process, through
 * requestCancellation, the cancel route's own path (#173 moved it to cancellation.ts), with its
 * default condition, which allows a repeat cancel of a CANCEL_REQUESTED task. It checks everything
 * again first, so it can never queue more than this allows: the operation still holds the workspace,
 * is still CANCEL_REQUESTED under the workspace's fence, the sweep recorded its one retry on it first
 * (so it never loops), and it is not an AI tool's developer task. The cancel's worker callbacks are
 * signed with the callback signing key, as the broker signs them.
 */
export function createCancelRetrier(dependencies: { client: Client; tableName: string; callbackSigningKey: string }): NonNullable<StuckCancelDependencies["retryCancel"]> {
  const state = { documentClient: dependencies.client as CancellationDependencies["documentClient"], tableName: dependencies.tableName };
  return async (workspaceId, operationId) => {
    const skipped = (reason: string): StuckCancelRetry => ({ outcome: "SKIPPED", reason });
    const record = await getItem<Record<string, unknown>>(state, { pk: `WORKSPACE#${workspaceId}`, sk: "META" });
    if (record?.activeOperationId !== operationId) return skipped("not-active");
    const target = await getItem<StuckOperation>(state, { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` });
    if (target?.status !== "CANCEL_REQUESTED") return skipped("not-cancel-requested");
    if (typeof target.cancelRetriedAt !== "string") return skipped("not-claimed");
    if (target.fence !== record.fence) return skipped("fence-changed");
    if (await getItem(state, taskPointerKey(workspaceId)) !== undefined) return skipped("developer-task");
    const workspace = WorkspaceInstanceSchema.parse(workspaceRecordFields(record));
    const result = await requestCancellation({ ...state, callbackSigningKey: dependencies.callbackSigningKey }, workspace, operationId, {});
    // A duplicate means the task finished before the cancel was recorded.
    if (result.duplicate) return skipped("finished");
    return { outcome: "REQUEUED", cancelOperationId: result.operation.id };
  };
}

/**
 * The production retryCancel, where the reconciler holds the callback signing key the retried
 * cancel's callbacks are signed with. It holds it in named environments only (#173), so only there
 * is a stuck cancel on a live worker queued again; the legacy reconciler has none, and only logs and
 * counts it.
 */
export function stuckCancelRetrier(
  environment: Record<string, string | undefined>,
  state: { client: Client; tableName: string },
): StuckCancelDependencies["retryCancel"] {
  const key = environment.CALLBACK_SIGNING_KEY;
  return key === undefined || key.length === 0 ? undefined : createCancelRetrier({ ...state, callbackSigningKey: key });
}
