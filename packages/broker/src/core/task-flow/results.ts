// Lane L6a, task flow core: a worker's terminal result. This is the entry the callback API calls once it has checked the worker's capability
// and read what the worker sent (Cloud's `terminal-result.ts`, whose artifact reading is not ported: it hands the flow a `StepOutcome`).
import { agentXError, change, when, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { operationKey, taskIndexKey, workspaceKey } from "./keys.js";
import { runWatchKey } from "./run-watch-rows.js";
import type { OperationResult, StepOutcome } from "./outcome.js";
import { readTask, taskViewOf } from "./reads.js";
import { fromDocument, toDocument, type OperationRecord, type TaskPointerRecord } from "./records.js";
import { onOperationEnded, readWorkspace } from "./stage-machine.js";
import { learnModelNotEnabled } from "../model-selection/learn-not-enabled.js";
import { iso } from "./support.js";
import { taskPointerKey } from "./keys.js";

const TERMINAL: ReadonlySet<string> = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
export const isTerminalStatus = (status: string): boolean => TERMINAL.has(status);

export async function readOperation(deps: Pick<TaskFlowDeps, "store">, workspaceId: string, operationId: string): Promise<OperationRecord | undefined> {
  return fromDocument<OperationRecord>(await deps.store.get(operationKey(workspaceId, operationId)));
}

const RESULT_ATTEMPTS = 3;

/**
 * Ends an operation: the operation becomes terminal, the workspace is released (and, for a preparation, becomes READY or PREPARATION_FAILED), and
 * then the task's next move runs. A result for another fence than the operation's is refused (STALE_FENCE). A repeat of a result that was
 * recorded answers `duplicate` and runs the next move again, which is a no-op when the first run took it: a crash between the two commits
 * is thereby mended by the worker's own retry.
 */
export async function recordOperationResult(deps: TaskFlowDeps, result: OperationResult): Promise<{ duplicate: boolean }> {
  let operation = await readOperation(deps, result.workspaceId, result.operationId);
  if (operation === undefined || operation.companyId !== deps.companyId) throw agentXError("NOT_FOUND", "operation not found");
  if (operation.fence !== result.fence) throw agentXError("STALE_FENCE", "this result is for an older hold of the workspace");
  // A worker is cancelled only by a cancel the flow asked for. A worker that reports itself cancelled unasked has not finished its step, so it
  // reads as a failure (which blocks the workflow for the owner), never as a quiet end that would leave the step running for ever.
  const unaskedCancel = result.status === "CANCELLED" && operation.status !== "CANCEL_REQUESTED" && !isTerminalStatus(operation.status);
  const status: OperationResult["status"] = unaskedCancel ? "FAILED" : result.status;
  const error = unaskedCancel ? (result.error ?? "the worker stopped the job without being asked") : result.error;
  let duplicate = isTerminalStatus(operation.status);
  for (let attempt = 1; !duplicate && attempt <= RESULT_ATTEMPTS; attempt += 1) {
    const workspace = await readWorkspace(deps, operation.workspaceId);
    const now = iso(deps);
    const holds = workspace !== undefined && workspace.activeOperationId === operation.id && workspace.fence === operation.fence;
    const items: TransactItem[] = [{
      kind: "update",
      key: operationKey(operation.workspaceId, operation.id),
      ops: [
        change.set("status", status), change.set("updatedAt", now),
        ...(error === undefined ? [] : [change.set("error", error.slice(0, 16_384))]),
        ...(result.outcome === undefined ? [] : [change.set("result", toDocument({ outcome: result.outcome }))]),
      ],
      condition: when.and(when.eq("fence", operation.fence), when.not(when.or(when.eq("status", "SUCCEEDED"), when.eq("status", "FAILED"), when.eq("status", "CANCELLED"), when.eq("status", "INTERRUPTED")))),
    }];
    // The operation is no longer watched for a lost machine (`sweepLostRuns`); an end that does not pass here (a close) leaves the row for the sweep to drop.
    items.push({ kind: "delete", key: runWatchKey(deps.companyId, operation.workspaceId, operation.id) });
    if (holds) {
      const prepared = operation.kind === "prepare";
      items.push({
        kind: "update",
        key: workspaceKey(operation.workspaceId),
        ops: [
          change.set("activeOperationId", null), change.set("updatedAt", now),
          change.set("status", prepared ? (status === "SUCCEEDED" ? "READY" : "PREPARATION_FAILED") : "READY"),
        ],
        condition: when.and(when.eq("activeOperationId", operation.id), when.eq("fence", operation.fence)),
      });
    }
    const applied = await deps.store.transact(items);
    if (applied.applied) break;
    // Lost a race: read again. The operation may have been ended by another path.
    const fresh = await readOperation(deps, operation.workspaceId, operation.id);
    if (fresh === undefined) throw agentXError("NOT_FOUND", "operation not found");
    operation = fresh;
    duplicate = isTerminalStatus(fresh.status);
  }
  const ended = await readOperation(deps, operation.workspaceId, operation.id);
  if (ended === undefined || !isTerminalStatus(ended.status)) throw agentXError("WORKSPACE_BUSY", "could not record the result just now; send it again");
  // The model proxy frees the operation's tokens and spend record now, not at its next refused call (a repeat of the result does it again, harmlessly).
  try { deps.onOperationEnded?.(ended.id); } catch { /* a proxy's bookkeeping never fails a result */ }
  await deps.secondReview?.operationEnded(ended);
  // A step that failed because its model could not be called (not enabled for the account, or not priced under a limit) teaches the next choice to leave that model out for a while. Best effort: it never changes the result.
  await learnModelNotEnabled(deps.usableModels, { model: ended.modelChoice?.model }, ended.status, ended.error, ended.result);
  // The next move is made from what was RECORDED, never from a repeat's own words: a late retry cannot turn a failure into a success.
  const recorded = (ended.result as { outcome?: StepOutcome } | undefined)?.outcome;
  await onOperationEnded(deps, ended, { status: ended.status as OperationResult["status"], ...(ended.error === undefined ? {} : { error: ended.error }), ...(recorded === undefined ? {} : { outcome: recorded }) });
  await syncTaskIndex(deps, ended.workspaceId);
  return { duplicate };
}

/** Keeps the task's index row (what a list shows) in step with the status its records give. Best effort: the records are the truth. */
export async function syncTaskIndex(deps: TaskFlowDeps, workspaceId: string): Promise<void> {
  try {
    const pointer = fromDocument<TaskPointerRecord>(await deps.store.get(taskPointerKey(workspaceId)));
    const task = pointer === undefined ? undefined : await readTask(deps, pointer.taskId);
    if (task === undefined) return;
    const view = await taskViewOf(deps, task);
    await deps.store.update({ key: taskIndexKey(task.developerId, task.createdAt, task.taskId), ops: [change.set("status", view.status), change.set("updatedAt", iso(deps))], condition: when.present() });
  } catch {
    // The index is a convenience for lists.
  }
}
