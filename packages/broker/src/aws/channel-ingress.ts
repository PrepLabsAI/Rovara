import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  ChannelIdSchema,
  channelBindingKey,
  channelEventGroupId,
  readChannelBindingItem,
  ChannelActionSchema,
  ChannelDecisionSchema,
  InboundMessageSchema,
  LINK_REQUIRED_INTERVAL_SECONDS,
  channelEventId,
  usableWebhookSecret,
  verifyWebhook,
  WEBHOOK_TOLERANCE_SECONDS,
  type ActorRef,
  type ChannelAdapterRecord,
  type ChannelBinding,
  type ChannelEvent,
  type ChannelQueueItem,
  type ChannelSpaceRef,
  type ConversationRef,
  type ChannelAction,
  type InboundMessage,
} from "@agentx/contracts";
import { adapterForChannel, builtInAdapterFromEnvironment } from "./channel-adapters.js";
import { issueLinkCode, linkedDeveloper } from "./channel-links.js";

/**
 * Spec 062 FR-021, FR-024, FR-030: the channel API. A registered adapter posts a person's message or decision, signed
 * with its own secret (Standard Webhooks). It is queued for the core only when the signature is good and fresh, the
 * path's channel is the body's, the space is bound to one of the adapter's projects, and the actor is linked to a
 * developer. Anything else runs nothing. An unlinked actor gets one `link_required` event an hour.
 *
 * FR-073: the built-in adapter (Slack) is checked the same way, except that its actors keep the surface's verified
 * identity: any space with a binding, no link and no step-up.
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
  /**
   * Phase 7c2: the built-in adapter's own router, by channel. A message from it is decided there (whether it is read,
   * a stop, a task, a request for the orchestrator) once its signature and binding are checked; what it answers is
   * this API's answer.
   */
  surfaces?: Readonly<Record<string, ChannelSurface>>;
  /**
   * Phase 7c3: the built-in adapter's own press handlers, by channel. An action one of them answers is run there; one it
   * does not (undefined) is queued for the orchestrator as before.
   */
  actionSurfaces?: Readonly<Record<string, ChannelActionSurface>>;
  now(): number;
  log?(entry: Record<string, unknown>): void;
}

