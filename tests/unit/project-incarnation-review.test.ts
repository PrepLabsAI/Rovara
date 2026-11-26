import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJson, IMPLICIT_COMPANY_ID, orgProjectCatalogKey, projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { registerProject } from "../../packages/broker/src/core-host/app/projects.js";
import { backfillCorePage } from "../../packages/broker/src/aws/core-project-backfill.js";
import { catalogBackfill } from "../../packages/broker/src/aws/project-catalog-backfill.js";
import { latestRevisionRowFor } from "../../packages/broker/src/aws/company-layout.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const companyId = "org_aaaaaaaaaaaaaaaaaaaa", project = "web";
const definition = { name: project, revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };
const hash = (row: unknown) => createHash("sha256").update(canonicalJson(row)).digest("hex");
const setupCheck = { workspaceId: "workspace", revision: 1, startedAt: "2026-11-21T12:00:00.000Z", startedBy: "owner" };
it.each([{ companyId: "org_bbbbbbbbbbbbbbbbbbbb" }, { orgId: "org_bbbbbbbbbbbbbbbbbbbb" }])("registration refuses to recycle a corrupt ownership tombstone's generation (%j)", async drift => {
  const store = new MemoryDocumentStore(), key = projectMetaKey(companyId, project);
  const item = { ...key, entityType: "PROJECT_META", companyId, project, incarnationRevision: 7, status: "deleted", ...drift };
  await store.put({ item });
  await expect(registerProject(store, companyId, definition)).rejects.toThrow();
  expect(await store.get(key)).toEqual(item);
});
it("implicit mirror undo preserves a witness that refuses a subsequently lost META", async () => {
  const db = new FakeDynamoDb(), company = IMPLICIT_COMPANY_ID, key = projectMetaKey(company, project);
  const deps = { documentClient: db, tableName: "state", signInTableName: "signin" }, input = { companyId: company, projectNames: [project], runId: "run-a", dryRun: false };
  db.set({ pk: "PROJECT#web", sk: "REV#000000000001", entityType: "PROJECT", definition });
  await backfillCorePage(deps, input);
  expect(await catalogBackfill(deps, { companyId: company, runId: "run-a", action: "undo-run", dryRun: false })).toMatchObject({ ok: true });
  db.delete(key.pk, key.sk); const before = [...db.items];
  expect(await backfillCorePage(deps, input)).toMatchObject({ written: 0, skippedConflict: 1 });
  expect([...db.items]).toEqual(before);
});
it("verified migration accepts the exact pre-rollout setup-check-only META shape", async () => {
  const db = new FakeDynamoDb(), key = projectMetaKey(companyId, project);
  const revision = { ...projectRevisionKey(companyId, project, 1), entityType: "PROJECT", definition };
  const catalog = { ...orgProjectCatalogKey(companyId, project), entityType: "PROJECT_CATALOG", latestRevision: 1 };
  const meta = { ...key, setupCheck };
  for (const row of [revision, catalog, meta]) db.set(row);
  expect(await backfillCorePage({ documentClient: db, tableName: "state", signInTableName: "signin" }, { mode: "migrate-incarnations", companyId, projectNames: [project], runId: "pre-rollout", dryRun: false,
    inventory: [{ project, revision: 1, revisionDigest: hash(revision), catalogDigest: hash(catalog), metaDigest: hash(meta) }] })).toMatchObject({ written: 1, skippedConflict: 0 });
  expect(db.get(key.pk, key.sk)).toMatchObject({ setupCheck, incarnationRevision: 1 });
});
it("local revisions never overwrite setup state added concurrently", async () => {
  const store = new MemoryDocumentStore(), key = projectMetaKey(companyId, project);
  await registerProject(store, companyId, definition);
  const original = store.transact.bind(store); let raced = false;
  store.transact = async items => {
    if (!raced) { raced = true; await store.update({ key, ops: [{ op: "set", path: ["setupCheck"], value: setupCheck }] }); }
    return original(items);
  };
  await registerProject(store, companyId, { ...definition, orchestratorInstructions: "Updated." });
  expect(await store.get(key)).toMatchObject({ setupCheck, incarnationRevision: 1 });
});
it("a retained implicit tombstone hides leftover authoritative legacy revisions", async () => {
  const db = new FakeDynamoDb();
  db.set({ pk: "PROJECT#web", sk: "REV#000000000001", entityType: "PROJECT", definition });
  db.set({ ...projectMetaKey(IMPLICIT_COMPANY_ID, project), entityType: "PROJECT_META", companyId: IMPLICIT_COMPANY_ID, project, incarnationRevision: 2, status: "deleted" });
  expect(await latestRevisionRowFor(db, "state", IMPLICIT_COMPANY_ID, project)).toBeUndefined();
});

it("a setup check that raced retirement cannot attach content or start work on the tombstone", async () => {
  const { createHarness } = await import("../support/task-flow-harness.js");
  const { startProjectSetupCheck } = await import("../../packages/broker/src/core/setup-agent/check.js");
  const h = createHarness({ companyId }); await h.registerProject(definition);
  const key = projectMetaKey(companyId, project), meta = { ...key, entityType: "PROJECT_META", companyId, project, incarnationRevision: 1, status: "active" };
  await h.store.put({ item: meta });
  const original = h.store.transact.bind(h.store);
  h.store.transact = async items => {
    await h.store.put({ item: { ...meta, status: "deleted" } });
    return original(items);
  };
  await expect(startProjectSetupCheck(h.deps, { project, requestId: "11111111-2222-4333-8444-555555555555", startedBy: "owner" })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  expect(await h.store.get(key)).toEqual({ ...meta, status: "deleted" });
});
it("migration's inventory fence refuses a setup mark first added between its read and write", async () => {
  const db = new FakeDynamoDb(), key = projectMetaKey(companyId, project);
  const revision = { ...projectRevisionKey(companyId, project, 1), entityType: "PROJECT", definition };
  const catalog = { ...orgProjectCatalogKey(companyId, project), entityType: "PROJECT_CATALOG", latestRevision: 1 };
  const meta = { ...key, entityType: "PROJECT_META", status: "active" };
  for (const row of [revision, catalog, meta]) db.set(row);
  const client = { async send(command: unknown) {
    if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") db.set({ ...meta, setupCheck });
    return db.send(command as never);
  } };
  expect(await backfillCorePage({ documentClient: client, tableName: "state", signInTableName: "signin" }, { mode: "migrate-incarnations", companyId, projectNames: [project], runId: "pre-rollout", dryRun: false,
    inventory: [{ project, revision: 1, revisionDigest: hash(revision), catalogDigest: hash(catalog), metaDigest: hash(meta) }] })).toMatchObject({ written: 0, failed: 1 });
  expect(db.get(key.pk, key.sk)).toEqual({ ...meta, setupCheck });
});
