// Port lane W0, port 1: the document store.
//
// A narrow store of JSON documents addressed by a two-part key, shaped on what Cloud's broker does with its state table
// (get, put, conditional update, query by key prefix, transactions with conditions, a few sparse indexes, and a change
// feed). Two kinds of adapter must satisfy it without a core change (decision 51): a DynamoDB adapter (today's code) and a
// SQLite adapter (the local one, decision 45.1). Nothing in this file names either.
//
// Rules for the words used here:
//  - A document is flat JSON with its key written in it (`pk`, `sk`), as the table's items are today.
//  - Keys keep the company scope (decision 45.6): company-owned data has a `pk` that starts with `ORG#<company>#` (see company-scope.ts).
//    A few partitions are install-wide and unscoped today; they are listed in docs/ports.md.
//  - A condition is data (a small expression tree), never a provider's expression string.
//  - Single reads are strongly consistent. Index reads may lag behind writes (DynamoDB's secondary indexes do); a caller never
//    relies on reading its own write through an index.
//  - A write that fails its condition is an ordinary answer (`applied: false`), not an exception. Exceptions are for faults.
import type { JsonValue } from "./json.js";

/** The sizes every adapter must accept at least. An adapter may allow more, never less. */
export const DOCUMENT_STORE_LIMITS = {
  /** `pk` and `sk` are each at most this many UTF-8 bytes. */
  maxKeyBytes: 1_024,
  /** One document, as compact JSON. */
  maxDocumentBytes: 400 * 1_024,
  /** Items in one transaction. */
  maxTransactItems: 100,
  /** All the documents a transaction writes, added up as compact JSON bytes. */
  maxTransactBytes: 4 * 1_024 * 1_024,
  /** Keys in one `getMany`. The keys must be different from each other. */
  maxGetMany: 100,
  /** Items in one query page. */
  maxPageSize: 1_000,
  /** Nesting depth of a document. */
  maxDepth: 32,
} as const;

export interface DocumentKey {
  pk: string;
  sk: string;
}

/** A stored document: flat JSON that carries its own key. Attribute names are non-empty strings. */
export type StoredDocument = DocumentKey & { [attribute: string]: JsonValue };

/** A route into a document: `["workflow", "revision"]` is the `revision` field of the `workflow` map. Never empty. */
export type AttributePath = readonly [string, ...string[]];

// ---- Conditions ----

/**
 * A test on one document, or on a document that is not there. Evaluation rules (an adapter must match them exactly):
 *  - `exists` and `notExists` test whether the path holds a value (null counts as a value). On a document that is absent every path is absent.
 *  - `eq` compares by deep equality; a missing path is not equal to anything.
 *  - `lt`, `lte`, `gt` and `gte` compare two numbers numerically or two strings by Unicode code point order. A missing path, or two
 *    different types, make the test false.
 *  - `beginsWith` is true for a string at the path that starts with the prefix.
 *  - `not` negates, so `not(eq(path, v))` is true for a missing path. There is no `ne`, because stores disagree about it.
 */
export type Condition =
  | { op: "exists"; path: AttributePath }
  | { op: "notExists"; path: AttributePath }
  | { op: "eq"; path: AttributePath; value: JsonValue }
  | { op: "lt" | "lte" | "gt" | "gte"; path: AttributePath; value: string | number }
  | { op: "beginsWith"; path: AttributePath; prefix: string }
  | { op: "and" | "or"; conditions: readonly Condition[] }
  | { op: "not"; condition: Condition };

/** `"workflow.revision"` is `["workflow", "revision"]`. A name that holds a dot is written as an array. */
export function attributePath(path: string | AttributePath): AttributePath {
  if (typeof path !== "string") return path;
  const parts = path.split(".");
  if (parts.some((part) => part === "")) throw new Error("an attribute path has no empty part");
  return parts as unknown as AttributePath;
}

/** Builders for conditions. `when.absent()` is the "write only if this item is new" test. */
export const when = {
  /** The item itself does not exist (the key attribute is absent). */
  absent: (): Condition => ({ op: "notExists", path: ["pk"] }),
  /** The item itself exists. */
  present: (): Condition => ({ op: "exists", path: ["pk"] }),
  exists: (path: string | AttributePath): Condition => ({ op: "exists", path: attributePath(path) }),
  notExists: (path: string | AttributePath): Condition => ({ op: "notExists", path: attributePath(path) }),
  eq: (path: string | AttributePath, value: JsonValue): Condition => ({ op: "eq", path: attributePath(path), value }),
  lt: (path: string | AttributePath, value: string | number): Condition => ({ op: "lt", path: attributePath(path), value }),
  lte: (path: string | AttributePath, value: string | number): Condition => ({ op: "lte", path: attributePath(path), value }),
  gt: (path: string | AttributePath, value: string | number): Condition => ({ op: "gt", path: attributePath(path), value }),
  gte: (path: string | AttributePath, value: string | number): Condition => ({ op: "gte", path: attributePath(path), value }),
  beginsWith: (path: string | AttributePath, prefix: string): Condition => ({ op: "beginsWith", path: attributePath(path), prefix }),
  and: (...conditions: Condition[]): Condition => ({ op: "and", conditions }),
  or: (...conditions: Condition[]): Condition => ({ op: "or", conditions }),
  not: (condition: Condition): Condition => ({ op: "not", condition }),
};

