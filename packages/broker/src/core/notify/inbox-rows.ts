// The in-app inbox's rows (web task channel C7): one row per person, session and kind, written beside the attention queue's pending row (`queueAttention`) and kept for `INBOX_KEEP_SECONDS`. Unlike the
// pending row, which goes once the person was messaged (or has nowhere to be messaged), an inbox row stays until it expires, so a person with no chat and no email still finds what waits for them.
// The partition is the company's AND the person's, built only from the company the caller was checked into; a later change of the same kind for the same session replaces the row (it is unread again).
import { INDEX_EXPIRY_ATTRIBUTE, SessionIdSchema, type DocumentStore, type StoredDocument } from "@agentx/contracts";

export const INBOX_KINDS = ["needs_you", "paused", "ready", "failed", "done"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
const KINDS: ReadonlySet<string> = new Set(INBOX_KINDS);
export const isInboxKind = (value: unknown): value is InboxKind => typeof value === "string" && KINDS.has(value);

/** How long a row is kept (the store deletes it after this; a reader tests the time itself). */
export const INBOX_KEEP_SECONDS = 14 * 86_400;

export const inboxPartition = (orgId: string, developerId: string): string => `NOTIFY_INBOX#${orgId}#${developerId}`;
export const inboxKey = (orgId: string, developerId: string, sessionId: string, kind: string) => ({ pk: inboxPartition(orgId, developerId), sk: `${sessionId}#${kind}` });

/** The row for one person's notice: `at` is the change's time, `atMs` the same as a number (the id's and the read mark's guard). */
export function inboxRow(input: { orgId: string; developerId: string; sessionId: string; kind: InboxKind; at: string; nowMs: number }): StoredDocument {
  const parsed = Date.parse(input.at);
  return {
    ...inboxKey(input.orgId, input.developerId, input.sessionId, input.kind), entityType: "NOTIFY_INBOX", orgId: input.orgId, developerId: input.developerId, sessionId: input.sessionId, kind: input.kind,
    at: input.at, atMs: Number.isFinite(parsed) ? parsed : input.nowMs, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(input.nowMs / 1000) + INBOX_KEEP_SECONDS,
  };
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
      await store.delete({ key: { pk: item.pk, sk: item.sk } });
      removed += 1;
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return removed;
}
