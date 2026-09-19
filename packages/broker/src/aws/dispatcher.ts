import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { WorkerInvocationSchema, agentXError, type WorkerInvocation } from "@agentx/contracts";
import { requiredEnvironment, type DurableOutboxRecord } from "./lambda.js";

export interface AgentCoreInvocationInput {
  runtimeArn: string;
  endpointQualifier: string;
  runtimeSessionId: string;
  payload: WorkerInvocation;
}

interface SqsRecord {
  messageId: string;
  body: string;
}

export interface SqsEvent {
  Records?: SqsRecord[];
}

export function createDispatcherHandler(dependencies: {
  invoke: (input: AgentCoreInvocationInput) => Promise<{ statusCode?: number }>;
  markDispatching: (record: DurableOutboxRecord) => Promise<boolean | void>;
  markDelivered: (id: string) => Promise<void>;
}) {
  return async (event: SqsEvent): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
    const batchItemFailures: Array<{ itemIdentifier: string }> = [];
    for (const message of event.Records ?? []) {
      try {
        const parsed = JSON.parse(message.body) as DurableOutboxRecord;
        const invocation = WorkerInvocationSchema.parse(parsed.invocation);
        const record: DurableOutboxRecord = { ...parsed, invocation };
        const shouldInvoke = await dependencies.markDispatching(record);
        if (shouldInvoke === false) {
          await dependencies.markDelivered(record.id);
          continue;
        }
        const response = await dependencies.invoke({
          runtimeArn: record.runtimeArn,
          endpointQualifier: record.endpointQualifier,
          runtimeSessionId: record.runtimeSessionId,
          payload: invocation,
        });
        if (response.statusCode !== undefined && response.statusCode >= 300) {
          throw agentXError("RUNTIME_UNAVAILABLE", `AgentCore returned HTTP ${response.statusCode}`);
        }
        await dependencies.markDelivered(record.id);
      } catch {
        batchItemFailures.push({ itemIdentifier: message.messageId });
      }
    }
    return { batchItemFailures };
  };
}

const tableName = process.env.STATE_TABLE_NAME;
const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
const agentCore = new BedrockAgentCoreClient(awsClientConfiguration);
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration));

export const handler = createDispatcherHandler({
  async invoke(input) {
    const response = await agentCore.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: input.runtimeArn,
      qualifier: input.endpointQualifier,
      runtimeSessionId: input.runtimeSessionId,
      contentType: "application/json",
      accept: "application/json",
      payload: Buffer.from(JSON.stringify(input.payload)),
    }));
    if (response.response && "transformToByteArray" in response.response) {
      await response.response.transformToByteArray();
    }
    return response.statusCode === undefined ? {} : { statusCode: response.statusCode };
  },
  async markDispatching(record) {
    try {
      await documentClient.send(new UpdateCommand({
        TableName: requiredEnvironment("STATE_TABLE_NAME"),
        Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
        UpdateExpression: "SET #status = :dispatching, updatedAt = :now",
        ConditionExpression: "#status = :accepted OR #status = :dispatching",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":accepted": "ACCEPTED",
          ":dispatching": "DISPATCHING",
          ":now": new Date().toISOString(),
        },
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  },
  async markDelivered(id) {
    await documentClient.send(new UpdateCommand({
      TableName: tableName ?? requiredEnvironment("STATE_TABLE_NAME"),
      Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" },
      UpdateExpression: "SET #status = :delivered, deliveredAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":delivered": "DELIVERED", ":now": new Date().toISOString() },
    }));
  },
});
