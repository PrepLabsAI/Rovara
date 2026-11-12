// Spec 062 Phase 7c3: which Slack presses the built-in Slack adapter hands to the channel API, and how.
import {
  ADMIN_CHANGE_CANCEL_ACTION,
  ADMIN_CHANGE_CONFIRM_ACTION,
  ChannelActionSchema,
  DETAILS_ACTION,
  SLACK_CHANNEL,
  formOfSlackModal,
  formValuesOfSlackState,
  WORKFLOW_PATH_ANSWER_ACTION,
  WORKFLOW_PATH_FULL_ACTION,
  WORKFLOW_PATH_QUICK_ACTION,
  conversationFromSlackThread,
  type ChannelAction,
} from "@agentx/contracts";
import { FEEDBACK_REVIEW_RETRY_ACTION } from "../developer/workflow-messages.js";
import { CHATGPT_PASTE_ACTION, CHATGPT_PASTE_SUBMISSION } from "./slack-chatgpt.js";
import type { SlackBlockAction } from "./slack-interactivity.js";

/** Phase 7c3b: the presses that open a form, which the core answers at once with the form to open. */
export const FORM_SLACK_PRESSES: ReadonlySet<string> = new Set([
  "agentx_workflow_approve", "agentx_workflow_changes", "agentx_feedback_review_changes", "agentx_workflow_retry_checks",
  "agentx_workflow_resolve_findings", "agentx_workflow_close", "agentx_task_people", DETAILS_ACTION, CHATGPT_PASTE_ACTION,
]);

/** Phase 7c3b: the forms whose submissions the core answers. */
export const SLACK_FORM_SUBMISSIONS: ReadonlySet<string> = new Set([
  "agentx_workflow_review_submission", "agentx_workflow_checks_retry_submission", "agentx_feedback_review_changes_submission",
  "agentx_workflow_close_submission", "agentx_workflow_resolve_findings_submission", "agentx_task_people_submission", "agentx_task_take_ownership",
  CHATGPT_PASTE_SUBMISSION,
]);

/** Phase 7c3b: an admin change's Confirm and Cancel, pressed in a direct message, so outside any bound space. */
export const ADMIN_CHANGE_PRESSES: ReadonlySet<string> = new Set([ADMIN_CHANGE_CONFIRM_ACTION, ADMIN_CHANGE_CANCEL_ACTION]);

/** Slack's own additions to a submitted view's text objects, which the form never had. */
function withoutSlackAdditions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSlackAdditions);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>).filter(([key, entry]) => key !== "emoji" && !(key === "verbatim" && entry === false) && !(key === "dispatch_action" && entry === false));
  return Object.fromEntries(entries.map(([key, entry]) => [key, withoutSlackAdditions(entry)]));
}

/**
 * A submitted Slack modal as a channel action: the form as shown, its state, each field's value and Slack's view ID; or
 * undefined for a form the core does not take, one from another workspace, or one this reader cannot read (which
 * Slack's interactivity then answers itself, as before).
 */
export function channelActionOfSubmission(payload: Record<string, unknown>, nowMs: number): ChannelAction | undefined {
  const record = (value: unknown) => (typeof value === "object" && value !== null ? value as Record<string, unknown> : {});
  const view = record(payload.view);
  const team = record(payload.team);
  const user = record(payload.user);
  if (typeof view.callback_id !== "string" || !SLACK_FORM_SUBMISSIONS.has(view.callback_id)) return undefined;
  if (typeof team.id !== "string" || typeof user.id !== "string" || user.team_id !== team.id) return undefined;
  const shown = Object.fromEntries(["type", "callback_id", "private_metadata", "title", "submit", "close", "blocks"].filter((key) => view[key] !== undefined).map((key) => [key, view[key]]));
  const form = formOfSlackModal(withoutSlackAdditions(shown));
  const values = formValuesOfSlackState(record(view.state).values ?? {});
  if (form === undefined || values === undefined) return undefined;
  const parsed = ChannelActionSchema.safeParse({
    version: 1, channel: SLACK_CHANNEL, eventId: `form:${typeof view.id === "string" ? view.id : "view"}:${nowMs}`.slice(0, 128),
    actor: { channel: SLACK_CHANNEL, tenant: team.id, userId: user.id }, actionId: view.callback_id, value: "",
    formSubmission: { form, ...(typeof view.id === "string" ? { handle: view.id } : {}), values }, receivedAt: new Date(nowMs).toISOString(),
  });
  return parsed.success ? parsed.data : undefined;
}

/** An admin change's Confirm or Cancel as a channel action outside any conversation; undefined without its workspace. */
export function channelActionOfAdminPress(press: { changeId: string; click: "confirm" | "cancel"; slackUserId: string; teamId?: string }, nowMs: number): ChannelAction | undefined {
  if (press.teamId === undefined) return undefined;
  const parsed = ChannelActionSchema.safeParse({
    version: 1, channel: SLACK_CHANNEL, eventId: `admin:${press.changeId}:${press.click}:${nowMs}`.slice(0, 128),
    actor: { channel: SLACK_CHANNEL, tenant: press.teamId, userId: press.slackUserId },
    actionId: press.click === "confirm" ? ADMIN_CHANGE_CONFIRM_ACTION : ADMIN_CHANGE_CANCEL_ACTION, value: press.changeId, receivedAt: new Date(nowMs).toISOString(),
  });
  return parsed.success ? parsed.data : undefined;
}

/** Phase 7c3a: the presses that open no form, so the core can take them after Slack has its answer. */
export const ROUTED_SLACK_PRESSES: ReadonlySet<string> = new Set([
  "agentx_workflow_retry_reviews", "agentx_workflow_send_back", "agentx_workflow_retry_plan", "agentx_workflow_retry_implementation",
  "agentx_workflow_keep_pull_requests", "agentx_workflow_retry_publish", FEEDBACK_REVIEW_RETRY_ACTION,
  "agentx_feedback_review_recommended", "agentx_feedback_review_dismiss",
  WORKFLOW_PATH_QUICK_ACTION, WORKFLOW_PATH_FULL_ACTION, WORKFLOW_PATH_ANSWER_ACTION,
]);

/**
 * A press the adapter hands on, or undefined for one the core does not take yet, or one from another workspace (Slack
 * Connect), which Slack's interactivity refuses itself as before. The event ID is Slack's own for the press.
 */
export function channelActionOfPress(action: SlackBlockAction): ChannelAction | undefined {
  if (!ROUTED_SLACK_PRESSES.has(action.actionId) && !FORM_SLACK_PRESSES.has(action.actionId)) return undefined;
  if (action.userTeamId !== action.thread.teamId || action.workspaceTeamId !== action.thread.teamId) return undefined;
  return ChannelActionSchema.parse({
    version: 1, channel: SLACK_CHANNEL, eventId: `${action.actionTs ?? action.messageTs}:${action.actionId}`.slice(0, 128),
    conversation: conversationFromSlackThread(action.thread), actor: { channel: SLACK_CHANNEL, tenant: action.thread.teamId, userId: action.userId },
    actionId: action.actionId, value: action.value, messageId: action.messageTs, messageText: action.messageText.slice(0, 40_000),
    receivedAt: new Date(action.requestStartedAt).toISOString(),
  });
}

