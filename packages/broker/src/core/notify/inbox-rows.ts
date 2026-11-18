// The in-app inbox's rows (web task channel C7): one row per person, session and kind, written beside the attention queue's pending row (`queueAttention`) and kept for `INBOX_KEEP_SECONDS`. Unlike the
// pending row, which goes once the person was messaged (or has nowhere to be messaged), an inbox row stays until it expires, so a person with no chat and no email still finds what waits for them.
// The partition is the company's AND the person's, built only from the company the caller was checked into; a later change of the same kind for the same session replaces the row (it is unread again).
import { SessionIdSchema, type DocumentStore, type StoredDocument } from "@agentx/contracts";

export const INBOX_KINDS = ["needs_you", "paused", "ready", "failed", "done"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
const KINDS: ReadonlySet<string> = new Set(INBOX_KINDS);
export const isInboxKind = (value: unknown): value is InboxKind => typeof value === "string" && KINDS.has(value);

/** How long a row is kept: `expiresAtSec` is the reader's own test of it; the store's background delete is set by the writer (`putInboxRow`) from the queue's own TTL attribute. */
export const INBOX_KEEP_SECONDS = 14 * 86_400;

export const inboxPartition = (orgId: string, developerId: string): string => `NOTIFY_INBOX#${orgId}#${developerId}`;
export const inboxKey = (orgId: string, developerId: string, sessionId: string, kind: string) => ({ pk: inboxPartition(orgId, developerId), sk: `${sessionId}#${kind}` });

/** The row for one person's notice: `at` is the change's time, `atMs` the same as a number (the id's and the read mark's guard). */
export function inboxRow(input: { orgId: string; developerId: string; sessionId: string; kind: InboxKind; at: string; nowMs: number }): StoredDocument {
  const parsed = Date.parse(input.at);
  return {
    ...inboxKey(input.orgId, input.developerId, input.sessionId, input.kind), entityType: "NOTIFY_INBOX", orgId: input.orgId, developerId: input.developerId, sessionId: input.sessionId, kind: input.kind,
    at: input.at, atMs: Number.isFinite(parsed) ? parsed : input.nowMs, expiresAtSec: Math.floor(input.nowMs / 1000) + INBOX_KEEP_SECONDS,
  };
}

/**
 * Keeps the person's inbox row for a notice (called by `queueAttention`, beside the pending row). `ttlAttribute` is the attention queue's own expiry attribute, given by the caller, so the store deletes the row
 * after `INBOX_KEEP_SECONDS` like the pending rows. A failed write is logged in fixed words (when the caller gave a log) and never throws: the inbox is never a reason for the queue to fail.
 */
export async function putInboxRow(
  store: Pick<DocumentStore, "put">, log: ((entry: Record<string, unknown>) => void) | undefined,
  input: { orgId: string; developerId: string; sessionId: string; kind: InboxKind; at: string; nowMs: number }, ttlAttribute: string,
): Promise<void> {
  try {
    const item = inboxRow(input);
    item[ttlAttribute] = item["expiresAtSec"] as number;
    await store.put({ item });
  } catch (error) {
    log?.({ event: "attention.inbox_failed", sessionId: input.sessionId, error: error instanceof Error ? error.name : "unknown" });
  }
}

// L4-U5b: the project notices (`upkeep_paused`, `setup_broken`): about a PROJECT, not a session, so a person who is told by neither chat nor email still finds them. They sit in the same per-person partition under a sort key that
// starts `PROJECT#` (no session id looks like that, so the session inbox above never reads one, and the person erase that walks the partition removes them too). The row names the notice's subject id (which holds the
// project, and the month and reason or the re-check), and is checked again against the project at every read (`project-notices.ts`): it shows only while the person still administers the project.
export const PROJECT_NOTICE_KINDS = ["upkeep_paused", "setup_broken"] as const;
export type ProjectNoticeKind = (typeof PROJECT_NOTICE_KINDS)[number];
export const isProjectNoticeKind = (value: unknown): value is ProjectNoticeKind => typeof value === "string" && (PROJECT_NOTICE_KINDS as readonly string[]).includes(value);
export const PROJECT_NOTICE_PREFIX = "PROJECT#";
export const projectNoticeKey = (orgId: string, developerId: string, subjectId: string, kind: ProjectNoticeKind) => ({ pk: inboxPartition(orgId, developerId), sk: `${PROJECT_NOTICE_PREFIX}${subjectId}#${kind}` });

/** The row for one person's project notice, with the queue's own expiry attribute so the store deletes it after `INBOX_KEEP_SECONDS`. */
export function projectNoticeRow(input: { orgId: string; developerId: string; subjectId: string; kind: ProjectNoticeKind; at: string; nowMs: number }, ttlAttribute: string): StoredDocument {
  const parsed = Date.parse(input.at);
  const expiresAtSec = Math.floor(input.nowMs / 1000) + INBOX_KEEP_SECONDS;
  const row: StoredDocument = {
    ...projectNoticeKey(input.orgId, input.developerId, input.subjectId, input.kind), entityType: "NOTIFY_INBOX_PROJECT", orgId: input.orgId, developerId: input.developerId, subjectId: input.subjectId, kind: input.kind,
    at: input.at, atMs: Number.isFinite(parsed) ? parsed : input.nowMs, expiresAtSec,
  };
  row[ttlAttribute] = expiresAtSec;
  return row;
}

/** The id a client names a row by: `<session>.<kind>.<atMs>`. It names no person, and `atMs` keeps a read mark off a row that changed since it was shown. */
export const inboxIdOf = (row: { sessionId: string; kind: string; atMs: number }): string => `${row.sessionId}.${row.kind}.${String(row.atMs)}`;

const INBOX_ID = /^([0-9a-z_]{1,64})\.([a-z_]{1,20})\.([0-9]{1,16})$/u;

/** A row id from a client, or undefined for anything that is not exactly one. */
export function parseInboxId(value: unknown): { sessionId: string; kind: InboxKind; atMs: number } | undefined {
  if (typeof value !== "string") return undefined;
  const match = INBOX_ID.exec(value);
  if (match === null || !SessionIdSchema.safeParse(match[1]).success || !isInboxKind(match[2])) return undefined;
  const atMs = Number(match[3]);
  return Number.isSafeInteger(atMs) ? { sessionId: match[1]!, kind: match[2], atMs } : undefined;
}

/** A person erase: every inbox row of this person in this company (the partition is theirs alone). Answers how many rows went. */
export async function eraseInboxRows(store: Pick<DocumentStore, "query" | "delete">, orgId: string, developerId: string): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await store.query({ pk: inboxPartition(orgId, developerId), limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      // The row's key is rebuilt from its own session and kind (never forwarded), so only a row this code wrote is deleted by its key.
      const hash = item.sk.indexOf("#");
      if (hash > 0) await store.delete({ key: inboxKey(orgId, developerId, item.sk.slice(0, hash), item.sk.slice(hash + 1)) });
      removed += 1;
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return removed;
}
