// Spec 040 phase 3: each finishing step on the install page. The steps are the ones agentx init
// already runs (phase 15d2); these tests check what each shows on the page, and that a wait that
// fails can be tried again there, while the terminal path stops exactly as it did.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { adminUserStep, alertsStep, e2eStep, firstProjectStep } from "../../packages/cli/src/init/finish-steps.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { problemText } from "../../packages/cli/src/init/retry.js";
import { alertsCard, channelCard, projectCard } from "../../packages/cli/src/init/ui/cards.js";
import { startInstallWizard } from "../../packages/cli/src/init/ui/index.js";
import type { WizardCard, WizardLink } from "../../packages/cli/src/init/ui/protocol.js";
import { initContext, memoryInitSecrets, progressHandle, sampleAnswers, scriptedPrompter, T0, TEST_BOT_TOKEN, TEST_SIGNING_SECRET, type TestInitContext } from "../support/init-fakes.js";
import { accessToken, ADMIN_EMAIL, ALERTS_TOPIC_ARN, CONTROL_PLANE, fakeAlerts, fakeCognito, fakeControlPlane, fakeSlackChannels, setupServices, STAGING_SETTINGS, turn } from "../support/setup-fakes.js";

let context: TestInitContext | undefined;
afterEach(async () => { if (context !== undefined) await rm(context.home, { recursive: true, force: true }); context = undefined; });
const page = () => { const cards: WizardCard[] = []; return { cards, card: (card: WizardCard) => { cards.push(card); } }; };
const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "t" };
const TIMED_OUT = agentXError("OPERATION_INTERRUPTED", "the AgentX sign-in did not finish within 10 minutes; run agentx init again and finish signing in as the admin user in the browser");

