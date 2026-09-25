import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { confirmationKey, pendingConfirmationFromItem } from "@agentx/contracts";
import type { ConfirmationStore } from "./confirmations.js";

/** Expired confirmations stay readable for a week, so a late "yes" hears that it expired. */
const RETAIN_AFTER_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
/** "Yes to all" lasts 24 hours; saying it again renews it (spec 014 D4). */
const YES_TO_ALL_SECONDS = 24 * 60 * 60;

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

/** Confirmations and "yes to all" grants, in the Slack threads table beside each thread's META item. */
export function createDynamoConfirmationStore(documentClient: Pick<DynamoDBDocumentClient, "send">, tableName: string, now: () => number = Date.now): ConfirmationStore {
  const yesKey = (subject: string, userId: string) => ({ pk: `THREAD#${subject}`, sk: `YES_TO_ALL#${userId}` });
  return {
    async load(subject) {
      const response = await documentClient.send(new GetCommand({ TableName: tableName, Key: confirmationKey(subject), ConsistentRead: true }));
      return pendingConfirmationFromItem(response.Item);
    },
    async save(subject, confirmation) {
      await documentClient.send(new PutCommand({ TableName: tableName, Item: {
        ...confirmationKey(subject), confirmationId: confirmation.confirmationId, confirmation,
        expiresAt: Math.floor(Date.parse(confirmation.expiresAt) / 1_000) + RETAIN_AFTER_EXPIRY_SECONDS,
      } }));
    },
    async claim(subject, confirmationId, eventId) {
      try {
        await documentClient.send(new UpdateCommand({
          TableName: tableName, Key: confirmationKey(subject),
          UpdateExpression: "SET claimedBy = :event",
          ConditionExpression: "confirmationId = :id AND attribute_not_exists(retiredAt) AND (attribute_not_exists(claimedBy) OR claimedBy = :event)",
          ExpressionAttributeValues: { ":id": confirmationId, ":event": eventId },
        }));
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },
    async retire(subject, confirmationId, eventId) {
      try {
        await documentClient.send(new UpdateCommand({
          TableName: tableName, Key: confirmationKey(subject),
          UpdateExpression: "SET retiredAt = :at, usedBy = :event",
          ConditionExpression: "confirmationId = :id AND attribute_not_exists(retiredAt)",
          ExpressionAttributeValues: { ":id": confirmationId, ":at": new Date(now()).toISOString(), ":event": eventId },
        }));
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    },
    async yesToAll(subject, userId) {
      const response = await documentClient.send(new GetCommand({ TableName: tableName, Key: yesKey(subject, userId), ConsistentRead: true }));
      const expiresAt = (response.Item as { expiresAt?: number } | undefined)?.expiresAt;
      return expiresAt !== undefined && expiresAt > now() / 1_000;
    },
    async grantYesToAll(subject, userId) {
      await documentClient.send(new PutCommand({ TableName: tableName, Item: {
        ...yesKey(subject, userId), grantedAt: new Date(now()).toISOString(), expiresAt: Math.floor(now() / 1_000) + YES_TO_ALL_SECONDS,
      } }));
    },
  };
}
