import { developerIdForSlackUser } from "./admin-actions.js";
import { SLACK_WORKFLOW_SESSION_ID } from "../developer/task-records.js";
import type { DeveloperCaller } from "./developer-routes.js";

/** Stable AgentX identity for a Slack user, paired with their Slack ID for channel membership checks. */
export function slackWorkflowCaller(userId: string): DeveloperCaller {
  return {
    developerId: developerIdForSlackUser(userId),
    sessionId: SLACK_WORKFLOW_SESSION_ID,
    amr: "slack",
    name: `Slack user ${userId}`,
    slackUserId: userId,
  };
}
