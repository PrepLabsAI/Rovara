import { SlackWorkspaceScopeSchema } from "@agentx/contracts";
import { slackCompanyDependenciesFromEnvironment } from "./slack-company-wiring.js";
import { slackCallerToken, type SlackCallerWorkspaces } from "./slack-workspace-tokens.js";
import { handleSlackInstallRequest, slackInstallSecretsFromSecretsManager } from "./slack-install-identity.js";
import { SlackWorkspaceRefused } from "./slack-workspace-binding.js";
// packages/broker/src/aws/developer-identity.ts
// The DeveloperIdentity Lambda (spec 025 phase 25a): wires the sign-in server to AWS. The only
// new role that reads the Slack secret (R2); it never logs a secret, and never repeats a secret's
// text in an error (a JSON parse error can quote it, so parse errors are replaced).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import type { ChannelByNameRequest, ChannelInfoRequest, ChannelMembersRequest, DeveloperSignInMethod, EndDeveloperSessionsRequest, ListSignInClientsRequest, PutSignInClientRequest, RemoveSignInClientRequest, SlackAuthCheckRequest, SlackUserByEmailRequest, TaskChannelPeopleRequest, TaskPersonProofRequest } from "@agentx/contracts";
import { ProviderNotConfiguredError, githubSignInProvider, oidcSignInProvider, slackSignInProvider, type SignInProvider } from "../developer/providers.js";
import { createDeveloperIdentityHandler, type DeveloperIdentityConfig, type SlackInstallInvoke } from "../developer/server.js";
import { slackDirectory } from "../developer/slack-directory.js";
import { slackDirectoryCallFromEnvironment } from "./slack-directory-channel.js";
import { DeveloperSignInStore, methodSince } from "../developer/store.js";
import { CompanySignInStore } from "../developer/company-membership.js";
import { companyIssuerProvider } from "../developer/company-issuer.js";
import { CompanyInviteStore } from "../developer/company-invites.js";
import { CompanyImportStore } from "../developer/company-import.js";
import type { StepUpDependencies } from "../developer/step-up.js";
import { POLICY_QUESTION_KEY_PURPOSE, kmsTokenSigner } from "../developer/tokens.js";
import type { HttpApiV2Event } from "./lambda.js";
import { sesStepUpEmailSender, stepUpEmailSenderAddress } from "./step-up-email.js";

const SECRET_CACHE_MS = 5 * 60 * 1000;
const SLACK_JWKS_URI = "https://slack.com/openid/connect/keys";

export type DeveloperIdentityLambdaConfig = DeveloperIdentityConfig & {
  oidcSettings?: { issuer: string; clientId: string; requiredClaim?: string; requiredValues: string[]; administrator?: { claim: string; values: string[] } };
  /** Set instead of oidcSettings when the company sign-in settings are unusable. Only that method
   * then refuses ("not finished"); Slack sign-in, keys, refresh and the invoke keep working. */
  oidcProblem?: string;
  /** DEC 254h: GitHub's OAuth app client id, and the name of the secret holding its client secret (read by reference only); or what is missing. */
  githubSettings?: { clientId: string; secretId: string };
  githubProblem?: string;
};

/** Reads the given environment (F1: never process.env directly), so it can be tested. */
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredValuesFrom(text: string | undefined): string[] {
  const invalid = () => new Error("DEVELOPER_OIDC_REQUIRED_VALUES must be a JSON array of strings");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text === undefined || text === "" ? "[]" : text);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) throw invalid();
  return parsed.filter((value) => value !== "");
}

/**
 * Spec 063 FR-005: who is an administrator, read from the admin client's own settings (ADMIN_OIDC_ISSUER, ADMIN_CLAIM,
 * ADMIN_VALUES). Only when company sign-in is that same identity provider: another provider's claim of the same name
 * means nothing here. Anything unreadable makes nobody an administrator.
 */
