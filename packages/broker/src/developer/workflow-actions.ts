// The Slack action IDs of a workflow task's buttons: shared by the messages that carry them and the router that answers them.

import { WORKFLOW_PATH_ANSWER_ACTION, WORKFLOW_PATH_FULL_ACTION, WORKFLOW_PATH_QUICK_ACTION, WORKFLOW_STOP_ACTION } from "@agentx/contracts";

/** The Quick or Full question's buttons, and (Task 21) Just answer; defined with the routed card the Slack service posts. */
export { WORKFLOW_PATH_ANSWER_ACTION, WORKFLOW_PATH_FULL_ACTION, WORKFLOW_PATH_QUICK_ACTION };

/** Every button `workflowSlackHandlers` answers. */
export const WORKFLOW_ACTION_IDS: ReadonlySet<string> = new Set([
  "agentx_task_people", "agentx_task_people_submission", "agentx_task_take_ownership",
  "agentx_workflow_approve", "agentx_workflow_changes", "agentx_feedback_review_recommended", "agentx_feedback_review_changes", "agentx_feedback_review_dismiss",
  "agentx_workflow_retry_checks", "agentx_workflow_retry_reviews", "agentx_workflow_retry_publish", "agentx_feedback_review_retry",
  // Task 16: an exit from every blocked state.
  "agentx_workflow_send_back", "agentx_workflow_resolve_findings", "agentx_workflow_retry_plan", "agentx_workflow_retry_implementation", "agentx_workflow_close",
  // An approved PR feedback fix that changed nothing: wait for the merge again, the pull request as it is.
  "agentx_workflow_keep_pull_requests",
  WORKFLOW_PATH_QUICK_ACTION, WORKFLOW_PATH_FULL_ACTION, WORKFLOW_PATH_ANSWER_ACTION,
  // Decision 134: Stop on a request that started Quick on its own.
  WORKFLOW_STOP_ACTION,
]);

/** What the presser hears for it. */
export const STOP_WHILE_PUBLISHING_TEXT = "The pull request is already being opened, so it can't be stopped now. You can close it on GitHub.";

/** What a member hears when the project their task belongs to has AgentX tasks switched off. */
export const PROJECT_TASKS_DISABLED_TEXT = "AgentX tasks aren't turned on for this project. Ask an AgentX admin to turn them on.";

/** What a press on a workflow button (anything but an approval) hears when it is out of date, from the broker or from Slack's handler. */
export const WORKFLOW_BUTTON_OUT_OF_DATE = "That button is out of date. Use the latest message in this thread.";

/** What a press on an approval (Approve, Request changes) hears when it is out of date, from the broker or from Slack's handler. */
export const WORKFLOW_APPROVAL_OUT_OF_DATE = "That approval is out of date. Use the latest message in this thread.";

/**
 * The refusals of an approval of a coding plan with an ordered work breakdown, by their exact text. They are kept apart from WORKFLOW_ACTIONABLE_REFUSALS (Slack says those as
 * they are); the task page says its own words for each (see `decideOnPage`).
 */
export const WORKFLOW_BREAKDOWN_REFUSALS = Object.freeze({
  digestMissing: "approve this exact ordered work plan by refreshing the plan and submitting its work breakdown digest",
  digestChanged: "the work breakdown changed; refresh the plan before deciding",
  noBreakdown: "the current plan has no work breakdown to approve",
  notEnabled: "ordered work plans are saved but this broker is not enabled to start them",
  onePinnedRepository: "ordered work is available only when this task is pinned to one registered repository",
});

