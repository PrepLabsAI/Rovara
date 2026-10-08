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
  workflowPublicationRetryable,
  workflowSendBackOffered,
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
  type WorkflowCheckPolicy,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import { requiredEnvironment, type HttpApiV2Event } from "./lambda.js";
import { SLACK_TASK_THREADS_OFF_NOTICE, parseSlackSecrets, validSignature, type SlackIngressLog, type SlackSecrets } from "./slack-ingress.js";
import {
  SlackWorkflowStartError,
  WORKFLOW_PATH_FULL_ACTION,
  WORKFLOW_PATH_QUICK_ACTION,
  createDynamoWorkflowChoiceStore,
  handOffChosenWorkflow,
  isHandedOffWorkflowStart,
  runHandedOffWorkflowStart,
  startWorkflowThroughBroker,
  workflowChoiceRefusal,
  workflowStartFailureNotice,
  type BrokerReply,
  type HandedOffWorkflowStart,
  type WorkflowChoiceOutcome,
  type WorkflowPath,
} from "./slack-workflow-choice.js";
import { detailsActionHandler, dynamoTurnDetailsReader } from "./slack-details.js";
import { WORKFLOW_ACTION_IDS, answeredWorkflowCard, slackText, workflowModalCopy } from "../developer/workflow-messages.js";

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

/** The buttons `workflowSlackHandlers` answers: named beside the messages that carry them. */
export { WORKFLOW_ACTION_IDS };
export { answeredWorkflowCard };

/** The modal that confirms Close task. */
const WORKFLOW_CLOSE_SUBMISSION = "agentx_workflow_close_submission";

class WorkflowDecisionSubmissionError extends Error {
  constructor() { super("the broker did not take the workflow event"); this.name = "WorkflowDecisionSubmissionError"; }
}

class WorkflowCheckSelectionRequired extends Error {
  constructor(message = "Select at least one check before approving the coding plan.") { super(message); this.name = "WorkflowCheckSelectionRequired"; }
}

/**
 * Gap 10h: hands a Slack workflow event (a decision, a retry, a send-back, a close) to the broker as an asynchronous
 * invoke, so Slack's three-second wait never depends on how long the broker takes to save it. Lambda answers 202 once
 * it has queued the event; anything else throws, so the owner can press again. The broker's answer reaches the thread
 * instead: the next step's message (and the card's status line), or a private refusal through the notifier.
 */
export async function invokeWorkflowDecision(
  lambda: { send(command: InvokeCommand): Promise<{ StatusCode?: number }> },
  functionName: string,
  event: Record<string, unknown>,
): Promise<void> {
  let statusCode: number | undefined;
  try {
    ({ StatusCode: statusCode } = await lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(event)) })));
  } catch (error) {
    console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.broker_handoff_failed", taskId: event.taskId, requestId: event.requestId, errorName: errorName(error) }));
    throw new WorkflowDecisionSubmissionError();
  }
  if (statusCode !== 202) {
    console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.broker_handoff_refused", taskId: event.taskId, requestId: event.requestId, statusCode: statusCode ?? null }));
    throw new WorkflowDecisionSubmissionError();
  }
  console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.broker_handoff", taskId: event.taskId, requestId: event.requestId, action: event.action }));
}

/** Slack's limits for check choices in a modal. */
const CHECKBOX_OPTIONS_MAX = 10;
const OPTION_TEXT_MAX = 75;
const REQUIRED_CHECKS_LISTED = 20;
const SECTION_TEXT_MAX = 3_000;

const optionText = (label: string): string => label.length > OPTION_TEXT_MAX ? `${label.slice(0, OPTION_TEXT_MAX - 1)}…` : label;

/**
 * Gap 10e: the check controls of the approval and Retry verification modals, within Slack's limits at the policy's
 * maximums (64 required, 20 optional, 80-character labels). The required list names at most 20 checks, then says how
 * many more, and stays inside one section's 3,000 characters; up to ten optional checks are checkboxes, more are a
 * multi-select (Slack allows ten checkboxes and 100 select options); each option reads at most 75 characters.
 * Before the coding plan (`codingPlan` false) no checks are chosen, so only the required list is shown.
 */