function administratorFrom(env: NodeJS.ProcessEnv, issuer: string): { administrator: { claim: string; values: string[] } } | Record<string, never> {
  const normalized = (text: string) => text.trim().replace(/\/+$/, "");
  const adminIssuer = env.ADMIN_OIDC_ISSUER ?? "";
  const claim = env.ADMIN_CLAIM ?? "";
  if (adminIssuer === "" || claim === "" || normalized(adminIssuer) !== normalized(issuer)) return {};
  let values: unknown;
  try {
    values = JSON.parse(env.ADMIN_VALUES ?? "");
  } catch {
    return {};
  }
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) return {};
  const nonEmpty = values.filter((value) => value !== "");
  return nonEmpty.length === 0 ? {} : { administrator: { claim, values: nonEmpty } };
}

function sinceFrom(text: string | undefined): { since: number } | Record<string, never> {
  const since = methodSince(text);
  return since === undefined ? {} : { since };
}

/** The GitHub OAuth app's client id: letters, digits, dots, dashes and underscores. */
export const GITHUB_CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
/** DEC 254h: GitHub sign-in's settings. Off unless DEVELOPER_SIGNIN_GITHUB is exactly "enabled"; on but unusable: a fixed problem, never a guess. */
function githubFrom(env: NodeJS.ProcessEnv): Pick<DeveloperIdentityLambdaConfig, "github" | "githubSettings" | "githubProblem"> {
  if (env.DEVELOPER_SIGNIN_GITHUB !== "enabled") return {};
  const github = { github: sinceFrom(env.DEVELOPER_GITHUB_SINCE) };
  const clientId = env.DEVELOPER_GITHUB_CLIENT_ID ?? "";
  const secretId = env.DEVELOPER_GITHUB_SECRET_ID ?? "";
  if (!GITHUB_CLIENT_ID.test(clientId)) return { ...github, githubProblem: "DEVELOPER_GITHUB_CLIENT_ID is not set; ask an admin to run agentx signin enable github" };
  if (secretId === "") return { ...github, githubProblem: "DEVELOPER_GITHUB_SECRET_ID is not set; ask an admin to run agentx signin enable github" };
  return { ...github, githubSettings: { clientId, secretId } };
}

export function developerIdentityConfigFromEnvironment(env: NodeJS.ProcessEnv): DeveloperIdentityLambdaConfig {
  const issuer = env.DEVELOPER_OIDC_ISSUER ?? "";
  const teamId = env.SLACK_TEAM_ID ?? "";
  const config: DeveloperIdentityLambdaConfig = {
    ...githubFrom(env),
    env: required(env, "AGENTX_ENV"),
    issuer: required(env, "DEVELOPER_TOKEN_ISSUER"),
    slack: { enabled: env.DEVELOPER_SIGNIN_SLACK === "enabled", ...(teamId === "" ? {} : { teamId }), ...sinceFrom(env.DEVELOPER_SIGNIN_SLACK_SINCE) },
    // Spec 025 E16: absent means the pop-up is allowed; only named environments set it.
    ...(env.MCP_CONFIRM_ELICITATION === "disabled" ? { confirmElicitation: false } : {}),
  };
  if (issuer === "") return config;
  const withOidc = { ...config, oidc: { displayName: env.DEVELOPER_OIDC_DISPLAY_NAME || "Company sign-in", ...sinceFrom(env.DEVELOPER_OIDC_SINCE) } };
  const problem = (text: string) => ({ ...withOidc, oidcProblem: `${text}; ask an admin to run agentx signin enable oidc` });
  const clientId = env.DEVELOPER_OIDC_CLIENT_ID ?? "";
  if (clientId === "") return problem("DEVELOPER_OIDC_CLIENT_ID is not set");
  const requiredClaim = env.DEVELOPER_OIDC_REQUIRED_CLAIM ?? "";
  let requiredValues: string[];
  try {
    requiredValues = requiredValuesFrom(env.DEVELOPER_OIDC_REQUIRED_VALUES);
  } catch (error) {
    return problem((error as Error).message);
  }
  if (requiredValues.length > 0 && requiredClaim === "") return problem("DEVELOPER_OIDC_REQUIRED_VALUES is set but DEVELOPER_OIDC_REQUIRED_CLAIM is empty");
  return { ...withOidc, oidcSettings: { issuer, clientId, ...(requiredClaim === "" ? {} : { requiredClaim }), requiredValues, ...administratorFrom(env, issuer) } };
}

