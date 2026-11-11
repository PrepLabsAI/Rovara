// Spec 062 Phase 7b (FR-073): the built-in Slack adapter's channel side. Slack's ingress hands an ordinary conversation
// request to the channel API, signed with the adapter's own secret, as any adapter does; the core's events for Slack
// come back, signed the same way, to POST /v1/slack/channel-events, where they are posted to Slack.
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  ChannelEventSchema,
  DETAILS_ACTION,
  SLACK_CHANNEL,
  TURN_DETAILS_ACTION_ID,
  confirmationBlocks,
  detailsReplyBlocks,
  inboundFromSlackRequest,
  slackThreadOf,
  slackThreadSubject,
  splitSectionText,
  usableWebhookSecret,
  verifyWebhook,
  webhookHeaders,
  type ChannelEvent,
  type MessageAction,
  type MessagePart,
  type SlackRequestMessage,
} from "@agentx/contracts";
import { requiredEnvironment, type HttpApiV2Event } from "./lambda.js";
import { SlackPostError, chatPostEphemeral, chatPostMessage, chatUpdate, postMayHaveLanded } from "./slack-web.js";

export const SLACK_CHANNEL_EVENTS_PATH = "/v1/slack/channel-events";

/** Slack waits 3 seconds for the ingress's answer; the channel API gets most of what is left. */
const FORWARD_TIMEOUT_MILLISECONDS = 2_500;
/** Longer than the event sender's retries (8 tries, at most 15 minutes apart), so a retry is never posted twice. */
const EVENT_CLAIM_SECONDS = 24 * 60 * 60;
/** How long a keyed message (a progress note) can still be edited. */
const MESSAGE_KEY_SECONDS = 14 * 24 * 60 * 60;
const SECRET_CACHE_MILLISECONDS = 60_000;

type Log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;

export interface SlackChannelForwarderDependencies {
  /** The channel API's origin, such as `https://abc.execute-api.us-east-1.amazonaws.com`. */
  channelApiUrl: string;
  /** The adapter's signing secret (`whsec_`). */
  secret(): Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Hands one Slack request to the channel API, which checks and queues it as it does any adapter's. Throws unless the
 * API accepted it or already had it, so the ingress undoes its records and Slack retries.
 */
export function createSlackChannelForwarder(deps: SlackChannelForwarderDependencies): (message: SlackRequestMessage) => Promise<void> {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const url = new URL(`/v1/channels/${SLACK_CHANNEL}/messages`, deps.channelApiUrl);
  return async (message) => {
    const body = JSON.stringify(inboundFromSlackRequest(message));
    const secret = await deps.secret();
    // A new ID for each attempt: the channel API drops a repeat by the Slack event ID, for a day.
    const headers = { "content-type": "application/json", ...webhookHeaders({ secret, id: `msg_${randomUUID()}`, timestamp: Math.floor(now() / 1_000), body }) };
    const response = await fetchFn(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(FORWARD_TIMEOUT_MILLISECONDS) });
    let status: unknown;
    try {
      status = ((await response.json()) as { status?: unknown }).status;
    } catch {
      status = undefined;
    }
    const taken = (response.status === 202 && status === "accepted") || (response.status === 200 && status === "duplicate");
    if (!taken) throw new Error(`the channel API did not take the request: HTTP ${response.status}`);
  };
}

export interface SlackChannelEventsDependencies {
  /** The adapter's signing secret, or undefined when it cannot be read. */
  secret(): Promise<string | undefined>;
  botToken(): Promise<string>;
  /** Claims an event ID until `expiresAtSeconds`; false when it is already claimed. */
  claim(eventId: string, expiresAtSeconds: number): Promise<boolean>;
  release(eventId: string): Promise<void>;
  /** The Slack timestamp of the message a key names in a thread, for an edit. */
  messageTs: {
    get(subject: string, key: string): Promise<string | undefined>;
    put(subject: string, key: string, ts: string, expiresAtSeconds: number): Promise<void>;
  };
  fetch?: typeof fetch;
  now?: () => number;
  log?: Log;
}

interface HttpResponse { statusCode: number; headers: Record<string, string>; body: string }

