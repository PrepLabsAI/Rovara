// Lanes AU and EV: the two read routes for a company administrator, as the developer API serves them:
//   GET /v1/dev/client/company/audit/records   and   GET /v1/dev/client/company/events
// The handler is checked here with fakes; the mount on the developer API is checked in tests/contract/company-reads-mount.test.ts.
import { describe, expect, it } from "vitest";
import { routeCompanyReads, type CompanyReadsConfiguration } from "../../packages/broker/src/developer/company-reads.js";
import { COMPANY_A, COMPANY_B, IMPLICIT_COMPANY_ID, TASK_IN_SHARD, countingReadOnly, newStore, plantAuditRow, seedAudit, seedEvent } from "../support/company-reads-fixtures.js";

const NOW = Date.parse("2026-11-20T00:00:00.000Z");
const ADA = { developerId: "a".repeat(64), administrator: true };
const BO = { developerId: "b".repeat(64), administrator: true };
const NOBODY = { developerId: "c".repeat(64), administrator: false };
const AUDIT = "/v1/dev/client/company/audit/records";
const EVENTS = "/v1/dev/client/company/events";
const url = (path: string, query: Record<string, string | string[]> = {}) => {
  const target = new URL(path, "https://code.invalid");
  for (const [name, value] of Object.entries(query)) for (const one of Array.isArray(value) ? value : [value]) target.searchParams.append(name, one);
  return target;
};

