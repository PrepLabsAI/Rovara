// Port lane P6 (item L2, owner decision 60): Code's `audit-sink` adapter, a small local append-only audit log on SQLite. It makes the rule "audit before add" (lessons design M6) hold in Code
// as it does in Cloud: a change that is audited is written to the log, durably, before the change is made. Code's default sink writes nothing, so without this the rule is either
// impossible or silently skipped.
//
// What it is: one table, `audit_events`, that only grows. SQLite triggers refuse every UPDATE and DELETE (the log cannot be changed through this connection or any other that opens the
// file with these triggers present; a person with the file and a SQLite shell can still drop them, which is why each row also holds a hash of the one before it and `verify()` checks the
// chain). It is a local record for the machine's owner, not a tamper-proof ledger: Cloud's ledger, its verifier and its outbox stay Cloud only (decision 41).
//
// How it meets the port: `record` writes the event and resolves when it is durable (default `synchronous = FULL`). `stage` writes the event too, BEFORE the caller's transaction is made
// (the audit comes first), and returns no transaction steps, because this sink writes somewhere else. So a change that is later refused still leaves its record: an attempt is audited
// as well as a success. Recording an `eventId` twice records it once. A write that fails throws, and the change is not made.
import { createHash } from "node:crypto";
import {
  canonicalJson,
  type AuditEvent,
  type AuditSink,
  type TransactItem,
} from "@agentx/contracts";
import { SqliteDatabase, storableText, type SqliteDatabaseOptions, type SqliteRow } from "./sqlite-database.js";

const SCHEMA_VERSION = "1";
const GENESIS_HASH = "0".repeat(64);
const ACTION = /^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/;
/** The most bytes of an event's details. A record is facts for a reader, not a document store. */
export const AUDIT_DETAILS_MAX_BYTES = 16 * 1_024;

/** The log could not take the event (a bad event, or a failed write). The change it was to record must not be made. */
export class AuditLogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuditLogError";
  }
}

export interface StoredAuditEvent extends AuditEvent {
  /** Its place in the log, from 1. */
  seq: number;
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  /** How many rows were checked. */
  checked: number;
  /** The first row whose hash or link does not match, when not ok. */
  brokenAt?: number;
}

export interface SqliteAuditLogOptions {
  database: SqliteDatabase;
}

export interface OpenSqliteAuditLogOptions extends Omit<SqliteDatabaseOptions, "path"> {
  path: string;
}

function eventHash(previous: string, event: AuditEvent): string {
  return createHash("sha256").update(previous).update("\n").update(canonicalJson(event)).digest("hex");
}

function rowEvent(row: SqliteRow): StoredAuditEvent {
  const event: StoredAuditEvent = {
    seq: Number(row.seq),
    hash: String(row.hash),
    eventId: String(row.event_id),
    companyId: String(row.company_id),
    at: String(row.at),
    actor: JSON.parse(String(row.actor)) as AuditEvent["actor"],
    action: String(row.action),
  };
  if (row.subject !== null) event.subject = JSON.parse(String(row.subject)) as NonNullable<AuditEvent["subject"]>;
  if (row.details !== null) event.details = JSON.parse(String(row.details)) as NonNullable<AuditEvent["details"]>;
  return event;
}

function checked(event: AuditEvent): void {
  const text = (value: unknown, label: string, max: number): void => {
    if (typeof value !== "string" || value.length === 0 || value.length > max || !storableText(value)) throw new AuditLogError(`the audit event's ${label} is not usable`);
  };
  text(event.eventId, "eventId", 256);
  text(event.companyId, "companyId", 128);
  text(event.at, "time", 64);
  if (Number.isNaN(Date.parse(event.at))) throw new AuditLogError("the audit event's time is not a time");
  text(event.actor?.id, "actor", 256);
  if (event.actor.type !== "person" && event.actor.type !== "agent" && event.actor.type !== "system") throw new AuditLogError("the audit event's actor type is not known");
  text(event.action, "action", 128);
  if (!ACTION.test(event.action)) throw new AuditLogError("the audit event's action is dotted lower-case words");
  if (event.details !== undefined && Buffer.byteLength(JSON.stringify(event.details)) > AUDIT_DETAILS_MAX_BYTES) throw new AuditLogError(`the audit event's details are over ${String(AUDIT_DETAILS_MAX_BYTES)} bytes`);
}

