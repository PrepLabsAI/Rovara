// P2: no effects before this one transaction. P3 composes route control; P4 resumes the accepted operation, never a fresh request's reads.
import { z } from "zod";
import { currentOperation } from "../../developer/task-records.js";
import { AgentXError, DOCUMENT_STORE_LIMITS, DocumentStoreError, TaskCloseDigestSchema, agentXError, change, when, type TransactItem } from "@agentx/contracts";
import { sessionCloseAcceptanceItems } from "../sessions/close-acceptance.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { closeFacts, mergeCloseConditions } from "./close-conditions.js";
import { acceptedCloseRecord, closeOperationId } from "./close-acceptance-record.js";
import { readCloseSnapshot, type CloseSnapshot } from "./close-inspection.js";
import { loadTaskAsOwner } from "./owner-round.js";
import { parseBody } from "./owner-round.js";
import { readOperation } from "./results.js";
import { taskKey } from "./keys.js";
import { toDocument, type OperationRecord, type TaskRecord } from "./records.js";
import { dispatchQueueName, hashJson, log } from "./support.js";

const CloseIntentSchema = z.object({ requestId: z.string().uuid(), expectedPreviewDigest: TaskCloseDigestSchema, discard_unpublished: z.boolean().optional() }).strict();
export type CloseIntent = z.infer<typeof CloseIntentSchema>;
const stale = () => agentXError("CHANGE_STALE", "the close preview has changed; review it again");

export const closeHasDigest = (input: unknown): boolean => typeof input === "object" && input !== null && Object.hasOwn(input, "expectedPreviewDigest");

export function parseCloseIntent(input: unknown): CloseIntent { return parseBody(CloseIntentSchema, input); }

function snapshotConditions(snapshot: CloseSnapshot): TransactItem[] {
  const { task, workspace, location, pointer } = snapshot;
  // The workspace fence/holder is the aggregate version for acquisition of new operations.
  // Historical operations cannot change the displayed status or retained content. Bind only
  // the inspection and current status/accounting source, so history never expands the transaction.
  const current = currentOperation(snapshot.operations);
  const sources = snapshot.operations.filter((op) => op.id === snapshot.operation.id || op.id === current?.id);
  return [
    { kind: "check", key: taskKey(task.taskId), condition: closeFacts(toDocument(task), ["companyId", "orgId", "taskId", "workspaceId", "project", "developerId", "ownerKey", "closedAt", "releasedAt", "closeOperationId", "sessionId", "workflow.revision", "workflow.stage", "workflow.state", "workflow.ownerId", "admissionReservationId", "charge"]) },
    { kind: "check", key: location.workspaceKey, condition: closeFacts(toDocument(workspace), ["companyId", "orgId", "id", "status", "fence", "activeOperationId", "legacyCloseClaim", "ownerKey", "closedAt", "machine", "machineReservationId", "projectRevision", "preparationManifest"]) },
    { kind: "check", key: location.taskPointerKey(), condition: closeFacts(pointer, ["companyId", "taskId", "pendingPrompt", "pendingWorkflowMode", "cancelledAt", "closeOperationId"]) },
    ...sources.map((op): TransactItem => ({ kind: "check", key: location.operationKey(op.id), condition: closeFacts(toDocument(op), ["companyId", "workspaceId", "id", "kind", "status", "fence", "createdAt", "machineId", "secondReviewPlan", ...(op.id === snapshot.operation.id ? ["result"] : [])]) })),
  ];
}

/** A read-only host plan; access predicates are merged with Updates, not sent as duplicate-key Checks. */
export async function planCloseAcceptance(deps: TaskFlowDeps, caller: TaskCaller, snapshot: CloseSnapshot, intent: CloseIntent, intentHash: string, authority: readonly TransactItem[]) {
  const operation = acceptedCloseRecord(deps, snapshot, intent, caller.principal.personId, intentHash);
  const { task, location } = snapshot, at = operation.createdAt;
  const items = mergeCloseConditions([
    ...snapshotConditions(snapshot), ...authority,
    ...(deps.closeInspection?.acceptanceItems?.(snapshot.inspection, operation.id) ?? []),
    { kind: "put", item: toDocument(operation), condition: when.absent() },
    { kind: "update", key: taskKey(task.taskId), ops: [change.set("closeOperationId", operation.id), change.set("updatedAt", at)] },
    { kind: "update", key: location.workspaceKey, ops: [change.set("status", "CLOSING"), change.set("fence", operation.fence), change.set("activeOperationId", operation.id), change.set("updatedAt", at)] },
    { kind: "update", key: location.taskPointerKey(), ops: [change.set("closeOperationId", operation.id), change.remove("pendingPrompt"), change.remove("pendingWorkflowMode")] },
    ...await sessionCloseAcceptanceItems(deps, task, caller.principal, { requestId: intent.requestId, operationId: operation.id, intentHash, at }),
    deps.outbox.stage({ id: operation.id, companyId: deps.companyId, queue: dispatchQueueName(deps), attributes: { kind: "close" }, body: { v: 1, companyId: deps.companyId, workspaceId: snapshot.workspace.id, operationId: operation.id, resumeClose: true } }),
  ]);
  if (items.length > DOCUMENT_STORE_LIMITS.maxTransactItems) throw stale();
  return { operation, items };
}

