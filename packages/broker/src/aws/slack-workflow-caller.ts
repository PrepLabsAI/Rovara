import { developerIdForSlackUser } from "./admin-actions.js";
import type { DeveloperCaller } from "./developer-routes.js";

/** Stable AgentX identity for a Slack user, paired with their Slack ID for channel membership checks. */
export function slackWorkflowCaller(userId: string): DeveloperCaller {
  return {
    developerId: developerIdForSlackUser(userId),
    sessionId: "slack-workflow",
    amr: "slack",
    name: `Slack user ${userId}`,
    slackUserId: userId,
  };
}
