import { beforeAll, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, orgProjectCatalogKey, projectMetaKey } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { retireProjectIncarnation } from "../../packages/broker/src/core/project-incarnation.js";
import { planCoreProjectWrites } from "../../packages/broker/src/aws/core-project-backfill.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

const companyId = IMPLICIT_COMPANY_ID, project = "web", key = projectMetaKey(companyId, project);
const definition = { name: project, revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };
const legacy = { pk: "PROJECT#web", sk: "REV#000000000001", entityType: "PROJECT", definition };
const catalog = { pk: "PROJECT_CATALOG", sk: "PROJECT#web", entityType: "PROJECT_CATALOG", name: project, latestRevision: 1, incarnationRevision: 7 };
beforeAll(async () => { await loadSlackBroker(); });

it.each([false, true])("implicit retirement refuses missing META without losing the stamped catalogue witness (owned=%s)", async owned => {
  const store = new MemoryDocumentStore(), witness = { ...catalog, ...(owned ? { companyId } : {}) };
  await store.put({ item: legacy }); await store.put({ item: witness });
  await expect(retireProjectIncarnation(store, companyId, project)).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
  expect(await store.get(key)).toBeUndefined();
  expect(await store.get(legacy)).toEqual(legacy);
  expect(await store.get(catalog)).toEqual(witness);
  const h = createBroker(); h.db.set(witness); h.db.set(legacy);
  await expect(planCoreProjectWrites({ documentClient: h.db, tableName: "state" }, legacy)).rejects.toThrow();
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
