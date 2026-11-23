import { claimLegacyClose, releaseLegacyClose } from "./legacy-close-claim.js";
import { mergeCloseConditions } from "./close-conditions.js";
import { acceptTaskClose, closeHasDigest } from "./close-acceptance.js";
import { decideClose, type CloseMode, type CloseProof } from "./close-guard.js";
import type { CloseSnapshot } from "./close-inspection.js";
import { acceptSystemClose } from "./close-system.js";
import { systemCloseActorId } from "./close-acceptance-record.js";
import { CLOSE_TRY_AGAIN_WORDS, type CloseRefusalReason } from "./close-words.js";
import { workspaceKeys } from "./workspace-location.js";
// Lane L6a, task flow core: closing a task, minimally: the task is closed, its workspace is closed under a new fence (so a late callback is
// refused), a job still running is ended as interrupted, the workspace slot is given back once, and the machine is terminated.
// A close nobody previewed (this file's `closeLoadedTask`, the unbound close) is guarded by `close-guard.ts` when the install has the guard: it deletes a machine-backed workspace only on proof the workspace
// holds nothing, and refuses otherwise (a person) or skips (the system). A close bound to a preview's digest is `close-acceptance.ts`. Cloud's `developer-tasks/close.ts` also checks the task's pull requests
// first; that is a gap (it needs the code host, which later lanes bring).
import { agentXError, change, when, workspaceSessionKey, type TransactItem } from "@agentx/contracts";
import { releaseAdmission, stageAudit } from "./admission.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { releaseItems } from "./limits.js";
import { chargeMarkerKey, taskIndexKey, taskKey } from "./keys.js";
import { loadOwnedTask, readTask, taskViewOf, type TaskView } from "./reads.js";
import { isTerminalStatus, readOperation, syncTaskIndex } from "./results.js";
import type { OperationRecord, TaskRecord, WorkspaceRecord } from "./records.js";
import { readWorkspace } from "./stage-machine.js";
import { iso, log } from "./support.js";
import { flushBeforeClose } from "./money-stop.js";
import { announceTaskEnd } from "./task-end.js";
import { DocumentStoreError } from "@agentx/contracts";

const CLOSE_ATTEMPTS = 3;
type ChangeOp = ReturnType<typeof change.set>;

/** Who closes the task, for the audit record. */
export type CloseActor = { type: "person" | "system"; id: string };

/** What closing a task writes besides the task's own `closedAt`: the task's own ops, and the items for its slot, pointer, workspace, running operation and audit. Nothing is written by building it. */
export interface CloseParts {
  taskOps: ChangeOp[];
  items: TransactItem[];
  workspace: WorkspaceRecord | undefined;
  /** The operation that was running, if any: this close ends it (no result will come). */
  active: OperationRecord | undefined;
}

export async function closeParts(deps: TaskFlowDeps, task: TaskRecord, now: string, actor: CloseActor, proof?: CloseProof): Promise<CloseParts> {
  const location = await workspaceKeys(deps, task.workspaceId);
  const workspace = await readWorkspace(deps, task.workspaceId);
  const active = workspace?.activeOperationId == null ? undefined : await readOperation(deps, workspace.id, workspace.activeOperationId);
  // The slot goes back once: the marker of the charge must still be there. A task with none (its slot was released, or it was charged in Cloud's
  // older form) is closed all the same, and has no slot to give back.
  const holdsSlot = task.releasedAt === undefined && await deps.store.get(chargeMarkerKey(task.charge, task.taskId)) !== undefined;
  if (!holdsSlot && task.releasedAt === undefined) log(deps, { event: "task_flow.close_without_slot", taskId: task.taskId });
  const items: TransactItem[] = [
    { kind: "check", key: workspaceSessionKey(task.workspaceId), condition: when.and(when.notExists("closeRetention"), when.notExists("closeDestroy")) },
    ...(holdsSlot ? releaseItems(task.charge, task.taskId) : []),
    { kind: "update", key: location.taskPointerKey(), ops: [change.set("cancelledAt", now), change.remove("pendingPrompt"), change.remove("pendingWorkflowMode")] },
    ...stageAudit(deps, { eventId: `task.closed:${task.taskId}`, actor, action: "task.closed", subject: { type: "task", id: task.taskId }, details: { project: task.project } }),
  ];
  if (workspace !== undefined) {
    items.push({
      kind: "update", key: location.workspaceKey,
      ops: [change.set("status", "CLOSED"), change.set("activeOperationId", null), change.set("closedAt", now), change.remove("legacyCloseClaim"), change.set("fence", workspace.fence + 1), change.set("updatedAt", now)],
      // The proof the guard allowed the close on (no machine ever, or its session gone) is part of the commit: a dispatch or a re-created session since the read makes this a conflict.
      condition: when.and(when.eq("fence", workspace.fence), when.eq("legacyCloseClaim", task.taskId), ...(proof?.workspaceConditions ?? [])),
    });
  }
  if (proof?.sessionCheck !== undefined) items.push(proof.sessionCheck);
  if (active !== undefined && !isTerminalStatus(active.status)) {
    items.push({
      kind: "update", key: location.operationKey(active.id), ops: [change.set("status", "INTERRUPTED"), change.set("error", "the task was closed"), change.set("updatedAt", now)],
      condition: when.and(when.eq("status", active.status), when.eq("fence", active.fence)),
    });
  }
  return { taskOps: [change.set("closedAt", now), change.set("updatedAt", now), ...(holdsSlot ? [change.set("releasedAt", now)] : [])], items, workspace, active };
}

