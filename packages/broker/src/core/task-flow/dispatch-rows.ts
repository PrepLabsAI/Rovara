// Lane L6a, task flow core: the workflow dispatch rows (Cloud's `WORKFLOW_DISPATCH`, `broker-shared.ts`): "start the next step of this task
// with no one asking", written in the same transaction as the result that made it due and run by the flow right after that commit; a sweep
// (`runDueDispatches`) runs any row left behind.
import { change, when, type DocumentStore, type IndexDefinition, type TransactItem } from "@agentx/contracts";
import { WORKFLOW_DISPATCH_DUE_INDEX } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { dispatchPartition, dispatchRowKey } from "./keys.js";
import type { DispatchKind, DispatchRowRecord } from "./records.js";
import { toDocument } from "./records.js";

/** The sparse due-time index the rows are found by. A store given to the flow must keep it. */
export const WORKFLOW_DISPATCH_INDEX: IndexDefinition = {
  name: WORKFLOW_DISPATCH_DUE_INDEX.name,
  partitionAttribute: WORKFLOW_DISPATCH_DUE_INDEX.partitionKey,
  sortAttribute: WORKFLOW_DISPATCH_DUE_INDEX.sortKey,
  sortType: "string",
};

/** A row nobody resolves is removed by a store with a time-to-live after this long (a backstop). */
const RETENTION_SECONDS = 7 * 86_400;

export function dispatchRowItem(deps: Pick<TaskFlowDeps, "companyId">, taskId: string, workflowRevision: number, kind: DispatchKind, now: string, dueAt: string = now, cause?: DispatchRowRecord["cause"]): Extract<TransactItem, { kind: "put" }> {
  const key = dispatchRowKey(deps.companyId, taskId, workflowRevision);
  const row: DispatchRowRecord = {
    ...key, entityType: "WORKFLOW_DISPATCH", companyId: deps.companyId, taskId, workflowRevision, kind, createdAt: now, attempts: 0, nextAttemptAt: dueAt, ...(cause === undefined ? {} : { cause }),
    dispatchDuePk: dispatchPartition(deps.companyId), dispatchDueSk: `${dueAt}#${key.sk}`,
    indexExpiresAt: Math.floor(Date.parse(now) / 1_000) + RETENTION_SECONDS,
  };
  return { kind: "put", item: toDocument(row), condition: when.absent() };
}

/** The rows due at `now`, oldest first. An index read may lag: a row written a moment ago can be missing, and the next sweep finds it. */
export async function dueDispatchRows(store: Pick<DocumentStore, "queryIndex">, companyId: string, now: string, limit: number): Promise<DispatchRowRecord[]> {
  const page = await store.queryIndex({
    index: WORKFLOW_DISPATCH_INDEX.name,
    partition: dispatchPartition(companyId),
    sort: { op: "lte", value: `${now}#￿` },
    limit,
  });
  return page.items.map((item) => item as unknown as DispatchRowRecord);
}

/** Resolves a row: the step it stood for was started, or is no longer wanted. */
export function resolveRowItem(deps: Pick<TaskFlowDeps, "companyId">, taskId: string, workflowRevision: number): TransactItem {
  return { kind: "delete", key: dispatchRowKey(deps.companyId, taskId, workflowRevision) };
}

/** Pushes a row's next try out (a backoff), keeping it on the index. Fenced on the due time the caller read, so a sweep that lost the race changes nothing. */
export function rescheduleRowItem(row: DispatchRowRecord, nextAttemptAt: string, attempts: number, lastError?: string): TransactItem {
  return {
    kind: "update",
    key: { pk: row.pk, sk: row.sk },
    ops: [change.set("nextAttemptAt", nextAttemptAt), change.set("dispatchDueSk", `${nextAttemptAt}#${row.sk}`), change.set("attempts", attempts), ...(lastError === undefined ? [] : [change.set("lastError", lastError.slice(0, 500))])],
    condition: when.eq("nextAttemptAt", row.nextAttemptAt),
  };
}
