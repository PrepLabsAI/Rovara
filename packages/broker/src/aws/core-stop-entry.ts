// S2 (core switch-on gate): the broker's other ways to stop a task, for a task the core owns. Each reaches the core's own stop and never the workflow's cancel:
//   - Slack's thread stop and the Slack Stop button: the core's authorized stop (`POST /v1/dev/tasks/{id}/cancel`, S1) as the Slack person's linked Rovara person, so the rule is the
//     core's (the task's owner, or a live owner/admin of the task's company), never weaker. A refusal reads as the workflow's own "not the owner" answer, whatever the reason;
//   - the administrator's workspace cancel: the route's own checks (the administrator claim here, an administrator grant on the task's project in the core's call), in the runtime of
//     the workspace's own company, then the core's `cancelTask`.
// On purpose, the Slack paths do not add the workflow's thread checks (this task's own thread, a view-only share): who may stop a core task is the core's rule alone, which is never weaker
// than those checks, and a refusal never says which check failed.
// Every function answers `undefined` for anything that is not the core's (an unstamped task or workspace, or an install without the core's entry): the broker then runs exactly what it ran
// before. Kept out of broker.ts so its call sites there stay one line each.
import { agentXError, type SharedTaskRecord, type SlackChannelBinding } from "@agentx/contracts";
import { ownerOfTaskId, ownerOfWorkspace, stopCoreTaskAs, type CoreEntryCaller, type CoreTaskEntry, type EngineStateTable } from "./engine-boundary.js";

/** A Stop the core ran for a core task: the core's cancel names no workflow operation. */
export type CoreStopOutcome = { outcome: "CANCEL_REQUESTED"; workspaceId?: string; taskId: string };

interface SlackCallerLike { developerId: string; sessionId: string; name: string }
const entryCallerOf = (caller: SlackCallerLike): CoreEntryCaller => ({ developerId: caller.developerId, sessionId: caller.sessionId, name: caller.name });

/** Slack's thread stop, for a thread whose shared task the core owns. A closed share, or a channel now bound to another project, stops nothing (as the workflow's thread stop). */
export async function coreThreadStop(table: EngineStateTable, entry: CoreTaskEntry | undefined, shared: SharedTaskRecord | undefined, binding: Pick<SlackChannelBinding, "projectName">,
  caller: () => Promise<SlackCallerLike>): Promise<CoreStopOutcome | { outcome: "NOTHING_RUNNING" } | { outcome: "NOT_OWNER" } | undefined> {
  if (shared === undefined || await ownerOfTaskId(table, shared.taskId) !== "core") return undefined;
  if (shared.closedAt !== undefined || binding.projectName !== shared.project) return { outcome: "NOTHING_RUNNING" };
  return await stopCoreTaskAs(entry, entryCallerOf(await caller()), shared.taskId) === "stopped" ? { outcome: "CANCEL_REQUESTED", taskId: shared.taskId } : { outcome: "NOT_OWNER" };
}

export const CORE_STOP_BUTTON_REFUSAL = "only a current task owner can close this task";

/**
 * The Slack Stop button (`workflow-close` with `stop`) on a task the core owns: its running step is stopped; the core closes nothing here yet. `checks` is the press's own Slack checks
 * (the Slack workspace is enabled, and the person is a linked person of its company), run before the stop. A refusal is the workflow's owner-only refusal.
 */
export async function coreStopButton(table: EngineStateTable, entry: CoreTaskEntry | undefined, event: { taskId: string; stop?: true }, caller: () => Promise<SlackCallerLike>): Promise<{ stopped: "cancelling" } | undefined> {
  if (event.stop !== true || await ownerOfTaskId(table, event.taskId) !== "core") return undefined;
  if (await stopCoreTaskAs(entry, entryCallerOf(await caller()), event.taskId) !== "stopped") throw agentXError("FORBIDDEN", CORE_STOP_BUTTON_REFUSAL);
  return { stopped: "cancelling" };
}

/**
 * The administrator's workspace cancel on a core task's workspace. The claim is checked here; `requireAdministrator(project)` is the route's own project check, which the core asks with the
 * task's project. An install without the core's administrator stop answers as before (undefined: the route's own `requireWorkspace` reads a core workspace as a missing one).
 */
export async function coreAdminStop(table: EngineStateTable, entry: CoreTaskEntry | undefined, identity: { isAdministrator: boolean; ownerKey: string }, workspaceId: string,
  requireAdministrator: (project: string) => Promise<void>): Promise<CoreStopOutcome | { outcome: "NOTHING_RUNNING"; workspaceId: string } | undefined> {
  if (entry?.stopWorkspaceForAdmin === undefined || await ownerOfWorkspace(table, workspaceId) !== "core") return undefined;
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const stopped = await entry.stopWorkspaceForAdmin(workspaceId, { id: identity.ownerKey }, requireAdministrator);
  return stopped.nothingRunning ? { outcome: "NOTHING_RUNNING", workspaceId } : { outcome: "CANCEL_REQUESTED", workspaceId, taskId: stopped.taskId };
}
