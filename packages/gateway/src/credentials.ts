import { createHash } from "node:crypto";
import { OAuthClientCredentialsSecretSchema, StaticSecretSchema, type OAuthClientCredentialsSecret, type StaticSecret } from "@agentx/contracts";
import type { CredentialProvider } from "./types.js";
import { isObject } from "./util.js";

/** A credential is missing, malformed or refused. The message is for an administrator and never holds a secret. */
export class CredentialUnavailable extends Error {
  constructor(message: string) { super(message); this.name = "CredentialUnavailable"; }
}

export interface SecretSource { read(secretName: string): Promise<string | undefined> }
export interface CachedToken { token: string; expiresAt: number }
export interface TokenCache {
  get(key: string): Promise<CachedToken | undefined>;
  put(key: string, value: CachedToken): Promise<void>;
  delete(key: string): Promise<void>;
}

const SECRET_TTL_MS = 300_000;
const REFRESH_MARGIN_MS = 300_000;
const DEFAULT_EXPIRES_IN_S = 3_600;
const TOKEN_TIMEOUT_MS = 10_000;
const MAX_TOKEN_RESPONSE = 65_536;

export function scopeKey(scopes: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...scopes].sort())).digest("hex").slice(0, 32);
}

/** Reads and parses a secret, caching it in memory for five minutes. */
function cachedSecret<T>(options: { ref: string; secretName: string; secrets: SecretSource; now: () => number }, parse: (value: unknown) => T | undefined, shape: string) {
  let cached: { value: T; readAt: number } | undefined;
  return {
    async get(): Promise<T> {
      if (cached && options.now() - cached.readAt < SECRET_TTL_MS) return cached.value;
      const raw = await options.secrets.read(options.secretName);
      if (raw === undefined) throw new CredentialUnavailable(`credential ${options.ref}: secret ${options.secretName} was not found`);
      let json: unknown;
      try { json = JSON.parse(raw); } catch { json = undefined; }
      const value = parse(json);
      if (value === undefined) throw new CredentialUnavailable(`credential ${options.ref}: secret ${options.secretName} must be JSON ${shape}`);
      cached = { value, readAt: options.now() };
      return value;
    },
    clear() { cached = undefined; },
  };
}

export function staticSecretProvider(options: { ref: string; secretName: string; secrets: SecretSource; now?: () => number }): CredentialProvider<unknown> {
  const secret = cachedSecret<StaticSecret>({ ...options, now: options.now ?? Date.now }, (value) => {
    const parsed = StaticSecretSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }, '{"apiKey": "..."}');
  return {
    async issue() { return { token: (await secret.get()).apiKey, bindings: {} }; },
    async invalidate() { secret.clear(); },
  };
}

export function oauthClientCredentialsProvider(options: {
  ref: string; secretName: string; secrets: SecretSource; tokens: TokenCache; tokenEndpoint: URL;
  fetchImplementation?: typeof fetch; now?: () => number;
}): CredentialProvider<unknown> {
  const now = options.now ?? Date.now;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const secret = cachedSecret<OAuthClientCredentialsSecret>({ ...options, now }, (value) => {
    const parsed = OAuthClientCredentialsSecretSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }, '{"clientId": "...", "clientSecret": "...", "scopes": ["..."]}');
  let memory: (CachedToken & { key: string }) | undefined;
  let lastKey: string | undefined;
  const usable = (token: CachedToken | undefined): token is CachedToken => token !== undefined && token.expiresAt - REFRESH_MARGIN_MS > now();

  async function mint(client: OAuthClientCredentialsSecret): Promise<CachedToken> {
    const response = await fetchImplementation(options.tokenEndpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: client.clientId, client_secret: client.clientSecret, scope: client.scopes.join(" ") }).toString(),
    });
    const text = await response.text();
    if (text.length > MAX_TOKEN_RESPONSE) throw new Error("token endpoint response exceeded limit");
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      const code = isObject(body) && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? ` (${body.error})` : "";
      throw new CredentialUnavailable(`credential ${options.ref}: the token endpoint refused the client credentials with HTTP ${response.status}${code}`);
    }
    if (!response.ok) throw new Error(`token endpoint returned HTTP ${response.status}`);
    if (!isObject(body) || typeof body.access_token !== "string" || body.access_token.length === 0) throw new Error("token endpoint returned no access token");
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN_S;
    return { token: body.access_token, expiresAt: now() + seconds * 1000 };
  }

  return {
    async issue() {
      const client = await secret.get();
      const key = scopeKey(client.scopes);
      lastKey = key;
      if (memory?.key === key && usable(memory)) return { token: memory.token, bindings: {} };
      const stored = await options.tokens.get(key);
      if (usable(stored)) {
        memory = { ...stored, key };
        return { token: stored.token, bindings: {} };
      }
      const minted = await mint(client);
      memory = { ...minted, key };
      await options.tokens.put(key, minted);
      return { token: minted.token, bindings: {} };
    },
    async invalidate() {
      memory = undefined;
      secret.clear();
      if (lastKey !== undefined) await options.tokens.delete(lastKey);
    },
  };
}
