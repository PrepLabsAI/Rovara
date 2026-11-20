import { AgentXError } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { githubChecks, githubWebhookChecks } from "../../packages/cli/src/doctor/github.js";
import { githubAppSecretName, githubWebhookUrl } from "../../packages/cli/src/init/github-app.js";
import { secretChecks } from "../../packages/cli/src/doctor/secrets.js";
import { slackChecks, slackSigningSecret } from "../../packages/cli/src/doctor/slack.js";
import { SlackRateLimitedError } from "../../packages/cli/src/setup/channel-add.js";
import { doctorContext, doctorServices, SECRETS, SETTINGS, SIGNING_KEY } from "../support/doctor-fakes.js";
import { fakeGitHubApi, fakeSlackApi, memoryInitSecrets, T0, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
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

  it("sends a signing key under 32 characters to a delete and then upgrade, since upgrade keeps any key that exists (final review I1)", async () => {
    const checks = await secretChecks(withSecrets({ ...SECRETS, "agentx/staging/callback-signing-key": "short-key" }));
    expect(checks.find((entry) => entry.name === "agentx/staging/callback-signing-key")).toMatchObject({
      status: "fail", detail: "is shorter than the 32 characters the control plane needs",
      fix: "with admin credentials, delete it (aws secretsmanager delete-secret --secret-id agentx/staging/callback-signing-key --force-delete-without-recovery --region us-east-1), then run agentx --env staging upgrade: it makes a new key and redeploys the control plane with it",
    });
    expect(text(checks)).not.toContain("short-key");
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

  it("names --project in the fix for a channel that is gone, since channel add refuses without it (final review M9)", async () => {
    const context = doctorContext({ services: doctorServices({ slackChannels: fakeSlackChannels([]) }) });
    expect((await slackChecks(context)).find((entry) => entry.name === "#payments")).toMatchObject({ status: "fail", fix: "in #payments, type /invite @agentx, or bind another channel with agentx --env staging channel add --project payments" });
  });

});

describe("doctor: the Slack signing secret parse (final review M10)", () => {
  it("reads the signing secret with the safe parse, so a malformed value never throws or echoes any part of itself", () => {
    const malformed = `{"botToken":"xoxb-SECRETpart","signingSecret":"${TEST_SIGNING_SECRET}"`;
    let result: unknown;
    expect(() => { result = slackSigningSecret(malformed); }).not.toThrow();
    expect(result).toBeUndefined();
    expect(slackSigningSecret(undefined)).toBeUndefined();
    expect(slackSigningSecret("[1]")).toBeUndefined();
    expect(slackSigningSecret(JSON.stringify({ signingSecret: TEST_SIGNING_SECRET }))).toBe(TEST_SIGNING_SECRET);
  });

  it("fails a malformed Slack secret with a message that holds no part of it", async () => {
    const malformed = `{"botToken":"xoxb-SECRETpart","signingSecret":"${TEST_SIGNING_SECRET}"`;
    const checks = await slackChecks(withSecrets({ ...SECRETS, "agentx/staging/slack": malformed }));
    expect(checks[0]).toMatchObject({ name: "bot token", status: "fail" });
    for (const part of ["SECRETpart", TEST_SIGNING_SECRET, "botToken"]) expect(text(checks)).not.toContain(part);
  });
});

describe("doctor: Slack (fix round 1)", () => {

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

  it("fails when the installation sees no repository", async () => {
    const context = doctorContext({ services: doctorServices({ github: fakeGitHubApi({ installationId: 456, repositoryCounts: [0] }) }) });
    expect((await githubChecks(context))[0]).toMatchObject({ status: "fail", detail: "installed on acme, but it sees no repository" });
  });

  it("skips when the GitHub App secret is unreadable (the secrets check reports it)", async () => {
    const context = withSecrets({ "agentx/staging/callback-signing-key": SIGNING_KEY });
    expect((await githubChecks(context))[0]?.status).toBe("skip");
  });
});

describe("doctor: Slack and GitHub (Task 6 polish)", () => {

  const lookupFailing = (error: Error) => doctorContext({ services: doctorServices({ slackChannels: { ...fakeSlackChannels([]), find: async () => { throw error; } } }) });
  const channelCheck = async (error: Error) => (await slackChecks(lookupFailing(error))).find((entry) => entry.name === "#payments")!;

  it("chooses the channel lookup's fix by the error", async () => {
    const scope = await channelCheck(new AgentXError("CONFIG_INVALID", "Slack conversations.list refused: missing_scope; reinstall the Slack app from its manifest so it has channels:read, groups:read and channels:join", 400));
    expect(scope.fix).toContain("reinstall the Slack app");
    expect(scope.fix).not.toContain("network");
    const many = await channelCheck(new AgentXError("CONFIG_INVALID", "the workspace has more than 50000 channels to search; bind the channel by id with agentx admin slack bind --team <team-id> --channel <channel-id> --project <name>", 400));
    expect(many.fix).toBe("bind it by ID: agentx admin slack bind --team T0TEAM --channel C0123456789 --project payments");
    const network = await channelCheck(new TypeError("fetch failed"));
    expect(network.fix).toContain("network access to slack.com");
    const refused = await channelCheck(new AgentXError("RUNTIME_UNAVAILABLE", "Slack conversations.list refused: invalid_auth", 503));
    expect(refused.fix).not.toContain("network");
  });

  it("tells a rate-limited channel lookup to wait, not to check the network", async () => {
    const limited = await channelCheck(new SlackRateLimitedError("conversations.list", 30_000));
    expect(limited).toMatchObject({ status: "fail", detail: "Slack conversations.list is rate limited; try again in 30 seconds", fix: "Slack is rate limiting the bot; run agentx doctor again in a minute" });
  });

  it("blames a suspended installation only on HTTP 403 or 404", async () => {
    const failing = (message: string) => doctorContext({ services: doctorServices({ github: { ...fakeGitHubApi({ installationId: 456 }), repositoryCount: async () => { throw new AgentXError("RUNTIME_UNAVAILABLE", message, 503); } } }) });
    expect((await githubChecks(failing("GitHub repository list failed with HTTP 404")))[0]!.fix).toContain("the installation may be suspended");
    const other = (await githubChecks(failing("GitHub repository list failed with HTTP 502")))[0]!;
    expect(other.status).toBe("fail");
    expect(other.fix).not.toContain("suspended");
  });
});

describe("doctor: GitHub webhook", () => {
  const EXPECTED_URL = githubWebhookUrl(SETTINGS.controlPlaneUrl);
  const SECRET_ID = githubAppSecretName("staging");
  const appSecret = (extra: Record<string, unknown>) => JSON.stringify({ appId: "123", slug: "agentx-acme", account: "acme", privateKey: TEST_PRIVATE_KEY, ...extra });
  const contextWith = (github: Parameters<typeof fakeGitHubApi>[0], secret = SECRETS[SECRET_ID]!) =>
    doctorContext({ services: doctorServices({ github: fakeGitHubApi({ installationId: 456, ...github }), secrets: memoryInitSecrets({ ...SECRETS, [SECRET_ID]: secret }) }) });

  describe("recent deliveries", () => {
    const SETTINGS_PAGE = "https://github.com/organizations/acme/settings/apps/agentx-acme-staging";
    const hoursAgo = (hours: number) => new Date(T0 - hours * 60 * 60 * 1000).toISOString();
    const deliveriesCheck = async (deliveries: Array<{ deliveredAt: string; status: string; statusCode: number }>) =>
      (await githubWebhookChecks(contextWith({ hookUrl: EXPECTED_URL, deliveries }))).find((entry) => entry.name === "GitHub webhook deliveries")!;

    // GitHub keeps only about 3 days of deliveries, so an older one is never listed and the window is 3 days.
    it("warns, naming where Active is switched on, when GitHub made no successful delivery in the last 3 days", async () => {
      for (const deliveries of [[], [{ deliveredAt: hoursAgo(4 * 24), status: "OK", statusCode: 200 }]]) {
        const found = await deliveriesCheck(deliveries);
        expect(found).toMatchObject({ status: "warn", detail: "no successful deliveries to AgentX in the last 3 days" });
        expect(found.fix).toBe(`check that Active is on at ${SETTINGS_PAGE}; GitHub lists each delivery at ${SETTINGS_PAGE}/advanced`);
      }
    });

    it("warns when the latest delivery failed, even after an older one went through", async () => {
      const refused = await deliveriesCheck([{ deliveredAt: hoursAgo(1), status: "Bad Gateway", statusCode: 502 }, { deliveredAt: hoursAgo(5), status: "OK", statusCode: 200 }]);
      expect(refused).toMatchObject({ status: "warn", detail: "GitHub's latest delivery to AgentX failed (HTTP 502)" });
      expect(refused.fix).toContain(`check that Active is on at ${SETTINGS_PAGE}`);
      const unreachable = await deliveriesCheck([{ deliveredAt: hoursAgo(1), status: "Invalid HTTP Response: 0", statusCode: 0 }]);
      expect(unreachable).toMatchObject({ status: "warn", detail: "GitHub's latest delivery to AgentX failed (it got no answer)" });
    });

    it("warns, and does not fail, when the deliveries cannot be read", async () => {
      const api = fakeGitHubApi({ installationId: 456, hookUrl: EXPECTED_URL });
      api.listHookDeliveries = async () => { throw new AgentXError("RUNTIME_UNAVAILABLE", "GitHub webhook delivery list failed with HTTP 500", 503); };
      const checks = await githubWebhookChecks(doctorContext({ services: doctorServices({ github: api }) }));
      const found = checks.find((entry) => entry.name === "GitHub webhook deliveries")!;
      expect(found).toMatchObject({ status: "warn" });
      expect(found.detail).toContain("HTTP 500");
      expect(checks.every((entry) => entry.status !== "fail")).toBe(true);
    });
  });

  it("warns, with the fix, when the App's webhook points somewhere else or nowhere", async () => {
    for (const hookUrl of ["https://old.example.test/hook", undefined]) {
      const found = (await githubWebhookChecks(contextWith({ ...(hookUrl === undefined ? {} : { hookUrl }) })))[0]!;
      expect(found).toMatchObject({ name: "GitHub webhook", status: "warn" });
      expect(found.detail).toContain(EXPECTED_URL);
      expect(found.fix).toBe("run agentx --env staging upgrade: it points the App's webhook at the control plane");
    }
  });

  it("warns when the App is not subscribed to every event, and names them and the settings page", async () => {
    const found = (await githubWebhookChecks(contextWith({ hookUrl: EXPECTED_URL, events: ["pull_request", "issue_comment"] })))[1]!;
    expect(found).toMatchObject({ name: "GitHub webhook", status: "warn" });
    expect(found.detail).toContain("pull_request_review, pull_request_review_comment");
    expect(found.fix).toContain("https://github.com/organizations/acme/settings/apps/agentx-acme-staging/permissions");
  });

  it("warns when no usable webhook secret is stored, without showing any secret", async () => {
    for (const secret of [appSecret({}), appSecret({ webhookSecret: "short-secret-value" })]) {
      const checks = await githubWebhookChecks(contextWith({ hookUrl: EXPECTED_URL }, secret));
      const found = checks[2]!;
      expect(found).toMatchObject({ name: "GitHub webhook secret", status: "warn", fix: "run agentx --env staging upgrade: it stores a webhook secret and gives it to GitHub" });
      expect(text(checks)).not.toContain("short-secret-value");
    }
  });

  it("warns, and does not fail, when GitHub cannot be asked", async () => {
    const api = fakeGitHubApi({ installationId: 456 });
    api.getHookConfig = async () => { throw new AgentXError("RUNTIME_UNAVAILABLE", "GitHub webhook lookup failed with HTTP 500", 503); };
    const checks = await githubWebhookChecks(doctorContext({ services: doctorServices({ github: api }) }));
    expect(checks[0]).toMatchObject({ status: "warn" });
    expect(checks[0]!.detail).toContain("HTTP 500");
    expect(checks.every((entry) => entry.status !== "fail")).toBe(true);
  });

  it("adds nothing when the GitHub App secret cannot be read (the GitHub App check says why)", async () => {
    expect(await githubWebhookChecks(doctorContext({ services: doctorServices({ secrets: memoryInitSecrets({}) }) }))).toEqual([]);
  });
});
