import { beforeAll, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, orgProjectCatalogKey, projectMetaKey } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { retireProjectIncarnation } from "../../packages/broker/src/core/project-incarnation.js";
import { COMPANY_PURGE_COOLING_OFF_MS, requestCompanyPurge, runCompanyPurge } from "../../packages/broker/src/core/company/purge.js";
import { DocumentAuditSink } from "../../packages/local-adapters/src/document-audit-sink.js";
import { planCoreProjectWrites } from "../../packages/broker/src/aws/core-project-backfill.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

const companyId = IMPLICIT_COMPANY_ID, project = "web", key = projectMetaKey(companyId, project);
const definition = { name: project, revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };
const legacy = { pk: "PROJECT#web", sk: "REV#000000000001", entityType: "PROJECT", definition };
const catalog = { pk: "PROJECT_CATALOG", sk: "PROJECT#web", entityType: "PROJECT_CATALOG", name: project, latestRevision: 1, incarnationRevision: 7 };
const meta = { ...key, entityType: "PROJECT_META", companyId, project, incarnationRevision: 7, status: "active" };
type BrokerModule = { registerProjectForTests: (input: unknown, identity: unknown, value: unknown, company: string | undefined) => Promise<{ duplicate: boolean }> };
let brokerModule: BrokerModule;
beforeAll(async () => { brokerModule = await loadSlackBroker() as unknown as BrokerModule; });

async function purge(store: MemoryDocumentStore) {
  let now = Date.parse("2026-11-21T12:00:00.000Z");
  const deps = { store, audit: new DocumentAuditSink({ store: () => store }), now: () => now, objects: { deleteEveryVersion: async () => true as const }, companyClosure: async () => ({ closed: true as const, closeId: "close" }) };
  await requestCompanyPurge(deps, { companyId, by: { kind: "operator", operatorId: "ops" }, requestId: "11111111-2222-4333-8444-555555555555" });
  now += COMPANY_PURGE_COOLING_OFF_MS + 1;
  for (let page = 0; page < 30; page++) if ((await runCompanyPurge(deps, companyId, 500)).outcome === "done") return "done";
  return "incomplete";
}

it.each([false, true])("implicit purge refuses missing META without losing the stamped catalogue witness (owned=%s)", async owned => {
  const store = new MemoryDocumentStore(), witness = { ...catalog, ...(owned ? { companyId } : {}) };
  await store.put({ item: legacy }); await store.put({ item: witness });
  await expect(retireProjectIncarnation(store, companyId, project)).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
  await expect(purge(store)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  expect(await store.get(key)).toBeUndefined();
  expect(await store.get(legacy)).toEqual(legacy);
  expect(await store.get(catalog)).toEqual(witness);
  const h = createBroker(); h.db.set(witness); h.db.set(legacy);
  await expect(planCoreProjectWrites({ documentClient: h.db, tableName: "state" }, legacy)).rejects.toThrow();
});

it.each([false, true])("implicit purge drains the catalogue and hosted recreation advances generation 7 to 8 (owned=%s)", async owned => {
  const store = new MemoryDocumentStore();
  for (const item of [legacy, { ...catalog, ...(owned ? { companyId } : {}) }, meta]) await store.put({ item });
  expect(await purge(store)).toBe("done");
  expect(await store.get(key)).toEqual({ ...meta, status: "deleted" });
  const h = createBroker();
  for (const rowKey of [key, legacy, catalog]) { const item = await store.get(rowKey); if (item !== undefined) h.db.set(item); }
  const identity = { issuer: "sign-in-client", subject: "owner", ownerKey: "owner", isAdministrator: true, claims: {} };
  const value = { definition, runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" } };
  expect(await brokerModule.registerProjectForTests(h.brokerInput, identity, value, undefined)).toMatchObject({ duplicate: false });
  expect(h.db.get(key.pk, key.sk)).toMatchObject({ incarnationRevision: 8, status: "active" });
  expect(h.db.get(catalog.pk, catalog.sk)).toMatchObject({ incarnationRevision: 8, latestRevision: 1 });
  expect(await store.get(legacy)).toBeUndefined();
  expect(await store.get(catalog)).toBeUndefined();
});

it.each(["legacy-absent", "legacy-unstamped", "canonical-absent"])("retirement fences its catalogue snapshot when initialization races a stamp (%s)", async shape => {
  const store = new MemoryDocumentStore(), witnessKey = shape === "canonical-absent" ? orgProjectCatalogKey(companyId, project) : catalog;
  if (shape === "legacy-unstamped") await store.put({ item: { pk: catalog.pk, sk: catalog.sk, entityType: "PROJECT_CATALOG", name: project, latestRevision: 1 } });
  const transact = store.transact.bind(store);
  store.transact = async items => {
    await store.put({ item: { ...catalog, ...witnessKey, incarnationRevision: 7 } });
    return transact(items);
  };
  await expect(retireProjectIncarnation(store, companyId, project)).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
  expect(await store.get(key)).toBeUndefined();
  expect(await store.get(witnessKey)).toMatchObject({ incarnationRevision: 7 });
});
