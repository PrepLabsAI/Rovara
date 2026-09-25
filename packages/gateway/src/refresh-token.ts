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
/** Longer than one refresh can take: the 10 s token request plus two secret writes. A refresh
 *  that has run for `REFRESH_LEASE_TTL_MS - LEASE_DEADLINE_SAFETY_MS` stops retrying and skips its
 *  write-back rather than risk still being at work after a new holder has taken the lease over. */
export const REFRESH_LEASE_TTL_MS = 15_000;
/** Longer than the lease, so a waiter takes over from a holder that died, within one 20 s call. */
export const REFRESH_LEASE_WAIT_MS = 16_000;
const LEASE_POLL_MS = 250;
const REFRESH_MARGIN_MS = 300_000;
/** A short fallback lifetime, used only when the vendor's expires_in is missing or not a usable number. */
const DEFAULT_EXPIRES_IN_S = 300;
const MIN_EXPIRES_IN_S = 60;
const MAX_EXPIRES_IN_S = 86_400;
const TOKEN_TIMEOUT_MS = 10_000;
const MAX_TOKEN_RESPONSE = 65_536;
/** Time carved out of the lease TTL so a refresh always finishes (or gives up) with margin to spare. */
const LEASE_DEADLINE_SAFETY_MS = 2_000;
/** Reported through onRotationUnsaved when a rotated token's write-back was skipped, not failed, because the lease was nearly spent. */
const LEASE_DEADLINE_UNSAVED_REASON = "LeaseDeadlineExceeded";

interface Refreshed { token: string; expiresAt: number; lifetimeMs: number; refreshToken?: string | undefined }
/** What this provider stores in the shared token cache: the plain CachedToken shape plus the
 *  margin-adjusted cutoff it was minted with, so a reader other than the minting container applies
 *  the same margin instead of a fixed one that can exceed a short-lived token's whole lifetime. A
 *  TokenCache that only round-trips `token`/`expiresAt` (as the real DynamoDB-backed one does today)
 *  drops this field silently; readers fall back to the fixed margin in that case, exactly as before. */
