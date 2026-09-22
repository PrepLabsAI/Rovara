import type { Operation } from "@agentx/contracts";
import { reconcileInterruptedOperations, type OperationJournal } from "@agentx/worker";
import type { SqliteOperationStore } from "./store/sqlite-operations.js";
import type { SqliteRegistry } from "./store/sqlite-registry.js";
import type { DeliveryOutcome } from "./dispatcher.js";

export interface RecoveryReport {
  /** Outbox rows that were still undelivered when the host started. */
  redelivered: DeliveryOutcome[];
  /**
   * Operations a replaced worker left `RUNNING`.
   *
   * These are marked interrupted, never rerun. The worker may have completed real side
   * effects we cannot see, so "we do not know" is the honest state and a fresh attempt
   * is a decision for the control plane, not something a restart does by itself.
   */
  interrupted: Operation[];
  /** Workspaces whose writer lease belonged to an operation that is already terminal. */
  releasedWriters: string[];
}

/**
 * Bring a restarted host back to a truthful state.
 *
 * Nothing here invents an outcome. Queued work is re-offered to the worker, which
 * recognises duplicates by journal; ambiguous work is marked interrupted; and leases
 * held by finished operations are released so the workspace is usable again.
 */
export async function recoverHost(dependencies: {
  registry: SqliteRegistry;
  operations: SqliteOperationStore;
  dispatcher: { drainOnce: () => Promise<DeliveryOutcome[]> };
  /** The worker's own journal, when this host runs an in-process worker. */
  journal?: OperationJournal;
}): Promise<RecoveryReport> {
  const interrupted: Operation[] = [];

  if (dependencies.journal) {
    for (const record of await reconcileInterruptedOperations(dependencies.journal)) {
      const operation = dependencies.operations.get(record.operationId);
      if (!operation) continue;
      interrupted.push(
        dependencies.operations.settleTerminal(record.operationId, "FAILED", {
          error: record.error ?? "worker process was replaced during an operation; side effects were not replayed",
        }),
      );
    }
  }

  const releasedWriters: string[] = [];
  for (const workspaceId of dependencies.registry.listWorkspaceIds()) {
    const workspace = await dependencies.registry.get(workspaceId);
    if (!workspace?.activeOperationId) continue;
    const holder = dependencies.operations.get(workspace.activeOperationId);
    if (!holder || !isTerminal(holder.status)) continue;
    await dependencies.registry.releaseWriterIfHeld(workspaceId, workspace.activeOperationId);
    releasedWriters.push(workspaceId);
  }

  const redelivered = await dependencies.dispatcher.drainOnce();
  return { redelivered, interrupted, releasedWriters };
}

function isTerminal(status: Operation["status"]): boolean {
  return ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(status);
}
