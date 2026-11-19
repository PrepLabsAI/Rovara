// L4-U5b: a Slack mention that starts a workflow for a company the core serves. The core refuses a start that asks to be shared to a channel (it has no channel share), so this start names none: the task is the core's,
// started as the Slack person's linked Rovara person (the caller the broker already checked), and the Slack thread it came from is REMEMBERED (`CoreTaskEntry.recordThread`) so what the task later tells that thread (a
// pause at Build for a broken setup, the pull request, the end: `core/channel/thread-notices.ts`) has somewhere to go. `undefined`: not the core's (no core entry, or a company the switch does not send to the core), and the
// broker starts exactly what it started before.
//
// The thread is remembered after the start and only by this caller for their own task (the core re-checks the caller's membership, that they may act on the task and that the thread's workspace is their company's). A thread
// that could not be remembered does not undo the start (the task runs; it just tells nothing in Slack), and is logged in fixed words.
//
// L4-U5c: ONE Slack thread, ONE task. The start's own transaction also writes the thread's guard row (`slackThreadGuardItem`: the same `SHARED_TASK` row the old start writes, with `workflowThread`), absent-only, so
// a second prefixed mention in the thread (or a second start racing the first) cannot commit a second task, and the ingress, which reads that row, takes a later mention in the thread as a reply to the task and not as a new
// start. The row names the company and the request that wrote it, so a Slack retry of the SAME event (same request id, same company) is told apart from a different request in a used thread: it reaches the core's own
// idempotency (`startIdempotencyKey`) and gets the first task back, never a second one and never a "this thread already has a task" notice for its own task.
import { SLACK_CHANNEL, SharedTaskRecordSchema, agentXError, sharedTaskKey, when, type SlackThread, type TransactItem } from "@agentx/contracts";
import type { StartExtrasInput } from "../core/task-flow/deps.js";
import { withStartFence } from "../core/task-flow/start-fence.js";
import { taskOwnerKey } from "../developer/task-records.js";
import { startOnCore, type CoreEntryCaller, type CoreTaskEntry } from "./engine-boundary.js";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface SlackCoreStartInput {
  caller: CoreEntryCaller;
  /** The company the thread's Slack workspace belongs to (the broker's own answer). The core's start must be for that company, or it commits nothing. */
  companyId: string;
  thread: SlackThread;
  /** The Slack member who asked (their Slack user id). */
  userId: string;
  requestId: string;
  project: string;
  instructions: string;
  workflowPath: "QUICK" | "FULL";
}

/**
 * The thread's guard row, for the core start's own transaction (`withStartFence`). It is the row the old start writes (`developer-tasks.ts`: `SHARED_TASK`, `workflowThread`), so the ingress, the stop and every reader of
 * that row treat a hosted thread as they treat any Slack-started task's thread, plus `companyId` and `startRequestId` (who wrote it). Written only when absent: a thread that already has a task makes this start commit
 * nothing. The company is the core start's own (the caller's live membership), and it must be the thread's workspace's: another company's start writes nothing and starts nothing. A row the readers could not read
 * (they fail closed on one) is never written: the start is refused in fixed words instead.
 */
export function slackThreadGuardItem(input: { thread: SlackThread; companyId: string; requestId: string }, extras: StartExtrasInput): TransactItem {
  if (extras.principal.companyId !== input.companyId) throw agentXError("FORBIDDEN", "this Slack workspace belongs to another company");
  const developerId = extras.principal.personId;
  const row = {
    ...sharedTaskKey(input.thread), entityType: "SHARED_TASK", taskId: extras.taskId, workspaceId: extras.workspaceId, ownerKey: taskOwnerKey(developerId, extras.taskId), developerId,
    developerName: extras.principal.displayName.trim().slice(0, 200) || "Rovara member", project: extras.project, mode: "continue", sharedAt: extras.receivedAt, workflowThread: true,
    companyId: input.companyId, startRequestId: input.requestId,
  };
  if (!SharedTaskRecordSchema.safeParse(row).success) throw agentXError("RUNTIME_UNAVAILABLE", "This Slack thread could not be recorded for the task.");
  return { kind: "put", item: row, condition: when.absent() };
}

/** Whether a thread's guard row is the one THIS start wrote: the same company and the same request id (Slack's retry of one event). Anything else, or no row, is not. */
export function isOwnSlackStart(row: Readonly<Record<string, unknown>> | undefined, input: { companyId: string | undefined; requestId: string }): boolean {
  return row !== undefined && input.companyId !== undefined && row["companyId"] === input.companyId && row["startRequestId"] === input.requestId && row["workflowThread"] === true;
}

export async function startSlackWorkflowOnCore(entry: CoreTaskEntry | undefined, input: SlackCoreStartInput, log: (entry: Record<string, unknown>) => void = () => undefined): Promise<{ taskId: string } | undefined> {
  const started = await withStartFence((extras) => [slackThreadGuardItem(input, extras)], () => startOnCore(entry, {
    method: "POST", path: "/v1/dev/tasks", headers: {}, requestId: input.requestId,
    body: JSON.stringify({ requestId: input.requestId, project: input.project, instructions: input.instructions, client: "slack", workflow: true, workflowPath: input.workflowPath }),
  }, input.caller));
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