/** A provider an admin has not finished setting up: every call says so, with what to fix. */
export function unconfiguredProvider(method: DeveloperSignInMethod, message: string): SignInProvider {
  const refuse = () => Promise.reject(new ProviderNotConfiguredError(message));
  return { method, authorizeUrl: refuse, complete: refuse };
}

function parseSecretObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProviderNotConfiguredError(`the ${what} is not valid JSON; ask an admin to run agentx signin check`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderNotConfiguredError(`the ${what} is not a JSON object; ask an admin to run agentx signin check`);
  }
  return value as Record<string, unknown>;
}

/** F25: a secret without a bot token means an admin has not finished setting Slack up. */
export function parseSlackSignInSecret(json: string): { botToken: string; clientId?: string; clientSecret?: string } {
  const value = parseSecretObject(json, "Slack secret");
  if (typeof value.botToken !== "string" || !value.botToken.startsWith("xoxb-")) {
    throw new ProviderNotConfiguredError("the Slack secret has no bot token yet; ask an admin to run agentx signin check");
  }
  return {
    botToken: value.botToken,
    ...(typeof value.clientId === "string" && value.clientId !== "" ? { clientId: value.clientId } : {}),
    ...(typeof value.clientSecret === "string" && value.clientSecret !== "" ? { clientSecret: value.clientSecret } : {}),
  };
}

/** DEC 254h: the GitHub OAuth app's secret, `{"clientSecret": "..."}`, as the company sign-in's. Its value is never logged or echoed. */
export function parseGithubClientSecret(json: string): string {
  const secret = parseSecretObject(json, "GitHub sign-in secret").clientSecret;
  if (typeof secret !== "string" || secret === "") throw new ProviderNotConfiguredError("the GitHub sign-in secret has no clientSecret; ask an admin to store it, then run agentx signin check");
  return secret;
}

export function parseOidcClientSecret(json: string): string {
  const secret = parseSecretObject(json, "company sign-in secret").clientSecret;
  if (typeof secret !== "string" || secret === "") {
    throw new ProviderNotConfiguredError("the company sign-in secret has no clientSecret; ask an admin to run agentx signin enable oidc");
  }
  return secret;
}

/** One remote key set per URI, so jose's key cache and refetch cooldown apply across sign-ins. */
export function remoteJwksCache(create: (url: URL) => JWTVerifyGetKey = (url) => createRemoteJWKSet(url), maximum = Infinity): (uri: string) => JWTVerifyGetKey {
  const cache = new Map<string, JWTVerifyGetKey>();
  return (uri) => {
    let jwks = cache.get(uri);
    if (jwks === undefined) {
      jwks = create(new URL(uri));
      if (cache.size >= maximum) cache.delete(cache.keys().next().value!);
      cache.set(uri, jwks);
    }
    return jwks;
  };
}

/** Only derived company secret names enter this bounded per-Lambda cache. */
export function companySecretReader(secrets: SecretsManagerClient): (name: string) => Promise<string> {
  const companySecrets = new Map<string, () => Promise<string>>();
  return (name) => {
    let read = companySecrets.get(name);
    if (read === undefined) {
      if (companySecrets.size >= 50) companySecrets.delete(companySecrets.keys().next().value!);
      read = cachedSecret(secrets, name, parseOidcClientSecret); companySecrets.set(name, read);
    }
    return read();
  };
}

function cachedSecret<T>(client: SecretsManagerClient, secretId: string, parse: (text: string) => T): () => Promise<T> {
  let cached: { value: Promise<T>; at: number } | undefined;
  return () => {
    if (cached === undefined || Date.now() - cached.at > SECRET_CACHE_MS) {
      const value = client.send(new GetSecretValueCommand({ SecretId: secretId })).then((response) => parse(response.SecretString ?? ""));
      cached = { value, at: Date.now() };
      value.catch(() => { cached = undefined; });
    }
    return cached.value;
  };
}

