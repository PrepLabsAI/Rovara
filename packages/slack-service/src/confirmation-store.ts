import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PendingConfirmationSchema, confirmationKey, pendingConfirmationFromItem } from "@agentx/contracts";
import { UNPOSTED_MARK, type ConfirmationStore } from "./confirmations.js";
import type { ServiceLog } from "./processor.js";

/** The table keeps a confirmation item a week past its expiry; it answers "expired" only for the first 24 hours of that. */
const RETAIN_AFTER_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
/** "Yes to all" lasts 24 hours; saying it again renews it (spec 014 D4). */
const YES_TO_ALL_SECONDS = 24 * 60 * 60;

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

/** Confirmations and "yes to all" grants, in the Slack threads table beside each thread's META item. */
export function createDynamoConfirmationStore(
  documentClient: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  now: () => number = Date.now,
  log: ServiceLog = () => undefined,
): ConfirmationStore {
  const yesKey = (subject: string, userId: string) => ({ pk: `THREAD#${subject}`, sk: `YES_TO_ALL#${userId}` });
  return {
    async load(subject) {
      const response = await documentClient.send(new GetCommand({ TableName: tableName, Key: confirmationKey(subject), ConsistentRead: true }));
      const confirmation = pendingConfirmationFromItem(response.Item);
      // The event name only: an unreadable item's content is not logged.
      if (response.Item !== undefined && confirmation === undefined) log("gate.confirmation_unreadable", {});
      return confirmation;
    },
    async save(subject, input) {
      // An invalid confirmation throws here, so the caller can tell the member, rather than being stored unreadable.
      const { retiredAt, usedBy, ...confirmation } = PendingConfirmationSchema.parse(input);
      await documentClient.send(new PutCommand({ TableName: tableName, Item: {
        ...confirmationKey(subject), confirmationId: confirmation.confirmationId, confirmation,
        // The tombstone fields live beside the confirmation, where claim's condition reads them.
        ...(retiredAt === undefined ? {} : { retiredAt }),
        ...(usedBy === undefined ? {} : { usedBy }),
        // Epoch milliseconds, so a claim can refuse an expired confirmation in its condition.
        validUntil: Date.parse(confirmation.expiresAt),
        expiresAt: Math.floor(Date.parse(confirmation.expiresAt) / 1_000) + RETAIN_AFTER_EXPIRY_SECONDS,
      } }));
    },
    async claim(subject, confirmationId, eventId) {
      // Single use: the claim itself leaves the tombstone, so a redelivery of the same event cannot claim again.
      try {
        await documentClient.send(new UpdateCommand({
          TableName: tableName, Key: confirmationKey(subject),
          UpdateExpression: "SET retiredAt = :at, usedBy = :event",
          ConditionExpression: "confirmationId = :id AND attribute_not_exists(retiredAt) AND validUntil > :now",
          ExpressionAttributeValues: { ":id": confirmationId, ":event": eventId, ":at": new Date(now()).toISOString(), ":now": now() },
        }));
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },
    async open(subject, confirmationId) {
      // Throws when the item is not this closed, unposted confirmation: it then stays closed.
      await documentClient.send(new UpdateCommand({
        TableName: tableName, Key: confirmationKey(subject),
        UpdateExpression: "REMOVE retiredAt, usedBy",
        ConditionExpression: "confirmationId = :id AND usedBy = :unposted",
        ExpressionAttributeValues: { ":id": confirmationId, ":unposted": UNPOSTED_MARK },
      }));
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
