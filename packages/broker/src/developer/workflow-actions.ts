// The Slack action IDs of a workflow task's buttons: shared by the messages that carry them and the router that answers them.

/** The Quick or Full question's buttons. */
export const WORKFLOW_PATH_QUICK_ACTION = "agentx_workflow_path_quick";
export const WORKFLOW_PATH_FULL_ACTION = "agentx_workflow_path_full";

/** Every button `workflowSlackHandlers` answers. */
export const WORKFLOW_ACTION_IDS: ReadonlySet<string> = new Set([
  "agentx_workflow_approve", "agentx_workflow_changes",
  "agentx_workflow_retry_checks", "agentx_workflow_retry_reviews", "agentx_workflow_retry_publish",
  // Task 16: an exit from every blocked state.
  "agentx_workflow_send_back", "agentx_workflow_retry_plan", "agentx_workflow_retry_implementation", "agentx_workflow_close",
  WORKFLOW_PATH_QUICK_ACTION, WORKFLOW_PATH_FULL_ACTION,
]);
