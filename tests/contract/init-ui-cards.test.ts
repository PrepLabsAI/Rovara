// Spec 040 phase 2: the status cards and the one "open this" link the page shows beside the
// question, and the rules that keep a link, or a secret, from reaching the page by accident.
import { describe, expect, it } from "vitest";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { adminCard, alertsCard, awsCard, awsSignedOutCard, channelCard, connectorsCard, githubCard, prerequisitesCard, projectCard, readyCard, releaseCard, replyCard, signedInAs, slackAppCard, slackChannelLink, slackUrlsCard } from "../../packages/cli/src/init/ui/cards.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";
import { createWizardHub, isShowableLink, LINK_REFUSED, NEW_TAB_NOTE } from "../../packages/cli/src/init/ui/state.js";
import { lintCopy, type CopyEntry } from "../support/copy-lint.js";

const card = (overrides: Partial<WizardCard> = {}): WizardCard => ({ id: "github", title: "GitHub App", status: "waiting", lines: ["one"], ...overrides });

/** A card's page words and its technical details, for the copy-lint rules. */
function cardEntries(input: WizardCard): CopyEntry[] {
  const where = `${input.id} card`;
  return [
    { where, text: input.title, context: "page" },
    ...input.lines.map((text) => ({ where, text, context: "page" as const })),
    ...(input.checks ?? []).flatMap((check) => [{ where, text: check.label, context: "page" as const }, { where, text: check.detail, context: "page" as const }]),
    ...(input.link === undefined ? [] : [{ where, text: input.link.label, context: "page" as const }]),
    ...(input.details ?? []).map((text) => ({ where, text, context: "details" as const })),
  ];
}

