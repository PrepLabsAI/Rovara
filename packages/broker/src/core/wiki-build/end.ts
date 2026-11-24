// What the task flow does when a wiki build run's operation ends (W3b): the run's end word is written ONCE (the first word stands, so a run that already ended by its own last page, a budget stop or a person's Stop keeps its word),
// a run that is still open ends as the person's stop when Stop was pressed and as `infrastructure` otherwise, the build record is told, and the run's workspace, machine and slot go back. Idempotent: a repeat finds the end written.
import { isPinMovedError } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { closeLoadedTask } from "../task-flow/close.js";
import type { TaskRecord } from "../task-flow/records.js";
import { readTask } from "../task-flow/reads.js";
import { log } from "../task-flow/support.js";
import { endWikiBuild, readWikiBuildPointer } from "./run.js";

/**
 * `failedPreparation`: the error of the run's PREPARATION when that is what ended (nothing else says why a run with no word ended). A preparation that found the commit it was pinned to gone from the default branch ends the run
 * `code_moved` (its own words, and the next Build pins again); any other end without a word is `infrastructure`.
 */
export async function endWikiBuildTask(deps: TaskFlowDeps, task: TaskRecord, failedPreparation?: { error: string | undefined }): Promise<void> {
  const fresh = (await readTask(deps, task.taskId)) ?? task;
  const scope = { orgId: deps.companyId, project: fresh.project, taskId: fresh.taskId };
  // Only this company's own pointer, and only while it is still THIS task's run (a newer run of the project is never ended by an older task's end).
  const pointer = await readWikiBuildPointer(deps.store, deps.companyId, fresh.project);
  if (pointer?.taskId === fresh.taskId) {
    const word = pointer.stop !== undefined ? "stopped_by_person" : failedPreparation !== undefined && isPinMovedError(failedPreparation.error) ? "code_moved" : "infrastructure";
    if (pointer.end === undefined) await endWikiBuild(deps.store, scope, word, () => (deps.now?.() ?? new Date()).getTime());
    await deps.wikiBuildEnded?.(scope).catch(() => undefined);
  }
  await closeLoadedTask(deps, fresh, fresh.developerId).catch((error: unknown) => log(deps, { event: "wiki_build.close_failed", taskId: fresh.taskId, error: error instanceof Error ? error.name : "unknown" }));
  await resnapshotAfterMove(deps, fresh, scope);
}

/**
 * A run that ended `code_moved` (its pinned commit is gone from the branch) is started again ONCE over a new snapshot, with no person asked: the run's workspace, machine and company slot are already given back above, so the new run
 * starts clean. A run that is itself such a retry never starts another (its pointer says so, `resnapshotOf`), so there is no loop. The log line says the old and the new pins.
 */
async function resnapshotAfterMove(deps: TaskFlowDeps, task: TaskRecord, scope: { orgId: string; project: string; taskId: string }): Promise<void> {
  if (deps.wikiBuildResnapshot === undefined) return;
  const ended = await readWikiBuildPointer(deps.store, deps.companyId, task.project);
  if (ended?.taskId !== task.taskId || ended.end?.word !== "code_moved" || ended.resnapshotOf !== undefined) return;
  const next = await deps.wikiBuildResnapshot({ project: task.project, taskId: task.taskId }).catch(() => undefined);
  if (next === undefined) { log(deps, { event: "wiki_build.resnapshot_not_started", taskId: scope.taskId }); return; }
  const started = await readWikiBuildPointer(deps.store, deps.companyId, task.project);
  log(deps, { event: "wiki_build.resnapshot", taskId: scope.taskId, newTaskId: next, oldPins: ended.pins, newPins: started?.taskId === next ? started.pins : undefined });
}
