import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  CONFIRM_APPROVE_ACTION,
  CONFIRM_CANCEL_ACTION,
  SlackChannelIdSchema,
  SlackMessageTimestampSchema,
  SlackRequestMessageSchema,
  SlackTeamIdSchema,
  SlackUserIdSchema,
  answeredConfirmationBlocks,
  confirmationClickEventId,
  confirmationKey,
  pendingConfirmationFromItem,
  slackThreadSubject,
  type PendingConfirmation,
  type SlackRequestMessage,
  type SlackThread,
} from "@agentx/contracts";
import { requiredEnvironment, type HttpApiV2Event } from "./lambda.js";
import { parseSlackSecrets, validSignature, type SlackIngressLog, type SlackSecrets } from "./slack-ingress.js";

const EVENT_RETENTION_SECONDS = 14 * 24 * 60 * 60;
/** Every Slack call made while Slack waits (3 seconds) for this request's answer gives up after this. */
const SLACK_FETCH_TIMEOUT_MILLISECONDS = 2_000;
const SECRET_CACHE_MILLISECONDS = 5 * 60 * 1_000;

/** One Block Kit button press, from a signed Slack interactivity request. */
export interface SlackBlockAction {
  actionId: string;
  value: string;
  userId: string;
  thread: SlackThread;
  /** The message that carries the button. */
  messageTs: string;
  /** The message's text, as AgentX posted it. */
  messageText: string;
  responseUrl: string;
  /** For opening a modal, such as the Details view (spec 014 phase 14d). */
  triggerId: string;
}

/** Handles the button presses whose action ID it matches. 14c registers confirmations; 14d adds Details. */
export interface SlackActionHandler {
  matches(actionId: string): boolean;
  handle(action: SlackBlockAction): Promise<void>;
}

export interface SlackInteractivityDependencies {
  secrets: () => Promise<SlackSecrets>;
  handlers: readonly SlackActionHandler[];
  /** Answers the clicking member privately when no handler matches the button (an old button after a rollback). */
  respondEphemeral?: (responseUrl: string, text: string) => Promise<void>;
  now?: () => number;
  log?: SlackIngressLog;
}

/** What a member hears, privately, for a button this release does not know. */
export const UNKNOWN_BUTTON_TEXT = "This button is no longer available.";
/** What a member hears, privately, when a handler fails before it took the click (nothing was queued). */
export const CLICK_FAILED_TEXT = "I couldn't process that click. Press the button again, or reply `@AgentX yes`.";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

interface HttpResponse { statusCode: number; headers: Record<string, string>; body: string }

function respond(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * POST /v1/slack/interactions: Slack's interactivity request URL. It refuses a request whose Slack
 * signature does not verify, reads the form-encoded `payload`, and hands each `block_actions`
 * button press to the handler that matches its action ID. It answers 200 quickly; a handler's own
 * failure is logged, never retried by Slack.
 */
export function createSlackInteractivityHandler(dependencies: SlackInteractivityDependencies) {
  const now = dependencies.now ?? Date.now;
  const log: SlackIngressLog = dependencies.log ?? (() => undefined);
  return async (event: HttpApiV2Event): Promise<HttpResponse> => {
    const rawBody = event.body === undefined ? "" : event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const secrets = await dependencies.secrets();
    if (!validSignature(secrets.signingSecret, headers["x-slack-request-timestamp"], headers["x-slack-signature"], rawBody, now())) {
      log("interaction.rejected", { reason: "invalid_signature" });
      return respond(401, { error: "invalid Slack signature" });
    }
    let payload: Record<string, unknown>;
    try {
      payload = asRecord(JSON.parse(new URLSearchParams(rawBody).get("payload") ?? ""));
    } catch {
      log("interaction.rejected", { reason: "malformed_payload" });
      return respond(400, { error: "interaction payload is not JSON" });
    }
    if (payload.type !== "block_actions") {
      log("interaction.ignored", { reason: "not_block_actions" });
      return respond(200, { ok: true });
    }
    const actions = parseBlockActions(payload);
    if ("reason" in actions) {
      log("interaction.ignored", { reason: actions.reason });
      return respond(200, { ok: true });
    }
    for (const action of actions.actions) {
      const handler = dependencies.handlers.find((entry) => entry.matches(action.actionId));
      if (!handler) {
        log("interaction.ignored", { reason: "unknown_action", actionId: action.actionId.slice(0, 64) });
        try {
          await dependencies.respondEphemeral?.(action.responseUrl, UNKNOWN_BUTTON_TEXT);
        } catch (error) {
          log("interaction.respond_failed", { errorName: error instanceof Error ? error.name : "unknown" });
        }
        continue;
      }
      try {
        await handler.handle(action);
      } catch (error) {
        // A handler throws only before it took the click (the confirmation handler guards every step
        // after its claim), so the member can safely press again.
        log("interaction.failed", { actionId: action.actionId.slice(0, 64), errorName: errorName(error) });
        try {
          await dependencies.respondEphemeral?.(action.responseUrl, CLICK_FAILED_TEXT);
        } catch (respondError) {
          log("interaction.respond_failed", { errorName: errorName(respondError) });
        }
      }
    }
    return respond(200, { ok: true });
  };
}

/** Only Slack's own response URLs are ever fetched. */
function isSlackResponseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "hooks.slack.com";
  } catch {
    return false;
  }
}

