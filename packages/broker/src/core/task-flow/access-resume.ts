// Internal hook for the existing owner retry route, before ordinary blocked-step retry. Same pause/retry records; no fresh operation or charge.
import { ContinueDeveloperTaskRequestSchema, OUTBOX_PENDING_INDEX, agentXError, change, companyScoped, when, type StoredDocument, type TransactItem } from "@agentx/contracts";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { CLOSED_TASK, loadTaskAsOwner, parseBody, type OwnerActing } from "./owner-round.js";
import { taskKey } from "./keys.js";
import { readWorkspace } from "./stage-machine.js";
import { readOperation } from "./results.js";
import { iso, hashJson } from "./support.js";
import { workspaceKeys } from "./workspace-location.js";
import type { TaskRecord } from "./records.js";

const conflict = (): never => { throw agentXError("IDEMPOTENCY_CONFLICT", "this access retry is out of date; refresh the task and try again"); };

export async function resumeAccessPausedDispatch(deps: TaskFlowDeps, caller: TaskCaller, taskId: string, value: unknown): Promise<boolean> {
  const { task, acting } = await loadTaskAsOwner(deps, caller, taskId);
  if (caller.principal.companyId !== deps.companyId || task.companyId !== deps.companyId) throw agentXError("TASK_NOT_FOUND", "no such task");
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  const request = parseBody(ContinueDeveloperTaskRequestSchema, retryValue(value));
  const auditKey = { pk: taskKey(taskId).pk, sk: `TASK_ACCESS_RETRY#${request.requestId}` };
  const payloadHash = hashJson(request);
  const prior = await deps.store.get(auditKey);
  if (prior !== undefined) {
    if (prior["actorId"] !== acting.actorId || prior["payloadHash"] !== payloadHash) return conflict();
    return true;
  }
  const page = await deps.store.query({ pk: taskKey(taskId).pk, sk: { op: "beginsWith", prefix: "TASK_ACCESS_PAUSE#" }, limit: 100 });
  const workspace = await readWorkspace(deps, task.workspaceId);
  const pauses = page.items.filter((row) => row["taskId"] === taskId && row["workspaceId"] === task.workspaceId && row["operationId"] === workspace?.activeOperationId);
  if (pauses.length === 0) return false;
  const pause = pauses.length === 1 ? pauses[0]! : undefined;
  if (pause === undefined || page.cursor !== undefined) return conflict();
  assertPauseMatches(pause, task, request);
  return resumeOne(deps, task, acting, pause, { auditKey, requestId: request.requestId, payloadHash });
}

async function resumeOne(deps: TaskFlowDeps, task: TaskRecord, acting: OwnerActing, pause: StoredDocument, retry: { auditKey: { pk: string; sk: string }; requestId: string; payloadHash: string }): Promise<boolean> {
  const outboxId = pause["outboxId"];
  const operationId = pause["operationId"];
  if (typeof outboxId !== "string" || typeof operationId !== "string") return conflict();
  const outboxKey = { pk: companyScoped(deps.companyId, `OUTBOX#${outboxId}`), sk: "OUTBOX" };
  const peopleKey = { pk: task.pk, sk: "PEOPLE" };
  const people = await deps.store.get(peopleKey);
  const revision = people?.["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || typeof pause["peopleRevision"] !== "number" || pause["peopleRevision"] > revision) return conflict();
  const operation = await readOperation(deps, task.workspaceId, operationId);
  if (operation === undefined || !["ACCEPTED", "DISPATCHING"].includes(operation.status)) return conflict();
  const location = await workspaceKeys(deps, task.workspaceId);
  const at = iso(deps);
  const workflow = task.workflow!;
  const items: TransactItem[] = [
    { kind: "update", key: outboxKey, ops: [change.set("status", "PENDING"), change.set("attempts", 0), change.set(OUTBOX_PENDING_INDEX.partitionAttribute, `PENDING#${deps.companyId}`), change.set(OUTBOX_PENDING_INDEX.sortAttribute!, at), change.remove("taskAccessPausedAt"), change.remove(deps.store.ttlAttribute ?? "expiresAt")], condition: when.and(when.eq("status", "WAITING_FOR_TASK_ACCESS"), when.eq("companyId", deps.companyId), when.eq(["body", "operationId"], operationId), when.eq(["body", "workspaceId"], task.workspaceId), when.eq(["body", "companyId"], deps.companyId)) },
    { kind: "check", key: taskKey(task.taskId), condition: when.and(when.eq("companyId", deps.companyId), when.eq("workspaceId", task.workspaceId), when.notExists("closedAt"), when.eq(["workflow", "revision"], workflow.revision), when.eq(["workflow", "stage"], workflow.stage), when.eq(["workflow", "state"], workflow.state)) },
    { kind: "check", key: peopleKey, condition: when.eq("revision", revision) },
    { kind: "check", key: location.operationKey(operationId), condition: when.and(when.eq("fence", operation.fence), when.or(when.eq("status", "ACCEPTED"), when.eq("status", "DISPATCHING"))) },
    { kind: "check", key: location.workspaceKey, condition: when.and(when.eq("fence", operation.fence), when.eq("activeOperationId", operationId)) },
    { kind: "check", key: location.taskPointerKey(), condition: when.eq("taskId", task.taskId) },
    { kind: "delete", key: { pk: `OUTBOX#${outboxId}`, sk: "TASK_ACCESS_PAUSE" }, condition: when.eq("operationId", operationId) },
    { kind: "delete", key: { pk: pause.pk, sk: pause.sk }, condition: when.eq("operationId", operationId) },
    { kind: "put", item: { ...retry.auditKey, entityType: "TASK_ACCESS_RETRY", schemaVersion: 1, taskId: task.taskId, requestId: retry.requestId, actorId: acting.actorId, payloadHash: retry.payloadHash, outboxId, operationId, at }, condition: when.absent() },
  ];
  addAuthority(items, acting.items ?? []);
  if (!(await deps.store.transact(items)).applied) return conflict();
  return true;
}

function addAuthority(items: TransactItem[], authority: readonly TransactItem[]): void {
  for (const guard of authority) {
    if (guard.kind !== "check") throw agentXError("CONFIG_INVALID", "task authority fence unavailable");
    const index = items.findIndex((item) => item.kind === "check" && item.key.pk === guard.key.pk && item.key.sk === guard.key.sk);
    const prior = items[index];
    if (prior?.kind === "check") items[index] = { ...prior, condition: when.and(prior.condition, guard.condition) };
    else items.push(guard);
  }
}

function assertPauseMatches(pause: StoredDocument, task: TaskRecord, request: { expectedRevision?: number | undefined; candidateDigest?: string | undefined }): void {
  const workflow = task.workflow;
  if (workflow === undefined || pause["workflowRevision"] !== workflow.revision || pause["workflowStage"] !== workflow.stage || pause["workflowState"] !== workflow.state) return conflict();
  if (request.expectedRevision !== undefined && request.expectedRevision !== workflow.revision) return conflict();
  if (request.candidateDigest !== undefined && request.candidateDigest !== workflow.candidate?.digest) return conflict();
 }

function retryValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { throw agentXError("CONFIG_INVALID", "body: invalid JSON"); }
}