const respond = (statusCode: number, body: Record<string, unknown>): HttpResponse => ({
  statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body),
});

/**
 * The core's events for Slack. Each is checked against the adapter's secret, posted once (its ID is claimed, and
 * released again if the post fails, so the sender's retry is not taken as a repeat), and answered so the sender knows
 * whether to retry: 429 or 503 for a failure that may pass, 422 for one Slack will refuse again.
 */
export function createSlackChannelEventsHandler(deps: SlackChannelEventsDependencies) {
  const now = deps.now ?? Date.now;
  const log: Log = deps.log ?? (() => undefined);
  const fetchFn = deps.fetch ?? fetch;

  async function post(input: { channel: string; threadTs: string; text: string; blocks?: unknown[] | undefined }): Promise<string> {
    const token = await deps.botToken();
    try {
      return (await chatPostMessage(token, input, fetchFn)).ts;
    } catch (error) {
      // Blocks Slack refuses never cost the reply: the text goes on its own.
      if (input.blocks === undefined || !(error instanceof SlackPostError) || error.slackError !== "invalid_blocks") throw error;
      log("slack_adapter.blocks_refused", { slackError: error.slackError });
      return (await chatPostMessage(token, { ...input, blocks: undefined }, fetchFn)).ts;
    }
  }

  async function message(event: Extract<ChannelEvent, { type: "message" }>): Promise<void> {
    const thread = slackThreadOf(event.conversation);
    const { data } = event;
    const blocks = blocksOf(data.text, data.parts, data.actions);
    if (data.audience?.kind === "ephemeral") {
      await chatPostEphemeral(await deps.botToken(), { channel: thread.channelId, threadTs: thread.threadTs, user: data.audience.actor.userId, text: data.text, blocks }, fetchFn);
      return;
    }
    if (data.key === undefined) {
      await post({ channel: thread.channelId, threadTs: thread.threadTs, text: data.text, blocks });
      return;
    }
    // A keyed message (a progress note) is edited in place once posted; events of a conversation arrive in order.
    const subject = slackThreadSubject(thread);
    const ts = await deps.messageTs.get(subject, data.key);
    if (ts !== undefined) {
      await chatUpdate(await deps.botToken(), { channel: thread.channelId, ts, text: data.text, blocks }, fetchFn);
      return;
    }
    const posted = await post({ channel: thread.channelId, threadTs: thread.threadTs, text: data.text, blocks });
    try {
      await deps.messageTs.put(subject, data.key, posted, Math.floor(now() / 1_000) + MESSAGE_KEY_SECONDS);
    } catch (error) {
      // Posted already, so never retried: a later edit of this key is posted as a new message instead.
      log("slack_adapter.key_not_saved", { eventId: event.id, errorName: error instanceof Error ? error.name : "unknown" });
    }
  }

  async function render(event: ChannelEvent): Promise<"posted" | "ignored"> {
    if (event.type === "direct") return "ignored";
    const thread = slackThreadOf(event.conversation);
    const text = (value: string) => post({ channel: thread.channelId, threadTs: thread.threadTs, text: value });
    switch (event.type) {
      case "message":
        await message(event);
        return "posted";
      case "approval_request":
        // Slack's own Approve and Cancel buttons, which its interactivity answers as a typed reply would be.
        await post({ channel: thread.channelId, threadTs: thread.threadTs, text: event.data.text,
          ...(event.data.actions === undefined ? {} : { blocks: confirmationBlocks(event.data.text, event.data.requestId) }) });
        return "posted";
      case "progress": case "question": case "check_report": case "error":
        await text(event.data.text);
        return "posted";
      case "pr":
        await text(`<${event.data.url}|${event.data.title.replace(/[<>|]/g, "")}>`);
        return "posted";
      case "done":
        if (event.data.text === undefined) return "ignored";
        await text(event.data.text);
        return "posted";
      // The ingress already said "Got it", and Slack's actors are never linked.
      case "ack": case "link_required":
        return "ignored";
    }
  }

  return async (request: HttpApiV2Event): Promise<HttpResponse> => {
    if (request.requestContext?.http?.method !== "POST") return respond(405, { error: "method_not_allowed" });
    const body = request.isBase64Encoded === true ? Buffer.from(request.body ?? "", "base64").toString("utf8") : request.body ?? "";
    const secret = await deps.secret();
    if (secret === undefined) {
      log("slack_adapter.secret_unavailable", {});
      return respond(503, { error: "unavailable" });
    }
    const verified = verifyWebhook({ secret, headers: request.headers ?? {}, body, nowSeconds: Math.floor(now() / 1_000) });
    if (!verified.ok) {
      log("slack_adapter.refused", { reason: verified.reason });
      return respond(401, { error: verified.reason });
    }
    let event: ChannelEvent;
    try {
      const parsed = ChannelEventSchema.safeParse(JSON.parse(body));
      if (!parsed.success) return respond(400, { error: "invalid_event" });
      event = parsed.data;
    } catch {
      return respond(400, { error: "invalid_json" });
    }
    if (event.channel !== SLACK_CHANNEL || event.id !== verified.id) return respond(400, { error: "invalid_event" });
    if (!await deps.claim(event.id, Math.floor(now() / 1_000) + EVENT_CLAIM_SECONDS)) return respond(200, { status: "duplicate" });
    try {
      const outcome = await render(event);
      log("slack_adapter.event", { eventId: event.id, type: event.type, outcome });
      return respond(200, { status: outcome });
    } catch (error) {
      try {
        await deps.release(event.id);
      } catch {
        log("slack_adapter.release_failed", { eventId: event.id });
      }
      const slackError = error instanceof SlackPostError ? error.slackError : undefined;
      log("slack_adapter.post_failed", { eventId: event.id, type: event.type, errorName: error instanceof Error ? error.name : "unknown", ...(slackError === undefined ? {} : { slackError }) });
      if (slackError === "ratelimited" || slackError === "rate_limited") return respond(429, { error: "rate_limited" });
      // A post Slack refused with its own code is refused again; anything else may pass.
      if (slackError !== undefined && !postMayHaveLanded(error)) return respond(422, { error: "refused" });
      return respond(503, { error: "try_again" });
    }
  };
}

