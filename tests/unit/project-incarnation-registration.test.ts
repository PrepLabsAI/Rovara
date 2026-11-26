import { planCanonicalProjectIdentity } from "../../packages/broker/src/aws/core-project-backfill.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { expect, it } from "vitest";
import { orgProjectCatalogKey, projectMetaKey, projectRevisionKey, type StoredDocument } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { registerProject } from "../../packages/broker/src/core-host/app/projects.js";
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

// Exact pre-rollout local rows: no company/project/incarnation fields on META.
async function preRollout(meta: StoredDocument = { ...key, entityType: "PROJECT_META", status: "active" }) {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...projectRevisionKey(company, "web", 1), entityType: "PROJECT", definition } });
  await store.put({ item: { ...orgProjectCatalogKey(company, "web"), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  await store.put({ item: meta });
  return store;
}

it("Identical pre-rollout re-send returns duplicate without initializing or writing", async () => {
  const store = await preRollout(), before = await store.get(key);
  store.transact = async () => { throw new Error("duplicate must not write"); };
  expect(await registerProject(store, company, definition)).toEqual({ project: "web", revision: 1, duplicate: true });
  expect(await store.get(key)).toEqual(before);
});
it("Duplicate is checked before identity even when that identity cannot authorize a revision", async () => {
  const store = await preRollout({ ...key, entityType: "UNEXPECTED", status: "active" });
  expect(await registerProject(store, company, definition)).toEqual({ project: "web", revision: 1, duplicate: true });
  await expect(registerProject(store, company, { ...definition, orchestratorInstructions: "Changed." })).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
});
it("Initializes a known pre-rollout project once in its registration transaction; replay writes nothing", async () => {
  const store = await preRollout();
  const changed = { ...definition, orchestratorInstructions: "Changed." };
  expect(await registerProject(store, company, changed)).toEqual({ project: "web", revision: 2, duplicate: false });
  expect(await store.get(key)).toEqual({ ...key, entityType: "PROJECT_META", status: "active", companyId: company, project: "web", incarnationRevision: 1 });
  expect(await store.get(orgProjectCatalogKey(company, "web"))).toMatchObject({ latestRevision: 2, incarnationRevision: 1 });
  store.transact = async () => { throw new Error("replay must not write"); };
  expect(await registerProject(store, company, changed)).toEqual({ project: "web", revision: 2, duplicate: true });
});
it.each([{ entityType: "UNEXPECTED" }, { companyId: "org_bbbbbbbbbbbbbbbbbbbb" }, { status: "deleted" }, { expiresAt: 123 }, { incarnationRevision: 0 }])("Refuses unexpected unstamped META %j without changing registration rows", async extra => {
  const store = await preRollout({ ...key, entityType: "PROJECT_META", status: "active", ...extra });
  const before = await store.query({ pk: key.pk });
  await expect(registerProject(store, company, { ...definition, orchestratorInstructions: "Changed." })).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
  expect(await store.query({ pk: key.pk })).toEqual(before);
  expect(await store.get(orgProjectCatalogKey(company, "web"))).toMatchObject({ latestRevision: 1 });
});
it.each(["meta", "catalog"])("Initialization fences the %s snapshot in the same transaction", async target => {
  const store = await preRollout(), original = store.transact.bind(store);
  store.transact = async items => {
    if (target === "meta") await store.put({ item: { ...key, entityType: "UNEXPECTED", status: "active" } });
    else await store.put({ item: { ...orgProjectCatalogKey(company, "web"), entityType: "PROJECT_CATALOG", latestRevision: 1, incarnationRevision: 7 } });
    return original(items);
  };
  await expect(registerProject(store, company, { ...definition, orchestratorInstructions: "Changed." })).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
  expect(await store.get(projectRevisionKey(company, "web", 2))).toBeUndefined();
  expect((await store.get(key))?.["incarnationRevision"]).toBeUndefined();
});
it("hosted DynamoDB registration never initializes a pre-rollout identity without operator migration", async () => {
  const db = new FakeDynamoDb();
  db.set({ ...key, entityType: "PROJECT_META", status: "active" });
  db.set({ ...projectRevisionKey(company, "web", 1), entityType: "PROJECT", definition });
  db.set({ ...orgProjectCatalogKey(company, "web"), entityType: "PROJECT_CATALOG", latestRevision: 1 });
  const before = [...db.items];
  await expect(planCanonicalProjectIdentity({ documentClient: db, tableName: "state" }, company, "web", true)).rejects.toThrow();
  expect([...db.items]).toEqual(before);
});
