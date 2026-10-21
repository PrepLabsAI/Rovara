import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { GetCommand, QueryCommand, DynamoDBDocumentClient, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { Ec2RuntimeBindingSchema, ProjectSetupExecutionSchema, ProjectSetupOperationSchema, ProjectSetupSessionSchema, SlackTeamIdSchema, WORKER_PING_FEATURES_FIELD, WorkerInvocationSchema, agentXError, projectSetupExecutionKey, projectSetupOperationKey, projectSetupSessionKey, workspaceSessionKey, type SlackChannelBinding, type WorkerInvocation } from "@agentx/contracts";
import { requiredEnvironment, type DurableOutboxRecord, type Ec2OutboxRecord } from "./lambda.js";
import type { Ec2Delivery } from "./ec2-delivery.js";
import { failOutboxOperation } from "./outbox-failure.js";
import { createEc2Delivery } from "./ec2-delivery.js";
import { createWorkflowE2EAdmissionAgentStepsReader, createWorkflowE2EAdmissionSchemaReader } from "./workflow-e2e-admission-schema.js";
import { appendOperationEvent } from "./operation-events.js";
import { ProjectSetupSessionManager, SessionManager, workspaceBinding } from "./sessions.js";
import { admitProjectSetupRuntime, projectSetupRuntimeKey, ProjectSetupRuntimeRecordSchema } from "./project-setup-runtime-catalog.js";
import { guardTaskDispatch, isTaskDispatchGuardRetryError } from "./task-dispatch-access.js";
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

/** Validates an internal warm-up against its stored operation and every active workflow/workspace fence. */
/**
 * Clears the planning operation's record of the schema-v2 application plan when delivery dropped it for an older worker, so the broker refuses a
 * v2 plan that run uploads (Ruling AW). Idempotent: a redelivery clears an already-cleared record.
 */
export function createApplicationPlanNegotiationRecorder(input: { documentClient: DynamoDBDocumentClient; tableName?: string }) {
  return async (record: Ec2OutboxRecord): Promise<void> => {
    await input.documentClient.send(new UpdateCommand({
      TableName: input.tableName ?? requiredEnvironment("STATE_TABLE_NAME"),
      Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
      UpdateExpression: "REMOVE workflowE2EPlanVersion",
      ConditionExpression: "attribute_exists(pk)",
    }));
  };
}

export function createWorkflowE2EReadinessValidator(input: { documentClient: DynamoDBDocumentClient; tableName?: string }) {
  return async (record: Ec2OutboxRecord, invocation: WorkerInvocation): Promise<"ORDINARY" | "READINESS" | "PARKED"> => {
    if (invocation.kind !== "resume") return "ORDINARY";
    const table = input.tableName ?? requiredEnvironment("STATE_TABLE_NAME");
    const opKey = { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` };
    const operation = (await input.documentClient.send(new GetCommand({ TableName: table, Key: opKey, ConsistentRead: true }))).Item as Record<string, unknown> | undefined;
    const marker = operation?.workflowE2EReadiness as Record<string, unknown> | undefined;
    if (marker === undefined) {
      if (record.workflowE2EReadiness !== undefined) throw agentXError("CALLBACK_FORBIDDEN", "an outbox readiness marker has no stored operation authority");
      return "ORDINARY";
    }
    const outbox = (await input.documentClient.send(new GetCommand({ TableName: table,
      Key: { pk: `OUTBOX#${record.id}`, sk: "OUTBOX" }, ConsistentRead: true }))).Item as Record<string, unknown> | undefined;
    const taskId = marker.taskId;
    const dispatchSk = marker.dispatchSk;
    const task = typeof taskId === "string" ? (await input.documentClient.send(new GetCommand({ TableName: table,
      Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true }))).Item as Record<string, unknown> | undefined : undefined;
    const dispatch = typeof dispatchSk === "string" ? (await input.documentClient.send(new GetCommand({ TableName: table,
      Key: { pk: "WORKFLOW_DISPATCH", sk: dispatchSk }, ConsistentRead: true }))).Item as Record<string, unknown> | undefined : undefined;
    const workspace = (await input.documentClient.send(new GetCommand({ TableName: table,
      Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: "META" }, ConsistentRead: true }))).Item as Record<string, unknown> | undefined;
    const workflow = task?.workflow as Record<string, unknown> | undefined;
    const candidate = workflow?.candidate as Record<string, unknown> | undefined;
    const dispatchRevision = dispatch?.workflowRevision;
    const dispatchCandidate = dispatch?.candidateDigest;
    const storedInvocation = outbox?.invocation as Record<string, unknown> | undefined;
    const storedPayload = storedInvocation?.payload as Record<string, unknown> | undefined;
    const durableOutboxMarker = outbox?.workflowE2EReadiness as Record<string, unknown> | undefined;
    const exactMarker = record.workflowE2EReadiness !== undefined && durableOutboxMarker !== undefined
      && marker.purpose === "workflow-e2e-readiness" && record.workflowE2EReadiness.purpose === marker.purpose
      && record.workflowE2EReadiness.taskId === marker.taskId && record.workflowE2EReadiness.workflowRevision === marker.workflowRevision
      && record.workflowE2EReadiness.candidateDigest === marker.candidateDigest && record.workflowE2EReadiness.dispatchSk === marker.dispatchSk
      && durableOutboxMarker.purpose === marker.purpose && durableOutboxMarker.taskId === marker.taskId
      && durableOutboxMarker.workflowRevision === marker.workflowRevision && durableOutboxMarker.candidateDigest === marker.candidateDigest
      && durableOutboxMarker.dispatchSk === marker.dispatchSk
      && marker.outboxId === record.id;
    if (!exactMarker || operation?.kind !== "resume" || operation.status !== "DISPATCHING" || operation.id !== record.operationId
      || operation.workspaceId !== record.workspaceId || operation.fence !== invocation.fence || invocation.operationId !== record.operationId
      || invocation.workspaceId !== record.workspaceId || invocation.payload === undefined || Object.keys(invocation.payload).length !== 0
      || outbox?.operationId !== record.operationId || outbox.workspaceId !== record.workspaceId || outbox.id !== record.id
      || storedInvocation?.kind !== "resume" || storedInvocation.operationId !== record.operationId
      || storedInvocation.workspaceId !== record.workspaceId || storedInvocation.fence !== invocation.fence
      || storedPayload === undefined || Object.keys(storedPayload).length !== 0
      || outbox.workflowE2EReadiness === undefined
      || !["QUEUED", "PENDING", "WAITING_FOR_SESSION", "WAITING_FOR_TASK_ACCESS"].includes(String(outbox.status))
      || workspace?.status !== "BUSY" || workspace.id !== record.workspaceId || workspace.projectRevision !== invocation.projectRevision
      || workspace.activeOperationId !== record.operationId || workspace.fence !== invocation.fence
      || task?.taskId !== taskId || task?.workspaceId !== record.workspaceId || task?.closedAt !== undefined
      || workflow?.revision !== marker.workflowRevision || workflow?.stage !== "VERIFY" || workflow?.state !== "WAITING"
      || candidate?.digest !== marker.candidateDigest || (workflow.e2e as Record<string, unknown> | undefined)?.required !== true
      || dispatch?.taskId !== taskId || dispatchRevision !== marker.workflowRevision || dispatchCandidate !== marker.candidateDigest
      || dispatch?.readinessOperationId !== record.operationId || dispatch?.kind !== "CHECKS") {
      throw agentXError("CALLBACK_FORBIDDEN", "the stored E2E readiness operation, outbox, task, or active fence does not match");
    }
    return "READINESS";
  };
}

/** State transitions stay under PROJECT_SETUP#setupExecutionId, never WORKSPACE#transportCorrelationId. */
export interface ProjectSetupDispatchLifecycle {
  markDispatching: (record: DurableOutboxRecord) => Promise<boolean | void>;
  markDelivered: (record: DurableOutboxRecord) => Promise<void>;
  markFailed: (record: DurableOutboxRecord, error: string) => Promise<void>;
}

export function createProjectSetupDispatchLifecycle(input: { documentClient: DynamoDBDocumentClient; tableName: string; now?: () => Date }): ProjectSetupDispatchLifecycle {
  return {
    async markDispatching(record) {
      if (record.invocation.kind !== "project-setup-smoke") return false;
      const setupId = record.invocation.payload.setupExecutionId;
      const operationKey = projectSetupOperationKey(setupId, record.operationId);
      const now = (input.now ?? (() => new Date()))().toISOString();
      try {
        await input.documentClient.send(new TransactWriteCommand({ TransactItems: [
          { Update: { TableName: input.tableName, Key: projectSetupExecutionKey(setupId),
            UpdateExpression: "SET #state = :dispatching, updatedAt = :now",
            ConditionExpression: "#state = :accepted OR #state = :dispatching",
            ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":now": now } } },
          { Update: { TableName: input.tableName, Key: operationKey,
            UpdateExpression: "SET #status = :dispatching, updatedAt = :now",
            ConditionExpression: "#status = :accepted OR #status = :dispatching",
            ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":now": now } } },
        ] }));
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionCanceledException") return false;
        throw error;
      }
    },
    async markDelivered(record) {
      if (record.invocation.kind !== "project-setup-smoke") return;
      await input.documentClient.send(new UpdateCommand({ TableName: input.tableName,
        Key: projectSetupOperationKey(record.invocation.payload.setupExecutionId, record.operationId),
        UpdateExpression: "SET #status = :delivered, updatedAt = :now",
        ConditionExpression: "#status = :dispatching OR #status = :delivered",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":dispatching": "DISPATCHING", ":delivered": "DELIVERED", ":now": (input.now ?? (() => new Date()))().toISOString() } }));
    },
    async markFailed(record, message) {
      if (record.invocation.kind !== "project-setup-smoke") return;
      const setupId = record.invocation.payload.setupExecutionId;
      const now = (input.now ?? (() => new Date()))().toISOString();
      await input.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: input.tableName, Key: projectSetupExecutionKey(setupId),
          UpdateExpression: "SET #state = :failed, updatedAt = :now, error = :error",
          ConditionExpression: "#state = :accepted OR #state = :dispatching",
          ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":failed": "FAILED", ":now": now, ":error": message.slice(0, 2_000) } } },
        { Update: { TableName: input.tableName, Key: projectSetupOperationKey(setupId, record.operationId),
          UpdateExpression: "SET #status = :failed, updatedAt = :now, #error = :error",
          ConditionExpression: "#status = :accepted OR #status = :dispatching OR #status = :delivered",
          ExpressionAttributeNames: { "#status": "status", "#error": "error" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":delivered": "DELIVERED", ":failed": "FAILED", ":now": now, ":error": message.slice(0, 2_000) } } },
      ] }));
    },
  };
}

