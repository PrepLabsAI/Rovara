// L4-SF (c): after a hosted setup approval the old broker's project registry is given the approved revision in the same decision, so the next operator or admin registration is not refused ("core project copy
// refused"). The mirror writes the exact revision, only for the company that owns the old rows, only while the old registry is where the setup was made from, and nothing on a rejection. While a proposal waits, the
// refusal says so.
import { describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectCatalogKey, projectRevisionKey, type JsonValue } from "@agentx/contracts";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { planCoreProjectWrites } from "../../packages/broker/src/aws/core-project-backfill.js";
import { coreCopyRefusalWords, CORE_COPY_REFUSED } from "../../packages/broker/src/aws/core-copy-refusal.js";
import { SETUP_REGISTRY_MOVED, createSetupRegistryMirror } from "../../packages/broker/src/aws/setup-registry-mirror.js";
import { projectKey } from "../../packages/broker/src/aws/project-records.js";
import { setupApplyKey } from "../../packages/broker/src/core/setup-agent/apply.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import type { FakeWorld } from "../support/core-host-fakes.js";
import { FAKE_COMPANY, LEDGER, OTHER, RUN, applyRow, command, decideBody, get, latestOf, post, projectDefinition, seedCandidate, setupWorld } from "../support/hosted-setup-world.js";

const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const LOW = { setup: [command("npm", ["ci", "--cache", ".npm-cache"])] };
const legacyRow = (world: FakeWorld, name: string, revision: number) => world.store.get(projectKey(name, revision));
const legacyCatalog = async (world: FakeWorld, name: string) => (await world.store.get(projectCatalogKey(name)))?.["latestRevision"];

describe("L4-SF (c): the old registry follows an approved setup", () => {

  it("lets the next operator registration through planCoreProjectWrites (revision 3), where without the mirror it is refused as a conflict", async () => {
    for (const mirror of [true, false]) {
      const { world, person, call } = await setupWorld({ legacy: [["payments", FAKE_COMPANY]], mirror });
      const { digest } = await seedCandidate(world, FAKE_COMPANY, "payments", LOW);
      const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
      expect((await call(post(`${RUN}/decide`, decideBody(digest)), maintainer)).status).toBe(200);
      // The same rows, in the old broker's own table fake, and the registration the old broker would now plan: revision 3 of the project.
      const db = new FakeDynamoDb();
      const keys = [projectKey("payments", 1), projectKey("payments", 2), projectCatalogKey("payments"), projectRevisionKey(FAKE_COMPANY, "payments", 1), projectRevisionKey(FAKE_COMPANY, "payments", 2), orgProjectCatalogKey(FAKE_COMPANY, "payments")];
      for (const key of keys) { const row = await world.store.get(key); if (row !== undefined) db.set(row); }
      const deps = { tableName: "state", documentClient: { send: (c: unknown) => db.send(c as never) } };
      const record = { ...projectKey("payments", 3), entityType: "PROJECT", companyId: FAKE_COMPANY, definition: asJson(projectDefinition("payments", 3)), runtimeBinding: { deploymentMode: "ec2-ebs" }, registeredBy: "owner-key-1", registeredAt: "2026-11-17T00:00:00.000Z" };
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

  it("another company's old rows never block this company: the old project of the same name is theirs at revision 1 while this company's core is at revision 2 (candidate 3), for another company and for the implicit one", async () => {
    for (const owner of [OTHER, undefined]) {
      const { world } = await setupWorld({ legacy: [["payments", owner]] });
      // This company's core is already at revision 2 (an earlier approval that had nothing to mirror) and waits on revision 3.
      await world.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, "payments", 2), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(projectDefinition("payments", 2))) as JsonValue } });
      await world.store.put({ item: { ...orgProjectCatalogKey(FAKE_COMPANY, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 2 } });
      const before = [await legacyRow(world, "payments", 1), await world.store.get(projectCatalogKey("payments"))];
      const definition = { ...projectDefinition("payments", 3), ...LOW };
      await world.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, "payments", 3), entityType: "PROJECT", candidate: true, definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
      const mirror = createSetupRegistryMirror({ store: world.store, companyId: FAKE_COMPANY });
      expect(await mirror.itemsFor({ project: "payments", baseRevision: 2, candidateRevision: 3 }, "2026-11-17T00:00:00.000Z"), String(owner)).toEqual([]);
      expect([await legacyRow(world, "payments", 1), await world.store.get(projectCatalogKey("payments"))]).toEqual(before);
      // The other company's old row may also sit at the candidate's own revision: still theirs, still not a block.
      await world.store.put({ item: { ...projectKey("payments", 3), entityType: "PROJECT", ...(owner === undefined ? {} : { companyId: owner }), definition: JSON.parse(JSON.stringify(projectDefinition("payments", 3))) as JsonValue, runtimeBinding: {}, registeredBy: "theirs", registeredAt: "2026-11-02T00:00:00.000Z" } });
      expect(await mirror.itemsFor({ project: "payments", baseRevision: 2, candidateRevision: 3 }, "2026-11-17T00:00:00.000Z"), `${String(owner)} at N+1`).toEqual([]);
    }
    // Positive control: the same shape with THIS company's old rows is refused (the old registry is not where the setup was made from).
    const { world } = await setupWorld({ legacy: [["payments", FAKE_COMPANY]] });
    const mirror = createSetupRegistryMirror({ store: world.store, companyId: FAKE_COMPANY });
    await expect(mirror.itemsFor({ project: "payments", baseRevision: 2, candidateRevision: 3 }, "2026-11-17T00:00:00.000Z")).rejects.toMatchObject({ message: SETUP_REGISTRY_MOVED });
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
    ["an old row already holds the candidate's revision", async (world: FakeWorld) => { await world.store.put({ item: { ...projectKey("payments", 2), entityType: "PROJECT", companyId: FAKE_COMPANY, definition: asJson(projectDefinition("payments", 2)), runtimeBinding: {}, registeredBy: "x", registeredAt: "2026-11-02T00:00:00.000Z" } }); }],
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

  it("refuses a candidate that is not exactly the next revision after its base", async () => {
    const { world } = await setupWorld({ legacy: [["payments", FAKE_COMPANY]] });
    await seedCandidate(world, FAKE_COMPANY, "payments", LOW);
    // A core row for revision 3 exists too, so only the "exactly the next revision" rule can refuse base 1 -> 3.
    await world.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, "payments", 3), entityType: "PROJECT", candidate: true, definition: JSON.parse(JSON.stringify(projectDefinition("payments", 3))) as JsonValue } });
    const mirror = createSetupRegistryMirror({ store: world.store, companyId: FAKE_COMPANY });
    for (const row of [{ project: "payments", baseRevision: 1, candidateRevision: 3 }, { project: "payments", baseRevision: 2, candidateRevision: 2 }, { project: "payments", baseRevision: 0, candidateRevision: 1 }]) {
      await expect(mirror.itemsFor(row, "2026-11-17T00:00:00.000Z"), JSON.stringify(row)).rejects.toMatchObject({ code: "invalid", message: SETUP_REGISTRY_MOVED });
    }
  });
});

