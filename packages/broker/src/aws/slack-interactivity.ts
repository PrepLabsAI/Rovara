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
  TaskPeopleViewSchema,
  WORKFLOW_RESOLVE_FINDINGS_MAX,
  WorkflowSnapshotSchema,
  openReviewFindings,
  WORKFLOW_BLOCK_REASONS,
  workflowKeepPullRequestsOffered,
  workflowPublicationRetryable,
  workflowResolveFindingsOffered,
  workflowSelectedChecks,
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
  type TaskPeopleView,
  type WorkflowCheck,
  type WorkflowCheckPolicy,
  type WorkflowOpenFinding,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import { requiredEnvironment, type HttpApiV2Event } from "./lambda.js";
import {
  SLACK_TASK_THREADS_OFF_NOTICE, createAnswerQueue, parseSlackSecrets, threadPendingCounter, validSignature, type SlackIngressLog, type SlackSecrets,
} from "./slack-ingress.js";
import {
  SlackWorkflowStartError,
  WORKFLOW_PATH_ANSWER_ACTION,
  WORKFLOW_PATH_FULL_ACTION,
  WORKFLOW_PATH_QUICK_ACTION,
  answerChosenRequest,
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
import {
  CHATGPT_OPEN_ACTION, CHATGPT_PASTE_ACTION, CHATGPT_PASTE_SUBMISSION, chatGptPasteModal, chatGptSubmission, isHandedOffChatGptFinish, runHandedOffChatGptFinish,
  type HandedOffChatGptFinish,
} from "./slack-chatgpt.js";
import { chatPostEphemeral } from "./slack-web.js";
import { WORKFLOW_APPROVAL_OUT_OF_DATE, WORKFLOW_BUTTON_OUT_OF_DATE } from "../developer/workflow-actions.js";
import { FEEDBACK_REVIEW_RETRY_ACTION, WORKFLOW_ACTION_IDS, answeredWorkflowCard, cleanLine, slackText, workflowModalCopy } from "../developer/workflow-messages.js";

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
  /** #340: the pasted ChatGPT address; the answer is Slack's response to the form. Absent: the form just closes. */
  chatgptSubmission?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
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

/** What a member hears when the task authorization itself failed, not when it said no. */
export const AUTHORIZATION_UNAVAILABLE_TEXT = "Something went wrong; try again in a minute.";

/** The AgentX error code a failed authorization carries (the broker's own, from its reply), if any. */
function authorizationErrorCode(error: unknown): string | undefined {
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/** Broker answers that say "no" about this member and this task: retrying cannot change them. */
const DEFINITE_ACCESS_REFUSALS: ReadonlySet<string> = new Set(["FORBIDDEN", "TASK_NOT_FOUND", "TASK_ACCESS_DENIED", "PROJECT_ACCESS_DENIED", "PROJECT_TASKS_DISABLED"]);

interface HttpResponse { statusCode: number; headers: Record<string, string>; body: string }

function respond(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** The buttons `workflowSlackHandlers` answers: named beside the messages that carry them. */
export { WORKFLOW_ACTION_IDS };
export { answeredWorkflowCard };

/** Said when a Retry review press no longer matches the task's failed review. */
const FEEDBACK_REVIEW_CHANGED = "This review changed. Use the latest AgentX message.";
/** The modal that confirms Close task. */
const WORKFLOW_CLOSE_SUBMISSION = "agentx_workflow_close_submission";
/** The modal that answers each blocking review finding of a blocked review. */
const WORKFLOW_FINDINGS_SUBMISSION = "agentx_workflow_resolve_findings_submission";
/** Said privately when the owner confirms Close task; the thread's "closed" follows once the workspace is released. */
const CLOSING_ACK = "Closing this task. Its workspace is being released; I'll post here when it's closed, usually within two minutes.";

class WorkflowDecisionSubmissionError extends Error {
  constructor() { super("the broker did not take the workflow event"); this.name = "WorkflowDecisionSubmissionError"; }
}

class WorkflowCheckSelectionRequired extends Error {
  constructor(message: string) { super(message); this.name = "WorkflowCheckSelectionRequired"; }
}

/** Problems with the owner's answers, each shown in the form on its own input (by block ID). */
class WorkflowFormErrors extends Error {
  constructor(readonly errors: Record<string, string>) { super("the form has problems"); this.name = "WorkflowFormErrors"; }
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
 * A heading and its checks' labels (escaped), naming at most 20 and then how many more, inside one section's 3,000
 * characters.
 */
function checkListSection(heading: string, checks: readonly WorkflowCheck[], kind: string): Record<string, unknown> {
  let text = heading;
  let listed = 0;
  for (const check of checks.slice(0, REQUIRED_CHECKS_LISTED)) {
    const line = `\n• ${slackText(optionText(check.label))}`;
    // Room is kept for the "and N more" line.
    if (text.length + line.length > SECTION_TEXT_MAX - 60) break;
    text += line;
    listed += 1;
  }
  if (listed < checks.length) text += `\nand ${checks.length - listed} more ${kind} ${checks.length - listed === 1 ? "check" : "checks"}`;
  return { type: "section", text: { type: "mrkdwn", text } };
}

/** What the coding plan form says when neither the project nor AgentX has a check for this change. */
function reviewOnlySentence(noneReason: string | undefined): string {
  const reason = noneReason?.trim().replace(/[.!?]+$/, "") ?? "";
  return `No automated checks apply${reason === "" ? "" : `: ${slackText(reason)}`}. If you approve without choosing a check, this change is checked by review only and the draft PR will say so.`;
}

/**
 * Gap 10e: the check controls of the approval and Retry verification modals, within Slack's limits at the policy's
 * maximums (64 required, 8 proposed, 20 optional, 80-character labels). Each list names at most 20 checks, then says
 * how many more, and stays inside one section's 3,000 characters; up to ten optional checks are checkboxes, more are a
 * multi-select (Slack allows ten checkboxes and 100 select options); each option reads at most 75 characters.
 * Before the coding plan (`codingPlan` false) no checks are chosen, so only the project's checks are shown.
 * Approving the coding plan: the project's checks and AgentX's proposed ones always run, optional ones may be added,
 * and choosing none of anything is review only, which the form says. A verification retry (`retry`) starts with the
 * optional checks chosen before, and must run at least one check.
 */
export function workflowCheckControls(policy: WorkflowCheckPolicy | undefined, options: { codingPlan: boolean; retry?: boolean }): Array<Record<string, unknown>> {
  const required = policy?.required ?? [];
  const optional = policy?.optional ?? [];
  // A task stored before proposals has no `proposed`.
  const proposed = policy?.proposed ?? [];
  const requiredSection = required.length > 0 ? checkListSection("Project checks, always run:", required, "required") : undefined;
  if (!options.codingPlan) {
    return [requiredSection ?? { type: "section", text: { type: "mrkdwn", text: "Checks are chosen when you approve the coding plan." } }];
  }
  const blocks: Array<Record<string, unknown>> = [];
  if (requiredSection !== undefined) blocks.push(requiredSection);
  if (proposed.length > 0 && options.retry === true) {
    // A retry may drop a proposed check (one the worker can't run, say), never add one: those still kept start ticked.
    const choices = proposed.map((check) => ({ text: { type: "plain_text", text: optionText(check.label) }, value: check.id }));
    const kept = choices.filter((choice) => policy?.selectedProposedIds === undefined || policy.selectedProposedIds.includes(choice.value));
    blocks.push({ type: "input", block_id: "workflow_proposed_checks", optional: true, label: { type: "plain_text", text: "Proposed by AgentX" },
      element: { type: "checkboxes", action_id: "selected_options", options: choices, ...(kept.length > 0 ? { initial_options: kept } : {}) } });
  } else if (proposed.length > 0) {
    blocks.push(checkListSection("Proposed by AgentX for this change:", proposed, "proposed"));
  }
  const locked = required.length + proposed.length;
  if (locked === 0 && options.retry !== true) blocks.push({ type: "section", text: { type: "mrkdwn", text: reviewOnlySentence(policy?.noneReason) } });
  if (optional.length === 0) return blocks;
  if (optional.some((check) => check.command.executable === "git" && check.command.args.join(" ") === "diff --check")) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "*Check patch whitespace* finds whitespace errors such as trailing spaces. It does not test program behavior." }] });
  }
  const choices = optional.map((check) => ({ text: { type: "plain_text", text: optionText(check.label) }, value: check.id }));
  // A retry must still run a check: with nothing else to run, one must be chosen.
  const mustChoose = options.retry === true && locked === 0;
  const chosenBefore = options.retry === true ? choices.filter((choice) => policy?.selectedOptionalIds.includes(choice.value)) : [];
  const initial = chosenBefore.length > 0 ? { initial_options: chosenBefore } : {};
  blocks.push({ type: "input", block_id: "workflow_checks", optional: !mustChoose,
    label: { type: "plain_text", text: mustChoose ? "Choose a check" : "Optional checks" },
    element: optional.length <= CHECKBOX_OPTIONS_MAX
      ? { type: "checkboxes", action_id: "selected_options", options: choices, ...initial }
      : { type: "multi_static_select", action_id: "selected_options", placeholder: { type: "plain_text", text: "Choose checks" }, options: choices, ...initial } });
  return blocks;
}

