import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  GetSecretValueCommand, PutSecretValueCommand, TagResourceCommand, type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  AgentXError, CredentialRegistrationSchema, OAUTH_AUTHORIZATION_PROFILES, OAuthAppSecretSchema, agentXError, oauthProfile,
} from "@agentx/contracts";
import { createPkceParameters } from "../auth.js";
import { registerCredential } from "./credential.js";

/** The tag the broker role's PutSecretValue grant requires (infra/lib/control-plane.ts). */
export const WRITABLE_TAG = { Key: "agentx-writable", Value: "refresh-token" } as const;
const SIGN_IN_TIMEOUT_MS = 300_000;
const TOKEN_TIMEOUT_MS = 10_000;
const MAX_ACCOUNT_FIELD = 128;
const APP_SECRET_SHAPE = '{"clientId": "...", "clientSecret": "..."}';

/** What `authorize` needs from Secrets Manager, with the administrator's own AWS credentials. */
export interface AuthorizeSecrets {
  /** The secret's value, or undefined when it does not exist. Throws when it is not a string secret. */
  read(secretName: string): Promise<string | undefined>;
  write(secretName: string, value: string): Promise<void>;
  /** Tags the secret so the broker may write a rotated refresh token back to it. */
  tag(secretName: string): Promise<void>;
}

export interface AuthorizeInput {
  controlPlaneUrl: string;
  accessToken: string;
  ref: string;
  secretName: string;
  /** A key of OAUTH_AUTHORIZATION_PROFILES, such as "asana". */
  provider: string;
  secrets: AuthorizeSecrets;
  openBrowser: (url: string) => Promise<void>;
  /**
   * Told the sign-in URL, so an administrator without a local browser can open it elsewhere, and
   * the redirect URL the vendor app must be registered with, as "(the Asana app's redirect URL must be exactly ...)".
   */
  showUrl: (url: string, redirectRequirement: string) => void;
  /**
   * Told which vendor account signed in, as one line, right after the code exchange and before
   * anything is stored or registered, so an administrator can see a wrong-account sign-in. It carries
   * only the account's name and email from the token response, never a token.
   */
  showAccount?: (line: string) => void;
  fetchImplementation?: typeof fetch;
  timeoutMilliseconds?: number;
  /** Tests only: listen on this port instead of the redirect URI's, and report the port bound. */
  listenPort?: number;
  onListening?: (port: number) => void;
  /** The AWS region the secret was read in (the command's --region), named only in a recovery hint. */
  region?: string;
}

/** Reads, writes and tags secrets with the administrator's AWS credentials. */
export function secretsManagerAuthorizeSecrets(client: Pick<SecretsManagerClient, "send">): AuthorizeSecrets {
  return {
    async read(secretName) {
      let response: { SecretString?: string | undefined };
      try {
        response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
      } catch (error) {
        if (error instanceof Error && error.name === "ResourceNotFoundException") return undefined;
        throw agentXError("CONFIG_INVALID", `could not read secret ${secretName} with your AWS credentials (${errorName(error)})`);
      }
      if (typeof response.SecretString === "string") return response.SecretString;
      throw agentXError("CONFIG_INVALID", `secret ${secretName} holds binary data, not a JSON string; store it as a JSON string ${APP_SECRET_SHAPE}`);
    },
    async write(secretName, value) {
      await client.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: value }));
    },
    async tag(secretName) {
      await client.send(new TagResourceCommand({ SecretId: secretName, Tags: [{ ...WRITABLE_TAG }] }));
    },
  };
}

/**
 * Signs a bot user in once through the browser (authorization code with PKCE S256 and a random
 * state), stores the refresh token in the credential's secret beside the app's client, tags the
 * secret for write-back, and registers it as oauth-refresh-token. Never prints or returns a token,
 * the authorization code or the client secret.
 */
