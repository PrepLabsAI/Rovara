import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  SlackChannelBindingSchema,
  SlackChannelIdSchema,
  SlackMessageTimestampSchema,
  SlackRequestMessageSchema,
  SlackTeamIdSchema,
  SlackUserIdSchema,
  slackRequestText,
  slackThreadSubject,
  type SlackChannelBinding,
  type SlackRequestMessage,
  type SlackThread,
} from "@agentx/contracts";
import { requiredEnvironment, type HttpApiV2Event } from "./lambda.js";

const SIGNATURE_WINDOW_SECONDS = 300;
const EVENT_RETENTION_SECONDS = 14 * 24 * 60 * 60;
const SECRET_CACHE_MILLISECONDS = 5 * 60 * 1_000;

export interface SlackSecrets {
  signingSecret: string;
  botToken: string;
}

export type SlackIngressLog = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;

export interface SlackIngressDependencies {
  secrets: () => Promise<SlackSecrets>;
  getBinding: (teamId: string, channelId: string) => Promise<SlackChannelBinding | undefined>;
  claimEvent: (eventId: string, expiresAtSeconds: number) => Promise<boolean>;
  releaseEvent: (eventId: string) => Promise<void>;
  changePending: (threadSubject: string, delta: 1 | -1) => Promise<number>;
  enqueue: (message: SlackRequestMessage, messageGroupId: string) => Promise<void>;
  postMessage: (input: { channel: string; threadTs: string; text: string }) => Promise<void>;
  now?: () => number;
  log?: SlackIngressLog;
}

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface Mention {
  eventId: string;
  thread: SlackThread;
  userId: string;
  text: string;
  botUserId?: string;
}

export function createSlackIngressHandler(dependencies: SlackIngressDependencies) {
  const now = dependencies.now ?? Date.now;
  const log: SlackIngressLog = dependencies.log ?? (() => undefined);
  return async (event: HttpApiV2Event): Promise<HttpResponse> => {
    const rawBody = event.body === undefined
      ? ""
      : event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const headers = Object.fromEntries(
      Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const secrets = await dependencies.secrets();
    if (!validSignature(secrets.signingSecret, headers["x-slack-request-timestamp"], headers["x-slack-signature"], rawBody, now())) {
      log("request.rejected", { reason: "invalid_signature" });
      return respond(401, { error: "invalid Slack signature" });
    }
    let payload: Record<string, unknown>;
    try {
      payload = asRecord(JSON.parse(rawBody));
    } catch {
      return respond(400, { error: "request body is not JSON" });
    }
    if (payload.type === "url_verification") {
      return respond(200, { challenge: typeof payload.challenge === "string" ? payload.challenge : "" });
    }
    if (payload.type !== "event_callback") return ignore(log, "not_event_callback");

    const mention = parseMention(payload);
    if ("reason" in mention) return ignore(log, mention.reason);
    const { thread } = mention;
    const binding = await dependencies.getBinding(thread.teamId, thread.channelId);
    if (!binding) return ignore(log, "channel_not_bound", { channelId: thread.channelId });
    if (!await dependencies.claimEvent(mention.eventId, Math.floor(now() / 1_000) + EVENT_RETENTION_SECONDS)) {
      return ignore(log, "duplicate_event", { eventId: mention.eventId });
    }

    const text = slackRequestText(mention.text, mention.botUserId);
    if (!text) {
      await post(dependencies, log, thread, "Please include a request after mentioning AgentX.");
      log("mention.empty", { eventId: mention.eventId });
      return respond(200, { ok: true });
    }
    const message = SlackRequestMessageSchema.parse({
      version: 1,
      eventId: mention.eventId,
      thread,
      userId: mention.userId,
      text,
      receivedAt: new Date(now()).toISOString(),
    });
    const subject = slackThreadSubject(thread);
    const pending = await dependencies.changePending(subject, 1);
    try {
      await dependencies.enqueue(message, createHash("sha256").update(subject).digest("hex"));
    } catch {
      // Undo both records so Slack's retry of this event is processed as new.
      await dependencies.changePending(subject, -1);
      await dependencies.releaseEvent(mention.eventId);
      log("mention.enqueue_failed", { eventId: mention.eventId });
      return respond(500, { error: "request could not be queued" });
    }
    log("mention.accepted", { eventId: mention.eventId, pendingInThread: pending });
    const ahead = pending - 1;
    await post(dependencies, log, thread, ahead > 0
      ? `Got it. This is queued behind ${ahead} earlier request${ahead === 1 ? "" : "s"} in this thread.`
      : "Got it. I'm on it and will reply in this thread.");
    return respond(200, { ok: true });
  };
}

export function validSignature(
  signingSecret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  nowMilliseconds: number,
): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(nowMilliseconds / 1_000) - Number(timestamp)) > SIGNATURE_WINDOW_SECONDS) return false;
  const expected = Buffer.from(`v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`);
  const provided = Buffer.from(signature);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function parseMention(payload: Record<string, unknown>): Mention | { reason: string } {
  const event = asRecord(payload.event);
  if (event.type !== "app_mention") return { reason: "not_app_mention" };
  if (event.bot_id !== undefined || event.subtype !== undefined) return { reason: "bot_or_edited_message" };
  const teamId = SlackTeamIdSchema.safeParse(payload.team_id);
  const channelId = SlackChannelIdSchema.safeParse(event.channel);
  const userId = SlackUserIdSchema.safeParse(event.user);
  const ts = SlackMessageTimestampSchema.safeParse(event.thread_ts ?? event.ts);
  if (!teamId.success || !userId.success || !ts.success) return { reason: "malformed_event" };
  if (!channelId.success) return { reason: "not_a_channel" };
  const userTeam = event.user_team ?? event.team;
  if (userTeam !== undefined && userTeam !== teamId.data) return { reason: "external_organization_user" };
  if (typeof payload.event_id !== "string" || typeof event.text !== "string") return { reason: "malformed_event" };
  const botUserId = Array.isArray(payload.authorizations)
    ? asRecord(payload.authorizations[0]).user_id
    : undefined;
  return {
    eventId: payload.event_id,
    thread: { teamId: teamId.data, channelId: channelId.data, threadTs: ts.data },
    userId: userId.data,
    text: event.text,
    ...(typeof botUserId === "string" ? { botUserId } : {}),
  };
}

