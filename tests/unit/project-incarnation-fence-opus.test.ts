// PROJECT-INCARNATION-FENCE, Opus review: the receipt replay across a deploy. A receipt written before receipts recorded their incarnation (no attribute), or one whose stored incarnation is not a
// valid number, never answers a repeat for a project that has an incarnation: the repeat is the plain stale refusal, nothing is written, and the old receipt is not returned as "replayed".
import { describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { LIFECYCLE_STALE, lifecycleAuditPrefix, lifecyclePartition, lifecycleRefusalPrefix, lifecycleRequestKey, routeProjectLifecycle, type ProjectLifecycleContext } from "../../packages/broker/src/aws/project-lifecycle-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const companyId = "org_aaaaaaaaaaaaaaaaaaaa", project = "web";
const ARCHIVE_ID = "31111111-2222-4333-8444-555555555555";

function world(incarnation: number | undefined) {
  const db = new FakeDynamoDb(), key = projectMetaKey(companyId, project);
  const definition = { name: project, revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };
  db.set({ ...projectRevisionKey(companyId, project, 1), entityType: "PROJECT", definition });
  db.set({ ...orgProjectCatalogKey(companyId, project), entityType: "PROJECT_CATALOG", latestRevision: 1 });
  db.set({ ...key, entityType: "PROJECT_META", companyId, project, status: "active", ...(incarnation === undefined ? {} : { incarnationRevision: incarnation }) });
  const ctx: ProjectLifecycleContext = { documentClient: db, tableName: "state", now: () => Date.parse("2026-11-26T12:00:00.000Z"), membershipOf: async () => ({ companyId, role: "owner" }), grantRole: async () => undefined, archiveTakesEffect: () => true, linkedSlackChannels: async () => 0 };
  const call = (body: Record<string, unknown>) => routeProjectLifecycle(ctx, { personId: "owner", project, action: "archive", body: JSON.stringify(body) });
  const archive = (extra: Record<string, unknown> = {}) => ({ requestId: ARCHIVE_ID, expectedRevision: 0, expectedProjectRevision: 1, acknowledgeNewWorkStops: true, ...extra });
  const rows = (prefix: string) => db.find((item) => item.pk === lifecyclePartition(companyId, project) && String(item.sk).startsWith(prefix));
  const request = lifecycleRequestKey(companyId, project, ARCHIVE_ID);
  /** A receipt row as an earlier Code wrote it (no incarnation), optionally with a stored incarnation value. */
  const oldReceipt = (stored?: unknown) => db.set({ ...request, entityType: "PROJECT_LIFECYCLE_REQUEST", companyId, project, action: "archive", personId: "owner", at: "2026-11-25T12:00:00.000Z",
    receipt: { project, status: "archived", revision: 1, projectRevision: 1, archivedAt: "2026-11-25T12:00:00.000Z", egressReconciliation: "pending" }, ...(stored === undefined ? {} : { incarnationRevision: stored }) });
  return { db, key, call, archive, rows, oldReceipt };
}

describe("a receipt that does not name the project's current incarnation never answers a repeat", () => {
  it("a receipt written before this change (no incarnation) for a project that has one: the repeat, named or not, is stale and writes nothing", async () => {
    const h = world(7);
    h.oldReceipt();
    await expect(h.call(h.archive({ expectedProjectIncarnation: 7 }))).rejects.toMatchObject({ code: "CHANGE_STALE", message: `CHANGE_STALE: ${LIFECYCLE_STALE}` });
    await expect(h.call(h.archive())).rejects.toMatchObject({ code: "CHANGE_STALE", message: `CHANGE_STALE: ${LIFECYCLE_STALE}` });
    expect(h.db.get(h.key.pk, h.key.sk)).not.toHaveProperty("lifecycleRevision");
    expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "active", incarnationRevision: 7 });
    expect(h.rows(lifecycleAuditPrefix)).toHaveLength(0);
    // A stale receipt is not an incarnation refusal: no refusal row.
    expect(h.rows(lifecycleRefusalPrefix)).toHaveLength(0);
  });

  it("a project that gained an incarnation since its receipt (incarnation 1 now, receipt with none): the repeat is stale", async () => {
    const h = world(1);
    h.oldReceipt();
    await expect(h.call(h.archive())).rejects.toMatchObject({ code: "CHANGE_STALE", message: `CHANGE_STALE: ${LIFECYCLE_STALE}` });
    expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "active" });
  });

  it.each([[0], ["7"], [7.5], [null]])("a stored incarnation that is not a valid number (%j) never replays, even when the project's is 7", async (stored) => {
    const h = world(7);
    h.oldReceipt(stored);
    await expect(h.call(h.archive({ expectedProjectIncarnation: 7 }))).rejects.toMatchObject({ code: "CHANGE_STALE", message: `CHANGE_STALE: ${LIFECYCLE_STALE}` });
    expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "active" });
    expect(h.rows(lifecycleAuditPrefix)).toHaveLength(0);
  });

  it("the same receipt shape that names the current incarnation still replays (control)", async () => {
    const h = world(7);
    h.oldReceipt(7);
    expect(await h.call(h.archive({ expectedProjectIncarnation: 7 }))).toMatchObject({ replayed: true, receipt: { status: "archived" } });
  });
});
