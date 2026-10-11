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
  routeAttributes,
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
import { chatPostEphemeral, chatUpdate } from "./slack-web.js";
import {
  SlackWorkflowStartError,
  WORKFLOW_CHOICE_WAITING_NOTICE,
  answerChosenRequest,
  WorkflowChoiceWaitingError,
  createDynamoWorkflowChoiceStore,
  isHandedOffWorkflowStart,
  offerWorkflowChoice,
  parseWorkflowChoiceReply,
  parseWorkflowPathReply,
  parseWorkflowStartRequest,
  startChosenWorkflow,
  startWorkflowThroughBroker,
  workflowChoiceRefusal,
  workflowStartFailureNotice,
  workflowStartedNotice,
  type BrokerReply,
  type HandedOffWorkflowStart,
  type SlackWorkflowStartInput,
  type WorkflowChoice,
  type WorkflowChoiceOutcome,
  type WorkflowPath,
} from "./slack-workflow-choice.js";

// Moved to the shared module with gap 3; still exported here for existing callers.
export { SlackWorkflowStartError, slackWorkflowStartRequestId, startWorkflowThroughBroker } from "./slack-workflow-choice.js";

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
  postMessage: (input: { channel: string; threadTs: string; text: string; blocks?: Array<Record<string, unknown>> }) => Promise<void>;
  /**
   * The stop command (#126): cancels the thread's running task, which the thread's queued messages
   * would otherwise wait behind. Absent: "stop" is an ordinary request.
   */
  stopTask?: (thread: SlackThread, userId: string) => Promise<StopOutcome>;
  /**
   * Gap 3: starts a task in this exact thread on a named path (`quick: ...`, `full: ...`). Absent: every mention goes
   * to the chat agent's queue, as before tasks could start in Slack.
   */
  startWorkflow?: (input: SlackWorkflowStartInput) => Promise<void>;
  /** Holds any other request (a plain @AgentX request, `workflow: ...`) and asks its requester Quick or Full; it never defaults. */
  requestWorkflowChoice?: (input: { thread: SlackThread; userId: string; instructions: string; requestId: string }) => Promise<void>;
  /** Starts the request waiting in the thread on the requester's chosen path. A refused start throws SlackWorkflowStartError. */
  chooseWorkflowPath?: (input: { thread: SlackThread; userId: string; workflowPath: WorkflowPath }) => Promise<WorkflowChoiceOutcome>;
  /** Who a Quick or Full choice waiting in the thread belongs to, so their plain `quick` or `full` reply is read. */
  pendingWorkflowChoice?: (thread: SlackThread) => Promise<{ choiceId: string; userId: string; suggested?: true } | undefined>;
  /**
   * Task 21: queues a plain top-level request (no `quick:`, `full:`, `workflow…:` or `chat:`) for the Slack service to
   * route after Slack has its answer: a question goes to the chat agent, a change gets a card suggesting Quick or Full.
   * Absent: such a request asks Quick or Full here (`requestWorkflowChoice`), as before.
   */
  routeRequest?: (message: SlackRequestMessage, messageGroupId: string) => Promise<void>;
  /** Task 21: the requester's typed `answer` to a waiting choice: its request goes to the chat agent instead. Absent: `answer` is not read. */
  answerWorkflowChoice?: (input: { thread: SlackThread; userId: string }) => Promise<WorkflowChoiceOutcome>;
  /**
   * Spec 025 FR-035: shared task threads. Absent (the legacy deployment): every thread is ordinary.
   * `lookup` gives the thread's mode, or undefined for an ordinary thread, and throws when it cannot
   * tell. `claimNotice` answers true for at most one caller per thread per hour.
   */
  sharedTask?: {
    /** `workflowThread`: the thread of a task started in Slack, which its owner drives from the thread. */
    lookup: (thread: SlackThread) => Promise<{ mode: "view" | "continue"; closed: boolean; taskId?: string; workflowThread?: true } | undefined>;
    claimNotice: (threadSubject: string, nowSeconds: number, kind: "view" | "closed") => Promise<boolean>;
  };
  /**
   * Gap 2: saves any reply, mention or not and from anyone, in a Slack-started task's open thread as input for
   * the task's next step. "refused" is an expected answer (the task closed, or its note limit is reached); a
   * throw means the reply could not be saved, and Slack retries it. Absent: such replies are not read.
   */
  recordThreadNote?: (input: { taskId: string; thread: SlackThread; userId: string; messageTs: string; eventId: string; text: string }) => Promise<{ outcome: "captured" | "duplicate" | "refused" }>;
  /** A message only `user` sees in the thread (chat.postEphemeral). Absent: such acknowledgements are skipped. */
  postEphemeral?: (input: { channel: string; threadTs: string; user: string; text: string }) => Promise<void>;
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
  /** An app_mention, or (gap 2) a plain message posted in a thread. */
  kind: "mention" | "message";
  eventId: string;
  thread: SlackThread;
  userId: string;
  text: string;
  messageTs: string;
  isThreadReply: boolean;
  botUserId?: string;
  /** The event carries bot_id, app_id or bot_profile: a person's own token through an app, or a bot. */
  appPosted: boolean;
}

