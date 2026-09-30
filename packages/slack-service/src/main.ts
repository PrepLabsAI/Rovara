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
import { SLACK_QUEUED_BEHIND_ATTRIBUTE, confirmationBlocks, queuedBehindOf, sharedNoticeClaim, type SlackRequestMessage } from "@agentx/contracts";
import { ControlPlaneApi } from "@agentx/orchestrator/control-plane-api";
import { runOrchestratorTurn } from "@agentx/orchestrator/orchestrator";
import { createDynamoActiveTurnStore } from "./active-turn-store.js";
import { createDynamoConfirmationStore } from "./confirmation-store.js";
import { runConsumer, type QueueClient } from "./consumer.js";
import { processSlackRequest, type ServiceLog, type ThreadServiceApi, type ThreadStore, type TurnInput } from "./processor.js";
import { createSignedServiceFetch } from "./signing-fetch.js";
import { createSlackUserNames } from "./user-names.js";
import { createThreadApi } from "./thread-api.js";
import { HANDOFF_MILLISECONDS, activeTurnFromItem } from "./interrupted-turn.js";
import { classifierTimeoutMs, createHostedClassifier, createHostedSlackRuntime, gateDecisionLogFields, runHostedTurn } from "./runtime.js";
import { DynamoTurnRecordWriter } from "./turn-records.js";

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
const turnRecordsTableName = required("TURN_RECORDS_TABLE_NAME");
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

// The action gate's classifier (spec 014): a small model chosen per deployment through the
// AgentXSlackOrchestrator parameter GateClassifierModelId. If it cannot be made, including a model
// the runtime does not know, the service still starts, logs gate.classifier_unavailable and says
// classifierAvailable: false in its start log, and every change no rule settles asks.
const classifierModel = {
  provider: process.env.AGENTX_GATE_CLASSIFIER_PROVIDER ?? "amazon-bedrock",
  modelId: process.env.AGENTX_GATE_CLASSIFIER_MODEL ?? "amazon.nova-lite-v1:0",
};
const gateClassifierTimeoutMs = classifierTimeoutMs(process.env.AGENTX_GATE_CLASSIFIER_TIMEOUT_MS);
const { classifier, available: classifierAvailable } = await createHostedClassifier({
  model: classifierModel, timeoutMs: gateClassifierTimeoutMs, log,
});
const confirmations = createDynamoConfirmationStore(documentClient, threadsTableName, Date.now, log);

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

async function postToSlack(channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${await slackBotToken()}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, thread_ts: threadTs, text, unfurl_links: false, ...(blocks === undefined ? {} : { blocks }) }),
  });
  const result = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || result.ok !== true) throw new Error(`Slack chat.postMessage failed: ${result.error ?? `HTTP ${response.status}`}`);
}

