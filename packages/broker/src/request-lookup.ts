import { AgentXError, agentXError } from "@agentx/contracts";
import { RequestIndexIntegrityError } from "./operations.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const REQUEST_LOOKUP_PATH = new RegExp(`^/v1/workspaces/(${UUID})/requests/(${UUID})$`, "i");

export interface RequestLookupPath {
  workspaceId: string;
  requestId: string;
}

/**
 * Match `GET /v1/workspaces/{workspaceId}/requests/{requestId}`.
 *
 * Both path fields must be well-formed UUIDs. A malformed path simply does not match the
 * route, so it can never reach storage or authorization with an attacker-chosen key.
 *
 * The identifiers are returned exactly as received. Task acceptance stores `requestId`
 * verbatim and keys its index on that exact string, both in the in-memory store and in the
 * AWS `REQUEST#<requestId>` sort key, so case-folding here would look up a key acceptance
 * never wrote. Two spellings of one UUID are therefore two distinct request identities at
 * every layer; folding in one place only would rewrite a stored identity and lose the
 * operation the caller is trying to recover.
 */
export function parseRequestLookupPath(pathname: string): RequestLookupPath | undefined {
  const match = REQUEST_LOOKUP_PATH.exec(pathname);
  if (!match?.[1] || !match[2]) return undefined;
  return { workspaceId: match[1], requestId: match[2] };
}

/**
 * Translate a failure raised while reading the request index into a safe wire error.
 *
 * Authorization and absence decisions already made as an `AgentXError` pass through
 * unchanged. Everything else — a dangling or corrupt index, a storage driver fault — becomes
 * one fixed server/storage error. It is never NOT_FOUND, because "we could not read the
 * index" must not be reported as "this request was never accepted", and it never carries the
 * underlying message or a stored row outward.
 */
export function requestLookupFailure(error: unknown): AgentXError {
  if (error instanceof AgentXError) return error;
  if (error instanceof RequestIndexIntegrityError) {
    return agentXError("RUNTIME_UNAVAILABLE", "request index is unavailable");
  }
  return agentXError("RUNTIME_UNAVAILABLE", "request lookup storage is unavailable");
}
