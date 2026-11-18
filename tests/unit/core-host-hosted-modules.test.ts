// Engine host (lane E2, step 5): the security-list points for the first staging run. Admission: an allow-list and two dollar caps read from the core's cost ledger (the task's total and the
// company's UTC day), checked again in the start's own transaction (the held day is lane L8's, core-host-spend-holds.test.ts); metering: list prices, an unknown model at a cautious price (never $0); identity: membership only; audit: Code's audit rows.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type AdmissionRequest, type MeterEntry, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { companyDayKey, utcDayOf } from "../../packages/broker/src/core/cost/ledger.js";
import {
  COMPANY_DAY_CAP_REACHED, COMPANY_NOT_ALLOWED, HOSTED_IDENTITY_PROVIDER, SPEND_UNKNOWN, TASK_CAP_REACHED, UNKNOWN_MODEL_PRICE,
  createHostedAdmission, createHostedIdentity, createHostedLedger, createHostedMetering, hostedSecurityModules, readHostedAdmissionSettings,
} from "../../packages/broker/src/core-host/hosted-modules.js";
import { buildCoreRegistry } from "../../packages/broker/src/core-host/registry.js";
import { costMicrosOf } from "../../packages/broker/src/core/cost/price-table.js";
import { githubLinkReaderOver, linkGithubAccount } from "../../packages/broker/src/core/people/github-links.js";
import { coreAdapter } from "../../packages/broker/src/core-host/registry.js";

const ORG = "org_staging0000000000001" as OrgId;
const OTHER = "org_staging0000000000002" as OrgId;
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const NOW = new Date("2026-11-15T10:00:00.000Z");
const SETTINGS = { allowedCompanies: [ORG], taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 };

const usage = (modelId: string, input: number, output: number) => ({ provider: "anthropic", modelId, tokens: { input, output, cacheRead: 0, cacheWrite: 0 } });
const entry = (entryId: string, micros: number, overrides: Partial<MeterEntry> = {}): MeterEntry => ({ companyId: ORG, entryId, at: NOW.toISOString(), usage: usage(`m-${String(micros)}`, micros, 0), taskId: TASK, ...overrides });
/** A meter that charges exactly `input` tokens' count in micros (USD), or no price for model `unpriced`, or EUR for model `euro`. */
const exactMeter = {
  async price() { return null; },
  async record(e: MeterEntry) {
    if (e.usage.modelId === "unpriced") return { cost: null, source: "unknown" as const };
    return { cost: { micros: e.usage.tokens.input, currency: e.usage.modelId === "euro" ? "EUR" : "USD" }, source: "price-table" as const };
  },
};

function setup() {
  const store = new MemoryDocumentStore();
  const ledger = createHostedLedger({ store, metering: exactMeter, now: () => NOW });
  const admission = createHostedAdmission({ settings: SETTINGS, store, ledger, now: () => NOW });
  return { store, ledger, admission };
}
const start = (overrides: Partial<AdmissionRequest> = {}): AdmissionRequest => ({ companyId: ORG, idempotencyKey: "k", action: "task.start", subject: { type: "task", id: TASK }, ...overrides });

