// L4-SF (c): after a hosted setup approval the old broker's project registry is given the approved revision in the same decision, so the next operator or admin registration is not refused ("core project copy
// refused"). The mirror writes the exact revision, only for the company that owns the old rows, only while the old registry is where the setup was made from, and nothing on a rejection. While a proposal waits, the
// refusal says so.
import { describe, expect, it } from "vitest";
import { canonicalJson, orgProjectCatalogKey, projectCatalogKey, projectRevisionKey } from "@agentx/contracts";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { planCoreProjectWrites, coreCopyRefusalWords, CORE_COPY_REFUSED } from "../../packages/broker/src/aws/core-project-backfill.js";
import { SETUP_REGISTRY_MOVED, createSetupRegistryMirror } from "../../packages/broker/src/aws/setup-registry-mirror.js";
import { projectKey } from "../../packages/broker/src/aws/project-records.js";
import { setupApplyKey } from "../../packages/broker/src/core/setup-agent/apply.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import type { FakeWorld } from "../support/core-host-fakes.js";
import { FAKE_COMPANY, LEDGER, OTHER, RUN, applyRow, command, decideBody, get, latestOf, post, projectDefinition, registerLegacy, seedCandidate, setupWorld } from "../support/hosted-setup-world.js";

const LOW = { setup: [command("npm", ["ci", "--cache", ".npm-cache"])] };
const legacyRow = (world: FakeWorld, name: string, revision: number) => world.store.get(projectKey(name, revision));
const legacyCatalog = async (world: FakeWorld, name: string) => (await world.store.get(projectCatalogKey(name)))?.["latestRevision"];
const content = (row: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => !["pk", "sk", "companyId", "backfillRunId"].includes(key)));

