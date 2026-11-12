// The task-end seam: a task ends once, and the host is told once (`TaskFlowDeps.taskEnded`: what a task kept only for its own lifetime, such as live-only source text, goes now).
//
// A task ends in one of two ways: the person closes it, or a merged pull request completes it (every required pull request merged: the workflow reaches MERGED). Either may come first, and the other may follow:
// a merged task can still be closed by the person later, and a redelivered merge is seen again. Both go through `announceTaskEnd`, which keeps one marker row in the task's own partition. The first end writes the
// marker and calls the seam; a later end finds the marker and does not call it again.
//
// "Once" is for a host that took the call. A host whose seam failed (or whose process stopped before it answered) has no confirmed delivery on the marker, so the next end calls it again with the same event
// (`{ orgId, taskId }`); a host's handler is therefore idempotent, as the handlers of Code's local app are (they drop what a task kept, and dropping it twice is the same as once).
import { change, when, type WorkflowSnapshot } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { iso, log } from "./support.js";

export type TaskEndCause = "closed" | "merged";

/** The marker row of a task's end, in the task's own partition. */
export const taskEndKey = (taskId: string): { pk: string; sk: string } => ({ pk: `DEVTASK#${taskId}`, sk: "TASK_END" });

/** Whether a save moved the workflow into the end a merge brings (every required pull request merged), as opposed to a workflow that was already there. */
export const completedByMerge = (before: Pick<WorkflowSnapshot, "stage"> | undefined, after: Pick<WorkflowSnapshot, "stage" | "state" | "outcome">): boolean =>
  after.stage === "MERGED" && after.state === "COMPLETE" && after.outcome === "MERGED" && before?.stage !== "MERGED";

/**
 * Tells the host that a task ended, once. Best effort, like the seam: it never throws and never fails the close or the merge that called it. Nothing is written when the host has no seam.
 * Returns whether the host was called by this end.
 */
export async function announceTaskEnd(deps: Pick<TaskFlowDeps, "store" | "companyId" | "taskEnded" | "now" | "log">, taskId: string, cause: TaskEndCause): Promise<boolean> {
  const taskEnded = deps.taskEnded;
  if (taskEnded === undefined) return false;
  try {
    const key = taskEndKey(taskId);
    const at = iso(deps);
    const first = await deps.store.put({ item: { ...key, entityType: "TASK_END", taskId, cause, at }, condition: when.absent() });
    if (!first.applied) {
      // An earlier end wrote the marker. If it also got the host's answer, this end has nothing to tell.
      const earlier = await deps.store.get(key);
      if (earlier === undefined || earlier["notifiedAt"] !== undefined) return false;
    }
    try {
      await taskEnded({ orgId: deps.companyId, taskId });
    } catch (error) {
      log(deps, { event: "task_flow.task_ended_failed", error: error instanceof Error ? error.name : "unknown" });
      return true;
    }
    // The answer is kept, so a later end does not call the host again. A write that fails here only means the next end calls it once more.
    await deps.store.update({ key, ops: [change.set("notifiedAt", at)], condition: when.present() }).catch(() => undefined);
    return true;
  } catch (error) {
    log(deps, { event: "task_flow.task_end_unrecorded", taskId, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}