/** Slack's own action IDs for the core's, where its interactivity already answers them. */
const SLACK_ACTION_IDS: Readonly<Record<string, string>> = { [TURN_DETAILS_ACTION_ID]: DETAILS_ACTION };

/** A message's parts and actions as Block Kit, or undefined for text alone. */
export function blocksOf(text: string, parts: readonly MessagePart[] | undefined, actions: readonly MessageAction[] | undefined): unknown[] | undefined {
  if (parts === undefined && actions === undefined) return undefined;
  // The Details button alone keeps exactly the blocks Slack's replies have always had (spec 014 FR-024).
  const only = actions?.length === 1 ? actions[0] : undefined;
  if (parts === undefined && only?.type === "button" && only.actionId === TURN_DETAILS_ACTION_ID) return detailsReplyBlocks(text, only.value);
  const section = (value: string) => splitSectionText(value).map((part) => ({ type: "section", text: { type: "mrkdwn", text: part } }));
  const blocks: unknown[] = [...section(text)];
  for (const part of parts ?? []) {
    if (part.type === "section") blocks.push(...section(part.text));
    else if (part.type === "fields") blocks.push({ type: "section", fields: part.fields.map((field) => ({ type: "mrkdwn", text: `*${field.label}*\n${field.value}` })) });
    else if (part.type === "context") blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: part.text }] });
    else if (part.type === "divider") blocks.push({ type: "divider" });
    else blocks.push({ type: "image", image_url: part.url, alt_text: part.alt });
  }
  const elements = (actions ?? []).flatMap((action, index): unknown[] => {
    const label = (value: string) => ({ type: "plain_text", text: value });
    if (action.type === "button") return [{ type: "button", action_id: SLACK_ACTION_IDS[action.actionId] ?? action.actionId, text: label(action.label), value: action.value, ...(action.style === undefined ? {} : { style: action.style }) }];
    if (action.type === "link") return [{ type: "button", action_id: `link_${index}`, text: label(action.label), url: action.url }];
    if (action.type === "select") return [{ type: "static_select", action_id: action.actionId, placeholder: label(action.placeholder), options: action.options.map((option) => ({ text: label(option.label), value: option.value })) }];
    // Forms are not declared for the built-in adapter yet (Phase 7c).
    return [];
  });
  if (elements.length > 0) blocks.push({ type: "actions", elements });
  return blocks;
}

