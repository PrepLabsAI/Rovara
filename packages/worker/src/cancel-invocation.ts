import type { WorkerInvocation } from "@agentx/contracts";
import type { OperationJournal } from "./journal.js";
import type { WorkerCancellationController } from "./cancel.js";

/** Executes the worker's signed cancel invocation against its exact target operation. */
export async function executeWorkerCancelInvocation(
  invocation: Extract<WorkerInvocation, { kind: "cancel" }>,
  cancellationController: WorkerCancellationController,
  journal: OperationJournal,
): Promise<{ status: "CANCELLED" | "INTERRUPTED"; remainingProcesses: number }> {
  const result = await cancellationController.cancel(invocation.payload.targetOperationId);
  await journal.transition(
    invocation.payload.targetOperationId,
    result.status,
    result.status === "CANCELLED"
      ? "operation cancelled by user"
      : "cancellation could not confirm all processes stopped",
  );
  return result;
}
