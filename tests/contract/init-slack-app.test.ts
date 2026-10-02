import { createHmac } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createSlackIngressHandler } from "../../packages/broker/src/aws/slack-ingress.js";
import { createSlackInteractivityHandler } from "../../packages/broker/src/aws/slack-interactivity.js";
import {
  botNameOf, missingScopes, probeSlackUrls, readSlackTeamIdFromSecret, SIGN_IN_BOT_SCOPES, signSlackRequest, slackAppManifest, slackAppStep, slackBotDisplayName, slackCreateAppUrl,
  slackSecretName, slackSecretWithBot, SlackTeamIdError, slackSecretWithSignIn, slackSignInCallbackUrl, slackValuesFields, SLACK_VALUES_TITLE, slackWebApi, verifySlackUrls,
} from "../../packages/cli/src/init/slack-app.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import {
  allStackOutputs, fakeSlackApi, initContext, memoryInitSecrets, progressHandle, scriptedDeployer, scriptedPrompter, slackIngressFetch, T0, TEST_BOT_TOKEN, TEST_SIGNING_SECRET, type TestInitContext,
} from "../support/init-fakes.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";
import { browserPrompter } from "../../packages/cli/src/init/ui/prompter.js";
import { createWizardHub, type WizardHub } from "../../packages/cli/src/init/ui/state.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });
const EVENTS = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/slack/events";
const INTERACTIONS = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/slack/interactions";
const SIGNIN = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth/callback/slack";
const SLACK_SECRET = slackSecretName("staging");
/** What the control plane's generateSecretString leaves in the Slack secret before init puts real values: 32 mixed-case letters and digits. */
const PLACEHOLDER = "Qm7ZkX2pLr9TbV4nHs8WcY3dJf6GtA1e";

/** A context whose control plane is deployed and whose Slack secret exists with the control plane's placeholder. */
function slackContext(prompts: Array<string | boolean>, extra: Parameters<typeof initContext>[0] = {}) {
  const outputs = allStackOutputs();
  const deployer = scriptedDeployer(outputs, Object.keys(outputs));
  const secrets = memoryInitSecrets({ [SLACK_SECRET]: JSON.stringify({ botToken: "unset", signingSecret: PLACEHOLDER }) });
  const context = initContext({ prompter: scriptedPrompter(prompts), secrets, ...extra });
  if (extra.answers === undefined) context.answers = { ...context.answers, signinMethods: "oidc" };
  context.deployment = async () => ({ deployer, store: context.store, secrets, holder: context.holder, partition: "aws", cleanup: async () => undefined });
  homes.push(context.home);
  return context;
}

function storedSlack(context: TestInitContext): { botToken: string; signingSecret: string } {
  return JSON.parse(context.secrets.values.get(SLACK_SECRET) ?? "{}") as { botToken: string; signingSecret: string };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

async function questionWhenAsked(hub: WizardHub, text: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const question = hub.state().question;
    if (question?.text === text) return question;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`question was not asked: ${text}`);
}

