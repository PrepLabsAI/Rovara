// Port lane W0: an in-memory document store. It is the fake the other lanes build against, and the reference the conformance
// suite is checked with. It is not a database: one process, nothing kept after exit.
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
  compareScalars,
  compareText,
  evaluateCondition,
  indexPlacement,
  indexSortInRange,
  sortKeyInRange,
  type ChangeSubscription,
  type Condition,
  type DeleteRequest,
  type DocumentChange,
  type DocumentChangeFeed,
  type DocumentKey,
  type DocumentStore,
  type IndexDefinition,
  type IndexQueryRequest,
  type PutRequest,
  type QueryPage,
  type QueryRequest,
  type StoredDocument,
  type TransactItem,
  type TransactResult,
  type UpdateRequest,
  type WriteResult,
} from "@agentx/contracts";

export interface MemoryDocumentStoreOptions {
  indexes?: readonly IndexDefinition[];
  ttlAttribute?: string;
  /** Seconds since the epoch, for the sweep. Default: the real clock. */
  nowSeconds?: () => number;
  /** Leave the change feed off, as a store that has none. Default: on. */
  changeFeed?: boolean;
}

const idOf = (key: DocumentKey): string => `${key.pk}\u0000${key.sk}`;

export class MemoryDocumentStore implements DocumentStore {
  readonly indexes: readonly IndexDefinition[];
  readonly ttlAttribute?: string;
  readonly changes?: DocumentChangeFeed;
  readonly #items = new Map<string, StoredDocument>();
  readonly #nowSeconds: () => number;
  readonly #faults: DocumentStoreError[] = [];
  #expiring = false;
  readonly #feed?: MemoryChangeFeed;

  constructor(options: MemoryDocumentStoreOptions = {}) {
    this.indexes = options.indexes ?? [];
    if (options.ttlAttribute !== undefined) this.ttlAttribute = options.ttlAttribute;
    this.#nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
    if (options.changeFeed !== false) {
      this.#feed = new MemoryChangeFeed();
      this.changes = this.#feed;
    }
  }

  /** Makes the next `count` calls to any method fail with this error, as a throttled or unreachable store does. */
  injectFault(error: DocumentStoreError, count = 1): void {
    this.#faults.push(...Array.from({ length: count }, () => error));
  }

  /** How many change batches the feed gave up on after its retries, for tests that must notice. */
  get droppedBatches(): number {
    return this.#feed?.dropped ?? 0;
  }

  get size(): number {
    return this.#items.size;
  }

