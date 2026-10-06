// Spec 040 phase 2: the status cards and the one "open this" link the page shows beside the
// question, and the rules that keep a link, or a secret, from reaching the page by accident.
import { describe, expect, it } from "vitest";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import {
  adminCard, alertsCard, awsCard, awsSignedOutCard, channelCard, connectorsCard, githubCard, onPageProblem, prerequisitesCard, projectCard, readyCard, releaseCard, replyCard,
  signedInAs, slackAppCard, slackChannelLink, slackUrlsCard,
} from "../../packages/cli/src/init/ui/cards.js";
import { startInstallWizard } from "../../packages/cli/src/init/ui/index.js";
import { WIZARD_JS, wizardHtml } from "../../packages/cli/src/init/ui/page.js";
import type { WizardCard, WizardState } from "../../packages/cli/src/init/ui/protocol.js";
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
  githubCard({ stage: "create", appName: "AgentX acme (staging)", account: "acme", startUrl: "http://127.0.0.1:5000/github/start?t=x" }),
  githubCard({ stage: "install", appName: "AgentX acme (staging)", slug: "agentx-acme-staging", account: "acme", installUrl: "https://github.com/apps/agentx-acme-staging/installations/new" }),
  githubCard({ stage: "repositories", appName: "AgentX acme (staging)", slug: "agentx-acme-staging", account: "acme", settingsUrl: "https://github.com/organizations/acme/settings/installations/1" }),
  githubCard({ stage: "done", appName: "AgentX acme (staging)", slug: "agentx-acme-staging", account: "acme" }),
  githubCard({ stage: "failed", problem: "no GitHub App was created within 15 minutes; run agentx init again" }),
  slackAppCard({ stage: "create", appName: "AgentX acme (staging)", createUrl: "https://api.slack.com/apps?new_app=1" }),
  slackAppCard({ stage: "credentials", appName: "AgentX acme (staging)" }),
  slackAppCard({ stage: "bot", user: "agentx-acme-staging", team: "Acme" }),
  slackAppCard({ stage: "refused", problem: "Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions" }),
  slackAppCard({ stage: "approval", appName: "AgentX acme (staging)" }),
  slackAppCard({ stage: "done", appName: "AgentX acme (staging)", appId: "A0APP", teamId: "T0TEAM", teamName: "Acme" }),
  slackUrlsCard({ stage: "verify", pageUrl: "https://api.slack.com/apps/A0APP/event-subscriptions" }),
  slackUrlsCard({ stage: "failed", problem: "the URL answered 401; run agentx init again", pageUrl: "https://api.slack.com/apps/A0APP/event-subscriptions" }),
  adminCard({ stage: "signing-in", who: "you@example.com", passwordEmail: "you@example.com" }),
  adminCard({ stage: "failed", problem: "the AgentX sign-in did not finish within 10 minutes; run agentx init again", retry: false }),
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

  it("FR-027: the GitHub app keeps its name on every card, and its slug only in the details", () => {
    for (const shown of EVERY_CARD.filter((entry) => entry.id === "github" && entry.status !== "failed")) {
      expect(shown.lines.join(" ")).toContain("AgentX acme (staging)");
      expect(shown.lines.join(" ")).not.toContain("agentx-acme-staging");
    }
    expect(githubCard({ stage: "done", appName: "AgentX acme (staging)", slug: "agentx-acme-staging", account: "acme" }).details).toEqual(["GitHub app slug: agentx-acme-staging"]);
  });

  it("FR-027: Slack's workspace and bot are named, and their IDs are only in the details", () => {
    const done = slackAppCard({ stage: "done", appName: "AgentX acme (staging)", appId: "A0APP", teamId: "T0TEAM", teamName: "Acme" });
    expect(done.lines).toEqual(['"AgentX acme (staging)" is installed in the Acme workspace.']);
    expect(done.details).toEqual(["Slack app ID: A0APP", "Slack workspace ID: T0TEAM"]);
    expect(channelCard({ stage: "waiting", channelName: "payments", botName: "agentx-acme-staging" }).commands).toEqual([{ label: "Invite the bot", command: "/invite @agentx-acme-staging" }]);
  });

  it("FR-034: the Slack create card says up front that a Request URL error is expected", () => {
    expect(slackAppCard({ stage: "create", appName: "AgentX acme (staging)", createUrl: "https://api.slack.com/apps?new_app=1" }).lines)
      .toContain("Slack may show a red error next to the Request URL. That is expected; AgentX fixes it in a later step.");
  });
});

