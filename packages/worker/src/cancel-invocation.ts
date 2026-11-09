import { agentXError, type WorkerInvocation } from "@agentx/contracts";
import { CANCELLED_BEFORE_ARRIVAL, type JournalRecord, type JournalStatus, type OperationJournal } from "./journal.js";
import type { WorkerCancellationController } from "./cancel.js";

const ENDED: ReadonlySet<JournalStatus> = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
/** The ends a stop may answer for: the operation stopped. An operation that finished on its own (SUCCEEDED, FAILED) was not stopped, and its cancel fails as it always did. */
const STOPPED: ReadonlySet<JournalStatus> = new Set(["CANCELLED", "INTERRUPTED"]);
/** How long a cancel for a still-starting operation waits for it to end. A cancel that cannot confirm the end in this time fails, and the broker keeps the workspace held (fails closed). */
const STARTING_END_WAIT_MS = 30_000;
const STARTING_END_POLL_MS = 200;

/**
 * Executes the worker's signed cancel invocation against its exact target operation.
 *
 * 058-stop-close (QA6-13): the target is not always running yet when its Stop arrives.
 * - The worker was never sent it (its delivery was waiting for the compute, or is on the way): the stop is written to the journal, so the operation is refused if it arrives, and the cancel succeeds.
 *   If the operation's own accept wins that race, the stop is treated as for any operation the worker has taken.
 * - The worker took it but it has not registered (it is checking out, or starting its session): the stop is remembered and applied when it registers; the cancel succeeds once the operation has stopped.
 * Both used to fail with NOT_FOUND, which left the task INTERRUPTED with its workspace held until the reconciler's idle check, ten minutes later.
 */
export async function executeWorkerCancelInvocation(
  invocation: Extract<WorkerInvocation, { kind: "cancel" }>,
  cancellationController: WorkerCancellationController,
  journal: OperationJournal,
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<{ status: "CANCELLED" | "INTERRUPTED"; remainingProcesses: number }> {
  const target = invocation.payload.targetOperationId;
  if (!cancellationController.isRegistered(target)) {
    let record: JournalRecord | undefined = await journal.get(target);
    if (record === undefined) {
      // Written only if nothing is there: when the operation's accept got in first, the record handed back is the operation's own, not the stop's.
      record = await journal.tombstone({ operationId: target, workspaceId: invocation.workspaceId, fence: invocation.fence });
    }
    // The same stop sent again, or the one just written.
    if (record.payloadHash === CANCELLED_BEFORE_ARRIVAL) return { status: "CANCELLED", remainingProcesses: 0 };
    if (!ENDED.has(record.status) && cancellationController.cancelWhenRegistered(target)) {
      const waitMs = options.waitMs ?? STARTING_END_WAIT_MS;
      const pollMs = options.pollMs ?? STARTING_END_POLL_MS;
      for (let waited = 0; waited <= waitMs; waited += pollMs) {
        const current = await journal.get(target);
        if (current !== undefined && ENDED.has(current.status)) {
          cancellationController.forget(target);
          if (STOPPED.has(current.status)) return { status: "CANCELLED", remainingProcesses: 0 };
          // It finished on its own while the stop waited: the stop did not stop it, so it does not claim to have.
          throw agentXError("NOT_FOUND", "active operation not found");
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      throw agentXError("OPERATION_INTERRUPTED", "the operation is still starting; it will stop as soon as it begins");
    }
  }
  const result = await cancellationController.cancel(target);
  await journal.transition(
    target,
    result.status,
    result.status === "CANCELLED"
      ? "operation cancelled by user"
      : "cancellation could not confirm all processes stopped",
  );
  return result;
}