describe("the cost ledger's company day", () => {
  it("adds each recorded dollar usage to the company's UTC day, once, in the same transaction as the task total", async () => {
    const { store, ledger } = setup();
    await ledger.recordUsage(entry("e1", 1_000_000));
    await ledger.recordUsage(entry("e1", 1_000_000));
    await ledger.recordUsage(entry("e2", 2_500_000, { taskId: "11111111-2222-4333-8444-555555555555" }));
    expect(await ledger.companyDayCost(ORG, utcDayOf(NOW))).toEqual({ day: "2026-11-15", usdMicros: 3_500_000, entries: 2, uncountedEntries: 0 });
    expect(await ledger.companyDayCost(OTHER, utcDayOf(NOW))).toEqual({ day: "2026-11-15", usdMicros: 0, entries: 0, uncountedEntries: 0 });
    // Written with no expiry (like the total), in the company's own partition.
    const row = await store.get(companyDayKey(ORG, "2026-11-15"));
    expect(row).toMatchObject({ pk: `ORG#${ORG}#COST_DAY`, sk: "DAY#2026-11-15", entityType: "COST_DAY", companyId: ORG });
    expect(row).not.toHaveProperty("indexExpiresAt");
  });

  it("counts an unpriced or non-dollar usage as one the day's figure leaves out", async () => {
    const { ledger } = setup();
    await ledger.recordUsage({ ...entry("u", 0), usage: usage("unpriced", 10, 0) });
    await ledger.recordUsage({ ...entry("eur", 0), usage: usage("euro", 99, 0), taskId: "11111111-2222-4333-8444-555555555555" });
    expect(await ledger.companyDayCost(ORG, "2026-11-15")).toMatchObject({ usdMicros: 0, entries: 2, uncountedEntries: 2 });
  });

  it("reads a row whose figures are not whole numbers as a floor nobody may rely on", async () => {
    const { store, ledger } = setup();
    await store.put({ item: { ...companyDayKey(ORG, "2026-11-15"), entityType: "COST_DAY", usdMicros: "lots", entries: 1, uncountedEntries: 0 } });
    expect((await ledger.companyDayCost(ORG, "2026-11-15")).uncountedEntries).toBeGreaterThan(0);
    expect(() => companyDayKey(ORG, "15/11/2026")).toThrow();
  });
});

describe("the staging admission", () => {
  it("declares a held dollar cap only where the per-run stop is wired (lane L8 holds the day and books usage; core-money-stop stops a run at its cap)", () => {
    expect(setup().admission.enforcesCost).toBe(false);
    const store = new MemoryDocumentStore();
    expect(createHostedAdmission({ settings: SETTINGS, store, ledger: createHostedLedger({ store, metering: createHostedMetering(), now: () => NOW }), now: () => NOW, runStopWired: true }).enforcesCost).toBe(true);
  });

  it("refuses any company not on the list, in fixed words, before reading any spend", async () => {
    const { admission } = setup();
    for (const companyId of [OTHER, IMPLICIT_COMPANY_ID, "", undefined as unknown as string]) {
      expect(await admission.admit(start({ companyId }))).toEqual({ allowed: false, code: "company_not_allowed", message: COMPANY_NOT_ALLOWED });
      expect(await admission.stage(start({ companyId }))).toEqual({ decision: { allowed: false, code: "company_not_allowed", message: COMPANY_NOT_ALLOWED }, items: [] });
    }
  });

  it("lets a listed company start below both caps, and the start's transaction takes its hold and holds the day and the task under their caps", async () => {
    const { admission } = setup();
    const staged = await admission.stage(start());
    expect(staged.decision.allowed && staged.decision.reservationId).toMatch(/^hold:org_/u);
    expect(staged.items.map((item) => item.kind)).toEqual(["put", "put", "update", "update"]);
    expect(staged.items.every((item) => item.kind === "put" || item.condition !== undefined)).toBe(true);
  });

  it("refuses at the company's daily cap, and a start staged before the day filled up does not commit after it", async () => {
    const { store, ledger, admission } = setup();
    const staged = await admission.stage(start());
    await ledger.recordUsage(entry("big", 25_000_000, { taskId: "11111111-2222-4333-8444-555555555555" }));
    // The hold: the start's own transaction fails on the day row now at its cap.
    const committed = await store.transact([...staged.items, { kind: "put", item: { pk: "TASK#x", sk: "META" } }]);
    expect(committed.applied).toBe(false);
    expect(await admission.admit(start())).toEqual({ allowed: false, code: "company_day_cap", message: COMPANY_DAY_CAP_REACHED });
  });

  it("refuses a task at its own cap, and an estimate that would take it past the cap", async () => {
    const { ledger, admission } = setup();
    await ledger.recordUsage(entry("t1", 4_000_000));
    // Each ask has its own key: one key asked again is the same decision (lane L8).
    expect((await admission.admit(start({ action: "model.call", idempotencyKey: "c1" }))).allowed).toBe(true);
    expect(await admission.admit(start({ action: "model.call", idempotencyKey: "c2", estimate: { cost: { micros: 1_000_001, currency: "USD" } } }))).toEqual({ allowed: false, code: "task_cap", message: TASK_CAP_REACHED });
    expect((await admission.admit(start({ action: "model.call", idempotencyKey: "c3", estimate: { cost: { micros: 1_000_000, currency: "USD" } } }))).allowed).toBe(true);
    await ledger.recordUsage(entry("t2", 1_000_000));
    expect(await admission.admit(start({ action: "model.call", idempotencyKey: "c4" }))).toEqual({ allowed: false, code: "task_cap", message: TASK_CAP_REACHED });
  });

  it("refuses when the spend cannot be read as dollars: an unpriced usage today, a non-dollar task, or an estimate that is not dollars", async () => {
    const unpriced = setup();
    // On ANOTHER task: only the company's day can refuse it here.
    await unpriced.ledger.recordUsage({ ...entry("u", 0), usage: usage("unpriced", 1, 0), taskId: "11111111-2222-4333-8444-555555555555" });
    expect(await unpriced.admission.admit(start())).toEqual({ allowed: false, code: "spend_unknown", message: SPEND_UNKNOWN });
    const { admission } = setup();
    for (const cost of [{ micros: 1, currency: "EUR" }, { micros: -1, currency: "USD" }, { micros: 1.5, currency: "USD" }, null]) {
      expect(await admission.admit(start({ estimate: { cost: cost as never } }))).toEqual({ allowed: false, code: "spend_unknown", message: SPEND_UNKNOWN });
    }
  });

  it("settles and releases nothing for an id it never gave", async () => {
    const { admission, store } = setup();
    await admission.settle("x", { tokens: 1 });
    await admission.release("x");
    expect(await store.get(companyDayKey(ORG, "2026-11-15"))).toBeUndefined();
  });
});

