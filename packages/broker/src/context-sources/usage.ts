// What one stage has used of its sources: calls and bytes per source, failures per source, and the stage's total calls. One item per operation, updated with atomic adds that
// carry their cap as a condition, so parallel calls (up to 4) cannot jointly pass a cap.
import { INDEX_EXPIRY_ATTRIBUTE, change, orgScoped, when, type DocumentStore, type OrgId } from "@agentx/contracts";

/** A stage may make at most this many calls to all its sources together, whatever each source allows. */
export const STAGE_TOTAL_CALLS = 50;
/** After this many failed calls to a source, it is off for the rest of the stage. */
export const SOURCE_FAILURE_LIMIT = 3;
const USAGE_RETENTION_SECONDS = 3 * 24 * 60 * 60;

export type Reservation = { ok: true } | { ok: false; reason: "calls" | "total" | "failures" };

export interface UsageStore {
  /** Takes one call from the source's and the stage's allowance, or says which one is used up. */
  reserveCall(input: { orgId: OrgId; operationId: string; sourceId: string; callsPerStage: number }): Promise<Reservation>;
  /** The bytes of results already shown from this source in this stage. */
  bytesUsed(input: { orgId: OrgId; operationId: string; sourceId: string }): Promise<number>;
  addBytes(input: { orgId: OrgId; operationId: string; sourceId: string; bytes: number }): Promise<void>;
  /** Counts a failed call; returns how many have failed for this source in this stage. */
  recordFailure(input: { orgId: OrgId; operationId: string; sourceId: string }): Promise<number>;
}

const key = (orgId: OrgId, operationId: string) => ({ pk: orgScoped(orgId, `CTXUSE#${operationId}`), sk: "USE" });
const calls = (sourceId: string) => `c_${sourceId}`;
const bytes = (sourceId: string) => `b_${sourceId}`;
const failures = (sourceId: string) => `f_${sourceId}`;
/** The counter is under its cap, or not there yet. */
const under = (attribute: string, cap: number) => when.or(when.notExists(attribute), when.lt(attribute, cap));

export function documentUsageStore(deps: { store: DocumentStore; now: () => number }): UsageStore {
  const expiry = () => Math.floor(deps.now() / 1_000) + USAGE_RETENTION_SECONDS;
  const read = async (orgId: OrgId, operationId: string): Promise<Record<string, unknown>> => (await deps.store.get(key(orgId, operationId))) ?? {};
  return {
    async reserveCall({ orgId, operationId, sourceId, callsPerStage }) {
      const done = await deps.store.update({
        key: key(orgId, operationId),
        ops: [change.add(calls(sourceId), 1), change.add("total", 1), change.set(INDEX_EXPIRY_ATTRIBUTE, expiry())],
        condition: when.and(under(calls(sourceId), callsPerStage), under("total", STAGE_TOTAL_CALLS), under(failures(sourceId), SOURCE_FAILURE_LIMIT)),
      });
      if (done.applied) return { ok: true };
      const item = await read(orgId, operationId);
      if (Number(item[failures(sourceId)] ?? 0) >= SOURCE_FAILURE_LIMIT) return { ok: false, reason: "failures" };
      if (Number(item.total ?? 0) >= STAGE_TOTAL_CALLS) return { ok: false, reason: "total" };
      return { ok: false, reason: "calls" };
    },
    async bytesUsed({ orgId, operationId, sourceId }) {
      return Number((await read(orgId, operationId))[bytes(sourceId)] ?? 0);
    },
    async addBytes({ orgId, operationId, sourceId, bytes: count }) {
      await deps.store.update({ key: key(orgId, operationId), ops: [change.add(bytes(sourceId), count), change.set(INDEX_EXPIRY_ATTRIBUTE, expiry())] });
    },
    async recordFailure({ orgId, operationId, sourceId }) {
      const done = await deps.store.update({ key: key(orgId, operationId), ops: [change.add(failures(sourceId), 1), change.set(INDEX_EXPIRY_ATTRIBUTE, expiry())], return: "new" });
      return done.applied ? Number(done.item?.[failures(sourceId)] ?? 1) : 1;
    },
  };
}
