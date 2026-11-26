// S2 (core switch-on gate): Slack's thread stop and the Slack Stop button for a task the core owns (see core-stop-entry.ts for the whole picture). Each reaches the core's authorized stop
// (`POST /v1/dev/tasks/{id}/cancel`, S1) as the Slack person's linked Rovara person, so the rule is the core's (the task's owner, or a live owner/admin of the task's company), never
// weaker; a refusal reads as the workflow's own "not the owner" answer. On purpose, the workflow's thread checks (this task's own thread, a view-only share) are not added: the core's rule
// alone decides, and a refusal never says which check failed. `undefined`: not the core's, and the broker runs exactly what it ran before.
import { agentXError, type SharedTaskRecord, type SlackChannelBinding } from "@agentx/contracts";
import { isCoreTask, stopCoreTaskAs, type CoreEntryCaller, type CoreTaskEntry, type EngineStateTable } from "./engine-boundary.js";
import type { CoreStopOutcome } from "./core-stop-entry.js";

export interface SlackCallerLike { developerId: string; sessionId: string; name: string }
const entryCallerOf = (caller: SlackCallerLike): CoreEntryCaller => ({ developerId: caller.developerId, sessionId: caller.sessionId, name: caller.name });

/** Slack's thread stop, for a thread whose shared task the core owns. A closed share, or a channel now bound to another project, stops nothing (as the workflow's thread stop). */
export async function coreThreadStop(table: EngineStateTable, entry: CoreTaskEntry | undefined, shared: SharedTaskRecord | undefined, binding: Pick<SlackChannelBinding, "projectName">,
  caller: () => Promise<SlackCallerLike>): Promise<CoreStopOutcome | { outcome: "NOTHING_RUNNING" } | { outcome: "NOT_OWNER" } | undefined> {
  if (shared === undefined || !await isCoreTask(table, shared.taskId)) return undefined;
  if (shared.closedAt !== undefined || binding.projectName !== shared.project) return { outcome: "NOTHING_RUNNING" };
  return await stopCoreTaskAs(entry, entryCallerOf(await caller()), shared.taskId) === "stopped" ? { outcome: "CANCEL_REQUESTED", taskId: shared.taskId } : { outcome: "NOT_OWNER" };
}



/** The Stop button's refusal for a person who may not stop the task (the words the old Slack workflow gave, kept). */
export const CORE_STOP_BUTTON_REFUSAL = "only a current task owner can close this task";

/**
 * The Slack Stop button (`workflow-close` with `stop`) on a task the core owns: its running step is stopped; the core closes nothing here yet. `checks` is the press's own Slack checks
 * (the Slack workspace is enabled, and the person is a linked person of its company), run before the stop. A refusal is the owner-only refusal. `undefined`: not a Stop of a core task.
 */
export async function coreStopButton(table: EngineStateTable, entry: CoreTaskEntry | undefined, event: { taskId: string; stop?: true }, caller: () => Promise<SlackCallerLike>): Promise<{ stopped: "cancelling" } | undefined> {
  if (event.stop !== true || !await isCoreTask(table, event.taskId)) return undefined;
  if (await stopCoreTaskAs(entry, entryCallerOf(await caller()), event.taskId) !== "stopped") throw agentXError("FORBIDDEN", CORE_STOP_BUTTON_REFUSAL);
  return { stopped: "cancelling" };
}
