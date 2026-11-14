// Port lane L3: the local Queue, on SQLite tables that the consumer polls.
//
// The behaviour is the in-memory fake's, made durable: at-least-once delivery, a visibility timeout and a receipt handle per delivery
// (a stale handle is refused), delay, duplicate suppression inside the 5 minute window, `maxReceiveCount` dead-lettering, dead letters
// that keep their id and can be listed, redriven or discarded, and ordered groups. Every operation is one write transaction, so a
// crash leaves a message either as it was or as the operation made it. `receive` is a poll; with `waitSeconds` it polls again until
// something arrives, and a message enqueued by this process wakes the wait at once.
import { randomUUID } from "node:crypto";
import {
  QUEUE_LIMITS,
  type DeadLetter,
  type EnqueueResult,
  type Queue,
  type QueueCapabilities,
  type QueueMessageInput,
  type QueueOptions,
  type QueueService,
  type ReceiveOptions,
  type ReceivedMessage,
} from "@agentx/contracts";
import { SqliteDatabase, SqliteFailure, storableText, type SqliteDatabaseOptions, type SqliteRow } from "./sqlite-database.js";

const SCHEMA_VERSION = "1";

/** The queue's database failed (busy, full disk, damaged file), as opposed to a caller's mistake. Retrying later is reasonable. */
export class QueueStorageError extends Error {
  readonly retryable = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QueueStorageError";
  }
}

export interface SqliteQueueServiceOptions {
  /** The connection to use. The service does not close a connection it was given. */
  database: SqliteDatabase;
  /** Milliseconds since the epoch. Default: the real clock. */
  now?: () => number;
  /** How often a waiting `receive` looks again. Default 250. */
  pollMs?: number;
}

export type SqliteQueueServiceOpenOptions = Omit<SqliteQueueServiceOptions, "database"> & SqliteDatabaseOptions;

const MESSAGE_COLUMNS = "seq, message_id, body, attributes, group_id, enqueued_at, receive_count";

export class SqliteQueueService implements QueueService {
  readonly #db: SqliteDatabase;
  readonly #ownsDatabase: boolean;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #queues = new Map<string, SqliteQueue>();
  readonly #waiters = new Set<() => void>();
  #closed = false;