/** The checks input a form error attaches to: the optional checks, or the proposed ones when only they can be chosen. */
function checksErrorBlock(view: Record<string, unknown>): string {
  const ids = Array.isArray(view.blocks) ? view.blocks.map((block) => asRecord(block).block_id) : [];
  return !ids.includes("workflow_checks") && ids.includes("workflow_proposed_checks") ? "workflow_proposed_checks" : "workflow_checks";
}

/** The block ID of a modal's first input: where an error that is about the whole form is shown. */
function firstInputBlock(view: Record<string, unknown>): string {
  const blocks = Array.isArray(view.blocks) ? view.blocks.map(asRecord) : [];
  const first = blocks.find((block) => block.type === "input" && typeof block.block_id === "string");
  return typeof first?.block_id === "string" ? first.block_id : "workflow_feedback";
}

/** How much of a finding's text and path the form shows: Slack limits a section to 3,000 characters, and the form holds up to 20. */
const FINDING_FORM_TEXT_MAX = 400;
const FINDING_FORM_FILE_MAX = 100;
const FINDING_REASON_MAX = 500;
const FINDING_INSTRUCTION_MAX = 1_000;

const findingBlockIds = (findingId: string) => ({ action: `finding_action_${findingId}`, note: `finding_note_${findingId}` });

/**
 * The form that answers each blocking review finding: the finding (escaped, cut), a Fix or Accept choice that starts on
 * Fix, and one text box ("Instructions" for Fix, "Reason" for Accept). Three blocks a finding and one introduction: at
 * most 61 of Slack's 100.
 */
