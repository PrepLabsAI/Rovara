// DEC 254h: agentx signin enable|disable github. Only the GitHub OAuth app's client id passes through the CLI; the client secret is stored by the
// owner under agentx/<env>/developer-github and never read, written or printed here.
import { describe, expect, it } from "vitest";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { runSigninDisable, runSigninEnable, type SigninServices } from "../../packages/cli/src/signin/commands.js";
import { readSignInSettings, signInStackParameters, writeSignInSettings, writeSlackTeamId } from "../../packages/cli/src/signin/settings.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "../support/fake-cloudformation.js";
import { HOLDER, T0, fakeSlackApi, memoryInitSecrets, scriptedPrompter, TEST_BOT_TOKEN, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { withDeclaredSignIn } from "../../packages/cli/src/deploy/deploy-environment.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const OIDC_SECRET = "planted-company-client-secret";
const installed = { ...stagingSettings, access: { artifactBucket: "b", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } };
const discovery = (issuer: string): typeof fetch => async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys` });
  throw new TypeError("fetch failed");
};
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

const GITHUB_PARAMETERS = { ...SIGN_IN_PARAMETERS, DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM", DeveloperSignInGithub: "disabled", DeveloperGithubClientId: "", DeveloperGithubSince: "0" };

describe("agentx signin enable github (DEC 254h)", () => {
  it("sets the client id and turns GitHub on, keeping Slack, with no secret asked for or stored", async () => {
    const h = await services([true], {}, GITHUB_PARAMETERS);
    await writeSignInSettings(h.store, slackOn);
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    expect(await runSigninEnable(h.s, "staging", "github", { githubClientId: "Ov23liAbCdEf0123" }, {}, false)).toEqual({ changed: true });
    expect(h.cloudFormation.parameters).toMatchObject({ DeveloperSignInGithub: "enabled", DeveloperGithubClientId: "Ov23liAbCdEf0123", DeveloperGithubSince: String(Math.floor(T0 / 1000) - 60), DeveloperSignInSlack: "enabled" });
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ slack: true, github: { clientId: "Ov23liAbCdEf0123", clientSecretName: "agentx/staging/developer-github" } });
    expect(h.secrets.values.has("agentx/staging/developer-github")).toBe(false);
    expect(h.prompter.asked).toEqual(["Apply this change?"]);
    const printed = h.lines.join("\n");
    expect(printed).toContain("GitHub sign-in: off -> on (client Ov23liAbCdEf0123; secret agentx/staging/developer-github)");
    expect(printed).not.toContain("COMPANY_SIGNIN");
  });

  it("refuses a missing or malformed client id before anything changes", async () => {
    for (const flags of [{}, { githubClientId: "" }, { githubClientId: "bad id<script>" }, { githubClientId: "x".repeat(65) }]) {
      const h = await services([], {}, GITHUB_PARAMETERS);
      await writeSignInSettings(h.store, slackOn);
      await expect(runSigninEnable(h.s, "staging", "github", flags, {}, true)).rejects.toThrow("GitHub sign-in needs --signin-github-client-id <the GitHub OAuth app's Client ID>");
      expect(h.cloudFormation.calls).toEqual([]);
    }
  });

  it("a Slack or company sign-in change keeps GitHub as it is, and never sends GitHub's parameters before GitHub was ever on", async () => {
    expect(Object.keys(signInStackParameters({ settings: slackOn }))).not.toContain("DeveloperSignInGithub");
    const h = await services([true], {}, GITHUB_PARAMETERS);
    await writeSignInSettings(h.store, { ...slackOn, github: { clientId: "Ov23liAbCdEf0123", clientSecretName: "agentx/staging/developer-github" }, since: { github: 1_700_000_000 } });
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    await runSigninDisable(h.s, "staging", "slack", false);
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ slack: false, github: { clientId: "Ov23liAbCdEf0123" }, since: { github: 1_700_000_000 } });
  });

  it("disable github turns it off (its sessions end), keeps its cutoff, and refuses when it is not on or is the last method", async () => {
    const h = await services([true], {}, { ...GITHUB_PARAMETERS, DeveloperSignInGithub: "enabled", DeveloperGithubClientId: "Ov23liAbCdEf0123" });
    await writeSignInSettings(h.store, { ...slackOn, github: { clientId: "Ov23liAbCdEf0123", clientSecretName: "agentx/staging/developer-github" }, since: { github: 1_700_000_000 } });
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    expect(await runSigninDisable(h.s, "staging", "github", false)).toEqual({ changed: true });
    expect(h.cloudFormation.parameters).toMatchObject({ DeveloperSignInGithub: "disabled", DeveloperGithubSince: "1700000000" });
    expect(h.lines.join("\n")).toContain("Everyone signed in with GitHub is signed out as soon as the update finishes");
    await expect(runSigninDisable(h.s, "staging", "github", true)).rejects.toThrow("GitHub sign-in is not on, so there is nothing to disable");
    const last = await services([], {}, GITHUB_PARAMETERS);
    await writeSignInSettings(last.store, { schemaVersion: 1, env: "staging", slack: false, github: { clientId: "Ov23liAbCdEf0123", clientSecretName: "agentx/staging/developer-github" }, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER });
    await expect(runSigninDisable(last.s, "staging", "github", true)).rejects.toThrow("GitHub sign-in is the only method enabled");
  });

  it("the settings refuse a GitHub secret name for another environment", async () => {
    const h = await services([]);
    await expect(writeSignInSettings(h.store, { ...slackOn, github: { clientId: "Ov23liAbCdEf0123", clientSecretName: "agentx/prod/developer-github" } })).rejects.toThrow("must be agentx/staging/developer-github");
  });

  it("is reachable as agentx signin enable github --signin-github-client-id <id>", async () => {
    const h = await services([], {}, GITHUB_PARAMETERS);
    await writeSignInSettings(h.store, slackOn);
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await executeCli(["--env", "staging", "signin", "enable", "github", "--signin-github-client-id", "Ov23liAbCdEf0123", "--yes"],
      { stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: (text: string) => stderr.push(text) }, signin: h.s });
    expect(stderr.join("")).toBe("");
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("Developer sign-in updated.\n");
    expect(h.cloudFormation.parameters.DeveloperSignInGithub).toBe("enabled");
  });

  it("a deploy to a template without GitHub's parameters drops them, and enabling GitHub on such a stack says to upgrade first", async () => {
    const declared = new Set(["SlackTeamId", "DeveloperSignInSlack"]);
    expect(withDeclaredSignIn({ SlackTeamId: "T0TEAM", DeveloperSignInGithub: "enabled", DeveloperGithubClientId: "x", DeveloperGithubSince: "1", Other: "kept" }, declared))
      .toEqual({ SlackTeamId: "T0TEAM", Other: "kept" });
    const h = await services([true], {}, { ...SIGN_IN_PARAMETERS, DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM" });
    await writeSignInSettings(h.store, slackOn);
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    await expect(runSigninEnable(h.s, "staging", "github", { githubClientId: "Ov23liAbCdEf0123" }, {}, true)).rejects.toThrow("was deployed from an older AgentX release");
    expect(await readSignInSettings(h.store, "staging")).not.toHaveProperty("github");
  });
});
