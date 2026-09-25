import { slackThreadUrl, type SlackThread, type SlackWorkspaceLimit } from "@agentx/contracts";
import { escapeText } from "./slack-format.js";

// Thread notices follow the reply formatting (spec 014 FR-022): the static texts below contain no
// Slack control characters, so they post exactly as written; every interpolated value goes through
// escapeText, so a value such as "<!here>" is shown and never notifies anyone.

export const NEW_WORKSPACE_MESSAGE = "Setting up a new workspace for this thread. The first request takes a few minutes.";
export const STILL_PREPARING_MESSAGE = "This thread's workspace is still being set up. I'll start as soon as it's ready.";

export const PREPARATION_SLOW_MESSAGE = "This thread's workspace is taking longer than expected to set up. " +
  "It continues in the background; mention me again in this thread in a few minutes.";

export const WORKSPACE_UNCONFIRMED_MESSAGE =
  "AgentX could not confirm this thread's workspace setup. Mention me again in this thread in a few minutes.";

export function preparationFailedMessage(status: string): string {
  return `AgentX could not set up this thread's workspace (${escapeText(status)}). Mention me again in this thread to retry.`;
}

export function limitMessage(result: { limit: SlackWorkspaceLimit; maximum: number; starterThreads: readonly SlackThread[] }): string {
  if (result.limit === "ORGANIZATION") {
    return `This organization already has ${result.maximum} AgentX workspaces, the most allowed, so I can't start a new one. ` +
      "Continue in an existing thread, or ask an administrator to raise the limit.";
  }
  const links = result.starterThreads.map((thread, index) => `• <${escapeText(slackThreadUrl(thread))}|Thread ${index + 1}>`);
  return [
    `You already have ${result.maximum} AgentX workspaces, the most one person can have, so I can't start a new one. ` +
      "Continue in one of your existing threads instead:",
    ...links,
  ].join("\n");
}
