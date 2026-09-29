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
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  CLOSED_SHARED_NOTICE,
  SharedTaskRecordSchema,
  SlackChannelBindingSchema,
  SlackChannelIdSchema,
  SlackMessageTimestampSchema,
  SlackRequestMessageSchema,
  SlackTeamIdSchema,
  SlackUserIdSchema,
  VIEW_ONLY_NOTICE,
  isStopCommand,
  parseConfirmationReply,
  queuedBehindAttributes,
  sharedNoticeClaim,
  sharedTaskKey,
  slackRequestText,
  slackThreadSubject,
  type SlackChannelBinding,
  type SlackRequestMessage,
  type SlackThread,
} from "@agentx/contracts";
import { requiredEnvironment, type HttpApiV2Event } from "./lambda.js";
import { createSlackMemberCheck, type SlackMemberCheck } from "./slack-members.js";
import { createAwsSlackInteractivityHandler } from "./slack-interactivity.js";

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
  /** `queuedBehind` is how many earlier requests in the thread this one waits behind (spec 014 FR-026). */
  enqueue: (message: SlackRequestMessage, messageGroupId: string, queuedBehind: number) => Promise<void>;
  postMessage: (input: { channel: string; threadTs: string; text: string }) => Promise<void>;
  /**
   * The stop command (#126): cancels the thread's running task, which the thread's queued messages
   * would otherwise wait behind. Absent: "stop" is an ordinary request.
   */
  stopTask?: (thread: SlackThread, userId: string) => Promise<"CANCEL_REQUESTED" | "NOTHING_RUNNING">;
  /**
   * Spec 025 FR-035: shared task threads. Absent (the legacy deployment): every thread is ordinary.
   * `lookup` gives the thread's mode, or undefined for an ordinary thread, and throws when it cannot
   * tell. `claimNotice` answers true for at most one caller per thread per hour.
   */
  sharedTask?: {
    lookup: (thread: SlackThread) => Promise<{ mode: "view" | "continue"; closed: boolean } | undefined>;
    claimNotice: (threadSubject: string, nowSeconds: number, kind: "view" | "closed") => Promise<boolean>;
  };
  now?: () => number;
  log?: SlackIngressLog;
  /**
   * Messages a person posts through an app with their own token (spec 014 US2). They carry bot_id or
   * app_id and are accepted only when `accept` is true and Slack confirms `user` is a person.
   * Absent: every app-posted message is ignored, as before feature 014.
   */
  appPosted?: { accept: boolean; checkMember: (userId: string) => Promise<SlackMemberCheck> };
  /**
   * Per-thread brake (spec 014 FR-011). Absent: no limit. `countTurn` must increment atomically and
   * return the new count; the single pause notice relies on exactly one caller seeing perMinute + 1.
   * `releaseTurn` must decrement the same counter atomically; it undoes a `countTurn` whose event was
   * then released because enqueueing failed, so a Slack retry of that event is not double-counted.
   */
  turnLimit?: {
    perMinute: number;
    countTurn: (threadSubject: string, windowStartSeconds: number, expiresAtSeconds: number) => Promise<number>;
    releaseTurn: (threadSubject: string, windowStartSeconds: number) => Promise<void>;
  };
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
  /** The event carries bot_id, app_id or bot_profile: a person's own token through an app, or a bot. */
  appPosted: boolean;
}

const TURN_WINDOW_SECONDS = 60;
// A window's counter outlives the window by one more, so a late event still finds it.
const TURN_COUNTER_TTL_SECONDS = 2 * TURN_WINDOW_SECONDS;

