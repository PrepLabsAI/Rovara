// Add to Slack, on the setup page (the install in the cloud). Instead of the person creating the
// Slack app from AgentX's manifest and pasting four values, they paste one Slack app configuration
// token: AgentX makes the app with it (apps.manifest.create), keeps the app's credentials in the
// Slack secret, and offers Slack's own Add to Slack page. Slack sends the browser back to the
// setup page with a code, which AgentX exchanges for the bot token (oauth.v2.access).
//
// Slack accepts only https redirect addresses, so this is the setup page's path; the terminal and
// the local page make the app by hand, as before.
//
// The app is made without event subscriptions: Slack checks the request URL as it saves it, and
// AgentX cannot answer that check before it holds the new app's signing secret. The slack-check
// step adds them (apps.manifest.update) once Slack can reach AgentX, with the same token, which
// lives only in this run's memory and is never stored.
import { randomBytes } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import type { InitContext } from "./context.js";
import { SLACK_BOT_HANDLE_PATTERN } from "./install-state.js";
import { cleanSecret } from "./prompts.js";
import { retryOnPage } from "./retry.js";
import { slackSecretName, slackSecretWithApp, storedSlackApp, type SlackApi, type SlackManifest, type SlackManifestErrors } from "./slack-app.js";
import type { ProgressHandle } from "./steps.js";
import type { SlackCardInput } from "./ui/cards.js";

export { SLACK_CALLBACK_PATH } from "./ui/server.js";
/** How long Add to Slack waits for the person (the GitHub step's cloud wait). */
export const ADD_TO_SLACK_WAIT_MS = 60 * 60 * 1000;
const CONFIG_TOKEN = /^xoxe\.xoxp-[A-Za-z0-9-]{10,}$/;

export const SLACK_CONFIG_TOKEN_QUESTION = "Slack app configuration token";

/** The manifest AgentX makes the app with: its own redirect added, the event subscriptions left
 * for later (see above). */
export function slackManifestForAddToSlack(full: SlackManifest, redirectUri: string): { create: SlackManifest; complete: SlackManifest } {
  const complete: SlackManifest = { ...full, oauth_config: { ...full.oauth_config, redirect_urls: [...full.oauth_config.redirect_urls, redirectUri] } };
  const settings = { ...complete.settings };
  delete settings.event_subscriptions;
  return { create: { ...complete, settings }, complete };
}

export function slackAuthorizeUrl(input: { clientId: string; manifest: SlackManifest; redirectUri: string; state: string }): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.search = new URLSearchParams({
    client_id: input.clientId, scope: input.manifest.oauth_config.scopes.bot.join(","), user_scope: input.manifest.oauth_config.scopes.user.join(","),
    redirect_uri: input.redirectUri, state: input.state,
  }).toString();
  return url.toString();
}

/** Slack's reasons, short enough for a card; never the token. */
export function slackManifestProblem(reply: { error?: string } & SlackManifestErrors): string {
  const details = (reply.errors ?? []).map((each) => [each.pointer, each.message].filter(Boolean).join(": ")).filter(Boolean).slice(0, 3);
  return `${reply.error ?? "no reason given"}${details.length === 0 ? "" : ` (${details.join("; ")})`}`;
}

const tokenProblem = (value: string) => (CONFIG_TOKEN.test(value.trim()) ? undefined : "paste the Access Token from Your App Configuration Tokens; it starts with xoxe.xoxp-");

export interface AddedSlackApp {
  botToken: string; signingSecret: string; appId: string; teamId: string; botUserId: string; botName?: string; teamName?: string;
  client: { clientId: string; clientSecret: string };
}

