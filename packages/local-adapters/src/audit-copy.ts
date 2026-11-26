// Port lane P6 (item L2, review H1/M2): the laptop's append-only, hash-chained copy of the audit trail (`SqliteAuditLog`, audit.db), fed from the COMMITTED `AUDIT#` rows of the document audit sink
// (`@agentx/broker/plugins/audit-sink-document`) through the store's change feed. The copy is never the primary.
import { auditEventOfRow, companyScoped, companyChangeFeed, queryAll, type AuditEvent, type DocumentChange, type DocumentStore } from "@agentx/contracts";
import type { SqliteAuditLog } from "./sqlite-audit-log.js";

export const AUDIT_COPY_CONSUMER = "audit-copy";
const HEAD_ENTITY_TYPE = "AUDIT_COPY_HEAD";

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
  return companyChangeFeed(feed, options.companyId, (event) => options.onError?.(new Error(event))).subscribe(
    AUDIT_COPY_CONSUMER,
    async (changes: readonly DocumentChange[]) => {
      let appended = false;
      for (const change of changes) {
        const event = auditEventOfRow(change.after);
        if (event === undefined || event.companyId !== options.companyId) continue;
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

export interface AuditCopyStart {
  /** What the check found before any back-fill. */
  verification: ReturnType<SqliteAuditLog["verify"]>;
  /** How many committed rows the copy was missing and got from the primary. 0 when it was complete. */
  backfilled: number;
}

/**
 * Brings the copy up to date with the primary at start, BEFORE the feed is attached. A copy can lack committed rows: its file was deleted, a batch of the feed was given up on (poison), or the process stopped
 * between a commit and the feed. The missing rows are appended from the primary `AUDIT#` rows, oldest first, and the anchor is rewritten. A copy whose chain is broken or whose anchored row differs (it was
 * CHANGED, not just short) is not touched: that is reported, never repaired. `behind` (rows cut off) is repaired, since the primary still has them.
 */
export async function startAuditCopyFromPrimary(options: Pick<AuditCopyOptions, "store" | "log" | "companyId">): Promise<AuditCopyStart> {
  const verification = await verifyAuditCopy(options);
  if (!verification.ok && verification.anchor !== "behind") return { verification, backfilled: 0 };
  const have = options.log.eventIds();
  const missing = (await queryAll(options.store, { pk: companyScoped(options.companyId, "AUDIT") }))
    .map((row) => auditEventOfRow(row))
    .filter((event): event is AuditEvent => event !== undefined && event.companyId === options.companyId && !have.has(event.eventId))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.eventId < b.eventId ? -1 : 1));
  for (const event of missing) options.log.append(event);
  if (missing.length > 0 || verification.anchor === "behind") {
    const head = options.log.head();
    await options.store.put({ item: { ...headKey(options.companyId), entityType: HEAD_ENTITY_TYPE, count: head.count, hash: head.hash } });
  }
  return { verification, backfilled: missing.length };
}

/** Checks the copy's chain and its anchor. A copy that has not been fed yet (no anchor) is checked for its chain alone. */
export async function verifyAuditCopy(options: Pick<AuditCopyOptions, "store" | "log" | "companyId">): Promise<ReturnType<SqliteAuditLog["verify"]>> {
  const row = await options.store.get(headKey(options.companyId));
  const anchor = row?.entityType === HEAD_ENTITY_TYPE && typeof row.count === "number" && typeof row.hash === "string" ? { count: row.count, hash: row.hash } : undefined;
  return options.log.verify(anchor);
}
