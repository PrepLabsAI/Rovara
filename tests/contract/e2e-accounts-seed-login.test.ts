import { describe, expect, it } from "vitest";
import {
  E2EApplicationProjectContractSchema, E2EExecutorAccountSchema, E2E_SEED_COMMAND_MAX_TIMEOUT_MS, createE2ESyntheticAccountDefinition, e2eSyntheticAccountContractDigest,
} from "@agentx/contracts";
import { planSyntheticAccountWrites, type E2EAccountRegistryEntry } from "../../packages/broker/src/e2e/application-account-registry.js";
import { ORDERS_APPLICATION_ID, contractOf, ordersManifestWith, shaCanonicalOf } from "../support/e2e-account-registry-fixtures.js";

// Task 3.2: the recipe-declared account seed (`rovara-accounts-file/v1`, `recipe.seed`) and the form login (`rovara-form-login/v1`, `profile.login`) are part of what an account
// is. A change to either re-versions the account (Task 3.1 carry), and a contract that declares neither is digested exactly as before, so the qualification digests do not move.

const LOGIN = { kind: "form", path: "/", usernameTestId: "email", passwordTestId: "password", submitTestId: "login-submit", successTestId: "identity" } as const;
const SEED = { program: "node", args: ["seed.mjs"], cwd: ".", timeoutMs: 30_000, env: {} };

type Edit = Parameters<typeof ordersManifestWith>[0];
type Loose = Record<string, unknown>;
/** The seed command and a profile's login form of a manifest being edited, as plain records (the fixtures type a manifest more narrowly than a test needs to). */
const seedOf = (e2e: Parameters<Edit>[0]) => (e2e.recipe as unknown as { seed: { program: string; args: string[]; cwd: string; timeoutMs: number; env: Record<string, string> } }).seed;
const loginOf = (e2e: Parameters<Edit>[0], profileId: string) => (e2e.accountProfiles.find((profile) => profile.profileId === profileId) as unknown as { login: Record<string, string> }).login;
const loginOfIndex = (e2e: Parameters<Edit>[0], index: number) => (e2e.accountProfiles[index] as unknown as { login: Loose }).login;
const withGenericAccounts: Edit = (e2e) => {
  const recipe = e2e.recipe as Record<string, unknown>;
  recipe.seedProfileId = "rovara-accounts-file/v1";
  recipe.seed = { ...SEED };
  for (const profile of e2e.accountProfiles) {
    profile.authProfileId = "rovara-form-login/v1";
    profile.seedProfileId = "rovara-accounts-file/v1";
    (profile as Record<string, unknown>).login = { ...LOGIN };
  }
};
const generic = contractOf(ordersManifestWith(withGenericAccounts));
const digestOf = (contract: typeof generic, profileId: string) => e2eSyntheticAccountContractDigest(contract, profileId);
const edited = (...edits: Edit[]) => contractOf(ordersManifestWith((e2e) => { withGenericAccounts(e2e); for (const edit of edits) edit(e2e); }));

