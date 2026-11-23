// What the task flow does when a wiki build run's operation ends (W3b): the run's end word is written ONCE (the first word stands, so a run that already ended by its own last page, a budget stop or a person's Stop keeps its word),
// a run that is still open ends as the person's stop when Stop was pressed and as `infrastructure` otherwise, the build record is told, and the run's workspace, machine and slot go back. Idempotent: a repeat finds the end written.
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { closeLoadedTask } from "../task-flow/close.js";
import type { TaskRecord } from "../task-flow/records.js";
import { readTask } from "../task-flow/reads.js";
import { log } from "../task-flow/support.js";
import { endWikiBuild, readWikiBuildPointer } from "./run.js";

export async function endWikiBuildTask(deps: TaskFlowDeps, task: TaskRecord): Promise<void> {
  const fresh = (await readTask(deps, task.taskId)) ?? task;
  const scope = { orgId: deps.companyId, project: fresh.project, taskId: fresh.taskId };
  // Only this company's own pointer, and only while it is still THIS task's run (a newer run of the project is never ended by an older task's end).
  const pointer = await readWikiBuildPointer(deps.store, deps.companyId, fresh.project);
  if (pointer?.taskId === fresh.taskId) {
    if (pointer.end === undefined) await endWikiBuild(deps.store, scope, pointer.stop === undefined ? "infrastructure" : "stopped_by_person", () => (deps.now?.() ?? new Date()).getTime());
    await deps.wikiBuildEnded?.(scope).catch(() => undefined);
  }
  // A system close: the end word and the pointer are written above, so the guard closes it by type. Without that proof the close is SKIPPED, and said so here, never swallowed.
  const closed = await closeLoadedTask(deps, fresh, fresh.developerId, { mode: "system", closer: "wiki-build" })
    .catch((error: unknown) => { log(deps, { event: "wiki_build.close_failed", taskId: fresh.taskId, error: error instanceof Error ? error.name : "unknown" }); return undefined; });
  if (closed?.outcome === "skipped") log(deps, { event: "wiki_build.close_skipped", taskId: fresh.taskId, reason: closed.reason });
}
