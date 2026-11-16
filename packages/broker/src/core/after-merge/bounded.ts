// One TOTAL bound on every read of a partition range: items and pages. A range with more than `max` rows is refused whole (`TooManyRows`), never answered with a part of it.
import { type Condition, type DocumentStore, type QueryPage, type StoredDocument } from "@agentx/contracts";

export class TooManyRows extends Error {
  constructor() { super("too many rows"); this.name = "TooManyRows"; }
}

/** The most pages one bounded read follows (a filter can make a page short, so the item bound alone does not bound the work). */
export const PAGES_MAX = 20;

/** One page of a partition range (the range names its own partition: callers never pass a partition key around). */
export function pageOf(store: Pick<DocumentStore, "query">, range: { pk: string; prefix: string; filter?: Condition | undefined }, options: { limit: number; cursor?: string | undefined }): Promise<QueryPage> {
  return store.query({ pk: range.pk, sk: { op: "beginsWith", prefix: range.prefix }, ...(range.filter === undefined ? {} : { filter: range.filter }), limit: options.limit, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) });
}

export async function readBounded(store: Pick<DocumentStore, "query">, range: { pk: string; prefix: string; filter?: Condition | undefined }, max: number): Promise<StoredDocument[]> {
  const items: StoredDocument[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= PAGES_MAX) throw new TooManyRows();
    const result = await pageOf(store, range, { limit: Math.min(max + 1, 1_000), cursor });
    items.push(...result.items);
    if (items.length > max) throw new TooManyRows();
    cursor = result.cursor;
    if (cursor === undefined) return items;
  }
}