/** The adapter's signing secret from Secrets Manager, reread at most once a minute so a rotation takes effect. */
export function slackAdapterSecretReader(secretsManager: Pick<SecretsManagerClient, "send">, secretName: string): () => Promise<string | undefined> {
  let cached: { value: string | undefined; at: number } | undefined;
  return async () => {
    if (cached !== undefined && Date.now() - cached.at < SECRET_CACHE_MILLISECONDS) return cached.value;
    try {
      const value = usableWebhookSecret((await secretsManager.send(new GetSecretValueCommand({ SecretId: secretName }))).SecretString);
      cached = { value, at: Date.now() };
      return value;
    } catch {
      return undefined;
    }
  };
}

/**
 * The forwarder when the deployment routes Slack through the channel API (`SlackViaChannel`), otherwise undefined and
 * Slack requests go on the Slack request queue as before.
 */
export function slackChannelForwarderFromEnvironment(secretsManager: Pick<SecretsManagerClient, "send">): ((message: SlackRequestMessage) => Promise<void>) | undefined {
  const channelApiUrl = process.env.CHANNEL_API_URL;
  const secretName = process.env.SLACK_ADAPTER_SECRET_NAME;
  if (process.env.SLACK_VIA_CHANNEL !== "enabled" || !channelApiUrl || !secretName) return undefined;
  const read = slackAdapterSecretReader(secretsManager, secretName);
  return createSlackChannelForwarder({
    channelApiUrl,
    async secret() {
      const value = await read();
      if (value === undefined) throw new Error("the Slack adapter's signing secret could not be read");
      return value;
    },
  });
}

/** The AWS handler for POST /v1/slack/channel-events; nothing is reachable unless Slack goes through the channel API. */
export function createAwsSlackChannelEventsHandler(botToken: () => Promise<string>): (request: HttpApiV2Event) => Promise<HttpResponse> {
  if (process.env.SLACK_VIA_CHANNEL !== "enabled" || !process.env.SLACK_ADAPTER_SECRET_NAME) return async () => respond(404, { error: "not_found" });
  const clientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfiguration), { marshallOptions: { removeUndefinedValues: true } });
  const secretsManager = new SecretsManagerClient(clientConfiguration);
  const tableName = requiredEnvironment("SLACK_THREADS_TABLE_NAME");
  return createSlackChannelEventsHandler({
    secret: slackAdapterSecretReader(secretsManager, requiredEnvironment("SLACK_ADAPTER_SECRET_NAME")),
    botToken,
    async claim(eventId, expiresAtSeconds) {
      try {
        await documentClient.send(new PutCommand({ TableName: tableName, Item: { pk: `CHANNEL_EVENT#${eventId}`, sk: "META", expiresAt: expiresAtSeconds }, ConditionExpression: "attribute_not_exists(pk)" }));
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
    async release(eventId) {
      await documentClient.send(new DeleteCommand({ TableName: tableName, Key: { pk: `CHANNEL_EVENT#${eventId}`, sk: "META" } }));
    },
    messageTs: {
      async get(subject, key) {
        const response = await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk: `MESSAGE_KEY#${subject}#${key}`, sk: "META" }, ConsistentRead: true }));
        const ts: unknown = (response.Item as Record<string, unknown> | undefined)?.ts;
        return typeof ts === "string" ? ts : undefined;
      },
      async put(subject, key, ts, expiresAtSeconds) {
        await documentClient.send(new PutCommand({ TableName: tableName, Item: { pk: `MESSAGE_KEY#${subject}#${key}`, sk: "META", ts, expiresAt: expiresAtSeconds } }));
      },
    },
    log(event, fields) {
      console.log(JSON.stringify({ component: "slack-adapter", event, ...fields }));
    },
  });
}
