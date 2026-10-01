// Issue 195: a cancel that never reaches the worker never holds a workspace for good. Stopping a
// task moves it to CANCEL_REQUESTED and queues a cancel operation; if that cancel is lost (its
// dispatch failed, or its worker is gone), the task stays CANCEL_REQUESTED and its workspace stays
// busy. Each reconciler run checks the workspaces it already lists:
// - a task CANCEL_REQUESTED over STUCK_CANCEL_MS whose compute is gone is ended as the lost-compute
//   path ends work, and its workspace freed;
// - one whose compute is alive has its cancel queued again, once: the retry is recorded on the
//   operation first (cancelRetriedAt), so a crash or a failed retry can never retry it twice;
// - a retried one still CANCEL_REQUESTED STUCK_CANCEL_RETRY_MS later is ended INTERRUPTED, and its
//   workspace freed.
// Operations not CANCEL_REQUESTED, and cancels within their limit, are never touched. A task an AI
// tool started (a developer task) keeps today's lost-compute rule only: ended when its compute is
// gone, never retried or interrupted while its compute is alive.
//
// Every write is conditioned on the operation still being CANCEL_REQUESTED under the fence read,
// and on the workspace still being held by it, so a cancel result that lands first stands.
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { taskPointerKey } from "../developer/task-records.js";

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
  /** Asks the broker to queue the cancel again. Absent where the reconciler may not invoke the broker (legacy). */
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
    }
    return;
  }
  // Compute is alive. A developer task keeps today's rule: only lost compute ends it.
  if (await get(taskPointerKey(workspaceId)) !== undefined) return;
  if (retriedAt !== undefined) {
    // Timed from the retry, or from a newer cancel request made after it.
    if (!(now - Math.max(retriedAt, requestedAt) > STUCK_CANCEL_RETRY_MS)) return;
    if (await end(dependencies, ids, operation, at, "INTERRUPTED", STUCK_CANCEL_INTERRUPTED_MESSAGE)) {
      result.interrupted.push(operationId);
      log({ event: "stuck_cancel.interrupted", ...ids });
    }
    return;
  }
  if (dependencies.retryCancel === undefined) {
    result.unretried.push(operationId);
    log({ event: "stuck_cancel.retry_unavailable", ...ids });
    return;
  }
  if (!(await claimRetry(dependencies, ids, operation, at))) return;
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
  const released = operation.kind === "prepare"
    ? "PREPARATION_FAILED"
    : operation.kind === "close" && typeof operation.closePreviousStatus === "string" ? operation.closePreviousStatus : "READY";
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
 * The reconciler's request to the broker to queue a stuck cancel again. Invoked by the reconciler
 * Lambda only, never through API Gateway, and only in named environments (the legacy reconciler
 * has no grant to invoke the broker).
 */
export interface StuckCancelRetryEvent {
  source: "agentx.session-reconciler";
  action: "retry-stuck-cancel";
  workspaceId: string;
  operationId: string;
}

export function isStuckCancelRetryEvent(event: unknown): event is StuckCancelRetryEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  // API Gateway always sets requestContext, so a request from outside can never take this path.
  return value.source === "agentx.session-reconciler" && value.action === "retry-stuck-cancel" && value.requestContext === undefined;
}

/** The part of a Lambda Invoke answer the retrier reads. */
interface InvokeAnswer { StatusCode?: number | undefined; FunctionError?: string | undefined; Payload?: Uint8Array | undefined }

/**
 * The production retryCancel: invokes the broker with the retry event and reads its answer. Any
 * answer but a readable REQUEUED or SKIPPED fails as StuckCancelRetryFailed, with the status only:
 * never the broker's message, which could carry stored data.
 */
export function createBrokerCancelRetrier(invoke: (payload: string) => Promise<InvokeAnswer>): NonNullable<StuckCancelDependencies["retryCancel"]> {
  const failed = (detail: string) => Object.assign(new Error(`the broker did not queue the cancel again (${detail})`), { name: "StuckCancelRetryFailed" });
  return async (workspaceId, operationId) => {
    const event: StuckCancelRetryEvent = { source: "agentx.session-reconciler", action: "retry-stuck-cancel", workspaceId, operationId };
    const response = await invoke(JSON.stringify(event));
    if (response.FunctionError !== undefined) throw failed("function error");
    let answer: { statusCode?: unknown; body?: unknown };
    let body: { outcome?: unknown; cancelOperationId?: unknown; reason?: unknown };
    try {
      answer = JSON.parse(new TextDecoder().decode(response.Payload)) as typeof answer;
      body = typeof answer.body === "string" ? JSON.parse(answer.body) as typeof body : {};
    } catch {
      throw failed("unreadable answer");
    }
    if (answer.statusCode !== 200) throw failed(`status ${typeof answer.statusCode === "number" ? answer.statusCode : "unknown"}`);
    if (body.outcome === "REQUEUED" && typeof body.cancelOperationId === "string") return { outcome: "REQUEUED", cancelOperationId: body.cancelOperationId };
    if (body.outcome === "SKIPPED" && typeof body.reason === "string") return { outcome: "SKIPPED", reason: body.reason };
    throw failed("unexpected answer");
  };
}

/** The broker function the reconciler may invoke; set in named environments only, so legacy never retries. */
export function stuckCancelBrokerFunction(environment: Record<string, string | undefined>): string | undefined {
  const name = environment.BROKER_FUNCTION_NAME;
  return name === undefined || name.length === 0 ? undefined : name;
}