async function post(dependencies: SlackIngressDependencies, log: SlackIngressLog, thread: SlackThread, text: string) {
  try {
    await dependencies.postMessage({ channel: thread.channelId, threadTs: thread.threadTs, text });
  } catch (error) {
    // The request is already queued; a failed acknowledgement must not make Slack retry it.
    log("acknowledgement.failed", { errorName: error instanceof Error ? error.name : "unknown" });
  }
}

function ignore(log: SlackIngressLog, reason: string, fields: Record<string, string> = {}): HttpResponse {
  log("event.ignored", { reason, ...fields });
  return respond(200, { ok: true });
}

function respond(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function postSlackMessage(
  botToken: string,
  input: { channel: string; threadTs: string; text: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImplementation("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: input.channel, thread_ts: input.threadTs, text: input.text, unfurl_links: false }),
  });
  const result = asRecord(await response.json());
  if (!response.ok || result.ok !== true) {
    throw new Error(`Slack chat.postMessage failed: ${typeof result.error === "string" ? result.error : `HTTP ${response.status}`}`);
  }
}

export function parseSlackSecrets(secretString: string): SlackSecrets {
  const value = asRecord(JSON.parse(secretString));
  if (typeof value.signingSecret !== "string" || value.signingSecret.length < 16) {
    throw new Error("Slack secret must contain a signingSecret");
  }
  if (typeof value.botToken !== "string" || !value.botToken.startsWith("xoxb-")) {
    throw new Error("Slack secret must contain an xoxb- botToken");
  }
  return { signingSecret: value.signingSecret, botToken: value.botToken };
}

function createAwsSlackIngressHandler() {
  const clientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfiguration), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const sqs = new SQSClient(clientConfiguration);
  const secretsManager = new SecretsManagerClient(clientConfiguration);
  const stateTableName = requiredEnvironment("STATE_TABLE_NAME");
  const threadsTableName = requiredEnvironment("SLACK_THREADS_TABLE_NAME");
  const queueUrl = requiredEnvironment("SLACK_REQUEST_QUEUE_URL");
  const secretArn = requiredEnvironment("SLACK_SECRET_ARN");
  let cached: { secrets: Promise<SlackSecrets>; loadedAt: number } | undefined;
  const secrets = (): Promise<SlackSecrets> => {
    if (!cached || Date.now() - cached.loadedAt > SECRET_CACHE_MILLISECONDS) {
      const loading = secretsManager.send(new GetSecretValueCommand({ SecretId: secretArn })).then((response) => {
        if (!response.SecretString) throw new Error("Slack secret is empty");
        return parseSlackSecrets(response.SecretString);
      });
      cached = { secrets: loading, loadedAt: Date.now() };
      loading.catch(() => {
        cached = undefined;
      });
    }
    return cached.secrets;
  };
  return createSlackIngressHandler({
    secrets,
    async getBinding(teamId, channelId) {
      const response = await documentClient.send(new GetCommand({
        TableName: stateTableName,
        Key: { pk: `SLACK_BINDING#${teamId}`, sk: `CHANNEL#${channelId}` },
      }));
      const item = response.Item as Record<string, unknown> | undefined;
      return item
        ? SlackChannelBindingSchema.parse({
            teamId: item.teamId,
            channelId: item.channelId,
            projectName: item.projectName,
            updatedAt: item.updatedAt,
          })
        : undefined;
    },
    async claimEvent(eventId, expiresAtSeconds) {
      try {
        await documentClient.send(new PutCommand({
          TableName: threadsTableName,
          Item: { pk: `EVENT#${eventId}`, sk: "META", expiresAt: expiresAtSeconds },
          ConditionExpression: "attribute_not_exists(pk)",
        }));
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
    async releaseEvent(eventId) {
      await documentClient.send(new DeleteCommand({ TableName: threadsTableName, Key: { pk: `EVENT#${eventId}`, sk: "META" } }));
    },
    async changePending(threadSubject, delta) {
      const response = await documentClient.send(new UpdateCommand({
        TableName: threadsTableName,
        Key: { pk: `THREAD#${threadSubject}`, sk: "META" },
        UpdateExpression: "ADD pendingRequests :delta",
        ExpressionAttributeValues: { ":delta": delta },
        ReturnValues: "UPDATED_NEW",
      }));
      return Number(response.Attributes?.pendingRequests ?? 0);
    },
    async enqueue(message, messageGroupId) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: message.eventId,
      }));
    },
    async postMessage(input) {
      await postSlackMessage((await secrets()).botToken, input);
    },
    log(event, fields) {
      console.log(JSON.stringify({ component: "slack-ingress", event, ...fields }));
    },
  });
}

let awsHandler: ReturnType<typeof createSlackIngressHandler> | undefined;

export const handler = (event: HttpApiV2Event): Promise<HttpResponse> => {
  awsHandler ??= createAwsSlackIngressHandler();
  return awsHandler(event);
};
