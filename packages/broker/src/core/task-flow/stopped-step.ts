// A workflow step whose run was stopped (a Stop, or the per-run dollar stop) has nothing running: the step is blocked with its reason and waits for the owner's Retry.
import { WorkflowSnapshotSchema, WorkflowTransitionError, blockWorkflow } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { readTask } from "./reads.js";
import type { OperationRecord } from "./records.js";
import { blockTaskWorkflow, commitWorkflow } from "./stage-machine.js";
import { iso } from "./support.js";
import { progressAfterStoppedRun } from "../work-breakdown/results.js";

export async function blockStoppedStep(deps: TaskFlowDeps, taskId: string, operation: OperationRecord, reason: string): Promise<void> {
  const after = await readTask(deps, taskId);
  const workflow = after?.workflow;
  if (after === undefined || workflow === undefined || (workflow.state !== "RUNNING" && workflow.state !== "READY")) return;
  // An ordered run (spec 059) that was stopped marks the item it was on as unknown in the same write that blocks the task, so Retry resumes only from what was acknowledged as done.
  const now = iso(deps);
  const marked = operation.workflowMode === "IMPLEMENT" && workflow.stage === "IMPLEMENT" ? progressAfterStoppedRun(workflow, operation, now) : undefined;
  if (marked !== undefined && marked.length > (workflow.workflowDependenciesProgress ?? []).length) {
    try {
      await commitWorkflow(deps, after, WorkflowSnapshotSchema.parse({ ...blockWorkflow(workflow, reason, now), workflowDependenciesProgress: marked }));
    } catch (error) {
      if (!(error instanceof WorkflowTransitionError)) throw error;
    }
  } else await blockTaskWorkflow(deps, taskId, workflow.revision, reason);
}