// ---- Updates ----

/**
 * One change to a document. The key attributes `pk` and `sk` cannot be changed. A nested path needs its parent map to exist
 * (otherwise the update is `invalid_request`, for `remove` too, as DynamoDB refuses it; not yet checked against DynamoDB Local). Updating an absent item creates it,
 * holding only its key and the changes, unless the request's condition says otherwise.
 *
 * The steps of one update must not overlap: no path may be the same as, or inside, another step's path (`invalid_request`). Every
 * step reads the document as it was before the update, so the order of the steps does not matter. (DynamoDB refuses overlapping
 * paths in one update and reads the old item for each action; the port takes the same rule so that every adapter agrees.)
 */
export type UpdateOp =
  | { op: "set"; path: AttributePath; value: JsonValue }
  /** Sets the value only when the path holds none (Cloud's `if_not_exists`). */
  | { op: "setIfAbsent"; path: AttributePath; value: JsonValue }
  | { op: "remove"; path: AttributePath }
  /** Adds a (possibly negative) number to a number; a missing path counts as 0, a non-number is `invalid_request`. */
  | { op: "add"; path: AttributePath; amount: number };

export const change = {
  set: (path: string | AttributePath, value: JsonValue): UpdateOp => ({ op: "set", path: attributePath(path), value }),
  setIfAbsent: (path: string | AttributePath, value: JsonValue): UpdateOp => ({ op: "setIfAbsent", path: attributePath(path), value }),
  remove: (path: string | AttributePath): UpdateOp => ({ op: "remove", path: attributePath(path) }),
  add: (path: string | AttributePath, amount: number): UpdateOp => ({ op: "add", path: attributePath(path), amount }),
};

// ---- Writes ----

export interface PutRequest {
  item: StoredDocument;
  condition?: Condition;
  /** `"old"`: answer with the document that was replaced, if there was one. */
  return?: "old";
}
export interface UpdateRequest {
  key: DocumentKey;
  ops: readonly UpdateOp[];
  condition?: Condition;
  return?: "new" | "old";
}
export interface DeleteRequest {
  key: DocumentKey;
  condition?: Condition;
  return?: "old";
}

/** `item` is set only when the request asked for a return value and there was one. */
export type WriteResult = { applied: true; item?: StoredDocument } | { applied: false; reason: "condition_failed" };

/**
 * One step of a transaction. `check` writes nothing; it only requires its condition to hold. No two steps may name the same
 * key. All steps are applied together or none is, and no reader sees a half-applied transaction.
 */
export type TransactItem =
  | { kind: "put"; item: StoredDocument; condition?: Condition }
  | { kind: "update"; key: DocumentKey; ops: readonly UpdateOp[]; condition?: Condition }
  | { kind: "delete"; key: DocumentKey; condition?: Condition }
  | { kind: "check"; key: DocumentKey; condition: Condition };

/** `failed` lists the indexes of the steps whose condition did not hold (every one an adapter can tell; at least one). */
export type TransactResult = { applied: true } | { applied: false; reason: "condition_failed"; failed: readonly number[] };

// ---- Reads ----

/** A range of sort keys inside one partition. Text compares by Unicode code point order (the same as UTF-8 byte order). */
export type SortKeyRange =
  | { op: "eq"; value: string }
  | { op: "beginsWith"; prefix: string }
  | { op: "between"; low: string; high: string }
  | { op: "lt" | "lte" | "gt" | "gte"; value: string };

/**
 * One page of a partition, in sort-key order (`descending` reverses it).
 * `limit` is the most items a page holds (at most `DOCUMENT_STORE_LIMITS.maxPageSize`; default: that). A page may hold fewer
 * items than `limit`, even none, and still carry a cursor (a filter drops items; a store may also end a page at a size limit): keep
 * asking until `cursor` is absent. The cursor is opaque
 * and good only for the same request.
 */
export interface QueryRequest {
  pk: string;
  sk?: SortKeyRange;
  filter?: Condition;
  descending?: boolean;
  limit?: number;
  cursor?: string;
}
export interface QueryPage {
  items: StoredDocument[];
  cursor?: string;
}

/**
 * A sparse secondary index over one partition attribute (a string) and, optionally, one sort attribute (a string or a number).
 * A document is in the index only if it holds the partition attribute (and the sort attribute, when the index has one).
 * Items come in sort-attribute order; the order of items with equal sort values is not defined.
 *
 * Index attributes have a fixed type, as DynamoDB's index keys do. A write that gives the partition attribute anything but a
 * non-empty string, or the sort attribute anything but a value of `sortType` (a non-empty string, if text), is `invalid_request`.
 * To leave a document out of an index, leave the attribute out.
 */
