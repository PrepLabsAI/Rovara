import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { GetCommand, QueryCommand, DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { SlackTeamIdSchema, WORKER_PING_FEATURES_FIELD, WorkerInvocationSchema, agentXError, type SlackChannelBinding, type WorkerInvocation } from "@agentx/contracts";
import { requiredEnvironment, type DurableOutboxRecord, type Ec2OutboxRecord } from "./lambda.js";
import type { Ec2Delivery } from "./ec2-delivery.js";
import { failOutboxOperation } from "./outbox-failure.js";
import { createEc2Delivery } from "./ec2-delivery.js";
import { appendOperationEvent } from "./operation-events.js";
import { SessionManager, workspaceBinding } from "./sessions.js";
import { guardTaskDispatch } from "./task-dispatch-access.js";
import { createTaskAuthorityAdmission } from "./task-authority-admission.js";
import { createTaskPersonRuntime, type TaskPersonDeveloperRecordProjection, type TaskPersonRuntimePorts } from "./task-person-runtime.js";
import { taskPersonProofThroughLambda } from "./task-person-proof-transport.js";

const DEFAULT_MAX_DISPATCH_ATTEMPTS = 5;

interface SqsRecord {
  messageId: string;
  body: string;
  attributes?: { ApproximateReceiveCount?: string };
}

export interface SqsEvent {
  Records?: SqsRecord[];
}

export interface DispatcherLambdaContext { getRemainingTimeInMillis(): number }

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
  /** Strongly checks and durably parks PEOPLE-backed work before any dispatch state or worker side effect. */
  guardTaskDispatch?: (record: DurableOutboxRecord, context?: { remainingTimeMs: () => number }) => Promise<"ALLOWED" | "PARKED">;
  markDispatching: (record: DurableOutboxRecord) => Promise<boolean | void>;
  markDelivered: (id: string) => Promise<void>;
  markFailed: (record: DurableOutboxRecord, error: string) => Promise<void>;
  /** Delivers an ec2-ebs record; without it such records fail like any undeliverable one. */
  deliverEc2?: (record: Ec2OutboxRecord, invocation: WorkerInvocation, context?: { remainingTimeMs: () => number }) => Promise<Ec2Delivery>;
  maxAttempts?: number;
  log?: (entry: DispatchLogEntry) => void;
}) {
  return async (event: SqsEvent, context?: DispatcherLambdaContext): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
    const batchItemFailures: Array<{ itemIdentifier: string }> = [];
    const records = event.Records ?? [];
    const remainingTimeMs = () => context?.getRemainingTimeInMillis() ?? 60_000;
    for (let index = 0; index < records.length; index += 1) {
      const message = records[index]!;
      if (remainingTimeMs() <= 2_000) {
        for (const unstarted of records.slice(index)) batchItemFailures.push({ itemIdentifier: unstarted.messageId });
        break;
      }
      let record: DurableOutboxRecord | undefined;
      const attempt = receiveCount(message);
      const maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_DISPATCH_ATTEMPTS;
      try {
        const parsed = JSON.parse(message.body) as DurableOutboxRecord;
        const invocation = WorkerInvocationSchema.parse(parsed.invocation);
        record = { ...parsed, invocation };
        if (await dependencies.guardTaskDispatch?.(record, { remainingTimeMs }) === "PARKED") continue;
        const shouldInvoke = await dependencies.markDispatching(record);
        if (shouldInvoke === false) {
          await dependencies.markDelivered(record.id);
          continue;
        }
        if (record.deploymentMode === "ec2-ebs") {
          if (dependencies.deliverEc2 === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "this dispatcher cannot reach ec2-ebs workers");
          // A record parked until its session is ready is acknowledged without using an attempt.
          if (await dependencies.deliverEc2(record, invocation, { remainingTimeMs }) === "DELIVERED") await dependencies.markDelivered(record.id);
          continue;
        }
        throw agentXError("RUNTIME_UNAVAILABLE", "retired deployment mode cannot execute work; register an ec2-ebs project");
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
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration));
/** Authority-only reads/fences do not silently consume retry time from the shared SDK client. */
const taskAuthorityDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ ...awsClientConfiguration, maxAttempts: 1 }));
const kms = new KMSClient(awsClientConfiguration);
const sfn = new SFNClient(awsClientConfiguration);
const lambdaClient = new LambdaClient(awsClientConfiguration);

