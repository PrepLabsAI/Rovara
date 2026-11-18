// L4-U5b: a Slack mention that starts a workflow for a company the core serves. The core refuses a start that asks to be shared to a channel (it has no channel share), so this start names none: the task is the core's,
// started as the Slack person's linked Rovara person (the caller the broker already checked), and the Slack thread it came from is REMEMBERED (`CoreTaskEntry.recordThread`) so what the task later tells that thread (a
// pause at Build for a broken setup, the pull request, the end: `core/channel/thread-notices.ts`) has somewhere to go. `undefined`: not the core's (no core entry, or a company the switch does not send to the core), and the
// broker starts exactly what it started before.
//
// The thread is remembered after the start and only by this caller for their own task (the core re-checks the caller's membership, that they may act on the task and that the thread's workspace is their company's). A thread
// that could not be remembered does not undo the start (the task runs; it just tells nothing in Slack), and is logged in fixed words.
import { SLACK_CHANNEL, agentXError, type SlackThread } from "@agentx/contracts";
import { startOnCore, type CoreEntryCaller, type CoreTaskEntry } from "./engine-boundary.js";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface SlackCoreStartInput {
  caller: CoreEntryCaller;
  thread: SlackThread;
  /** The Slack member who asked (their Slack user id). */
  userId: string;
  requestId: string;
  project: string;
  instructions: string;
  workflowPath: "QUICK" | "FULL";
}

export async function startSlackWorkflowOnCore(entry: CoreTaskEntry | undefined, input: SlackCoreStartInput, log: (entry: Record<string, unknown>) => void = () => undefined): Promise<{ taskId: string } | undefined> {
  const started = await startOnCore(entry, {
    method: "POST", path: "/v1/dev/tasks", headers: {}, requestId: input.requestId,
    body: JSON.stringify({ requestId: input.requestId, project: input.project, instructions: input.instructions, client: "slack", workflow: true, workflowPath: input.workflowPath }),
  }, input.caller);
  if (started === undefined) return undefined;
  const task = (started.value as { task?: { taskId?: unknown } } | null)?.task;
  const taskId = typeof task?.taskId === "string" && TASK_ID.test(task.taskId) ? task.taskId : undefined;
  // The core answered a start but not with a task it made: never fall back to the old start (that could make a second task).
  if (taskId === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The core engine's answer could not be read.");
  let recorded: boolean;
  try {
    recorded = await entry?.recordThread?.(input.caller, {
      taskId,
      conversation: { channel: SLACK_CHANNEL, tenant: input.thread.teamId, space: input.thread.channelId, thread: input.thread.threadTs },
      actor: { channel: SLACK_CHANNEL, tenant: input.thread.teamId, userId: input.userId },
    }) === true;
  } catch { recorded = false; }
  if (!recorded) log({ event: "slack_core_start.thread_not_recorded" });
  return { taskId };
}
