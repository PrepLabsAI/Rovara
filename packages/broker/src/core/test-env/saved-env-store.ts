// Saved environment images: the `SavedEnvStore` on the document store. One row per project, in the company's partition (the same keys as Cloud, so Cloud can switch with no data move):
//   pk = ORG#<orgId>, sk = SAVED_ENV#<projectId>   the registry row (images, job, flags); `version` is the compare-and-set counter.
// Every write of the row is ONE transaction: the row put (conditional on the stored version, or on no row yet) and the audit sink's steps for the change. The transaction answers false when it did not
// apply (the row changed meanwhile), and the caller then retries or reports `stale_write`. An audit entry that is not tied to a row change (a refused lease, a routine deletion, a scan start) is recorded alone.
// Only `activity` (a push or a task touched the row's times) and the dispatcher's hand-over of a lease are not audit events: each is the row write alone, with the same version fence.
// `deletedNeedingPurge` and `pollDue` read the one sparse due index (`SAVED_ENV_INDEXES`, the `workflow-dispatch-due` index the other cross-company sweeps use), in two partitions: a deleted row carries a
// due time in `SAVED_ENV_PURGE` until its registry deletion is final (finished after `deletedAt` plus a job lease), then the attributes are dropped in the write that records the purge; a live, enabled row
// carries its next poll time in `SAVED_ENV_POLL`.
import { createHash } from "node:crypto";
import {
  ImageDigestSchema, OrgIdSchema, SavedEnvManifestSchema, WORKFLOW_DISPATCH_DUE_INDEX, agentXError, orgPk, when,
  type AuditEvent, type DocumentKey, type IndexDefinition, type StoredDocument,
} from "@agentx/contracts";
import { z } from "zod";
import { documentOf, recordAuditEvent, stageAuditEvent, type TestEnvDeps } from "./deps.js";
import { SAVED_ENV_JOB_LEASE_MS, type SavedEnvAuditEntry, type SavedEnvState, type SavedEnvStore } from "./saved-env.js";

type Row = Record<string, unknown>;

/** What the store needs of the install: the document store, the clock of the sweep's due test (milliseconds), and the audit sink. */
export type SavedEnvTable = Pick<TestEnvDeps, "store" | "audit"> & { now?: () => number };

/** The index the due rows are listed in. The document store must keep it (the same index the task flow's recovery sweep uses; declare it once). */
export const SAVED_ENV_INDEXES: readonly IndexDefinition[] = [
  { name: WORKFLOW_DISPATCH_DUE_INDEX.name, partitionAttribute: WORKFLOW_DISPATCH_DUE_INDEX.partitionKey, sortAttribute: WORKFLOW_DISPATCH_DUE_INDEX.sortKey, sortType: "string" },
];

/** The partition of the sparse due index that lists deleted projects whose registry deletion is not final. */
export const SAVED_ENV_PURGE_PARTITION = "SAVED_ENV_PURGE";
/** The partition of the same sparse index that lists live projects by the time the periodic poll next looks at them. */
export const SAVED_ENV_POLL_PARTITION = "SAVED_ENV_POLL";
/** The most deleted projects one sweep reads (the nightly runs it daily; a remainder is swept the next night). */
export const SAVED_ENV_PURGE_PAGE = 200;
/** The most index pages one poll read looks through. */
const POLL_PAGES_MAX = 5;

const rowKey = (orgId: string, projectId: string): DocumentKey => ({ pk: orgPk(OrgIdSchema.parse(orgId)), sk: `SAVED_ENV#${projectId}` });
const dueKey = (time: number): string => String(Math.max(0, Math.trunc(time))).padStart(15, "0");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Saved project images could not be read.");

const Iso = z.string().datetime();
const Approved = z.object({ revision: z.number().int().min(1), digest: z.string().min(1).max(100) }).strict();
const ImageSchema = z.object({
  approved: Approved, digest: ImageDigestSchema, tag: z.string().min(1).max(128), manifest: SavedEnvManifestSchema, recordedAt: Iso, status: z.enum(["ready", "stale"]),
  staleStep: z.string().max(40).optional(), scanStartedAt: Iso.optional(),
}).strict();
const JobSchema = z.object({
  jobId: z.string().min(1).max(64), leaseToken: z.string().min(1).max(200), reason: z.enum(["no_image", "key_changed", "max_age", "stale", "reset"]), approved: Approved,
  commits: z.record(z.string().min(1).max(200), z.string().regex(/^[a-f0-9]{40}$/u)), expectedKey: z.string().regex(/^[a-f0-9]{64}$/u), createdAt: Iso, leaseUntil: Iso, dispatchedAt: Iso.optional(), dispatchedOperationId: z.string().max(64).optional(),
}).strict();
const StateSchema = z.object({
  orgId: OrgIdSchema, projectId: z.string().min(1).max(200), version: z.number().int().min(1), enabled: z.boolean(), images: z.array(ImageSchema).max(20), job: JobSchema.optional(),
  resetRequested: z.boolean().optional(), archived: z.boolean().optional(), deleted: z.boolean().optional(), deletedAt: Iso.optional(), registryPurgedAt: Iso.optional(), lastResetAt: Iso.optional(),
  lastResetRequestId: z.string().max(100).optional(), lastPushAt: Iso.optional(), lastTaskAt: Iso.optional(), lastRebuildReason: z.enum(["no_image", "key_changed", "max_age", "stale", "reset"]).optional(),
  lastFailureAt: Iso.optional(), lastFailure: z.string().max(60).optional(), nextPollAt: Iso.optional(), pollFailures: z.number().int().min(0).max(1000).optional(), health: z.enum(["never_proved", "healthy", "needs_repair"]),
}).strict();

