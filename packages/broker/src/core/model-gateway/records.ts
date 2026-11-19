import { locateWorkspace } from "../task-flow/workspace-location.js";
import { OperationStatusSchema, WorkspaceStatusSchema, WorkflowStageSchema, agentXError } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { taskKey } from "../task-flow/keys.js";
import { fromDocument, type OperationRecord, type WorkspaceRecord, type TaskRecord, type TaskPointerRecord } from "../task-flow/records.js";
import { isTerminalStatus } from "../task-flow/results.js";
import type { TaskTokenOperation } from "./token.js";
import type { TaskTokenDeadline } from "./deadline.js";

export interface TaskTokenRecords { operation: OperationRecord; workspace: WorkspaceRecord; task: TaskRecord }
const refused = () => agentXError("CALLBACK_FORBIDDEN", "this operation has no model access");
const NO_TASK = Symbol("task-token-no-task");
/** True only for the refusal of an operation whose workspace has no task pointer at all (L4-EVH: the one case where the route may try an eval health run's own description). Same error, same message, as before. */
export const hasNoTask = (error: unknown): boolean => typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[NO_TASK] === true;
/** Four point reads for a new workspace (five for legacy); no task/operation enumeration, and every record belongs to the same company and workspace. */
export async function readTaskTokenRecords(deps: Pick<TaskFlowDeps, "store" | "companyId">, scope: TaskTokenOperation, deadline?: TaskTokenDeadline): Promise<TaskTokenRecords> {
  deadline?.check();
  const location = await locateWorkspace({ companyId: deps.companyId, store: { get: async (key) => { deadline?.check(); return deps.store.get(key); } } }, scope.workspaceId);
  deadline?.check();
  if (location === undefined) throw refused();
  const operation = fromDocument<OperationRecord>(await deps.store.get(location.operationKey(scope.operationId)));
  if (operation === undefined || operation.companyId !== deps.companyId || operation.id !== scope.operationId || operation.workspaceId !== scope.workspaceId) throw refused();
  deadline?.check();
  const workspace = fromDocument<WorkspaceRecord>(location.workspace);
  if (workspace === undefined || workspace.companyId !== deps.companyId || workspace.id !== scope.workspaceId) throw refused();
  if (operation.fence !== scope.fence || workspace.fence !== scope.fence || workspace.activeOperationId !== scope.operationId) throw agentXError("STALE_FENCE", "callback no longer owns the workspace");
  if (!OperationStatusSchema.safeParse(operation.status).success || isTerminalStatus(operation.status) || operation.status === "CANCEL_REQUESTED") throw refused();
  if (!WorkspaceStatusSchema.safeParse(workspace.status).success || workspace.closedAt !== undefined || ["CLOSING", "CLOSED", "STOPPED"].includes(workspace.status)) throw refused();
  deadline?.check();
  const pointer = fromDocument<TaskPointerRecord>(await deps.store.get(location.taskPointerKey()));
  if (pointer === undefined) throw Object.assign(refused(), { [NO_TASK]: true });
  if (typeof pointer?.taskId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(pointer.taskId)) throw refused();
  deadline?.check();
  const task = fromDocument<TaskRecord>(await deps.store.get(taskKey(pointer.taskId)));
  if (task === undefined || task.companyId !== deps.companyId || task.taskId !== pointer.taskId || task.workspaceId !== scope.workspaceId || task.project !== workspace.projectName) throw refused();
  if (task.workflow !== undefined && !WorkflowStageSchema.safeParse(task.workflow?.stage).success) throw refused();
  if (task.stopRequest !== undefined || task.releasedAt !== undefined || task.closedAt !== undefined || task.workflow?.stage === "CLOSED" || task.workflow?.stage === "MERGED") throw refused();
  return { operation, workspace, task };
}
