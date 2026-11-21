import { expect, it } from "vitest";
import { projectMetaKey } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { registerProject } from "../../packages/broker/src/local/app/projects.js";
import { retireProjectIncarnation } from "../../packages/broker/src/core/project-incarnation.js";
const company = "org_aaaaaaaaaaaaaaaaaaaa", key = projectMetaKey(company, "web");
const definition = { name: "web", revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };
it("concurrent recreations consume one increment; repeats and revisions keep that incarnation", async () => {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...key, entityType: "PROJECT_META", companyId: company, project: "web", status: "deleted", incarnationRevision: 17 } });
  const results = await Promise.all([registerProject(store, company, definition), registerProject(store, company, definition)]);
  expect(results.map(result => result.duplicate).sort()).toEqual([false, true]);
  expect(await store.get(key)).toMatchObject({ incarnationRevision: 18 });
});
it.each([0, -1, 1.5, null, "1", Number.MAX_SAFE_INTEGER + 1])("corrupt incarnation %s cannot be registered or retired into generation one", async revision => {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...key, entityType: "PROJECT_META", companyId: company, project: "web", status: "deleted", incarnationRevision: revision } });
  const before = await store.get(key);
  await expect(registerProject(store, company, definition)).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
  await expect(retireProjectIncarnation(store, company, "web")).rejects.toThrow();
  expect(await store.get(key)).toEqual(before);
});
it("a lost marker on a stamped live catalogue cannot be reinitialized by erasure", async () => {
  const store = new MemoryDocumentStore();
  await registerProject(store, company, definition);
  await store.delete({ key });
  await expect(retireProjectIncarnation(store, company, "web")).rejects.toThrow();
  expect(await store.get(key)).toBeUndefined();
});
