// Issue 202: a cancel that reached the worker and failed (a restarted worker that no longer knows
// the task, say) marks its task INTERRUPTED but leaves the task holding the workspace, because the
// worker may still be running it. The workspace is freed only on evidence that nothing runs there:
// - the compute is gone (the reconciler's stuck-cancel sweep, at once);
// - the worker answers its ping idle (the sweep, once FAILED_CANCEL_GRACE_MS has passed since the
//   cancel failed, so a task POST still in flight has landed);
// - the task's own late result arrives (the broker, at once): proof that its run ended.
// A worker that answers busy keeps the workspace held for good; the sweep counts it for the
// StuckCancels alarm instead. The release records why on the operation, which stays INTERRUPTED.
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { releaseFailedPreparation } from "./failed-preparation.js";

type Client = { send(command: unknown): Promise<unknown> };

/** One reconciler period: an idle worker's workspace is freed this long after its cancel failed. */
export const FAILED_CANCEL_GRACE_MS = 10 * 60_000;

/** Why a failed cancel's workspace was freed, recorded on the operation as workspaceReleaseReason. */
export type FailedCancelReleaseReason = "compute-gone" | "worker-idle" | "own-result";

/** What the task's status says, and a Slack thread is told, once its workspace is free again. */
export const FAILED_CANCEL_RELEASED_MESSAGE = "The stop request did not reach the task, but the task is no longer running, so its workspace is free again. A request that was waiting starts now, or you can send a new one.";

export interface HeldOperation {
  kind?: unknown;
  fence?: unknown;
  error?: unknown;
  closePreviousStatus?: unknown;
}

/** The released status, as failActiveOperation picks it for lost compute. */
export function releasedStatus(operation: HeldOperation): string {
  return operation.kind === "prepare"
    ? "PREPARATION_FAILED"
    : operation.kind === "close" && typeof operation.closePreviousStatus === "string" ? operation.closePreviousStatus : "READY";
}

/**
 * Frees the workspace an INTERRUPTED operation still holds, exactly once: only while the operation
 * is INTERRUPTED under the fence read and not yet released, and only while the workspace is still
 * held by it under that fence, so a result or a new operation that lands first wins. Records when
 * and why on the operation, and the plain-words message as its error when it carries none. False
 * when something moved first.
 */
export async function releaseFailedCancelWorkspace(
  client: Client,
  tableName: string,
  { workspaceId, operationId }: { workspaceId: string; operationId: string },
  operation: HeldOperation,
  reason: FailedCancelReleaseReason,
  at: Date,
): Promise<boolean> {
  const released = releasedStatus(operation);
  const now = at.toISOString();
  const withMessage = typeof operation.error !== "string";
  try {
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName,
        Key: { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` },
        UpdateExpression: `SET workspaceReleasedAt = :now, workspaceReleaseReason = :reason${withMessage ? ", #error = :message" : ""}`,
        ConditionExpression: "#status = :interrupted AND fence = :fence AND attribute_not_exists(workspaceReleasedAt)",
        ExpressionAttributeNames: { "#status": "status", ...(withMessage ? { "#error": "error" } : {}) },
        ExpressionAttributeValues: {
          ":now": now, ":reason": reason, ":interrupted": "INTERRUPTED", ":fence": operation.fence,
          ...(withMessage ? { ":message": FAILED_CANCEL_RELEASED_MESSAGE } : {}),
        },
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
  } catch (failure) {
    if (failure instanceof Error && failure.name === "TransactionCanceledException") return false;
    throw failure;
  }
  // #213: a prepare's workspace freed as PREPARATION_FAILED stops counting toward the limits.
  if (released === "PREPARATION_FAILED") await releaseFailedPreparation(client, tableName, workspaceId);
  return true;
}
