import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
  SlackThreadWorkspaceResultSchema,
  SlackWorkspaceCloseCompleteResultSchema,
  SlackWorkspaceCloseStartResultSchema,
  type SlackRequestMessage,
} from "@agentx/contracts";
import { ControlPlaneApi } from "@agentx/orchestrator/control-plane-api";
import { pollOperation } from "@agentx/orchestrator/event-client";
import { runOrchestratorTurn } from "@agentx/orchestrator/orchestrator";
import { runConsumer, type QueueClient } from "./consumer.js";
import { processSlackRequest, type ServiceLog, type ThreadServiceApi, type ThreadStore, type TurnInput } from "./processor.js";
import { createSignedServiceFetch } from "./signing-fetch.js";
import { createSlackUserNames } from "./user-names.js";
import { threadWorkspaceRequest } from "./thread-workspace-request.js";
import { createHostedSlackRuntime } from "./runtime.js";

const MAX_RECEIVE_COUNT = 5;
const VISIBILITY_SECONDS = 15 * 60;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const region = required("AWS_REGION");
const queueUrl = required("SLACK_REQUEST_QUEUE_URL");
const threadsTableName = required("SLACK_THREADS_TABLE_NAME");
const sessionBucketName = required("THREAD_SESSION_BUCKET_NAME");
const controlPlaneUrl = required("CONTROL_PLANE_URL").replace(/\/$/, "");
const slackSecretArn = required("SLACK_SECRET_ARN");
const stateDirectory = process.env.STATE_DIRECTORY ?? "/tmp/agentx-slack";
const concurrency = Number.parseInt(process.env.SLACK_CONCURRENCY ?? "4", 10);
const model = {
  provider: process.env.AGENTX_ORCHESTRATOR_PROVIDER ?? "amazon-bedrock",
  modelId: process.env.AGENTX_ORCHESTRATOR_MODEL ?? "amazon.nova-pro-v1:0",
};

const credentials = defaultProvider();
const sqs = new SQSClient({ region });
const s3 = new S3Client({ region });
const secretsManager = new SecretsManagerClient({ region });
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

const log: ServiceLog = (event, fields) => {
  console.log(JSON.stringify({ component: "slack-orchestrator", event, ...fields }));
};

let botToken: { value: Promise<string>; loadedAt: number } | undefined;
function slackBotToken(): Promise<string> {
  if (!botToken || Date.now() - botToken.loadedAt > 5 * 60 * 1_000) {
    const value = secretsManager.send(new GetSecretValueCommand({ SecretId: slackSecretArn })).then((response) => {
      const secret = JSON.parse(response.SecretString ?? "{}") as { botToken?: unknown };
      if (typeof secret.botToken !== "string" || !secret.botToken.startsWith("xoxb-")) {
        throw new Error("Slack secret must contain an xoxb- botToken");
      }
      return secret.botToken;
    });
    botToken = { value, loadedAt: Date.now() };
    value.catch(() => {
      botToken = undefined;
    });
  }
  return botToken.value;
}

const slackUserName = createSlackUserNames({ token: slackBotToken });

async function postToSlack(channel: string, threadTs: string, text: string): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${await slackBotToken()}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, thread_ts: threadTs, text, unfurl_links: false }),
  });
  const result = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || result.ok !== true) throw new Error(`Slack chat.postMessage failed: ${result.error ?? `HTTP ${response.status}`}`);
}

