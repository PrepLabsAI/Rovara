import { expect, it } from "vitest";
import { orgProjectCatalogKey, projectMetaKey, projectRevisionKey, type StoredDocument } from "@agentx/contracts";
import { projectIncarnationSettlement } from "../../packages/broker/src/core/project-incarnation.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { registerProject } from "../../packages/broker/src/local/app/projects.js";
import { createStoreProjectSource } from "../../packages/broker/src/core/task-flow/project-source.js";
import { COMPANY_PURGE_COOLING_OFF_MS, requestCompanyPurge, runCompanyPurge } from "../../packages/broker/src/core/company/purge.js";
import { DocumentAuditSink } from "../../packages/local-adapters/src/document-audit-sink.js";

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

it("a retired project is unavailable even when a partial purge left its revision and catalogue", async () => {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...projectRevisionKey(company, project, 1), entityType: "PROJECT", definition } });
  await store.put({ item: { ...orgProjectCatalogKey(company, project), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  await store.put({ item: identity(4, "deleted") });
  const source = createStoreProjectSource(store, company);
  expect(await source.latest(project)).toBeUndefined();
  expect(await source.revision(project, 1)).toBeUndefined();
  await expect(registerProject(store, company, definition)).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
});

it("real bounded company purge retains a minimal generation tombstone through resumed passes and recreation", async () => {
  const store = new MemoryDocumentStore();
  await registerProject(store, company, definition);
  await store.update({ key, ops: [{ op: "set", path: ["description"], value: "remove project content" }] });
  let now = Date.parse("2026-11-21T12:00:00.000Z");
  const audit = new DocumentAuditSink({ store: () => store });
  const deps = { store, audit, now: () => now, objects: { deleteEveryVersion: async () => true as const }, companyClosure: async () => ({ closed: true as const, closeId: "closed" }) };
  const by = { kind: "operator" as const, operatorId: "ops" };
  await requestCompanyPurge(deps, { companyId: company, by, requestId: "11111111-2222-4333-8444-555555555555" });
  now += COMPANY_PURGE_COOLING_OFF_MS + 1;
  let outcome = "";
  for (let page = 0; page < 50; page++) {
    const result = await runCompanyPurge(deps, company, 500);
    outcome = result.outcome;
    if (outcome === "done") break;
  }
  expect(outcome).toBe("done");
  expect(await store.get(key)).toEqual(identity(1, "deleted"));
  expect(await store.get(projectRevisionKey(company, project, 1))).toBeUndefined();
  expect(await store.get(orgProjectCatalogKey(company, project))).toBeUndefined();
  await registerProject(store, company, definition);
  expect(await store.get(key)).toMatchObject(identity(2));
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
