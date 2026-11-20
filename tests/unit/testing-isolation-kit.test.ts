// The two-company isolation kit (packages/testing/src/isolation): it passes on adapters that keep two companies apart, and it FAILS on adapters that do not. The second half is what
// makes it a proof: every mutant here is a router that leaks in one specific way, and the check that guards that way must catch it.
import { describe, expect, it } from "vitest";
import type { CodeHost, SecretValue } from "@agentx/contracts";
import { COMPANY_A, COMPANY_A_ID, COMPANY_B, COMPANY_B_ID, NO_COMPANY_WORDS, SHARED_RAW_IDS, assertFailsClosed, assertSurfacesIsolated, assertTwoCompanyIsolation, createCompanySecretStore, failingResolver, fakeCheckRunnerCompanies, fakeCodeHostCompanies, fakeTrackerCompanies, routeByCompany, type CompanyResolver, type IsolationSurface } from "../../packages/testing/src/isolation/index.js";
import type { FakeCodeHost, FakeTracker } from "../../packages/broker/src/plugins/fake/index.js";

const REPO = { url: SHARED_RAW_IDS.repositoryUrl };

describe("a leaking router fails the check that guards the way it leaks", () => {
  // Every call goes to company A's adapter, whoever asks.
  const alwaysA: CompanyResolver = () => COMPANY_A_ID;

  it("check runner: a router that does that starts company B's run in company A's runner and is caught", async () => {
    const companies = fakeCheckRunnerCompanies((runners) => routeByCompany(runners, { resolve: alwaysA }));
    await expect(assertSurfacesIsolated(companies.isolation.surfaces)).rejects.toThrow(/started in another company's runner/);
  });

  it("positive control: the same probes pass on the honest routers (so the failures above come from the leak, not from the probe)", async () => {
    for (const make of [fakeCodeHostCompanies, fakeTrackerCompanies, fakeCheckRunnerCompanies]) await assertTwoCompanyIsolation(make().isolation);
  });
});

describe("the kit's own rules", () => {
  const own = (company: typeof COMPANY_A): Promise<{ handle: string }> => Promise.resolve({ handle: company.label });

  it("a surface that observes nothing cannot pass by looking at nothing", async () => {
    const blind: IsolationSurface = { kind: "read", name: "blind", plant: own, observe: async () => undefined };
    await expect(assertSurfacesIsolated([blind])).rejects.toThrow(/saw none of its own markers/);
  });

  it("a fail-closed probe that succeeds with data fails, and one that is refused or answers nothing passes", async () => {
    const give = (value: unknown) => ({ name: "p", prepare: async () => undefined, attempt: async () => value });
    await expect(assertFailsClosed([give({ file: "text" })])).rejects.toThrow(/succeeded with/);
    await assertFailsClosed([give(undefined), give([]), give(null), { name: "refused", prepare: async () => undefined, attempt: async () => { throw new Error("refused"); } }]);
  });

});

describe("the company router", () => {
  const hosts = fakeCodeHostCompanies().hosts;
  const router = routeByCompany(hosts);

  it("serves a call for the company its scope names, and the data properties come from the first adapter", async () => {
    expect(router.kind).toBe("fake");
    expect(await router.repositoryIdentity(REPO, COMPANY_A.scope)).toMatchObject({ fullName: "acme/app" });
    expect(await router.repositoryIdentity(REPO, COMPANY_B.scope)).toMatchObject({ fullName: "acme/app" });
  });

  it("refuses with one fixed sentence that names no company: a system scope, an unknown company, a resolver that throws, a resolver that answers nothing", async () => {
    const calls: Array<[string, CodeHost]> = [
      ["system scope", router],
      ["unknown company", routeByCompany(hosts, { resolve: () => "org_zzzzzzzzzzzzzzzzzzzz" })],
      ["resolver throws", routeByCompany(hosts, { resolve: failingResolver("throws") })],
      ["resolver answers undefined", routeByCompany(hosts, { resolve: failingResolver("undefined") })],
    ];
    for (const [label, host] of calls) {
      const refused = await host.repositoryIdentity(REPO, label === "system scope" ? { system: "install" } : COMPANY_A.scope).catch((error: Error) => error);
      expect(refused, label).toBeInstanceOf(Error);
      const message = (refused as Error).message;
      expect(message, label).toContain(NO_COMPANY_WORDS);
      expect(message.replace(/^FORBIDDEN: /u, ""), label).toBe(NO_COMPANY_WORDS);
      for (const word of [COMPANY_A_ID, COMPANY_B_ID, "org_zzzzzzzzzzzzzzzzzzzz", "company lookup"]) expect(message).not.toContain(word);
    }
  });

  it("a call with no scope at all is refused, never given to the first company", async () => {
    const bare = router as unknown as { branchHead(...args: unknown[]): Promise<string> };
    await expect(bare.branchHead(REPO, "main")).rejects.toThrow(NO_COMPANY_WORDS);
  });

  it("needs at least one company", () => {
    expect(() => routeByCompany(new Map<string, FakeCodeHost>())).toThrow(/at least one company/);
    expect(() => routeByCompany(new Map<string, FakeTracker>())).toThrow(/at least one company/);
  });
});

describe("the secret ledger and the leak greps", () => {
  const ref = { env: "SHARED_NAME" } as const;
  const planted = (label: string): string => ["planted", label, "value", "0123456789"].join("-");

  it("serves each company its own secret under the same reference, and records every read without a value", async () => {
    const store = createCompanySecretStore();
    store.set(COMPANY_A_ID, ref, planted("a"));
    store.set(COMPANY_B_ID, ref, planted("b"));
    expect((await store.read(COMPANY_A_ID, ref) as SecretValue).reveal()).toBe(planted("a"));
    expect((await store.read(COMPANY_B_ID, ref) as SecretValue).reveal()).toBe(planted("b"));
    expect(store.reads).toEqual([{ companyId: COMPANY_A_ID, ref: "env:SHARED_NAME" }, { companyId: COMPANY_B_ID, ref: "env:SHARED_NAME" }]);
    store.set(COMPANY_A_ID, ref, undefined);
    expect(await store.read(COMPANY_A_ID, ref)).toBeUndefined();
  });

  it("a read for another company while a call is made for company A fails at once with a sentence that names neither", async () => {
    const store = createCompanySecretStore();
    store.set(COMPANY_B_ID, ref, planted("b"));
    const error = await store.actingFor(COMPANY_A_ID, () => store.read(COMPANY_B_ID, ref)).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(COMPANY_B_ID);
    expect(store.reads).toHaveLength(1);
    // Outside the call the read is ordinary again, and a read for the acting company is fine.
    expect(await store.read(COMPANY_B_ID, ref)).toBeDefined();
    await store.actingFor(COMPANY_B_ID, () => store.read(COMPANY_B_ID, ref));
  });

});
