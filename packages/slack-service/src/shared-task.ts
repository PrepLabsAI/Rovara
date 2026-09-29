// Spec 025 FR-054, C12: a continue-mode turn starts only once the task's workspace has no active
// operation (the developer's own run, or the operation the previous channel turn started), waiting
// at most 30 minutes. The consumer's heartbeat keeps the queue message invisible meanwhile.
import { CHANNEL_TURN_WAIT_MS, type SlackThreadWorkspaceResult } from "@agentx/contracts";
import { withDeadline } from "./lazy-worker.js";
import type { ServiceLog, ThreadServiceApi } from "./processor.js";

export const TASK_BUSY_WAIT_MESSAGE = "The task is busy with other work right now. I'll start on this as soon as it's free.";
export const TASK_STILL_BUSY_MESSAGE = "The task was still busy after 30 minutes, so I didn't run this request. Mention me again when it's free.";
export const SHARED_CLOSE_REFUSED_MESSAGE = "This thread follows a task started from an AI tool. Only the developer who started it can close it, from their AI tool.";

type WorkspaceAnswer = Extract<SlackThreadWorkspaceResult, { outcome: "WORKSPACE" }>;
const SAME_OPERATION_PAUSE_MS = 5_000;

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
  /** False on an SQS redelivery: the earlier attempt already told the thread to wait. */
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
    if (current.operationId === null || current.operationId === waitedFor) {
      // The developer's own run, which the broker does not name, or a run that ended while the
      // workspace still names it: a brief pause before asking again, never a hot loop.
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
