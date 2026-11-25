// Who the task's CURRENT step is charged to, as far as a press names it: the requester of the operation now running on the task's workspace (the person its press started it for), else the person on the task's due dispatch
// row (`by`). Undefined: nothing is running or due that anybody pressed, and the host's fixed choice names the payer. Read-only; a surface asks `checkStep(task, thisPerson)` to learn whether that person still stands.
import { dispatchRowKey } from "./keys.js";
import type { TaskFlowDeps } from "./deps.js";
import { readWorkspace } from "./stage-machine.js";
import type { TaskRecord } from "./records.js";
import { workspaceKeys } from "./workspace-location.js";

export async function currentPress(deps: Pick<TaskFlowDeps, "store" | "companyId">, task: Pick<TaskRecord, "taskId" | "workspaceId" | "workflow">): Promise<string | undefined> {
  const workspace = await readWorkspace(deps, task.workspaceId);
  const operationId = workspace?.activeOperationId;
  if (typeof operationId === "string") {
    const requester = (await deps.store.get((await workspaceKeys(deps, task.workspaceId)).operationKey(operationId)))?.["requester"] as { personId?: unknown } | undefined;
    if (typeof requester?.personId === "string") return requester.personId;
  }
  const row = task.workflow === undefined ? undefined : await deps.store.get(dispatchRowKey(deps.companyId, task.taskId, task.workflow.revision));
  return typeof row?.["by"] === "string" ? row["by"] : undefined;
}