/** Optional task public key: reuse the signer's cached KMS read, never sign here. */
export function taskPublicKeysFromEnvironment(env: NodeJS.ProcessEnv, kms: Parameters<typeof kmsTokenSigner>[0]["kms"]): ReadonlyArray<Pick<ReturnType<typeof kmsTokenSigner>, "publicJwk">> {
  const keyId = env.TASK_TOKEN_KEY_ARN;
  return keyId === undefined || keyId === "" ? [] : [kmsTokenSigner({ kms, keyId })];
}

/**
 * Hosted wiring (c): every extra key the JWKS publishes, with its purpose: the task key (as before, first) and, where the install has one, the policy hook's question key
 * (POLICY_HOOK_KEY_ARN, purpose `policy-question`). Only the public half is read here; this function may not sign with either (each key's policy says so).
 */
export interface PublishedExtraKey { purpose: "task" | typeof POLICY_QUESTION_KEY_PURPOSE; publicJwk: ReturnType<typeof kmsTokenSigner>["publicJwk"] }
export function extraPublicKeysFromEnvironment(env: NodeJS.ProcessEnv, kms: Parameters<typeof kmsTokenSigner>[0]["kms"]): PublishedExtraKey[] {
  const policyKey = env.POLICY_HOOK_KEY_ARN;
  const keys: PublishedExtraKey[] = taskPublicKeysFromEnvironment(env, kms).map((key) => ({ purpose: "task", publicJwk: () => key.publicJwk() }));
  if (policyKey !== undefined && policyKey !== "") {
    const policy = kmsTokenSigner({ kms, keyId: policyKey });
    keys.push({ purpose: POLICY_QUESTION_KEY_PURPOSE, publicJwk: () => policy.publicJwk() });
  }
  return keys;
}

/** The name passkeys show for this install (WebAuthn's relying-party name). */
export const PASSKEY_RP_NAME = "AgentX";

/**
 * Hosted wiring (a) and (b): the factors Code owns for a step-up, from the function's environment.
 *   - STEP_UP_EMAIL_FROM: the verified SES identity the code is sent from. Empty or not one plain address: no email factor (logged once, in fixed words).
 *   - DEVELOPER_PASSKEYS=enabled: passkeys on, with the relying-party id the API's own host (the sign-in issuer's host), so the expected origin is always the issuer's.
 * Neither set: undefined, and a step-up is refused for everyone, exactly as before.
 */
export function stepUpFromEnvironment(env: NodeJS.ProcessEnv, issuer: string, ses: () => Pick<SESv2Client, "send">, log: (entry: Record<string, unknown>) => void): StepUpDependencies | undefined {
  const configured = env.STEP_UP_EMAIL_FROM ?? "";
  const from = stepUpEmailSenderAddress(configured);
  if (configured !== "" && from === undefined) log({ event: "signin.step_up_email_not_configured", detail: "STEP_UP_EMAIL_FROM is not one plain address" });
  const passkeys = env.DEVELOPER_PASSKEYS === "enabled" ? { rpId: new URL(issuer).hostname, rpName: PASSKEY_RP_NAME } : undefined;
  if (from === undefined && passkeys === undefined) return undefined;
  return {
    ...(from === undefined ? {} : { email: sesStepUpEmailSender({ ses: ses(), from }) }),
    ...(passkeys === undefined ? {} : { passkeys }),
  };
}

let built: ReturnType<typeof createDeveloperIdentityHandler> | undefined;

