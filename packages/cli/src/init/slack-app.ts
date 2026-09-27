// FR-031 to FR-035. The Slack app is created from a manifest AgentX generates; the bot token and
// signing secret come from hidden prompts (or files or environment variables), are checked with
// auth.test, and go straight into the control plane's agentx/<env>/slack secret. The ingress
// still refuses its own and other bots' messages (FR-034): nothing here changes that.
// FR-033 (amended): Slack has no API that reports whether it verified a Request URL, and it never
// checks the interactivity URL, so AgentX sends both URLs a correctly signed Slack-style request
// itself, then asks the engineer to confirm the Event Subscriptions page shows Verified.
import { createHmac, randomBytes } from "node:crypto";
import { agentXError, environmentStackName } from "@agentx/contracts";
import type { InitContext } from "./context.js";
import { checkSlackBotToken, checkSlackSigningSecret, secretFromSource } from "./prompts.js";
import type { InitStep, ProgressHandle } from "./steps.js";

export const SLACK_BOT_SCOPES: readonly string[] = ["app_mentions:read", "channels:join", "channels:read", "chat:write", "groups:read", "users:read"];
export const SLACK_PROBE_TIMEOUT_MS = 7 * 60 * 1000;
const PROBE_POLL_MS = 15_000;

export interface SlackManifest {
  display_information: { name: string; description: string };
  features: { bot_user: { display_name: string; always_online: boolean } };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { request_url: string; bot_events: string[] };
    interactivity: { is_enabled: boolean; request_url: string };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export function slackBotDisplayName(appName: string): string {
  const name = appName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return name === "" ? "agentx" : name;
}

export function slackAppManifest(input: { appName: string; eventsUrl: string; interactivityUrl: string }): SlackManifest {
  return {
    display_information: { name: input.appName, description: "AgentX: ask in Slack, and AgentX works in your repositories and trackers." },
    features: { bot_user: { display_name: slackBotDisplayName(input.appName), always_online: true } },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      event_subscriptions: { request_url: input.eventsUrl, bot_events: ["app_mention"] },
      interactivity: { is_enabled: true, request_url: input.interactivityUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export function slackCreateAppUrl(manifest: SlackManifest): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

export function slackSecretName(env: string): string {
  return `agentx/${env}/slack`;
}

/** Slack's v0 request signature, the one the control plane's validSignature checks. */
export function signSlackRequest(input: { signingSecret: string; body: string; timestampSeconds: number }): { "x-slack-request-timestamp": string; "x-slack-signature": string } {
  const timestamp = String(input.timestampSeconds);
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", input.signingSecret).update(`v0:${timestamp}:${input.body}`).digest("hex")}`,
  };
}

async function echoedChallenge(response: Response): Promise<unknown> {
  try {
    return ((await response.json()) as { challenge?: unknown }).challenge;
  } catch {
    return undefined;
  }
}

/**
 * Sends each URL a signed Slack-style request: a url_verification challenge to the events URL and
 * a form-encoded payload to the interactivity URL. A 401 means the ingress still holds its cached
 * old signing secret (up to 5 minutes), so it retries until the timeout.
 */
export async function probeSlackUrls(input: {
  eventsUrl: string; interactivityUrl: string; signingSecret: string; fetch: typeof fetch; now(): number; sleep(ms: number): Promise<void>; write(line: string): void;
  timeoutMs?: number; pollMs?: number;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? SLACK_PROBE_TIMEOUT_MS;
  const deadline = input.now() + timeoutMs;
  let told = false;
  const send = (url: string, body: string, contentType: string) => input.fetch(url, {
    method: "POST",
    headers: { "content-type": contentType, ...signSlackRequest({ signingSecret: input.signingSecret, body, timestampSeconds: Math.floor(input.now() / 1000) }) },
    body,
  });
  const retry = async (url: string) => {
    if (input.now() >= deadline) {
      throw agentXError("CONFIG_INVALID", `${url} still refuses requests signed with the new signing secret after ${Math.round(timeoutMs / 60_000)} minutes; check that you pasted the Signing Secret, not the Client Secret, then run agentx init again`);
    }
    if (!told) {
      input.write("Waiting for the Slack ingress to pick up the new signing secret (it keeps the old one for up to 5 minutes)");
      told = true;
    }
    await input.sleep(input.pollMs ?? PROBE_POLL_MS);
  };

  const challenge = randomBytes(12).toString("hex");
  const eventsBody = JSON.stringify({ type: "url_verification", token: "agentx-init-probe", challenge });
  for (;;) {
    const response = await send(input.eventsUrl, eventsBody, "application/json");
    if (response.status === 200) {
      if ((await echoedChallenge(response)) !== challenge) {
        throw agentXError("RUNTIME_UNAVAILABLE", `${input.eventsUrl} answered without echoing Slack's challenge; check the control plane's SlackIngress logs`);
      }
      break;
    }
    if (response.status !== 401) throw agentXError("RUNTIME_UNAVAILABLE", `${input.eventsUrl} answered HTTP ${response.status}; check the control plane's SlackIngress logs`);
    await retry(input.eventsUrl);
  }
  const form = `payload=${encodeURIComponent(JSON.stringify({ type: "agentx_init_probe" }))}`;
  for (;;) {
    const response = await send(input.interactivityUrl, form, "application/x-www-form-urlencoded");
    if (response.status >= 500) throw agentXError("RUNTIME_UNAVAILABLE", `${input.interactivityUrl} answered HTTP ${response.status}; check the control plane's SlackIngress logs`);
    if (response.status !== 401) return;
    await retry(input.interactivityUrl);
  }
}

export interface SlackApi {
  authTest(token: string): Promise<{ ok: boolean; error?: string; user_id?: string; bot_id?: string; team_id?: string }>;
  botsInfo(token: string, botId: string): Promise<{ ok: boolean; error?: string; bot?: { app_id?: string } }>;
}

export function slackWebApi(fetchImplementation: typeof fetch): SlackApi {
  const call = async (method: string, token: string, query = ""): Promise<unknown> => {
    const response = await fetchImplementation(`https://slack.com/api/${method}${query}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `Slack ${method} failed with HTTP ${response.status}; try again in a minute`);
    return response.json();
  };
  return {
    authTest: async (token) => (await call("auth.test", token)) as Awaited<ReturnType<SlackApi["authTest"]>>,
    botsInfo: async (token, botId) => (await call("bots.info", token, `?bot=${encodeURIComponent(botId)}`)) as Awaited<ReturnType<SlackApi["botsInfo"]>>,
  };
}

async function controlPlaneSlackUrls(context: InitContext): Promise<{ eventsUrl: string; interactivityUrl: string }> {
  const stackName = environmentStackName(context.env, "control-plane");
  const outputs = await (await context.deployment()).deployer.outputs(stackName);
  const eventsUrl = outputs?.SlackEventsUrl;
  const interactivityUrl = outputs?.SlackInteractivityUrl;
  if (eventsUrl === undefined || interactivityUrl === undefined) {
    throw agentXError("CONFIG_INVALID", `stack ${stackName} reports no Slack URLs; the control-plane step must finish first, so run agentx init again`);
  }
  return { eventsUrl, interactivityUrl };
}

export function slackAppStep(api: SlackApi): InitStep<InitContext> {
  return {
    id: "slack-app",
    title: "Create the Slack app",
    async run(context, progress) {
      const { env } = context;
      const { appName } = context.answers.slack;
      const urls = await controlPlaneSlackUrls(context);
      const resuming = progress.current().steps["slack-app"]?.status === "waiting";
      if (resuming) {
        context.write(`Continuing with the Slack app "${appName}". Once an admin approves it, install it from its Install App page.`);
      } else {
        const url = slackCreateAppUrl(slackAppManifest({ appName, ...urls }));
        context.write(`Create the Slack app "${appName}" from AgentX's manifest: pick the workspace, press Next, then Create, then Install to Workspace. If your workspace needs an admin to approve new apps, choose Request to Install.`);
        context.write(`If no browser opens, open: ${url}`);
        if (context.openBrowser !== undefined) await context.openBrowser(url);
      }
      const installed = await context.prompter.choose<"installed" | "approval">("Is the Slack app installed in your workspace?", [
        { value: "installed", label: "Yes: I can copy its Bot User OAuth Token" },
        { value: "approval", label: "Not yet: a workspace admin must approve it first" },
      ], { flag: "--slack-install", defaultValue: "installed" });
      if (installed === "approval") {
        return { status: "waiting", message: `Slack is waiting for a workspace admin to approve "${appName}". Once it is installed, run agentx init --env ${env} again; it continues here.` };
      }

      context.write("Copy the Bot User OAuth Token from OAuth & Permissions, and the Signing Secret from Basic Information, App Credentials.");
      const common = { processEnv: context.processEnv, prompter: context.prompter };
      const botToken = checkSlackBotToken(await secretFromSource({ ...common, what: "Slack bot token", flag: "--slack-bot-token", source: context.secretFlags.slackBotToken ?? {} }));
      const signingSecret = checkSlackSigningSecret(await secretFromSource({ ...common, what: "Slack signing secret", flag: "--slack-signing-secret", source: context.secretFlags.slackSigningSecret ?? {} }));

      const auth = await api.authTest(botToken);
      if (!auth.ok) throw agentXError("CONFIG_INVALID", `Slack refused the bot token (${auth.error ?? "no reason given"}); copy it again from OAuth & Permissions`);
      if (auth.bot_id === undefined || auth.user_id === undefined || auth.team_id === undefined) {
        throw agentXError("CONFIG_INVALID", "that token does not belong to a bot user; paste the Bot User OAuth Token (it starts with xoxb-)");
      }
      const earlier = progress.current().slack;
      if (earlier !== undefined && earlier.teamId !== auth.team_id) {
        throw agentXError("CONFIG_INVALID", `that token belongs to Slack workspace ${auth.team_id}, but this install uses ${earlier.teamId}; nothing was saved`);
      }
      const info = await api.botsInfo(botToken, auth.bot_id);
      const appId = info.bot?.app_id;
      if (!info.ok || appId === undefined) {
        throw agentXError("RUNTIME_UNAVAILABLE", `Slack bots.info did not return the app id (${info.error ?? "no app_id"}); run agentx init again`);
      }

      await context.secrets.put(slackSecretName(env), JSON.stringify({ signingSecret, botToken }));
      await progress.update({ slack: { appId, teamId: auth.team_id, botUserId: auth.user_id } });
      return { status: "done", note: `Slack app ${appId} in workspace ${auth.team_id}` };
    },
  };
}

function storedSigningSecret(raw: string | undefined): string | undefined {
  try {
    const value = (JSON.parse(raw ?? "") as { signingSecret?: unknown }).signingSecret;
    // The control plane's placeholder is not a Slack signing secret: the Slack app step has not run.
    return typeof value === "string" && /^[a-f0-9]{32}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function verifySlackUrls(context: InitContext, progress: ProgressHandle): Promise<void> {
  const name = slackSecretName(context.env);
  const signingSecret = storedSigningSecret(await context.secrets.get(name));
  if (signingSecret === undefined) throw agentXError("CONFIG_INVALID", `secret ${name} holds no Slack signing secret; run agentx init again to repeat the Slack app step`);
  const { eventsUrl, interactivityUrl } = await controlPlaneSlackUrls(context);
  await probeSlackUrls({ eventsUrl, interactivityUrl, signingSecret, fetch: context.fetch, now: context.now, sleep: context.sleep, write: context.write });
  const appId = progress.current().slack?.appId;
  const page = appId === undefined ? "https://api.slack.com/apps" : `https://api.slack.com/apps/${appId}/event-subscriptions`;
  context.write(`AgentX now answers Slack's URL check. Open ${page}; if the Request URL is not marked Verified, press Retry.`);
  if (context.openBrowser !== undefined) await context.openBrowser(page);
  if (!(await context.prompter.confirm("Does Slack show the Request URL as Verified?", { defaultValue: true }))) {
    throw agentXError("CONFIG_INVALID", `Slack has not verified ${eventsUrl}. On ${page}, press Retry; if it still fails, look for invalid_signature in the control plane's SlackIngress logs, then run agentx init again`);
  }
}
