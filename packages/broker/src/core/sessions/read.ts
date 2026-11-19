// Reading sessions (lane L6b, inventory B6): a person's list, one session's header with the words every surface says, and the event log. The full `SessionView` of the contracts carries the task's own page view
// (`DeveloperTaskView`), which the task flow owns; the surfaces build it from `sessionSnapshot` and the task flow's view.
import {
  SESSION_EVENTS_PAGE_MAX, SessionEventSchema, agentSessionKey, hideEmailAddresses, mySessionsKey, sessionTaskStatus, taskStatusNext, taskStatusText,
  type AgentSessionRecord, type DocumentStore, type OrgId, type SessionEvent, type SessionEventPage, type SessionId, type TaskStatus,
} from "@agentx/contracts";
import { sessionFromDocument } from "./store.js";

export interface SessionSnapshot {
  sessionId: string;
  title: string;
  project?: string | undefined;
  status: AgentSessionRecord["summary"]["status"];
  /** The one status model's state, word and next step. */
  state: TaskStatus["state"];
  statusText: string;
  next?: string | undefined;
  step?: string | undefined;
  /** Cost so far in dollars; absent when the cost is not in dollars. */
  costUsd: number;
  runLimitUsd?: number | undefined;
  needsYou: boolean;
  open: boolean;
  /** What the owner can do now. */
  actions: Array<"watch" | "steer" | "stop" | "retry">;
  createdAt: string;
  updatedAt: string;
  endedAt?: string | undefined;
}

/** A session as every surface says it. The owner reads it (a Code install has one), so the owner's words are used. */
export function sessionSnapshot(session: AgentSessionRecord): SessionSnapshot {
  const status = sessionTaskStatus(session.summary);
  const open = session.endedAt === undefined;
  return {
    sessionId: session.sessionId, title: session.title, ...(session.project === undefined ? {} : { project: session.project }), status: session.summary.status, state: status.state,
    statusText: taskStatusText(status), ...(taskStatusNext(status, true) === undefined ? {} : { next: taskStatusNext(status, true) }), ...(session.summary.step === undefined ? {} : { step: session.summary.step }),
    costUsd: session.summary.costUsd, ...(session.summary.runLimitUsd === undefined ? {} : { runLimitUsd: session.summary.runLimitUsd }),
    needsYou: open && (status.state === "needs_you" || status.state === "paused_budget" || status.state === "ready_to_merge" || status.state === "failed"),
    open, actions: !open ? ["watch"] : ["watch", "steer", "stop", ...(session.summary.workflowBlocked === true ? ["retry" as const] : [])],
    createdAt: session.createdAt, updatedAt: session.updatedAt, ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
  };
}

export type SessionFilter = "all" | "open" | "needs_me" | "failed";

/** The newest sessions of a person (their `MY_SESSIONS` list, newest first), with a cursor for the next page. A session that cannot be read is left out. */
export async function listSessions(
  store: Pick<DocumentStore, "query" | "getMany">, orgId: OrgId, developerId: string, options: { filter?: SessionFilter; limit?: number; cursor?: string } = {},
): Promise<{ sessions: AgentSessionRecord[]; cursor?: string }> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const filter = options.filter ?? "all";
  const found: AgentSessionRecord[] = [];
  let cursor = options.cursor;
  const pk = mySessionsKey(orgId, developerId, "2000-01-01T00:00:00.000Z", "x").pk;
  // A filter drops sessions after they are read, so read on until the page is full or the list ends.
  for (let reads = 0; reads < 20 && found.length < limit; reads += 1) {
    const page = await store.query({ pk, descending: true, limit: Math.min(limit * 2, 100), ...(cursor === undefined ? {} : { cursor }) });
    const ids = page.items.flatMap((item) => (typeof item["sessionId"] === "string" ? [item["sessionId"]] : []));
    const documents = ids.length === 0 ? [] : await store.getMany(ids.map((sessionId) => agentSessionKey(orgId, sessionId, "META")));
    for (const document of documents) {
      const session = document === undefined || document["orgId"] !== orgId ? undefined : sessionFromDocument(document);
      if (session === undefined || session.owner.developerId !== developerId) continue;
      const snapshot = sessionSnapshot(session);
      if (filter === "open" && !snapshot.open) continue;
      if (filter === "needs_me" && !snapshot.needsYou) continue;
      if (filter === "failed" && snapshot.state !== "failed") continue;
      found.push(session);
      if (found.length >= limit) break;
    }
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  return { sessions: found, ...(cursor === undefined ? {} : { cursor }) };
}

