// The Slack action IDs of a workflow task's buttons: shared by the messages that carry them and the router that answers them.

import { WORKFLOW_PATH_ANSWER_ACTION, WORKFLOW_PATH_FULL_ACTION, WORKFLOW_PATH_QUICK_ACTION } from "@agentx/contracts";

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
]);

/** What a press on a workflow button (anything but an approval) hears when it is out of date, from the broker or from Slack's handler. */
export const WORKFLOW_BUTTON_OUT_OF_DATE = "That button is out of date. Use the latest message in this thread.";

/** What a press on an approval (Approve, Request changes) hears when it is out of date, from the broker or from Slack's handler. */
export const WORKFLOW_APPROVAL_OUT_OF_DATE = "That approval is out of date. Use the latest message in this thread.";
