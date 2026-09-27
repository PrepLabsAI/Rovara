import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DurableOutboxRecord } from "./lambda.js";

/**
 * Fails an outbox record's operation for good: the operation becomes FAILED, the workspace is
 * released (PREPARATION_FAILED after a prepare, READY otherwise; a cancel holds no workspace), and
 * the outbox record becomes FAILED, all in one transaction fenced on the invocation's fence.
 * `whileOutbox` adds a condition on the outbox record's current status.
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
}
