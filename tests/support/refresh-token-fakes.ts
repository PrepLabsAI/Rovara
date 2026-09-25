// Fakes for the oauth-refresh-token provider: a clock, a shared token cache, a lease with real
// expiry, a secret store and an OAuth token endpoint that can rotate or refuse refresh tokens.
import type { CachedToken, RefreshLease, SecretStore, TokenCache } from "../../packages/gateway/src/index.js";

export interface Clock { now: () => number; sleep: (milliseconds: number) => Promise<void> }

/** Time moves only when a caller sleeps, so lease waits are deterministic. */
export function fakeClock(start = 1_800_000_000_000): Clock & { advance: (milliseconds: number) => void } {
  let current = start;
  return {
    now: () => current,
    sleep: async (milliseconds) => { current += milliseconds; await new Promise<void>((resolve) => setImmediate(resolve)); },
    advance: (milliseconds) => { current += milliseconds; },
  };
}

export function memoryTokenCache(): TokenCache & { items: Map<string, CachedToken> } {
  const items = new Map<string, CachedToken>();
  return {
    items,
    get: async (key) => items.get(key),
    put: async (key, value) => { items.set(key, value); },
    delete: async (key) => { items.delete(key); },
  };
}

/** One lease shared by every provider given it, the way DynamoRefreshLease is shared by containers. */
export function memoryLease(clock: Pick<Clock, "now">): RefreshLease & { holder(): string | undefined; acquisitions: number; refusals: number; firstRefusal: Promise<void> } {
  let held: { owner: string; expiresAt: number } | undefined;
  let refused!: () => void;
  const firstRefusal = new Promise<void>((resolve) => { refused = resolve; });
  const lease = {
    firstRefusal,
    acquisitions: 0,
    refusals: 0,
    holder: () => (held !== undefined && held.expiresAt > clock.now() ? held.owner : undefined),
    async acquire(owner: string, ttlMs: number) {
      if (held !== undefined && held.expiresAt > clock.now() && held.owner !== owner) { lease.refusals += 1; refused(); return false; }
      held = { owner, expiresAt: clock.now() + ttlMs };
      lease.acquisitions += 1;
      return true;
    },
    async release(owner: string) { if (held?.owner === owner) held = undefined; },
  };
  return lease;
}

export function memorySecretStore(values: Record<string, string>): SecretStore & { values: Record<string, string>; writes: Array<{ name: string; value: string }>; failWrites: number } {
  const store = {
    values,
    writes: [] as Array<{ name: string; value: string }>,
    failWrites: 0,
    read: async (name: string) => store.values[name],
    async write(name: string, value: string) {
      if (store.failWrites > 0) {
        store.failWrites -= 1;
        const error = new Error("simulated write failure");
        error.name = "AccessDeniedException";
        throw error;
      }
      store.writes.push({ name, value });
      store.values[name] = value;
    },
  };
  return store;
}

export interface FakeTokenEndpoint {
  fetch: typeof fetch;
  /** Every refresh token presented, in order. */
  presented: string[];
  /** Requests received, counted before any hold. */
  requested: number;
  /** The refresh token the endpoint currently accepts. */
  valid(): string;
  /** When true, each successful refresh issues a new refresh token and revokes the old one. */
  rotate: boolean;
  /** When set, every refresh answers this status and body. */
  fail?: { status: number; body: string } | undefined;
  /** Resolves each refresh only when release() is called, to hold refreshes in flight. */
  hold: boolean;
  release(): void;
  accessTokens: string[];
}

export function fakeTokenEndpoint(options: { clientId: string; clientSecret: string; refreshToken: string; expiresIn?: number }): FakeTokenEndpoint {
  let valid = options.refreshToken;
  let serial = 0;
  const waiting: Array<() => void> = [];
  const endpoint: FakeTokenEndpoint = {
    presented: [],
    requested: 0,
    accessTokens: [],
    rotate: false,
    hold: false,
    valid: () => valid,
    release: () => { for (const resume of waiting.splice(0)) resume(); },
    fetch: async (_url, init) => {
      const form = new URLSearchParams(init?.body as string);
      endpoint.requested += 1;
      if (endpoint.hold) await new Promise<void>((resolve) => waiting.push(resolve));
      if (endpoint.fail) return new Response(endpoint.fail.body, { status: endpoint.fail.status });
      if (form.get("client_id") !== options.clientId || form.get("client_secret") !== options.clientSecret) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      if (form.get("grant_type") !== "refresh_token") return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      const presented = form.get("refresh_token") ?? "";
      endpoint.presented.push(presented);
      if (presented !== valid) return Response.json({ error: "invalid_grant" }, { status: 400 });
      serial += 1;
      const accessToken = `access-token-${serial}-${"a".repeat(40)}`;
      endpoint.accessTokens.push(accessToken);
      const body: Record<string, unknown> = { access_token: accessToken, token_type: "bearer", expires_in: options.expiresIn ?? 3_600 };
      if (endpoint.rotate) {
        valid = `refresh-token-rotated-${serial}`;
        body.refresh_token = valid;
      } else {
        body.refresh_token = presented;
      }
      return Response.json(body);
    },
  };
  return endpoint;
}
