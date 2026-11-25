// S2 (core switch-on gate): the broker's other ways to stop a task, for a task the core owns. Each reaches the core's own stop and never the workflow's cancel:
//   - Slack's thread stop and the Slack Stop button: the core's authorized stop (`POST /v1/dev/tasks/{id}/cancel`, S1) as the Slack person's linked Rovara person, so the rule is the
//     core's (the task's owner, or a live owner/admin of the task's company), never weaker. A refusal reads as the workflow's own "not the owner" answer, whatever the reason;
//   - the administrator's workspace cancel: the route's own checks (the administrator claim here, an administrator grant on the task's project in the core's call), in the runtime of
//     the workspace's own company, then the core's `cancelTask`.
// On purpose, the Slack paths do not add the workflow's thread checks (this task's own thread, a view-only share): who may stop a core task is the core's rule alone, which is never weaker
// than those checks, and a refusal never says which check failed.
// Every function answers `undefined` for anything that is not the core's (an unstamped task or workspace, or an install without the core's entry): the broker then runs exactly what it ran
// before. Kept out of broker.ts so its call sites there stay one line each. The Slack paths live in slack-core-stop.ts (the Slack boundary keeps Slack names in Slack modules).
import { AgentXError, agentXError } from "@agentx/contracts";
import { isCoreWorkspace, isSetupCheckWorkspace, type CoreTaskEntry, type EngineStateTable } from "./engine-boundary.js";

/** A Stop the core ran for a core task: the core's cancel names no workflow operation. */
/** A setup check's stop names no task (`taskId` absent). */
export type CoreStopOutcome = { outcome: "CANCEL_REQUESTED"; workspaceId?: string; taskId?: string };

/**
 * The administrator's workspace cancel on a core task's workspace. The claim is checked here; `requireAdministrator(project)` is the route's own project check, which the core asks with the
 * task's project. An install without the core's administrator stop answers as before (undefined: the route's own `requireWorkspace` reads a core workspace as a missing one).
 */
export async function coreAdminStop(table: EngineStateTable, entry: CoreTaskEntry | undefined, identity: { isAdministrator: boolean; ownerKey: string }, workspaceId: string,
  requireAdministrator: (project: string) => Promise<void>): Promise<CoreStopOutcome | { outcome: "NOTHING_RUNNING"; workspaceId: string } | undefined> {
  if (entry?.stopWorkspaceForAdmin === undefined || !await isCoreOrSetupCheckWorkspace(table, workspaceId)) return undefined;
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const stopped = await entry.stopWorkspaceForAdmin(workspaceId, { id: identity.ownerKey }, requireAdministrator);
  return stopped.nothingRunning ? { outcome: "NOTHING_RUNNING", workspaceId } : { outcome: "CANCEL_REQUESTED", workspaceId, ...(stopped.taskId === undefined ? {} : { taskId: stopped.taskId }) };
}

/** A core task's workspace, or a setup check's (a workspace with no task, whose own record names this company: the core's too, so its stop is the core's). */
async function isCoreOrSetupCheckWorkspace(table: EngineStateTable, workspaceId: string): Promise<boolean> {
  try {
    return await isCoreWorkspace(table, workspaceId);
  } catch (error) {
    if (error instanceof AgentXError && error.code === "NOT_FOUND" && await isSetupCheckWorkspace(table, workspaceId)) return true;
    throw error;
  }
}
