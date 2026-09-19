import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentXError } from "@agentx/contracts";
import type { StoredTokens, TokenStore } from "./token-store.js";

const execFileAsync = promisify(execFile);

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  scopes_supported?: string[];
}

export interface LoginOptions {
  issuer: string;
  clientId: string;
  audience: string;
  tokenStore: TokenStore;
  openBrowser?: (url: string) => Promise<void>;
  fetchImplementation?: typeof fetch;
  timeoutMilliseconds?: number;
  callbackPort?: number;
}

export function createPkceParameters(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(48).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(24).toString("base64url"),
  };
}

export async function loginWithPkce(options: LoginOptions): Promise<StoredTokens> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const discoveryUrl = `${options.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const discoveryResponse = await fetchImplementation(discoveryUrl);
  if (!discoveryResponse.ok) throw agentXError("AUTH_REQUIRED", "OIDC discovery failed");
  const discovery = parseDiscovery(await discoveryResponse.json());
  const pkce = createPkceParameters();
  const callback = await createCallbackListener(
    pkce.state,
    options.timeoutMilliseconds ?? 120_000,
    options.callbackPort ?? 0,
  );
  try {
    const authorize = new URL(discovery.authorization_endpoint);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", options.clientId);
    authorize.searchParams.set("redirect_uri", callback.redirectUri);
    const scopes = ["openid"];
    if (discovery.scopes_supported?.includes("offline_access")) scopes.push("offline_access");
    authorize.searchParams.set("scope", scopes.join(" "));
    authorize.searchParams.set("audience", options.audience);
    authorize.searchParams.set("state", pkce.state);
    authorize.searchParams.set("code_challenge", pkce.challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    await (options.openBrowser ?? openSystemBrowser)(authorize.toString());
    const code = await callback.code;

    const tokenResponse = await fetchImplementation(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: options.clientId,
        code,
        redirect_uri: callback.redirectUri,
        code_verifier: pkce.verifier,
      }),
    });
    if (!tokenResponse.ok) throw agentXError("AUTH_REQUIRED", "OIDC token exchange failed");
    const tokens = parseTokenResponse(await tokenResponse.json());
    await options.tokenStore.set(tokenStoreKey(options), tokens);
    return tokens;
  } finally {
    callback.close();
  }
}

export function tokenStoreKey(input: Pick<LoginOptions, "issuer" | "clientId" | "audience">): string {
  return createHash("sha256")
    .update(input.issuer)
    .update("\0")
    .update(input.clientId)
    .update("\0")
    .update(input.audience)
    .digest("hex");
}

async function createCallbackListener(expectedState: string, timeoutMilliseconds: number, port: number): Promise<{
  redirectUri: string;
  code: Promise<string>;
  close: () => void;
}> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const callbackState = url.searchParams.get("state");
    const authorizationCode = url.searchParams.get("code");
    if (callbackState !== expectedState || !authorizationCode) {
      response.writeHead(400, { "content-type": "text/plain" }).end("Invalid authentication callback.");
      rejectCode(agentXError("AUTH_REQUIRED", "OIDC callback state or code is invalid"));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" }).end("AgentX authentication complete. You can close this window.");
    resolveCode(authorizationCode);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OIDC callback listener did not bind TCP");
  const timer = setTimeout(() => rejectCode(agentXError("AUTH_REQUIRED", "OIDC login timed out")), timeoutMilliseconds);
  timer.unref();
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    code,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

async function openSystemBrowser(url: string): Promise<void> {
  if (process.platform === "darwin") await execFileAsync("open", [url]);
  else if (process.platform === "linux") await execFileAsync("xdg-open", [url]);
  else throw agentXError("AUTH_REQUIRED", "open the authorization URL in a browser manually");
}

function parseDiscovery(value: unknown): OidcDiscovery {
  if (!value || typeof value !== "object") throw agentXError("AUTH_REQUIRED", "invalid OIDC discovery response");
  const data = value as Record<string, unknown>;
  if (typeof data.authorization_endpoint !== "string" || typeof data.token_endpoint !== "string") {
    throw agentXError("AUTH_REQUIRED", "OIDC discovery lacks required endpoints");
  }
  if (![data.authorization_endpoint, data.token_endpoint].every((url) => new URL(url).protocol === "https:")) {
    throw agentXError("AUTH_REQUIRED", "OIDC endpoints must use HTTPS");
  }
  const scopesSupported = Array.isArray(data.scopes_supported) && data.scopes_supported.every(
    (scope): scope is string => typeof scope === "string",
  )
    ? data.scopes_supported
    : undefined;
  return {
    authorization_endpoint: data.authorization_endpoint,
    token_endpoint: data.token_endpoint,
    ...(scopesSupported ? { scopes_supported: scopesSupported } : {}),
  };
}

function parseTokenResponse(value: unknown): StoredTokens {
  if (!value || typeof value !== "object") throw agentXError("AUTH_REQUIRED", "invalid OIDC token response");
  const data = value as Record<string, unknown>;
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw agentXError("AUTH_REQUIRED", "OIDC response lacks an access token");
  }
  const lifetime = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 300;
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + lifetime * 1_000,
    ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
  };
}
