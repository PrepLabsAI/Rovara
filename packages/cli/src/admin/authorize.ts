import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  GetSecretValueCommand, PutSecretValueCommand, TagResourceCommand, type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  AgentXError, CredentialRegistrationSchema, OAUTH_AUTHORIZATION_PROFILES, OAuthAppSecretSchema, agentXError, mcpEndpointProblem, oauthProfile,
} from "@agentx/contracts";
import { createPkceParameters } from "../auth.js";
import { registerCredential } from "./credential.js";
import { discoverOAuth, registerClient } from "./oauth-discovery.js";

/** The tag the broker role's PutSecretValue grant requires (infra/lib/control-plane.ts). */
export const WRITABLE_TAG = { Key: "agentx-writable", Value: "refresh-token" } as const;
const SIGN_IN_TIMEOUT_MS = 300_000;
const TOKEN_TIMEOUT_MS = 10_000;
const MAX_ACCOUNT_FIELD = 128;
const APP_SECRET_SHAPE = '{"clientId": "...", "clientSecret": "..."}';
/** The redirect a generic (`--endpoint`) sign-in listens on; the OAuth app, or a registered client, must allow it. */
export const GENERIC_REDIRECT_URI = "http://localhost:8765/callback";

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
  /** A key of OAUTH_AUTHORIZATION_PROFILES, such as "asana". Exactly one of provider and endpoint. */
  provider?: string;
  /**
   * Spec 055 phase 2: a generic MCP server's endpoint. Its sign-in is discovered (RFC 9728, RFC 8414)
   * unless authorizeUrl and tokenUrl are both given, and the credential is registered pinned to its
   * host with the token URL and resource.
   */
  endpoint?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  /** Space-separated scopes to ask for; defaults to what the server asks for or lists. */
  scope?: string;
  /** Register AgentX as the server's client (RFC 7591) instead of reading one from the secret. */
  registerClient?: boolean;
  secrets: AuthorizeSecrets;
  /** Opens the sign-in URL in a browser; when absent (`--no-browser`), the URL is only shown. */
  openBrowser?: (url: string) => Promise<void>;
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
  /**
   * The bot user's email (`--expect-account`). When set, a sign-in by any other account, or by one
   * whose email the token response does not carry, is refused after the code exchange and before
   * anything is stored, tagged or registered. Compared trimmed and case-insensitively.
   */
  expectAccount?: string;
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
  const expectedEmail = expectedAccountEmail(input.expectAccount);
  const signIn = await resolveSignIn(input);
  const generic = signIn.generic;
  const registrationFields = { ref: input.ref, type: "oauth-refresh-token", secretName: input.secretName, ...(generic ?? {}) } as const;
  // Checked before the browser opens, so a discovered URL AgentX would refuse fails first.
  const registration = CredentialRegistrationSchema.safeParse(registrationFields);
  if (!registration.success) throw agentXError("CONFIG_INVALID", `invalid credential registration: ${registration.error.issues[0]?.message}`);

  const raw = await input.secrets.read(input.secretName);
  let client: { clientId: string; clientSecret?: string | undefined };
  if (input.registerClient) {
    if (raw === undefined) throw agentXError("CONFIG_INVALID", `secret ${input.secretName} was not found; create it first (its value can be {}), then run the command again`);
    if (signIn.registrationUrl === undefined) throw agentXError("CONFIG_INVALID", `${signIn.vendor} does not offer client registration; create an OAuth app, store ${APP_SECRET_SHAPE} in ${input.secretName}, and run the command again without --register-client`);
    client = await registerClient(signIn.registrationUrl, signIn.redirectUri, input.fetchImplementation ?? fetch);
  } else {
    if (raw === undefined) throw agentXError("CONFIG_INVALID", `secret ${input.secretName} was not found; create it as JSON ${APP_SECRET_SHAPE} first`);
    let json: unknown;
    try { json = JSON.parse(raw); } catch { json = undefined; }
    const app = OAuthAppSecretSchema.safeParse(json);
    if (!app.success) throw agentXError("CONFIG_INVALID", `secret ${input.secretName} must be JSON ${APP_SECRET_SHAPE}`);
    client = { clientId: app.data.clientId, clientSecret: app.data.clientSecret };
  }
  const { clientId, clientSecret } = client;

  const vendor = signIn.vendor;
  const redirectRequirement = `(the ${vendor} app's redirect URL must be exactly ${signIn.redirectUri})`;
  const pkce = createPkceParameters();
  const callback = await listenForCallback({
    redirectUri: new URL(signIn.redirectUri),
    redirectRequirement,
    state: pkce.state,
    timeoutMilliseconds: input.timeoutMilliseconds ?? SIGN_IN_TIMEOUT_MS,
    ...(input.listenPort === undefined ? {} : { port: input.listenPort }),
  });
  let code: string;
  try {
    input.onListening?.(callback.port);
    const authorize = new URL(signIn.authorizeUrl);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", signIn.redirectUri);
    authorize.searchParams.set("state", pkce.state);
    authorize.searchParams.set("code_challenge", pkce.challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    if (signIn.scopes.length > 0) authorize.searchParams.set("scope", signIn.scopes.join(" "));
    if (signIn.resource !== undefined) authorize.searchParams.set("resource", signIn.resource);
    input.showUrl(authorize.href, redirectRequirement);
    // The printed URL still works when no browser can be opened here.
    await input.openBrowser?.(authorize.href).catch(() => undefined);
    code = await callback.code;
  } finally {
    callback.close();
  }

  const { refreshToken, account } = await exchangeCode({
    tokenUrl: new URL(signIn.tokenUrl), code, verifier: pkce.verifier, redirectUri: signIn.redirectUri, clientId, clientSecret,
    // Only a generic sign-in names the resource on the token request; the Asana profile never has (unchanged).
    resource: generic?.resource, fetchImplementation: input.fetchImplementation ?? fetch,
  });
  const shown = account?.shown;
  input.showAccount?.(`${shown === undefined ? `Signed in to ${vendor} (the account could not be shown)` : `Signed in to ${vendor} as ${shown}`}. This must be the connector's bot user; if it is not, run the command again with the sign-in URL opened in a private window signed in as the bot user.`);
  if (expectedEmail !== undefined && account?.email?.toLowerCase() !== expectedEmail.toLowerCase()) {
    // Compared on the raw email, so a hidden character or text past the shown 128 cannot match.
    throw agentXError("AUTH_REQUIRED", `the sign-in was for ${shown ?? "an account that could not be shown"}, not ${expectedEmail}; nothing was stored or registered. `
      + `Run the command again with --no-browser and open the sign-in URL in a private window signed in as ${expectedEmail}`);
  }
  const stored = { clientId, ...(clientSecret === undefined ? {} : { clientSecret }), refreshToken };
  await input.secrets.write(input.secretName, JSON.stringify(stored)).catch((error: unknown) => {
    throw agentXError("CONFIG_INVALID", `could not store the refresh token in secret ${input.secretName} with your AWS credentials (${errorName(error)}); nothing was registered, run the command again`);
  });
  await input.secrets.tag(input.secretName).catch((error: unknown) => {
    throw agentXError("CONFIG_INVALID", `stored the refresh token in secret ${input.secretName} but could not tag it ${WRITABLE_TAG.Key}=${WRITABLE_TAG.Value} with your AWS credentials (${errorName(error)}); nothing was registered, run the command again`);
  });
  try {
    return await registerCredential({ controlPlaneUrl: input.controlPlaneUrl, accessToken: input.accessToken, ...registrationFields }, input.fetchImplementation);
  } catch (error) {
    // The sign-in already succeeded: say how to finish without signing in again.
    const flags = generic === undefined ? "" : ` --host ${generic.host} --token-url ${generic.tokenUrl}${generic.resource === undefined ? "" : ` --resource ${generic.resource}`}`;
    const register = `finish with \`agentx admin credential register --ref ${input.ref} --type oauth-refresh-token --secret ${input.secretName}${flags}\` (no new sign-in needed)`;
    // The control plane refusing the secret itself (CONFIG_INVALID) is most often a secret written in
    // another region than the control plane's, where registering again would only fail the same way.
    const wrongRegion = error instanceof AgentXError && error.code === "CONFIG_INVALID";
    throw withRecovery(error, wrongRegion
      ? `the refresh token is stored and tagged in secret ${input.secretName} in ${input.region ?? "your default AWS region"}, but the control plane reads secrets in its own AWS region: if that is a different region, run the command again with --region set to the control plane's region; otherwise ${register}`
      : `the refresh token is stored and tagged in secret ${input.secretName}; ${register}`);
  }
}

