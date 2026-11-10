// Port lane P6 (item L2, review H1/M2): Code's default `audit-sink`. The audit record COMMITS WITH THE CHANGE, as the port says (`audit-sink.ts`): `stage` returns a `put` step for the caller's own
// document-store transaction, an `AUDIT#` row in the same store (state.db). So a change that is refused, lost to a competing writer, or interrupted before its transaction commits leaves NO row, and
// a change that commits always leaves one. The "audit before add" rule holds because the record and the add are one atomic step.
//
// The row's key is the event id, and the step's condition is "absent, or the same facts": a retry of a committed event is harmless, and the same event id used for DIFFERENT facts makes the step
// fail (the caller's transaction is refused; it is never silently dropped). The facts exclude the time, so a retry at a later moment is the same record.
//
// `startAuditCopy` feeds the append-only, hash-chained copy (`SqliteAuditLog`, audit.db) from COMMITTED rows only, through the store's change feed. The copy is never the primary.
import {
  companyScoped,
  type AuditEvent,
  type AuditSink,
  type DocumentChange,
  type DocumentStore,
  type JsonObject,
  type StoredDocument,
  type TransactItem,
  when,
} from "@agentx/contracts";
import { AuditLogError, auditDigest, checkAuditEvent, storedAuditEvent } from "./audit-event.js";
import type { SqliteAuditLog } from "./sqlite-audit-log.js";

export const AUDIT_ENTITY_TYPE = "AUDIT";
export const AUDIT_COPY_CONSUMER = "audit-copy";
const HEAD_ENTITY_TYPE = "AUDIT_COPY_HEAD";

/** The key of an event's row. */
export function auditRowKey(companyId: string, eventId: string): { pk: string; sk: string } {
  try {
    return { pk: companyScoped(companyId, "AUDIT"), sk: `EVENT#${eventId}` };
  } catch (error) {
    throw new AuditLogError("the audit event's company is not usable", { cause: error });
  }
}

function auditRow(event: AuditEvent): StoredDocument {
  checkAuditEvent(event);
  const stored = storedAuditEvent(event);
  return {
    ...auditRowKey(stored.companyId, stored.eventId),
    entityType: AUDIT_ENTITY_TYPE,
    eventId: stored.eventId,
    companyId: stored.companyId,
    at: stored.at,
    actor: { ...stored.actor },
    action: stored.action,
    ...(stored.subject === undefined ? {} : { subject: { ...stored.subject } }),
    ...(stored.details === undefined ? {} : { details: stored.details }),
    digest: auditDigest(stored),
  };
}

/** The event a row holds, or undefined for a document that is not an audit row. */
export function auditEventOfRow(row: StoredDocument | undefined): AuditEvent | undefined {
  if (row === undefined || row.entityType !== AUDIT_ENTITY_TYPE) return undefined;
  const { eventId, companyId, at, action } = row;
  if (typeof eventId !== "string" || typeof companyId !== "string" || typeof at !== "string" || typeof action !== "string") return undefined;
  const actor = row.actor as { type: AuditEvent["actor"]["type"]; id: string };
  return storedAuditEvent({
    eventId, companyId, at, actor, action,
    ...(row.subject === undefined ? {} : { subject: row.subject as unknown as NonNullable<AuditEvent["subject"]> }),
    ...(row.details === undefined ? {} : { details: row.details as JsonObject }),
  });
}

export interface DocumentAuditSinkOptions {
  /** The store the rows go to; asked when `record` is called, so the registry's `storage` adapter (which may be a plug-in loaded later) is the one used. */
  store: () => Pick<DocumentStore, "put" | "get">;
}

export class DocumentAuditSink implements AuditSink {
  readonly #options: DocumentAuditSinkOptions;

  constructor(options: DocumentAuditSinkOptions) {
    this.#options = options;
  }

  stage(event: AuditEvent): readonly TransactItem[] {
    const item = auditRow(event);
    return [{ kind: "put", item, condition: when.or(when.absent(), when.eq("digest", item.digest as string)) }];
  }

  async record(event: AuditEvent): Promise<void> {
    const item = auditRow(event);
    const store = this.#options.store();
    let result;
    try {
      result = await store.put({ item, condition: when.or(when.absent(), when.eq("digest", item.digest as string)) });
    } catch (error) {
      throw new AuditLogError("the audit record could not be written", { cause: error });
    }
    if (!result.applied) throw new AuditLogError("the audit event id is already used for other facts");
  }
}

// ---- the append-only copy ----

const headKey = (companyId: string) => ({ pk: companyScoped(companyId, "AUDIT_COPY"), sk: "HEAD" });

export interface AuditCopyOptions {
  store: DocumentStore;
  log: SqliteAuditLog;
  /** Where the copy's anchor (its row count and newest hash) is kept: in the store, apart from audit.db. */
  companyId: string;
  onError?: (error: unknown) => void;
}

/**
 * Feeds the copy from the store's committed AUDIT rows, in commit order, at least once (the copy drops a repeat). After each batch the anchor is written, so `verifyAuditCopy` can tell a copy whose
 * newest rows were cut off. A store with no change feed gets no copy (`undefined`): the AUDIT rows alone are the record.
 */
export async function startAuditCopy(options: AuditCopyOptions): Promise<{ stop(): Promise<void> } | undefined> {
  const feed = options.store.changes;
  if (feed === undefined) return undefined;
  return feed.subscribe(
    AUDIT_COPY_CONSUMER,
    async (changes: readonly DocumentChange[]) => {
      let appended = false;
      for (const change of changes) {
        const event = auditEventOfRow(change.after);
        if (event === undefined) continue;
        options.log.append(event);
        appended = true;
      }
      if (!appended) return;
      const head = options.log.head();
      await options.store.put({ item: { ...headKey(options.companyId), entityType: HEAD_ENTITY_TYPE, count: head.count, hash: head.hash } });
    },
    { onPoison: (_changes, error) => options.onError?.(error) },
  );
}

/** Checks the copy's chain and its anchor. A copy that has not been fed yet (no anchor) is checked for its chain alone. */
export async function verifyAuditCopy(options: Pick<AuditCopyOptions, "store" | "log" | "companyId">): Promise<ReturnType<SqliteAuditLog["verify"]>> {
  const row = await options.store.get(headKey(options.companyId));
  const anchor = row?.entityType === HEAD_ENTITY_TYPE && typeof row.count === "number" && typeof row.hash === "string" ? { count: row.count, hash: row.hash } : undefined;
  return options.log.verify(anchor);
}
