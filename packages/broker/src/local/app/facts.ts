// Lane L9-wire: the TaskFactsSource L6b's sessions read, over the task flow's records (L6a). The sessions module ships no adapter on purpose: the run status is
// derived from operation records only the task flow knows, so the wiring lane writes this thin function once.
import type { DeveloperTaskStatus, TaskStatus } from "@agentx/contracts";
import { developerIdOf } from "../../core/sessions/create.js";
import type { SessionTaskFacts, TaskFactsSource, TaskRunStatus } from "../../core/sessions/facts.js";
import { readTask, taskViewOf } from "../../core/task-flow/reads.js";
import { stateOf, standingFactsOf, type StandingFacts, type TaskState } from "../../core/task-view/index.js";
import { attentionOf } from "./attention.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import type { TaskRecord } from "../../core/task-flow/records.js";

const RUN_STATUS: Partial<Record<DeveloperTaskStatus, TaskRunStatus>> = {
  STARTING: "STARTING", RUNNING: "RUNNING", SUCCEEDED: "SUCCEEDED", FAILED: "FAILED", CANCELLED: "CANCELLED", INTERRUPTED: "INTERRUPTED",
};

/** The one line that says what step a workflow task is on, in the words the sessions show. */
export function stepOf(stage: string, state: string): string | undefined {
  if (state === "BLOCKED") return "Needs your attention";
  switch (stage) {
    case "UNDERSTAND": return "Reading the request";
    case "PLAN": return "Writing the plan";
    case "PLAN_CRITIQUE": return "Checking the plan";
    case "PLAN_REVIEW": return state === "WAITING" ? "Waiting for your approval" : "Plan review";
    default: return undefined;
  }
}

/** Where the rule's line stands over the attention reader's: a Stopped task, a decision the attention reader does not know of (a feedback card waiting), a blocked review (it says why a person is needed), and whenever attention has nothing to say. */
function ruleWins(rule: TaskState, facts: StandingFacts, attention: TaskStatus | undefined): boolean {
  return attention === undefined || rule.pill === "stopped" || facts.reviewBlock !== undefined || (rule.status.state === "needs_you" && attention.state !== "needs_you");
}

/**
 * F2-B: the status line the session shows is the ONE rule's (`stateOf`, person-free), the same one the served standing carries, and the fact a person stopped the task. The pull request's readiness is a fact of the rule too (`pullRequestReady`),
 * so where the attention reader says more (the words of a blocked step's ask, a held draft, a branch update) its words stay (`attention`); a Stopped task (a person's Stop, the budget, a prepare that failed) always reads as the rule says. A task with
 * no workflow keeps what the run's status says (the rule has no run status to read).
 */
async function ruleOf(deps: Pick<TaskFlowDeps, "store" | "companyId">, task: TaskRecord, attention: TaskStatus | undefined): Promise<Pick<SessionTaskFacts, "display" | "stoppedByPerson">> {
  if (task.workflow === undefined) return attention === undefined ? {} : { display: attention };
  const facts = await standingFactsOf(deps, task);
  const rule = stateOf(facts);
  return { display: ruleWins(rule, facts, attention) ? rule.status : attention!, ...(facts.stoppedByPerson === true ? { stoppedByPerson: true } : {}) };
}

export function createTaskFactsSource(deps: Pick<TaskFlowDeps, "store" | "companyId"> & Partial<TaskFlowDeps>): TaskFactsSource {
  return {
    async read(companyId, taskId): Promise<SessionTaskFacts | undefined> {
      if (companyId !== deps.companyId) return undefined;
      const task = await readTask(deps, taskId);
      if (task === undefined || task.companyId !== companyId) return undefined;
      const view = await taskViewOf(deps as TaskFlowDeps, task);
      const workflow = task.workflow;
      const failed = view.failure;
      // Lane L12: Rovara's ask and where the pull request stands, in the words the page uses.
      const attention = await attentionOf(deps, task);
      return {
        companyId, taskId, project: task.project, ownerDeveloperId: developerIdOf({ provider: task.provider, personId: task.developerId }),
        ...(task.closedAt === undefined ? {} : { closedAt: task.closedAt }),
        ...(workflow === undefined ? {} : { workflow: { stage: workflow.stage, state: workflow.state, ...(workflow.outcome === undefined ? {} : { outcome: workflow.outcome }), ...(workflow.blockReason === undefined ? {} : { blockReason: workflow.blockReason }) } }),
        runStatus: RUN_STATUS[view.status] ?? "IDLE",
        ...(failed === undefined ? {} : { failureCategory: failed.category }),
        ...(failed?.stage === "setup" ? { failedPrepare: {} } : {}),
        ...(workflow === undefined ? {} : (() => { const step = attention.step ?? stepOf(workflow.stage, workflow.state); return step === undefined ? {} : { step }; })()),
        ...await ruleOf(deps, task, attention.display),
        pendingApprovals: 0,
        ...(task.closedAt === undefined ? {} : { endedAt: task.closedAt }),
        updatedAt: task.updatedAt,
      };
    },
  };
}