export class SqliteAuditLog implements AuditSink {
  readonly #db: SqliteDatabase;
  readonly #owned: boolean;

  private constructor(database: SqliteDatabase, owned: boolean) {
    this.#db = database;
    this.#owned = owned;
    this.#migrate();
  }

  /** Opens (and creates) the log's own database file. */
  static open(options: OpenSqliteAuditLogOptions): SqliteAuditLog {
    return new SqliteAuditLog(new SqliteDatabase(options), true);
  }

  /** Uses a connection the caller owns; `close()` leaves it open. */
  static over(options: SqliteAuditLogOptions): SqliteAuditLog {
    return new SqliteAuditLog(options.database, false);
  }

  #migrate(): void {
    this.#db.write(() => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS audit_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS audit_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          company_id TEXT NOT NULL,
          at TEXT NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          subject TEXT,
          details TEXT,
          prev_hash TEXT NOT NULL,
          hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audit_events_by_company ON audit_events (company_id, seq);
        CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
      `);
      const version = this.#db.get("SELECT value FROM audit_meta WHERE key = 'schema'");
      if (version === undefined) this.#db.run("INSERT INTO audit_meta (key, value) VALUES ('schema', ?)", SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new AuditLogError("the audit log was made by a different version of Rovara");
    });
  }

  /** Appends the event; a second call with the same `eventId` appends nothing. Resolves (returns) when the row is committed. */
  #append(event: AuditEvent): void {
    checked(event);
    // The stored form is exactly what the hash covers: keys in a fixed order, no undefined.
    const stored: AuditEvent = {
      eventId: event.eventId,
      companyId: event.companyId,
      at: event.at,
      actor: { type: event.actor.type, id: event.actor.id },
      action: event.action,
      ...(event.subject === undefined ? {} : { subject: event.subject }),
      ...(event.details === undefined ? {} : { details: event.details }),
    };
    try {
      this.#db.write(() => {
        if (this.#db.get("SELECT 1 AS present FROM audit_events WHERE event_id = ?", stored.eventId) !== undefined) return;
        const last = this.#db.get("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1");
        const previous = last === undefined ? GENESIS_HASH : String(last.hash);
        this.#db.run(
          "INSERT INTO audit_events (event_id, company_id, at, actor, action, subject, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          stored.eventId, stored.companyId, stored.at, JSON.stringify(stored.actor), stored.action,
          stored.subject === undefined ? null : JSON.stringify(stored.subject), stored.details === undefined ? null : JSON.stringify(stored.details),
          previous, eventHash(previous, stored),
        );
      });
    } catch (error) {
      throw error instanceof AuditLogError ? error : new AuditLogError("the audit log could not be written", { cause: error });
    }
  }

  stage(event: AuditEvent): readonly TransactItem[] {
    this.#append(event);
    return [];
  }

  record(event: AuditEvent): Promise<void> {
    try {
      this.#append(event);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new AuditLogError("the audit log could not be written"));
    }
  }

  /** A company's events, oldest first, after `afterSeq` (default: from the start). */
  read(options: { companyId: string; afterSeq?: number; limit?: number }): StoredAuditEvent[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
    return this.#db.all("SELECT * FROM audit_events WHERE company_id = ? AND seq > ? ORDER BY seq LIMIT ?", options.companyId, options.afterSeq ?? 0, limit).map(rowEvent);
  }

  /** Checks every row's hash and its link to the row before. */
  verify(): AuditVerification {
    let previous = GENESIS_HASH;
    let count = 0;
    for (const row of this.#db.all("SELECT * FROM audit_events ORDER BY seq")) {
      const { seq, hash, ...event } = rowEvent(row);
      count += 1;
      if (row.prev_hash !== previous || hash !== eventHash(previous, event)) return { ok: false, checked: count, brokenAt: seq };
      previous = hash;
    }
    return { ok: true, checked: count };
  }

  close(): void {
    if (this.#owned) this.#db.close();
  }
}
