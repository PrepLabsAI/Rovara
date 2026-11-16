// Learn on send-back (lessons seam `TaskFlowDeps.lessonsSentBack`, filled by the lessons host): a person's move that sends a task back to coding tells the lessons host, so the correction can help the next task while this
// one is open. Shared by `send-back.ts` and `review-findings.ts`; each calls it once, after its own commit. The host reads the task itself and decides (switch, company, mode, the person's own words, rounds, spend caps).
import type { TaskFlowDeps } from "./deps.js";
import { log } from "./support.js";

/** The longest the send-back waits for the lessons seam; past it the send-back goes on (the seam's own work is ids only and safe to finish later). */
export const LESSONS_TELL_LIMIT_MS = 3_000;

export async function tellLessons(deps: TaskFlowDeps, taskId: string): Promise<void> {
  if (deps.lessonsSentBack === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const told = Promise.resolve().then(() => deps.lessonsSentBack?.(taskId));
    // A seam that fails after the wait ended must not become an unhandled rejection.
    told.catch(() => undefined);
    await Promise.race([told, new Promise<void>((resolve) => { timer = setTimeout(resolve, LESSONS_TELL_LIMIT_MS); })]);
  } catch {
    log(deps, { event: "task_actions.send_back_lessons_not_told", taskId });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
