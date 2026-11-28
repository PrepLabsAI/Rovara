// #1612: the install's own company. One setting row names it; `company-install-ensure` makes it once (or adopts a company the install was already moved into) and every later
// call answers the same company. The first owner is kept only as the hash of their email.
import { describe, expect, it } from "vitest";
import { companyScoped } from "@agentx/contracts";
import { CompanySignInStore, companyKey } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { INSTALL_COMPANY_KEY, InstallCompanyStore } from "../../packages/broker/src/developer/install-company.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const at = Date.parse("2026-11-27T12:00:00Z");
const FIRST = "org_" + "a".repeat(20);
const SECOND = "org_" + "b".repeat(20);
const MOVED = "org_" + "c".repeat(20);
const ownerHash = emailIndexKey("owner@example.test").pk.slice(6);

function world(ids: string[] = [FIRST, SECOND]) {
  const db = new FakeDynamoDb();
  const company = new CompanySignInStore({ documentClient: db, tableName: "signin", now: () => at });
  const queue = [...ids];
  const install = new InstallCompanyStore({ company, documentClient: db, tableName: "signin", now: () => at, newCompanyId: () => queue.shift()! });
  const logs: Record<string, unknown>[] = [];
  const invoke = (event: unknown) => companyOperator({ store: company, installCompany: install, now: () => at, log: (entry) => logs.push(entry) }, event);
  const setting = () => db.get(INSTALL_COMPANY_KEY.pk, INSTALL_COMPANY_KEY.sk);
  return { db, company, install, invoke, logs, setting };
}

describe("the install's company", () => {
  it("is made once, with its name and the owner's email hash, and every later ensure answers the same company", async () => {
    const h = world();
    expect(await h.invoke({ kind: "company-install-read" })).toEqual({ ok: false, error: "not_found" });
    expect(await h.invoke({ kind: "company-install-ensure", name: "Acme", ownerEmail: " Owner@Example.test " })).toEqual({ ok: true, companyId: FIRST, outcome: "created" });
    expect(h.db.get(companyKey(FIRST).pk, "META")).toMatchObject({ entityType: "COMPANY", companyId: FIRST, name: "Acme", status: "active", createdBy: "operator" });
    expect(h.setting()).toMatchObject({ entityType: "INSTALL_COMPANY", companyId: FIRST, via: "created", ownerEmailHash: ownerHash });
    expect(JSON.stringify(h.setting())).not.toMatch(/example\.test/iu);
    expect(await h.company.companyExists(FIRST)).toBe(true);

    expect(await h.invoke({ kind: "company-install-ensure", name: "Other name", ownerEmail: "someone@example.test" })).toEqual({ ok: true, companyId: FIRST, outcome: "existing" });
    expect(await h.invoke({ kind: "company-install-read" })).toEqual({ ok: true, companyId: FIRST, outcome: "existing" });
    // Nothing else was made: no second company, and the first owner is unchanged.
    expect(h.db.get(companyKey(SECOND).pk, "META")).toBeUndefined();
    expect(h.setting()).toMatchObject({ ownerEmailHash: ownerHash });
    expect(h.db.get(companyKey(FIRST).pk, "META")).toMatchObject({ name: "Acme" });
  });

  it("logs only the outcome and the opaque id, never the name or the email", async () => {
    const h = world();
    await h.invoke({ kind: "company-install-ensure", name: "Acme Secret Name", ownerEmail: "owner@example.test" });
    expect(h.logs).toEqual([{ event: "company-install-ensure", companyId: FIRST, outcome: "created" }]);
    const companyLog = h.db.find((item) => item.pk === companyScoped(FIRST, "COMPANY_LOG"));
    expect(companyLog.map((item) => item.event)).toEqual(["company-install-create"]);
    expect(JSON.stringify(companyLog)).not.toMatch(/Secret|example/iu);
  });

  it("names the first owner later when the company was made without one, and never replaces a named owner", async () => {
    const h = world();
    await h.invoke({ kind: "company-install-ensure", name: "Acme" });
    expect(h.setting()?.ownerEmailHash).toBeUndefined();
    await h.invoke({ kind: "company-install-ensure", name: "Acme", ownerEmail: "owner@example.test" });
    expect(h.setting()).toMatchObject({ ownerEmailHash: ownerHash });
    await h.invoke({ kind: "company-install-ensure", name: "Acme", ownerEmail: "other@example.test" });
    expect(h.setting()).toMatchObject({ ownerEmailHash: ownerHash });
  });

  it("adopts the named company an operator already moved the install into, instead of making one", async () => {
    const h = world();
    await h.company.create(MOVED, "Moved", "admin@example.test", 24);
    expect(await h.invoke({ kind: "company-install-ensure", name: "Acme", adoptCompanyId: MOVED })).toEqual({ ok: true, companyId: MOVED, outcome: "adopted" });
    expect(h.setting()).toMatchObject({ companyId: MOVED, via: "adopted" });
    expect(h.setting()?.ownerEmailHash).toBeUndefined();
    expect(h.db.get(companyKey(FIRST).pk, "META")).toBeUndefined();
    // An adopted company already has its people: a later owner email is not stored.
    await h.invoke({ kind: "company-install-ensure", name: "Acme", ownerEmail: "owner@example.test" });
    expect(h.setting()?.ownerEmailHash).toBeUndefined();
  });

  it("refuses to adopt a company that does not exist or the built-in company, and writes nothing", async () => {
    const h = world();
    expect(await h.invoke({ kind: "company-install-ensure", name: "Acme", adoptCompanyId: MOVED })).toEqual({ ok: false, error: "unavailable" });
    expect(await h.invoke({ kind: "company-install-ensure", name: "Acme", adoptCompanyId: "org_00000000000000000000" })).toEqual({ ok: false, error: "invalid_request" });
    expect(h.setting()).toBeUndefined();
  });

  it("answers the winner's company when two ensures race, leaving no stray company", async () => {
    const h = world();
    const [one, two] = await Promise.all([h.install.ensure({ name: "Acme" }), h.install.ensure({ name: "Acme" })]);
    expect(one.companyId).toBe(two.companyId);
    expect([one.outcome, two.outcome].sort()).toEqual(["created", "existing"]);
    const companies = h.db.find((item) => item.entityType === "COMPANY");
    expect(companies).toHaveLength(1);
  });

  it("refuses a bad name or email, and fails closed on a setting row that does not read", async () => {
    const h = world();
    for (const event of [{ kind: "company-install-ensure", name: "" }, { kind: "company-install-ensure", name: "x".repeat(81) }, { kind: "company-install-ensure", name: "Acme", ownerEmail: "not-an-email" }, { kind: "company-install-ensure", name: "Acme", extra: 1 }]) {
      expect(await h.invoke(event)).toEqual({ ok: false, error: "invalid_request" });
    }
    h.db.set({ ...INSTALL_COMPANY_KEY, entityType: "INSTALL_COMPANY", companyId: "org_00000000000000000000", via: "created", setAt: new Date(at).toISOString() });
    expect(await h.invoke({ kind: "company-install-read" })).toEqual({ ok: false, error: "unavailable" });
    expect(await h.invoke({ kind: "company-install-ensure", name: "Acme" })).toEqual({ ok: false, error: "unavailable" });
  });

  it("is unavailable where the deployment wires no install company store", async () => {
    const db = new FakeDynamoDb();
    const store = new CompanySignInStore({ documentClient: db, tableName: "signin", now: () => at });
    expect(await companyOperator({ store, now: () => at, log: () => undefined }, { kind: "company-install-ensure", name: "Acme" })).toEqual({ ok: false, error: "unavailable" });
  });
});