  /** Opens (and creates) the database file and a queue service over it. `close()` closes the file. */
  static open(options: SqliteQueueServiceOpenOptions): SqliteQueueService {
    const { path, busyTimeoutMs, synchronous, ...rest } = options;
    const database = new SqliteDatabase({ path, ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }), ...(synchronous === undefined ? {} : { synchronous }) });
    try {
      return new SqliteQueueService({ ...rest, database }, true);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  constructor(options: SqliteQueueServiceOptions, ownsDatabase = false) {
    this.#db = options.database;
    this.#ownsDatabase = ownsDatabase;
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? 250;
    if (!Number.isFinite(this.#pollMs) || this.#pollMs < 1) throw new Error("pollMs is a number of at least 1");
    storage(() => this.#initialise());
  }

  async queue(name: string, options: QueueOptions = {}): Promise<Queue> {
    if (this.#closed) throw new QueueStorageError("the queue service is closed");
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error("a queue name is 1 to 80 letters, digits, dots, hyphens or underscores");
    checkOptions(options);
    let queue = this.#queues.get(name);
    if (queue === undefined) {
      queue = new SqliteQueue(name, options, this.#db, this.#now, this.#pollMs, this.#waiters);
      this.#queues.set(name, queue);
    } else if (Object.keys(options).length > 0 && JSON.stringify(sorted(options)) !== JSON.stringify(sorted(queue.options))) {
      // Options belong to where the queue is declared (each start-up of the process), not to whoever asks first.
      throw new Error("that queue is already declared with different options");
    }
    return queue;
  }

  /** Wakes every waiting `receive` and closes the file if this service opened it. Safe to call twice. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const wake of [...this.#waiters]) wake();
    if (this.#ownsDatabase) this.#db.close();
  }

  #initialise(): void {
    const db = this.#db;
    db.write(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rv_queue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS rv_queue_message (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          queue TEXT NOT NULL,
          message_id TEXT NOT NULL,
          body TEXT NOT NULL,
          attributes TEXT NOT NULL,
          group_id TEXT,
          enqueued_at INTEGER NOT NULL,
          visible_at INTEGER NOT NULL,
          receive_count INTEGER NOT NULL,
          receipt TEXT
        );
        CREATE INDEX IF NOT EXISTS rv_queue_message_visible ON rv_queue_message (queue, visible_at, seq);
        CREATE INDEX IF NOT EXISTS rv_queue_message_group ON rv_queue_message (queue, group_id, seq) WHERE group_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS rv_queue_message_receipt ON rv_queue_message (receipt) WHERE receipt IS NOT NULL;
        CREATE TABLE IF NOT EXISTS rv_queue_dead (
          dseq INTEGER PRIMARY KEY AUTOINCREMENT,
          queue TEXT NOT NULL,
          message_id TEXT NOT NULL,
          body TEXT NOT NULL,
          attributes TEXT NOT NULL,
          group_id TEXT,
          enqueued_at INTEGER NOT NULL,
          receive_count INTEGER NOT NULL,
          reason TEXT NOT NULL,
          dead_lettered_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS rv_queue_dead_id ON rv_queue_dead (queue, message_id);
        CREATE TABLE IF NOT EXISTS rv_queue_dedupe (
          queue TEXT NOT NULL,
          dedupe_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          PRIMARY KEY (queue, dedupe_id)
        ) WITHOUT ROWID;
      `);
      const version = db.get("SELECT value FROM rv_queue_meta WHERE key = 'schema'");
      if (version === undefined) db.run("INSERT INTO rv_queue_meta (key, value) VALUES ('schema', ?)", SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new QueueStorageError(`the database file was written by a newer version of the queue (schema ${String(version.value)})`);
    });
  }
}

const sorted = (options: QueueOptions): Record<string, unknown> => Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));

function checkOptions(options: QueueOptions): void {
  const { visibilityTimeoutSeconds, maxReceiveCount, ordered } = options;
  if (visibilityTimeoutSeconds !== undefined && (!Number.isFinite(visibilityTimeoutSeconds) || visibilityTimeoutSeconds < 0 || visibilityTimeoutSeconds > QUEUE_LIMITS.maxSeconds)) throw new Error("visibilityTimeoutSeconds is out of range");
  if (maxReceiveCount !== undefined && (!Number.isInteger(maxReceiveCount) || maxReceiveCount < 1)) throw new Error("maxReceiveCount is a whole number of at least 1");
  if (ordered !== undefined && typeof ordered !== "boolean") throw new Error("ordered is true or false");
}

/** Runs database work, turning the database's own failures into a `QueueStorageError`; a caller's mistake passes through. */
function storage<T>(body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (error instanceof SqliteFailure) throw new QueueStorageError(error.busy ? "the queue database is busy: another connection holds its lock" : `the queue database failed (${error.message})`, { cause: error });
    throw error;
  }
}

function plainText(value: string, what: string): string {
  if (typeof value !== "string" || !storableText(value)) throw new Error(`${what} must be text without an unpaired surrogate or a NUL character`);
  return value;
}

class SqliteQueue implements Queue {
  readonly capabilities: QueueCapabilities = { ordered: true, dedupe: true, maxDelaySeconds: QUEUE_LIMITS.maxSeconds, detectsStaleHandle: true, deadLettersById: true };

  constructor(
    readonly name: string,
    readonly options: QueueOptions,
    private readonly db: SqliteDatabase,
    private readonly now: () => number,
    private readonly pollMs: number,
    private readonly waiters: Set<() => void>,
  ) {}

  async enqueue(input: QueueMessageInput): Promise<EnqueueResult> {
    const body = JSON.stringify(input.body);
    if (body === undefined) throw new Error("a message body must be JSON");
    if (new TextEncoder().encode(body).length > QUEUE_LIMITS.maxBodyBytes) throw new Error(`a message body is at most ${QUEUE_LIMITS.maxBodyBytes} bytes`);
    const delay = input.delaySeconds ?? 0;
    if (!Number.isFinite(delay) || delay < 0 || delay > this.capabilities.maxDelaySeconds) throw new Error("delaySeconds is out of range");
    const attributes = input.attributes ?? {};
    for (const [key, value] of Object.entries(attributes)) if (typeof value !== "string") throw new Error(`attribute ${key} must be text`);
    const groupId = input.groupId === undefined ? null : plainText(input.groupId, "groupId");
    const dedupeId = input.dedupeId === undefined ? undefined : plainText(input.dedupeId, "dedupeId");
    const result = storage(() => this.db.write((): EnqueueResult => {
      const now = this.now();
      if (dedupeId !== undefined) {
        this.db.run("DELETE FROM rv_queue_dedupe WHERE queue = ? AND at < ?", this.name, now - QUEUE_LIMITS.dedupeWindowSeconds * 1_000);
        const seen = this.db.get("SELECT message_id FROM rv_queue_dedupe WHERE queue = ? AND dedupe_id = ?", this.name, dedupeId);
        if (seen !== undefined) return { messageId: seen.message_id as string, duplicate: true };
      }
      const messageId = randomUUID();
      if (dedupeId !== undefined) this.db.run("INSERT INTO rv_queue_dedupe (queue, dedupe_id, message_id, at) VALUES (?, ?, ?, ?)", this.name, dedupeId, messageId, now);
      this.db.run(
        "INSERT INTO rv_queue_message (queue, message_id, body, attributes, group_id, enqueued_at, visible_at, receive_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
        this.name, messageId, body, JSON.stringify(attributes), groupId, now, now + delay * 1_000,
      );
      return { messageId, duplicate: false };
    }));
    if (!result.duplicate) this.#wake();
    return result;
  }

  async receive(options: ReceiveOptions = {}): Promise<ReceivedMessage[]> {
    const max = options.maxMessages ?? 1;
    if (!Number.isInteger(max) || max < 1 || max > QUEUE_LIMITS.maxReceive) throw new Error(`maxMessages is 1 to ${QUEUE_LIMITS.maxReceive}`);
    const hideFor = options.visibilityTimeoutSeconds ?? this.options.visibilityTimeoutSeconds ?? 30;
    if (!Number.isFinite(hideFor) || hideFor < 0 || hideFor > QUEUE_LIMITS.maxSeconds) throw new Error("visibilityTimeoutSeconds is out of range");
    const wait = options.waitSeconds ?? 0;
    if (!Number.isFinite(wait) || wait < 0 || wait > QUEUE_LIMITS.maxSeconds) throw new Error("waitSeconds is out of range");
    const deadline = Date.now() + wait * 1_000;
    for (;;) {
      const received = this.#receiveOnce(max, hideFor);
      if (received.length > 0 || Date.now() >= deadline) return received;
      await this.#sleep(Math.min(this.pollMs, deadline - Date.now()));
    }
  }

  async ack(receiptHandle: string): Promise<boolean> {
    return storage(() => this.db.run("DELETE FROM rv_queue_message WHERE queue = ? AND receipt = ?", this.name, plainText(receiptHandle, "the receipt handle")) > 0);
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<boolean> {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > QUEUE_LIMITS.maxSeconds) throw new Error("seconds is out of range");
    const changed = storage(() => this.db.run("UPDATE rv_queue_message SET visible_at = ? WHERE queue = ? AND receipt = ?", this.now() + seconds * 1_000, this.name, plainText(receiptHandle, "the receipt handle")) > 0);
    if (changed && seconds === 0) this.#wake();
    return changed;
  }

  async deadLetter(receiptHandle: string, reason: string): Promise<boolean> {
    plainText(reason, "the reason");
    return storage(() => this.db.write(() => {
      const row = this.db.get(`SELECT ${MESSAGE_COLUMNS} FROM rv_queue_message WHERE queue = ? AND receipt = ?`, this.name, plainText(receiptHandle, "the receipt handle"));
      if (row === undefined) return false;
      this.#bury(row, reason, this.now());
      this.db.run("DELETE FROM rv_queue_message WHERE seq = ?", row.seq as number);
      return true;
    }));
  }

  async listDeadLetters(options: { limit?: number; cursor?: string } = {}): Promise<{ items: DeadLetter[]; cursor?: string }> {
    this.#sweepDead();
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("limit is 1 to 1000");
    let after = 0;
    if (options.cursor !== undefined) {
      after = Number(options.cursor);
      if (!/^\d{1,15}$/.test(options.cursor) || !Number.isSafeInteger(after)) throw new Error("that cursor is not valid");
    }
    const rows = storage(() => this.db.all("SELECT dseq, message_id, body, attributes, receive_count, reason, dead_lettered_at FROM rv_queue_dead WHERE queue = ? AND dseq > ? ORDER BY dseq LIMIT ?", this.name, after, limit + 1));
    const items = rows.slice(0, limit).map((row): DeadLetter => ({
      messageId: row.message_id as string,
      body: JSON.parse(row.body as string) as DeadLetter["body"],
      attributes: JSON.parse(row.attributes as string) as Record<string, string>,
      receiveCount: row.receive_count as number,
      deadLetteredAt: new Date(row.dead_lettered_at as number).toISOString(),
      reason: row.reason as string,
    }));
    return rows.length > limit ? { items, cursor: String(rows[limit - 1]!.dseq) } : { items };
  }

  async redrive(messageId: string): Promise<boolean> {
    const done = storage(() => this.db.write(() => {
      const row = this.db.get("SELECT dseq, message_id, body, attributes, group_id, enqueued_at FROM rv_queue_dead WHERE queue = ? AND message_id = ? ORDER BY dseq LIMIT 1", this.name, plainText(messageId, "the message id"));
      if (row === undefined) return false;
      this.db.run("DELETE FROM rv_queue_dead WHERE dseq = ?", row.dseq as number);
      this.db.run(
        "INSERT INTO rv_queue_message (queue, message_id, body, attributes, group_id, enqueued_at, visible_at, receive_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
        this.name, row.message_id as string, row.body as string, row.attributes as string, (row.group_id as string | null) ?? null, row.enqueued_at as number, this.now(),
      );
      return true;
    }));
    if (done) this.#wake();
    return done;
  }

  async discardDeadLetter(messageId: string): Promise<boolean> {
    return storage(() => this.db.write(() => {
      const row = this.db.get("SELECT dseq FROM rv_queue_dead WHERE queue = ? AND message_id = ? ORDER BY dseq LIMIT 1", this.name, plainText(messageId, "the message id"));
      if (row === undefined) return false;
      this.db.run("DELETE FROM rv_queue_dead WHERE dseq = ?", row.dseq as number);
      return true;
    }));
  }

  /** One poll: dead-letter what has used up its receives, then take the visible messages (one write transaction). */
  #receiveOnce(max: number, hideFor: number): ReceivedMessage[] {
    // An idle poll reads only: the write lock is taken when there is something visible to take (or to dead-letter).
    if (storage(() => this.db.get("SELECT 1 AS one FROM rv_queue_message WHERE queue = ? AND visible_at <= ? LIMIT 1", this.name, this.now())) === undefined) return [];
    return storage(() => this.db.write(() => {
      const now = this.now();
      this.#sweepDeadIn(now);
      // On an ordered queue only the first message of a group can be delivered, and not while it is hidden (in flight or delayed).
      const ordered = this.options.ordered === true;
      const rows = this.db.all(
        `SELECT ${MESSAGE_COLUMNS} FROM rv_queue_message m WHERE queue = ? AND visible_at <= ?${ordered ? " AND (group_id IS NULL OR seq = (SELECT MIN(seq) FROM rv_queue_message g WHERE g.queue = m.queue AND g.group_id = m.group_id))" : ""} ORDER BY seq LIMIT ?`,
        this.name, now, max,
      );
      return rows.map((row): ReceivedMessage => {
        const receipt = randomUUID();
        const count = (row.receive_count as number) + 1;
        this.db.run("UPDATE rv_queue_message SET receive_count = ?, visible_at = ?, receipt = ? WHERE seq = ?", count, now + hideFor * 1_000, receipt, row.seq as number);
        return {
          messageId: row.message_id as string,
          receiptHandle: receipt,
          body: JSON.parse(row.body as string) as ReceivedMessage["body"],
          attributes: JSON.parse(row.attributes as string) as Record<string, string>,
          receiveCount: count,
          enqueuedAt: new Date(row.enqueued_at as number).toISOString(),
          ...(row.group_id === null ? {} : { groupId: row.group_id as string }),
        };
      });
    }));
  }

  #sweepDead(): void {
    storage(() => this.db.write(() => this.#sweepDeadIn(this.now())));
  }

  /** A message that has used up its receives and is visible again goes to the dead letters instead of being delivered. */
  #sweepDeadIn(now: number): void {
    const limit = this.options.maxReceiveCount;
    if (limit === undefined) return;
    const rows = this.db.all(`SELECT ${MESSAGE_COLUMNS} FROM rv_queue_message WHERE queue = ? AND receive_count >= ? AND visible_at <= ? ORDER BY seq`, this.name, limit, now);
    for (const row of rows) {
      this.#bury(row, "max_receives", now);
      this.db.run("DELETE FROM rv_queue_message WHERE seq = ?", row.seq as number);
    }
  }

  #bury(row: SqliteRow, reason: string, at: number): void {
    this.db.run(
      "INSERT INTO rv_queue_dead (queue, message_id, body, attributes, group_id, enqueued_at, receive_count, reason, dead_lettered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      this.name, row.message_id as string, row.body as string, row.attributes as string, (row.group_id as string | null) ?? null, row.enqueued_at as number, row.receive_count as number, reason, at,
    );
  }

  #wake(): void {
    for (const wake of [...this.waiters]) wake();
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.waiters;
      const timer = setTimeout(done, Math.max(1, ms));
      function done(): void {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      }
      waiters.add(done);
    });
  }
}
