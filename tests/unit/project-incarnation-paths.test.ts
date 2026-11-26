import { expect, it } from "vitest";
import { orgProjectCatalogKey, projectMetaKey, projectRevisionKey, type StoredDocument } from "@agentx/contracts";
import { projectIncarnationSettlement } from "../../packages/broker/src/core/project-incarnation.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { registerProject } from "../../packages/broker/src/core-host/app/projects.js";
import { createStoreProjectSource } from "../../packages/broker/src/core/task-flow/project-source.js";

const company = "org_aaaaaaaaaaaaaaaaaaaa";
const project = "web";
const key = projectMetaKey(company, project);
const definition = { name: project, revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };
const identity = (incarnationRevision = 1, status = "active"): StoredDocument => ({ ...key, entityType: "PROJECT_META", companyId: company, project, incarnationRevision, status });

it("registers, revises and repeats locally without changing the incarnation", async () => {
  const store = new MemoryDocumentStore();
  await registerProject(store, company, definition);
  expect(await store.get(key)).toMatchObject(identity());
  expect(await registerProject(store, company, definition)).toMatchObject({ duplicate: true });
  await registerProject(store, company, { ...definition, orchestratorInstructions: "Updated instructions." });
  expect(await store.get(key)).toMatchObject(identity());
});

it("local recreation increments a tombstone; a live project with a lost marker requires verified migration", async () => {
  const store = new MemoryDocumentStore();
  await store.put({ item: identity(7, "deleted") });
  expect(await registerProject(store, company, definition)).toMatchObject({ revision: 1 });
  expect(await store.get(key)).toMatchObject(identity(8));
  await store.delete({ key });
  await expect(registerProject(store, company, { ...definition, orchestratorInstructions: "Changed." })).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
});

it("a retired project is unavailable even when its revision and catalogue were left behind", async () => {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...projectRevisionKey(company, project, 1), entityType: "PROJECT", definition } });
  await store.put({ item: { ...orgProjectCatalogKey(company, project), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  await store.put({ item: identity(4, "deleted") });
  const source = createStoreProjectSource(store, company);
  expect(await source.latest(project)).toBeUndefined();
  expect(await source.revision(project, 1)).toBeUndefined();
  await expect(registerProject(store, company, definition)).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
});

it("settlement fences the exact generation/status in the transaction, including a delete/recreate race", async () => {
  const store = new MemoryDocumentStore();
  await store.put({ item: identity() });
  const condition = projectIncarnationSettlement(company, project, await store.get(key), 1);
  const resultKey = { pk: "TEST_RESULT", sk: "grant" };
  // Same name, project revision and lifecycle revision can all be reused; the incarnation cannot.
  await store.put({ item: identity(2) });
  expect(await store.transact([{ kind: "check", key, condition }, { kind: "put", item: { ...resultKey, granted: true } }])).toMatchObject({ applied: false });
  expect(await store.get(resultKey)).toBeUndefined();
  for (const status of ["archived", "deleted"]) {
    await store.put({ item: identity(1, status) });
    expect(await store.transact([{ kind: "check", key, condition }, { kind: "put", item: { ...resultKey, granted: true } }])).toMatchObject({ applied: false });
  }
  await store.put({ item: identity() });
  expect(await store.transact([{ kind: "check", key, condition }, { kind: "put", item: { ...resultKey, granted: true } }])).toMatchObject({ applied: true });
});

it.each([undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", 2])("old or malformed invitation pins (%s) never supply settlement authority", expected => {
  expect(() => projectIncarnationSettlement(company, project, identity(), expected)).toThrow();
});

it.each(["indexExpiresAt", "expiresAt"])("settlement rejects a %s identity and fences expiry added after its read", async field => {
  const store = new MemoryDocumentStore();
  expect(() => projectIncarnationSettlement(company, project, { ...identity(), [field]: 123 }, 1)).toThrow();
  await store.put({ item: identity() });
  const condition = projectIncarnationSettlement(company, project, await store.get(key), 1);
  await store.put({ item: { ...identity(), [field]: 123 } });
  expect(await store.transact([{ kind: "check", key, condition }])).toMatchObject({ applied: false });
});