describe("the admin user on the page (FR-050)", () => {
  it("shows the new admin user and the sign-in wait, then who signed in", async () => {
    const surface = page();
    context = initContext({ prompter: scriptedPrompter([ADMIN_EMAIL]), surface, setup: setupServices({ cognito: fakeCognito() }), adminSession: async () => session });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    expect(await adminUserStep().run(context, progressHandle())).toEqual({ status: "done", note: `admin ${ADMIN_EMAIL}` });
    expect(surface.cards.map((card) => [card.id, card.status, card.lines])).toEqual([
      ["admin", "waiting", [
        `AgentX made your admin sign-in for ${ADMIN_EMAIL}. Look for an email with your temporary password; you choose your own when you first sign in.`,
        `Sign in to AgentX as ${ADMIN_EMAIL} in the tab the Sign in button opens. This page moves on by itself when you have.`,
      ]],
      ["admin", "ok", [`You are signed in to AgentX as ${ADMIN_EMAIL}.`]],
    ]);
  });

  it("Review Focus 5: a sign-in that timed out can be tried again on the page", async () => {
    const surface = page();
    let sessions = 0;
    context = initContext({
      prompter: scriptedPrompter([ADMIN_EMAIL, true]), surface, setup: setupServices({ cognito: fakeCognito() }),
      adminSession: async () => { sessions += 1; if (sessions === 1) throw TIMED_OUT; return session; },
    });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    await adminUserStep().run(context, progressHandle());
    expect(sessions).toBe(2);
    expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual(["Your email address, for your AgentX admin user", "Sign in again?"]);
    expect(surface.cards.find((card) => card.status === "failed")?.lines[0]).toBe("the AgentX sign-in did not finish within 10 minutes; run agentx init again and finish signing in as the admin user in the browser");
    expect(surface.cards.map((card) => [card.id, card.status])).toEqual([["admin", "waiting"], ["admin", "failed"], ["admin", "waiting"], ["admin", "ok"]]);
  });

  it("a failed sign-in's button leaves the page while Sign in again? is asked, and the retry's own button appears", async () => {
    const wizard = await startInstallWizard({ env: "staging", write: () => undefined });
    try {
      let sessions = 0;
      const linkWhenAsked: Array<WizardLink | undefined> = [];
      const prompter = scriptedPrompter([ADMIN_EMAIL, true]);
      const watching = { ...prompter, confirm: async (...args: Parameters<typeof prompter.confirm>) => { linkWhenAsked.push(wizard.hub.state().link); return prompter.confirm(...args); } };
      context = initContext({
        prompter: watching, surface: wizard.surface, setup: setupServices({ cognito: fakeCognito() }),
        // As context.adminSession does on the page: the sign-in address becomes the page's button.
        adminSession: async () => {
          sessions += 1;
          await wizard.openLink(`https://login.example.com/authorize?attempt=${sessions}`);
          if (sessions === 1) throw TIMED_OUT;
          return session;
        },
      });
      await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
      await adminUserStep().run(context, progressHandle());
      expect(prompter.asked).toEqual(["Your email address, for your AgentX admin user", "Sign in again?"]);
      expect(linkWhenAsked).toEqual([undefined]);
      expect(wizard.hub.state().link?.url).toBe("https://login.example.com/authorize?attempt=2");
    } finally {
      await wizard.close();
    }
  });

  describe("with your own OIDC provider (M2)", () => {
    const OIDC_SETTINGS = { ...STAGING_SETTINGS, identity: { mode: "oidc" as const, issuer: "https://login.example.com", audience: "agentx", clientId: "cli" } };
    const oidcAnswers = sampleAnswers({ identity: { mode: "oidc", issuer: "https://login.example.com", audience: "agentx", clientId: "cli", adminClaim: "groups", adminValues: ["agentx-admins"] } });

    it("shows the sign-in wait for an administrator of your company's sign-in, then who signed in", async () => {
      const surface = page();
      const token = accessToken({ sub: "00u1abcd", email: "bob@example.com", groups: ["agentx-admins"] });
      context = initContext({ answers: oidcAnswers, prompter: scriptedPrompter([]), surface, adminSession: async () => ({ controlPlaneUrl: CONTROL_PLANE, accessToken: token }) });
      await writeEnvironmentSettings(context.store, OIDC_SETTINGS);
      expect(await adminUserStep().run(context, progressHandle())).toEqual({ status: "done", note: "admin bob@example.com signed in with your OIDC provider" });
      expect(surface.cards.map((card) => [card.id, card.status, card.lines])).toEqual([
        ["admin", "waiting", ["Sign in to AgentX as an administrator of your company's sign-in in the tab the Sign in button opens. This page moves on by itself when you have."]],
        ["admin", "ok", ["You are signed in to AgentX as bob@example.com."]],
      ]);
    });

    it("a token with no email or sub claim shows a failed admin card, and the step rejects with that error", async () => {
      const surface = page();
      const token = accessToken({ groups: ["agentx-admins"] });
      context = initContext({ answers: oidcAnswers, prompter: scriptedPrompter([]), surface, adminSession: async () => ({ controlPlaneUrl: CONTROL_PLANE, accessToken: token }) });
      await writeEnvironmentSettings(context.store, OIDC_SETTINGS);
      const failure = await adminUserStep().run(context, progressHandle()).then(() => undefined, (error: unknown) => error);
      expect((failure as Error).message).toContain("your sign-in token has no email or sub claim of 3 to 128 characters");
      expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual([]);
      expect(surface.cards.map((card) => [card.id, card.status])).toEqual([["admin", "waiting"], ["admin", "failed"]]);
      expect(surface.cards[1]?.lines).toEqual(["The sign-in did not finish."]);
      expect(surface.cards[1]?.details).toEqual([problemText(failure)]);
    });

    it("a token the page cannot retry drops the sign-in's button when the failed card shows", async () => {
      const wizard = await startInstallWizard({ env: "staging", write: () => undefined });
      try {
        const token = accessToken({ groups: ["agentx-admins"] });
        context = initContext({
          answers: oidcAnswers, prompter: scriptedPrompter([]), surface: wizard.surface,
          adminSession: async () => { await wizard.openLink("https://login.example.com/authorize"); return { controlPlaneUrl: CONTROL_PLANE, accessToken: token }; },
        });
        await writeEnvironmentSettings(context.store, OIDC_SETTINGS);
        await expect(adminUserStep().run(context, progressHandle())).rejects.toThrow("your sign-in token has no email or sub claim");
        expect(wizard.hub.state().cards?.find((card) => card.id === "admin")?.status).toBe("failed");
        expect(wizard.hub.state().link).toBeUndefined();
      } finally {
        await wizard.close();
      }
    });
  });

  it("the terminal path stops on a timed-out sign-in, as before", async () => {
    context = initContext({ prompter: scriptedPrompter([ADMIN_EMAIL]), setup: setupServices({ cognito: fakeCognito() }), adminSession: async () => { throw TIMED_OUT; } });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    await expect(adminUserStep().run(context, progressHandle())).rejects.toBe(TIMED_OUT);
    expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual(["Your email address, for your AgentX admin user"]);
  });
});