/** One sign-in's endpoints and, for a generic MCP server, what its credential is registered with. */
interface SignIn {
  vendor: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  resource?: string | undefined;
  scopes: string[];
  registrationUrl?: string | undefined;
  generic?: { host: string; tokenUrl: string; resource?: string } | undefined;
}

/** The built-in provider's profile, or the generic endpoint's sign-in: given, or discovered from the server. */
async function resolveSignIn(input: AuthorizeInput): Promise<SignIn> {
  if ((input.provider === undefined) === (input.endpoint === undefined)) {
    throw agentXError("CONFIG_INVALID", `give exactly one of --provider (${Object.keys(OAUTH_AUTHORIZATION_PROFILES).join(", ")}) and --endpoint <mcp url>`);
  }
  const scopes = input.scope === undefined ? undefined : input.scope.split(" ").filter((scope) => scope !== "");
  if (input.provider !== undefined) {
    if (input.authorizeUrl !== undefined || input.tokenUrl !== undefined || input.registerClient) {
      throw agentXError("CONFIG_INVALID", "--authorize-url, --token-url and --register-client go with --endpoint, not --provider");
    }
    const profile = oauthProfile(input.provider);
    if (!profile) throw agentXError("CONFIG_INVALID", `no browser sign-in for provider ${input.provider}; known providers: ${Object.keys(OAUTH_AUTHORIZATION_PROFILES).join(", ")}`);
    return {
      vendor: `${input.provider.charAt(0).toUpperCase()}${input.provider.slice(1)}`,
      authorizeUrl: profile.authorizeUrl, tokenUrl: profile.tokenUrl, redirectUri: profile.redirectUri,
      resource: "resource" in profile ? profile.resource : undefined, scopes: scopes ?? [],
    };
  }
  const endpoint = input.endpoint!;
  const problem = mcpEndpointProblem(endpoint);
  if (problem !== undefined) throw agentXError("CONFIG_INVALID", `--endpoint: ${problem}`);
  const url = new URL(endpoint);
  if ((input.authorizeUrl === undefined) !== (input.tokenUrl === undefined)) throw agentXError("CONFIG_INVALID", "give both --authorize-url and --token-url, or neither to discover them");
  const discovered = input.authorizeUrl !== undefined && input.tokenUrl !== undefined
    ? { authorizeUrl: input.authorizeUrl, tokenUrl: input.tokenUrl, resource: url.href, scopes: [] as string[], registrationUrl: undefined }
    : await discoverOAuth(url, input.fetchImplementation ?? fetch);
  return {
    vendor: url.host,
    authorizeUrl: discovered.authorizeUrl, tokenUrl: discovered.tokenUrl, redirectUri: GENERIC_REDIRECT_URI,
    resource: discovered.resource, scopes: scopes ?? discovered.scopes, registrationUrl: discovered.registrationUrl,
    generic: { host: url.hostname, tokenUrl: discovered.tokenUrl, resource: discovered.resource },
  };
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
  tokenUrl: URL; code: string; verifier: string; redirectUri: string; clientId: string; clientSecret: string | undefined;
  resource: string | undefined; fetchImplementation: typeof fetch;
}): Promise<{ refreshToken: string; account: Account | undefined }> {
  const response = await input.fetchImplementation(input.tokenUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier,
      client_id: input.clientId,
      // A public client has no secret: PKCE alone binds the code to this sign-in.
      ...(input.clientSecret === undefined ? {} : { client_secret: input.clientSecret }),
      ...(input.resource === undefined ? {} : { resource: input.resource }),
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
 * `--expect-account` trimmed, or undefined when not given. Throws CONFIG_INVALID when it is blank,
 * so the CLI can check it before logging in or reading any secret.
 */
export function expectedAccountEmail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") throw agentXError("CONFIG_INVALID", "--expect-account must be the bot user's email");
  return trimmed;
}

/**
 * The signed-in account: `shown` is "Name <email>", "Name" or "email", printable and shortened, for
 * the terminal; `email` is the raw email, trimmed, for comparison only, never printed.
 */
interface Account { shown: string; email: string | undefined }

/**
 * The account from the token response's user object (Asana's `data`), or undefined when neither
 * name nor email is usable. Both are shown on a terminal, so each keeps printable characters only
 * and at most 128 of them.
 */
function accountOf(data: unknown): Account | undefined {
  if (!data || typeof data !== "object") return undefined;
  const printable = (value: unknown) => typeof value === "string"
    ? Array.from(value.replace(/[\p{C}]/gu, "")).slice(0, MAX_ACCOUNT_FIELD).join("").trim()
    : "";
  const { name, email } = data as Record<string, unknown>;
  const shownName = printable(name);
  const shownEmail = printable(email);
  const signedInEmail = typeof email === "string" && email.trim() !== "" ? email.trim() : undefined;
  if (shownName && shownEmail) return { shown: `${shownName} <${shownEmail}>`, email: signedInEmail };
  const shown = shownName || shownEmail;
  return shown ? { shown, email: signedInEmail } : undefined;
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
