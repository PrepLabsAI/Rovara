// Lane L6a, task flow core: registered projects read from the document store, by Cloud's keys (`projectRevisionKey`, `orgProjectCatalogKey`).
import {
  ProjectRevisionUnreadableError,
  noAutomatedTestsOfRow,
  orgProjectCatalogKey,
  projectMetaKey,
  projectPk,
  projectRevisionKey,
  PROJECT_REVISION_SK_PREFIX,
  readStoredProject,
  type DocumentStore,
  type OrgId,
  type StoredDocument,
} from "@agentx/contracts";
import type { ProjectRevision, ProjectSource } from "./deps.js";

function revisionOf(document: StoredDocument | undefined, meta: StoredDocument | undefined): ProjectRevision | undefined {
  if (document === undefined || meta?.status === "deleted") return undefined;
  // The stored record is read with the stored reader (arch rule 8): the rules that judge new input are asked again where the record is used (start.ts, dispatch.ts).
  const parsed = readStoredProject(document.definition);
  const noTests = noAutomatedTestsOfRow(document);
  return parsed.success ? { definition: parsed.data, ...(meta?.status === "archived" ? { archived: true } : {}), ...(noTests === undefined ? {} : { noAutomatedTests: noTests }) } : undefined;
}

/** Reads project revisions from the store. A pinned revision that does not read is absent (the caller says the revision is gone); the project's LATEST that does not read is refused, never replaced by an older one. */
export function createStoreProjectSource(store: Pick<DocumentStore, "get" | "query">, orgId: OrgId): ProjectSource {
  const unreadable = () => new ProjectRevisionUnreadableError();
  return {
    async revision(project, revision) {
      const [document, meta] = await Promise.all([store.get(projectRevisionKey(orgId, project, revision)), store.get(projectMetaKey(orgId, project))]);
      return revisionOf(document, meta);
    },
    async latest(project) {
      // The catalog row names the latest revision; a project registered before the pointer existed is found by its newest revision row.
      const [catalog, meta] = await Promise.all([store.get(orgProjectCatalogKey(orgId, project)), store.get(projectMetaKey(orgId, project))]);
      if (meta?.status === "deleted") return undefined;
      if (typeof catalog?.latestRevision === "number") {
        // The catalog names THE revision: if it is missing or does not read, the project is refused (arch rule 9), not served from the newest older row.
        const named = revisionOf(await store.get(projectRevisionKey(orgId, project, catalog.latestRevision)), meta);
        if (named === undefined) throw unreadable();
        return named;
      }
      // A candidate revision (a setup waiting for the owner's approval) is never the project's latest, whatever the catalog says.
      const page = await store.query({ pk: projectPk(orgId, project), sk: { op: "beginsWith", prefix: PROJECT_REVISION_SK_PREFIX }, descending: true, limit: 20 });
      const newest = page.items.find((item) => item["candidate"] !== true);
      if (newest === undefined) return undefined;
      const found = revisionOf(newest, meta);
      if (found === undefined) throw unreadable();
      return found;
    },
  };
}