  #fault(): void {
    const error = this.#faults.shift();
    if (error !== undefined) throw error;
  }

  async get(key: DocumentKey): Promise<StoredDocument | undefined> {
    assertValidKey(key);
    this.#fault();
    const found = this.#items.get(idOf(key));
    return found === undefined ? undefined : structuredClone(found);
  }

  async getMany(keys: readonly DocumentKey[]): Promise<(StoredDocument | undefined)[]> {
    if (keys.length > DOCUMENT_STORE_LIMITS.maxGetMany) throw new DocumentStoreError("invalid_request", `getMany takes at most ${DOCUMENT_STORE_LIMITS.maxGetMany} keys`);
    assertDistinctKeys(keys);
    this.#fault();
    return Promise.all(keys.map((key) => this.get(key)));
  }

  async put(request: PutRequest): Promise<WriteResult> {
    assertValidDocument(request.item);
    assertValidIndexAttributes(this.indexes, request.item);
    this.#fault();
    const result = this.#commit([{ kind: "put", item: request.item, ...(request.condition === undefined ? {} : { condition: request.condition }) }]);
    if (!result.applied) return { applied: false, reason: "condition_failed" };
    return request.return === "old" && result.before[0] !== undefined ? { applied: true, item: result.before[0] } : { applied: true };
  }

  async update(request: UpdateRequest): Promise<WriteResult> {
    assertValidKey(request.key);
    assertValidOps(request.ops);
    this.#fault();
    const result = this.#commit([{ kind: "update", key: request.key, ops: request.ops, ...(request.condition === undefined ? {} : { condition: request.condition }) }]);
    if (!result.applied) return { applied: false, reason: "condition_failed" };
    if (request.return === "old") return result.before[0] === undefined ? { applied: true } : { applied: true, item: result.before[0] };
    if (request.return === "new") return { applied: true, item: result.after[0]! };
    return { applied: true };
  }

  async delete(request: DeleteRequest): Promise<WriteResult> {
    assertValidKey(request.key);
    this.#fault();
    const result = this.#commit([{ kind: "delete", key: request.key, ...(request.condition === undefined ? {} : { condition: request.condition }) }]);
    if (!result.applied) return { applied: false, reason: "condition_failed" };
    return request.return === "old" && result.before[0] !== undefined ? { applied: true, item: result.before[0] } : { applied: true };
  }

  async transact(items: readonly TransactItem[]): Promise<TransactResult> {
    assertValidTransaction(items);
    this.#fault();
    const result = this.#commit(items);
    return result.applied ? { applied: true } : { applied: false, reason: "condition_failed", failed: result.failed };
  }

  async query(request: QueryRequest): Promise<QueryPage> {
    this.#fault();
    if (typeof request.pk !== "string" || request.pk === "") throw new DocumentStoreError("invalid_request", "pk must be a non-empty string");
    const candidates = [...this.#items.values()]
      .filter((item) => item.pk === request.pk && sortKeyInRange(item.sk, request.sk))
      .sort((a, b) => compareText(a.sk, b.sk));
    if (request.descending === true) candidates.reverse();
    return this.#page(candidates, request, (item) => ({ pk: item.pk, sk: item.sk }));
  }

  async queryIndex(request: IndexQueryRequest): Promise<QueryPage> {
    this.#fault();
    const index = this.indexes.find((candidate) => candidate.name === request.index);
    if (index === undefined) throw new DocumentStoreError("invalid_request", `no index named ${request.index}`);
    if (request.sort !== undefined && index.sortAttribute === undefined) throw new DocumentStoreError("invalid_request", "that index has no sort attribute");
    const placed: { item: StoredDocument; sort: string | number | undefined }[] = [];
    for (const item of this.#items.values()) {
      const place = indexPlacement(index, item);
      if (place === undefined || place.partition !== request.partition) continue;
      if (place.sort !== undefined && !indexSortInRange(place.sort, request.sort)) continue;
      placed.push({ item, sort: place.sort });
    }
    placed.sort((a, b) => (compareScalars(a.sort, b.sort) ?? 0) || compareText(a.item.pk, b.item.pk) || compareText(a.item.sk, b.item.sk));
    if (request.descending === true) placed.reverse();
    const sortOf = new Map(placed.map((entry) => [idOf(entry.item), entry.sort] as const));
    return this.#page(placed.map((entry) => entry.item), request, (item) => ({ pk: item.pk, sk: item.sk, ...(sortOf.get(idOf(item)) === undefined ? {} : { sort: sortOf.get(idOf(item))! }) }));
  }

  /** Deletes the documents whose time-to-live attribute is in the past, as a store with a background sweep would. */
  sweepExpired(): number {
    if (this.ttlAttribute === undefined) return 0;
    const now = this.#nowSeconds();
    let removed = 0;
    for (const item of [...this.#items.values()]) {
      const expires = item[this.ttlAttribute];
      if (typeof expires === "number" && expires <= now) {
        this.#expiring = true;
        try {
          this.#commit([{ kind: "delete", key: item }]);
        } finally {
          this.#expiring = false;
        }
        removed += 1;
      }
    }
    return removed;
  }

  /** Waits for the change feed to hand every committed change to its consumers (for tests). */
  async settled(): Promise<void> {
    await this.#feed?.settled();
  }

  #page(ordered: StoredDocument[], request: { filter?: Condition; limit?: number; cursor?: string; descending?: boolean }, positionOf: (item: StoredDocument) => Position): QueryPage {
    const limit = request.limit ?? DOCUMENT_STORE_LIMITS.maxPageSize;
    if (!Number.isInteger(limit) || limit < 1 || limit > DOCUMENT_STORE_LIMITS.maxPageSize) throw new DocumentStoreError("invalid_request", `limit must be 1 to ${DOCUMENT_STORE_LIMITS.maxPageSize}`);
    let start = 0;
    if (request.cursor !== undefined) {
      // A cursor names the last item of the previous page. Resume after its position, even if that item has since been deleted.
      const after = decodeCursor(request.cursor);
      const direction = request.descending === true ? -1 : 1;
      start = ordered.findIndex((item) => comparePosition(positionOf(item), after) * direction > 0);
      if (start === -1) start = ordered.length;
    }
    const window = ordered.slice(start, start + limit);
    const items = window.filter((item) => request.filter === undefined || evaluateCondition(item, request.filter)).map((item) => structuredClone(item));
    const more = start + limit < ordered.length;
    const last = window[window.length - 1];
    return more && last !== undefined ? { items, cursor: encodeCursor(positionOf(last)) } : { items };
  }

  /** Checks every condition, then applies every step, or none. Returns what each step held before and after. */
  #commit(steps: readonly TransactItem[]): { applied: true; before: (StoredDocument | undefined)[]; after: (StoredDocument | undefined)[] } | { applied: false; failed: number[] } {
    const failed: number[] = [];
    const before = steps.map((step) => this.#items.get(idOf(step.kind === "put" ? step.item : step.key)));
    steps.forEach((step, index) => {
      if (step.condition !== undefined && !evaluateCondition(before[index], step.condition)) failed.push(index);
    });
    if (failed.length > 0) return { applied: false, failed };
    const after = steps.map((step, index): StoredDocument | undefined => {
      switch (step.kind) {
        case "put": assertValidDocument(step.item); return structuredClone(step.item);
        case "update": return applyUpdateOps(before[index], step.key, step.ops);
        case "delete": return undefined;
        case "check": return before[index];
      }
    });
    for (const next of after) if (next !== undefined) assertValidIndexAttributes(this.indexes, next);
    const changes: Omit<DocumentChange, "sequence">[] = [];
    steps.forEach((step, index) => {
      if (step.kind === "check") return;
      const key = step.kind === "put" ? step.item : step.key;
      const old = before[index];
      const next = after[index];
      if (next === undefined) this.#items.delete(idOf(key));
      else this.#items.set(idOf(key), next);
      if (old === undefined && next === undefined) return;
      changes.push({
        kind: old === undefined ? "insert" : next === undefined ? "remove" : "modify",
        cause: this.#expiring ? "expired" : "write",
        key: { pk: key.pk, sk: key.sk },
        ...(old === undefined ? {} : { before: structuredClone(old) }),
        ...(next === undefined ? {} : { after: structuredClone(next) }),
      });
    });
    this.#feed?.publish(changes);
    return { applied: true, before: before.map((item) => (item === undefined ? undefined : structuredClone(item))), after: after.map((item) => (item === undefined ? undefined : structuredClone(item))) };
  }
}