export function workflowFindingsModal(findings: readonly WorkflowOpenFinding[], metadata: Record<string, unknown>): Record<string, unknown> {
  const fix = { text: { type: "plain_text", text: "Fix" }, value: "FIX" };
  const accept = { text: { type: "plain_text", text: "Accept" }, value: "ACCEPT" };
  const blocks: Array<Record<string, unknown>> = [{ type: "section", text: { type: "mrkdwn", text: findings.length === 1
    ? "Fix sends this finding back to coding with your instructions. Accept lets the change go on to its pull request; your reason is saved and listed there."
    : "Fix sends a finding back to coding with your instructions. Accept lets the change go on to its pull request; your reason is saved and listed there." } }];
  findings.forEach((finding, index) => {
    const ids = findingBlockIds(finding.findingId);
    // Reviewer text and paths are untrusted: redacted, on one line, cut, escaped and never a link (as on the card).
    const where = finding.file === undefined ? "" : ` (${cleanLine(finding.file, FINDING_FORM_FILE_MAX)}${finding.line === undefined ? "" : `:${finding.line}`})`;
    blocks.push(
      { type: "section", text: { type: "mrkdwn", text: `*${index + 1}. ${finding.role === "SECURITY" ? "Security review" : "Code review"}*${where}\n${cleanLine(finding.text, FINDING_FORM_TEXT_MAX)}` } },
      { type: "input", block_id: ids.action, label: { type: "plain_text", text: `What should happen to finding ${index + 1}?` },
        element: { type: "radio_buttons", action_id: "action", options: [fix, accept], initial_option: fix } },
      { type: "input", block_id: ids.note, optional: true, label: { type: "plain_text", text: "Fix instructions, or your reason to accept" },
        hint: { type: "plain_text", text: "A reason is needed to accept this finding." },
        element: { type: "plain_text_input", action_id: "note", multiline: true, max_length: FINDING_INSTRUCTION_MAX } },
    );
  });
  return {
    type: "modal", callback_id: WORKFLOW_FINDINGS_SUBMISSION, private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: "Resolve findings" }, submit: { type: "plain_text", text: "Save" }, close: { type: "plain_text", text: "Cancel" }, blocks,
  };
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
      if (callbackId === CHATGPT_PASTE_SUBMISSION) {
        if (dependencies.chatgptSubmission === undefined) return respond(200, { response_action: "clear" });
        return respond(200, await dependencies.chatgptSubmission(payload));
      }
      if (callbackId !== "agentx_workflow_review_submission" && callbackId !== "agentx_workflow_checks_retry_submission" && callbackId !== "agentx_feedback_review_changes_submission"
        && callbackId !== WORKFLOW_CLOSE_SUBMISSION && callbackId !== WORKFLOW_FINDINGS_SUBMISSION
        && callbackId !== "agentx_task_people_submission" && callbackId !== "agentx_task_take_ownership") return respond(200, { response_action: "clear" });
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
      if (callbackId === "agentx_task_take_ownership") {
        try {
          if (dependencies.workflow === undefined) throw new WorkflowInteractionRefusal("Task People is unavailable.");
          await dependencies.workflow.handleSubmission(payload);
          return respond(200, { response_action: "clear" });
        } catch (error) {
          log("workflow.submission_failed", { errorName: errorName(error) });
          const current = asRecord(payload.view);
          const blocks: unknown[] = Array.isArray(current.blocks) ? current.blocks as unknown[] : [];
          return respond(200, { response_action: "update", view: { ...current,
            blocks: [{ type: "section", text: { type: "mrkdwn", text: error instanceof WorkflowInteractionRefusal ? error.message : "Task ownership changed. Close this form and try again." } }, ...blocks] } });
        }
      }
      if (dependencies.workflow === undefined) {
        log("workflow.submission_failed", { errorName: "WorkflowNotConfigured" });
        return respond(200, { response_action: "errors", errors: { [callbackId === "agentx_feedback_review_changes_submission" ? "feedback_note" : callbackId === "agentx_workflow_checks_retry_submission" ? "workflow_checks"
          : callbackId === WORKFLOW_FINDINGS_SUBMISSION ? firstInputBlock(asRecord(payload.view)) : "workflow_feedback"]: "Workflow approvals are temporarily unavailable. Try again shortly." } });
      }
      try {
        await dependencies.workflow.handleSubmission(payload);
        return respond(200, { response_action: "clear" });
      } catch (error) {
        log("workflow.submission_failed", { errorName: errorName(error) });
        // Each problem with the owner's answers is shown on the input it is about.
        if (error instanceof WorkflowFormErrors) return respond(200, { response_action: "errors", errors: error.errors });
        const field = callbackId === "agentx_feedback_review_changes_submission" ? "feedback_note"
          : callbackId === WORKFLOW_FINDINGS_SUBMISSION ? firstInputBlock(asRecord(payload.view))
          : callbackId === "agentx_task_people_submission" ? "task_person"
          : callbackId === "agentx_workflow_checks_retry_submission" || error instanceof WorkflowCheckSelectionRequired ? checksErrorBlock(asRecord(payload.view)) : "workflow_feedback";
        // A refusal the form can tell (not the owner, another workspace, a step that moved on) reads as itself.
        const message = error instanceof WorkflowCheckSelectionRequired || error instanceof WorkflowInteractionRefusal
          ? error.message
          : callbackId === "agentx_task_people_submission"
            ? "I couldn't save this role. If they are not in the task channel yet, invite them to the task channel in Slack, then return and choose their task role."
            : "I couldn't save this decision. Close this form and try again.";
        return respond(200, { response_action: "errors", errors: { [field]: message } });
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
            : action.actionId === WORKFLOW_PATH_ANSWER_ACTION ? "I couldn't take that choice. Press the button again, or reply `answer`."
            : action.actionId === "agentx_workflow_retry_reviews" ? "I couldn't start the review retry. Use the latest AgentX task update and try again."
            : action.actionId === "agentx_workflow_retry_publish" ? "I couldn't retry opening the pull request. Use the latest AgentX task update and try again."
            : action.actionId === "agentx_workflow_send_back" ? "I couldn't send the task back to coding. Use the latest AgentX task update and try again."
            : action.actionId === "agentx_workflow_resolve_findings" ? "I couldn't open the findings form. Use the latest AgentX task update and try again."
            : action.actionId === "agentx_workflow_retry_plan" || action.actionId === "agentx_workflow_retry_implementation" ? "I couldn't start the retry. Use the latest AgentX task update and try again."
            : action.actionId === "agentx_workflow_close" ? "I couldn't open the close confirmation. Use the latest AgentX task update and try again."
            : action.actionId === "agentx_workflow_keep_pull_requests" ? "I couldn't keep the pull request as it is. Use the latest message in this thread and try again."
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

/**
 * #340: the buttons on a ChatGPT connect answer. Sign in with ChatGPT is a link, and Slack still reports its press;
 * Paste the address opens the form, for a member of the thread's own workspace only.
 */
export function chatGptActionHandler(deps: {
  openView: (triggerId: string, view: Record<string, unknown>, timeoutMs?: number) => Promise<void>;
  respondEphemeral: (responseUrl: string, text: string) => Promise<void>;
}): SlackActionHandler {
  return {
    matches: (actionId) => actionId === CHATGPT_PASTE_ACTION || actionId === CHATGPT_OPEN_ACTION,
    async handle(action) {
      if (action.actionId === CHATGPT_OPEN_ACTION) return;
      if (action.userTeamId !== action.thread.teamId || (action.workspaceTeamId !== "" && action.workspaceTeamId !== action.thread.teamId)) {
        await deps.respondEphemeral(action.responseUrl, "ChatGPT can be connected only by a member of this Slack workspace.");
        return;
      }
      // The answer is ephemeral, so its own timestamp is not the thread's: the button carries the thread.
      const threadTs = SlackMessageTimestampSchema.safeParse(action.value);
      const metadata = { channel: action.thread.channelId, threadTs: threadTs.success ? threadTs.data : action.thread.threadTs };
      await deps.openView(action.triggerId, chatGptPasteModal(metadata), Math.max(500, 2_500 - (Date.now() - action.requestStartedAt)));
    },
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

/** Slack's response_url edit: replaces the message the button is on, for everyone who reads it. */
export async function respondReplace(responseUrl: string, message: { text: string; blocks: Array<Record<string, unknown>> }, fetchImplementation: typeof fetch = fetch): Promise<void> {
  const response = await fetchImplementation(responseUrl, {
    method: "POST",
    signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MILLISECONDS),
    redirect: "error",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ replace_original: true, text: message.text, blocks: message.blocks }),
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
  const brokerReplyErrorCode = (answer: BrokerReply): string | undefined => {
    try {
      const code = asRecord(asRecord(JSON.parse(answer.body ?? "")).error).code;
      return typeof code === "string" ? code : undefined;
    } catch { return undefined; }
  };
  const taskPeopleRefusal = (answer: BrokerReply, fallback: string): WorkflowInteractionRefusal => {
    try {
      const message = asRecord(asRecord(JSON.parse(answer.body ?? "")).error).message;
      return new WorkflowInteractionRefusal(typeof message === "string" && message.length > 0 ? message : fallback);
    } catch { return new WorkflowInteractionRefusal(fallback); }
  };
  const choices = createDynamoWorkflowChoiceStore({ documentClient, tableName: threadsTableName });
  const workflow = stateTableName && brokerFunctionName ? workflowSlackHandlers({
    async loadTask(taskId) {
      const response = await documentClient.send(new GetCommand({ TableName: stateTableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true, ProjectionExpression: "pk, sk, slackUserId, #share, workflow", ExpressionAttributeNames: { "#share": "share" } })) as { Item?: Record<string, unknown> };
      return response.Item;
    },
    async authorize(taskId, userId, thread, taskAction) {
      const answer = await invokeBroker({ source: "agentx.slack-ingress", action: "task-people-authorize", taskId, userId, thread, taskAction }, SLACK_FETCH_TIMEOUT_MILLISECONDS);
      if (answer.statusCode !== 200) throw Object.assign(new Error("task authorization refused"), { code: brokerReplyErrorCode(answer) });
    },
    async getPeople(input) {
      const answer = await invokeBroker({ source: "agentx.slack-ingress", action: "task-people-read", ...input }, SLACK_FETCH_TIMEOUT_MILLISECONDS);
      if (answer.statusCode !== 200) throw new Error("People read refused");
      const parsed = asRecord(JSON.parse(answer.body ?? ""));
      return TaskPeopleViewSchema.parse({ revision: parsed.revision, orphaned: parsed.orphaned, people: parsed.people,
        canManage: parsed.canManage, canTakeOwnership: parsed.canTakeOwnership, addPeopleUrl: parsed.addPeopleUrl });
    },
    async changePeople(input) {
      const answer = await invokeBroker({ source: "agentx.slack-ingress", action: "task-people-change", ...input }, SLACK_FETCH_TIMEOUT_MILLISECONDS);
      if (answer.statusCode !== 200) throw taskPeopleRefusal(answer, "Task access changed before the role could be saved.");
    },
    async takePeopleOwnership(input) {
      const answer = await invokeBroker({ source: "agentx.slack-ingress", action: "task-people-take-ownership", ...input }, SLACK_FETCH_TIMEOUT_MILLISECONDS);
      if (answer.statusCode !== 200) throw taskPeopleRefusal(answer, "Task ownership changed before it could be saved.");
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
    async resolveFindings(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName, { source: "agentx.slack-ingress", action: "workflow-resolve-findings", ...input });
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
    async keepPullRequests(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName, { source: "agentx.slack-ingress", action: "workflow-keep-pull-requests", ...input });
    },
    async submitFeedback(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName, { source: "agentx.slack-ingress", action: "workflow-feedback-findings-decision", ...input });
    },
    async retryFeedbackReview(input) {
      await invokeWorkflowDecision(lambda, brokerFunctionName, { source: "agentx.slack-ingress", action: "workflow-feedback-review-retry", ...input });
    },
    // Gap 3: a task started in Slack is driven from its thread, so none starts where task threads are off.
    // Gap 10h: the choice is taken while Slack waits; the start (a broker call that can outlast Slack's three seconds)
    // runs in an asynchronous invoke of this same Lambda.
    async chooseWorkflowPath(input) {
      if (process.env.SHARED_TASKS !== "enabled") throw new WorkflowInteractionRefusal(SLACK_TASK_THREADS_OFF_NOTICE);
      // The card says "Starting this on ..." at once, before the start is handed over; a start that fails puts it back.
      return handOffChosenWorkflow({ store: choices, handOff: (event) => handOffToSelf(lambda, event), replaceCard: (message) => respondReplace(input.responseUrl, message) }, input);
    },
    // Task 21: queuing for the chat agent is quick (DynamoDB and SQS), so it runs while Slack waits.
    async answerWorkflowChoice(input) {
      if (process.env.SHARED_TASKS !== "enabled") throw new WorkflowInteractionRefusal(SLACK_TASK_THREADS_OFF_NOTICE);
      return answerChosenRequest({ store: choices, enqueueAnswer: createAnswerQueue({ sqs, queueUrl, changePending: threadPendingCounter(documentClient, threadsTableName) }),
        updateQuestion: async (question) => slackApi((await secrets()).botToken, "chat.update", question) }, input);
    },
    respondEphemeral: (responseUrl, text) => respondEphemeral(responseUrl, text),
  }) : undefined;
  // The handed-off start runs inside this Lambda's own 10 seconds: a broker that has not answered in 7 is given up on,
  // so the member is still told (the broker's start is idempotent, so a later press meets the same task).
  const chosenStart = (event: HandedOffWorkflowStart) => runHandedOffWorkflowStart({
    store: choices, startWorkflow: (start) => startWorkflowThroughBroker((brokerEvent) => invokeBroker(brokerEvent, HANDED_OFF_START_TIMEOUT_MS), start),
    updateQuestion: async (input) => slackApi((await secrets()).botToken, "chat.update", input),
    respondEphemeral: (responseUrl, text) => respondEphemeral(responseUrl, text),
    replaceCard: (responseUrl, message) => respondReplace(responseUrl, message),
  }, event);
  const openView = async (triggerId: string, view: Record<string, unknown>, timeoutMs?: number) => {
    await slackApi((await secrets()).botToken, "views.open", { trigger_id: triggerId, view }, fetch, timeoutMs);
  };
  // #340: finishing a ChatGPT connection can outlast Slack's three seconds, so it runs in an asynchronous invoke of
  // this same Lambda, which has the rest of its own timeout for the broker.
  const chatgptFinish = (event: HandedOffChatGptFinish) => runHandedOffChatGptFinish({
    finish: (input) => invokeBroker({ source: "agentx.slack-ingress", action: "chatgpt-finish", ...input }, HANDED_OFF_START_TIMEOUT_MS),
    updateView: async (viewId, view) => slackApi((await secrets()).botToken, "views.update", { view_id: viewId, view }, fetch, 5_000),
    postEphemeral: async (input) => chatPostEphemeral((await secrets()).botToken, input),
    log,
  }, event);
  const interactivity = createSlackInteractivityHandler({
    secrets,
    log,
    ...(brokerFunctionName === undefined ? {} : {
      chatgptSubmission: (payload: Record<string, unknown>) => chatGptSubmission({ handOff: (event) => handOffToSelf(lambda, event) }, payload),
    }),
    ...(adminChange === undefined ? {} : { adminChange }),
    ...(workflow === undefined ? {} : { workflow }),
    // The module's own respondEphemeral, for a button no handler knows.
    respondEphemeral,
    handlers: [chatGptActionHandler({ openView, respondEphemeral: (responseUrl, text) => respondEphemeral(responseUrl, text) }), confirmationActionHandler({
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
  return async (event: HttpApiV2Event | HandedOffWorkflowStart | HandedOffChatGptFinish): Promise<HttpResponse> => {
    if (isHandedOffWorkflowStart(event)) {
      const outcome = await chosenStart(event);
      log("workflow.handed_off_start", { outcome });
      return respond(200, { outcome });
    }
    if (isHandedOffChatGptFinish(event)) return respond(200, { outcome: await chatgptFinish(event) });
    return interactivity(event);
  };
}

/** How long a handed-off Quick or Full start waits for the broker, inside the ingress Lambda's 10-second timeout. */
const HANDED_OFF_START_TIMEOUT_MS = 7_000;

/** This Lambda's own name, as Lambda sets it; a Quick or Full start is handed to an asynchronous invoke of it. */
async function handOffToSelf(lambda: LambdaClient, event: HandedOffWorkflowStart | HandedOffChatGptFinish): Promise<void> {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (functionName === undefined) throw new Error("AWS_LAMBDA_FUNCTION_NAME is not set");
  const response = await lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(event)) }));
  if (response.StatusCode !== 202) throw Object.assign(new Error("the start was not handed over"), { name: "StartHandOffRefused" });
}

interface WorkflowActionValue { taskId: string; revision: number; digest: string; decision: "APPROVE" | "REQUEST_CHANGES"; workBreakdownDigest?: string }

class WorkflowInteractionRefusal extends Error {
  constructor(message: string) { super(message); this.name = "WorkflowInteractionRefusal"; }
}

/** Shown in place of the close confirmation when the close was refused, so the owner reads why. */
function closeRefusedView(message: string): Record<string, unknown> {
  return { type: "modal", title: { type: "plain_text", text: "Close this task" }, close: { type: "plain_text", text: "Done" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: message } }] };
}

