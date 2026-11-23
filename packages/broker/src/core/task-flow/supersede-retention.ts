import { CloseRetentionSchema, when, workspaceSessionKey, type CloseRetention, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import type { WorkspaceRecord } from "./records.js";
import { toDocument } from "./records.js";
import { readOperation } from "./results.js";
import { workspaceKeys } from "./workspace-location.js";
import { CloseInspectionSchema } from "./close-inspection.js";

/** Only an exactly persisted completed preflight can be superseded; acceptance races on the same holder and SESSION. */
export async function retainedSuccessor(deps: TaskFlowDeps, workspace: WorkspaceRecord): Promise<{ retention: CloseRetention; items: TransactItem[] } | undefined> {
  if (workspace.legacyCloseClaim !== undefined || workspace.status !== "READY" || workspace.activeOperationId === null) return undefined;
  const operation = await readOperation(deps, workspace.id, workspace.activeOperationId);
  const parsed = CloseInspectionSchema.safeParse((operation?.result as { closeInspection?: unknown } | undefined)?.closeInspection);
  if (operation?.closePreflight === undefined || operation.status !== "SUCCEEDED" || operation.fence !== workspace.fence || !parsed.success) return undefined;
  const found = CloseRetentionSchema.safeParse({ inspectionOperationId: operation.id, inspectionFence: operation.fence, retentionId: parsed.data.retentionId, contentDigest: parsed.data.contentDigest, generation: parsed.data.retentionProof?.generation });
  if (!found.success) return undefined;
  return { retention: found.data, items: [
    { kind: "check", key: (await workspaceKeys(deps, workspace.id)).operationKey(operation.id), condition: when.and(when.eq("companyId", deps.companyId), when.eq("status", "SUCCEEDED"), when.eq("fence", workspace.fence), when.eq("result", toDocument(operation.result!))) },
    { kind: "check", key: workspaceSessionKey(workspace.id), condition: when.and(when.eq("state", "READY"), when.eq("closeRetention.retained", toDocument(found.data)), when.notExists("closeRetention.acceptedOperationId"), when.notExists("closeDestroy")) },
  ] };
}
