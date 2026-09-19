import { DynamoDBClient, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { requiredEnvironment, type DurableOutboxRecord } from "./lambda.js";

interface DynamoStreamRecord {
  eventName?: string;
  dynamodb?: { NewImage?: Record<string, AttributeValue> };
}

export interface DynamoStreamEvent {
  Records?: DynamoStreamRecord[];
}

export function createOutboxPublisherHandler(dependencies: {
  send: (record: DurableOutboxRecord) => Promise<void>;
  markQueued: (id: string) => Promise<void>;
}) {
  return async (event: DynamoStreamEvent): Promise<{ published: number }> => {
    let published = 0;
    for (const record of event.Records ?? []) {
      if (!record.dynamodb?.NewImage || !["INSERT", "MODIFY"].includes(record.eventName ?? "")) continue;
      const image = unmarshall(record.dynamodb.NewImage) as Partial<DurableOutboxRecord>;
      if (image.entityType !== "OUTBOX" || image.status !== "PENDING" || typeof image.id !== "string") continue;
      await dependencies.send(image as DurableOutboxRecord);
      await dependencies.markQueued(image.id);
      published += 1;
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
});

function required(value: string | undefined, name: string): string {
  return value ?? requiredEnvironment(name);
}
