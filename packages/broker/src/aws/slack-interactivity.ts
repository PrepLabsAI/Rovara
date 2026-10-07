import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  ADMIN_CHANGE_CANCEL_ACTION,
  ADMIN_CHANGE_CONFIRM_ACTION,
  CONFIRM_APPROVE_ACTION,
  CONFIRM_CANCEL_ACTION,
  SlackChannelIdSchema,
  SlackMessageTimestampSchema,
  SlackRequestMessageSchema,
  SlackTeamIdSchema,
  SlackThreadSchema,
  SlackUserIdSchema,
  WorkflowSnapshotSchema,
  answeredConfirmationBlocks,
  confirmationClickEventId,
  confirmationKey,
  pendingConfirmationFromItem,
  queuedBehindAttributes,
  slackThreadSubject,
  type AdminChangePressEvent,
  type PendingConfirmation,
  type SlackRequestMessage,
  type SlackThread,
} from "@agentx/contracts";
import { requiredEnvironment, type HttpApiV2Event } from "./lambda.js";
import { parseSlackSecrets, validSignature, type SlackIngressLog, type SlackSecrets } from "./slack-ingress.js";
import { detailsActionHandler, dynamoTurnDetailsReader } from "./slack-details.js";

const EVENT_RETENTION_SECONDS = 14 * 24 * 60 * 60;
/** Every Slack call made while Slack waits (3 seconds) for this request's answer gives up after this. */
const SLACK_FETCH_TIMEOUT_MILLISECONDS = 2_000;
const SECRET_CACHE_MILLISECONDS = 5 * 60 * 1_000;

/** One Block Kit button press, from a signed Slack interactivity request. */
export interface SlackBlockAction {
  actionId: string;
  value: string;
  userId: string;
  /**
   * The clicking member's own workspace (the payload's user.team_id), which differs from the thread's
   * team for a Slack Connect member from another organization. Empty when Slack sent none.
   */
  userTeamId: string;
  /** The payload's team.id: the workspace Slack says the click came through. Empty when Slack sent none. */
  workspaceTeamId: string;
  /** The payload's Enterprise Grid (enterprise.id, else team.enterprise_id). Empty outside a grid. */
  enterpriseId: string;
  /** The clicking member's own grid (user.enterprise_id). Empty when Slack sent none. */
  userEnterpriseId: string;
  /** When this request reached the endpoint (epoch ms), for handlers racing Slack's 3-second trigger window. */
  requestStartedAt: number;
  thread: SlackThread;
  /** The message that carries the button. */
  messageTs: string;
  /** The message's text, as AgentX posted it. */
  messageText: string;
  responseUrl: string;
  /** For opening a modal, such as the Details view (spec 014 phase 14d). */
  triggerId: string;
  /** Slack's stable timestamp for this specific action, used to keep retry request IDs stable. */
  actionTs?: string;
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
  /**
   * Spec 025 E14: an admin change's Confirm and Cancel buttons. Wired only in named environments
   * (D14); without it every button, these two included, keeps the thread-based parsing below.
   */
  adminChange?: {
    /** Hands the press to the broker, which decides (asynchronously); resolves once it is handed over. */
    press(input: { changeId: string; click: "confirm" | "cancel"; slackUserId: string; teamId?: string }): Promise<void>;
    /** The change's trace ID, for the log line only. */
    traceOf?(changeId: string): Promise<string | undefined>;
  };
  workflow?: {
    handleAction(action: SlackBlockAction): Promise<void>;
    handleSubmission(payload: Record<string, unknown>): Promise<void>;
  };
}

/** What an admin hears, privately, once a Confirm press is handed to the broker (spec 025 E14). */
export const ADMIN_CHANGE_RECEIVED_TEXT = "Received. AgentX is applying the change; the message above will show how it went.";
/** What an admin hears, privately, once a Cancel press is handed to the broker (spec 025 E14). */
export const ADMIN_CHANGE_CANCEL_RECEIVED_TEXT = "Received. AgentX is dropping the change.";
const ADMIN_CHANGE_PRESS_FAILED_TEXT = "I couldn't take that press. Press the button again.";
const CHANGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

const WORKFLOW_DECISION_INVOKE_TIMEOUT_MS = 1_800;

class WorkflowDecisionSubmissionError extends Error {
  constructor() { super("broker did not save the workflow decision"); this.name = "WorkflowDecisionSubmissionError"; }
}

