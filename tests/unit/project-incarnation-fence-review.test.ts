// PROJECT-INCARNATION-FENCE, pre-review additions (Sonnet): the atomicity of the fence (a recreate that lands after the check and before the write), no row for a person outside the company,
// and the oracle/spam surface of the refusal row. Test-only; the builder's own cases are in project-incarnation-fence.test.ts.
import { describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { LIFECYCLE_INCARNATION_CHANGED, LIFECYCLE_STALE, lifecycleAuditPrefix, lifecyclePartition, lifecycleRefusalPrefix, lifecycleRequestKey, routeProjectLifecycle, type ProjectLifecycleContext } from "../../packages/broker/src/aws/project-lifecycle-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const companyId = "org_aaaaaaaaaaaaaaaaaaaa", otherCompany = "org_bbbbbbbbbbbbbbbbbbbb", project = "web";
const ID = "11111111-2222-4333-8444-555555555555";

function world(options: { company?: string; status?: "active" | "archived" } = {}) {
  const db = new FakeDynamoDb(), key = projectMetaKey(companyId, project);
  db.set({ ...projectRevisionKey(companyId, project, 1), entityType: "PROJECT", definition: { name: project, revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." } });
  db.set({ ...orgProjectCatalogKey(companyId, project), entityType: "PROJECT_CATALOG", latestRevision: 1 });
  const meta = { ...key, entityType: "PROJECT_META", companyId, project, status: options.status ?? "active", incarnationRevision: 7, ...(options.status === "archived" ? { lifecycleRevision: 1 } : {}) };
  db.set(meta);
  const ctx: ProjectLifecycleContext = { documentClient: db, tableName: "state", now: () => Date.parse("2026-11-26T12:00:00.000Z"), membershipOf: async () => ({ companyId: options.company ?? companyId, role: "owner" }), grantRole: async () => undefined, archiveTakesEffect: () => true, linkedSlackChannels: async () => 0 };
  const call = (action: Parameters<typeof routeProjectLifecycle>[1]["action"], body?: unknown) => routeProjectLifecycle(ctx, { personId: "owner", project, action, body: body === undefined ? undefined : JSON.stringify(body) });
  const archive = (extra: Record<string, unknown> = {}) => ({ requestId: ID, expectedRevision: 0, expectedProjectRevision: 1, acknowledgeNewWorkStops: true, ...extra });
  const restore = (extra: Record<string, unknown> = {}) => ({ requestId: ID, expectedRevision: 1, expectedProjectRevision: 1, acknowledgeNewWorkAllowed: true, ...extra });
  const rows = (prefix: string) => db.find((item) => item.pk === lifecyclePartition(companyId, project) && String(item.sk).startsWith(prefix));
  const recreate = (to: number) => db.set({ ...(db.get(key.pk, key.sk) ?? meta), incarnationRevision: to });
  /** Runs `hook` just before the first transaction is sent: a recreate that lands after the check and before the write. */
  const raceAtWrite = (hook: () => void) => { ctx.documentClient = { async send(command: unknown) { if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") hook(); return db.send(command as never); } }; };
  return { db, key, ctx, call, archive, restore, rows, recreate, raceAtWrite };
}

describe("the fence is atomic with the write (a recreate between the check and the write)", () => {
  it("archive: the confirm NAMES the previewed incarnation, passes the check, and a recreate lands before the transaction: the write is refused, nothing changes", async () => {
    const h = world();
    h.raceAtWrite(() => h.recreate(8));
    await expect(h.call("archive", h.archive({ expectedProjectIncarnation: 7 }))).rejects.toMatchObject({ code: "CHANGE_STALE", message: `CHANGE_STALE: ${LIFECYCLE_STALE}` });
    expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "active", incarnationRevision: 8 });
    expect(h.db.get(h.key.pk, h.key.sk)).not.toHaveProperty("lifecycleRevision");
    const request = lifecycleRequestKey(companyId, project, ID);
    expect(h.db.get(request.pk, request.sk)).toBeUndefined();
    expect(h.rows(lifecycleAuditPrefix)).toHaveLength(0);
  });

  it("restore: the same", async () => {
    const h = world({ status: "archived" });
    h.raceAtWrite(() => h.recreate(8));
    await expect(h.call("restore", h.restore({ expectedProjectIncarnation: 7 }))).rejects.toMatchObject({ code: "CHANGE_STALE", message: `CHANGE_STALE: ${LIFECYCLE_STALE}` });
    expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "archived", incarnationRevision: 8, lifecycleRevision: 1 });
    expect(h.rows(lifecycleAuditPrefix)).toHaveLength(0);
  });

  it("a recreate that retires the identity (a deleted tombstone) after the check is refused too", async () => {
    const h = world();
    h.raceAtWrite(() => h.db.set({ ...h.key, entityType: "PROJECT_META", companyId, project, status: "deleted", incarnationRevision: 7 }));
    await expect(h.call("archive", h.archive({ expectedProjectIncarnation: 7 }))).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "deleted" });
  });
});

describe("who can reach the fence", () => {
  it("a person whose company is not the project's company gets the uniform not-found and no row, even naming the incarnation", async () => {
    const h = world({ company: otherCompany });
    h.recreate(8);
    await expect(h.call("archive", h.archive({ expectedProjectIncarnation: 7 }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.rows(lifecycleRefusalPrefix)).toHaveLength(0);
    expect(h.db.find((item) => String(item.sk).startsWith(lifecycleRefusalPrefix))).toHaveLength(0);
  });

  it("the refusal answer is the same sentence whatever the number sent: it does not say what the current incarnation is", async () => {
    const h = world();
    const seen = new Set<string>();
    for (const guess of [1, 6, 8, 9, 1000]) {
      const error = await h.call("archive", { ...h.archive({ expectedProjectIncarnation: guess }), requestId: `${guess}`.padStart(8, "0") + "-2222-4333-8444-555555555555" }).catch((e: Error) => e);
      seen.add((error as Error).message);
    }
    expect([...seen]).toEqual([`CHANGE_STALE: ${LIFECYCLE_INCARNATION_CHANGED}`]);
    expect(JSON.stringify([...seen])).not.toContain("7");
  });
});

describe("what the refusal row does not bound (recorded, not asserted as desired)", () => {
  it("one authorized person can add one row per refused request id: the row count is not capped", async () => {
    const h = world();
    for (let n = 0; n < 5; n += 1) await h.call("archive", { ...h.archive({ expectedProjectIncarnation: 9 }), requestId: `0000000${n}-2222-4333-8444-555555555555` }).catch(() => undefined);
    expect(h.rows(lifecycleRefusalPrefix)).toHaveLength(5);
  });
});
