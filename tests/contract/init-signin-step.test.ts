// The developer-signin init step (spec 025 FR-044): the last agentx init step (R9 corrected by
// F15). Nothing here reaches AWS, Slack or an identity provider.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import type { InitContext } from "../../packages/cli/src/init/context.js";
import { unattendedPrompter, type Prompter } from "../../packages/cli/src/init/prompts.js";
import { developerSignInStep } from "../../packages/cli/src/init/signin-step.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { readSignInSettings } from "../../packages/cli/src/signin/settings.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "../support/fake-cloudformation.js";
import {
  T0, fakeSlackApi, initContext, memoryInitSecrets, progressHandle, scriptedPrompter, storeWithInitLock, TEST_BOT_TOKEN, TEST_SIGNING_SECRET,
} from "../support/init-fakes.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });
const CLIENT_SECRET = "fedcba9876543210fedcba9876543210";
const installed = { ...stagingSettings, controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", access: { artifactBucket: "b", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } };
const withScopes = fakeSlackApi({ authTest: async () => ({ ok: true, team_id: "T0TEAM", user_id: "U0BOT", bot_id: "B0BOT", scopes: ["channels:read", "groups:read", "im:write", "users:read", "users:read.email"] }) });

async function context(prompts: Array<string | boolean>, finalStatus?: string, overrides: Partial<Omit<InitContext, "secrets">> = {}, prompter: Prompter = scriptedPrompter(prompts)) {
  const cloudFormation = fakeCloudFormation({ parameters: SIGN_IN_PARAMETERS, ...(finalStatus === undefined ? {} : { finalStatus }) });
  const secrets = memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }) });
  // F13: InitContext.store is a ParameterStore, which has no `calls`; a MemoryParameterStore made
  // here (rather than read back off ctx.store) keeps its concrete type, so tests can inspect calls.
  const store = storeWithInitLock();
  const ctx = initContext({ prompter, secrets, cloudFormation, store, ...overrides });
  homes.push(ctx.home);
  await writeEnvironmentSettings(ctx.store, installed);
  const progress = progressHandle({ ...emptyProgress("staging", T0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" } });
  return { ctx, store, cloudFormation, progress };
}

describe("the developer-signin init step (FR-044)", () => {
  it("defaults to Slack, stores the client credentials, records the team and turns Slack sign-in on", async () => {
    const { ctx, cloudFormation, progress } = await context(["", "1111111111.2222222222222", CLIENT_SECRET, true]);
    expect(await developerSignInStep({ slack: withScopes }).run(ctx, progress)).toEqual({ status: "done", note: "developer sign-in: Slack" });
    expect(cloudFormation.parameters).toMatchObject({ DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM" });
    expect(await readSignInSettings(ctx.store, "staging")).toMatchObject({ slack: true });
    expect(ctx.lines).toContain("Developers sign in with: node /opt/agentx/dist/main.js login https://abc123.execute-api.us-east-1.amazonaws.com");
    expect(ctx.lines.join("\n")).not.toContain(CLIENT_SECRET);
  });

  it("holds the lock the step runner already holds, and never takes it again", async () => {
    const { ctx, store, progress } = await context(["", "1111111111.2222222222222", CLIENT_SECRET, true]);
    await developerSignInStep({ slack: withScopes }).run(ctx, progress);
    expect(store.calls.filter((call) => call.name.endsWith("/lock") && call.op !== "get")).toEqual([]);
  });

  it("refuses a bot token of another workspace than the install's", async () => {
    const { ctx, progress } = await context([""]);
    const otherTeam = fakeSlackApi({ authTest: async () => ({ ok: true, team_id: "T0OTHER", user_id: "U0BOT", bot_id: "B0BOT", scopes: [] }) });
    await expect(developerSignInStep({ slack: otherTeam }).run(ctx, progress)).rejects.toThrow("the stored bot token belongs to Slack workspace T0OTHER, but this install uses T0TEAM; nothing was saved");
  });

  it("puts the Slack secret back as it was when the stack update rolls back (Task 12 fix round 1)", async () => {
    const { ctx, progress } = await context(["", "1111111111.2222222222222", CLIENT_SECRET, true], "UPDATE_ROLLBACK_COMPLETE");
    const before = ctx.secrets.values.get("agentx/staging/slack");
    await expect(developerSignInStep({ slack: withScopes }).run(ctx, progress)).rejects.toThrow("the previous client credentials were put back in agentx/staging/slack");
    expect(ctx.secrets.values.get("agentx/staging/slack")).toBe(before);
    expect(await readSignInSettings(ctx.store, "staging")).toBeUndefined();
  });

  describe("--signin both (Task 13 review, fix round 1c)", () => {
    const ISSUER = "https://acme.okta.com";
    const OIDC_SECRET = "planted-company-client-secret";
    const discovery: typeof fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/keys` });
      throw new TypeError("fetch failed");
    };
    const both = {
      fetch: discovery,
      processEnv: { SLACK_SECRET: CLIENT_SECRET, OIDC_SECRET },
      signinFlags: { methods: "both" as const, slackClientId: "1111111111.2222222222222", oidcIssuer: ISSUER, oidcClientId: "0oa1", oidcRequiredClaim: "", oidcDisplayName: "Okta" },
      secretFlags: { slackClientSecret: { envName: "SLACK_SECRET" }, oidcClientSecret: { envName: "OIDC_SECRET" } },
    };

    it("stores both secrets and records both methods", async () => {
      const { ctx, cloudFormation, progress } = await context([true], undefined, both);
      expect(await developerSignInStep({ slack: withScopes }).run(ctx, progress)).toEqual({ status: "done", note: "developer sign-in: Slack and company sign-in" });
      expect(JSON.parse(ctx.secrets.values.get("agentx/staging/slack")!)).toMatchObject({ clientId: "1111111111.2222222222222", clientSecret: CLIENT_SECRET });
      expect(JSON.parse(ctx.secrets.values.get("agentx/staging/developer-oidc")!)).toEqual({ clientSecret: OIDC_SECRET });
      expect(await readSignInSettings(ctx.store, "staging")).toMatchObject({ slack: true, oidc: { issuer: ISSUER, clientId: "0oa1", displayName: "Okta" } });
      expect(cloudFormation.parameters).toMatchObject({ DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM", DeveloperOidcIssuer: ISSUER });
    });

    it("puts the Slack secret back, writes no settings and names the failure when the company secret cannot be stored", async () => {
      const { ctx, cloudFormation, progress } = await context([true], undefined, both);
      const before = ctx.secrets.values.get("agentx/staging/slack");
      ctx.secrets.create = async () => { throw Object.assign(new Error("User is not authorized to perform secretsmanager:CreateSecret"), { name: "AccessDeniedException" }); };
      await expect(developerSignInStep({ slack: withScopes }).run(ctx, progress)).rejects.toThrow("User is not authorized to perform secretsmanager:CreateSecret");
      expect(ctx.secrets.values.get("agentx/staging/slack")).toBe(before);
      expect(await readSignInSettings(ctx.store, "staging")).toBeUndefined();
      expect(cloudFormation.calls.map((call) => call.name)).not.toContain("ExecuteChangeSetCommand");
    });

    it("tries both restores, company first, even when one fails, and names the one that failed", async () => {
      const { ctx, progress } = await context([true], "UPDATE_ROLLBACK_COMPLETE", both);
      const put = ctx.secrets.put.bind(ctx.secrets);
      const order: string[] = [];
      let slackPuts = 0;
      ctx.secrets.put = async (name, value) => {
        if (name === "agentx/staging/slack" && ++slackPuts > 1) { order.push("slack restore"); throw new Error("Rate exceeded"); }
        await put(name, value);
      };
      const create = ctx.secrets.create.bind(ctx.secrets);
      ctx.secrets.create = async (name, value) => { await create(name, value); order.push("oidc create"); };
      const error = await developerSignInStep({ slack: withScopes }).run(ctx, progress).then(() => undefined, (caught: unknown) => caught);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("agentx/staging/developer-oidc did not exist before, so it stays, unused until company sign-in is on");
      expect(message).toContain("agentx/staging/slack: Rate exceeded");
      expect(message).toContain("run agentx init again");
      expect(order).toEqual(["oidc create", "slack restore"]);
    });
  });

  describe("under --yes (Task 13 review, fix round 1c)", () => {
    const ISSUER = "https://acme.okta.com";
    const discovery: typeof fetch = async () => Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/keys` });
    const oidcFlags = { methods: "oidc" as const, oidcIssuer: ISSUER, oidcClientId: "0oa1", oidcRequiredClaim: "groups", oidcRequiredValues: "engineering", oidcDisplayName: "Okta" };

    it("sets up company sign-in from its flags alone", async () => {
      const { ctx, progress } = await context([], undefined, { fetch: discovery, processEnv: { OIDC_SECRET: "s" }, signinFlags: oidcFlags, secretFlags: { oidcClientSecret: { envName: "OIDC_SECRET" } } }, unattendedPrompter());
      expect(await developerSignInStep({ slack: withScopes }).run(ctx, progress)).toEqual({ status: "done", note: "developer sign-in: company sign-in" });
      expect(await readSignInSettings(ctx.store, "staging")).toMatchObject({ slack: false, oidc: { issuer: ISSUER, requiredClaim: "groups", requiredValues: ["engineering"] } });
    });

    it("sets up both from their flags alone", async () => {
      const { ctx, progress } = await context([], undefined, {
        fetch: discovery, processEnv: { OIDC_SECRET: "s", SLACK_SECRET: CLIENT_SECRET },
        signinFlags: { ...oidcFlags, methods: "both", slackClientId: "1111111111.2222222222222" },
        secretFlags: { oidcClientSecret: { envName: "OIDC_SECRET" }, slackClientSecret: { envName: "SLACK_SECRET" } },
      }, unattendedPrompter());
      expect(await developerSignInStep({ slack: withScopes }).run(ctx, progress)).toEqual({ status: "done", note: "developer sign-in: Slack and company sign-in" });
    });

    it("names the flag to pass when one is missing", async () => {
      const withoutIssuer: Partial<typeof oidcFlags> = { ...oidcFlags };
      delete withoutIssuer.oidcIssuer;
      const { ctx, progress } = await context([], undefined, { fetch: discovery, signinFlags: withoutIssuer }, unattendedPrompter());
      await expect(developerSignInStep({ slack: withScopes }).run(ctx, progress)).rejects.toThrow("with --yes, pass --signin-oidc-issuer");
      const noSecret = await context([], undefined, { fetch: discovery, signinFlags: oidcFlags }, unattendedPrompter());
      await expect(developerSignInStep({ slack: withScopes }).run(noSecret.ctx, noSecret.progress)).rejects.toThrow("with --yes, pass --signin-oidc-client-secret-file <path> or --signin-oidc-client-secret-env <NAME>");
    });
  });

  it("is done at once when sign-in was already set up (a re-run after a crash)", async () => {
    const { ctx, cloudFormation, progress } = await context([]);
    await ctx.store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: "x" }));
    expect(await developerSignInStep({ slack: withScopes }).run(ctx, progress)).toEqual({ status: "done", note: "developer sign-in was already set up" });
    expect(cloudFormation.calls).toEqual([]);
  });
});
