// A document store holding one registered project, for the tests of the test environment's modules.
import { projectMetaKey, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";

/** The project as the store reader finds it: one revision, an active record, and (when asked) a dev container. */
export async function projectStore(orgId: OrgId, project: string, options: { devcontainer?: boolean; archived?: boolean; store?: MemoryDocumentStore } = {}): Promise<MemoryDocumentStore> {
  const store = options.store ?? new MemoryDocumentStore();
  await store.put({ item: { ...projectMetaKey(orgId, project), status: options.archived === true ? "archived" : "active" } });
  const definition = {
    name: project, revision: 1,
    repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [], readiness: [], orchestratorInstructions: "x",
    ...(options.devcontainer === true ? { devcontainer: { repository: "web" } } : {}),
  };
  await store.put({ item: { ...projectRevisionKey(orgId, project, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: {}, definition: definition } });
  return store;
}
