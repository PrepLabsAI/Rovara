// Lead 3 B1 (DEC 254t b): per-project and per-person MONTHLY limit overrides in Cloud's Companies table, read by the gateway on every call
// (company-caps.ts). No override item: the company default. An item that is unreadable, another company's, another kind's, another id's or
// malformed: the call is refused (caps the server answers 503 to), nothing held or sent. A failed read throws. The company's monthly cap
// stays the outer bound.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { validCaps } from "../../packages/model-gateway/src/caps.js";
import { CompanyBudgetCaps, NO_CAP } from "../../packages/model-gateway/src/company-caps.js";
import { GATEWAY_COMPANY_BUDGET_MAX, GATEWAY_COMPANY_SPEND_LIMITS } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo, type Item } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const COMPANIES = "cloud-companies";
const A = `org_${"a".repeat(20)}`;
const B = `org_${"b".repeat(20)}`;
const PERSON_1 = "1".repeat(64);
const PERSON_2 = "2".repeat(64);
const scope = { iss: "https://install.example/v1/auth", cid: A, pid: "web", tid: "task_1", per: PERSON_1 };
const all = { companyMonthlyUsdMicros: 50_000_000, memberMonthlyUsdMicros: 10_000_000, projectMonthlyUsdMicros: 20_000_000, taskUsdMicros: 2_000_000 };
const at = "2026-11-17T12:00:00.000Z";

function setup() {
  const wire = new WireDynamo([COMPANIES]);
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  const seed = (budgets: Record<string, unknown>, companyId = A) => db.put(COMPANIES, { pk: `COMPANY#${companyId}`, sk: "SETTINGS", companyId, version: 1, settings: { featureGates: {}, budgets } as never });
  /** The item Cloud's store writes (company-dynamo.ts putSpendLimit), with any field overridden. */
  const override = (kind: string, id: string, micros: unknown, more: Record<string, unknown> = {}, company = A): Item =>
    ({ pk: `COMPANY#${company}`, sk: `${GATEWAY_COMPANY_SPEND_LIMITS.kinds.find((k) => k.kind === kind)!.sortPrefix}${id}`, companyId: company, kind, id, monthlyUsdMicros: micros as number, version: 1, updatedAt: at, updatedBy: "d".repeat(64), ...more });
  const put = (item: Item) => db.put(COMPANIES, item);
  return { wire, db, caps: new CompanyBudgetCaps(db, COMPANIES), seed, override, put };
}
const refused = async (s: ReturnType<typeof setup>, call = scope) => validCaps(await s.caps.capsFor(call));