/** Loads only the binding pinned by the stored setup execution and its registered project revision. */
export function createProjectSetupBindingReader(input: { documentClient: DynamoDBDocumentClient; tableName?: string }) {
  return async ({ setupExecutionId, subjectId }: { setupExecutionId: string; subjectId: string }) => {
    const table = input.tableName ?? requiredEnvironment("STATE_TABLE_NAME");
    const item = await input.documentClient.send(new GetCommand({ TableName: table,
      Key: projectSetupExecutionKey(setupExecutionId), ConsistentRead: true }));
    const row = ProjectSetupExecutionSchema.safeParse(setupDomainRow(item.Item, projectSetupExecutionKey(setupExecutionId), "PROJECT_SETUP_EXECUTION"));
    if (!row.success || row.data.subjectId !== subjectId) return undefined;
    const project = (await input.documentClient.send(new GetCommand({ TableName: table,
      Key: { pk: `PROJECT#${row.data.projectName}`, sk: `REV#${String(row.data.projectRevision).padStart(12, "0")}` }, ConsistentRead: true }))).Item as { runtimeBinding?: unknown } | undefined;
    const binding = Ec2RuntimeBindingSchema.safeParse(project?.runtimeBinding);
    return binding.success && binding.data.deploymentMode === "ec2-ebs" ? binding.data : undefined;
  };
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
  /** Strongly checks and durably parks PEOPLE-backed work before any dispatch state or worker side effect. */
  guardTaskDispatch?: (record: DurableOutboxRecord, context?: { remainingTimeMs: () => number }) => Promise<"ALLOWED" | "PARKED">;
  /** Setup work is authorized from its own stored proposal/execution namespace, never a feature task. */
  guardProjectSetupDispatch?: (record: DurableOutboxRecord, context?: { remainingTimeMs: () => number }) => Promise<"ALLOWED" | "PARKED">;
  projectSetupLifecycle?: ProjectSetupDispatchLifecycle;
  markDispatching: (record: DurableOutboxRecord) => Promise<boolean | void>;
  markDelivered: (id: string) => Promise<void>;
  markFailed: (record: DurableOutboxRecord, error: string) => Promise<void>;
  /** Completes only a broker-marked E2E compute-readiness resume after the exact session is READY. */
  completeWorkflowE2EReadiness?: (record: DurableOutboxRecord, generation: number) => Promise<void>;
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
        if (invocation.kind === "project-setup-smoke") {
          if (record.operationId !== invocation.operationId || record.workspaceId !== invocation.workspaceId
            || invocation.payload.transportCorrelationId !== invocation.workspaceId) {
            throw agentXError("CONFIG_INVALID", "project setup outbox identity does not match its authenticated invocation");
          }
          if (dependencies.guardProjectSetupDispatch === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "project setup smoke authority is not configured");
          if (dependencies.projectSetupLifecycle === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "project setup operation storage is not configured");
          if (await dependencies.guardProjectSetupDispatch(record, { remainingTimeMs }) === "PARKED") continue;
        } else if (await dependencies.guardTaskDispatch?.(record, { remainingTimeMs }) === "PARKED") continue;
        const setup = invocation.kind === "project-setup-smoke" ? dependencies.projectSetupLifecycle : undefined;
        const shouldInvoke = await (setup?.markDispatching(record) ?? dependencies.markDispatching(record));
        if (shouldInvoke === false) {
          if (setup) await setup.markDelivered(record);
          await dependencies.markDelivered(record.id);
          continue;
        }
        if (record.deploymentMode === "ec2-ebs") {
          if (dependencies.deliverEc2 === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "this dispatcher cannot reach ec2-ebs workers");
          // A record parked until its session is ready is acknowledged without using an attempt.
          const delivery = await dependencies.deliverEc2(record, invocation, { remainingTimeMs });
          if (typeof delivery === "object") {
            if (invocation.kind !== "resume" || dependencies.completeWorkflowE2EReadiness === undefined) {
              throw agentXError("RUNTIME_UNAVAILABLE", "an internal readiness dispatch is not authorized");
            }
            await dependencies.completeWorkflowE2EReadiness(record, delivery.readinessGeneration);
            continue;
          }
          if (delivery === "DELIVERED") {
            if (setup) await setup.markDelivered(record);
            await dependencies.markDelivered(record.id);
          }
          continue;
        }
        throw agentXError("RUNTIME_UNAVAILABLE", "retired deployment mode cannot execute work; register an ec2-ebs project");
      } catch (error) {
        const terminal = record !== undefined && attempt >= maxAttempts && !isTaskDispatchGuardRetryError(error);
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
            const setup = record.invocation.kind === "project-setup-smoke" ? dependencies.projectSetupLifecycle : undefined;
            if (setup) await setup.markFailed(record, terminalDispatchError(error, attempt));
            else await dependencies.markFailed(record, terminalDispatchError(error, attempt));
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
export const taskPersonProofLambdaClient = new LambdaClient({ ...awsClientConfiguration, maxAttempts: 1 });

export function taskPersonProofInvokeCommand(functionName: string, payload: Uint8Array): InvokeCommand {
  return new InvokeCommand({ FunctionName: functionName, Payload: payload, InvocationType: "RequestResponse" });
}

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
        const response = await taskPersonProofLambdaClient.send(taskPersonProofInvokeCommand(input.proofArn, payload), { abortSignal: options.abortSignal });
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

const setupDomainRow = (item: Record<string, unknown> | undefined, key: { pk: string; sk: string }, entityType: string): Record<string, unknown> | undefined => {
  if (!item || item.pk !== key.pk || item.sk !== key.sk || item.entityType !== entityType) return undefined;
  const { pk: _pk, sk: _sk, entityType: _entityType, ...domain } = item;
  void _pk; void _sk; void _entityType;
  return domain;
};

const setupRuntimeDomainRow = (item: Record<string, unknown> | undefined, key: { pk: string; sk: string }): Record<string, unknown> | undefined => {
  const domain = setupDomainRow(item, key, "PROJECT_SETUP_RUNTIME");
  return domain === undefined ? undefined : { ...domain, entityType: "PROJECT_SETUP_RUNTIME" };
};

export function createProjectSetupDispatchGuard(input: { documentClient: DynamoDBDocumentClient; tableName: string; runtimeCatalogId: string; now?: () => number }) {
  return async (record: DurableOutboxRecord): Promise<"ALLOWED" | "PARKED"> => {
  const invocation = record.invocation;
  const catalogId = input.runtimeCatalogId;
  if (invocation.kind !== "project-setup-smoke" || !catalogId || record.workspaceId !== invocation.payload.transportCorrelationId
    || record.operationId !== invocation.operationId) return "PARKED";
  const setupId = invocation.payload.setupExecutionId;
  const [executionItem, sessionItem, operationItem] = await Promise.all([
    input.documentClient.send(new GetCommand({ TableName: input.tableName, Key: projectSetupExecutionKey(setupId), ConsistentRead: true })),
    input.documentClient.send(new GetCommand({ TableName: input.tableName, Key: projectSetupSessionKey(setupId), ConsistentRead: true })),
    input.documentClient.send(new GetCommand({ TableName: input.tableName, Key: projectSetupOperationKey(setupId, invocation.operationId), ConsistentRead: true })),
  ]);
  const execution = ProjectSetupExecutionSchema.safeParse(setupDomainRow(executionItem.Item, projectSetupExecutionKey(setupId), "PROJECT_SETUP_EXECUTION"));
  const session = ProjectSetupSessionSchema.safeParse(setupDomainRow(sessionItem.Item, projectSetupSessionKey(setupId), "PROJECT_SETUP_SESSION"));
  const operation = ProjectSetupOperationSchema.safeParse(setupDomainRow(operationItem.Item, projectSetupOperationKey(setupId, invocation.operationId), "PROJECT_SETUP_OPERATION"));
  if (!execution.success || !session.success || !operation.success) return "PARKED";
  const row = execution.data;
  if (row.state !== "ACCEPTED" && row.state !== "DISPATCHING") return "PARKED";
  if (row.setupExecutionId !== setupId || row.operationId !== invocation.operationId || row.outboxId !== record.id
    || row.transportCorrelationId !== invocation.payload.transportCorrelationId || row.subjectId !== invocation.payload.subjectId
    || row.approvalRevision !== invocation.payload.approvalRevision || row.fence !== invocation.fence
    || row.executionRef.sha256 !== invocation.payload.executionRef.sha256 || row.executionRef.key !== invocation.payload.executionRef.key
    || operation.data.status !== "ACCEPTED" && operation.data.status !== "DISPATCHING"
    || operation.data.transportCorrelationId !== row.transportCorrelationId || operation.data.fence !== row.fence) return "PARKED";
  const stateTable = input.tableName;
  const projectItem = (await input.documentClient.send(new GetCommand({ TableName: stateTable,
    Key: { pk: `PROJECT#${row.projectName}`, sk: `REV#${String(row.projectRevision).padStart(12, "0")}` }, ConsistentRead: true }))).Item as Record<string, unknown> | undefined;
  const project = projectItem as { registeredBy?: unknown; definition?: { revision?: unknown }; runtimeBinding?: unknown; setupApproval?: { proposalSha256?: unknown; proposalRef?: unknown; decision?: unknown } } | undefined;
  if (!project || project.registeredBy !== row.ownerKey || project.definition?.revision !== row.projectRevision
    || project.setupApproval?.decision !== "approve" || project.setupApproval.proposalSha256 !== row.proposalSha256
    || project.setupApproval.proposalRef !== row.proposalRef) return "PARKED";
  const membership = (await input.documentClient.send(new GetCommand({ TableName: stateTable,
    Key: { pk: `MEMBER#${row.ownerKey}`, sk: `PROJECT#${row.projectName}` }, ConsistentRead: true }))).Item as { role?: unknown } | undefined;
  if (membership?.role !== "administrator") return "PARKED";
  const approved = (await input.documentClient.send(new GetCommand({ TableName: stateTable,
    Key: { pk: `PROJECT_SETUP#${row.projectName}`, sk: `PROPOSAL#${row.proposalSha256}` }, ConsistentRead: true }))).Item as Record<string, unknown> | undefined;
  if (!approved || approved.ownerKey !== row.ownerKey || approved.decision !== "approve" || approved.proposalRef !== row.proposalRef
    || approved.policyDigest !== row.policyDigest) return "PARKED";
  const binding = Ec2RuntimeBindingSchema.safeParse(project.runtimeBinding);
  if (!binding.success || binding.data.deploymentMode !== "ec2-ebs") return "PARKED";
  const catalogItem = await input.documentClient.send(new GetCommand({ TableName: stateTable,
    Key: projectSetupRuntimeKey(catalogId, row.bindingDigest), ConsistentRead: true }));
  const catalogKey = projectSetupRuntimeKey(catalogId, row.bindingDigest);
  const catalog = ProjectSetupRuntimeRecordSchema.safeParse(setupRuntimeDomainRow(catalogItem.Item, catalogKey));
  if (!catalog.success || catalog.data.runtimeCatalogId !== row.runtimeCatalogId
    || catalog.data.catalogRevision !== row.runtimeCatalogRevision
    || catalog.data.transportCorrelationId !== row.transportCorrelationId || catalog.data.generation !== row.runtimeGeneration
    || !admitProjectSetupRuntime(catalog.data, { runtimeCatalogId: catalogId, binding: binding.data, scope: "source-interface", now: (input.now ?? Date.now)() })) return "PARKED";
  const storedSession = session.data;
  if (storedSession.state !== "READY" || storedSession.setupExecutionId !== setupId || storedSession.subjectId !== row.subjectId
    || storedSession.transportCorrelationId !== row.transportCorrelationId || storedSession.approvalRevision !== row.approvalRevision
    || storedSession.bindingDigest !== row.bindingDigest || storedSession.generation !== row.runtimeGeneration) return "PARKED";
  return "ALLOWED";
  };
}

async function guardProjectSetupDispatch(record: DurableOutboxRecord): Promise<"ALLOWED" | "PARKED"> {
  const catalogId = process.env.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID;
  const stateTable = tableName ?? (process.env.STATE_TABLE_NAME ?? "");
  if (!catalogId || !stateTable) return "PARKED";
  return createProjectSetupDispatchGuard({ documentClient, tableName: stateTable, runtimeCatalogId: catalogId })(record);
}
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
  projectSetupSessions: new ProjectSetupSessionManager({ documentClient, tableName: tableName ?? "" }),
  projectSetupBinding: createProjectSetupBindingReader({ documentClient, ...(tableName === undefined ? {} : { tableName }) }),
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
  // Reads the admission a CHECKS reference names to hold its `kind` to it. Without the artifact bucket (a deployment that has not granted it) only the kind decides.
  ...(process.env.ARTIFACT_BUCKET_NAME === undefined || process.env.ARTIFACT_BUCKET_NAME === "" ? {} : {
    workflowE2EAdmissionSchemaVersion: createWorkflowE2EAdmissionSchemaReader({ s3: new S3Client(awsClientConfiguration), bucket: process.env.ARTIFACT_BUCKET_NAME }),
    workflowE2EAdmissionUsesAgentSteps: createWorkflowE2EAdmissionAgentStepsReader({ s3: new S3Client(awsClientConfiguration), bucket: process.env.ARTIFACT_BUCKET_NAME }),
  }),
  guardTaskDispatch: taskDispatchGuard,
  applicationPlanNotNegotiated: createApplicationPlanNegotiationRecorder({ documentClient, ...(tableName === undefined ? {} : { tableName }) }),
  validateWorkflowE2EReadiness: createWorkflowE2EReadinessValidator({ documentClient, ...(tableName === undefined ? {} : { tableName }) }),
  guardProjectSetupDispatch,
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
  guardProjectSetupDispatch,
  projectSetupLifecycle: {
    async markDispatching(record) {
      if (record.invocation.kind !== "project-setup-smoke") return false;
      const setupId = record.invocation.payload.setupExecutionId;
      const operationKey = projectSetupOperationKey(setupId, record.operationId);
      const now = new Date().toISOString();
      try {
        await documentClient.send(new TransactWriteCommand({ TransactItems: [
          { Update: { TableName: tableName ?? requiredEnvironment("STATE_TABLE_NAME"), Key: projectSetupExecutionKey(setupId),
            UpdateExpression: "SET #state = :dispatching, updatedAt = :now",
            ConditionExpression: "#state = :accepted OR #state = :dispatching",
            ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":now": now } } },
          { Update: { TableName: tableName ?? requiredEnvironment("STATE_TABLE_NAME"), Key: operationKey,
            UpdateExpression: "SET #status = :dispatching, updatedAt = :now",
            ConditionExpression: "#status = :accepted OR #status = :dispatching",
            ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":now": now } } },
        ] }));
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionCanceledException") return false;
        throw error;
      }
    },
    async markDelivered(record) {
      if (record.invocation.kind !== "project-setup-smoke") return;
      await documentClient.send(new UpdateCommand({ TableName: tableName ?? requiredEnvironment("STATE_TABLE_NAME"),
        Key: projectSetupOperationKey(record.invocation.payload.setupExecutionId, record.operationId),
        UpdateExpression: "SET #status = :delivered, updatedAt = :now",
        ConditionExpression: "#status = :dispatching OR #status = :delivered",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":dispatching": "DISPATCHING", ":delivered": "DELIVERED", ":now": new Date().toISOString() } }));
    },
    async markFailed(record, message) {
      if (record.invocation.kind !== "project-setup-smoke") return;
      const setupId = record.invocation.payload.setupExecutionId;
      const now = new Date().toISOString();
      await documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: tableName ?? requiredEnvironment("STATE_TABLE_NAME"), Key: projectSetupExecutionKey(setupId),
          UpdateExpression: "SET #state = :failed, updatedAt = :now, error = :error",
          ConditionExpression: "#state = :accepted OR #state = :dispatching",
          ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":failed": "FAILED", ":now": now, ":error": message.slice(0, 2_000) } } },
        { Update: { TableName: tableName ?? requiredEnvironment("STATE_TABLE_NAME"), Key: projectSetupOperationKey(setupId, record.operationId),
          UpdateExpression: "SET #status = :failed, updatedAt = :now, #error = :error",
          ConditionExpression: "#status = :accepted OR #status = :dispatching OR #status = :delivered",
          ExpressionAttributeNames: { "#status": "status", "#error": "error" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":delivered": "DELIVERED", ":failed": "FAILED", ":now": now, ":error": message.slice(0, 2_000) } } },
      ] }));
    },
  },
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
  completeWorkflowE2EReadiness: createWorkflowE2EReadinessCompleter({ documentClient, ...(tableName === undefined ? {} : { tableName }) }),
});


