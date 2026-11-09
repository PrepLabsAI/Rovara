// Port lane L3: the local DocumentStore, on SQLite (owner decisions 44 and 45.1).
//
// The rules (conditions, data-shaped updates, size and depth limits, number range, typed index keys, the update-overlap rule) are not
// written again here: every write reads the documents inside its transaction and calls the shared functions of
// `document-semantics.ts`, the same ones the in-memory fake uses. What this file adds is storage:
//  - `rv_doc(pk, sk, doc)`: the document as JSON text, keyed by (pk, sk). Text columns are UTF-8 with BINARY collation, so SQL order is
//    the code point order the port promises. Keys with an unpaired surrogate or a NUL are refused (SQLite would change or cut them).
//  - one table per declared index, kept in the same transaction as the document, and an optional time-to-live table.
//  - a change log for the change feed (sqlite-change-feed.ts), written in the same transaction.
// Limits that follow from SQLite are in docs/ports.md ("Local adapters").
import {
  DOCUMENT_STORE_LIMITS,
  DocumentStoreError,
  applyUpdateOps,
  assertDistinctKeys,
  assertValidDocument,
  assertValidIndexAttributes,
  assertValidKey,
  assertValidOps,
  assertValidTransaction,
  evaluateCondition,
  indexPlacement,
  type Condition,
  type DeleteRequest,
  type DocumentChangeFeed,
  type DocumentKey,
  type DocumentStore,
  type IndexDefinition,
  type IndexQueryRequest,
  type PutRequest,
  type QueryPage,
  type QueryRequest,
  type SortKeyRange,
  type StoredDocument,
  type TransactItem,
  type TransactResult,
  type UpdateRequest,
  type WriteResult,
} from "@agentx/contracts";
import { CHANGE_FEED_SCHEMA, SqliteChangeFeed, consumersRegistered, logChanges, translateFailure, type LoggedChange, type SqliteChangeFeedOptions } from "./sqlite-change-feed.js";
import { SqliteDatabase, storableText, type SqliteDatabaseOptions, type SqliteValue } from "./sqlite-database.js";

const SCHEMA_VERSION = "1";
const SWEEP_PAGE = 100;

export interface SqliteDocumentStoreOptions {
  /** The connection to use. The store does not close a connection it was given. */
  database: SqliteDatabase;
  /**
   * The sparse secondary indexes, fixed for this open. The file remembers its indexes and time-to-live attribute: opening it with a
   * different set is refused unless `migrate` is true, because every connection to the file must maintain the same tables.
   */
  indexes?: readonly IndexDefinition[];
  /**
   * Allow this open to change the file's indexes and time-to-live attribute to the ones given (new index tables are built from the
   * documents, tables of indexes no longer named are dropped). Other connections that were open with the old set refuse to write after
   * that, and must be reopened. Default false.
   */
  migrate?: boolean;
  /** The top-level number attribute (seconds since the epoch) after which a document may be swept. */
  ttlAttribute?: string;
  /** Seconds since the epoch, for the sweep. Default: the real clock. */
  nowSeconds?: () => number;
  /** How often expired documents are swept in the background, in ms. 0 turns the timer off (call `sweepExpired`). Default 60000 when there is a ttlAttribute. */
  sweepIntervalMs?: number;
  /** The change feed. `false` leaves it off (the store then has no `changes`). */
  changeFeed?: false | SqliteChangeFeedOptions;
}

export type SqliteDocumentStoreOpenOptions = Omit<SqliteDocumentStoreOptions, "database"> & SqliteDatabaseOptions;

const invalid = (message: string): DocumentStoreError => new DocumentStoreError("invalid_request", message);
const INDEX_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const indexTable = (name: string): string => `rv_doc_ix_${Buffer.from(name, "utf8").toString("hex")}`;

interface IndexPlan {
  definition: IndexDefinition;
  table: string;
  sortType: "string" | "number" | "none";
}

/** The index definition as stored, so a change between opens is noticed. */
const describeIndex = (plan: IndexPlan): string => JSON.stringify({ name: plan.definition.name, partitionAttribute: plan.definition.partitionAttribute, sortAttribute: plan.definition.sortAttribute ?? null, sortType: plan.sortType });