/** Decides one built-in adapter message, in the bound space's project. */
export type ChannelSurface = (message: InboundMessage, context: { projectName: string }) => Promise<{ statusCode: number; body: string }>;
/** Runs one built-in adapter action, or answers undefined for one it does not run. */
export type ChannelActionSurface = (action: ChannelAction, context: { projectName?: string }) => Promise<{ statusCode: number; body: string } | undefined>;

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
export function conversationGroupId(conversation: ConversationRef): string {
  return groupOf(conversation);
}

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
    const route = /^\/v1\/channels\/([^/]+)\/(messages|decisions|actions)$/.exec(event.rawPath ?? "");
    const channel = route === null ? undefined : ChannelIdSchema.safeParse(route[1]);
    if (route === null || channel === undefined || !channel.success) return refuse(404, "not_found");
    const kind = route[2] as "messages" | "decisions" | "actions";

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
      const parsed = kind === "messages" ? InboundMessageSchema.safeParse(json) : kind === "decisions" ? ChannelDecisionSchema.safeParse(json) : ChannelActionSchema.safeParse(json);
      if (!parsed.success) return refuse(400, "invalid_body");
      const item = parsed.data;
      if (item.channel !== adapter.channel) return refuse(403, "channel_mismatch");
      const { actor } = item;
      // FR-071: an action on a direct message, or a submitted form, has no conversation. Phase 7c3b: the built-in
      // adapter's are run by its press handler, which checks the person's access to the task itself; any other is refused.
      const conversation = item.conversation;
      if (conversation === undefined) {
        const direct = adapter.builtIn === true && kind === "actions" ? deps.actionSurfaces?.[adapter.channel] : undefined;
        const handled = direct === undefined ? undefined : await direct(ChannelActionSchema.parse(item), {});
        if (handled === undefined) return refuse(400, "conversation_required");
        if (handled.statusCode >= 500) throw new Error(`the ${adapter.channel} press handler answered ${handled.statusCode}`);
        log({ event: "pressed", channel: adapter.channel, statusCode: handled.statusCode });
        return { statusCode: handled.statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: handled.body };
      }
      if (actor.tenant !== conversation.tenant) return refuse(403, "actor_tenant_mismatch");

      const binding = await deps.getBinding({ channel: conversation.channel, tenant: conversation.tenant, space: conversation.space });
      if (binding === undefined || (adapter.builtIn !== true && !adapter.projects.includes(binding.projectName))) {
        log({ event: "refused", channel: adapter.channel, reason: "space_not_bound" });
        return refuse(403, "space_not_bound");
      }

      const actionSurface = adapter.builtIn === true && kind === "actions" ? deps.actionSurfaces?.[adapter.channel] : undefined;
      if (actionSurface !== undefined) {
        const handled = await actionSurface(ChannelActionSchema.parse(item), { projectName: binding.projectName });
        if (handled !== undefined) {
          if (handled.statusCode >= 500) throw new Error(`the ${adapter.channel} press handler answered ${handled.statusCode}`);
          log({ event: "pressed", channel: adapter.channel, statusCode: handled.statusCode });
          return { statusCode: handled.statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: handled.body };
        }
      }
      const surface = adapter.builtIn === true && kind === "messages" ? deps.surfaces?.[adapter.channel] : undefined;
      if (surface !== undefined) {
        // The router claims the event itself, and answers 5xx for anything worth trying again.
        const routed = await surface(InboundMessageSchema.parse(item), { projectName: binding.projectName });
        if (routed.statusCode >= 500) throw new Error(`the ${adapter.channel} router answered ${routed.statusCode}`);
        log({ event: "routed", channel: adapter.channel, statusCode: routed.statusCode });
        return { statusCode: routed.statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: routed.body };
      }

      if (!(await claim(`EVENT#${adapter.channel}/${kind}/${item.eventId}`, EVENT_DEDUPE_SECONDS))) return respond(200, { status: "duplicate" });

      const developerId = adapter.builtIn === true ? undefined : await deps.linkedDeveloper(actor);
      if (developerId === undefined && adapter.builtIn !== true) {
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

      const checked = { projectName: binding.projectName, ...(developerId === undefined ? {} : { developerId }), stepUp: adapter.stepUp };
      const queued: ChannelQueueItem = kind === "messages"
        ? { kind: "message", message: InboundMessageSchema.parse(item), ...checked }
        : kind === "decisions"
          ? { kind: "decision", decision: ChannelDecisionSchema.parse(item), ...checked }
          : { kind: "action", action: ChannelActionSchema.parse(item), ...checked };
      await deps.enqueue(queued, groupOf(conversation));
      // The built-in adapter answers its surface itself ("Got it"), so it gets no ack to deliver.
      if (kind === "messages" && adapter.builtIn !== true) {
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

export function createAwsChannelIngressHandler(surfaces: Readonly<Record<string, ChannelSurface>> = {}, actionSurfaces: Readonly<Record<string, ChannelActionSurface>> = {}) {
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
  const builtIn = builtInAdapterFromEnvironment(process.env);
  const registry = process.env.CHANNEL_ADAPTERS === "enabled";
  const secrets = new Map<string, { value: string | undefined; at: number }>();
  return createChannelIngressHandler({
    getAdapter: (channel) => adapterForChannel({ documentClient, tableName: stateTableName }, channel, { builtIn, registry }),
    async getSecret(secretName) {
      const cached = secrets.get(secretName);
      if (cached !== undefined && Date.now() - cached.at < SECRET_CACHE_MS) return cached.value;
      try {
        const value = (await secretsManager.send(new GetSecretValueCommand({ SecretId: secretName }))).SecretString;
        const usable = usableWebhookSecret(value);
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
        MessageDeduplicationId: createHash("sha256").update(queueItemIdentity(item)).digest("hex"),
      }));
    },
    async sendEvent(channelEvent) {
      // FIFO: a conversation's events reach its adapter in order; the event ID drops a resend.
      await sqs.send(new SendMessageCommand({
        QueueUrl: eventQueueUrl, MessageBody: JSON.stringify(channelEvent), MessageGroupId: channelEventGroupId(channelEvent), MessageDeduplicationId: channelEvent.id,
      }));
    },
    surfaces,
    actionSurfaces,
    now: Date.now,
  });
}

/** The channel, kind and adapter event ID a queued item is dropped as a duplicate by. */
export function queueItemIdentity(item: ChannelQueueItem): string {
  if (item.kind === "message") return `${item.message.channel}:message:${item.message.eventId}`;
  if (item.kind === "decision") return `${item.decision.channel}:decision:${item.decision.eventId}`;
  return `${item.action.channel}:action:${item.action.eventId}`;
}

/** The channel API's Lambda handler, with the deployment's own routers made on first use. */
export function channelApiHandler(
  makeSurfaces: () => Readonly<Record<string, ChannelSurface>> = () => ({}),
  makeActionSurfaces: () => Readonly<Record<string, ChannelActionSurface>> = () => ({}),
) {
  let built: ReturnType<typeof createChannelIngressHandler> | undefined;
  return async (event: ChannelIngressEvent): Promise<ChannelIngressResponse> => {
    // Spec 062: off unless the deployment turns channel adapters or its built-in adapter on; then nothing is reachable.
    if (process.env.CHANNEL_ADAPTERS !== "enabled" && process.env.BUILT_IN_ADAPTER !== "enabled") return refuse(404, "not_found");
    built ??= createAwsChannelIngressHandler(makeSurfaces(), makeActionSurfaces());
    return built(event);
  };
}

export const handler = channelApiHandler();
