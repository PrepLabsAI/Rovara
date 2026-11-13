// The trackers `rovara up` registers: only the ones the owner has signed in to, each sign-in read through the secrets socket when it is used (never kept), and the Jira site checked before a token can go to it.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, PluginConfigSchema, SecretValue, type SecretRef, type SecretStore } from "@rovara-code/contracts";
import { createLocalTrackers } from "../../packages/core/src/local/trackers.js";

// Built at run time: a fixture must not look like a real key.
const LINEAR = ["lin", "api", "fixture"].join("_");
const JIRA = ["jira", "fixture", "token"].join("-");

function secrets(known: Record<string, string>): SecretStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(_company: string, ref: SecretRef) {
      const name = "env" in ref ? `env:${ref.env}` : "key" in ref ? `key:${ref.key}` : "other";
      reads.push(name);
      return known[name] === undefined ? undefined : new SecretValue(known[name]);
    },
  };
}
const kinds = async (store: SecretStore, environment: NodeJS.ProcessEnv = {}) => (await createLocalTrackers({ environment, secrets: store, companyId: IMPLICIT_COMPANY_ID })).map((tracker) => tracker.kind);

describe("the trackers a laptop signs in to", () => {
  it("registers none without a sign-in, Linear for a key (the environment, then the key file), and Jira only with a site, an email and a token", async () => {
    expect(await kinds(secrets({}))).toEqual([]);
    expect(await kinds(secrets({ "env:LINEAR_API_KEY": LINEAR }))).toEqual(["linear"]);
    expect(await kinds(secrets({ "key:linear": LINEAR }))).toEqual(["linear"]);
    const site = { JIRA_SITE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "owner@example.test" };
    expect(await kinds(secrets({ "env:JIRA_API_TOKEN": JIRA }), site)).toEqual(["jira"]);
    expect(await kinds(secrets({ "env:JIRA_API_TOKEN": JIRA }), { JIRA_EMAIL: "owner@example.test" })).toEqual([]);
    expect(await kinds(secrets({ "env:JIRA_API_TOKEN": JIRA }), { ...site, JIRA_EMAIL: "" })).toEqual([]);
    expect(await kinds(secrets({ "env:JIRA_API_TOKEN": JIRA, "env:LINEAR_API_KEY": LINEAR }), site)).toEqual(["linear", "jira"]);
  });

  it("never sends a token to an address that is not an Atlassian site: no Jira is registered for it", async () => {
    for (const site of ["https://evil.example.test", "http://acme.atlassian.net", "https://acme.atlassian.net.evil.test"]) {
      expect(await kinds(secrets({ "env:JIRA_API_TOKEN": JIRA }), { JIRA_SITE_URL: site, JIRA_EMAIL: "owner@example.test" })).toEqual([]);
    }
  });

  it("reads a secrets adapter that fails as no sign-in, and its words are not passed on", async () => {
    const failing = { async read() { throw new Error(`the vault said ${LINEAR}`); } } as unknown as SecretStore;
    expect(await kinds(failing)).toEqual([]);
  });
});

describe("the config's linked accounts", () => {
  const base = { version: 1, plugins: [] };
  it("takes the neutral outside-account shape and nothing else", () => {
    expect(PluginConfigSchema.safeParse({ ...base, linkedAccounts: [{ provider: "linear", tenant: "", accountId: "u1" }, { provider: "jira", tenant: "acme.atlassian.net", accountId: "712020:abc" }] }).success).toBe(true);
    for (const bad of [{ provider: "linear", accountId: "u1" }, { provider: "Linear", tenant: "", accountId: "u1" }, { provider: "linear", tenant: "", accountId: "" }, { provider: "linear", tenant: "", accountId: "u1", email: "a@b.test" }]) {
      expect(PluginConfigSchema.safeParse({ ...base, linkedAccounts: [bad] }).success).toBe(false);
    }
    expect(PluginConfigSchema.safeParse({ ...base, linkedAccounts: Array.from({ length: 51 }, (_, index) => ({ provider: "linear", tenant: "", accountId: `u${String(index)}` })) }).success).toBe(false);
  });
});
