// The two-company isolation kit (packages/testing/src/isolation): it passes on adapters that keep two companies apart, and it FAILS on adapters that do not. The second half is what
// makes it a proof: every mutant here is a router that leaks in one specific way, and the check that guards that way must catch it.
import { describe, expect, it } from "vitest";
import type { CheckRunner, CodeHost, SecretValue, Tracker } from "@agentx/contracts";
import {
  COMPANY_A, COMPANY_A_ID, COMPANY_B, COMPANY_B_ID, NO_COMPANY_WORDS, SHARED_RAW_IDS, assertFailsClosed, assertNoSecretLeaks, assertSurfacesIsolated, assertTwoCompanyIsolation, captureLogs,
  createCompanySecretStore, failingResolver, fakeCheckRunnerCompanies, fakeCodeHostCompanies, fakeTrackerCompanies, routeByCompany, twoCompanyChecks,
  type CompanyResolver, type IsolationSurface, type TwoCompanyIsolation,
} from "../../packages/testing/src/isolation/index.js";
import { runContract } from "../../packages/testing/src/ports/plugin-contract-kit.js";
import type { FakeCodeHost, FakeTracker } from "../../packages/broker/src/plugins/fake/index.js";

const REPO = { url: SHARED_RAW_IDS.repositoryUrl };

/** A router with some of its properties replaced: the leak a mutant adds on top of an honest router. */
const overriding = <T extends object>(router: T, overrides: Record<string, unknown>): T => new Proxy(router, {
  get: (target, property, receiver) => (typeof property === "string" && property in overrides ? overrides[property] : (Reflect.get(target, property, receiver) as unknown)),
});

describe("the kit passes on routers that keep two companies apart", () => {
  const sets: Array<[string, () => TwoCompanyIsolation]> = [
    ["a code host", () => fakeCodeHostCompanies().isolation],
    ["a tracker", () => fakeTrackerCompanies().isolation],
    ["a check runner", () => fakeCheckRunnerCompanies().isolation],
  ];
  for (const [label, make] of sets) {
    runContract<{ isolation: TwoCompanyIsolation }>(`${label} behind a company router`, twoCompanyChecks(), () => ({ isolation: make() }));
  }

  it("shows the checks as skipped, never passed, for a world that serves one company", () => {
    const [shared, failClosed] = twoCompanyChecks<{ isolation?: TwoCompanyIsolation }>();
    expect(shared!.needs!({})).toBe(false);
    expect(failClosed!.needs!({})).toBe(false);
    expect(shared!.needs!({ isolation: fakeTrackerCompanies().isolation })).toBe(true);
    // A set with surfaces but no fail-closed probe does not claim the fail-closed check.
    expect(failClosed!.needs!({ isolation: { surfaces: [] } })).toBe(false);
  });
});

