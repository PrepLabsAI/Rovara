// A cancelled critic keeps the workspace fenced until its worker is known to be quiescent.
import { MachineError, agentXError, change, when, type MachineHealth } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { OperationRecord, TaskRecord } from "../task-flow/records.js";
import { readOperation, recordOperationResult, isTerminalStatus } from "../task-flow/results.js";
import { readWorkspace } from "../task-flow/stage-machine.js";
import { iso } from "../task-flow/support.js";

export async function quiesceCritic(deps: TaskFlowDeps, task: TaskRecord, operation: OperationRecord) {
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (task.companyId !== deps.companyId || operation.companyId !== deps.companyId || operation.workspaceId !== task.workspaceId
    || workspace?.activeOperationId !== operation.id || workspace.companyId !== deps.companyId) throw agentXError("STALE_FENCE", "The feedback operation changed.");
  const heldFence = operation.fence + 1;
  if (workspace.fence === operation.fence) {
    const claimed = await deps.store.transact([
      { kind: "check", key: task, condition: when.and(when.eq("companyId", deps.companyId), when.eq(["workflow", "revision"], task.workflow!.revision), when.notExists("closedAt")) },
      { kind: "update", key: workspace, ops: [change.set("fence", heldFence)], condition: when.and(when.eq("activeOperationId", operation.id), when.eq("fence", operation.fence)) },
      { kind: "update", key: operation, ops: [change.set("status", "CANCEL_REQUESTED"), change.set("stopRequestedAt", iso(deps))], condition: when.and(when.eq("fence", operation.fence), when.eq("status", operation.status)) },
    ]);
    if (!claimed.applied) throw agentXError("IDEMPOTENCY_CONFLICT", "The feedback operation changed while stopping.");
  } else if (workspace.fence !== heldFence || operation.status !== "CANCEL_REQUESTED") {
    throw agentXError("STALE_FENCE", "The feedback operation no longer owns this cancellation.");
  }
  if (operation.machineId === undefined) return { workspace: { ...workspace, fence: heldFence }, confirmed: true };
  await deps.machines.stop(operation.machineId);
  // Confirmed only once the machine is really stopped or gone: a session still STOPPING (the reaper ends its instance on its next tick) is not, and the hold stays until a later pass sees it.
  const health = await healthOrUnknown(deps, operation.machineId);
  return { workspace: { ...workspace, fence: heldFence }, confirmed: health?.state === "stopped" || health?.state === "terminated" };
}

/**
 * The machine's health, or undefined when the adapter cannot say right now (`unavailable`). The broker's adapter cannot ping a READY worker and refuses; for the hold that is "not known stopped",
 * never a failure of the pass.
 */
async function healthOrUnknown(deps: TaskFlowDeps, machineId: string): Promise<MachineHealth | undefined> {
  try {
    return await deps.machines.health(machineId);
  } catch (error) {
    if (error instanceof MachineError && error.code === "unavailable") return undefined;
    throw error;
  }
}

export async function releaseCriticHold(deps: TaskFlowDeps, operation: OperationRecord): Promise<void> {
  const workspace = await readWorkspace(deps, operation.workspaceId);
  if (workspace === undefined) return;
  await deps.store.update({ key: workspace, ops: [change.set("activeOperationId", null), change.set("status", "READY")],
    condition: when.and(when.eq("fence", operation.fence + 1), when.eq("activeOperationId", operation.id), when.not(when.or(when.eq("status", "CLOSING"), when.eq("status", "CLOSED")))) });
}

export async function settleQuiescedCritic(deps: TaskFlowDeps, operation: OperationRecord): Promise<void> {
  await recordOperationResult(deps, { workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence,
    status: "INTERRUPTED", error: "The feedback review was stopped before it completed." });
  await releaseCriticHold(deps, operation);
}

async function finishMachineStop(deps: TaskFlowDeps, operation: OperationRecord): Promise<boolean> {
  if (operation.machineId === undefined) return true;
  const health = await healthOrUnknown(deps, operation.machineId);
  if (health?.state === "stopped" || health?.state === "terminated") return true;
  if (health?.state === "stopping") return false;
  // Unknown (the broker cannot ping a READY worker) or still up: stop it. The stop is idempotent.
  await deps.machines.stop(operation.machineId);
  const after = await healthOrUnknown(deps, operation.machineId);
  return after?.state === "stopped" || after?.state === "terminated";
}

/** A result can commit while a stop is in flight; its higher workspace fence keeps a later paid round waiting. */
export async function recoverCriticHold(deps: TaskFlowDeps, task: TaskRecord): Promise<void> {
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace?.activeOperationId == null) return;
  const operation = await readOperation(deps, task.workspaceId, workspace.activeOperationId);
  if (operation?.workflowMode !== "FEEDBACK_REVIEW" || workspace.fence !== operation.fence + 1) return;
  if (isTerminalStatus(operation.status)) {
    if (await finishMachineStop(deps, operation)) await releaseCriticHold(deps, operation);
    return;
  }
  const stopped = await quiesceCritic(deps, task, operation);
  if (stopped.confirmed) await settleQuiescedCritic(deps, operation);
}
