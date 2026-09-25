import { randomUUID } from "node:crypto";
import type { OAuthRefreshTokenSecret } from "@agentx/contracts";
import { CredentialUnavailable, parseConnectorSecret, readLimitedText, type CachedToken, type SecretSource, type TokenCache } from "./credentials.js";
import type { CredentialProvider } from "./types.js";
import { isObject } from "./util.js";

/** A secret source that can also replace a secret's value, for a rotated refresh token. */
export interface SecretStore extends SecretSource {
  /** Replaces the secret's value. A thrown error's message must never hold the value. */
  write(secretName: string, value: string): Promise<void>;
}

/** One refresh at a time per credential, across every broker container. */
export interface RefreshLease {
  /** Takes the lease for `ttlMs` unless another owner holds an unexpired one; false when it is held. */
  acquire(owner: string, ttlMs: number): Promise<boolean>;
  /** Gives the lease up if `owner` still holds it. */
  release(owner: string): Promise<void>;
}

/** The shared-cache key for a refresh-token credential's access token; one per credential reference. */
export const REFRESH_TOKEN_CACHE_KEY = "refresh-token";
/** Longer than one refresh can take: the 10 s token request plus two secret writes. */
export const REFRESH_LEASE_TTL_MS = 15_000;
/** Longer than the lease, so a waiter takes over from a holder that died, within one 20 s call. */
export const REFRESH_LEASE_WAIT_MS = 16_000;
const LEASE_POLL_MS = 250;
const REFRESH_MARGIN_MS = 300_000;
const DEFAULT_EXPIRES_IN_S = 3_600;
const TOKEN_TIMEOUT_MS = 10_000;
const MAX_TOKEN_RESPONSE = 65_536;

interface Refreshed { token: string; expiresAt: number; lifetimeMs: number; refreshToken?: string | undefined }

/**
 * Mints access tokens from a refresh token a bot user's one-time sign-in produced. The access
 * token is shared across containers through `tokens` and reused until five minutes (at most half
 * its lifetime) before expiry. Only the holder of `lease` refreshes; the others wait for its token.
 * A rotated refresh token is written back to the secret before its access token is used. A refused
 * refresh is CredentialUnavailable, which callers report as not connected; anything else is transient.
 */