describe("L4-SF (c): the old registry follows an approved setup", () => {
  it("mirrors the approved revision (exactly N+1) into the old registry in the decision: the legacy row, the legacy catalog and the core's own row agree", async () => {
    const { world, person, call } = await setupWorld({ legacy: [["payments", FAKE_COMPANY]] });
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", LOW);
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    const decided = await call(post(`${RUN}/decide`, decideBody(digest)), maintainer);
    expect(decided.status, decided.raw).toBe(200);
    expect(await latestOf(world, FAKE_COMPANY)).toBe(2);
    const mirrored = await legacyRow(world, "payments", 2);
    expect(mirrored).toMatchObject({ entityType: "PROJECT", companyId: FAKE_COMPANY, definition: { name: "payments", revision: 2, setup: LOW.setup }, runtimeBinding: { deploymentMode: "ec2-ebs", image: "demo@sha256:abc" }, registeredBy: "owner-key-1" });
    expect(await legacyCatalog(world, "payments")).toBe(2);
    // The base legacy row is untouched, and no other revision appeared.
    expect(await legacyRow(world, "payments", 1)).toMatchObject({ definition: { revision: 1 }, registeredAt: "2026-11-01T00:00:00.000Z" });
    expect(await legacyRow(world, "payments", 3)).toBeUndefined();
    // The two copies of revision 2 are one content: what planCoreProjectWrites checks for the next registration.
    expect(canonicalJson(content(mirrored) as never)).toBe(canonicalJson(content(await world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2))) as never));
  });

  it("lets the next operator registration through planCoreProjectWrites (revision 3), where without the mirror it is refused as a conflict", async () => {
    for (const mirror of [true, false]) {
      const { world, person, call } = await setupWorld({ legacy: [["payments", FAKE_COMPANY]], mirror });
      const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", LOW);
      const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
      expect((await call(post(`${RUN}/decide`, decideBody(digest)), maintainer)).status).toBe(200);
      // The same rows, in the old broker's own table fake, and the registration the old broker would now plan: revision 3 of the project.
      const db = new FakeDynamoDb();
      const keys = [projectKey("payments", 1), projectKey("payments", 2), projectCatalogKey("payments"), projectRevisionKey(FAKE_COMPANY, "payments", 1), projectRevisionKey(FAKE_COMPANY, "payments", 2), orgProjectCatalogKey(FAKE_COMPANY, "payments")];
      for (const key of keys) { const row = await world.store.get(key); if (row !== undefined) db.set(row as never); }
      const deps = { tableName: "state", documentClient: { send: (c: unknown) => db.send(c as never) } };
      const record = { ...projectKey("payments", 3), entityType: "PROJECT", companyId: FAKE_COMPANY, definition: projectDefinition("payments", 3), runtimeBinding: { deploymentMode: "ec2-ebs" }, registeredBy: "owner-key-1", registeredAt: "2026-11-17T00:00:00.000Z" };
      if (mirror) {
        const plan = await planCoreProjectWrites(deps, record);
        expect(plan.status).toBe("ready");
        // The writes that follow are the core's revision 3 and its catalog moving from 2 to 3: the plan read the mirrored history and fenced it.
        const fenced = JSON.stringify(plan.writes);
        expect(fenced).toContain("REV#000000000002");
        await db.send(new TransactWriteCommand({ TransactItems: plan.writes }));
        expect(db.get(orgProjectCatalogKey(FAKE_COMPANY, "payments").pk, "PROJECT#payments")?.latestRevision).toBe(3);
      } else {
        await expect(planCoreProjectWrites(deps, record)).rejects.toThrow("core project conflict");
      }
    }
  });

  it("writes nothing to the old registry for a rejection, a discard or a low-risk decision that is refused", async () => {
    const { world, person, call } = await setupWorld({ legacy: [["payments", FAKE_COMPANY]] });
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", { network: { allowedDomains: ["api.stripe.com"] } });
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    // Refused (high risk, maintainer): nothing changes.
    expect((await call(post(`${RUN}/decide`, decideBody(digest)), maintainer)).status).toBe(403);
    expect(await legacyRow(world, "payments", 2)).toBeUndefined();
    expect(await legacyCatalog(world, "payments")).toBe(1);
    // Rejected: still nothing.
    expect((await call(post(`${RUN}/decide`, decideBody(digest, "reject")), maintainer)).status).toBe(200);
    expect(await legacyRow(world, "payments", 2)).toBeUndefined();
    expect(await legacyCatalog(world, "payments")).toBe(1);
  });

  it("never reads or writes another company's old rows: an old row of the other company (or of the implicit one) is left alone and the core still approves", async () => {
    for (const owner of [OTHER, undefined]) {
      const { world, person, call } = await setupWorld({ legacy: [["payments", owner]] });
      const before = [await legacyRow(world, "payments", 1), await world.store.get(projectCatalogKey("payments"))];
      const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", LOW);
      const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
      const decided = await call(post(`${RUN}/decide`, decideBody(digest)), maintainer);
      expect(decided.status, decided.raw).toBe(200);
      expect(await latestOf(world, FAKE_COMPANY)).toBe(2);
      expect(await legacyRow(world, "payments", 2), String(owner)).toBeUndefined();
      expect([await legacyRow(world, "payments", 1), await world.store.get(projectCatalogKey("payments"))]).toEqual(before);
      // The other company's own candidate row is not the one that was written to either.
      expect((await world.store.get(projectRevisionKey(OTHER, "payments", 2)))).toBeUndefined();
    }
  });

  it("two projects: approving one project leaves the other's old rows alone", async () => {
    const { world, person, call } = await setupWorld({ legacy: [["payments", FAKE_COMPANY], ["ledger", FAKE_COMPANY]] });
    const ledgerBefore = [await legacyRow(world, "ledger", 1), await world.store.get(projectCatalogKey("ledger"))];
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", LOW);
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator", ledger: "administrator" });
    expect((await call(post(`${RUN}/decide`, decideBody(digest)), maintainer)).status).toBe(200);
    expect(await legacyRow(world, "payments", 2)).toBeDefined();
    expect([await legacyRow(world, "ledger", 1), await world.store.get(projectCatalogKey("ledger"))]).toEqual(ledgerBefore);
    expect(await legacyRow(world, "ledger", 2)).toBeUndefined();
    // The other company's project of the same name keeps its own state too.
    expect(await latestOf(world, OTHER)).toBe(1);
    expect(await call(get(LEDGER), maintainer).then((answer) => answer.status)).toBe(200);
  });

  it("a project the core made on its own (no old registry rows) is approved with nothing mirrored", async () => {
    const { world, person, call } = await setupWorld();
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", LOW);
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    expect((await call(post(`${RUN}/decide`, decideBody(digest)), maintainer)).status).toBe(200);
    expect(await latestOf(world, FAKE_COMPANY)).toBe(2);
    expect(await legacyRow(world, "payments", 1)).toBeUndefined();
    expect(await legacyRow(world, "payments", 2)).toBeUndefined();
    expect(await world.store.get(projectCatalogKey("payments"))).toBeUndefined();
  });

  it.each([
    ["the old catalog has moved on (ahead of the base)", async (world: FakeWorld) => { await world.store.put({ item: { ...projectCatalogKey("payments"), entityType: "PROJECT_CATALOG", name: "payments", latestRevision: 2 } }); }],
    ["an old row already holds the candidate's revision", async (world: FakeWorld) => { await world.store.put({ item: { ...projectKey("payments", 2), entityType: "PROJECT", companyId: FAKE_COMPANY, definition: projectDefinition("payments", 2), runtimeBinding: {}, registeredBy: "x", registeredAt: "2026-11-02T00:00:00.000Z" } }); }],
    ["the old base row has no runtime binding", async (world: FakeWorld) => { await world.store.put({ item: { ...projectKey("payments", 1), entityType: "PROJECT", companyId: FAKE_COMPANY, definition: projectDefinition("payments"), registeredBy: "owner-key-1", registeredAt: "2026-11-01T00:00:00.000Z" } }); }],
    ["the old base row names another project", async (world: FakeWorld) => { await world.store.put({ item: { ...projectKey("payments", 1), entityType: "PROJECT", companyId: FAKE_COMPANY, definition: projectDefinition("ledger"), runtimeBinding: {}, registeredBy: "owner-key-1", registeredAt: "2026-11-01T00:00:00.000Z" } }); }],
    ["the old catalog row is damaged", async (world: FakeWorld) => { await world.store.put({ item: { ...projectCatalogKey("payments"), entityType: "SOMETHING_ELSE", name: "payments", latestRevision: 1 } }); }],
  ])("refuses the approval, writing nothing, when %s", async (_label, damage) => {
    const { world, person, call } = await setupWorld({ legacy: [["payments", FAKE_COMPANY]] });
    await damage(world);
    const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", LOW);
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    const refused = await call(post(`${RUN}/decide`, decideBody(digest)), maintainer);
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: { code: "CONFIG_INVALID", message: SETUP_REGISTRY_MOVED } });
    expect(await latestOf(world, FAKE_COMPANY)).toBe(1);
    expect(await applyRow(world, FAKE_COMPANY)).toMatchObject({ state: "checking" });
    expect(await world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2))).not.toHaveProperty("runtimeBinding");
  });

  it("holds its own conditions in the transaction: an old catalog or an old row that moves after the read fails the whole decision", async () => {
    const { world } = await setupWorld({ legacy: [["payments", FAKE_COMPANY]] });
    await seedCandidate(world, FAKE_COMPANY, "payments", LOW);
    const mirror = createSetupRegistryMirror({ store: world.store, companyId: FAKE_COMPANY });
    const row = { project: "payments", baseRevision: 1, candidateRevision: 2 };
    // The catalog moves after the mirror read it: its step fails and nothing of the steps applies.
    const steps = await mirror.itemsFor(row, "2026-11-17T00:00:00.000Z");
    await world.store.put({ item: { ...projectCatalogKey("payments"), entityType: "PROJECT_CATALOG", name: "payments", latestRevision: 2 } });
    expect((await world.store.transact(steps)).applied).toBe(false);
    expect(await legacyRow(world, "payments", 2)).toBeUndefined();
    // A rival registers revision 2 in the old registry after the read: the put is refused.
    await world.store.put({ item: { ...projectCatalogKey("payments"), entityType: "PROJECT_CATALOG", name: "payments", latestRevision: 1 } });
    const again = await mirror.itemsFor(row, "2026-11-17T00:00:00.000Z");
    await world.store.put({ item: { ...projectKey("payments", 2), entityType: "PROJECT", companyId: FAKE_COMPANY, definition: projectDefinition("payments", 2), runtimeBinding: {}, registeredBy: "rival", registeredAt: "2026-11-17T00:00:00.000Z" } });
    expect((await world.store.transact(again)).applied).toBe(false);
    expect(await legacyRow(world, "payments", 2)).toMatchObject({ registeredBy: "rival" });
    // The base row changes owner after the read: the check fails.
    await world.store.delete({ key: projectKey("payments", 2) });
    const third = await mirror.itemsFor(row, "2026-11-17T00:00:00.000Z");
    await registerLegacy(world, "payments", OTHER);
    expect((await world.store.transact(third)).applied).toBe(false);
  });

  it("refuses a candidate that is not exactly the next revision after its base", async () => {
    const { world } = await setupWorld({ legacy: [["payments", FAKE_COMPANY]] });
    await seedCandidate(world, FAKE_COMPANY, "payments", LOW);
    const mirror = createSetupRegistryMirror({ store: world.store, companyId: FAKE_COMPANY });
    for (const row of [{ project: "payments", baseRevision: 1, candidateRevision: 3 }, { project: "payments", baseRevision: 2, candidateRevision: 2 }, { project: "payments", baseRevision: 0, candidateRevision: 1 }]) {
      await expect(mirror.itemsFor(row, "2026-11-17T00:00:00.000Z"), JSON.stringify(row)).rejects.toMatchObject({ code: "invalid", message: SETUP_REGISTRY_MOVED });
    }
  });
});

