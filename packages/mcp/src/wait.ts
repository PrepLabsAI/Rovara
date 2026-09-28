// Spec 025 US2, D10, R21: waiting on a task. Ending first is not an error; a cancelled call stops at once.
import { ENDED_TASK_STATUSES, type DeveloperTaskView } from "@agentx/contracts";
import type { ControlPlaneClient } from "./client.js";

const FIRST_INTERVAL_MS = 2_000;
const INTERVAL_STEP_MS = 1_000;
const LONGEST_INTERVAL_MS = 5_000;

/**
 * Polls the task every 2 seconds, growing to 5, until it ends, the wait ends, or the call is
 * cancelled. A progress notification follows every poll, so they are never more than 5 seconds
 * apart (the spec's bound is 15). A cancelled call returns what it last saw and polls no more.
 */
export async function waitForTask(options: {
  client: Pick<ControlPlaneClient, "getTask">;
  taskId: string;
  waitSeconds: number;
  events: number;
  signal: AbortSignal;
  progress?(elapsedSeconds: number, totalSeconds: number, message: string): Promise<void>;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}): Promise<{ task: DeveloperTaskView; timedOut: boolean }> {
  const started = options.now();
  const deadline = started + options.waitSeconds * 1_000;
  let interval = FIRST_INTERVAL_MS;
  // MCP needs each progress value to be greater than the last.
  let reported = -1;
  let task = await options.client.getTask(options.taskId, options.events);
  for (;;) {
    if (ENDED_TASK_STATUSES.has(task.status)) return { task, timedOut: false };
    const left = deadline - options.now();
    if (left <= 0 || options.signal.aborted) return { task, timedOut: true };
    const elapsed = Math.min(options.waitSeconds, Math.round((options.now() - started) / 1_000));
    if (options.progress !== undefined && elapsed > reported) {
      reported = elapsed;
      await options.progress(elapsed, options.waitSeconds, `${task.status}: ${task.events.at(-1)?.text ?? "working"}`);
    }
    await options.sleep(Math.min(interval, left), options.signal);
    if (options.signal.aborted) return { task, timedOut: true };
    task = await options.client.getTask(options.taskId, options.events);
    interval = Math.min(interval + INTERVAL_STEP_MS, LONGEST_INTERVAL_MS);
  }
}