export interface IndexDefinition {
  name: string;
  partitionAttribute: string;
  sortAttribute?: string;
  /** The type of the sort attribute. Default `string`. */
  sortType?: "string" | "number";
}
export type IndexSortRange =
  | { op: "eq"; value: string | number }
  | { op: "between"; low: string | number; high: string | number }
  | { op: "lt" | "lte" | "gt" | "gte"; value: string | number };
export interface IndexQueryRequest {
  index: string;
  partition: string;
  sort?: IndexSortRange;
  filter?: Condition;
  descending?: boolean;
  limit?: number;
  cursor?: string;
}

// ---- The change feed ----

/** One committed change. `before` is absent for an insert, `after` for a remove. */
export interface DocumentChange {
  /** Opaque. Changes to one key arrive in commit order; the sequence says nothing about order between keys. */
  sequence: string;
  kind: "insert" | "modify" | "remove";
  /** `expired` for a removal by the time-to-live sweep, so a consumer can tell it from a delete; `write` for everything else. */
  cause: "write" | "expired";
  key: DocumentKey;
  before?: StoredDocument;
  after?: StoredDocument;
}
export interface ChangeSubscription {
  stop(): Promise<void>;
}
/**
 * What the DynamoDB stream does today: every committed change reaches each named consumer at least once, in commit order for
 * one key. A handler that throws is called again with the same changes. A rejected conditional write produces no change.
 * This is the way indexers, notifiers and the outbox relay learn what happened.
 *
 * Consumers are named and the names are fixed: a store may require them to be declared when it is built (DynamoDB's readers are
 * declared in the deployment, and at most two can read one stream), and `subscribe` then attaches to a declared name. A consumer
 * sees the changes committed after the first time its name subscribed, and, after a restart, the ones it had not yet handled
 * (the adapter keeps a durable checkpoint per name). Retries are bounded: after the adapter's limit it stops retrying that batch,
 * calls `onPoison` if given, and goes on, so one bad batch cannot block a consumer for ever. A handler must therefore be safe to
 * run twice on the same change.
 */
export interface DocumentChangeFeed {
  subscribe(
    consumer: string,
    handler: (changes: readonly DocumentChange[]) => Promise<void>,
    options?: { onPoison?: (changes: readonly DocumentChange[], error: unknown) => void },
  ): Promise<ChangeSubscription>;
}

// ---- The port ----

export interface DocumentStore {
  /** The secondary indexes this store keeps. Fixed when the store is built. */
  readonly indexes: readonly IndexDefinition[];
  /**
   * The top-level number attribute (seconds since the epoch) after which a document may be deleted in the background, if the store
   * does that. A document past its time may still be read until it is swept, so a reader tests the time itself (a condition).
   */
  readonly ttlAttribute?: string;
  /** Present when the store can tell others about its changes. */
  readonly changes?: DocumentChangeFeed;

  /** One document, read strongly consistently, or undefined. */
  get(key: DocumentKey): Promise<StoredDocument | undefined>;
  /** The documents for these keys, in the order of `keys` (undefined where there is none). Not a snapshot: use `transact` with `check` steps for that. */
  getMany(keys: readonly DocumentKey[]): Promise<(StoredDocument | undefined)[]>;
  put(request: PutRequest): Promise<WriteResult>;
  update(request: UpdateRequest): Promise<WriteResult>;
  delete(request: DeleteRequest): Promise<WriteResult>;
  query(request: QueryRequest): Promise<QueryPage>;
  queryIndex(request: IndexQueryRequest): Promise<QueryPage>;
  transact(items: readonly TransactItem[]): Promise<TransactResult>;
}

export type DocumentStoreErrorCode =
  /** The request breaks a rule of the port (a bad key, a document that is too big, two steps on one key, an update through a missing parent). The caller's bug; never retried. */
  | "invalid_request"
  /** The store asked the caller to slow down. Retry later. */
  | "throttled"
  /** The store could not be reached or failed. Retry later. */
  | "unavailable"
  /**
   * A transaction lost a race with another writer (DynamoDB's `TransactionConflict`). Not a failed condition. An adapter retries a
   * bounded number of times itself and throws this only when the retries are used up; the caller may retry the whole operation.
   */
  | "conflict";

export class DocumentStoreError extends Error {
  constructor(readonly code: DocumentStoreErrorCode, message: string) {
    super(message);
    this.name = "DocumentStoreError";
  }
  get retryable(): boolean {
    return this.code !== "invalid_request";
  }
}

/** Every item of a query, following cursors. */
export async function queryAll(store: Pick<DocumentStore, "query">, request: Omit<QueryRequest, "cursor">): Promise<StoredDocument[]> {
  const items: StoredDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.query(cursor === undefined ? request : { ...request, cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
}

/** Every item of an index query, following cursors. */
export async function queryIndexAll(store: Pick<DocumentStore, "queryIndex">, request: Omit<IndexQueryRequest, "cursor">): Promise<StoredDocument[]> {
  const items: StoredDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.queryIndex(cursor === undefined ? request : { ...request, cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
}
