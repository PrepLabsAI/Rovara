// The records that bind one outside surface (a tracker ticket, a chat thread) to one session, on the document store port. A session has the session's own `BINDING#<kind>` item (in its own partition,
// `sessionBindingKey`) and the reverse `sessionSurfaceKey` item that says which session a surface follows. Each is written only if absent, so a surface follows one session and a session has one binding of
// each kind. The key layout is Cloud's, so one set of rows serves both.
//
// A binding is a routing hint, never authority: whatever arrives through it must still be checked against the acting person's own session level before it steers the agent.
import {
  SessionBindingSchema, SessionIdSchema, agentSessionKey, agentXError, sessionBindingKey, sessionSurfaceKey, when,
  type AgentSessionRecord, type DocumentStore, type OrgId, type SessionBinding, type SessionId, type TransactItem,
} from "@agentx/contracts";
import { SessionStore } from "./store.js";

type Store = Pick<DocumentStore, "get" | "getMany" | "put" | "transact" | "query">;

const NOUN = { slack_thread: "thread", linear_issue: "issue", tracker_item: "ticket" } as const;
const BUSY = "This can't be saved right now. Try again.";
const ATTEMPTS = 3;

/** The surface a stored binding names, or undefined when it doesn't parse. Two bindings are the same surface when their surface items are the same item. */
function surfaceOf(orgId: OrgId, stored: unknown): string | undefined {
  const parsed = SessionBindingSchema.safeParse(stored);
  return parsed.success ? sessionSurfaceKey(orgId, parsed.data).sk : undefined;
}

/**
 * The two items of one binding for a session that is being made in the same transaction (the session's own items are in it, so there is no check that it is there): each written only if absent, so a
 * surface that follows another session refuses the whole transaction.
 */
export function bindingItems(orgId: OrgId, sessionId: SessionId, binding: SessionBinding, at: string): TransactItem[] {
  return bindingItemsForOpenSession(orgId, sessionId, binding, at).slice(1);
}

/** The two items of one binding, each written only if absent, behind a check that the session is in this company and still open. The binding's own items are the last two. */
export function bindingItemsForOpenSession(orgId: OrgId, sessionId: SessionId, binding: SessionBinding, at: string): TransactItem[] {
  const clean = SessionBindingSchema.parse(binding);
  return [
    { kind: "check", key: agentSessionKey(orgId, sessionId, "META"), condition: when.and(when.present(), when.eq("orgId", orgId), when.notExists("endedAt")) },
    { kind: "put", item: { ...sessionBindingKey(orgId, sessionId, clean.kind), entityType: "AGENT_SESSION_BINDING", orgId, sessionId, binding: JSON.parse(JSON.stringify(clean)) as never, at }, condition: when.absent() },
    { kind: "put", item: { ...sessionSurfaceKey(orgId, clean), entityType: "SESSION_SURFACE", orgId, sessionId, kind: clean.kind, at }, condition: when.absent() },
  ];
}

type Diagnosis = "already_bound" | "retry" | Error;

/** What the three items say after a refused binding. Read again, because a refused transaction can also mean that another writer got there first with the same answer. */
async function diagnose(store: Store, orgId: OrgId, sessionId: SessionId, binding: SessionBinding): Promise<Diagnosis> {
  const surface = sessionSurfaceKey(orgId, binding);
  const [meta, own, reverse] = await store.getMany([agentSessionKey(orgId, sessionId, "META"), sessionBindingKey(orgId, sessionId, binding.kind), surface]);
  if (meta === undefined || meta["orgId"] !== orgId) return agentXError("NOT_FOUND", "session not found");
  const ownIsThis = own !== undefined && own["orgId"] === orgId && surfaceOf(orgId, own["binding"]) === surface.sk;
  const reverseIsThis = reverse !== undefined && reverse["orgId"] === orgId && reverse["sessionId"] === sessionId;
  if (ownIsThis && reverseIsThis) return "already_bound";
  if (reverse !== undefined && !reverseIsThis) return agentXError("CONFIG_INVALID", `This ${NOUN[binding.kind]} already follows another session.`);
  if (own !== undefined && !ownIsThis) return agentXError("CONFIG_INVALID", `This session already follows another ${NOUN[binding.kind]}.`);
  if (meta["endedAt"] !== undefined) return agentXError("SESSION_ENDED", "This session has ended.");
  return "retry";
}

/**
 * Binds a ticket (or a chat thread) to a session after the fact. One transaction writes the session's `BINDING#<kind>` and the reverse surface item, each only if absent, behind a check that the session
 * is in this company and still open. "bound" when it wrote them, "already_bound" for a repeat of the same binding. A surface that follows another session, or a second binding of one kind on the session,
 * is `CONFIG_INVALID`; a session of another company or a missing one is `NOT_FOUND` (the same answer for both); an ended one is `SESSION_ENDED`.
 */
