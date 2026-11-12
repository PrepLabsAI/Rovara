// Spec 062 Phase 7b (FR-073): the built-in Slack adapter's channel side. Slack's ingress hands an ordinary conversation
// request to the channel API, signed with the adapter's own secret, as any adapter does; the core's events for Slack
// come back, signed the same way, to POST /v1/slack/channel-events, where they are posted to Slack.
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  SLACK_CONFIRMATION_ACTION_ID,
  ChannelActionSchema,
  ChannelCommandSchema,
  InboundMessageSchema,
  ChannelEventSchema,
  SLACK_CHANNEL,
  confirmationBlocks,
  conversationFromSlackThread,
  inboundFromSlackRequest,
  ChannelActionAnswerSchema,
  slackBlocksOf,
  slackModalOf,
  slackThreadOf,
  slackThreadSubject,
  usableWebhookSecret,
  verifyWebhook,
  webhookHeaders,
  type ChannelAction,
  type ChannelActionAnswer,
  type ChannelCommand,
  type ChannelEvent,
  type DirectoryUser,
  type InboundMessage,
  type MessageAction,
  type MessagePart,
  type SlackRequestMessage,
} from "@agentx/contracts";
import { requiredEnvironment, type HttpApiV2Event } from "./lambda.js";
import { SlackPostError, chatPostEphemeral, chatPostMessage, chatUpdate, createChannelCanvas, deleteTaskPlanCanvas, postMayHaveLanded, slackWebFetch } from "./slack-web.js";

export const SLACK_CHANNEL_EVENTS_PATH = "/v1/slack/channel-events";

/** A confirmation press, already claimed and counted by Slack's interactivity, as the action the channel API takes. */
export function confirmationAction(message: SlackRequestMessage): ChannelAction {
  return ChannelActionSchema.parse({
    version: 1, channel: SLACK_CHANNEL, eventId: message.eventId, conversation: conversationFromSlackThread(message.thread),
    actor: { channel: SLACK_CHANNEL, tenant: message.thread.teamId, userId: message.userId },
    actionId: SLACK_CONFIRMATION_ACTION_ID, value: message.text, receivedAt: message.receivedAt,
  });
}
/** Phase 7c: where the core's commands for Slack come, each answered at once. */
export const SLACK_CHANNEL_COMMANDS_PATH = "/v1/slack/channel-commands";

