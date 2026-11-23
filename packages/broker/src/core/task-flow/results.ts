import { workspaceKeys, locateWorkspace } from "./workspace-location.js";
// Lane L6a, task flow core: a worker's terminal result. This is the entry the callback API calls once it has checked the worker's capability
// and read what the worker sent (Cloud's `terminal-result.ts`, whose artifact reading is not ported: it hands the flow a `StepOutcome`).
import { agentXError, companyScoped, change, when, type Condition, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { preparationResultItems, releasePreparationAdmission } from "./prepare-result.js";
import { taskIndexKey } from "./keys.js";
import { runWatchKey } from "./run-watch-rows.js";
import type { OperationResult, StepOutcome } from "./outcome.js";
import { readTask, taskViewOf } from "./reads.js";
import { fromDocument, toDocument, type OperationRecord, type TaskPointerRecord, type WorkspaceRecord } from "./records.js";
import { onOperationEnded, readWorkspace } from "./stage-machine.js";
import { learnModelNotEnabled } from "../model-selection/learn-not-enabled.js";
import { iso } from "./support.js";
import { isSpendStopCode, spendStopReason } from "./money-stop.js";
import { blockStoppedStep } from "./stopped-step.js";
import { acceptedCloseForRun } from "./close-recovery-state.js";

const TERMINAL: ReadonlySet<string> = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
export const isTerminalStatus = (status: string): boolean => TERMINAL.has(status);

export async function readOperation(deps: Pick<TaskFlowDeps, "store" | "companyId">, workspaceId: string, operationId: string): Promise<OperationRecord | undefined> {
  const location = await locateWorkspace(deps, workspaceId);
  if (location === undefined) return undefined;
  const operation = fromDocument<OperationRecord>(await deps.store.get(location.operationKey(operationId)));
  return operation?.companyId === deps.companyId ? operation : undefined;
}

const RESULT_ATTEMPTS = 3;

/**
 * Ends an operation: the operation becomes terminal, the workspace is released (and, for a preparation, becomes READY or PREPARATION_FAILED), and
 * then the task's next move runs. A result for another fence than the operation's is refused (STALE_FENCE). A repeat of a result that was
 * recorded answers `duplicate` and runs the next move again, which is a no-op when the first run took it: a crash between the two commits
 * is thereby mended by the worker's own retry.
 */
type PreparationRecovery = { before: string; outboxStatus: "DEAD" | "absent" };

export async function recordOperationResult(deps: TaskFlowDeps, result: OperationResult, preparationRecovery?: PreparationRecovery): Promise<{ duplicate: boolean }> {
  let operation = await readOperation(deps, result.workspaceId, result.operationId);
  if (operation === undefined || operation.companyId !== deps.companyId) throw agentXError("NOT_FOUND", "operation not found");
  if (operation.fence !== result.fence) throw agentXError("STALE_FENCE", "this result is for an older hold of the workspace");
  // A worker is cancelled only by a cancel the flow asked for. A worker that reports itself cancelled unasked has not finished its step, so it
  // reads as a failure (which blocks the workflow for the owner), never as a quiet end that would leave the step running for ever.
  const { status, error } = normalizedResult(operation, result);
  let duplicate = isTerminalStatus(operation.status);
  for (let attempt = 1; !duplicate && attempt <= RESULT_ATTEMPTS; attempt += 1) {
    const workspace = await readWorkspace(deps, operation.workspaceId);
    const now = iso(deps);
    const holds = workspace !== undefined && workspace.activeOperationId === operation.id && workspace.fence === operation.fence;
    const recovery = recoveryFence(deps, operation, workspace, preparationRecovery);
    if (!recovery.allowed) return { duplicate: true };
    const location = await workspaceKeys(deps, operation.workspaceId);
    const items: TransactItem[] = [{
      kind: "update",
      key: location.operationKey(operation.id),
      ops: [
        change.set("status", status), change.set("updatedAt", now),
        ...(error === undefined ? [] : [change.set("error", error.slice(0, 16_384))]),
        ...(result.outcome === undefined ? [] : [change.set("result", toDocument({ outcome: result.outcome }))]),
      ],
      condition: when.and(...recovery.operation, when.eq("fence", operation.fence), when.not(when.or(when.eq("status", "SUCCEEDED"), when.eq("status", "FAILED"), when.eq("status", "CANCELLED"), when.eq("status", "INTERRUPTED")))),
    }];
    // The operation is no longer watched for a lost machine (`sweepLostRuns`); an end that does not pass here (a close) leaves the row for the sweep to drop.
    items.push({ kind: "delete", key: runWatchKey(deps.companyId, operation.workspaceId, operation.id) });
    if (holds) {
      const prepared = operation.kind === "prepare";
      items.push({
        kind: "update",
        key: location.workspaceKey,
        ops: [
          change.set("activeOperationId", null), change.set("updatedAt", now),
          change.set("status", prepared ? (status === "SUCCEEDED" ? "READY" : "PREPARATION_FAILED") : "READY"),
        ],
        condition: when.and(...recovery.workspace, when.eq("activeOperationId", operation.id), when.eq("fence", operation.fence)),
      });
    }
    items.push(...recovery.items);
    items.push(...await preparationResultItems(deps, operation, status));
    const applied = await deps.store.transact(items);
    if (applied.applied) break;
    if (preparationRecovery !== undefined) return { duplicate: true };
    // Lost a race: read again. The operation may have been ended by another path.
    const fresh = await readOperation(deps, operation.workspaceId, operation.id);
    if (fresh === undefined) throw agentXError("NOT_FOUND", "operation not found");
    operation = fresh;
    duplicate = isTerminalStatus(fresh.status);
  }
  const ended = await readOperation(deps, operation.workspaceId, operation.id);
  if (ended === undefined || !isTerminalStatus(ended.status)) throw agentXError("WORKSPACE_BUSY", "could not record the result just now; send it again");
  if (await acceptedCloseForRun(deps, ended) !== undefined) return { duplicate };
  return finishRecordedResult(deps, ended, duplicate);
}

async function finishRecordedResult(deps: TaskFlowDeps, ended: OperationRecord, duplicate: boolean): Promise<{ duplicate: boolean }> {
  // The model proxy frees the operation's tokens and spend record now, not at its next refused call (a repeat of the result does it again, harmlessly).
  try { deps.onOperationEnded?.(ended.id); } catch { /* a proxy's bookkeeping never fails a result */ }
  await deps.secondReview?.operationEnded(ended);
  await releasePreparationAdmission(deps, ended);
  // A step that failed because its model could not be called (not enabled for the account, or not priced under a limit) teaches the next choice to leave that model out for a while. Best effort: it never changes the result.
  await learnModelNotEnabled(deps.usableModels, { model: ended.modelChoice?.model }, ended.status, ended.error, ended.result);
  // The next move is made from what was RECORDED, never from a repeat's own words: a late retry cannot turn a failure into a success.
  const recorded = (ended.result as { outcome?: StepOutcome } | undefined)?.outcome;
  await onOperationEnded(deps, ended, { status: ended.status as OperationResult["status"], ...(ended.error === undefined ? {} : { error: ended.error }), ...(recorded === undefined ? {} : { outcome: recorded }) });
  // A run stopped at its spending limit (money-stop.ts) waits for its owner with the fixed reason, however its end came (its worker's result, or the backstop's).
  if (deps.moneyStop !== undefined && ended.status === "CANCELLED" && isSpendStopCode(ended.stopReason)) {
    const taskId = (await deps.store.get((await workspaceKeys({ store: deps.store, companyId: ended.companyId }, ended.workspaceId)).taskPointerKey()))?.["taskId"];
    if (typeof taskId === "string" && taskId !== "") await blockStoppedStep(deps, taskId, ended, spendStopReason(ended.stopReason));
  }
  await syncTaskIndex(deps, ended.workspaceId);
  return { duplicate };
}

/** Keeps the task's index row (what a list shows) in step with the status its records give. Best effort: the records are the truth. */
export async function syncTaskIndex(deps: TaskFlowDeps, workspaceId: string): Promise<void> {
  try {
    const pointer = fromDocument<TaskPointerRecord>(await deps.store.get((await workspaceKeys(deps, workspaceId)).taskPointerKey()));
    const task = pointer === undefined ? undefined : await readTask(deps, pointer.taskId);
    if (task === undefined) return;
    const view = await taskViewOf(deps, task);
    await deps.store.update({ key: taskIndexKey(task.developerId, task.createdAt, task.taskId), ops: [change.set("status", view.status), change.set("updatedAt", iso(deps))], condition: when.present() });
  } catch {
    // The index is a convenience for lists.
  }
}

function normalizedResult(operation: OperationRecord, result: OperationResult): { status: OperationResult["status"]; error: string | undefined } {
  const unaskedCancel = result.status === "CANCELLED" && operation.status !== "CANCEL_REQUESTED" && !isTerminalStatus(operation.status);
  const status: OperationResult["status"] = unaskedCancel ? "FAILED" : result.status;
  const error = unaskedCancel ? (result.error ?? "the worker stopped the job without being asked") : result.error;
  return { status, error };
}

/** Extra read predicates and their atomic equivalents for the internal scheduled orphan repair. */
function recoveryFence(deps: TaskFlowDeps, operation: OperationRecord, workspace: WorkspaceRecord | undefined, recovery: PreparationRecovery | undefined): { allowed: boolean; operation: Condition[]; workspace: Condition[]; items: TransactItem[] } {
  if (recovery === undefined) return { allowed: true, operation: [], workspace: [], items: [] };
  const allowed = workspace?.status === "PREPARING" && workspace?.activeOperationId === operation.id && workspace?.fence === operation.fence && operation.kind === "prepare" && operation.status === "ACCEPTED" && operation.deliveredAt === undefined && Date.parse(operation.createdAt) < Date.parse(recovery.before);
  return { allowed,
    operation: [when.eq("kind", "prepare"), when.eq("status", "ACCEPTED"), when.notExists("deliveredAt"), when.eq("createdAt", operation.createdAt)],
    workspace: [when.eq("status", "PREPARING")],
    items: [{ kind: "check", key: { pk: companyScoped(deps.companyId, `OUTBOX#${operation.id}`), sk: "OUTBOX" }, condition: recovery.outboxStatus === "DEAD" ? when.eq("status", "DEAD") : when.absent() }],
  };
}