async function world() {
  const store = newStore();
  for (let index = 0; index < 3; index += 1) {
    await seedAudit(store, COMPANY_A, { eventId: `evt_a${String(index)}`, at: `2026-11-10T10:0${String(index)}:00.000Z`, actor: { type: "person", id: ADA.developerId } });
    await seedAudit(store, COMPANY_B, { eventId: `evt_b${String(index)}`, at: `2026-11-10T10:0${String(index)}:00.000Z`, actor: { type: "person", id: BO.developerId } });
  }
  const a = await seedEvent(store, COMPANY_A, { at: "2026-11-10T10:00:00.000Z", taskId: TASK_IN_SHARD(1) });
  const b = await seedEvent(store, COMPANY_B, { at: "2026-11-10T10:00:00.000Z", taskId: TASK_IN_SHARD(1) });
  const config: CompanyReadsConfiguration = {
    store,
    companyOf: async (developerId) => (developerId === ADA.developerId ? COMPANY_A : developerId === BO.developerId ? COMPANY_B : undefined),
    personName: async (developerId) => (developerId === ADA.developerId ? "Ada" : developerId === BO.developerId ? "Bo" : undefined),
  };
  return { store, config, a, b };
}
const read = (config: CompanyReadsConfiguration, caller: { developerId: string; administrator: boolean }, target: URL) => routeCompanyReads(config, caller, target, NOW);
const failure = async (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a refusal"); }, (error: Error & { code?: string; status?: number }) => error);

describe("two companies, both routes: each administrator sees their own company and nothing else", () => {
  it("the audit read answers each administrator their own company's records, with names", async () => {
    const { config } = await world();
    const ada = await read(config, ADA, url(AUDIT)) as { records: Array<{ eventId: string; actor: { name: string } }> };
    const bo = await read(config, BO, url(AUDIT)) as { records: Array<{ eventId: string; actor: { name: string } }> };
    expect(ada.records.map((record) => record.eventId).sort()).toEqual(["evt_a0", "evt_a1", "evt_a2"]);
    expect(bo.records.map((record) => record.eventId).sort()).toEqual(["evt_b0", "evt_b1", "evt_b2"]);
    expect(new Set(ada.records.map((record) => record.actor.name))).toEqual(new Set(["Ada"]));
    expect(new Set(bo.records.map((record) => record.actor.name))).toEqual(new Set(["Bo"]));
  });

  it("the event read answers each administrator their own company's events", async () => {
    const { config, a, b } = await world();
    const window = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-30T00:00:00.000Z" };
    const ada = await read(config, ADA, url(EVENTS, window)) as { events: Array<{ id: string }> };
    const bo = await read(config, BO, url(EVENTS, window)) as { events: Array<{ id: string }> };
    expect(ada.events.map((event) => event.id)).toEqual([a]);
    expect(bo.events.map((event) => event.id)).toEqual([b]);
  });

  it("neither body, nor any refusal, carries the other company's id", async () => {
    const { config, store } = await world();
    await plantAuditRow(store, COMPANY_A, "evt_planted", { companyId: COMPANY_B });
    const window = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-30T00:00:00.000Z" };
    const texts = [
      JSON.stringify(await read(config, ADA, url(AUDIT))), JSON.stringify(await read(config, ADA, url(EVENTS, window))),
      (await failure(read(config, ADA, url(AUDIT, { limit: "0" })))).message, (await failure(read(config, ADA, url(AUDIT, { cursor: "x" })))).message,
      (await failure(read(config, NOBODY, url(AUDIT)))).message,
    ];
    for (const text of texts) {
      expect(text).not.toContain(COMPANY_B);
      expect(text).not.toContain("evt_b");
      expect(text).not.toContain(BO.developerId);
    }
  });

  it("a cursor from one company's page does not open the other's", async () => {
    const { config } = await world();
    const first = await read(config, ADA, url(AUDIT, { limit: "1" })) as { next?: string };
    expect(first.next).toBeDefined();
    const refused = await failure(read(config, BO, url(AUDIT, { limit: "1", cursor: first.next! })));
    expect(refused).toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: that cursor is not valid" });
  });
});

describe("who may read: a company administrator, resolved from membership", () => {
  it("refuses a caller who is not an administrator, on both routes, with the same words and no read", async () => {
    const { config, store } = await world();
    const probe = countingReadOnly(store);
    const guarded = { ...config, store: probe.store };
    for (const target of [url(AUDIT), url(EVENTS, { from: "2026-11-01T00:00:00.000Z" })]) {
      expect(await failure(read(guarded, NOBODY, target))).toMatchObject({ code: "FORBIDDEN", message: "FORBIDDEN: only a company administrator can read this" });
    }
    expect(probe.queries()).toBe(0);
  });

  it("answers the sign-in-again refusal, and reads nothing, when the caller's company cannot be resolved (no fallback to the implicit company)", async () => {
    const { config, store } = await world();
    const probe = countingReadOnly(store);
    const stranger = { developerId: "d".repeat(64), administrator: true };
    for (const companyOf of [async () => undefined, async () => { throw new Error("membership store down: secret"); }, async () => "", async () => "not-a-company", async () => 7 as never]) {
      const refusal = await failure(read({ ...config, store: probe.store, companyOf }, stranger, url(AUDIT)));
      expect(refusal).toMatchObject({ code: "AUTH_REQUIRED" });
      expect(refusal.message).not.toContain("secret");
    }
    expect(probe.queries()).toBe(0);
  });

  it("is one company, the implicit one, when the install has no company resolver (today's behaviour)", async () => {
    const store = newStore();
    await plantAuditRow(store, IMPLICIT_COMPANY_ID, "evt_old", {});
    await seedAudit(store, COMPANY_A, { eventId: "evt_a", at: "2026-11-10T10:00:00.000Z" });
    const page = await read({ store }, ADA, url(AUDIT)) as { records: Array<{ eventId: string }> };
    expect(page.records.map((record) => record.eventId)).toEqual(["evt_old"]);
  });

  it.todo("refuses a token without the company audit scope (waits for the scope table: lane ID's named scopes)");
  it.todo("refuses a token without the company events scope (waits for the scope table: lane ID's named scopes)");
});

// Audit gap 4 (2026-11-18): an owner or admin of a real company has no Rovara administrator flag (that is the built-in company's OIDC admin only). They read their own company by their LIVE
// role, the rule the other company admin routes use; a member, a removed person and another company's person are refused.
describe("who may read: a live owner or admin of the caller's own company", () => {
  const OWNER = { developerId: "e".repeat(64), administrator: false };
  const ADMIN = { developerId: "f".repeat(64), administrator: false };
  const MEMBER = { developerId: "9".repeat(64), administrator: false };
  const OWNER_B = { developerId: "8".repeat(64), administrator: false };
  const roles: Record<string, { companyId: string; role: "owner" | "admin" | "member" }> = {
    [OWNER.developerId]: { companyId: COMPANY_A, role: "owner" }, [ADMIN.developerId]: { companyId: COMPANY_A, role: "admin" },
    [MEMBER.developerId]: { companyId: COMPANY_A, role: "member" }, [OWNER_B.developerId]: { companyId: COMPANY_B, role: "owner" },
  };
  async function live(overrides: Partial<CompanyReadsConfiguration> = {}) {
    const base = await world();
    const config: CompanyReadsConfiguration = {
      ...base.config,
      companyOf: async (developerId) => roles[developerId]?.companyId,
      membershipOf: async (developerId) => roles[developerId],
      ...overrides,
    };
    return { ...base, config };
  }
  const ids = (page: unknown) => (page as { records: Array<{ eventId: string }> }).records.map((record) => record.eventId).sort();

  it("an owner and an admin read their own company's records and events, and nothing of the other company", async () => {
    const { config, a } = await live();
    for (const caller of [OWNER, ADMIN]) {
      expect(ids(await read(config, caller, url(AUDIT)))).toEqual(["evt_a0", "evt_a1", "evt_a2"]);
      expect((await read(config, caller, url(EVENTS, { from: "2026-11-01T00:00:00.000Z" })) as { events: Array<{ id: string }> }).events.map((event) => event.id)).toEqual([a]);
    }
    expect(ids(await read(config, OWNER_B, url(AUDIT)))).toEqual(["evt_b0", "evt_b1", "evt_b2"]);
  });

  it("refuses a member, a person with no membership, and a role the reader does not know, with the fixed words and no read", async () => {
    const { config, store } = await live({ membershipOf: async (developerId) => (developerId === "7".repeat(64) ? { companyId: COMPANY_A, role: "stranger" as never } : roles[developerId]) });
    const probe = countingReadOnly(store);
    for (const caller of [MEMBER, NOBODY, { developerId: "7".repeat(64), administrator: false }]) {
      for (const target of [url(AUDIT), url(EVENTS, { from: "2026-11-01T00:00:00.000Z" })]) {
        expect(await failure(read({ ...config, store: probe.store }, caller, target))).toMatchObject({ code: "FORBIDDEN", message: "FORBIDDEN: only a company administrator can read this" });
      }
    }
    expect(probe.queries()).toBe(0);
  });

  it("refuses an owner whose live membership names another company than the resolver, or than their sign-in resolved", async () => {
    const { config, store } = await live();
    const probe = countingReadOnly(store);
    // The resolver says company A, the live membership says company B: no read of either.
    const split = { ...config, store: probe.store, membershipOf: async () => ({ companyId: COMPANY_B, role: "owner" as const }) };
    expect(await failure(read(split, OWNER, url(AUDIT)))).toMatchObject({ code: "FORBIDDEN" });
    // The sign-in resolved company B, the membership now says company A (moved or removed since): refused.
    expect(await failure(read({ ...config, store: probe.store }, { ...OWNER, companyId: COMPANY_B }, url(AUDIT)))).toMatchObject({ code: "FORBIDDEN" });
    expect(probe.queries()).toBe(0);
    // The same company on both: read.
    expect(ids(await read(config, { ...OWNER, companyId: COMPANY_A }, url(AUDIT)))).toEqual(["evt_a0", "evt_a1", "evt_a2"]);
  });

  it("refuses everyone but a Rovara administrator where the install gives no live role reader, or no company resolver", async () => {
    const { config } = await live();
    const { membershipOf: _dropped, ...noRoles } = config;
    void _dropped;
    expect(await failure(read(noRoles, OWNER, url(AUDIT)))).toMatchObject({ code: "FORBIDDEN" });
    const { companyOf: _alsoDropped, ...noResolver } = config;
    void _alsoDropped;
    expect(await failure(read(noResolver, OWNER, url(AUDIT)))).toMatchObject({ code: "FORBIDDEN" });
    // Even a role reader that names the install's one (implicit) company opens nothing without a resolver: that install's reads stay the Rovara administrator's.
    expect(await failure(read({ ...noResolver, membershipOf: async () => ({ companyId: IMPLICIT_COMPANY_ID, role: "owner" as const }) }, OWNER, url(AUDIT)))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("answers the sign-in-again refusal when the live role cannot be read, never the cause", async () => {
    const { config } = await live({ membershipOf: async () => { throw new Error("membership store down: secret"); } });
    const refusal = await failure(read(config, OWNER, url(AUDIT)));
    expect(refusal).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(refusal.message).not.toContain("secret");
  });
});

describe("the query string", () => {
  it("passes the audit filters through", async () => {
    const { config } = await world();
    const page = await read(config, ADA, url(AUDIT, { person: ADA.developerId, action: "task.*", from: "2026-11-10T10:01:00.000Z", to: "2026-11-10T10:02:00.000Z", limit: "10" })) as { records: unknown[] };
    expect(page.records).toHaveLength(2);
  });

  it("passes the event filters through, and reads `kinds` as a comma list", async () => {
    const { config } = await world();
    const page = await read(config, ADA, url(EVENTS, { from: "2026-11-01T00:00:00.000Z", kinds: "step_started,cost_settled", project: "billing-service", person: "dev_ada" })) as { events: unknown[] };
    expect(page.events).toHaveLength(1);
  });

  it("refuses a repeated parameter, an unknown one, and an empty one, with fixed words that echo nothing", async () => {
    const { config } = await world();
    for (const target of [
      url(AUDIT, { person: ["x", "y"] }), url(AUDIT, { surprise: "1" }), url(AUDIT, { person: "" }), url(AUDIT, { limit: "ten" }), url(AUDIT, { limit: "010" }), url(AUDIT, { limit: "1e1" }),
      url(EVENTS, { from: "2026-11-01T00:00:00.000Z", kinds: "a,,b" }), url(EVENTS, { kinds: "step_started" }), url(EVENTS, { from: "2026-11-01T00:00:00.000Z", surprise: "1" }),
    ]) {
      const refusal = await failure(read(config, ADA, target));
      expect(refusal.code, target.search).toMatch(/^(CONFIG_INVALID|AUDIT_RANGE_INVALID)$/u);
      expect(refusal.message).not.toContain("surprise");
      expect(refusal.message).not.toContain("ten");
    }
  });

  it("answers an unknown route under the prefix as not found", async () => {
    const { config } = await world();
    expect(await failure(read(config, ADA, url("/v1/dev/client/company/audit")))).toMatchObject({ code: "NOT_FOUND" });
    expect(await failure(read(config, ADA, url("/v1/dev/client/company/events/x")))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("looks up a name for each person once, and no more than a page's worth", async () => {
    const { config } = await world();
    const asked: string[] = [];
    await read({ ...config, personName: async (id) => { asked.push(id); return "N"; } }, ADA, url(AUDIT));
    expect(asked).toEqual([ADA.developerId]);
  });

  it("asks for a name with the caller's company, so a lookup can refuse a person of another company", async () => {
    const { config } = await world();
    const seen: Array<[string, string]> = [];
    await read({ ...config, personName: async (id, company) => { seen.push([id, company]); return "N"; } }, ADA, url(AUDIT));
    expect(seen).toEqual([[ADA.developerId, COMPANY_A]]);
  });

  it("falls back to the person's id when no name is known, or the lookup fails", async () => {
    const { config } = await world();
    const page = await read({ ...config, personName: async () => { throw new Error("nope"); } }, ADA, url(AUDIT)) as { records: Array<{ actor: { name: string } }> };
    expect(page.records[0]!.actor.name).toBe(ADA.developerId);
  });
});
