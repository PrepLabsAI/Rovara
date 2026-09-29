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
}): Promise<SlackThreadWorkspaceResult | "BUSY"> {
  const until = input.now() + (input.deadlineMs ?? CHANNEL_TURN_WAIT_MS);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await input.post(TASK_BUSY_WAIT_MESSAGE);
  input.log("shared_task.waiting", { eventId: input.eventId });
  let current: SlackThreadWorkspaceResult = input.first;
  let waitedFor: string | undefined;
  while (current.outcome === "WORKSPACE" && current.operationId !== null) {
    const remaining = until - input.now();
    if (remaining <= 0) return "BUSY";
    if (current.operationId === waitedFor) {
      // The operation ended but the workspace still names it: a brief pause, never a hot loop.
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