export class SqliteDocumentStore implements DocumentStore {
  readonly indexes: readonly IndexDefinition[];
  readonly ttlAttribute?: string;
  readonly changes?: DocumentChangeFeed;
  readonly #db: SqliteDatabase;
  readonly #ownsDatabase: boolean;
  readonly #plans: readonly IndexPlan[];
  readonly #nowSeconds: () => number;
  readonly #feed: SqliteChangeFeed | undefined;
  #sweepTimer: NodeJS.Timeout | undefined;
  #sweepFollowUp: NodeJS.Timeout | undefined;
  #sweeping = false;
  #closed = false;
  /** The layout generation of the file this store was opened on; a change by another connection makes writes refuse. */
  #generation = "";

  /** Opens (and creates) the database file and a store over it. `close()` closes the file. */
  static open(options: SqliteDocumentStoreOpenOptions): SqliteDocumentStore {
    const { path, busyTimeoutMs, synchronous, ...rest } = options;
    const database = new SqliteDatabase({ path, ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }), ...(synchronous === undefined ? {} : { synchronous }) });
    try {
      return new SqliteDocumentStore({ ...rest, database }, true);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  constructor(options: SqliteDocumentStoreOptions, ownsDatabase = false) {
    this.#db = options.database;
    this.#ownsDatabase = ownsDatabase;
    this.#nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
    const definitions = options.indexes ?? [];
    const names = new Set<string>();
    this.#plans = definitions.map((definition): IndexPlan => {
      if (!INDEX_NAME.test(definition.name)) throw new Error("an index name is 1 to 64 letters, digits, dots, hyphens or underscores");
      if (names.has(definition.name)) throw new Error(`two indexes are named ${definition.name}`);
      names.add(definition.name);
      if (definition.partitionAttribute === "" ) throw new Error("an index needs a partition attribute");
      if (definition.sortAttribute === undefined && definition.sortType !== undefined) throw new Error("an index with no sort attribute has no sort type");
      return { definition, table: indexTable(definition.name), sortType: definition.sortAttribute === undefined ? "none" : (definition.sortType ?? "string") };
    });
    this.indexes = definitions;
    if (options.ttlAttribute !== undefined) {
      if (options.ttlAttribute === "" || options.ttlAttribute === "pk" || options.ttlAttribute === "sk") throw new Error("ttlAttribute names a top-level attribute other than the key");
      this.ttlAttribute = options.ttlAttribute;
    }
    this.#translate(() => this.#initialise(options.migrate === true));
    if (options.changeFeed !== false) {
      this.#feed = new SqliteChangeFeed(this.#db, options.changeFeed ?? {});
      this.changes = this.#feed;
    }
    const sweepMs = options.sweepIntervalMs ?? 60_000;
    if (this.ttlAttribute !== undefined && sweepMs > 0) {
      this.#sweepTimer = setInterval(() => this.#sweepTick(), sweepMs);
      this.#sweepTimer.unref();
    }
  }

  /** Stops the change feed and the sweep, and closes the file if this store opened it. Safe to call twice. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer);
    if (this.#sweepFollowUp !== undefined) clearTimeout(this.#sweepFollowUp);
    this.#sweepTimer = undefined;
    this.#sweepFollowUp = undefined;
    await this.#feed?.close();
    if (this.#ownsDatabase) this.#db.close();
  }

  /** Waits for the change feed to hand every committed change to this process's consumers (for tests). */
  async settled(): Promise<void> {
    await this.#feed?.settled();
  }

  /** Retires a change-feed consumer for good: deletes its checkpoint and the log it alone was holding back. */
  removeConsumer(name: string): boolean {
    return this.#feed === undefined ? false : this.#translate(() => this.#feed!.removeConsumer(name), "write");
  }

  /** How many change batches the feed gave up on after their retries. */
  get droppedBatches(): number {
    return this.#feed?.dropped ?? 0;
  }

  // ---- Reads ----

  async get(key: DocumentKey): Promise<StoredDocument | undefined> {
    this.#assertKey(key);
    return this.#translate(() => this.#read(key));
  }

  async getMany(keys: readonly DocumentKey[]): Promise<(StoredDocument | undefined)[]> {
    if (keys.length > DOCUMENT_STORE_LIMITS.maxGetMany) throw invalid(`getMany takes at most ${DOCUMENT_STORE_LIMITS.maxGetMany} keys`);
    assertDistinctKeys(keys);
    for (const key of keys) this.#assertKey(key);
    return this.#translate(() => keys.map((key) => this.#read(key)));
  }

  async query(request: QueryRequest): Promise<QueryPage> {
    if (typeof request.pk !== "string" || request.pk === "") throw invalid("pk must be a non-empty string");
    this.#assertText(request.pk, "pk");
    const limit = pageLimit(request.limit);
    const clauses = ["pk = ?"];
    const params: SqliteValue[] = [request.pk];
    this.#sortKeyClauses(request.sk, clauses, params);
    const descending = request.descending === true;
    if (request.cursor !== undefined) {
      const after = decodeCursor(request.cursor);
      if (after.pk !== request.pk) throw invalid("that cursor is not valid");
      this.#assertText(after.sk, "the cursor");
      clauses.push(descending ? "sk < ?" : "sk > ?");
      params.push(after.sk);
    }
    const sql = `SELECT sk, doc FROM rv_doc WHERE ${clauses.join(" AND ")} ORDER BY sk ${descending ? "DESC" : "ASC"} LIMIT ?`;
    const rows = this.#translate(() => this.#db.all(sql, ...params, limit + 1));
    return this.#page(rows.map((row) => ({ doc: parseDocument(row.doc), position: { pk: request.pk, sk: row.sk as string } })), limit, request.filter);
  }

  async queryIndex(request: IndexQueryRequest): Promise<QueryPage> {
    const plan = this.#plans.find((candidate) => candidate.definition.name === request.index);
    if (plan === undefined) throw invalid(`no index named ${request.index}`);
    if (request.sort !== undefined && plan.sortType === "none") throw invalid("that index has no sort attribute");
    if (typeof request.partition !== "string") throw invalid("the index partition must be text");
    this.#assertText(request.partition, "the index partition");
    const limit = pageLimit(request.limit);
    const clauses = ["t.ix_part = ?"];
    const params: SqliteValue[] = [request.partition];
    if (request.sort !== undefined && !this.#indexSortClauses(plan, request.sort, clauses, params)) return { items: [] };
    const descending = request.descending === true;
    if (request.cursor !== undefined) {
      const after = decodeCursor(request.cursor);
      this.#assertText(after.pk, "the cursor");
      this.#assertText(after.sk, "the cursor");
      const sort = plan.sortType === "none" ? "" : after.sort;
      if (sort === undefined || typeof sort !== (plan.sortType === "number" ? "number" : "string")) throw invalid("that cursor is not valid");
      if (typeof sort === "string") this.#assertText(sort, "the cursor");
      clauses.push(`(t.ix_sort, t.pk, t.sk) ${descending ? "<" : ">"} (?, ?, ?)`);
      params.push(sort, after.pk, after.sk);
    }
    const direction = descending ? "DESC" : "ASC";
    const sql = `SELECT t.ix_sort AS ix_sort, t.pk AS pk, t.sk AS sk, d.doc AS doc FROM ${plan.table} t JOIN rv_doc d ON d.pk = t.pk AND d.sk = t.sk WHERE ${clauses.join(" AND ")} ORDER BY t.ix_sort ${direction}, t.pk ${direction}, t.sk ${direction} LIMIT ?`;
    const rows = this.#translate(() => {
      this.#assertLayout();
      return this.#db.all(sql, ...params, limit + 1);
    });
    return this.#page(
      rows.map((row) => ({ doc: parseDocument(row.doc), position: { pk: row.pk as string, sk: row.sk as string, ...(plan.sortType === "none" ? {} : { sort: row.ix_sort as string | number }) } })),
      limit,
      request.filter,
    );
  }

  // ---- Writes ----

  async put(request: PutRequest): Promise<WriteResult> {
    assertValidDocument(request.item);
    assertValidIndexAttributes(this.indexes, request.item);
    this.#assertKey(request.item);
    const result = this.#commit([{ kind: "put", item: request.item, ...(request.condition === undefined ? {} : { condition: request.condition }) }]);
    if (!result.applied) return { applied: false, reason: "condition_failed" };
    return request.return === "old" && result.before[0] !== undefined ? { applied: true, item: result.before[0] } : { applied: true };
  }

  async update(request: UpdateRequest): Promise<WriteResult> {
    this.#assertKey(request.key);
    assertValidOps(request.ops);
    const result = this.#commit([{ kind: "update", key: request.key, ops: request.ops, ...(request.condition === undefined ? {} : { condition: request.condition }) }]);
    if (!result.applied) return { applied: false, reason: "condition_failed" };
    if (request.return === "old") return result.before[0] === undefined ? { applied: true } : { applied: true, item: result.before[0] };
    if (request.return === "new") return { applied: true, item: result.after[0]! };
    return { applied: true };
  }

  async delete(request: DeleteRequest): Promise<WriteResult> {
    this.#assertKey(request.key);
    const result = this.#commit([{ kind: "delete", key: request.key, ...(request.condition === undefined ? {} : { condition: request.condition }) }]);
    if (!result.applied) return { applied: false, reason: "condition_failed" };
    return request.return === "old" && result.before[0] !== undefined ? { applied: true, item: result.before[0] } : { applied: true };
  }

  async transact(items: readonly TransactItem[]): Promise<TransactResult> {
    assertValidTransaction(items);
    for (const item of items) this.#assertKey(item.kind === "put" ? item.item : item.key);
    const result = this.#commit(items);
    return result.applied ? { applied: true } : { applied: false, reason: "condition_failed", failed: result.failed };
  }

  /**
   * Deletes the documents whose time-to-live attribute is in the past, as a store with a background sweep would, and tells the change
   * feed `cause: "expired"`. Returns how many it removed. It works in pages of 100, one transaction each. Runs by itself every
   * `sweepIntervalMs`, a little at a time so the event loop is not held.
   */
  sweepExpired(): number {
    let removed = 0;
    for (;;) {
      const page = this.#sweepPage();
      removed += page;
      if (page < SWEEP_PAGE) return removed;
    }
  }

  /** One page of expired documents: listed and deleted in one transaction, so a document renewed meanwhile is not removed. */
  #sweepPage(): number {
    const ttl = this.ttlAttribute;
    if (ttl === undefined || this.#sweeping || this.#closed) return 0;
    this.#sweeping = true;
    try {
      const now = this.#nowSeconds();
      const outcome = this.#commit(() => this.#db.all("SELECT pk, sk FROM rv_doc_ttl WHERE expires <= ? ORDER BY expires, pk, sk LIMIT ?", now, SWEEP_PAGE).map((row): TransactItem => ({ kind: "delete", key: { pk: row.pk as string, sk: row.sk as string } })), "expired");
      return outcome.applied ? outcome.before.filter((item) => item !== undefined).length : 0;
    } finally {
      this.#sweeping = false;
    }
  }

  /** The timer's work: pages for at most 50 ms, then, if more is due, another go after the event loop has had a turn. */
  #sweepTick(): void {
    if (this.#closed) return;
    try {
      const until = Date.now() + 50;
      let page: number;
      do page = this.#sweepPage();
      while (page === SWEEP_PAGE && Date.now() < until);
      if (page === SWEEP_PAGE) {
        this.#sweepFollowUp = setTimeout(() => this.#sweepTick(), 20);
        this.#sweepFollowUp.unref();
      }
    } catch {
      // A busy or failing file is retried on the next tick.
    }
  }

  // ---- Inside ----

  #assertText(value: string, what: string): void {
    if (!storableText(value)) throw invalid(`${what} holds an unpaired surrogate or a NUL character, which the SQLite store cannot keep`);
  }

  #assertKey(key: DocumentKey): void {
    assertValidKey(key);
    this.#assertText(key.pk, "pk");
    this.#assertText(key.sk, "sk");
  }

  /** The index key attributes become SQL text; they must survive it. */
  #assertIndexText(document: StoredDocument): void {
    for (const plan of this.#plans) {
      const place = indexPlacement(plan.definition, document);
      if (place === undefined) continue;
      this.#assertText(place.partition, plan.definition.partitionAttribute);
      if (typeof place.sort === "string") this.#assertText(place.sort, plan.definition.sortAttribute ?? "the sort attribute");
    }
  }

  /** Maps the store's failures to the port's error codes. A busy file on a write is a lost race (`conflict`); on a read, `throttled`. */
  #translate<T>(body: () => T, mode: "read" | "write" = "read"): T {
    if (this.#closed) throw new DocumentStoreError("unavailable", "the store is closed");
    return translateFailure(body, mode);
  }

  /** Refuses to go on if another connection changed the file's indexes or time-to-live attribute after this store was opened. Call inside the transaction or query. */
  #assertLayout(): void {
    const row = this.#db.get("SELECT value FROM rv_doc_meta WHERE key = 'generation'");
    if (row?.value !== this.#generation) throw new DocumentStoreError("unavailable", "the database's indexes were changed by another connection since this store was opened; reopen the store");
  }

  #read(key: DocumentKey): StoredDocument | undefined {
    const row = this.#db.get("SELECT doc FROM rv_doc WHERE pk = ? AND sk = ?", key.pk, key.sk);
    return row === undefined ? undefined : parseDocument(row.doc);
  }

  #sortKeyClauses(range: SortKeyRange | undefined, clauses: string[], params: SqliteValue[]): void {
    if (range === undefined) return;
    const text = (value: unknown, what: string): string => {
      if (typeof value !== "string") throw invalid(`${what} must be text`);
      this.#assertText(value, what);
      return value;
    };
    switch (range.op) {
      case "eq": clauses.push("sk = ?"); params.push(text(range.value, "the sort key")); break;
      case "beginsWith": {
        const prefix = text(range.prefix, "the prefix");
        if (prefix === "") break;
        clauses.push("sk >= ?");
        params.push(prefix);
        const end = prefixEnd(prefix);
        if (end !== undefined) {
          clauses.push("sk < ?");
          params.push(end);
        }
        break;
      }
      case "between": clauses.push("sk >= ?", "sk <= ?"); params.push(text(range.low, "the low bound"), text(range.high, "the high bound")); break;
      case "lt": clauses.push("sk < ?"); params.push(text(range.value, "the bound")); break;
      case "lte": clauses.push("sk <= ?"); params.push(text(range.value, "the bound")); break;
      case "gt": clauses.push("sk > ?"); params.push(text(range.value, "the bound")); break;
      case "gte": clauses.push("sk >= ?"); params.push(text(range.value, "the bound")); break;
      default: throw invalid("unknown sort key range");
    }
  }

  /** False when a bound has the wrong type for the index: nothing is in range then, as in the port's rules. */
  #indexSortClauses(plan: IndexPlan, range: NonNullable<IndexQueryRequest["sort"]>, clauses: string[], params: SqliteValue[]): boolean {
    const wanted = plan.sortType === "number" ? "number" : "string";
    const bounds = range.op === "between" ? [range.low, range.high] : [range.value];
    for (const bound of bounds) {
      if (typeof bound === "number" && !Number.isFinite(bound)) throw invalid("a bound must be a finite number");
      if (typeof bound === "string") this.#assertText(bound, "the bound");
      if (typeof bound !== wanted) return false;
    }
    switch (range.op) {
      case "eq": clauses.push("t.ix_sort = ?"); break;
      case "between": clauses.push("t.ix_sort >= ?", "t.ix_sort <= ?"); break;
      case "lt": clauses.push("t.ix_sort < ?"); break;
      case "lte": clauses.push("t.ix_sort <= ?"); break;
      case "gt": clauses.push("t.ix_sort > ?"); break;
      case "gte": clauses.push("t.ix_sort >= ?"); break;
      default: throw invalid("unknown index sort range");
    }
    params.push(...(bounds as SqliteValue[]));
    return true;
  }

  /** `rows` holds up to limit + 1 entries; the extra one only says there is more. The filter drops items after the window is cut, so a page may be short. */
  #page(rows: { doc: StoredDocument; position: Position }[], limit: number, filter: Condition | undefined): QueryPage {
    const window = rows.slice(0, limit);
    const items = window.filter((row) => filter === undefined || evaluateCondition(row.doc, filter)).map((row) => row.doc);
    const last = window[window.length - 1];
    return rows.length > limit && last !== undefined ? { items, cursor: encodeCursor(last.position) } : { items };
  }

  /** Checks every condition, then applies every step, or none: one SQLite write transaction. */
  #commit(provided: readonly TransactItem[] | (() => TransactItem[]), cause: "write" | "expired" = "write"): { applied: true; before: (StoredDocument | undefined)[]; after: (StoredDocument | undefined)[] } | { applied: false; failed: number[] } {
    const outcome = this.#translate(() => this.#db.write(() => {
      this.#assertLayout();
      const steps = typeof provided === "function" ? provided() : provided;
      const before = steps.map((step) => this.#read(step.kind === "put" ? step.item : step.key));
      const failed: number[] = [];
      steps.forEach((step, index) => {
        if (step.condition !== undefined && !evaluateCondition(before[index], step.condition)) failed.push(index);
      });
      if (failed.length > 0) return { applied: false as const, failed };
      const after = steps.map((step, index): StoredDocument | undefined => {
        switch (step.kind) {
          case "put": assertValidDocument(step.item); return structuredClone(step.item);
          case "update": return applyUpdateOps(before[index], step.key, step.ops);
          case "delete": return undefined;
          case "check": return before[index];
        }
      });
      for (const next of after) {
        if (next === undefined) continue;
        assertValidIndexAttributes(this.indexes, next);
        this.#assertIndexText(next);
      }
      const logged: LoggedChange[] = [];
      steps.forEach((step, index) => {
        if (step.kind === "check") return;
        const key = step.kind === "put" ? step.item : step.key;
        const old = before[index];
        const next = after[index];
        if (old !== undefined) this.#unplace(old);
        if (next === undefined) {
          this.#db.run("DELETE FROM rv_doc WHERE pk = ? AND sk = ?", key.pk, key.sk);
        } else {
          this.#db.run("INSERT INTO rv_doc (pk, sk, doc) VALUES (?, ?, ?) ON CONFLICT (pk, sk) DO UPDATE SET doc = excluded.doc", key.pk, key.sk, JSON.stringify(next));
          this.#place(next);
        }
        if (old === undefined && next === undefined) return;
        logged.push({
          kind: old === undefined ? "insert" : next === undefined ? "remove" : "modify",
          cause,
          key: { pk: key.pk, sk: key.sk },
          ...(old === undefined ? {} : { before: old }),
          ...(next === undefined ? {} : { after: next }),
        });
      });
      // Every writer logs while any consumer is registered in the file, whether or not this store runs a feed itself.
      if (logged.length > 0 && consumersRegistered(this.#db)) logChanges(this.#db, logged);
      return { applied: true as const, before, after };
    }), "write");
    if (outcome.applied) this.#feed?.kick();
    return outcome;
  }

  /** Drops the index and time-to-live entries of a document that is about to change or go. */
  #unplace(document: StoredDocument): void {
    for (const plan of this.#plans) {
      const place = placementOf(plan, document);
      if (place !== undefined) this.#db.run(`DELETE FROM ${plan.table} WHERE ix_part = ? AND ix_sort = ? AND pk = ? AND sk = ?`, place.partition, place.sort, document.pk, document.sk);
    }
    const expires = this.ttlAttribute === undefined ? undefined : document[this.ttlAttribute];
    if (typeof expires === "number") this.#db.run("DELETE FROM rv_doc_ttl WHERE expires = ? AND pk = ? AND sk = ?", expires, document.pk, document.sk);
  }

  #place(document: StoredDocument): void {
    for (const plan of this.#plans) {
      const place = placementOf(plan, document);
      if (place !== undefined) this.#db.run(`INSERT OR REPLACE INTO ${plan.table} (ix_part, ix_sort, pk, sk) VALUES (?, ?, ?, ?)`, place.partition, place.sort, document.pk, document.sk);
    }
    const expires = this.ttlAttribute === undefined ? undefined : document[this.ttlAttribute];
    if (typeof expires === "number") this.#db.run("INSERT OR REPLACE INTO rv_doc_ttl (expires, pk, sk) VALUES (?, ?, ?)", expires, document.pk, document.sk);
  }

  // ---- Schema ----

  #initialise(migrate: boolean): void {
    const db = this.#db;
    db.write(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rv_doc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS rv_doc (pk TEXT NOT NULL, sk TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (pk, sk)) WITHOUT ROWID;
        ${CHANGE_FEED_SCHEMA}
      `);
      const version = db.get("SELECT value FROM rv_doc_meta WHERE key = 'schema'");
      if (version === undefined) db.run("INSERT INTO rv_doc_meta (key, value) VALUES ('schema', ?)", SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new DocumentStoreError("unavailable", `the database file was written by a newer version of the store (schema ${String(version.value)})`);
      // The file remembers its layout. Every connection must maintain the same index and time-to-live tables, so a different request is
      // refused unless the caller says it is migrating the file.
      const storedIndexes = db.get("SELECT value FROM rv_doc_meta WHERE key = 'indexes'");
      const storedTtl = db.get("SELECT value FROM rv_doc_meta WHERE key = 'ttl'");
      const wantedIndexes = this.#plans.map(describeIndex).sort();
      const wantedTtl = this.ttlAttribute ?? "";
      const fresh = storedIndexes === undefined;
      const differs = !fresh && (JSON.stringify((JSON.parse(storedIndexes.value as string) as string[]).slice().sort()) !== JSON.stringify(wantedIndexes) || (storedTtl?.value ?? "") !== wantedTtl);
      if (differs && !migrate) {
        throw new DocumentStoreError("invalid_request", "this database file was built with other indexes or another time-to-live attribute than the ones requested; open it with the same ones, or with migrate: true to change the file");
      }
      if (fresh || differs) {
        this.#reconcileIndexes();
        this.#reconcileTtl();
        const generation = db.get("SELECT value FROM rv_doc_meta WHERE key = 'generation'");
        db.run("INSERT OR REPLACE INTO rv_doc_meta (key, value) VALUES ('generation', ?)", String(Number(generation?.value ?? 0) + 1));
      }
      db.run("INSERT OR IGNORE INTO rv_doc_meta (key, value) VALUES ('generation', '1')");
      this.#generation = db.get("SELECT value FROM rv_doc_meta WHERE key = 'generation'")!.value as string;
    });
  }

  /** Builds the tables of new or changed indexes from the documents, and drops the tables of indexes that are gone. */
  #reconcileIndexes(): void {
    const db = this.#db;
    const stored = new Map<string, string>();
    const row = db.get("SELECT value FROM rv_doc_meta WHERE key = 'indexes'");
    if (row !== undefined) for (const description of JSON.parse(row.value as string) as string[]) stored.set((JSON.parse(description) as { name: string }).name, description);
    const wanted = new Map(this.#plans.map((plan) => [plan.definition.name, plan] as const));
    for (const [name, description] of stored) {
      if (!wanted.has(name)) db.exec(`DROP TABLE IF EXISTS ${indexTable(name)}`);
      else if (description !== describeIndex(wanted.get(name)!)) db.exec(`DROP TABLE IF EXISTS ${indexTable(name)}`);
    }
    const rebuilt: IndexPlan[] = [];
    for (const plan of this.#plans) {
      const exists = stored.get(plan.definition.name) === describeIndex(plan);
      const sortSql = plan.sortType === "number" ? "REAL" : "TEXT";
      db.exec(`CREATE TABLE IF NOT EXISTS ${plan.table} (ix_part TEXT NOT NULL, ix_sort ${sortSql} NOT NULL, pk TEXT NOT NULL, sk TEXT NOT NULL, PRIMARY KEY (ix_part, ix_sort, pk, sk)) WITHOUT ROWID`);
      if (!exists) rebuilt.push(plan);
    }
    if (rebuilt.length > 0) {
      this.#scan((document) => {
        for (const plan of rebuilt) {
          const place = placementOf(plan, document);
          if (place !== undefined && storableText(place.partition) && (typeof place.sort !== "string" || storableText(place.sort))) {
            db.run(`INSERT OR REPLACE INTO ${plan.table} (ix_part, ix_sort, pk, sk) VALUES (?, ?, ?, ?)`, place.partition, place.sort, document.pk, document.sk);
          }
        }
      });
    }
    db.run("INSERT OR REPLACE INTO rv_doc_meta (key, value) VALUES ('indexes', ?)", JSON.stringify(this.#plans.map(describeIndex)));
  }

  #reconcileTtl(): void {
    const db = this.#db;
    const row = db.get("SELECT value FROM rv_doc_meta WHERE key = 'ttl'");
    const was = row === undefined ? "" : (row.value as string);
    const now = this.ttlAttribute ?? "";
    if (now === "") {
      db.exec("DROP TABLE IF EXISTS rv_doc_ttl");
    } else {
      db.exec("CREATE TABLE IF NOT EXISTS rv_doc_ttl (expires REAL NOT NULL, pk TEXT NOT NULL, sk TEXT NOT NULL, PRIMARY KEY (expires, pk, sk)) WITHOUT ROWID");
      if (was !== now) {
        db.exec("DELETE FROM rv_doc_ttl");
        this.#scan((document) => {
          const expires = document[now];
          if (typeof expires === "number") db.run("INSERT OR REPLACE INTO rv_doc_ttl (expires, pk, sk) VALUES (?, ?, ?)", expires, document.pk, document.sk);
        });
      }
    }
    db.run("INSERT OR REPLACE INTO rv_doc_meta (key, value) VALUES ('ttl', ?)", now);
  }

  /** Visits every stored document, a page of keys at a time. */
  #scan(visit: (document: StoredDocument) => void): void {
    let after: DocumentKey | undefined;
    for (;;) {
      const rows = after === undefined
        ? this.#db.all("SELECT pk, sk, doc FROM rv_doc ORDER BY pk, sk LIMIT 500")
        : this.#db.all("SELECT pk, sk, doc FROM rv_doc WHERE (pk, sk) > (?, ?) ORDER BY pk, sk LIMIT 500", after.pk, after.sk);
      if (rows.length === 0) return;
      for (const row of rows) visit(parseDocument(row.doc));
      const last = rows[rows.length - 1]!;
      after = { pk: last.pk as string, sk: last.sk as string };
    }
  }
}

/** Where a document sits in an index, if it is in it with the right types (a document that does not fit is simply not indexed). */
function placementOf(plan: IndexPlan, document: StoredDocument): { partition: string; sort: string | number } | undefined {
  const place = indexPlacement(plan.definition, document);
  if (place === undefined || place.partition === "") return undefined;
  if (plan.sortType === "none") return { partition: place.partition, sort: "" };
  if (typeof place.sort !== (plan.sortType === "number" ? "number" : "string") || place.sort === "") return undefined;
  return { partition: place.partition, sort: place.sort! };
}

function parseDocument(value: unknown): StoredDocument {
  try {
    return JSON.parse(value as string) as StoredDocument;
  } catch {
    throw new DocumentStoreError("unavailable", "a stored document is not valid JSON; the database file may be damaged");
  }
}

function pageLimit(limit: number | undefined): number {
  const value = limit ?? DOCUMENT_STORE_LIMITS.maxPageSize;
  if (!Number.isInteger(value) || value < 1 || value > DOCUMENT_STORE_LIMITS.maxPageSize) throw invalid(`limit must be 1 to ${DOCUMENT_STORE_LIMITS.maxPageSize}`);
  return value;
}

/**
 * The smallest text that sorts after every text starting with `prefix`, in code point order, or undefined when there is none (the
 * prefix is all U+10FFFF). The last code point that can grow is raised by one (skipping the surrogate range) and what follows is cut.
 */
export function prefixEnd(prefix: string): string | undefined {
  const points = Array.from(prefix);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const code = points[index]!.codePointAt(0)!;
    if (code >= 0x10ffff) continue;
    const next = code === 0xd7ff ? 0xe000 : code + 1;
    return points.slice(0, index).join("") + String.fromCodePoint(next);
  }
  return undefined;
}

interface Position {
  pk: string;
  sk: string;
  sort?: string | number;
}
function encodeCursor(position: Position): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}
function decodeCursor(cursor: string): Position {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<Position>;
    if (typeof parsed.pk !== "string" || typeof parsed.sk !== "string") throw new Error("shape");
    return { pk: parsed.pk, sk: parsed.sk, ...(typeof parsed.sort === "string" || typeof parsed.sort === "number" ? { sort: parsed.sort } : {}) };
  } catch {
    throw invalid("that cursor is not valid");
  }
}
