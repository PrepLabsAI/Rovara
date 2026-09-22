import { agentXError, type WorkerInvocation } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "@agentx/broker";
import {
  OperationJournal,
  WorkerCancellationController,
  WorkerOperationCancelledError,
  createWorkerCallbackSinks,
  runTaskInvocation,
  type PiSessionAdapter,
} from "@agentx/worker";
import type { SqliteOperationStore } from "./store/sqlite-operations.js";

export type HostHandler = (request: BrokerRequest) => Promise<BrokerResponse>;

export interface WorkerTransport {
  deliver(invocation: WorkerInvocation): Promise<void>;
}

export interface DeliveryOutcome {
  outboxId: string;
  operationId: string;
  delivered: boolean;
  reason?: string;
}

/**
 * Drain the durable outbox into a worker transport.
 *
 * Delivery is at-least-once and the worker's journal is the thing that makes that safe:
 * a redelivered invocation is recognised as a duplicate rather than run twice. A row is
 * marked delivered only after the transport returns, so a crash mid-delivery leaves work
 * queued rather than silently dropped.
 */
export function createOutboxDispatcher(dependencies: {
  operations: SqliteOperationStore;
  transport: WorkerTransport;
  maxAttempts?: number;
}) {
  const maxAttempts = dependencies.maxAttempts ?? 5;
  return {
    async drainOnce(): Promise<DeliveryOutcome[]> {
      const outcomes: DeliveryOutcome[] = [];
      for (const record of dependencies.operations.pendingOutbox()) {
        // An execution whose outcome we could not observe is held. Handing the same job
        // out again would authorize a second execution on the strength of our own
        // ignorance, so it waits for an explicit reconciliation instead.
        const hold = dependencies.operations.executionHold(record.operationId);
        if (hold.held) {
          outcomes.push({
            outboxId: record.id,
            operationId: record.operationId,
            delivered: false,
            reason: hold.reason ?? "execution outcome unknown; reconcile before retry",
          });
          continue;
        }
        if (record.attempts >= maxAttempts) {
          outcomes.push({
            outboxId: record.id,
            operationId: record.operationId,
            delivered: false,
            reason: "attempt limit reached",
          });
          continue;
        }
        dependencies.operations.recordOutboxAttempt(record.id);
        try {
          await dependencies.transport.deliver(record.invocation);
          dependencies.operations.markOutboxDelivered(record.id);
          outcomes.push({ outboxId: record.id, operationId: record.operationId, delivered: true });
        } catch (error) {
          outcomes.push({
            outboxId: record.id,
            operationId: record.operationId,
            delivered: false,
            reason: error instanceof Error ? error.message : "delivery failed",
          });
        }
      }
      return outcomes;
    },
  };
}

export interface FixtureWorkerTransportOptions {
  /** Prepared workspace root containing `.agentx/preparation-manifest.json`. */
  rootPath: string;
  /** The host's own route handler; callbacks go back through it, authenticated. */
  handler: HostHandler;
  /** Deterministic, model-free session that edits real source. */
  sessionAdapter: PiSessionAdapter;
  controlPlaneUrl?: string;
  /** Swallow the terminal callback to reproduce a lost reply. */
  dropTerminalReply?: () => boolean;
}

/**
 * A transport that runs the **real** worker entry code against a fixture session.
 *
 * `runTaskInvocation` here is the production function: it reads the preparation
 * manifest, binds the candidate base, creates the session, freezes the candidate through
 * the actual freezer, publishes the workspace diff and uploads artifacts with receipt
 * verification. Only the model-facing session is a fixture, and it does nothing but
 * write files.
 *
 * Nothing in this transport inserts a completed operation or manufactures a bundle: the
 * terminal result it reports is whatever the real worker produced.
 */
export function createFixtureWorkerTransport(options: FixtureWorkerTransportOptions): WorkerTransport & {
  journal: OperationJournal;
  cancellation: WorkerCancellationController;
} {
  const journal = new OperationJournal(options.rootPath);
  const cancellation = new WorkerCancellationController();
  const controlPlaneUrl = options.controlPlaneUrl ?? "https://host.invalid";

  const fetchImplementation: typeof fetch = async (input, init) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const response = await options.handler({
      method: init?.method ?? "POST",
      path: new URL(address).pathname,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };

  return {
    journal,
    cancellation,
    async deliver(invocation: WorkerInvocation): Promise<void> {
      const accepted = await journal.accept(invocation);
      // A redelivered invocation is not a second run. This is the guarantee that makes
      // at-least-once outbox delivery safe.
      if (accepted.duplicate) return;

      const callbacks = createWorkerCallbackSinks({ controlPlaneUrl, invocation, fetchImplementation });

      if (invocation.kind === "cancel") {
        const result = await cancellation.cancel(invocation.payload.targetOperationId);
        await journal.transition(invocation.operationId, "SUCCEEDED");
        await callbacks.terminalSink({
          operationId: invocation.payload.targetOperationId,
          status: result.status === "CANCELLED" ? "CANCELLED" : "FAILED",
          ...(result.status === "CANCELLED" ? {} : { error: "cancellation could not confirm all processes stopped" }),
        });
        return;
      }

      if (invocation.kind !== "task") {
        throw agentXError("CONFIG_INVALID", `fixture transport does not run ${invocation.kind} invocations`);
      }

      await journal.transition(invocation.operationId, "RUNNING");
      try {
        const result = await runTaskInvocation(invocation, {
          rootPath: options.rootPath,
          model: { provider: "fixture", modelId: "fixture" },
          piAdapter: options.sessionAdapter,
          cancellationController: cancellation,
          ...callbacks,
        });
        await journal.transition(invocation.operationId, "SUCCEEDED", undefined, result);
        // A dropped reply leaves the host with an accepted operation and no terminal
        // result: exactly the lost-reply state recovery has to survive.
        if (options.dropTerminalReply?.()) return;
        await callbacks.terminalSink({
          operationId: invocation.operationId, status: "SUCCEEDED", result,
        });
      } catch (error) {
        const cancelled = error instanceof WorkerOperationCancelledError;
        const message = error instanceof Error ? error.message : "task failed";
        await journal.transition(
          invocation.operationId, cancelled ? "CANCELLED" : "FAILED", message,
        );
        if (options.dropTerminalReply?.()) return;
        await callbacks.terminalSink({
          operationId: invocation.operationId,
          status: cancelled ? "CANCELLED" : "FAILED",
          error: message,
        });
      }
    },
  };
}