describe("L4-SF (c): the refusal says a setup change is waiting", () => {
  const A = FAKE_COMPANY;
  const row = (companyId: string, state: string) => ({ ...setupApplyKey(companyId as never, "payments"), entityType: "SETUP_APPLY", state });
  const depsOf = (db: FakeDynamoDb) => ({ tableName: "state", documentClient: { send: (c: unknown) => db.send(c as never) } });

  it("names the waiting setup when the company has one in `checking`, and keeps the plain words otherwise (another state, another company, another project, no row, an unreadable store)", async () => {
    const db = new FakeDynamoDb();
    expect(await coreCopyRefusalWords(depsOf(db), A, "payments")).toBe(CORE_COPY_REFUSED);
    db.set(row(A, "checking") as never);
    const words = await coreCopyRefusalWords(depsOf(db), A, "payments");
    expect(words).toContain(CORE_COPY_REFUSED);
    expect(words).toContain("waiting for approval");
    expect(words).toContain("Approve or discard");
    // Positive control above; now every other case is the plain words.
    expect(await coreCopyRefusalWords(depsOf(db), OTHER, "payments")).toBe(CORE_COPY_REFUSED);
    expect(await coreCopyRefusalWords(depsOf(db), A, "ledger")).toBe(CORE_COPY_REFUSED);
    for (const state of ["approved", "rejected", "discarded"]) { db.set(row(A, state) as never); expect(await coreCopyRefusalWords(depsOf(db), A, "payments"), state).toBe(CORE_COPY_REFUSED); }
    db.set(row(A, "checking") as never);
    expect(await coreCopyRefusalWords({ tableName: "state", documentClient: { send: async () => { throw new Error("private detail"); } } }, A, "payments")).toBe(CORE_COPY_REFUSED);
    expect(await coreCopyRefusalWords(depsOf(db), A, "../bad")).toBe(CORE_COPY_REFUSED);
  });

  it("carries no stored text: the words are fixed whatever the row holds", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...row(A, "checking"), project: "private-canary", by: "private-canary" } as never);
    expect(await coreCopyRefusalWords(depsOf(db), A, "payments")).not.toContain("private-canary");
  });
});