describe("per-project and per-person monthly overrides", () => {
  it("no override item: the company default applies, exactly as before (golden)", async () => {
    const s = setup(); await s.seed(all);
    expect(await s.caps.capsFor(scope)).toEqual({ task: 2_000_000, projectMonth: 20_000_000, personMonth: 10_000_000, companyMonth: 50_000_000 });
    const none = setup(); await none.seed({ ...all, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null });
    expect(await none.caps.capsFor({ ...scope })).toEqual({ task: 2_000_000, projectMonth: NO_CAP, companyMonth: 50_000_000 });
  });

  it("a project override replaces the project default; a person override replaces the member default (higher or lower), others keep the default", async () => {
    const s = setup(); await s.seed(all);
    await s.put(s.override("project_month", "web", 5_000_000));
    await s.put(s.override("person_month", PERSON_1, 30_000_000));
    const read = await s.caps.capsFor(scope);
    expect(read).toEqual({ task: 2_000_000, projectMonth: 5_000_000, personMonth: 30_000_000, companyMonth: 50_000_000 });
    expect(validCaps(read)).toBe(true);
    // Another project and another person of the same company keep the defaults.
    expect(await s.caps.capsFor({ ...scope, pid: "api", per: PERSON_2 })).toEqual({ task: 2_000_000, projectMonth: 20_000_000, personMonth: 10_000_000, companyMonth: 50_000_000 });
  });

  it("an override works where the default is null (no cap of that kind), and a zero override is a real cap of zero", async () => {
    const s = setup(); await s.seed({ ...all, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null });
    await s.put(s.override("project_month", "web", 0));
    await s.put(s.override("person_month", PERSON_1, 7));
    expect(await s.caps.capsFor(scope)).toEqual({ task: 2_000_000, projectMonth: 0, personMonth: 7, companyMonth: 50_000_000 });
  });

  it("the company's monthly cap stays the outer bound: it is still returned beside an override above it, and no company cap still refuses", async () => {
    const s = setup(); await s.seed(all);
    await s.put(s.override("project_month", "web", 900_000_000));
    expect(await s.caps.capsFor(scope)).toMatchObject({ projectMonth: 900_000_000, companyMonth: 50_000_000 });
    const noCompany = setup(); await noCompany.seed({ ...all, companyMonthlyUsdMicros: null });
    await noCompany.put(noCompany.override("project_month", "web", 1));
    expect(await refused(noCompany)).toBe(false);
  });

  it("reads exactly the settings item and the two override keys by GetItem, the overrides strongly consistent, and only the person's when the call names one", async () => {
    const s = setup(); await s.seed(all);
    await s.put(s.override("project_month", "web", 5)); await s.put(s.override("person_month", PERSON_1, 6));
    const before = s.wire.calls.length;
    await s.caps.capsFor(scope);
    const reads = s.wire.calls.slice(before);
    expect(reads.map((c) => ({ operation: c.operation, table: c.table, key: c.keys[0]! })).sort((x, y) => x.key.sk.localeCompare(y.key.sk)).map((c) => [c.operation, c.table, c.key])).toEqual([
      ["GetItem", COMPANIES, { pk: `COMPANY#${A}`, sk: "SETTINGS" }],
      ["GetItem", COMPANIES, { pk: `COMPANY#${A}`, sk: `SPEND_LIMIT#PERSON#${PERSON_1}` }],
      ["GetItem", COMPANIES, { pk: `COMPANY#${A}`, sk: "SPEND_LIMIT#PROJECT#web" }],
    ]);
    // A lowered override must apply to the very next call: the override reads are strongly consistent.
    expect(reads.filter((c) => String(c.keys[0]?.sk).startsWith("SPEND_LIMIT#")).map((c) => c.input.ConsistentRead)).toEqual([true, true]);
    const noPerson = setup(); await noPerson.seed(all);
    const mark = noPerson.wire.calls.length;
    await noPerson.caps.capsFor({ iss: scope.iss, cid: A, pid: "web", tid: "t" });
    expect(noPerson.wire.calls.slice(mark).map((c) => c.keys[0]?.sk).sort()).toEqual(["SETTINGS", "SPEND_LIMIT#PROJECT#web"]);
  });

  it("a lowered override applies to the next call (the new value, not the old)", async () => {
    const s = setup(); await s.seed(all);
    await s.put(s.override("project_month", "web", 8_000_000));
    expect((await s.caps.capsFor(scope)).projectMonth).toBe(8_000_000);
    await s.put(s.override("project_month", "web", 1_000_000, { version: 2 }));
    expect((await s.caps.capsFor(scope)).projectMonth).toBe(1_000_000);
  });

  describe("an override that does not read refuses the call (nothing held or sent)", () => {
    const cases: Array<[string, "project_month" | "person_month", (s: ReturnType<typeof setup>) => Item]> = [
      ["another company's companyId", "project_month", (s) => s.override("project_month", "web", 5, { companyId: B })],
      ["a key naming another company in its attribute only (row under A, attribute B)", "person_month", (s) => s.override("person_month", PERSON_1, 5, { companyId: B })],
      ["another kind", "project_month", (s) => s.override("project_month", "web", 5, { kind: "person_month" })],
      ["another id", "project_month", (s) => s.override("project_month", "web", 5, { id: "api" })],
      ["another person's id", "person_month", (s) => s.override("person_month", PERSON_1, 5, { id: PERSON_2 })],
      ["a missing companyId", "project_month", (s) => { const i = s.override("project_month", "web", 5); delete (i as Record<string, unknown>).companyId; return i; }],
      ["a missing amount", "project_month", (s) => { const i = s.override("project_month", "web", 5); delete (i as Record<string, unknown>).monthlyUsdMicros; return i; }],
      ["a negative amount", "project_month", (s) => s.override("project_month", "web", -1)],
      ["a text amount", "person_month", (s) => s.override("person_month", PERSON_1, "5")],
      ["a null amount", "project_month", (s) => s.override("project_month", "web", null)],
      ["an amount past the backend's ceiling", "project_month", (s) => s.override("project_month", "web", GATEWAY_COMPANY_BUDGET_MAX + 1)],
      ["a missing version", "person_month", (s) => { const i = s.override("person_month", PERSON_1, 5); delete (i as Record<string, unknown>).version; return i; }],
      ["a zero version", "project_month", (s) => s.override("project_month", "web", 5, { version: 0 })],
      // Cloud's store requires the author and time it writes (validSpendLimit), so the gateway does too: the two never disagree about whether an item reads.
      ["no author", "project_month", (s) => { const i = s.override("project_month", "web", 5); delete (i as Record<string, unknown>).updatedBy; return i; }],
      ["no time", "person_month", (s) => { const i = s.override("person_month", PERSON_1, 5); delete (i as Record<string, unknown>).updatedAt; return i; }],
    ];
    for (const [name, kind, make] of cases) {
      it(name, async () => {
        const s = setup(); await s.seed(all);
        await s.put(make(s));
        expect(await refused(s), name).toBe(false);
        // The same bad row never reaches the other kind's caps or another project: only the call that names it is refused.
        expect(await refused(s, kind === "project_month" ? { ...scope, pid: "api" } : { ...scope, per: PERSON_2 }), `${name} (other id)`).toBe(true);
      });
    }

    it("a key of another company's partition is never read: company B's override does not touch company A's call", async () => {
      const s = setup(); await s.seed(all); await s.seed(all, B);
      await s.put(s.override("project_month", "web", 1, {}, B));
      await s.put(s.override("person_month", PERSON_1, 1, {}, B));
      expect(await s.caps.capsFor(scope)).toEqual({ task: 2_000_000, projectMonth: 20_000_000, personMonth: 10_000_000, companyMonth: 50_000_000 });
      expect(await s.caps.capsFor({ ...scope, cid: B })).toEqual({ task: 2_000_000, projectMonth: 1, personMonth: 1, companyMonth: 50_000_000 });
    });

    it("a project or person id that is not in the token's format is refused before any read of an override", async () => {
      const s = setup(); await s.seed(all);
      for (const bad of [{ ...scope, pid: "Web" }, { ...scope, pid: "" }, { ...scope, pid: "a/b" }, { ...scope, per: "x".repeat(64) }, { ...scope, per: "" }]) {
        const mark = s.wire.calls.length;
        expect(validCaps(await s.caps.capsFor(bad)), JSON.stringify(bad)).toBe(false);
        expect(s.wire.calls.slice(mark).filter((c) => String(c.keys[0]?.sk).startsWith("SPEND_LIMIT#"))).toEqual([]);
      }
    });

    it("an override with no company settings still refuses (no settings row is no ceiling)", async () => {
      const s = setup();
      await s.put(s.override("project_month", "web", 5));
      expect(await refused(s)).toBe(false);
    });
  });

  it("a failed read of an override throws (the call stops before anything is reserved or sent)", async () => {
    const s = setup(); await s.seed(all);
    s.wire.fault((c) => String(c.keys[0]?.sk).startsWith("SPEND_LIMIT#PROJECT#"), { kind: "error", status: 400, type: "AccessDeniedException" });
    await expect(s.caps.capsFor(scope)).rejects.toThrow();
    const person = setup(); await person.seed(all);
    person.wire.fault((c) => String(c.keys[0]?.sk).startsWith("SPEND_LIMIT#PERSON#"), { kind: "error", status: 400, type: "AccessDeniedException" });
    await expect(person.caps.capsFor(scope)).rejects.toThrow();
  });

  it("the keys are the ones Cloud writes (pinned): a different prefix would read no override and silently use the default", () => {
    expect(GATEWAY_COMPANY_SPEND_LIMITS).toEqual({
      partitionPrefix: "COMPANY#",
      kinds: [
        { kind: "project_month", scope: "project", sortPrefix: "SPEND_LIMIT#PROJECT#", caps: "projectMonth" },
        { kind: "person_month", scope: "person", sortPrefix: "SPEND_LIMIT#PERSON#", caps: "personMonth" },
        { kind: "upkeep_month", scope: "project", sortPrefix: "SPEND_LIMIT#UPKEEP#", caps: null },
        { kind: "answers_month", scope: "company", sortPrefix: "SPEND_LIMIT#ANSWERS#", caps: null },
      ],
    });
  });
});

