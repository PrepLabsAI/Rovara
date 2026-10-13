// rovara loop (#355, #356): what the agent is told. Rovara's own words for its own loops; the agent learns the
// loop from its first assignment, and every later message says who it is from.
import type { LoopDefinition } from "./definitions.js";
import { LOOP_MCP_SERVER, itemBranch, planPath } from "./naming.js";
import type { WorkItemState } from "./state.js";

/** The sections a Quick plan must have, in this order. */
export const PLAN_SECTIONS = ["Summary", "Changes", "Testing"] as const;

const common = (state: WorkItemState) => [
  `You are working on GitHub issue ${state.repo}#${state.issue} for rovara loop, in your own git worktree on branch ${itemBranch(state.issue)}.`,
  "",
  "How this loop works:",
  "- Commit your work on this branch as you go.",
  "- Never push, and never open a pull request yourself.",
  `- When you have finished your step, or you need an answer from the person, call the \`loop_complete\` tool of the \`${LOOP_MCP_SERVER}\` MCP server with a short summary: what you did, and anything you need from them. It is posted on the issue. The loop checks your claim and may say what is missing. Once it is accepted, stop and wait.`,
  "- Replies on the issue, and the loop's own messages, reach you here as new messages. Treat each one as your next instruction.",
  "- `loop_status` tells you where the loop stands.",
];

export function firstAssignment(state: WorkItemState, loop: LoopDefinition): string {
  if (loop.name === "quick") {
    return [
      ...common(state),
      "",
      "This is the Quick loop: plan, then a person approves the plan, then you code it, then the loop runs the checks and opens a pull request.",
      "",
      `Your step now: PLAN ONLY. Do not change any code yet. Read what you need, then write the plan to ${planPath(state.issue)}, with these sections, as Markdown headings: ${PLAN_SECTIONS.map((section) => `\`## ${section}\``).join(", ")}. Summary says what will change and why; Changes lists the files and what changes in each; Testing says how the change will be proved. Commit the plan, then call loop_complete.`,
      "",
      `Instruction from @${state.startedBy}:`,
      state.instruction,
    ].join("\n");
  }
  return [
    ...common(state),
    "- This is the Do loop: it has no gates and does not publish anything.",
    "",
    `Instruction from @${state.startedBy}:`,
    state.instruction,
  ].join("\n");
}

export function replyAssignment(author: string, text: string): string {
  return [`Reply from @${author} on the issue:`, text, "", "When you have dealt with it, commit, then call loop_complete again with a summary."].join("\n");
}

export function planChangesAssignment(author: string, text: string): string {
  return [`@${author} asked for changes to the plan (they are also added to the plan, under "Review feedback"):`, text, "", "Update the plan, keeping its sections, commit it, then call loop_complete again. Still no code changes."].join("\n");
}

export function codeAssignment(approver: string): string {
  return [
    `@${approver} approved the plan. Your step now: implement it.`,
    "- Do not edit the plan: it is locked, and a changed plan is refused.",
    "- Commit as you go. Do not push and do not open a pull request: when you call loop_complete, the loop runs the repository's checks and opens the pull request itself.",
  ].join("\n");
}

export function checksFailedAssignment(detail: string): string {
  return ["The loop ran the repository's checks, and they failed:", "", detail, "", "Fix the code (not the checks), commit, then call loop_complete again. The loop runs the checks again."].join("\n");
}

/** Said to a session that had to be restarted while it was working. */
export const RESUMED_ASSIGNMENT = "Your session was restarted. Carry on with your step where you left off, then call loop_complete with a summary.";