describe("the admission for every company (DEC 229a)", () => {
  it("reads `all` with the caps, and lets any company with its own id in, never the laptop's implicit company or a malformed id, still under the caps", async () => {
    const read = readHostedAdmissionSettings({ ROVARA_CORE_ALLOWED_COMPANIES: "all", ROVARA_CORE_COMPANY_DAY_CAP_USD: "1" });
    expect(read).toEqual({ settings: { allowedCompanies: "all", taskCapMicros: 5_000_000, companyDayCapMicros: 1_000_000 } });
    if (!("settings" in read)) throw new Error("unreachable");
    const store = new MemoryDocumentStore();
    const ledger = createHostedLedger({ store, metering: exactMeter, now: () => NOW });
    const admission = createHostedAdmission({ settings: read.settings, store, ledger, now: () => NOW });
    for (const companyId of [ORG, OTHER]) expect((await admission.admit(start({ companyId }))).allowed, companyId).toBe(true);
    for (const companyId of [IMPLICIT_COMPANY_ID, "org_short", "", "ORG_STAGING0000000000001"]) expect(await admission.admit(start({ companyId })), companyId).toEqual({ allowed: false, code: "company_not_allowed", message: COMPANY_NOT_ALLOWED });
    // The caps still hold for every company.
    await ledger.recordUsage(entry("d", 1_000_000, { companyId: OTHER, taskId: "11111111-2222-4333-8444-555555555555" }));
    expect(await admission.admit(start({ companyId: OTHER, idempotencyKey: "second" }))).toEqual({ allowed: false, code: "company_day_cap", message: COMPANY_DAY_CAP_REACHED });
    expect(readHostedAdmissionSettings({ ROVARA_CORE_ALLOWED_COMPANIES: "all", ROVARA_CORE_TASK_CAP_USD: "0" })).toHaveProperty("problem");
    expect(readHostedAdmissionSettings({ ROVARA_CORE_ALLOWED_COMPANIES: "ALL" })).toHaveProperty("problem");
  });
});

