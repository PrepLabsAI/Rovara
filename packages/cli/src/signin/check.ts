// FR-046's checks. 15e's `agentx doctor` calls checkDeveloperSignIn unchanged (R5). Never prints
// a secret: the Slack test request carries only the client ID and the callback URL.
import { AgentXConfigurationSchema, AgentXError } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { EnvironmentSettings } from "../environments/settings.js";
import type { InitSecrets } from "../init/context.js";
import { SIGN_IN_BOT_SCOPES, missingScopes, readSlackTeamIdFromSecret, slackSecretName, slackSignInCallbackUrl, type SlackApi } from "../init/slack-app.js";
import { checkOidcDiscovery } from "./collect.js";
import { oidcSecretName, readSignInSettings, readSlackTeamId } from "./settings.js";

/** `warn`: ok, but not verified; shown as a warning, and it fails neither signin check nor doctor. */
export interface SignInCheck { name: string; ok: boolean; warn?: boolean; detail: string }

/** An error's own words, without AgentXError's "CODE: " prefix. */
const plainMessage = (error: Error) => (error instanceof AgentXError ? error.message.slice(error.code.length + 2) : error.message);

const parse = (text: string | undefined): Record<string, unknown> => {
  try {
    const value = JSON.parse(text ?? "{}") as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** The control plane's base URL without a trailing slash; the issuer is this plus /v1/auth. */
export const apiBase = (settings: EnvironmentSettings) => settings.controlPlaneUrl.replace(/\/+$/, "");
export const agentXConfigurationUrl = (settings: EnvironmentSettings) => `${apiBase(settings)}/v1/auth/.well-known/agentx-configuration`;

/** "Unverified" is ok (a healthy install must not fail doctor) and carries a warning. */
type RedirectAnswer = { state: "registered" } | { state: "not registered" } | { state: "unverified"; why?: string };

/** Slack's wording for a redirect_uri it does not know: on its error page, or as an OAuth error code. */
const REDIRECT_URI_ERROR = /bad_redirect_uri|invalid_redirect_uri|redirect_uri_mismatch|redirect_uri[^<]{0,40}(did not match|does not match|not (?:registered|allowed))/i;

/**
 * Whether Slack knows `redirectUri` for this client, read from how Slack answers a test authorize
 * request. This is inferred, not documented, and the live check (spec 025 Task 15) confirms it:
 * - a redirect to the callback proves it is registered, since Slack never redirects to an
 *   unregistered URL (RFC 6749 4.1.2.1); an `error=` there still counts unless it names redirect_uri;
 * - Slack's error page (or an error code) naming redirect_uri means it is not registered;
 * - anything else, such as a redirect to Slack's own sign-in page (likely, as the request is signed
 *   out) or any 200, settles nothing: "unverified", never a pass or a failure.
 */
async function slackRedirectRegistered(fetchFn: typeof fetch, clientId: string, redirectUri: string): Promise<RedirectAnswer> {
  const url = new URL("https://slack.com/openid/connect/authorize");
  for (const [key, value] of Object.entries({ response_type: "code", scope: "openid", client_id: clientId, redirect_uri: redirectUri, state: "agentx-signin-check" })) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch {
    return { state: "unverified" };
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    let target: URL | undefined;
    try { target = new URL(location); } catch { target = undefined; }
    const error = `${target?.searchParams.get("error") ?? ""} ${target?.searchParams.get("error_description") ?? ""}`;
    if (/redirect_uri/i.test(error) || REDIRECT_URI_ERROR.test(target?.href ?? location)) return { state: "not registered" };
    if (target !== undefined && `${target.origin}${target.pathname}` === redirectUri) return { state: "registered" };
    return { state: "unverified", why: `Slack sent the test sign-in request to ${target === undefined ? "an address it did not name" : `${target.origin}${target.pathname}`}` };
  }
  const body = await response.text().catch(() => "");
  if (REDIRECT_URI_ERROR.test(body)) return { state: "not registered" };
  return { state: "unverified", why: `Slack answered the test sign-in request with HTTP ${response.status}` };
}

function redirectCheck(answer: RedirectAnswer, callback: string, base: string): SignInCheck {
  const name = "Slack redirect URL";
  if (answer.state === "registered") return { name, ok: true, detail: `Slack sent a test sign-in request back to ${callback}, so it is a registered redirect URL` };
  if (answer.state === "not registered") return { name, ok: false, detail: `Slack does not list ${callback} as a redirect URL; add it on OAuth & Permissions` };
  return answer.why === undefined
    ? { name, ok: true, warn: true, detail: `not verified: could not reach slack.com to send a test sign-in request; run agentx login ${base} to confirm that ${callback} is a redirect URL` }
    : { name, ok: true, warn: true, detail: `not verified: ${answer.why}, so it does not show whether ${callback} is a redirect URL; run agentx login ${base} to confirm` };
}

async function controlPlaneCheck(input: { settings: EnvironmentSettings; fetch: typeof fetch }, stored: { slack: boolean; oidcOn: boolean }): Promise<SignInCheck> {
  const url = agentXConfigurationUrl(input.settings);
  let live;
  try {
    const response = await input.fetch(url, { signal: AbortSignal.timeout(10_000) });
    live = AgentXConfigurationSchema.parse(await response.json());
  } catch {
    return { name: "control plane", ok: false, detail: `could not read ${url}; the environment may run a release without developer sign-in, so upgrade it, then run this again` };
  }
  // F22: the issuer is the control plane's DeveloperSignInIssuer output, <ApiEndpoint>/v1/auth.
  const issuer = `${apiBase(input.settings)}/v1/auth`;
  const liveOidc = live.methods.oidc !== null;
  const problems = [
    ...(live.issuer === issuer ? [] : [`the control plane names issuer ${live.issuer}, not ${issuer}; check that this environment's settings name its own control plane (agentx env adopt or agentx init)`]),
    ...(live.methods.slack === stored.slack ? [] : [`the control plane ${live.methods.slack ? "offers" : "does not offer"} Slack sign-in, but the settings say it is ${stored.slack ? "on" : "off"}; run agentx signin ${stored.slack ? "enable" : "disable"} slack again`]),
    ...(liveOidc === stored.oidcOn ? [] : [`the control plane ${liveOidc ? "offers" : "does not offer"} company sign-in, but the settings say it is ${stored.oidcOn ? "on" : "off"}; run agentx signin ${stored.oidcOn ? "enable" : "disable"} oidc again`]),
  ];
  return problems.length === 0 ? { name: "control plane", ok: true, detail: "offers exactly the enabled methods" } : { name: "control plane", ok: false, detail: problems.join("; ") };
}

async function slackChecks(input: { env: string; store: ParameterStore; secrets: Pick<InitSecrets, "get">; settings: EnvironmentSettings; fetch: typeof fetch; slackApi: SlackApi }): Promise<SignInCheck[]> {
  const secretName = slackSecretName(input.env);
  const secret = parse(await input.secrets.get(secretName));
  const clientId = typeof secret.clientId === "string" && /^\d+\.\d+$/.test(secret.clientId) ? secret.clientId : undefined;
  const clientSecretOk = typeof secret.clientSecret === "string" && /^[a-f0-9]{32}$/.test(secret.clientSecret);
  const checks: SignInCheck[] = [clientId !== undefined && clientSecretOk
    ? { name: "Slack app credentials", ok: true, detail: `client ID and client secret are stored in ${secretName}` }
    : { name: "Slack app credentials", ok: false, detail: `the Slack app's client ID and client secret are not stored in ${secretName}; run agentx signin enable slack` }];

  const recorded = await readSlackTeamId(input.store, input.env);
  let live: { teamId: string; scopes?: string[] } | undefined;
  let liveProblem: string | undefined;
  try {
    live = await readSlackTeamIdFromSecret({ secrets: input.secrets, api: input.slackApi, secretId: secretName });
  } catch (error) {
    // readSlackTeamIdFromSecret never puts the token in its errors.
    liveProblem = error instanceof Error ? plainMessage(error) : undefined;
  }
  checks.push(recorded === undefined
    ? { name: "Slack team ID", ok: false, detail: `no team ID is recorded at /agentx/${input.env}/slack/teamId; run agentx signin enable slack` }
    : live !== undefined && live.teamId !== recorded
      ? { name: "Slack team ID", ok: false, detail: `the recorded team ${recorded} is not the bot token's team ${live.teamId}; run agentx signin enable slack` }
      : { name: "Slack team ID", ok: true, detail: `team ${recorded}` });
  const missing = live?.scopes === undefined ? undefined : missingScopes(live.scopes, SIGN_IN_BOT_SCOPES);
  checks.push(missing === undefined
    ? { name: "Slack bot scopes", ok: false, detail: liveProblem === undefined ? `Slack did not report the app's scopes; check that the bot token in ${secretName} works` : `could not ask Slack for the app's scopes: ${liveProblem}` }
    : missing.length === 0 ? { name: "Slack bot scopes", ok: true, detail: "the app has every scope sign-in needs" }
      : { name: "Slack bot scopes", ok: false, detail: `the app is missing ${missing.join(", ")}; add them on OAuth & Permissions and reinstall the app` });

  const callback = slackSignInCallbackUrl(input.settings.controlPlaneUrl);
  checks.push(clientId === undefined
    ? { name: "Slack redirect URL", ok: false, detail: `no Slack client ID is stored in ${secretName}, so ${callback} cannot be checked; run agentx signin enable slack` }
    : redirectCheck(await slackRedirectRegistered(input.fetch, clientId, callback), callback, apiBase(input.settings)));
  return checks;
}

export async function checkDeveloperSignIn(input: { env: string; store: ParameterStore; secrets: Pick<InitSecrets, "get">; settings: EnvironmentSettings; fetch: typeof fetch; slackApi: SlackApi }): Promise<SignInCheck[]> {
  const stored = await readSignInSettings(input.store, input.env);
  if (stored === undefined) return [{ name: "settings", ok: false, detail: "developer sign-in is not set up; run agentx signin enable slack (or oidc)" }];
  const checks: SignInCheck[] = [
    { name: "settings", ok: true, detail: `Slack sign-in ${stored.slack ? "on" : "off"}, company sign-in ${stored.oidc === undefined ? "off" : "on"}` },
    await controlPlaneCheck(input, { slack: stored.slack, oidcOn: stored.oidc !== undefined }),
  ];
  if (stored.slack) checks.push(...await slackChecks(input));
  if (stored.oidc !== undefined) {
    try {
      await checkOidcDiscovery(input.fetch, stored.oidc.issuer);
      checks.push({ name: "company sign-in discovery", ok: true, detail: `${stored.oidc.issuer} publishes its discovery document` });
    } catch (error) {
      checks.push({ name: "company sign-in discovery", ok: false, detail: error instanceof Error ? plainMessage(error) : `could not read ${stored.oidc.issuer}'s discovery document` });
    }
    const secretName = oidcSecretName(input.env);
    const secret = parse(await input.secrets.get(secretName));
    checks.push(typeof secret.clientSecret === "string" && secret.clientSecret !== ""
      ? { name: "company sign-in secret", ok: true, detail: `the client secret is stored in ${secretName}` }
      : { name: "company sign-in secret", ok: false, detail: `no client secret is stored in ${secretName}; run agentx signin enable oidc` });
  }
  return checks;
}

export function checkLines(checks: SignInCheck[]): string[] {
  return checks.map((check) => `${check.warn === true ? "warn" : check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`);
}