describe("the account seed and login declarations", () => {
  it("accepts a seed command of at most 60000 ms and a login form, and refuses a seed command that may run longer", () => {
    expect(E2E_SEED_COMMAND_MAX_TIMEOUT_MS).toBe(60_000);
    expect(generic.recipe.seed).toEqual(SEED);
    expect(generic.accountProfiles.every((profile) => profile.login !== undefined)).toBe(true);
    const longer = ordersManifestWith((e2e) => { withGenericAccounts(e2e); seedOf(e2e).timeoutMs = 60_001; });
    expect(() => contractOf(longer)).toThrow(/at most 60000/);
  });

  it("refuses a seed command whose seed profile is not the accounts-file profile, and a login that does not belong to the form-login profile", () => {
    expect(() => contractOf(ordersManifestWith((e2e) => { (e2e.recipe as Record<string, unknown>).seed = { ...SEED }; }))).toThrow(/rovara-accounts-file\/v1/);
    expect(() => contractOf(ordersManifestWith((e2e) => { (e2e.accountProfiles[0] as Record<string, unknown>).login = { ...LOGIN }; }))).toThrow(/login form is declared exactly for rovara-form-login\/v1/);
    expect(() => contractOf(ordersManifestWith((e2e) => { withGenericAccounts(e2e); delete (e2e.accountProfiles[0] as Record<string, unknown>).login; }))).toThrow(/login form is declared exactly for rovara-form-login\/v1/);
  });

  it("refuses a seed command that carries a credential-looking environment name, as every recipe command does", () => {
    expect(() => contractOf(ordersManifestWith((e2e) => { withGenericAccounts(e2e); seedOf(e2e).env = { SEED_TOKEN: "x" }; }))).toThrow();
  });

  it("refuses a login form with an unknown field or a path that leaves the application", () => {
    expect(() => contractOf(ordersManifestWith((e2e) => { withGenericAccounts(e2e); loginOfIndex(e2e, 0).extra = 1; }))).toThrow();
    expect(() => contractOf(ordersManifestWith((e2e) => { withGenericAccounts(e2e); loginOfIndex(e2e, 0).path = "https://elsewhere.example/login"; }))).toThrow();
  });

  it("lets the executor plan carry the login of an account, exactly as declared, and refuses a login of another shape", () => {
    const base = { profileId: "orders-owner", email: "rovara-orders-owner-abc123@example.test", password: "p".repeat(32) };
    expect(E2EExecutorAccountSchema.parse({ ...base, login: LOGIN }).login).toEqual(LOGIN);
    expect(E2EExecutorAccountSchema.parse(base)).toEqual(base);
    expect(() => E2EExecutorAccountSchema.parse({ ...base, login: { ...LOGIN, kind: "basic" } })).toThrow();
    expect(() => E2EExecutorAccountSchema.parse({ ...base, login: { ...LOGIN, extra: true } })).toThrow();
  });
});

describe("the per-profile account digest covers the seed and the login", () => {
  it("is unchanged for a contract that declares neither (the built-in orders profiles; no qualification digest moves)", () => {
    const orders = contractOf(ordersManifestWith(() => undefined));
    expect(digestOf(orders, "synthetic")).toBe("b5c15f23623dc153c48041e24167e45e29668d5b9c42ea0c76741fee39a98fbc");
    expect(digestOf(orders, "orders-owner")).toBe("72ff5e665dd4e8c9c495ecb344eb48572c98bdef86719bcd0d30134b25146e3e");
    expect(digestOf(orders, "orders-viewer")).toBe("b6d137a6e48dccfdc49d3eddf77e0887e3a06d5633dda67316d21a8a3068e567");
  });

  it("differs from the built-in profile's digest once the profile uses the generic seed and login", () => {
    const orders = contractOf(ordersManifestWith(() => undefined));
    expect(digestOf(generic, "orders-owner")).not.toBe(digestOf(orders, "orders-owner"));
  });

  it.each([
    ["the seed command's arguments", (e2e: Parameters<Edit>[0]) => { seedOf(e2e).args = ["seed.mjs", "--fast"]; }],
    ["the seed command's program", (e2e: Parameters<Edit>[0]) => { seedOf(e2e).program = "bun"; }],
    ["the seed command's timeout", (e2e: Parameters<Edit>[0]) => { seedOf(e2e).timeoutMs = 31_000; }],
    ["the seed command's environment", (e2e: Parameters<Edit>[0]) => { seedOf(e2e).env = { SEED_MODE: "small" }; }],
    ["the seed command's working directory", (e2e: Parameters<Edit>[0]) => { seedOf(e2e).cwd = "tools"; }],
  ] as const)("changes every profile's digest when %s changes (the seed is part of the recipe they run under)", (_name, edit) => {
    const changed = edited(edit);
    for (const profile of generic.accountProfiles) expect(digestOf(changed, profile.profileId), profile.profileId).not.toBe(digestOf(generic, profile.profileId));
  });

  it("changes every profile's digest when the seed command is removed", () => {
    const removed = contractOf(ordersManifestWith((e2e) => { withGenericAccounts(e2e); delete (e2e.recipe as Record<string, unknown>).seed; }));
    for (const profile of generic.accountProfiles) expect(digestOf(removed, profile.profileId)).not.toBe(digestOf(generic, profile.profileId));
  });

  it.each([
    ["path", "/signin"], ["usernameTestId", "user"], ["passwordTestId", "pass"], ["submitTestId", "go"], ["successTestId", "welcome"],
  ] as const)("changes the digest of the profile whose login form %s changes, and no other profile's", (field, value) => {
    const changed = edited((e2e) => { loginOf(e2e, "orders-viewer")[field] = value; });
    expect(digestOf(changed, "orders-viewer")).not.toBe(digestOf(generic, "orders-viewer"));
    expect(digestOf(changed, "orders-owner")).toBe(digestOf(generic, "orders-owner"));
    expect(digestOf(changed, "synthetic")).toBe(digestOf(generic, "synthetic"));
  });

  it("is not moved by the order of keys in the login form or in the seed command", () => {
    const reordered = contractOf(ordersManifestWith((e2e) => {
      withGenericAccounts(e2e);
      const profile = e2e.accountProfiles[0] as unknown as { login: Record<string, string> };
      profile.login = Object.fromEntries(Object.entries(profile.login).reverse());
      const recipe = e2e.recipe as unknown as { seed: Record<string, unknown> };
      recipe.seed = Object.fromEntries(Object.entries(recipe.seed).reverse());
    }));
    expect(E2EApplicationProjectContractSchema.parse(reordered)).toBeDefined();
    for (const profile of generic.accountProfiles) expect(digestOf(reordered, profile.profileId)).toBe(digestOf(generic, profile.profileId));
  });
});