/** Phase 7c2: Slack has its answer before the hand-off, so the channel API may take its time (its own limit is 10 s). */
const FORWARD_TIMEOUT_MILLISECONDS = 9_000;
/** How long a thread Rovara posted in has its plain replies read; each post renews it. */
const ROVARA_THREAD_SECONDS = 90 * 24 * 60 * 60;
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
export function createSlackChannelForwarder(deps: SlackChannelForwarderDependencies): (message: SlackRequestMessage | InboundMessage | ChannelAction) => Promise<void> {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const messagesUrl = new URL(`/v1/channels/${SLACK_CHANNEL}/messages`, deps.channelApiUrl);
  // Phase 7c2: a press (a confirmation's Approve or Cancel) is an action.
  const actionsUrl = new URL(`/v1/channels/${SLACK_CHANNEL}/actions`, deps.channelApiUrl);
  return async (message) => {
    const action = "actionId" in message;
    const url = action ? actionsUrl : messagesUrl;
    const body = JSON.stringify(action ? ChannelActionSchema.parse(message) : message.version === 2 ? InboundMessageSchema.parse(message) : inboundFromSlackRequest(message));
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
  /** Phase 7c2: remembers a thread Rovara posted in, whose plain replies are then read. Best effort. */
  markThread?: (channelId: string, threadTs: string, expiresAtSeconds: number) => Promise<void>;
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
      case "progress":
        // code/next's `onlyTo`: one person only (a one-use link code), never posted for the whole thread.
        if (event.data.onlyTo !== undefined) {
          await chatPostEphemeral(await deps.botToken(), { channel: thread.channelId, threadTs: thread.threadTs, user: event.data.onlyTo, text: event.data.text }, fetchFn);
          return "posted";
        }
        await text(event.data.text);
        return "posted";
      case "question": case "check_report": case "error":
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
      if (outcome === "posted" && event.type !== "direct" && deps.markThread !== undefined) {
        const thread = slackThreadOf(event.conversation);
        await deps.markThread(thread.channelId, thread.threadTs, Math.floor(now() / 1_000) + ROVARA_THREAD_SECONDS)
          .catch(() => log("slack_adapter.thread_not_marked", { eventId: event.id }));
      }
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

export interface SlackChannelCommandsDependencies {
  secret(): Promise<string | undefined>;
  /** Phase 7c2: remembers a thread Rovara posted in. Best effort. */
  markThread?: (channelId: string, threadTs: string, expiresAtSeconds: number) => Promise<void>;
  botToken(): Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: Log;
}

/** Slack's directory reads take 1,000 members, or 200 channels, a page. */
const MEMBERS_PAGE = "1000";
const CHANNELS_PAGE = "200";

/** No readable answer from Slack (a timeout, a 429 or 5xx): the core reads the command as unanswered. */
class Unanswered extends Error {}

/** One Web API read: Slack's answer when it is ok, a refusal by Slack's code, or Unanswered. */
async function slackRead(token: string, method: string, query: Record<string, string>, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await slackWebFetch(method, token, { query, signal: AbortSignal.timeout(5_000) }, fetchFn);
  } catch {
    throw new Unanswered(method);
  }
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
  if (response.status === 429 || response.status >= 500 || record === undefined) throw new Unanswered(method);
  if (record.ok !== true) {
    const code = typeof record.error === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(record.error) ? record.error : "no_error_code";
    throw new Refused(code, `Slack refused ${method}`);
  }
  return record;
}

const text200 = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.slice(0, 200) : undefined);
const cursorOf = (body: Record<string, unknown>) => {
  const next = (body.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
  return typeof next === "string" && next !== "" ? next.slice(0, 500) : undefined;
};

/** A Slack user as the directory's person; one Slack describes oddly is refused, so the core never guesses. */
function directoryUserOf(user: unknown): DirectoryUser {
  const value = typeof user === "object" && user !== null ? user as Record<string, unknown> : {};
  const profile = typeof value.profile === "object" && value.profile !== null ? value.profile as Record<string, unknown> : {};
  const enterprise = value.enterprise_user as { teams?: unknown } | undefined;
  if (typeof value.id !== "string" || typeof value.is_bot !== "boolean" || (value.deleted !== undefined && typeof value.deleted !== "boolean")
    || (value.is_stranger !== undefined && typeof value.is_stranger !== "boolean")
    || (enterprise !== undefined && (!Array.isArray(enterprise.teams) || !enterprise.teams.every((team) => typeof team === "string")))) {
    throw new Refused("malformed_user", "Slack described the person in a way the directory cannot read");
  }
  const email = typeof profile.email === "string" && /^[^@\s]+@[^@\s]+$/.test(profile.email) && profile.email.length <= 320 ? profile.email : undefined;
  const name = text200(value.name);
  const displayName = text200(profile.display_name);
  const realName = text200(profile.real_name) ?? text200(value.real_name);
  return {
    userId: value.id,
    ...(typeof value.team_id === "string" ? { tenant: value.team_id } : {}),
    ...(enterprise === undefined ? {} : { linkedTenants: (enterprise.teams as string[]).slice(0, 200) }),
    ...(name === undefined ? {} : { name }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(realName === undefined ? {} : { realName }),
    ...(email === undefined ? {} : { email }),
    bot: value.is_bot,
    deleted: value.deleted === true,
    ...(value.is_stranger === undefined ? {} : { external: value.is_stranger }),
  };
}

/** A command answered with a refusal: nothing it asked for is left done. */
class Refused extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/**
 * Phase 7c: the core's commands for Slack. Each is checked against the adapter's secret, run, and answered signed with
 * the command's own ID: Slack's result, or Slack's error code when Slack refused, so nothing was done. A failure that
 * may have reached Slack (a timeout, a lost connection) is answered 503, which the core reads as "may have run".
 */
export function createSlackChannelCommandsHandler(deps: SlackChannelCommandsDependencies) {
  const now = deps.now ?? Date.now;
  const log: Log = deps.log ?? (() => undefined);
  const fetchFn = deps.fetch ?? fetch;

  async function run(command: ChannelCommand): Promise<unknown> {
    // Nothing reached Slack without a token.
    const token = await deps.botToken().catch(() => { throw new Refused("token_unavailable", "the Slack bot token could not be read"); });
    switch (command.kind) {
      case "post_message": {
        const blocks = slackBlocksOf(command.message);
        if (command.audience?.kind === "ephemeral") {
          await chatPostEphemeral(token, { channel: command.space, threadTs: command.thread, user: command.audience.actor.userId, text: command.message.text, blocks }, fetchFn);
          return { space: command.space };
        }
        const posted = await chatPostMessage(token, { channel: command.space, threadTs: command.thread, text: command.message.text, blocks }, fetchFn);
        const thread = command.thread ?? posted.ts;
        await deps.markThread?.(command.space, thread, Math.floor(now() / 1_000) + ROVARA_THREAD_SECONDS).catch(() => log("slack_adapter.thread_not_marked", {}));
        return { space: posted.channel ?? command.space, messageId: posted.ts, thread };
      }
      case "direct_message": {
        // A post to a person's ID lands in the bot's direct message with them, whose ID Slack answers.
        const posted = await chatPostMessage(token, { channel: command.to.userId, text: command.message.text, blocks: slackBlocksOf(command.message) }, fetchFn);
        return { space: posted.channel ?? command.to.userId, messageId: posted.ts };
      }
      case "update_message":
        await chatUpdate(token, { channel: command.space, ts: command.messageId, text: command.message.text, blocks: slackBlocksOf(command.message) }, fetchFn);
        return { updated: true };
      case "create_document": {
        // A Canvas is shared with a channel (C or G); Slack holds 32 KB of Markdown in one.
        if (!/^[CG][A-Z0-9]{8,}$/.test(command.space) || Buffer.byteLength(command.markdown, "utf8") > 32_768) throw new Refused("invalid_input", "the document's channel or size is not one Slack takes");
        let created: string | undefined;
        try {
          const canvas = await createChannelCanvas(token, { channel: command.space, title: command.title, markdown: command.markdown }, fetchFn, async (canvasId) => { created = canvasId; });
          return { documentId: canvas.canvasId, url: canvas.permalink };
        } catch (error) {
          if (created === undefined) throw error;
          // The core never heard of a Canvas that failed after it was made, so it is removed here, and the answer is a
          // refusal: Slack's own code where Slack refused, so the core reads it as it always has.
          await deleteTaskPlanCanvas(token, created, fetchFn).catch(() => log("slack_adapter.canvas_cleanup_failed", {}));
          const code = error instanceof SlackPostError && !postMayHaveLanded(error) ? error.slackError : "canvas_unavailable";
          throw new Refused(code, "the Canvas could not be shared");
        }
      }
      case "delete_document":
        return { deleted: (await deleteTaskPlanCanvas(token, command.documentId, fetchFn)) === "deleted" };
      // Phase 7c3b: a form still open, updated by the handle its submission gave (Slack's view ID).
      case "update_form": {
        const response = await slackWebFetch("views.update", token, { body: { view_id: command.handle, view: slackModalOf(command.form) }, signal: AbortSignal.timeout(5_000) }, fetchFn)
          .catch(() => { throw new Unanswered("views.update"); });
        const body = await response.json().catch(() => undefined) as { ok?: unknown; error?: unknown } | undefined;
        if (response.status === 429 || response.status >= 500 || body === undefined) throw new Unanswered("views.update");
        if (body.ok !== true) throw new Refused(typeof body.error === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(body.error) ? body.error : "no_error_code", "Slack refused views.update");
        return { updated: true };
      }
      // Phase 7c1b: the directory's reads.
      case "user":
        try {
          return { user: directoryUserOf((await slackRead(token, "users.info", { user: command.userId }, fetchFn)).user) };
        } catch (error) {
          if (error instanceof Refused && error.code === "user_not_found") return {};
          throw error;
        }
      case "user_by_email":
        try {
          return { user: directoryUserOf((await slackRead(token, "users.lookupByEmail", { email: command.email }, fetchFn)).user) };
        } catch (error) {
          if (error instanceof Refused && error.code === "users_not_found") return {};
          throw error;
        }
      case "space_members": {
        const body = await slackRead(token, "conversations.members", { channel: command.space, limit: MEMBERS_PAGE, ...(command.cursor === undefined ? {} : { cursor: command.cursor }) }, fetchFn);
        if (!Array.isArray(body.members) || !body.members.every((member) => typeof member === "string")) throw new Refused("malformed_members", "Slack's member list cannot be read");
        const nextCursor = cursorOf(body);
        return { members: body.members, ...(nextCursor === undefined ? {} : { nextCursor }) };
      }
      case "space":
        try {
          const channel = (await slackRead(token, "conversations.info", { channel: command.space }, fetchFn)).channel as { name?: unknown; is_private?: unknown } | undefined;
          if (typeof channel?.name !== "string") throw new Refused("malformed_channel", "Slack's channel cannot be read");
          // Fail closed: a channel is public only when Slack says so.
          return { space: { name: channel.name.slice(0, 200), private: channel.is_private !== false } };
        } catch (error) {
          if (error instanceof Refused && error.code === "channel_not_found") return {};
          throw error;
        }
      case "spaces": {
        const body = await slackRead(token, "conversations.list", { types: "public_channel", exclude_archived: "true", limit: CHANNELS_PAGE, ...(command.cursor === undefined ? {} : { cursor: command.cursor }) }, fetchFn);
        if (!Array.isArray(body.channels)) throw new Refused("malformed_channels", "Slack's channel list cannot be read");
        const spaces = (body.channels as Array<{ id?: unknown; name?: unknown; is_private?: unknown }>).flatMap((channel) =>
          typeof channel.id === "string" && typeof channel.name === "string" && channel.name !== "" ? [{ space: channel.id, name: channel.name.slice(0, 200), private: channel.is_private !== false }] : []);
        const nextCursor = cursorOf(body);
        return { spaces, ...(nextCursor === undefined ? {} : { nextCursor }) };
      }
      case "check": {
        const body = await slackRead(token, "auth.test", {}, fetchFn);
        if (typeof body.team_id !== "string") throw new Refused("no_team", "Slack named no team for the bot token");
        return { tenant: body.team_id };
      }
      default:
        throw new Refused("unsupported", `the Slack adapter does not take ${command.kind} commands`);
    }
  }

  return async (request: HttpApiV2Event): Promise<HttpResponse> => {
    if (request.requestContext?.http?.method !== "POST") return respond(405, { error: "method_not_allowed" });
    const body = request.isBase64Encoded === true ? Buffer.from(request.body ?? "", "base64").toString("utf8") : request.body ?? "";
    const secret = await deps.secret();
    if (secret === undefined) return respond(503, { error: "unavailable" });
    const nowSeconds = Math.floor(now() / 1_000);
    const verified = verifyWebhook({ secret, headers: request.headers ?? {}, body, nowSeconds });
    if (!verified.ok) {
      log("slack_adapter.command_refused", { reason: verified.reason });
      return respond(401, { error: verified.reason });
    }
    let command: ChannelCommand;
    try {
      const parsed = ChannelCommandSchema.safeParse(JSON.parse(body));
      if (!parsed.success || parsed.data.id !== verified.id || parsed.data.channel !== SLACK_CHANNEL) return respond(400, { error: "invalid_command" });
      command = parsed.data;
    } catch {
      return respond(400, { error: "invalid_json" });
    }
    const answer = (value: Record<string, unknown>): HttpResponse => {
      const text = JSON.stringify(value);
      return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store", ...webhookHeaders({ secret, id: command.id, timestamp: Math.floor(now() / 1_000), body: text }) }, body: text };
    };
    try {
      const result = await run(command);
      log("slack_adapter.command", { kind: command.kind, outcome: "ok" });
      return answer({ ok: true, result });
    } catch (error) {
      if (error instanceof Unanswered) {
        log("slack_adapter.command", { kind: command.kind, outcome: "unanswered" });
        return respond(503, { error: "try_again" });
      }
      if (error instanceof Refused) {
        log("slack_adapter.command", { kind: command.kind, outcome: "refused", code: error.code });
        return answer({ ok: false, error: { code: error.code, message: error.message } });
      }
      const slackError = error instanceof SlackPostError ? error.slackError : undefined;
      log("slack_adapter.command", { kind: command.kind, outcome: "failed", errorName: error instanceof Error ? error.name : "unknown", ...(slackError === undefined ? {} : { slackError }) });
      if (slackError !== undefined && !postMayHaveLanded(error)) return answer({ ok: false, error: { code: slackError, message: `Slack refused the ${command.kind} command` } });
      // Anything else may have reached Slack.
      return respond(503, { error: "try_again" });
    }
  };
}

/** A message's parts and actions as Block Kit, or undefined for text alone (the shared Slack renderer). */
export function blocksOf(text: string, parts: readonly MessagePart[] | undefined, actions: readonly MessageAction[] | undefined): unknown[] | undefined {
  return slackBlocksOf({ text, ...(parts === undefined ? {} : { parts: [...parts] }), ...(actions === undefined ? {} : { actions: [...actions] }) });
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
 * Phase 7c3b: sends one action and waits for the core's answer: the form to open, or what to do with a submitted one.
 * Undefined when the channel API queued it instead. Throws on no answer within `timeoutMs`.
 */
export function createSlackChannelActionClient(deps: SlackChannelForwarderDependencies): (action: ChannelAction, timeoutMs: number) => Promise<ChannelActionAnswer | undefined> {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const url = new URL(`/v1/channels/${SLACK_CHANNEL}/actions`, deps.channelApiUrl);
  return async (action, timeoutMs) => {
    const body = JSON.stringify(ChannelActionSchema.parse(action));
    const secret = await deps.secret();
    const headers = { "content-type": "application/json", ...webhookHeaders({ secret, id: `act_${randomUUID()}`, timestamp: Math.floor(now() / 1_000), body }) };
    const response = await fetchFn(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(Math.max(200, timeoutMs)) });
    const json: unknown = await response.json().catch(() => undefined);
    if (response.status === 202) return undefined;
    const answer = ChannelActionAnswerSchema.safeParse(json);
    if (response.status !== 200 || !answer.success) throw new Error(`the channel API did not answer the action: HTTP ${response.status}`);
    return answer.data;
  };
}

/** The action client when the deployment routes Slack through the channel API; otherwise undefined. */
export function slackChannelActionClientFromEnvironment(secretsManager: Pick<SecretsManagerClient, "send">): ReturnType<typeof createSlackChannelActionClient> | undefined {
  const channelApiUrl = process.env.CHANNEL_API_URL;
  const secretName = process.env.SLACK_ADAPTER_SECRET_NAME;
  if (process.env.SLACK_VIA_CHANNEL !== "enabled" || !channelApiUrl || !secretName) return undefined;
  const read = slackAdapterSecretReader(secretsManager, secretName);
  return createSlackChannelActionClient({
    channelApiUrl,
    async secret() {
      const value = await read();
      if (value === undefined) throw new Error("the Slack adapter's signing secret could not be read");
      return value;
    },
  });
}

/**
 * The forwarder when the deployment routes Slack through the channel API (`SlackViaChannel`), otherwise undefined and
 * Slack requests go on the Slack request queue as before.
 */
export function slackChannelForwarderFromEnvironment(secretsManager: Pick<SecretsManagerClient, "send">): ((message: SlackRequestMessage | InboundMessage | ChannelAction) => Promise<void>) | undefined {
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

/** Phase 7c2: the threads Rovara posted in, in Slack's threads table, so their plain replies are read. */
export function rovaraThreads(documentClient: Pick<DynamoDBDocumentClient, "send">, tableName: string) {
  const key = (channelId: string, threadTs: string) => ({ pk: `ROVARA_THREAD#${channelId}#${threadTs}`, sk: "META" });
  return {
    async mark(channelId: string, threadTs: string, expiresAtSeconds: number): Promise<void> {
      await documentClient.send(new PutCommand({ TableName: tableName, Item: { ...key(channelId, threadTs), expiresAt: expiresAtSeconds } }));
    },
    async has(channelId: string, threadTs: string): Promise<boolean> {
      const response = await documentClient.send(new GetCommand({ TableName: tableName, Key: key(channelId, threadTs), ConsistentRead: true }));
      const expiresAt: unknown = (response.Item as Record<string, unknown> | undefined)?.expiresAt;
      return typeof expiresAt === "number" && expiresAt > Math.floor(Date.now() / 1_000);
    },
  };
}

/** The AWS handler for POST /v1/slack/channel-commands; nothing is reachable unless Slack goes through the channel API. */
export function createAwsSlackChannelCommandsHandler(botToken: () => Promise<string>): (request: HttpApiV2Event) => Promise<HttpResponse> {
  if (process.env.SLACK_VIA_CHANNEL !== "enabled" || !process.env.SLACK_ADAPTER_SECRET_NAME) return async () => respond(404, { error: "not_found" });
  const clientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const threads = rovaraThreads(DynamoDBDocumentClient.from(new DynamoDBClient(clientConfiguration)), requiredEnvironment("SLACK_THREADS_TABLE_NAME"));
  return createSlackChannelCommandsHandler({
    secret: slackAdapterSecretReader(new SecretsManagerClient(clientConfiguration), requiredEnvironment("SLACK_ADAPTER_SECRET_NAME")),
    botToken,
    markThread: (channelId, threadTs, expiresAtSeconds) => threads.mark(channelId, threadTs, expiresAtSeconds),
    log(event, fields) {
      console.log(JSON.stringify({ component: "slack-adapter", event, ...fields }));
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
  const threads = rovaraThreads(documentClient, tableName);
  return createSlackChannelEventsHandler({
    markThread: (channelId, threadTs, expiresAtSeconds) => threads.mark(channelId, threadTs, expiresAtSeconds),
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
