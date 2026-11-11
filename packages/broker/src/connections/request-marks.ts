// The request item that makes a write repeatable (the same rule as the hosted product's: a request's id and a fingerprint of what it asked). The item is written in the SAME transaction as the
// change it belongs to and holds what the change returned, so a repeat of the request is answered from it and writes nothing. It is kept for a week and then expires.
import { INDEX_EXPIRY_ATTRIBUTE, agentRequestKey, agentXError, when, type DocumentStore, type JsonValue, type OrgId, type TransactItem } from "@agentx/contracts";

/** How long a request item answers a repeat; a repeat later is a new request. */
export const REQUEST_MEMORY_DAYS = 7;

export interface RequestMark {
  orgId: OrgId;
  developerId: string;
  requestId: string;
  fingerprint: string;
  /** Overrides what is remembered, for a write that returns nothing itself. */
  result?: unknown;
}

export interface MarkDeps {
  store: DocumentStore;
  now: () => number;
}

/** The request's own step: a put that succeeds only when no live item of this id exists (an expired one the store has not swept yet counts as gone). */
export function requestMarkStep(deps: MarkDeps, request: RequestMark, result?: unknown): TransactItem {
  const remembered = JSON.parse(JSON.stringify(request.result ?? result ?? null)) as JsonValue;
  const seconds = Math.floor(deps.now() / 1000);
  return {
    kind: "put",
    item: { ...agentRequestKey(request.orgId, request.developerId, request.requestId), entityType: "AGENT_REQUEST", fingerprint: request.fingerprint, result: remembered, at: new Date(deps.now()).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: seconds + REQUEST_MEMORY_DAYS * 86_400 },
    condition: when.or(when.absent(), when.lte(INDEX_EXPIRY_ATTRIBUTE, seconds)),
  };
}

/** What an earlier request of this developer's with this id did, or undefined when it did nothing or its item has expired. */
export async function readRequestMark(deps: MarkDeps, orgId: OrgId, developerId: string, requestId: string): Promise<{ fingerprint: string; result: unknown } | undefined> {
  const earlier = await deps.store.get(agentRequestKey(orgId, developerId, requestId));
  const expires = earlier?.[INDEX_EXPIRY_ATTRIBUTE];
  if (earlier === undefined || (typeof expires === "number" && expires <= Math.floor(deps.now() / 1000))) return undefined;
  const fingerprint = earlier["fingerprint"];
  return { fingerprint: typeof fingerprint === "string" ? fingerprint : "", result: earlier["result"] };
}

/**
 * One transaction. A refused condition becomes the error `refuse` picks from the indexes that failed; the request's own step failing is a reused request id. With `request`, its item is added
 * as the last step: the mark is written with the change or not at all.
 */
export async function commitWithMark(
  deps: MarkDeps, items: readonly TransactItem[], refuse: (failed: ReadonlySet<number>) => Error | undefined, request?: RequestMark, result?: unknown,
): Promise<void> {
  const at = items.length;
  const steps = request === undefined ? items : [...items, requestMarkStep(deps, request, result)];
  const done = await deps.store.transact(steps);
  if (done.applied) return;
  const failed = new Set(done.failed);
  if (request !== undefined && failed.has(at)) throw agentXError("IDEMPOTENCY_CONFLICT", "This request ID is already being used for another change.");
  throw refuse(failed) ?? agentXError("CHANGE_STALE", "that changed while you were saving it; try again");
}