/** The stored attributes that are not part of the state (keys, entity type, the due index) are dropped. Undefined for a row that does not read back. */
function stateOf(raw: Row | undefined): SavedEnvState | undefined {
  if (raw === undefined) return undefined;
  const { pk: _pk, sk: _sk, entityType: _type, [WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]: _duePk, [WORKFLOW_DISPATCH_DUE_INDEX.sortKey]: _dueSk, ...rest } = raw;
  void _pk; void _sk; void _type; void _duePk; void _dueSk;
  const parsed = StateSchema.safeParse(rest);
  return parsed.success ? (parsed.data as SavedEnvState) : undefined;
}

/** The registry deletion of a deleted row is final once it finished after `deletedAt` plus `leaseMs`. */
function purgeFinal(state: Pick<SavedEnvState, "deletedAt" | "registryPurgedAt">, leaseMs: number): boolean {
  if (state.registryPurgedAt === undefined) return false;
  const deletedAt = Date.parse(state.deletedAt ?? state.registryPurgedAt);
  return !(Date.parse(state.registryPurgedAt) < deletedAt + leaseMs);
}

/**
 * The due attributes of a row, for the one sparse index: a deleted row whose purge is not final is due for the sweep (first at the delete, then again at `deletedAt` plus a lease); a live, enabled, unarchived row
 * with a `nextPollAt` is due for the poll at that time. Nothing else has them.
 */
function dueAttributes(state: SavedEnvState): Row {
  const key = (partition: string, at: number): Row => ({ [WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]: partition, [WORKFLOW_DISPATCH_DUE_INDEX.sortKey]: `${dueKey(at)}#${state.orgId}#${state.projectId}` });
  if (state.deleted === true) {
    if (purgeFinal(state, SAVED_ENV_JOB_LEASE_MS)) return {};
    const deletedAt = Date.parse(state.deletedAt ?? "") || 0;
    return key(SAVED_ENV_PURGE_PARTITION, state.registryPurgedAt === undefined ? deletedAt : deletedAt + SAVED_ENV_JOB_LEASE_MS);
  }
  if (state.archived === true || !state.enabled || state.nextPollAt === undefined) return {};
  return key(SAVED_ENV_POLL_PARTITION, Date.parse(state.nextPollAt));
}

