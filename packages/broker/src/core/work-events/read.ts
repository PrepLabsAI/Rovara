// Lane EV: the per-company event read. Events and usage (`cost_settled`) out of Code, for a company administrator of THAT company, polled with a cursor: oldest first, bounded, and append-only from the API's
// side (the store it takes has `query` and nothing else). The events of a month are in eight shards (`workEventPartitions`); a month is read as one merge of its shards in time order, months one after the other.
//
// The cursor is a position in time order (`<at>#<id>`, the events' own sort key), bound to the company and the filters. It is always returned, so a poller keeps it after the last event and asks again
// later. An event is stamped with the time of the CHANGE that made it, which can be earlier than the time it was stored: a poller that must not miss a late event asks with `from` a few minutes before the last
// event it saw, and drops events it has already seen by their id (an event's id is its identity). A real feed (the store's change feed) is a later step.
//
// One call reads at most COMPANY_EVENTS_SCAN_MAX rows (a little more may be fetched ahead, at most one page per shard) and returns at most the page limit; the range may touch at most COMPANY_EVENTS_MONTHS_MAX months.
// Rows are checked against the company again (`rowBelongsToCompany`); a row that is not this company's is counted as skipped, a row this code cannot read as unreadable. Never their content.
import {
  COMPANY_EVENTS_MONTHS_MAX, COMPANY_EVENTS_PAGE_DEFAULT, COMPANY_EVENTS_SCAN_MAX, CompanyEventsQuerySchema, INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, WORK_EVENT_SHARDS, WorkEventSchema, agentXError,
  workEventMonths, workEventPartition,
  type CompanyEventsResponse, type DocumentStore, type QueryRequest, type StoredDocument, type WorkEvent,
} from "@agentx/contracts";
import { rowBelongsToCompany } from "../company-read-rows.js";
import { decodeCursor, encodeCursor, filterDigest } from "../company-read-cursor.js";

export { COMPANY_EVENTS_SCAN_MAX };