// A new kind with a meter cap is an entry in GATEWAY_COMPANY_SPEND_LIMITS; this walks every such entry through capsFor.
describe("every kind with a meter cap in the gateway's table", () => {
  const callFor = { project: { ...scope }, person: { ...scope } } as const;
  const idOf = { project: scope.pid, person: scope.per } as const;
  for (const def of GATEWAY_COMPANY_SPEND_LIMITS.kinds.filter((k) => k.caps !== null)) {
    const cap = def.caps;
    it(`${def.kind}: replaces ${cap} for its own id only, refuses what does not read, never reads another company's, and throws on a failed read`, async () => {
      const s = setup(); await s.seed(all); await s.seed(all, B);
      const base = await s.caps.capsFor(callFor[def.scope]);
      await s.put(s.override(def.kind, idOf[def.scope], 3));
      expect((await s.caps.capsFor(callFor[def.scope]))[cap]).toBe(3);
      // Company B's call has the default (the same id, another company's partition).
      expect((await s.caps.capsFor({ ...callFor[def.scope], cid: B }))[cap]).toBe(base[cap]);
      // Another id of the same scope keeps the default.
      expect((await s.caps.capsFor(def.scope === "project" ? { ...scope, pid: "api" } : { ...scope, per: PERSON_2 }))[cap]).toBe(base[cap]);
      for (const damage of [{ companyId: B }, { kind: "no_such_kind" }, { id: "x" }, { monthlyUsdMicros: -1 }, { version: 0 }]) {
        const bad = setup(); await bad.seed(all);
        await bad.put(bad.override(def.kind, idOf[def.scope], 3, damage));
        expect(validCaps(await bad.caps.capsFor(callFor[def.scope])), JSON.stringify(damage)).toBe(false);
      }
      const failing = setup(); await failing.seed(all);
      failing.wire.fault((c) => String(c.keys[0]?.sk).startsWith(def.sortPrefix), { kind: "error", status: 400, type: "AccessDeniedException" });
      await expect(failing.caps.capsFor(callFor[def.scope])).rejects.toThrow();
    });
  }
});
