import { describe, expect, it } from "vitest";
import { githubChecks } from "../../packages/cli/src/doctor/github.js";
import { secretChecks } from "../../packages/cli/src/doctor/secrets.js";
import { slackChecks } from "../../packages/cli/src/doctor/slack.js";
import { doctorContext, doctorServices, SECRETS, SIGNING_KEY } from "../support/doctor-fakes.js";
import { fakeGitHubApi, fakeSlackApi, memoryInitSecrets, TEST_BOT_TOKEN, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
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
