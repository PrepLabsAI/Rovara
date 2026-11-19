// The status model's words for a task session (lane L6b): where the work stands in the ONE status model of the contracts (a state, a reason sentence where the state needs one, and the next step), from the
// task's facts. The task flow may supply richer words for its own task page (`facts.display`); this is the default, with the same states and fixed sentences, so every surface says the same thing and the
// notifications always have a state to compare. Fixed words only: never task content, never a raw code.
import { failureCause, taskStatusFromSession, type SessionStatus, type TaskStatus } from "@agentx/contracts";
import type { SessionTaskFacts } from "./facts.js";

export const BUDGET_PAUSE_REASON = "it reached its spending limit";
export const BUDGET_PAUSE_NEXT = "The work goes on once the limit is raised or the allowance changes.";

export function defaultTaskDisplay(facts: SessionTaskFacts, status: SessionStatus, input: { lastRunFailed?: true | undefined; ended?: boolean; step?: string | undefined } = {}): TaskStatus {
  const workflow = facts.workflow;
  if (workflow?.stage === "MERGED") return { state: "merged", next: "Nothing; this task is complete." };
  if (workflow?.outcome === "ANSWERED") return { state: "closed", reason: "Answered: no code change was needed", next: "Nothing; no code change was needed." };
  if (facts.failedPrepare !== undefined) return { state: "failed", reason: "the repository could not be prepared for the task", next: "Close the task and start it again." };
  if (input.ended === true) {
    if (status === "failed") return { state: "failed", reason: failureCause(facts.failureCategory), next: "Start a new task." };
    return { state: "closed", next: "Nothing; this task is closed." };
  }
  if (facts.budgetPaused === true) return { state: "paused_budget", reason: BUDGET_PAUSE_REASON, next: BUDGET_PAUSE_NEXT };
  if (workflow === undefined) return taskStatusFromSession({ status, ...(input.lastRunFailed === undefined ? {} : { lastRunFailed: input.lastRunFailed }), ...(input.step === undefined ? {} : { step: input.step }) });
  if (workflow.state === "BLOCKED") return { state: "needs_you", reason: "the task is blocked", next: "Retry it, or ask for changes." };
  if (workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING") return { state: "needs_you", reason: "the plan is waiting for approval", next: "Review it and approve, or ask for changes." };
  if (workflow.stage === "UNDERSTAND" && workflow.state === "WAITING") return { state: "needs_you", reason: "questions about the request need answers", next: "Answer them." };
  if (workflow.stage === "WAIT_FOR_MERGE") return { state: "ready_to_merge", next: "Review the pull request and merge it." };
  switch (workflow.stage) {
    case "UNDERSTAND": return { state: "understanding", next: "A plan follows once the request is understood." };
    case "PLAN": case "PLAN_CRITIQUE": case "PLAN_REVIEW": return { state: "planning", next: "You review the plan when it is ready." };
    case "IMPLEMENT": return { state: "building", next: "Checks and a pull request follow." };
    case "VERIFY": case "REVIEW": case "PULL_REQUEST": return { state: "checking", next: "A pull request is opened once the checks pass." };
    default: return { state: "building" };
  }
}