const TURN_WINDOW_SECONDS = 60;
// A window's counter outlives the window by one more, so a late event still finds it.
const TURN_COUNTER_TTL_SECONDS = 2 * TURN_WINDOW_SECONDS;

const UNVERIFIED_MEMBER_NOTICE = "I couldn't confirm that this message came from a person, so I didn't act on it. Try again, or type the request in Slack.";
/** Gap 2: the private acknowledgements in a Slack-started task's thread. */
const THREAD_NOTE_SAVED = "Saved. I'll include this at the next step.";
const THREAD_NOTE_NOT_SAVED = "I couldn't save this reply for the task. It may be closed, or it already has as many replies as I keep.";
const NOTHING_RUNNING_NOTICE = "Nothing is running for this task right now.";
const NOT_OWNER_STOP_NOTICE = "Only the person who started this task can stop it.";
const PATH_WITHOUT_REQUEST_NOTICE = "Add your request after it, for example `quick: fix the login typo`.";
/**
 * Said when a Slack task would start, or a path be chosen, but this ingress cannot read task threads: a task
 * started here could not be driven from its thread, so none is started.
 */
export const SLACK_TASK_THREADS_OFF_NOTICE = "AgentX can't run tasks from Slack threads here yet. Ask an AgentX admin to turn on Slack task threads.";

/** NOT_OWNER: a Slack-started task's own thread, where only the task's owner may stop it. */
export type StopOutcome = "CANCEL_REQUESTED" | "NOTHING_RUNNING" | "NOT_OWNER";

/** The stop command through the broker's `stop-task` event; any other answer throws. */
export async function stopTaskThroughBroker(invoke: (event: Record<string, unknown>) => Promise<BrokerReply>, thread: SlackThread, userId: string): Promise<StopOutcome> {
  const reply = await invoke({ source: "agentx.slack-ingress", action: "stop-task", thread, userId });
  const body = asRecord(JSON.parse(reply.body ?? "{}"));
  if (reply.statusCode !== 200 || (body.outcome !== "CANCEL_REQUESTED" && body.outcome !== "NOTHING_RUNNING" && body.outcome !== "NOT_OWNER")) {
    throw new Error("broker stop failed");
  }
  return body.outcome;
}

type SharedThreadLookup = { mode: "view" | "continue"; closed: boolean; taskId?: string; workflowThread?: true };

/**
 * Gap 2: records a reply in a Slack-started task's own open thread through the broker's `thread-note` event, with
 * `invoke` delivering the event and returning the broker's answer. A 4xx answer is an expected refusal; a 5xx
 * answer, or an answer that cannot be read, throws so Slack retries the reply.
 */
