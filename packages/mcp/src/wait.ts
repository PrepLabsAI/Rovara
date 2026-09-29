// Spec 025 US2, D10, R21: waiting on a task. Ending first is not an error; a cancelled call stops at once.
import { ENDED_TASK_STATUSES, type DeveloperTaskView } from "@agentx/contracts";
import type { ControlPlaneClient } from "./client.js";

const FIRST_INTERVAL_MS = 2_000;
const INTERVAL_STEP_MS = 1_000;
const LONGEST_INTERVAL_MS = 5_000;
/** Each read inside a wait gets this long, retries included, so a wait passes its end by at most this. */
export const WAIT_POLL_DEADLINE_MS = 10_000;
/** A progress notification goes out at least this often, even while a read is slow (the spec's bound is 15 s). */
export const WAIT_HEARTBEAT_MS = 10_000;

export interface WaitResult {
  task: DeveloperTaskView;
  /** The wait ran its full time and the task had not ended. */
  timedOut: boolean;
  /** A read failed during the wait: `task` is the last view seen, and this is not a timeout. */
  failure?: unknown;
}

const messageOf = (task: DeveloperTaskView) => `${task.status}: ${task.events.at(-1)?.text ?? "working"}`;

/**
 * Polls the task every 2 seconds, growing to 5, until it ends, the wait ends, or the call is
 * cancelled. A progress notification follows every poll, and a timer sends one while a read is
 * slow, so they are never more than 10 seconds apart. A cancel aborts a read in flight. Starting
 * from `first` (the view a start or continue returned) skips reading the task again at once.
 */
export async function waitForTask(options: {
  client: Pick<ControlPlaneClient, "getTask">;
  taskId: string;
  first?: DeveloperTaskView;
  waitSeconds: number;
  events: number;
  signal: AbortSignal;
  progress?(elapsedSeconds: number, totalSeconds: number, message: string): Promise<void>;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}): Promise<WaitResult> {
  const started = options.now();
  const deadline = started + options.waitSeconds * 1_000;
  const read = () => options.client.getTask(options.taskId, options.events, { signal: options.signal, deadlineMs: WAIT_POLL_DEADLINE_MS });
  let task = options.first ?? (await read());
  let interval = FIRST_INTERVAL_MS;
  // MCP needs each progress value to be greater than the last.
  let reported = -1;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const report = async (): Promise<void> => {
    if (options.progress === undefined || done) return;
    clearTimeout(heartbeat);
    heartbeat = setTimeout(() => { report().catch(() => undefined); }, WAIT_HEARTBEAT_MS);
    const elapsed = Math.min(options.waitSeconds, Math.floor((options.now() - started) / 1_000));
    if (elapsed <= reported || options.signal.aborted) return;
    reported = elapsed;
    await options.progress(elapsed, options.waitSeconds, messageOf(task));
  };
  try {
    for (;;) {
      if (ENDED_TASK_STATUSES.has(task.status)) return { task, timedOut: false };
      const left = deadline - options.now();
      if (left <= 0 || options.signal.aborted) return { task, timedOut: true };
      await report();
      await options.sleep(Math.min(interval, left), options.signal);
      if (options.signal.aborted) return { task, timedOut: true };
      try {
        task = await read();
      } catch (error) {
        if (options.signal.aborted) return { task, timedOut: true };
        return { task, timedOut: false, failure: error };
      }
      interval = Math.min(interval + INTERVAL_STEP_MS, LONGEST_INTERVAL_MS);
    }
  } finally {
    done = true;
    clearTimeout(heartbeat);
  }
}
