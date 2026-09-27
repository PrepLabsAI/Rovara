// The questions for developer sign-in (spec 025 FR-044, FR-045), shared by agentx init and
// agentx signin enable. Secrets come only from a hidden prompt, a file or an environment variable.
import { agentXError } from "@agentx/contracts";
import type { InitSecrets } from "../init/context.js";
import { secretFromSource, type Prompter, type SecretSource } from "../init/prompts.js";
import { SIGN_IN_BOT_SCOPES, missingScopes, readSlackTeamIdFromSecret, slackSecretName, slackSecretWithSignIn, slackSignInCallbackUrl, type SlackApi } from "../init/slack-app.js";
import { oidcSecretName, type DeveloperSignInSettings } from "./settings.js";

export interface SigninFlags { methods?: "slack" | "oidc" | "both"; slackClientId?: string; oidcIssuer?: string; oidcClientId?: string; oidcRequiredClaim?: string; oidcRequiredValues?: string; oidcDisplayName?: string }
export interface SigninSecretFlags { slackClientSecret?: SecretSource; oidcClientSecret?: SecretSource }

/**
 * The one set of flag names for developer sign-in (F14), used by `agentx init` and
 * `agentx signin enable` alike, and named by every question so `--yes` can say which flag to pass.
 * A secret's flag takes `-file <path>` or `-env <NAME>` after it, never the value itself.
 */
export const SIGNIN_FLAG_NAMES = {
  slackClientId: "--slack-client-id",
  slackClientSecret: "--slack-client-secret",
  oidcIssuer: "--signin-oidc-issuer",
  oidcClientId: "--signin-oidc-client-id",
  oidcClientSecret: "--signin-oidc-client-secret",
  oidcRequiredClaim: "--signin-oidc-required-claim",
  oidcRequiredValues: "--signin-oidc-required-values",
  oidcDisplayName: "--signin-oidc-display-name",
} as const;

const SLACK_CLIENT_ID = /^\d+\.\d+$/;

export function checkSlackClientId(value: string): string {
  if (!SLACK_CLIENT_ID.test(value.trim())) throw agentXError("CONFIG_INVALID", "a Slack client ID is two numbers joined by a dot (Basic Information, App Credentials, Client ID)");
  return value.trim();
}

export function checkSlackClientSecret(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) throw agentXError("CONFIG_INVALID", "a Slack client secret is 32 lowercase hexadecimal characters (Basic Information, App Credentials, Client Secret); it is not the Signing Secret");
  return value;
}

export async function slackSignInPrerequisites(input: { env: string; secrets: InitSecrets; slackApi: SlackApi; expectedTeamId?: string }): Promise<{ teamId: string }> {
  const { teamId, scopes } = await readSlackTeamIdFromSecret({ secrets: input.secrets, api: input.slackApi, secretId: slackSecretName(input.env) });
  if (input.expectedTeamId !== undefined && input.expectedTeamId !== teamId) {
    throw agentXError("CONFIG_INVALID", `the stored bot token belongs to Slack workspace ${teamId}, but this install uses ${input.expectedTeamId}; nothing was saved`);
  }
  const missing = missingScopes(scopes, SIGN_IN_BOT_SCOPES);
  if (missing.length > 0) {
    throw agentXError("CONFIG_INVALID", `the Slack app is missing the bot scopes ${missing.join(", ")}; add them on the app's OAuth & Permissions page, reinstall the app, then run this again`);
  }
  return { teamId };
}

export async function collectSlackClient(input: { prompter: Prompter; processEnv: NodeJS.ProcessEnv; flags: SigninFlags; secretFlags: SigninSecretFlags }): Promise<{ clientId: string; clientSecret: string }> {
  const clientId = checkSlackClientId(input.flags.slackClientId ?? await input.prompter.ask("Slack app Client ID (Basic Information, App Credentials)", {
    flag: SIGNIN_FLAG_NAMES.slackClientId,
    validate: (value) => (SLACK_CLIENT_ID.test(value.trim()) ? undefined : "two numbers joined by a dot"),
  }));
  const clientSecret = checkSlackClientSecret(await secretFromSource({ what: "Slack client secret", flag: SIGNIN_FLAG_NAMES.slackClientSecret, source: input.secretFlags.slackClientSecret ?? {}, processEnv: input.processEnv, prompter: input.prompter }));
  return { clientId, clientSecret };
}

export async function checkOidcDiscovery(fetchFn: typeof fetch, issuer: string): Promise<void> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let doc: Record<string, unknown>;
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(String(response.status));
    doc = await response.json() as Record<string, unknown>;
  } catch {
    throw agentXError("CONFIG_INVALID", `could not read ${url}; check the issuer URL and that this computer can reach it`);
  }
  if (typeof doc.issuer !== "string" || doc.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
    throw agentXError("CONFIG_INVALID", `${url} names issuer ${typeof doc.issuer === "string" ? doc.issuer : "nothing"}, not ${issuer}; use the issuer exactly as your identity provider writes it`);
  }
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    const endpoint = doc[key];
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) throw agentXError("CONFIG_INVALID", `${url} has no HTTPS ${key}; check the issuer URL`);
  }
}

