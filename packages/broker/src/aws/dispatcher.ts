import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { WorkerInvocationSchema, agentXError, type WorkerInvocation } from "@agentx/contracts";
import { requiredEnvironment, type DurableOutboxRecord } from "./lambda.js";

const DEFAULT_MAX_DISPATCH_ATTEMPTS = 5;

export interface AgentCoreInvocationInput {
  runtimeArn: string;
  endpointQualifier: string;
  runtimeSessionId: string;
  payload: WorkerInvocation;
}

export interface AgentCoreInvocationResult {
  statusCode?: number;
  error?: string;
}

interface SqsRecord {
  messageId: string;
  body: string;
  attributes?: { ApproximateReceiveCount?: string };
}

export interface SqsEvent {
  Records?: SqsRecord[];
}

export interface DispatchLogEntry {
  level: "warn" | "error";
  event: "dispatch.attempt_failed" | "dispatch.terminal_transition_failed";
  operationId?: string;
  workspaceId?: string;
  outboxId?: string;
  messageId: string;
  attempt: number;
  maxAttempts: number;
  terminal: boolean;
  errorName: string;
  errorCode?: string;
  httpStatusCode?: number;
  errorMessage?: string;
}

export function createDispatcherHandler(dependencies: {
  invoke: (input: AgentCoreInvocationInput) => Promise<AgentCoreInvocationResult>;
  markDispatching: (record: DurableOutboxRecord) => Promise<boolean | void>;
  markDelivered: (id: string) => Promise<void>;
  markFailed: (record: DurableOutboxRecord, error: string) => Promise<void>;
  maxAttempts?: number;
  log?: (entry: DispatchLogEntry) => void;
}) {
  return async (event: SqsEvent): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
    const batchItemFailures: Array<{ itemIdentifier: string }> = [];
    for (const message of event.Records ?? []) {
      let record: DurableOutboxRecord | undefined;
      const attempt = receiveCount(message);
      const maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_DISPATCH_ATTEMPTS;
      try {
        const parsed = JSON.parse(message.body) as DurableOutboxRecord;
        const invocation = WorkerInvocationSchema.parse(parsed.invocation);
        record = { ...parsed, invocation };
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
          throw agentXError(
            "RUNTIME_UNAVAILABLE",
            `AgentCore returned HTTP ${response.statusCode}${response.error ? `: ${sanitizeErrorMessage(response.error)}` : ""}`,
          );
        }
        await dependencies.markDelivered(record.id);
      } catch (error) {
        const terminal = record !== undefined && attempt >= maxAttempts;
        logDispatchFailure(dependencies.log, {
          ...errorLogFields(error),
          level: "warn",
          event: "dispatch.attempt_failed",
          ...(record === undefined ? {} : {
            operationId: record.operationId,
            workspaceId: record.workspaceId,
            outboxId: record.id,
          }),
          messageId: message.messageId,
          attempt,
          maxAttempts,
          terminal,
        });
        if (terminal && record) {
          try {
            await dependencies.markFailed(record, terminalDispatchError(error, attempt));
            continue;
          } catch (transitionError) {
            logDispatchFailure(dependencies.log, {
              ...errorLogFields(transitionError),
              level: "error",
              event: "dispatch.terminal_transition_failed",
              operationId: record.operationId,
              workspaceId: record.workspaceId,
              outboxId: record.id,
              messageId: message.messageId,
              attempt,
              maxAttempts,
              terminal: true,
            });
          }
        }
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
  maxAttempts: parseMaximumAttempts(process.env.MAX_DISPATCH_ATTEMPTS),
  async invoke(input) {
    const response = await agentCore.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: input.runtimeArn,
      qualifier: input.endpointQualifier,
      runtimeSessionId: input.runtimeSessionId,
      contentType: "application/json",
      accept: "application/json",
      payload: Buffer.from(JSON.stringify(input.payload)),
    }));
    const body = response.response && "transformToByteArray" in response.response
      ? Buffer.from(await response.response.transformToByteArray()).toString("utf8")
      : undefined;
    const runtimeError = response.statusCode !== undefined && response.statusCode >= 300
      ? runtimeErrorMessage(body)
      : undefined;
    return {
      ...(response.statusCode === undefined ? {} : { statusCode: response.statusCode }),
      ...(runtimeError === undefined ? {} : { error: runtimeError }),
    };
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
  async markFailed(record, error) {
    const now = new Date().toISOString();
    const releaseWorkspace = record.invocation.kind !== "cancel";
    const workspaceStatus = record.invocation.kind === "prepare" ? "PREPARATION_FAILED" : "READY";
    await documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Update: {
          TableName: tableName ?? requiredEnvironment("STATE_TABLE_NAME"),
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
          TableName: tableName ?? requiredEnvironment("STATE_TABLE_NAME"),
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
          TableName: tableName ?? requiredEnvironment("STATE_TABLE_NAME"),
          Key: { pk: `OUTBOX#${record.id}`, sk: "OUTBOX" },
          UpdateExpression: "SET #status = :failed, failedAt = :now, #error = :error",
          ExpressionAttributeNames: { "#status": "status", "#error": "error" },
          ExpressionAttributeValues: { ":failed": "FAILED", ":now": now, ":error": error },
        } },
      ],
    }));
  },
});

function receiveCount(message: SqsRecord): number {
  const parsed = Number.parseInt(message.attributes?.ApproximateReceiveCount ?? "1", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function parseMaximumAttempts(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_DISPATCH_ATTEMPTS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("MAX_DISPATCH_ATTEMPTS must be an integer from 1 through 100");
  }
  return parsed;
}

function terminalDispatchError(error: unknown, attempts: number): string {
  const fields = errorLogFields(error);
  const details = [
    fields.errorName,
    fields.errorCode,
    fields.httpStatusCode === undefined ? undefined : `HTTP ${fields.httpStatusCode}`,
  ].filter((value): value is string => value !== undefined).join("/");
  return [
    `RUNTIME_UNAVAILABLE: AgentCore dispatch failed after ${attempts} attempts${details ? ` (${details})` : ""}`,
    fields.errorMessage,
  ].filter((value): value is string => value !== undefined).join(": ").slice(0, 16_384);
}

function errorLogFields(error: unknown): Pick<
  DispatchLogEntry,
  "errorName" | "errorCode" | "httpStatusCode" | "errorMessage"
> {
  if (!error || typeof error !== "object") return { errorName: typeof error };
  const candidate = error as Record<string, unknown>;
  const metadata = candidate.$metadata;
  const status = metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>).httpStatusCode
    : undefined;
  return {
    errorName: error instanceof Error ? error.name : "object",
    ...(typeof candidate.code === "string" ? { errorCode: candidate.code } : {}),
    ...(typeof status === "number" ? { httpStatusCode: status } : {}),
    ...(error instanceof Error ? { errorMessage: sanitizeErrorMessage(error.message) } : {}),
  };
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\b(?:xapp|xoxb|xoxp|xoxa|xoxr|AKIA)[A-Za-z0-9_-]+\b/gu, "<redacted>")
    .replace(/\bBearer\s+\S+/giu, "Bearer <redacted>")
    .slice(0, 512);
}

function runtimeErrorMessage(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const error = (parsed as Record<string, unknown>).error;
    return typeof error === "string" ? sanitizeErrorMessage(error) : undefined;
  } catch {
    return undefined;
  }
}

function logDispatchFailure(
  logger: ((entry: DispatchLogEntry) => void) | undefined,
  entry: DispatchLogEntry,
): void {
  if (logger) {
    logger(entry);
    return;
  }
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}
