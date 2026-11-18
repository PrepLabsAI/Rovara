// Explicit policy for company mode. Unknown actions are unavailable, including newly added buttons.
// Source census: slack-press-routing.ts ADMIN_CHANGE_PRESSES:34, FORM_SLACK_PRESSES:21,
// SLACK_FORM_SUBMISSIONS:27, ROUTED_SLACK_PRESSES:80; model-command.ts parses `use <model>`.
export type SlackActionClass = "member" | "admin" | "settings";
export const SLACK_WEB_SIGNIN_NOTICE = "That needs a web sign-in. Open it in Rovara.";
export const SLACK_ACTION_CLASSES: Readonly<Record<string, SlackActionClass>> = Object.freeze({
  agentx_admin_change_confirm: "admin", agentx_admin_change_cancel: "admin",
  "use <model>": "settings",
  agentx_task_people: "settings", agentx_task_people_submission: "settings", agentx_task_take_ownership: "settings",
  rovara_chatgpt_paste: "settings", rovara_chatgpt_paste_submission: "settings",
  "connect chatgpt": "settings", "disconnect chatgpt": "settings", "chatgpt status": "settings",
  agentx_workflow_approve: "member", agentx_workflow_changes: "member", agentx_feedback_review_changes: "member",
  agentx_workflow_retry_checks: "member", agentx_workflow_resolve_findings: "member", agentx_workflow_close: "member",
  agentx_details: "member", agentx_workflow_retry_reviews: "member", agentx_workflow_send_back: "member",
  agentx_workflow_retry_plan: "member", agentx_workflow_retry_implementation: "member", agentx_workflow_keep_pull_requests: "member",
  agentx_workflow_retry_publish: "member", agentx_feedback_review_retry: "member", agentx_feedback_review_recommended: "member",
  agentx_feedback_review_dismiss: "member", agentx_workflow_path_quick: "member", agentx_workflow_path_full: "member", agentx_workflow_path_answer: "member",
  agentx_workflow_review_submission: "member", agentx_workflow_checks_retry_submission: "member", agentx_feedback_review_changes_submission: "member",
  agentx_workflow_close_submission: "member", agentx_workflow_resolve_findings_submission: "member",
  agentx_confirm_approve: "member", agentx_confirm_cancel: "member", "slack.confirmation": "member", agentx_workflow_stop: "member",
  // HW5b: the plan card's Approve and Request changes (and the box Request changes opens), for a low or medium risk plan. A member's press is a request; the core decides (slack-core-plan-press.ts). Reject and Skip are NOT here.
  rovara_decide_APPROVE: "member", rovara_decide_REQUEST_CHANGES: "member", rovara_changes: "member",
  // The plan card's "Open the task" is a link button: Slack still reports its press, and there is nothing to do (it carries no value, so no handler takes it). Not a decision: a member's press of it is simply let through, with no notice.
  rovara_open_task: "member",
});
export function slackActionClass(action: unknown): SlackActionClass | undefined {
  return typeof action === "string" && Object.hasOwn(SLACK_ACTION_CLASSES, action) ? SLACK_ACTION_CLASSES[action] : undefined;
}
