// Port lane L3: the change feed of the SQLite document store, with a durable checkpoint per named consumer.
//
// Every write that commits while at least one consumer is registered also writes its changes into the `rv_doc_change` table, in the
// same transaction, so the log and the data cannot disagree. A consumer reads the log after its checkpoint, calls its handler, and
// stores the new checkpoint; a crash between the two means the batch is delivered again (at least once). The sequence number is the
// log's row number: it only grows, so order is commit order across all keys.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DocumentStoreError,
  type ChangeSubscription,
  type DocumentChange,
  type DocumentChangeFeed,
  type StoredDocument,
} from "@agentx/contracts";
import { SqliteFailure, storableText, type SqliteDatabase } from "./sqlite-database.js";

export const CHANGE_FEED_SCHEMA = `
CREATE TABLE IF NOT EXISTS rv_doc_change (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  cause TEXT NOT NULL,
  pk TEXT NOT NULL,
  sk TEXT NOT NULL,
  before_doc TEXT,
  after_doc TEXT
);
CREATE TABLE IF NOT EXISTS rv_doc_consumer (
  name TEXT PRIMARY KEY,
  checkpoint INTEGER NOT NULL
) WITHOUT ROWID;
`;

export interface SqliteChangeFeedOptions {
  /** How often an idle consumer looks for changes written by another connection. Local commits wake a consumer at once. Default 500. */
  pollMs?: number;
  /** Delay before the first retry of a failing handler; it doubles each time, up to 5 s. Default 200. */
  retryDelayMs?: number;
  /** A batch whose handler failed this many times is given up on (`onPoison`) and the consumer goes on. Default 10. */
  maxAttempts?: number;
  /** Most changes in one batch. Default 100. */
  batchSize?: number;
}

export interface LoggedChange {
  kind: DocumentChange["kind"];
  cause: DocumentChange["cause"];
  key: { pk: string; sk: string };
  before?: StoredDocument;
  after?: StoredDocument;
}

interface Consumer {
  name: string;
  handler: (changes: readonly DocumentChange[]) => Promise<void>;
  onPoison?: (changes: readonly DocumentChange[], error: unknown) => void;
  stopped: boolean;
  running: Promise<void> | undefined;
  /** Another look at the log was asked for while the consumer was busy. */
  again: boolean;
  wake: (() => void) | undefined;
}

/** Whether any consumer is registered in the file (by any connection): only then are changes worth logging. Call inside the commit's transaction. */
export function consumersRegistered(db: SqliteDatabase): boolean {
  return db.get("SELECT 1 AS one FROM rv_doc_consumer LIMIT 1") !== undefined;
}

/** Writes the changes of one commit into the log. Call inside the commit's transaction. Every writer does this, whether or not it runs a feed itself. */
export function logChanges(db: SqliteDatabase, changes: readonly LoggedChange[]): void {
  for (const change of changes) {
    db.run(
      "INSERT INTO rv_doc_change (kind, cause, pk, sk, before_doc, after_doc) VALUES (?, ?, ?, ?, ?, ?)",
      change.kind,
      change.cause,
      change.key.pk,
      change.key.sk,
      change.before === undefined ? null : JSON.stringify(change.before),
      change.after === undefined ? null : JSON.stringify(change.after),
    );
  }
}

/** Maps a database failure to the port's error codes; anything else passes through. */
export function translateFailure<T>(body: () => T, mode: "read" | "write" = "read"): T {
  try {
    return body();
  } catch (error) {
    if (error instanceof SqliteFailure) {
      if (error.busy) throw new DocumentStoreError(mode === "write" ? "conflict" : "throttled", "the database file is busy: another connection holds its lock");
      throw new DocumentStoreError("unavailable", `the database failed (${error.message})`);
    }
    throw error;
  }
}

/** Marks the call chain of a handler, so a handler that stops its own consumer (or closes the store) does not wait for itself. */
const handlerOf = new AsyncLocalStorage<object>();

export const sequenceOf = (seq: number | bigint): string => String(seq).padStart(20, "0");

export class SqliteChangeFeed implements DocumentChangeFeed {
  readonly #db: SqliteDatabase;
  readonly #pollMs: number;
  readonly #retryDelayMs: number;
  readonly #maxAttempts: number;
  readonly #batchSize: number;
  readonly #consumers = new Map<string, Consumer>();
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  #kickScheduled = false;