const STALE_WORKFLOW_BUTTON = WORKFLOW_BUTTON_OUT_OF_DATE;

/** Said in place of the close when an approved fix started after the owner opened the close form. */
const CLOSE_AFTER_FIX_STARTED = "An approved fix started after you opened this, and closing now would discard it. Close this form and press Close task again if you still want to close.";

const OPEN_PULL_REQUEST = new Set(["OPEN", "UNKNOWN"]);

/** "PR #3", or "PRs #3 and #4" (and "PRs #3, #4 and #5"). */
function pullRequestNumbers(pullRequests: ReadonlyArray<{ number: number }>): string {
  const numbers = [...pullRequests].map((pullRequest) => pullRequest.number).sort((left, right) => left - right);
  if (numbers.length === 1) return `PR #${numbers[0]}`;
  return `PRs ${numbers.slice(0, -1).map((number) => `#${number}`).join(", ")} and #${numbers.at(-1)}`;
}

/**
 * Whether closing would discard an approved PR feedback fix that isn't on the open pull requests yet: it is being made,
 * checked, reviewed or pushed, its push failed, or the reviewed code differs from what a pull request holds. A fix that
 * changed nothing has nothing to discard.
 */
function approvedFixNotOnPullRequests(workflow: WorkflowSnapshot): boolean {
  const open = (workflow.pullRequests ?? []).filter((pullRequest) => OPEN_PULL_REQUEST.has(pullRequest.state));
  if (open.length === 0 || workflow.blockReason === WORKFLOW_BLOCK_REASONS.fixChangedNothing) return false;
  return ["IMPLEMENT", "VERIFY", "REVIEW", "PULL_REQUEST"].includes(workflow.stage)
    || workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed
    || (workflow.candidate !== undefined && open.some((pullRequest) => pullRequest.candidateDigest !== workflow.candidate?.digest));
}

/** What the close form says closing does: what is discarded, and what becomes of each pull request on GitHub. */
export function closeConfirmationText(workflow: WorkflowSnapshot): string {
  const pullRequests = (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.required);
  const lines = ["Closing stops this task and releases its workspace."];
  if (pullRequests.length === 0) return [...lines, "Code that isn't in a pull request is discarded."].join(" ");
  const open = pullRequests.filter((pullRequest) => OPEN_PULL_REQUEST.has(pullRequest.state));
  const closed = pullRequests.filter((pullRequest) => pullRequest.state === "CLOSED");
  const merged = pullRequests.filter((pullRequest) => pullRequest.state === "MERGED");
  lines.push(approvedFixNotOnPullRequests(workflow) ? `The approved fix that isn't on ${pullRequestNumbers(open)} yet is discarded.` : "Code that isn't in a pull request is discarded.");
  if (open.length > 0) lines.push(`${pullRequestNumbers(open)} ${open.length === 1 ? "stays" : "stay"} open on GitHub.`);
  if (closed.length > 0) lines.push(`${pullRequestNumbers(closed)} ${closed.length === 1 ? "stays" : "stay"} closed on GitHub.`);
  if (merged.length > 0) lines.push(`${pullRequestNumbers(merged)} ${merged.length === 1 ? "is" : "are"} already merged.`);
  return lines.join(" ");
}

const CHOICE_NOT_WAITING = workflowChoiceRefusal("none");

function workflowActionValue(value: string): WorkflowActionValue | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.taskId !== "string" || !CHANGE_ID.test(parsed.taskId) || !Number.isInteger(parsed.revision)
      || typeof parsed.digest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.digest)
      || (parsed.decision !== "APPROVE" && parsed.decision !== "REQUEST_CHANGES")
      || (parsed.workBreakdownDigest !== undefined && (typeof parsed.workBreakdownDigest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.workBreakdownDigest)))) return undefined;
    return { taskId: parsed.taskId, revision: parsed.revision as number, digest: parsed.digest, decision: parsed.decision,
      ...(typeof parsed.workBreakdownDigest === "string" ? { workBreakdownDigest: parsed.workBreakdownDigest } : {}) };
  } catch { return undefined; }
}

/**
 * The card a PR feedback button sits on. `ANSWER` is the Request changes button of a card whose reviewer left a question
 * to the owner: the owner's words approve the fix (with any recommended ones), so they are coded rather than kept.
 */
interface FeedbackReviewActionValue {
  taskId: string; expectedRevision: number; reviewDigest: string; proposalDigest: string; bundleSetDigest: string; selection: "RECOMMENDED" | "ANSWER";
  /** ANSWER only: the findings whose questions the card showed (one to three), and so the only ones the answer decides. */
  findingIds?: string[];
}

function feedbackReviewActionValue(value: string): FeedbackReviewActionValue | undefined {
  try {
    const parsed = asRecord(JSON.parse(value));
    if (typeof parsed.taskId !== "string" || !CHANGE_ID.test(parsed.taskId) || typeof parsed.expectedRevision !== "number" || !Number.isInteger(parsed.expectedRevision)
      || typeof parsed.reviewDigest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.reviewDigest)
      || typeof parsed.proposalDigest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.proposalDigest)
      || typeof parsed.bundleSetDigest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.bundleSetDigest)
      || (parsed.selection !== "RECOMMENDED" && parsed.selection !== "ANSWER")) return undefined;
    const findingIds = parsed.findingIds;
    if (parsed.selection === "RECOMMENDED") {
      if (findingIds !== undefined) return undefined;
      return { taskId: parsed.taskId, expectedRevision: parsed.expectedRevision, reviewDigest: parsed.reviewDigest, proposalDigest: parsed.proposalDigest, bundleSetDigest: parsed.bundleSetDigest, selection: "RECOMMENDED" };
    }
    if (!Array.isArray(findingIds) || findingIds.length < 1 || findingIds.length > 3 || new Set(findingIds).size !== findingIds.length
      || !findingIds.every((id): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 128)) return undefined;
    return { taskId: parsed.taskId, expectedRevision: parsed.expectedRevision, reviewDigest: parsed.reviewDigest, proposalDigest: parsed.proposalDigest, bundleSetDigest: parsed.bundleSetDigest, selection: "ANSWER", findingIds };
  } catch { return undefined; }
}

/** The task, revision and code a Resolve findings button or its form names, or undefined when any is missing or malformed. */
function resolveFindingsTarget(value: string): { taskId: string; revision: number; candidateDigest: string } | undefined {
  try {
    const parsed = asRecord(JSON.parse(value));
    if (typeof parsed.taskId !== "string" || !CHANGE_ID.test(parsed.taskId) || typeof parsed.revision !== "number" || !Number.isInteger(parsed.revision)
      || typeof parsed.candidateDigest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.candidateDigest)) return undefined;
    return { taskId: parsed.taskId, revision: parsed.revision, candidateDigest: parsed.candidateDigest };
  } catch { return undefined; }
}

