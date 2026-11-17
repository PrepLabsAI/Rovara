// The in-app inbox (web task channel C7): what waits for one person, newest first, read from the rows `queueAttention` keeps for them (`inbox-rows.ts`).
//
// A row is never shown on its own say-so. Each one is checked again against the session now: the person's company is the caller's (a row of another company, or one that is not theirs, is skipped), the session
// still exists and is a task, it still stands in the state the row was written for, and the person may still READ it (`access`, the session level read live). A person who lost access, a task that moved on, or a
// session that went reads as nothing: no title, no count, no hint that a row exists. What is shown is what a message would hold: the task's title, its status sentence (fixed words) and its link. No task
// content beyond that. The read marks only the caller's own rows (the key is built from the caller's company and person, never from the request).
import { INDEX_EXPIRY_ATTRIBUTE, SessionIdSchema, agentXError, change, hideEmailAddresses, sessionTaskStatus, taskStatusText, when, type AgentSessionRecord, type DocumentStore, type StoredDocument } from "@agentx/contracts";
import { SessionStore } from "../sessions/store.js";
import { attentionKindOf, oneLine } from "./attention.js";
import { inboxIdOf, inboxKey, inboxPartition, isInboxKind, parseInboxId, type InboxKind } from "./inbox-rows.js";

export const INBOX_PAGE_DEFAULT = 20;
export const INBOX_PAGE_MAX = 50;
/** The most ids one read mark takes. */
export const INBOX_READ_IDS_MAX = 50;
/** The most rows read for one person in one request (a person's rows are one per session and kind, kept for 14 days). */
export const INBOX_ROWS_MAX = 300;
/** The most rows checked against their sessions in one request. */
export const INBOX_CHECK_MAX = 100;
const TITLE_MAX = 100;
const ROWS_PAGE = 100;

export const INBOX_BAD_CURSOR = "That page marker is not valid.";
export const INBOX_BAD_LIMIT = `The page size must be a whole number from 1 to ${String(INBOX_PAGE_MAX)}.`;
export const INBOX_BAD_READ = `Send { requestId, ids } with 1 to ${String(INBOX_READ_IDS_MAX)} inbox ids.`;

export interface InboxItem {
  id: string;
  sessionId: string;
  kind: InboxKind;
  title: string;
  status: string;
  link: string;
  /** When the change happened (an ISO time). */
  at: string;
  read: boolean;
}
export interface InboxPage {
  items: InboxItem[];
  /** Present when more may follow; send it back as `cursor`. */
  nextCursor?: string;
  /** First page only: how many of the newest checked rows are unread (at most `INBOX_CHECK_MAX` rows are checked, so it never exceeds that). */
  unread?: number;
}

export interface InboxDeps {
  store: Pick<DocumentStore, "get" | "put" | "query" | "update">;
  /** Whether the person may READ the session now (their level, read live); undefined or a throw: no. */
  access: (session: AgentSessionRecord) => Promise<{ owner: boolean } | undefined>;
  /** The address of a session's page. */
  link: (sessionId: string) => string;
  now: () => number;
}
/** The caller: their company is the live membership's, their id the verified person's. */
export interface InboxPerson { companyId: string; developerId: string }

interface Row { sessionId: string; kind: InboxKind; at: string; atMs: number; read: boolean; sk: string }

function rowOf(item: StoredDocument, who: InboxPerson, nowSeconds: number): Row | undefined {
  const { orgId, developerId, sessionId, kind, at, atMs, sk } = item;
  if (orgId !== who.companyId || developerId !== who.developerId || typeof sessionId !== "string" || !isInboxKind(kind) || typeof at !== "string" || typeof atMs !== "number" || !Number.isSafeInteger(atMs)) return undefined;
  if (!SessionIdSchema.safeParse(sessionId).success || sk !== `${sessionId}#${kind}`) return undefined;
  const expires = item[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires <= nowSeconds) return undefined;
  return { sessionId, kind, at, atMs, read: typeof item["readAt"] === "number", sk };
}

/** Newest first; rows of one time by their sort key, newest-named first. */
const NEWER_FIRST = (a: Pick<Row, "atMs" | "sk">, b: Pick<Row, "atMs" | "sk">): number => (a.atMs !== b.atMs ? b.atMs - a.atMs : a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0);

const encodeCursor = (row: Row): string => Buffer.from(JSON.stringify([row.atMs, row.sk]), "utf8").toString("base64url");
function decodeCursor(cursor: string): { atMs: number; sk: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && Number.isSafeInteger(value[0]) && typeof value[1] === "string" && value[1].length <= 100) return { atMs: value[0], sk: value[1] };
  } catch { /* not a cursor */ }
  throw agentXError("CONFIG_INVALID", INBOX_BAD_CURSOR);
}

