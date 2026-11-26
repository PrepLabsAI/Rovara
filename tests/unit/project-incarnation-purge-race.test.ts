import { expect, it } from "vitest";
import { projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { registerProject } from "../../packages/broker/src/core-host/app/projects.js";
import { COMPANY_PURGE_COOLING_OFF_MS, requestCompanyPurge, runCompanyPurge } from "../../packages/broker/src/core/company/purge.js";
import { DocumentAuditSink } from "../../packages/broker/src/plugins/audit-sink/document/sink.js";
it("purge cannot delete a replacement's content while its identity remains live", async () => {
  const companyId = "org_aaaaaaaaaaaaaaaaaaaa", project = "web", store = new MemoryDocumentStore();
  const key = projectMetaKey(companyId, project), revisionKey = projectRevisionKey(companyId, project, 1);
  const definition = { name: project, revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };
  await registerProject(store, companyId, definition);
  let now = Date.parse("2026-11-21T12:00:00.000Z"), raced = false, unsafe = false;
  const deps = { store, audit: new DocumentAuditSink({ store: () => store }), now: () => now, objects: { deleteEveryVersion: async () => true as const }, companyClosure: async () => ({ closed: true as const, closeId: "close" }) };
  const race = async () => {
    if (raced) return; raced = true;
    await store.put({ item: { ...key, entityType: "PROJECT_META", companyId, project, incarnationRevision: 2, status: "active" } });
  };
  const observe = async () => { if (raced && await store.get(revisionKey) === undefined && (await store.get(key))?.["status"] === "active") unsafe = true; };
  const remove = store.delete.bind(store), transact = store.transact.bind(store);
  store.delete = async request => {
    if (request.key.pk === revisionKey.pk && request.key.sk === revisionKey.sk) await race();
    const result = await remove(request); await observe(); return result;
  };
  store.transact = async items => {
    if (items.some(item => item.kind === "delete" && item.key.pk === revisionKey.pk && item.key.sk === revisionKey.sk)) await race();
    const result = await transact(items); await observe(); return result;
  };
  await requestCompanyPurge(deps, { companyId, by: { kind: "operator", operatorId: "ops" }, requestId: "11111111-2222-4333-8444-555555555555" });
  now += COMPANY_PURGE_COOLING_OFF_MS + 1;
  for (let page = 0; page < 30; page++) if ((await runCompanyPurge(deps, companyId, 500)).outcome === "done") break;
  expect(raced).toBe(true);
  expect(unsafe).toBe(false);
  expect(await store.get(key)).toMatchObject({ incarnationRevision: 2, status: "deleted" });
});
