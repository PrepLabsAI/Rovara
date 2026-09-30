import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { StreamRecord } from "../developer/notifications.js";
import { INDEX_DEFAULT_BUDGET_MS, byDeadline, indexActivity } from "./activity-index.js";
import { requiredEnvironment, type DurableOutboxRecord } from "./lambda.js";

export interface DynamoStreamEvent {
  Records?: StreamRecord[];
}

/** The part of the Lambda context the publisher reads. */
export interface PublisherContext {
  getRemainingTimeInMillis(): number;
}

/** A4: time kept back from the Lambda's remaining time, so the index ends before the timeout. */
export const INDEX_SAFETY_MARGIN_MS = 5_000;

export function createOutboxPublisherHandler(dependencies: {
  send: (record: DurableOutboxRecord) => Promise<void>;
  markQueued: (id: string) => Promise<void>;
  /** Spec 025 A4: the failure and usage indexes, run after dispatch, best effort. */
  index?: (records: readonly StreamRecord[], options?: { deadline: number }) => Promise<unknown>;
}) {
  return async (event: DynamoStreamEvent, context?: PublisherContext): Promise<{ published: number }> => {
    let published = 0;
    for (const record of event.Records ?? []) {
      if (!record.dynamodb?.NewImage || !["INSERT", "MODIFY"].includes(record.eventName ?? "")) continue;
      const image = unmarshall(record.dynamodb.NewImage) as Partial<DurableOutboxRecord>;
      if (image.entityType !== "OUTBOX" || image.status !== "PENDING" || typeof image.id !== "string") continue;
      await dependencies.send(image as DurableOutboxRecord);
      await dependencies.markQueued(image.id);
      published += 1;
    }
    if (dependencies.index !== undefined) {
      try {
        const records = event.Records ?? [];
        if (context === undefined) {
          await dependencies.index(records);
        } else {
          // A4: the index is abandoned at its deadline even if it never settles, so the batch ends in time.
          const deadline = Date.now() + context.getRemainingTimeInMillis() - INDEX_SAFETY_MARGIN_MS;
          await byDeadline(deadline, () => dependencies.index!(records, { deadline }));
        }
      } catch (error) {
        // A4: dispatch never waits on, or repeats for, the index; the error's name only.
        console.log(JSON.stringify({ component: "outbox-publisher", event: "activity_index.write_failed", error: error instanceof Error ? error.name : "unknown" }));
      }
    }
    return { published };
  };
}

const queueUrl = process.env.DISPATCH_QUEUE_URL;
const tableName = process.env.STATE_TABLE_NAME;
const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
const sqs = new SQSClient(awsClientConfiguration);
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration));

export const handler = createOutboxPublisherHandler({
  async send(record) {
    await sqs.send(new SendMessageCommand({ QueueUrl: required(queueUrl, "DISPATCH_QUEUE_URL"), MessageBody: JSON.stringify(record) }));
  },
  async markQueued(id) {
    try {
      await documentClient.send(new UpdateCommand({
        TableName: required(tableName, "STATE_TABLE_NAME"),
        Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" },
        UpdateExpression: "SET #status = :queued, queuedAt = :now",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":pending": "PENDING",
          ":queued": "QUEUED",
          ":now": new Date().toISOString(),
        },
      }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
    }
  },
  index: (records, options) => indexActivity(records, {
    // A4: the SDK has no default request timeout; the index's signal aborts a hung request.
    get: async (key, requestOptions) => ((await documentClient.send(new GetCommand({ TableName: required(tableName, "STATE_TABLE_NAME"), Key: key, ConsistentRead: true }), abortOptions(requestOptions?.signal))) as { Item?: Record<string, unknown> }).Item,
    put: async (item, requestOptions) => {
      try {
        await documentClient.send(new PutCommand({ TableName: required(tableName, "STATE_TABLE_NAME"), Item: item, ConditionExpression: "attribute_not_exists(pk)" }), abortOptions(requestOptions?.signal));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
      }
    },
  }, (entry) => console.log(JSON.stringify({ component: "outbox-publisher", ...entry })), options?.deadline ?? Date.now() + INDEX_DEFAULT_BUDGET_MS),
});

/** The SDK's per-request options: the index's abort signal, when it gave one. */
function abortOptions(signal: AbortSignal | undefined): { abortSignal?: AbortSignal } {
  return signal === undefined ? {} : { abortSignal: signal };
}

function required(value: string | undefined, name: string): string {
  return value ?? requiredEnvironment(name);
}