function taskPersonRuntimePorts(input: {
  admission: ReturnType<typeof createTaskAuthorityAdmission>;
  stateTableName: string;
  signInTableName: string | undefined;
  proofArn: string;
  slackTeamId: string;
}): TaskPersonRuntimePorts {
  const projection = (attributes: readonly string[]) => ({
    ProjectionExpression: attributes.map((_, index) => `#p${index}`).join(", "),
    ExpressionAttributeNames: Object.fromEntries(attributes.map((attribute, index) => [`#p${index}`, attribute])),
  });
  const queryPages = async <T>(inputQuery: {
    pk: string; prefix: string; projection: readonly string[]; abortSignal: AbortSignal;
  }): Promise<{ items: T[]; complete: boolean }> => {
    const items: T[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let page = 0;
    do {
      if (page >= 128 || items.length >= 10_000) return { items, complete: false };
      const abortSignal = page === 0 ? inputQuery.abortSignal : input.admission.admitStateRead();
      const queryProjection = projection(inputQuery.projection);
      const response = await taskAuthorityDocumentClient.send(new QueryCommand({
        TableName: input.stateTableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": inputQuery.pk, ":prefix": inputQuery.prefix },
        ...queryProjection,
        ConsistentRead: true,
        Limit: 100,
        ScanIndexForward: false,
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
      }), { abortSignal });
      input.admission.assertOpen();
      const result = response as { Items?: T[]; LastEvaluatedKey?: Record<string, unknown> };
      items.push(...(result.Items ?? []));
      exclusiveStartKey = result.LastEvaluatedKey;
      page += 1;
    } while (exclusiveStartKey !== undefined);
    return { items, complete: true };
  };
  const taskProjection = (sortKey: string): readonly string[] => sortKey === "META"
    ? ["pk", "sk", "entityType", "taskId", "project", "developerId", "provider", "slackUserId", "developerName", "share"]
    : sortKey.startsWith("PERSON_SUBJECT#")
      ? ["pk", "sk", "schemaVersion", "personId", "developerId", "createdAt"]
      : ["pk", "sk", "schemaVersion", "personId", "developerId", "slackUserId", "name", "method", "issuer", "subject", "createdAt"];
  return {
    async readTaskRecord({ taskId, sortKey, abortSignal }) {
      const fields = taskProjection(sortKey);
      const response = await taskAuthorityDocumentClient.send(new GetCommand({
        TableName: input.stateTableName,
        Key: { pk: `DEVTASK#${taskId}`, sk: sortKey },
        ConsistentRead: true,
        ...projection(fields),
      }), { abortSignal });
      input.admission.assertOpen();
      return (response as { Item?: Record<string, unknown> }).Item;
    },
    async readDeveloperRecord({ developerId, projection: fields, abortSignal }) {
      if (input.signInTableName === undefined) throw new Error("developer sign-in table is unavailable");
      const response = await taskAuthorityDocumentClient.send(new GetCommand({
        TableName: input.signInTableName,
        Key: { pk: `DEVELOPER#${developerId}`, sk: "META" },
        ConsistentRead: true,
        ...projection(fields),
      }), { abortSignal });
      input.admission.assertOpen();
      return (response as unknown as { Item?: TaskPersonDeveloperRecordProjection }).Item;
    },
    projectAuthorityReader: {
      async latestRevision(project, admission, abortSignal) {
        const response = await taskAuthorityDocumentClient.send(new QueryCommand({
          TableName: input.stateTableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":prefix": "REV#" },
          ProjectionExpression: "#pk, #sk, #definition.#revision, #definition.#developerTasks",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk", "#definition": "definition", "#revision": "revision", "#developerTasks": "developerTasks" },
          ConsistentRead: true,
          Limit: 1,
          ScanIndexForward: false,
        }), { abortSignal });
        admission.assertOpen();
        const item = (response as { Items?: Array<{ pk?: string; sk?: string; definition?: { revision?: number; developerTasks?: unknown } }> }).Items?.[0];
        if (item?.definition === undefined) return { complete: true };
        return { revision: { ...(item.pk === undefined ? {} : { pk: item.pk }), ...(item.sk === undefined ? {} : { sk: item.sk }), revision: item.definition.revision as number,
          definition: Object.hasOwn(item.definition, "developerTasks") ? { developerTasks: item.definition.developerTasks } : {} }, complete: true };
      },
      async memberships(developerId, admission, abortSignal) {
        const result = await queryPages<{ pk: string; sk: string; projectName: string; role?: string }>({
          pk: `MEMBER#${developerId}`, prefix: "PROJECT#", projection: ["pk", "sk", "projectName", "role"], abortSignal,
        });
        admission.assertOpen();
        return result;
      },
      async bindings(teamId, admission, abortSignal) {
        const result = await queryPages<SlackChannelBinding & { pk: string; sk: string }>({
          pk: `SLACK_BINDING#${teamId}`, prefix: "CHANNEL#", projection: ["pk", "sk", "teamId", "channelId", "projectName", "updatedAt"], abortSignal,
        });
        admission.assertOpen();
        return result;
      },
    },
    taskPersonProof: (request, admission) => taskPersonProofThroughLambda({
      admission,
      now: () => Date.now(),
      expectedTeamId: input.slackTeamId,
      async invoke(payload, options) {
        const response = await lambdaClient.send(new InvokeCommand({ FunctionName: input.proofArn, Payload: payload }), { abortSignal: options.abortSignal });
        return { ...(response.FunctionError === undefined ? {} : { FunctionError: response.FunctionError }), ...(response.Payload === undefined ? {} : { Payload: response.Payload }) };
      },
    })(request),
  };
}