function threadApi(message: SlackRequestMessage): ThreadServiceApi {
  const signedFetch = createSignedServiceFetch({ region, credentials, thread: message.thread, userId: message.userId });
  const client = (workspaceId: string) => new ControlPlaneApi(controlPlaneUrl, "slack-service", workspaceId, signedFetch);
  return {
    async ensureWorkspace(requestId) {
      const response = await signedFetch(`${controlPlaneUrl}/v1/threads/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(threadWorkspaceRequest(requestId)),
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        const error = body.error as { code?: string; message?: string } | undefined;
        throw new Error(`thread workspace request failed: ${error?.code ?? response.status} ${error?.message ?? ""}`.trim());
      }
      delete body.requestId;
      return SlackThreadWorkspaceResultSchema.parse(body);
    },
    async startClose(requestId) {
      const response = await signedFetch(`${controlPlaneUrl}/v1/threads/workspace/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        const error = body.error as { code?: string; message?: string } | undefined;
        throw new Error(`workspace close request failed: ${error?.code ?? response.status} ${error?.message ?? ""}`.trim());
      }
      delete body.requestId;
      return SlackWorkspaceCloseStartResultSchema.parse(body);
    },
    async completeClose(requestId, operationId) {
      const response = await signedFetch(`${controlPlaneUrl}/v1/threads/workspace/close/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, operationId }),
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        const error = body.error as { code?: string; message?: string } | undefined;
        throw new Error(`workspace close completion failed: ${error?.code ?? response.status} ${error?.message ?? ""}`.trim());
      }
      delete body.requestId;
      return SlackWorkspaceCloseCompleteResultSchema.parse(body);
    },
    async waitForOperation(workspaceId, operationId) {
      const { operation } = await pollOperation(operationId, client(workspaceId), { intervalMilliseconds: 5_000 });
      return {
        status: operation.status,
        ...(operation.error === undefined ? {} : { error: operation.error }),
        ...(operation.result === undefined ? {} : { result: operation.result }),
      };
    },
    async createConversation(workspaceId) {
      return (await client(workspaceId).createConversation()).id;
    },
  };
}

const threads: ThreadStore = {
  async load(subject) {
    const response = await documentClient.send(new GetCommand({
      TableName: threadsTableName,
      Key: { pk: `THREAD#${subject}`, sk: "META" },
      ConsistentRead: true,
    }));
    const item = response.Item as {
      workspaceId?: string;
      conversationId?: string;
      settingsRevision?: number;
      closedAt?: string;
    } | undefined;
    return {
      ...(item?.workspaceId === undefined ? {} : { workspaceId: item.workspaceId }),
      ...(item?.conversationId === undefined ? {} : { conversationId: item.conversationId }),
      ...(item?.settingsRevision === undefined ? {} : { settingsRevision: item.settingsRevision }),
      ...(item?.closedAt === undefined ? {} : { closedAt: item.closedAt }),
    };
  },
  async saveConversation(subject, state) {
    await documentClient.send(new UpdateCommand({
      TableName: threadsTableName,
      Key: { pk: `THREAD#${subject}`, sk: "META" },
      UpdateExpression: "SET workspaceId = :workspace, conversationId = :conversation",
      ExpressionAttributeValues: { ":workspace": state.workspaceId, ":conversation": state.conversationId },
    }));
  },
  async saveSettingsRevision(subject, revision) {
    await documentClient.send(new UpdateCommand({
      TableName: threadsTableName,
      Key: { pk: `THREAD#${subject}`, sk: "META" },
      UpdateExpression: "SET settingsRevision = :revision",
      ExpressionAttributeValues: { ":revision": revision },
    }));
  },
  async close(subject, state) {
    await documentClient.send(new UpdateCommand({
      TableName: threadsTableName,
      Key: { pk: `THREAD#${subject}`, sk: "META" },
      UpdateExpression: "SET workspaceId = :workspace, closedAt = :closedAt REMOVE conversationId, settingsRevision",
      ExpressionAttributeValues: { ":workspace": state.workspaceId, ":closedAt": state.closedAt },
    }));
    await s3.send(new DeleteObjectCommand({ Bucket: sessionBucketName, Key: sessionKey(subject) }));
  },
  async finish(subject) {
    try {
      await documentClient.send(new UpdateCommand({
        TableName: threadsTableName,
        Key: { pk: `THREAD#${subject}`, sk: "META" },
        UpdateExpression: "ADD pendingRequests :minusOne",
        ConditionExpression: "pendingRequests > :zero",
        ExpressionAttributeValues: { ":minusOne": -1, ":zero": 0 },
      }));
    } catch (error) {
      if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
    }
  },
};

function sessionKey(subject: string): string {
  return `threads/${createHash("sha256").update(subject).digest("hex")}/session.jsonl`;
}

async function loadSession(subject: string): Promise<Uint8Array | undefined> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: sessionBucketName, Key: sessionKey(subject) }));
    return await response.Body?.transformToByteArray();
  } catch (error) {
    if (error instanceof NoSuchKey) return undefined;
    throw error;
  }
}

async function runTurn(input: TurnInput): Promise<string> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(stateDirectory, "thread-"));
  try {
    const sessions = join(directory, "sessions");
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const saved = await loadSession(input.subject);
    const sessionFile = saved === undefined ? undefined : join(sessions, "thread.jsonl");
    if (sessionFile !== undefined && saved !== undefined) await writeFile(sessionFile, saved, { mode: 0o600 });
    const userName = await slackUserName(input.message.userId);
    const signedFetch = createSignedServiceFetch({ region, credentials, thread: input.message.thread, userId: input.message.userId, ...(userName === undefined ? {} : { userName }) });
    const runtime = await createHostedSlackRuntime(input, {
      stateDirectory: directory,
      api: new ControlPlaneApi(controlPlaneUrl, "slack-service", input.workspaceId, signedFetch),
      model,
      ...(sessionFile === undefined ? {} : { sessionFile }),
      // Operators see why a connector was missing from a turn; the message is the control plane's sanitized error.
      onConnectorUnavailable: (failure) => log("connector.discovery_failed", {
        eventId: input.message.eventId, connector: failure.connector, cause: failure.cause, code: failure.code, message: failure.message,
      }),
    });
    try {
      const response = await runOrchestratorTurn(runtime, input.message.text);
      const written = runtime.session.sessionManager.getSessionFile();
      if (written !== undefined && await exists(written)) {
        await s3.send(new PutObjectCommand({
          Bucket: sessionBucketName,
          Key: sessionKey(input.subject),
          Body: await readFile(written),
          ServerSideEncryption: "AES256",
        }));
      }
      return response;
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const queue: QueueClient = {
  async receive(maximum) {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maximum,
      WaitTimeSeconds: 20,
      VisibilityTimeout: VISIBILITY_SECONDS,
      MessageSystemAttributeNames: ["MessageGroupId", "ApproximateReceiveCount"],
    }));
    return (response.Messages ?? []).map((message) => ({
      body: message.Body ?? "",
      receiptHandle: message.ReceiptHandle ?? "",
      groupId: message.Attributes?.MessageGroupId ?? "",
      receiveCount: Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? "1", 10),
    }));
  },
  async delete(receiptHandle) {
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  },
  async extendVisibility(receiptHandle, seconds) {
    await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
  },
};

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log("service.stopping", { signal });
    controller.abort();
  });
}

log("service.started", { concurrency, provider: model.provider, model: model.modelId });
await runConsumer(queue, (message, context) => processSlackRequest(message, {
  api: threadApi,
  threads,
  runTurn,
  post: (thread, text) => postToSlack(thread.channelId, thread.threadTs, text),
  log,
}, context), {
  concurrency,
  maxReceiveCount: MAX_RECEIVE_COUNT,
  visibilitySeconds: VISIBILITY_SECONDS,
  heartbeatMilliseconds: 5 * 60 * 1_000,
  signal: controller.signal,
  log,
});
log("service.stopped", {});