export async function recordThreadNoteThroughBroker(
  invoke: (event: Record<string, unknown>) => Promise<BrokerReply>,
  input: { taskId: string; thread: SlackThread; userId: string; messageTs: string; eventId: string; text: string },
): Promise<{ outcome: "captured" | "duplicate" | "refused" }> {
  const reply = await invoke({ source: "agentx.slack-ingress", action: "thread-note", ...input });
  const status = reply.statusCode ?? 500;
  if (status >= 400 && status < 500) return { outcome: "refused" };
  if (status !== 200) throw new Error("broker thread note failed");
  const body = asRecord(JSON.parse(reply.body ?? "{}"));
  if (body.outcome !== "captured" && body.outcome !== "duplicate" && body.outcome !== "refused") throw new Error("broker thread note failed");
  return { outcome: body.outcome };
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
    if (mention.appPosted && !dependencies.appPosted) return ignore(log, "bot_or_edited_message");
    if (mention.appPosted && !dependencies.appPosted?.accept) return ignore(log, "app_posted_disabled");
    const { thread } = mention;
    const binding = await dependencies.getBinding(thread.teamId, thread.channelId);
    if (!binding) return ignore(log, "channel_not_bound", { channelId: thread.channelId });
    // Gap 2: a plain message is read only in a Slack-started task's own open thread. Every other channel
    // message is left alone before it is claimed, checked or stored.
    let shared: SharedThreadLookup | undefined;
    let sharedLooked = false;
    // Gap 3: the requester's plain `quick` or `full` in a thread waiting for their choice is read too.
    let choiceAnswer = false;
    if (mention.kind === "message") {
      try {
        choiceAnswer = await isChoiceAnswer(dependencies, mention);
      } catch (error) {
        // Nothing was claimed yet: Slack's retry is handled as new.
        log("workflow.choice_lookup_failed", { eventId: mention.eventId, errorName: errorName(error) });
        return respond(500, { error: "thread could not be checked" });
      }
    }
    if (mention.kind === "message" && !choiceAnswer) {
      if (dependencies.sharedTask === undefined || dependencies.recordThreadNote === undefined) return ignore(log, "not_task_thread");
      try {
        shared = await dependencies.sharedTask.lookup(thread);
      } catch (error) {
        // Nothing was claimed yet: Slack's retry is handled as new.
        log("shared_task.lookup_failed", { eventId: mention.eventId, errorName: errorName(error) });
        return respond(500, { error: "shared thread could not be checked" });
      }
      if (shared?.workflowThread !== true || shared.closed) return ignore(log, "not_task_thread");
      sharedLooked = true;
    }
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
      if (!sharedLooked) {
        try {
          shared = await dependencies.sharedTask.lookup(thread);
        } catch (error) {
          await releaseQuietly(dependencies, log, mention.eventId, "shared_task.release_failed");
          log("shared_task.lookup_failed", { eventId: mention.eventId, errorName: errorName(error) });
          return respond(500, { error: "shared thread could not be checked" });
        }
      }
      const replyText = slackRequestText(mention.text, mention.botUserId);
      // A task started in Slack is driven from its own thread: a stop goes to the broker, which stops
      // only for the task's owner, and every other reply is saved as input for the task's next step.
      // Nothing said in the thread is ever queued as an ordinary request.
      if (shared?.workflowThread === true && !shared.closed && shared.taskId !== undefined) {
        return workflowThreadReply(dependencies, log, mention, shared.taskId, replyText, memberCheckError);
      }
      // A closed thread gets the closed notice whoever started it; the view-only notice is never
      // posted in the thread of a task started in Slack.
      if (shared !== undefined && (shared.closed || (shared.mode === "view" && shared.workflowThread !== true))) {
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
      if (shared?.workflowThread === true) {
        // Never an ordinary coding request: the task moves on only through its owner's buttons.
        log("workflow_thread.reply_not_run", { eventId: mention.eventId });
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
      let outcome: StopOutcome;
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
      if (outcome === "NOT_OWNER") {
        await ephemeral(dependencies, log, thread, mention.userId, NOT_OWNER_STOP_NOTICE);
        return respond(200, { ok: true });
      }
      // Nothing is running: the request goes to the orchestrator like any other.
    }
    // Gap 3: in a thread with a Quick or Full question waiting, a loose `quick` or `full` answers it (Task 21: and
    // `answer` sends it to the chat agent). Anywhere else (an ordinary chat thread) such a reply is the chat agent's.
    const pathAnswer = mention.isThreadReply ? choiceReply(dependencies, text) : undefined;
    if (pathAnswer !== undefined && dependencies.chooseWorkflowPath && dependencies.pendingWorkflowChoice) {
      // A plain message got here only as its requester's answer to a waiting choice (checked before the claim).
      let waiting = mention.kind === "message";
      if (!waiting) {
        try {
          waiting = answers(pathAnswer, await dependencies.pendingWorkflowChoice(thread));
        } catch (error) {
          await releaseQuietly(dependencies, log, mention.eventId, "workflow.choice_release_failed");
          log("workflow.choice_lookup_failed", { eventId: mention.eventId, errorName: errorName(error) });
          return respond(500, { error: "thread could not be checked" });
        }
      }
      if (waiting) return chooseFromThread(dependencies, log, mention, pathAnswer);
    }
    let chatText = text;
    if (dependencies.startWorkflow) {
      const request = parseWorkflowStartRequest(text);
      // A plain request in a thread stays with the chat agent (an existing chat thread); only a prefixed one starts a
      // task there. A prefix always changes the text, so unchanged instructions mean no prefix. A stop that found
      // nothing running is the chat agent's too.
      const plainThreadRequest = mention.isThreadReply && request.kind === "start" && request.instructions === text.trim();
      if (request.kind === "chat") {
        chatText = request.text;
      } else if (!plainThreadRequest && !isStopCommand(text)) {
        // Task 21: a plain top-level request (no prefix: the instructions are the whole text) is routed by the Slack
        // service, after Slack has its answer; `workflow:` still asks Quick or Full here.
        const routed = dependencies.routeRequest !== undefined && !mention.isThreadReply && request.path === undefined && request.instructions === text.trim();
        return startFromMention(dependencies, log, mention, request,
          routed ? () => queueRequest(dependencies, log, mention, request.instructions, countedWindowStart, now, true) : undefined);
      }
    }
    if (!chatText) {
      await post(dependencies, log, thread, "Please include a request after mentioning AgentX.");
      log("mention.empty", { eventId: mention.eventId });
      return respond(200, { ok: true });
    }
    return queueRequest(dependencies, log, mention, chatText, countedWindowStart, now, false);
  };
}

