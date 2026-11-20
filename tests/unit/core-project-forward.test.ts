import { expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, orgProjectCatalogKey, projectRevisionKey } from "@agentx/contracts";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { registerRevision } from "../support/developer-task-broker.js";
import { projectKey } from "../../packages/broker/src/aws/project-records.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
it("dual-writes an update from stored company A, without touching same-name B", async () => {
  const h = await createAdminReadBroker();
  const old = h.db.get(projectKey("payments", 1).pk, projectKey("payments", 1).sk)!;
  h.db.set({ ...old, companyId: A });
  const foreign = { ...old, ...projectRevisionKey(B, "payments", 2), companyId: B };
  h.db.set(foreign);
  await registerRevision(h.handler, 2, {});
  expect(h.db.get(projectRevisionKey(A, "payments", 2).pk, projectRevisionKey(A, "payments", 2).sk)?.definition).toMatchObject({ revision: 2 });
  expect(h.db.get(orgProjectCatalogKey(A, "payments").pk, "PROJECT#payments")?.latestRevision).toBe(2);
  expect(h.db.get(projectKey("payments", 2).pk, projectKey("payments", 2).sk)?.companyId).toBe(A);
  expect(h.db.get(foreign.pk, foreign.sk)).toEqual(foreign);
});
it("repairs core layout on duplicate registration even when legacy catalog already matches", async () => {
  const h = await createAdminReadBroker();
  const key = projectKey("payments", 1);
  h.db.set({ ...h.db.get(key.pk, key.sk)!, companyId: A });
  const stored = h.db.get(key.pk, key.sk)!;
  expect((await h.admin("POST", "/v1/admin/projects", { body: { definition: stored.definition, runtimeBinding: stored.runtimeBinding } })).status).toBe(201);
  expect(h.db.get(projectRevisionKey(A, "payments", 1).pk, key.sk)?.definition).toMatchObject({ revision: 1 });
});
it("keeps company-less registrations unindexed until the implicit catalog is flagged", async () => {
  const h = await createAdminReadBroker();
  const row = h.db.get("PROJECT#payments", projectKey("payments", 1).sk)!;
  const before = [...h.db.items];
  const answer = await h.admin("POST", "/v1/admin/projects", { body: { definition: row.definition, runtimeBinding: row.runtimeBinding } });
  expect(answer.status).toBe(201);
  expect(answer.body.duplicate).toBe(true);
  expect([...h.db.items]).toEqual(before);
  expect(h.db.get(projectRevisionKey(IMPLICIT_COMPANY_ID, "payments", 1).pk, "REV#000000000001")).toBeUndefined();
  expect(h.db.get(orgProjectCatalogKey(IMPLICIT_COMPANY_ID, "payments").pk, "PROJECT#payments")).toBeUndefined();
});
it("a conflicting core row refuses the entire legacy registration transaction", async () => {
  const h = await createAdminReadBroker();
  const key = projectKey("payments", 1);
  const old = h.db.get(key.pk, key.sk)!;
  h.db.set({ ...old, companyId: A });
  const foreign = { ...old, ...projectRevisionKey(A, "payments", 2), companyId: B };
  h.db.set(foreign);
  await expect(registerRevision(h.handler, 2, {})).rejects.toThrow();
  expect(h.db.get(projectKey("payments", 2).pk, projectKey("payments", 2).sk)).toBeUndefined();
  expect(h.db.get(foreign.pk, foreign.sk)).toEqual(foreign);
});
it("fences stored ownership if it changes while the new revision commits", async () => {
  const h = await createAdminReadBroker();
  const key = projectKey("payments", 1), old = h.db.get(projectKey("payments", 1).pk, projectKey("payments", 1).sk)!;
  h.db.set({ ...old, companyId: A });
  h.db.injectFault({ command: "TransactWriteCommand", match: () => { h.db.set({ ...old, companyId: B }); return false; }, error: { name: "unused" } });
  await expect(registerRevision(h.handler, 2, {})).rejects.toThrow();
  expect(h.db.get(projectKey("payments", 2).pk, projectKey("payments", 2).sk)).toBeUndefined();
  expect(h.db.get(projectRevisionKey(A, "payments", 2).pk, projectRevisionKey(A, "payments", 2).sk)).toBeUndefined();
  expect(h.db.get(key.pk, key.sk)?.companyId).toBe(B);
});