export function workflowCheckControls(policy: WorkflowCheckPolicy | undefined, options: { codingPlan: boolean }): Array<Record<string, unknown>> {
  const required = policy?.required ?? [];
  const optional = policy?.optional ?? [];
  let requiredText: string;
  if (required.length > 0) {
    requiredText = "Always run these project checks:";
    let listed = 0;
    for (const check of required.slice(0, REQUIRED_CHECKS_LISTED)) {
      const line = `\n• ${slackText(optionText(check.label))}`;
      // Room is kept for the "and N more" line.
      if (requiredText.length + line.length > SECTION_TEXT_MAX - 60) break;
      requiredText += line;
      listed += 1;
    }
    if (listed < required.length) requiredText += `\nand ${required.length - listed} more required checks`;
  } else {
    requiredText = options.codingPlan ? "No project checks are required. Choose at least one check below." : "Checks are chosen when you approve the coding plan.";
  }
  const blocks: Array<Record<string, unknown>> = [{ type: "section", text: { type: "mrkdwn", text: requiredText } }];
  if (!options.codingPlan || optional.length === 0) return blocks;
  if (optional.some((check) => check.command.executable === "git" && check.command.args.join(" ") === "diff --check")) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "*Check patch whitespace* finds whitespace errors such as trailing spaces. It does not test program behavior." }] });
  }
  const choices = optional.map((check) => ({ text: { type: "plain_text", text: optionText(check.label) }, value: check.id }));
  blocks.push({ type: "input", block_id: "workflow_checks", optional: required.length > 0,
    label: { type: "plain_text", text: required.length > 0 ? "Optional checks" : "Choose a check" },
    element: optional.length <= CHECKBOX_OPTIONS_MAX
      ? { type: "checkboxes", action_id: "selected_options", options: choices }
      : { type: "multi_static_select", action_id: "selected_options", placeholder: { type: "plain_text", text: "Choose checks" }, options: choices } });
  return blocks;
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
      if (callbackId !== "agentx_workflow_review_submission" && callbackId !== "agentx_workflow_checks_retry_submission"
        && callbackId !== WORKFLOW_CLOSE_SUBMISSION) return respond(200, { response_action: "clear" });
      // The close confirmation has no input to attach an error to, so a refusal replaces the modal with its reason.
      if (callbackId === WORKFLOW_CLOSE_SUBMISSION) {
        try {
          if (dependencies.workflow === undefined) throw new WorkflowInteractionRefusal("Closing tasks from Slack is temporarily unavailable. Try again shortly.");
          await dependencies.workflow.handleSubmission(payload);
          return respond(200, { response_action: "clear" });
        } catch (error) {
          log("workflow.submission_failed", { errorName: errorName(error) });
          return respond(200, { response_action: "update", view: closeRefusedView(error instanceof WorkflowInteractionRefusal ? error.message : "I couldn't close the task. Close this form and try again.") });
        }
      }
      if (dependencies.workflow === undefined) {
        log("workflow.submission_failed", { errorName: "WorkflowNotConfigured" });
        return respond(200, { response_action: "errors", errors: { [callbackId === "agentx_workflow_checks_retry_submission" ? "workflow_checks" : "workflow_feedback"]: "Workflow approvals are temporarily unavailable. Try again shortly." } });
      }
      try {
        await dependencies.workflow.handleSubmission(payload);
        return respond(200, { response_action: "clear" });
      } catch (error) {
        log("workflow.submission_failed", { errorName: errorName(error) });
        const field = callbackId === "agentx_workflow_checks_retry_submission" || error instanceof WorkflowCheckSelectionRequired ? "workflow_checks" : "workflow_feedback";
        // A refusal the form can tell (not the owner, another workspace, a step that moved on) reads as itself.
        return respond(200, { response_action: "errors", errors: { [field]: error instanceof WorkflowCheckSelectionRequired || error instanceof WorkflowInteractionRefusal
          ? error.message : "I couldn't save this decision. Close this form and try again." } });
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
      const handler = dependencies.workflow && WORKFLOW_ACTION_IDS.has(action.actionId)
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
          const workflowButton = WORKFLOW_ACTION_IDS.has(action.actionId);
          const message = error instanceof WorkflowInteractionRefusal ? error.message
            : error instanceof WorkflowDecisionSubmissionError ? "I couldn't save that decision. Try again."
            : action.actionId === WORKFLOW_PATH_QUICK_ACTION || action.actionId === WORKFLOW_PATH_FULL_ACTION ? "I couldn't take that choice. Press the button again, or reply `quick` or `full`."
            : action.actionId === "agentx_workflow_retry_reviews" ? "I couldn't start the review retry. Use the latest AgentX task update and try again."
            : action.actionId === "agentx_workflow_retry_publish" ? "I couldn't retry opening the pull request. Use the latest AgentX task update and try again."
            : action.actionId === "agentx_workflow_send_back" ? "I couldn't send the task back to coding. Use the latest AgentX task update and try again."
            : action.actionId === "agentx_workflow_retry_plan" || action.actionId === "agentx_workflow_retry_implementation" ? "I couldn't start the retry. Use the latest AgentX task update and try again."
            : action.actionId === "agentx_workflow_close" ? "I couldn't open the close confirmation. Use the latest AgentX task update and try again."
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
  /** A direct broker invoke: the broker's answer, or a throw when the broker itself failed. */
  const invokeBroker = async (event: Record<string, unknown>, timeoutMs: number): Promise<BrokerReply> => {
    if (brokerFunctionName === undefined) throw new Error("the broker is not configured");
    const response = await lambda.send(new InvokeCommand({ FunctionName: brokerFunctionName, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(event)) }),
      { abortSignal: AbortSignal.timeout(timeoutMs) });
    if (response.FunctionError !== undefined || response.Payload === undefined) throw new Error(`broker ${String(event.action)} failed`);
    return JSON.parse(Buffer.from(response.Payload).toString("utf8")) as BrokerReply;
  };
  const choices = createDynamoWorkflowChoiceStore({ documentClient, tableName: threadsTableName });
  const workflow = stateTableName && brokerFunctionName ? workflowSlackHandlers({
    async loadTask(taskId) {
      const response = await documentClient.send(new GetCommand({ TableName: stateTableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true, ProjectionExpression: "pk, sk, slackUserId, #share, workflow", ExpressionAttributeNames: { "#share": "share" } })) as { Item?: Record<string, unknown> };
      return response.Item;
    },
    openView: async (triggerId, view) => slackApi((await secrets()).botToken, "views.open", { trigger_id: triggerId, view }),
    async submit(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName, { source: "agentx.slack-ingress", action: "workflow-decision", ...input });
    },
    async retryChecks(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName, { source: "agentx.slack-ingress", action: "workflow-retry", ...input });
    },
    async retryReviews(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName, { source: "agentx.slack-ingress", action: "workflow-review-retry", ...input });
    },
    async retryPublication(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName, { source: "agentx.slack-ingress", action: "workflow-publish-retry", ...input });
    },
    async sendBack(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName, { source: "agentx.slack-ingress", action: "workflow-send-back", ...input });
    },
    async retryPlan(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName, { source: "agentx.slack-ingress", action: "workflow-retry", ...input });
    },
    async retryImplementation(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName, { source: "agentx.slack-ingress", action: "workflow-retry", ...input });
    },
    async close(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName, { source: "agentx.slack-ingress", action: "workflow-close", ...input });
    },
    // Gap 3: a task started in Slack is driven from its thread, so none starts where task threads are off.
    // Gap 10h: the choice is taken while Slack waits; the start (a broker call that can outlast Slack's three seconds)
    // runs in an asynchronous invoke of this same Lambda.
    async chooseWorkflowPath(input) {
      if (process.env.SHARED_TASKS !== "enabled") throw new WorkflowInteractionRefusal(SLACK_TASK_THREADS_OFF_NOTICE);
      return handOffChosenWorkflow({ store: choices, handOff: (event) => handOffToSelf(lambda, event) }, input);
    },
    respondEphemeral: (responseUrl, text) => respondEphemeral(responseUrl, text),
  }) : undefined;
  // The handed-off start runs inside this Lambda's own 10 seconds: a broker that has not answered in 7 is given up on,
  // so the member is still told (the broker's start is idempotent, so a later press meets the same task).
  const chosenStart = (event: HandedOffWorkflowStart) => runHandedOffWorkflowStart({
    store: choices, startWorkflow: (start) => startWorkflowThroughBroker((brokerEvent) => invokeBroker(brokerEvent, HANDED_OFF_START_TIMEOUT_MS), start),
    updateQuestion: async (input) => slackApi((await secrets()).botToken, "chat.update", input),
    respondEphemeral: (responseUrl, text) => respondEphemeral(responseUrl, text),
  }, event);
  const interactivity = createSlackInteractivityHandler({
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
  return async (event: HttpApiV2Event | HandedOffWorkflowStart): Promise<HttpResponse> => {
    if (isHandedOffWorkflowStart(event)) {
      const outcome = await chosenStart(event);
      log("workflow.handed_off_start", { outcome });
      return respond(200, { outcome });
    }
    return interactivity(event);
  };
}

/** How long a handed-off Quick or Full start waits for the broker, inside the ingress Lambda's 10-second timeout. */
const HANDED_OFF_START_TIMEOUT_MS = 7_000;

/** This Lambda's own name, as Lambda sets it; a Quick or Full start is handed to an asynchronous invoke of it. */
async function handOffToSelf(lambda: LambdaClient, event: HandedOffWorkflowStart): Promise<void> {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (functionName === undefined) throw new Error("AWS_LAMBDA_FUNCTION_NAME is not set");
  const response = await lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(event)) }));
  if (response.StatusCode !== 202) throw Object.assign(new Error("the start was not handed over"), { name: "StartHandOffRefused" });
}

