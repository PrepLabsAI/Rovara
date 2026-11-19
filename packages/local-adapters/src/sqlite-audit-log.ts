// Port lane P6 (item L2, owner decision 60): the append-only, hash-chained COPY of Code's audit trail, in its own SQLite file (audit.db). It is not the audit sink: the record that commits with a change is
// the `AUDIT#` row `DocumentAuditSink` stages into the caller's transaction. This copy is fed from COMMITTED rows only (`startAuditCopy`, through the store's change feed), so it never holds a record of a
// change that did not happen.
//
// What it is: one table, `audit_events`, that only grows. SQLite triggers refuse every UPDATE and DELETE (the log cannot be changed through this connection or any other that opens the file with these
// triggers present; a person with the file and a SQLite shell can still drop them). Each row holds a hash of the one before it, and `verify()` checks the chain and, given the anchor the feeder keeps in the
// document store (the row count and newest hash), that no newer rows were cut off. It is a local record for the machine's owner, not a tamper-proof ledger: Cloud's ledger, its verifier and its outbox stay
// Cloud only (decision 41).
import { createHash } from "node:crypto";
import { canonicalJson, type AuditEvent } from "@agentx/contracts";
import { AuditLogError, auditDigest, checkAuditEvent, storedAuditEvent } from "./audit-event.js";
import { SqliteDatabase, type SqliteDatabaseOptions, type SqliteRow } from "./sqlite-database.js";

export { AUDIT_DETAILS_MAX_BYTES, AuditLogError } from "./audit-event.js";

const SCHEMA_VERSION = "2";
const GENESIS_HASH = "0".repeat(64);

export interface StoredAuditEvent extends AuditEvent {
  /** Its place in the log, from 1. */
  seq: number;
  hash: string;
}

export interface AuditAnchor {
  /** How many rows the feeder had appended. */
  count: number;
  /** The hash of the newest of them. */
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  /** How many rows were checked. */
  checked: number;
  /** The first row whose hash or link does not match, when not ok. */
  brokenAt?: number;
  /** Set when the chain is intact but does not agree with the anchor: rows were cut off, or the anchored row differs. */
  anchor?: "behind" | "mismatch";
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

export class SqliteAuditLog {
  readonly #db: SqliteDatabase;

  private constructor(database: SqliteDatabase) {
    this.#db = database;
    this.#migrate();
  }

  /** Opens (and creates) the copy's own database file. */
  static open(options: OpenSqliteAuditLogOptions): SqliteAuditLog {
    return new SqliteAuditLog(new SqliteDatabase(options));
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
          digest TEXT NOT NULL,
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

  /**
   * Appends a committed event. An event id seen before with the same facts appends nothing (the feed delivers at least once); the same id with other facts throws, because the primary refuses that and a
   * copy that disagrees has been tampered with.
   */
  append(event: AuditEvent): void {
    checkAuditEvent(event);
    const stored = storedAuditEvent(event);
    const digest = auditDigest(stored);
    try {
      this.#db.write(() => {
        const existing = this.#db.get("SELECT digest FROM audit_events WHERE event_id = ?", stored.eventId);
        if (existing !== undefined) {
          if (existing.digest !== digest) throw new AuditLogError("the audit copy already holds this event id for other facts");
          return;
        }
        const last = this.#db.get("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1");
        const previous = last === undefined ? GENESIS_HASH : String(last.hash);
        this.#db.run(
          "INSERT INTO audit_events (event_id, company_id, at, actor, action, subject, details, digest, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          stored.eventId, stored.companyId, stored.at, JSON.stringify(stored.actor), stored.action,
          stored.subject === undefined ? null : JSON.stringify(stored.subject), stored.details === undefined ? null : JSON.stringify(stored.details),
          digest, previous, eventHash(previous, stored),
        );
      });
    } catch (error) {
      throw error instanceof AuditLogError ? error : new AuditLogError("the audit log could not be written", { cause: error });
    }
  }

  /** The ids of every event the copy holds. */
  eventIds(): Set<string> {
    return new Set(this.#db.all("SELECT event_id FROM audit_events").map((row) => String(row.event_id)));
  }

  /** The number of rows and the newest hash: what the feeder anchors. */
  head(): AuditAnchor {
    const count = this.#db.get("SELECT COUNT(*) AS n FROM audit_events");
    const last = this.#db.get("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1");
    return { count: Number(count?.n ?? 0), hash: last === undefined ? GENESIS_HASH : String(last.hash) };
  }

  /** A company's events, oldest first, after `afterSeq` (default: from the start). */
  read(options: { companyId: string; afterSeq?: number; limit?: number }): StoredAuditEvent[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
    return this.#db.all("SELECT * FROM audit_events WHERE company_id = ? AND seq > ? ORDER BY seq LIMIT ?", options.companyId, options.afterSeq ?? 0, limit).map(rowEvent);
  }

  /**
   * Checks every row's hash and its link to the row before. With an `anchor`, also that the log is not shorter than the anchor says and that the row the anchor names has the hash it recorded. A log that
   * is LONGER than the anchor is fine: the feeder writes the anchor after the rows.
   */
  verify(anchor?: AuditAnchor): AuditVerification {
    let previous = GENESIS_HASH;
    let count = 0;
    let anchored: string | undefined;
    for (const row of this.#db.all("SELECT * FROM audit_events ORDER BY seq")) {
      const { seq, hash, ...event } = rowEvent(row);
      count += 1;
      if (row.prev_hash !== previous || hash !== eventHash(previous, event)) return { ok: false, checked: count, brokenAt: seq };
      previous = hash;
      if (anchor !== undefined && count === anchor.count) anchored = hash;
    }
    if (anchor !== undefined && anchor.count > 0) {
      if (count < anchor.count) return { ok: false, checked: count, anchor: "behind" };
      if (anchored !== anchor.hash) return { ok: false, checked: count, anchor: "mismatch" };
    }
    return { ok: true, checked: count };
  }

  close(): void {
    this.#db.close();
  }
}
