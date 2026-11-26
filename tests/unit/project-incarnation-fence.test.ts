// PROJECT-INCARNATION-FENCE: the archive and restore confirm names the project incarnation its preview showed. Code refuses a confirm whose incarnation is not the project's now (the project was
// deleted and created again under the same name between the preview and the confirm), before anything is written, and keeps the refusal as an audit row. A confirm that names none behaves as before.
import { describe, expect, it } from "vitest";
import { ReviewedProjectArchiveBodySchema, ReviewedProjectRestoreBodySchema, orgProjectCatalogKey, projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { LIFECYCLE_INCARNATION_CHANGED, LIFECYCLE_STALE, lifecycleAuditPrefix, lifecyclePartition, lifecycleRefusalPrefix, lifecycleRequestKey, routeProjectLifecycle, type ProjectLifecycleContext } from "../../packages/broker/src/aws/project-lifecycle-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const companyId = "org_aaaaaaaaaaaaaaaaaaaa", project = "web";
const ARCHIVE_ID = "11111111-2222-4333-8444-555555555555", RESTORE_ID = "21111111-2222-4333-8444-555555555555";

function world(options: { incarnation?: number | undefined; role?: "owner" | "member"; grant?: "developer" | undefined } = {}) {
  const db = new FakeDynamoDb(), key = projectMetaKey(companyId, project);
  const definition = { name: project, revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };
  db.set({ ...projectRevisionKey(companyId, project, 1), entityType: "PROJECT", definition });
  db.set({ ...orgProjectCatalogKey(companyId, project), entityType: "PROJECT_CATALOG", latestRevision: 1 });
  const incarnation = "incarnation" in options ? options.incarnation : 7;
  const meta = { ...key, entityType: "PROJECT_META", companyId, project, status: "active", ...(incarnation === undefined ? {} : { incarnationRevision: incarnation }) };
  db.set(meta);
  const ctx: ProjectLifecycleContext = { documentClient: db, tableName: "state", now: () => Date.parse("2026-11-26T12:00:00.000Z"), membershipOf: async () => ({ companyId, role: options.role ?? "owner" }), grantRole: async () => options.grant, archiveTakesEffect: () => true, linkedSlackChannels: async () => 0 };
  const call = (action: Parameters<typeof routeProjectLifecycle>[1]["action"], body?: unknown) => routeProjectLifecycle(ctx, { personId: "owner", project, action, body: body === undefined ? undefined : JSON.stringify(body) });
  const archive = (extra: Record<string, unknown> = {}) => ({ requestId: ARCHIVE_ID, expectedRevision: 0, expectedProjectRevision: 1, acknowledgeNewWorkStops: true, ...extra });
  const restore = (extra: Record<string, unknown> = {}) => ({ requestId: RESTORE_ID, expectedRevision: 1, expectedProjectRevision: 1, acknowledgeNewWorkAllowed: true, ...extra });
  const rows = (prefix: string) => db.find((item) => item.pk === lifecyclePartition(companyId, project) && String(item.sk).startsWith(prefix));
  /** The project is deleted and created again under the same name: a new incarnation, the same lifecycle state. */
  const recreate = (to: number) => db.set({ ...(db.get(key.pk, key.sk) ?? meta), incarnationRevision: to });
  return { db, key, ctx, call, archive, restore, rows, recreate };
}

describe("the confirm names the incarnation that was previewed", () => {
  it("archive: a matching incarnation proceeds, and the project keeps it", async () => {
    const h = world();
    const previewed = (await h.call("archive-preview") as { expectedProjectIncarnation?: number }).expectedProjectIncarnation;
    expect(previewed).toBe(7);
    const outcome = await h.call("archive", h.archive({ expectedProjectIncarnation: previewed }));
    expect(outcome).toMatchObject({ receipt: { status: "archived", revision: 1 }, replayed: false, current: { status: "archived", expectedProjectIncarnation: 7 } });
    expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "archived", lifecycleRevision: 1, incarnationRevision: 7 });
    expect(h.rows(lifecycleAuditPrefix)).toHaveLength(1);
    expect(h.rows(lifecycleRefusalPrefix)).toHaveLength(0);
  });

  it("restore: a matching incarnation proceeds", async () => {
    const h = world();
    await h.call("archive", h.archive());
    const previewed = (await h.call("restore-preview") as { expectedProjectIncarnation?: number }).expectedProjectIncarnation;
    const outcome = await h.call("restore", h.restore({ expectedProjectIncarnation: previewed }));
    expect(outcome).toMatchObject({ receipt: { status: "active", revision: 2 }, replayed: false });
    expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "active", incarnationRevision: 7 });
  });

  it("archive: a project created again under the same name since the preview is refused with the stable sentence, and nothing changes", async () => {
    const h = world();
    const previewed = (await h.call("archive-preview") as { expectedProjectIncarnation?: number }).expectedProjectIncarnation;
    h.recreate(8);
    const before = structuredClone(h.db.get(h.key.pk, h.key.sk));
    const sentBefore = h.db.commandNames().length;
    await expect(h.call("archive", h.archive({ expectedProjectIncarnation: previewed }))).rejects.toMatchObject({ code: "CHANGE_STALE", message: `CHANGE_STALE: ${LIFECYCLE_INCARNATION_CHANGED}` });
    expect(LIFECYCLE_INCARNATION_CHANGED).toBe("This project changed since you previewed it; preview again.");
    expect(LIFECYCLE_INCARNATION_CHANGED).not.toBe(LIFECYCLE_STALE);
    expect(h.db.get(h.key.pk, h.key.sk)).toEqual(before);
    expect(h.db.get(lifecycleRequestKey(companyId, project, ARCHIVE_ID).pk, lifecycleRequestKey(companyId, project, ARCHIVE_ID).sk)).toBeUndefined();
    expect(h.rows(lifecycleAuditPrefix)).toHaveLength(0);
    // No transaction was attempted: only the reads and the one refusal row.
    expect(h.db.commandNames().slice(sentBefore)).not.toContain("TransactWriteCommand");
  });

  it("the refusal says why in the audit: who, which change, the two incarnations; never anything else", async () => {
    const h = world();
    h.recreate(9);
    await expect(h.call("archive", h.archive({ expectedProjectIncarnation: 7 }))).rejects.toMatchObject({ code: "CHANGE_STALE" });
    const refusals = h.rows(lifecycleRefusalPrefix);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toEqual({
      pk: lifecyclePartition(companyId, project), sk: `${lifecycleRefusalPrefix}2026-11-26T12:00:00.000Z#${ARCHIVE_ID}`, entityType: "PROJECT_LIFECYCLE_REFUSAL",
      companyId, project, action: "archive", personId: "owner", basis: "company-owner", reason: "project_incarnation_changed", previewedIncarnation: 7, currentIncarnation: 9, at: "2026-11-26T12:00:00.000Z",
    });
  });

  it("restore: a mismatch is refused the same way, and the archived project stays archived", async () => {
    const h = world();
    await h.call("archive", h.archive());
    h.recreate(8);
    await expect(h.call("restore", h.restore({ expectedProjectIncarnation: 7 }))).rejects.toMatchObject({ code: "CHANGE_STALE", message: `CHANGE_STALE: ${LIFECYCLE_INCARNATION_CHANGED}` });
    expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "archived", lifecycleRevision: 1, incarnationRevision: 8 });
    expect(h.rows(lifecycleRefusalPrefix)).toMatchObject([{ action: "restore", previewedIncarnation: 7, currentIncarnation: 8 }]);
    expect(h.rows(lifecycleAuditPrefix)).toHaveLength(1);
  });

  it("an older confirm that names no incarnation behaves as before: it proceeds, and the write is still fenced on the incarnation read at confirm time", async () => {
    const h = world();
    expect(await h.call("archive", h.archive())).toMatchObject({ receipt: { status: "archived" }, replayed: false });
    expect(h.rows(lifecycleRefusalPrefix)).toHaveLength(0);
    const racing = world();
    racing.ctx.documentClient = { async send(command: unknown) {
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") racing.recreate(8);
      return racing.db.send(command as never);
    } };
    await expect(racing.call("archive", racing.archive())).rejects.toMatchObject({ code: "CHANGE_STALE", message: `CHANGE_STALE: ${LIFECYCLE_STALE}` });
    expect(racing.db.get(racing.key.pk, racing.key.sk)).toMatchObject({ status: "active", incarnationRevision: 8 });
  });

  it("a project with no incarnation: the preview names none, a confirm without one proceeds, and a confirm naming one is refused", async () => {
    const h = world({ incarnation: undefined });
    expect(await h.call("archive-preview")).not.toHaveProperty("expectedProjectIncarnation");
    await expect(h.call("archive", h.archive({ expectedProjectIncarnation: 7 }))).rejects.toMatchObject({ code: "CHANGE_STALE", message: `CHANGE_STALE: ${LIFECYCLE_INCARNATION_CHANGED}` });
    expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "active" });
    expect(h.rows(lifecycleRefusalPrefix)).toMatchObject([{ previewedIncarnation: 7 }]);
    expect(h.rows(lifecycleRefusalPrefix)[0]).not.toHaveProperty("currentIncarnation");
    expect(await h.call("archive", h.archive())).toMatchObject({ receipt: { status: "archived" } });
    expect(h.db.get(h.key.pk, h.key.sk)).not.toHaveProperty("incarnationRevision");
  });

  it("a retry of a confirm that already happened answers its receipt only while the project is still the one previewed", async () => {
    const h = world();
    await h.call("archive", h.archive({ expectedProjectIncarnation: 7 }));
    expect(await h.call("archive", h.archive({ expectedProjectIncarnation: 7 }))).toMatchObject({ replayed: true, receipt: { status: "archived", revision: 1 } });
    h.recreate(8);
    await expect(h.call("archive", h.archive({ expectedProjectIncarnation: 7 }))).rejects.toMatchObject({ message: `CHANGE_STALE: ${LIFECYCLE_INCARNATION_CHANGED}` });
  });

  it("a person who may not change the project gets the fixed refusal, not the incarnation sentence, and no row", async () => {
    const h = world({ role: "member", grant: "developer" });
    h.recreate(8);
    await expect(h.call("archive", h.archive({ expectedProjectIncarnation: 7 }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.rows(lifecycleRefusalPrefix)).toHaveLength(0);
  });

  it("the refusal stands when its audit row cannot be written", async () => {
    const h = world();
    h.recreate(8);
    h.db.injectFault({ command: "PutCommand", error: { name: "ProvisionedThroughputExceededException" } });
    await expect(h.call("archive", h.archive({ expectedProjectIncarnation: 7 }))).rejects.toMatchObject({ code: "CHANGE_STALE", message: `CHANGE_STALE: ${LIFECYCLE_INCARNATION_CHANGED}` });
    expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "active" });
  });
});

describe("the confirm bodies", () => {
  const base = { requestId: ARCHIVE_ID, expectedRevision: 0, expectedProjectRevision: 1 };
  const bodies = [["archive", ReviewedProjectArchiveBodySchema, { acknowledgeNewWorkStops: true }], ["restore", ReviewedProjectRestoreBodySchema, { acknowledgeNewWorkAllowed: true }]] as const;
  it.each(bodies)("%s takes the optional incarnation (a positive whole number, as the preview carries it) and stays strict", (_kind, schema, ack) => {
    expect(schema.safeParse({ ...base, ...ack }).success).toBe(true);
    for (const good of [1, 7, Number.MAX_SAFE_INTEGER]) expect(schema.parse({ ...base, ...ack, expectedProjectIncarnation: good })).toMatchObject({ expectedProjectIncarnation: good });
    for (const bad of [0, -1, 1.5, "7", null, true, [7], { n: 7 }, Number.MAX_SAFE_INTEGER + 1]) expect(schema.safeParse({ ...base, ...ack, expectedProjectIncarnation: bad }).success).toBe(false);
    expect(schema.safeParse({ ...base, ...ack, expectedProjectIncarnation: 7, somethingElse: 1 }).success).toBe(false);
  });
});