  /** How many batches were given up on after their retries (for tests and operators that must notice). */
  dropped = 0;
  /** How many times a consumer could not read the log for a reason other than a busy file (a damaged row, a removed checkpoint). The consumer tries again at the next poll. */
  readFailures = 0;

  constructor(db: SqliteDatabase, options: SqliteChangeFeedOptions = {}) {
    this.#db = db;
    this.#pollMs = positive(options.pollMs ?? 500, "pollMs");
    this.#retryDelayMs = positive(options.retryDelayMs ?? 200, "retryDelayMs");
    this.#maxAttempts = positive(options.maxAttempts ?? 10, "maxAttempts");
    this.#batchSize = positive(options.batchSize ?? 100, "batchSize");
  }

  async subscribe(consumer: string, handler: (changes: readonly DocumentChange[]) => Promise<void>, options: { onPoison?: (changes: readonly DocumentChange[], error: unknown) => void } = {}): Promise<ChangeSubscription> {
    if (typeof consumer !== "string" || consumer === "" || consumer.length > 128 || !storableText(consumer)) throw new DocumentStoreError("invalid_request", "a consumer name is 1 to 128 characters of plain text");
    if (this.#closed) throw new DocumentStoreError("unavailable", "the store is closed");
    if (this.#consumers.has(consumer)) throw new DocumentStoreError("invalid_request", "that consumer name is already subscribed");
    // A new name starts at the present; a name that subscribed before resumes after its stored checkpoint.
    translateFailure(() => this.#db.write(() => {
      const known = this.#db.get("SELECT checkpoint FROM rv_doc_consumer WHERE name = ?", consumer);
      if (known !== undefined) return;
      const counter = this.#db.get("SELECT seq FROM sqlite_sequence WHERE name = 'rv_doc_change'");
      this.#db.run("INSERT INTO rv_doc_consumer (name, checkpoint) VALUES (?, ?)", consumer, counter === undefined ? 0 : Number(counter.seq));
    }), "write");
    const entry: Consumer = { name: consumer, handler, stopped: false, running: undefined, again: false, wake: undefined, ...(options.onPoison === undefined ? {} : { onPoison: options.onPoison }) };
    this.#consumers.set(consumer, entry);
    this.#startTimer();
    this.kick();
    return {
      stop: async () => {
        await this.#stop(entry);
      },
    };
  }

  /**
   * Has every consumer in this process look at the log again, a moment from now (not inside the caller's stack, and one look for a
   * burst of commits). Call after a commit.
   */
  kick(): void {
    if (this.#kickScheduled || this.#closed) return;
    this.#kickScheduled = true;
    setImmediate(() => {
      this.#kickScheduled = false;
      for (const entry of this.#consumers.values()) this.#start(entry);
    });
  }

  /** Forgets a consumer for good: its checkpoint goes, and the log is trimmed. Use it when a consumer is retired; a consumer that is only absent keeps the log it has not read. */
  removeConsumer(name: string): boolean {
    if (this.#consumers.has(name)) throw new DocumentStoreError("invalid_request", "stop the subscription before removing the consumer");
    return translateFailure(() => this.#db.write(() => {
      const removed = this.#db.run("DELETE FROM rv_doc_consumer WHERE name = ?", name) > 0;
      this.#prune();
      return removed;
    }), "write");
  }

  /** Waits until every consumer in this process has handled every committed change (for tests). */
  async settled(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let idle = true;
      translateFailure(() => {
        const last = this.#db.get("SELECT COALESCE(MAX(seq), 0) AS last FROM rv_doc_change");
        const lastSeq = Number(last?.last ?? 0);
        for (const entry of this.#consumers.values()) {
          const row = this.#db.get("SELECT checkpoint FROM rv_doc_consumer WHERE name = ?", entry.name);
          if (entry.running !== undefined || (row !== undefined && Number(row.checkpoint) < lastSeq)) idle = false;
        }
      });
      if (idle || Date.now() > deadline) return;
      this.kick();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.all([...this.#consumers.values()].map((entry) => this.#stop(entry)));
  }

  #startTimer(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.kick(), this.#pollMs);
    this.#timer.unref();
  }

  async #stop(entry: Consumer): Promise<void> {
    entry.stopped = true;
    entry.wake?.();
    // The name stays taken until the handler in flight has finished, so a resubscribe cannot run two handlers on one checkpoint.
    if (handlerOf.getStore() !== entry) await entry.running;
    this.#release(entry);
  }

  #release(entry: Consumer): void {
    if (this.#consumers.get(entry.name) === entry) this.#consumers.delete(entry.name);
    if (this.#consumers.size === 0 && this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #start(entry: Consumer): void {
    if (entry.stopped) return;
    if (entry.running !== undefined) {
      entry.again = true;
      return;
    }
    entry.running = this.#drain(entry).finally(() => {
      entry.running = undefined;
    });
  }

