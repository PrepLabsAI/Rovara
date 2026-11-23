// Existing retry HTTP path: access-paused delivery is resumed before the normal blocked-step retry, which would otherwise refuse this still-running workflow.
import { AgentXError, agentXError, type OrgId } from "@agentx/contracts";
import type { CoreTaskEntry, coreTaskEntryFrom } from "./engine-boundary.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { resumeAccessPausedDispatch } from "../core/task-flow/access-resume.js";

export function accessRetryRoute(entry: CoreTaskEntry, inputs: { caller: Parameters<typeof coreTaskEntryFrom>[1]; flowFor(companyId: OrgId): Promise<TaskFlowDeps> }): CoreTaskEntry["route"] {
  return async (request, caller) => {
    const match = request.method === "POST" ? /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/workflow\/retry$/u.exec(request.path.split("?")[0] ?? "") : null;
    if (match === null) return entry.route(request, caller);
    try {
      const deployed = await inputs.caller(caller);
      if (deployed === undefined) return entry.route(request, caller);
      if (deployed.scriptToken !== undefined) throw agentXError("TASK_NOT_FOUND", "no such task");
      const flow = await inputs.flowFor(deployed.principal.companyId);
      if (await resumeAccessPausedDispatch(flow, { principal: deployed.principal }, match[1]!, request.body ?? "{}")) {
        const read = { ...request, method: "GET", path: `/v1/dev/tasks/${match[1]!}` };
        delete read.body;
        return entry.route(read, caller);
      }
      return entry.route(request, caller);
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { statusCode: error.statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: error.code, message: error.message.slice(error.code.length + 2) } }) };
    }
  };
}