describe("the first project on the page, resumed (M6)", () => {
  it("an earlier run's project is shown without its repository, then its channel, with no invite wait", async () => {
    const surface = page();
    const slackChannels = fakeSlackChannels([]);
    context = initContext({ prompter: scriptedPrompter([]), surface, setup: setupServices({ slackChannels }), adminSession: async () => session });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    const progress = progressHandle({
      ...emptyProgress("staging", T0),
      slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001" },
      project: { name: "payments-api", revision: 1, channelName: "payments", channelId: "C0PAY00001", teamId: "T0123456789" },
    });
    expect(await firstProjectStep().run(context, progress)).toEqual({ status: "done", note: "project payments-api in #payments" });
    expect(surface.cards).toEqual([
      projectCard({ name: "payments-api", revision: 1 }),
      channelCard({ stage: "done", channelName: "payments", projectName: "payments-api" }),
    ]);
    expect(surface.cards[0]?.lines).toEqual(["The project payments-api is set up."]);
    expect(slackChannels.finds()).toBe(0);
  });
});

describe("the first project's channel wait on the page", () => {
  const slackSecrets = () => memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ botToken: TEST_BOT_TOKEN, signingSecret: TEST_SIGNING_SECRET }) });
  const recordedProject = () => progressHandle({
    ...emptyProgress("staging", T0),
    slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001" },
    project: { name: "payments-api", revision: 1 },
  });

  it("an invite wait that times out shows the failed channel card with the problem, and the step rejects with that error", async () => {
    const surface = page();
    context = initContext({ prompter: scriptedPrompter(["payments"]), surface, secrets: slackSecrets(), setup: setupServices({ slackChannels: fakeSlackChannels([]) }), adminSession: async () => session });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    const failure = await firstProjectStep().run(context, recordedProject()).then(() => undefined, (error: unknown) => error);
    expect((failure as Error).message).toContain("the bot cannot see a channel named #payments after 10 minutes");
    expect(surface.cards).toEqual([
      projectCard({ name: "payments-api", revision: 1 }),
      channelCard({ stage: "waiting", channelName: "payments", botName: "agentx-acme-staging" }),
      channelCard({ stage: "failed", channelName: "payments", problem: problemText(failure) }),
    ]);
    expect(surface.cards[2]?.details).toEqual(["the bot cannot see a channel named #payments after 10 minutes; create it in Slack (or invite the bot to it, if it is private), then run this again"]);
  });

  it("a failure before the invite wait shows no channel card", async () => {
    const surface = page();
    context = initContext({ prompter: scriptedPrompter([]), surface, secrets: slackSecrets(), flags: { channel: "not a channel!" }, setup: setupServices({ slackChannels: fakeSlackChannels([]) }), adminSession: async () => session });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    await expect(firstProjectStep().run(context, recordedProject())).rejects.toThrow("--channel must be a Slack channel name");
    expect(surface.cards).toEqual([projectCard({ name: "payments-api", revision: 1 })]);
  });
});