/** Where an item sits in a result: its index sort value (for index queries), then its key. */
interface Position {
  sort?: string | number;
  pk: string;
  sk: string;
}
function comparePosition(a: Position, b: Position): number {
  return (compareScalars(a.sort, b.sort) ?? 0) || compareText(a.pk, b.pk) || compareText(a.sk, b.sk);
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
    throw new DocumentStoreError("invalid_request", "that cursor is not valid");
  }
}

interface Consumer {
  handler: (changes: readonly DocumentChange[]) => Promise<void>;
  queue: DocumentChange[];
  running: boolean;
  stopped: boolean;
  onPoison?: (changes: readonly DocumentChange[], error: unknown) => void;
}

/** At-least-once delivery to named consumers, in commit order. A handler that throws gets the same changes again (up to 10 times, then they are dropped). */
class MemoryChangeFeed implements DocumentChangeFeed {
  readonly #consumers = new Map<string, Consumer>();
  #sequence = 0;

  dropped = 0;

  async subscribe(consumer: string, handler: (changes: readonly DocumentChange[]) => Promise<void>, options: { onPoison?: (changes: readonly DocumentChange[], error: unknown) => void } = {}): Promise<ChangeSubscription> {
    if (this.#consumers.has(consumer)) throw new DocumentStoreError("invalid_request", "that consumer name is already subscribed");
    const entry: Consumer = { handler, queue: [], running: false, stopped: false, ...(options.onPoison === undefined ? {} : { onPoison: options.onPoison }) };
    this.#consumers.set(consumer, entry);
    return {
      stop: async () => {
        entry.stopped = true;
        this.#consumers.delete(consumer);
      },
    };
  }

  publish(changes: readonly Omit<DocumentChange, "sequence">[]): void {
    if (changes.length === 0) return;
    const numbered = changes.map((change): DocumentChange => ({ ...change, sequence: String(++this.#sequence).padStart(20, "0") }));
    for (const consumer of this.#consumers.values()) {
      consumer.queue.push(...numbered);
      if (!consumer.running) void this.#run(consumer);
    }
  }

  async settled(): Promise<void> {
    for (let spins = 0; spins < 200; spins += 1) {
      if ([...this.#consumers.values()].every((consumer) => !consumer.running && consumer.queue.length === 0)) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  async #run(consumer: Consumer): Promise<void> {
    consumer.running = true;
    try {
      while (consumer.queue.length > 0 && !consumer.stopped) {
        const batch = consumer.queue.splice(0, consumer.queue.length);
        for (let attempt = 1; attempt <= 10; attempt += 1) {
          try {
            await consumer.handler(batch);
            break;
          } catch (error) {
            if (attempt === 10) {
              this.dropped += 1;
              consumer.onPoison?.(batch, error);
            } else await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }
      }
    } finally {
      consumer.running = false;
    }
  }
}