describe("status cards", () => {
  it("shows a card, replaces it in place by id, and keeps the order cards first appeared in", () => {
    const hub = createWizardHub("staging");
    expect(hub.state().cards).toBeUndefined();
    hub.showCard(card({ id: "aws", title: "AWS account", status: "ok" }));
    hub.showCard(card());
    hub.showCard(card({ id: "aws", title: "AWS account", status: "failed", lines: ["two"] }));
    expect(hub.state().cards?.map((shown) => [shown.id, shown.status, shown.lines])).toEqual([["aws", "failed", ["two"]], ["github", "waiting", ["one"]]]);
  });

  it("gives a page that connects late every card in its snapshot", () => {
    const hub = createWizardHub("staging");
    hub.showCard(card({ checks: [{ label: "EC2 vCPU quota", ok: false, detail: "must be at least 1" }] }));
    expect(hub.snapshot().cards).toEqual([card({ checks: [{ label: "EC2 vCPU quota", ok: false, detail: "must be at least 1" }] })]);
  });

  it("pushes each card to every listener as it changes", () => {
    const hub = createWizardHub("staging");
    const seen: number[] = [];
    hub.subscribe({ state: (state) => { seen.push(state.cards?.length ?? 0); }, log: () => undefined, closed: () => undefined });
    hub.showCard(card({ id: "aws" }));
    hub.showCard(card());
    expect(seen).toEqual([1, 2]);
  });
});

