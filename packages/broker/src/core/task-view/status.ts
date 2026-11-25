// F2-A: the person-free status of a task in the ONE status model (`TaskStatus`: a state key, a reason sentence where the state needs one, the next step). This is the switch `core/sessions/display.ts` (K4) held, moved here so the
// stored session summary and the served standing read ONE rule (`stateOf` in `state.ts` calls it). The state key of every case it had is unchanged (it is the stable contract); the sentences now come from the words table
// (`STATUS_LINES`) and a state that needs a person also says what anyone else reads (`nextOthers`). Fixed words only: never task content.
import { STATUS_LINES, failureCause, taskStatusFromSession, type SessionStatus, type TaskStatus } from "@agentx/contracts";

export const BUDGET_PAUSE_REASON = STATUS_LINES.spendStopped.reason;
export const BUDGET_PAUSE_NEXT = STATUS_LINES.spendStopped.next;

/** What the status reads of a task: the same facts a session summary holds (`SessionTaskFacts` fits it). */
export interface StatusFacts {
  workflow?: { stage: string; state: string; outcome?: string | undefined; blockReason?: string | undefined } | undefined;
  failedPrepare?: { at?: string | undefined } | undefined;
  budgetPaused?: boolean | undefined;
  /** A person pressed Stop and nothing has started the work again (the standing's own fact): the line says the run finished and waits, never that a person is needed. */
  stoppedByPerson?: boolean | undefined;
  failureCategory?: string | undefined;
}

export interface StatusInput { lastRunFailed?: true | undefined; ended?: boolean; step?: string | undefined }

/** What the workflow's own stage and state say, once nothing outside it (an ended task, a prepare that failed, a budget pause) has spoken. */
function workflowStatus(workflow: NonNullable<StatusFacts["workflow"]>): TaskStatus {
  if (workflow.state === "BLOCKED") return { state: "needs_you", ...STATUS_LINES.blocked };
  if (workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING") return { state: "needs_you", ...STATUS_LINES.planWaiting };
  if (workflow.stage === "UNDERSTAND" && workflow.state === "WAITING") return { state: "needs_you", ...STATUS_LINES.questionsWaiting };
  if (workflow.stage === "WAIT_FOR_MERGE") return { state: "ready_to_merge", ...STATUS_LINES.readyToMerge };
  switch (workflow.stage) {
    case "UNDERSTAND": return { state: "understanding", ...STATUS_LINES.understanding };
    case "PLAN": case "PLAN_CRITIQUE": case "PLAN_REVIEW": return { state: "planning", ...STATUS_LINES.planning };
    case "IMPLEMENT": return { state: "building", ...STATUS_LINES.building };
    case "VERIFY": case "REVIEW": case "PULL_REQUEST": return { state: "checking", ...STATUS_LINES.checking };
    default: return { state: "building" };
  }
}

export function statusOfTask(facts: StatusFacts, status: SessionStatus, input: StatusInput = {}): TaskStatus {
  const workflow = facts.workflow;
  if (workflow?.stage === "MERGED") return { state: "merged", ...STATUS_LINES.merged };
  if (workflow?.outcome === "ANSWERED") return { state: "closed", ...STATUS_LINES.answered };
  if (facts.failedPrepare !== undefined) return { state: "failed", ...STATUS_LINES.prepareFailed };
  if (input.ended === true) {
    if (status === "failed") return { state: "failed", reason: failureCause(facts.failureCategory), ...STATUS_LINES.endedFailed };
    return { state: "closed", ...STATUS_LINES.endedClosed };
  }
  if (facts.budgetPaused === true) return { state: "paused_budget", ...STATUS_LINES.spendStopped };
  if (facts.stoppedByPerson === true) return { state: "finished_run", ...STATUS_LINES.stoppedByPerson };
  if (workflow === undefined) return taskStatusFromSession({ status, ...(input.lastRunFailed === undefined ? {} : { lastRunFailed: input.lastRunFailed }), ...(input.step === undefined ? {} : { step: input.step }) });
  return workflowStatus(workflow);
}
