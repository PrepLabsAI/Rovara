import { locateWorkspace, type WorkspaceLocation } from "./workspace-location.js";
// Lane L6a, task flow core: reading a task. A task of someone else reads as "not found" (no leak).
import { PullRequestSummarySchema, AgentXError, IMPLICIT_COMPANY_ID, OrgIdSchema, agentXError, type DeveloperTaskFailure, type DeveloperTaskView, type DeveloperTaskStatus, type StoredDocument, type WorkflowSnapshot } from "@agentx/contracts";
import { taskStartupView, deriveTaskStatus, taskIndexKey, type DeveloperTaskIndexRecord } from "../../developer/task-records.js";
import { taskOwnerView, type TaskOwnerView } from "../../developer/task-owner-view.js";
import { taskNotFound } from "./access.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { OPERATION_SK_PREFIX, taskKey } from "./keys.js";
import { setupRecheckLineOf } from "../setup-agent/recheck-rows.js";
import { reportFeatureKey, reportTaskFeatureKey } from "@agentx/contracts";
import { featureOf, resolveFeature, taskFeatureOf } from "../report/feature-store.js";
import { fromDocument, type OperationRecord, type TaskPointerRecord, type TaskRecord, type WorkspaceRecord } from "./records.js";

export interface TaskView {
  taskId: string;
  /** The task's own person (Q7). Absent for a record with no sign-in owner. */
  owner?: TaskOwnerView;
  project: string;
  title: string;
  status: DeveloperTaskStatus;
  startupReason?: DeveloperTaskView["startupReason"];
  closing: boolean;
  workspaceId: string;
  startingRevision: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  workflow?: { definitionVersion: string; path: string; stage: string; state: string; revision: number; blockReason?: string };
  failure?: DeveloperTaskFailure;
  pullRequests?: Array<{ repository: string; number: number; url: string; state: "open" | "closed" | "merged" }>;
  operations: Array<{ id: string; kind: string; status: string; workflowMode?: string }>;
  /** L4-DR (DEC 254z c): the one quiet line when Rovara re-checked the project's setup for this task ("Setup re-checked after dependency files changed: still works."). Absent when there was no drift. */
  setupRecheck?: string;
  feature?: { id: string; name: string; source: string } | null;
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

/**
 * The task, if the caller may READ it: whoever may act on it, and (on a host that says so, `TaskAccess.canRead`) the commenters and viewers of its People list. Otherwise TASK_NOT_FOUND, the same as
 * for a task that does not exist. For reads only: nothing that changes a task goes through here.
 */
export async function loadReadableTask(deps: TaskFlowDeps, caller: TaskCaller, taskId: string): Promise<TaskRecord> {
  const task = await readTask(deps, taskId);
  if (caller.principal.companyId !== deps.companyId || task === undefined || task.companyId !== deps.companyId) throw taskNotFound();
  let allowed: boolean;
  try {
    allowed = deps.access.canRead === undefined ? await deps.access.canAct(caller.principal, task) : await deps.access.canRead(caller.principal, task);
  } catch (error) {
    // A person the task's People list refuses reads exactly as for a task that does not exist (the People proof's own denial says the task has a list). Any other failure stays a failure.
    if (error instanceof AgentXError && error.code === "TASK_ACCESS_DENIED") throw taskNotFound();
    throw error;
  }
  if (!allowed) throw taskNotFound();
  return task;
}

export async function workspaceOperations(deps: Pick<TaskFlowDeps, "store" | "companyId">, workspaceId: string): Promise<OperationRecord[]> {
  if (!OrgIdSchema.safeParse(deps.companyId).success) throw agentXError("CONFIG_INVALID", "workspace company is invalid");
  const location = await locateWorkspace(deps, workspaceId);
  return location === undefined ? [] : operationsAt(deps, location);
}

async function operationsAt(deps: Pick<TaskFlowDeps, "store" | "companyId">, location: WorkspaceLocation): Promise<OperationRecord[]> {
  const items: StoredDocument[] = [];
  let cursor: string | undefined;
  // Ten reads of at most 200 rows and DynamoDB's 1 MB page each, plus a 1-row completion probe.
  // Large rows can exhaust the read bound before 2,000 rows; never return partial operations.
  for (let reads = 0; reads <= 10; reads++) {
    const page = await deps.store.query({ pk: location.workspaceKey.pk, sk: { op: "beginsWith", prefix: OPERATION_SK_PREFIX }, limit: reads === 10 ? 1 : 200,
      ...(cursor === undefined ? {} : { cursor }) });
    if (reads === 10) {
      if (page.items.length > 0 || page.cursor !== undefined) throw agentXError("CONFIG_INVALID", "workspace operation read limit exceeded (10 reads, each up to 1 MB, plus a completion probe)");
      break;
    }
    items.push(...page.items.filter((item) => item["entityType"] !== "WORKSPACE_COMPANY_POINTER" && (item["companyId"] === undefined ? IMPLICIT_COMPANY_ID : item["companyId"]) === deps.companyId));
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  // Oldest first; a hold of the workspace takes the next fence, so the fence orders operations made in one instant.
  return items.map((item: StoredDocument) => item as unknown as OperationRecord).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.fence - right.fence);
}

export async function taskViewOf(deps: TaskFlowDeps, task: TaskRecord): Promise<TaskView> {
  const location = await locateWorkspace(deps, task.workspaceId);
  const workspace = fromDocument<WorkspaceRecord>(location?.workspace);
  const [pointer, operations] = location === undefined ? [undefined, []] : await Promise.all([
    deps.store.get(location.taskPointerKey()).then((item) => fromDocument<TaskPointerRecord>(item)),
    operationsAt(deps, location),
  ]);
  const pullRequests = await publicationSummaries(deps, location);
  const storedAssignment = taskFeatureOf(await deps.store.get(reportTaskFeatureKey(deps.companyId, task.taskId)), deps.companyId);
  const assignment = storedAssignment?.project === task.project ? storedAssignment : undefined;
  const resolved = new Map<string, NonNullable<ReturnType<typeof featureOf>>>();
  let featureId = assignment?.featureId;
  for (let hop = 0; featureId != null && hop <= 8; hop += 1) {
    const record = featureOf(await deps.store.get(reportFeatureKey(deps.companyId, featureId)), deps.companyId);
    if (record === undefined || resolved.has(featureId)) break;
    resolved.set(featureId, record);
    if (record.state !== "merged") break;
    featureId = record.mergedInto;
  }
  const featureRecord = assignment?.featureId == null ? undefined : resolveFeature(resolved, assignment.featureId);
  const derived = deriveTaskStatus({
    ...(task.closedAt === undefined ? {} : { closedAt: task.closedAt }),
    workspaceStatus: workspace?.status ?? "PREPARING",
    pointer,
    operations,
  });
  const workflow: WorkflowSnapshot | undefined = task.workflow;
  const owner = taskOwnerView(task);
  const setupRecheck = await setupRecheckLineOf(deps, task.project, task.taskId);
  return {
    taskId: task.taskId,
    ...pullRequests,
    ...(owner === undefined ? {} : { owner }),
    project: task.project,
    title: task.title,
    status: derived.status,
    ...taskStartupView(derived, workspace, operations),
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
    ...(setupRecheck === undefined ? {} : { setupRecheck }),
    ...(assignment === undefined ? {} : { feature: assignment.featureId === null || featureRecord === undefined ? null : { id: featureRecord.id, name: featureRecord.name, source: assignment.source } }),
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
      if (item["entityType"] !== "WORKSPACE_COMPANY_POINTER" && company === deps.companyId) tasks.push(item as unknown as DeveloperTaskIndexRecord);
    }
    cursor = page.cursor;
    if (tasks.length === limit || cursor === undefined) break;
  }
  return { tasks, ...(cursor === undefined ? {} : { cursor }) };
}

async function publicationSummaries(deps: TaskFlowDeps, location: WorkspaceLocation | undefined): Promise<Pick<TaskView, "pullRequests">> {
  if (location === undefined) return {};
  const page = await deps.store.query({ pk: location.workspaceKey.pk, sk: { op: "beginsWith", prefix: "PULL_REQUEST#" }, limit: 32 });
  const rows = page.items.map(row => ({ repository: row["repository"], number: row["number"], url: row["url"], state: row["state"] }));
  const parsed = PullRequestSummarySchema.array().max(32).safeParse(rows);
  return parsed.success && parsed.data !== undefined && parsed.data.length > 0 ? { pullRequests: parsed.data } : {};
}
