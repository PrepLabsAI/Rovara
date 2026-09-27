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

/**
 * Makes text a server sent safe to show: strips control characters (C0 and DEL) so it cannot
 * rewrite the terminal, hides anything shaped like an AgentX refresh token or authorization code,
 * and cuts it to 300 characters.
 */
export function sanitizeServerText(text: string): string {
  const printable = [...text].filter((character) => {
    const code = character.charCodeAt(0);
    return code > 0x1f && code !== 0x7f;
  }).join("");
  return printable.replace(/agx[rc]_[A-Za-z0-9_-]+/g, "[hidden]").slice(0, 300);
}

/** What the listener says when it gives up; the admin login keeps its original wording. */
export interface CallbackListenerMessages {
  timedOut: string;
  noAnswer: string;
}

const ADMIN_LISTENER_MESSAGES: CallbackListenerMessages = {
  timedOut: "OIDC login timed out",
  noAnswer: "OIDC callback state or code is invalid",
};

/**
 * The loopback listener for an authorization-code redirect, on 127.0.0.1 only. A callback with the
 * right state and an `error` rejects at once with the server's reason. A callback with any other
 * state gets a 400 and is otherwise ignored, so no other web page can cancel a sign-in.
 */
export async function createCallbackListener(
  expectedState: string,
  timeoutMilliseconds: number,
  port: number,
  messages: CallbackListenerMessages = ADMIN_LISTENER_MESSAGES,
): Promise<{
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
  // The caller awaits code after the browser step; this only stops Node reporting an early
  // refusal as an unhandled rejection. The promise itself still rejects for the caller.
  code.catch(() => undefined);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const callbackState = url.searchParams.get("state");
    const authorizationCode = url.searchParams.get("code");
    const failure = url.searchParams.get("error");
    if (callbackState !== expectedState) {
      // Not from this sign-in (any web page can send the browser here): refuse it and keep waiting.
      response.writeHead(400, { "content-type": "text/plain" }).end("Invalid authentication callback.");
      return;
    }
    if (failure !== null) {
      // The server refused or could not finish the sign-in: stop at once with its reason
      // (Review Focus 1) instead of waiting for the timeout.
      const description = sanitizeServerText(url.searchParams.get("error_description") ?? failure);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(`AgentX sign-in did not finish: ${description}\nYou can close this window and return to the terminal.`);
      rejectCode(failure === "temporarily_unavailable"
        ? agentXError("RUNTIME_UNAVAILABLE", `sign-in could not finish: ${description}`)
        : agentXError("AUTH_REQUIRED", `sign-in refused: ${description}`));
      return;
    }
    if (!authorizationCode) {
      response.writeHead(400, { "content-type": "text/plain" }).end("Invalid authentication callback.");
      rejectCode(agentXError("AUTH_REQUIRED", messages.noAnswer));
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
  const timer = setTimeout(() => rejectCode(agentXError("AUTH_REQUIRED", messages.timedOut)), timeoutMilliseconds);
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

export async function openSystemBrowser(url: string): Promise<void> {
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