describe("the admission's settings", () => {
  it("reads the allow-list and the caps, defaulting to $5 a task and $25 a company day", () => {
    expect(readHostedAdmissionSettings({ ROVARA_CORE_ALLOWED_COMPANIES: `${ORG}:${ORG}` })).toEqual({ settings: { allowedCompanies: [ORG], taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 } });
    expect(readHostedAdmissionSettings({ ROVARA_CORE_ALLOWED_COMPANIES: ORG, ROVARA_CORE_TASK_CAP_USD: "2", ROVARA_CORE_COMPANY_DAY_CAP_USD: "10" })).toEqual({ settings: { allowedCompanies: [ORG], taskCapMicros: 2_000_000, companyDayCapMicros: 10_000_000 } });
  });

  it("refuses, in fixed words that never echo the value, a missing list, a malformed id, the laptop's company and a cap that is not 1 to 1000 dollars", () => {
    for (const env of [{}, { ROVARA_CORE_ALLOWED_COMPANIES: " " }, { ROVARA_CORE_ALLOWED_COMPANIES: "org_bad;zzqx" }, { ROVARA_CORE_ALLOWED_COMPANIES: IMPLICIT_COMPANY_ID },
      { ROVARA_CORE_ALLOWED_COMPANIES: ORG, ROVARA_CORE_TASK_CAP_USD: "0" }, { ROVARA_CORE_ALLOWED_COMPANIES: ORG, ROVARA_CORE_TASK_CAP_USD: "5.5" },
      { ROVARA_CORE_ALLOWED_COMPANIES: ORG, ROVARA_CORE_COMPANY_DAY_CAP_USD: "25000" }]) {
      const read = readHostedAdmissionSettings(env);
      expect("problem" in read, JSON.stringify(env)).toBe(true);
      expect(JSON.stringify(read)).not.toContain("zzqx");
    }
  });
});

describe("the staging meter", () => {
  it("prices a catalog model at its list price, and an unknown model at the cautious price, never $0", async () => {
    const meter = createHostedMetering({ find: (model) => (model.modelId === "known" ? { price: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 }, currency: "USD", origin: "catalog" } : undefined), findCap: (model) => (model.modelId === "known" ? { price: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 }, currency: "USD", origin: "catalog" } : undefined) });
    expect(await meter.record({ companyId: ORG, entryId: "a", at: NOW.toISOString(), usage: usage("known", 1_000_000, 0) })).toEqual({ cost: { micros: 3_000_000, currency: "USD" }, source: "price-table" });
    const unknown = await meter.record({ companyId: ORG, entryId: "b", at: NOW.toISOString(), usage: usage("never-heard-of", 1_000_000, 1_000_000) });
    expect(unknown).toEqual({ cost: { micros: costMicrosOf(UNKNOWN_MODEL_PRICE, { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }), currency: "USD" }, source: "unknown" });
    expect(unknown.cost!.micros).toBeGreaterThan(0);
    expect(await meter.price(usage("never-heard-of", 1, 1))).toMatchObject({ currency: "USD" });
    expect((await meter.price(usage("never-heard-of", 1_000, 0)))!.micros).toBeGreaterThan(0);
  });
});

