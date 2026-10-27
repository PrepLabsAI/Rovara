import { DeleteCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { REQUALIFY_PROFILE_ID, RequalifyLockSchema, requalifyLockKey } from "@agentx/contracts";

/**
 * The single-flight lock of the test machine's renewal (AUTOREQUALIFY): one run, automatic or the operator's script, holds it at a time. The row is
 * exactly `RequalifyLockSchema` (ISO strings from `toISOString`, so a lexicographic comparison is a time comparison); the switch checks it again inside
 * its own transaction.
 */

/** Longer than any run (the step machine is bounded at 3 hours), short enough that a crashed run does not block the next day's. */
export const REQUALIFY_LOCK_TTL_MS = 4 * 60 * 60_000;

export interface RequalifyLockDependencies {
  documentClient: Pick<DynamoDBDocumentClient, "send">;
  tableName: string;
  now?: () => number;
}

/** Takes the lock when nobody holds it or the holder's time is up. Returns whether this run now holds it. */
export async function acquireRequalifyLock(deps: RequalifyLockDependencies, runId: string, ttlMs = REQUALIFY_LOCK_TTL_MS): Promise<boolean> {
  const now = deps.now?.() ?? Date.now();
  const item = RequalifyLockSchema.parse({
    entityType: "RUNTIME_REQUALIFY_LOCK", runId, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
  });
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName, Item: { ...requalifyLockKey(REQUALIFY_PROFILE_ID), ...item },
      ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now", ExpressionAttributeValues: { ":now": new Date(now).toISOString() },
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** Releases the lock only if this run still holds it. Returns whether it deleted the row. */
export async function releaseRequalifyLock(deps: RequalifyLockDependencies, runId: string): Promise<boolean> {
  try {
    await deps.documentClient.send(new DeleteCommand({
      TableName: deps.tableName, Key: requalifyLockKey(REQUALIFY_PROFILE_ID), ConditionExpression: "runId = :runId", ExpressionAttributeValues: { ":runId": runId },
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}
