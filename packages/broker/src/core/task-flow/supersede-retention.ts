import { CloseRetentionSchema, change, when, workspaceSessionKey, type CloseRetention, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import type { OperationRecord, WorkspaceRecord } from "./records.js";
import { toDocument } from "./records.js";
import { readOperation } from "./results.js";
import { workspaceKeys } from "./workspace-location.js";
import { CloseInspectionSchema } from "./close-inspection.js";

/** Only an exactly persisted completed preflight can be superseded; acceptance races on the same holder and SESSION. */
export async function retainedSuccessor(deps: TaskFlowDeps, workspace: WorkspaceRecord): Promise<{ retention?: CloseRetention; unconfirmed?: NonNullable<OperationRecord["supersedesUnconfirmed"]>; items: TransactItem[] } | undefined> {
  if (workspace.legacyCloseClaim !== undefined || workspace.status !== "READY" || workspace.activeOperationId === null) return undefined;
  const operation = await readOperation(deps, workspace.id, workspace.activeOperationId);
  if (operation !== undefined) {
    const unconfirmed = await unconfirmedSuccessor(deps, workspace, operation);
    if (unconfirmed !== undefined) return unconfirmed;
  }
  const parsed = CloseInspectionSchema.safeParse((operation?.result as { closeInspection?: unknown } | undefined)?.closeInspection);
  if (operation?.closePreflight === undefined || operation.status !== "SUCCEEDED" || operation.fence !== workspace.fence || !parsed.success) return undefined;
  const found = CloseRetentionSchema.safeParse({ inspectionOperationId: operation.id, inspectionFence: operation.fence, retentionId: parsed.data.retentionId, contentDigest: parsed.data.contentDigest, generation: parsed.data.retentionProof?.generation });
  if (!found.success) return undefined;
  return { retention: found.data, items: [
    { kind: "check", key: (await workspaceKeys(deps, workspace.id)).operationKey(operation.id), condition: when.and(when.eq("companyId", deps.companyId), when.eq("status", "SUCCEEDED"), when.eq("fence", workspace.fence), when.eq("result", toDocument(operation.result!))) },
    // A STOPPED (idle-stopped after the check) or FAILED (its wake did not provision) session is continued too: the step wakes it on the same volume like a plain stopped session; retention changes only what Close does.
    { kind: "check", key: workspaceSessionKey(workspace.id), condition: when.and(when.or(when.eq("state", "READY"), when.eq("state", "STOPPED"), when.eq("state", "FAILED")), when.eq("closeRetention.retained", toDocument(found.data)), when.notExists("closeRetention.acceptedOperationId"), when.notExists("closeDestroy")) },
  ] };
}

/**
 * A check that captured its target but whose worker never confirmed the retention (it answered `unavailable`, or died) leaves an UNCONFIRMED record and its preflight holding the workspace. While the instance runs, the
 * idle rule ends it after the idle window (the volume and the record stay: Close says "can't check"). Once the instance is gone (STOPPED or FAILED) a Continue / Retry / new step may take the workspace over: the
 * preflight is ended (INTERRUPTED) and the unconfirmed record dropped in the step's own transaction, so the step wakes the machine on the same volume and the next Close re-runs the check. The worker may nevertheless
 * have sealed and answered (the reply was lost): the step is marked `supersedesUnconfirmed` and the dispatcher learns the worker's retention by replaying the retain, so the hand-over is the ordinary confirmed one.
 */
async function unconfirmedSuccessor(deps: TaskFlowDeps, workspace: WorkspaceRecord, operation: OperationRecord): Promise<{ unconfirmed: NonNullable<OperationRecord["supersedesUnconfirmed"]>; items: TransactItem[] } | undefined> {
  if (operation.kind !== "close" || operation.closePreflight?.target === undefined || (operation.status !== "ACCEPTED" && operation.status !== "RUNNING") || operation.fence !== workspace.fence) return undefined;
  const session = await deps.store.get(workspaceSessionKey(workspace.id));
  const record = session?.["closeRetention"] as { operationId?: unknown; retained?: unknown; acceptedOperationId?: unknown } | undefined;
  if (session === undefined || record === undefined || record.operationId !== operation.id || record.retained !== undefined || record.acceptedOperationId !== undefined || session["closeDestroy"] !== undefined) return undefined;
  if (session["state"] !== "STOPPED" && session["state"] !== "FAILED") return undefined;
  return { unconfirmed: { operationId: operation.id, fence: operation.fence, generation: operation.closePreflight.target }, items: [
    { kind: "update", key: (await workspaceKeys(deps, workspace.id)).operationKey(operation.id), condition: when.and(when.eq("companyId", deps.companyId), when.eq("status", operation.status), when.eq("fence", operation.fence), when.eq("closePreflight", toDocument(operation.closePreflight))), ops: [change.set("status", "INTERRUPTED")] },
    { kind: "update", key: workspaceSessionKey(workspace.id), condition: when.and(when.or(when.eq("state", "STOPPED"), when.eq("state", "FAILED")), when.eq("closeRetention", toDocument(record)), when.notExists("closeDestroy")), ops: [change.remove("closeRetention")] },
  ] };
}
