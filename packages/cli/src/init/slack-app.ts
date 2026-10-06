// FR-031 to FR-035. The Slack app is created from a manifest AgentX generates; the bot token and
// signing secret come from hidden prompts (or files or environment variables), are checked with
// auth.test, and go straight into the control plane's agentx/<env>/slack secret. The ingress
// still refuses its own and other bots' messages (FR-034): nothing here changes that.
// FR-033 (amended): Slack has no API that reports whether it verified a Request URL, and it never
// checks the interactivity URL, so AgentX sends both URLs a correctly signed Slack-style request
// itself, then asks the engineer to confirm the Event Subscriptions page shows Verified.
import { createHmac, randomBytes } from "node:crypto";
import { AgentXError, agentXError, environmentStackName, errorStatus } from "@agentx/contracts";
import type { InitContext, InitSecrets, SecretFlags } from "./context.js";
import { SLACK_BOT_HANDLE_PATTERN, type InstallProgress } from "./install-state.js";
import { askForm, checkSlackBotToken, checkSlackSigningSecret, cleanSecret, fieldCheck, secretFromSource, type FormField, type SecretSource } from "./prompts.js";
import { problemText, retryOnPage } from "./retry.js";
import { addToSlack, SLACK_CALLBACK_PATH } from "./slack-install.js";
import type { InitStep, ProgressHandle, StepOutcome } from "./steps.js";
import { SLACK_APPS_URL, slackAppCard, type SlackCardInput, slackUrlsCard, type SlackUrlsCardInput } from "./ui/cards.js";
import { STEP_PLAN } from "./ui/journey.js";
import { checkSlackClientId, checkSlackClientSecret, hasStoredSlackClient, SIGNIN_FLAG_NAMES, slackClientIdProblem, type SigninFlags } from "../signin/collect.js";

// channels:join, channels:read and groups:read serve 15d2's `channel add`; users:read.email and
// im:write serve developer sign-in (spec 025 FR-044). Adding scopes later forces a reinstall (R10).
export const SLACK_BOT_SCOPES: readonly string[] = ["app_mentions:read", "channels:join", "channels:read", "chat:write", "groups:read", "im:write", "users:read", "users:read.email"];
/** Sign in with Slack (OpenID Connect). */
export const SLACK_USER_SCOPES: readonly string[] = ["email", "openid", "profile"];
/** What developer sign-in needs of the bot token: users.info, users.lookupByEmail, conversations.members, and 25e's DMs. */
export const SIGN_IN_BOT_SCOPES: readonly string[] = ["channels:read", "groups:read", "im:write", "users:read", "users:read.email"];
export const SLACK_PROBE_TIMEOUT_MS = 7 * 60 * 1000;
const PROBE_POLL_MS = 15_000;
export const SLACK_VALUES_TITLE = "Your Slack app's values";
const SLACK_APP_LINK = { learnMoreUrl: SLACK_APPS_URL, linkLabel: "Open your Slack apps" };
const SAME_SECRET = "This is the Client Secret again. Copy the Signing Secret, just below it on Basic Information.";

/** Spec 048 FR-033: the values in Slack's order. A value supplied by a flag or file is omitted. */
export function slackValuesFields(input: { client: boolean; secretFlags: SecretFlags; signinFlags: SigninFlags }): FormField[] {
  const fields: FormField[] = [];
  if (input.client && input.signinFlags.slackClientId === undefined) {
    fields.push({
      name: "clientId", question: "Slack app Client ID (Basic Information, App Credentials)", flag: SIGNIN_FLAG_NAMES.slackClientId,
      validate: slackClientIdProblem, help: SLACK_APP_LINK,
    });
  }
  if (input.client && input.secretFlags.slackClientSecret === undefined) {
    fields.push({
      name: "clientSecret", question: "Slack client secret", flag: SIGNIN_FLAG_NAMES.slackClientSecret,
      secret: true, validate: fieldCheck(checkSlackClientSecret), help: SLACK_APP_LINK,
    });
  }
  if (input.secretFlags.slackSigningSecret === undefined) {
    fields.push({
      name: "signingSecret", question: "Slack signing secret", flag: "--slack-signing-secret",
      secret: true, validate: fieldCheck(checkSlackSigningSecret), help: SLACK_APP_LINK,
    });
  }
  if (input.secretFlags.slackBotToken === undefined) {
    fields.push({
      name: "botToken", question: "Slack bot token", flag: "--slack-bot-token",
      secret: true, validate: fieldCheck(checkSlackBotToken), help: SLACK_APP_LINK,
    });
  }
  return fields;
}