describe("a leaking router fails the check that guards the way it leaks", () => {
  // Every call goes to company A's adapter, whoever asks.
  const alwaysA: CompanyResolver = () => COMPANY_A_ID;
  // A broken lookup is answered with company A, the "default company".
  const defaultsToA = (resolve: CompanyResolver | undefined): CompanyResolver | undefined => resolve === undefined ? undefined : async (scope) => { try { return (await resolve(scope)) ?? COMPANY_A_ID; } catch { return COMPANY_A_ID; } };

  it("code host: a router that serves every call from one company's adapter shows company A's file to company B", async () => {
    const companies = fakeCodeHostCompanies((hosts) => routeByCompany(hosts, { resolve: alwaysA }));
    await expect(assertSurfacesIsolated(companies.isolation.surfaces)).rejects.toThrow(/saw company A's marker/);
  });

  it("tracker: a router that does that shows company A's item to company B", async () => {
    const companies = fakeTrackerCompanies((trackers) => routeByCompany(trackers, { resolve: alwaysA }));
    await expect(assertSurfacesIsolated(companies.isolation.surfaces)).rejects.toThrow(/saw company A's marker|saw none of its own/);
  });

  it("check runner: a router that does that starts company B's run in company A's runner and is caught", async () => {
    const companies = fakeCheckRunnerCompanies((runners) => routeByCompany(runners, { resolve: alwaysA }));
    await expect(assertSurfacesIsolated(companies.isolation.surfaces)).rejects.toThrow(/started in another company's runner/);
  });

  it("check runner: runs are routed but a log read is served from company A's runner, so company B reads A's log", async () => {
    const companies = fakeCheckRunnerCompanies((runners) => {
      const router = routeByCompany(runners);
      const first = [...runners.values()][0]!;
      return overriding<CheckRunner>(router, { logTail: first.logTail.bind(first) });
    });
    await expect(assertSurfacesIsolated(companies.isolation.surfaces)).rejects.toThrow(/saw company A's marker/);
  });

  it("tracker: reads are routed but comments all go to the first company's tracker, so company B's write never lands in B", async () => {
    const companies = fakeTrackerCompanies((trackers) => {
      const router = routeByCompany(trackers);
      const first = [...trackers.values()][0]!;
      return overriding<Tracker>(router, { comment: first.comment.bind(first) });
    });
    await expect(assertSurfacesIsolated(companies.isolation.surfaces)).rejects.toThrow(/write "tracker: a comment/);
  });

  it("code host: a delivery verified with any company's secret is shown to a company it was not signed for", async () => {
    const companies = fakeCodeHostCompanies((hosts) => {
      const router = routeByCompany(hosts);
      return overriding<CodeHost>(router, { events: {
        mode: "webhook",
        normalise: async (delivery: never, scope: never) => {
          for (const host of hosts.values()) { try { return await host.events.normalise!(delivery, scope); } catch { /* try the next company's secret */ } }
          throw new Error("no company's secret verifies it");
        },
      } });
    });
    await expect(assertSurfacesIsolated(companies.isolation.surfaces)).rejects.toThrow(/delivery "code host: a webhook delivery/);
  });

  it("every adapter: one that falls back to a default company when the lookup throws or answers nothing is caught by the fail-closed probes", async () => {
    const code = fakeCodeHostCompanies((hosts, resolve) => routeByCompany(hosts, { resolve: defaultsToA(resolve) ?? ((scope) => ("orgId" in scope ? scope.orgId : undefined)) }));
    await expect(assertFailsClosed(code.isolation.failClosed!)).rejects.toThrow(/gave out company A's marker|succeeded with/);
    const tracker = fakeTrackerCompanies((trackers, resolve) => routeByCompany(trackers, { resolve: defaultsToA(resolve) ?? ((scope) => ("orgId" in scope ? scope.orgId : undefined)) }));
    await expect(assertFailsClosed(tracker.isolation.failClosed!)).rejects.toThrow(/gave out company A's marker|succeeded with/);
    const runner = fakeCheckRunnerCompanies((runners, resolve) => routeByCompany(runners, { resolve: defaultsToA(resolve) ?? ((scope) => ("orgId" in scope ? scope.orgId : undefined)) }));
    await expect(assertFailsClosed(runner.isolation.failClosed!)).rejects.toThrow(/gave out company A's marker|succeeded with/);
  });

  it("positive control: the same probes pass on the honest routers (so the failures above come from the leak, not from the probe)", async () => {
    for (const make of [fakeCodeHostCompanies, fakeTrackerCompanies, fakeCheckRunnerCompanies]) await assertTwoCompanyIsolation(make().isolation);
  });
});

describe("the kit's own rules", () => {
  const own = (company: typeof COMPANY_A): Promise<{ handle: string }> => Promise.resolve({ handle: company.label });

  it("a set with no surfaces proves nothing and fails", async () => {
    await expect(assertSurfacesIsolated([])).rejects.toThrow(/no surfaces/);
  });

  it("a surface that observes nothing cannot pass by looking at nothing", async () => {
    const blind: IsolationSurface = { kind: "read", name: "blind", plant: own, observe: async () => undefined };
    await expect(assertSurfacesIsolated([blind])).rejects.toThrow(/saw none of its own markers/);
  });

  it("a surface that shows the other company's canary fails, naming the surface and the observer but never inventing a secret", async () => {
    const mixed: IsolationSurface = { kind: "list", name: "mixed", plant: own, observe: async (as) => [COMPANY_A.canary, COMPANY_B.canary, as.label] };
    await expect(assertSurfacesIsolated([mixed])).rejects.toThrow(/list "mixed" as company A: saw company B's marker/);
  });

  it("a surface may declare that the observer legitimately sees nothing of its own", async () => {
    const refusing: IsolationSurface = { kind: "event", name: "refused by design", expectOwn: false, plant: own, observe: async () => ({ ok: false, refused: "no" }) };
    await assertSurfacesIsolated([refusing]);
  });

  it("an adapter that does not echo what it is given names the opaque ids it handed back as its markers", async () => {
    const ids = new Map<string, string>();
    const opaque: IsolationSurface = {
      kind: "read", name: "opaque ids",
      plant: async (me) => { ids.set(me.label, `id-${me.label}-77`); return { handle: me.label, markers: [`id-${me.label}-77`] }; },
      observe: async (as) => [...ids.entries()].filter(([label]) => label === as.label).map(([, id]) => id),
    };
    await assertSurfacesIsolated([opaque]);
    const leaky: IsolationSurface = { ...opaque, observe: async () => [...ids.values()] };
    await expect(assertSurfacesIsolated([leaky])).rejects.toThrow(/saw company/);
  });

  it("tears a surface down after the observations, pass or fail", async () => {
    let torn = 0;
    const base: IsolationSurface = { kind: "read", name: "listening", plant: own, observe: async (as) => as.canary, teardown: async () => { torn += 1; } };
    await assertSurfacesIsolated([base]);
    expect(torn).toBe(1);
    await expect(assertSurfacesIsolated([{ ...base, observe: async () => undefined }])).rejects.toThrow(/saw none of its own/);
    expect(torn).toBe(2);
  });

  it("a fail-closed probe that succeeds with data fails, and one that is refused or answers nothing passes", async () => {
    const give = (value: unknown) => ({ name: "p", prepare: async () => undefined, attempt: async () => value });
    await expect(assertFailsClosed([give({ file: "text" })])).rejects.toThrow(/succeeded with/);
    await assertFailsClosed([give(undefined), give([]), give(null), { name: "refused", prepare: async () => undefined, attempt: async () => { throw new Error("refused"); } }]);
  });

  it("a probe whose refusal names a company's canary fails", async () => {
    await expect(assertFailsClosed([{ name: "p", prepare: async () => undefined, attempt: async () => { throw new Error(`no access for ${COMPANY_B.canary}`); } }])).rejects.toThrow(/gave out company B's marker/);
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

  it("finds a planted secret in an error, a log line and a result, naming the position and never the value", async () => {
    const secret = planted("leak");
    expect(() => assertNoSecretLeaks(["fine", new Error("fine"), { ok: true }], [secret])).not.toThrow();
    for (const output of [`token ${secret}`, new Error(`failed with ${secret}`), { nested: { value: secret } }]) {
      let message = "";
      try { assertNoSecretLeaks([output], [secret]); } catch (error) { message = (error as Error).message; }
      expect(message).toContain("holds planted secret number 0");
      expect(message).not.toContain(secret);
    }
    const { lines, result } = await captureLogs(async () => { console.log("a line"); console.error({ seen: secret }); return 7; });
    expect(result).toBe(7);
    expect(lines).toHaveLength(2);
    expect(() => assertNoSecretLeaks(lines, [secret])).toThrow(/output 1 holds planted secret number 0/);
  });
});
