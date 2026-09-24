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

// This project builds without the "dom" lib, under which undici's ambient `Response.body` type
// resolves to `any` (its declared type references the DOM `ReadableStream` global, which isn't
// present). Declared locally and applied with `as` so the stream read below is fully typed.
interface BytesReader { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }
interface BytesStream { getReader(): BytesReader }

/**
 * Reads a response body up to `limit` bytes, rejecting before buffering the rest when the
 * declared content-length or the running byte count (not UTF-16 length) exceeds it. Never
 * includes any of the body in a thrown message.
 */
async function readLimitedText(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > limit) throw new Error("token endpoint response exceeded limit");
  }
  const body = response.body as BytesStream | null;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("token endpoint response exceeded limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
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

  /** The token this instance minted or last read, and the moment it should be refreshed by. */
  let memory: (CachedToken & { key: string; refreshAt: number }) | undefined;
  let lastKey: string | undefined;
  /** Bumped by invalidate() so a mint already in flight cannot write a stale result back afterwards. */
  let generation = 0;
  /** In-flight mint (or shared-cache read + mint) per scope key, so concurrent issue() calls share one fetch. */
  const inFlight = new Map<string, Promise<CachedToken>>();

  /** A margin capped at half the token's own lifetime, so a short-lived token is still reusable. */
  const marginFor = (lifetimeMs: number) => Math.min(REFRESH_MARGIN_MS, lifetimeMs / 2);
  /** Whether a value straight from the shared cache is fresh, using the fixed margin (its true lifetime is unknown). */
  const storedUsable = (token: CachedToken | undefined): token is CachedToken => token !== undefined && token.expiresAt - REFRESH_MARGIN_MS > now();

  async function mint(client: OAuthClientCredentialsSecret): Promise<CachedToken & { lifetimeMs: number }> {
    const response = await fetchImplementation(options.tokenEndpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: client.clientId, client_secret: client.clientSecret, scope: client.scopes.join(" ") }).toString(),
    });
    const text = await readLimitedText(response, MAX_TOKEN_RESPONSE);
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      const code = isObject(body) && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? ` (${body.error})` : "";
      throw new CredentialUnavailable(`credential ${options.ref}: the token endpoint refused the client credentials with HTTP ${response.status}${code}`);
    }
    if (!response.ok) throw new Error(`token endpoint returned HTTP ${response.status}`);
    if (!isObject(body) || typeof body.access_token !== "string" || body.access_token.length === 0) throw new Error("token endpoint returned no access token");
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN_S;
    const lifetimeMs = seconds * 1000;
    return { token: body.access_token, expiresAt: now() + lifetimeMs, lifetimeMs };
  }

  return {
    async issue() {
      const client = await secret.get();
      const key = scopeKey(client.scopes);
      lastKey = key;

      if (memory !== undefined && memory.key === key && now() < memory.refreshAt) {
        return { token: memory.token, bindings: {} };
      }

      const existing = inFlight.get(key);
      if (existing) {
        const shared = await existing;
        return { token: shared.token, bindings: {} };
      }

      const generationAtStart = generation;
      const task = (async (): Promise<CachedToken> => {
        const stored = await options.tokens.get(key);
        if (storedUsable(stored)) {
          if (generation === generationAtStart) memory = { token: stored.token, expiresAt: stored.expiresAt, key, refreshAt: stored.expiresAt - REFRESH_MARGIN_MS };
          return stored;
        }
        const minted = await mint(client);
        const result: CachedToken = { token: minted.token, expiresAt: minted.expiresAt };
        if (generation === generationAtStart) {
          memory = { ...result, key, refreshAt: minted.expiresAt - marginFor(minted.lifetimeMs) };
          await options.tokens.put(key, result);
        }
        return result;
      })();
      inFlight.set(key, task);
      try {
        const result = await task;
        return { token: result.token, bindings: {} };
      } finally {
        inFlight.delete(key);
      }
    },
    async invalidate() {
      generation++;
      memory = undefined;
      let key = lastKey;
      if (key === undefined) {
        try {
          const client = await secret.get();
          key = scopeKey(client.scopes);
          lastKey = key;
        } catch {
          key = undefined;
        }
      }
      secret.clear();
      if (key !== undefined) await options.tokens.delete(key);
    },
  };
}