/** Slack must not clear an approval form just because Lambda accepted an asynchronous event. */
async function invokeWorkflowDecision(
  lambda: LambdaClient,
  functionName: string,
  event: Record<string, unknown>,
): Promise<void> {
  let response;
  try {
    response = await lambda.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(event)),
    }), { abortSignal: AbortSignal.timeout(WORKFLOW_DECISION_INVOKE_TIMEOUT_MS) });
    if (response.FunctionError !== undefined || response.StatusCode !== 200 || response.Payload === undefined) {
      console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.broker_decision_failed", taskId: event.taskId, requestId: event.requestId, functionError: response.FunctionError ?? null, statusCode: response.StatusCode ?? null, hasPayload: response.Payload !== undefined }));
      throw new WorkflowDecisionSubmissionError();
    }
    const result = asRecord(JSON.parse(Buffer.from(response.Payload).toString("utf8")));
    if (typeof result.statusCode !== "number" || result.statusCode < 200 || result.statusCode >= 300) {
      console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.broker_decision_rejected", taskId: event.taskId, requestId: event.requestId, statusCode: result.statusCode ?? "invalid" }));
      throw new WorkflowDecisionSubmissionError();
    }
    console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.decision_saved", taskId: event.taskId, requestId: event.requestId, decision: event.decision }));
  } catch (error) {
    if (error instanceof WorkflowDecisionSubmissionError) throw error;
    console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.broker_decision_failed", taskId: event.taskId, requestId: event.requestId, errorName: error instanceof Error ? error.name : "unknown" }));
    throw new WorkflowDecisionSubmissionError();
  }
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
    const requestStartedAt = now();
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
    if (payload.type === "view_submission") {
      const callbackId = asRecord(payload.view).callback_id;
      if (callbackId !== "agentx_workflow_review_submission" && callbackId !== "agentx_feedback_review_changes_submission") return respond(200, { response_action: "clear" });
      if (dependencies.workflow === undefined) {
        log("workflow.submission_failed", { errorName: "WorkflowNotConfigured" });
        return respond(200, { response_action: "errors", errors: { [callbackId === "agentx_feedback_review_changes_submission" ? "feedback_note" : "workflow_feedback"]: "Workflow approvals are temporarily unavailable. Try again shortly." } });
      }
      try {
        await dependencies.workflow.handleSubmission(payload);
        return respond(200, { response_action: "clear" });
      } catch (error) {
        log("workflow.submission_failed", { errorName: errorName(error) });
        return respond(200, { response_action: "errors", errors: { [callbackId === "agentx_feedback_review_changes_submission" ? "feedback_note" : "workflow_feedback"]: "I couldn't save this decision. Close this form and try again." } });
      }
    }
    if (payload.type !== "block_actions") {
      log("interaction.ignored", { reason: "not_block_actions" });
      return respond(200, { ok: true });
    }
    // Spec 025 E14: an admin change's buttons live in a direct message (a D... channel), which the
    // thread-based parsing below refuses; they are read here, and only these two action IDs.
    const adminChange = dependencies.adminChange;
    const press = adminChange === undefined ? undefined : adminChangePress(payload);
    if (press !== undefined && adminChange !== undefined) {
      const answer = async (text: string): Promise<void> => {
        try {
          await dependencies.respondEphemeral?.(press.responseUrl, text);
        } catch (error) {
          log("interaction.respond_failed", { errorName: errorName(error) });
        }
      };
      const traceId = await adminChange.traceOf?.(press.changeId).catch(() => undefined);
      log("admin_change.press_received", { changeId: press.changeId, ...(traceId === undefined ? {} : { traceId }), click: press.click });
      try {
        await adminChange.press({ changeId: press.changeId, click: press.click, slackUserId: press.slackUserId, ...(press.teamId === undefined ? {} : { teamId: press.teamId }) });
      } catch (error) {
        log("admin_change.press_failed", { changeId: press.changeId, ...(traceId === undefined ? {} : { traceId }), errorName: errorName(error) });
        await answer(ADMIN_CHANGE_PRESS_FAILED_TEXT);
        return respond(200, { ok: true });
      }
      // The broker records the outcome and edits the message; an `unavailable` outcome leaves the
      // change pending with its buttons, so the admin can press again.
      await answer(press.click === "confirm" ? ADMIN_CHANGE_RECEIVED_TEXT : ADMIN_CHANGE_CANCEL_RECEIVED_TEXT);
      return respond(200, { ok: true });
    }
    const actions = parseBlockActions(payload, requestStartedAt);
    if ("reason" in actions) {
      log("interaction.ignored", { reason: actions.reason });
      return respond(200, { ok: true });
    }
    for (const action of actions.actions) {
      const handler = dependencies.workflow && (action.actionId === "agentx_workflow_approve" || action.actionId === "agentx_workflow_changes"
        || action.actionId === "agentx_github_feedback_approve" || action.actionId === "agentx_github_feedback_dismiss"
        || action.actionId === "agentx_feedback_review_recommended" || action.actionId === "agentx_feedback_review_changes")
        ? { matches: () => true, handle: (value: SlackBlockAction) => dependencies.workflow!.handleAction(value) }
        : dependencies.handlers.find((entry) => entry.matches(action.actionId));
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
          const workflowButton = action.actionId === "agentx_workflow_approve" || action.actionId === "agentx_workflow_changes"
            || action.actionId === "agentx_github_feedback_approve" || action.actionId === "agentx_github_feedback_dismiss"
            || action.actionId === "agentx_feedback_review_recommended" || action.actionId === "agentx_feedback_review_changes";
          const message = error instanceof WorkflowInteractionRefusal ? error.message
            : error instanceof WorkflowDecisionSubmissionError ? "I couldn't save that decision. Try again."
            : workflowButton ? "I couldn't open those plan controls. Use the latest plan message and try again."
            : CLICK_FAILED_TEXT;
          await dependencies.respondEphemeral?.(action.responseUrl, message);
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

interface AdminChangePress { changeId: string; click: "confirm" | "cancel"; slackUserId: string; teamId?: string; responseUrl: string }

/**
 * A Confirm or Cancel press on an admin change (spec 025 E14), or undefined for every other button
 * and for a press whose value is not a change ID, whose presser is unreadable, or whose response URL
 * is not Slack's. The broker checks that the presser is the change's admin.
 */
function adminChangePress(payload: Record<string, unknown>): AdminChangePress | undefined {
  const [action] = Array.isArray(payload.actions) ? payload.actions.map(asRecord) : [];
  if (action === undefined || (action.action_id !== ADMIN_CHANGE_CONFIRM_ACTION && action.action_id !== ADMIN_CHANGE_CANCEL_ACTION)) return undefined;
  const user = asRecord(payload.user);
  const userId = SlackUserIdSchema.safeParse(user.id);
  const team = SlackTeamIdSchema.safeParse(asRecord(payload.team).id ?? user.team_id);
  if (typeof action.value !== "string" || !CHANGE_ID.test(action.value) || !userId.success || !isSlackResponseUrl(payload.response_url)) return undefined;
  return {
    changeId: action.value, click: action.action_id === ADMIN_CHANGE_CONFIRM_ACTION ? "confirm" : "cancel", slackUserId: userId.data,
    ...(team.success ? { teamId: team.data } : {}), responseUrl: payload.response_url,
  };
}

const ENTERPRISE_ID = /^E[A-Z0-9]{2,31}$/;

function enterpriseIdOf(value: unknown): string {
  return typeof value === "string" && ENTERPRISE_ID.test(value) ? value : "";
}

function parseBlockActions(payload: Record<string, unknown>, requestStartedAt: number): { actions: SlackBlockAction[] } | { reason: string } {
  const user = asRecord(payload.user);
  const team = asRecord(payload.team);
  const container = asRecord(payload.container);
  const message = asRecord(payload.message);
  const teamId = SlackTeamIdSchema.safeParse(team.id ?? user.team_id);
  const workspaceTeamId = SlackTeamIdSchema.safeParse(team.id);
  const enterpriseId = enterpriseIdOf(asRecord(payload.enterprise).id ?? team.enterprise_id);
  const userEnterpriseId = enterpriseIdOf(user.enterprise_id);
  const userId = SlackUserIdSchema.safeParse(user.id);
  const userTeamId = SlackTeamIdSchema.safeParse(user.team_id);
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
      userTeamId: userTeamId.success ? userTeamId.data : "",
      workspaceTeamId: workspaceTeamId.success ? workspaceTeamId.data : "",
      enterpriseId,
      userEnterpriseId,
      requestStartedAt,
      thread,
      messageTs: messageTs.data,
      messageText: typeof message.text === "string" ? message.text : "",
      responseUrl: payload.response_url as string,
      triggerId: typeof payload.trigger_id === "string" ? payload.trigger_id : "",
      actionTs: typeof entry.action_ts === "string" ? entry.action_ts : messageTs.data,
    }] : []),
  };
}