export function createAwsDeveloperIdentityHandler(env: NodeJS.ProcessEnv, workspaces?: SlackCallerWorkspaces, legacyTeamId?: string): ReturnType<typeof createDeveloperIdentityHandler> {
  const region = env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION };
  const config = developerIdentityConfigFromEnvironment(env);
  const secrets = new SecretsManagerClient(region);
  const slackSecret = cachedSecret(secrets, required(env, "SLACK_SECRET_ARN"), parseSlackSignInSecret);
  const now = () => Date.now();
  const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));
  const jwksFor = remoteJwksCache();
  const oidcSettings = config.oidcSettings;
  const oidcSecretId = env.DEVELOPER_OIDC_SECRET_ID ?? "";
  const oidcProvider = (): SignInProvider | undefined => {
    if (config.oidc === undefined) return undefined;
    if (config.oidcProblem !== undefined) return unconfiguredProvider("oidc", config.oidcProblem);
    if (oidcSettings === undefined || oidcSecretId === "") return unconfiguredProvider("oidc", "DEVELOPER_OIDC_SECRET_ID is not set; ask an admin to run agentx signin enable oidc");
    return oidcSignInProvider({ ...oidcSettings, clientSecret: cachedSecret(secrets, oidcSecretId, parseOidcClientSecret), fetch, jwksFor, now });
  };
  const oidc = oidcProvider();
  const github = config.github === undefined ? undefined
    : config.githubSettings === undefined ? unconfiguredProvider("github", config.githubProblem ?? "GitHub sign-in is not set up; ask an admin to run agentx signin enable github")
      : githubSignInProvider({ clientId: config.githubSettings.clientId, clientSecret: cachedSecret(secrets, config.githubSettings.secretId, parseGithubClientSecret), fetch, now });
  if (config.githubProblem !== undefined) log({ event: "signin.not_configured", method: "github", detail: config.githubProblem });
  if (config.oidcProblem !== undefined) log({ event: "signin.not_configured", method: "oidc", detail: config.oidcProblem });
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(region), { marshallOptions: { removeUndefinedValues: true } });
  const tableName = required(env, "DEVELOPER_SIGNIN_TABLE_NAME");
  const company = env.COMPANY_SIGNIN === "enabled" ? new CompanySignInStore({ documentClient, tableName, now }) : undefined;
  const readCompanySecret = companySecretReader(secrets);
  const companyJwksFor = remoteJwksCache(undefined, 50);
  const directory = slackDirectory({ teamId: config.slack.teamId, botToken: async () => (await slackSecret()).botToken, fetch, now, ...directoryCall(secrets),
    report: (problem) => log({ event: "signin.slack_problem", ...problem }) });
  return createDeveloperIdentityHandler({
    config,
    store: new DeveloperSignInStore({
      documentClient,
      tableName,
      now,
    }),
    ...(company === undefined ? {} : { company, companyIssuer: companyIssuerProvider({ store: company, env: config.env, readSecret: readCompanySecret, fetch, jwksFor: companyJwksFor, now }),
      // DEC 254a, 253z: invite codes and self-serve create, only with the company layer.
      companyInvites: new CompanyInviteStore({ documentClient, tableName, now, company }) }),
    // DEC 254b (b): the operator's company import runs BEFORE the company layer is switched on, so it is there with the layer on or off.
    companyImport: new CompanyImportStore({ documentClient, tableName, now }),
    signer: kmsTokenSigner({ kms: new KMSClient(region), keyId: required(env, "DEVELOPER_TOKEN_KEY_ARN") }),
    extraPublicKeys: extraPublicKeysFromEnvironment(env, new KMSClient(region)),
    providers: {
      // DEC 254e: with Code's company layer on, any Slack workspace may sign in (the company still comes only from membership).
      slack: slackSignInProvider({ ...(company === undefined ? {} : { anyWorkspace: true }), teamId: config.slack.teamId, credentials: slackSecret, fetch, jwks: jwksFor(SLACK_JWKS_URI), now }),
      ...(oidc === undefined ? {} : { oidc }),
      ...(github === undefined ? {} : { github }),
    },
    directory,
    ...(workspaces === undefined ? {} : { directoryForWorkspace: createWorkspaceSlackDirectory({ legacy: directory, workspaces, fetch, now, ...(legacyTeamId === undefined ? {} : { legacyTeamId }) }) }),
    now,
    log,
    ...stepUpOf(stepUpFromEnvironment(env, config.issuer, () => new SESv2Client(region), log)),
    // Guided onboarding PR 4: Add to Slack's Slack side, beside the Slack app's client secret; with the company layer only.
    ...(company === undefined ? {} : { slackInstall: (event: unknown) => handleSlackInstallRequest({ appClient: slackSecret, secrets: slackInstallSecretsFromSecretsManager(secrets, config.env), fetch }, event) }),
  });
}

