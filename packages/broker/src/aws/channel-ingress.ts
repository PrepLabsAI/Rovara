import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  AdapterChannelIdSchema,
  channelBindingKey,
  readChannelBindingItem,
  ChannelDecisionSchema,
  InboundMessageSchema,
  LINK_REQUIRED_INTERVAL_SECONDS,
  channelEventId,
  verifyWebhook,
  WEBHOOK_TOLERANCE_SECONDS,
  type ActorRef,
  type ChannelAdapterRecord,
  type ChannelBinding,
  type ChannelEvent,
  type ChannelQueueItem,
  type ChannelSpaceRef,
  type ConversationRef,
} from "@agentx/contracts";
import { getChannelAdapter } from "./channel-adapters.js";
import { issueLinkCode, linkedDeveloper } from "./channel-links.js";

/**
 * Spec 062 FR-021, FR-024, FR-030: the channel API. A registered adapter posts a person's message or decision, signed
 * with its own secret (Standard Webhooks). It is queued for the core only when the signature is good and fresh, the
 * path's channel is the body's, the space is bound to one of the adapter's projects, and the actor is linked to a
 * developer. Anything else runs nothing. An unlinked actor gets one `link_required` event an hour.
 */

/** How long a `webhook-id` is remembered: twice the signature tolerance, so a replay within it is always caught. */
const WEBHOOK_REPLAY_SECONDS = 2 * WEBHOOK_TOLERANCE_SECONDS;
/** How long an adapter's own event ID is remembered, so a resend under a new `webhook-id` still runs once. */
const EVENT_DEDUPE_SECONDS = 24 * 60 * 60;
const MAX_BODY_BYTES = 256 * 1024;

export interface ChannelIngressDependencies {
  getAdapter(channel: string): Promise<ChannelAdapterRecord | undefined>;
  /** The adapter's signing secret, or undefined when it cannot be read; nothing is accepted without it. */
  getSecret(secretName: string): Promise<string | undefined>;
  getBinding(ref: ChannelSpaceRef): Promise<ChannelBinding | undefined>;
  linkedDeveloper(actor: ActorRef): Promise<string | undefined>;
  issueLinkCode(actor: ActorRef): Promise<{ code: string; expiresAt: number }>;
  /** The page a link code is redeemed on. */
  linkUrl(code: string): string;
  /** Claims a key until `expiresAt` (seconds); false when it is already claimed. */
  claim(key: string, expiresAt: number): Promise<boolean>;
  release(key: string): Promise<void>;
  enqueue(item: ChannelQueueItem, groupId: string): Promise<void>;
  sendEvent(event: ChannelEvent): Promise<void>;
  now(): number;
  log?(entry: Record<string, unknown>): void;
}

export interface ChannelIngressEvent {
  rawPath?: string;
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string } };
}

export interface ChannelIngressResponse { statusCode: number; headers: Record<string, string>; body: string }

const respond = (statusCode: number, body: Record<string, unknown>): ChannelIngressResponse => ({
  statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body),
});
const refuse = (statusCode: number, error: string) => respond(statusCode, { error });

/** The FIFO group a conversation's work is ordered in. */
function groupOf(conversation: ConversationRef): string {
  return `${conversation.channel}/${conversation.tenant}/${conversation.space}/${conversation.thread}`.slice(0, 128);
}

function eventBase(adapter: ChannelAdapterRecord, conversation: ConversationRef, now: number) {
  return { version: 1 as const, id: channelEventId(), channel: adapter.channel, conversation, createdAt: new Date(now).toISOString() };
}

