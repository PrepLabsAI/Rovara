import { describe, expect, it } from "vitest";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { changeLine } from "../../packages/cli/src/signin/apply.js";
import { checkSlackClientId, slackClientIdProblem } from "../../packages/cli/src/signin/collect.js";
import { runSigninDisable, runSigninEnable, runSigninShow, type SigninServices } from "../../packages/cli/src/signin/commands.js";
import { readSignInSettings, writeSignInSettings, writeSlackTeamId } from "../../packages/cli/src/signin/settings.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "../support/fake-cloudformation.js";
import { HOLDER, T0, fakeSlackApi, memoryInitSecrets, scriptedPrompter, TEST_BOT_TOKEN, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const SLACK_CLIENT_SECRET = "fedcba9876543210fedcba9876543210";
const OIDC_SECRET = "planted-company-client-secret";
const installed = { ...stagingSettings, access: { artifactBucket: "b", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } };
const discovery = (issuer: string): typeof fetch => async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys` });
  throw new TypeError("fetch failed");
};
const REPLACE = { slackClientId: "1111111111.2222222222222" };
const slackOn = { schemaVersion: 1 as const, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER };

async function services(prompts: Array<string | boolean>, overrides: Partial<SigninServices> = {}, parameters: Record<string, string> = SIGN_IN_PARAMETERS, stack: { finalStatus?: string; slackSecret?: Record<string, string> } = {}) {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, installed);
  const secrets = memoryInitSecrets({ "agentx/staging/slack": JSON.stringify(stack.slackSecret ?? { signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }) });
  const cloudFormation = fakeCloudFormation({ parameters, ...(stack.finalStatus === undefined ? {} : { finalStatus: stack.finalStatus }) });
  const prompter = scriptedPrompter(prompts);
  const lines: string[] = [];
  const s: SigninServices = {
    store, secrets, cloudFormation, identity: { get: async () => ({ account: "123456789012", arn: HOLDER }) },
    fetch: discovery("https://acme.okta.com"),
    slackApi: fakeSlackApi({ authTest: async () => ({ ok: true, team_id: "T0TEAM", user_id: "U0BOT", bot_id: "B0BOT", scopes: ["app_mentions:read", "channels:read", "groups:read", "im:write", "users:read", "users:read.email"] }) }),
    prompter, processEnv: { OIDC_SECRET }, write: (line) => lines.push(line), now: () => T0, sleep: async () => undefined, pollMs: 1,
    ...overrides,
  };
  return { s, store, secrets, cloudFormation, lines, prompter };
}

describe("the sign-in change line", () => {
  it("shows a changed line as before -> after, and an unchanged line as it is", () => {
    expect(changeLine("Slack sign-in: off", "Slack sign-in: on")).toBe("  Slack sign-in: off -> on");
    expect(changeLine("Company sign-in: on (Okta, https://acme.okta.com, client 0oa1)", "Company sign-in: off")).toBe("  Company sign-in: on -> off");
    expect(changeLine("Slack sign-in: on", "Slack sign-in: on")).toBe("  Slack sign-in: on");
  });
});

describe("agentx signin enable slack (FR-045)", () => {
  it("stores the client credentials in the Slack secret, records the team ID, shows the change, updates the stack and writes the settings", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true]);
    expect(await runSigninEnable(h.s, "staging", "slack", {}, {}, false)).toEqual({ changed: true });
    expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).toEqual({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "1111111111.2222222222222", clientSecret: SLACK_CLIENT_SECRET });
    expect(h.store.values.get("/agentx/staging/slack/teamId")).toBe("T0TEAM");
    expect(h.cloudFormation.parameters).toMatchObject({ SlackTeamId: "T0TEAM", DeveloperSignInSlack: "enabled" });
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ slack: true, updatedBy: HOLDER });
    const printed = h.lines.join("\n");
    expect(printed).toContain("Slack sign-in: off -> on");
    expect(printed).toContain("https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/callback/slack");
    for (const secret of [SLACK_CLIENT_SECRET, TEST_BOT_TOKEN, TEST_SIGNING_SECRET]) {
      expect(printed).not.toContain(secret);
      expect([...h.store.values.values()].join("\n")).not.toContain(secret);
    }
    expect(h.store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("asks \"Apply this change?\" once, and does not print it as well (F30)", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true]);
    await runSigninEnable(h.s, "staging", "slack", {}, {}, false);
    expect(h.prompter.asked.filter((question) => question === "Apply this change?")).toHaveLength(1);
    expect(h.lines.join("\n")).not.toContain("Apply this change?");
  });

  it("refuses, storing nothing, when the Slack app lacks the sign-in bot scopes", async () => {
    const h = await services([], { slackApi: fakeSlackApi({ authTest: async () => ({ ok: true, team_id: "T0TEAM", user_id: "U0BOT", bot_id: "B0BOT", scopes: ["app_mentions:read", "users:read"] }) }) });
    await expect(runSigninEnable(h.s, "staging", "slack", {}, {}, false)).rejects.toThrow("the Slack app is missing the bot scopes channels:read, groups:read, im:write, users:read.email; add them on the app's OAuth & Permissions page, reinstall the app, then run this again");
    expect(h.cloudFormation.calls).toEqual([]);
    expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).not.toHaveProperty("clientId");
  });

  it("changes nothing, not even the Slack secret, when the change is declined (F21)", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, false]);
    await expect(runSigninEnable(h.s, "staging", "slack", {}, {}, false)).rejects.toThrow(/not applied; nothing changed/);
    expect(h.cloudFormation.parameters.DeveloperSignInSlack).toBe("disabled");
    expect(await readSignInSettings(h.store, "staging")).toBeUndefined();
    expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).toEqual({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });
    expect(h.store.values.has("/agentx/staging/slack/teamId")).toBe(false);
  });

  it("leaves the stack and settings alone, and removes the change set, when storing the credentials fails", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true]);
    h.secrets.put = async () => { throw Object.assign(new Error("User is not authorized to perform secretsmanager:PutSecretValue"), { name: "AccessDeniedException" }); };
    await expect(runSigninEnable(h.s, "staging", "slack", {}, {}, false)).rejects.toThrow("User is not authorized to perform secretsmanager:PutSecretValue");
    expect(h.cloudFormation.calls.map((call) => call.name)).toContain("DeleteChangeSetCommand");
    expect(h.cloudFormation.calls.map((call) => call.name)).not.toContain("ExecuteChangeSetCommand");
    expect(await readSignInSettings(h.store, "staging")).toBeUndefined();
    expect(h.store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("puts the previous client credentials back when the stack update rolls back (fix round 1, I1)", async () => {
    const OLD_SECRET = "00000000000000000000000000000000";
    const before = { signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "9999.8888", clientSecret: OLD_SECRET };
    const h = await services([SLACK_CLIENT_SECRET, true], {}, SIGN_IN_PARAMETERS, { finalStatus: "UPDATE_ROLLBACK_COMPLETE", slackSecret: before });
    // Replacing stored credentials takes --slack-client-id; without it the stored ones are reused.
    const error = await runSigninEnable(h.s, "staging", "slack", REPLACE, {}, false).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("ended in UPDATE_ROLLBACK_COMPLETE");
    expect(message).toContain("the previous client credentials were put back in agentx/staging/slack");
    expect(message).not.toContain(SLACK_CLIENT_SECRET);
    expect(message).not.toContain(OLD_SECRET);
    expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).toEqual(before);
    expect(await readSignInSettings(h.store, "staging")).toBeUndefined();
  });

  it("keeps the new credentials, and says the update is still running, when the update times out (fix round 1 ruling)", async () => {
    const OLD_SECRET = "00000000000000000000000000000000";
    const before = { signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "9999.8888", clientSecret: OLD_SECRET };
    // Each clock read moves on 10 minutes, so the 30-minute wait runs out while the stack is still updating.
    let clock = T0;
    const h = await services([SLACK_CLIENT_SECRET, true], { now: () => (clock += 10 * 60_000) }, SIGN_IN_PARAMETERS, { finalStatus: "UPDATE_IN_PROGRESS", slackSecret: before });
    const error = await runSigninEnable(h.s, "staging", "slack", REPLACE, {}, false).then(() => undefined, (caught: unknown) => caught);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("the update of agentx-staging-control-plane is still running");
    expect(message).toContain("the new client credentials are kept in agentx/staging/slack");
    expect(message).toContain("check the stack's status in the CloudFormation console, then run agentx signin enable slack again");
    expect(message).not.toContain("put back");
    expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).toMatchObject({ clientId: "1111111111.2222222222222", clientSecret: SLACK_CLIENT_SECRET });
  });

  describe("after a failed update, restores only on an allow-listed failure (fix round 2)", () => {
    const OLD = { signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "9999.8888", clientSecret: "00000000000000000000000000000000" };
    const NEW = { clientId: "1111111111.2222222222222", clientSecret: SLACK_CLIENT_SECRET };
    // These replace the stored credentials, which takes --slack-client-id.
    const PROMPTS = [SLACK_CLIENT_SECRET, true];
    const failure = (promise: Promise<unknown>) => promise.then(() => "", (caught: unknown) => (caught instanceof Error ? caught.message : ""));
    /** Wraps the fake so a test can fail one call; `executed` turns true once ExecuteChangeSet was sent. */
    function intercept(h: Awaited<ReturnType<typeof services>>, fail: (name: string, executed: boolean) => Error | undefined) {
      let executed = false;
      h.s.cloudFormation = {
        send: async (command: unknown) => {
          const name = (command as { constructor: { name: string } }).constructor.name;
          const error = fail(name, executed);
          if (error !== undefined) throw error;
          if (name === "ExecuteChangeSetCommand") executed = true;
          return h.cloudFormation.send(command as Parameters<typeof h.cloudFormation.send>[0]);
        },
      };
    }

    it("keeps the new credentials on UPDATE_ROLLBACK_FAILED, naming the status", async () => {
      const h = await services(PROMPTS, {}, SIGN_IN_PARAMETERS, { finalStatus: "UPDATE_ROLLBACK_FAILED", slackSecret: OLD });
      const message = await failure(runSigninEnable(h.s, "staging", "slack", REPLACE, {}, false));
      expect(message).toContain("agentx-staging-control-plane is UPDATE_ROLLBACK_FAILED, so the new client credentials are kept in agentx/staging/slack; check the stack in the CloudFormation console, then run agentx signin enable slack again");
      expect(message).not.toContain("sign-in did not change");
      expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).toMatchObject(NEW);
    });

    it("says the state could not be confirmed, and keeps the credentials, when the stack cannot be read afterwards", async () => {
      const h = await services(PROMPTS, {}, SIGN_IN_PARAMETERS, { finalStatus: "UPDATE_ROLLBACK_COMPLETE", slackSecret: OLD });
      let readsAfterExecute = 0;
      intercept(h, (name, executed) => (name === "DescribeStacksCommand" && executed && ++readsAfterExecute > 1 ? Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }) : undefined));
      const message = await failure(runSigninEnable(h.s, "staging", "slack", REPLACE, {}, false));
      expect(message).toContain("the state of agentx-staging-control-plane could not be confirmed (Rate exceeded); the new client credentials are kept in agentx/staging/slack; check the stack's status in the CloudFormation console, then run agentx signin enable slack again");
      expect(message).not.toContain("sign-in did not change");
      expect(message).not.toContain("still running");
      expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).toMatchObject(NEW);
    });

    it("keeps the credentials, and says to record the settings, when the stack did take the change", async () => {
      const h = await services(PROMPTS, {}, SIGN_IN_PARAMETERS, { slackSecret: OLD });
      // The change set executes (and the fake applies it), then polling it fails.
      intercept(h, (name, executed) => (name === "DescribeChangeSetCommand" && executed ? Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }) : undefined));
      const message = await failure(runSigninEnable(h.s, "staging", "slack", REPLACE, {}, false));
      expect(message).toContain("Rate exceeded; agentx-staging-control-plane did take the change, so the new client credentials are kept in agentx/staging/slack; run agentx signin enable slack again to record the settings");
      expect(h.cloudFormation.parameters.DeveloperSignInSlack).toBe("enabled");
      expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).toMatchObject(NEW);
      expect(await readSignInSettings(h.store, "staging")).toBeUndefined();
    });

    it("puts the previous credentials back when the change set never executed", async () => {
      const h = await services(PROMPTS, {}, SIGN_IN_PARAMETERS, { slackSecret: OLD });
      intercept(h, (name) => (name === "ExecuteChangeSetCommand" ? Object.assign(new Error("Access denied"), { name: "AccessDeniedException" }) : undefined));
      const message = await failure(runSigninEnable(h.s, "staging", "slack", REPLACE, {}, false));
      expect(message).toContain("Access denied; the previous client credentials were put back in agentx/staging/slack");
      expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).toEqual(OLD);
    });
  });

  it("says the credentials were replaced, not that the stack was updated, when only they changed and the settings write fails (fix round 2)", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true], {}, { ...SIGN_IN_PARAMETERS, DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM" });
    await writeSignInSettings(h.store, slackOn);
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    const put = h.store.put.bind(h.store);
    h.store.put = async (name, value, options) => {
      if (name === "/agentx/staging/signin") throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
      await put(name, value, options);
    };
    await expect(runSigninEnable(h.s, "staging", "slack", {}, {}, false))
      .rejects.toThrow("the client credentials in agentx/staging/slack were replaced (agentx-staging-control-plane already matched), but recording the sign-in settings at /agentx/staging/signin failed (Rate exceeded); run agentx signin enable slack again to record them");
  });

  it("says so, and never that sign-in did not change, when the previous credentials cannot be put back", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true], {}, SIGN_IN_PARAMETERS, { finalStatus: "UPDATE_ROLLBACK_COMPLETE" });
    const put = h.secrets.put.bind(h.secrets);
    let puts = 0;
    h.secrets.put = async (name, value) => {
      puts += 1;
      if (puts > 1) throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
      await put(name, value);
    };
    const error = await runSigninEnable(h.s, "staging", "slack", {}, {}, false).then(() => undefined, (caught: unknown) => caught);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("putting the previous client credentials back in agentx/staging/slack failed too (Rate exceeded)");
    expect(message).toContain("run agentx signin enable slack again");
    expect(message).not.toContain("sign-in did not change");
  });

  it("writes the settings only once the stack has changed, and says how to record them when that write fails (fix round 1, minor 4)", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true]);
    const put = h.store.put.bind(h.store);
    h.store.put = async (name, value, options) => {
      if (name === "/agentx/staging/signin") throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
      await put(name, value, options);
    };
    await expect(runSigninEnable(h.s, "staging", "slack", {}, {}, false))
      .rejects.toThrow("agentx-staging-control-plane was updated, but recording the sign-in settings at /agentx/staging/signin failed (Rate exceeded); run agentx signin enable slack again to record them");
    expect(h.cloudFormation.parameters.DeveloperSignInSlack).toBe("enabled");
  });

  it("builds the change from the settings read under the lock (fix round 1, minor 3)", async () => {
    const oidcOn = { ...slackOn, slack: false, oidc: { issuer: "https://acme.okta.com", clientId: "0oa1", displayName: "Okta", clientSecretName: "agentx/staging/developer-oidc" } };
    const h = await services([true]);
    // Another operator turns company sign-in on while this command asks its questions.
    h.s.prompter.secret = async () => { await writeSignInSettings(h.store, oidcOn); return SLACK_CLIENT_SECRET; };
    await runSigninEnable(h.s, "staging", "slack", { slackClientId: "1111111111.2222222222222" }, {}, false);
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ slack: true, oidc: { issuer: "https://acme.okta.com" } });
  });

  it("stores new client credentials after asking, even when the stack parameters stay the same", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true], {}, { ...SIGN_IN_PARAMETERS, DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM" });
    await writeSignInSettings(h.store, slackOn);
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    expect(await runSigninEnable(h.s, "staging", "slack", {}, {}, false)).toEqual({ changed: true });
    expect(h.prompter.asked.filter((question) => question === "Apply this change?")).toHaveLength(1);
    expect(h.cloudFormation.calls.map((call) => call.name)).toEqual(["DescribeStacksCommand"]);
    expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).toMatchObject({ clientId: "1111111111.2222222222222", clientSecret: SLACK_CLIENT_SECRET });
    expect(h.lines.join("\n")).toContain("the new client credentials replace the stored ones");
  });

  it("says new client credentials take effect within 5 minutes when only they changed", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true], {}, { ...SIGN_IN_PARAMETERS, DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM", DeveloperSignInSlackSince: "1700000000" });
    await writeSignInSettings(h.store, { ...slackOn, since: { slack: 1700000000 } });
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    await runSigninEnable(h.s, "staging", "slack", {}, {}, false);
    expect(h.lines).toContain("The new client credentials take effect within 5 minutes, once the control plane's cached copy expires.");
    // A change that updates the stack restarts the functions, so the credentials apply at once and no delay is claimed.
    const fresh = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true]);
    await runSigninEnable(fresh.s, "staging", "slack", {}, {}, false);
    expect(fresh.lines.join("\n")).not.toContain("within 5 minutes");
  });

  describe("stored Slack client credentials on a re-enable", () => {
    const STORED = { signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "9999.8888", clientSecret: "abcdef0123456789abcdef0123456789" };
    const REUSE = "Using the Slack client credentials already stored in agentx/staging/slack; pass --slack-client-id to replace them.";

    it("reuses them without asking, and never prints them", async () => {
      const h = await services([true], {}, SIGN_IN_PARAMETERS, { slackSecret: STORED });
      expect(await runSigninEnable(h.s, "staging", "slack", {}, {}, false)).toEqual({ changed: true });
      expect(h.prompter.asked).toEqual(["Apply this change?"]);
      expect(h.lines).toContain(REUSE);
      expect(h.cloudFormation.parameters).toMatchObject({ DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM" });
      expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).toEqual(STORED);
      const printed = h.lines.join("\n");
      for (const value of [STORED.clientId, STORED.clientSecret, TEST_BOT_TOKEN]) expect(printed).not.toContain(value);
    });

    it("reuses them under --yes with nothing to answer", async () => {
      const h = await services([], {}, SIGN_IN_PARAMETERS, { slackSecret: STORED });
      expect(await runSigninEnable(h.s, "staging", "slack", {}, {}, true)).toEqual({ changed: true });
      expect(h.prompter.asked).toEqual([]);
      expect(h.lines).toContain(REUSE);
    });

    it("asks again when --slack-client-id is given, or when only one of the two is stored", async () => {
      const replace = await services([SLACK_CLIENT_SECRET, true], {}, SIGN_IN_PARAMETERS, { slackSecret: STORED });
      await runSigninEnable(replace.s, "staging", "slack", { slackClientId: "1111111111.2222222222222" }, {}, false);
      expect(replace.lines).not.toContain(REUSE);
      expect(JSON.parse(replace.secrets.values.get("agentx/staging/slack")!)).toMatchObject({ clientId: "1111111111.2222222222222", clientSecret: SLACK_CLIENT_SECRET });
      const idOnly = { signingSecret: STORED.signingSecret, botToken: STORED.botToken, clientId: STORED.clientId };
      const half = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true], {}, SIGN_IN_PARAMETERS, { slackSecret: idOnly });
      await runSigninEnable(half.s, "staging", "slack", {}, {}, false);
      expect(half.lines).not.toContain(REUSE);
    });
  });

  it("never reads a secret from a flag value", async () => {
    const h = await services([]);
    await expect(runSigninEnable(h.s, "staging", "slack", { slackClientId: "1111111111.2222222222222" }, { slackClientSecret: { envName: "MISSING" } }, true)).rejects.toThrow(/environment variable MISSING/);
  });

  it("refuses an environment that uses the legacy stack names", async () => {
    const h = await services([]);
    await writeEnvironmentSettings(h.store, { ...installed, env: "staging", naming: "legacy" });
    await expect(runSigninEnable(h.s, "staging", "slack", {}, {}, true)).rejects.toThrow(/installed with agentx init/);
  });
});

describe("agentx signin enable oidc (FR-004, FR-010, FR-045)", () => {
  it("checks the issuer's discovery document, stores the client secret, and keeps Slack as it was", async () => {
    const h = await services([true]);
    await writeSignInSettings(h.store, slackOn);
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    await runSigninEnable(h.s, "staging", "oidc", { oidcIssuer: "https://acme.okta.com", oidcClientId: "0oa1", oidcRequiredClaim: "groups", oidcRequiredValues: "engineering,platform", oidcDisplayName: "Okta" }, { oidcClientSecret: { envName: "OIDC_SECRET" } }, false);
    expect(JSON.parse(h.secrets.values.get("agentx/staging/developer-oidc")!)).toEqual({ clientSecret: OIDC_SECRET });
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ slack: true, oidc: { issuer: "https://acme.okta.com", clientId: "0oa1", requiredClaim: "groups", requiredValues: ["engineering", "platform"], displayName: "Okta", clientSecretName: "agentx/staging/developer-oidc" } });
    expect(h.cloudFormation.parameters).toMatchObject({ DeveloperOidcIssuer: "https://acme.okta.com", DeveloperOidcRequiredValues: "[\"engineering\",\"platform\"]", DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM" });
    expect(h.lines.join("\n")).toContain("Register this redirect URI with your identity provider: https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/callback/oidc");
    expect(h.lines.join("\n")).not.toContain(OIDC_SECRET);
  });

  it("prints the change under --yes too, and asks nothing", async () => {
    const h = await services([]);
    await writeSignInSettings(h.store, slackOn);
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    await runSigninEnable(h.s, "staging", "oidc", { oidcIssuer: "https://acme.okta.com", oidcClientId: "0oa1", oidcRequiredClaim: "", oidcDisplayName: "Okta" }, { oidcClientSecret: { envName: "OIDC_SECRET" } }, true);
    expect(h.prompter.asked).toEqual([]);
    const printed = h.lines.join("\n");
    expect(printed).toContain("  Company sign-in: off -> on (Okta, https://acme.okta.com, client 0oa1)");
    expect(printed).toContain("agentx-staging-control-plane will change: Modify DeveloperSignInFunction1A2B3C4D (AWS::Lambda::Function)");
  });

  it("refuses an issuer whose discovery document cannot be read, before storing anything", async () => {
    const h = await services([]);
    await expect(runSigninEnable(h.s, "staging", "oidc", { oidcIssuer: "https://down.example.test", oidcClientId: "c" }, { oidcClientSecret: { envName: "OIDC_SECRET" } }, true))
      .rejects.toThrow("could not read https://down.example.test/.well-known/openid-configuration; check the issuer URL and that this computer can reach it");
    expect(h.secrets.values.has("agentx/staging/developer-oidc")).toBe(false);
  });

  it("leaves a company client secret that did not exist before in place when the stack rolls back, and says it is unused", async () => {
    const h = await services([true], {}, SIGN_IN_PARAMETERS, { finalStatus: "UPDATE_ROLLBACK_COMPLETE" });
    await writeSignInSettings(h.store, slackOn);
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    await expect(runSigninEnable(h.s, "staging", "oidc", { oidcIssuer: "https://acme.okta.com", oidcClientId: "0oa1", oidcRequiredClaim: "", oidcDisplayName: "Okta" }, { oidcClientSecret: { envName: "OIDC_SECRET" } }, false))
      .rejects.toThrow("agentx/staging/developer-oidc did not exist before, so it stays, unused until company sign-in is on");
    expect(h.secrets.values.has("agentx/staging/developer-oidc")).toBe(true);
  });

  it("stores no company client secret when the change is declined (F21)", async () => {
    const h = await services([false]);
    await writeSignInSettings(h.store, slackOn);
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    await expect(runSigninEnable(h.s, "staging", "oidc", { oidcIssuer: "https://acme.okta.com", oidcClientId: "0oa1", oidcRequiredClaim: "", oidcDisplayName: "Okta" }, { oidcClientSecret: { envName: "OIDC_SECRET" } }, false))
      .rejects.toThrow(/not applied; nothing changed/);
    expect(h.secrets.values.has("agentx/staging/developer-oidc")).toBe(false);
  });
});

describe("each method's enabled-since cutoff (FR-045)", () => {
  // The cutoff is set a minute before now, so an admin clock running fast never refuses sessions
  // that start just after the enable.
  const T0_SECONDS = Math.floor(T0 / 1000) - 60;
  it("sets a method's cutoff to a minute before now when it goes from off to on, so sessions its disable ended stay ended", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true]);
    await writeSignInSettings(h.store, { ...slackOn, slack: false, oidc: { issuer: "https://acme.okta.com", clientId: "0oa1", displayName: "Okta", clientSecretName: "agentx/staging/developer-oidc" }, since: { slack: 1700000000, oidc: 1700000100 } });
    await runSigninEnable(h.s, "staging", "slack", {}, {}, false);
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ since: { slack: T0_SECONDS, oidc: 1700000100 } });
    expect(h.cloudFormation.parameters).toMatchObject({ DeveloperSignInSlack: "enabled", DeveloperSignInSlackSince: String(T0_SECONDS), DeveloperOidcSince: "1700000100" });
  });

  it("sets it on a first enable too", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true]);
    await runSigninEnable(h.s, "staging", "slack", {}, {}, false);
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ since: { slack: T0_SECONDS } });
    expect(h.cloudFormation.parameters).toMatchObject({ DeveloperSignInSlackSince: String(T0_SECONDS), DeveloperOidcSince: "0" });
  });

  it("keeps the cutoff when the method was already on", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true], {}, { ...SIGN_IN_PARAMETERS, DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM", DeveloperSignInSlackSince: "1700000000" });
    await writeSignInSettings(h.store, { ...slackOn, since: { slack: 1700000000 } });
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    await runSigninEnable(h.s, "staging", "slack", {}, {}, false);
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ since: { slack: 1700000000 } });
    expect(h.cloudFormation.parameters.DeveloperSignInSlackSince).toBe("1700000000");
  });

  it("keeps the cutoff when the method is turned off", async () => {
    const h = await services([true], {}, { ...SIGN_IN_PARAMETERS, DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM", DeveloperSignInSlackSince: "1700000000" });
    await writeSignInSettings(h.store, { ...slackOn, oidc: { issuer: "https://acme.okta.com", clientId: "0oa1", displayName: "Okta", clientSecretName: "agentx/staging/developer-oidc" }, since: { slack: 1700000000 } });
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    await runSigninDisable(h.s, "staging", "slack", false);
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ slack: false, since: { slack: 1700000000 } });
    expect(h.cloudFormation.parameters).toMatchObject({ DeveloperSignInSlack: "disabled", DeveloperSignInSlackSince: "1700000000" });
  });
});

describe("agentx signin disable and show", () => {
  it("disables a method, which revokes its sessions through the control plane (FR-045, R13)", async () => {
    const h = await services([true], {}, { ...SIGN_IN_PARAMETERS, DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM" });
    await writeSignInSettings(h.store, { ...slackOn, oidc: { issuer: "https://acme.okta.com", clientId: "0oa1", displayName: "Okta", clientSecretName: "agentx/staging/developer-oidc" } });
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    expect(await runSigninDisable(h.s, "staging", "slack", false)).toEqual({ changed: true });
    expect(h.cloudFormation.parameters.DeveloperSignInSlack).toBe("disabled");
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ slack: false });
    expect(h.lines.join("\n")).toContain("Everyone signed in with Slack is signed out as soon as the update finishes");
  });

  it("refuses to disable the last method (FR-010)", async () => {
    const h = await services([]);
    await writeSignInSettings(h.store, slackOn);
    await expect(runSigninDisable(h.s, "staging", "slack", true)).rejects.toThrow("Slack sign-in is the only method enabled; enable company sign-in first (agentx signin enable oidc), because at least one method must stay on");
  });

  it("shows the settings and what the control plane offers, never a secret", async () => {
    const h = await services([], {
      fetch: async () => Response.json({ env: "staging", apiVersion: "1.0", issuer: "i", authorizationEndpoint: "https://a/x", tokenEndpoint: "https://a/t", revocationEndpoint: "https://a/r", clientId: "agentx-cli", methods: { slack: true, oidc: null } }),
    });
    await writeSignInSettings(h.store, slackOn);
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    const shown = await runSigninShow(h.s, "staging");
    expect(shown.lines).toEqual([
      "Slack sign-in: on",
      "Company sign-in: off",
      "Slack team: T0TEAM",
      "The control plane offers: Slack",
      "Developers sign in with: npx @preplabs/rovara-code login https://abc.execute-api.us-east-1.amazonaws.com",
    ]);
  });
});

describe("the agentx signin command (F14)", () => {
  it("takes the same flag names as agentx init, and reads the company secret from --signin-oidc-client-secret-env", async () => {
    const h = await services([]);
    await writeSignInSettings(h.store, slackOn);
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await executeCli([
      "--env", "staging", "signin", "enable", "oidc", "--yes",
      "--signin-oidc-issuer", "https://acme.okta.com", "--signin-oidc-client-id", "0oa1", "--signin-oidc-client-secret-env", "OIDC_SECRET",
      "--signin-oidc-required-claim", "groups", "--signin-oidc-required-values", "engineering", "--signin-oidc-display-name", "Okta",
    ], { stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: (text: string) => stderr.push(text) }, signin: h.s });
    expect(stderr.join("")).toBe("");
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("Developer sign-in updated.\n");
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ oidc: { issuer: "https://acme.okta.com", clientId: "0oa1", requiredClaim: "groups", requiredValues: ["engineering"], displayName: "Okta" } });
    expect(JSON.parse(h.secrets.values.get("agentx/staging/developer-oidc")!)).toEqual({ clientSecret: OIDC_SECRET });
  });

  it("names a flag signin enable accepts when --yes leaves a question unanswered", async () => {
    const stderr: string[] = [];
    const h = await services([]);
    // Without a prompter override, --yes uses the CLI's own unattended prompter.
    const withoutPrompter: Partial<SigninServices> = { ...h.s };
    delete withoutPrompter.prompter;
    const code = await executeCli(["--env", "staging", "signin", "enable", "oidc", "--yes"], { stdout: { write: () => true }, stderr: { write: (text: string) => stderr.push(text) }, signin: withoutPrompter });
    expect(code).not.toBe(0);
    expect(stderr.join("")).toContain("with --yes, pass --signin-oidc-issuer");
  });
});

describe("the Slack Client ID question", () => {
  it("says a pasted 32-hex value looks like a secret, without repeating it", () => {
    const pasted = "abcdef0123456789abcdef0123456789";
    expect(slackClientIdProblem(pasted)).toBe("that looks like the client secret or signing secret; the Client ID is two numbers joined by a dot");
    expect(slackClientIdProblem("not-an-id")).toBe("two numbers joined by a dot");
    expect(slackClientIdProblem("1111111111.2222222222222")).toBeUndefined();
    const error = (() => { try { checkSlackClientId(pasted); } catch (caught) { return caught as Error; } return undefined; })();
    expect(error?.message).toContain("that looks like the client secret or signing secret");
    expect(error?.message).not.toContain(pasted);
  });
});