describe("Slack app manifest", () => {
  it("carries AgentX's bot scopes, the app_mention event and this environment's URLs", () => {
    expect(slackAppManifest({ appName: "AgentX", eventsUrl: EVENTS, interactivityUrl: INTERACTIONS, signInCallbackUrl: SIGNIN })).toEqual({
      display_information: { name: "AgentX", description: "AgentX: ask in Slack, and AgentX works in your repositories and trackers." },
      features: { bot_user: { display_name: "agentx", always_online: true } },
      oauth_config: {
        redirect_urls: [SIGNIN],
        scopes: {
          bot: ["app_mentions:read", "channels:join", "channels:read", "chat:write", "groups:read", "im:write", "users:read", "users:read.email"],
          user: ["email", "openid", "profile"],
        },
      },
      settings: {
        event_subscriptions: { request_url: EVENTS, bot_events: ["app_mention"] },
        interactivity: { is_enabled: true, request_url: INTERACTIONS },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
  });

  it("derives a valid bot display name from any app name", () => {
    expect(slackBotDisplayName("AgentX Staging!")).toBe("agentx-staging");
    expect(slackBotDisplayName("***")).toBe("agentx");
  });

  it("opens Slack's create-from-manifest page with the manifest", () => {
    const manifest = slackAppManifest({ appName: "AgentX", eventsUrl: EVENTS, interactivityUrl: INTERACTIONS, signInCallbackUrl: SIGNIN });
    const url = new URL(slackCreateAppUrl(manifest));
    expect(`${url.origin}${url.pathname}`).toBe("https://api.slack.com/apps");
    expect(url.searchParams.get("new_app")).toBe("1");
    expect(JSON.parse(url.searchParams.get("manifest_json") ?? "")).toEqual(manifest);
  });

  it("signs a request exactly as the ingress verifies it", () => {
    const headers = signSlackRequest({ signingSecret: TEST_SIGNING_SECRET, body: "{}", timestampSeconds: 1_800_000_000 });
    expect(headers).toEqual({
      "x-slack-request-timestamp": "1800000000",
      "x-slack-signature": `v0=${createHmac("sha256", TEST_SIGNING_SECRET).update("v0:1800000000:{}").digest("hex")}`,
    });
  });
});

describe("the bot's display handle (FR-026, FR-027)", () => {
  it("uses the handle Slack reported, else derives one from the app name", () => {
    const withHandle = { ...emptyProgress("staging", T0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT", botName: "agentx-acme-staging" } };
    expect(botNameOf(withHandle, "AgentX acme (staging)")).toBe("agentx-acme-staging");
    const withoutHandle = { ...emptyProgress("staging", T0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" } };
    expect(botNameOf(withoutHandle, "AgentX acme (staging)")).toBe(slackBotDisplayName("AgentX acme (staging)"));
    expect(botNameOf(emptyProgress("staging", T0), "AgentX")).toBe("agentx");
  });

  it("spec 048 FR-026: uses the bot handle Slack assigned from then on", () => {
    const progress = { ...emptyProgress("staging", 0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT", botName: "agentx-acme-staging2" } };
    expect(botNameOf(progress, "AgentX acme (staging)")).toBe("agentx-acme-staging2");
    expect(botNameOf(emptyProgress("staging", 0), "AgentX acme (staging)")).toBe("agentx-acme-staging");
  });
});

describe("probing the Slack URLs", () => {
  const probe = (fetch: typeof globalThis.fetch, clock = { t: T0 }, lines: string[] = []) => probeSlackUrls({
    eventsUrl: EVENTS, interactivityUrl: INTERACTIONS, signingSecret: TEST_SIGNING_SECRET, fetch, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, write: (line) => lines.push(line),
  });

  it("retries while the ingress still holds the old secret, then passes both URLs", async () => {
    const fetch = slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET, staleFor: 3 });
    const lines: string[] = [];
    await probe(fetch, { t: T0 }, lines);
    expect(fetch.calls.filter((url) => url === EVENTS)).toHaveLength(4);
    expect(fetch.calls.at(-1)).toBe(INTERACTIONS);
    expect(lines).toEqual(["Waiting for the Slack ingress to pick up the new signing secret (it keeps the old one for up to 5 minutes)"]);
  });

  it("gives up after 7 minutes, suggesting the likeliest mistake", async () => {
    await expect(probe(slackIngressFetch({ signingSecret: "ffffffffffffffffffffffffffffffff" })))
      .rejects.toThrow(`${EVENTS} still refuses requests signed with the new signing secret after 7 minutes; check that you pasted the Signing Secret, not the Client Secret, and that this computer's clock is correct (Slack refuses signatures older than 5 minutes), then run agentx init again`);
  });

  it("passes the control plane's real ingress and interactivity handlers", async () => {
    const unused = () => { throw new Error("test setup: a URL check must not reach this"); };
    const secrets = async () => ({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });
    const ingress = createSlackIngressHandler({
      secrets, now: () => T0, getBinding: unused, claimEvent: unused, releaseEvent: unused, changePending: unused, enqueue: unused, postMessage: unused,
    });
    const interactivity = createSlackInteractivityHandler({ secrets, now: () => T0, handlers: [] });
    const statuses: number[] = [];
    const realIngress = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const target = requestUrl(url);
      const event = { headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === "string" ? init.body : "" };
      const answer = target === EVENTS ? await ingress(event) : await interactivity(event);
      statuses.push(answer.statusCode);
      return new Response(answer.body, { status: answer.statusCode });
    };
    await probe(realIngress);
    expect(statuses).toEqual([200, 200]);
  });

  it("refuses an interactivity URL that answers 403 or 404: a wrong route or stage", async () => {
    for (const status of [403, 404]) {
      const passing = slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET });
      const wrongRoute = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => (
        requestUrl(url) === INTERACTIONS ? new Response("Not Found", { status }) : passing(url, init)
      ), { calls: [] });
      await expect(probe(wrongRoute)).rejects.toThrow(`${INTERACTIONS} answered HTTP ${status}, so the route or stage is wrong; check that the Slack URLs come from this environment's control-plane stack outputs, then run agentx init again`);
    }
  });
});

describe("Slack Web API client", () => {
  it("calls auth.test and bots.info with the token as a bearer header", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const api = slackWebApi(async (url, init) => {
      seen.push({ url: requestUrl(url), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await api.authTest(TEST_BOT_TOKEN);
    await api.botsInfo(TEST_BOT_TOKEN, "B0BOT");
    expect(seen).toEqual([
      { url: "https://slack.com/api/auth.test", authorization: `Bearer ${TEST_BOT_TOKEN}` },
      { url: "https://slack.com/api/bots.info?bot=B0BOT", authorization: `Bearer ${TEST_BOT_TOKEN}` },
    ]);
  });

  it("reports an HTTP failure without the token", async () => {
    const api = slackWebApi(async () => new Response("", { status: 503 }));
    let message = "";
    try { await api.authTest(TEST_BOT_TOKEN); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Slack auth.test failed with HTTP 503");
    expect(message).not.toContain(TEST_BOT_TOKEN);
  });
});

describe("Slack app step", () => {
  it("stores the bot token and signing secret in the Slack secret and records the app, never printing either", async () => {
    const confirmations: Array<{ question: string; defaultValue: boolean }> = [];
    const prompter = { ...scriptedPrompter(["installed", `${TEST_SIGNING_SECRET}\n`, TEST_BOT_TOKEN]), confirm: async (question: string, options: { defaultValue: boolean }) => { confirmations.push({ question, defaultValue: options.defaultValue }); return true; } };
    const context = slackContext([], { prompter });
    const progress = progressHandle();
    expect(await slackAppStep(fakeSlackApi()).run(context, progress)).toMatchObject({ status: "done" });
    expect(storedSlack(context)).toEqual({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });
    expect(progress.value().slack).toEqual({ appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT", botName: "agentx", teamName: "Acme" });
    const printed = context.lines.join("\n");
    expect(printed).not.toContain(TEST_BOT_TOKEN);
    expect(printed).not.toContain(TEST_SIGNING_SECRET);
    expect(JSON.stringify(progress.value())).not.toContain(TEST_BOT_TOKEN);
    expect(JSON.stringify(progress.value())).not.toContain(TEST_SIGNING_SECRET);
    expect(context.opened[0]).toMatch(/^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
    expect(context.lines).toContain("Bot @agentx in workspace Acme (https://acme.slack.com/)");
    expect(confirmations).toEqual([{ question: "Is this the AgentX bot in the right workspace?", defaultValue: true }]);
  });

  it("records a workspace name Slack sends only within 1 to 100 characters, and a handle only in the stored pattern", async () => {
    const run = async (auth: { team: string; user: string }) => {
      const context = slackContext(["installed", TEST_SIGNING_SECRET, TEST_BOT_TOKEN, true]);
      const progress = progressHandle();
      const api = fakeSlackApi({ authTest: async () => ({ ok: true, user_id: "U0BOT", bot_id: "B0BOT", team_id: "T0TEAM", url: "https://acme.slack.com/", ...auth }) });
      expect(await slackAppStep(api).run(context, progress)).toMatchObject({ status: "done" });
      return progress.value().slack;
    };
    expect(await run({ team: "A".repeat(150), user: "agentx" })).toEqual({ appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT", botName: "agentx", teamName: "A".repeat(100) });
    expect(await run({ team: "", user: "AgentX Bot" })).toEqual({ appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" });
  });

  it("stores nothing when the engineer says the token is for the wrong bot or workspace", async () => {
    const context = slackContext(["installed", TEST_SIGNING_SECRET, TEST_BOT_TOKEN, false]);
    await expect(slackAppStep(fakeSlackApi()).run(context, progressHandle()))
      .rejects.toThrow("nothing was saved; copy the Bot User OAuth Token from the AgentX app in the right workspace, then run agentx init again");
    expect(storedSlack(context).botToken).toBe("unset");
    expect(context.lines.join("\n")).not.toContain(TEST_BOT_TOKEN);
  });

  it("waits when a workspace admin must approve the app, and continues on the next run", async () => {
    const waiting = slackContext(["approval"]);
    const outcome = await slackAppStep(fakeSlackApi()).run(waiting, progressHandle());
    expect(outcome).toEqual({ status: "waiting", message: 'Slack is waiting for a workspace admin to approve "AgentX acme (staging)". Once it is installed, run agentx init --env staging --region us-east-1 again; it continues here.' });
    expect(storedSlack(waiting).botToken).toBe("unset");

    const resumed = slackContext(["installed", TEST_SIGNING_SECRET, TEST_BOT_TOKEN, true]);
    const progress = progressHandle({ ...emptyProgress("staging", T0), steps: { "slack-app": { status: "waiting", at: "2026-09-27T00:00:00.000Z" } } });
    expect(await slackAppStep(fakeSlackApi()).run(resumed, progress)).toMatchObject({ status: "done" });
    expect(resumed.opened).toEqual([]);
    expect(resumed.lines.some((line) => line.includes("https://api.slack.com/apps?new_app=1&manifest_json="))).toBe(true);
  });

  it("prints the link and carries on when the browser cannot open", async () => {
    const opened: string[] = [];
    const context = slackContext(["installed", TEST_SIGNING_SECRET, TEST_BOT_TOKEN, true], { openBrowser: async (url) => { opened.push(url); return false; } });
    expect(await slackAppStep(fakeSlackApi()).run(context, progressHandle())).toMatchObject({ status: "done" });
    expect(opened).toHaveLength(1);
    expect(context.lines).toContain(`If no browser opens, open: ${opened[0]!}`);
  });

  it("refuses a user token before storing anything", async () => {
    const context = slackContext(["installed", TEST_SIGNING_SECRET, "xoxp-1-2-3-user"]);
    await expect(slackAppStep(fakeSlackApi()).run(context, progressHandle())).rejects.toThrow("that is a user token (xoxp-)");
    expect(storedSlack(context).botToken).toBe("unset");
  });

  it("refuses a token Slack rejects, or one without a bot user, without echoing it", async () => {
    const rejected = slackContext(["installed", TEST_SIGNING_SECRET, TEST_BOT_TOKEN]);
    let message = "";
    try { await slackAppStep(fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) })).run(rejected, progressHandle()); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions");
    expect(message).not.toContain(TEST_BOT_TOKEN);
    expect(storedSlack(rejected).botToken).toBe("unset");

    const noBot = slackContext(["installed", TEST_SIGNING_SECRET, TEST_BOT_TOKEN]);
    await expect(slackAppStep(fakeSlackApi({ authTest: async () => ({ ok: true, user_id: "U1", team_id: "T1" }) })).run(noBot, progressHandle()))
      .rejects.toThrow("that token does not belong to a bot user");
  });

  it("refuses a token from a different workspace than this install already uses", async () => {
    const context = slackContext(["installed", TEST_SIGNING_SECRET, TEST_BOT_TOKEN]);
    const progress = progressHandle({ ...emptyProgress("staging", T0), slack: { appId: "A0OLD", teamId: "T0OTHER", botUserId: "U0OLD" } });
    await expect(slackAppStep(fakeSlackApi()).run(context, progress)).rejects.toThrow("that token belongs to Slack workspace T0TEAM, but this install uses T0OTHER; nothing was saved");
    expect(storedSlack(context).botToken).toBe("unset");
  });

  it("on the page, the create address is the card's button, so no 'If no browser opens' line is written", async () => {
    const surface = { cards: [] as WizardCard[], card(card: WizardCard) { this.cards.push(card); } };
    const context = slackContext(["installed", TEST_SIGNING_SECRET, TEST_BOT_TOKEN, true], { surface });
    expect(await slackAppStep(fakeSlackApi()).run(context, progressHandle())).toMatchObject({ status: "done" });
    expect(context.lines.some((line) => line.startsWith("If no browser opens"))).toBe(false);
    expect(surface.cards[0]?.link?.url).toMatch(/^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
  });

  it("M19: on the page, a refused token read from an environment variable is not offered for pasting again", async () => {
    const surface = { cards: [] as WizardCard[], card(card: WizardCard) { this.cards.push(card); } };
    // The bot token from an environment variable (the signing secret pasted); the signing secret
    // from a file that cannot be read (the bot token pasted).
    for (const [secretFlags, pasted] of [
      [{ slackBotToken: { envName: "BOT" } }, TEST_SIGNING_SECRET],
      [{ slackSigningSecret: { file: "/nonexistent/signing-secret" } }, TEST_BOT_TOKEN],
    ] as const) {
      const context = slackContext(["installed", pasted], { surface, secretFlags, processEnv: { BOT: TEST_BOT_TOKEN } });
      const prompter = context.prompter as ReturnType<typeof scriptedPrompter>;
      await expect(slackAppStep(fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) })).run(context, progressHandle()))
        .rejects.toThrow("slackBotToken" in secretFlags ? "Slack refused the bot token (invalid_auth)" : "could not read --slack-signing-secret-file");
      expect(prompter.asked).not.toContain("Paste the Slack bot token and signing secret again?");
      expect(storedSlack(context).botToken).toBe("unset");
      // The page still shows the failure on the Slack card, in plain words, with the raw problem in its details.
      expect(surface.cards.at(-1)).toMatchObject({ id: "slack", status: "failed", lines: ["Slack did not accept those values.", "Nothing was saved."] });
      expect(surface.cards.at(-1)?.details?.[0]).toContain("slackBotToken" in secretFlags ? "Slack refused the bot token (invalid_auth)" : "could not read --slack-signing-secret-file");
    }
    // With no retry on the page, the card keeps the terminal's advice to run agentx init again in its details.
    const context = slackContext(["installed", TEST_SIGNING_SECRET], { surface, secretFlags: { slackBotToken: { envName: "BOT" } }, processEnv: { BOT: TEST_BOT_TOKEN } });
    await expect(slackAppStep(fakeSlackApi({ botsInfo: async () => ({ ok: false, error: "missing_scope" }) })).run(context, progressHandle()))
      .rejects.toThrow("Slack bots.info did not return the app id (missing_scope); run agentx init again");
    expect(surface.cards.at(-1)).toMatchObject({
      id: "slack", status: "failed", lines: ["Slack did not accept those values.", "Nothing was saved."],
      details: ["Slack bots.info did not return the app id (missing_scope); run agentx init again"],
    });
  });

  it("without a page, a credential from an environment variable that Slack refuses fails with no card", async () => {
    const context = slackContext(["installed", TEST_SIGNING_SECRET], { secretFlags: { slackBotToken: { envName: "BOT" } }, processEnv: { BOT: TEST_BOT_TOKEN } });
    await expect(slackAppStep(fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) })).run(context, progressHandle()))
      .rejects.toThrow("CONFIG_INVALID: Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions");
  });

  it("reads the token and signing secret from files or environment variables under --yes", async () => {
    const context = slackContext([], {
      secretFlags: { slackBotToken: { envName: "BOT" }, slackSigningSecret: { envName: "SIGNING" } },
      processEnv: { BOT: TEST_BOT_TOKEN, SIGNING: TEST_SIGNING_SECRET },
    });
    context.prompter = { ...scriptedPrompter([true]), choose: async (_q, _c, options) => options.defaultValue };
    expect(await slackAppStep(fakeSlackApi()).run(context, progressHandle())).toMatchObject({ status: "done" });
    expect(storedSlack(context)).toEqual({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });
  });
});

describe("spec 048 FR-033: the Slack values on one form", () => {
  const CLIENT_ID = "1111111111.2222222222222";
  const CLIENT_SECRET = "fedcba9876543210fedcba9876543210";

  it("asks the four values in the order Slack shows them, each linked to the Slack apps page", () => {
    const fields = slackValuesFields({ client: true, secretFlags: {}, signinFlags: {} });
    expect(fields.map((field) => field.name)).toEqual(["clientId", "clientSecret", "signingSecret", "botToken"]);
    expect(fields.map((field) => field.secret === true)).toEqual([false, true, true, true]);
    for (const field of fields) {
      expect(field.help).toMatchObject({ learnMoreUrl: "https://api.slack.com/apps", linkLabel: "Open your Slack apps" });
    }
  });

  it("leaves out what a flag gives, and the client pair when developers do not sign in with Slack", () => {
    expect(slackValuesFields({ client: false, secretFlags: { slackBotToken: { file: "/t" } }, signinFlags: {} }).map((field) => field.name)).toEqual(["signingSecret"]);
  });

  it("stores the client pair with the bot values, so developer sign-in asks for nothing", async () => {
    const context = slackContext(["installed", CLIENT_ID, CLIENT_SECRET, TEST_SIGNING_SECRET, TEST_BOT_TOKEN, true]);
    context.answers = { ...context.answers, signinMethods: "slack" };
    await expect(slackAppStep(fakeSlackApi()).run(context, progressHandle())).resolves.toMatchObject({ status: "done" });
    expect(JSON.parse(context.secrets.values.get(SLACK_SECRET) ?? "{}")).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      signingSecret: TEST_SIGNING_SECRET,
      botToken: TEST_BOT_TOKEN,
    });
  });

  it("Review Focus 1: the same value in Client Secret and Signing Secret is refused and nothing is stored", async () => {
    const hub = createWizardHub("staging");
    const context = slackContext([], {
      prompter: browserPrompter(hub),
      surface: { card: (card) => hub.showCard(card) },
    });
    context.answers = { ...context.answers, signinMethods: "slack" };
    const running = slackAppStep(fakeSlackApi()).run(context, progressHandle());
    const installed = await questionWhenAsked(hub, "Is the Slack app installed in your workspace?");
    expect(hub.answer(installed.id, "installed")).toBeUndefined();
    const form = await questionWhenAsked(hub, SLACK_VALUES_TITLE);
    expect(hub.answer(form.id, JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, signingSecret: CLIENT_SECRET, botToken: TEST_BOT_TOKEN }))).toBe("Check the field marked below.");
    const again = hub.state().question;
    expect(again?.fields?.find((field) => field.name === "signingSecret")?.error).toBe("This is the Client Secret again. Copy the Signing Secret, just below it on Basic Information.");
    expect(JSON.stringify(hub.snapshot())).not.toContain(CLIENT_SECRET);
    expect(context.secrets.values.get(SLACK_SECRET)).toBe(JSON.stringify({ botToken: "unset", signingSecret: PLACEHOLDER }));
    hub.close();
    await running.catch(() => undefined);
  });

  it("FR-036 and Ruling 2: on the page an admin approval keeps the run waiting here, and continues once installed", async () => {
    const cards: WizardCard[] = [];
    const context = slackContext(["approval", "installed", CLIENT_ID, CLIENT_SECRET, TEST_SIGNING_SECRET, TEST_BOT_TOKEN, true], {
      surface: { card: (card) => { cards.push(card); } },
    });
    context.answers = { ...context.answers, signinMethods: "slack" };
    await expect(slackAppStep(fakeSlackApi()).run(context, progressHandle())).resolves.toMatchObject({ status: "done" });
    expect(cards.find((card) => card.status === "waiting" && card.lines[0]?.startsWith("Slack is waiting for a workspace admin"))?.lines).toEqual([
      "Slack is waiting for a workspace admin to approve \"AgentX acme (staging)\".",
      "Your progress is saved. You can leave the installer running, or stop and continue later.",
      "When the app is installed in Slack, choose Installed, continue.",
    ]);
  });

  it("FR-036: without a page an admin approval still ends the run waiting, as before", async () => {
    const context = slackContext(["approval"]);
    await expect(slackAppStep(fakeSlackApi()).run(context, progressHandle())).resolves.toMatchObject({ status: "waiting" });
  });
});

describe("Slack sign-in support in the app (FR-044, R10, R11)", () => {
  it("builds the sign-in callback URL from the control plane's endpoint", () => {
    expect(slackSignInCallbackUrl("https://abc123.execute-api.us-east-1.amazonaws.com/")).toBe(SIGNIN);
    expect(slackSignInCallbackUrl("https://abc123.execute-api.us-east-1.amazonaws.com")).toBe(SIGNIN);
  });

  it("puts this environment's sign-in callback URL in the manifest the step opens", async () => {
    const context = slackContext(["installed", TEST_SIGNING_SECRET, TEST_BOT_TOKEN, true]);
    await slackAppStep(fakeSlackApi()).run(context, progressHandle());
    const manifest = JSON.parse(new URL(context.opened[0]!).searchParams.get("manifest_json") ?? "") as { oauth_config: { redirect_urls: string[] } };
    expect(manifest.oauth_config.redirect_urls).toEqual([SIGNIN]);
  });

  it("requires the ApiEndpoint output only in the Slack app step, not in the URL check (F26)", async () => {
    const withoutEndpoint = (prompts: Array<string | boolean>, fetch?: typeof globalThis.fetch) => {
      const context = slackContext(prompts, fetch === undefined ? {} : { fetch });
      const outputs = allStackOutputs();
      delete outputs["agentx-staging-control-plane"]?.ApiEndpoint;
      const deployer = scriptedDeployer(outputs, Object.keys(outputs));
      context.deployment = async () => ({ deployer, store: context.store, secrets: context.secrets, holder: context.holder, partition: "aws", cleanup: async () => undefined });
      return context;
    };
    const step = withoutEndpoint(["installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET, true]);
    await expect(slackAppStep(fakeSlackApi()).run(step, progressHandle()))
      .rejects.toThrow("stack agentx-staging-control-plane reports no ApiEndpoint; the control-plane step must finish first, so run agentx init again");
    expect(storedSlack(step).botToken).toBe("unset");

    const fetch = slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET });
    const verify = withoutEndpoint([true], fetch);
    verify.secrets.values.set(SLACK_SECRET, JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }));
    await verifySlackUrls(verify, progressHandle());
    expect(fetch.calls).toEqual([EVENTS, INTERACTIONS]);
  });

  it("keeps the sign-in client ID and secret when the bot token is replaced (Review Focus 5)", async () => {
    const existing = JSON.stringify({ signingSecret: "old", botToken: "xoxb-old", clientId: "1111.2222", clientSecret: "f".repeat(32) });
    expect(JSON.parse(slackSecretWithBot(existing, { signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }))).toEqual({
      signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "1111.2222", clientSecret: "f".repeat(32),
    });
    // The control plane's placeholder carries no sign-in keys, and none are invented.
    expect(JSON.parse(slackSecretWithBot(JSON.stringify({ botToken: "unset", signingSecret: PLACEHOLDER }), { signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }))).toEqual({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });
    expect(JSON.parse(slackSecretWithBot(undefined, { signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }))).toEqual({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });
    expect(JSON.parse(slackSecretWithBot("not json", { signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }))).toEqual({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });

    const context = slackContext(["installed", TEST_SIGNING_SECRET, TEST_BOT_TOKEN, true]);
    context.secrets.values.set(SLACK_SECRET, existing);
    await slackAppStep(fakeSlackApi()).run(context, progressHandle());
    expect(JSON.parse(context.secrets.values.get(SLACK_SECRET)!)).toEqual({ clientId: "1111.2222", clientSecret: "f".repeat(32), botToken: TEST_BOT_TOKEN, signingSecret: TEST_SIGNING_SECRET });
    const printed = context.lines.join("\n");
    expect(printed).not.toContain("f".repeat(32));
    expect(printed).not.toContain(TEST_BOT_TOKEN);
  });

  it("adds the client credentials and keeps the bot token and signing secret", () => {
    const existing = JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });
    expect(JSON.parse(slackSecretWithSignIn(existing, { clientId: "1111.2222", clientSecret: "e".repeat(32) }))).toEqual({
      signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "1111.2222", clientSecret: "e".repeat(32),
    });
  });

  it("reads the team ID and granted scopes with the stored bot token, never echoing it", async () => {
    const secrets = memoryInitSecrets({ [SLACK_SECRET]: JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }) });
    const api = fakeSlackApi({ authTest: async (token) => ({ ok: token === TEST_BOT_TOKEN, team_id: "T0TEAM", user_id: "U0BOT", bot_id: "B0BOT", scopes: ["users:read"] }) });
    expect(await readSlackTeamIdFromSecret({ secrets, api, secretId: SLACK_SECRET })).toEqual({ teamId: "T0TEAM", scopes: ["users:read"] });
    const unset = memoryInitSecrets({ [SLACK_SECRET]: JSON.stringify({ botToken: "unset", signingSecret: PLACEHOLDER }) });
    await expect(readSlackTeamIdFromSecret({ secrets: unset, api, secretId: SLACK_SECRET })).rejects.toThrow(`secret ${SLACK_SECRET} has no Slack bot token yet; finish the Slack app step of agentx init first`);
    const refused = fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) });
    let message = "";
    try { await readSlackTeamIdFromSecret({ secrets, api: refused, secretId: SLACK_SECRET }); } catch (error) { message = (error as Error).message; }
    // Live check L1: the same next step as doctor's bot token check; a finished init skips its Slack app step.
    expect(message).toBe(`CONFIG_INVALID: Slack refused the stored bot token (invalid_auth); reinstall the Slack app (api.slack.com/apps, Install App), then store its new Bot User OAuth Token in ${SLACK_SECRET} (docs/day-two.md, "Replace the Slack bot token")`);
    expect(message).not.toContain(TEST_BOT_TOKEN);
  });

  it("reports an HTTP failure from Slack as unreachable, with a fixed reason (fix round 1)", async () => {
    const secrets = memoryInitSecrets({ [SLACK_SECRET]: JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }) });
    const api = slackWebApi(async () => new Response("", { status: 503 }));
    const error = await readSlackTeamIdFromSecret({ secrets, api, secretId: SLACK_SECRET }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SlackTeamIdError);
    expect((error as SlackTeamIdError).reason).toBe("Slack could not be reached");
    expect((error as SlackTeamIdError).message).not.toContain(TEST_BOT_TOKEN);
  });

  it("names the sign-in scopes the app is missing", () => {
    expect(missingScopes(["app_mentions:read", "channels:read", "groups:read", "users:read"], SIGN_IN_BOT_SCOPES)).toEqual(["im:write", "users:read.email"]);
    expect(missingScopes(undefined, SIGN_IN_BOT_SCOPES)).toEqual([]);
  });

  it("reads the granted scopes from auth.test's x-oauth-scopes header", async () => {
    const api = slackWebApi(async () => Response.json({ ok: true, team_id: "T0TEAM" }, { headers: { "x-oauth-scopes": "chat:write,users:read, im:write" } }));
    expect((await api.authTest(TEST_BOT_TOKEN)).scopes).toEqual(["chat:write", "users:read", "im:write"]);
    const bare = slackWebApi(async () => Response.json({ ok: true, team_id: "T0TEAM" }));
    expect(await bare.authTest(TEST_BOT_TOKEN)).toEqual({ ok: true, team_id: "T0TEAM" });
  });
});

