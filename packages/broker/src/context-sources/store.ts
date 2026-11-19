// The store of a project's context sources, over the document store port. One document per project (with a revision) and one item per pending change; a decided change is
// kept for the audit trail until its expiry. Every key starts with the company, so another company's items cannot be read by building a key from the caller's. The keys and the
// documents are the hosted product's (company scope: `ORG#<company>#CTXSRC#<project>`), so a later switch moves no data.
import { ContextSourceSchema, ContextSourcesDocumentSchema, INDEX_EXPIRY_ATTRIBUTE, change as set, orgScoped, when, type ContextSourcesDocument, type DocumentStore, type JsonValue, type OrgId, type StoredDocument } from "@agentx/contracts";
import type { ContextSourceChange, ContextSourceStore } from "./settings.js";

/** How long a change is kept after it was made (a pending one expires unconfirmed). */
export const CHANGE_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** A stored value as text: a field that is not text reads as empty. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const partition = (orgId: OrgId, project: string): string => orgScoped(orgId, `CTXSRC#${project}`);
const documentKey = (orgId: OrgId, project: string) => ({ pk: partition(orgId, project), sk: "DOC" });
const changeKey = (orgId: OrgId, project: string, changeId: string) => ({ pk: partition(orgId, project), sk: `CHG#${changeId}` });

function changeFrom(item: StoredDocument | undefined): ContextSourceChange | undefined {
  if (item === undefined || typeof item.changeId !== "string" || typeof item.project !== "string" || typeof item.orgId !== "string") return undefined;
  const source = item.source === undefined ? undefined : ContextSourceSchema.safeParse(item.source);
  // A stored source that no longer parses is not served: the change reads as missing, never as a half-valid one.
  if (source !== undefined && !source.success) return undefined;
  const status = item.status === "applied" || item.status === "rejected" ? item.status : "pending";
  return {
    changeId: item.changeId, orgId: item.orgId, project: item.project, kind: item.kind === "remove" ? "remove" : "set", sourceId: text(item.sourceId),
    ...(source === undefined ? {} : { source: source.data }),
    proposedBy: text(item.proposedBy), proposedAt: text(item.proposedAt), baseRevision: Number(item.baseRevision),
    secondAdminReasons: Array.isArray(item.secondAdminReasons) ? item.secondAdminReasons.map(String) : [], status,
    ...(typeof item.decidedBy === "string" ? { decidedBy: item.decidedBy } : {}), ...(typeof item.decidedAt === "string" ? { decidedAt: item.decidedAt } : {}),
  };
}

export function documentContextSourceStore(deps: { store: DocumentStore; now: () => number }): ContextSourceStore {
  const expiry = () => Math.floor(deps.now() / 1_000) + CHANGE_RETENTION_SECONDS;
  const changeItem = (value: ContextSourceChange): StoredDocument => ({ ...changeKey(value.orgId, value.project, value.changeId), ...(value as unknown as Record<string, JsonValue>), [INDEX_EXPIRY_ATTRIBUTE]: expiry() });
  const decided = (status: "applied" | "rejected", by: string, at: string) => [set.set("status", status), set.set("decidedBy", by), set.set("decidedAt", at)];
  return {
    async readDocument(orgId, project): Promise<ContextSourcesDocument> {
      const found = await deps.store.get(documentKey(orgId, project));
      if (found === undefined) return { revision: 0, sources: [] };
      const parsed = ContextSourcesDocumentSchema.safeParse({ revision: found.revision, sources: found.sources });
      // A document that does not parse serves no sources at all: every source of the project is off until the owner saves it again.
      return parsed.success ? parsed.data : { revision: typeof found.revision === "number" ? found.revision : 0, sources: [] };
    },
    async putChange(value) {
      const done = await deps.store.put({ item: changeItem(value), condition: when.absent() });
      if (!done.applied) throw new Error("that change already exists");
    },
    async getChange(orgId, project, changeId) {
      return changeFrom(await deps.store.get(changeKey(orgId, project, changeId)));
    },
    async listPending(orgId, project) {
      const found = await deps.store.query({ pk: partition(orgId, project), sk: { op: "beginsWith", prefix: "CHG#" }, limit: 100 });
      return found.items.map(changeFrom).filter((value): value is ContextSourceChange => value?.status === "pending");
    },
    async apply({ change: value, next, decidedBy, decidedAt }) {
      const key = documentKey(value.orgId, value.project);
      const done = await deps.store.transact([
        { kind: "put", item: { ...key, revision: next.revision, sources: next.sources as unknown as JsonValue }, condition: value.baseRevision === 0 ? when.absent() : when.eq("revision", value.baseRevision) },
        { kind: "update", key: changeKey(value.orgId, value.project, value.changeId), ops: decided("applied", decidedBy, decidedAt), condition: when.eq("status", "pending") },
      ]);
      return done.applied ? "applied" : "stale";
    },
    async reject({ change: value, decidedBy, decidedAt }) {
      const done = await deps.store.transact([
        { kind: "update", key: changeKey(value.orgId, value.project, value.changeId), ops: decided("rejected", decidedBy, decidedAt), condition: when.eq("status", "pending") },
      ]);
      return done.applied ? "rejected" : "stale";
    },
  };
}