export async function bindSessionSurface(
  deps: { store: Store; now: () => number },
  input: { orgId: OrgId; sessionId: SessionId; binding: SessionBinding; /** Items that commit with the binding or not at all; none are written for a repeat. */ extraItems?: TransactItem[] },
): Promise<"bound" | "already_bound"> {
  const parsedBinding = SessionBindingSchema.safeParse(input.binding);
  const parsedId = SessionIdSchema.safeParse(input.sessionId);
  if (!parsedBinding.success || !parsedId.success) throw agentXError("CONFIG_INVALID", "This link can't be bound to a session.");
  const binding = parsedBinding.data;
  const sessionId = parsedId.data;
  const meta = await deps.store.get(agentSessionKey(input.orgId, sessionId, "META"));
  if (meta === undefined || meta["orgId"] !== input.orgId) throw agentXError("NOT_FOUND", "session not found");
  for (let attempt = 1; ; attempt += 1) {
    const at = new Date(deps.now()).toISOString();
    const result = await deps.store.transact([...bindingItemsForOpenSession(input.orgId, sessionId, binding, at), ...(input.extraItems ?? [])]);
    if (result.applied) return "bound";
    const outcome = await diagnose(deps.store, input.orgId, sessionId, binding);
    if (outcome === "already_bound") return outcome;
    if (outcome !== "retry") throw outcome;
    if (attempt >= ATTEMPTS) throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
  }
}

/**
 * The session a surface follows in this company, or undefined (nothing bound, a session that is gone, or two items that disagree). The surface item names the session and the session's own binding must name
 * the surface back, so a stale or tampered item reads as unbound. A read that fails is thrown, never read as "unbound".
 */
export async function sessionForSurface(store: Store, orgId: OrgId, binding: SessionBinding): Promise<AgentSessionRecord | undefined> {
  const parsed = SessionBindingSchema.safeParse(binding);
  if (!parsed.success) return undefined;
  const surface = sessionSurfaceKey(orgId, parsed.data);
  const reverse = await store.get(surface);
  if (reverse === undefined || reverse["orgId"] !== orgId) return undefined;
  const id = SessionIdSchema.safeParse(reverse["sessionId"]);
  if (!id.success) return undefined;
  const session = await new SessionStore(store).get(orgId, id.data);
  if (session === undefined) return undefined;
  const own = await store.get(sessionBindingKey(orgId, id.data, parsed.data.kind));
  return own !== undefined && own["orgId"] === orgId && surfaceOf(orgId, own["binding"]) === surface.sk ? session : undefined;
}

/**
 * Lets go of a session's binding of one kind: the session's own `BINDING#<kind>` item and the reverse surface item are deleted in one transaction, behind a check that the session is in this company and that
 * the binding is still the one that was read. The surface item goes only if it names this session. "unbound" when it deleted them, "not_bound" when the session follows nothing of that kind.
 */
export async function unbindSessionSurface(
  store: Store,
  input: { orgId: OrgId; sessionId: SessionId; kind: SessionBinding["kind"] },
): Promise<{ result: "unbound"; binding: SessionBinding } | { result: "not_bound" }> {
  const parsedId = SessionIdSchema.safeParse(input.sessionId);
  if (!parsedId.success) throw agentXError("CONFIG_INVALID", "This link can't be removed from a session.");
  const sessionId = parsedId.data;
  for (let attempt = 1; ; attempt += 1) {
    const own = await store.get(sessionBindingKey(input.orgId, sessionId, input.kind));
    if (own === undefined || own["orgId"] !== input.orgId) return { result: "not_bound" };
    const parsed = SessionBindingSchema.safeParse(own["binding"]);
    if (!parsed.success || parsed.data.kind !== input.kind) throw agentXError("RUNTIME_UNAVAILABLE", "This link can't be read right now.");
    const binding = parsed.data;
    const surface = sessionSurfaceKey(input.orgId, binding);
    const done = await store.transact([
      { kind: "check", key: agentSessionKey(input.orgId, sessionId, "META"), condition: when.and(when.present(), when.eq("orgId", input.orgId)) },
      { kind: "delete", key: sessionBindingKey(input.orgId, sessionId, input.kind), condition: when.and(when.present(), when.eq("orgId", input.orgId), when.eq("at", own["at"] ?? null)) },
      { kind: "delete", key: surface, condition: when.or(when.absent(), when.and(when.eq("orgId", input.orgId), when.eq("sessionId", sessionId))) },
    ]);
    if (done.applied) return { result: "unbound", binding };
    // Something moved between the read and the write. A binding that is gone was let go by another call; one that is another binding now is not undone, because it is not the one that was read.
    const now = await store.get(sessionBindingKey(input.orgId, sessionId, input.kind));
    if (now === undefined) return { result: "not_bound" };
    if (now["at"] !== own["at"] || now["orgId"] !== input.orgId) throw agentXError("CONFIG_INVALID", "This session's link changed just now. Check it and try again.");
    if (attempt >= ATTEMPTS) throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
  }
}

/** The kinds a session can be bound to, in the order they are reported (a ticket of any tracker last). */
const BINDING_KINDS = ["slack_thread", "linear_issue", "tracker_item"] as const;

/**
 * The session's bindings in this company: its chat thread, then its Linear issue, then its ticket, whichever it has. A session id that is not one, or no session, has none. A read that fails is thrown (never read
 * as "no binding"), so a caller that must not lose a binding (the merged milestone) stops instead of going on without it.
 */
export async function sessionBindingsOf(store: Pick<DocumentStore, "getMany">, orgId: OrgId, sessionId: string | undefined): Promise<SessionBinding[]> {
  const id = SessionIdSchema.safeParse(sessionId);
  if (!id.success) return [];
  const rows = await store.getMany(BINDING_KINDS.map((kind) => sessionBindingKey(orgId, id.data, kind)));
  const found: SessionBinding[] = [];
  rows.forEach((item, index) => {
    if (item === undefined || item["orgId"] !== orgId) return;
    const parsed = SessionBindingSchema.safeParse(item["binding"]);
    if (parsed.success && parsed.data.kind === BINDING_KINDS[index]) found.push(parsed.data);
  });
  return found;
}
