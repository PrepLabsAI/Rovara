// Port lane L3: the one place that touches `node:sqlite`.
//
// Why node:sqlite and not better-sqlite3: it ships inside Node (22.5 and later; the repository pins >=22.19 <23), so there is nothing to
// download or compile on macOS or Linux, arm64 or x64, and no new dependency to review. Its SQLite is 3.51 with WAL and row values.
// The costs: Node marks it "active development" (1.1) and prints an ExperimentalWarning once at first use, and its API could change in a
// later Node line. Everything that depends on those two facts is in this file, so moving to better-sqlite3 later means rewriting
// this file only (the surface is `exec`, `run`, `get`, `all`, `write`, `close`, with the same synchronous behaviour).
//
// One connection is one process's view of the file. Calls are synchronous, so two calls in one process never interleave.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export type SqliteValue = string | number | bigint | null;
export type SqliteRow = Record<string, SqliteValue | Uint8Array>;

export interface SqliteDatabaseOptions {
  /** A file path, or `:memory:` (one connection only: a second `:memory:` connection is a different database). */
  path: string;
  /** How long a write waits for another connection's lock before it fails as busy. Default 5000. The wait blocks this process. */
  busyTimeoutMs?: number;
  /**
   * `FULL` (default): every commit is flushed before it returns, so a power cut cannot lose an acknowledged commit.
   * `NORMAL`: faster; a process crash still loses nothing, but a power cut or OS crash can lose the last commits (never corrupt the file).
   */
  synchronous?: "FULL" | "NORMAL";
}

/** SQLite's primary result codes that matter to a caller. */
export const SQLITE_BUSY = 5;
export const SQLITE_LOCKED = 6;

/** A failure of the database itself (full disk, lock timeout, corrupt file), as opposed to a caller's mistake. */
export class SqliteFailure extends Error {
  constructor(message: string, readonly code: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SqliteFailure";
  }
  /** Another connection held the write lock longer than the busy timeout. Retrying later is reasonable. */
  get busy(): boolean {
    return this.code === SQLITE_BUSY || this.code === SQLITE_LOCKED;
  }
}

function asFailure(error: unknown): SqliteFailure {
  if (error instanceof SqliteFailure) return error;
  const detail = error as { errcode?: unknown; message?: unknown } | null;
  const extended = typeof detail?.errcode === "number" ? detail.errcode : 1;
  const message = typeof detail?.message === "string" ? detail.message : "the database failed";
  return new SqliteFailure(message, extended & 0xff, { cause: error });
}

/** Text that SQLite would change on the way in: an unpaired surrogate becomes U+FFFD, and a NUL cuts the text short when it is read back. */
export function storableText(value: string): boolean {
  return !UNPAIRED_SURROGATE.test(value) && !value.includes("\u0000");
}
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const STATEMENT_CACHE_LIMIT = 256;

function openConnection(options: SqliteDatabaseOptions): DatabaseSync {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 600_000) throw new Error("busyTimeoutMs is a whole number from 0 to 600000");
  const synchronous = options.synchronous ?? "FULL";
  if (synchronous !== "FULL" && synchronous !== "NORMAL") throw new Error("synchronous is FULL or NORMAL");
  const inMemory = options.path === ":memory:";
  let db: DatabaseSync | undefined;
  try {
    if (!inMemory) {
      // Only the owner may read the file: it holds task state. SQLite gives the -wal and -shm files the same mode as the main file.
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
      closeSync(openSync(options.path, "a", 0o600));
      chmodSync(options.path, 0o600);
      // Side files left by an earlier run keep the mode they were made with; make them private too.
      for (const suffix of ["-wal", "-shm"]) {
        try {
          chmodSync(options.path + suffix, 0o600);
        } catch {
          // There is none yet; SQLite will make it with the main file's mode.
        }
      }
    }
    db = new DatabaseSync(options.path);
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    if (!inMemory) {
      // WAL lets readers go on while a write commits. A file system that cannot do it (some network shares) answers with another mode.
      const mode = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | undefined;
      if (mode?.journal_mode !== "wal") throw new Error("the file system does not support SQLite's WAL mode; keep the database on a local disk");
    }
    db.exec(`PRAGMA synchronous = ${synchronous}`);
    // The key order of text is the code point order of the UTF-8 bytes (document-semantics.ts `compareText`): BINARY collation on UTF-8 text.
    const encoding = db.prepare("PRAGMA encoding").get() as { encoding?: string } | undefined;
    if (encoding?.encoding !== "UTF-8") throw new Error("the database file is not UTF-8 text");
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Nothing more to do with a connection that did not open.
    }
    throw asFailure(error);
  }
}

export class SqliteDatabase {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #depth = 0;
  #closed = false;

  constructor(options: SqliteDatabaseOptions) {
    this.path = options.path;
    this.#db = openConnection(options);
  }

  /** Runs statements with no parameters and no result (schema set-up). */
  exec(sql: string): void {
    this.#guard();
    try {
      this.#db.exec(sql);
    } catch (error) {
      throw asFailure(error);
    }
  }

  /** Runs one statement; returns how many rows it changed. */
  run(sql: string, ...params: SqliteValue[]): number {
    this.#guard();
    try {
      return Number(this.#statement(sql).run(...(params as SQLInputValue[])).changes);
    } catch (error) {
      throw asFailure(error);
    }
  }

  get(sql: string, ...params: SqliteValue[]): SqliteRow | undefined {
    this.#guard();
    try {
      return this.#statement(sql).get(...(params as SQLInputValue[]));
    } catch (error) {
      throw asFailure(error);
    }
  }

  all(sql: string, ...params: SqliteValue[]): SqliteRow[] {
    this.#guard();
    try {
      return this.#statement(sql).all(...(params as SQLInputValue[]));
    } catch (error) {
      throw asFailure(error);
    }
  }

  /**
   * Runs `body` as one write transaction: all of it commits or none of it. The write lock is taken at the start (`BEGIN IMMEDIATE`), so
   * the busy timeout applies there and a transaction never fails half way on a lock upgrade. A call inside another `write` joins it.
   */
  write<T>(body: () => T): T {
    this.#guard();
    if (this.#depth > 0) return body();
    try {
      this.#db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw asFailure(error);
    }
    this.#depth += 1;
    let result: T;
    try {
      result = body();
    } catch (error) {
      this.#depth -= 1;
      this.#rollback();
      throw error;
    }
    this.#depth -= 1;
    try {
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw asFailure(error);
    }
    return result;
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    this.#db.close();
  }

  #rollback(): void {
    try {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
    } catch {
      // The original error is the one to report; a failed rollback leaves the transaction to be undone when the connection closes.
    }
  }

  #guard(): void {
    if (this.#closed) throw new SqliteFailure("the database is closed", 14);
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      if (this.#statements.size >= STATEMENT_CACHE_LIMIT) this.#statements.clear();
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
}
