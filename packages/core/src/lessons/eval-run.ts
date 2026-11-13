// An eval or replay run never feeds learning. Lessons learn only from HISTORICAL outcomes. The task record carries a marker (`evalRun`); a task with the marker is not a
// piece of the team's work. Every learning path refuses it: the production task source hands out nothing for it, the task-end and human-edit reflections stop at it, the reflector refuses it before it builds
// a prompt, and the counters ignore its outcome. `tests/unit/lessons/eval-run-refusal.test.ts` keeps the list of places that call a learning model.

/**
 * Whether a task record's `evalRun` mark says the task is an eval run. FAIL CLOSED: absent, null and false are a real task; any other value, even a malformed one ("yes", an object), is an eval run, so a task
 * whose mark was written wrongly is never learned from.
 */
export function isEvalRunMark(mark: unknown): boolean {
  return mark !== undefined && mark !== null && mark !== false;
}
