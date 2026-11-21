// Permanent identity on the existing canonical project META. Never expire or erase it.
import { agentXError, canonicalJson, IMPLICIT_COMPANY_ID, orgProjectCatalogKey, projectMetaKey, when, type Condition, type DocumentStore, type StoredDocument, type TransactItem } from "@agentx/contracts";

type Row = Record<string, unknown>;
export const validIncarnation = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const refused = () => agentXError("PROJECT_REVISION_MISMATCH", "Project identity is unavailable. An operator must verify its retained incarnation before this operation.");

export function requireProjectIncarnation(companyId: string, project: string, row: Row | undefined): number {
  const key = projectMetaKey(companyId, project);
  if (row === undefined || row.pk !== key.pk || row.sk !== key.sk || row.entityType !== "PROJECT_META" || row.companyId !== companyId || row.project !== project
    || (row.orgId !== undefined && row.orgId !== companyId) || row.indexExpiresAt !== undefined || row.expiresAt !== undefined
    || !validIncarnation(row.incarnationRevision) || (row.status !== "active" && row.status !== "archived" && row.status !== "deleted")) throw refused();
  return row.incarnationRevision;
}
/** Compare all identity fields at commit, never just the caller's prior comparison. */
export function projectIncarnationSettlement(companyId: string, project: string, row: Row | undefined, expected: unknown): Condition {
  const revision = requireProjectIncarnation(companyId, project, row);
  if (!validIncarnation(expected) || expected !== revision || row?.status !== "active") throw refused();
  return when.and(when.eq("entityType", "PROJECT_META"), when.eq("companyId", companyId), when.eq("project", project), when.eq("incarnationRevision", revision), when.eq("status", "active"), row?.["orgId"] === undefined ? when.notExists("orgId") : when.eq("orgId", companyId), when.notExists("indexExpiresAt"), when.notExists("expiresAt"));
}
/** First registration is proved by absent content; retirement requires a fully drained project before recreation. */
export function planProjectIncarnation(companyId: string, project: string, row: Row | undefined, hasContent: boolean): StoredDocument {
  const key = projectMetaKey(companyId, project);
  if (row === undefined) {
    if (hasContent) throw refused();
    return { ...key, entityType: "PROJECT_META", companyId, project, incarnationRevision: 1, status: "active" };
  }
  const revision = requireProjectIncarnation(companyId, project, row);
  if (row.status !== "deleted") return row as StoredDocument;
  if (hasContent || revision === Number.MAX_SAFE_INTEGER) throw refused();
  return { ...key, entityType: "PROJECT_META", companyId, project, incarnationRevision: revision + 1, status: "active" };
}
/** Snapshot CAS also fences absent identity fields during the one-time migration. */
export function projectMetaSnapshot(row: StoredDocument | undefined): Condition {
  if (row === undefined) return when.absent();
  const fields = new Set([...Object.keys(row), "incarnationRevision", "companyId", "orgId", "project", "status", "setupCheck", "lifecycleRevision", "indexExpiresAt", "expiresAt"]);
  return when.and(...[...fields].map(field => row[field] === undefined ? when.notExists(field) : when.eq([field], row[field])));
}

/** Only erasure may retire a pre-rollout identity; it never makes missing identity live. */
export function projectIncarnationTombstone(companyId: string, project: string, previous: Row | undefined, catalog: Row | undefined): StoredDocument {
  let revision: number;
  if (previous?.["incarnationRevision"] !== undefined) revision = requireProjectIncarnation(companyId, project, previous);
  else {
    if (catalog?.["incarnationRevision"] !== undefined || !uninitializedProjectMeta(companyId, project, previous)) throw refused();
    revision = 1;
  }
  return { ...projectMetaKey(companyId, project), entityType: "PROJECT_META", companyId, project, incarnationRevision: revision, status: "deleted" };
}
/** Erasure retires identity before content. Even a pre-rollout project gets a retained tombstone. */
export async function retireProjectIncarnation(store: Pick<DocumentStore, "get" | "transact">, companyId: string, project: string): Promise<boolean> {
  const key = projectMetaKey(companyId, project);
  const catalogKeys = [orgProjectCatalogKey(companyId, project), ...(companyId === IMPLICIT_COMPANY_ID ? [{ pk: "PROJECT_CATALOG", sk: `PROJECT#${project}` }] : [])];
  const [previous, ...catalogs] = await Promise.all([store.get(key), ...catalogKeys.map(catalogKey => store.get(catalogKey))]);
  // Either layout may be the last initialized witness after META loss. Fence even an absent/unstamped witness.
  const item = projectIncarnationTombstone(companyId, project, previous, catalogs.find(catalog => catalog?.["incarnationRevision"] !== undefined));
  if (previous !== undefined && canonicalJson(previous) === canonicalJson(item)) return false;
  const written = await store.transact([
    { kind: "put", item, condition: projectMetaSnapshot(previous) },
    ...catalogKeys.map((catalogKey, index): TransactItem => ({ kind: "check", key: catalogKey, condition: projectMetaSnapshot(catalogs[index]) })),
  ]);
  if (!written.applied) throw refused();
  return true;
}

/** Known pre-rollout shapes only. This validation never authorizes initialization without inventory/content proof. */
export function uninitializedProjectMeta(companyId: string, project: string, row: Row | undefined): boolean {
  if (row === undefined) return true;
  const key = projectMetaKey(companyId, project);
  if (row.pk !== key.pk || row.sk !== key.sk || row.incarnationRevision !== undefined || row.indexExpiresAt !== undefined || row.expiresAt !== undefined
    || (row.companyId !== undefined && row.companyId !== companyId) || (row.orgId !== undefined && row.orgId !== companyId)
    || (row.project !== undefined && row.project !== project) || (row.status !== undefined && row.status !== "active" && row.status !== "archived")) return false;
  if (row.entityType === "PROJECT_META") return true;
  const mark = row.setupCheck as Row | undefined;
  return row.entityType === undefined && Object.keys(row).every(field => ["pk", "sk", "setupCheck"].includes(field)) && mark !== undefined && mark !== null && typeof mark === "object" && !Array.isArray(mark)
    && typeof mark.workspaceId === "string" && validIncarnation(mark.revision) && typeof mark.startedAt === "string" && Number.isFinite(Date.parse(mark.startedAt)) && typeof mark.startedBy === "string";
}
/** Existing setup writers may retain their pre-rollout shape; after initialization the exact incarnation must still be live. */
export function projectIncarnationUpdate(companyId: string, project: string, row: StoredDocument | undefined): Condition {
  if (row?.["incarnationRevision"] !== undefined) requireProjectIncarnation(companyId, project, row);
  if (row?.["status"] === "deleted") throw refused();
  return projectMetaSnapshot(row);
}

/** Registration preserves a live META instead of replacing its lifecycle/setup fields. */
export function projectIncarnationRegistration(companyId: string, project: string, previous: StoredDocument | undefined, identity: StoredDocument): TransactItem {
  return previous !== undefined && previous["status"] !== "deleted"
    ? { kind: "check", key: projectMetaKey(companyId, project), condition: projectMetaSnapshot(previous) }
    : { kind: "put", item: identity, condition: projectMetaSnapshot(previous) };
}
