// Lane L6a, task flow core: reading a task. A task of someone else reads as "not found" (no leak).
import { queryAll, type DeveloperTaskFailure, type DeveloperTaskStatus, type StoredDocument, type WorkflowSnapshot } from "@agentx/contracts";
import { deriveTaskStatus, taskIndexKey, type DeveloperTaskIndexRecord } from "../../developer/task-records.js";
import { taskNotFound } from "./access.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { OPERATION_SK_PREFIX, taskKey, taskPointerKey, workspaceKey } from "./keys.js";
import { fromDocument, type OperationRecord, type TaskPointerRecord, type TaskRecord, type WorkspaceRecord } from "./records.js";

export interface TaskView {
  taskId: string;
  project: string;
  title: string;
  status: DeveloperTaskStatus;
  closing: boolean;
  workspaceId: string;
  startingRevision: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  workflow?: { definitionVersion: string; path: string; stage: string; state: string; revision: number; blockReason?: string };
  failure?: DeveloperTaskFailure;
  operations: Array<{ id: string; kind: string; status: string; workflowMode?: string }>;
}

export async function readTask(deps: Pick<TaskFlowDeps, "store">, taskId: string): Promise<TaskRecord | undefined> {
  return fromDocument<TaskRecord>(await deps.store.get(taskKey(taskId)));
}

/** The task, if the caller may act on it; otherwise TASK_NOT_FOUND, the same as for a task that does not exist. */
export async function loadOwnedTask(deps: TaskFlowDeps, caller: TaskCaller, taskId: string): Promise<TaskRecord> {
  const task = await readTask(deps, taskId);
  if (caller.principal.companyId !== deps.companyId || task === undefined || task.companyId !== deps.companyId || !(await deps.access.canAct(caller.principal, task))) throw taskNotFound();
  return task;
}

export async function workspaceOperations(deps: Pick<TaskFlowDeps, "store">, workspaceId: string): Promise<OperationRecord[]> {
  const items = await queryAll(deps.store, { pk: workspaceKey(workspaceId).pk, sk: { op: "beginsWith", prefix: OPERATION_SK_PREFIX } });
  // Oldest first; a hold of the workspace takes the next fence, so the fence orders operations made in one instant.
  return items.map((item: StoredDocument) => item as unknown as OperationRecord).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.fence - right.fence);
}

export async function taskViewOf(deps: TaskFlowDeps, task: TaskRecord): Promise<TaskView> {
  const [workspace, pointer, operations] = await Promise.all([
    deps.store.get(workspaceKey(task.workspaceId)).then((item) => fromDocument<WorkspaceRecord>(item)),
    deps.store.get(taskPointerKey(task.workspaceId)).then((item) => fromDocument<TaskPointerRecord>(item)),
    workspaceOperations(deps, task.workspaceId),
  ]);
  const derived = deriveTaskStatus({
    ...(task.closedAt === undefined ? {} : { closedAt: task.closedAt }),
    workspaceStatus: workspace?.status ?? "PREPARING",
    pointer,
    operations,
  });
  const workflow: WorkflowSnapshot | undefined = task.workflow;
  return {
    taskId: task.taskId,
    project: task.project,
    title: task.title,
    status: derived.status,
    closing: derived.closing,
    workspaceId: task.workspaceId,
    startingRevision: task.startingRevision,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.closedAt === undefined ? {} : { closedAt: task.closedAt }),
    ...(workflow === undefined ? {} : { workflow: {
      definitionVersion: workflow.definitionVersion, path: workflow.path, stage: workflow.stage, state: workflow.state, revision: workflow.revision,
      ...(workflow.blockReason === undefined ? {} : { blockReason: workflow.blockReason }),
    } }),
    ...(derived.failure === undefined ? {} : { failure: derived.failure }),
    operations: operations.map((operation) => ({ id: operation.id, kind: operation.kind, status: operation.status, ...(operation.workflowMode === undefined ? {} : { workflowMode: operation.workflowMode }) })),
  };
}

export async function getTask(deps: TaskFlowDeps, caller: TaskCaller, taskId: string): Promise<TaskView> {
  return taskViewOf(deps, await loadOwnedTask(deps, caller, taskId));
}

/** The caller's own tasks, newest first (the index of `DEVELOPER#<person>`). */
export async function listTasks(deps: TaskFlowDeps, caller: TaskCaller, options: { limit?: number; cursor?: string } = {}): Promise<{ tasks: DeveloperTaskIndexRecord[]; cursor?: string }> {
  if (caller.principal.companyId !== deps.companyId) return { tasks: [] };
  const page = await deps.store.query({
    pk: taskIndexKey(caller.principal.personId, "", "").pk,
    sk: { op: "beginsWith", prefix: "TASK#" },
    descending: true,
    limit: Math.min(options.limit ?? 50, 200),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
  return { tasks: page.items.map((item) => item as unknown as DeveloperTaskIndexRecord), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
}