export interface ConfirmationClickDependencies {
  loadConfirmation: (subject: string) => Promise<PendingConfirmation | undefined>;
  claimEvent: (eventId: string, expiresAtSeconds: number) => Promise<boolean>;
  releaseEvent: (eventId: string) => Promise<void>;
  changePending: (threadSubject: string, delta: 1 | -1) => Promise<number>;
  /** `queuedBehind` is how many earlier requests in the thread the click waits behind, as the message ingress sends it (spec 014 FR-026). */
  enqueue: (message: SlackRequestMessage, messageGroupId: string, queuedBehind: number) => Promise<void>;
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
        const pending = await dependencies.changePending(subject, 1);
        raised = true;
        // Counted exactly as the message ingress counts a mention: with nothing ahead, the Slack
        // service says nothing more, since the button already says "Running it now".
        await dependencies.enqueue(message, createHash("sha256").update(subject).digest("hex"), Math.max(pending - 1, 0));
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

/**
 * A Slack Web API call, bounded so it never outlasts Slack's 3-second wait for this request. A caller
 * that already spent part of that wait passes what is left as timeoutMs.
 */
export async function slackApi(
  token: string, method: string, body: unknown, fetchImplementation: typeof fetch = fetch, timeoutMs = SLACK_FETCH_TIMEOUT_MILLISECONDS,
): Promise<void> {
  const response = await fetchImplementation(`https://slack.com/api/${method}`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
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
  // Optional: only the Details button reads it, so a missing variable must not break Approve/Cancel.
  const turnRecordsTableName = process.env.TURN_RECORDS_TABLE_NAME;
  const stateTableName = process.env.STATE_TABLE_NAME;
  const brokerFunctionName = process.env.BROKER_FUNCTION_NAME;
  const lambda = new LambdaClient(clientConfiguration);
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
  if (!turnRecordsTableName) log("interaction.details_not_configured", { variable: "TURN_RECORDS_TABLE_NAME" });
  // Spec 025 E14 (C14): named environments only (D14). The legacy deployment sets no ADMIN_CHANGES,
  // so its interactivity handling, and every variable and grant it reads, is unchanged.
  const adminChange = process.env.ADMIN_CHANGES === "enabled" ? awsAdminChangePress(clientConfiguration, documentClient) : undefined;
  const workflow = stateTableName && brokerFunctionName ? workflowSlackHandlers({
    async loadTask(taskId) {
      const response = await documentClient.send(new GetCommand({ TableName: stateTableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true, ProjectionExpression: "pk, sk, slackUserId, #share, workflow", ExpressionAttributeNames: { "#share": "share" } })) as { Item?: Record<string, unknown> };
      return response.Item;
    },
    openView: async (triggerId, view) => slackApi((await secrets()).botToken, "views.open", { trigger_id: triggerId, view }),
    async submit(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName!, { source: "agentx.slack-ingress", action: "workflow-decision", ...input });
    },
    async submitFeedback(input) {
      const action = input.selection === "RECOMMENDED" ? "workflow-feedback-findings-decision" : "workflow-feedback-decision";
      await invokeWorkflowDecision(lambda, brokerFunctionName!, { source: "agentx.slack-ingress", action, ...input });
    },
  }) : undefined;
  return createSlackInteractivityHandler({
    secrets,
    log,
    ...(adminChange === undefined ? {} : { adminChange }),
    ...(workflow === undefined ? {} : { workflow }),
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
      async enqueue(message, messageGroupId, queuedBehind) {
        await sqs.send(new SendMessageCommand({
          QueueUrl: queueUrl, MessageBody: JSON.stringify(message), MessageGroupId: messageGroupId, MessageDeduplicationId: message.eventId,
          MessageAttributes: queuedBehindAttributes(queuedBehind),
        }));
      },
      async updateMessage(input) {
        await slackApi((await secrets()).botToken, "chat.update", input);
      },
      respondEphemeral: (responseUrl, text) => respondEphemeral(responseUrl, text),
      log,
    }), detailsActionHandler({
      // Spec 014 FR-024: the Details view reads one turn record's non-text fields and opens a modal.
      readDetails: turnRecordsTableName ? dynamoTurnDetailsReader(documentClient, turnRecordsTableName) : detailsNotConfigured,
      openView: async (triggerId, view, timeoutMs) => {
        const token = (await secrets()).botToken;
        await slackApi(token, "views.open", { trigger_id: triggerId, view }, fetch, timeoutMs);
      },
      respondEphemeral: (responseUrl, text) => respondEphemeral(responseUrl, text),
      log,
    })],
  });
}