export function createWorkflowE2EReadinessCompleter(input: { documentClient: DynamoDBDocumentClient; tableName?: string }) {
  return async (record: DurableOutboxRecord, generation: number): Promise<void> => {
    const documentClient = input.documentClient;
    const table = input.tableName ?? requiredEnvironment("STATE_TABLE_NAME");
    const invocation = record.invocation;
    if (invocation.kind !== "resume" || record.operationId !== invocation.operationId || record.workspaceId !== invocation.workspaceId) {
      throw agentXError("CALLBACK_FORBIDDEN", "E2E readiness record identity does not match its stored resume invocation");
    }
    const opKey = { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` };
    const stored = await documentClient.send(new GetCommand({ TableName: table, Key: opKey, ConsistentRead: true }));
    const operation = stored.Item as { kind?: unknown; status?: unknown; fence?: unknown; workflowE2EReadiness?: {
      purpose?: unknown; taskId?: unknown; workflowRevision?: unknown; candidateDigest?: unknown; dispatchSk?: unknown; outboxId?: unknown;
      readyGeneration?: unknown;
    } } | undefined;
    const readiness = operation?.workflowE2EReadiness;
    const outboxMarker = record.workflowE2EReadiness;
    if (operation?.kind !== "resume" || readiness === undefined || outboxMarker === undefined || operation.status !== "DISPATCHING"
      || !Number.isInteger(operation.fence) || readiness.outboxId !== record.id || readiness.taskId === undefined
      || !Number.isInteger(readiness.workflowRevision) || typeof readiness.candidateDigest !== "string"
      || typeof readiness.dispatchSk !== "string" || readiness.purpose !== "workflow-e2e-readiness"
      || outboxMarker.purpose !== readiness.purpose || outboxMarker.taskId !== readiness.taskId
      || outboxMarker.workflowRevision !== readiness.workflowRevision || outboxMarker.candidateDigest !== readiness.candidateDigest
      || outboxMarker.dispatchSk !== readiness.dispatchSk || operation.fence !== invocation.fence
      || !Number.isInteger(generation) || generation < 1) {
      throw agentXError("CALLBACK_FORBIDDEN", "the stored operation is not the exact broker-admitted E2E readiness resume");
    }
    const now = new Date().toISOString();
    await documentClient.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: table, Key: { pk: `DEVTASK#${readiness.taskId}`, sk: "META" },
        ConditionExpression: "attribute_not_exists(closedAt) AND workflow.revision = :revision AND workflow.#stage = :verify AND workflow.#state = :waiting AND workflow.candidate.digest = :candidate",
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state" }, ExpressionAttributeValues: {
          ":revision": readiness.workflowRevision, ":verify": "VERIFY", ":waiting": "WAITING", ":candidate": readiness.candidateDigest,
        } } },
      { ConditionCheck: { TableName: table, Key: { pk: "WORKFLOW_DISPATCH", sk: readiness.dispatchSk },
        ConditionExpression: "taskId = :task AND workflowRevision = :revision AND candidateDigest = :candidate AND readinessOperationId = :operation",
        ExpressionAttributeValues: { ":task": readiness.taskId, ":revision": readiness.workflowRevision, ":candidate": readiness.candidateDigest,
          ":operation": record.operationId } } },
      { ConditionCheck: { TableName: table, Key: workspaceSessionKey(record.workspaceId),
        ConditionExpression: "#state = :ready AND generation = :generation",
        ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":ready": "READY", ":generation": generation } } },
      { Update: { TableName: table, Key: opKey, UpdateExpression: "SET #status = :succeeded, updatedAt = :now, #result = :result, workflowE2EReadiness = :readiness",
        ConditionExpression: "#status = :dispatching AND #kind = :resume AND workspaceId = :workspace AND fence = :fence AND workflowE2EReadiness.purpose = :purpose AND workflowE2EReadiness.taskId = :task AND workflowE2EReadiness.workflowRevision = :revision AND workflowE2EReadiness.candidateDigest = :candidate AND workflowE2EReadiness.dispatchSk = :dispatchSk AND workflowE2EReadiness.outboxId = :outbox",
        ExpressionAttributeNames: { "#status": "status", "#kind": "kind", "#result": "result" }, ExpressionAttributeValues: {
          ":dispatching": "DISPATCHING", ":succeeded": "SUCCEEDED", ":resume": "resume", ":workspace": record.workspaceId,
          ":fence": invocation.fence, ":purpose": "workflow-e2e-readiness",
          ":task": readiness.taskId, ":revision": readiness.workflowRevision, ":candidate": readiness.candidateDigest,
          ":dispatchSk": readiness.dispatchSk, ":outbox": record.id, ":now": now,
          ":readiness": { ...readiness, readyGeneration: generation },
          ":result": { status: "READY", generation },
        } } },
      { Update: { TableName: table, Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: "META" },
        UpdateExpression: "SET #status = :ready, updatedAt = :now REMOVE activeOperationId",
        ConditionExpression: "#status = :busy AND activeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: {
          ":ready": "READY", ":busy": "BUSY", ":now": now, ":operation": record.operationId, ":fence": operation.fence,
        } } },
      { Update: { TableName: table, Key: { pk: `OUTBOX#${record.id}`, sk: "OUTBOX" },
        UpdateExpression: "SET #status = :delivered, deliveredAt = :now",
        ConditionExpression: "(#status = :queued OR #status = :pending) AND operationId = :operation AND workspaceId = :workspace AND workflowE2EReadiness.purpose = :purpose AND workflowE2EReadiness.taskId = :task AND workflowE2EReadiness.workflowRevision = :revision AND workflowE2EReadiness.candidateDigest = :candidate AND workflowE2EReadiness.dispatchSk = :dispatchSk",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":delivered": "DELIVERED", ":queued": "QUEUED", ":pending": "PENDING", ":now": now,
          ":operation": record.operationId, ":workspace": record.workspaceId, ":purpose": "workflow-e2e-readiness", ":task": readiness.taskId,
          ":revision": readiness.workflowRevision, ":candidate": readiness.candidateDigest, ":dispatchSk": readiness.dispatchSk } } },
    ] }));
  };
}

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