describe("links", () => {
  it("shows only https addresses without a user name, and this machine's 127.0.0.1 addresses", () => {
    for (const url of ["https://github.com/apps/agentx-acme-staging/installations/new", "http://127.0.0.1:51234/github/start?t=abc"]) expect(isShowableLink(url)).toBe(true);
    for (const url of ["http://github.com/", "javascript:alert(1)", "data:text/html,x", "https://user:pw@github.com/", "http://localhost:51234/", "http://127.0.0.1.evil.test/", "", "not an address"]) {
      expect(isShowableLink(url)).toBe(false);
    }
  });

  it("shows a 127.0.0.1 address only on a port a listener can have, 1 to 65535", () => {
    for (const url of ["http://127.0.0.1:1/", "http://127.0.0.1:65535/github/start?t=abc"]) expect(isShowableLink(url)).toBe(true);
    for (const url of ["http://127.0.0.1:0/", "http://127.0.0.1:00000/", "http://127.0.0.1:65536/", "http://127.0.0.1:99999/"]) expect(isShowableLink(url)).toBe(false);
  });

  it("the wizard's openLink says false for an address the page refused, so the step falls back to its terminal instructions", async () => {
    const wizard = await startInstallWizard({ env: "staging", write: () => undefined });
    try {
      expect(await wizard.openLink("http://example.com/")).toBe(false);
      expect(wizard.hub.state().link).toBeUndefined();
      expect(await wizard.openLink("https://github.com/apps/agentx-acme-staging/installations/new")).toBe(true);
      expect(wizard.hub.state().link).toEqual({ url: "https://github.com/apps/agentx-acme-staging/installations/new", label: "Open github.com", note: NEW_TAB_NOTE });
    } finally {
      await wizard.close();
    }
  });

  it("drops the run's link once the card that offered it is replaced by one that no longer does", () => {
    const hub = createWizardHub("staging");
    const create = "https://api.slack.com/apps?new_app=1";
    hub.showCard(card({ id: "slack", link: { url: create, label: "Create the Slack app" } }));
    hub.showLink({ url: create, label: "Open api.slack.com" });
    // The same card, still offering it: the link stays.
    hub.showCard(card({ id: "slack", lines: ["two"], link: { url: create, label: "Create the Slack app" } }));
    expect(hub.state().link?.url).toBe(create);
    // Another card replaced: the link stays.
    hub.showCard(card({ id: "github" }));
    expect(hub.state().link?.url).toBe(create);
    // Slack's credentials card offers no link: the create address is stale.
    hub.showCard(card({ id: "slack", lines: ["paste"] }));
    expect(hub.state().link).toBeUndefined();
  });

  it("keeps a run link that the replaced card did not offer", () => {
    const hub = createWizardHub("staging");
    hub.showCard(card({ id: "github", link: { url: "https://github.com/apps/agentx/installations/new", label: "Install" } }));
    hub.showLink({ url: "https://api.slack.com/apps", label: "Open api.slack.com" });
    hub.showCard(card({ id: "github", lines: ["repositories"], link: { url: "https://github.com/settings/installations/1", label: "Choose repositories" } }));
    expect(hub.state().link?.url).toBe("https://api.slack.com/apps");
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

  it("keeps a card's details and commands when its link is refused", () => {
    const hub = createWizardHub("staging");
    hub.showCard(card({
      link: { url: "javascript:alert(1)", label: "Create" },
      details: ["raw error ARN"],
      commands: [{ label: "Continue later with", command: "agentx --env staging init" }],
    }));
    const shown = hub.state().cards?.[0];
    expect(shown).not.toHaveProperty("link");
    expect(shown?.details).toEqual(["raw error ARN"]);
    expect(shown?.commands).toEqual([{ label: "Continue later with", command: "agentx --env staging init" }]);
  });

  it("clearLink drops the run's link, and does nothing when there is none", () => {
    const hub = createWizardHub("staging");
    const states: WizardState[] = [];
    hub.subscribe({ state: (state) => { states.push(state); }, log: () => undefined, closed: () => undefined });
    hub.showLink({ url: "https://login.example.com/authorize?attempt=1", label: "Open login.example.com" });
    hub.clearLink();
    expect(hub.state().link).toBeUndefined();
    // It is published, so a page already open drops the button too.
    expect(states.at(-1)).not.toHaveProperty("link");
    hub.clearLink();
    expect(hub.state().link).toBeUndefined();
  });

  it("clears the run's link when its step ends, or when the next one starts", () => {
    const hub = createWizardHub("staging");
    hub.setSteps([{ id: "github-app", title: "Create the GitHub app" }, { id: "control-plane", title: "Start the AgentX service" }]);
    hub.showLink({ url: "https://github.com/apps/agentx-acme-staging/installations/new", label: "Open github.com" });
    expect(hub.state().link).toEqual({ url: "https://github.com/apps/agentx-acme-staging/installations/new", label: "Open github.com", note: NEW_TAB_NOTE });
    hub.applyEvent({ kind: "step-done", id: "github-app", title: "Create the GitHub app" });
    expect(hub.state().link).toBeUndefined();
    hub.showLink({ url: "https://api.slack.com/apps", label: "Open api.slack.com" });
    hub.applyEvent({ kind: "step-started", id: "control-plane", title: "Start the AgentX service" });
    expect(hub.state().link).toBeUndefined();
  });
});

describe("the page", () => {
  it("has a place for the cards and for the Next link, and still no inline script", () => {
    const html = wizardHtml("t");
    expect(html).toContain('<div id="cards"></div>');
    expect(html).toContain('<section id="next" class="card hidden">');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
  });

  it("builds cards and links from text only, and opens links in a new tab without a referrer", () => {
    expect(WIZARD_JS).not.toContain("innerHTML");
    expect(WIZARD_JS).not.toContain("insertAdjacentHTML");
    expect(WIZARD_JS).not.toContain("document.write");
    expect(WIZARD_JS).toContain('anchor.target = "_blank";');
    expect(WIZARD_JS).toContain('anchor.rel = "noopener noreferrer";');
    expect(WIZARD_JS).toContain("renderPanelCards(state);");
  });

  it("Q4: empties a masked field the moment it is sent, empties the question area once answered, and asks password managers to leave it alone", () => {
    expect(WIZARD_JS).toContain('if (question.masked) field.value = "";');
    expect(WIZARD_JS).toContain('byId("question-body").replaceChildren();');
    expect(WIZARD_JS).toContain('field.setAttribute("data-1p-ignore", "");');
    expect(WIZARD_JS).toContain('field.setAttribute("data-lpignore", "true");');
    // Enter sends through the same reader as the button, so it empties the field too.
    expect(WIZARD_JS).toContain("submit(question.id, read());");
    expect(WIZARD_JS).not.toContain("submit(question.id, field.value)");
  });

  it("a press while an answer is in flight leaves the typed value in the field", () => {
    // read() runs before submit() can refuse the press, so it checks `sending` itself, before the
    // masked field is emptied.
    const reader = /read = \(\) => \{\n {6}const value = field\.value;[\s\S]*?\n {4}\};/.exec(WIZARD_JS)?.[0] ?? "";
    expect(reader).toContain("if (sending) return value;");
    expect(reader.indexOf("if (sending) return value;")).toBeLessThan(reader.indexOf('if (question.masked) field.value = "";'));
  });
});

describe("cards that offer to try again on the page (M18)", () => {
  it("a refused Slack token says nothing of running agentx init again, and says nothing was saved once", () => {
    expect(slackAppCard({ stage: "refused", problem: "Slack bots.info did not return the app id (no app_id); run agentx init again" }).lines)
      .toEqual(["Slack bots.info did not return the app id (no app_id)", "Nothing was saved."]);
    expect(slackAppCard({ stage: "refused", problem: "nothing was saved; copy the Bot User OAuth Token from the AgentX app in the right workspace, then run agentx init again" }).lines)
      .toEqual(["nothing was saved; copy the Bot User OAuth Token from the AgentX app in the right workspace"]);
    expect(slackAppCard({ stage: "refused", problem: "that token belongs to Slack workspace T0OTHER, but this install uses T0TEAM; nothing was saved" }).lines)
      .toEqual(["that token belongs to Slack workspace T0OTHER, but this install uses T0TEAM; nothing was saved"]);
    expect(slackAppCard({ stage: "refused", problem: "Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions" }).lines)
      .toEqual(["Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions", "Nothing was saved."]);
  });

  it("a failed Request URL check says to run the check again below, not agentx init", () => {
    const problem = "Slack has not verified https://abc.execute-api.us-east-1.amazonaws.com/slack/events. On https://api.slack.com/apps/A0APP/event-subscriptions, press Retry; if it still fails, look for invalid_signature in the control plane's SlackIngress logs, then run agentx init again";
    const failed = slackUrlsCard({ stage: "failed", pageUrl: "https://api.slack.com/apps/A0APP/event-subscriptions", problem });
    expect(failed.lines).toEqual(["Slack's check of the address did not pass.", "Fix it, then choose Check again below."]);
    expect(failed.link).toEqual({ url: "https://api.slack.com/apps/A0APP/event-subscriptions", label: "Open Event Subscriptions" });
    expect(failed.details).toEqual([problem]);
    expect(JSON.stringify(failed.lines)).not.toContain("run agentx init again");
  });
});

const WHERE = { channelName: "payments", channelId: "C0PAY00001", teamId: "T0123456789" };

describe("the finishing cards", () => {
  it("admin: the new user, the sign-in wait, a failed sign-in, and who signed in", () => {
    expect(adminCard({ stage: "signing-in", who: "alice@example.com", passwordEmail: "alice@example.com" })).toEqual({
      id: "admin", title: "Your AgentX sign-in", status: "waiting",
      lines: [
        "First, check your email at alice@example.com for your temporary password. It comes from no-reply@verificationemail.com with the subject \"Your temporary password\", can take a few minutes, and often lands in Spam. It works for 7 days.",
        "Then press Sign in, enter alice@example.com and the temporary password, and choose your own password. This page moves on by itself when you have.",
      ],
    });
    expect(adminCard({ stage: "signing-in", who: "alice@example.com" }).lines).toHaveLength(1);
    expect(adminCard({ stage: "failed", problem: "the AgentX sign-in did not finish within 10 minutes" })).toMatchObject({ status: "failed", lines: ["the AgentX sign-in did not finish within 10 minutes", "Choose Sign in again below."] });
    expect(adminCard({ stage: "done", username: "alice@example.com" })).toMatchObject({ status: "ok", lines: ["You are signed in to AgentX as alice@example.com."] });
  });

  it("project and channel", () => {
    expect(projectCard({ name: "payments-api", revision: 1, repository: "acme/payments-api" })).toEqual({
      id: "project", title: "Your first project", status: "ok",
      lines: ["The project payments-api is set up for acme/payments-api."],
      details: ["Project revision 1"],
    });
    expect(projectCard({ name: "payments-api", revision: 2 }).lines).toEqual(["The project payments-api is set up."]);
    expect(channelCard({ stage: "waiting", channelName: "payments", botName: "agentx-acme-staging" })).toEqual({
      id: "channel", title: "Slack channel", status: "waiting",
      lines: [
        "AgentX's bot cannot see #payments yet.",
        "If #payments is private, invite the bot in it with the command below. If it does not exist yet, create it in Slack.",
        "This page moves on by itself when the bot can see it (up to 10 minutes).",
      ],
      commands: [{ label: "Invite the bot", command: "/invite @agentx-acme-staging" }],
    });
    expect(channelCard({ stage: "done", channelName: "payments", projectName: "payments-api" })).toMatchObject({ status: "ok", lines: ["AgentX answers in #payments for payments-api."] });
  });

  it("a channel wait that timed out is failed, with the problem whole, since the page offers no retry", () => {
    const problem = "the bot cannot see a channel named #payments after 10 minutes; create it in Slack (or invite the bot to it, if it is private), then run this again";
    expect(channelCard({ stage: "failed", channelName: "payments", problem })).toEqual({ id: "channel", title: "Slack channel", status: "failed", lines: ["AgentX's bot still cannot see #payments."], details: [problem] });
  });

  it("a GitHub App wait that failed is failed, with the problem whole and no link", () => {
    const problem = "the GitHub App was not installed on acme within 15 minutes; install it at https://github.com/apps/agentx-acme-staging/installations/new, then run agentx init again";
    expect(githubCard({ stage: "failed", problem })).toEqual({ id: "github", title: "GitHub app", status: "failed", lines: ["The GitHub app was not set up."], details: [problem] });
  });

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

  it("I1: alerts while the test alarm is out, and a test alarm that failed", () => {
    expect(alertsCard({ stage: "testing", shownAs: "ops@example.com" })).toEqual({
      id: "alerts", title: "Alerts", status: "waiting",
      lines: ["Alerts go to ops@example.com. AgentX sent a test alert; answer below whether it arrived."],
    });
    const problem = "the test alarm did not arrive; check the subscription is confirmed and your spam folder, then run agentx alerts test";
    expect(alertsCard({ stage: "failed", problem })).toEqual({ id: "alerts", title: "Alerts", status: "failed", lines: ["The test alert could not be sent."], details: [problem] });
  });

  it("the test reply: how to mention the bot, a link to the channel, and what to fix", () => {
    expect(slackChannelLink("T0123456789", "C0PAY00001")).toBe("https://slack.com/app_redirect?team=T0123456789&channel=C0PAY00001");
    expect(replyCard({ stage: "waiting", ...WHERE, botName: "agentx-acme-staging", minutes: 10 })).toEqual({
      id: "reply", title: "First reply", status: "waiting",
      lines: [
        'In #payments, post a message that mentions @agentx-acme-staging, for example "@agentx-acme-staging what can you do?".',
        "Type @ and pick agentx-acme-staging from Slack's list. If you see two bots with similar names, pick agentx-acme-staging.",
        "Waiting up to 10 minutes for AgentX to reply in the thread. This page moves on by itself.",
      ],
      link: { url: "https://slack.com/app_redirect?team=T0123456789&channel=C0PAY00001", label: "Open #payments in Slack" },
    });
    expect(replyCard({ stage: "failed", ...WHERE, problem: "no AgentX reply in #payments within 10 minutes" })).toMatchObject({
      status: "failed", lines: ["AgentX did not reply.", "When it is fixed, choose Watch again below."], details: ["no AgentX reply in #payments within 10 minutes"],
    });
    expect(replyCard({ stage: "done", channelName: "payments", seconds: 12 })).toMatchObject({ status: "ok", lines: ["AgentX replied in #payments in 12 seconds."] });
  });

  it("R2: a failed test reply shows plain words on the page, and keeps the raw problem in its details", () => {
    const problem = "the bot is not in #payments; invite it, then run agentx --env staging init again";
    const failed = replyCard({ stage: "failed", ...WHERE, problem });
    expect(failed.lines).toEqual(["AgentX did not reply.", "When it is fixed, choose Watch again below."]);
    expect(failed.details).toEqual([problem]);
    expect(JSON.stringify(failed.lines)).not.toContain("init again");
  });

  it("R2: onPageProblem also strips a closing run agentx --env <env> init again", () => {
    expect(onPageProblem("Slack refused conversations.history (missing_scope), fix it, then run agentx --env staging init again"))
      .toBe("Slack refused conversations.history (missing_scope), fix it");
    expect(onPageProblem("no AgentX reply in #payments within 10 minutes; check the worker logs, then run agentx --env staging init again."))
      .toBe("no AgentX reply in #payments within 10 minutes; check the worker logs");
    expect(onPageProblem("Slack said ratelimited; run agentx --env prod-eu init again")).toBe("Slack said ratelimited");
  });

  it("M1: the admin card drops a failed sign-in's closing run agentx init again, since the page offers to sign in again", () => {
    expect(adminCard({ stage: "failed", problem: "your sign-in token has no email or sub claim; fix it, then run agentx init again" }).lines[0])
      .toBe("your sign-in token has no email or sub claim; fix it");
  });

  it("M2: an admin card the page offers no retry for keeps the problem whole in its details, and asks nothing", () => {
    expect(adminCard({ stage: "failed", problem: "your sign-in token has no email or sub claim; fix it, then run agentx init again", retry: false }))
      .toEqual({ id: "admin", title: "Your AgentX sign-in", status: "failed", lines: ["The sign-in did not finish."], details: ["your sign-in token has no email or sub claim; fix it, then run agentx init again"] });
  });

});

const FROM_SOURCE = { published: false, cliPath: "/opt/agentx/dist/main.js" };
const READY_PROGRESS = {
  ...emptyProgress("staging", 0),
  slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT", botName: "agentx-acme-staging" },
  project: { name: "payments-api", revision: 1, channelName: "payments", channelId: "C0PAY00001", teamId: "T0TEAM" },
};

describe("spec 048 the ready screen", () => {
  it("FR-059 and #222: says how to try AgentX by name, and gives commands that work as shown, each with --env", () => {
    const card = readyCard({
      env: "staging", controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com", progress: READY_PROGRESS, botName: "agentx-acme-staging",
      invocation: FROM_SOURCE, root: false, alertsOn: true, created: ["agentx-staging-access"], logPath: "/home/a/.agentx/logs/init-staging.log",
    });
    expect(card.lines).toEqual([
      "Try it: in #payments, mention @agentx-acme-staging and ask it something.",
      "Send your developers the sign-in command below. They run it once, then use AgentX from Claude Code, Codex or Cursor.",
      "The AgentX CLI is not published yet, so this command works on this computer. Other computers need their own copy of the AgentX CLI first.",
      "No issue trackers connected yet.",
      "Everything here is also in /home/a/.agentx/logs/init-staging.log.",
    ]);
    expect(card.commands).toEqual([
      { label: "Developer sign-in", command: "node /opt/agentx/dist/main.js login https://abc.execute-api.us-east-1.amazonaws.com", group: "Invite your developers" },
      { label: "Check the install", command: "node /opt/agentx/dist/main.js --env staging doctor", group: "Look after it" },
      { label: "Connect an issue tracker", command: "node /opt/agentx/dist/main.js --env staging connector add linear --project payments-api", group: "Look after it" },
      { label: "Add a project", command: "node /opt/agentx/dist/main.js --env staging project add", group: "Look after it" },
      { label: "Send a test alert", command: "node /opt/agentx/dist/main.js --env staging alerts test", group: "Look after it" },
      { label: "Remove AgentX", command: "node /opt/agentx/dist/main.js --env staging destroy", group: "Look after it" },
    ]);
    expect(card.details).toEqual(["What was created: agentx-staging-access"]);
    expect(lintCopy([
      ...cardEntries(card).map((entry) => ({ ...entry, context: entry.context === "page" ? ("ready" as const) : entry.context })),
      ...(card.commands ?? []).map((command) => ({ where: "ready", text: command.command, context: "ready" as const })),
    ])).toEqual([]);
  });

  it("FR-016: names the commands that need an admin user when the install ran as root", () => {
    const card = readyCard({
      env: "staging", controlPlaneUrl: "https://abc.example.com", progress: READY_PROGRESS, botName: "agentx-acme-staging",
      invocation: FROM_SOURCE, root: true, alertsOn: true, created: [],
    });
    expect(card.lines).toContain("You installed as the AWS root user. The day-two commands below need an admin user: AWS does not let the root user use the AgentX operator role.");
  });

  it("names the published package only when the CLI is the published one", () => {
    const card = readyCard({
      env: "staging", controlPlaneUrl: "https://abc.example.com", progress: READY_PROGRESS, botName: "agentx-acme-staging",
      invocation: { published: true, version: "1.2.3", cliPath: "/x" }, root: false, alertsOn: true, created: [],
    });
    expect(card.commands?.[0]?.command).toBe("npx @preplabsai/rovara-code@1.2.3 login https://abc.example.com");
    expect(card.lines.join(" ")).not.toContain("not published");
  });
});