interface WorkflowActionValue { taskId: string; revision: number; digest: string; decision: "APPROVE" | "REQUEST_CHANGES" }

class WorkflowInteractionRefusal extends Error {
  constructor(message: string) { super(message); this.name = "WorkflowInteractionRefusal"; }
}

function workflowActionValue(value: string): WorkflowActionValue | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.taskId !== "string" || !CHANGE_ID.test(parsed.taskId) || !Number.isInteger(parsed.revision)
      || typeof parsed.digest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.digest)
      || (parsed.decision !== "APPROVE" && parsed.decision !== "REQUEST_CHANGES")) return undefined;
    return { taskId: parsed.taskId, revision: parsed.revision as number, digest: parsed.digest, decision: parsed.decision };
  } catch { return undefined; }
}

interface FeedbackReviewActionValue {
  taskId: string; expectedRevision: number; reviewDigest: string; proposalDigest: string; bundleSetDigest: string; selection: "RECOMMENDED";
}

function feedbackReviewActionValue(value: string): FeedbackReviewActionValue | undefined {
  try {
    const parsed = asRecord(JSON.parse(value));
    if (typeof parsed.taskId !== "string" || !CHANGE_ID.test(parsed.taskId) || typeof parsed.expectedRevision !== "number" || !Number.isInteger(parsed.expectedRevision)
      || typeof parsed.reviewDigest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.reviewDigest)
      || typeof parsed.proposalDigest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.proposalDigest)
      || typeof parsed.bundleSetDigest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.bundleSetDigest)
      || parsed.selection !== "RECOMMENDED") return undefined;
    return { taskId: parsed.taskId, expectedRevision: parsed.expectedRevision, reviewDigest: parsed.reviewDigest, proposalDigest: parsed.proposalDigest, bundleSetDigest: parsed.bundleSetDigest, selection: "RECOMMENDED" };
  } catch { return undefined; }
}

