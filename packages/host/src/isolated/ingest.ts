import { createHash } from "node:crypto";
import type { BrokerRequest, BrokerResponse } from "@agentx/broker";
import type { Operation } from "@agentx/contracts";
import type { SqliteOperationStore } from "../store/sqlite-operations.js";
import type { IsolatedRunResult } from "./runtime.js";

export type IngestHandler = (request: BrokerRequest) => Promise<BrokerResponse>;

export class UnsettledRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsettledRunError";
  }
}

/**
 * The stable identity of one admission effect.
 *
 * Derived from the operation, the container that produced the bytes and the terminal
 * record itself, so re-admitting the identical retained result after a lost reply is
 * recognised as the same effect rather than performed twice.
 */
export function admissionEffectId(result: IsolatedRunResult): string {
  return createHash("sha256")
    .update(result.operationId)
    .update("\0")
    .update(result.cid)
    .update("\0")
    .update(JSON.stringify(result.terminal))
    .digest("hex");
}

/**
 * Admit the bytes an isolated run produced through the host's real routes.
 *
 * Admission requires a **clean, owned, settled** run. A run that timed out, exited
 * non-zero, or whose container could not be confirmed removed is not a successful
 * execution, and calling it one would turn an uncertain cleanup into a passing result.
 * Those are refused; the caller records the uncertainty instead.
 *
 * The container has no network and never held a callback capability, so the bytes it
 * returned are admitted here through the same authenticated route, capability check and
 * durable write a networked worker would have driven. Nothing is synthesised.
 */
export async function ingestIsolatedRun(input: {
  handler: IngestHandler;
  result: IsolatedRunResult;
  store: SqliteOperationStore;
  capability?: string;
}): Promise<Operation> {
  const { result, store } = input;

  if (result.outcome !== "completed") {
    throw new UnsettledRunError(`run outcome is ${result.outcome}; only a completed run may be admitted`);
  }
  if (result.cleanup !== "removed") {
    throw new UnsettledRunError(
      `run cleanup is ${result.cleanup}; an unconfirmed container cannot produce a successful admission`,
    );
  }
  assertWellFormed(result);

  const effectId = admissionEffectId(result);
  const claim = store.claimAdmission(effectId, result.operationId, result.terminal.status);
  if (claim.duplicate) {
    // Same effect, already applied. Re-appending its events would duplicate progress.
    const existing = store.get(result.operationId);
    if (!existing) throw new UnsettledRunError("admitted operation is missing");
    store.settleOutboxFor(result.operationId);
    store.markExecutionSettled(result.operationId);
    return existing;
  }

  const capability = input.capability ?? result.callbackCapability;
  const base = `/v1/internal/workspaces/${result.workspaceId}/operations/${result.operationId}`;
  const headers = { "x-agentx-callback-capability": capability };

  if (result.events.length > 0) {
    await call(input.handler, "POST", `${base}/events`, { events: result.events }, headers);
  }
  for (const artifact of result.artifacts) {
    await call(input.handler, "POST", `${base}/artifacts`, artifact, headers);
  }
  const terminal = await call(input.handler, "POST", `${base}/result`, result.terminal, headers);

  // The queued invocation is done with, and the execution is no longer in doubt.
  store.settleOutboxFor(result.operationId);
  store.markExecutionSettled(result.operationId);
  return (terminal.body as { operation: Operation }).operation;
}

/**
 * Record a run that finished without a usable outcome.
 *
 * It writes no terminal row. The operation keeps whatever it honestly had, and the
 * execution is held so the queued work is not silently offered to another runtime.
 */
export function recordUnsettledRun(input: {
  store: SqliteOperationStore;
  operationId: string;
  reason: string;
}): { operationId: string; outcome: "unknown" } {
  input.store.markExecutionUnknown(input.operationId, input.reason);
  return { operationId: input.operationId, outcome: "unknown" };
}

function assertWellFormed(result: IsolatedRunResult): void {
  if (result.exitCode !== 0 && result.terminal.status !== "FAILED") {
    throw new UnsettledRunError(`run exited ${result.exitCode} without reporting a failure`);
  }
  const terminal = result.terminal;
  if (!terminal || typeof terminal !== "object") throw new UnsettledRunError("run has no terminal record");
  if (terminal.operationId !== result.operationId) {
    throw new UnsettledRunError("terminal record names another operation");
  }
  if (terminal.status !== "SUCCEEDED" && terminal.status !== "FAILED") {
    throw new UnsettledRunError(`terminal status ${String(terminal.status)} is not a run outcome`);
  }
  if (terminal.status === "SUCCEEDED" && terminal.result === undefined) {
    throw new UnsettledRunError("a successful run must carry its result");
  }
  for (const artifact of result.artifacts) {
    if (typeof artifact.name !== "string" || typeof artifact.content !== "string") {
      throw new UnsettledRunError("run returned a malformed artifact");
    }
  }
}

async function call(
  handler: IngestHandler,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const response = await handler({ method, path, headers, body: JSON.stringify(body) });
  const parsed = JSON.parse(response.body) as unknown;
  if (response.statusCode >= 400) {
    throw new Error(`host refused ${method} ${path}: ${response.statusCode} ${response.body}`);
  }
  return { status: response.statusCode, body: parsed };
}