/** The most rows asked of the store in one query (so at most eight pages are read ahead). */
const SHARD_PAGE = 100;
const POSITION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#(?:wev_[a-f0-9]{32})?$/u;
const STORED_ONLY = new Set(["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE]);

interface ShardState { request: Omit<QueryRequest, "cursor">; rows: StoredDocument[]; at: number; cursor: string | undefined; fetched: boolean }

function unavailable(): never {
  throw agentXError("AUDIT_UNAVAILABLE", "the events could not be read");
}

/** One page of a company's work events. `query` is checked here (an unknown field, a wrong type or an out-of-range value is a refusal with fixed words). `now` is epoch milliseconds. */
export async function readCompanyEvents(store: Pick<DocumentStore, "query">, companyId: string, query: unknown, now: number = Date.now()): Promise<CompanyEventsResponse> {
  if (!OrgIdSchema.safeParse(companyId).success) throw agentXError("CONFIG_INVALID", "the company is not valid");
  const parsed = CompanyEventsQuerySchema.safeParse(query);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the event query is not valid");
  const filters = parsed.data;
  if ((filters.cursor === undefined) === (filters.from === undefined)) throw agentXError("CONFIG_INVALID", "the event query is not valid");
  const limit = filters.limit ?? COMPANY_EVENTS_PAGE_DEFAULT;
  const to = filters.to ?? new Date(now).toISOString();
  const kinds = filters.kinds === undefined ? undefined : [...new Set(filters.kinds)].sort();
  const digest = filterDigest({ kinds, project: filters.project, taskId: filters.taskId, person: filters.person });
  const start = filters.cursor === undefined ? `${filters.from!}#` : decodeCursor("p", filters.cursor, companyId, digest, (position) => POSITION.test(position));
  const startAt = start.slice(0, start.indexOf("#"));
  if (Date.parse(startAt) > Date.parse(to)) {
    // Nothing yet between the position and `to`: the same position again.
    if (filters.cursor === undefined) throw agentXError("AUDIT_RANGE_INVALID", "the time range is not valid");
    return { events: [], next: encodeCursor("p", companyId, digest, start), hasMore: false, unreadable: 0, skipped: 0 };
  }
  const months = workEventMonths(startAt, to);
  if (months.length > COMPANY_EVENTS_MONTHS_MAX) throw agentXError("AUDIT_RANGE_INVALID", "the time range is not valid");
  const nowSeconds = Math.floor(now / 1000);

  const events: WorkEvent[] = [];
  let unreadable = 0;
  let skipped = 0;
  let scanned = 0;
  let last = start;
  let hasMore = false;

  const fill = async (state: ShardState): Promise<void> => {
    let page;
    try {
      page = await store.query({ ...state.request, limit: SHARD_PAGE, ...(state.cursor === undefined ? {} : { cursor: state.cursor }) });
    } catch {
      return unavailable();
    }
    state.rows = page.items;
    state.at = 0;
    state.cursor = page.cursor;
    state.fetched = true;
  };
  const ready = async (state: ShardState): Promise<boolean> => {
    if (!state.fetched || (state.at >= state.rows.length && state.cursor !== undefined)) await fill(state);
    // A page can be empty and still carry a cursor (a store may end a page early): keep asking.
    while (state.at >= state.rows.length && state.cursor !== undefined) await fill(state);
    return state.at < state.rows.length;
  };

  month: for (const [index, month] of months.entries()) {
    const lowRange = index === 0 ? (filters.cursor === undefined ? { sk: { op: "gte" as const, value: filters.from! } } : { sk: { op: "gt" as const, value: start } }) : {};
    const shards: ShardState[] = Array.from({ length: WORK_EVENT_SHARDS }, (_, shard) => ({
      request: { pk: workEventPartition(companyId, month, shard), ...lowRange }, rows: [], at: 0, cursor: undefined, fetched: false,
    }));
    for (;;) {
      let best: ShardState | undefined;
      for (const state of shards) {
        if (!(await ready(state))) continue;
        if (best === undefined || state.rows[state.at]!.sk < best.rows[best.at]!.sk) best = state;
      }
      if (best === undefined) break;
      const row = best.rows[best.at]!;
      const rowAt = row.sk.slice(0, row.sk.indexOf("#"));
      // Time order: the first row past `to` ends the read for good.
      if (Date.parse(rowAt) > Date.parse(to)) break month;
      if (scanned >= COMPANY_EVENTS_SCAN_MAX) {
        hasMore = true;
        break month;
      }
      best.at += 1;
      scanned += 1;
      last = row.sk;
      const expires = row[INDEX_EXPIRY_ATTRIBUTE];
      if (typeof expires === "number" && expires <= nowSeconds) continue;
      if (!rowBelongsToCompany(row, companyId)) {
        skipped += 1;
        continue;
      }
      const event = WorkEventSchema.safeParse(Object.fromEntries(Object.entries(row).filter(([name]) => !STORED_ONLY.has(name))));
      if (!event.success) {
        unreadable += 1;
        continue;
      }
      if (event.data.orgId !== companyId) {
        skipped += 1;
        continue;
      }
      const data = event.data;
      if (kinds !== undefined && !kinds.includes(data.kind)) continue;
      if (filters.project !== undefined && data.project !== filters.project) continue;
      if (filters.taskId !== undefined && data.taskId !== filters.taskId) continue;
      if (filters.person !== undefined && !(data.actor.kind === "person" && data.actor.personId === filters.person)) continue;
      events.push(data);
      if (events.length >= limit) {
        // More may follow in this month's shards, or in a later month: the next call finds out.
        const pending = shards.some((state) => state.at < state.rows.length || state.cursor !== undefined);
        hasMore = pending || index < months.length - 1;
        break month;
      }
    }
  }
  return { events, next: encodeCursor("p", companyId, digest, last), hasMore, unreadable, skipped };
}
