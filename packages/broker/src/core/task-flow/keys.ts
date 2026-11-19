// Core workspaces created now use company keys. Existing workspaces are located once before their rows are addressed.
import { agentXError, OrgIdSchema, companyScoped, orgLimitKey, type DocumentKey, type OrgId } from "@agentx/contracts";

export { taskKey, taskIndexKey, startIdempotencyKey } from "../../developer/task-records.js";

export function workspacePartition(companyId: string, workspaceId: string): string {
  if (!OrgIdSchema.safeParse(companyId).success) throw agentXError("CONFIG_INVALID", "invalid workspace company");
  return companyScoped(companyId, `WORKSPACE#${workspaceId}`);
}
export const workspaceKey = (companyId: string, workspaceId: string): DocumentKey => ({ pk: workspacePartition(companyId, workspaceId), sk: "META" });
export const OPERATION_SK_PREFIX = "OPERATION#";
export const operationKey = (companyId: string, workspaceId: string, operationId: string): DocumentKey => ({ pk: workspacePartition(companyId, workspaceId), sk: `${OPERATION_SK_PREFIX}${operationId}` });
export const conversationKey = (companyId: string, workspaceId: string, conversationId: string): DocumentKey => ({ pk: workspacePartition(companyId, workspaceId), sk: `CONVERSATION#${conversationId}` });
export const taskPointerKey = (companyId: string, workspaceId: string): DocumentKey & { sk: "DEVELOPER_TASK" } => ({ pk: workspacePartition(companyId, workspaceId), sk: "DEVELOPER_TASK" });
export const operationEventPrefix = (operationId: string): string => `EVENT#${operationId}#`;
export const operationEventKey = (companyId: string, workspaceId: string, operationId: string, sequence: number): DocumentKey => ({ pk: workspacePartition(companyId, workspaceId), sk: `${operationEventPrefix(operationId)}${String(sequence).padStart(10, "0")}` });
export function operationRequestKey(companyId: string, ownerKey: string, workspaceId: string, requestId: string): DocumentKey {
  if (!OrgIdSchema.safeParse(companyId).success) throw agentXError("CONFIG_INVALID", "invalid workspace company");
  return { pk: companyScoped(companyId, `IDEMPOTENCY#${ownerKey}#${workspaceId}`), sk: `REQUEST#${requestId}` };
}

/** The partition of one company's workflow dispatch rows (Cloud keeps one install-wide partition; Code scopes it, decision 45.6). */
export const dispatchPartition = (companyId: string): string => companyScoped(companyId, "WORKFLOW_DISPATCH");

export const dispatchRowKey = (companyId: string, taskId: string, workflowRevision: number): DocumentKey => ({ pk: dispatchPartition(companyId), sk: `${taskId}#${workflowRevision}` });

// ---- Workspace limits (Cloud's counters; the per-task marker replaces its string set, docs/ports.md "What is not here") ----

export type CounterKey = DocumentKey;
export interface WorkspaceCharge { member: CounterKey; organization: CounterKey }

export function developerCharge(input: { companyId: OrgId; developerId: string }): WorkspaceCharge {
  return {
    member: { pk: `DEVELOPER_LIMIT#${input.developerId}`, sk: "MEMBER" },
    organization: orgLimitKey(input.companyId),
  };
}

/** The marker that says a task holds a slot of this member's counter. Written once with `when.absent()`. */
export const chargeMarkerKey = (charge: WorkspaceCharge, taskId: string): DocumentKey => ({ pk: charge.member.pk, sk: `TASK#${taskId}` });