export async function addToSlack(input: {
  context: InitContext; api: SlackApi; progress: ProgressHandle; show: (card: SlackCardInput) => void;
  appName: string; manifest: SlackManifest; redirectUri: string;
}): Promise<AddedSlackApp> {
  const { context, api, progress, show, appName } = input;
  const open = context.slackInstallHost;
  if (open === undefined) throw agentXError("CONFIG_INVALID", "Add to Slack needs the setup page");
  const name = slackSecretName(context.env);
  const manifests = slackManifestForAddToSlack(input.manifest, input.redirectUri);
  let configToken: string | undefined;
  let pending = progress.current().slackPending;
  if (pending === undefined) {
    show({ stage: "token", appName });
    const made = await retryOnPage({
      surface: context.surface, prompter: context.prompter, question: "Paste a configuration token again?",
      failed: (problem) => show({ stage: "refused", problem }),
      run: async () => {
        const token = cleanSecret(await context.prompter.secret(SLACK_CONFIG_TOKEN_QUESTION, { flag: "--slack-config-token", validate: tokenProblem }), SLACK_CONFIG_TOKEN_QUESTION);
        const problem = tokenProblem(token);
        if (problem !== undefined) throw agentXError("CONFIG_INVALID", problem);
        const reply = await api.manifestCreate(token, manifests.create);
        const credentials = reply.credentials;
        if (!reply.ok || reply.app_id === undefined || credentials?.client_id === undefined || credentials.client_secret === undefined || credentials.signing_secret === undefined) {
          throw agentXError("CONFIG_INVALID", `Slack did not make the app: ${slackManifestProblem(reply)}. Nothing was made; generate a new configuration token and paste it again`);
        }
        configToken = token;
        return { appId: reply.app_id, clientId: credentials.client_id, clientSecret: credentials.client_secret, signingSecret: credentials.signing_secret };
      },
    });
    // Kept before the install: a run that stops after this never makes a second app.
    await context.secrets.put(name, slackSecretWithApp(await context.secrets.get(name), made));
    await progress.update({ slackPending: { appId: made.appId } });
    pending = { appId: made.appId };
  }
  const app = storedSlackApp(await context.secrets.get(name));
  if (app === undefined) throw agentXError("CONFIG_INVALID", `secret ${name} holds no credentials for the Slack app ${pending.appId}; delete that app at https://api.slack.com/apps and try this step again`);

  const state = randomBytes(16).toString("hex");
  const host = await open({ state, timeoutMs: context.githubWaitMs ?? ADD_TO_SLACK_WAIT_MS });
  let code: string;
  try {
    const addUrl = slackAuthorizeUrl({ clientId: app.clientId, manifest: manifests.complete, redirectUri: input.redirectUri, state });
    show({ stage: "add", appName, addUrl });
    if (context.openBrowser !== undefined) await context.openBrowser(addUrl);
    code = await host.code;
  } finally {
    host.close();
  }
  const access = await api.oauthAccess({ clientId: app.clientId, clientSecret: app.clientSecret, code, redirectUri: input.redirectUri });
  const botToken = access.access_token;
  if (!access.ok || access.token_type !== "bot" || botToken === undefined || !botToken.startsWith("xoxb-") || access.bot_user_id === undefined || access.team?.id === undefined) {
    throw agentXError("CONFIG_INVALID", `Slack did not give AgentX the app's bot token (${access.error ?? "no bot token in its reply"}); press Add to Slack again`);
  }
  if (access.app_id !== undefined && access.app_id !== pending.appId) {
    throw agentXError("CONFIG_INVALID", `Slack installed app ${access.app_id}, not ${pending.appId}; press Add to Slack again`);
  }
  const auth = await api.authTest(botToken);
  const token = configToken;
  const appId = pending.appId;
  // Only this run holds the token: a later run checks the request URL by hand, as before.
  if (token !== undefined) {
    context.slackEvents = async () => {
      const reply = await api.manifestUpdate(token, appId, manifests.complete);
      return reply.ok ? { ok: true } : { ok: false, problem: slackManifestProblem(reply) };
    };
  }
  const teamName = access.team.name === undefined || access.team.name.trim() === "" ? undefined : access.team.name.slice(0, 100);
  return {
    botToken, signingSecret: app.signingSecret, appId, teamId: access.team.id, botUserId: access.bot_user_id,
    ...(auth.ok && auth.user !== undefined && SLACK_BOT_HANDLE_PATTERN.test(auth.user) ? { botName: auth.user } : {}),
    ...(teamName === undefined ? {} : { teamName }),
    client: { clientId: app.clientId, clientSecret: app.clientSecret },
  };
}
