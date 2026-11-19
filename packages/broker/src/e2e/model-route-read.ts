// The part of the model route registry that reads one route revision and touches no cloud client: the partition, the revision's key, the transient-fault test and the read of an admitted route.
// `model-route-registry.ts` (which keeps the DynamoDB-shaped writes) re-exports them, and the verifier of a round's evidence imports them from here.
import { E2EModelRouteDefinitionSchema, e2eModelRouteRevision, e2eModelRouteRevisionNumber, type E2EModelRouteDefinition } from "@agentx/contracts";

export const E2E_MODEL_ROUTE_PARTITION = "E2E_MODEL_ROUTES" as const;

const TRANSIENT_FAULT_NAMES: ReadonlySet<string> = new Set([
  "ProvisionedThroughputExceededException", "ThrottlingException", "ThrottledException", "RequestLimitExceeded", "TooManyRequestsException", "InternalServerError",
  "InternalFailure", "ServiceUnavailable", "ServiceUnavailableException", "RequestTimeout", "RequestTimeoutException", "TimeoutError", "AbortError",
]);
const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * Whether a failure to read DynamoDB or SSM is the kind that a later attempt can be expected to get past: throttling, a 5xx or InternalServerError, or a network, timeout or abort
 * error. Anything else (AccessDenied, ParameterNotFound, a malformed row, a validation error) is deterministic and will fail the same way again.
 */
export function isTransientAwsFault(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const fault = error as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown }; $fault?: unknown; cause?: unknown };
  if (typeof fault.name === "string" && TRANSIENT_FAULT_NAMES.has(fault.name)) return true;
  if (typeof fault.code === "string" && TRANSIENT_NETWORK_CODES.has(fault.code)) return true;
  const status = fault.$metadata?.httpStatusCode;
  if (typeof status === "number" && (status >= 500 || status === 429)) return true;
  if (fault.$fault === "server") return true;
  return fault.cause !== undefined && fault.cause !== error ? isTransientAwsFault(fault.cause) : false;
}

export const e2eModelRouteRevisionKey = (routeId: string, revisionNumber: number) => ({ pk: E2E_MODEL_ROUTE_PARTITION, sk: `E2E_MODEL_ROUTE#${routeId}#REV#${revisionNumber}` });

/**
 * The definition the registry stores for the route revision an admission names (Task 4.4a, ruling DJ): one GetItem by key, held to the revision it was read for. A worker's account of
 * the route it served is never the definition the broker judges a round's receipts against; this is. Null when the revision is not in the registry, or its row is not exactly that
 * revision's (another route id or number, a definition that does not hash to the revision it is filed under). A fault the read can be expected to get past (throttling, a timeout) is
 * tried again up to three times; one that persists, or any other, is thrown, so the caller can tell "not there" from "could not be asked".
 */
export async function readAdmittedE2EModelRoute(read: (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined>, route: { routeId: string; routeRevision: string },
  options: { sleep?: (ms: number) => Promise<void> } = {}): Promise<E2EModelRouteDefinition | null> {
  const revisionNumber = e2eModelRouteRevisionNumber(route.routeRevision);
  if (revisionNumber === null) return null;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let row: Record<string, unknown> | undefined;
  for (let attempt = 1; ; attempt += 1) {
    try { row = await read(e2eModelRouteRevisionKey(route.routeId, revisionNumber)); break; }
    catch (error) { if (attempt >= 3 || !isTransientAwsFault(error)) throw error; await sleep(100 * attempt); }
  }
  if (row === undefined || row["entityType"] !== "E2E_MODEL_ROUTE" || row["routeId"] !== route.routeId || row["revisionNumber"] !== revisionNumber || row["revision"] !== route.routeRevision) return null;
  const parsed = E2EModelRouteDefinitionSchema.safeParse(row["definition"]);
  if (!parsed.success || parsed.data.routeId !== route.routeId || parsed.data.revision !== revisionNumber || e2eModelRouteRevision(parsed.data) !== route.routeRevision) return null;
  return parsed.data;
}

