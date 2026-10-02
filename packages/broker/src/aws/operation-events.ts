import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * Appends one event to an operation's event stream, as the worker's event callbacks do: the next
 * sequence number, fenced on the operation's fence. `onceKey` makes it idempotent, so a message
 * delivered twice records its event once.
 */
export async function appendOperationEvent(
  documentClient: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  input: {
    workspaceId: string;
    operationId: string;
    fence: number;
    onceKey: string;
    event: { type: string; timestamp: string; payload: unknown };
  },
): Promise<void> {
  const markerKey = { pk: `OPERATION#${input.operationId}`, sk: `EVENTBATCH#${input.onceKey}` };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await documentClient.send(new GetCommand({ TableName: tableName, Key: markerKey }))).Item) return;
    const operation = (await documentClient.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `WORKSPACE#${input.workspaceId}`, sk: `OPERATION#${input.operationId}` },
    }))).Item as { eventSequence?: number } | undefined;
    if (operation === undefined) return;
    const current = operation.eventSequence ?? 0;
    const sequence = current + 1;
    try {
      await documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: tableName,
          Key: { pk: `WORKSPACE#${input.workspaceId}`, sk: `OPERATION#${input.operationId}` },
          UpdateExpression: "SET eventSequence = :next",
          ConditionExpression: "eventSequence = :current AND fence = :fence",
          ExpressionAttributeValues: { ":next": sequence, ":current": current, ":fence": input.fence },
        } },
        { Put: { TableName: tableName, Item: { ...markerKey, entityType: "EVENT_BATCH" }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: {
          TableName: tableName,
          Item: {
            pk: `OPERATION#${input.operationId}`,
            sk: `EVENT#${String(sequence).padStart(12, "0")}`,
            entityType: "EVENT",
            workspaceId: input.workspaceId,
            operationId: input.operationId,
            sequence,
            ...input.event,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
      ] }));
      return;
    } catch (error) {
      const conditional = error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");
      if (!conditional || attempt === 3) throw error;
    }
  }
}

/**
 * #225: one event on a developer task's prepare that did not succeed, saying so with the first line
 * of its error (the task view redacts and caps it), at the time it ended. Once per prepare, however
 * often the worker sends the result. Best effort: the outcome is recorded already, so a failure here
 * is logged by its name and never fails the caller.
 */
export async function recordPrepareFailureEvent(
  documentClient: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  input: { workspaceId: string; operationId: string; fence: number; status: string; error: string | undefined; at: string },
): Promise<void> {
  const first = (input.error ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  const said = input.status === "FAILED" ? "Workspace setup failed" : `Workspace setup ended ${input.status}`;
  try {
    await appendOperationEvent(documentClient, tableName, {
      workspaceId: input.workspaceId, operationId: input.operationId, fence: input.fence, onceKey: "prepare-result",
      event: { type: "error", timestamp: input.at, payload: { message: first === "" ? `${said}.` : `${said}: ${first}` } },
    });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "developer.prepare_failure_event_failed", operationId: input.operationId, error: error instanceof Error ? error.name : "unknown" }));
  }
}
