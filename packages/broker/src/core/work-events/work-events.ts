// Work events (U3, requirements P-11 and E-62): the writer and the one internal reader, on the document store port. The shape of an event, its key and its retention are in `@agentx/contracts` (`work-event.ts`).
//
// The event is a row in the company's own key scope (`ORG#<org>#WORK_EVENTS#<yyyy-mm>`), written like a milestone: `workEventItems` gives the items to ADD to the transaction of the change that caused the
// event, so the event exists exactly when the change committed, and a change that did not commit leaves nothing. The id is derived from the change, so a repeat of the change is the same row. The Put has NO
// condition on purpose: an event must never be the reason a change is refused (a conditional put that met its own earlier copy would cancel the whole transaction). A caller that has no transaction uses `recordWorkEvent`. The row expires `WORK_EVENT_RETENTION_MONTHS` months after its month (the store's expiry attribute), and holds no text: the schema is strict and closed.
//
// The reader (`listWorkEvents`) is for the rollups and the first Insights read that come later; nothing in Code reads events yet.
import {
  INDEX_EXPIRY_ATTRIBUTE, WorkEventInstantSchema, WorkEventSchema, queryAll, workEventExpiresAt, workEventKey, workEventMonths, workEventPartition,
  type DocumentStore, type OrgId, type StoredDocument, type TransactItem, type WorkEvent, type WorkEventInput, type WorkEventKind, type WriteResult,
} from "@agentx/contracts";

/** The most events one transaction is asked to carry from one change (a change makes one or two, never a batch). */
export const WORK_EVENTS_PER_CHANGE_MAX = 8;

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

/** The items for the events one change makes, in order. Two events of one change must differ in kind or source: they would be one row, and a transaction may not name a key twice. */
export function workEventItems(events: readonly WorkEventInput[]): TransactItem[] {
  if (events.length > WORK_EVENTS_PER_CHANGE_MAX) throw new Error(`a change makes at most ${String(WORK_EVENTS_PER_CHANGE_MAX)} work events`);
  return events.map(workEventItem);
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
}

/** The events of one company in a range, oldest first, and how many rows could not be read (a version this code does not know). Reads one partition per month in the range. */
export async function listWorkEvents(store: Pick<DocumentStore, "query">, query: WorkEventQuery): Promise<{ events: WorkEvent[]; unreadable: number }> {
  WorkEventInstantSchema.parse(query.from);
  WorkEventInstantSchema.parse(query.to);
  const events: WorkEvent[] = [];
  let unreadable = 0;
  for (const month of workEventMonths(query.from, query.to)) {
    // The sort key is `<at>#<id>`: "~" sorts after "#", so `to~` includes every event at `to`.
    const rows = await queryAll(store, { pk: workEventPartition(query.orgId, month), sk: { op: "between", low: query.from, high: `${query.to}~` } });
    for (const row of rows) {
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
  return { events, unreadable };
}