function parseBlockActions(payload: Record<string, unknown>): { actions: SlackBlockAction[] } | { reason: string } {
  const user = asRecord(payload.user);
  const container = asRecord(payload.container);
  const message = asRecord(payload.message);
  const teamId = SlackTeamIdSchema.safeParse(asRecord(payload.team).id ?? user.team_id);
  const userId = SlackUserIdSchema.safeParse(user.id);
  const channelId = SlackChannelIdSchema.safeParse(container.channel_id ?? asRecord(payload.channel).id);
  const messageTs = SlackMessageTimestampSchema.safeParse(container.message_ts ?? message.ts);
  const threadTs = SlackMessageTimestampSchema.safeParse(message.thread_ts ?? container.thread_ts ?? container.message_ts);
  if (!teamId.success || !userId.success || !channelId.success || !messageTs.success || !threadTs.success) return { reason: "malformed_action" };
  if (!isSlackResponseUrl(payload.response_url)) return { reason: "malformed_action" };
  const thread = { teamId: teamId.data, channelId: channelId.data, threadTs: threadTs.data };
  const entries = Array.isArray(payload.actions) ? payload.actions.map(asRecord) : [];
  return {
    actions: entries.flatMap((entry) => typeof entry.action_id === "string" && typeof entry.value === "string" ? [{
      actionId: entry.action_id,
      value: entry.value,
      userId: userId.data,
      thread,
      messageTs: messageTs.data,
      messageText: typeof message.text === "string" ? message.text : "",
      responseUrl: payload.response_url as string,
      triggerId: typeof payload.trigger_id === "string" ? payload.trigger_id : "",
    }] : []),
  };
}

export interface ConfirmationClickDependencies {
  loadConfirmation: (subject: string) => Promise<PendingConfirmation | undefined>;
  claimEvent: (eventId: string, expiresAtSeconds: number) => Promise<boolean>;
  releaseEvent: (eventId: string) => Promise<void>;
  changePending: (threadSubject: string, delta: 1 | -1) => Promise<number>;
  enqueue: (message: SlackRequestMessage, messageGroupId: string) => Promise<void>;
  updateMessage: (input: { channel: string; ts: string; text: string; blocks: unknown[] }) => Promise<void>;
  respondEphemeral: (responseUrl: string, text: string) => Promise<void>;
  now?: () => number;
  log?: SlackIngressLog;
}

const NOT_PENDING = "That confirmation is no longer pending, so nothing was run.";
const RETRY_CLICK = "I couldn't take that click. Press the button again, or reply `@AgentX yes`.";
const ALREADY_RECEIVED = "Already received. I'm on it.";

/**
 * Approve and Cancel on a confirmation message (spec 014 D2). Only the member who was asked can
 * answer; anyone else gets a notice only they see. A requester's click becomes a queue message
 * with the text "yes" or "cancel" and an event ID derived from the confirmation and its postedAt, so the Slack
 * service runs it through the same checks as a typed "@AgentX yes", and a repeated click is a
 * duplicate event. The buttons are then replaced by who answered.
 */