export async function authorizeCredential(input: AuthorizeInput): Promise<unknown> {
  const registration = CredentialRegistrationSchema.safeParse({ ref: input.ref, type: "oauth-refresh-token", secretName: input.secretName });
  if (!registration.success) throw agentXError("CONFIG_INVALID", `invalid credential registration: ${registration.error.issues[0]?.message}`);
  const profile = oauthProfile(input.provider);
  if (!profile) throw agentXError("CONFIG_INVALID", `no browser sign-in for provider ${input.provider}; known providers: ${Object.keys(OAUTH_AUTHORIZATION_PROFILES).join(", ")}`);

  const raw = await input.secrets.read(input.secretName);
  if (raw === undefined) throw agentXError("CONFIG_INVALID", `secret ${input.secretName} was not found; create it as JSON ${APP_SECRET_SHAPE} first`);
  let json: unknown;
  try { json = JSON.parse(raw); } catch { json = undefined; }
  const app = OAuthAppSecretSchema.safeParse(json);
  if (!app.success) throw agentXError("CONFIG_INVALID", `secret ${input.secretName} must be JSON ${APP_SECRET_SHAPE}`);
  const { clientId, clientSecret } = app.data;

  const vendor = `${input.provider.charAt(0).toUpperCase()}${input.provider.slice(1)}`;
  const redirectRequirement = `(the ${vendor} app's redirect URL must be exactly ${profile.redirectUri})`;
  const pkce = createPkceParameters();
  const callback = await listenForCallback({
    redirectUri: new URL(profile.redirectUri),
    redirectRequirement,
    state: pkce.state,
    timeoutMilliseconds: input.timeoutMilliseconds ?? SIGN_IN_TIMEOUT_MS,
    ...(input.listenPort === undefined ? {} : { port: input.listenPort }),
  });
  let code: string;
  try {
    input.onListening?.(callback.port);
    const authorize = new URL(profile.authorizeUrl);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", profile.redirectUri);
    authorize.searchParams.set("state", pkce.state);
    authorize.searchParams.set("code_challenge", pkce.challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    if (profile.resource !== undefined) authorize.searchParams.set("resource", profile.resource);
    input.showUrl(authorize.href, redirectRequirement);
    // The printed URL still works when no browser can be opened here.
    await input.openBrowser(authorize.href).catch(() => undefined);
    code = await callback.code;
  } finally {
    callback.close();
  }

  const { refreshToken, account } = await exchangeCode({
    tokenUrl: new URL(profile.tokenUrl), code, verifier: pkce.verifier, redirectUri: profile.redirectUri, clientId, clientSecret,
    fetchImplementation: input.fetchImplementation ?? fetch,
  });
  input.showAccount?.(`${account === undefined ? `Signed in to ${vendor} (the account could not be shown)` : `Signed in to ${vendor} as ${account}`}. This must be the connector's bot user; if it is not, run the command again with the sign-in URL opened in a private window signed in as the bot user.`);
  await input.secrets.write(input.secretName, JSON.stringify({ clientId, clientSecret, refreshToken })).catch((error: unknown) => {
    throw agentXError("CONFIG_INVALID", `could not store the refresh token in secret ${input.secretName} with your AWS credentials (${errorName(error)}); nothing was registered, run the command again`);
  });
  await input.secrets.tag(input.secretName).catch((error: unknown) => {
    throw agentXError("CONFIG_INVALID", `stored the refresh token in secret ${input.secretName} but could not tag it ${WRITABLE_TAG.Key}=${WRITABLE_TAG.Value} with your AWS credentials (${errorName(error)}); nothing was registered, run the command again`);
  });
  try {
    return await registerCredential({ controlPlaneUrl: input.controlPlaneUrl, accessToken: input.accessToken, ref: input.ref, type: "oauth-refresh-token", secretName: input.secretName }, input.fetchImplementation);
  } catch (error) {
    // The sign-in already succeeded: say how to finish without signing in again.
    const register = `finish with \`agentx admin credential register --ref ${input.ref} --type oauth-refresh-token --secret ${input.secretName}\` (no new sign-in needed)`;
    // The control plane refusing the secret itself (CONFIG_INVALID) is most often a secret written in
    // another region than the control plane's, where registering again would only fail the same way.
    const wrongRegion = error instanceof AgentXError && error.code === "CONFIG_INVALID";
    throw withRecovery(error, wrongRegion
      ? `the refresh token is stored and tagged in secret ${input.secretName} in ${input.region ?? "your default AWS region"}, but the control plane reads secrets in its own AWS region: if that is a different region, run the command again with --region set to the control plane's region; otherwise ${register}`
      : `the refresh token is stored and tagged in secret ${input.secretName}; ${register}`);
  }
}

/**
 * A registration failure with the recovery appended: an AgentX error keeps its code and message; any
 * other error becomes a plain one (INTERNAL_ERROR at the CLI) naming only its class, and deliberately
 * carries no `cause`, since its message can echo request data.
 */
function withRecovery(error: unknown, recovery: string): Error {
  if (error instanceof AgentXError) {
    const prefix = `${error.code}: `;
    const message = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
    return agentXError(error.code, `${message}; ${recovery}`);
  }
  return new Error(`could not register the credential (${errorName(error)}); ${recovery}`);
}

async function exchangeCode(input: {
  tokenUrl: URL; code: string; verifier: string; redirectUri: string; clientId: string; clientSecret: string; fetchImplementation: typeof fetch;
}): Promise<{ refreshToken: string; account: string | undefined }> {
  const response = await input.fetchImplementation(input.tokenUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier,
      client_id: input.clientId, client_secret: input.clientSecret,
    }).toString(),
  }).catch((error: unknown) => {
    throw agentXError("AUTH_REQUIRED", `could not reach the token endpoint (${errorName(error)}); nothing was stored`);
  });
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (!response.ok) {
    const code = typeof record.error === "string" && /^[a-z_]{1,64}$/.test(record.error) ? ` (${record.error})` : "";
    throw agentXError("AUTH_REQUIRED", `the token endpoint refused the sign-in with HTTP ${response.status}${code}; nothing was stored`);
  }
  if (typeof record.refresh_token !== "string" || record.refresh_token.length === 0) {
    throw agentXError("AUTH_REQUIRED", "the token endpoint returned no refresh token, so AgentX could not stay signed in; check the app type in the setup guide. Nothing was stored");
  }
  return { refreshToken: record.refresh_token, account: accountOf(record.data) };
}