const sha = (...parts: string[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40);

/**
 * The audit event of one entry, or undefined for `activity` (the row's times only). The actor is the person for a Reset, the system otherwise; the facts are fixed words, a digest and a count, never a secret.
 * The event id is the same for the same change (`version` for a row change, otherwise the time, action and fact), so a repeat records once.
 */
export function savedEnvAuditEvent(entry: SavedEnvAuditEntry, version: number | undefined): AuditEvent | undefined {
  if (entry.action === "activity") return undefined;
  // The dispatcher's hand-over of the lease is operational (the audit has the job being queued, and its result): it is the row alone.
  if (entry.action === "rebuild_queued" && entry.reason === "dispatched") return undefined;
  const eventId = `saved_env.${entry.action}:${sha(entry.orgId, entry.projectId, version === undefined ? entry.at : String(version), entry.action, version === undefined ? (entry.digest ?? entry.reason ?? "") : "")}`;
  const details: Record<string, string | number | boolean> = {};
  if (entry.reason !== undefined) details["cause"] = entry.reason.slice(0, 60);
  if (entry.digest !== undefined) details["digest"] = entry.digest;
  if (entry.count !== undefined) details["count"] = entry.count;
  if (entry.action === "setting_changed") details["enabled"] = entry.enabled === true;
  return {
    eventId, companyId: entry.orgId, at: entry.at, actor: entry.actor === undefined ? { type: "system", id: "rovara" } : { type: "person", id: entry.actor },
    action: `saved_env.${entry.action}`, subject: { type: "project", id: entry.projectId }, details,
  };
}

export function documentSavedEnvStore(table: SavedEnvTable): SavedEnvStore {
  const read = async (orgId: string, projectId: string): Promise<Row | undefined> => await table.store.get(rowKey(orgId, projectId));

  return {
    async get(orgId, projectId) {
      if (!OrgIdSchema.safeParse(orgId).success || projectId.length === 0 || projectId.length > 200) return undefined;
      const raw = await read(orgId, projectId);
      if (raw === undefined) return undefined;
      const state = stateOf(raw);
      // A row that exists and does not read back is an error, never "no row": "no row" would let a first write replace it.
      if (state === undefined) throw unavailable();
      return state;
    },

    async commit(next, expectedVersion, entry) {
      if (!OrgIdSchema.safeParse(next.orgId).success || next.orgId !== entry.orgId || next.projectId !== entry.projectId) return false;
      const parsed = StateSchema.safeParse(next);
      if (!parsed.success) return false;
      if (expectedVersion === null ? next.version !== 1 : next.version !== expectedVersion + 1) return false;
      const event = savedEnvAuditEvent(entry, next.version);
      const staged = event === undefined ? [] : stageAuditEvent(table, event);
      const item: StoredDocument = documentOf({ ...rowKey(next.orgId, next.projectId), entityType: "SAVED_ENV", ...(parsed.data as Row), ...dueAttributes(parsed.data as SavedEnvState) });
      const result = await table.store.transact([
        { kind: "put", item, condition: expectedVersion === null ? when.absent() : when.eq("version", expectedVersion) },
        ...staged,
      ]);
      if (!result.applied) return false;
      // A sink that writes somewhere else than the transaction (no steps staged) is told now.
      if (event !== undefined && staged.length === 0) await recordAuditEvent(table, event);
      return true;
    },

    async audit(entry) {
      const event = savedEnvAuditEvent(entry, undefined);
      if (event === undefined) return;
      await recordAuditEvent(table, event);
    },

    async pollDue(limit) {
      const now = (table.now ?? Date.now)();
      const out: Array<{ orgId: string; projectId: string }> = [];
      let cursor: string | undefined;
      // The index lists rows by time, and a row on it may be one that is no longer eligible (turned off, archived, moved on): the pages are read past those until `limit` eligible rows are found, a few pages at most.
      for (let page = 0; page < POLL_PAGES_MAX && out.length < limit; page += 1) {
        const result = await table.store.queryIndex({
          index: WORKFLOW_DISPATCH_DUE_INDEX.name, partition: SAVED_ENV_POLL_PARTITION, sort: { op: "between", low: "0", high: `${dueKey(now)}~` }, limit: SAVED_ENV_PURGE_PAGE, ...(cursor === undefined ? {} : { cursor }),
        });
        for (const raw of result.items as Row[]) {
          if (out.length >= limit) break;
          if (typeof raw["orgId"] !== "string" || typeof raw["projectId"] !== "string" || !OrgIdSchema.safeParse(raw["orgId"]).success) continue;
          // The index may lag: the row itself says whether it is live and its time has come.
          const fresh = stateOf(await read(raw["orgId"], raw["projectId"]));
          if (fresh !== undefined && fresh.deleted !== true && fresh.archived !== true && fresh.enabled && fresh.nextPollAt !== undefined && Date.parse(fresh.nextPollAt) <= now) out.push({ orgId: fresh.orgId, projectId: fresh.projectId });
        }
        cursor = result.cursor;
        if (cursor === undefined) break;
      }
      return out;
    },

    async deletedNeedingPurge(leaseMs) {
      const now = (table.now ?? Date.now)();
      const result = await table.store.queryIndex({
        index: WORKFLOW_DISPATCH_DUE_INDEX.name, partition: SAVED_ENV_PURGE_PARTITION,
        // "~" sorts after the "#" that follows each due time, so this includes every row due at or before now.
        sort: { op: "between", low: "0", high: `${dueKey(now)}~` }, limit: SAVED_ENV_PURGE_PAGE,
      });
      const out: Array<{ orgId: string; projectId: string }> = [];
      for (const raw of result.items as Row[]) {
        if (typeof raw["orgId"] !== "string" || typeof raw["projectId"] !== "string" || !OrgIdSchema.safeParse(raw["orgId"]).success) continue;
        const fresh = stateOf(await read(raw["orgId"], raw["projectId"]));
        if (fresh?.deleted === true && !purgeFinal(fresh, leaseMs)) out.push({ orgId: fresh.orgId, projectId: fresh.projectId });
      }
      return out;
    },
  };
}
