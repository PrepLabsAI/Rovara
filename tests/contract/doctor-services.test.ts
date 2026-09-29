import { AgentXError } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { githubChecks } from "../../packages/cli/src/doctor/github.js";
import { secretChecks } from "../../packages/cli/src/doctor/secrets.js";
import { slackChecks } from "../../packages/cli/src/doctor/slack.js";
import { doctorContext, doctorServices, SECRETS, SIGNING_KEY } from "../support/doctor-fakes.js";
import { fakeGitHubApi, fakeSlackApi, memoryInitSecrets, T0, TEST_BOT_TOKEN, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { fakeSlackChannels } from "../support/setup-fakes.js";

const withSecrets = (values: Record<string, string>) => doctorContext({ services: doctorServices({ secrets: memoryInitSecrets(values) }) });
const text = (value: unknown) => JSON.stringify(value);

describe("doctor: secrets (FR-050)", () => {
  it("passes the three secrets every environment has", async () => {
    const checks = await secretChecks(doctorContext());
    expect(checks.map((entry) => [entry.name, entry.status])).toEqual([
      ["agentx/staging/callback-signing-key", "ok"], ["agentx/staging/slack", "ok"], ["agentx/staging/github-app", "ok"],
    ]);
  });

  it("fails a missing secret with a fix, and a malformed one without showing its value", async () => {
    const malformed = { ...SECRETS, "agentx/staging/slack": JSON.stringify({ botToken: "xoxp-PERSONALtoken", signingSecret: TEST_SIGNING_SECRET }) };
    delete (malformed as Record<string, string>)["agentx/staging/callback-signing-key"];
    const checks = await secretChecks(withSecrets(malformed));
    expect(checks.find((entry) => entry.name === "agentx/staging/callback-signing-key")).toMatchObject({ status: "fail", detail: "does not exist", fix: "run agentx --env staging upgrade: it makes a new key and redeploys the control plane with it" });
    const slack = checks.find((entry) => entry.name === "agentx/staging/slack")!;
    expect(slack.status).toBe("fail");
    expect(slack.detail).toBe("holds no bot token (xoxb-)");
    expect(text(checks)).not.toContain("PERSONALtoken");
  });

  it("checks the webhook alert address and the OpenRouter key only when the environment uses them", async () => {
    const context = doctorContext({
      answers: { ...doctorContext().answers!, alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/staging/alert-endpoint" } },
      settings: { ...doctorContext().settings, models: { ...doctorContext().settings.models, openRouter: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/openrouter-AbCdEf" } } },
      services: doctorServices({ secrets: memoryInitSecrets({ ...SECRETS, "agentx/staging/alert-endpoint": "http://not-https.example.com/SECRETkey" }) }),
    });
    const checks = await secretChecks(context);
    expect(checks.find((entry) => entry.name === "agentx/staging/alert-endpoint")?.status).toBe("fail");
    expect(checks.find((entry) => entry.name === "agentx/staging/openrouter")).toMatchObject({ status: "fail", detail: "does not exist" });
    expect(text(checks)).not.toContain("SECRETkey");
  });
});

describe("doctor: the OpenRouter secret (fix round 1)", () => {
  const withOpenRouter = (secretArn: string, secrets: Record<string, string> = SECRETS) => doctorContext({
    settings: { ...doctorContext().settings, models: { ...doctorContext().settings.models, openRouter: { secretArn } } },
    services: doctorServices({ secrets: memoryInitSecrets(secrets) }),
  });

  it("reports a present, non-empty key ok", async () => {
    const checks = await secretChecks(withOpenRouter("arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/openrouter-AbCdEf", { ...SECRETS, "agentx/staging/openrouter": "sk-or-SECRETvalue" }));
    expect(checks.find((entry) => entry.name === "agentx/staging/openrouter")).toMatchObject({ status: "ok" });
    expect(text(checks)).not.toContain("SECRETvalue");
  });

  it("skips, and says so, a key in a secret the operator made", async () => {
    const arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:team/openrouter-key-AbCdEf";
    const checks = await secretChecks(withOpenRouter(arn));
    expect(checks.find((entry) => entry.name === "OpenRouter key")).toEqual({ group: "secrets", name: "OpenRouter key", status: "skip", detail: `the OpenRouter key is in a secret you made yourself (${arn}), which doctor's role cannot read; check it yourself` });
    expect(checks.find((entry) => entry.name === "agentx/staging/openrouter")).toBeUndefined();
  });

  it("does not mistake agentx/<env>/openrouter-mine for the environment's own secret", async () => {
    const arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/openrouter-mine-AbCdEf";
    const checks = await secretChecks(withOpenRouter(arn));
    expect(checks.find((entry) => entry.name === "agentx/staging/openrouter")).toBeUndefined();
    expect(checks.find((entry) => entry.name === "OpenRouter key")?.status).toBe("skip");
  });
});

describe("doctor: Slack (FR-050)", () => {
  it("passes a working bot token, both URLs answering the signed probe, and the bot in the bound channel", async () => {
    const checks = await slackChecks(doctorContext());
    expect(checks.map((entry) => [entry.name, entry.status])).toEqual([["bot token", "ok"], ["request URLs", "ok"], ["#payments", "ok"]]);
    expect(text(checks)).not.toContain(TEST_BOT_TOKEN);
    expect(text(checks)).not.toContain(TEST_SIGNING_SECRET);
  });

  it("fails a revoked token with Slack's error code only, and skips the checks that need it", async () => {
    const context = doctorContext({ services: doctorServices({ slackApi: fakeSlackApi({ authTest: async () => ({ ok: false, error: "token_revoked" }) }) }) });
    const checks = await slackChecks(context);
    expect(checks[0]).toMatchObject({ name: "bot token", status: "fail", detail: "Slack refused the bot token (token_revoked)" });
    expect(checks[0]!.fix).toContain("reinstall the Slack app");
  });

  it("fails when the bot token belongs to another workspace than init recorded", async () => {
    const context = doctorContext({ services: doctorServices({ slackApi: fakeSlackApi({ authTest: async () => ({ ok: true, user_id: "U1", bot_id: "B1", team_id: "T0OTHER", team: "Other" }) }) }) });
    expect((await slackChecks(context))[0]).toMatchObject({ status: "fail", detail: "the bot token is for workspace T0OTHER, but agentx init set up T0TEAM" });
  });

  it("fails when the events URL does not echo the challenge", async () => {
    const context = doctorContext({ services: doctorServices({ fetch: async () => new Response("nope", { status: 500 }) }) });
    expect((await slackChecks(context)).find((entry) => entry.name === "request URLs")?.status).toBe("fail");
  });

  it("fails when the bot left the bound channel, naming the invite", async () => {
    const context = doctorContext({ services: doctorServices({ slackChannels: fakeSlackChannels([{ id: "C0123456789", name: "payments", isPrivate: true, isMember: false }]) }) });
    expect((await slackChecks(context)).find((entry) => entry.name === "#payments")).toMatchObject({ status: "fail", fix: "in #payments, type /invite @agentx" });
  });

  it("skips the channel check when init bound no channel", async () => {
    const context = doctorContext({ progress: { ...doctorContext().progress!, project: undefined } });
    expect((await slackChecks(context)).at(-1)).toMatchObject({ name: "bound channels", status: "skip" });
  });
});

describe("doctor: Slack (fix round 1)", () => {
  it("reads the Slack secret once, for both the token and the signing secret", async () => {
    const secrets = memoryInitSecrets(SECRETS);
    const reads: string[] = [];
    const counting = { get: async (name: string) => { reads.push(name); return secrets.get(name); } };
    const checks = await slackChecks(doctorContext({ services: doctorServices({ secrets: counting }) }));
    expect(checks.map((entry) => entry.status)).toEqual(["ok", "ok", "ok"]);
    expect(reads.filter((name) => name === "agentx/staging/slack")).toHaveLength(1);
  });

  it("keeps the checks already made, and fails the channel, when the channel lookup throws", async () => {
    const channels = { ...fakeSlackChannels([]), find: async () => { throw new AgentXError("RUNTIME_UNAVAILABLE", "Slack conversations.list failed with HTTP 503", 503); } };
    const checks = await slackChecks(doctorContext({ services: doctorServices({ slackChannels: channels }) }));
    expect(checks.map((entry) => [entry.name, entry.status])).toEqual([["bot token", "ok"], ["request URLs", "ok"], ["#payments", "fail"]]);
    expect(checks.at(-1)!.detail).toBe("Slack conversations.list failed with HTTP 503");
  });

  it("gives a doctor message, not init's, when the URLs keep refusing the stored signing secret", async () => {
    let clock = T0;
    const context = doctorContext({ services: doctorServices({
      fetch: async () => new Response(JSON.stringify({ error: "invalid Slack signature" }), { status: 401 }),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }) });
    const urls = (await slackChecks(context)).find((entry) => entry.name === "request URLs")!;
    expect(urls.status).toBe("fail");
    expect(urls.detail).toContain("refuses requests signed with the signing secret stored in agentx/staging/slack");
    expect(urls.detail).not.toContain("agentx init");
    expect(urls.detail).not.toContain("1 minutes");
    expect(urls.fix).toContain("Signing Secret");
    expect(urls.fix).not.toContain("agentx init");
  });
});

describe("doctor: GitHub App (fix round 1)", () => {
  const withGitHub = (overrides: Partial<ReturnType<typeof fakeGitHubApi>>, progress = doctorContext().progress) =>
    doctorContext({ progress, services: doctorServices({ github: { ...fakeGitHubApi({ installationId: 456 }), ...overrides } }) });

  it("fails, with a fix, when the installation token cannot be made", async () => {
    const found = (await githubChecks(withGitHub({ installationToken: async () => { throw new AgentXError("RUNTIME_UNAVAILABLE", "GitHub installation token failed with HTTP 403", 503); } })))[0]!;
    expect(found).toMatchObject({ name: "GitHub App", status: "fail" });
    expect(found.detail).toContain("GitHub installation token failed with HTTP 403");
    expect(found.fix).toContain("the installation may be suspended; check it in the installation settings on GitHub");
  });

  it("fails, with a fix, when the repositories cannot be listed", async () => {
    const found = (await githubChecks(withGitHub({ repositoryCount: async () => { throw new AgentXError("RUNTIME_UNAVAILABLE", "GitHub repository list failed with HTTP 500", 503); } })))[0]!;
    expect(found).toMatchObject({ name: "GitHub App", status: "fail" });
    expect(found.fix).toContain("installation settings on GitHub");
  });

  it("tells a refused key (HTTP 401) apart from GitHub being unreachable", async () => {
    const refused = (await githubChecks(withGitHub({ listInstallations: async () => { throw new AgentXError("RUNTIME_UNAVAILABLE", "GitHub installation list failed with HTTP 401", 503); } })))[0]!;
    expect(refused).toMatchObject({ status: "fail", detail: "GitHub refused the app's key (HTTP 401)" });
    expect(refused.fix).toContain("generate a new private key");
    const unreachable = (await githubChecks(withGitHub({ listInstallations: async () => { throw new TypeError("fetch failed"); } })))[0]!;
    expect(unreachable.status).toBe("fail");
    expect(unreachable.detail).toContain("could not reach GitHub");
    expect(unreachable.fix).toContain("network access to github.com");
    expect(unreachable.fix).not.toContain("private key");
  });

  it("with no installation recorded, picks the installation on the app's own account", async () => {
    const progress = { ...doctorContext().progress!, github: { ...doctorContext().progress!.github!, installationId: undefined } };
    const found = (await githubChecks(withGitHub({ listInstallations: async () => [{ id: 1, account: { login: "someone-else" } }, { id: 456, account: { login: "acme" } }] }, progress)))[0]!;
    expect(found).toMatchObject({ status: "ok", detail: "installed on acme, sees 1 repository" });
    const none = (await githubChecks(withGitHub({ listInstallations: async () => [{ id: 1, account: { login: "someone-else" } }] }, progress)))[0]!;
    expect(none).toMatchObject({ status: "fail", detail: "the GitHub App agentx-acme is not installed on acme" });
  });
});

describe("doctor: GitHub App (FR-050)", () => {
  it("passes an installed app that sees repositories, and never shows the private key", async () => {
    const checks = await githubChecks(doctorContext());
    expect(checks).toEqual([expect.objectContaining({ name: "GitHub App", status: "ok", detail: "installed on acme, sees 1 repository" })]);
    expect(text(checks)).not.toContain(TEST_PRIVATE_KEY.slice(40, 80));
  });

  it("fails when the app is no longer installed, with the install link", async () => {
    const context = doctorContext({ services: doctorServices({ github: fakeGitHubApi({ installAfterPolls: 99 }) }) });
    expect((await githubChecks(context))[0]).toMatchObject({ status: "fail", fix: "install it again: https://github.com/apps/agentx-acme/installations/new" });
  });

  it("fails when the installation sees no repository", async () => {
    const context = doctorContext({ services: doctorServices({ github: fakeGitHubApi({ installationId: 456, repositoryCounts: [0] }) }) });
    expect((await githubChecks(context))[0]).toMatchObject({ status: "fail", detail: "installed on acme, but it sees no repository" });
  });

  it("skips when the GitHub App secret is unreadable (the secrets check reports it)", async () => {
    const context = withSecrets({ "agentx/staging/callback-signing-key": SIGNING_KEY });
    expect((await githubChecks(context))[0]?.status).toBe("skip");
  });
});
