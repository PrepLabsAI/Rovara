import { expect, it } from "vitest";
import { orgProjectCatalogKey, projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { backfillCorePage } from "../../packages/broker/src/aws/core-project-backfill.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const companyId = "org_aaaaaaaaaaaaaaaaaaaa";
const otherCompany = "org_bbbbbbbbbbbbbbbbbbbb";
const project = "web";
const definition = (revision = 1) => ({ name: project, revision, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." });
const legacy = (revision = 1) => ({ pk: "PROJECT#web", sk: `REV#${String(revision).padStart(12, "0")}`, entityType: "PROJECT", companyId, definition: definition(revision) });
const request = { companyId, projectNames: [project], dryRun: false };
function world() {
  const db = new FakeDynamoDb();
  const deps = { documentClient: db, tableName: "state", signInTableName: "signin" };
  db.set(legacy());
  const key = projectMetaKey(companyId, project);
  return { db, deps, key, meta: () => db.get(key.pk, key.sk) };
}

it("gives a verified imported live project its first retained incarnation and keeps it across revisions/replay", async () => {
  const h = world();
  expect(await backfillCorePage(h.deps, request)).toMatchObject({ written: 1, failed: 0, skippedConflict: 0 });
  expect(h.meta()).toMatchObject({ entityType: "PROJECT_META", companyId, project, incarnationRevision: 1, status: "active" });
  h.db.set(legacy(2));
  expect(await backfillCorePage(h.deps, request)).toMatchObject({ written: 1, failed: 0, skippedConflict: 0 });
  expect(h.meta()?.incarnationRevision).toBe(1);
  expect(await backfillCorePage(h.deps, request)).toMatchObject({ written: 0, failed: 0, skippedConflict: 0 });
  expect(h.meta()?.incarnationRevision).toBe(1);
});

it("legacy import never silently migrates an existing native target", async () => {
  const h = world();
  h.db.set({ ...legacy(), ...projectRevisionKey(companyId, project, 1) });
  h.db.set({ ...orgProjectCatalogKey(companyId, project), entityType: "PROJECT_CATALOG", latestRevision: 1 });
  h.db.set({ ...h.key, entityType: "PROJECT_META", status: "archived", lifecycleRevision: 7 });
  const before = [...h.db.items];
  expect(await backfillCorePage(h.deps, request)).toMatchObject({ written: 0, skippedConflict: 1 });
  expect([...h.db.items]).toEqual(before);
});

it("recreation increments the retained tombstone instead of recycling generation one", async () => {
  const h = world();
  h.db.set({ ...h.key, entityType: "PROJECT_META", companyId, project, incarnationRevision: 9, status: "deleted" });
  expect(await backfillCorePage(h.deps, request)).toMatchObject({ written: 1, failed: 0, skippedConflict: 0 });
  expect(h.meta()).toMatchObject({ incarnationRevision: 10, status: "active" });
  expect(await backfillCorePage(h.deps, request)).toMatchObject({ written: 0, skippedConflict: 0 });
  expect(h.meta()?.incarnationRevision).toBe(10);
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined])("refuses corrupt retained generations (%s) rather than treating them as missing", async (incarnationRevision) => {
  const h = world();
  h.db.set({ ...h.key, entityType: "PROJECT_META", companyId, project, status: "deleted", ...(incarnationRevision === undefined ? {} : { incarnationRevision }) });
  expect(await backfillCorePage(h.deps, request)).toMatchObject({ written: 0, skippedConflict: 1 });
  expect(h.db.get(projectRevisionKey(companyId, project, 1).pk, projectRevisionKey(companyId, project, 1).sk)).toBeUndefined();
});

it("refuses overflow, foreign markers and incomplete deletion without overwriting retained identity", async () => {
  for (const extra of [{ incarnationRevision: Number.MAX_SAFE_INTEGER }, { companyId: otherCompany, incarnationRevision: 3 }, { project: "other", incarnationRevision: 3 }, { incarnationRevision: 3, partial: true }]) {
    const h = world();
    const meta = { ...h.key, entityType: "PROJECT_META", companyId, project, status: "deleted", ...extra };
    h.db.set(meta);
    if ("partial" in extra) h.db.set({ ...legacy(), ...projectRevisionKey(companyId, project, 1) });
    expect(await backfillCorePage(h.deps, request)).toMatchObject({ written: 0, skippedConflict: 1 });
    expect(h.meta()).toEqual(meta);
  }
});
