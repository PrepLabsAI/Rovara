// The session store (lane L6b, inventory B6): a session's header, its event log and the lists that find it, on the document store port. Every key is built from the company the caller checked; a
// session of another company reads as absent. The key layout is the hosted product's (`agentSessionKey` and friends in the contracts), so one set of rows serves both.
import {
  AgentSessionRecordSchema, INDEX_EXPIRY_ATTRIBUTE, SESSION_EVENT_TEXT_MAX, SESSION_RETENTION_DAYS, SessionEventSchema, agentSessionKey, redactText, sessionEventSk, when,
  type AgentSessionRecord, type DocumentStore, type OrgId, type SessionEvent, type SessionId, type StoredDocument, type TransactItem,
} from "@agentx/contracts";

/** What names a session when an item is written for it. */
export interface SessionRef {
  orgId: OrgId;
  sessionId: SessionId;
}

/** The part of a task a session lookup reads. */
export interface SessionTaskRef {
  taskId: string;
  orgId?: OrgId | undefined;
  sessionId?: string | undefined;
}

const SECONDS_PER_DAY = 86_400;

/**
 * Text kept in an event: redacted first (so the cut can't leave half a token), control characters other than line breaks replaced, and cut
 * to the event limit by characters.
 */
export function eventText(text: string): string {
  const clean = redactText(text).replace(/(?![\n\t\r])\p{Cc}/gu, " ");
  return [...clean].slice(0, SESSION_EVENT_TEXT_MAX).join("");
}

/**
 * The write of one event: `EVENT#<at>#<eventId>`, written only if absent. There is no counter, so it never conflicts with another writer, and an event with the same id (a retry) is the same item.
 * It expires `SESSION_RETENTION_DAYS` after `at`.
 */
export function sessionEventItem(session: SessionRef, event: SessionEvent): TransactItem {
  const clean = SessionEventSchema.parse({ ...event, text: eventText(event.text) });
  return {
    kind: "put",
    item: {
      ...agentSessionKey(session.orgId, session.sessionId, sessionEventSk(clean.at, clean.eventId)), entityType: "AGENT_SESSION_EVENT", orgId: session.orgId, sessionId: session.sessionId,
      ...(JSON.parse(JSON.stringify(clean)) as Record<string, never>), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(clean.at) / 1000) + SESSION_RETENTION_DAYS * SECONDS_PER_DAY,
    },
    condition: when.absent(),
  };
}

const HOUSEKEEPING = new Set(["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE]);

/** A session's META document as a record, or undefined when it doesn't parse. */
export function sessionFromDocument(document: StoredDocument): AgentSessionRecord | undefined {
  const parsed = AgentSessionRecordSchema.safeParse(Object.fromEntries(Object.entries(document).filter(([key]) => !HOUSEKEEPING.has(key))));
  return parsed.success ? parsed.data : undefined;
}

/** Plain JSON of a record, for a write (the schema may leave `undefined` keys that the store refuses). */
export const jsonOf = (value: unknown): StoredDocument & Record<string, never> => JSON.parse(JSON.stringify(value)) as StoredDocument & Record<string, never>;

export class SessionStore {
  constructor(private readonly store: Pick<DocumentStore, "get" | "put" | "query">) {}

  /** A session of this company, or undefined. A record that doesn't parse is an error, never read as it is. */
  async get(orgId: OrgId, sessionId: SessionId): Promise<AgentSessionRecord | undefined> {
    const document = await this.store.get(agentSessionKey(orgId, sessionId, "META"));
    if (document === undefined || document["orgId"] !== orgId) return undefined;
    const record = sessionFromDocument(document);
    if (record === undefined) throw new Error("This session can't be read right now.");
    return record;
  }

  /** The session a task belongs to: the one its record names. Undefined for a task of another company, a task with no session, and a session whose subject isn't this task. */
  async getForTask(orgId: OrgId, task: SessionTaskRef): Promise<AgentSessionRecord | undefined> {
    if (task.orgId !== orgId || task.sessionId === undefined) return undefined;
    const session = await this.get(orgId, task.sessionId);
    return session?.subject.kind === "task" && session.subject.taskId === task.taskId ? session : undefined;
  }

  /** Writes one event on its own, as one conditional put. An event that is already there is "exists", not an error. */
  async appendEvent(orgId: OrgId, sessionId: SessionId, event: SessionEvent): Promise<"appended" | "exists"> {
    const item = sessionEventItem({ orgId, sessionId }, event);
    if (item.kind !== "put") throw new Error("an event is a put");
    const result = await this.store.put({ item: item.item, ...(item.condition === undefined ? {} : { condition: item.condition }) });
    return result.applied ? "appended" : "exists";
  }
}