export function createChannelIngressHandler(deps: ChannelIngressDependencies) {
  const log = (entry: Record<string, unknown>) => (deps.log === undefined ? console.log(JSON.stringify({ component: "channel-ingress", ...entry })) : deps.log(entry));

  return async (event: ChannelIngressEvent): Promise<ChannelIngressResponse> => {
    if (event.requestContext?.http?.method !== "POST") return refuse(405, "method_not_allowed");
    const route = /^\/v1\/channels\/([^/]+)\/(messages|decisions)$/.exec(event.rawPath ?? "");
    const channel = route === null ? undefined : AdapterChannelIdSchema.safeParse(route[1]);
    if (route === null || channel === undefined || !channel.success) return refuse(404, "not_found");
    const kind = route[2] as "messages" | "decisions";

    const body = event.isBase64Encoded === true ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return refuse(413, "too_large");

    const adapter = await deps.getAdapter(channel.data);
    if (adapter === undefined) return refuse(404, "not_found");
    const secret = await deps.getSecret(adapter.secretName);
    if (secret === undefined) {
      log({ event: "secret_unavailable", channel: adapter.channel });
      return refuse(503, "unavailable");
    }
    const nowMs = deps.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const verified = verifyWebhook({ secret, headers: event.headers ?? {}, body, nowSeconds });
    if (!verified.ok) {
      log({ event: "refused", channel: adapter.channel, reason: verified.reason });
      return refuse(401, verified.reason);
    }

    // Every claim this request makes; released if it fails transiently, so the adapter's retry is not taken as a replay.
    const claimed: string[] = [];
    const claim = async (key: string, seconds: number) => {
      const ok = await deps.claim(key, nowSeconds + seconds);
      if (ok) claimed.push(key);
      return ok;
    };
    try {
      if (!(await claim(`WEBHOOK#${adapter.channel}/${verified.id}`, WEBHOOK_REPLAY_SECONDS))) return respond(200, { status: "duplicate" });

      let json: unknown;
      try { json = JSON.parse(body); } catch { return refuse(400, "invalid_json"); }
      const parsed = kind === "messages" ? InboundMessageSchema.safeParse(json) : ChannelDecisionSchema.safeParse(json);
      if (!parsed.success) return refuse(400, "invalid_body");
      const item = parsed.data;
      if (item.channel !== adapter.channel) return refuse(403, "channel_mismatch");
      const { conversation, actor } = item;
      if (actor.tenant !== conversation.tenant) return refuse(403, "actor_tenant_mismatch");

      const binding = await deps.getBinding({ channel: conversation.channel, tenant: conversation.tenant, space: conversation.space });
      if (binding === undefined || !adapter.projects.includes(binding.projectName)) {
        log({ event: "refused", channel: adapter.channel, reason: "space_not_bound" });
        return refuse(403, "space_not_bound");
      }

      if (!(await claim(`EVENT#${adapter.channel}/${kind}/${item.eventId}`, EVENT_DEDUPE_SECONDS))) return respond(200, { status: "duplicate" });

      const developerId = await deps.linkedDeveloper(actor);
      if (developerId === undefined) {
        // FR-030: one notice per actor an hour, claimed like the rest so a failed send frees it for the retry.
        if (await claim(`LINK_NOTICE#${actor.channel}/${actor.tenant}/${actor.userId}`, LINK_REQUIRED_INTERVAL_SECONDS)) {
          const { code, expiresAt } = await deps.issueLinkCode(actor);
          await deps.sendEvent({
            ...eventBase(adapter, conversation, nowMs), type: "link_required",
            data: { linkUrl: deps.linkUrl(code), expiresAt: new Date(expiresAt * 1000).toISOString(), actor },
          });
        }
        log({ event: "link_required", channel: adapter.channel });
        return respond(202, { status: "link_required" });
      }

      const queued: ChannelQueueItem = kind === "messages"
        ? { kind: "message", message: InboundMessageSchema.parse(item), projectName: binding.projectName, developerId }
        : { kind: "decision", decision: ChannelDecisionSchema.parse(item), projectName: binding.projectName, developerId };
      await deps.enqueue(queued, groupOf(conversation));
      if (kind === "messages") {
        // Queued already: a failed ack must not fail the request, or the adapter's retry would queue it twice.
        try {
          await deps.sendEvent({ ...eventBase(adapter, conversation, nowMs), type: "ack", data: { inReplyTo: item.eventId } });
        } catch (error) {
          log({ event: "ack_failed", channel: adapter.channel, errorName: error instanceof Error ? error.name : "UnknownError" });
        }
      }
      log({ event: "accepted", channel: adapter.channel, kind });
      return respond(202, { status: "accepted" });
    } catch (error) {
      for (const key of claimed) {
        try { await deps.release(key); } catch { log({ event: "release_failed", channel: adapter.channel }); }
      }
      log({ event: "failed", channel: adapter.channel, errorName: error instanceof Error ? error.name : "UnknownError" });
      return refuse(500, "try_again");
    }
  };
}