describe("the alerts on the page", () => {
  const TOPIC = ALERTS_TOPIC_ARN;
  const setupFor = (alerts: ReturnType<typeof fakeAlerts>) => setupServices({ alerts, stackOutputs: async () => ({ OperatorAlertsTopicArn: TOPIC }) });
  const answers = sampleAnswers({ alert: { kind: "email", address: "ops@example.com" } });

  it("Review Focus 4: waits on the page for the confirmation, checks again without subscribing twice, then sends the test alarm", async () => {
    const surface = page();
    const alerts = fakeAlerts({ confirmAfterPolls: 1_000_000, budgetUsd: 100 });
    const base = scriptedPrompter([true, true]);
    // The operator confirms the email while the card is up, then answers Yes.
    const prompter = { ...base, confirm: async (question: string, options: { defaultValue: boolean }) => { if (question.startsWith("Have you confirmed")) alerts.confirmAll(); return base.confirm(question, options); } };
    context = initContext({ answers, prompter, surface, setup: setupFor(alerts) });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    expect(await alertsStep().run(context, progressHandle())).toEqual({ status: "done", note: "alerts to ops@example.com, test alarm received" });
    expect(alerts.subscribed).toHaveLength(1);
    expect(base.asked[0]).toBe("Have you confirmed the subscription? Answer Yes to check again.");
    // The run's own 10-minute wait, then the confirm card after it, then the test alarm, then done.
    expect(surface.cards.map((card) => card.status)).toEqual(["waiting", "waiting", "waiting", "ok"]);
    expect(surface.cards[0]?.lines).toEqual(alertsCard({ stage: "waiting", shownAs: "ops@example.com" }).lines);
    expect(surface.cards[1]?.lines).toEqual(alertsCard({ stage: "confirm", shownAs: "ops@example.com" }).lines);
    expect(surface.cards[2]?.lines).toEqual(alertsCard({ stage: "testing", shownAs: "ops@example.com" }).lines);
  });

  it("I1: a test alarm that did not arrive shows a failed alerts card, and the step fails as on the terminal", async () => {
    const surface = page();
    const alerts = fakeAlerts({ confirmAfterPolls: 0, budgetUsd: 100 });
    context = initContext({ answers, prompter: scriptedPrompter([false]), surface, setup: setupFor(alerts) });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    const failure = await alertsStep().run(context, progressHandle()).then(() => undefined, (error: unknown) => error);
    const terminal = initContext({ answers, prompter: scriptedPrompter([false]), setup: setupFor(fakeAlerts({ confirmAfterPolls: 0, budgetUsd: 100 })) });
    await writeEnvironmentSettings(terminal.store, STAGING_SETTINGS);
    const terminalFailure = await alertsStep().run(terminal, progressHandle()).then(() => undefined, (error: unknown) => error);
    await rm(terminal.home, { recursive: true, force: true });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe((terminalFailure as Error).message);
    expect(surface.cards.map((card) => [card.id, card.status])).toEqual([["alerts", "waiting"], ["alerts", "failed"]]);
    expect(surface.cards[0]?.lines).toEqual(alertsCard({ stage: "testing", shownAs: "ops@example.com" }).lines);
    expect(surface.cards[1]?.lines).toEqual(["The test alert could not be sent."]);
    expect(surface.cards[1]?.details).toEqual([problemText(failure)]);
  });

  it("I1: a test alarm CloudWatch did not record shows a failed alerts card, and the step rejects with that error", async () => {
    const surface = page();
    const alerts = fakeAlerts({ confirmAfterPolls: 0, historyEmpty: true, budgetUsd: 100 });
    context = initContext({ answers, prompter: scriptedPrompter([]), surface, setup: setupFor(alerts) });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    const failure = await alertsStep().run(context, progressHandle()).then(() => undefined, (error: unknown) => error);
    expect((failure as Error).message).toContain("CloudWatch did not record the test alarm going off");
    expect(surface.cards.map((card) => [card.id, card.status])).toEqual([["alerts", "waiting"], ["alerts", "failed"]]);
    expect(surface.cards[1]?.lines).toEqual(["The test alert could not be sent."]);
    expect(surface.cards[1]?.details).toEqual([problemText(failure)]);
  });

  it("the terminal path still stops and says to run agentx init again when nobody has confirmed", async () => {
    const alerts = fakeAlerts({ confirmAfterPolls: 1_000_000, budgetUsd: 100 });
    context = initContext({ answers, prompter: scriptedPrompter([]), setup: setupFor(alerts) });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    const outcome = await alertsStep().run(context, progressHandle());
    expect(outcome).toMatchObject({ status: "waiting" });
  });

  it("saying no on the page stops the same way", async () => {
    const surface = page();
    const alerts = fakeAlerts({ confirmAfterPolls: 1_000_000, budgetUsd: 100 });
    context = initContext({ answers, prompter: scriptedPrompter([false]), surface, setup: setupFor(alerts) });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    expect(await alertsStep().run(context, progressHandle())).toMatchObject({ status: "waiting" });
    expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual(["Have you confirmed the subscription? Answer Yes to check again."]);
    expect(surface.cards.map((card) => card.status)).toEqual(["waiting", "waiting"]);
  });

  it("--no-alerts shows that there is no alert address yet", async () => {
    const surface = page();
    context = initContext({ answers: sampleAnswers({ alert: { kind: "none" } }), prompter: scriptedPrompter([]), surface, setup: setupFor(fakeAlerts()) });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    expect(await alertsStep().run(context, progressHandle())).toMatchObject({ status: "done" });
    expect(surface.cards).toEqual([alertsCard({ stage: "none" })]);
  });
});