function slackActionRequestId(action: SlackBlockAction): string {
  const digest = createHash("sha256").update(`${action.thread.teamId}/${action.thread.channelId}/${action.messageTs}/${action.actionTs ?? action.messageTs}/${action.actionId}`, "utf8").digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function workflowSlackHandlers(deps: {
  loadTask(taskId: string): Promise<Record<string, unknown> | undefined>;
  openView(triggerId: string, view: Record<string, unknown>): Promise<void>;
  submit(input: Record<string, unknown>): Promise<void>;
  submitFeedback?(input: Record<string, unknown>): Promise<void>;
}) {
  const currentFeedbackReview = async (value: FeedbackReviewActionValue, userId: string, userTeamId: string, workspaceTeamId: string, thread: SlackThread) => {
    const task = await deps.loadTask(value.taskId);
    if (!task || task.slackUserId !== userId) {
      const owner = SlackUserIdSchema.safeParse(task?.slackUserId);
      throw new WorkflowInteractionRefusal(owner.success ? `Only <@${owner.data}> can decide this PR feedback.` : "Only the task owner can decide this PR feedback.");
    }
    const share = asRecord(task.share);
    if (workspaceTeamId !== thread.teamId || userTeamId !== thread.teamId || share.teamId !== thread.teamId
      || share.channelId !== thread.channelId || share.threadTs !== thread.threadTs) throw new WorkflowInteractionRefusal("This PR feedback belongs to another Slack workspace or thread.");
    const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
    const review = parsed.success ? parsed.data.feedbackReview : undefined;
    const bundleDigests = review?.bundleRefs.map(bundle => bundle.sha256) ?? [];
    const bundleSetDigest = createHash("sha256").update(JSON.stringify(bundleDigests), "utf8").digest("hex");
    if (!parsed.success || parsed.data.revision !== value.expectedRevision || parsed.data.stage !== "WAIT_FOR_MERGE"
      || parsed.data.state !== "WAITING" || review?.status !== "PENDING" || review.reviewRef.status !== "COMPLETE"
      || review.reviewRef.sha256 !== value.reviewDigest || review.reviewRef.proposalDigest !== value.proposalDigest
      || bundleSetDigest !== value.bundleSetDigest) throw new WorkflowInteractionRefusal("This review changed. Reopen the AgentX review details.");
    return { task, workflow: parsed.data, bundleDigests };
  };
  const currentReview = async (value: WorkflowActionValue, userId: string, thread: SlackThread) => {
    const task = await deps.loadTask(value.taskId);
    if (!task || task.slackUserId !== userId) {
      const owner = SlackUserIdSchema.safeParse(task?.slackUserId);
      throw new WorkflowInteractionRefusal(owner.success ? `Only <@${owner.data}> can approve this step.` : "Only the task owner can approve this step.");
    }
    const share = asRecord(task.share);
    if (share.teamId !== thread.teamId || share.channelId !== thread.channelId || share.threadTs !== thread.threadTs) throw new WorkflowInteractionRefusal("This approval belongs to another Slack thread.");
    const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
    if (!parsed.success || parsed.data.revision !== value.revision || parsed.data.stage !== "PLAN_REVIEW" || parsed.data.state !== "WAITING") throw new WorkflowInteractionRefusal("This approval has changed. Use the latest AgentX message.");
    const artifactType = parsed.data.path === "FULL" && parsed.data.reviewPhase === "REQUIREMENTS" ? "requirements"
      : parsed.data.path === "FULL" && parsed.data.reviewPhase === "DESIGN" ? "design" : "plan";
    const plan = parsed.data.artifacts.filter((artifact) => artifact.type === artifactType).at(-1);
    if (!plan || plan.sha256 !== value.digest) throw new WorkflowInteractionRefusal("This approval has changed. Use the latest AgentX message.");
    return { task, workflow: parsed.data };
  };
  return {
    async handleAction(action: SlackBlockAction) {
      if (action.actionId === "agentx_feedback_review_recommended" || action.actionId === "agentx_feedback_review_changes") {
        const value = feedbackReviewActionValue(action.value);
        if (!value || action.triggerId === "") throw new WorkflowInteractionRefusal("This review action is no longer available. Reopen the AgentX review details.");
        const { bundleDigests } = await currentFeedbackReview(value, action.userId, action.userTeamId, action.workspaceTeamId, action.thread);
        const requestId = slackActionRequestId(action);
        if (deps.submitFeedback === undefined) throw new Error("PR feedback decisions are not configured");
        if (action.actionId === "agentx_feedback_review_recommended") {
          await deps.submitFeedback({ taskId: value.taskId, userId: action.userId, thread: action.thread, requestId,
            expectedRevision: value.expectedRevision, reviewDigest: value.reviewDigest, proposalDigest: value.proposalDigest,
            bundleDigests, selection: "RECOMMENDED", decision: "APPROVE" });
          return;
        }
        await deps.openView(action.triggerId, {
          type: "modal", callback_id: "agentx_feedback_review_changes_submission",
          private_metadata: JSON.stringify({ ...value, bundleDigests, requestId, thread: action.thread }),
          title: { type: "plain_text", text: "Request changes" },
          submit: { type: "plain_text", text: "Send note" }, close: { type: "plain_text", text: "Cancel" },
          blocks: [{ type: "input", block_id: "feedback_note", label: { type: "plain_text", text: "What should AgentX reconsider?" },
            element: { type: "plain_text_input", action_id: "reason", multiline: true, max_length: 500, placeholder: { type: "plain_text", text: "Add a short note" } } }],
        });
        return;
      }
      if (action.actionId === "agentx_github_feedback_approve" || action.actionId === "agentx_github_feedback_dismiss") {
        let feedbackAction: Record<string, unknown>;
        try { feedbackAction = asRecord(JSON.parse(action.value)); } catch { throw new Error("invalid PR feedback action"); }
        const taskId = typeof feedbackAction.taskId === "string" && CHANGE_ID.test(feedbackAction.taskId) ? feedbackAction.taskId : undefined;
        const revision = feedbackAction.revision;
        const feedbackId = feedbackAction.feedbackId;
        const candidateDigest = feedbackAction.candidateDigest;
        const decision = action.actionId === "agentx_github_feedback_approve" ? "APPROVE" : "REQUEST_CHANGES";
        if (taskId === undefined || !Number.isInteger(revision) || typeof feedbackId !== "string" || !/^[a-f0-9]{64}$/.test(feedbackId)
          || typeof candidateDigest !== "string" || !/^[a-f0-9]{64}$/.test(candidateDigest) || feedbackAction.decision !== decision) {
          throw new Error("invalid PR feedback action");
        }
        const task = await deps.loadTask(taskId);
        if (!task || task.slackUserId !== action.userId) {
          const owner = SlackUserIdSchema.safeParse(task?.slackUserId);
          throw new WorkflowInteractionRefusal(owner.success ? `Only <@${owner.data}> can decide this PR feedback.` : "Only the task owner can decide this PR feedback.");
        }
        const share = asRecord(task.share);
        if (share.teamId !== action.thread.teamId || share.channelId !== action.thread.channelId || share.threadTs !== action.thread.threadTs) throw new WorkflowInteractionRefusal("This PR feedback belongs to another Slack thread.");
        const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
        const feedback = parsed.success ? parsed.data.feedback : undefined;
        if (!parsed.success || parsed.data.revision !== revision || parsed.data.stage !== "WAIT_FOR_MERGE" || parsed.data.state !== "WAITING"
          || feedback?.status !== "PENDING" || feedback.feedbackId !== feedbackId || feedback.candidateDigest !== candidateDigest
          || parsed.data.candidate?.digest !== candidateDigest) throw new WorkflowInteractionRefusal("This PR feedback changed. Use the latest AgentX message.");
        if (deps.submitFeedback === undefined) throw new Error("PR feedback decisions are not configured");
        await deps.submitFeedback({ taskId, userId: action.userId, thread: action.thread, requestId: randomUUID(), expectedRevision: revision, feedbackId, candidateDigest, decision });
        return;
      }
      const value = workflowActionValue(action.value);
      if (!value || action.triggerId === "") throw new Error("invalid workflow action");
      const { workflow } = await currentReview(value, action.userId, action.thread);
      const requiredText = workflow.checkPolicy?.required.length
        ? `Always run:\n${workflow.checkPolicy.required.map((check) => `• ${check.label}`).join("\n")}`
        : "No required project checks are configured.";
      const blocks: Array<Record<string, unknown>> = [{ type: "section", text: { type: "mrkdwn", text: requiredText } }];
      if (value.decision === "APPROVE") {
        const optional = workflow.checkPolicy?.optional ?? [];
        blocks.push({ type: "section", text: { type: "mrkdwn", text: optional.length ? "Choose any extra checks to run:" : "No extra project-approved checks are available." } });
        if (optional.length) blocks.push({ type: "input", block_id: "workflow_checks", optional: true, label: { type: "plain_text", text: "Extra checks" }, element: {
          type: "checkboxes", action_id: "selected_options", options: optional.map((check) => ({ text: { type: "plain_text", text: check.label }, value: check.id })),
        } });
      } else {
        blocks.push({ type: "input", block_id: "workflow_feedback", label: { type: "plain_text", text: "What should change?" }, element: { type: "plain_text_input", action_id: "reason", multiline: true, max_length: 500 } });
      }
      const privateMetadata = JSON.stringify({ ...value, thread: action.thread });
      await deps.openView(action.triggerId, {
        type: "modal", callback_id: "agentx_workflow_review_submission", private_metadata: privateMetadata,
        title: { type: "plain_text", text: value.decision === "APPROVE" ? "Approve plan" : "Request changes" },
        submit: { type: "plain_text", text: value.decision === "APPROVE" ? "Approve and start" : "Send feedback" },
        close: { type: "plain_text", text: "Cancel" }, blocks,
      });
    },
    async handleSubmission(payload: Record<string, unknown>) {
      const view = asRecord(payload.view);
      if (view.callback_id === "agentx_feedback_review_changes_submission") {
        let metadata: Record<string, unknown>;
        try { metadata = asRecord(JSON.parse(typeof view.private_metadata === "string" ? view.private_metadata : "")); }
        catch { throw new Error("invalid feedback modal metadata"); }
        const value = feedbackReviewActionValue(JSON.stringify(metadata));
        const thread = SlackThreadSchema.safeParse(metadata.thread);
        const slackUser = asRecord(payload.user);
        const user = SlackUserIdSchema.safeParse(slackUser.id);
        const userTeam = SlackTeamIdSchema.safeParse(slackUser.team_id);
        const workspaceTeam = SlackTeamIdSchema.safeParse(asRecord(payload.team).id);
        if (!value || !thread.success || !user.success || !userTeam.success || !workspaceTeam.success
          || typeof metadata.requestId !== "string" || !CHANGE_ID.test(String(metadata.taskId))) {
          throw new WorkflowInteractionRefusal("This PR feedback belongs to another Slack workspace or thread.");
        }
        const { bundleDigests } = await currentFeedbackReview(value, user.data, userTeam.data, workspaceTeam.data, thread.data);
        const reason = asRecord(asRecord(asRecord(view.state).values).feedback_note).reason;
        const ownerNote = asRecord(reason).value;
        if (typeof ownerNote !== "string" || ownerNote.trim().length === 0 || ownerNote.trim().length > 500) throw new WorkflowInteractionRefusal("Add a short note before sending.");
        if (deps.submitFeedback === undefined) throw new Error("PR feedback decisions are not configured");
        await deps.submitFeedback({ taskId: value.taskId, userId: user.data, thread: thread.data, requestId: metadata.requestId,
          expectedRevision: value.expectedRevision, reviewDigest: value.reviewDigest, proposalDigest: value.proposalDigest,
          bundleDigests, selection: "RECOMMENDED", decision: "REQUEST_CHANGES", ownerNote: ownerNote.trim() });
        return;
      }
      let metadata: Record<string, unknown>;
      try { metadata = asRecord(JSON.parse(typeof view.private_metadata === "string" ? view.private_metadata : "")); }
      catch { throw new Error("invalid workflow modal metadata"); }
      const value = workflowActionValue(JSON.stringify({ taskId: metadata.taskId, revision: metadata.revision, digest: metadata.digest, decision: metadata.decision }));
      const thread = SlackThreadSchema.safeParse(metadata.thread);
      const userId = SlackUserIdSchema.safeParse(asRecord(payload.user).id);
      if (!value || !thread.success || !userId.success) throw new Error("invalid workflow modal submission");
      const { workflow } = await currentReview(value, userId.data, thread.data);
      const state = asRecord(view.state);
      const values = asRecord(state.values);
      let reason = "Approved in Slack.";
      let selectedOptionalCheckIds: string[] = [];
      if (value.decision === "REQUEST_CHANGES") {
        const feedback = asRecord(asRecord(values.workflow_feedback).reason).value;
        if (typeof feedback !== "string" || !feedback.trim()) throw new Error("workflow feedback is required");
        reason = feedback.trim().slice(0, 500);
      } else {
        const selections = asRecord(asRecord(values.workflow_checks).selected_options).selected_options;
        if (Array.isArray(selections)) selectedOptionalCheckIds = selections.flatMap((entry) => {
          const id = asRecord(entry).value;
          return typeof id === "string" && workflow.checkPolicy?.optional.some((check) => check.id === id) ? [id] : [];
        });
      }
      await deps.submit({
        taskId: value.taskId, userId: userId.data, thread: thread.data,
        expectedRevision: value.revision, artifactDigest: value.digest, decision: value.decision,
        reason, selectedOptionalCheckIds,
        requestId: workflowDecisionRequestId({ taskId: value.taskId, revision: value.revision, digest: value.digest, decision: value.decision, reason, selectedOptionalCheckIds }),
      });
    },
  };
}

/** Retries of the same Slack modal submission reuse the broker's idempotency key. */
function workflowDecisionRequestId(input: { taskId: string; revision: number; digest: string; decision: string; reason: string; selectedOptionalCheckIds: string[] }): string {
  const digest = createHash("sha256").update(JSON.stringify({ ...input, selectedOptionalCheckIds: [...input.selectedOptionalCheckIds].sort() }), "utf8").digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** The broker's press event (E14), exactly what `isAdminChangePressEvent` accepts. */
export function adminChangePressEvent(press: Parameters<NonNullable<SlackInteractivityDependencies["adminChange"]>["press"]>[0]): AdminChangePressEvent {
  return {
    source: "agentx.slack-ingress", action: "admin-change-press", changeId: press.changeId, click: press.click, slackUserId: press.slackUserId,
    ...(press.teamId === undefined ? {} : { teamId: press.teamId }),
  };
}

/**
 * The press hand-over for the ingress Lambda: an asynchronous invoke of the broker, so Slack's
 * 3-second answer never waits on an apply (the broker records the outcome), and a by-key read of
 * the change's keys and trace ID only, for the log line.
 */
function awsAdminChangePress(
  clientConfiguration: { region?: string }, documentClient: DynamoDBDocumentClient,
): NonNullable<SlackInteractivityDependencies["adminChange"]> {
  const lambda = new LambdaClient(clientConfiguration);
  const brokerFunctionName = requiredEnvironment("BROKER_FUNCTION_NAME");
  const stateTableName = requiredEnvironment("STATE_TABLE_NAME");
  return {
    async press(press) {
      const response = await lambda.send(new InvokeCommand({
        FunctionName: brokerFunctionName, InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(adminChangePressEvent(press))),
      }));
      // An asynchronous invoke that Lambda accepted answers 202.
      if (response.StatusCode !== 202) throw Object.assign(new Error("broker invoke was not accepted"), { name: "BrokerInvokeNotAccepted" });
    },
    async traceOf(changeId) {
      const response = await documentClient.send(new GetCommand({
        TableName: stateTableName, Key: { pk: `ADMIN_CHANGE#${changeId}`, sk: "META" }, ProjectionExpression: "pk, sk, traceId",
      }));
      const traceId = (response.Item as { traceId?: unknown } | undefined)?.traceId;
      return typeof traceId === "string" ? traceId : undefined;
    },
  };
}

/** The Details reader when TURN_RECORDS_TABLE_NAME is unset: every click hears DETAILS_UNAVAILABLE. */
async function detailsNotConfigured(): Promise<never> {
  throw Object.assign(new Error("TURN_RECORDS_TABLE_NAME is not set"), { name: "DetailsNotConfigured" });
}
