// Lane L6a, task flow core: registered projects read from the document store, by Cloud's keys (`projectRevisionKey`, `orgProjectCatalogKey`).
import {
  ProjectDefinitionSchema,
  orgProjectCatalogKey,
  projectMetaKey,
  projectPk,
  projectRevisionKey,
  PROJECT_REVISION_SK_PREFIX,
  type DocumentStore,
  type OrgId,
  type StoredDocument,
} from "@agentx/contracts";
import type { ProjectRevision, ProjectSource } from "./deps.js";

function revisionOf(document: StoredDocument | undefined, meta: StoredDocument | undefined): ProjectRevision | undefined {
  if (document === undefined) return undefined;
  const parsed = ProjectDefinitionSchema.safeParse(document.definition);
  return parsed.success ? { definition: parsed.data, ...(meta?.status === "archived" ? { archived: true } : {}) } : undefined;
}

/** Reads project revisions from the store. A record that does not parse as a project is treated as absent (the start then says the project does not exist). */
export function createStoreProjectSource(store: Pick<DocumentStore, "get" | "query">, orgId: OrgId): ProjectSource {
  return {
    async revision(project, revision) {
      const [document, meta] = await Promise.all([store.get(projectRevisionKey(orgId, project, revision)), store.get(projectMetaKey(orgId, project))]);
      return revisionOf(document, meta);
    },
    async latest(project) {
      // The catalog row names the latest revision; a project registered before the pointer existed is found by its newest revision row.
      const [catalog, meta] = await Promise.all([store.get(orgProjectCatalogKey(orgId, project)), store.get(projectMetaKey(orgId, project))]);
      if (typeof catalog?.latestRevision === "number") {
        const named = revisionOf(await store.get(projectRevisionKey(orgId, project, catalog.latestRevision)), meta);
        if (named !== undefined) return named;
      }
      const page = await store.query({ pk: projectPk(orgId, project), sk: { op: "beginsWith", prefix: PROJECT_REVISION_SK_PREFIX }, descending: true, limit: 1 });
      return revisionOf(page.items[0], meta);
    },
  };
}