describe("verifying the Slack URLs after the Slack service deploys", () => {
  it("probes both URLs, opens Event Subscriptions and accepts the engineer's confirmation", async () => {
    const fetch = slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET });
    const context = slackContext([true], { fetch });
    context.secrets.values.set(SLACK_SECRET, JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }));
    await verifySlackUrls(context, progressHandle({ ...emptyProgress("staging", T0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" } }));
    expect(fetch.calls).toEqual([EVENTS, INTERACTIONS]);
    expect(context.opened).toEqual(["https://api.slack.com/apps/A0APP/event-subscriptions"]);
    const printed = context.lines.join("\n");
    expect(printed).not.toContain(TEST_BOT_TOKEN);
    expect(printed).not.toContain(TEST_SIGNING_SECRET);
  });

  it("refuses at once while the secret still holds the control plane's placeholder", async () => {
    const fetch = slackIngressFetch({ signingSecret: PLACEHOLDER });
    const context = slackContext([], { fetch });
    await expect(verifySlackUrls(context, progressHandle())).rejects.toThrow("secret agentx/staging/slack holds no Slack signing secret; run agentx init again to repeat the Slack app step");
    expect(fetch.calls).toEqual([]);
  });

  it("stops with what to check when Slack does not show Verified", async () => {
    const context = slackContext([false], { fetch: slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET }) });
    context.secrets.values.set(SLACK_SECRET, JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }));
    await expect(verifySlackUrls(context, progressHandle({ ...emptyProgress("staging", T0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" } })))
      .rejects.toThrow("Slack has not verified");
  });

  const withSlack = () => progressHandle({ ...emptyProgress("staging", T0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" } });
  const page = () => { const cards: WizardCard[] = []; return { cards, card: (card: WizardCard) => { cards.push(card); } }; };

  it("FR-041: on the page, a check Slack has not verified runs again, and the card shows each stage", async () => {
    const surface = page();
    // Not verified; yes, run it again; verified.
    const context = slackContext([false, true, true], { fetch: slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET, staleFor: 1 }), surface });
    context.secrets.values.set(SLACK_SECRET, JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }));
    await verifySlackUrls(context, withSlack());
    expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual([
      "Does Slack show the Request URL as Verified?", "Run the Request URL check again?", "Does Slack show the Request URL as Verified?",
    ]);
    expect(surface.cards.map((card) => [card.id, card.status])).toEqual([
      ["slack-urls", "running"], ["slack-urls", "running"], ["slack-urls", "waiting"], ["slack-urls", "failed"],
      ["slack-urls", "running"], ["slack-urls", "waiting"], ["slack-urls", "ok"],
    ]);
    expect(surface.cards[1]?.lines).toContain("AgentX can take up to 5 minutes to start using the new Signing Secret. Checking again every 15 seconds.");
    expect(surface.cards[3]?.link).toEqual({ url: "https://api.slack.com/apps/A0APP/event-subscriptions", label: "Open Event Subscriptions" });
    expect(JSON.stringify(surface.cards)).not.toContain(TEST_SIGNING_SECRET);
  });

  it("FR-041: on the page, a probe that fails outright shows readable words, with no error code, and asks to run it again", async () => {
    const surface = page();
    const ingress = slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET });
    let calls = 0;
    const flaky = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls += 1;
      return calls === 1 ? new Response("upstream error", { status: 500 }) : ingress(url, init);
    }) as typeof fetch;
    const context = slackContext([true, true], { fetch: flaky, surface });
    context.secrets.values.set(SLACK_SECRET, JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }));
    await verifySlackUrls(context, withSlack());
    expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual(["Run the Request URL check again?", "Does Slack show the Request URL as Verified?"]);
    const failed = surface.cards.find((card) => card.status === "failed");
    expect(failed?.lines).toEqual(["Slack's check of the address did not pass.", "Fix it, then choose Check again below."]);
    expect(failed?.details?.[0]).toBe(`${EVENTS} answered HTTP 500; check the control plane's SlackIngress logs`);
    expect(failed?.details?.[0]).not.toMatch(/^[A-Z_]+: /);
    expect(surface.cards.at(-1)?.status).toBe("ok");
  });

  it("FR-041: without a page, a check Slack has not verified still stops at once and asks nothing more", async () => {
    const context = slackContext([false], { fetch: slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET }) });
    context.secrets.values.set(SLACK_SECRET, JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }));
    await expect(verifySlackUrls(context, withSlack())).rejects.toThrow("Slack has not verified");
    expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual(["Does Slack show the Request URL as Verified?"]);
  });
});