const taskDispatchGuard = (record: DurableOutboxRecord, context?: { remainingTimeMs: () => number }) => {
  const stateTableName = tableName ?? requiredEnvironment("STATE_TABLE_NAME");
  const admission = createTaskAuthorityAdmission({ now: () => Date.now(), lambdaRemainingMs: context?.remainingTimeMs() ?? 60_000 });
  const proofArn = process.env.TASK_PERSON_PROOF_FUNCTION_ARN;
  const slackTeamId = process.env.SLACK_TEAM_ID ?? "";
  const personRuntime = proofArn === undefined || proofArn.trim() === "" || !SlackTeamIdSchema.safeParse(slackTeamId).success ? undefined : createTaskPersonRuntime({
    admission,
    ports: taskPersonRuntimePorts({
      admission,
      stateTableName,
      signInTableName: process.env.DEVELOPER_SIGNIN_TABLE_NAME,
      proofArn,
      slackTeamId,
    }),
    stateTableName,
    slackTeamId,
    now: () => Date.now(),
    uuid: randomUUID,
  });
  const checkTaskPerson = personRuntime?.checkTaskPerson;
  return guardTaskDispatch({
    documentClient: taskAuthorityDocumentClient,
    tableName: stateTableName,
    admission,
    ...(context === undefined ? {} : { remainingTimeMs: context.remainingTimeMs }),
    ...(checkTaskPerson === undefined ? {} : { checkTaskPerson }),
    ...(personRuntime === undefined ? {} : { stateAuthorityWitnessForOwnerActor: (task, ownerActorId) => personRuntime.stateAuthorityWitnessForOwnerActor(task, ownerActorId) }),
  }, record);
};
/** A worker answers /invocations as soon as it has journaled the operation. */
const WORKER_POST_TIMEOUT_MS = 10_000;
/** Asking a worker what it parses (spec 053); one that does not answer gets no optional field. */
const WORKER_PING_TIMEOUT_MS = 3_000;

/**
 * Spec 053: the invocation features a worker reports on GET /ping; none for a worker built before
 * them, whose /ping has no such field. A worker that does not answer, or answers with a non-2xx
 * status, rejects, failing the attempt rather than dropping the level.
 */
export async function workerPingFeatures(url: string, fetchPing: typeof fetch = fetch): Promise<string[]> {
  const response = await fetchPing(url, { signal: AbortSignal.timeout(WORKER_PING_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`worker /ping returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  const features = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[WORKER_PING_FEATURES_FIELD] : undefined;
  return Array.isArray(features) ? features.filter((feature): feature is string => typeof feature === "string") : [];
}

const deliverEc2 = createEc2Delivery({
  sessions: new SessionManager({
    documentClient,
    tableName: tableName ?? "",
    executions: {
      provisionerArn: process.env.PROVISIONER_ARN ?? "",
      deleterArn: process.env.DELETER_ARN ?? "",
      async start(input) {
        return (await sfn.send(new StartExecutionCommand(input))).executionArn!;
      },
    },
  }),
  binding: (workspaceId) => workspaceBinding(documentClient, tableName ?? requiredEnvironment("STATE_TABLE_NAME"), workspaceId),
  async sign(message) {
    const response = await kms.send(new SignCommand({
      KeyId: requiredEnvironment("INVOKE_SIGNING_KEY_ARN"),
      Message: message,
      MessageType: "RAW",
      SigningAlgorithm: "ECDSA_SHA_256",
    }));
    return response.Signature!;
  },
  async post(url, init) {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: init.authorization, "content-type": "application/json" },
      body: init.body,
      signal: AbortSignal.timeout(WORKER_POST_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.text() };
  },
  workerFeatures: (url) => workerPingFeatures(url),
  guardTaskDispatch: taskDispatchGuard,
  async progress(record, message) {
    await appendOperationEvent(documentClient, tableName ?? requiredEnvironment("STATE_TABLE_NAME"), {
      workspaceId: record.workspaceId,
      operationId: record.operationId,
      fence: record.invocation.fence,
      onceKey: `session-wait#${record.id}`,
      event: { type: "progress", timestamp: new Date().toISOString(), payload: { message } },
    });
  },
});

export const handler = createDispatcherHandler({
  guardTaskDispatch: taskDispatchGuard,
  deliverEc2,
  maxAttempts: parseMaximumAttempts(process.env.MAX_DISPATCH_ATTEMPTS),
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
    await failOutboxOperation(documentClient, tableName ?? requiredEnvironment("STATE_TABLE_NAME"), record, error);
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
    `RUNTIME_UNAVAILABLE: worker dispatch failed after ${attempts} attempts${details ? ` (${details})` : ""}`,
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