function threadApi(message: SlackRequestMessage): ThreadServiceApi {
  const signedFetch = createSignedServiceFetch({ region, credentials, thread: message.thread, userId: message.userId });
  return createThreadApi({ controlPlaneUrl, signedFetch });
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
      refreshConnectors?: unknown;
      activeTurn?: unknown;
    } | undefined;
    const activeTurn = activeTurnFromItem(item?.activeTurn);
    return {
      ...(item?.workspaceId === undefined ? {} : { workspaceId: item.workspaceId }),
      ...(item?.conversationId === undefined ? {} : { conversationId: item.conversationId }),
      ...(item?.settingsRevision === undefined ? {} : { settingsRevision: item.settingsRevision }),
      ...(item?.closedAt === undefined ? {} : { closedAt: item.closedAt }),
      ...(Array.isArray(item?.refreshConnectors) ? { refreshConnectors: item.refreshConnectors.filter((name): name is string => typeof name === "string") } : {}),
      ...(activeTurn === undefined ? {} : { activeTurn }),
    };
  },
  // Issue 157: the worker operation a turn waits on, so a redelivery after a deploy can resume it.
  ...createDynamoActiveTurnStore(documentClient, threadsTableName),
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
      UpdateExpression: "SET workspaceId = :workspace, closedAt = :closedAt REMOVE conversationId, settingsRevision, refreshConnectors",
      ExpressionAttributeValues: { ":workspace": state.workspaceId, ":closedAt": state.closedAt },
    }));
    await s3.send(new DeleteObjectCommand({ Bucket: sessionBucketName, Key: sessionKey(subject) }));
  },
  async saveRefreshConnectors(subject, connectors) {
    await documentClient.send(new UpdateCommand({
      TableName: threadsTableName,
      Key: { pk: `THREAD#${subject}`, sk: "META" },
      ...(connectors.length === 0
        ? { UpdateExpression: "REMOVE refreshConnectors" }
        : { UpdateExpression: "SET refreshConnectors = :connectors", ExpressionAttributeValues: { ":connectors": connectors } }),
    }), { abortSignal: AbortSignal.timeout(5000) });
  },
  async claimSharedNotice(subject, nowSeconds, kind) {
    try {
      // The same claim the Slack ingress sends (F13), so one notice an hour holds across both.
      await documentClient.send(new UpdateCommand({ TableName: threadsTableName, ...sharedNoticeClaim(subject, nowSeconds, kind) }), { abortSignal: AbortSignal.timeout(5000) });
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  },
  async finish(subject) {
    try {
      await documentClient.send(new UpdateCommand({
        TableName: threadsTableName,
        Key: { pk: `THREAD#${subject}`, sk: "META" },
        UpdateExpression: "ADD pendingRequests :minusOne",
        ConditionExpression: "pendingRequests > :zero",
        ExpressionAttributeValues: { ":minusOne": -1, ":zero": 0 },
      }), { abortSignal: AbortSignal.timeout(5000) });
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
      onExtensionError: (failure) => log("extension.handler_failed", {
        eventId: input.message.eventId, ...failure,
      }),
      classifier,
      // The gate's own deadline follows the same setting, so a longer timeout is not cut at 8 seconds.
      classifierTimeoutMs: gateClassifierTimeoutMs,
      // One line per gate decision until turn records carry them; never the call's arguments.
      onGateDecision: (decision) => log("gate.decision", gateDecisionLogFields(input.message.eventId, decision)),
    });
    try {
      // Issue 157: a handed-off turn's model stops (or never starts), and its unfinished session is not saved.
      const response = await runHostedTurn(runtime, input.signal, () => runOrchestratorTurn(runtime, input.message.text, input.recorder));
      const written = runtime.session.sessionManager.getSessionFile();
      if (input.signal?.aborted !== true && written !== undefined && await exists(written)) {
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
      MessageAttributeNames: [SLACK_QUEUED_BEHIND_ATTRIBUTE],
    }));
    return (response.Messages ?? []).map((message) => {
      const queuedBehind = queuedBehindOf(message.MessageAttributes);
      return {
        body: message.Body ?? "",
        receiptHandle: message.ReceiptHandle ?? "",
        groupId: message.Attributes?.MessageGroupId ?? "",
        receiveCount: Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? "1", 10),
        ...(queuedBehind === undefined ? {} : { queuedBehind }),
      };
    });
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
    // Running turns get until the hand-off deadline (issue 157); nothing new starts.
    log("service.stopping", { signal, handoffMilliseconds: HANDOFF_MILLISECONDS });
    controller.abort();
  });
}

log("service.started", {
  concurrency, provider: model.provider, model: model.modelId,
  classifierProvider: classifierModel.provider, classifierModel: classifierModel.modelId, classifierAvailable,
});
await runConsumer(queue, (message, context) => processSlackRequest(message, {
  api: threadApi,
  threads,
  runTurn,
  post: (thread, text) => postToSlack(thread.channelId, thread.threadTs, text),
  log,
  confirmations,
  postConfirmation: (thread, confirmation, text) => postToSlack(thread.channelId, thread.threadTs, text, confirmationBlocks(text, confirmation.confirmationId)),
  postWithBlocks: (thread, text, blocks) => postToSlack(thread.channelId, thread.threadTs, text, blocks),
  turnRecords: new DynamoTurnRecordWriter(documentClient, turnRecordsTableName),
  userName: slackUserName,
}, context), {
  concurrency,
  maxReceiveCount: MAX_RECEIVE_COUNT,
  visibilitySeconds: VISIBILITY_SECONDS,
  heartbeatMilliseconds: 5 * 60 * 1_000,
  signal: controller.signal,
  handoffMilliseconds: HANDOFF_MILLISECONDS,
  log,
});
log("service.stopped", {});