/**
 * Queues a claimed request for the Slack service, in its thread's order: for the chat agent, or (`routed`, Task 21) for
 * the service to route first. A queue that failed undoes every record of the event and answers 500, so Slack retries it.
 */
async function queueRequest(
  dependencies: SlackIngressDependencies,
  log: SlackIngressLog,
  mention: Mention,
  text: string,
  countedWindowStart: number | undefined,
  now: () => number,
  routed: boolean,
): Promise<HttpResponse> {
  const { thread } = mention;
  const subject = slackThreadSubject(thread);
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
  const groupId = createHash("sha256").update(subject).digest("hex");
  try {
    await (routed ? dependencies.routeRequest!(message, groupId) : dependencies.enqueue(message, groupId, Math.max(ahead, 0)));
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
  log("mention.accepted", { eventId: mention.eventId, pendingInThread: pending, ...(routed ? { routed: true } : {}) });
  // A routed request is answered by its card or its chat reply within seconds, so "Got it" would be noise.
  if (routed) return respond(200, { ok: true });
  // A message that is only a confirmation answer is answered by the confirmation itself (or the
  // turn it runs), so "Got it" would be noise. Waiting behind earlier requests is still said.
  if (ahead > 0) {
    await post(dependencies, log, thread, `Got it. This is queued behind ${ahead} earlier request${ahead === 1 ? "" : "s"} in this thread.`);
  } else if (parseConfirmationReply(text) === undefined) {
    await post(dependencies, log, thread, "Got it. I'm on it and will reply in this thread.");
  }
  return respond(200, { ok: true });
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

/**
 * Gap 2: a claimed reply in a Slack-started task's own open thread. An @AgentX stop goes to the broker; any other
 * reply with text is saved as input for the task's next step. Expected refusals answer 200, so Slack never
 * retries them; only a save that could not be attempted answers 500, with the claim released.
 */
async function workflowThreadReply(
  dependencies: SlackIngressDependencies,
  log: SlackIngressLog,
  mention: Mention,
  taskId: string,
  replyText: string,
  memberCheckError: string | undefined,
): Promise<HttpResponse> {
  const { thread, eventId } = mention;
  if (memberCheckError !== undefined) {
    // Fail closed: a sender Slack could not confirm as a person adds nothing to the task.
    log("event.ignored", { reason: "member_check_failed", slackError: memberCheckError });
    return respond(200, { ok: true });
  }
  if (isStopCommand(replyText)) {
    if (mention.kind === "mention" && dependencies.stopTask) {
      let outcome: StopOutcome;
      try {
        outcome = await dependencies.stopTask(thread, mention.userId);
      } catch {
        log("stop.failed", { eventId });
        await post(dependencies, log, thread, "I couldn't stop the running task. Try again in a moment.", "stop.notice_failed");
        return respond(200, { ok: true });
      }
      log("stop.requested", { eventId, outcome });
      if (outcome === "CANCEL_REQUESTED") {
        await post(dependencies, log, thread, "Stopping the running task. I'll reply here once it has stopped.", "stop.notice_failed");
      } else {
        await ephemeral(dependencies, log, thread, mention.userId, outcome === "NOT_OWNER" ? NOT_OWNER_STOP_NOTICE : NOTHING_RUNNING_NOTICE);
      }
      return respond(200, { ok: true });
    }
    // Slack also delivers an @AgentX stop as a plain message; its app_mention copy is the one that stops.
    if (mention.kind === "message" && mention.botUserId !== undefined && mention.text.includes(`<@${mention.botUserId}>`)) {
      return ignore(log, "stop_mention_copy", { eventId });
    }
  }
  if (replyText.length === 0) return ignore(log, "empty_thread_reply", { eventId });
  if (dependencies.recordThreadNote === undefined) {
    // Never an ordinary coding request: the task moves on only through its owner's buttons.
    log("workflow_thread.reply_not_run", { eventId });
    return respond(200, { ok: true });
  }
  let outcome: "captured" | "duplicate" | "refused";
  try {
    ({ outcome } = await dependencies.recordThreadNote({ taskId, thread, userId: mention.userId, messageTs: mention.messageTs, eventId, text: replyText }));
  } catch (error) {
    await releaseQuietly(dependencies, log, eventId, "thread_note.release_failed");
    log("thread_note.failed", { eventId, errorName: errorName(error) });
    return respond(500, { error: "reply could not be saved" });
  }
  // Never the reply's text.
  log("thread_note.recorded", { eventId, taskId, outcome, kind: mention.kind });
  // Only a mention asked AgentX something, so only a mention is answered, and only its sender sees it. A
  // duplicate here is the plain-message copy of this same mention, saved first.
  if (mention.kind === "mention") {
    await ephemeral(dependencies, log, thread, mention.userId, outcome === "refused" ? THREAD_NOTE_NOT_SAVED : THREAD_NOTE_SAVED);
  }
  return respond(200, { ok: true });
}

/** A Slack task cannot start, or its path be chosen, where task threads cannot be read: say so, and start nothing. */
async function threadsOff(dependencies: SlackIngressDependencies, log: SlackIngressLog, thread: SlackThread, eventId: string): Promise<HttpResponse> {
  log("workflow.task_threads_off", { eventId });
  await post(dependencies, log, thread, SLACK_TASK_THREADS_OFF_NOTICE, "workflow.task_threads_off_notice_failed");
  return respond(200, { ok: true });
}

/**
 * Gap 3: whether a plain message (no mention) is its sender's Quick or Full answer in a thread waiting for their
 * choice. Checked before the event is claimed, so no other channel message is claimed or stored. The plain copy of an
 * @AgentX answer is not: its app_mention copy answers.
 */
async function isChoiceAnswer(dependencies: SlackIngressDependencies, mention: Mention): Promise<boolean> {
  if (dependencies.pendingWorkflowChoice === undefined || dependencies.chooseWorkflowPath === undefined) return false;
  if (mention.botUserId !== undefined && mention.text.includes(`<@${mention.botUserId}>`)) return false;
  if (choiceReply(dependencies, slackRequestText(mention.text, mention.botUserId)) === undefined) return false;
  const reply = choiceReply(dependencies, slackRequestText(mention.text, mention.botUserId))!;
  const pending = await dependencies.pendingWorkflowChoice(mention.thread);
  return answers(reply, pending) && pending!.userId === mention.userId;
}

/**
 * Whether `reply` answers the choice waiting in the thread. Task 21: `answer` answers only a routed card (one that
 * carries a suggestion); the plain Quick or Full question (`workflow:`) is answered by a path alone.
 */
function answers(reply: WorkflowChoice, pending: { suggested?: true } | undefined): boolean {
  return pending !== undefined && (reply !== "ANSWER" || pending.suggested === true);
}

/** A loose answer to a waiting choice: `quick` or `full`, and (Task 21) `answer` where this ingress can send it to the chat agent. */
function choiceReply(dependencies: SlackIngressDependencies, text: string): WorkflowChoice | undefined {
  const reply = parseWorkflowChoiceReply(text);
  return reply === "ANSWER" && dependencies.answerWorkflowChoice === undefined ? undefined : reply;
}

/** Gap 3: a Quick or Full answer in a thread. Only the requester's answer starts the request waiting there. */
async function chooseFromThread(dependencies: SlackIngressDependencies, log: SlackIngressLog, mention: Mention, workflowPath: WorkflowChoice): Promise<HttpResponse> {
  const { thread, eventId } = mention;
  if (dependencies.sharedTask === undefined) return threadsOff(dependencies, log, thread, eventId);
  let outcome: WorkflowChoiceOutcome;
  try {
    // Task 21: `answer` sends the waiting request to the chat agent, whose reply is the answer; nothing is posted here.
    outcome = workflowPath === "ANSWER"
      ? await dependencies.answerWorkflowChoice!({ thread, userId: mention.userId })
      : await dependencies.chooseWorkflowPath!({ thread, userId: mention.userId, workflowPath });
  } catch (error) {
    log("workflow.choice_failed", { eventId, errorName: errorName(error) });
    await post(dependencies, log, thread, startFailureNotice(error, eventId), "workflow.choice_failure_notice_failed");
    return respond(200, { ok: true });
  }
  log("workflow.choice", { eventId, outcome, ...(workflowPath === "ANSWER" ? { chosen: "ANSWER" } : {}) });
  if (outcome === "started") {
    if (workflowPath !== "ANSWER") await post(dependencies, log, thread, workflowStartedNotice(workflowPath), "workflow.start_notice_failed");
  } else {
    await ephemeral(dependencies, log, thread, mention.userId, workflowChoiceRefusal(outcome));
  }
  return respond(200, { ok: true });
}

/** Gap 3: starts a task from a mention: on the path its prefix names, or by asking Quick or Full. */
async function startFromMention(
  dependencies: SlackIngressDependencies,
  log: SlackIngressLog,
  mention: Mention,
  request: { path?: WorkflowPath; instructions: string },
  /** Task 21: queues a plain top-level request for the Slack service to route, instead of asking Quick or Full here. */
  route?: () => Promise<HttpResponse>,
): Promise<HttpResponse> {
  const { thread, eventId } = mention;
  if (dependencies.sharedTask === undefined) return threadsOff(dependencies, log, thread, eventId);
  if (!request.instructions) {
    await post(dependencies, log, thread, "Please include a request after mentioning AgentX.");
    log("mention.empty", { eventId });
    return respond(200, { ok: true });
  }
  // `@AgentX quick` alone names a path but no request: never a task called "quick".
  if (request.path === undefined && parseWorkflowPathReply(request.instructions) !== undefined) {
    await post(dependencies, log, thread, PATH_WITHOUT_REQUEST_NOTICE, "workflow.choice_notice_failed");
    log("mention.path_without_request", { eventId });
    return respond(200, { ok: true });
  }
  if (request.path === undefined && route !== undefined) return route();
  try {
    if (request.path === undefined) {
      if (dependencies.requestWorkflowChoice === undefined) {
        await post(dependencies, log, thread, "Choose Quick or Full by starting your request with `quick:` or `full:`.", "workflow.choice_notice_failed");
        return respond(200, { ok: true });
      }
      await dependencies.requestWorkflowChoice({ thread, userId: mention.userId, instructions: request.instructions, requestId: eventId });
      log("workflow.choice_offered", { eventId });
      return respond(200, { ok: true });
    }
    await dependencies.startWorkflow!({ thread, userId: mention.userId, instructions: request.instructions, workflowPath: request.path, requestId: eventId });
  } catch (error) {
    log("workflow.start_failed", { eventId, errorName: errorName(error) });
    await post(dependencies, log, thread, startFailureNotice(error, eventId), "workflow.start_failure_notice_failed");
    return respond(200, { ok: true });
  }
  await post(dependencies, log, thread, workflowStartedNotice(request.path), "workflow.start_notice_failed");
  return respond(200, { ok: true });
}

function startFailureNotice(error: unknown, eventId: string): string {
  if (error instanceof WorkflowChoiceWaitingError) return WORKFLOW_CHOICE_WAITING_NOTICE;
  return workflowStartFailureNotice(error instanceof SlackWorkflowStartError ? error.code : "UNKNOWN", eventId);
}

/** A best-effort private message: a failure is logged and never makes Slack retry the event. */
async function ephemeral(dependencies: SlackIngressDependencies, log: SlackIngressLog, thread: SlackThread, user: string, text: string): Promise<void> {
  if (dependencies.postEphemeral === undefined) return;
  try {
    await dependencies.postEphemeral({ channel: thread.channelId, threadTs: thread.threadTs, user, text });
  } catch (error) {
    log("ephemeral.failed", { errorName: errorName(error) });
  }
}

const THREAD_REPLY_SUBTYPES: ReadonlySet<string> = new Set(["thread_broadcast", "file_share"]);

function parseMention(payload: Record<string, unknown>): Mention | { reason: string } {
  const event = asRecord(payload.event);
  // Gap 2: a plain message is read only as a thread reply: posted, also sent to the channel, or posted with
  // files (only its text is read); never an edit, a deletion, or any other subtype.
  const kind = event.type === "app_mention" ? "mention" : event.type === "message" && event.thread_ts !== undefined ? "message" : undefined;
  if (kind === undefined) return { reason: "not_app_mention" };
  if (event.subtype !== undefined && !(kind === "message" && typeof event.subtype === "string" && THREAD_REPLY_SUBTYPES.has(event.subtype))) return { reason: "bot_or_edited_message" };
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
  const messageTs = SlackMessageTimestampSchema.safeParse(event.ts);
  if (!teamId.success || !userId.success || !ts.success || !messageTs.success) return { reason: "malformed_event" };
  if (!channelId.success) return { reason: "not_a_channel" };
  const userTeam = event.user_team ?? event.team;
  if (userTeam !== undefined && userTeam !== teamId.data) return { reason: "external_organization_user" };
  if (typeof payload.event_id !== "string" || typeof event.text !== "string") return { reason: "malformed_event" };
  return {
    kind,
    eventId: payload.event_id,
    thread: { teamId: teamId.data, channelId: channelId.data, threadTs: ts.data },
    userId: userId.data,
    text: event.text,
    messageTs: messageTs.data,
    isThreadReply: event.thread_ts !== undefined,
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
  input: { channel: string; threadTs: string; text: string; blocks?: Array<Record<string, unknown>> },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ ts?: string }> {
  const response = await fetchImplementation("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: input.channel, thread_ts: input.threadTs, text: input.text, ...(input.blocks === undefined ? {} : { blocks: input.blocks }), unfurl_links: false }),
  });
  const result = asRecord(await response.json());
  if (!response.ok || result.ok !== true) {
    throw new Error(`Slack chat.postMessage failed: ${typeof result.error === "string" ? result.error : `HTTP ${response.status}`}`);
  }
  return typeof result.ts === "string" ? { ts: result.ts } : {};
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

/**
 * Task 21: queues a waiting request its requester sent to the chat agent ("Just answer"), counted like any queued
 * request of its thread. It carries no queued-behind count, so the chat agent says when it starts.
 */
export function createAnswerQueue(input: {
  sqs: { send(command: SendMessageCommand): Promise<unknown> };
  queueUrl: string;
  changePending: (threadSubject: string, delta: 1 | -1) => Promise<number>;
  now?: () => number;
}): (answer: { thread: SlackThread; userId: string; text: string; eventId: string }) => Promise<void> {
  const now = input.now ?? Date.now;
  return async (answer) => {
    const message = SlackRequestMessageSchema.parse({ version: 1, eventId: answer.eventId, thread: answer.thread, userId: answer.userId,
      text: answer.text, receivedAt: new Date(now()).toISOString() });
    const subject = slackThreadSubject(answer.thread);
    await input.changePending(subject, 1);
    try {
      await input.sqs.send(new SendMessageCommand({ QueueUrl: input.queueUrl, MessageBody: JSON.stringify(message),
        MessageGroupId: createHash("sha256").update(subject).digest("hex"), MessageDeduplicationId: message.eventId }));
    } catch (error) {
      await input.changePending(subject, -1).catch(() => undefined);
      throw error;
    }
  };
}

/** The Slack threads table's count of a thread's queued requests, which the Slack service lowers as each one finishes. */
export function threadPendingCounter(documentClient: { send(command: UpdateCommand): Promise<{ Attributes?: Record<string, unknown> }> }, tableName: string) {
  return async (threadSubject: string, delta: 1 | -1): Promise<number> => {
    const response = await documentClient.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: `THREAD#${threadSubject}`, sk: "META" },
      UpdateExpression: "ADD pendingRequests :delta",
      ExpressionAttributeValues: { ":delta": delta },
      ReturnValues: "UPDATED_NEW",
    }));
    return Number(response.Attributes?.pendingRequests ?? 0);
  };
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
  /** A direct broker invoke: the broker's answer, or a throw when the broker itself failed. */
  const invokeBroker = async (event: Record<string, unknown>): Promise<BrokerReply> => {
    if (brokerFunctionName === undefined) throw new Error("the broker is not configured");
    const response = await lambda.send(new InvokeCommand({
      FunctionName: brokerFunctionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(event)),
    }));
    if (response.FunctionError !== undefined || response.Payload === undefined) throw new Error(`broker ${String(event.action)} failed`);
    return JSON.parse(Buffer.from(response.Payload).toString("utf8")) as BrokerReply;
  };
  const invokeWorkflow = async (input: SlackWorkflowStartInput) => {
    await startWorkflowThroughBroker(invokeBroker, input);
  };
  const choices = createDynamoWorkflowChoiceStore({ documentClient, tableName: threadsTableName });
  const changePending = threadPendingCounter(documentClient, threadsTableName);
  const enqueueAnswer = createAnswerQueue({ sqs, queueUrl, changePending });
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
    ...(brokerFunctionName === undefined ? {} : {
      async requestWorkflowChoice(input: { thread: SlackThread; userId: string; instructions: string; requestId: string }) {
        await offerWorkflowChoice({ store: choices, postMessage: async (message) => postSlackMessage((await secrets()).botToken, message) }, input);
      },
      // Task 19: a typed answer also takes the question's buttons away once its task started.
      async chooseWorkflowPath(input: { thread: SlackThread; userId: string; workflowPath: WorkflowPath }) {
        return startChosenWorkflow({ store: choices, startWorkflow: invokeWorkflow,
          updateQuestion: async (question) => chatUpdate((await secrets()).botToken, question) }, input);
      },
      async pendingWorkflowChoice(thread: SlackThread) {
        return choices.pending(thread);
      },
      // Task 21: the Slack service routes a plain top-level request; the queue mark (not the body) says so.
      async routeRequest(message: SlackRequestMessage, messageGroupId: string) {
        await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message), MessageGroupId: messageGroupId,
          MessageDeduplicationId: message.eventId, MessageAttributes: routeAttributes() }));
      },
      async answerWorkflowChoice(input: { thread: SlackThread; userId: string }) {
        return answerChosenRequest({ store: choices, enqueueAnswer: (answer) => enqueueAnswer(answer),
          updateQuestion: async (question) => chatUpdate((await secrets()).botToken, question) }, input);
      },
    }),
    changePending,
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
          return { mode: record.mode, closed: record.closedAt !== undefined, taskId: record.taskId,
            ...(record.workflowThread === true ? { workflowThread: true as const } : {}) };
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
        return stopTaskThroughBroker(invokeBroker, thread, userId);
      },
      async startWorkflow(input: SlackWorkflowStartInput) {
        await invokeWorkflow(input);
      },
      async recordThreadNote(input: { taskId: string; thread: SlackThread; userId: string; messageTs: string; eventId: string; text: string }) {
        return recordThreadNoteThroughBroker(invokeBroker, input);
      },
    }),
    async postEphemeral(input) {
      await chatPostEphemeral((await secrets()).botToken, input);
    },
    log(event, fields) {
      console.log(JSON.stringify({ component: "slack-ingress", event, ...fields }));
    },
  });
}

/** Slack's interactivity request URL path (spec 014): button presses, and 14d's Details view. */
export const SLACK_INTERACTIONS_PATH = "/v1/slack/interactions";

let awsHandler: ReturnType<typeof createSlackIngressHandler> | undefined;
let awsInteractivityHandler: ReturnType<typeof createAwsSlackInteractivityHandler> | undefined;

/**
 * The Events API and, since spec 014, Slack's interactivity request URL share this Lambda. Task 19: so does the
 * asynchronous start of a Quick or Full choice, which the interactivity handler hands to this same Lambda.
 */
export const handler = (event: HttpApiV2Event | HandedOffWorkflowStart): Promise<HttpResponse> => {
  if (isHandedOffWorkflowStart(event) || event.rawPath === SLACK_INTERACTIONS_PATH) {
    awsInteractivityHandler ??= createAwsSlackInteractivityHandler();
    return awsInteractivityHandler(event);
  }
  awsHandler ??= createAwsSlackIngressHandler();
  return awsHandler(event);
};