/** After a close was committed: the task index shows it closed, and the machines and the allowances held for the task are given back. */
export async function finishClose(deps: TaskFlowDeps, task: TaskRecord, parts: Pick<CloseParts, "workspace" | "active">, now: string): Promise<void> {
  const { workspace, active } = parts;
  // The operation that was running is ended by this close (no result will come): the allowance held for its second review goes back here.
  if (active !== undefined && !isTerminalStatus(active.status)) await deps.secondReview?.operationEnded(active);
  await deps.store.update({ key: taskIndexKey(task.developerId, task.createdAt, task.taskId), ops: [change.set("status", "CLOSED"), change.set("updatedAt", now)], condition: when.present() });
  // The workspace is read again once it is closed: a dispatch may have recorded a machine after the first read, and nothing records one on a closed workspace.
  const closed = await readWorkspace(deps, task.workspaceId);
  await stopMachines(deps, [workspace?.machine?.machineId, closed?.machine?.machineId], [workspace?.machineReservationId, closed?.machineReservationId, task.admissionReservationId]);
  // The host is told once: a task a merge already ended is not announced again by its close (`task-end.ts`).
  await announceTaskEnd(deps, task.taskId, "closed");
  // What the run cost goes to the estimates of the next runs. Best effort: a cost that cannot be read now is simply not counted, and the close stands.
  try { await deps.onTaskClosed?.(task, now); } catch (error) { log(deps, { event: "task_flow.run_cost_not_recorded", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }); }
}

export async function closeTask(deps: TaskFlowDeps, caller: TaskCaller, taskId: string, input?: unknown): Promise<TaskView> {
  if (closeHasDigest(input)) {
    await acceptTaskClose(deps, caller, taskId, input);
    const task = await readTask(deps, taskId);
    if (task === undefined) throw agentXError("TASK_NOT_FOUND", "no such task");
    return taskViewOf(deps, task);
  }
  return closeLoadedTask(deps, await loadOwnedTask(deps, caller, taskId), caller.principal.personId);
}

/** A system closer's close that did not close: nothing was written (the task keeps its slot), and it says why in the words of the guard. */
export interface CloseSkipped { outcome: "skipped"; reason: CloseRefusalReason; words: string }
export type SystemCloseOutcome = { outcome: "closed" | "accepted"; view: TaskView } | CloseSkipped;
/** The system's way in: `closer` names the sweep (the audit and the request id), `key` the thing it closes for (a repeated sweep with the same key replays). */
export interface SystemCloseOptions { mode: "system"; closer: string; key?: string }
export interface PersonCloseOptions { mode?: "person" }

/**
 * Closes a task the flow itself is finished with (a setup run that ended: its workspace, its machine and its slot are given back). `actorId` is who the audit names; the task's own person is
 * the one the start named. It does the same as `closeTask`, with no caller to check: the flow has just read the task's own record.
 *
 * On an install with the guard (`deps.closeGuard`) the close first asks `close-guard.ts`: a PERSON's close of a workspace that may hold work is refused (409 WORKSPACE_BUSY, the guard's exact words, nothing
 * written); the SYSTEM's (`mode: "system"`) is skipped and returned as such, never thrown, so no caller can swallow it unseen. Without the guard it is the plain close it always was.
 */
export function closeLoadedTask(deps: TaskFlowDeps, loaded: TaskRecord, actorId: string, options?: PersonCloseOptions): Promise<TaskView>;
export function closeLoadedTask(deps: TaskFlowDeps, loaded: TaskRecord, actorId: string, options: SystemCloseOptions): Promise<SystemCloseOutcome>;
export async function closeLoadedTask(deps: TaskFlowDeps, loaded: TaskRecord, actorId: string, options: PersonCloseOptions | SystemCloseOptions = {}): Promise<TaskView | SystemCloseOutcome> {
  assertLegacyClose(loaded);
  const system = options.mode === "system" ? options : undefined;
  const guarded = await askGuard(deps, loaded, actorId, system);
  if ("done" in guarded) return guarded.done;
  const view = await closeUnder(deps, loaded, actorId, guarded.proof);
  return system === undefined ? view : { outcome: "closed", view };
}

