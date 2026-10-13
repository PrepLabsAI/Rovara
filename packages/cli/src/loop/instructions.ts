// rovara loop (#355, #356, #357): what the agent is told. Rovara's own words for its own loops; the agent learns the
// loop from its first assignment, and every later message says who it is from.
import type { Artifact, LoopDefinition } from "./definitions.js";
import { LOOP_MCP_SERVER, artifactPath, itemBranch } from "./naming.js";
import type { WorkItemState } from "./state.js";

/**
 * The sections each document must have, in order, as `## ` headings. The same three documents as the hosted Full
 * path: the requirements say what someone can do or see; the design says how it works; the plan says where in the
 * code, and how the change is proved.
 */
export const ARTIFACT_SECTIONS: Record<Artifact, readonly string[]> = {
  requirements: ["What changes", "Not changing", "Risks"],
  design: ["How it works", "Risks"],
  plan: ["Summary", "Changes", "Testing"],
};

const WHAT: Record<Artifact, string> = {
  requirements: "the requirements: what someone will be able to do or see when this is done, what does not change, and the risks (write \"None\" where there are none). Do not describe how it works or where in the code.",
  design: "the design: how it works, derived from the approved requirements, and its risks. Keep to what the requirements ask for.",
  plan: "the plan: Summary says what will change and why; Changes lists the files and what changes in each; Testing says how the change will be proved.",
};

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

/** The step that writes `artifact`: what to write, where, and with which sections. */
export function artifactAssignment(state: WorkItemState, artifact: Artifact, after?: { approver: string; approved: Artifact }): string {
  const earlier = (["requirements", "design"] as const).filter((candidate) => candidate !== artifact && state.approvals?.[candidate] !== undefined);
  return [
    ...(after === undefined ? [] : [`@${after.approver} approved the ${after.approved}. ${after.approved === "requirements" ? "They are" : "It is"} locked: do not edit ${after.approved === "requirements" ? "them" : "it"}.`, ""]),
    `Your step now: write ${WHAT[artifact]}`,
    `Write it to ${artifactPath(state.issue, artifact)}, with these sections as Markdown headings: ${ARTIFACT_SECTIONS[artifact].map((section) => `\`## ${section}\``).join(", ")}.`,
    ...(earlier.length === 0 ? [] : [`Derive it from the approved ${earlier.map((name) => `${name} (${artifactPath(state.issue, name)})`).join(" and ")}.`]),
    "Do not change any code yet. Commit the document, then call loop_complete.",
  ].join("\n");
}

export function firstAssignment(state: WorkItemState, loop: LoopDefinition): string {
  const first = loop.steps.find((step) => step.id === state.step);
  if (loop.name === "do") {
    return [...common(state), "- This is the Do loop: it has no gates and does not publish anything.", "", `Instruction from @${state.startedBy}:`, state.instruction].join("\n");
  }
  const outline = loop.name === "full"
    ? `This is the Full loop: requirements, then a design, then a plan, each approved by a person before the next is written; then you code it, and the loop runs the checks and opens a pull request.${(state.skipped ?? []).length === 0 ? "" : ` These phases were declared away, so there is no document for them: ${(state.skipped ?? []).join(", ")}.`}`
    : "This is the Quick loop: plan, then a person approves the plan, then you code it, then the loop runs the checks and opens a pull request.";
  return [
    ...common(state),
    "",
    outline,
    "",
    first?.artifact === undefined ? "Your step now: work on the instruction below." : artifactAssignment(state, first.artifact),
    "",
    `Instruction from @${state.startedBy}:`,
    state.instruction,
  ].join("\n");
}

export function replyAssignment(author: string, text: string): string {
  return [`Reply from @${author} on the issue:`, text, "", "When you have dealt with it, commit, then call loop_complete again with a summary."].join("\n");
}

export function changesAssignment(artifact: Artifact, author: string, text: string): string {
  return [`@${author} asked for changes to the ${artifact} (they are also added to it, under "Review feedback"):`, text, "", `Update ${artifact === "plan" ? "the plan" : `the ${artifact}`}, keeping its sections, commit it, then call loop_complete again. Still no code changes.`].join("\n");
}

export function codeAssignment(approver: string, approved: Artifact): string {
  return [
    `@${approver} approved the ${approved}. Your step now: implement it.`,
    "- Do not edit any approved document: they are locked, and a claim with a changed one is refused.",
    "- Commit as you go. Do not push and do not open a pull request: when you call loop_complete, the loop runs the repository's checks and opens the pull request itself.",
  ].join("\n");
}

export function checksFailedAssignment(detail: string): string {
  return ["The loop ran the repository's checks, and they failed:", "", detail, "", "Fix the code (not the checks), commit, then call loop_complete again. The loop runs the checks again."].join("\n");
}

/** Said to a session that had to be restarted while it was working. */
export const RESUMED_ASSIGNMENT = "Your session was restarted. Carry on with your step where you left off, then call loop_complete with a summary.";
