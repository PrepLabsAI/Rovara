// The watch rows of operations in flight: one row for each operation handed to a worker machine, written in the same transaction as the hand-over (`claimDispatch`). The run-lost sweep
// (`run-watch.ts`) reads them to find an operation whose machine is gone; nothing else does. A row nobody removes is dropped by a store with a time-to-live after `RETENTION_SECONDS`.
import { companyScoped, type DocumentKey, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import type { OperationRecord } from "./records.js";
import { toDocument } from "./records.js";

/** A row the sweep did not remove (its operation never ended on a store the sweep reads) goes after this long. A backstop, as for the dispatch rows. */
const RETENTION_SECONDS = 7 * 86_400;

/** The partition of one company's watch rows. */
export const runWatchPartition = (companyId: string): string => companyScoped(companyId, "WORKFLOW_RUN_WATCH");

export const runWatchKey = (companyId: string, workspaceId: string, operationId: string): DocumentKey => ({ pk: runWatchPartition(companyId), sk: `${workspaceId}#${operationId}` });

/** What the sweep reads of an operation it watches. `unhealthySince` is the first time the sweep saw the machine lost or unhealthy; the grace period counts from it. */
export interface RunWatchRecord {
  pk: string;
  sk: string;
  entityType: "WORKFLOW_RUN_WATCH";
  companyId: string;
  workspaceId: string;
  operationId: string;
  /** The fence the operation was handed over under: the row names that hold of the workspace and no other. */
  fence: number;
  machineId: string;
  watchedAt: string;
  unhealthySince?: string;
}

/**
 * The step that starts watching an operation, for the transaction that hands it to a machine. A hand-over repeated (a redelivered message, another machine) writes the row again from the start:
 * the clock of the grace period begins again with the new machine.
 */
export function runWatchItem(deps: Pick<TaskFlowDeps, "companyId" | "store">, operation: Pick<OperationRecord, "workspaceId" | "id" | "fence">, machineId: string, now: string): TransactItem {
  const key = runWatchKey(deps.companyId, operation.workspaceId, operation.id);
  const row: RunWatchRecord = { ...key, entityType: "WORKFLOW_RUN_WATCH", companyId: deps.companyId, workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, machineId, watchedAt: now };
  const expires = deps.store.ttlAttribute === undefined ? {} : { [deps.store.ttlAttribute]: Math.floor(Date.parse(now) / 1_000) + RETENTION_SECONDS };
  return { kind: "put", item: toDocument({ ...row, ...expires }) };
}
