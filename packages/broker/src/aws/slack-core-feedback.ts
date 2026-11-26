// Core Keep uses the same served route and live caller authority as HTTP. An
// unserved action is answered by the engine boundary, never the old workflow.
import { agentXError } from "@agentx/contracts";
import { isCoreTask, serveCoreTaskRoute, type CoreEntryCaller, type CoreTaskEntry, type EngineStateTable } from "./engine-boundary.js";

export async function coreKeepPullRequests(table: EngineStateTable, entry: CoreTaskEntry | undefined,
  event: { taskId: string; requestId: string; expectedRevision: number }, caller: () => Promise<CoreEntryCaller>): Promise<unknown> {
  if (!await isCoreTask(table, event.taskId)) return undefined;
  return await serveCoreTaskRoute(entry, { method: "POST", path: `/v1/dev/tasks/${event.taskId}/workflow/keep-pull-requests`, headers: {},
    requestId: event.requestId, body: JSON.stringify({ requestId: event.requestId, expectedRevision: event.expectedRevision }) }, await caller(), event.taskId,
  async () => { throw agentXError("TASK_NOT_FOUND", "this task cannot be changed from Slack"); });
}
