// rovara loop (#355): what the agent is told. Rovara's own words for its own loop; the agent learns the loop
// from its first assignment, and every later message says who it is from.
import { LOOP_MCP_SERVER, itemBranch } from "./naming.js";
import type { WorkItemState } from "./state.js";

export function firstAssignment(state: WorkItemState): string {
  return [
    `You are working on GitHub issue ${state.repo}#${state.issue} for rovara loop, in your own git worktree on branch ${itemBranch(state.issue)}.`,
    "",
    "How this loop works:",
    "- Do the instruction below. Commit your work on this branch as you go.",
    "- Do not push, and do not open a pull request: this loop does not publish anything.",
    `- When you have finished, or you need an answer from the person, call the \`loop_complete\` tool of the \`${LOOP_MCP_SERVER}\` MCP server with a short summary: what you did, and anything you need from them. It is posted on the issue. Then stop and wait.`,
    "- Replies on the issue reach you here as new messages that start with \"Reply from @\". Treat each one as your next instruction.",
    `- \`loop_status\` tells you where the loop stands.`,
    "",
    `Instruction from @${state.startedBy}:`,
    state.instruction,
  ].join("\n");
}

export function replyAssignment(author: string, text: string): string {
  return [`Reply from @${author} on the issue:`, text, "", "When you have dealt with it, call loop_complete again with a summary."].join("\n");
}

/** Said to a session that had to be restarted while it was working. */
export const RESUMED_ASSIGNMENT = "Your session was restarted. Carry on with the issue's work where you left off, then call loop_complete with a summary.";
