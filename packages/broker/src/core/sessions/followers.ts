// Following a session and seeing who is looking at it now (the hosted product's `agent-sessions/followers.ts`, written on the document store). The keys and the rules are the hosted product's, so
// a company's members adapter, or a Cloud install later, finds what a laptop wrote.
//
// A follow is a `FOLLOWER#<developerId>` item on the session's partition and a `followerCount` change on its META, written in one transaction, so the count never drifts from the items by a crash between two writes. Following is
// idempotent (a second follow writes nothing), at most `SESSION_FOLLOWERS_MAX`, and needs `view`. The session's owner follows without an item: they hear of everything already, so a follow would only double the count (on a Code
// install there is one person, and it is the owner: every follow answers `following: true` and writes nothing, until an adapter brings more people).
//
// A heartbeat puts `PRESENCE#<developerId>`, trusted for `PRESENCE_TTL_SECONDS` and checked on read (the store's expiry lags). Presence never goes to anyone's changes feed: it is not a thing to catch up on.
import {
  INDEX_EXPIRY_ATTRIBUTE, PRESENCE_TTL_SECONDS, PRESENCE_VIEWERS_MAX, SESSION_FOLLOWERS_MAX, SESSION_RETENTION_DAYS, SessionOwnerSchema, agentSessionKey, agentXError, change, cleanSessionName, livePresenceKey, when,
  type AgentSessionRecord, type DocumentStore, type OrgId, type Principal, type SessionId, type SessionLevel, type SessionOwner, type TransactItem,
} from "@agentx/contracts";
import { developerIdOf } from "./create.js";
import { SessionStore } from "./store.js";

const FOLLOWER_PREFIX = "FOLLOWER#";
const PRESENCE_PREFIX = "PRESENCE#";
const DAY_SECONDS = 86_400;
/** The most presence items one read looks at. */
const PRESENCE_SCAN_MAX = 500;
export const TOO_MANY_FOLLOWERS = "This session has the most followers it can have.";

export interface FollowerDependencies {
  store: DocumentStore;
  /** The person's level on the session. Default: the company's owner has `edit` (and owns the session when it is theirs), anyone else `none`, which reads as a missing session. */
  level?: ((principal: Principal, session: AgentSessionRecord) => Promise<SessionLevel | "none"> | SessionLevel | "none") | undefined;
  now?: () => Date;
}

const followerKey = (session: { orgId: OrgId; sessionId: string }, developerId: string) => agentSessionKey(session.orgId, session.sessionId, `${FOLLOWER_PREFIX}${developerId}`);

/** What an item written for an ended session expires with: its own record, a year after it ended. Undefined for an open session. */
const endedExpiry = (session: AgentSessionRecord): number | undefined => (session.endedAt === undefined ? undefined : Math.floor(Date.parse(session.endedAt) / 1000) + SESSION_RETENTION_DAYS * DAY_SECONDS);

/** The session the person may view, and whether they own it; a session they may not view reads as missing. */
async function viewable(deps: FollowerDependencies, principal: Principal, orgId: OrgId, sessionId: SessionId): Promise<{ session: AgentSessionRecord; owner: boolean }> {
  const missing = agentXError("NOT_FOUND", "There is no such session.");
  if (principal.companyId !== orgId) throw missing;
  const session = await new SessionStore(deps.store).get(orgId, sessionId);
  if (session === undefined) throw missing;
  const level = deps.level === undefined ? (principal.roles.includes("owner") ? "edit" : "none") : await deps.level(principal, session);
  if (level === "none") throw missing;
  return { session, owner: session.owner.developerId === developerIdOf(principal) };
}

/** `POST /v1/app/sessions/<id>/follow` (needs `view`). Writes the follower item and counts it in one transaction. A person who follows already (an item, or the owner): nothing is written. At `SESSION_FOLLOWERS_MAX` it is refused. */
export async function followSession(deps: FollowerDependencies, principal: Principal, orgId: OrgId, sessionId: SessionId): Promise<{ following: boolean }> {
  const { session, owner } = await viewable(deps, principal, orgId, sessionId);
  if (owner) return { following: true };
  const developerId = developerIdOf(principal);
  const key = followerKey(session, developerId);
  if (await deps.store.get(key) !== undefined) return { following: true };
  const expiry = endedExpiry(session);
  const items: TransactItem[] = [
    { kind: "put", item: { ...key, entityType: "AGENT_SESSION_FOLLOWER", orgId: session.orgId, sessionId: session.sessionId, developerId, ...(expiry === undefined ? {} : { [INDEX_EXPIRY_ATTRIBUTE]: expiry }) }, condition: when.absent() },
    { kind: "update", key: agentSessionKey(session.orgId, session.sessionId, "META"), ops: [change.add("followerCount", 1)], condition: when.lt("followerCount", SESSION_FOLLOWERS_MAX) },
  ];
  const result = await deps.store.transact(items);
  if (result.applied) return { following: true };
  // Read it again before deciding: a lost race with the same person's other request means they follow, which is what was asked.
  if (await deps.store.get(key) !== undefined) return { following: true };
  if (result.failed.includes(1)) throw agentXError("CONFIG_INVALID", TOO_MANY_FOLLOWERS);
  throw agentXError("RUNTIME_UNAVAILABLE", "This session is busy right now. Try again in a moment.");
}