const EVERY_CARD: WizardCard[] = [
  releaseCard({ stage: "downloading", receivedBytes: 500_000, totalBytes: 1_000_000 }),
  releaseCard({ stage: "ready" }),
  awsCard({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice", region: "us-east-1", profile: "dev" }),
  awsSignedOutCard({ profile: "dev", problem: "AUTH_REQUIRED: your AWS session has expired. Refresh your AWS session first (for example aws sso login or aws login)", signIn: "aws sso login --profile dev" }),
  prerequisitesCard({ status: "failed", checks: [{ label: "EC2 vCPU quota", ok: false, detail: "Ask AWS for more in Service Quotas." }] }),
  githubCard({ stage: "create", appName: "Rovara acme (staging)", account: "acme", startUrl: "http://127.0.0.1:5000/github/start?t=x" }),
  githubCard({ stage: "install", appName: "Rovara acme (staging)", slug: "agentx-acme-staging", account: "acme", installUrl: "https://github.com/apps/agentx-acme-staging/installations/new" }),
  githubCard({ stage: "repositories", appName: "Rovara acme (staging)", slug: "agentx-acme-staging", account: "acme", settingsUrl: "https://github.com/organizations/acme/settings/installations/1" }),
  githubCard({ stage: "done", appName: "Rovara acme (staging)", slug: "agentx-acme-staging", account: "acme" }),
  githubCard({ stage: "failed", problem: "no GitHub App was created within 15 minutes; run agentx init again" }),
  slackAppCard({ stage: "create", appName: "Rovara acme (staging)", createUrl: "https://api.slack.com/apps?new_app=1" }),
  slackAppCard({ stage: "credentials", appName: "Rovara acme (staging)" }),
  slackAppCard({ stage: "bot", user: "agentx-acme-staging", team: "Acme" }),
  slackAppCard({ stage: "refused", problem: "Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions" }),
  slackAppCard({ stage: "approval", appName: "Rovara acme (staging)" }),
  slackAppCard({ stage: "done", appName: "Rovara acme (staging)", appId: "A0APP", teamId: "T0TEAM", teamName: "Acme" }),
  slackUrlsCard({ stage: "verify", pageUrl: "https://api.slack.com/apps/A0APP/event-subscriptions" }),
  slackUrlsCard({ stage: "failed", problem: "the URL answered 401; run agentx init again", pageUrl: "https://api.slack.com/apps/A0APP/event-subscriptions" }),
  adminCard({ stage: "signing-in", who: "you@example.com", passwordEmail: "you@example.com" }),
  adminCard({ stage: "failed", problem: "the Rovara sign-in did not finish within 10 minutes; run agentx init again", retry: false }),
  projectCard({ name: "payments-api", revision: 1, repository: "acme/payments-api" }),
  channelCard({ stage: "waiting", channelName: "payments", botName: "agentx-acme-staging" }),
  channelCard({ stage: "failed", channelName: "payments", problem: "the bot was not invited within 10 minutes; run agentx init again" }),
  connectorsCard({ projectName: "payments-api", connected: [] }),
  alertsCard({ stage: "confirm", shownAs: "ops@example.com" }),
  alertsCard({ stage: "failed", problem: "CloudWatch refused SetAlarmState" }),
  alertsCard({ stage: "none" }),
  replyCard({ stage: "waiting", channelName: "payments", channelId: "C0PAY00001", teamId: "T0TEAM", botName: "agentx-acme-staging", minutes: 10 }),
  replyCard({ stage: "failed", channelName: "payments", channelId: "C0PAY00001", teamId: "T0TEAM", problem: "no reply within 10 minutes; run agentx init again" }),
];

describe("spec 048 card copy", () => {
  it("SC-011: no card says an internal word, a raw ID, a flag or a command outside its technical details", () => {
    expect(lintCopy(EVERY_CARD.flatMap(cardEntries))).toEqual([]);
  });

  it("FR-027: names who is signed in, never the ARN, which is kept in the details", () => {
    expect(signedInAs("arn:aws:sts::123456789012:assumed-role/Admin/alice")).toBe("alice (role Admin)");
    expect(signedInAs("arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_AdministratorAccess_0123456789abcdef/alice@example.com")).toBe("alice@example.com (AdministratorAccess, through IAM Identity Center)");
    expect(signedInAs("arn:aws:iam::123456789012:user/ops/bob")).toBe("the IAM user bob");
    expect(signedInAs("arn:aws:iam::123456789012:root")).toBe("the AWS root user");
    expect(EVERY_CARD.find((entry) => entry.id === "aws" && entry.status === "ok")?.details).toEqual(["arn:aws:sts::123456789012:assumed-role/Admin/alice"]);
  });

});

describe("links", () => {
  it("shows only https addresses without a user name, and this machine's 127.0.0.1 addresses", () => {
    for (const url of ["https://github.com/apps/agentx-acme-staging/installations/new", "http://127.0.0.1:51234/github/start?t=abc"]) expect(isShowableLink(url)).toBe(true);
    for (const url of ["http://github.com/", "javascript:alert(1)", "data:text/html,x", "https://user:pw@github.com/", "http://localhost:51234/", "http://127.0.0.1.evil.test/", "", "not an address"]) {
      expect(isShowableLink(url)).toBe(false);
    }
  });

  it("drops a card's link it cannot check, and never shows a run link it cannot check", () => {
    const hub = createWizardHub("staging");
    hub.showCard(card({ link: { url: "javascript:alert(1)", label: "Create" } }));
    expect(hub.state().cards?.[0]).not.toHaveProperty("link");
    hub.showLink({ url: "http://example.com/", label: "Open example.com" });
    expect(hub.state().link).toBeUndefined();
    // The refusal is logged without the address, which could be anything.
    expect(hub.snapshot().log).toEqual([LINK_REFUSED, LINK_REFUSED]);
  });

  it("clears the run's link when its step ends, or when the next one starts", () => {
    const hub = createWizardHub("staging");
    hub.setSteps([{ id: "github-app", title: "Create the GitHub app" }, { id: "control-plane", title: "Start the Rovara service" }]);
    hub.showLink({ url: "https://github.com/apps/agentx-acme-staging/installations/new", label: "Open github.com" });
    expect(hub.state().link).toEqual({ url: "https://github.com/apps/agentx-acme-staging/installations/new", label: "Open github.com", note: NEW_TAB_NOTE });
    hub.applyEvent({ kind: "step-done", id: "github-app", title: "Create the GitHub app" });
    expect(hub.state().link).toBeUndefined();
    hub.showLink({ url: "https://api.slack.com/apps", label: "Open api.slack.com" });
    hub.applyEvent({ kind: "step-started", id: "control-plane", title: "Start the Rovara service" });
    expect(hub.state().link).toBeUndefined();
  });
});

describe("cards that offer to try again on the page (M18)", () => {
  it("a refused Slack token says nothing of running agentx init again, and says nothing was saved once", () => {
    expect(slackAppCard({ stage: "refused", problem: "Slack bots.info did not return the app id (no app_id); run agentx init again" }).lines)
      .toEqual(["Slack bots.info did not return the app id (no app_id)", "Nothing was saved."]);
    expect(slackAppCard({ stage: "refused", problem: "nothing was saved; copy the Bot User OAuth Token from the Rovara app in the right workspace, then run agentx init again" }).lines)
      .toEqual(["nothing was saved; copy the Bot User OAuth Token from the Rovara app in the right workspace"]);
    expect(slackAppCard({ stage: "refused", problem: "that token belongs to Slack workspace T0OTHER, but this install uses T0TEAM; nothing was saved" }).lines)
      .toEqual(["that token belongs to Slack workspace T0OTHER, but this install uses T0TEAM; nothing was saved"]);
    expect(slackAppCard({ stage: "refused", problem: "Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions" }).lines)
      .toEqual(["Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions", "Nothing was saved."]);
  });

});

const WHERE = { channelName: "payments", channelId: "C0PAY00001", teamId: "T0123456789" };

describe("the finishing cards", () => {

  it("connectors and alerts, naming a webhook only by its display form", () => {
    expect(connectorsCard({ projectName: "payments-api", connected: [] }).lines).toEqual(["No issue trackers are connected to payments-api yet. You can connect Linear, Jira or Asana later."]);
    expect(connectorsCard({ projectName: "payments-api", connected: [{ label: "Linear" }, { label: "Jira", warning: "the Jira service account can also see issues in HR" }] }).lines).toEqual([
      "Connected to payments-api: Linear, Jira.", "Warning (Jira): the Jira service account can also see issues in HR.",
    ]);
    expect(alertsCard({ stage: "confirm", shownAs: "https://events.pagerduty.com/..." })).toMatchObject({
      id: "alerts", status: "waiting",
      lines: [
        "Confirm the alert email for https://events.pagerduty.com/...: open the email from AWS Notifications and choose Confirm subscription.",
        "Then choose Check again below.",
      ],
    });
    expect(alertsCard({ stage: "waiting", shownAs: "ops@example.com" })).toEqual({
      id: "alerts", title: "Alerts", status: "waiting",
      lines: [
        "Confirm the alert email for ops@example.com: open the email from AWS Notifications and choose Confirm subscription.",
        "This page moves on by itself when it is confirmed (up to 10 minutes).",
      ],
      details: ["A webhook confirms by opening the SubscribeURL that AWS sent it."],
    });
    expect(alertsCard({ stage: "done", shownAs: "ops@example.com" }).lines).toEqual(["Alerts go to ops@example.com, and the test alert arrived."]);
    expect(alertsCard({ stage: "none" }).lines).toEqual(["No alerts yet. The ready screen shows how to turn them on."]);
  });

  it("the test reply: how to mention the bot, a link to the channel, and what to fix", () => {
    expect(slackChannelLink("T0123456789", "C0PAY00001")).toBe("https://slack.com/app_redirect?team=T0123456789&channel=C0PAY00001");
    expect(replyCard({ stage: "waiting", ...WHERE, botName: "agentx-acme-staging", minutes: 10 })).toEqual({
      id: "reply", title: "First reply", status: "waiting",
      lines: [
        'In #payments, post a message that mentions @agentx-acme-staging, for example "@agentx-acme-staging what can you do?".',
        "Type @ and pick agentx-acme-staging from Slack's list. If you see two bots with similar names, pick agentx-acme-staging.",
        "Waiting up to 10 minutes for Rovara to reply in the thread. This page moves on by itself.",
      ],
      link: { url: "https://slack.com/app_redirect?team=T0123456789&channel=C0PAY00001", label: "Open #payments in Slack" },
    });
    expect(replyCard({ stage: "failed", ...WHERE, problem: "no Rovara reply in #payments within 10 minutes" })).toMatchObject({
      status: "failed", lines: ["Rovara did not reply.", "When it is fixed, choose Watch again below."], details: ["no Rovara reply in #payments within 10 minutes"],
    });
    expect(replyCard({ stage: "done", channelName: "payments", seconds: 12 })).toMatchObject({ status: "ok", lines: ["Rovara replied in #payments in 12 seconds."] });
  });

});

const FROM_SOURCE = { published: false, cliPath: "/opt/agentx/dist/main.js" };
const READY_PROGRESS = {
  ...emptyProgress("staging", 0),
  slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT", botName: "agentx-acme-staging" },
  project: { name: "payments-api", revision: 1, channelName: "payments", channelId: "C0PAY00001", teamId: "T0TEAM" },
};

describe("spec 048 the ready screen", () => {

  it("FR-016: names the commands that need an admin user when the install ran as root", () => {
    const card = readyCard({
      env: "staging", region: "us-east-1", controlPlaneUrl: "https://abc.example.com", progress: READY_PROGRESS, botName: "agentx-acme-staging",
      invocation: FROM_SOURCE, root: true, alertsOn: true, created: [],
    });
    expect(card.lines).toContain("You installed as the AWS root user. The day-two commands below need an admin user: AWS does not let the root user use the Rovara operator role.");
  });

  it("names the published package only when the CLI is the published one", () => {
    const card = readyCard({
      env: "staging", region: "us-east-1", controlPlaneUrl: "https://abc.example.com", progress: READY_PROGRESS, botName: "agentx-acme-staging",
      invocation: { published: true, version: "1.2.3", cliPath: "/x" }, root: false, alertsOn: true, created: [],
    });
    expect(card.commands?.[0]?.command).toBe("npx @preplabsai/rovara-code@1.2.3 login https://abc.example.com");
    expect(card.lines.join(" ")).not.toContain("not published");
  });
});