function slackActionRequestId(action: SlackBlockAction): string {
  const digest = createHash("sha256").update(`${action.thread.teamId}/${action.thread.channelId}/${action.messageTs}/${action.actionTs ?? action.messageTs}/${action.actionId}`, "utf8").digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

const SLACK_SECTION_TEXT_LIMIT = 3000;
const SLACK_MODAL_BLOCK_LIMIT = 100;

function taskPeopleListSections(people: TaskPeopleView["people"]): string[] {
  if (people.length === 0) return ["No people are available."];
  const sections: string[] = [];
  let lines: string[] = [];
  let length = 0;
  for (const person of people) {
    const line = `${person.you ? "You" : cleanLine(person.name, 80)} — ${person.role}`;
    if (line.length > SLACK_SECTION_TEXT_LIMIT) throw new WorkflowInteractionRefusal("A task People entry cannot fit in a Slack section.");
    const separatorLength = lines.length === 0 ? 0 : 1;
    if (length + separatorLength + line.length > SLACK_SECTION_TEXT_LIMIT) {
      sections.push(lines.join("\n"));
      lines = [];
      length = 0;
    }
    length += (lines.length === 0 ? 0 : 1) + line.length;
    lines.push(line);
  }
  if (lines.length > 0) sections.push(lines.join("\n"));
  return sections;
}

export function workflowSlackHandlers(deps: {
  loadTask(taskId: string): Promise<Record<string, unknown> | undefined>;
  openView(triggerId: string, view: Record<string, unknown>): Promise<void>;
  submit(input: Record<string, unknown>): Promise<void>;
  retryChecks?(input: Record<string, unknown>): Promise<void>;
  retryReviews?(input: Record<string, unknown>): Promise<void>;
  retryPublication?(input: Record<string, unknown>): Promise<void>;
  submitFeedback?(input: Record<string, unknown>): Promise<void>;
  /** Retry review on a failed PR feedback review: the same comments are reviewed again. */
  retryFeedbackReview?(input: Record<string, unknown>): Promise<void>;
  /** Task 16: Send back to coding, with the problems found as the coder's instructions. */
  sendBack?(input: Record<string, unknown>): Promise<void>;
  /** The owner's answer to each blocking review finding (Fix or Accept, with a note), handed to the broker. */
  resolveFindings?(input: Record<string, unknown>): Promise<void>;
  /** Task 16: retry blocked planning. */
  retryPlan?(input: Record<string, unknown>): Promise<void>;
  /** Task 16: retry blocked coding on the approved plan. */
  retryImplementation?(input: Record<string, unknown>): Promise<void>;
  /** Task 16: close the task after the owner confirmed it in the modal. */
  close?(input: Record<string, unknown>): Promise<void>;
  /** Keep the pull request as it is after an approved fix changed nothing: the task waits for the merge again. */
  keepPullRequests?(input: Record<string, unknown>): Promise<void>;
  /** Gap 3: starts the request waiting in the thread on the path its requester clicked. A refused start throws SlackWorkflowStartError. */
  /**
   * Starts the request waiting in the thread on the path its requester clicked, or hands that start over (the AWS
   * wiring); "started" means it started or is on its way. A refused start throws SlackWorkflowStartError. `messageTs` is
   * the question's own message; its card reads "Starting this on ..." from the press on (through `responseUrl`) and gets
   * its buttons back if the start fails.
   */
  chooseWorkflowPath?(input: { thread: SlackThread; userId: string; workflowPath: WorkflowPath; choiceId: string; responseUrl: string; messageTs: string }): Promise<WorkflowChoiceOutcome>;
  /**
   * Task 21: "Just answer" on a routed card: the request waiting in the thread goes to the chat agent instead, and the
   * card loses its buttons. "started" means it is queued; only the requester's press counts.
   */
  answerWorkflowChoice?(input: { thread: SlackThread; userId: string; choiceId: string; messageTs: string }): Promise<WorkflowChoiceOutcome>;
  /** Answers the member who pressed a button, privately (Slack's response_url). */
  respondEphemeral?(responseUrl: string, text: string): Promise<void>;
  authorize?(taskId: string, userId: string, thread: SlackThread, action: "decide" | "retry" | "publish" | "feedback" | "close" | "control"): Promise<void>;
  getPeople?(input: { taskId: string; userId: string; thread: SlackThread }): Promise<TaskPeopleView>;
  changePeople?(input: { taskId: string; requestId: string; expectedPeopleRevision: number; slackUserId: string; role: "owner" | "commenter" | "viewer" | "denied"; userId: string; thread: SlackThread }): Promise<void>;
  takePeopleOwnership?(input: { taskId: string; requestId: string; expectedPeopleRevision: number; userId: string; thread: SlackThread }): Promise<void>;
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
  const requireOwnerAction = async (task: Record<string, unknown>, taskId: string, userId: string, thread: SlackThread,
    action: "decide" | "retry" | "publish" | "feedback" | "close" | "control", legacyMessage: string, mention = true): Promise<void> => {
    if (deps.authorize !== undefined) {
      try { await deps.authorize(taskId, userId, thread, action); } catch (error) {
        // Only a definite "not yours", "no such task" or "no access" answer is the owner's message; anything else (a broker fault, a timeout, a malformed reply)
        // says nothing about the member, so it is logged with its code and answered as a retryable failure.
        const code = authorizationErrorCode(error);
        console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.authorize_failed", taskId, action, code: code ?? "UNKNOWN", errorName: errorName(error) }));
        throw new WorkflowInteractionRefusal(code !== undefined && DEFINITE_ACCESS_REFUSALS.has(code) ? legacyMessage : AUTHORIZATION_UNAVAILABLE_TEXT);
      }
      return;
    }
    if (task.slackUserId !== userId) {
      const owner = SlackUserIdSchema.safeParse(task.slackUserId);
      throw new WorkflowInteractionRefusal(mention && owner.success ? legacyMessage.replace("the task owner", `<@${owner.data}>`) : legacyMessage);
    }
  };
  const currentFeedbackReview = async (value: FeedbackReviewActionValue, userId: string, userTeamId: string, workspaceTeamId: string, thread: SlackThread) => {
    const task = await deps.loadTask(value.taskId);
    if (!task) throw new WorkflowInteractionRefusal(WORKFLOW_BUTTON_OUT_OF_DATE);
    await requireOwnerAction(task, value.taskId, userId, thread, "feedback", "Only the task owner can decide this PR feedback.");
    const share = asRecord(task.share);
    if (workspaceTeamId !== thread.teamId || userTeamId !== thread.teamId || share.teamId !== thread.teamId
      || share.channelId !== thread.channelId || share.threadTs !== thread.threadTs) throw new WorkflowInteractionRefusal("This PR feedback belongs to another Slack workspace or thread.");
    const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
    const review = parsed.success ? parsed.data.feedbackReview : undefined;
    const bundleDigests = review?.bundleRefs.map(bundle => bundle.sha256) ?? [];
    const bundleSetDigest = createHash("sha256").update(JSON.stringify(bundleDigests), "utf8").digest("hex");
    // The task moved past PR feedback (its pull request merged, or it closed): the card is just old.
    if (task.closedAt !== undefined || (parsed.success && (parsed.data.stage === "MERGED" || parsed.data.stage === "CLOSED"))) {
      throw new WorkflowInteractionRefusal(WORKFLOW_BUTTON_OUT_OF_DATE);
    }
    if (!parsed.success || parsed.data.revision !== value.expectedRevision || parsed.data.stage !== "WAIT_FOR_MERGE"
      || parsed.data.state !== "WAITING" || review?.status !== "PENDING" || review.reviewRef.status !== "COMPLETE"
      || review.reviewRef.sha256 !== value.reviewDigest || review.reviewRef.proposalDigest !== value.proposalDigest
      || bundleSetDigest !== value.bundleSetDigest) throw new WorkflowInteractionRefusal("This review changed. Reopen the AgentX review details.");
    return { task, workflow: parsed.data, bundleDigests };
  };
  /**
   * The owner's task, decided from its own thread, by a member of the task's own Slack workspace pressing there (a
   * Slack Connect member from another organization is refused, as on every sibling button); its snapshot, whatever
   * its stage.
   */
  const loadOwnedThreadTask = async (value: WorkflowActionValue, who: { userId: string; userTeamId: string; workspaceTeamId: string }, thread: SlackThread) => {
    sameWorkspace(who.userTeamId, who.workspaceTeamId, thread, "This approval must be used from the task's AgentX workspace.");
    const task = await deps.loadTask(value.taskId);
    if (!task) throw new WorkflowInteractionRefusal(WORKFLOW_APPROVAL_OUT_OF_DATE);
    await requireOwnerAction(task, value.taskId, who.userId, thread, "decide", "Only the task owner can approve this step.");
    const share = asRecord(task.share);
    if (share.teamId !== thread.teamId || share.channelId !== thread.channelId || share.threadTs !== thread.threadTs) throw new WorkflowInteractionRefusal("This approval belongs to another Slack thread.");
    const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
    if (!parsed.success) throw new WorkflowInteractionRefusal(WORKFLOW_APPROVAL_OUT_OF_DATE);
    return { task, workflow: parsed.data };
  };
  /** The step `value` approves is still the one waiting: same revision, same document. */
  const reviewStillWaiting = (value: WorkflowActionValue, workflow: WorkflowSnapshot): void => {
    if (workflow.revision !== value.revision || workflow.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") throw new WorkflowInteractionRefusal(WORKFLOW_APPROVAL_OUT_OF_DATE);
    const artifactType = workflow.path === "FULL" && workflow.reviewPhase === "REQUIREMENTS" ? "requirements"
      : workflow.path === "FULL" && workflow.reviewPhase === "DESIGN" ? "design" : "plan";
    const plan = workflow.artifacts.filter((artifact) => artifact.type === artifactType).at(-1);
    if (!plan || plan.sha256 !== value.digest) throw new WorkflowInteractionRefusal(WORKFLOW_APPROVAL_OUT_OF_DATE);
  };
  /**
   * Hands the owner's decision on the step `value` names to the broker, from the form or from a one-click Approve. Its
   * request ID is derived from the decision itself, so the same decision pressed or submitted again is the same request.
   * Answers false when this exact decision is already saved (a resubmission after a slow save): nothing is sent, before
   * any check that the step is still waiting, which it no longer is.
   */
  const submitDecision = async (value: WorkflowActionValue, userId: string, thread: SlackThread, workflow: WorkflowSnapshot,
    reason: string, chosenOptionalCheckIds: string[]): Promise<boolean> => {
    // One canonical order for both the request ID and the submitted decision, so the same selection made in another
    // order is the same decision rather than a replay mismatch.
    const selectedOptionalCheckIds = [...chosenOptionalCheckIds].sort();
    const requestId = workflowDecisionRequestId({ taskId: value.taskId, revision: value.revision, digest: value.digest, decision: value.decision, reason, selectedOptionalCheckIds,
      ...(value.workBreakdownDigest === undefined ? {} : { workBreakdownDigest: value.workBreakdownDigest }) });
    if (workflow.decisions.some((decision) => decision.requestId === requestId)) {
      console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.decision_replayed", taskId: value.taskId, requestId }));
      return false;
    }
    reviewStillWaiting(value, workflow);
    await deps.submit({
      taskId: value.taskId, userId, thread,
      expectedRevision: value.revision, artifactDigest: value.digest, decision: value.decision,
      ...(value.decision === "APPROVE" && value.workBreakdownDigest !== undefined ? { workBreakdownDigest: value.workBreakdownDigest } : {}),
      reason, selectedOptionalCheckIds, requestId,
    });
    return true;
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
    if (!task) throw new WorkflowInteractionRefusal(STALE_WORKFLOW_BUTTON);
    await requireOwnerAction(task, input.taskId, input.userId, input.thread, "control", `Only the task owner can ${what}.`);
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
    if (!task) throw new WorkflowInteractionRefusal("This verification retry is no longer available.");
    await requireOwnerAction(task, taskId, userId, thread, "retry", "Only the task owner can retry verification.");
    const share = asRecord(task.share);
    if (share.teamId !== thread.teamId || share.channelId !== thread.channelId || share.threadTs !== thread.threadTs) {
      throw new WorkflowInteractionRefusal("This verification retry belongs to another Slack thread.");
    }
    const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
    // Task 16: also Run checks again on a change ready to publish whose code changed after its checks.
    if (!parsed.success || parsed.data.revision !== revision || !((parsed.data.stage === "VERIFY" && parsed.data.state === "BLOCKED")
      || (workflowPublicationRetryable(parsed.data) && (parsed.data.pullRequests?.length ?? 0) === 0))) {
      throw new WorkflowInteractionRefusal(WORKFLOW_BUTTON_OUT_OF_DATE);
    }
    return { task, workflow: parsed.data };
  };
  const currentReviewRetry = async (taskId: string, revision: number, candidateDigest: string, userId: string, thread: SlackThread) => {
    const task = await deps.loadTask(taskId);
    if (!task) throw new WorkflowInteractionRefusal("This review retry is no longer available.");
    await requireOwnerAction(task, taskId, userId, thread, "retry", "Only the task owner can retry reviews.");
    const share = asRecord(task.share);
    if (share.teamId !== thread.teamId || share.channelId !== thread.channelId || share.threadTs !== thread.threadTs) {
      throw new WorkflowInteractionRefusal("This review retry belongs to another Slack thread.");
    }
    const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
    if (!parsed.success || parsed.data.revision !== revision || parsed.data.stage !== "REVIEW" || parsed.data.state !== "BLOCKED"
      || parsed.data.candidate?.digest !== candidateDigest || parsed.data.verification?.candidateDigest !== candidateDigest
      || !parsed.data.verification.results.every((result) => result.status === "PASS")) {
      throw new WorkflowInteractionRefusal(WORKFLOW_BUTTON_OUT_OF_DATE);
    }
    return parsed.data;
  };
  return {
    async handleAction(action: SlackBlockAction) {
      if (action.actionId === "agentx_task_people") {
        let value: Record<string, unknown>;
        try { value = asRecord(JSON.parse(action.value)); } catch { throw new WorkflowInteractionRefusal(STALE_WORKFLOW_BUTTON); }
        if (typeof value.taskId !== "string" || !CHANGE_ID.test(value.taskId) || action.triggerId === "") throw new WorkflowInteractionRefusal(STALE_WORKFLOW_BUTTON);
        sameWorkspace(action.userTeamId, action.workspaceTeamId, action.thread, "This People form belongs to another Slack workspace.");
        if (deps.getPeople === undefined) throw new WorkflowInteractionRefusal("Task People is unavailable.");
        let people: TaskPeopleView;
        try { people = await deps.getPeople({ taskId: value.taskId, userId: action.userId, thread: action.thread }); }
        catch { throw new WorkflowInteractionRefusal("Task People is unavailable."); }
        const metadata = JSON.stringify({ taskId: value.taskId, expectedPeopleRevision: people.revision, requestId: slackActionRequestId(action), thread: action.thread });
        const listBlocks = taskPeopleListSections(people.people).map((text) => ({ type: "section", text: { type: "mrkdwn", text } }));
        if (people.canTakeOwnership && !people.canManage) {
          const blocks = [...listBlocks, { type: "section", text: { type: "mrkdwn", text: "This task has no current owner. Taking ownership does not restart it." } }];
          if (blocks.length > SLACK_MODAL_BLOCK_LIMIT) throw new WorkflowInteractionRefusal("The complete task People list is too large to open in Slack.");
          await deps.openView(action.triggerId, { type: "modal", callback_id: "agentx_task_take_ownership", private_metadata: metadata,
            title: { type: "plain_text", text: "Task people" }, submit: { type: "plain_text", text: "Take ownership" }, close: { type: "plain_text", text: "Cancel" },
            blocks });
          return;
        }
        const blocks: Array<Record<string, unknown>> = [...listBlocks];
        if (people.canManage) blocks.push(
          { type: "context", elements: [{ type: "mrkdwn", text: "Invite them to this task channel in Slack, then return and choose their task role." }] },
          { type: "input", block_id: "task_person", label: { type: "plain_text", text: "Person" }, element: { type: "users_select", action_id: "person", placeholder: { type: "plain_text", text: "Choose a person" } } },
          { type: "input", block_id: "task_role", label: { type: "plain_text", text: "Role" }, element: { type: "static_select", action_id: "role", options: [
            { text: { type: "plain_text", text: "Owner" }, value: "owner" },
            { text: { type: "plain_text", text: "Commenter" }, value: "commenter" },
            { text: { type: "plain_text", text: "Viewer" }, value: "viewer" },
            { text: { type: "plain_text", text: "Remove access" }, value: "denied" },
          ] } },
        );
        if (blocks.length > SLACK_MODAL_BLOCK_LIMIT) throw new WorkflowInteractionRefusal("The complete task People list is too large to open in Slack.");
        await deps.openView(action.triggerId, { type: "modal", callback_id: "agentx_task_people_submission", private_metadata: metadata,
          title: { type: "plain_text", text: "Task people" }, ...(people.canManage ? { submit: { type: "plain_text", text: "Save role" } } : {}),
          close: { type: "plain_text", text: "Close" }, blocks });
        return;
      }
      if (action.actionId === WORKFLOW_PATH_ANSWER_ACTION) {
        let choiceId: unknown;
        try { choiceId = asRecord(JSON.parse(action.value)).choiceId; } catch { choiceId = undefined; }
        if (typeof choiceId !== "string" || !CHANGE_ID.test(choiceId)) throw new WorkflowInteractionRefusal(CHOICE_NOT_WAITING);
        if (deps.answerWorkflowChoice === undefined) throw new Error("Just answer is not configured");
        const outcome = await deps.answerWorkflowChoice({ thread: action.thread, userId: action.userId, choiceId, messageTs: action.messageTs });
        if (outcome !== "started") throw new WorkflowInteractionRefusal(workflowChoiceRefusal(outcome));
        // The card already says so; the chat agent's reply is the answer.
        return;
      }
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
        // The card already reads "Starting this on ..." with no buttons (the choice took it before handing the start
        // over); the start marks it answered, and a start that fails puts the question back with its buttons.
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
        const modalBlocks = workflowCheckControls(workflow.checkPolicy, { codingPlan: true, retry: true });
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
      if (action.actionId === "agentx_workflow_resolve_findings") {
        const target = resolveFindingsTarget(action.value);
        if (target === undefined || action.triggerId === "") throw new WorkflowInteractionRefusal(WORKFLOW_BUTTON_OUT_OF_DATE);
        const workflow = await currentOwnedWorkflow({ ...action, taskId: target.taskId, revision: target.revision }, "resolve these findings",
          (current) => current.candidate?.digest === target.candidateDigest && workflowResolveFindingsOffered(current));
        const open = openReviewFindings(workflow);
        if (open.length > WORKFLOW_RESOLVE_FINDINGS_MAX) {
          throw new WorkflowInteractionRefusal(`This change has more than ${WORKFLOW_RESOLVE_FINDINGS_MAX} open findings, which is too many to resolve here. Send it back to coding instead.`);
        }
        // The form carries what its submission is checked against, and a request ID that stays the same for this one press.
        await deps.openView(action.triggerId, workflowFindingsModal(open, { taskId: target.taskId, revision: workflow.revision, candidateDigest: target.candidateDigest,
          requestId: slackActionRequestId(action), thread: action.thread, responseUrl: action.responseUrl }));
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
        await deps.openView(action.triggerId, {
          type: "modal", callback_id: WORKFLOW_CLOSE_SUBMISSION,
          // The press's response_url rides along, so the confirmed close can be acknowledged at once. The step the owner
          // read, and whether an approved fix was under way then, are checked again when the close is confirmed.
          private_metadata: JSON.stringify({ taskId, requestId: slackActionRequestId(action), thread: action.thread, responseUrl: action.responseUrl,
            revision: workflow.revision, fixPending: approvedFixNotOnPullRequests(workflow) }),
          title: { type: "plain_text", text: "Close this task" }, submit: { type: "plain_text", text: "Close task" }, close: { type: "plain_text", text: "Cancel" },
          blocks: [{ type: "section", text: { type: "mrkdwn", text: closeConfirmationText(workflow) } }],
        });
        return;
      }
      if (action.actionId === "agentx_workflow_keep_pull_requests") {
        const { taskId, revision } = exitButton(action);
        const workflow = await currentOwnedWorkflow({ ...action, taskId, revision }, "keep the pull request as it is", workflowKeepPullRequestsOffered);
        if (deps.keepPullRequests === undefined) throw new Error("keeping the pull request is not configured");
        // The thread's next post says the task waits for the merge again, so nothing is said privately as well.
        await deps.keepPullRequests({ taskId, userId: action.userId, thread: action.thread, expectedRevision: workflow.revision, requestId: slackActionRequestId(action) });
        return;
      }
      if (action.actionId === "agentx_workflow_retry_publish") {
        let retry: Record<string, unknown>;
        try { retry = asRecord(JSON.parse(action.value)); } catch { throw new WorkflowInteractionRefusal("This retry is no longer available."); }
        const taskId = typeof retry.taskId === "string" && CHANGE_ID.test(retry.taskId) ? retry.taskId : undefined;
        if (taskId === undefined || !Number.isInteger(retry.revision)) throw new WorkflowInteractionRefusal("This retry is no longer available.");
        if (action.workspaceTeamId !== action.thread.teamId || action.userTeamId !== action.thread.teamId) throw new WorkflowInteractionRefusal("This retry must be used from the task's AgentX workspace.");
        const task = await deps.loadTask(taskId);
        if (!task) throw new WorkflowInteractionRefusal("This retry is no longer available.");
        await requireOwnerAction(task, taskId, action.userId, action.thread, "publish", "Only the task owner can retry opening the pull request.", false);
        const share = asRecord(task.share);
        if (share.teamId !== action.thread.teamId || share.channelId !== action.thread.channelId || share.threadTs !== action.thread.threadTs) {
          throw new WorkflowInteractionRefusal("This retry belongs to another Slack thread.");
        }
        const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
        if (!parsed.success || parsed.data.revision !== Number(retry.revision) || !workflowPublicationRetryable(parsed.data)) {
          throw new WorkflowInteractionRefusal(WORKFLOW_BUTTON_OUT_OF_DATE);
        }
        if (deps.retryPublication === undefined) throw new Error("pull request retry is not configured");
        await deps.retryPublication({ taskId, userId: action.userId, thread: action.thread, requestId: slackActionRequestId(action), expectedRevision: parsed.data.revision });
        await acknowledged(action, "Opening the draft pull request again.");
        return;
      }
      if (action.actionId === FEEDBACK_REVIEW_RETRY_ACTION) {
        let retry: Record<string, unknown>;
        try { retry = asRecord(JSON.parse(action.value)); } catch { throw new WorkflowInteractionRefusal(FEEDBACK_REVIEW_CHANGED); }
        const taskId = typeof retry.taskId === "string" && CHANGE_ID.test(retry.taskId) ? retry.taskId : undefined;
        const reviewDigest = typeof retry.reviewDigest === "string" && /^[a-f0-9]{64}$/.test(retry.reviewDigest) ? retry.reviewDigest : undefined;
        if (taskId === undefined || reviewDigest === undefined) throw new WorkflowInteractionRefusal(FEEDBACK_REVIEW_CHANGED);
        sameWorkspace(action.userTeamId, action.workspaceTeamId, action.thread, "This review belongs to another Slack workspace or thread.");
        const task = await deps.loadTask(taskId);
        if (!task) throw new WorkflowInteractionRefusal("This review retry is no longer available.");
        await requireOwnerAction(task, taskId, action.userId, action.thread, "feedback", "Only the task owner can retry this review.");
        const share = asRecord(task.share);
        if (share.teamId !== action.thread.teamId || share.channelId !== action.thread.channelId || share.threadTs !== action.thread.threadTs) {
          throw new WorkflowInteractionRefusal("This review belongs to another Slack workspace or thread.");
        }
        const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
        const workflow = parsed.success ? parsed.data : undefined;
        const review = workflow?.feedbackReview;
        const retried = review?.status === "COLLECTING" && workflow?.feedbackReviewHistory?.some((ref) => ref.sha256 === reviewDigest && ref.status !== "COMPLETE");
        // An earlier press already started the retried review: nothing more to do.
        if (retried && workflow?.state === "RUNNING") {
          await acknowledged(action, "Already reviewing the feedback again.");
          return;
        }
        // Bound by the report itself (failed, timed out or interrupted), which no later change reuses; the card's step is
        // carried for the record. A retry still waiting to start goes to the broker too, which starts it.
        if (!retried && (workflow?.stage !== "WAIT_FOR_MERGE" || workflow.state !== "WAITING" || review?.status !== "PENDING"
          || review.reviewRef.status === "COMPLETE" || review.reviewRef.sha256 !== reviewDigest)) throw new WorkflowInteractionRefusal(FEEDBACK_REVIEW_CHANGED);
        if (deps.retryFeedbackReview === undefined) throw new Error("retrying the PR feedback review is not configured");
        // Only the broker knows whether the review started: it tells the owner privately then, or why not.
        await deps.retryFeedbackReview({ taskId, userId: action.userId, thread: action.thread, requestId: slackActionRequestId(action), reviewDigest });
        return;
      }
      if (action.actionId === "agentx_feedback_review_recommended" || action.actionId === "agentx_feedback_review_changes" || action.actionId === "agentx_feedback_review_dismiss") {
        const value = feedbackReviewActionValue(action.value);
        if (!value || action.triggerId === "" || (action.actionId !== "agentx_feedback_review_changes" && value.selection !== "RECOMMENDED")) {
          throw new WorkflowInteractionRefusal("This review action is no longer available. Reopen the AgentX review details.");
        }
        const { bundleDigests } = await currentFeedbackReview(value, action.userId, action.userTeamId, action.workspaceTeamId, action.thread);
        const requestId = slackActionRequestId(action);
        if (deps.submitFeedback === undefined) throw new Error("PR feedback decisions are not configured");
        const decided = { taskId: value.taskId, userId: action.userId, thread: action.thread, requestId,
          expectedRevision: value.expectedRevision, reviewDigest: value.reviewDigest, proposalDigest: value.proposalDigest,
          // The broker checks the review it decides on by the same bundle set digest the card carries.
          bundleDigests, bundleSetDigest: value.bundleSetDigest, selection: "RECOMMENDED" };
        if (action.actionId === "agentx_feedback_review_recommended") {
          await deps.submitFeedback({ ...decided, decision: "APPROVE" });
          await acknowledged(action, "Working on the recommended fixes.");
          return;
        }
        if (action.actionId === "agentx_feedback_review_dismiss") {
          // Nothing to ask: a dismissal changes no code, and the pull request stays as it is. The thread's next post says
          // so, so nothing is said privately as well.
          await deps.submitFeedback({ ...decided, decision: "DISMISS", ownerNote: "Dismissed in Slack." });
          return;
        }
        const answering = value.selection === "ANSWER";
        await deps.openView(action.triggerId, {
          type: "modal", callback_id: "agentx_feedback_review_changes_submission",
          private_metadata: JSON.stringify({ ...value, bundleDigests, requestId, thread: action.thread }),
          title: { type: "plain_text", text: answering ? "Answer the reviewer" : "Request changes" },
          submit: { type: "plain_text", text: answering ? "Make the change" : "Send note" }, close: { type: "plain_text", text: "Cancel" },
          blocks: [
            ...(answering ? [{ type: "context", elements: [{ type: "mrkdwn",
              text: "AgentX makes the change you describe for the question on the card. Recommended fixes are not included; approve them from the card." }] }] : []),
            { type: "input", block_id: "feedback_note", label: { type: "plain_text", text: answering ? "What should AgentX do?" : "What should AgentX reconsider?" },
              element: { type: "plain_text_input", action_id: "reason", multiline: true, max_length: 500,
                placeholder: { type: "plain_text", text: answering ? "Your answer to the reviewer's question" : "Add a short note" } } },
          ],
        });
        return;
      }
      const value = workflowActionValue(action.value);
      if (!value || action.triggerId === "") throw new Error("invalid workflow action");
      const { workflow } = await loadOwnedThreadTask(value, action, action.thread);
      const requiredChecks = workflow.checkPolicy?.required ?? [];
      const codingPlan = workflow.path === "QUICK" || workflow.reviewPhase === "IMPLEMENTATION_PLAN";
      const optionalChecks = workflow.checkPolicy?.optional ?? [];
      const choosing = value.decision === "APPROVE" && codingPlan;
      if (choosing && optionalChecks.length === 0) {
        // Nothing to choose: Approve is the decision, the same one the form would submit with nothing chosen.
        if (await submitDecision(value, action.userId, action.thread, workflow, "Approved in Slack.", [])) await acknowledged(action, "Approving the coding plan.");
        return;
      }
      reviewStillWaiting(value, workflow);
      const controls = workflowCheckControls(workflow.checkPolicy, { codingPlan: choosing });
      // Asking for changes to the coding plan itself: its checks are chosen when it is approved, not "later".
      const blocks: Array<Record<string, unknown>> = !choosing && codingPlan && requiredChecks.length === 0
        ? [{ type: "section", text: { type: "mrkdwn", text: optionalChecks.length > 0
          ? "No project checks are required. You choose checks when you approve the coding plan." : "No project checks are required." } }]
        : [...controls];
      if (value.decision === "REQUEST_CHANGES") {
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
      if (view.callback_id === "agentx_task_people_submission" || view.callback_id === "agentx_task_take_ownership") {
        let metadata: Record<string, unknown>;
        try { metadata = asRecord(JSON.parse(typeof view.private_metadata === "string" ? view.private_metadata : "")); }
        catch { throw new WorkflowInteractionRefusal("This People request is no longer available."); }
        const taskId = typeof metadata.taskId === "string" && CHANGE_ID.test(metadata.taskId) ? metadata.taskId : undefined;
        const requestId = typeof metadata.requestId === "string" && CHANGE_ID.test(metadata.requestId) ? metadata.requestId : undefined;
        const revision = metadata.expectedPeopleRevision;
        const submittedThread = SlackThreadSchema.safeParse(metadata.thread);
        const user = SlackUserIdSchema.safeParse(asRecord(payload.user).id);
        const userTeam = SlackTeamIdSchema.safeParse(asRecord(payload.user).team_id);
        const workspaceTeam = SlackTeamIdSchema.safeParse(asRecord(payload.team).id);
        if (taskId === undefined || requestId === undefined || !Number.isSafeInteger(revision) || Number(revision) < 1 || !submittedThread.success || !user.success
          || !userTeam.success || !workspaceTeam.success || userTeam.data !== submittedThread.data.teamId || workspaceTeam.data !== submittedThread.data.teamId) {
          throw new WorkflowInteractionRefusal("This People request belongs to another Slack workspace.");
        }
        if (view.callback_id === "agentx_task_take_ownership") {
          if (deps.takePeopleOwnership === undefined) throw new WorkflowInteractionRefusal("Task People is unavailable.");
          await deps.takePeopleOwnership({ taskId, requestId, expectedPeopleRevision: Number(revision), userId: user.data, thread: submittedThread.data });
          return;
        }
        const values = asRecord(asRecord(view.state).values);
        const slackUserId = SlackUserIdSchema.safeParse(asRecord(asRecord(values.task_person).person).selected_user);
        const roleValue = asRecord(asRecord(asRecord(values.task_role).role).selected_option).value;
        if (!slackUserId.success || (roleValue !== "owner" && roleValue !== "commenter" && roleValue !== "viewer" && roleValue !== "denied")) {
          throw new WorkflowFormErrors({ task_person: "Choose a current workspace member and role." });
        }
        if (deps.changePeople === undefined) throw new WorkflowInteractionRefusal("Task People is unavailable.");
        await deps.changePeople({ taskId, requestId, expectedPeopleRevision: Number(revision), slackUserId: slackUserId.data, role: roleValue, userId: user.data, thread: submittedThread.data });
        return;
      }
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
        const current = await currentOwnedWorkflow({ taskId, userId: userId.data, thread: thread.data, userTeamId: userTeamId.data, workspaceTeamId: workspaceTeamId.data },
          "close this task", (workflow) => workflow.state !== "COMPLETE");
        // The owner confirmed what the form said. An approved fix that started after it opened was never mentioned, so it is
        // not discarded silently. (A form opened before this check existed carries no revision and closes as it did.)
        if (Number.isInteger(metadata.revision) && metadata.revision !== current.revision && metadata.fixPending !== true && approvedFixNotOnPullRequests(current)) {
          throw new WorkflowInteractionRefusal(CLOSE_AFTER_FIX_STARTED);
        }
        if (deps.close === undefined) throw new Error("closing tasks is not configured");
        await deps.close({ taskId, userId: userId.data, thread: thread.data, requestId });
        // The thread hears "closed" only once the workspace is released, which takes a minute or two; until then the
        // owner is told privately that the close is under way. Best effort: the close is already handed off.
        if (isSlackResponseUrl(metadata.responseUrl)) {
          try {
            await deps.respondEphemeral?.(metadata.responseUrl, CLOSING_ACK);
          } catch (error) {
            console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.ack_failed", actionId: "agentx_workflow_close", errorName: errorName(error) }));
          }
        }
        return;
      }
      if (view.callback_id === WORKFLOW_FINDINGS_SUBMISSION) {
        let metadata: Record<string, unknown>;
        try { metadata = asRecord(JSON.parse(typeof view.private_metadata === "string" ? view.private_metadata : "")); }
        catch { throw new WorkflowInteractionRefusal(STALE_WORKFLOW_BUTTON); }
        const target = resolveFindingsTarget(JSON.stringify(metadata));
        const requestId = typeof metadata.requestId === "string" && CHANGE_ID.test(metadata.requestId) ? metadata.requestId : undefined;
        const thread = SlackThreadSchema.safeParse(metadata.thread);
        const userId = SlackUserIdSchema.safeParse(asRecord(payload.user).id);
        const userTeamId = SlackTeamIdSchema.safeParse(asRecord(payload.user).team_id);
        const workspaceTeamId = SlackTeamIdSchema.safeParse(asRecord(payload.team).id);
        if (target === undefined || requestId === undefined || !thread.success || !userId.success || !userTeamId.success || !workspaceTeamId.success) {
          throw new WorkflowInteractionRefusal(STALE_WORKFLOW_BUTTON);
        }
        // The same owner, thread and step the form was opened for; the open findings are read again from the task.
        const workflow = await currentOwnedWorkflow({ taskId: target.taskId, userId: userId.data, thread: thread.data, userTeamId: userTeamId.data, workspaceTeamId: workspaceTeamId.data, revision: target.revision },
          "resolve these findings", (current) => current.candidate?.digest === target.candidateDigest && workflowResolveFindingsOffered(current));
        const open = openReviewFindings(workflow);
        if (open.length > WORKFLOW_RESOLVE_FINDINGS_MAX) throw new WorkflowInteractionRefusal(STALE_WORKFLOW_BUTTON);
        const values = asRecord(asRecord(view.state).values);
        const errors: Record<string, string> = {};
        const resolutions = open.map((finding) => {
          const ids = findingBlockIds(finding.findingId);
          const chosen = asRecord(asRecord(asRecord(values[ids.action]).action).selected_option).value;
          const action: "ACCEPT" | "FIX" = chosen === "ACCEPT" ? "ACCEPT" : "FIX";
          const raw = asRecord(asRecord(values[ids.note]).note).value;
          const note = typeof raw === "string" ? raw.trim() : "";
          if (action === "ACCEPT" && note === "") errors[ids.note] = "Give a reason to accept this finding.";
          else if (action === "ACCEPT" && note.length > FINDING_REASON_MAX) errors[ids.note] = `A reason is at most ${FINDING_REASON_MAX} characters.`;
          else if (action === "FIX" && note.length > FINDING_INSTRUCTION_MAX) errors[ids.note] = "Instructions are at most 1,000 characters.";
          return { findingId: finding.findingId, action, note };
        });
        if (Object.keys(errors).length > 0) throw new WorkflowFormErrors(errors);
        if (deps.resolveFindings === undefined) throw new Error("resolving review findings is not configured");
        await deps.resolveFindings({ taskId: target.taskId, userId: userId.data, thread: thread.data, requestId, expectedRevision: workflow.revision, candidateDigest: target.candidateDigest, resolutions });
        // The form closes at once and the next card comes later: say privately what was saved. Best effort; the save stands.
        if (isSlackResponseUrl(metadata.responseUrl)) {
          const toFix = resolutions.filter((resolution) => resolution.action === "FIX").length;
          const findings = (count: number) => `${count} ${count === 1 ? "finding" : "findings"}`;
          try {
            await deps.respondEphemeral?.(metadata.responseUrl, toFix > 0 ? `Sending ${findings(toFix)} back to coding.`
              : `Accepted ${findings(resolutions.length)}; the change goes on to its draft pull request.`);
          } catch (error) {
            console.log(JSON.stringify({ component: "slack-interactivity", event: "workflow.ack_failed", actionId: "agentx_workflow_resolve_findings", errorName: errorName(error) }));
          }
        }
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
        // The proposed checks the owner kept ticked, only from the approved plan. A form without that choice (none
        // proposed) keeps what the task runs now.
        const proposed = workflow.checkPolicy?.proposed ?? [];
        const keptSelections = asRecord(asRecord(asRecord(asRecord(view.state).values).workflow_proposed_checks).selected_options).selected_options;
        const selectedProposedCheckIds = proposed.length === 0 || !Array.isArray(keptSelections) ? undefined : keptSelections.flatMap((entry) => {
          const id = asRecord(entry).value;
          return typeof id === "string" && proposed.some((check) => check.id === id) ? [id] : [];
        }).sort();
        // A retry runs the project's checks, the proposed ones kept here and the optional ones chosen here.
        const remaining = workflow.checkPolicy === undefined ? 0 : workflowSelectedChecks({ ...workflow.checkPolicy, selectedOptionalIds: selectedOptionalCheckIds,
          ...(selectedProposedCheckIds === undefined ? {} : { selectedProposedIds: selectedProposedCheckIds }) }).length;
        if (remaining === 0) {
          throw new WorkflowCheckSelectionRequired(proposed.length > 0 ? "Keep at least one check, or close the task." : "Choose at least one check before retrying verification.");
        }
        if (deps.retryChecks === undefined) throw new Error("verification retry is not configured");
        await deps.retryChecks({ taskId, userId: userId.data, thread: thread.data, requestId, expectedRevision: revision,
          selectedOptionalCheckIds, ...(selectedProposedCheckIds === undefined ? {} : { selectedProposedCheckIds }), instructions: "Retry the selected checks without changing code." });
        return;
      }
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
          bundleDigests, bundleSetDigest: value.bundleSetDigest, ownerNote: ownerNote.trim(),
          // An answer to the reviewer's question approves the fix it describes; any other note is kept for the next round.
          ...(value.selection === "ANSWER" ? { selection: "ANSWER", questionFindingIds: value.findingIds, decision: "APPROVE" } : { selection: "RECOMMENDED", decision: "REQUEST_CHANGES" }) });
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
      }
      // Gap 10h: a decision already saved just closes the form. Approving with no check at all is review only.
      await submitDecision(value, userId.data, thread.data, workflow, reason, selectedOptionalCheckIds);
    },
  };
}

/** Retries of the same Slack modal submission reuse the broker's idempotency key. */
function workflowDecisionRequestId(input: { taskId: string; revision: number; digest: string; decision: string; reason: string; selectedOptionalCheckIds: string[]; workBreakdownDigest?: string }): string {
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