describe("the registry re-versions an account when its seed or login changes", () => {
  const T0 = Date.parse("2026-10-20T00:00:00.000Z");
  const entriesOf = (contract: typeof generic) => planSyntheticAccountWrites({ contract, applicationId: ORDERS_APPLICATION_ID, prior: [], now: T0 })
    .map((write): E2EAccountRegistryEntry => ({ definition: write.definition, latest: write.latest }));
  const initial = entriesOf(generic);

  it("writes nothing for the same contract registered again", () => {
    expect(planSyntheticAccountWrites({ contract: generic, applicationId: ORDERS_APPLICATION_ID, prior: initial, now: T0 + 86_400_000 })).toEqual([]);
  });

  it("writes revision 2 of every account when the seed command changes", () => {
    const changed = edited((e2e) => { seedOf(e2e).args = ["seed.mjs", "--v2"]; });
    const writes = planSyntheticAccountWrites({ contract: changed, applicationId: ORDERS_APPLICATION_ID, prior: initial, now: T0 + 86_400_000 });
    expect(writes.map((write) => [write.definition.profileId, write.definition.revision, write.previousRevision]).sort()).toEqual(
      generic.accountProfiles.map((profile) => [profile.profileId, 2, 1]).sort());
    for (const write of writes) expect(write.definition.contractDigest).toBe(digestOf(changed, write.definition.profileId));
  });

  it("writes revision 2 of the one account whose login form changes", () => {
    const changed = edited((e2e) => { loginOf(e2e, "orders-owner").successTestId = "welcome"; });
    const writes = planSyntheticAccountWrites({ contract: changed, applicationId: ORDERS_APPLICATION_ID, prior: initial, now: T0 + 86_400_000 });
    expect(writes.map((write) => [write.definition.profileId, write.definition.revision])).toEqual([["orders-owner", 2]]);
    const before = initial.find((entry) => entry.definition.profileId === "orders-owner")!.definition;
    expect(writes[0]!.definition.contractDigest).not.toBe(before.contractDigest);
  });

  it("gives the account revisions of a login-bearing profile the same shape as any other: no credential, no connection", () => {
    const definition = createE2ESyntheticAccountDefinition({ contract: generic, applicationId: ORDERS_APPLICATION_ID, profileId: "orders-owner", revision: 1, now: T0 });
    expect(definition).toMatchObject({ authProfileId: "rovara-form-login/v1", seedProfileId: "rovara-accounts-file/v1", credentialHandleId: null, connectionRef: null });
    expect(shaCanonicalOf(definition)).toMatch(/^[a-f0-9]{64}$/);
  });
});
