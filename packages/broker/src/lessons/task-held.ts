// Public's per-task cap, shared by every run of one task (the task-end reflection and the human-edit job, in either order). Holds only task ids and counts: nothing about a person.
import type { TaskFailureTally } from "./pause.js";
import type { LessonStore, ScopeKey } from "./store.js";

/**
 * Public's per-task cap is one total for the task, across the task-end run and the human-edit job, in any order. What the task has held is a ladder of once-keys, one per whole cent (rounded up):
 * `task-held:<task>:<n>`. No store method is added. A read counts the steps from 1 until one is missing. A call RESERVES its hold by taking the next free steps one at a time (`markOnce` is atomic, so two runs at once never
 * take the same step), and fails when the cap's steps are used up. Runs whose holds are not reserved call by call (the first reflection, the judges) top the ladder up to their tally when they end (`noteTaskHeld`). The total only
 * grows, and holds only task ids (nothing about a person). Enterprise has no cap and neither reads nor writes it.
 */
const HELD_STEP_USD = 0.01;
const HELD_MAX_STEPS = 100;
const heldName = (taskId: string, step: number): string => `task-held:${taskId}:${String(step)}`;
const stepsOf = (usd: number): number => Math.max(0, Math.ceil(usd / HELD_STEP_USD - 1e-9));
const maxStepsOf = (capUsd: number | undefined): number => (capUsd === undefined ? HELD_MAX_STEPS : Math.max(1, stepsOf(capUsd)));
export async function readTaskHeld(store: Pick<LessonStore, "seenOnce">, key: ScopeKey, taskId: string, capUsd?: number): Promise<number> {
  let steps = 0;
  const max = maxStepsOf(capUsd);
  while (steps < max && await store.seenOnce(key, heldName(taskId, steps + 1))) steps += 1;
  return Math.round(steps * HELD_STEP_USD * 100) / 100;
}
/** Tops the ladder up to at least `usd`. */
export async function noteTaskHeld(store: Pick<LessonStore, "seenOnce" | "markOnce">, key: ScopeKey, taskId: string, usd: number, capUsd?: number): Promise<void> {
  const wanted = Math.min(maxStepsOf(capUsd), stepsOf(usd));
  for (let step = stepsOf(await readTaskHeld(store, key, taskId, capUsd)) + 1; step <= wanted; step += 1) await store.markOnce(key, heldName(taskId, step));
}
/** Reserves `usd` of the task's cap: takes that many free steps. False when the cap's steps run out first (the steps taken stay taken: a refusal is conservative). */
export async function reserveTaskHeld(store: Pick<LessonStore, "seenOnce" | "markOnce">, key: ScopeKey, taskId: string, usd: number, capUsd: number): Promise<boolean> {
  const need = stepsOf(usd);
  const max = maxStepsOf(capUsd);
  let taken = 0;
  for (let step = stepsOf(await readTaskHeld(store, key, taskId, capUsd)) + 1; step <= max && taken < need; step += 1) if (await store.markOnce(key, heldName(taskId, step))) taken += 1;
  return taken >= need;
}

/** Puts the task's shared cap ledger on its tally (idempotent): every paid call of the task that has the tally reserves its hold on the ladder before it is made. */
export function attachCapLadder(tally: TaskFailureTally, store: Pick<LessonStore, "seenOnce" | "markOnce">, key: ScopeKey, taskId: string, capUsd: number): void {
  tally.reserve ??= (usd) => reserveTaskHeld(store, key, taskId, usd, capUsd);
}