export async function collectOidc(input: { env: string; prompter: Prompter; processEnv: NodeJS.ProcessEnv; fetch: typeof fetch; flags: SigninFlags; secretFlags: SigninSecretFlags }): Promise<{ oidc: NonNullable<DeveloperSignInSettings["oidc"]>; clientSecret: string }> {
  const { prompter, flags } = input;
  const issuer = (flags.oidcIssuer ?? await prompter.ask("Company sign-in issuer URL (for example https://acme.okta.com)", {
    flag: SIGNIN_FLAG_NAMES.oidcIssuer, validate: (value) => (value.startsWith("https://") ? undefined : "must start with https://"),
  })).replace(/\/+$/, "");
  if (!issuer.startsWith("https://")) throw agentXError("CONFIG_INVALID", "the company issuer URL must start with https://");
  await checkOidcDiscovery(input.fetch, issuer);
  const clientId = flags.oidcClientId ?? await prompter.ask("Client ID of the company sign-in app", { flag: SIGNIN_FLAG_NAMES.oidcClientId });
  const clientSecret = await secretFromSource({ what: "company sign-in client secret", flag: SIGNIN_FLAG_NAMES.oidcClientSecret, source: input.secretFlags.oidcClientSecret ?? {}, processEnv: input.processEnv, prompter });
  const claim = (flags.oidcRequiredClaim ?? await prompter.ask("Claim a person must carry to use AgentX, for example groups (leave empty for none)", { flag: SIGNIN_FLAG_NAMES.oidcRequiredClaim, defaultValue: "" })).trim();
  const values = claim === "" ? [] : (flags.oidcRequiredValues ?? await prompter.ask(`Values of ${claim} that may use AgentX, comma-separated`, { flag: SIGNIN_FLAG_NAMES.oidcRequiredValues }))
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (claim !== "" && values.length === 0) throw agentXError("CONFIG_INVALID", `name at least one value of ${claim} with ${SIGNIN_FLAG_NAMES.oidcRequiredValues}`);
  const displayName = (flags.oidcDisplayName ?? await prompter.ask("Name on the sign-in button, for example Okta", { flag: SIGNIN_FLAG_NAMES.oidcDisplayName, defaultValue: "Company sign-in" })).trim().slice(0, 40);
  return {
    oidc: { issuer, clientId, ...(claim === "" ? {} : { requiredClaim: claim, requiredValues: values }), displayName, clientSecretName: oidcSecretName(input.env) },
    clientSecret,
  };
}

export async function storeOidcSecret(secrets: InitSecrets, env: string, clientSecret: string): Promise<void> {
  const name = oidcSecretName(env);
  const value = JSON.stringify({ clientSecret });
  if ((await secrets.arn(name)) === undefined) await secrets.create(name, value);
  else await secrets.put(name, value);
}

/** Where the company identity provider sends a developer back: the control plane's callback route. */
export function oidcSignInCallbackUrl(apiEndpoint: string): string {
  return `${apiEndpoint.replace(/\/+$/, "")}/v1/auth/callback/oidc`;
}

/** Client credentials collected but not yet stored: where they go, and the write itself. */
export interface SignInCredentials { secretName: string; store: () => Promise<void> }

export interface SignInQuestionsInput {
  env: string; apiEndpoint: string; secrets: InitSecrets; prompter: Prompter; processEnv: NodeJS.ProcessEnv;
  flags: SigninFlags; secretFlags: SigninSecretFlags; write: (line: string) => void;
}

/**
 * The Slack half of turning sign-in on, shared by agentx init and agentx signin enable (F16):
 * checks the bot token's workspace and scopes, names the redirect URL, and asks for the app's
 * client credentials. Nothing is stored here: `credentials.store` writes them into the Slack
 * secret, and applySignInChange calls it only once the change is confirmed (F21).
 */
export async function enableSlackSignIn(input: SignInQuestionsInput & { slackApi: SlackApi; expectedTeamId?: string }): Promise<{ teamId: string; credentials: SignInCredentials }> {
  const { teamId } = await slackSignInPrerequisites({ env: input.env, secrets: input.secrets, slackApi: input.slackApi, ...(input.expectedTeamId === undefined ? {} : { expectedTeamId: input.expectedTeamId }) });
  input.write(`Check that the Slack app's OAuth & Permissions page lists the redirect URL ${slackSignInCallbackUrl(input.apiEndpoint)} and the user scopes openid, email and profile.`);
  const client = await collectSlackClient(input);
  const name = slackSecretName(input.env);
  return { teamId, credentials: { secretName: name, store: async () => { await input.secrets.put(name, slackSecretWithSignIn(await input.secrets.get(name), client)); } } };
}

/**
 * The company half, shared the same way (F16): checks the issuer's discovery document, asks for
 * the app and its rules, and names the redirect URI to register. `credentials.store` writes the
 * client secret to agentx/<env>/developer-oidc, only once the change is confirmed (F21).
 */
export async function enableOidcSignIn(input: SignInQuestionsInput & { fetch: typeof fetch }): Promise<{ oidc: NonNullable<DeveloperSignInSettings["oidc"]>; credentials: SignInCredentials }> {
  const { oidc, clientSecret } = await collectOidc(input);
  input.write(`Register this redirect URI with your identity provider: ${oidcSignInCallbackUrl(input.apiEndpoint)}`);
  return { oidc, credentials: { secretName: oidcSecretName(input.env), store: () => storeOidcSecret(input.secrets, input.env, clientSecret) } };
}
