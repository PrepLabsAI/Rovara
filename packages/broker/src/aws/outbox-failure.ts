import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { releaseFailedPreparation } from "./failed-preparation.js";
import type { DurableOutboxRecord } from "./lambda.js";

/**
 * Fails an outbox record's operation for good: the operation becomes FAILED, the workspace is
 * released (PREPARATION_FAILED after a prepare, READY otherwise; a cancel holds no workspace), and
 * the outbox record becomes FAILED, all in one transaction fenced on the invocation's fence.
 * `whileOutbox` adds a condition on the outbox record's current status. A failed prepare's
 * workspace then stops counting toward the workspace limits (#213).
 */
export async function failOutboxOperation(
  documentClient: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  record: DurableOutboxRecord,
  error: string,
  whileOutbox?: { status: DurableOutboxRecord["status"] },
): Promise<void> {
  const now = new Date().toISOString();
  const releaseWorkspace = record.invocation.kind !== "cancel";
  const workspaceStatus = record.invocation.kind === "prepare" ? "PREPARATION_FAILED" : "READY";
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      { Update: {
        TableName: tableName,
        Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
        UpdateExpression: "SET #status = :failed, updatedAt = :now, #result = :result, #error = :error",
        ConditionExpression: "(#status = :accepted OR #status = :dispatching) AND fence = :fence",
        ExpressionAttributeNames: {
          "#status": "status",
          "#result": "result",
          "#error": "error",
        },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":accepted": "ACCEPTED",
          ":dispatching": "DISPATCHING",
          ":now": now,
          ":result": null,
          ":error": error,
          ":fence": record.invocation.fence,
        },
      } },
      ...(releaseWorkspace ? [{ Update: {
        TableName: tableName,
        Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: "META" },
        UpdateExpression: "SET #status = :workspaceStatus, updatedAt = :now REMOVE activeOperationId",
        ConditionExpression: "activeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":workspaceStatus": workspaceStatus,
          ":now": now,
          ":operation": record.operationId,
          ":fence": record.invocation.fence,
        },
      } }] : []),
      { Update: {
        TableName: tableName,
        Key: { pk: `OUTBOX#${record.id}`, sk: "OUTBOX" },
        UpdateExpression: "SET #status = :failed, failedAt = :now, #error = :error",
        ...(whileOutbox === undefined ? {} : { ConditionExpression: "#status = :expected" }),
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":now": now,
          ":error": error,
          ...(whileOutbox === undefined ? {} : { ":expected": whileOutbox.status }),
        },
      } },
    ],
  }));
  if (record.invocation.kind === "prepare") await releaseFailedPreparation(documentClient, tableName, record.workspaceId);
}

/**
 * Fails the workspace's active operation, whatever stage it reached, and releases the workspace:
 * for the reconciler when a worker's compute is lost mid-operation (#86). Fenced on the operation's
 * fence, so an operation that finished or was replaced meanwhile is left alone. A lost prepare's
 * workspace stops counting toward the workspace limits (#213). Returns the failed
 * operation's ID, or undefined when there was none to fail.
 */
export async function failActiveOperation(
  documentClient: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  workspaceId: string,
  error: string,
): Promise<string | undefined> {
  const workspace = (await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" } }))).Item as { activeOperationId?: unknown } | undefined;
  const operationId = workspace?.activeOperationId;
  if (typeof operationId !== "string") return undefined;
  const operation = (await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` },
  }))).Item as { kind?: string; fence?: number; closePreviousStatus?: string } | undefined;
  if (operation?.fence === undefined) return undefined;
  const released = operation.kind === "prepare"
    ? "PREPARATION_FAILED"
    : operation.kind === "close" && typeof operation.closePreviousStatus === "string" ? operation.closePreviousStatus : "READY";
  const now = new Date().toISOString();
  try {
    await documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName,
        Key: { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` },
        UpdateExpression: "SET #status = :failed, updatedAt = :now, #result = :result, #error = :error",
        ConditionExpression: "(#status = :accepted OR #status = :dispatching OR #status = :running OR #status = :cancelRequested) AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status", "#result": "result", "#error": "error" },
        ExpressionAttributeValues: {
          ":failed": "FAILED", ":now": now, ":result": null, ":error": error, ":fence": operation.fence,
          ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":running": "RUNNING", ":cancelRequested": "CANCEL_REQUESTED",
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
    if (released === "PREPARATION_FAILED") await releaseFailedPreparation(documentClient, tableName, workspaceId);
    return operationId;
  } catch (failure) {
    if (failure instanceof Error && failure.name === "TransactionCanceledException") return undefined;
    throw failure;
  }
}
