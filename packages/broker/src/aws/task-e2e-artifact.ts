import { agentXError } from "@agentx/contracts";
import { can, resolveTaskAccess } from "../developer/task-access.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "./developer-tasks.js";

/**
 * M1.3 Task 3.7: the screenshot behind a row of a task's results, for someone who may read the task.
 *
 * The reader's right to the task is the page's own rule (`resolveTaskAccess`: the owner, a person the task was shared with, or a member of the Slack channel the task is in who
 * can use its project), checked on every call; it throws the page's not-found error for anyone else, before anything is looked up. Only then is the digest looked for in the
 * task's current display. Returns undefined for a digest the display does not name.
 */
export async function getTaskE2EArtifact(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, sha256: string):
  Promise<{ contentType: "image/jpeg"; bytes: Uint8Array } | undefined> {
  const { task, role } = await resolveTaskAccess(deps, caller, taskId);
  // Whoever may read the task page may read what it shows; a role that cannot read it is told the page's own not-found.
  if (!can(role, "read")) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  if (deps.workflowE2EArtifact === undefined) return undefined;
  return deps.workflowE2EArtifact({ task, sha256 });
}