const UNVERIFIED_MEMBER_NOTICE = "I couldn't confirm that this message came from a person, so I didn't act on it. Try again, or type the request in Slack.";

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
    if (mention.appPosted && !dependencies.appPosted) return ignore(log, "bot_or_edited_message");
    if (mention.appPosted && !dependencies.appPosted?.accept) return ignore(log, "app_posted_disabled");
    const { thread } = mention;
    const binding = await dependencies.getBinding(thread.teamId, thread.channelId);
    if (!binding) return ignore(log, "channel_not_bound", { channelId: thread.channelId });
    let memberCheckError: string | undefined;
    if (mention.appPosted && dependencies.appPosted) {
      let member: SlackMemberCheck;
      try {
        member = await dependencies.appPosted.checkMember(mention.userId);
      } catch {
        // A check that throws is a check that failed: fail closed, and never log the error text.
        member = { outcome: "failed", error: "check_threw" };
      }
      if (member.outcome === "not_person") return ignore(log, "not_a_person");
      if (member.outcome === "failed") memberCheckError = member.error;
    }
    const nowSeconds = Math.floor(now() / 1_000);
    if (!await dependencies.claimEvent(mention.eventId, nowSeconds + EVENT_RETENTION_SECONDS)) {
      return ignore(log, "duplicate_event", { eventId: mention.eventId });
    }
    const subject = slackThreadSubject(thread);
    // FR-035, C10: a view-only or closed shared thread gets one fixed notice an hour. Nothing is
    // queued or counted, so no thread workspace is ever made for it. A continue thread goes on as
    // any thread does. A record that cannot be read fails closed: Slack retries the event.
    if (dependencies.sharedTask) {
      let shared: { mode: "view" | "continue"; closed: boolean } | undefined;
      try {
        shared = await dependencies.sharedTask.lookup(thread);
      } catch (error) {
        await releaseQuietly(dependencies, log, mention.eventId, "shared_task.release_failed");
        log("shared_task.lookup_failed", { eventId: mention.eventId, errorName: errorName(error) });
        return respond(500, { error: "shared thread could not be checked" });
      }
      if (shared !== undefined && (shared.mode === "view" || shared.closed)) {
        let notify = false;
        try {
          notify = await dependencies.sharedTask.claimNotice(subject, nowSeconds, shared.closed ? "closed" : "view");
        } catch (error) {
          log("shared_task.notice_claim_failed", { eventId: mention.eventId, errorName: errorName(error) });
        }
        log("shared_task.not_run", { eventId: mention.eventId, closed: shared.closed, notified: notify });
        if (notify) await post(dependencies, log, thread, shared.closed ? CLOSED_SHARED_NOTICE : VIEW_ONLY_NOTICE, "shared_task.notice_failed");
        return respond(200, { ok: true });
      }
    }
    // Set only when a turn was actually counted, so the enqueue-failure path knows whether (and at
    // which window) to undo it.
    let countedWindowStart: number | undefined;
    if (dependencies.turnLimit) {
      const { perMinute, countTurn } = dependencies.turnLimit;
      const windowStart = nowSeconds - (nowSeconds % TURN_WINDOW_SECONDS);
      let turns: number;
      try {
        turns = await countTurn(subject, windowStart, windowStart + TURN_COUNTER_TTL_SECONDS);
      } catch {
        await releaseQuietly(dependencies, log, mention.eventId, "turn_limit.release_failed");
        log("turn_limit.failed", { eventId: mention.eventId });
        return respond(500, { error: "request could not be counted" });
      }
      countedWindowStart = windowStart;
      if (turns > perMinute) {
        log("thread.paused", { eventId: mention.eventId, turnsThisMinute: turns });
        if (turns === perMinute + 1) {
          await post(dependencies, log, thread, `I'm pausing this thread: it sent me more than ${perMinute} requests in a minute. Mention me again in a minute to continue. Anything waiting for your confirmation is still waiting; confirm again after a minute.`, "thread_paused.notice_failed");
        }
        return respond(200, { ok: true });
      }
    }
    if (memberCheckError !== undefined) {
      // Fail closed: an unconfirmed sender is never run, but the person is told rather than left in silence.
      log("event.ignored", { reason: "member_check_failed", slackError: memberCheckError });
      await post(dependencies, log, thread, UNVERIFIED_MEMBER_NOTICE, "member_check.notice_failed");
      return respond(200, { ok: true });
    }

    const text = slackRequestText(mention.text, mention.botUserId);
    if (!text) {
      await post(dependencies, log, thread, "Please include a request after mentioning AgentX.");
      log("mention.empty", { eventId: mention.eventId });
      return respond(200, { ok: true });
    }
    if (dependencies.stopTask && isStopCommand(text)) {
      let outcome: "CANCEL_REQUESTED" | "NOTHING_RUNNING";
      try {
        outcome = await dependencies.stopTask(thread, mention.userId);
      } catch {
        log("stop.failed", { eventId: mention.eventId });
        await post(dependencies, log, thread, "I couldn't stop the running task. Try again in a moment.", "stop.notice_failed");
        return respond(200, { ok: true });
      }
      log("stop.requested", { eventId: mention.eventId, outcome });
      if (outcome === "CANCEL_REQUESTED") {
        await post(dependencies, log, thread, "Stopping the running task. I'll reply here once it has stopped.", "stop.notice_failed");
        return respond(200, { ok: true });
      }
      // Nothing is running: the request goes to the orchestrator like any other.
    }
    const message = SlackRequestMessageSchema.parse({
      version: 1,
      eventId: mention.eventId,
      thread,
      userId: mention.userId,
      text,
      receivedAt: new Date(now()).toISOString(),
    });
    const pending = await dependencies.changePending(subject, 1);
    const ahead = pending - 1;
    try {
      await dependencies.enqueue(message, createHash("sha256").update(subject).digest("hex"), Math.max(ahead, 0));
    } catch {
      // Undo all records so Slack's retry of this event is processed as new.
      await dependencies.changePending(subject, -1);
      if (dependencies.turnLimit && countedWindowStart !== undefined) {
        try {
          await dependencies.turnLimit.releaseTurn(subject, countedWindowStart);
        } catch (error) {
          // A missed decrement only means a retried event's turn is briefly over-counted; log it,
          // do not throw, and still release the claim so Slack's retry is processed as new.
          log("turn_limit.decrement_failed", { eventId: mention.eventId, errorName: errorName(error) });
        }
      }
      await releaseQuietly(dependencies, log, mention.eventId, "enqueue.release_failed");
      log("mention.enqueue_failed", { eventId: mention.eventId });
      return respond(500, { error: "request could not be queued" });
    }
    log("mention.accepted", { eventId: mention.eventId, pendingInThread: pending });
    // A message that is only a confirmation answer is answered by the confirmation itself (or the
    // turn it runs), so "Got it" would be noise. Waiting behind earlier requests is still said.
    if (ahead > 0) {
      await post(dependencies, log, thread, `Got it. This is queued behind ${ahead} earlier request${ahead === 1 ? "" : "s"} in this thread.`);
    } else if (parseConfirmationReply(text) === undefined) {
      await post(dependencies, log, thread, "Got it. I'm on it and will reply in this thread.");
    }
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
  if (event.subtype !== undefined) return { reason: "bot_or_edited_message" };
  const botUserId = Array.isArray(payload.authorizations)
    ? asRecord(payload.authorizations[0]).user_id
    : undefined;
  // AgentX's own bot user under any of the event's authorizations, and AgentX's app named in either app field.
  // Only a bot authorization (is_bot === true) counts: a user-token installation's authorization can
  // name a person, and that person's own typed mention must not be dropped as AgentX's own message.
  const ownBotUsers = new Set(
    (Array.isArray(payload.authorizations) ? payload.authorizations : [])
      .filter((authorization) => asRecord(authorization).is_bot === true)
      .map((authorization) => asRecord(authorization).user_id)
      .filter((userId): userId is string => typeof userId === "string" && userId.length > 0),
  );
  const ownBotUser = typeof event.user === "string" && ownBotUsers.has(event.user);
  const ownApp = typeof payload.api_app_id === "string"
    && (event.app_id === payload.api_app_id || asRecord(event.bot_profile).app_id === payload.api_app_id);
  if (ownBotUser || ownApp) return { reason: "own_message" };
  if (typeof event.user !== "string" || event.user.length === 0) return { reason: "no_user" };
  const teamId = SlackTeamIdSchema.safeParse(payload.team_id);
  const channelId = SlackChannelIdSchema.safeParse(event.channel);
  const userId = SlackUserIdSchema.safeParse(event.user);
  const ts = SlackMessageTimestampSchema.safeParse(event.thread_ts ?? event.ts);
  if (!teamId.success || !userId.success || !ts.success) return { reason: "malformed_event" };
  if (!channelId.success) return { reason: "not_a_channel" };
  const userTeam = event.user_team ?? event.team;
  if (userTeam !== undefined && userTeam !== teamId.data) return { reason: "external_organization_user" };
  if (typeof payload.event_id !== "string" || typeof event.text !== "string") return { reason: "malformed_event" };
  return {
    eventId: payload.event_id,
    thread: { teamId: teamId.data, channelId: channelId.data, threadTs: ts.data },
    userId: userId.data,
    text: event.text,
    ...(typeof botUserId === "string" ? { botUserId } : {}),
    // Any app field present, even null, marks the event as app-posted so it gets the member check.
    appPosted: "bot_id" in event || "app_id" in event || "bot_profile" in event,
  };
}

