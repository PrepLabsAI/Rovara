// The test environment on the ports: what every module of `core/test-env` is handed. Cloud's version of this feature wrote straight to its table (`documentClient` and `tableName`) and its audit
// outbox; here the same rows (the same keys: `projectPk(orgId, project)` and the same sort keys) go through `DocumentStore`, and audit goes through `AuditSink`. Code runs as one company, so
// `orgId` is the company id the caller passes (`IMPLICIT_COMPANY_ID` on a laptop).
import { type AuditEvent, type AuditSink, type DocumentStore, type StoredDocument, type TransactItem, INDEX_EXPIRY_ATTRIBUTE } from "@agentx/contracts";
import type { FixtureStoreFactory } from "./fixture-lookup.js";
import type { ServiceCatalogSource } from "./dependency-plan.js";

export interface TestEnvDeps {
  store: DocumentStore;
  now(): number;
  /** Records what changed (an approval, a setting): the steps join the change's own transaction. Absent: nothing is recorded (Code's default sink writes nothing). */
  audit?: AuditSink | undefined;
  /** The install's switches (`ev`, `tx`, `sv`, `nh`...). Absent: the process environment. */
  env?: NodeJS.ProcessEnv | undefined;
  /** The release's signed service catalog. Without one, a dependency cannot be pinned and a run with dependencies is refused in fixed words. */
  serviceCatalog?: ServiceCatalogSource | undefined;
  /** The install's fixture store (a factory over the production list). Without it no fake is approved. */
  fixtureStore?: FixtureStoreFactory | undefined;
}

/** What a module needs when it reads or writes one row and no more. */
export type StoreOnly = Pick<TestEnvDeps, "store">;

/** `JSON.parse(JSON.stringify(...))`: drops `undefined` fields, which a document may not hold. */
export const documentOf = <T extends object>(value: T): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;

/** The expiry attribute the store's TTL sweep reads (seconds since the epoch). A reader still tests it, because a swept row may be read until the sweep runs. */
export const expiryOf = (atMs: number): { [INDEX_EXPIRY_ATTRIBUTE]: number } => ({ [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(atMs / 1000) });

/** Whether a stored row's expiry has passed. A row with no expiry does not expire. */
export const expired = (row: { [attribute: string]: unknown }, nowMs: number): boolean => {
  const at = row[INDEX_EXPIRY_ATTRIBUTE];
  return typeof at === "number" && at * 1000 <= nowMs;
};

/** The steps to add to a transaction so an audit record commits with the change (none when no sink is wired). */
export function stageAuditEvent(deps: Pick<TestEnvDeps, "audit">, event: AuditEvent): readonly TransactItem[] {
  return deps.audit === undefined ? [] : deps.audit.stage(event);
}

/** An audit record on its own, for a change that has no transaction. Never throws: an audit that cannot be written does not undo a change that was made. */
export async function recordAuditEvent(deps: Pick<TestEnvDeps, "audit">, event: AuditEvent): Promise<void> {
  try { await deps.audit?.record(event); } catch { /* the change stands; the sink is the sink's to repair */ }
}