type StoredToken = CachedToken & { refreshAt?: number };

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
  /**
   * Told the error class name when a rotated refresh token could not be saved, or the synthetic
   * reason `"LeaseDeadlineExceeded"` when the write was skipped because the lease was nearly
   * spent; never the token itself. Required so a rotation that failed to persist is never silent.
   */
  onRotationUnsaved: (errorName: string) => void;
}): CredentialProvider<unknown> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let memory: (CachedToken & { refreshAt: number }) | undefined;
  /** A rotated refresh token this container holds because saving it failed or was skipped. It is newer than the secret's. */
  let unsaved: string | undefined;
  /** Bumped by invalidate() so a refresh already in flight cannot write a stale token back afterwards. */
  let generation = 0;
  let inFlight: Promise<CachedToken> | undefined;

  /** The margin-adjusted cutoff a stored token is usable until: its own, when known, else the fixed margin. */
  function usableUntil(token: CachedToken): number {
    const refreshAt = (token as StoredToken).refreshAt;
    return typeof refreshAt === "number" ? refreshAt : token.expiresAt - REFRESH_MARGIN_MS;
  }
  const storedUsable = (token: CachedToken | undefined): token is CachedToken => token !== undefined && usableUntil(token) > now();

  function remember(token: CachedToken, refreshAt: number, generationAtStart: number): CachedToken {
    if (generation === generationAtStart) memory = { ...token, refreshAt };
    return token;
  }

  async function readClient(): Promise<OAuthRefreshTokenSecret> {
    return parseConnectorSecret("oauth-refresh-token", await options.secrets.read(options.secretName), options.ref, options.secretName);
  }

  /** A numeric seconds count from expires_in, tolerating a numeric string, clamped to a sane range. */
  function parseExpiresIn(raw: unknown): number {
    const numeric = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim().length > 0 ? Number(raw) : NaN;
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_EXPIRES_IN_S;
    return Math.min(MAX_EXPIRES_IN_S, Math.max(MIN_EXPIRES_IN_S, Math.floor(numeric)));
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
    const seconds = parseExpiresIn(body.expires_in);
    const rotated = typeof body.refresh_token === "string" && body.refresh_token.length > 0 ? body.refresh_token : undefined;
    return { token: body.access_token, expiresAt: now() + seconds * 1000, lifetimeMs: seconds * 1000, refreshToken: rotated };
  }

  /**
   * Writes a rotated refresh token back, trying twice. Re-reads the secret immediately before each
   * write and replaces only the refreshToken field, so a concurrent admin change to the client
   * survives. On failure this container keeps the token in memory and reports the error's class
   * name only, never the token.
   */
  async function saveRotated(refreshToken: string): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fresh = await readClient();
        const value = JSON.stringify({ clientId: fresh.clientId, clientSecret: fresh.clientSecret, refreshToken });
        await options.secrets.write(options.secretName, value);
        unsaved = undefined;
        return;
      } catch (error) { failure = error; }
    }
    unsaved = refreshToken;
    options.onRotationUnsaved(failure instanceof Error ? failure.name : "unknown");
  }

  async function refreshUnderLease(generationAtStart: number): Promise<CachedToken> {
    const owner = randomUUID();
    const acquireDeadline = now() + REFRESH_LEASE_WAIT_MS;
    for (;;) {
      const stored = await options.tokens.get(REFRESH_TOKEN_CACHE_KEY);
      if (storedUsable(stored)) return remember(stored, usableUntil(stored), generationAtStart);
      if (await options.lease.acquire(owner, REFRESH_LEASE_TTL_MS)) break;
      if (now() >= acquireDeadline) throw new Error("another AgentX process is still refreshing this credential; try again");
      await sleep(LEASE_POLL_MS);
    }
    // Past this point, a new holder can take the lease over once REFRESH_LEASE_TTL_MS elapses; stop
    // retrying, and stop trying to write, with margin to spare before that happens.
    const refreshDeadline = now() + REFRESH_LEASE_TTL_MS - LEASE_DEADLINE_SAFETY_MS;
    try {
      // Another container may have refreshed between the read above and taking the lease.
      const stored = await options.tokens.get(REFRESH_TOKEN_CACHE_KEY);
      if (storedUsable(stored)) return remember(stored, usableUntil(stored), generationAtStart);
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
        if (storedUsable(latest)) return remember(latest, usableUntil(latest), generationAtStart);
        client = await readClient();
        if (client.refreshToken === current) throw error;
        // Too close to losing the lease to risk a second round trip; the next refresh (with its own
        // fresh lease) retries against whatever the secret holds by then.
        if (now() >= refreshDeadline) throw error;
        current = client.refreshToken;
        unsaved = undefined;
        refreshed = await exchange(client, current);
      }
      // The token to keep is what the vendor issued this call, or (unrotated) what was presented.
      // Saved whenever it differs from what the secret actually holds — including a token this
      // container rotated on an earlier call but never managed to save.
      const toKeep = refreshed.refreshToken ?? current;
      if (toKeep !== client.refreshToken) {
        if (now() >= refreshDeadline) {
          // Writing now could race a new holder that has already taken the lease over and could
          // write its own rotation first. Keep it in memory; the next refresh retries the write.
          unsaved = toKeep;
          options.onRotationUnsaved(LEASE_DEADLINE_UNSAVED_REASON);
        } else {
          await saveRotated(toKeep);
        }
      }
      const refreshAt = refreshed.expiresAt - Math.min(REFRESH_MARGIN_MS, refreshed.lifetimeMs / 2);
      const token: StoredToken = { token: refreshed.token, expiresAt: refreshed.expiresAt, refreshAt };
      if (generation === generationAtStart) {
        remember(token, refreshAt, generationAtStart);
        await options.tokens.put(REFRESH_TOKEN_CACHE_KEY, token);
        // invalidate() may have run while the put was in flight; its delete may have landed first.
        if (generation !== generationAtStart) await options.tokens.delete(REFRESH_TOKEN_CACHE_KEY);
      }
      return token;
    } finally {
      // Only this call's own owner is released: a lease another refresh (a fresh owner of its own,
      // acquired after this one gave up or after invalidate() started a new attempt) now holds must
      // never be released out from under it.
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
