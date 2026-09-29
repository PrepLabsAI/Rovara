// Spec 025 FR-054, C12: a continue-mode turn starts only once the task's workspace has no active
// operation (the developer's own run, or the operation the previous channel turn started), waiting
// at most 30 minutes. The consumer's heartbeat keeps the queue message invisible meanwhile.
import { CHANNEL_TURN_WAIT_MS, type SlackThreadWorkspaceResult } from "@agentx/contracts";
import { withDeadline } from "./lazy-worker.js";
import type { ServiceLog, ThreadServiceApi } from "./processor.js";

export const TASK_BUSY_WAIT_MESSAGE = "The task is busy with other work right now. I'll start on this as soon as it's free.";
export const TASK_STILL_BUSY_MESSAGE = "The task was still busy after 30 minutes, so I didn't run this request. Mention me again when it's free.";
export const SHARED_SETUP_FAILED_MESSAGE = "This task's workspace could not be set up, so I can't run requests in this thread. The developer who started the task can close it and start a new one from their AI tool.";
export const SHARED_CLOSE_REFUSED_MESSAGE = "This thread follows a task started from an AI tool. Only the developer who started it can close it, from their AI tool.";

type WorkspaceAnswer = Extract<SlackThreadWorkspaceResult, { outcome: "WORKSPACE" }>;
const SAME_OPERATION_PAUSE_MS = 5_000;
/**
 * The developer's own run is never named, so there is nothing to wait on but the next answer. Each
 * ask is a full workspace request, so they come every 15 seconds (at most about 120 in 30 minutes).
 */
const HIDDEN_RUN_PAUSE_MS = 15_000;

/**
 * C12: the task's workspace is taken. The broker names the running operation only when the channel
 * started it; the developer's own run comes as `activeOperation: "developer"` with no ID (D22).
 */
export function taskBusy(answer: SlackThreadWorkspaceResult): answer is WorkspaceAnswer {
  return answer.outcome === "WORKSPACE" && (answer.operationId !== null || answer.activeOperation === "developer");
}

export async function waitForIdleTask(input: {
  api: Pick<ThreadServiceApi, "ensureWorkspace" | "waitForOperation">;
  requestId: string;
  first: WorkspaceAnswer;
  post: (text: string) => Promise<void>;
  log: ServiceLog;
  eventId: string;
  now: () => number;
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * False on an SQS redelivery: the earlier attempt already told the thread to wait. An earlier
   * attempt that failed before its post leaves the redelivery waiting silently. That is accepted: a
   * repeated wait notice on every redelivery is the worse trade, and the member still gets the
   * start or the still-busy reply when the wait ends.
   */
  announce?: boolean;
}): Promise<SlackThreadWorkspaceResult | "BUSY"> {
  const until = input.now() + (input.deadlineMs ?? CHANNEL_TURN_WAIT_MS);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (input.announce !== false) await input.post(TASK_BUSY_WAIT_MESSAGE);
  input.log("shared_task.waiting", { eventId: input.eventId });
  let current: SlackThreadWorkspaceResult = input.first;
  let waitedFor: string | undefined;
  while (taskBusy(current)) {
    const remaining = until - input.now();
    if (remaining <= 0) return "BUSY";
    if (current.operationId === null) {
      // The developer's own run, which the broker does not name: a pause before asking again.
      await sleep(Math.min(HIDDEN_RUN_PAUSE_MS, remaining));
    } else if (current.operationId === waitedFor) {
      // A run that ended while the workspace still names it: a brief pause, never a hot loop.
      await sleep(Math.min(SAME_OPERATION_PAUSE_MS, remaining));
    } else {
      const controller = new AbortController();
      const settled = await withDeadline(input.api.waitForOperation(current.workspaceId, current.operationId, controller.signal), remaining, controller);
      if (settled === "TIMED_OUT") return "BUSY";
      waitedFor = current.operationId;
    }
    current = await input.api.ensureWorkspace(input.requestId);
  }
  return current;
}
