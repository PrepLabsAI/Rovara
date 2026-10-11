// The Slack action IDs of a workflow task's buttons: shared by the messages that carry them and the router that answers them.

import { WORKFLOW_PATH_ANSWER_ACTION, WORKFLOW_PATH_FULL_ACTION, WORKFLOW_PATH_QUICK_ACTION } from "@agentx/contracts";

/** The Quick or Full question's buttons, and (Task 21) Just answer; defined with the routed card the Slack service posts. */
export { WORKFLOW_PATH_ANSWER_ACTION, WORKFLOW_PATH_FULL_ACTION, WORKFLOW_PATH_QUICK_ACTION };

/** Every button `workflowSlackHandlers` answers. */
export const WORKFLOW_ACTION_IDS: ReadonlySet<string> = new Set([
  "agentx_workflow_approve", "agentx_workflow_changes", "agentx_feedback_review_recommended", "agentx_feedback_review_changes",
  "agentx_workflow_retry_checks", "agentx_workflow_retry_reviews", "agentx_workflow_retry_publish",
  // Task 16: an exit from every blocked state.
  "agentx_workflow_send_back", "agentx_workflow_retry_plan", "agentx_workflow_retry_implementation", "agentx_workflow_close",
  WORKFLOW_PATH_QUICK_ACTION, WORKFLOW_PATH_FULL_ACTION, WORKFLOW_PATH_ANSWER_ACTION,
]);
