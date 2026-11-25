import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { validCaps } from "../../packages/model-gateway/src/caps.js";
import { CompanyBudgetCaps, NO_CAP } from "../../packages/model-gateway/src/company-caps.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DEFAULT_MAX_OUTPUT_TOKENS, modelLimitsFrom } from "../../packages/model-gateway/src/process.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const COMPANIES = "cloud-companies";
const cid = `org_${"a".repeat(20)}`;
const scope = { iss: "https://install.example/v1/auth", cid, pid: "web", tid: "task_1" };
function setup() {
  const wire = new WireDynamo([COMPANIES]);
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  // The row the Cloud company backend writes (company-dynamo.ts settingsItem): COMPANY#<org> / SETTINGS, settings.budgets.
  const seed = (budgets: Record<string, unknown>, companyId = cid, pkCompany = cid) => db.put(COMPANIES, { pk: `COMPANY#${pkCompany}`, sk: "SETTINGS", companyId, version: 1, settings: { featureGates: {}, budgets } as never });
  return { wire, db, caps: new CompanyBudgetCaps(db, COMPANIES), seed };
}
const all = { companyMonthlyUsdMicros: 50_000_000, memberMonthlyUsdMicros: 10_000_000, projectMonthlyUsdMicros: 20_000_000, taskUsdMicros: 2_000_000 };

describe("budgets from the Cloud company backend's Companies table", () => {
  it("maps the four budgets to the meter's caps, reading only COMPANY#<org> / SETTINGS and the project override key (B1) by GetItem", async () => {
    const { wire, caps, seed } = setup();
    await seed(all);
    expect(await caps.capsFor(scope)).toEqual({ task: 2_000_000, projectMonth: 20_000_000, personMonth: 10_000_000, companyMonth: 50_000_000 });
    const reads = wire.calls.filter((c) => c.operation !== "PutItem");
    expect(reads.map((c) => [c.operation, c.table, c.keys])).toEqual([["GetItem", COMPANIES, [{ pk: `COMPANY#${cid}`, sk: "SETTINGS" }]], ["GetItem", COMPANIES, [{ pk: `COMPANY#${cid}`, sk: "SPEND_LIMIT#PROJECT#web" }]]]);
  });

  it("under a company monthly cap, null is no cap of that kind (the backend's meaning): task and project unbounded, member drops out", async () => {
    const { caps, seed } = setup();
    await seed({ companyMonthlyUsdMicros: 9, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null });
    const read = await caps.capsFor(scope);
    expect(read).toEqual({ task: NO_CAP, projectMonth: NO_CAP, companyMonth: 9 });
    expect(validCaps(read)).toBe(true);
  });

  it("no company monthly cap refuses: the backend's all-null default (saved with any other setting) never opens unlimited spend", async () => {
    const { caps, seed } = setup();
    await seed({ companyMonthlyUsdMicros: null, memberMonthlyUsdMicros: 1, projectMonthlyUsdMicros: 1, taskUsdMicros: 1 });
    expect(validCaps(await caps.capsFor(scope))).toBe(false);
    const fresh = setup();
    await fresh.seed({ companyMonthlyUsdMicros: null, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null });
    expect(validCaps(await fresh.caps.capsFor(scope))).toBe(false);
  });

  it("refuses (caps the server answers 503 to) when the company set no budgets, the row is another company's, or a budget is malformed", async () => {
    const none = setup();
    expect(validCaps(await none.caps.capsFor(scope))).toBe(false);
    const other = setup();
    await other.seed(all, `org_${"b".repeat(20)}`);
    expect(validCaps(await other.caps.capsFor(scope))).toBe(false);
    for (const bad of [{ ...all, taskUsdMicros: -1 }, { ...all, taskUsdMicros: "2" }, { ...all, companyMonthlyUsdMicros: 1_000_000_000_001 }, { companyMonthlyUsdMicros: 1 }]) {
      const f = setup(); await f.seed(bad);
      expect(validCaps(await f.caps.capsFor(scope))).toBe(false);
    }
    expect(validCaps(await setup().caps.capsFor({ ...scope, cid: "COMPANY#x" }))).toBe(false);
  });

  it("carries the company's learning cap (DEC 226) beside the caps, and omits it when the row has none (an older row: the default applies)", async () => {
    const { caps, seed } = setup();
    await seed({ ...all, learningMonthlyUsdMicros: 7_000_000 });
    const read = await caps.capsFor(scope);
    expect(read).toEqual({ task: 2_000_000, projectMonth: 20_000_000, personMonth: 10_000_000, companyMonth: 50_000_000, learningMonth: 7_000_000 });
    expect(validCaps(read)).toBe(true);
    const older = setup(); await older.seed(all);
    expect(Object.keys(await older.caps.capsFor(scope))).not.toContain("learningMonth");
    const zero = setup(); await zero.seed({ ...all, learningMonthlyUsdMicros: 0 });
    expect((await zero.caps.capsFor(scope)).learningMonth).toBe(0);
  });

  it("refuses a learning cap that is null, negative, text or past the backend's ceiling", async () => {
    for (const bad of [null, -1, "7", 1_000_000_000_001]) {
      const f = setup(); await f.seed({ ...all, learningMonthlyUsdMicros: bad });
      expect(validCaps(await f.caps.capsFor(scope)), String(bad)).toBe(false);
    }
  });

  it("a failed read throws (the call stops before anything is reserved or sent)", async () => {
    const { wire, caps, seed } = setup();
    await seed(all);
    wire.fault(() => true, { kind: "error", status: 400, type: "AccessDeniedException" });
    await expect(caps.capsFor(scope)).rejects.toThrow();
  });
});

describe("per-model output ceilings", () => {
  it("uses the price row's own max_output_tokens, and the fixed fallback only for a model no row names", () => {
    const limits = modelLimitsFrom({ maxOutputTokens: (_provider, model) => (model === "claude-known" ? 32_000 : undefined) });
    expect(limits.maxOutputTokens("anthropic", "claude-known")).toBe(32_000);
    expect(limits.maxOutputTokens("anthropic", "claude-new")).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(limits.maxOutputTokens("openai", "claude-known")).toBeUndefined();
  });
});
