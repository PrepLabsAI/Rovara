// A lesson-set rollback with the normal tier check run again on every restored lesson. `rollbackLessonSet` takes the check as a hook
// (`onRestored`); this is the one place that passes it, so no caller can restore a set without it. A restored lesson is settled with `noAutoApply`: it comes back pending
// and needing a person (the store already dropped any automatic approval), and settling can raise its tier but never lets it go live by itself.
import { rollbackLessonSet, type ApproveDeps } from "./approve.js";
import { settleLesson, type ProcessDeps } from "./process.js";

export type RollbackInput = Omit<Parameters<typeof rollbackLessonSet>[1], "onRestored">;

export function rollbackLessonSetSettled(deps: ApproveDeps & ProcessDeps, input: RollbackInput): ReturnType<typeof rollbackLessonSet> {
  const key = { workspaceId: input.workspaceId, project: input.project };
  return rollbackLessonSet(deps, { ...input, onRestored: (lessonId) => settleLesson(deps, key, lessonId, { noAutoApply: true }) });
}
