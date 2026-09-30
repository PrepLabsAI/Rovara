import { UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { ActiveTurn, TurnNote } from "./interrupted-turn.js";

/** A META write gives up after this long, so a hung request cannot hold the turn. */
const WRITE_TIMEOUT_MS = 5_000;

/** Issue 157: the worker operation a turn waits on (`activeTurn`) and the next turn's note (`turnNote`), on the thread's META item. */
export function createDynamoActiveTurnStore(documentClient: Pick<DynamoDBDocumentClient, "send">, tableName: string) {
  const key = (subject: string) => ({ pk: `THREAD#${subject}`, sk: "META" });
  return {
    async saveActiveTurn(subject: string, turn: ActiveTurn): Promise<void> {
      await documentClient.send(new UpdateCommand({
        TableName: tableName,
        Key: key(subject),
        UpdateExpression: "SET activeTurn = :turn",
        ExpressionAttributeValues: { ":turn": { eventId: turn.eventId, workspaceId: turn.workspaceId, operationId: turn.operationId } },
      }), { abortSignal: AbortSignal.timeout(WRITE_TIMEOUT_MS) });
    },
    async saveTurnNote(subject: string, note: TurnNote | undefined): Promise<void> {
      await documentClient.send(new UpdateCommand({
        TableName: tableName,
        Key: key(subject),
        ...(note === undefined
          ? { UpdateExpression: "REMOVE turnNote" }
          : { UpdateExpression: "SET turnNote = :note", ExpressionAttributeValues: { ":note": { eventId: note.eventId, text: note.text } } }),
      }), { abortSignal: AbortSignal.timeout(WRITE_TIMEOUT_MS) });
    },
    async clearActiveTurn(subject: string, eventId: string): Promise<void> {
      try {
        await documentClient.send(new UpdateCommand({
          TableName: tableName,
          Key: key(subject),
          UpdateExpression: "REMOVE activeTurn",
          // Another event's turn, or none, is left as it is.
          ConditionExpression: "activeTurn.eventId = :event",
          ExpressionAttributeValues: { ":event": eventId },
        }), { abortSignal: AbortSignal.timeout(WRITE_TIMEOUT_MS) });
      } catch (error) {
        if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
      }
    },
  };
}