describe("the deployed identity point", () => {
  const identity = createHostedIdentity({
    membershipOf: async (personId) => (personId === "dev-a" ? { companyId: ORG, role: "member" } : personId === "dev-x" ? { companyId: ORG, role: "superuser" as never } : undefined),
    displayNameOf: async (personId) => (personId === "dev-a" || personId === "dev-x" ? "Ada" : undefined),
  });

  it("names a member of the company from membership, and nobody else", async () => {
    expect(await identity.getPrincipal(ORG, "dev-a")).toEqual({ companyId: ORG, personId: "dev-a", displayName: "Ada", roles: ["member"], provider: HOSTED_IDENTITY_PROVIDER });
    expect(await identity.getPrincipal(OTHER, "dev-a")).toBeUndefined();
    expect(await identity.getPrincipal(ORG, "dev-b")).toBeUndefined();
    expect(await identity.getPrincipal(ORG, "dev-x")).toBeUndefined();
    expect(await identity.getPrincipal("not-a-company", "dev-a")).toBeUndefined();
  });

  it("authenticates no credential and resolves no outside account (Code's sign-in does that)", async () => {
    expect(await identity.authenticate({ scheme: "bearer", value: "anything" })).toEqual({ ok: false, reason: "refused" });
    expect(await identity.resolveExternalAccount(ORG, { provider: "slack", tenant: "T", accountId: "U" })).toBeUndefined();
  });
});

describe("the deployed identity point with linked GitHub accounts (L4-GH)", () => {
  const PEOPLE: Record<string, OrgId> = { "dev-a": ORG, "dev-b": ORG, "dev-o": OTHER };
  const identityOver = (store: MemoryDocumentStore) => createHostedIdentity({
    membershipOf: async (personId) => (PEOPLE[personId] === undefined ? undefined : { companyId: PEOPLE[personId], role: "member" }),
    displayNameOf: async (personId) => (PEOPLE[personId] === undefined ? undefined : personId),
    githubLinks: githubLinkReaderOver(store),
  });
  const link = (store: MemoryDocumentStore, companyId: string, githubUserId: string, personId: string) => linkGithubAccount(store, { companyId, githubUserId, login: `login${githubUserId}`, personId, linkedAt: NOW.toISOString() });
  const github = (accountId: string, tenant = "") => ({ provider: "github", tenant, accountId });

  it("links code host accounts only when it is given the links (the capability follows)", () => {
    expect(createHostedIdentity({ membershipOf: async () => undefined, displayNameOf: async () => undefined }).capabilities.externalAccounts).toBe(false);
    const store = new MemoryDocumentStore();
    const identity = identityOver(store);
    expect(identity.capabilities.externalAccounts).toBe(true);
    expect(typeof identity.accountsOf).toBe("function");
  });

  it("resolves a linked GitHub account to its member of the asking company, and to nobody else", async () => {
    const store = new MemoryDocumentStore();
    await link(store, ORG, "7", "dev-a");
    const identity = identityOver(store);
    expect((await identity.resolveExternalAccount(ORG, github("7")))?.personId).toBe("dev-a");
    expect(await identity.resolveExternalAccount(ORG, github("8"))).toBeUndefined();
    // Another company asking for the same account: nobody (its own partition is empty).
    expect(await identity.resolveExternalAccount(OTHER, github("7"))).toBeUndefined();
    // Another provider, or a tenant: nobody.
    expect(await identity.resolveExternalAccount(ORG, { provider: "gitlab", tenant: "", accountId: "7" })).toBeUndefined();
    expect(await identity.resolveExternalAccount(ORG, github("7", "some-org"))).toBeUndefined();
    expect(await identity.resolveExternalAccount("not-a-company", github("7"))).toBeUndefined();
  });

  it("reads the person live: a member who left, moved to another company, or has no name is nobody", async () => {
    const store = new MemoryDocumentStore();
    await link(store, ORG, "7", "dev-a");
    await link(store, ORG, "9", "dev-o");
    await link(store, ORG, "10", "dev-gone");
    const identity = identityOver(store);
    // dev-o is a member of OTHER now, though the link row sits under ORG.
    expect(await identity.resolveExternalAccount(ORG, github("9"))).toBeUndefined();
    expect(await identity.resolveExternalAccount(ORG, github("10"))).toBeUndefined();
    expect(await identity.accountsOf!(ORG, "dev-o")).toEqual([]);
    expect(await identity.accountsOf!(ORG, "dev-gone")).toEqual([]);
  });

  it("lists a person's own account, in their company only", async () => {
    const store = new MemoryDocumentStore();
    await link(store, ORG, "7", "dev-a");
    const identity = identityOver(store);
    expect(await identity.accountsOf!(ORG, "dev-a")).toEqual([github("7")]);
    expect(await identity.accountsOf!(ORG, "dev-b")).toEqual([]);
    expect(await identity.accountsOf!(OTHER, "dev-a")).toEqual([]);
  });

  it("the identity module reads the links from the registry's own storage (no input needed)", async () => {
    const store = new MemoryDocumentStore();
    const modules = hostedSecurityModules({ env: { ROVARA_CORE_ALLOWED_COMPANIES: ORG }, identity: { membershipOf: async (id) => (id === "dev-a" ? { companyId: ORG, role: "member" } : undefined), displayNameOf: async (id) => id } });
    const registry = await buildCoreRegistry({ modules: [coreAdapter({ point: "storage", name: "memory", owner: "test", create: () => store }), ...modules], context: { installCompanyId: IMPLICIT_COMPANY_ID, now: () => NOW, env: {}, clients: {}, log: () => undefined }, areas: [] });
    const identity = registry.require("identity");
    expect(identity.capabilities.externalAccounts).toBe(true);
    expect(await identity.resolveExternalAccount(ORG, github("7"))).toBeUndefined();
    await link(store, ORG, "7", "dev-a");
    expect((await identity.resolveExternalAccount(ORG, github("7")))?.personId).toBe("dev-a");
  });
});