async function post(
  dependencies: SlackIngressDependencies,
  log: SlackIngressLog,
  thread: SlackThread,
  text: string,
  failureEvent = "acknowledgement.failed",
) {
  try {
    await dependencies.postMessage({ channel: thread.channelId, threadTs: thread.threadTs, text });
  } catch (error) {
    // The event is already claimed and handled; a failed thread post must not make Slack retry it.
    log(failureEvent, { errorName: errorName(error) });
  }
}

/**
 * Releases a claimed event, logging rather than throwing if that itself fails. The caller has
 * already decided to answer 500 (so Slack retries); a release failure must not change that
 * decision or crash the handler, only leave the claim in place until it expires (M2).
 */
async function releaseQuietly(
  dependencies: SlackIngressDependencies,
  log: SlackIngressLog,
  eventId: string,
  failureEvent: string,
): Promise<void> {
  try {
    await dependencies.releaseEvent(eventId);
  } catch (error) {
    log(failureEvent, { eventId, errorName: errorName(error) });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
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

export interface SlackIngressSettings {
  acceptAppPosted: boolean;
  turnsPerMinute: number;
}

/** Reads the deployment's Slack ingress switches (spec 014 FR-011, FR-012); a bad value stops the cold start. */
export function slackIngressSettings(environment: Readonly<Record<string, string | undefined>>): SlackIngressSettings {
  const appPosted = environment.SLACK_APP_POSTED_MESSAGES ?? "accept";
  if (appPosted !== "accept" && appPosted !== "ignore") {
    throw new Error("SLACK_APP_POSTED_MESSAGES must be accept or ignore");
  }
  const turns = environment.SLACK_THREAD_TURNS_PER_MINUTE ?? "6";
  if (!/^\d{1,2}$/u.test(turns) || Number(turns) < 1 || Number(turns) > 60) {
    throw new Error("SLACK_THREAD_TURNS_PER_MINUTE must be a whole number from 1 to 60");
  }
  return { acceptAppPosted: appPosted === "accept", turnsPerMinute: Number(turns) };
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
  const lambda = new LambdaClient(clientConfiguration);
  const stateTableName = requiredEnvironment("STATE_TABLE_NAME");
  const threadsTableName = requiredEnvironment("SLACK_THREADS_TABLE_NAME");
  const queueUrl = requiredEnvironment("SLACK_REQUEST_QUEUE_URL");
  const secretArn = requiredEnvironment("SLACK_SECRET_ARN");
  const brokerFunctionName = process.env.BROKER_FUNCTION_NAME;
  const settings = slackIngressSettings(process.env);
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
  const checkMember = createSlackMemberCheck({ token: async () => (await secrets()).botToken });
  return createSlackIngressHandler({
    secrets,
    appPosted: { accept: settings.acceptAppPosted, checkMember },
    turnLimit: {
      perMinute: settings.turnsPerMinute,
      async countTurn(threadSubject, windowStartSeconds, expiresAtSeconds) {
        const response = await documentClient.send(new UpdateCommand({
          TableName: threadsTableName,
          Key: { pk: `THREAD#${threadSubject}`, sk: `TURNS#${windowStartSeconds}` },
          UpdateExpression: "ADD turns :one SET expiresAt = :expiresAt",
          ExpressionAttributeValues: { ":one": 1, ":expiresAt": expiresAtSeconds },
          ReturnValues: "UPDATED_NEW",
        }));
        // A missing count fails closed: the handler answers 500 and Slack retries.
        const turns = Number(response.Attributes?.turns);
        if (!Number.isFinite(turns)) throw new Error("turn counter returned no count");
        return turns;
      },
      async releaseTurn(threadSubject, windowStartSeconds) {
        // Undoes a countTurn whose event was then released because enqueueing failed (M3). Does not
        // touch expiresAt: the row already has one from the countTurn that this undoes.
        await documentClient.send(new UpdateCommand({
          TableName: threadsTableName,
          Key: { pk: `THREAD#${threadSubject}`, sk: `TURNS#${windowStartSeconds}` },
          UpdateExpression: "ADD turns :minusOne",
          ExpressionAttributeValues: { ":minusOne": -1 },
        }));
      },
    },
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
    async enqueue(message, messageGroupId, queuedBehind) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: message.eventId,
        MessageAttributes: queuedBehindAttributes(queuedBehind),
      }));
    },
    async postMessage(input) {
      await postSlackMessage((await secrets()).botToken, input);
    },
    ...(process.env.SHARED_TASKS === "enabled" ? {
      sharedTask: {
        async lookup(thread: SlackThread) {
          const response = await documentClient.send(new GetCommand({ TableName: stateTableName, Key: sharedTaskKey(thread), ConsistentRead: true }));
          if (response.Item === undefined) return undefined;
          // An unreadable record throws, and the handler fails closed.
          const record = SharedTaskRecordSchema.parse(response.Item);
          return { mode: record.mode, closed: record.closedAt !== undefined };
        },
        async claimNotice(threadSubject: string, nowSeconds: number, kind: "view" | "closed") {
          try {
            // The same claim the Slack service sends (F13), so one notice an hour holds across both.
            await documentClient.send(new UpdateCommand({ TableName: threadsTableName, ...sharedNoticeClaim(threadSubject, nowSeconds, kind) }));
            return true;
          } catch (error) {
            if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
            throw error;
          }
        },
      },
    } : {}),
    ...(brokerFunctionName === undefined ? {} : {
      // The broker holds the state table and callback key; this Lambda gets neither (#126).
      async stopTask(thread: SlackThread, userId: string) {
        const response = await lambda.send(new InvokeCommand({
          FunctionName: brokerFunctionName,
          InvocationType: "RequestResponse",
          Payload: Buffer.from(JSON.stringify({ source: "agentx.slack-ingress", action: "stop-task", thread, userId })),
        }));
        if (response.FunctionError !== undefined || response.Payload === undefined) throw new Error("broker stop failed");
        const reply = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as { statusCode?: number; body?: string };
        const body = JSON.parse(reply.body ?? "{}") as { outcome?: unknown };
        if (reply.statusCode !== 200 || (body.outcome !== "CANCEL_REQUESTED" && body.outcome !== "NOTHING_RUNNING")) {
          throw new Error("broker stop failed");
        }
        return body.outcome;
      },
    }),
    log(event, fields) {
      console.log(JSON.stringify({ component: "slack-ingress", event, ...fields }));
    },
  });
}

/** Slack's interactivity request URL path (spec 014): button presses, and 14d's Details view. */
export const SLACK_INTERACTIONS_PATH = "/v1/slack/interactions";

let awsHandler: ReturnType<typeof createSlackIngressHandler> | undefined;
let awsInteractivityHandler: ReturnType<typeof createAwsSlackInteractivityHandler> | undefined;

/** The Events API and, since spec 014, Slack's interactivity request URL share this Lambda. */
export const handler = (event: HttpApiV2Event): Promise<HttpResponse> => {
  if (event.rawPath === SLACK_INTERACTIONS_PATH) {
    awsInteractivityHandler ??= createAwsSlackInteractivityHandler();
    return awsInteractivityHandler(event);
  }
  awsHandler ??= createAwsSlackIngressHandler();
  return awsHandler(event);
};