export interface SlackManifest {
  display_information: { name: string; description: string };
  features: { bot_user: { display_name: string; always_online: boolean } };
  oauth_config: { redirect_urls: string[]; scopes: { bot: string[]; user: string[] } };
  settings: {
    /** Left out when Add to Slack makes the app: Slack checks the request URL as it saves it, and
     * AgentX cannot answer that check until it holds the new app's signing secret. */
    event_subscriptions?: { request_url: string; bot_events: string[] };
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

export function slackAppManifest(input: { appName: string; eventsUrl: string; interactivityUrl: string; signInCallbackUrl: string }): SlackManifest {
  return {
    display_information: { name: input.appName, description: "AgentX: ask in Slack, and AgentX works in your repositories and trackers." },
    features: { bot_user: { display_name: slackBotDisplayName(input.appName), always_online: true } },
    oauth_config: { redirect_urls: [input.signInCallbackUrl], scopes: { bot: [...SLACK_BOT_SCOPES], user: [...SLACK_USER_SCOPES] } },
    settings: {
      event_subscriptions: { request_url: input.eventsUrl, bot_events: ["app_mention"] },
      interactivity: { is_enabled: true, request_url: input.interactivityUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/** Where Slack sends a developer back after Sign in with Slack: the control plane's callback route. */
export function slackSignInCallbackUrl(apiEndpoint: string): string {
  return `${apiEndpoint.replace(/\/+$/, "")}/v1/auth/callback/slack`;
}

/** The needed scopes the token was not granted; none when Slack did not report the granted scopes. */
export function missingScopes(granted: readonly string[] | undefined, needed: readonly string[]): string[] {
  if (granted === undefined) return [];
  return needed.filter((scope) => !granted.includes(scope));
}

export function slackCreateAppUrl(manifest: SlackManifest): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

export function slackSecretName(env: string): string {
  return `agentx/${env}/slack`;
}

/** The Slack secret's JSON object; an empty one when it is missing, not JSON, or not an object. */
function parsedSecret(existing: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(existing ?? "{}") as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Why the team ID could not be read, as a fixed phrase that never holds secret content, and what
 * to do next, beside the message.
 */
export class SlackTeamIdError extends AgentXError {
  constructor(message: string, readonly reason: string, readonly nextStep: string) {
    super("CONFIG_INVALID", message, errorStatus("CONFIG_INVALID"));
  }
}

/** probeSlackUrls' timeout: `url` kept answering 401 to requests signed with the signing secret it
 * was given. The message is init's (a new secret); doctor words its own from `url`. */
export class SlackSignatureRefusedError extends AgentXError {
  constructor(message: string, readonly url: string) {
    super("CONFIG_INVALID", message, errorStatus("CONFIG_INVALID"));
  }
}

/** A Slack error code as Slack documents them (lower case, digits, underscores); anything else is not echoed. */
function safeSlackErrorCode(code: string | undefined): string {
  if (code === undefined) return "no reason given";
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : "unrecognized error";
}

/** R11: a new bot token and signing secret, keeping the sign-in keys the developer sign-in step stored. */
export function slackSecretWithBot(existing: string | undefined, bot: { signingSecret: string; botToken: string }): string {
  const current = parsedSecret(existing);
  const keep = Object.fromEntries(["clientId", "clientSecret"].filter((key) => typeof current[key] === "string").map((key) => [key, current[key]]));
  return JSON.stringify({ ...keep, signingSecret: bot.signingSecret, botToken: bot.botToken });
}

/** A new app's credentials, before it is installed: the bot token stays whatever the secret holds
 * (the control plane's placeholder) until the install gives one. */
export function slackSecretWithApp(existing: string | undefined, app: { signingSecret: string; clientId: string; clientSecret: string }): string {
  return JSON.stringify({ ...parsedSecret(existing), signingSecret: app.signingSecret, clientId: app.clientId, clientSecret: app.clientSecret });
}

/** A made app's credentials in the Slack secret (Add to Slack keeps them there before the install),
 * or undefined when it holds none. */
export function storedSlackApp(raw: string | undefined): { signingSecret: string; clientId: string; clientSecret: string } | undefined {
  const value = parsedSecret(raw);
  const { signingSecret, clientId, clientSecret } = value;
  return typeof signingSecret === "string" && /^[a-f0-9]{32}$/.test(signingSecret) && typeof clientId === "string" && typeof clientSecret === "string"
    ? { signingSecret, clientId, clientSecret } : undefined;
}

/** The Sign in with Slack client credentials added to the Slack secret, keeping every other key. */
export function slackSecretWithSignIn(existing: string | undefined, client: { clientId: string; clientSecret: string }): string {
  return JSON.stringify({ ...parsedSecret(existing), clientId: client.clientId, clientSecret: client.clientSecret });
}

/** The bot token in a Slack secret's value, or undefined when it holds none (F25: the one place
 * that reads it). Callers never put it in an error or a log line. */
function storedSlackBotToken(raw: string | undefined): string | undefined {
  const token = parsedSecret(raw).botToken;
  return typeof token === "string" && token.startsWith("xoxb-") ? token : undefined;
}

/** The environment's Slack bot token, from agentx/<env>/slack; the error never echoes what the secret holds. */
export async function readSlackBotToken(secrets: Pick<InitSecrets, "get">, env: string): Promise<string> {
  const token = storedSlackBotToken(await secrets.get(slackSecretName(env)));
  if (token === undefined) {
    throw agentXError("CONFIG_INVALID", `secret ${slackSecretName(env)} holds no Slack bot token; run agentx init again so the Slack app step stores it`);
  }
  return token;
}

/** What to do when Slack refuses the stored bot token: doctor's bot token check and sign-in's scope
 * check give this same step (live check L1). A finished init skips its Slack app step, so neither
 * points there. */
export function replaceSlackBotTokenStep(secretName: string): string {
  return `reinstall the Slack app (api.slack.com/apps, Install App), then store its new Bot User OAuth Token in ${secretName} (docs/day-two.md, "Replace the Slack bot token")`;
}

/** The workspace (team) ID and granted scopes of the bot token stored in the Slack secret. Never puts the token in an error. */
export async function readSlackTeamIdFromSecret(input: { secrets: Pick<InitSecrets, "get">; api: SlackApi; secretId: string }): Promise<{ teamId: string; scopes?: string[] }> {
  const token = storedSlackBotToken(await input.secrets.get(input.secretId));
  if (token === undefined) {
    throw new SlackTeamIdError(
      `secret ${input.secretId} has no Slack bot token yet; finish the Slack app step of agentx init first`,
      "no bot token in the Slack secret",
      "finish the Slack app step of agentx init, then run agentx signin enable slack",
    );
  }
  let auth: Awaited<ReturnType<SlackApi["authTest"]>>;
  try {
    auth = await input.api.authTest(token);
  } catch {
    // A network failure or an HTTP error from Slack; the underlying message is not kept.
    throw new SlackTeamIdError("Slack auth.test could not be reached; try again in a minute", "Slack could not be reached", "check this computer's network access to slack.com, then run agentx signin enable slack");
  }
  if (!auth.ok || auth.team_id === undefined) {
    const code = safeSlackErrorCode(auth.error);
    throw new SlackTeamIdError(
      `Slack refused the stored bot token (${code}); ${replaceSlackBotTokenStep(input.secretId)}`,
      `Slack refused the bot token (${code})`,
      `${replaceSlackBotTokenStep(input.secretId)}, then run agentx signin enable slack`,
    );
  }
  return { teamId: auth.team_id, ...(auth.scopes === undefined ? {} : { scopes: auth.scopes }) };
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
  /** Called once, when the probe starts waiting for the ingress to pick up the new signing secret. */
  onWaiting?: () => void;
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
      throw new SlackSignatureRefusedError(`${url} still refuses requests signed with the new signing secret after ${Math.round(timeoutMs / 60_000)} minutes; check that you pasted the Signing Secret, not the Client Secret, and that this computer's clock is correct (Slack refuses signatures older than 5 minutes), then run agentx init again`, url);
    }
    if (!told) {
      input.write("Waiting for the Slack ingress to pick up the new signing secret (it keeps the old one for up to 5 minutes)");
      input.onWaiting?.();
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
    if (response.status >= 200 && response.status < 300) return;
    if (response.status !== 401) {
      throw agentXError("CONFIG_INVALID", `${input.interactivityUrl} answered HTTP ${response.status}, so the route or stage is wrong; check that the Slack URLs come from this environment's control-plane stack outputs, then run agentx init again`);
    }
    await retry(input.interactivityUrl);
  }
}

/** Slack's own reasons a manifest was refused (apps.manifest.create and update). */
export interface SlackManifestErrors { errors?: Array<{ message?: string; pointer?: string }> }

export interface SlackApi {
  /** `scopes` comes from the response's x-oauth-scopes header, when Slack sends it. */
  authTest(token: string): Promise<{ ok: boolean; error?: string; user_id?: string; bot_id?: string; team_id?: string; team?: string; url?: string; user?: string; scopes?: string[] }>;
  botsInfo(token: string, botId: string): Promise<{ ok: boolean; error?: string; bot?: { app_id?: string } }>;
  /** Creates an app from a manifest, with an app configuration token (Add to Slack, slack-install.ts). */
  manifestCreate(configToken: string, manifest: SlackManifest): Promise<{
    ok: boolean; error?: string; app_id?: string; credentials?: { client_id?: string; client_secret?: string; signing_secret?: string };
  } & SlackManifestErrors>;
  manifestUpdate(configToken: string, appId: string, manifest: SlackManifest): Promise<{ ok: boolean; error?: string } & SlackManifestErrors>;
  /** The OAuth install's code for the app's bot token. */
  oauthAccess(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<{
    ok: boolean; error?: string; access_token?: string; token_type?: string; bot_user_id?: string; app_id?: string; team?: { id?: string; name?: string };
  }>;
}

export function slackWebApi(fetchImplementation: typeof fetch): SlackApi {
  const call = async (method: string, token: string, query = ""): Promise<{ body: unknown; headers: Headers }> => {
    const response = await fetchImplementation(`https://slack.com/api/${method}${query}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `Slack ${method} failed with HTTP ${response.status}; try again in a minute`);
    return { body: await response.json(), headers: response.headers };
  };
  /** A form-encoded call; the token, when there is one, as a bearer header. Never logs the body. */
  const form = async (method: string, fields: Record<string, string>, token?: string): Promise<unknown> => {
    const response = await fetchImplementation(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: new URLSearchParams(fields).toString(),
    });
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `Slack ${method} failed with HTTP ${response.status}; try again in a minute`);
    return response.json();
  };
  return {
    async authTest(token) {
      const { body, headers } = await call("auth.test", token);
      const header = headers.get("x-oauth-scopes");
      const scopes = header === null ? {} : { scopes: header.split(",").map((scope) => scope.trim()).filter(Boolean) };
      return { ...(body as Awaited<ReturnType<SlackApi["authTest"]>>), ...scopes };
    },
    botsInfo: async (token, botId) => (await call("bots.info", token, `?bot=${encodeURIComponent(botId)}`)).body as Awaited<ReturnType<SlackApi["botsInfo"]>>,
    manifestCreate: async (configToken, manifest) =>
      (await form("apps.manifest.create", { manifest: JSON.stringify(manifest) }, configToken)) as Awaited<ReturnType<SlackApi["manifestCreate"]>>,
    manifestUpdate: async (configToken, appId, manifest) =>
      (await form("apps.manifest.update", { app_id: appId, manifest: JSON.stringify(manifest) }, configToken)) as Awaited<ReturnType<SlackApi["manifestUpdate"]>>,
    oauthAccess: async (input) => (await form("oauth.v2.access", {
      client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri,
    })) as Awaited<ReturnType<SlackApi["oauthAccess"]>>,
  };
}

/** The Slack URLs, and the ApiEndpoint output when there is one: only the Slack app step requires it (F26). */
async function controlPlaneSlackUrls(context: InitContext): Promise<{ stackName: string; eventsUrl: string; interactivityUrl: string; apiEndpoint?: string }> {
  const stackName = environmentStackName(context.env, "control-plane");
  const outputs = await (await context.deployment()).deployer.outputs(stackName);
  const eventsUrl = outputs?.SlackEventsUrl;
  const interactivityUrl = outputs?.SlackInteractivityUrl;
  if (eventsUrl === undefined || interactivityUrl === undefined) {
    throw agentXError("CONFIG_INVALID", `stack ${stackName} reports no Slack URLs; the control-plane step must finish first, so run agentx init again`);
  }
  const apiEndpoint = outputs?.ApiEndpoint;
  return { stackName, eventsUrl, interactivityUrl, ...(apiEndpoint === undefined ? {} : { apiEndpoint }) };
}

export function slackAppStep(api: SlackApi): InitStep<InitContext> {
  return {
    id: "slack-app",
    title: STEP_PLAN["slack-app"].title,
    async run(context, progress) {
      const { env } = context;
      const { appName } = context.answers.slack;
      const { stackName, eventsUrl, interactivityUrl, apiEndpoint } = await controlPlaneSlackUrls(context);
      if (apiEndpoint === undefined) {
        throw agentXError("CONFIG_INVALID", `stack ${stackName} reports no ApiEndpoint; the control-plane step must finish first, so run agentx init again`);
      }
      const resuming = progress.current().steps["slack-app"]?.status === "waiting";
      const url = slackCreateAppUrl(slackAppManifest({ appName, eventsUrl, interactivityUrl, signInCallbackUrl: slackSignInCallbackUrl(apiEndpoint) }));
      const show = (card: SlackCardInput) => context.surface?.card(slackAppCard(card));
      // The setup page: Add to Slack, with one configuration token (slack-install.ts), unless the
      // person would rather make the app by hand. A run that already made the app goes on with it.
      if (context.slackInstallHost !== undefined && context.setupPageUrl !== undefined) {
        const how = progress.current().slackPending !== undefined ? "token" : await context.prompter.choose<"token" | "manual">(SLACK_HOW_QUESTION, [
          { value: "token", label: "With a Slack configuration token: AgentX makes and installs the app (recommended)" },
          { value: "manual", label: "By hand: make it from AgentX's manifest and paste its values" },
        ], { flag: "--slack-create", defaultValue: "token" });
        if (how === "token") {
          const added = await addToSlack({
            context, api, progress, show, appName,
            manifest: slackAppManifest({ appName, eventsUrl, interactivityUrl, signInCallbackUrl: slackSignInCallbackUrl(apiEndpoint) }),
            redirectUri: `${context.setupPageUrl}${SLACK_CALLBACK_PATH}`,
          });
          return finishSlackApp(context, progress, show, appName, added);
        }
      }
      if (resuming) {
        context.write(`Continuing with the Slack app "${appName}". Once an admin approves it, install it from its Install App page.`);
        context.write(`If you have not created the app yet, open: ${url}`);
        show({ stage: "create", appName, createUrl: url });
      } else {
        context.write(`Create the Slack app "${appName}" from AgentX's manifest: pick the workspace, press Next, then Create, then Install to Workspace. If your workspace needs an admin to approve new apps, choose Request to Install.`);
        // On the page the address is the card's button, not a browser that might not open.
        if (context.surface === undefined) context.write(`If no browser opens, open: ${url}`);
        if (context.openBrowser !== undefined) await context.openBrowser(url);
        show({ stage: "create", appName, createUrl: url });
      }
      for (;;) {
        const installed = await context.prompter.choose<"installed" | "approval">("Is the Slack app installed in your workspace?", [
          { value: "installed", label: "Yes: I can copy its Bot User OAuth Token" },
          { value: "approval", label: "Not yet: a workspace admin must approve it first" },
        ], { flag: "--slack-install", defaultValue: "installed" });
        if (installed === "installed") break;
        show({ stage: "approval", appName });
        if (context.surface === undefined) {
          return { status: "waiting", message: `Slack is waiting for a workspace admin to approve "${appName}". Once it is installed, run agentx init --env ${env} --region ${context.answers.region} again; it continues here.` };
        }
      }

      context.write("Copy the Client ID, Client Secret and Signing Secret from Basic Information, App Credentials, and the Bot User OAuth Token from OAuth & Permissions.");
      show({ stage: "credentials", appName });
      // Q8: on the page, a token Slack refuses is pasted again; the terminal stops, as before. A
      // credential read from a file or an environment variable cannot be pasted again, so then the
      // page stops as the terminal does.
      const fromSource = (source: SecretSource | undefined) => source?.file !== undefined || source?.envName !== undefined;
      const pastedOnPage = !fromSource(context.secretFlags.slackBotToken) && !fromSource(context.secretFlags.slackSigningSecret);
      const methods = context.signinFlags.methods ?? context.answers.signinMethods ?? "slack";
      const client = methods !== "oidc" && !(await hasStoredSlackClient(context.secrets, slackSecretName(env)));
      const bot = await retryOnPage({
        surface: pastedOnPage ? context.surface : undefined, prompter: context.prompter, question: "Paste the Slack values again?",
        failed: (problem) => show({ stage: "refused", problem }),
        run: pastedOnPage || context.surface === undefined
          ? () => collectSlackValues(context, api, progress, show, client)
          : async () => {
            try {
              return await collectSlackValues(context, api, progress, show, client);
            } catch (error) {
              // No paste again here, so the card keeps the terminal's whole advice.
              show({ stage: "refused", problem: problemText(error), retry: false });
              throw error;
            }
          },
      });

      return finishSlackApp(context, progress, show, appName, bot);
    },
  };
}

export const SLACK_HOW_QUESTION = "How do you want to make the Slack app?";

/** Keeps the bot's token and signing secret (and the sign-in client, when there is one) in the Slack
 * secret, and records the app, however it was made. */
async function finishSlackApp(context: InitContext, progress: ProgressHandle, show: (card: SlackCardInput) => void, appName: string, bot: SlackValues): Promise<StepOutcome> {
  const name = slackSecretName(context.env);
  // Read, merge, write: a concurrent writer (this step alongside `agentx signin enable slack`)
  // could lose an update. Left for admins to avoid by running one at a time.
  const before = await context.secrets.get(name);
  const withBot = slackSecretWithBot(before, { signingSecret: bot.signingSecret, botToken: bot.botToken });
  await context.secrets.put(name, bot.client === undefined ? withBot : slackSecretWithSignIn(withBot, bot.client));
  await progress.update({ slack: { appId: bot.appId, teamId: bot.teamId, botUserId: bot.botUserId, ...(bot.botName === undefined ? {} : { botName: bot.botName }), ...(bot.teamName === undefined ? {} : { teamName: bot.teamName }) } });
  show({ stage: "done", appName, appId: bot.appId, teamId: bot.teamId, ...(bot.teamName === undefined ? {} : { teamName: bot.teamName }) });
  return { status: "done", note: `Slack app ${bot.appId} in workspace ${bot.teamId}` };
}

/** FR-026 and FR-027: Slack's own handle for the bot, as the Slack app step stored it, else the
 * handle AgentX derived from the app's name when it created the manifest. */
export function botNameOf(progress: InstallProgress, appName: string): string {
  return progress.slack?.botName ?? slackBotDisplayName(appName);
}

interface SlackBot { botToken: string; signingSecret: string; appId: string; teamId: string; botUserId: string; botName?: string; teamName?: string }
interface SlackValues extends SlackBot { client?: { clientId: string; clientSecret: string } }

/** The two credentials, checked on their fields (FR-040) and then with Slack, and the operator's
 * word that this is the right bot. Throws, and saves nothing, when any of it fails. */
async function collectSlackValues(context: InitContext, api: SlackApi, progress: ProgressHandle, show: (card: SlackCardInput) => void, client: boolean): Promise<SlackValues> {
  const common = { processEnv: context.processEnv, prompter: context.prompter };
  const fields = slackValuesFields({ client, secretFlags: context.secretFlags, signinFlags: context.signinFlags });
  const typed = fields.length === 0 ? {} : await askForm(context.prompter, SLACK_VALUES_TITLE, fields, {
    crossCheck: (values) => (values.clientSecret !== undefined && values.clientSecret === values.signingSecret ? { signingSecret: SAME_SECRET } : undefined),
  });
  const fromSource = async (name: string, what: string, flag: string, source: SecretSource | undefined, check: (value: string) => string) => {
    const pasted = typed[name];
    return check(pasted === undefined
      ? await secretFromSource({ ...common, what, flag, source: source ?? {}, validate: fieldCheck(check) })
      : cleanSecret(pasted, what));
  };
  const botToken = await fromSource("botToken", "Slack bot token", "--slack-bot-token", context.secretFlags.slackBotToken, checkSlackBotToken);
  const signingSecret = await fromSource("signingSecret", "Slack signing secret", "--slack-signing-secret", context.secretFlags.slackSigningSecret, checkSlackSigningSecret);
  let pair: SlackValues["client"];
  if (client) {
    const clientId = checkSlackClientId(context.signinFlags.slackClientId ?? typed.clientId ?? "");
    const clientSecret = await fromSource("clientSecret", "Slack client secret", SIGNIN_FLAG_NAMES.slackClientSecret, context.secretFlags.slackClientSecret, checkSlackClientSecret);
    if (clientSecret === signingSecret) {
      throw agentXError("CONFIG_INVALID", "the Slack client secret and signing secret are the same value; nothing was saved. Copy each from Basic Information, App Credentials");
    }
    pair = { clientId, clientSecret };
  }

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

  const where = auth.url === undefined ? "" : ` (${auth.url})`;
  context.write(`Bot @${auth.user ?? auth.user_id} in workspace ${auth.team ?? auth.team_id}${where}`);
  show({ stage: "bot", user: auth.user ?? auth.user_id, team: auth.team ?? auth.team_id });
  if (!(await context.prompter.confirm("Is this the AgentX bot in the right workspace?", { defaultValue: true }))) {
    throw agentXError("CONFIG_INVALID", "nothing was saved; copy the Bot User OAuth Token from the AgentX app in the right workspace, then run agentx init again");
  }
  // A handle Slack sends that does not match the stored handle's own pattern is left out rather
  // than refusing the whole install over a display name AgentX never validated itself.
  const botName = auth.user !== undefined && SLACK_BOT_HANDLE_PATTERN.test(auth.user) ? auth.user : undefined;
  // The same for the workspace's name: kept within the 1 to 100 characters the progress record
  // takes, so recording it can never fail after the secret was written.
  const teamName = auth.team === undefined || auth.team.trim() === "" ? undefined : auth.team.slice(0, 100);
  return {
    botToken, signingSecret, appId, teamId: auth.team_id, botUserId: auth.user_id,
    ...(botName === undefined ? {} : { botName }), ...(teamName === undefined ? {} : { teamName }), ...(pair === undefined ? {} : { client: pair }),
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
  const appId = progress.current().slack?.appId;
  const page = appId === undefined ? "https://api.slack.com/apps" : `https://api.slack.com/apps/${appId}/event-subscriptions`;
  const show = (card: SlackUrlsCardInput) => context.surface?.card(slackUrlsCard(card));
  // FR-041 (Q7): on the page, a failed check runs again after the fix; the terminal stops, as before.
  await retryOnPage({
    surface: context.surface, prompter: context.prompter, question: "Run the Request URL check again?",
    failed: (problem) => show(problem.startsWith("Slack has not verified") ? { stage: "not-verified", pageUrl: page } : { stage: "failed", problem, pageUrl: page }),
    run: async () => {
      show({ stage: "checking", eventsUrl });
      await probeSlackUrls({
        eventsUrl, interactivityUrl, signingSecret, fetch: context.fetch, now: context.now, sleep: context.sleep, write: context.write,
        onWaiting: () => show({ stage: "waiting-for-secret", eventsUrl, until: new Date(context.now() + SLACK_PROBE_TIMEOUT_MS).toISOString() }),
      });
      // Add to Slack made the app without its event subscriptions: added now, Slack checks the
      // request URL as it saves it, so there is nothing for the person to confirm.
      if (context.slackEvents !== undefined) {
        const added = await context.slackEvents();
        if (added.ok) {
          context.write("Slack checked AgentX's request URL and turned on the app's events.");
          return;
        }
        context.write(`Slack did not take the app's events (${added.problem}); check them on the app's page.`);
      }
      context.write(`AgentX now answers Slack's URL check. Open ${page}; if the Request URL is not marked Verified, press Retry.`);
      show({ stage: "verify", pageUrl: page });
      if (context.openBrowser !== undefined) await context.openBrowser(page);
      if (!(await context.prompter.confirm("Does Slack show the Request URL as Verified?", { defaultValue: true }))) {
        throw agentXError("CONFIG_INVALID", `Slack has not verified ${eventsUrl}. On ${page}, press Retry; if it still fails, look for invalid_signature in the control plane's SlackIngress logs, then run agentx init again`);
      }
    },
  });
  show({ stage: "done", eventsUrl });
}