describe("the step 5 modules", () => {
  const storage = coreAdapter({ point: "storage", name: "memory", owner: "test", create: () => new MemoryDocumentStore() });
  const context = { installCompanyId: IMPLICIT_COMPANY_ID, now: () => NOW, env: {}, clients: {}, log: () => undefined };

  it("fill metering, admission, identity, approvers (lane L2a) and the audit sink, none as Code's laptop default", async () => {
    const modules = hostedSecurityModules({ env: { ROVARA_CORE_ALLOWED_COMPANIES: ORG }, identity: { membershipOf: async () => undefined, displayNameOf: async () => undefined } });
    expect(modules.map((module) => module.point)).toEqual(["metering", "admission", "identity", "approvers", "audit-sink"]);
    expect(modules.some((module) => module.isDefault === true)).toBe(false);
    // The merge area needs storage, code host, approvers and audit: the code host is the broker's own lane (L1b), so it is named, and approvers no longer is.
    const refused = await buildCoreRegistry({ modules: [storage, ...modules], context, areas: ["merge"] }).then(() => undefined, (error: unknown) => error as Error);
    expect(refused?.message).toMatch(/code-host/u);
    expect(refused?.message).not.toMatch(/approvers/u);
  });

  it("refuse the registry when no company is allowed, rather than let every company in", async () => {
    const modules = hostedSecurityModules({ env: {}, identity: { membershipOf: async () => undefined, displayNameOf: async () => undefined } });
    await expect(buildCoreRegistry({ modules: [storage, ...modules], context, areas: [] })).rejects.toThrow("no company is allowed on the core engine");
  });

  it("write Code's audit rows in the company's own partition", async () => {
    const store = new MemoryDocumentStore();
    const modules = hostedSecurityModules({ env: { ROVARA_CORE_ALLOWED_COMPANIES: ORG }, identity: { membershipOf: async () => undefined, displayNameOf: async () => undefined } });
    const registry = await buildCoreRegistry({ modules: [coreAdapter({ point: "storage", name: "memory", owner: "test", create: () => store }), ...modules], context, areas: [] });
    await registry.require("audit-sink").record({ eventId: "evt_1", companyId: ORG, at: NOW.toISOString(), actor: { type: "system", id: "rovara" }, action: "task.started" });
    expect(await store.get({ pk: `ORG#${ORG}#AUDIT`, sk: "EVENT#evt_1" })).toMatchObject({ entityType: "AUDIT", action: "task.started" });
  });
});