describe("L4-SF (c): the refusal says a setup change is waiting", () => {
  const A = FAKE_COMPANY;
  const row = (companyId: string, state: string) => ({ ...setupApplyKey(companyId, "payments"), entityType: "SETUP_APPLY", state });
  const depsOf = (db: FakeDynamoDb) => ({ tableName: "state", documentClient: { send: (c: unknown) => db.send(c as never) } });

  it("names the waiting setup when the company has one in `checking`, and keeps the plain words otherwise (another state, another company, another project, no row, an unreadable store)", async () => {
    const db = new FakeDynamoDb();
    expect(await coreCopyRefusalWords(depsOf(db), A, "payments")).toBe(CORE_COPY_REFUSED);
    db.set(row(A, "checking"));
    const words = await coreCopyRefusalWords(depsOf(db), A, "payments");
    expect(words).toContain(CORE_COPY_REFUSED);
    expect(words).toContain("waiting for approval");
    expect(words).toContain("Approve or discard");
    // Positive control above; now every other case is the plain words.
    expect(await coreCopyRefusalWords(depsOf(db), OTHER, "payments")).toBe(CORE_COPY_REFUSED);
    expect(await coreCopyRefusalWords(depsOf(db), A, "ledger")).toBe(CORE_COPY_REFUSED);
    for (const state of ["approved", "rejected", "discarded"]) { db.set(row(A, state)); expect(await coreCopyRefusalWords(depsOf(db), A, "payments"), state).toBe(CORE_COPY_REFUSED); }
    db.set(row(A, "checking"));
    expect(await coreCopyRefusalWords({ tableName: "state", documentClient: { send: async () => { throw new Error("private detail"); } } }, A, "payments")).toBe(CORE_COPY_REFUSED);
    expect(await coreCopyRefusalWords(depsOf(db), A, "../bad")).toBe(CORE_COPY_REFUSED);
  });

});
