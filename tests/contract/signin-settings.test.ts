import { describe, expect, it } from "vitest";
import {
  describeSignIn, readSignInSettings, readStoredDeveloperSignIn, signInParameterName, signInStackParameters, slackTeamIdParameterName,
  writeSignInSettings, writeSlackTeamId, type DeveloperSignInSettings,
} from "../../packages/cli/src/signin/settings.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const slackOnly: DeveloperSignInSettings = { schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: "arn:aws:iam::123456789012:user/alice" };
const both: DeveloperSignInSettings = {
  ...slackOnly,
  oidc: { issuer: "https://acme.okta.com", clientId: "0oa1", requiredClaim: "groups", requiredValues: ["engineering"], displayName: "Okta", clientSecretName: "agentx/staging/developer-oidc" },
};

describe("sign-in settings in SSM (FR-010, R7)", () => {
  it("round-trip at /agentx/<env>/signin and hold no secret value", async () => {
    const store = new MemoryParameterStore();
    await writeSignInSettings(store, both);
    expect(store.values.has(signInParameterName("staging"))).toBe(true);
    expect(signInParameterName("staging")).toBe("/agentx/staging/signin");
    expect(await readSignInSettings(store, "staging")).toEqual(both);
    expect(store.values.get("/agentx/staging/signin")).not.toMatch(/clientSecret"/);
  });

  it("refuse a setting with no method enabled, an http issuer, a secret name for another environment, or another environment's name", async () => {
    const store = new MemoryParameterStore();
    await expect(writeSignInSettings(store, { ...slackOnly, slack: false })).rejects.toThrow(/Slack sign-in, company sign-in, or both/);
    await expect(writeSignInSettings(store, { ...both, oidc: { ...both.oidc!, issuer: "http://acme.okta.com" } })).rejects.toThrow(/https/);
    await expect(writeSignInSettings(store, { ...both, oidc: { ...both.oidc!, clientSecretName: "agentx/prod/developer-oidc" } })).rejects.toThrow(/agentx\/staging\/developer-oidc/);
    store.values.set("/agentx/staging/signin", JSON.stringify({ ...slackOnly, env: "other" }));
    await expect(readSignInSettings(store, "staging")).rejects.toThrow(/names environment other/);
  });

  it("keep the team ID at FR-006's path, and read nothing when nothing is stored", async () => {
    const store = new MemoryParameterStore();
    expect(await readStoredDeveloperSignIn(store, "staging")).toBeUndefined();
    await writeSlackTeamId(store, "staging", "T0TEAM1");
    expect(store.values.get(slackTeamIdParameterName("staging"))).toBe("T0TEAM1");
    expect(slackTeamIdParameterName("staging")).toBe("/agentx/staging/slack/teamId");
    await expect(writeSlackTeamId(store, "staging", "not-a-team")).rejects.toThrow(/team ID/);
    expect(await readStoredDeveloperSignIn(store, "staging")).toEqual({ slackTeamId: "T0TEAM1" });
  });
});

describe("stack parameters from stored sign-in", () => {
  it("map every sign-in parameter, sign-in off for what is not enabled", () => {
    expect(signInStackParameters({ settings: both, slackTeamId: "T0TEAM1" })).toEqual({
      SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "enabled", DeveloperOidcIssuer: "https://acme.okta.com", DeveloperOidcClientId: "0oa1",
      DeveloperOidcRequiredClaim: "groups", DeveloperOidcRequiredValues: "[\"engineering\"]", DeveloperOidcDisplayName: "Okta",
    });
    expect(signInStackParameters({ slackTeamId: "T0TEAM1" })).toEqual({
      SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "disabled", DeveloperOidcIssuer: "", DeveloperOidcClientId: "",
      DeveloperOidcRequiredClaim: "", DeveloperOidcRequiredValues: "[]", DeveloperOidcDisplayName: "Company sign-in",
    });
  });

  it("describe the settings in plain words", () => {
    expect(describeSignIn(both)).toEqual(["Slack sign-in: on", "Company sign-in: on (Okta, https://acme.okta.com, client 0oa1, requires groups: engineering)"]);
    expect(describeSignIn(undefined)).toEqual(["Slack sign-in: off", "Company sign-in: off"]);
  });
});
