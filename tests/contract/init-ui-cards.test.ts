// Spec 040 phase 2: the status cards and the one "open this" link the page shows beside the
// question, and the rules that keep a link, or a secret, from reaching the page by accident.
import { describe, expect, it } from "vitest";
import { slackAppCard, slackUrlsCard } from "../../packages/cli/src/init/ui/cards.js";
import { startInstallWizard } from "../../packages/cli/src/init/ui/index.js";
import { WIZARD_JS, wizardHtml } from "../../packages/cli/src/init/ui/page.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";
import { createWizardHub, isShowableLink, LINK_REFUSED } from "../../packages/cli/src/init/ui/state.js";

const card = (overrides: Partial<WizardCard> = {}): WizardCard => ({ id: "github", title: "GitHub App", status: "waiting", lines: ["one"], ...overrides });

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
      expect(wizard.hub.state().link).toEqual({ url: "https://github.com/apps/agentx-acme-staging/installations/new", label: "Open github.com" });
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

  it("clears the run's link when its step ends, or when the next one starts", () => {
    const hub = createWizardHub("staging");
    hub.setSteps([{ id: "github-app", title: "Create and install the GitHub App" }, { id: "control-plane", title: "Deploy the control plane and runtime" }]);
    hub.showLink({ url: "https://github.com/apps/agentx-acme-staging/installations/new", label: "Open github.com" });
    expect(hub.state().link).toEqual({ url: "https://github.com/apps/agentx-acme-staging/installations/new", label: "Open github.com" });
    hub.applyEvent({ kind: "step-done", id: "github-app", title: "Create and install the GitHub App" });
    expect(hub.state().link).toBeUndefined();
    hub.showLink({ url: "https://api.slack.com/apps", label: "Open api.slack.com" });
    hub.applyEvent({ kind: "step-started", id: "control-plane", title: "Deploy the control plane and runtime" });
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
    expect(WIZARD_JS).toContain("renderCards(state.cards, state.link);");
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
    const failed = slackUrlsCard({
      stage: "failed", pageUrl: "https://api.slack.com/apps/A0APP/event-subscriptions",
      problem: "Slack has not verified https://abc.execute-api.us-east-1.amazonaws.com/slack/events. On https://api.slack.com/apps/A0APP/event-subscriptions, press Retry; if it still fails, look for invalid_signature in the control plane's SlackIngress logs, then run agentx init again",
    });
    expect(failed.lines).toEqual([
      "Slack has not verified https://abc.execute-api.us-east-1.amazonaws.com/slack/events. On https://api.slack.com/apps/A0APP/event-subscriptions, press Retry; if it still fails, look for invalid_signature in the control plane's SlackIngress logs",
      "Fix it, then answer Yes below to run the check again.",
    ]);
    expect(failed.link).toEqual({ url: "https://api.slack.com/apps/A0APP/event-subscriptions", label: "Open Event Subscriptions" });
    expect(JSON.stringify(failed)).not.toContain("run agentx init again");
  });
});
