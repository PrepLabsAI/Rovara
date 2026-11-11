// Work events (U3, requirements P-11 and E-62): the writer and the one internal reader, on the document store port. The shape of an event, its key and its retention are in `@agentx/contracts` (`work-event.ts`).
//
// The event is a row in the company's own key scope (`ORG#<org>#WORK_EVENTS#<yyyy-mm>`), written like a milestone: `workEventItems` gives the items to ADD to the transaction of the change that caused the
// event, so the event exists exactly when the change committed, and a change that did not commit leaves nothing. The id is derived from the change, so a repeat of the change is the same row. The Put has NO
// condition on purpose: an event must never be the reason a change is refused (a conditional put that met its own earlier copy would cancel the whole transaction). A caller that has no transaction uses `recordWorkEvent`. The row expires `WORK_EVENT_RETENTION_MONTHS` months after its month (the store's expiry attribute), and holds no text: the schema is strict and closed.
//
// The reader (`listWorkEvents`) is for the rollups and flow reports that come later; nothing in Code reads events yet.
import {
  INDEX_EXPIRY_ATTRIBUTE, WorkEventInstantSchema, WorkEventSchema, queryAll, workEventExpiresAt, workEventKey, workEventMonths, workEventPartitions,
  type DocumentStore, type OrgId, type StoredDocument, type TransactItem, type WorkEvent, type WorkEventInput, type WorkEventKind, type WriteResult,
} from "@agentx/contracts";

/** The most events one change adds to its transaction; more are left out (a change makes a handful, and a business transaction is never refused for events). */
export const WORK_EVENTS_PER_CHANGE_MAX = 50;

/** The stored row of an event: the event, its key, a type marker and the expiry. */
export function workEventRow(input: WorkEventInput): StoredDocument {
  // Parse first: an event that is not valid is a bug at the caller, and nothing is written. Parsing also drops nothing: the shape is strict.
  const event = WorkEventSchema.parse(input);
  return JSON.parse(JSON.stringify({ ...workEventKey(event), entityType: "WORK_EVENT", ...event, [INDEX_EXPIRY_ATTRIBUTE]: workEventExpiresAt(event.at) })) as StoredDocument;
}

/** The transaction item for one event: a Put of its row (the same change is the same row). Add it to the transaction of the change that caused it. Throws for an event that is not valid. */
export function workEventItem(event: WorkEventInput): TransactItem {
  return { kind: "put", item: workEventRow(event) };
}

/**
 * The items for the events one change makes, in order. NEVER throws, because it runs inside a business write: an event that is not valid, or one past `WORK_EVENTS_PER_CHANGE_MAX`, is left out and `onSkip` is told
 * (a deployment logs it). Two events of one change must differ in kind or source: they would be one row, and a transaction may not name a key twice, so the later one is left out too.
 */
export function workEventItems(events: readonly WorkEventInput[], onSkip?: (reason: "invalid" | "too_many" | "duplicate") => void): TransactItem[] {
  const items: TransactItem[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (items.length >= WORK_EVENTS_PER_CHANGE_MAX) {
      onSkip?.("too_many");
      continue;
    }
    const parsed = WorkEventSchema.safeParse(event);
    if (!parsed.success) {
      onSkip?.("invalid");
      continue;
    }
    if (seen.has(parsed.data.id)) {
      onSkip?.("duplicate");
      continue;
    }
    seen.add(parsed.data.id);
    items.push(workEventItem(parsed.data));
  }
  return items;
}

/** Records an event on its own, for a caller with no transaction. Recording the same change again writes the same row. */
export async function recordWorkEvent(store: Pick<DocumentStore, "put">, event: WorkEventInput): Promise<WriteResult> {
  return store.put({ item: workEventRow(event) });
}

export interface WorkEventQuery {
  orgId: OrgId;
  /** The range, both ends inclusive, as UTC instants. */
  from: string;
  to: string;
  /** Only these kinds (default: all). */
  kinds?: readonly WorkEventKind[];
  /** Only this task's events. */
  taskId?: string;
  /** The time rows are judged expired at, epoch milliseconds (default now): a store's time-to-live sweep is lazy, so a row past its time may still be there, and is not returned. */
  now?: number;
}

/**
 * The events of one company in a range, oldest first, and how many rows could not be read (a version this code does not know). One query per shard for each month in the range. A row past its expiry is not
 * returned, even if the store has not yet swept it.
 */
export async function listWorkEvents(store: Pick<DocumentStore, "query">, query: WorkEventQuery): Promise<{ events: WorkEvent[]; unreadable: number }> {
  WorkEventInstantSchema.parse(query.from);
  WorkEventInstantSchema.parse(query.to);
  const nowSeconds = Math.floor((query.now ?? Date.now()) / 1000);
  const events: WorkEvent[] = [];
  let unreadable = 0;
  for (const month of workEventMonths(query.from, query.to)) {
    for (const pk of workEventPartitions(query.orgId, month)) {
      // The sort key is `<at>#<id>`: "~" sorts after "#", so `to~` includes every event at `to`.
      const rows = await queryAll(store, { pk, sk: { op: "between", low: query.from, high: `${query.to}~` } });
      for (const row of rows) {
        const expires = row[INDEX_EXPIRY_ATTRIBUTE];
        if (typeof expires === "number" && expires <= nowSeconds) continue;
        const parsed = WorkEventSchema.safeParse(Object.fromEntries(Object.entries(row).filter(([name]) => !["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE].includes(name))));
        if (!parsed.success) {
          unreadable += 1;
          continue;
        }
        if (query.kinds !== undefined && !query.kinds.includes(parsed.data.kind)) continue;
        if (query.taskId !== undefined && parsed.data.taskId !== query.taskId) continue;
        events.push(parsed.data);
      }
    }
  }
  // Shards are read one after another: put the month back in time order.
  events.sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
  return { events, unreadable };
}
