// Add to Slack, on the setup page: one configuration token instead of four pasted values, Slack's
// own install page, its redirect back to the setup page, and the events added once Slack can reach
// AgentX. Nothing here reaches AWS or Slack.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenSlackInstallHost } from "../../packages/cli/src/init/context.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { slackAppManifest, slackAppStep, slackSecretName, verifySlackUrls } from "../../packages/cli/src/init/slack-app.js";
import { slackAuthorizeUrl, slackManifestForAddToSlack, SLACK_CONFIG_TOKEN_QUESTION } from "../../packages/cli/src/init/slack-install.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";
import { setupPageHandler } from "../../packages/cli/src/init/ui/setup-handler.js";
import { memorySetupStore } from "../../packages/cli/src/init/ui/setup-store.js";
import {
  allStackOutputs, FAKE_SLACK_CLIENT, fakeSlackApi, initContext, memoryInitSecrets, progressHandle, scriptedDeployer, scriptedPrompter,
  slackIngressFetch, TEST_BOT_TOKEN, TEST_SIGNING_SECRET,
} from "../support/init-fakes.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

const SETUP = "https://setup.example.com";
// A made-up token in Slack's format, put together here so no file holds one (push protection).
const CONFIG_TOKEN = ["xoxe", "xoxp-1-NOTAREALTOKENFORTESTS"].join(".");
const SLACK_SECRET = slackSecretName("staging");
const MANIFEST = slackAppManifest({
  appName: "AgentX", eventsUrl: "https://api.example.com/v1/slack/events", interactivityUrl: "https://api.example.com/v1/slack/interactions",
  signInCallbackUrl: "https://api.example.com/v1/auth/callback/slack",
});

/** The setup page's context: the control plane deployed, the Slack secret holding its placeholder,
 * and a page whose Add to Slack sends Slack's code back at once (or never). */
function setupContext(prompts: Array<string | boolean>, options: { code?: string; prompter?: ReturnType<typeof scriptedPrompter> } = {}) {
  const outputs = allStackOutputs();
  const deployer = scriptedDeployer(outputs, Object.keys(outputs));
  const secrets = memoryInitSecrets({ [SLACK_SECRET]: JSON.stringify({ botToken: "unset", signingSecret: "Qm7ZkX2pLr9TbV4nHs8WcY3dJf6GtA1e" }) });
  const cards: WizardCard[] = [];
  const opened: string[] = [];
  const states: string[] = [];
  const slackInstallHost: OpenSlackInstallHost = async ({ state }) => {
    states.push(state);
    return { code: options.code === undefined ? new Promise<string>(() => undefined) : Promise.resolve(options.code), close: () => undefined };
  };
  const context = initContext({
    prompter: options.prompter ?? scriptedPrompter(prompts), secrets, setupPageUrl: SETUP, slackInstallHost,
    surface: { card: (card) => { cards.push(card); } },
    openBrowser: async (url) => { opened.push(url); return true; },
  });
  context.deployment = async () => ({ deployer, store: context.store, secrets, holder: context.holder, partition: "aws", cleanup: async () => undefined });
  homes.push(context.home);
  const stored = () => JSON.parse(context.secrets.values.get(SLACK_SECRET) ?? "{}") as Record<string, string>;
  return { context, cards, opened, states, stored };
}