describe("the test reply on the page (FR-051)", () => {
  const progress = () => progressHandle({
    ...emptyProgress("staging", T0),
    slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001" },
    project: { name: "payments-api", revision: 1, channelName: "payments", channelId: "C0PAY00001", teamId: "T0123456789" },
  });
  const SUBJECT = "T0123456789/C0PAY00001/1790000000.000100";

  it("shows how to mention the bot and a link to the channel, then the reply", async () => {
    const surface = page();
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: SUBJECT, receivedAt: new Date(T0 + 2000).toISOString(), disposition: "answered", durationMs: 12_000 })];
    context = initContext({ surface, setup: setupServices({ fetch: plane.fetch }), adminSession: async () => session });
    await e2eStep().run(context, progress());
    expect(surface.cards.map((card) => [card.status, card.link?.url])).toEqual([
      ["waiting", "https://slack.com/app_redirect?team=T0123456789&channel=C0PAY00001"],
      ["ok", undefined],
    ]);
    expect(surface.cards[0]?.lines[1]).toContain("pick agentx");
  });

  it("Review Focus 1: counts a mention made just before the watch started", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: SUBJECT, receivedAt: new Date(T0 - 3000).toISOString(), disposition: "answered", durationMs: 9_000 })];
    context = initContext({ surface: page(), setup: setupServices({ fetch: plane.fetch }), adminSession: async () => session });
    expect(await e2eStep().run(context, progress())).toEqual({ status: "done", note: "a mention in #payments got a threaded reply in 9 seconds" });
  });

  it("Review Focus 3: a second watch does not fail on the turn the first one reported, and waits for a new mention", async () => {
    const surface = page();
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: SUBJECT, receivedAt: new Date(T0 + 2000).toISOString(), disposition: "error" })];
    const base = scriptedPrompter([true]);
    const prompter = { ...base, confirm: async (question: string, options: { defaultValue: boolean }) => {
      // The operator fixes the problem and mentions the bot again before answering Yes.
      plane.turns.push(turn({ subject: "T0123456789/C0PAY00001/1790000100.000100", receivedAt: new Date((context?.now() ?? T0) + 1000).toISOString(), disposition: "answered", durationMs: 7_000 }));
      return base.confirm(question, options);
    } };
    context = initContext({ prompter, surface, setup: setupServices({ fetch: plane.fetch }), adminSession: async () => session });
    expect(await e2eStep().run(context, progress())).toEqual({ status: "done", note: "a mention in #payments got a threaded reply in 7 seconds" });
    expect(base.asked).toEqual(["Watch for the reply again?"]);
    expect(surface.cards.find((card) => card.status === "failed")?.details?.[0]).toContain("but the turn ended as error");
    // Ruling R2: on the page the card says to answer Yes below, not to run init again.
    expect(surface.cards.find((card) => card.status === "failed")?.lines.join(" ")).not.toContain("init again");
  });

  it("without a page, a failed reply still stops with what to fix", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: SUBJECT, receivedAt: new Date(T0 + 2000).toISOString(), disposition: "error" })];
    context = initContext({ setup: setupServices({ fetch: plane.fetch }), adminSession: async () => session });
    await expect(e2eStep().run(context, progress())).rejects.toThrow("but the turn ended as error; see agentx --env staging admin turns export --since 15m, fix it, then run agentx --env staging init again");
  });
});