export function oauthRefreshTokenProvider(options: {
  ref: string;
  secretName: string;
  secrets: SecretStore;
  tokens: TokenCache;
  lease: RefreshLease;
  tokenEndpoint: URL;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Told the error class name when a rotated refresh token could not be saved; never the token. */
  onRotationUnsaved?: (errorName: string) => void;
}): CredentialProvider<unknown> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const owner = randomUUID();
  let memory: (CachedToken & { refreshAt: number }) | undefined;
  /** A rotated refresh token this container holds because saving it failed. It is newer than the secret's. */
  let unsaved: string | undefined;
  /** Bumped by invalidate() so a refresh already in flight cannot write a stale token back afterwards. */
  let generation = 0;
  let inFlight: Promise<CachedToken> | undefined;

  const storedUsable = (token: CachedToken | undefined): token is CachedToken => token !== undefined && token.expiresAt - REFRESH_MARGIN_MS > now();

  function remember(token: CachedToken, refreshAt: number, generationAtStart: number): CachedToken {
    if (generation === generationAtStart) memory = { ...token, refreshAt };
    return token;
  }

  async function readClient(): Promise<OAuthRefreshTokenSecret> {
    return parseConnectorSecret("oauth-refresh-token", await options.secrets.read(options.secretName), options.ref, options.secretName);
  }

  async function exchange(client: OAuthRefreshTokenSecret, refreshToken: string): Promise<Refreshed> {
    const response = await fetchImplementation(options.tokenEndpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret }).toString(),
    });
    const text = await readLimitedText(response, MAX_TOKEN_RESPONSE);
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      const code = isObject(body) && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? ` (${body.error})` : "";
      throw new CredentialUnavailable(`credential ${options.ref}: the token endpoint refused the refresh token with HTTP ${response.status}${code}; the bot user must sign in again with agentx admin credential authorize --ref ${options.ref}`);
    }
    if (!response.ok) throw new Error(`token endpoint returned HTTP ${response.status}`);
    if (!isObject(body) || typeof body.access_token !== "string" || body.access_token.length === 0) throw new Error("token endpoint returned no access token");
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN_S;
    const rotated = typeof body.refresh_token === "string" && body.refresh_token.length > 0 ? body.refresh_token : undefined;
    return { token: body.access_token, expiresAt: now() + seconds * 1000, lifetimeMs: seconds * 1000, refreshToken: rotated };
  }

  /** Writes a rotated refresh token back, trying twice. On failure this container keeps it in memory. */
  async function saveRotated(client: OAuthRefreshTokenSecret, refreshToken: string): Promise<void> {
    const value = JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret, refreshToken });
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await options.secrets.write(options.secretName, value);
        unsaved = undefined;
        return;
      } catch (error) { failure = error; }
    }
    unsaved = refreshToken;
    options.onRotationUnsaved?.(failure instanceof Error ? failure.name : "unknown");
  }

  async function refreshUnderLease(generationAtStart: number): Promise<CachedToken> {
    const deadline = now() + REFRESH_LEASE_WAIT_MS;
    for (;;) {
      const stored = await options.tokens.get(REFRESH_TOKEN_CACHE_KEY);
      if (storedUsable(stored)) return remember(stored, stored.expiresAt - REFRESH_MARGIN_MS, generationAtStart);
      if (await options.lease.acquire(owner, REFRESH_LEASE_TTL_MS)) break;
      if (now() >= deadline) throw new Error("another AgentX process is still refreshing this credential; try again");
      await sleep(LEASE_POLL_MS);
    }
    try {
      // Another container may have refreshed between the read above and taking the lease.
      const stored = await options.tokens.get(REFRESH_TOKEN_CACHE_KEY);
      if (storedUsable(stored)) return remember(stored, stored.expiresAt - REFRESH_MARGIN_MS, generationAtStart);
      // Read under the lease, never from a cache, so a token another container rotated and saved is the one used.
      let client = await readClient();
      let current = unsaved ?? client.refreshToken;
      let refreshed: Refreshed;
      try {
        refreshed = await exchange(client, current);
      } catch (error) {
        if (!(error instanceof CredentialUnavailable)) throw error;
        // A container that outlived its lease may have rotated the token, and saved it, meanwhile.
        const latest = await options.tokens.get(REFRESH_TOKEN_CACHE_KEY);
        if (storedUsable(latest)) return remember(latest, latest.expiresAt - REFRESH_MARGIN_MS, generationAtStart);
        client = await readClient();
        if (client.refreshToken === current) throw error;
        current = client.refreshToken;
        unsaved = undefined;
        refreshed = await exchange(client, current);
      }
      if (refreshed.refreshToken !== undefined && refreshed.refreshToken !== current) await saveRotated(client, refreshed.refreshToken);
      const token: CachedToken = { token: refreshed.token, expiresAt: refreshed.expiresAt };
      if (generation === generationAtStart) {
        remember(token, refreshed.expiresAt - Math.min(REFRESH_MARGIN_MS, refreshed.lifetimeMs / 2), generationAtStart);
        await options.tokens.put(REFRESH_TOKEN_CACHE_KEY, token);
        // invalidate() may have run while the put was in flight; its delete may have landed first.
        if (generation !== generationAtStart) await options.tokens.delete(REFRESH_TOKEN_CACHE_KEY);
      }
      return token;
    } finally {
      await options.lease.release(owner).catch(() => undefined);
    }
  }

  return {
    async issue() {
      if (memory !== undefined && now() < memory.refreshAt) return { token: memory.token, bindings: {} };
      if (!inFlight) {
        const task = refreshUnderLease(generation);
        inFlight = task;
        // Only this call's own entry is cleared: invalidate() may already have replaced it.
        void task.finally(() => { if (inFlight === task) inFlight = undefined; }).catch(() => undefined);
      }
      const token = await inFlight;
      return { token: token.token, bindings: {} };
    },
    async invalidate() {
      generation += 1;
      memory = undefined;
      inFlight = undefined;
      await options.tokens.delete(REFRESH_TOKEN_CACHE_KEY);
    },
  };
}
