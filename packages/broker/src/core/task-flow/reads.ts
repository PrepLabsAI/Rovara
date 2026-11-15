// Lane L6a, task flow core: reading a task. A task of someone else reads as "not found" (no leak).
import { IMPLICIT_COMPANY_ID, OrgIdSchema, agentXError, type DeveloperTaskFailure, type DeveloperTaskStatus, type StoredDocument, type WorkflowSnapshot } from "@agentx/contracts";
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

export async function workspaceOperations(deps: Pick<TaskFlowDeps, "store"> & Partial<Pick<TaskFlowDeps, "companyId">>, workspaceId: string): Promise<OperationRecord[]> {
  if (!OrgIdSchema.safeParse(deps.companyId).success) throw agentXError("CONFIG_INVALID", "workspace company is invalid");
  const items: StoredDocument[] = [];
  let cursor: string | undefined;
  // Ten 200-row reads plus one 1-row probe: exactly 2,000 rows can still complete.
  for (let reads = 0; reads <= 10; reads++) {
    const page = await deps.store.query({ pk: workspaceKey(workspaceId).pk, sk: { op: "beginsWith", prefix: OPERATION_SK_PREFIX }, limit: reads === 10 ? 1 : 200,
      ...(cursor === undefined ? {} : { cursor }) });
    if (reads === 10) {
      if (page.items.length > 0 || page.cursor !== undefined) throw agentXError("CONFIG_INVALID", "workspace operation limit exceeded");
      break;
    }
    items.push(...page.items.filter((item) => (item["companyId"] === undefined ? IMPLICIT_COMPANY_ID : item["companyId"]) === deps.companyId));
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
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
  if (!OrgIdSchema.safeParse(deps.companyId).success || caller.principal.companyId !== deps.companyId) return { tasks: [] };
  const requested = options.limit ?? 50;
  if (!Number.isSafeInteger(requested) || requested < 1) throw agentXError("CONFIG_INVALID", "list limit is invalid");
  const limit = Math.min(requested, 200);
  const tasks: DeveloperTaskIndexRecord[] = [];
  let cursor = options.cursor;
  // At most ten page reads and 2,000 index rows per call. A bounded partial page always
  // carries the store's continuation when more rows may exist; no accepted row is skipped.
  for (let reads = 0; reads < 10; reads++) {
    const page = await deps.store.query({
      pk: taskIndexKey(caller.principal.personId, "", "").pk,
      sk: { op: "beginsWith", prefix: "TASK#" },
      descending: true,
      limit: limit - tasks.length,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const item of page.items) {
      const company = item["orgId"] === undefined ? IMPLICIT_COMPANY_ID : item["orgId"];
      if (company === deps.companyId) tasks.push(item as unknown as DeveloperTaskIndexRecord);
    }
    cursor = page.cursor;
    if (tasks.length === limit || cursor === undefined) break;
  }
  return { tasks, ...(cursor === undefined ? {} : { cursor }) };
}