/** The guard's answer for this close: the proof to commit it under (none on an install without the guard), or the system's outcome when it did not close here. A person's refusal is thrown. */
async function askGuard(deps: TaskFlowDeps, loaded: TaskRecord, actorId: string, system: SystemCloseOptions | undefined): Promise<{ proof: CloseProof | undefined } | { done: SystemCloseOutcome }> {
  if (loaded.closedAt !== undefined || deps.closeGuard === undefined) return { proof: undefined };
  const mode: CloseMode = system === undefined ? "person" : "system";
  const decision = await decideClose(deps, loaded, system === undefined ? actorId : systemCloseActorId(system.closer), mode);
  if (decision.kind === "refuse") throw agentXError("WORKSPACE_BUSY", decision.words);
  if (decision.kind === "close") return { proof: decision.proof };
  if (decision.kind === "skip") return { done: skipped(deps, loaded, system, decision) };
  // A retained preview that says the workspace is clean is the system's to close through (a person presses Close again on the preview, bound).
  if (system === undefined) throw new Error("only a system close goes through a retained preview");
  return { done: await acceptedBySystem(deps, loaded, system, decision.snapshot) };
}

function skipped(deps: TaskFlowDeps, task: TaskRecord, system: SystemCloseOptions | undefined, why: { reason: CloseRefusalReason; words: string }): CloseSkipped {
  log(deps, { event: "task_flow.close_skipped", taskId: task.taskId, closer: system?.closer ?? "person", reason: why.reason });
  return { outcome: "skipped", reason: why.reason, words: why.words };
}

async function acceptedBySystem(deps: TaskFlowDeps, task: TaskRecord, system: SystemCloseOptions, snapshot: CloseSnapshot): Promise<SystemCloseOutcome> {
  const accepted = await acceptSystemClose(deps, task, system.closer, system.key ?? "1", snapshot);
  if (accepted === undefined) return skipped(deps, task, system, { reason: "retained", words: "" });
  const fresh = await readTask(deps, task.taskId);
  if (fresh === undefined) throw agentXError("TASK_NOT_FOUND", "no such task");
  return { outcome: "accepted", view: await taskViewOf(deps, fresh) };
}

async function closeUnder(deps: TaskFlowDeps, loaded: TaskRecord, actorId: string, proof: CloseProof | undefined): Promise<TaskView> {
  await claimLegacyClose(deps, loaded);
  try {
    return await commitLegacyClose(deps, loaded, actorId, proof);
  } catch (error) {
    // A close that did not close gives the workspace back (the claim only serializes this close against a check and a step).
    await releaseLegacyClose(deps, loaded);
    throw error;
  }
}

async function commitLegacyClose(deps: TaskFlowDeps, loaded: TaskRecord, actorId: string, proof: CloseProof | undefined): Promise<TaskView> {
  const taskId = loaded.taskId;
  let task = loaded;
  // A deployed install (money-stop.ts): a model run still going sends its usage before the close ends it. Without `moneyStop` nothing is read or written here.
  if (task.closedAt === undefined && deps.moneyStop !== undefined) await flushBeforeClose(deps, await readWorkspace(deps, task.workspaceId));
  for (let attempt = 1; task.closedAt === undefined && attempt <= CLOSE_ATTEMPTS; attempt += 1) {
    const now = iso(deps);
    const parts = await closeParts(deps, task, now, { type: "person", id: actorId }, proof);
    const items: TransactItem[] = [{ kind: "update", key: taskKey(task.taskId), ops: parts.taskOps, condition: when.and(when.notExists("closedAt"), when.notExists("closeOperationId")) }, ...parts.items];
    let applied;
    try {
      applied = await deps.store.transact(mergeCloseConditions(items));
    } catch (error) {
      if (error instanceof DocumentStoreError && error.code === "conflict") throw agentXError("WORKSPACE_BUSY", CLOSE_TRY_AGAIN_WORDS);
      throw error;
    }
    if (applied.applied) await finishClose(deps, task, parts, now);
    const fresh = await readTask(deps, taskId);
    if (fresh === undefined) throw agentXError("TASK_NOT_FOUND", "no such task");
    assertLegacyClose(fresh);
    task = fresh;
  }
  if (task.closedAt === undefined) throw agentXError("WORKSPACE_BUSY", CLOSE_TRY_AGAIN_WORDS);
  await syncTaskIndex(deps, task.workspaceId);
  return taskViewOf(deps, task);
}

/**
 * The machine is not needed any more, and the allowances held for the task go back. Each step is tried on its own: a machine that will not terminate
 * does not keep an allowance held. A failure leaves a machine the adapter's own idle rules reap; it never reopens the task. (`Admission.settle` takes
 * tokens and cost, not machine time, so the reservations are released; the machine time actually used is a port gap.)
 */
async function stopMachines(deps: TaskFlowDeps, machineIds: ReadonlyArray<string | undefined>, reservationIds: ReadonlyArray<string | undefined>): Promise<void> {
  for (const machineId of new Set(machineIds)) {
    if (machineId === undefined) continue;
    try {
      await deps.machines.terminate(machineId);
    } catch (error) {
      log(deps, { event: "task_flow.terminate_machine_failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }
  for (const reservationId of new Set(reservationIds)) await releaseAdmission(deps, reservationId);
}

function assertLegacyClose(task: TaskRecord): void {
  if (task.closeOperationId !== undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "this task already has an accepted close");
}
