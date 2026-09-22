import { randomUUID } from "node:crypto";
import type { WorkerInvocation } from "@agentx/contracts";
import type { WorkerTransport } from "../dispatcher.js";
import type { SqliteOperationStore } from "../store/sqlite-operations.js";
import type { FixtureMode } from "../fixture-worker.js";
import { ingestIsolatedRun, recordUnsettledRun, type IngestHandler } from "./ingest.js";
import type { MockModelRoute } from "./mock-model-route.js";
import type { IsolatedFixtureRuntime } from "./runtime.js";

export interface IsolatedExecutionTransportOptions {
  runtime: IsolatedFixtureRuntime;
  handler: IngestHandler;
  store: SqliteOperationStore;
  /** Prepared workspace streamed to the container; never mounted. */
  workspacePath: string;
  mode: FixtureMode;
  /** Mock-only route. It holds no credential and reaches no provider. */
  route: MockModelRoute;
  caseId: string;
  /** Authorized ceiling for this attempt, enforced by the route before dispatch. */
  budget?: { maxMicrounits: number; maxCalls: number; ttlMs: number };
  modelId?: string;
}

/**
 * The bounded bridge from durable dispatch to an isolated execution.
 *
 * This is a real `WorkerTransport`, so the ordinary outbox dispatcher drives it: an
 * accepted task becomes a queued invocation, the dispatcher delivers it here, this
 * launches the isolated worker, prices the request through the mock route, and admits
 * the returned bytes through the host's authenticated routes. Nothing in the path is a
 * test helper reaching around the queue.
 *
 * Three orderings matter and are deliberate:
 *
 * 1. Execution ownership is claimed **before** the runtime is touched, so a launch we
 *    then lose sight of already has a durable owner.
 * 2. The route reservation is taken **before** the run, at a conservative upper bound,
 *    and is never refunded.
 * 3. A run that did not come back clean, owned and settled is recorded as unknown and
 *    **not** admitted. The queued work is then held rather than re-offered.
 */
export function createIsolatedExecutionTransport(
  options: IsolatedExecutionTransportOptions,
): WorkerTransport & { lastReceiptFor: (operationId: string) => unknown[] } {
  const budget = options.budget ?? { maxMicrounits: 1_000_000, maxCalls: 4, ttlMs: 600_000 };
  const modelId = options.modelId ?? "mock/deterministic-v1";

  return {
    lastReceiptFor(operationId: string) {
      return options.store.listRouteReceipts(operationId);
    },

    async deliver(invocation: WorkerInvocation): Promise<void> {
      if (invocation.kind !== "task") return;

      // 1. Own the execution before anything is launched.
      const claim = options.store.beginExecution(invocation.operationId, randomUUID());
      if (claim.duplicate) return;

      // 2. Price the request before dispatch. A refusal here stops the run.
      const token = options.route.mint({
        operationId: invocation.operationId,
        caseId: options.caseId,
        attemptNumber: 1,
        maxMicrounits: budget.maxMicrounits,
        maxCalls: budget.maxCalls,
        notAfter: new Date(Date.now() + budget.ttlMs).toISOString(),
      });
      const reservation = options.route.reserve({
        token,
        modelId,
        inputBytes: Buffer.byteLength(invocation.payload.prompt, "utf8"),
      });

      let result;
      try {
        result = await options.runtime.runTask({
          invocation,
          workspacePath: options.workspacePath,
          mode: options.mode,
        });
      } catch (error) {
        // The launch itself is in doubt, which is not the same as knowing it failed.
        options.route.settleUnknown(reservation.reservationId, "run outcome not observed");
        recordUnsettledRun({
          store: options.store,
          operationId: invocation.operationId,
          reason: error instanceof Error ? error.message : "isolated run failed to produce an outcome",
        });
        return;
      }

      if (result.outcome !== "completed" || result.cleanup !== "removed") {
        // Observed, and observed to be unusable. The route keeps its reservation and
        // the operation keeps whatever it honestly had.
        options.route.settleUnknown(
          reservation.reservationId,
          `run outcome ${result.outcome}, cleanup ${result.cleanup}`,
        );
        recordUnsettledRun({
          store: options.store,
          operationId: invocation.operationId,
          reason: `isolated run was not clean and settled: outcome ${result.outcome}, cleanup ${result.cleanup}`,
        });
        return;
      }

      // 3. The run came back clean and owned. The route observed its own dispatch, so
      // the receipt records an observed outcome rather than silence.
      options.route.settleObserved(reservation.reservationId, {
        outcome: "succeeded",
        observedMicrounits: Buffer.byteLength(invocation.payload.prompt, "utf8"),
      });
      await ingestIsolatedRun({ handler: options.handler, result, store: options.store });
    },
  };
}
