// An in-memory SavedEnvStore for tests: compare-and-set on the row's version, and the audit entries kept beside it.
import type { SavedEnvAuditEntry, SavedEnvState, SavedEnvStore } from "../../packages/broker/src/core/test-env/saved-env.js";

export interface MemorySavedEnvStore extends SavedEnvStore {
  rows: Map<string, SavedEnvState>;
  /** Every audit entry, in order (those written with a change and those written alone). */
  log: SavedEnvAuditEntry[];
  /** Makes the next commit report that the row changed meanwhile. */
  failNextCommit(): void;
}

export function memorySavedEnvStore(clock?: () => number): MemorySavedEnvStore {
  const rows = new Map<string, SavedEnvState>();
  const log: SavedEnvAuditEntry[] = [];
  let failNext = false;
  const key = (orgId: string, projectId: string): string => `${orgId}#${projectId}`;
  return {
    rows, log,
    failNextCommit() { failNext = true; },
    audit(entry) { log.push(structuredClone(entry)); return Promise.resolve(); },
    deletedNeedingPurge: (leaseMs) => Promise.resolve([...rows.values()].filter((row) => row.deleted === true && (row.registryPurgedAt === undefined || Date.parse(row.registryPurgedAt) < Date.parse(row.deletedAt ?? row.registryPurgedAt) + leaseMs)).map((row) => ({ orgId: row.orgId, projectId: row.projectId }))),
    pollDue: (limit) => Promise.resolve([...rows.values()].filter((row) => row.deleted !== true && row.archived !== true && row.enabled && row.nextPollAt !== undefined && Date.parse(row.nextPollAt) <= (clock?.() ?? Date.now())).sort((a, b) => Date.parse(a.nextPollAt!) - Date.parse(b.nextPollAt!)).slice(0, limit).map((row) => ({ orgId: row.orgId, projectId: row.projectId }))),
    get: (orgId, projectId) => Promise.resolve(structuredClone(rows.get(key(orgId, projectId)))),
    commit(next, expectedVersion, entry) {
      if (failNext) { failNext = false; return Promise.resolve(false); }
      const current = rows.get(key(next.orgId, next.projectId));
      if ((current?.version ?? null) !== expectedVersion) return Promise.resolve(false);
      rows.set(key(next.orgId, next.projectId), structuredClone(next));
      log.push(structuredClone(entry));
      return Promise.resolve(true);
    },
  };
}