async function rowsOf(deps: InboxDeps, who: InboxPerson): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  const nowSeconds = Math.floor(deps.now() / 1000);
  do {
    const page = await deps.store.query({ pk: inboxPartition(who.companyId, who.developerId), limit: ROWS_PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      const row = rowOf(item, who, nowSeconds);
      if (row !== undefined) rows.push(row);
    }
    cursor = page.cursor;
  } while (cursor !== undefined && rows.length < INBOX_ROWS_MAX);
  return rows.sort(NEWER_FIRST).slice(0, INBOX_ROWS_MAX);
}

/** The item for a row if it still holds against its session now; otherwise undefined (shown as nothing). */
async function checked(deps: InboxDeps, sessions: SessionStore, who: InboxPerson, row: Row): Promise<InboxItem | undefined> {
  const session = await sessions.get(who.companyId, row.sessionId).catch(() => undefined);
  if (session === undefined || session.orgId !== who.companyId || session.subject.kind !== "task") return undefined;
  const access = await deps.access(session).catch(() => undefined);
  if (access === undefined) return undefined;
  const kind = attentionKindOf(session.summary);
  if (kind !== row.kind || (session.endedAt !== undefined && kind !== "done" && kind !== "failed")) return undefined;
  return {
    id: inboxIdOf(row), sessionId: row.sessionId, kind, at: row.at, read: row.read, link: deps.link(row.sessionId),
    title: oneLine(access.owner ? session.title : hideEmailAddresses(session.title), TITLE_MAX) || "A task",
    status: oneLine(taskStatusText(sessionTaskStatus(session.summary)), 200),
  };
}

/** One page of the person's inbox, newest first. A page size outside 1..50 or a cursor that is not one this function made is a fixed refusal. */
export async function listInbox(deps: InboxDeps, who: InboxPerson, input: { limit?: number | undefined; cursor?: string | undefined } = {}): Promise<InboxPage> {
  const limit = input.limit ?? INBOX_PAGE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > INBOX_PAGE_MAX) throw agentXError("CONFIG_INVALID", INBOX_BAD_LIMIT);
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  const all = await rowsOf(deps, who);
  let index = after === undefined ? 0 : all.findIndex((row) => NEWER_FIRST(row, after) > 0);
  if (index < 0) index = all.length;
  const sessions = new SessionStore(deps.store);
  const first = after === undefined;
  const found: Array<{ row: Row; item: InboxItem }> = [];
  let examined = 0;
  let last: Row | undefined;
  // The first page keeps checking up to the budget, so the unread count covers the newest rows; later pages stop as soon as one more than the page is found.
  while (index < all.length && examined < INBOX_CHECK_MAX && (first || found.length <= limit)) {
    const row = all[index]!;
    index += 1;
    examined += 1;
    last = row;
    const item = await checked(deps, sessions, who, row);
    if (item !== undefined) found.push({ row, item });
  }
  const page = found.slice(0, limit);
  const more = found.length > limit;
  const cursorRow = more ? page[page.length - 1]!.row : index < all.length ? last : undefined;
  return {
    items: page.map((entry) => entry.item),
    ...(cursorRow === undefined ? {} : { nextCursor: encodeCursor(cursorRow) }),
    ...(first ? { unread: found.filter((entry) => !entry.item.read).length } : {}),
  };
}

/**
 * Marks the person's own rows read: `ids` are rows (`inboxIdOf`), each looked up under the caller's own company and person, and only when the row still has the time the id names (a row that changed since it
 * was shown stays unread). An id that is not shaped like one refuses the whole call; an id with no row is skipped. Answers how many rows were marked.
 */
export async function markInboxRead(deps: Pick<InboxDeps, "store" | "now">, who: InboxPerson, ids: readonly unknown[]): Promise<number> {
  if (ids.length < 1 || ids.length > INBOX_READ_IDS_MAX) throw agentXError("CONFIG_INVALID", INBOX_BAD_READ);
  const parsed = ids.map((id) => parseInboxId(id));
  if (parsed.some((entry) => entry === undefined)) throw agentXError("CONFIG_INVALID", INBOX_BAD_READ);
  let marked = 0;
  for (const entry of new Map(parsed.map((one) => [`${one!.sessionId}.${one!.kind}.${String(one!.atMs)}`, one!])).values()) {
    const result = await deps.store.update({
      key: inboxKey(who.companyId, who.developerId, entry.sessionId, entry.kind), ops: [change.set("readAt", deps.now())],
      condition: when.and(when.present(), when.eq("atMs", entry.atMs), when.eq("orgId", who.companyId), when.eq("developerId", who.developerId)),
    });
    if (result.applied) marked += 1;
  }
  return marked;
}
