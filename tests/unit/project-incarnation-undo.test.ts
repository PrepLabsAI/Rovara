import { expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, projectMetaKey } from "@agentx/contracts";
import { backfillCorePage } from "../../packages/broker/src/aws/core-project-backfill.js";
import { catalogBackfill } from "../../packages/broker/src/aws/project-catalog-backfill.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const company = "org_aaaaaaaaaaaaaaaaaaaa";
async function world(companyId = company) {
  const db = new FakeDynamoDb(), key = projectMetaKey(companyId, "web");
  const deps = { documentClient: db, tableName: "state", signInTableName: "signin" };
  db.set({ pk: "PROJECT#web", sk: "REV#000000000001", entityType: "PROJECT", ...(companyId === IMPLICIT_COMPANY_ID ? {} : { companyId }), definition: { name: "web", revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." } });
  const input = { companyId, projectNames: ["web"], dryRun: false, runId: "run-a" };
  expect(await backfillCorePage(deps, input)).toMatchObject({ written: 1, failed: 0 });
  const undo = () => catalogBackfill(deps, { companyId, action: "undo-run", runId: "run-a", dryRun: false });
  return { db, deps, key, input, undo };
}
it("undo retires a named company's canonical identity; re-import is a new incarnation", async () => {
  const h = await world();
  h.db.set({ ...h.db.get(h.key.pk, h.key.sk)!, incarnationRevision: 7 });
  expect(await h.undo()).toMatchObject({ ok: true, deleteCount: 2 });
  expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "deleted", incarnationRevision: 7 });
  expect(await backfillCorePage(h.deps, h.input)).toMatchObject({ written: 1, failed: 0 });
  expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "active", incarnationRevision: 8 });
});
it("undo of an implicit company's mirror proves the same live legacy identity and retains its generation", async () => {
  const h = await world(IMPLICIT_COMPANY_ID);
  expect(await h.undo()).toMatchObject({ ok: true });
  expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "active", incarnationRevision: 1 });
  expect(await backfillCorePage(h.deps, h.input)).toMatchObject({ written: 1, failed: 0 });
  expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "active", incarnationRevision: 1 });
});
it.each(["missing", "corrupt"])("undo refuses %s retained identity without deleting content", async kind => {
  const h = await world();
  if (kind === "missing") h.db.delete(h.key.pk, h.key.sk);
  else h.db.set({ ...h.db.get(h.key.pk, h.key.sk)!, incarnationRevision: 0 });
  const before = [...h.db.items];
  expect(await h.undo()).toMatchObject({ ok: false });
  expect([...h.db.items]).toEqual(before);
});
it("undo's retirement fences the exact generation and leaves a concurrent replacement untouched", async () => {
  const h = await world();
  h.db.injectFault({ command: "TransactWriteCommand", match: () => { h.db.set({ ...h.db.get(h.key.pk, h.key.sk)!, incarnationRevision: 9 }); return false; }, error: { name: "unused" } });
  expect(await h.undo()).toMatchObject({ ok: false });
  expect(h.db.get(h.key.pk, h.key.sk)).toMatchObject({ status: "active", incarnationRevision: 9 });
});