interface WorkflowActionValue { taskId: string; revision: number; digest: string; decision: "APPROVE" | "REQUEST_CHANGES" }

class WorkflowInteractionRefusal extends Error {
  constructor(message: string) { super(message); this.name = "WorkflowInteractionRefusal"; }
}

/** Shown in place of the close confirmation when the close was refused, so the owner reads why. */
function closeRefusedView(message: string): Record<string, unknown> {
  return { type: "modal", title: { type: "plain_text", text: "Close this task" }, close: { type: "plain_text", text: "Done" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: message } }] };
}

const STALE_WORKFLOW_BUTTON = "This button is no longer current. Use the latest AgentX task update.";

const CHOICE_NOT_WAITING = workflowChoiceRefusal("none");

function workflowActionValue(value: string): WorkflowActionValue | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.taskId !== "string" || !CHANGE_ID.test(parsed.taskId) || !Number.isInteger(parsed.revision)
      || typeof parsed.digest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.digest)
      || (parsed.decision !== "APPROVE" && parsed.decision !== "REQUEST_CHANGES")) return undefined;
    return { taskId: parsed.taskId, revision: parsed.revision as number, digest: parsed.digest, decision: parsed.decision };
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
  retryChecks?(input: Record<string, unknown>): Promise<void>;
  retryReviews?(input: Record<string, unknown>): Promise<void>;
  retryPublication?(input: Record<string, unknown>): Promise<void>;
  /** Task 16: Send back to coding, with the problems found as the coder's instructions. */
  sendBack?(input: Record<string, unknown>): Promise<void>;
  /** Task 16: retry blocked planning. */
  retryPlan?(input: Record<string, unknown>): Promise<void>;
  /** Task 16: retry blocked coding on the approved plan. */
  retryImplementation?(input: Record<string, unknown>): Promise<void>;
  /** Task 16: close the task after the owner confirmed it in the modal. */
  close?(input: Record<string, unknown>): Promise<void>;
  /** Gap 3: starts the request waiting in the thread on the path its requester clicked. A refused start throws SlackWorkflowStartError. */
  /**
   * Starts the request waiting in the thread on the path its requester clicked, or hands that start over (the AWS
   * wiring); "started" means it started or is on its way. A refused start throws SlackWorkflowStartError. `messageTs` is
   * the question's own message, which loses its buttons only once the task actually started.
   */
  chooseWorkflowPath?(input: { thread: SlackThread; userId: string; workflowPath: WorkflowPath; choiceId: string; responseUrl: string; messageTs: string }): Promise<WorkflowChoiceOutcome>;
  /** Answers the member who pressed a button, privately (Slack's response_url). */
  respondEphemeral?(responseUrl: string, text: string): Promise<void>;
}) {
  /**
   * A button whose press was handed to the broker: the member hears `ack` privately, and nothing else changes. The card
   * keeps its buttons: the press is only queued, and a refusal (busy, out of date) or a failed save must leave a way to
   * press again. The next step's post (and the notifier's card edit) replaces it once the press took effect.
   */
  const acknowledged = async (action: SlackBlockAction, ack: string): Promise<void> => {
    try {
      await deps.respondEphemeral?.(action.responseUrl, ack);
    } catch (error) {
      console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.ack_failed", actionId: action.actionId, errorName: errorName(error) }));
    }
  };
  /** The press must come from the task's own Slack workspace, from a member of that workspace (not Slack Connect). */
  const sameWorkspace = (userTeamId: string, workspaceTeamId: string, thread: SlackThread, refusal: string): void => {
    if (workspaceTeamId !== thread.teamId || userTeamId !== thread.teamId) throw new WorkflowInteractionRefusal(refusal);
  };
  /**
   * The owner's task, decided from its own thread, by a member of the task's own Slack workspace pressing there (a
   * Slack Connect member from another organization is refused, as on every sibling button); its snapshot, whatever
   * its stage.
   */
  const loadOwnedThreadTask = async (value: WorkflowActionValue, who: { userId: string; userTeamId: string; workspaceTeamId: string }, thread: SlackThread) => {
    sameWorkspace(who.userTeamId, who.workspaceTeamId, thread, "This approval must be used from the task's AgentX workspace.");
    const task = await deps.loadTask(value.taskId);
    if (!task || task.slackUserId !== who.userId) {
      const owner = SlackUserIdSchema.safeParse(task?.slackUserId);
      throw new WorkflowInteractionRefusal(owner.success ? `Only <@${owner.data}> can approve this step.` : "Only the task owner can approve this step.");
    }
    const share = asRecord(task.share);
    if (share.teamId !== thread.teamId || share.channelId !== thread.channelId || share.threadTs !== thread.threadTs) throw new WorkflowInteractionRefusal("This approval belongs to another Slack thread.");
    const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
    if (!parsed.success) throw new WorkflowInteractionRefusal("This approval has changed. Use the latest AgentX message.");
    return { task, workflow: parsed.data };
  };
  /** The step `value` approves is still the one waiting: same revision, same document. */
  const reviewStillWaiting = (value: WorkflowActionValue, workflow: WorkflowSnapshot): void => {
    if (workflow.revision !== value.revision || workflow.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") throw new WorkflowInteractionRefusal("This approval has changed. Use the latest AgentX message.");
    const artifactType = workflow.path === "FULL" && workflow.reviewPhase === "REQUIREMENTS" ? "requirements"
      : workflow.path === "FULL" && workflow.reviewPhase === "DESIGN" ? "design" : "plan";
    const plan = workflow.artifacts.filter((artifact) => artifact.type === artifactType).at(-1);
    if (!plan || plan.sha256 !== value.digest) throw new WorkflowInteractionRefusal("This approval has changed. Use the latest AgentX message.");
  };
  const currentReview = async (value: WorkflowActionValue, who: { userId: string; userTeamId: string; workspaceTeamId: string }, thread: SlackThread) => {
    const owned = await loadOwnedThreadTask(value, who, thread);
    reviewStillWaiting(value, owned.workflow);
    return owned;
  };
  /**
   * Task 16: the owner's own task, pressed in its own thread from its own workspace, still in a state `accepts`
   * (and at `revision` when given). Anyone else hears who can act; a stale button hears so.
   */
  const currentOwnedWorkflow = async (input: { taskId: string; userId: string; thread: SlackThread; userTeamId: string; workspaceTeamId: string; revision?: number },
    what: string, accepts: (workflow: WorkflowSnapshot) => boolean) => {
    if (input.workspaceTeamId !== input.thread.teamId || input.userTeamId !== input.thread.teamId) {
      throw new WorkflowInteractionRefusal("This button must be used from the task's AgentX workspace.");
    }
    const task = await deps.loadTask(input.taskId);
    if (!task || task.slackUserId !== input.userId) {
      const owner = SlackUserIdSchema.safeParse(task?.slackUserId);
      throw new WorkflowInteractionRefusal(owner.success ? `Only <@${owner.data}> can ${what}.` : `Only the task owner can ${what}.`);
    }
    const share = asRecord(task.share);
    if (share.teamId !== input.thread.teamId || share.channelId !== input.thread.channelId || share.threadTs !== input.thread.threadTs) {
      throw new WorkflowInteractionRefusal("This button belongs to another Slack thread.");
    }
    const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
    if (!parsed.success || (input.revision !== undefined && parsed.data.revision !== input.revision) || !accepts(parsed.data)) {
      throw new WorkflowInteractionRefusal(STALE_WORKFLOW_BUTTON);
    }
    return parsed.data;
  };
  /** A blocked-state button's task and revision, from its value. */
  const exitButton = (action: SlackBlockAction): { taskId: string; revision: number } => {
    let value: Record<string, unknown>;
    try { value = asRecord(JSON.parse(action.value)); } catch { throw new WorkflowInteractionRefusal(STALE_WORKFLOW_BUTTON); }
    if (typeof value.taskId !== "string" || !CHANGE_ID.test(value.taskId) || typeof value.revision !== "number" || !Number.isInteger(value.revision)) {
      throw new WorkflowInteractionRefusal(STALE_WORKFLOW_BUTTON);
    }
    return { taskId: value.taskId, revision: value.revision };
  };
  const currentVerificationRetry = async (taskId: string, revision: number, userId: string, thread: SlackThread) => {
    const task = await deps.loadTask(taskId);
    if (!task || task.slackUserId !== userId) throw new WorkflowInteractionRefusal("Only the task owner can retry verification.");
    const share = asRecord(task.share);
    if (share.teamId !== thread.teamId || share.channelId !== thread.channelId || share.threadTs !== thread.threadTs) {
      throw new WorkflowInteractionRefusal("This verification retry belongs to another Slack thread.");
    }
    const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
    // Task 16: also Run checks again on a change ready to publish whose code changed after its checks.
    if (!parsed.success || parsed.data.revision !== revision || !((parsed.data.stage === "VERIFY" && parsed.data.state === "BLOCKED")
      || (workflowPublicationRetryable(parsed.data) && (parsed.data.pullRequests?.length ?? 0) === 0))) {
      throw new WorkflowInteractionRefusal("This verification retry is no longer current. Use the latest AgentX task update.");
    }
    return { task, workflow: parsed.data };
  };
  const currentReviewRetry = async (taskId: string, revision: number, candidateDigest: string, userId: string, thread: SlackThread) => {
    const task = await deps.loadTask(taskId);
    if (!task || task.slackUserId !== userId) throw new WorkflowInteractionRefusal("Only the task owner can retry reviews.");
    const share = asRecord(task.share);
    if (share.teamId !== thread.teamId || share.channelId !== thread.channelId || share.threadTs !== thread.threadTs) {
      throw new WorkflowInteractionRefusal("This review retry belongs to another Slack thread.");
    }
    const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
    if (!parsed.success || parsed.data.revision !== revision || parsed.data.stage !== "REVIEW" || parsed.data.state !== "BLOCKED"
      || parsed.data.candidate?.digest !== candidateDigest || parsed.data.verification?.candidateDigest !== candidateDigest
      || !parsed.data.verification.results.every((result) => result.status === "PASS")) {
      throw new WorkflowInteractionRefusal("This review retry is no longer current. Use the latest AgentX task update.");
    }
    return parsed.data;
  };
  return {
    async handleAction(action: SlackBlockAction) {
      if (action.actionId === WORKFLOW_PATH_QUICK_ACTION || action.actionId === WORKFLOW_PATH_FULL_ACTION) {
        let choiceId: unknown;
        try { choiceId = asRecord(JSON.parse(action.value)).choiceId; } catch { choiceId = undefined; }
        if (typeof choiceId !== "string" || !CHANGE_ID.test(choiceId)) throw new WorkflowInteractionRefusal(CHOICE_NOT_WAITING);
        if (deps.chooseWorkflowPath === undefined) throw new Error("Quick or Full choices are not configured");
        const workflowPath: WorkflowPath = action.actionId === WORKFLOW_PATH_FULL_ACTION ? "FULL" : "QUICK";
        let outcome: WorkflowChoiceOutcome;
        try {
          outcome = await deps.chooseWorkflowPath({ thread: action.thread, userId: action.userId, workflowPath, choiceId, responseUrl: action.responseUrl, messageTs: action.messageTs });
        } catch (error) {
          // The broker refused the start: say why, with the choice as the reference an admin can look up.
          if (error instanceof SlackWorkflowStartError) throw new WorkflowInteractionRefusal(workflowStartFailureNotice(error.code, choiceId));
          throw error;
        }
        if (outcome !== "started") throw new WorkflowInteractionRefusal(workflowChoiceRefusal(outcome));
        // The question keeps its buttons and its "reply quick or full" hint until the task has started: the start marks
        // it answered then. A start that fails leaves it as it was, and the member hears why.
        await acknowledged(action, workflowPath === "FULL" ? "Starting this on Full." : "Starting this on Quick.");
        return;
      }
      if (action.actionId === "agentx_workflow_retry_checks") {
        let retry: Record<string, unknown>;
        try { retry = asRecord(JSON.parse(action.value)); } catch { throw new WorkflowInteractionRefusal("This verification retry is no longer available."); }
        const taskId = typeof retry.taskId === "string" && CHANGE_ID.test(retry.taskId) ? retry.taskId : undefined;
        if (taskId === undefined || !Number.isInteger(retry.revision)) throw new WorkflowInteractionRefusal("This verification retry is no longer available.");
        if (action.workspaceTeamId !== action.thread.teamId || action.userTeamId !== action.thread.teamId) {
          throw new WorkflowInteractionRefusal("This verification retry must be opened from the task's AgentX workspace.");
        }
        const { workflow } = await currentVerificationRetry(taskId, Number(retry.revision), action.userId, action.thread);
        const modalBlocks = workflowCheckControls(workflow.checkPolicy, { codingPlan: true });
        await deps.openView(action.triggerId, {
          type: "modal", callback_id: "agentx_workflow_checks_retry_submission",
          private_metadata: JSON.stringify({ taskId, revision: workflow.revision, requestId: randomUUID(), thread: action.thread }),
          title: { type: "plain_text", text: "Retry verification" }, submit: { type: "plain_text", text: "Run checks" },
          close: { type: "plain_text", text: "Cancel" }, blocks: modalBlocks,
        });
        return;
      }
      if (action.actionId === "agentx_workflow_retry_reviews") {
        let retry: Record<string, unknown>;
        try { retry = asRecord(JSON.parse(action.value)); } catch { throw new WorkflowInteractionRefusal("This review retry is no longer available."); }
        const taskId = typeof retry.taskId === "string" && CHANGE_ID.test(retry.taskId) ? retry.taskId : undefined;
        const candidateDigest = typeof retry.candidateDigest === "string" && /^[a-f0-9]{64}$/.test(retry.candidateDigest) ? retry.candidateDigest : undefined;
        if (taskId === undefined || candidateDigest === undefined || !Number.isInteger(retry.revision)) throw new WorkflowInteractionRefusal("This review retry is no longer available.");
        if (action.workspaceTeamId !== action.thread.teamId || action.userTeamId !== action.thread.teamId) throw new WorkflowInteractionRefusal("This review retry must be opened from the task's AgentX workspace.");
        const workflow = await currentReviewRetry(taskId, Number(retry.revision), candidateDigest, action.userId, action.thread);
        if (deps.retryReviews === undefined) throw new Error("review retry is not configured");
        await deps.retryReviews({ taskId, userId: action.userId, thread: action.thread, requestId: slackActionRequestId(action),
          expectedRevision: workflow.revision, candidateDigest });
        await acknowledged(action, "Retrying the reviews on the same checked code.");
        return;
      }
      if (action.actionId === "agentx_workflow_send_back") {
        const { taskId, revision } = exitButton(action);
        const workflow = await currentOwnedWorkflow({ ...action, taskId, revision }, "send this task back to coding", workflowSendBackOffered);
        if (deps.sendBack === undefined) throw new Error("send back to coding is not configured");
        await deps.sendBack({ taskId, userId: action.userId, thread: action.thread, expectedRevision: workflow.revision, requestId: slackActionRequestId(action) });
        await acknowledged(action, "Sending this back to coding.");
        return;
      }
      if (action.actionId === "agentx_workflow_retry_plan" || action.actionId === "agentx_workflow_retry_implementation") {
        const { taskId, revision } = exitButton(action);
        const plan = action.actionId === "agentx_workflow_retry_plan";
        const workflow = await currentOwnedWorkflow({ ...action, taskId, revision }, plan ? "retry the planning" : "retry the coding",
          (current) => current.stage === (plan ? "PLAN" : "IMPLEMENT") && current.state === "BLOCKED");
        const input = { taskId, userId: action.userId, thread: action.thread, expectedRevision: workflow.revision, requestId: slackActionRequestId(action),
          selectedOptionalCheckIds: [], step: plan ? "plan" : "coding" };
        if (plan ? deps.retryPlan === undefined : deps.retryImplementation === undefined) throw new Error("retrying this step is not configured");
        await (plan ? deps.retryPlan?.(input) : deps.retryImplementation?.(input));
        await acknowledged(action, "Retrying.");
        return;
      }
      if (action.actionId === "agentx_workflow_close") {
        const { taskId } = exitButton(action);
        if (action.triggerId === "") throw new WorkflowInteractionRefusal(STALE_WORKFLOW_BUTTON);
        const workflow = await currentOwnedWorkflow({ ...action, taskId }, "close this task", (current) => current.state !== "COMPLETE");
        const published = (workflow.pullRequests?.length ?? 0) > 0;
        await deps.openView(action.triggerId, {
          type: "modal", callback_id: WORKFLOW_CLOSE_SUBMISSION,
          private_metadata: JSON.stringify({ taskId, requestId: slackActionRequestId(action), thread: action.thread }),
          title: { type: "plain_text", text: "Close this task" }, submit: { type: "plain_text", text: "Close task" }, close: { type: "plain_text", text: "Cancel" },
          blocks: [{ type: "section", text: { type: "mrkdwn", text: published
            ? "Closing stops this task and releases its workspace. Code that isn't in a pull request is discarded. Its open pull request stays on GitHub."
            : "Closing stops this task and releases its workspace. Code that isn't in a pull request is discarded." } }],
        });
        return;
      }
      if (action.actionId === "agentx_workflow_retry_publish") {
        let retry: Record<string, unknown>;
        try { retry = asRecord(JSON.parse(action.value)); } catch { throw new WorkflowInteractionRefusal("This retry is no longer available."); }
        const taskId = typeof retry.taskId === "string" && CHANGE_ID.test(retry.taskId) ? retry.taskId : undefined;
        if (taskId === undefined || !Number.isInteger(retry.revision)) throw new WorkflowInteractionRefusal("This retry is no longer available.");
        if (action.workspaceTeamId !== action.thread.teamId || action.userTeamId !== action.thread.teamId) throw new WorkflowInteractionRefusal("This retry must be used from the task's AgentX workspace.");
        const task = await deps.loadTask(taskId);
        if (!task || task.slackUserId !== action.userId) throw new WorkflowInteractionRefusal("Only the task owner can retry opening the pull request.");
        const share = asRecord(task.share);
        if (share.teamId !== action.thread.teamId || share.channelId !== action.thread.channelId || share.threadTs !== action.thread.threadTs) {
          throw new WorkflowInteractionRefusal("This retry belongs to another Slack thread.");
        }
        const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
        if (!parsed.success || parsed.data.revision !== Number(retry.revision) || !workflowPublicationRetryable(parsed.data)) {
          throw new WorkflowInteractionRefusal("This retry is no longer current. Use the latest AgentX task update.");
        }
        if (deps.retryPublication === undefined) throw new Error("pull request retry is not configured");
        await deps.retryPublication({ taskId, userId: action.userId, thread: action.thread, requestId: slackActionRequestId(action), expectedRevision: parsed.data.revision });
        await acknowledged(action, "Opening the draft pull request again.");
        return;
      }
      const value = workflowActionValue(action.value);
      if (!value || action.triggerId === "") throw new Error("invalid workflow action");
      const { workflow } = await currentReview(value, action, action.thread);
      const requiredChecks = workflow.checkPolicy?.required ?? [];
      const codingPlan = workflow.path === "QUICK" || workflow.reviewPhase === "IMPLEMENTATION_PLAN";
      const optionalChecks = workflow.checkPolicy?.optional ?? [];
      if (value.decision === "APPROVE" && codingPlan && requiredChecks.length === 0 && optionalChecks.length === 0) {
        throw new WorkflowInteractionRefusal("This project has no checks to run. Ask a project admin to configure at least one check before approving the coding plan.");
      }
      const choosing = value.decision === "APPROVE" && codingPlan;
      const controls = workflowCheckControls(workflow.checkPolicy, { codingPlan: choosing });
      // Asking for changes to the coding plan itself: its checks are chosen when it is approved, not "later".
      const blocks: Array<Record<string, unknown>> = [!choosing && codingPlan && requiredChecks.length === 0
        ? { type: "section", text: { type: "mrkdwn", text: "No project checks are required. You choose checks when you approve the coding plan." } }
        : controls[0]!];
      if (choosing) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: optionalChecks.length
          ? requiredChecks.length ? "Optional checks: select any extras to run." : "Choose at least one check. AgentX will run these before review or opening a pull request."
          : "No optional checks are available." } });
        blocks.push(...controls.slice(1));
      } else if (value.decision === "REQUEST_CHANGES") {
        blocks.push({ type: "input", block_id: "workflow_feedback", label: { type: "plain_text", text: "What should change?" }, element: { type: "plain_text_input", action_id: "reason", multiline: true, max_length: 500 } });
      }
      // Keep this below Slack's 3,000-character private_metadata limit. The original
      // approval card is updated from its persisted notifier record after the decision;
      // copying the full plan message here is unnecessary and breaks long plans.
      const privateMetadata = JSON.stringify({ ...value, thread: action.thread });
      const copy = workflowModalCopy(workflow, value.decision);
      await deps.openView(action.triggerId, {
        type: "modal", callback_id: "agentx_workflow_review_submission", private_metadata: privateMetadata,
        title: { type: "plain_text", text: copy.title },
        submit: { type: "plain_text", text: copy.submit },
        close: { type: "plain_text", text: "Cancel" }, blocks,
      });
    },
    async handleSubmission(payload: Record<string, unknown>) {
      const view = asRecord(payload.view);
      if (view.callback_id === WORKFLOW_CLOSE_SUBMISSION) {
        let metadata: Record<string, unknown>;
        try { metadata = asRecord(JSON.parse(typeof view.private_metadata === "string" ? view.private_metadata : "")); }
        catch { throw new WorkflowInteractionRefusal(STALE_WORKFLOW_BUTTON); }
        const taskId = typeof metadata.taskId === "string" && CHANGE_ID.test(metadata.taskId) ? metadata.taskId : undefined;
        const requestId = typeof metadata.requestId === "string" && CHANGE_ID.test(metadata.requestId) ? metadata.requestId : undefined;
        const thread = SlackThreadSchema.safeParse(metadata.thread);
        const userId = SlackUserIdSchema.safeParse(asRecord(payload.user).id);
        const userTeamId = SlackTeamIdSchema.safeParse(asRecord(payload.user).team_id);
        const workspaceTeamId = SlackTeamIdSchema.safeParse(asRecord(payload.team).id);
        if (taskId === undefined || requestId === undefined || !thread.success || !userId.success || !userTeamId.success || !workspaceTeamId.success) {
          throw new WorkflowInteractionRefusal(STALE_WORKFLOW_BUTTON);
        }
        await currentOwnedWorkflow({ taskId, userId: userId.data, thread: thread.data, userTeamId: userTeamId.data, workspaceTeamId: workspaceTeamId.data },
          "close this task", (current) => current.state !== "COMPLETE");
        if (deps.close === undefined) throw new Error("closing tasks is not configured");
        await deps.close({ taskId, userId: userId.data, thread: thread.data, requestId });
        return;
      }
      if (view.callback_id === "agentx_workflow_checks_retry_submission") {
        let metadata: Record<string, unknown>;
        try { metadata = asRecord(JSON.parse(typeof view.private_metadata === "string" ? view.private_metadata : "")); }
        catch { throw new WorkflowInteractionRefusal("This verification retry is no longer available."); }
        const taskId = typeof metadata.taskId === "string" && CHANGE_ID.test(metadata.taskId) ? metadata.taskId : undefined;
        const revision = metadata.revision;
        const requestId = typeof metadata.requestId === "string" && CHANGE_ID.test(metadata.requestId) ? metadata.requestId : undefined;
        const thread = SlackThreadSchema.safeParse(metadata.thread);
        const userId = SlackUserIdSchema.safeParse(asRecord(payload.user).id);
        const userTeamId = SlackTeamIdSchema.safeParse(asRecord(payload.user).team_id);
        const workspaceTeamId = SlackTeamIdSchema.safeParse(asRecord(payload.team).id);
        if (taskId === undefined || !Number.isInteger(revision) || requestId === undefined || !thread.success || !userId.success) {
          throw new WorkflowInteractionRefusal("This verification retry is no longer available.");
        }
        if (!userTeamId.success || !workspaceTeamId.success || userTeamId.data !== thread.data.teamId || workspaceTeamId.data !== thread.data.teamId) {
          throw new WorkflowInteractionRefusal("This verification retry must be submitted from the task's AgentX workspace.");
        }
        const { workflow } = await currentVerificationRetry(taskId, Number(revision), userId.data, thread.data);
        const selections = asRecord(asRecord(asRecord(asRecord(view.state).values).workflow_checks).selected_options).selected_options;
        const selectedOptionalCheckIds = Array.isArray(selections) ? selections.flatMap(entry => {
          const id = asRecord(entry).value;
          return typeof id === "string" && workflow.checkPolicy?.optional.some(check => check.id === id) ? [id] : [];
        }) : [];
        // Canonical order: the same selection in another order replays the modal's request ID.
        selectedOptionalCheckIds.sort();
        const required = workflow.checkPolicy?.required ?? [];
        if (required.length === 0 && selectedOptionalCheckIds.length === 0) {
          throw new WorkflowCheckSelectionRequired("Choose at least one check before retrying verification.");
        }
        if (deps.retryChecks === undefined) throw new Error("verification retry is not configured");
        await deps.retryChecks({ taskId, userId: userId.data, thread: thread.data, requestId, expectedRevision: revision,
          selectedOptionalCheckIds, instructions: "Retry the selected checks without changing code." });
        return;
      }
      let metadata: Record<string, unknown>;
      try { metadata = asRecord(JSON.parse(typeof view.private_metadata === "string" ? view.private_metadata : "")); }
      catch { throw new Error("invalid workflow modal metadata"); }
      const value = workflowActionValue(JSON.stringify({ taskId: metadata.taskId, revision: metadata.revision, digest: metadata.digest, decision: metadata.decision }));
      const thread = SlackThreadSchema.safeParse(metadata.thread);
      const userId = SlackUserIdSchema.safeParse(asRecord(payload.user).id);
      if (!value || !thread.success || !userId.success) throw new Error("invalid workflow modal submission");
      const userTeamId = SlackTeamIdSchema.safeParse(asRecord(payload.user).team_id);
      const workspaceTeamId = SlackTeamIdSchema.safeParse(asRecord(payload.team).id);
      const { workflow } = await loadOwnedThreadTask(value, { userId: userId.data, userTeamId: userTeamId.success ? userTeamId.data : "",
        workspaceTeamId: workspaceTeamId.success ? workspaceTeamId.data : "" }, thread.data);
      const state = asRecord(view.state);
      const values = asRecord(state.values);
      let reason = "Approved in Slack.";
      let selectedOptionalCheckIds: string[] = [];
      if (value.decision === "REQUEST_CHANGES") {
        const feedback = asRecord(asRecord(values.workflow_feedback).reason).value;
        if (typeof feedback !== "string" || !feedback.trim()) throw new Error("workflow feedback is required");
        reason = feedback.trim().slice(0, 500);
      } else {
        // Checkboxes and a multi-select both answer `selected_options`.
        const selections = asRecord(asRecord(values.workflow_checks).selected_options).selected_options;
        if (Array.isArray(selections)) selectedOptionalCheckIds = selections.flatMap((entry) => {
          const id = asRecord(entry).value;
          return typeof id === "string" && workflow.checkPolicy?.optional.some((check) => check.id === id) ? [id] : [];
        });
        // One canonical order for both the request ID and the submitted decision, so the same
        // selection made in another order is the same decision rather than a replay mismatch.
        selectedOptionalCheckIds.sort();
      }
      const requestId = workflowDecisionRequestId({ taskId: value.taskId, revision: value.revision, digest: value.digest, decision: value.decision, reason, selectedOptionalCheckIds });
      // Gap 10h: this exact decision is already saved (a resubmission after a slow save): the form just closes,
      // before any check that the step is still waiting, which it no longer is.
      if (workflow.decisions.some((decision) => decision.requestId === requestId)) {
        console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.decision_replayed", taskId: value.taskId, requestId }));
        return;
      }
      reviewStillWaiting(value, workflow);
      const codingPlan = workflow.path === "QUICK" || workflow.reviewPhase === "IMPLEMENTATION_PLAN";
      if (value.decision === "APPROVE" && codingPlan && (workflow.checkPolicy?.required.length ?? 0) === 0 && selectedOptionalCheckIds.length === 0) {
        throw new WorkflowCheckSelectionRequired();
      }
      await deps.submit({
        taskId: value.taskId, userId: userId.data, thread: thread.data,
        expectedRevision: value.revision, artifactDigest: value.digest, decision: value.decision,
        reason, selectedOptionalCheckIds, requestId,
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
