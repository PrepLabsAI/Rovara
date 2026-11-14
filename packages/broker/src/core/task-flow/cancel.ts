import { WorkflowSnapshotSchema, WorkflowTransitionError, blockWorkflow, change, when } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { operationKey, workspaceKey } from "./keys.js";
import { readTask } from "./reads.js";
import { fromDocument, type OperationRecord, type WorkspaceRecord } from "./records.js";
import { recordOperationResult } from "./results.js";
import { blockTaskWorkflow, commitWorkflow } from "./stage-machine.js";
import { iso } from "./support.js";
import { progressAfterStoppedRun } from "../work-breakdown/results.js";

/** Cancels the active operation. The host must authorize the caller before invoking this task-level action. */
export async function cancelTask(deps: TaskFlowDeps, taskId: string): Promise<{ nothingRunning: boolean; message?: string }> {
  const task = await readTask(deps, taskId);
  if (task === undefined || task.closedAt !== undefined) return { nothingRunning: true };
  const workspace = fromDocument<WorkspaceRecord>(await deps.store.get(workspaceKey(task.workspaceId)));
  if (workspace === undefined || workspace.activeOperationId === null) return { nothingRunning: true };
  const operation = fromDocument<OperationRecord>(await deps.store.get(operationKey(workspace.id, workspace.activeOperationId)));
  if (operation === undefined) return { nothingRunning: true };
  // The stop is asked for first, so the result that follows reads as a stop the flow asked for and not as the worker giving up on its own.
  await deps.store.update({
    key: operationKey(workspace.id, operation.id), ops: [change.set("status", "CANCEL_REQUESTED"), change.set("updatedAt", iso(deps))],
    condition: when.and(when.eq("fence", operation.fence), when.not(when.or(when.eq("status", "SUCCEEDED"), when.eq("status", "FAILED"), when.eq("status", "CANCELLED"), when.eq("status", "INTERRUPTED")))),
  });
  // The machine keeps its volume; the next step wakes it. A machine that is already gone is the same as one stopped.
  if (workspace.machine !== undefined) await deps.machines.stop(workspace.machine.machineId).catch(() => undefined);
  await recordOperationResult(deps, { workspaceId: workspace.id, operationId: operation.id, fence: operation.fence, status: "CANCELLED" });
  // A workflow step that was stopped has nothing running: it waits for the owner's Retry.
  const after = await readTask(deps, taskId);
  const workflow = after?.workflow;
  if (after !== undefined && workflow !== undefined && (workflow.state === "RUNNING" || workflow.state === "READY")) {
    const reason = "You stopped this step. Retry to run it again.";
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
  return { nothingRunning: false };
}
