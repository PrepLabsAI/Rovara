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
// - a retried one whose cancel failed (the result marks it INTERRUPTED but leaves it holding the
//   workspace) has its workspace freed.
// A cancel operation for the task that is still live and changed within STUCK_CANCEL_MS counts as
// progressing, so a live worker's task is neither retried nor interrupted while it moves.
// Operations not CANCEL_REQUESTED, and cancels within their limit, are never touched. A task an AI
// tool started (a developer task) keeps today's lost-compute rule only: ended when its compute is
// gone, never retried or interrupted while its compute is alive.
//
// Every write is conditioned on the operation still being in the state read (CANCEL_REQUESTED, or
// for a release INTERRUPTED with the sweep's retry recorded) under the fence read, and on the
// workspace still being held by it, so a cancel result that lands first stands.
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { WorkspaceInstanceSchema, workspaceRecordFields } from "@agentx/contracts";
import { taskPointerKey } from "../developer/task-records.js";
import { getItem, requestCancellation, type CancellationDependencies } from "./cancellation.js";

type Client = { send(command: unknown): Promise<unknown> };

/** Owner decision, 2026-10-01: a cancel normally finishes in seconds. */
export const STUCK_CANCEL_MS = 30 * 60_000;
/** How long a re-queued cancel gets before the task is ended as interrupted. */
export const STUCK_CANCEL_RETRY_MS = 30 * 60_000;
export const STUCK_CANCEL_LOST_MESSAGE = "RUNTIME_UNAVAILABLE: workspace compute was lost before the cancel finished; the task was stopped";
export const STUCK_CANCEL_INTERRUPTED_MESSAGE = "the cancel did not reach the worker, even after a retry; the task was stopped and its workspace freed";

/** What the reconciler knows of a workspace's compute this run. "unknown": starting or stopping. */
export type StuckCancelCompute = "alive" | "gone" | "unknown";
export interface StuckCancelCandidate { workspaceId: string; compute: StuckCancelCompute }

export type StuckCancelRetry =
  | { outcome: "REQUEUED"; cancelOperationId: string }
  | { outcome: "SKIPPED"; reason: string };

export interface StuckCancelDependencies {
  client: Client;
  tableName: string;
  /** Queues the cancel again (createCancelRetrier). Absent where the reconciler has no signing key (legacy). */
  retryCancel?: (workspaceId: string, operationId: string) => Promise<StuckCancelRetry>;
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
  { workspaceId, compute }: StuckCancelCandidate,
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
  // The retried cancel failed (the worker no longer knew the task): the result marked the task
  // INTERRUPTED but, as for any failed cancel, left it holding the workspace. Only an operation
  // this sweep retried is freed so, and only after the retry limit, as a stuck retry would be.
  if (operation?.status === "INTERRUPTED" && typeof operation.cancelRetriedAt === "string" && typeof operation.fence === "number") {
    const changedAt = Math.max(Date.parse(operation.cancelRetriedAt), typeof operation.updatedAt === "string" ? Date.parse(operation.updatedAt) : 0);
    if (!(at.getTime() - changedAt > STUCK_CANCEL_RETRY_MS)) return;
    if (await release(dependencies, { workspaceId, operationId }, operation, at)) {
      result.interrupted.push(operationId);
      log({ event: "stuck_cancel.released", workspaceId, operationId });
    } else {
      log({ event: "stuck_cancel.skipped", workspaceId, operationId, reason: "changed" });
    }
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
    log({ event: "stuck_cancel.retry_failed", ...ids, errorName: error instanceof Error ? error.name : "unknown" });
    return;
  }
  if (retry.outcome === "REQUEUED") {
    result.retried.push(operationId);
    log({ event: "stuck_cancel.retried", ...ids, cancelOperationId: retry.cancelOperationId });
  } else {
    log({ event: "stuck_cancel.retry_skipped", ...ids, reason: retry.reason });
  }
}

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

/** The released status, as failActiveOperation picks it for lost compute. */
function releasedStatus(operation: StuckOperation): string {
  return operation.kind === "prepare"
    ? "PREPARATION_FAILED"
    : operation.kind === "close" && typeof operation.closePreviousStatus === "string" ? operation.closePreviousStatus : "READY";
}

/** Frees the workspace an INTERRUPTED, retried operation still holds. False when something moved first. */
async function release(
  { client, tableName }: StuckCancelDependencies,
  { workspaceId, operationId }: { workspaceId: string; operationId: string },
  operation: StuckOperation,
  at: Date,
): Promise<boolean> {
  try {
    await client.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: {
        TableName: tableName,
        Key: { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` },
        ConditionExpression: "#status = :interrupted AND fence = :fence AND attribute_exists(cancelRetriedAt)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":interrupted": "INTERRUPTED", ":fence": operation.fence },
      } },
      { Update: {
        TableName: tableName,
        Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" },
        UpdateExpression: "SET #status = :released, updatedAt = :now REMOVE activeOperationId",
        ConditionExpression: "activeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":released": releasedStatus(operation), ":now": at.toISOString(), ":operation": operationId, ":fence": operation.fence },
      } },
    ] }));
    return true;
  } catch (failure) {
    if (failure instanceof Error && failure.name === "TransactionCanceledException") return false;
    throw failure;
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
 * The key the retried cancel's callbacks are signed with. The reconciler holds it in named
 * environments only (#173), so only there is a stuck cancel on a live worker queued again; the
 * legacy reconciler has none, and only logs and counts it.
 */
export function stuckCancelSigningKey(environment: Record<string, string | undefined>): string | undefined {
  const key = environment.CALLBACK_SIGNING_KEY;
  return key === undefined || key.length === 0 ? undefined : key;
}
