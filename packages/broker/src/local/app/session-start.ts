// Lane L9-wire: the task's session is created in the task's own start transaction (L6b's `createTaskSessionItems`), so the task and its session exist together or not at all.
import { ROVARA_CODE_AGENT_ID, type OrgId, type WorkOrigin } from "@agentx/contracts";
import { createTaskSessionItems, developerIdOf, taskSessionId } from "../../core/sessions/create.js";
import type { StartExtrasInput, StartExtras } from "../../core/task-flow/deps.js";

/** Where a task was started from, as a session names it. The client name is the surface's own; anything unknown is the app. */
function originOf(client: string): WorkOrigin {
  return client === "mcp" || client === "cli" ? client : "app";
}

export function createSessionStartExtras(companyId: OrgId): (input: StartExtrasInput) => StartExtras {
  return (input) => {
    const sessionId = taskSessionId(input.taskId);
    return {
      sessionId,
      items: createTaskSessionItems({
        orgId: companyId, sessionId, taskId: input.taskId, project: input.project,
        // Code has one built-in agent; the draft version is the current one on an install with no agent versions.
        agent: { agentId: ROVARA_CODE_AGENT_ID, name: "Rovara Code", version: "draft" },
        title: input.title, owner: input.principal, origin: originOf(input.client),
        payer: { kind: "member", developerId: developerIdOf(input.principal) }, now: input.receivedAt,
      }),
    };
  };
}
