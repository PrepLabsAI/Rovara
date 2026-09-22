import type { BrokerRequest, BrokerResponse } from "@agentx/broker";
import type { Operation } from "@agentx/contracts";
import type { IsolatedRunResult } from "./runtime.js";

export type IngestHandler = (request: BrokerRequest) => Promise<BrokerResponse>;

/**
 * Admit the bytes an isolated run produced through the host's real routes.
 *
 * The container has no network, so it cannot call back. The bytes it returns were still
 * produced by the real freezer and the real artifact path; admitting them here runs the
 * same authenticated route, capability check and durable write a networked worker would
 * have driven. Nothing is synthesised: if the run reported no terminal record, none is
 * invented.
 *
 * Re-admitting an identical retained result is safe and expected after a lost reply.
 * Artifacts are immutable by name and the terminal settle accepts an identical repeat,
 * so a second admission produces the same operation rather than a second candidate.
 */
export async function ingestIsolatedRun(input: {
  handler: IngestHandler;
  result: IsolatedRunResult;
  capability?: string;
}): Promise<Operation> {
  const { result } = input;
  if (result.outcome !== "completed") {
    throw new Error(`cannot admit a run whose outcome is ${result.outcome}`);
  }
  // The capability was minted by the host for this exact operation and fence. The
  // container never received it: a worker with no network has no use for a callback
  // credential, and not issuing it is cheaper than trusting it.
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
  return (terminal.body as { operation: Operation }).operation;
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