/**
 * "Name <email>", "Name" or "email" from the token response's user object (Asana's `data`), or
 * undefined when neither is usable. Both are shown on a terminal, so each keeps printable
 * characters only and at most 128 of them.
 */
function accountOf(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const printable = (value: unknown) => typeof value === "string"
    ? Array.from(value.replace(/[\p{C}]/gu, "")).slice(0, MAX_ACCOUNT_FIELD).join("").trim()
    : "";
  const { name, email } = data as Record<string, unknown>;
  const shownName = printable(name);
  const shownEmail = printable(email);
  if (shownName && shownEmail) return `${shownName} <${shownEmail}>`;
  return shownName || shownEmail || undefined;
}

/**
 * Waits for one browser redirect carrying the expected state. A request with any other state is
 * answered and ignored, so a stale tab or another page cannot end or take over the sign-in. Binds
 * 127.0.0.1 only. Rejects on an `error` redirect with the right state, or after the timeout.
 */
async function listenForCallback(options: { redirectUri: URL; redirectRequirement: string; state: string; timeoutMilliseconds: number; port?: number }): Promise<{ port: number; code: Promise<string>; close: () => void }> {
  const { redirectUri } = options;
  if (redirectUri.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(redirectUri.hostname) || redirectUri.port === "") {
    throw agentXError("CONFIG_INVALID", "the provider's redirect URI must be http://localhost:<port>/<path>");
  }
  const expected = Buffer.from(options.state);
  const matches = (state: string | null) => {
    if (state === null) return false;
    const given = Buffer.from(state);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // The redirect can arrive while the browser is still being opened, before anyone awaits `code`.
  code.catch(() => undefined);
  const finish = (outcome: { code: string } | { error: Error }) => {
    if (settled) return;
    settled = true;
    if ("code" in outcome) resolveCode(outcome.code); else rejectCode(outcome.error);
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== redirectUri.pathname) { response.writeHead(404).end(); return; }
    if (settled) { response.writeHead(410, { "content-type": "text/plain" }).end("This sign-in has already finished. You can close this tab."); return; }
    if (!matches(url.searchParams.get("state"))) {
      response.writeHead(400, { "content-type": "text/plain" }).end("This sign-in link is not the one AgentX is waiting for. Use the link the command printed.");
      return;
    }
    const error = url.searchParams.get("error");
    const authorizationCode = url.searchParams.get("code");
    if (error !== null || !authorizationCode) {
      response.writeHead(200, { "content-type": "text/plain" }).end("Sign-in was not completed. You can close this tab and run the command again.");
      const shown = error !== null && /^[a-z_]{1,64}$/.test(error) ? ` (${error})` : "";
      finish({ error: agentXError("AUTH_REQUIRED", `the sign-in was refused or cancelled${shown}; nothing was stored`) });
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" }).end("AgentX received the sign-in. You can close this tab.");
    finish({ code: authorizationCode });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE"
        ? agentXError("CONFIG_INVALID", `port ${redirectUri.port} is in use; stop whatever is listening on it and run the command again`)
        : error);
    });
    server.listen(options.port ?? Number(redirectUri.port), "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sign-in listener did not bind TCP");
  const timer = setTimeout(() => finish({ error: agentXError("AUTH_REQUIRED", `no sign-in arrived within ${Math.round(options.timeoutMilliseconds / 1000)} seconds ${options.redirectRequirement}; nothing was stored`) }), options.timeoutMilliseconds);
  timer.unref();
  return {
    port: address.port,
    code,
    close: () => { clearTimeout(timer); server.closeAllConnections(); server.close(); },
  };
}

/** An error's class name, never its message: vendor and AWS messages can echo request data. */
function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "unknown error";
}