describe("Add to Slack", () => {
  it("makes the app with one pasted token, keeps its credentials before the install, and takes the bot token Slack's redirect brought", async () => {
    const slack = fakeSlackApi();
    const { context, cards, opened, states, stored } = setupContext(["token", CONFIG_TOKEN], { code: "slack-code" });
    const progress = progressHandle();
    expect(await slackAppStep(slack).run(context, progress)).toMatchObject({ status: "done" });

    expect(slack.manifests).toHaveLength(1);
    const made = slack.manifests[0]!;
    expect(made).toMatchObject({ method: "create", token: CONFIG_TOKEN });
    expect(made.manifest.settings.event_subscriptions).toBeUndefined();
    expect(made.manifest.oauth_config.redirect_urls).toContain(`${SETUP}/slack/callback`);
    const add = new URL(opened.at(-1) ?? "");
    expect(`${add.origin}${add.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
    expect(Object.fromEntries(add.searchParams)).toMatchObject({ client_id: FAKE_SLACK_CLIENT.clientId, redirect_uri: `${SETUP}/slack/callback`, state: states[0] });
    expect(cards.filter((card) => card.id === "slack").map((card) => card.link?.label)).toEqual(expect.arrayContaining(["Open your Slack apps", "Add to Slack"]));

    expect(slack.exchanged).toEqual(["slack-code"]);
    expect(stored()).toEqual({ botToken: TEST_BOT_TOKEN, signingSecret: TEST_SIGNING_SECRET, ...FAKE_SLACK_CLIENT });
    expect(JSON.stringify(stored())).not.toContain(CONFIG_TOKEN);
    expect(progress.value()).toMatchObject({ slackPending: { appId: "A0APP" }, slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT", botName: "agentx", teamName: "Acme" } });
    expect(context.lines.join("\n")).not.toContain(CONFIG_TOKEN);
    // This run holds the token: the slack-check step adds the events with it.
    expect(context.slackEvents).toBeDefined();
  });

  it("never makes a second app: a run after the app was made goes straight to Add to Slack", async () => {
    const slack = fakeSlackApi();
    const { context, stored } = setupContext([], { code: "slack-code" });
    context.secrets.values.set(SLACK_SECRET, JSON.stringify({ botToken: "unset", signingSecret: TEST_SIGNING_SECRET, ...FAKE_SLACK_CLIENT }));
    const progress = progressHandle({ ...emptyProgress("staging", 0), slackPending: { appId: "A0APP" } });
    expect(await slackAppStep(slack).run(context, progress)).toMatchObject({ status: "done" });
    expect(slack.manifests).toEqual([]);
    expect(stored()).toMatchObject({ botToken: TEST_BOT_TOKEN });
    // No token in this run: the request URL is checked by hand, as before.
    expect(context.slackEvents).toBeUndefined();
  });

  it("asks for another token when Slack refuses one, and makes nothing with the refused one", async () => {
    let creates = 0;
    const slack = fakeSlackApi({
      manifestCreate: async () => {
        creates += 1;
        return creates === 1
          ? { ok: false, error: "invalid_auth" }
          : { ok: true, app_id: "A0APP", credentials: { client_id: FAKE_SLACK_CLIENT.clientId, client_secret: FAKE_SLACK_CLIENT.clientSecret, signing_secret: TEST_SIGNING_SECRET } };
      },
    });
    const prompter = scriptedPrompter(["token", ["xoxe", "xoxp-1-ANOTHERMADEUPTOKEN"].join("."), true, CONFIG_TOKEN]);
    const { context, cards } = setupContext([], { code: "slack-code", prompter });
    expect(await slackAppStep(slack).run(context, progressHandle())).toMatchObject({ status: "done" });
    expect(prompter.asked).toEqual(["How do you want to make the Slack app?", SLACK_CONFIG_TOKEN_QUESTION, "Paste a configuration token again?", SLACK_CONFIG_TOKEN_QUESTION]);
    expect(cards.find((card) => card.status === "failed")?.details?.[0]).toContain("Slack did not make the app: invalid_auth");
  });

  it("lets the person make the app by hand instead, as the terminal does", async () => {
    const slack = fakeSlackApi();
    const prompter = { ...scriptedPrompter(["manual", "installed", `${TEST_SIGNING_SECRET}\n`, TEST_BOT_TOKEN]), confirm: async () => true };
    const { context, opened } = setupContext([], { prompter });
    context.answers = { ...context.answers, signinMethods: "oidc" };
    expect(await slackAppStep(slack).run(context, progressHandle())).toMatchObject({ status: "done" });
    expect(slack.manifests).toEqual([]);
    expect(opened.some((url) => url.startsWith("https://api.slack.com/apps?new_app=1"))).toBe(true);
  });

  it("is offered only on the setup page: the terminal and the local page make the app by hand", async () => {
    const prompter = { ...scriptedPrompter(["installed", `${TEST_SIGNING_SECRET}\n`, TEST_BOT_TOKEN]), confirm: async () => true };
    const { context } = setupContext([], { prompter });
    delete context.slackInstallHost;
    delete context.setupPageUrl;
    context.answers = { ...context.answers, signinMethods: "oidc" };
    expect(await slackAppStep(fakeSlackApi()).run(context, progressHandle())).toMatchObject({ status: "done" });
    expect(prompter.asked).not.toContain("How do you want to make the Slack app?");
  });

  it("builds its manifest and Slack's install address from the one AgentX always makes", () => {
    const { create, complete } = slackManifestForAddToSlack(MANIFEST, `${SETUP}/slack/callback`);
    expect(create.settings.event_subscriptions).toBeUndefined();
    expect(complete.settings.event_subscriptions).toEqual(MANIFEST.settings.event_subscriptions);
    expect(complete.oauth_config.redirect_urls).toEqual([...MANIFEST.oauth_config.redirect_urls, `${SETUP}/slack/callback`]);
    const url = new URL(slackAuthorizeUrl({ clientId: "c", manifest: complete, redirectUri: `${SETUP}/slack/callback`, state: "s" }));
    expect(url.searchParams.get("scope")).toBe(MANIFEST.oauth_config.scopes.bot.join(","));
    expect(url.searchParams.get("user_scope")).toBe(MANIFEST.oauth_config.scopes.user.join(","));
  });
});

describe("the request URL after Add to Slack", () => {
  const checkContext = (events?: () => Promise<{ ok: true } | { ok: false; problem: string }>) => {
    const prompter = scriptedPrompter([true]);
    const { context } = setupContext([], { prompter });
    context.secrets.values.set(SLACK_SECRET, JSON.stringify({ botToken: TEST_BOT_TOKEN, signingSecret: TEST_SIGNING_SECRET }));
    context.fetch = slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET });
    if (events !== undefined) context.slackEvents = events;
    return { context, prompter };
  };

  it("is checked by Slack itself as the events are added: nobody confirms it by hand", async () => {
    let added = 0;
    const { context, prompter } = checkContext(async () => { added += 1; return { ok: true }; });
    await verifySlackUrls(context, progressHandle());
    expect(added).toBe(1);
    expect(prompter.asked).toEqual([]);
  });

  it("falls back to the person's confirmation when Slack does not take the events", async () => {
    const { context, prompter } = checkContext(async () => ({ ok: false, problem: "invalid_manifest" }));
    await verifySlackUrls(context, progressHandle());
    expect(prompter.asked).toEqual(["Does Slack show the Request URL as Verified?"]);
  });
});

describe("Slack's redirect back to the setup page", () => {
  const handler = () => {
    const store = memorySetupStore();
    return { store, handle: setupPageHandler({ store, env: "staging", origin: SETUP, auth: { kind: "token", token: "t" } }) };
  };
  const back = (query: Record<string, string>) => ({ method: "GET", path: "/slack/callback", query, headers: { host: "setup.example.com", "sec-fetch-site": "cross-site" } });

  it("takes the code, with no token, only with the waiting install's state, once", async () => {
    const { store, handle } = handler();
    expect((await handle(back({ code: "c", state: "s" }))).status).toBe(400);
    await store.putSlackInstall("s".repeat(32));
    expect((await handle(back({ code: "c", state: "x".repeat(32) }))).status).toBe(400);
    expect((await handle(back({ code: "c", state: "s".repeat(32) }))).body).toContain("Slack sent AgentX the app's install");
    expect(await store.takeSlackCode("s".repeat(32))).toBe("c");
    expect((await handle(back({ code: "again", state: "s".repeat(32) }))).status).toBe(400);
  });

  it("keeps waiting after Cancel or Request to Install, so Add to Slack can be pressed again", async () => {
    const { store, handle } = handler();
    await store.putSlackInstall("s".repeat(32));
    const refused = await handle(back({ error: "access_denied", state: "s".repeat(32) }));
    expect(refused).toMatchObject({ status: 400, body: expect.stringContaining("Slack did not add the app (access_denied)") as unknown });
    expect(await store.getSlackInstall()).toBe("s".repeat(32));
    expect((await handle(back({ error: "<script>", state: "s".repeat(32) }))).body).not.toContain("<script>");
  });
});