export function confirmationActionHandler(dependencies: ConfirmationClickDependencies): SlackActionHandler {
  const now = dependencies.now ?? Date.now;
  const log: SlackIngressLog = dependencies.log ?? (() => undefined);
  return {
    matches: (actionId) => actionId === CONFIRM_APPROVE_ACTION || actionId === CONFIRM_CANCEL_ACTION,
    async handle(action) {
      const answer = async (responseUrl: string, text: string): Promise<void> => {
        try {
          await dependencies.respondEphemeral(responseUrl, text);
        } catch (error) {
          log("interaction.respond_failed", { errorName: errorName(error) });
        }
      };
      const click = action.actionId === CONFIRM_APPROVE_ACTION ? "approve" : "cancel";
      const subject = slackThreadSubject(action.thread);
      const pending = await dependencies.loadConfirmation(subject);
      const live = pending !== undefined && pending.confirmationId === action.value && pending.retiredAt === undefined && now() < Date.parse(pending.expiresAt);
      if (!live) {
        log("interaction.ignored", { reason: "not_pending" });
        await dependencies.respondEphemeral(action.responseUrl, NOT_PENDING);
        return;
      }
      if (pending.requesterId !== action.userId) {
        log("interaction.ignored", { reason: "not_requester" });
        await dependencies.respondEphemeral(action.responseUrl, `Only <@${pending.requesterId}> can answer this confirmation.`);
        return;
      }
      // postedAt keeps a click on a re-posted confirmation (same ID, redelivered request) from reusing an earlier click's event ID.
      const eventId = confirmationClickEventId(pending.confirmationId, click, pending.postedAt);
      // Built before the claim, so nothing between the claim and the guarded steps below can throw.
      const message = SlackRequestMessageSchema.parse({
        version: 1, eventId, thread: action.thread, userId: action.userId, text: click === "approve" ? "yes" : "cancel", receivedAt: new Date(now()).toISOString(),
      });
      if (!await dependencies.claimEvent(eventId, Math.floor(now() / 1_000) + EVENT_RETENTION_SECONDS)) {
        log("interaction.ignored", { reason: "duplicate_click" });
        await answer(action.responseUrl, ALREADY_RECEIVED);
        return;
      }
      // From here on every step is guarded: any failure releases the claim, so the member can press
      // again rather than hit a silent duplicate, and the member is always told.
      let raised = false;
      try {
        await dependencies.changePending(subject, 1);
        raised = true;
        await dependencies.enqueue(message, createHash("sha256").update(subject).digest("hex"));
      } catch (error) {
        log("interaction.enqueue_failed", { eventId, errorName: errorName(error) });
        if (raised) {
          try {
            await dependencies.changePending(subject, -1);
          } catch (decrementError) {
            log("interaction.decrement_failed", { eventId, errorName: errorName(decrementError) });
          }
        }
        try {
          await dependencies.releaseEvent(eventId);
        } catch (releaseError) {
          log("interaction.release_failed", { eventId, errorName: errorName(releaseError) });
        }
        await answer(action.responseUrl, RETRY_CLICK);
        return;
      }
      log("interaction.accepted", { eventId, click });
      const note = click === "approve" ? `Approved by <@${action.userId}>. Running it now.` : `Cancelled by <@${action.userId}>.`;
      try {
        await dependencies.updateMessage({ channel: action.thread.channelId, ts: action.messageTs, text: `${action.messageText}\n${note}`, blocks: answeredConfirmationBlocks(action.messageText, note) });
      } catch (error) {
        // The click is queued; a message that keeps its buttons only lets a second click hear "Already received".
        log("interaction.update_failed", { errorName: errorName(error) });
      }
    },
  };
}

/** A Slack Web API call, bounded so it never outlasts Slack's 3-second wait for this request. */
export async function slackApi(token: string, method: string, body: unknown, fetchImplementation: typeof fetch = fetch): Promise<void> {
  const response = await fetchImplementation(`https://slack.com/api/${method}`, {
    method: "POST",
    signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MILLISECONDS),
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const result = asRecord(await response.json());
  if (!response.ok || result.ok !== true) throw new Error(`Slack ${method} failed: ${typeof result.error === "string" ? result.error : `HTTP ${response.status}`}`);
}

/** Slack's response_url answer, shown only to the member who pressed the button. */
export async function respondEphemeral(responseUrl: string, text: string, fetchImplementation: typeof fetch = fetch): Promise<void> {
  const response = await fetchImplementation(responseUrl, {
    method: "POST",
    signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MILLISECONDS),
    redirect: "error",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
  });
  if (!response.ok) throw new Error(`Slack response_url failed: HTTP ${response.status}`);
}

/** The interactivity handler for the ingress Lambda, from the same environment the ingress reads. */
export function createAwsSlackInteractivityHandler() {
  const clientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfiguration), { marshallOptions: { removeUndefinedValues: true } });
  const sqs = new SQSClient(clientConfiguration);
  const secretsManager = new SecretsManagerClient(clientConfiguration);
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
      loading.catch(() => { cached = undefined; });
    }
    return cached.secrets;
  };
  const log: SlackIngressLog = (event, fields) => console.log(JSON.stringify({ component: "slack-interactivity", event, ...fields }));
  return createSlackInteractivityHandler({
    secrets,
    log,
    // The module's own respondEphemeral, for a button no handler knows.
    respondEphemeral,
    handlers: [confirmationActionHandler({
      async loadConfirmation(subject) {
        const response = await documentClient.send(new GetCommand({ TableName: threadsTableName, Key: confirmationKey(subject), ConsistentRead: true }));
        return pendingConfirmationFromItem(response.Item);
      },
      async claimEvent(eventId, expiresAtSeconds) {
        try {
          await documentClient.send(new PutCommand({ TableName: threadsTableName, Item: { pk: `EVENT#${eventId}`, sk: "META", expiresAt: expiresAtSeconds }, ConditionExpression: "attribute_not_exists(pk)" }));
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
          TableName: threadsTableName, Key: { pk: `THREAD#${threadSubject}`, sk: "META" },
          UpdateExpression: "ADD pendingRequests :delta", ExpressionAttributeValues: { ":delta": delta }, ReturnValues: "UPDATED_NEW",
        }));
        return Number(response.Attributes?.pendingRequests ?? 0);
      },
      async enqueue(message, messageGroupId) {
        await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message), MessageGroupId: messageGroupId, MessageDeduplicationId: message.eventId }));
      },
      async updateMessage(input) {
        await slackApi((await secrets()).botToken, "chat.update", input);
      },
      respondEphemeral: (responseUrl, text) => respondEphemeral(responseUrl, text),
      log,
    })],
  });
}