// ---- the event log

/** Events are read again from this long before the cursor, so one written late with an earlier time is still seen. */
const REREAD_MS = 5_000;
/** At most this many re-read events go in a page; the rest of the page is new events, so a page always moves forward. */
const REREAD_MAX = 100;
/** Rows looked at (expired ones included) before a page gives up and hands back a cursor. */
const SCAN_MAX = 1_000;
const SK_PREFIX = "EVENT#";
const SK_LAST = `${SK_PREFIX}9999-12-31T23:59:59.999Z#evt_ffffffffffffffffffffffff`;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#(evt_[0-9a-f]{24})$/;
const HOUSEKEEPING = new Set(["pk", "sk", "entityType", "orgId", "sessionId", "indexExpiresAt"]);

function parseCursor(after: string | undefined): { at: string; sk: string } | undefined {
  if (after === undefined) return undefined;
  const match = CURSOR.exec(after);
  const ms = match === null ? Number.NaN : Date.parse(match[1]!);
  if (match === null || Number.isNaN(ms) || new Date(ms).toISOString() !== match[1]) throw new Error("after: is not a cursor this log gave");
  return { at: match[1], sk: `${SK_PREFIX}${after}` };
}

function eventOf(item: Record<string, unknown>, orgId: string, sessionId: string, nowSeconds: number): SessionEvent | undefined {
  if (item["orgId"] !== orgId || item["sessionId"] !== sessionId) return undefined;
  const expires = item["indexExpiresAt"];
  // The store may not have swept an expired event yet.
  if (typeof expires === "number" && expires <= nowSeconds) return undefined;
  const parsed = SessionEventSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !HOUSEKEEPING.has(key))));
  return parsed.success ? { ...parsed.data, text: hideEmailAddresses(parsed.data.text) } : undefined;
}

/**
 * One page of a session's timeline, oldest first (by time, then id). With a cursor (`<at>#<eventId>`, the last event of the previous page) it re-reads the five seconds before it (at most
 * `REREAD_MAX` events, never the cursor's own) and then goes on; readers de-duplicate by `eventId`. An event whose expiry has passed is not returned.
 */
export async function readSessionEvents(store: Pick<DocumentStore, "query">, orgId: OrgId, sessionId: SessionId, query: { after?: string | undefined } = {}, nowMs: number = Date.now()): Promise<SessionEventPage> {
  const cursor = parseCursor(query.after);
  const pk = agentSessionKey(orgId, sessionId, "META").pk;
  const nowSeconds = Math.floor(nowMs / 1000);
  const events = new Map<string, SessionEvent>();
  if (cursor !== undefined) {
    const low = `${SK_PREFIX}${new Date(Date.parse(cursor.at) - REREAD_MS).toISOString()}#`;
    const behind = await store.query({ pk, sk: { op: "between", low, high: cursor.sk }, descending: true, limit: REREAD_MAX + 1 });
    const reread: SessionEvent[] = [];
    for (const item of behind.items) {
      if (item.sk === cursor.sk) continue;
      const event = eventOf(item, orgId, sessionId, nowSeconds);
      if (event !== undefined && reread.length < REREAD_MAX) reread.push(event);
    }
    for (const event of reread.reverse()) events.set(event.eventId, event);
  }
  const room = SESSION_EVENTS_PAGE_MAX - events.size;
  let kept = 0;
  let scanned = 0;
  let lastSk: string | undefined;
  let pageCursor: string | undefined;
  scan: for (;;) {
    const page = await store.query({ pk, sk: { op: "between", low: cursor?.sk ?? SK_PREFIX, high: SK_LAST }, limit: SESSION_EVENTS_PAGE_MAX, ...(pageCursor === undefined ? {} : { cursor: pageCursor }) });
    for (const item of page.items) {
      if (item.sk === cursor?.sk) continue;
      if (kept >= room || scanned >= SCAN_MAX) break scan;
      scanned += 1;
      lastSk = item.sk;
      const event = eventOf(item, orgId, sessionId, nowSeconds);
      if (event === undefined) continue;
      events.set(event.eventId, event);
      kept += 1;
    }
    pageCursor = page.cursor;
    if (pageCursor === undefined) break;
  }
  const next = lastSk !== undefined ? lastSk.slice(SK_PREFIX.length) : query.after;
  return { events: [...events.values()], ...(next === undefined ? {} : { next }) };
}