function replay(operation: OperationRecord | undefined, intentHash: string): OperationRecord | undefined {
  if (operation === undefined) return undefined;
  if (operation.kind !== "close" || operation.closeAcceptance?.schemaVersion !== 1 || operation.payloadHash !== intentHash || operation.closeAcceptance.intentHash !== intentHash) throw agentXError("IDEMPOTENCY_CONFLICT", "that request ID was used for a different close");
  return operation;
}

async function authorizedTask(deps: TaskFlowDeps, caller: TaskCaller, taskId: string) {
  try { return await loadTaskAsOwner(deps, caller, taskId); }
  catch (error) { if (error instanceof AgentXError && ["TASK_NOT_FOUND", "TASK_ACCESS_DENIED", "FORBIDDEN"].includes(error.code)) throw stale(); throw error; }
}

/** Read-only preparation shared by developer close and session control. The latter owns its acceptance commit. */
export async function prepareTaskCloseAcceptance(deps: TaskFlowDeps, caller: TaskCaller, taskId: string, input: unknown, sessionId?: string) {
  const intent = parseCloseIntent(input);
  const { task, acting } = await authorizedTask(deps, caller, taskId);
  if (sessionId !== undefined && task.sessionId !== sessionId) throw stale();
  return prepareAcceptance(deps, caller, task, intent, acting.items ?? []);
}

/** The acceptance once the task and the caller's authority are settled: the person's (above) and the system's (`close-system.ts`, no owner to check: the flow has just read its own task). */
export async function prepareAcceptance(deps: TaskFlowDeps, caller: TaskCaller, task: TaskRecord, intent: CloseIntent, authority: readonly TransactItem[]) {
  const taskId = task.taskId;
  const intentHash = hashJson({ companyId: deps.companyId, actorId: caller.principal.personId, taskId, requestId: intent.requestId, expectedPreviewDigest: intent.expectedPreviewDigest, discard_unpublished: intent.discard_unpublished === true });
  const id = closeOperationId(deps.companyId, taskId, intent.requestId);
  const prior = replay(await readOperation(deps, task.workspaceId, id), intentHash);
  if (prior !== undefined) return preparedAcceptance(deps, prior, [], true, intentHash);
  if (task.closedAt !== undefined || task.closeOperationId !== undefined) throw stale();
  const snapshot = await requireCloseSnapshot(deps, caller, task, intent);
  const { operation, items } = await planCloseAcceptance(deps, caller, snapshot, intent, intentHash, authority);
  return preparedAcceptance(deps, operation, items, false, intentHash);
}

function preparedAcceptance(deps: TaskFlowDeps, operation: OperationRecord, items: TransactItem[], repeated: boolean, intentHash: string) {
  const plan = {
    operation, items, repeated,
    async onConflict() {
      // Resume the persisted winner, including its original deadline and receipts, never the losing candidate.
      const winner = replay(await readOperation(deps, operation.workspaceId, operation.id), intentHash);
      if (winner === undefined) throw stale();
      plan.operation = winner;
    },
    async resume() {
      try { await deps.resumeAcceptedClose?.(plan.operation); }
      catch (error) { log(deps, { event: "task_flow.close_resume_failed", error: error instanceof Error ? error.name : "unknown" }); }
    },
  };
  return plan;
}

/** Returns durable acceptance. Accounting/destruction belong to resume, never the request's pre-accept reads. */
export async function acceptTaskClose(deps: TaskFlowDeps, caller: TaskCaller, taskId: string, input: unknown): Promise<OperationRecord> {
  return commitAcceptance(deps, await prepareTaskCloseAcceptance(deps, caller, taskId, input));
}

export async function commitAcceptance(deps: TaskFlowDeps, plan: Awaited<ReturnType<typeof prepareAcceptance>>): Promise<OperationRecord> {
  if (!plan.repeated) {
    let applied = false;
    try { applied = (await deps.store.transact(plan.items)).applied; }
    catch (error) { if (!(error instanceof DocumentStoreError && error.code === "conflict")) throw error; }
    if (!applied) await plan.onConflict();
  }
  await plan.resume();
  return plan.operation;
}

async function requireCloseSnapshot(deps: TaskFlowDeps, caller: TaskCaller, task: TaskRecord, intent: CloseIntent): Promise<CloseSnapshot> {
  let snapshot: CloseSnapshot | undefined;
  try { snapshot = await readCloseSnapshot(deps, caller, task, intent.discard_unpublished === true ? "discard" : "close"); } catch { throw stale(); }
  if (snapshot === undefined || snapshot.preview.digest !== intent.expectedPreviewDigest || snapshot.workspace.status === "CLOSING" || snapshot.workspace.status === "CLOSED") throw stale();
  if (intent.discard_unpublished !== true && !snapshot.inspection.safeToClose) throw stale();
  return snapshot;
}
