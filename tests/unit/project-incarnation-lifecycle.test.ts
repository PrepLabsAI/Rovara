import { expect, it } from "vitest";
import { orgProjectCatalogKey, projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { routeProjectLifecycle, type ProjectLifecycleContext } from "../../packages/broker/src/aws/project-lifecycle-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const companyId = "org_aaaaaaaaaaaaaaaaaaaa", project = "web";
function world() {
  const db = new FakeDynamoDb(), key = projectMetaKey(companyId, project);
  const definition = { name: project, revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };
  db.set({ ...projectRevisionKey(companyId, project, 1), entityType: "PROJECT", definition });
  db.set({ ...orgProjectCatalogKey(companyId, project), entityType: "PROJECT_CATALOG", latestRevision: 1 });
  const meta = { ...key, entityType: "PROJECT_META", companyId, project, status: "active", incarnationRevision: 7 };
  db.set(meta);
  const ctx: ProjectLifecycleContext = { documentClient: db, tableName: "state", now: () => Date.parse("2026-11-21T12:00:00.000Z"), membershipOf: async () => ({ companyId, role: "owner" }), grantRole: async () => undefined, archiveTakesEffect: () => true, linkedSlackChannels: async () => 0 };
  const call = (action: Parameters<typeof routeProjectLifecycle>[1]["action"], body?: unknown) => routeProjectLifecycle(ctx, { personId: "owner", project, action, body: body === undefined ? undefined : JSON.stringify(body) });
  const archive = { requestId: "11111111-2222-4333-8444-555555555555", expectedRevision: 0, expectedProjectRevision: 1, acknowledgeNewWorkStops: true };
  return { db, key, ctx, meta, call, archive };
}
it("previews expose the retained incarnation; archive and explicit same-incarnation restore preserve it", async () => {
  const h = world();
  expect(await h.call("archive-preview")).toMatchObject({ expectedProjectIncarnation: 7 });
  await h.call("archive", h.archive);
  expect(await h.call("restore-preview")).toMatchObject({ expectedProjectIncarnation: 7 });
  await h.call("restore", { requestId: "21111111-2222-4333-8444-555555555555", expectedRevision: 1, expectedProjectRevision: 1, acknowledgeNewWorkAllowed: true });
  expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ incarnationRevision: 7, status: "active" });
});
it.each(["deleted", "corrupt"])("%s identity is unavailable to lifecycle preview", async kind => {
  const h = world(); h.db.set({ ...h.meta, ...(kind === "deleted" ? { status: "deleted" } : { incarnationRevision: 0 }) });
  await expect(h.call("archive-preview")).rejects.toThrow();
});
it("archive's META write cannot commit across retirement/recreation", async () => {
  const h = world();
  h.ctx.documentClient = { async send(command: unknown) {
    if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") h.db.set({ ...h.meta, incarnationRevision: 8 });
    return h.db.send(command as never);
  } };
  await expect(h.call("archive", h.archive)).rejects.toMatchObject({ code: "CHANGE_STALE" });
  expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "active", incarnationRevision: 8 });
});