/** How long a read signing secret is reused, so a rotation takes effect within a minute. */
const SECRET_CACHE_MS = 60_000;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function createAwsChannelIngressHandler() {
  const clientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfiguration), { marshallOptions: { removeUndefinedValues: true } });
  const sqs = new SQSClient(clientConfiguration);
  const secretsManager = new SecretsManagerClient(clientConfiguration);
  const stateTableName = requiredEnvironment("STATE_TABLE_NAME");
  const channelTableName = requiredEnvironment("CHANNEL_STATE_TABLE_NAME");
  const requestQueueUrl = requiredEnvironment("CHANNEL_REQUEST_QUEUE_URL");
  const eventQueueUrl = requiredEnvironment("CHANNEL_EVENT_QUEUE_URL");
  const linkOrigin = new URL(requiredEnvironment("CHANNEL_LINK_ORIGIN")).origin;
  const links = { documentClient, stateTableName, now: Date.now };
  const secrets = new Map<string, { value: string | undefined; at: number }>();
  return createChannelIngressHandler({
    getAdapter: (channel) => getChannelAdapter({ documentClient, tableName: stateTableName }, channel),
    async getSecret(secretName) {
      const cached = secrets.get(secretName);
      if (cached !== undefined && Date.now() - cached.at < SECRET_CACHE_MS) return cached.value;
      try {
        const value = (await secretsManager.send(new GetSecretValueCommand({ SecretId: secretName }))).SecretString;
        const usable = value?.startsWith("whsec_") === true ? value : undefined;
        secrets.set(secretName, { value: usable, at: Date.now() });
        return usable;
      } catch {
        return undefined;
      }
    },
    async getBinding(ref) {
      const response = await documentClient.send(new GetCommand({ TableName: stateTableName, Key: channelBindingKey(ref), ConsistentRead: true }));
      return readChannelBindingItem(ref, response.Item as Record<string, unknown> | undefined);
    },
    linkedDeveloper: (actor) => linkedDeveloper(links, actor),
    issueLinkCode: (actor) => issueLinkCode(links, actor),
    linkUrl: (code) => `${linkOrigin}/review/link/${code}`,
    async claim(key, expiresAt) {
      try {
        await documentClient.send(new PutCommand({
          TableName: channelTableName,
          Item: { pk: key, sk: "CLAIM", expiresAt },
          // Expiry lags, so an expired claim counts as free.
          ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now",
          ExpressionAttributeValues: { ":now": Math.floor(Date.now() / 1000) },
        }));
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
    async release(key) {
      await documentClient.send(new DeleteCommand({ TableName: channelTableName, Key: { pk: key, sk: "CLAIM" } }));
    },
    async enqueue(item, groupId) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: requestQueueUrl, MessageBody: JSON.stringify(item), MessageGroupId: groupId,
        // Per channel and kind, hashed so a 128-character event ID never truncates into another's.
        MessageDeduplicationId: createHash("sha256").update(item.kind === "message"
          ? `${item.message.channel}:message:${item.message.eventId}` : `${item.decision.channel}:decision:${item.decision.eventId}`).digest("hex"),
      }));
    },
    async sendEvent(channelEvent) {
      await sqs.send(new SendMessageCommand({ QueueUrl: eventQueueUrl, MessageBody: JSON.stringify(channelEvent) }));
    },
    now: Date.now,
  });
}

let awsHandler: ReturnType<typeof createChannelIngressHandler> | undefined;

export const handler = async (event: ChannelIngressEvent): Promise<ChannelIngressResponse> => {
  // Spec 062: off unless the deployment turns channel adapters on; then nothing is reachable.
  if (process.env.CHANNEL_ADAPTERS !== "enabled") return refuse(404, "not_found");
  awsHandler ??= createAwsChannelIngressHandler();
  return awsHandler(event);
};
