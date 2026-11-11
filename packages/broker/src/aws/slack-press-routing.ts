// Spec 062 Phase 7c3: which Slack presses the built-in Slack adapter hands to the channel API, and how.
import {
  ChannelActionSchema,
  SLACK_CHANNEL,
  WORKFLOW_PATH_ANSWER_ACTION,
  WORKFLOW_PATH_FULL_ACTION,
  WORKFLOW_PATH_QUICK_ACTION,
  conversationFromSlackThread,
  type ChannelAction,
} from "@agentx/contracts";
import { FEEDBACK_REVIEW_RETRY_ACTION } from "../developer/workflow-messages.js";
import type { SlackBlockAction } from "./slack-interactivity.js";

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
  if (!ROUTED_SLACK_PRESSES.has(action.actionId)) return undefined;
  if (action.userTeamId !== action.thread.teamId || action.workspaceTeamId !== action.thread.teamId) return undefined;
  return ChannelActionSchema.parse({
    version: 1, channel: SLACK_CHANNEL, eventId: `${action.actionTs ?? action.messageTs}:${action.actionId}`.slice(0, 128),
    conversation: conversationFromSlackThread(action.thread), actor: { channel: SLACK_CHANNEL, tenant: action.thread.teamId, userId: action.userId },
    actionId: action.actionId, value: action.value, messageId: action.messageTs, messageText: action.messageText.slice(0, 40_000),
    receivedAt: new Date(action.requestStartedAt).toISOString(),
  });
}