function stepUpOf(stepUp: StepUpDependencies | undefined): { stepUp?: StepUpDependencies } {
  return stepUp === undefined ? {} : { stepUp };
}

function directoryCall(secrets: SecretsManagerClient): { call?: NonNullable<Parameters<typeof slackDirectory>[0]["call"]> } {
  const call = slackDirectoryCallFromEnvironment(secrets);
  return call === undefined ? {} : { call };
}

export const handler = async (event: HttpApiV2Event | ChannelMembersRequest | TaskPersonProofRequest | TaskChannelPeopleRequest | ChannelInfoRequest | SlackUserByEmailRequest | SlackAuthCheckRequest | EndDeveloperSessionsRequest | ChannelByNameRequest
  | PutSignInClientRequest | RemoveSignInClientRequest | ListSignInClientsRequest | SlackInstallInvoke) => {
  built ??= identityFromEnvironment(process.env);
  return built(event);
};

/** One directory per company/team, with a TOTAL bound across all workspaces in this process. */
export function createWorkspaceSlackDirectory(options: {
  legacy: ReturnType<typeof slackDirectory>;
  workspaces?: SlackCallerWorkspaces;
  /**
   * L2-2 PR 18c: the install's team, and a request naming no workspace, keep today's answer exactly. Company mode needs company sign-in, and with company sign-in on and no
   * company directory today's DeveloperIdentity answers every directory read "slack_unavailable" (server.ts); refusing here gives that same answer.
   */
  legacyTeamId?: string;
  fetch: typeof fetch;
  now(): number;
}) {
  const cache = new Map<string, ReturnType<typeof slackDirectory>>();
  return async (value: unknown): Promise<ReturnType<typeof slackDirectory>> => {
    if (options.workspaces === undefined) return options.legacy;
    if (options.legacyTeamId !== undefined && (value === undefined || (value !== null && typeof value === "object" && (value as { teamId?: unknown }).teamId === options.legacyTeamId))) throw new SlackWorkspaceRefused();
    const workspaces = options.workspaces;
    try {
      const parsed = SlackWorkspaceScopeSchema.safeParse(value);
      if (!parsed.success || await workspaces.requireCompany(parsed.data.teamId) !== parsed.data.companyId) throw new SlackWorkspaceRefused();
      const scope = parsed.data;
      const key = `${scope.companyId}/${scope.teamId}`;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const directory = slackDirectory({ teamId: scope.teamId, botToken: () => slackCallerToken(workspaces, scope), fetch: options.fetch, now: () => options.now() });
      if (cache.size >= 50) cache.delete(cache.keys().next().value!);
      cache.set(key, directory);
      return directory;
    } catch { throw new SlackWorkspaceRefused(); }
  };
}

/** L2-2 PR 18c: with Slack company mode on (slack-company-wiring.ts), the company directory for other teams; off, today's handler. */
function identityFromEnvironment(env: NodeJS.ProcessEnv): ReturnType<typeof createDeveloperIdentityHandler> {
  const region = env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION };
  const dynamo = new DynamoDBClient(region);
  const wiring = slackCompanyDependenciesFromEnvironment(env, { documentClient: DynamoDBDocumentClient.from(dynamo), dynamo, secrets: new SecretsManagerClient(region) });
  return wiring === undefined ? createAwsDeveloperIdentityHandler(env) : createAwsDeveloperIdentityHandler(env, wiring.workspaces, wiring.legacyTeamId);
}
