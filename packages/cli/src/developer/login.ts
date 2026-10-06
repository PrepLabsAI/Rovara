// agentx login <url> (FR-011): the developer sign-in. It needs no AWS credentials.
import { CLI_PACKAGE_NAME, AGENTX_CLI_CLIENT_ID, AgentXConfigurationSchema, DEVELOPER_API_VERSION, DeveloperTokenResponseSchema, agentXError, apiVersionCompatible, type AgentXConfiguration } from "@agentx/contracts";
import { createCallbackListener, createPkceParameters, openSystemBrowser } from "../auth.js";
import type { TokenStore } from "../token-store.js";
import { developerTokenKey, saveDeveloperEnvironment } from "./config.js";
import { serverReason } from "./session.js";

export interface DeveloperLoginOptions { url: string; allowLoopback: boolean; browser: boolean; home: string; tokenStore: TokenStore; fetch: typeof fetch; openBrowser?: (url: string) => Promise<void>; write: (line: string) => void; timeoutMs?: number; callbackPort?: number }

/** The only hosts --allow-loopback lets use plain http (URL.hostname keeps the brackets on IPv6). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Reads and checks the environment's sign-in configuration before anything is sent to it. */
async function readConfiguration(options: DeveloperLoginOptions, base: URL, url: string): Promise<AgentXConfiguration> {
  let configuration: AgentXConfiguration;
  try {
    const response = await options.fetch(`${url}/v1/auth/.well-known/agentx-configuration`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    configuration = AgentXConfigurationSchema.parse(await response.json());
  } catch {
    throw agentXError("CONFIG_INVALID", `${url} does not look like an AgentX environment with developer sign-in; check the URL with your admin`);
  }
  for (const endpoint of [configuration.issuer, configuration.authorizationEndpoint, configuration.tokenEndpoint, configuration.revocationEndpoint]) {
    if (new URL(endpoint).origin !== base.origin) throw agentXError("CONFIG_INVALID", `the sign-in endpoints must be on ${base.origin}; ${endpoint} is not, so nothing was sent`);
  }
  const version = apiVersionCompatible(configuration.apiVersion, DEVELOPER_API_VERSION);
  if (!version.compatible) throw agentXError("CONFIG_INVALID", `this AgentX (API ${configuration.apiVersion}) needs a newer CLI; upgrade: npx ${CLI_PACKAGE_NAME}@latest login ${url}`);
  if (!configuration.methods.slack && configuration.methods.oidc === null) {
    throw agentXError("CONFIG_INVALID", "no developer sign-in method is enabled in this AgentX; ask an admin to run agentx signin enable slack");
  }
  return configuration;
}

export async function developerLogin(options: DeveloperLoginOptions): Promise<{ env: string; configuration: AgentXConfiguration }> {
  let base: URL;
  try {
    base = new URL(options.url);
  } catch {
    throw agentXError("CONFIG_INVALID", `${options.url} is not a URL; pass your AgentX URL, for example https://agentx.example.com`);
  }
  const loopbackHost = LOOPBACK_HOSTS.has(base.hostname);
  if (base.protocol !== "https:" && !(options.allowLoopback && base.protocol === "http:" && loopbackHost)) {
    throw agentXError("CONFIG_INVALID", "your AgentX URL must use https; plain http is allowed only for 127.0.0.1, localhost or ::1 with --allow-loopback");
  }
  const url = base.origin + base.pathname.replace(/\/+$/, "");
  const configuration = await readConfiguration(options, base, url);

  const pkce = createPkceParameters();
  const again = `run npx ${CLI_PACKAGE_NAME} login ${url} again`;
  const listener = await createCallbackListener(pkce.state, options.timeoutMs ?? 300_000, options.callbackPort ?? 0, {
    timedOut: `sign-in timed out; ${again}`,
    noAnswer: `the sign-in came back without an answer; ${again}`,
  });
  try {
    const authorize = new URL(configuration.authorizationEndpoint);
    for (const [key, value] of Object.entries({
      response_type: "code", client_id: AGENTX_CLI_CLIENT_ID, redirect_uri: listener.redirectUri, state: pkce.state,
      code_challenge: pkce.challenge, code_challenge_method: "S256",
    })) authorize.searchParams.set(key, value);
    if (options.browser) {
      options.write(`Opening your browser to sign in to AgentX environment ${configuration.env}. If it does not open, open this link: ${authorize.toString()}`);
      await (options.openBrowser ?? openSystemBrowser)(authorize.toString()).catch(() => undefined);
    } else {
      options.write(`Open this link in a browser on this computer to sign in to AgentX environment ${configuration.env}: ${authorize.toString()}`);
    }
    const code = await listener.code;
    let response: Response;
    try {
      response = await options.fetch(configuration.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: AGENTX_CLI_CLIENT_ID, code, code_verifier: pkce.verifier, redirect_uri: listener.redirectUri }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw agentXError("RUNTIME_UNAVAILABLE", `could not reach AgentX at ${url} to finish signing in; check your connection and run agentx login ${url} again`);
    }
    const body: unknown = await response.json().catch(() => ({}));
    const tokens = DeveloperTokenResponseSchema.safeParse(body);
    if (!response.ok || !tokens.success) {
      const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      throw agentXError("AUTH_REQUIRED", `sign-in failed: ${serverReason(fields.error_description, `HTTP ${response.status}; run agentx login ${url} again`)}`);
    }
    await options.tokenStore.set(developerTokenKey(configuration.issuer), {
      accessToken: tokens.data.access_token, refreshToken: tokens.data.refresh_token, expiresAt: Date.now() + tokens.data.expires_in * 1000,
    });
    await saveDeveloperEnvironment(options.home, configuration.env, { url, issuer: configuration.issuer, tokenEndpoint: configuration.tokenEndpoint, revocationEndpoint: configuration.revocationEndpoint });
    return { env: configuration.env, configuration };
  } finally {
    listener.close();
  }
}
