// Lane L9-wire: the TaskFactsSource L6b's sessions read, over the task flow's records (L6a). The sessions module ships no adapter on purpose: the run status is
// derived from operation records only the task flow knows, so the wiring lane writes this thin function once.
import type { DeveloperTaskStatus } from "@agentx/contracts";
import { developerIdOf } from "../../core/sessions/create.js";
import type { SessionTaskFacts, TaskFactsSource, TaskRunStatus } from "../../core/sessions/facts.js";
import { readTask, taskViewOf } from "../../core/task-flow/reads.js";
import { attentionOf } from "./attention.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";

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
        ...(attention.display === undefined ? {} : { display: attention.display }),
        pendingApprovals: 0,
        ...(task.closedAt === undefined ? {} : { endedAt: task.closedAt }),
        updatedAt: task.updatedAt,
      };
    },
  };
}