  async #drain(entry: Consumer): Promise<void> {
    do {
      entry.again = false;
      while (!entry.stopped) {
        let batch: { changes: DocumentChange[]; last: number } | undefined;
        try {
          batch = this.#read(entry.name);
        } catch (error) {
          // A busy or closed file is the next poll's business; anything else is counted so an operator can see a consumer that cannot read.
          if (!(error instanceof SqliteFailure && (error.busy || this.#db.closed))) this.readFailures += 1;
          return;
        }
        if (batch === undefined) {
          // The consumer was retired (removeConsumer, possibly from another connection). Nothing more will come: stop reading.
          this.readFailures += 1;
          entry.stopped = true;
          this.#release(entry);
          return;
        }
        if (batch.changes.length === 0) break;
        if (!(await this.#deliver(entry, batch.changes))) return;
        try {
          this.#db.write(() => {
            this.#db.run("UPDATE rv_doc_consumer SET checkpoint = ? WHERE name = ? AND checkpoint < ?", batch.last, entry.name, batch.last);
            this.#prune();
          });
        } catch {
          // The checkpoint was not stored, so the batch will be delivered again: at least once.
          return;
        }
      }
    } while (entry.again && !entry.stopped);
  }

  /** Calls the handler, with bounded retries. False when the consumer was stopped while waiting. */
  async #deliver(entry: Consumer, changes: DocumentChange[]): Promise<boolean> {
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (entry.stopped) return false;
      try {
        await handlerOf.run(entry, () => entry.handler(changes));
        return true;
      } catch (error) {
        if (attempt === this.#maxAttempts) {
          this.dropped += 1;
          try {
            entry.onPoison?.(changes, error);
          } catch {
            // A failing callback must not stop the consumer.
          }
          return true;
        }
        await this.#sleep(entry, Math.min(this.#retryDelayMs * 2 ** (attempt - 1), 5_000));
      }
    }
    return true;
  }

  #sleep(entry: Consumer, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        entry.wake = undefined;
        resolve();
      }
      entry.wake = done;
    });
  }

  #read(name: string): { changes: DocumentChange[]; last: number } | undefined {
    const checkpoint = this.#db.get("SELECT checkpoint FROM rv_doc_consumer WHERE name = ?", name);
    if (checkpoint === undefined) return undefined;
    const rows = this.#db.all("SELECT seq, kind, cause, pk, sk, before_doc, after_doc FROM rv_doc_change WHERE seq > ? ORDER BY seq LIMIT ?", Number(checkpoint.checkpoint), this.#batchSize);
    const changes = rows.map((row): DocumentChange => ({
      sequence: sequenceOf(row.seq as number),
      kind: row.kind as DocumentChange["kind"],
      cause: row.cause as DocumentChange["cause"],
      key: { pk: row.pk as string, sk: row.sk as string },
      ...(row.before_doc === null ? {} : { before: JSON.parse(row.before_doc as string) as StoredDocument }),
      ...(row.after_doc === null ? {} : { after: JSON.parse(row.after_doc as string) as StoredDocument }),
    }));
    return { changes, last: rows.length === 0 ? 0 : Number(rows[rows.length - 1]!.seq) };
  }

  /** Deletes the log rows every consumer has handled. Call inside a write. */
  #prune(): void {
    this.#db.run("DELETE FROM rv_doc_change WHERE seq <= COALESCE((SELECT MIN(checkpoint) FROM rv_doc_consumer), (SELECT COALESCE(MAX(seq), 0) FROM rv_doc_change))");
  }
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} is a number of at least 1`);
  return value;
}
