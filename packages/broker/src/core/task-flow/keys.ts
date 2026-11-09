// Lane L6a, task flow core: the keys of the records the flow writes. They are Cloud's key forms (a Code store and a Cloud
// table can hold the same items, decision 45.6): a record that is addressed by a random id keeps Cloud's unscoped key, and a
// partition that gathers many tasks (the dispatch rows) carries the company scope.
import { companyScoped, orgLimitKey, type DocumentKey, type OrgId } from "@agentx/contracts";

export { taskKey, taskIndexKey, taskPointerKey, startIdempotencyKey } from "../../developer/task-records.js";

export const workspaceKey = (workspaceId: string): DocumentKey => ({ pk: `WORKSPACE#${workspaceId}`, sk: "META" });

export const operationKey = (workspaceId: string, operationId: string): DocumentKey => ({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` });

/** The sort-key prefix of a workspace's operations, for a query on the workspace's partition. */
export const OPERATION_SK_PREFIX = "OPERATION#";

export const conversationKey = (workspaceId: string, conversationId: string): DocumentKey => ({ pk: `WORKSPACE#${workspaceId}`, sk: `CONVERSATION#${conversationId}` });

/** One accepted request of one workspace: a repeated request id answers with the first operation (Cloud's acceptTask rule). */
export const operationRequestKey = (ownerKey: string, workspaceId: string, requestId: string): DocumentKey => ({ pk: `IDEMPOTENCY#${ownerKey}#${workspaceId}`, sk: `REQUEST#${requestId}` });

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