/** `DELETE /v1/app/sessions/<id>/follow`. The follow goes and the count drops. Not following writes nothing. The owner always follows: the answer says so. */
export async function unfollowSession(deps: FollowerDependencies, principal: Principal, orgId: OrgId, sessionId: SessionId): Promise<{ following: boolean }> {
  const { session, owner } = await viewable(deps, principal, orgId, sessionId);
  if (owner) return { following: true };
  await removeFollower(deps.store, session, developerIdOf(principal));
  return { following: false };
}

/**
 * Removes one person's follow and takes it off the session's count, in one transaction; true when it removed one. A count that has drifted to zero (or a session record that is gone) never keeps the follow: the item is then
 * deleted alone, and the count is never taken below zero.
 */
export async function removeFollower(store: DocumentStore, session: { orgId: OrgId; sessionId: string }, developerId: string): Promise<boolean> {
  const key = followerKey(session, developerId);
  if (await store.get(key) === undefined) return false;
  const result = await store.transact([
    { kind: "delete", key, condition: when.present() },
    { kind: "update", key: agentSessionKey(session.orgId, session.sessionId, "META"), ops: [change.add("followerCount", -1)], condition: when.gt("followerCount", 0) },
  ]);
  if (result.applied) return true;
  // The follow itself is gone (another request removed it): nothing is left to remove. Only a refused count with the follow still there is a drifted count.
  if (result.failed.includes(0)) return false;
  return (await store.delete({ key, condition: when.present() })).applied;
}

/** Whether a heartbeat at `at` still counts at `nowMs`: the store deletes late, so every reader checks the time itself. A time that does not read is NaN, and no comparison with NaN holds. */
export const presenceIsFresh = (at: unknown, nowMs: number): boolean => typeof at === "string" && nowMs - Date.parse(at) < PRESENCE_TTL_SECONDS * 1000;

/** The people looking at the session now: the presence items whose heartbeat is newer than `PRESENCE_TTL_SECONDS`, at most `PRESENCE_VIEWERS_MAX`, in name order. An item whose person or name does not read is left out. */
export async function viewingNow(store: Pick<DocumentStore, "query">, session: { orgId: OrgId; sessionId: string }, nowMs: number): Promise<SessionOwner[]> {
  const here: SessionOwner[] = [];
  let scanned = 0;
  let cursor: string | undefined;
  do {
    const page = await store.query({ pk: agentSessionKey(session.orgId, session.sessionId, "META").pk, sk: { op: "beginsWith", prefix: PRESENCE_PREFIX }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      scanned += 1;
      if (!presenceIsFresh(item["at"], nowMs)) continue;
      const person = SessionOwnerSchema.safeParse({ developerId: item["developerId"], name: item["name"] });
      if (person.success) here.push(person.data);
    }
    cursor = page.cursor;
  } while (cursor !== undefined && scanned < PRESENCE_SCAN_MAX);
  here.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.developerId < b.developerId ? -1 : a.developerId > b.developerId ? 1 : 0));
  return here.slice(0, PRESENCE_VIEWERS_MAX);
}

/**
 * `POST /v1/app/sessions/<id>/presence` (needs `view`): the caller's heartbeat. Puts their presence item (expiring `PRESENCE_TTL_SECONDS` on) and the same heartbeat in the company's presence index (the Live wall reads it in one
 * query). Answers who is looking now, this heartbeat included.
 */
export async function recordPresence(deps: FollowerDependencies, principal: Principal, orgId: OrgId, sessionId: SessionId): Promise<{ viewingNow: SessionOwner[] }> {
  const { session } = await viewable(deps, principal, orgId, sessionId);
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const developerId = developerIdOf(principal);
  const fields = { orgId: session.orgId, sessionId: session.sessionId, developerId, name: cleanSessionName(principal.displayName) ?? "a member", at: new Date(nowMs).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + PRESENCE_TTL_SECONDS };
  await deps.store.put({ item: { ...agentSessionKey(session.orgId, session.sessionId, `${PRESENCE_PREFIX}${developerId}`), entityType: "AGENT_SESSION_PRESENCE", ...fields } });
  // The index only shows who is looking, so a write that fails never fails the heartbeat.
  await deps.store.put({ item: { ...livePresenceKey(session.orgId, session.sessionId, developerId), entityType: "LIVE_PRESENCE", ...fields } }).catch(() => undefined);
  return { viewingNow: await viewingNow(deps.store, session, nowMs) };
}
