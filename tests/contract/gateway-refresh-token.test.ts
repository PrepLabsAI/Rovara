import { describe, expect, it, vi } from "vitest";
import {
  CredentialUnavailable, REFRESH_LEASE_TTL_MS, REFRESH_TOKEN_CACHE_KEY, oauthRefreshTokenProvider, parseConnectorSecret,
} from "../../packages/gateway/src/index.js";
import { fakeClock, fakeTokenEndpoint, memoryLease, memorySecretStore, memoryTokenCache } from "../support/refresh-token-fakes.js";

const SECRET = "agentx/connectors/asana-bot";
const CLIENT = { clientId: "1210000000000001", clientSecret: "client-secret-value-0123456789" };
const REFRESH = "refresh-token-original-value";
const endpointUrl = new URL("https://auth.vendor.test/-/oauth_token");

/** One broker container: its own provider over the shared cache, lease and secret store. */
function setup(options: { rotate?: boolean; expiresIn?: number } = {}) {
  const clock = fakeClock();
  const tokens = memoryTokenCache();
  const lease = memoryLease(clock);
  const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }) });
  const endpoint = fakeTokenEndpoint({ ...CLIENT, refreshToken: REFRESH, ...(options.expiresIn === undefined ? {} : { expiresIn: options.expiresIn }) });
  endpoint.rotate = options.rotate ?? false;
  const unsaved: string[] = [];
  const container = () => oauthRefreshTokenProvider({
    ref: "asana-bot", secretName: SECRET, secrets, tokens, lease, tokenEndpoint: endpointUrl,
    fetchImplementation: endpoint.fetch, now: clock.now, sleep: clock.sleep, onRotationUnsaved: (name) => unsaved.push(name),
  });
  return { clock, tokens, lease, secrets, endpoint, unsaved, container };
}

/** A standalone provider (its own clock, cache, lease and secret) over a caller-supplied fetch, for tests that need to control the token response or the secret store directly. */
function directSetup(fetchImplementation: typeof fetch, secretValue: Record<string, unknown> = { ...CLIENT, refreshToken: REFRESH }) {
  const clock = fakeClock();
  const tokens = memoryTokenCache();
  const lease = memoryLease(clock);
  const secrets = memorySecretStore({ [SECRET]: JSON.stringify(secretValue) });
  const unsaved: string[] = [];
  const provider = oauthRefreshTokenProvider({
    ref: "asana-bot", secretName: SECRET, secrets, tokens, lease, tokenEndpoint: endpointUrl,
    fetchImplementation, now: clock.now, sleep: clock.sleep, onRotationUnsaved: (name) => unsaved.push(name),
  });
  return { clock, tokens, lease, secrets, unsaved, provider };
}

describe("parseConnectorSecret for oauth-refresh-token", () => {
  it("parses the client and refresh token, and names only the secret when malformed", () => {
    const raw = JSON.stringify({ ...CLIENT, refreshToken: REFRESH });
    expect(parseConnectorSecret("oauth-refresh-token", raw, "asana-bot", SECRET)).toEqual({ ...CLIENT, refreshToken: REFRESH });
    const withoutToken = JSON.stringify(CLIENT);
    expect(() => parseConnectorSecret("oauth-refresh-token", withoutToken, "asana-bot", SECRET))
      .toThrow(new CredentialUnavailable(`credential asana-bot: secret ${SECRET} must be JSON {"clientId": "...", "clientSecret": "...", "refreshToken": "..."}`));
  });
});

describe("oauth-refresh-token provider", () => {
  it("refreshes with the stored refresh token, form-encoded, without following redirects, and caches the access token", async () => {
    const { endpoint, tokens } = setup();
    const fetchSpy = vi.fn(endpoint.fetch);
    const provider = oauthRefreshTokenProvider({
      ref: "asana-bot", secretName: SECRET, secrets: memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }) }),
      tokens, lease: memoryLease({ now: Date.now }), tokenEndpoint: endpointUrl, fetchImplementation: fetchSpy, onRotationUnsaved: () => {},
    });
    const issued = await provider.issue(undefined, "read");
    expect(issued).toEqual({ token: endpoint.accessTokens[0], bindings: {} });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(endpointUrl);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new URLSearchParams(init?.body as string))).toEqual({
      grant_type: "refresh_token", refresh_token: REFRESH, client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret,
    });
    expect(tokens.items.get(REFRESH_TOKEN_CACHE_KEY)?.token).toBe(endpoint.accessTokens[0]);
  });

  it("reuses the access token until five minutes before its one-hour expiry, then refreshes", async () => {
    const { endpoint, clock, container } = setup();
    const provider = container();
    const first = await provider.issue(undefined, "read");
    clock.advance(54 * 60_000);
    expect(await provider.issue(undefined, "read")).toEqual(first);
    expect(endpoint.presented).toHaveLength(1);
    clock.advance(2 * 60_000);
    const second = await provider.issue(undefined, "read");
    expect(second.token).not.toBe(first.token);
    expect(endpoint.presented).toEqual([REFRESH, REFRESH]);
  });

  it("does not write the secret when the refresh token comes back unchanged or absent (as Asana did on 2026-09-24)", async () => {
    const { secrets, container } = setup();
    await container().issue(undefined, "read");
    expect(secrets.writes).toEqual([]);
  });

  it("writes a rotated refresh token back to the secret before using its access token, and uses it next time", async () => {
    const { secrets, endpoint, clock, container } = setup({ rotate: true });
    const provider = container();
    await provider.issue(undefined, "read");
    expect(secrets.writes).toEqual([{ name: SECRET, value: JSON.stringify({ ...CLIENT, refreshToken: "refresh-token-rotated-1" }) }]);
    clock.advance(56 * 60_000);
    await provider.issue(undefined, "read");
    expect(endpoint.presented).toEqual([REFRESH, "refresh-token-rotated-1"]);
    expect(JSON.parse(secrets.values[SECRET]!)).toEqual({ ...CLIENT, refreshToken: "refresh-token-rotated-2" });
  });

  it("a second container uses the rotated token the first one saved, never the revoked one", async () => {
    const { endpoint, clock, container } = setup({ rotate: true });
    await container().issue(undefined, "read");
    clock.advance(56 * 60_000);
    await container().issue(undefined, "read");
    expect(endpoint.presented).toEqual([REFRESH, "refresh-token-rotated-1"]);
  });

  it("keeps a rotated token it could not save, retries the write once, reports it by error name only, and still serves the call", async () => {
    const { secrets, endpoint, clock, unsaved, container } = setup({ rotate: true });
    secrets.failWrites = 2;
    const provider = container();
    const issued = await provider.issue(undefined, "read");
    expect(issued.token).toBe(endpoint.accessTokens[0]);
    expect(unsaved).toEqual(["AccessDeniedException"]);
    expect(JSON.parse(secrets.values[SECRET]!)).toEqual({ ...CLIENT, refreshToken: REFRESH });
    clock.advance(56 * 60_000);
    await provider.issue(undefined, "read");
    expect(endpoint.presented).toEqual([REFRESH, "refresh-token-rotated-1"]);
    expect(JSON.parse(secrets.values[SECRET]!)).toEqual({ ...CLIENT, refreshToken: "refresh-token-rotated-2" });
  });

  it("still retries saving a rotated token it could not write even when a later refresh does not rotate again", async () => {
    const { secrets, endpoint, clock, unsaved, container } = setup({ rotate: true });
    secrets.failWrites = 2;
    const provider = container();
    await provider.issue(undefined, "read");
    expect(unsaved).toEqual(["AccessDeniedException"]);
    expect(JSON.parse(secrets.values[SECRET]!)).toEqual({ ...CLIENT, refreshToken: REFRESH });
    // The next refresh does not rotate: the vendor echoes back the same refresh token it was
    // presented. That token (refresh-token-rotated-1) was never itself saved, so it still must be.
    endpoint.rotate = false;
    clock.advance(56 * 60_000);
    await provider.issue(undefined, "read");
    expect(endpoint.presented).toEqual([REFRESH, "refresh-token-rotated-1"]);
    expect(JSON.parse(secrets.values[SECRET]!)).toEqual({ ...CLIENT, refreshToken: "refresh-token-rotated-1" });
    expect(unsaved).toEqual(["AccessDeniedException"]);
  });

  it("reports a refused refresh token as not connected with the re-authorize command, never echoing the body or a token", async () => {
    const { endpoint, container } = setup();
    endpoint.fail = { status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: `token ${REFRESH} revoked` }) };
    const failure = await container().issue(undefined, "read").catch((error: unknown) => error);
    expect(failure).toEqual(new CredentialUnavailable("credential asana-bot: the token endpoint refused the refresh token with HTTP 400 (invalid_grant); the bot user must sign in again with agentx admin credential authorize --ref asana-bot"));
    expect(String((failure as Error).message)).not.toContain(REFRESH);
    expect(String((failure as Error).message)).not.toContain(CLIENT.clientSecret);
  });

  it("reports a refused client (401 invalid_client) as not connected too", async () => {
    const { endpoint, container } = setup();
    endpoint.fail = { status: 401, body: JSON.stringify({ error: "invalid_client" }) };
    await expect(container().issue(undefined, "read")).rejects.toThrow(CredentialUnavailable);
  });

  it("treats a server error or a response without an access token as transient, never as not connected", async () => {
    const { endpoint, container } = setup();
    endpoint.fail = { status: 503, body: `upstream down ${REFRESH}` };
    const failure = await container().issue(undefined, "read").catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(CredentialUnavailable);
    expect((failure as Error).message).toBe("token endpoint returned HTTP 503");
    endpoint.fail = { status: 200, body: "{}" };
    await expect(container().issue(undefined, "read")).rejects.toThrow("token endpoint returned no access token");
  });

  it("reports a missing or malformed secret as not connected, naming only the secret", async () => {
    const { secrets, container } = setup();
    secrets.values[SECRET] = JSON.stringify(CLIENT);
    await expect(container().issue(undefined, "read")).rejects.toThrow(`credential asana-bot: secret ${SECRET} must be JSON`);
  });

  it("coalesces concurrent calls in one container into one refresh", async () => {
    const { endpoint, container } = setup();
    const provider = container();
    endpoint.hold = true;
    const calls = [provider.issue(undefined, "read"), provider.issue(undefined, "read"), provider.issue(undefined, "write")];
    await vi.waitFor(() => expect(endpoint.requested).toBe(1));
    endpoint.hold = false;
    endpoint.release();
    const results = await Promise.all(calls);
    expect(new Set(results.map((result) => result.token)).size).toBe(1);
    expect(endpoint.presented).toEqual([REFRESH]);
  });

  it("lets only one of two containers refresh at a time; the other waits for its token", async () => {
    const { endpoint, lease, container } = setup({ rotate: true });
    const first = container();
    const second = container();
    endpoint.hold = true;
    const one = first.issue(undefined, "read");
    await vi.waitFor(() => expect(lease.holder()).toBeDefined());
    const two = second.issue(undefined, "read");
    await lease.firstRefusal;
    endpoint.hold = false;
    endpoint.release();
    const [a, b] = await Promise.all([one, two]);
    expect(a.token).toBe(b.token);
    expect(endpoint.presented).toEqual([REFRESH]);
    expect(lease.holder()).toBeUndefined();
  });

  it("retries once with a refresh token another container rotated and saved after this one read the secret", async () => {
    const { secrets, endpoint, container } = setup({ rotate: true });
    const original = secrets.values[SECRET]!;
    // Another container already spent REFRESH and saved the token that replaced it; this one read the secret first.
    await container().issue(undefined, "read");
    const saved = secrets.values[SECRET]!;
    let reads = 0;
    secrets.read = async () => (reads++ === 0 ? original : saved);
    const late = oauthRefreshTokenProvider({
      ref: "asana-bot", secretName: SECRET, secrets, tokens: memoryTokenCache(), lease: memoryLease({ now: Date.now }),
      tokenEndpoint: endpointUrl, fetchImplementation: endpoint.fetch, onRotationUnsaved: () => {},
    });
    const issued = await late.issue(undefined, "read");
    expect(issued.token).toBe(endpoint.accessTokens[1]);
    expect(endpoint.presented).toEqual([REFRESH, REFRESH, "refresh-token-rotated-1"]);
    expect((JSON.parse(secrets.values[SECRET]!) as { refreshToken: string }).refreshToken).toBe("refresh-token-rotated-2");
  });

  it("takes over the lease from a container that died holding it, within one call", async () => {
    const { lease, endpoint, container } = setup();
    expect(await lease.acquire("dead-container", REFRESH_LEASE_TTL_MS)).toBe(true);
    const issued = await container().issue(undefined, "read");
    expect(issued.token).toBe(endpoint.accessTokens[0]);
  });

  it("releases the lease after a failed refresh, so the next call can try", async () => {
    const { endpoint, lease, container } = setup();
    endpoint.fail = { status: 503, body: "" };
    const provider = container();
    await expect(provider.issue(undefined, "read")).rejects.toThrow("HTTP 503");
    expect(lease.holder()).toBeUndefined();
    endpoint.fail = undefined;
    expect((await provider.issue(undefined, "read")).token).toBe(endpoint.accessTokens[0]);
  });

  it("invalidate drops the cached access token so the next call refreshes, and keeps the refresh token", async () => {
    const { endpoint, tokens, secrets, container } = setup();
    const provider = container();
    await provider.issue(undefined, "read");
    await provider.invalidate!(undefined);
    expect(tokens.items.has(REFRESH_TOKEN_CACHE_KEY)).toBe(false);
    await provider.issue(undefined, "read");
    expect(endpoint.presented).toEqual([REFRESH, REFRESH]);
    expect((JSON.parse(secrets.values[SECRET]!) as { refreshToken: string }).refreshToken).toBe(REFRESH);
  });

  it("does not store an access token from a refresh that was in flight when invalidate ran", async () => {
    const { endpoint, tokens, container } = setup();
    const provider = container();
    endpoint.hold = true;
    const pending = provider.issue(undefined, "read");
    await vi.waitFor(() => expect(endpoint.requested).toBe(1));
    await provider.invalidate!(undefined);
    endpoint.hold = false;
    endpoint.release();
    await pending;
    expect(tokens.items.has(REFRESH_TOKEN_CACHE_KEY)).toBe(false);
  });

  it("gives each refresh its own lease owner, so a refresh started after invalidate() waits for the earlier one's lease instead of running under its abandoned owner", async () => {
    const { endpoint, lease, container } = setup({ rotate: true });
    const provider = container();
    endpoint.hold = true;
    const first = provider.issue(undefined, "read");
    await vi.waitFor(() => expect(lease.holder()).toBeDefined());
    await provider.invalidate!(undefined);
    const second = provider.issue(undefined, "read");
    // The refresh started after invalidate() must be refused the lease (a fresh owner of its own,
    // not the first refresh's still-held one) rather than acquiring it and exchanging concurrently.
    await lease.firstRefusal;
    expect(endpoint.requested).toBe(1);
    endpoint.hold = false;
    endpoint.release();
    await Promise.all([first, second]);
    // Two sequential refreshes, each presenting the refresh token that was actually current when it
    // ran: never the same token presented twice, which is what racing under one shared owner would
    // do (and did, before each refresh got its own owner: this scenario then timed out, because the
    // second refresh's same-owner acquire never gets refused, so lease.firstRefusal never resolves).
    expect(endpoint.presented).toEqual([REFRESH, "refresh-token-rotated-1"]);
    expect(lease.holder()).toBeUndefined();
  });

  it("adopts a short-lived token's shared cache entry using half its lifetime as the margin, not the fixed five minutes", async () => {
    const { endpoint, container } = setup({ expiresIn: 240 });
    const first = await container().issue(undefined, "read");
    const second = await container().issue(undefined, "read");
    expect(second.token).toBe(first.token);
    expect(endpoint.presented).toEqual([REFRESH]);
  });

  it("clamps a corrupt refreshAt from the shared cache to the token's real expiry, never trusting it past that", async () => {
    const { endpoint, tokens, clock, container } = setup();
    const injectedAt = clock.now();
    // A corrupt (or hostile) cache entry: refreshAt claims the token is usable long after it really expires.
    tokens.items.set(REFRESH_TOKEN_CACHE_KEY, { token: "stale-token", expiresAt: injectedAt + 10_000, refreshAt: injectedAt + 1_000_000 });
    clock.advance(20_000); // past the token's real expiry, though well before the corrupt refreshAt
    const issued = await container().issue(undefined, "read");
    expect(issued.token).toBe(endpoint.accessTokens[0]);
    expect(endpoint.presented).toEqual([REFRESH]);
  });

  it("renews the lease under the same owner and still writes back a rotated token when merely slow, with nobody else contesting the lease", async () => {
    const { clock, secrets, unsaved, provider } = directSetup(async (_url, init) => {
      // Simulate the exchange itself consuming almost the whole lease TTL, with no one else waiting
      // for it: renewing under the same owner must succeed, so the write-back must not be stranded.
      clock.advance(REFRESH_LEASE_TTL_MS - 500);
      const form = new URLSearchParams(init?.body as string);
      expect(form.get("refresh_token")).toBe(REFRESH);
      return Response.json({ access_token: "access-token-slow", token_type: "bearer", expires_in: 3_600, refresh_token: "refresh-token-rotated-1" });
    });
    const issued = await provider.issue(undefined, "read");
    expect(issued.token).toBe("access-token-slow");
    expect(secrets.writes).toHaveLength(1);
    expect(unsaved).toEqual([]);
    expect(JSON.parse(secrets.values[SECRET]!)).toEqual({ ...CLIENT, refreshToken: "refresh-token-rotated-1" });
  });

  it("keeps the rotated token in memory instead of writing when renewing the lease is refused because another container has since taken it over", async () => {
    const clock = fakeClock();
    const tokens = memoryTokenCache();
    const lease = memoryLease(clock);
    const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }) });
    const unsaved: string[] = [];
    const fetchImplementation: typeof fetch = async (_url, init) => {
      // The exchange itself runs past both our internal deadline and the lease's real TTL; while it
      // was in flight, a new container legitimately took the (by-then-expired) lease over.
      clock.advance(REFRESH_LEASE_TTL_MS + 1_000);
      await lease.acquire("another-container", REFRESH_LEASE_TTL_MS);
      const form = new URLSearchParams(init?.body as string);
      expect(form.get("refresh_token")).toBe(REFRESH);
      return Response.json({ access_token: "access-token-slow", token_type: "bearer", expires_in: 3_600, refresh_token: "refresh-token-rotated-1" });
    };
    const provider = oauthRefreshTokenProvider({
      ref: "asana-bot", secretName: SECRET, secrets, tokens, lease, tokenEndpoint: endpointUrl,
      fetchImplementation, now: clock.now, sleep: clock.sleep, onRotationUnsaved: (name) => unsaved.push(name),
    });
    const issued = await provider.issue(undefined, "read");
    expect(issued.token).toBe("access-token-slow");
    expect(secrets.writes).toEqual([]);
    expect(unsaved).toEqual(["LeaseDeadlineExceeded"]);
    expect(JSON.parse(secrets.values[SECRET]!)).toEqual({ ...CLIENT, refreshToken: REFRESH });
    expect(lease.holder()).toBe("another-container");
  });

  it("checks the lease deadline before each write attempt inside saveRotated, not only once before it, and reports the deadline reason rather than the write failure when it runs out between attempts", async () => {
    const endpoint = fakeTokenEndpoint({ ...CLIENT, refreshToken: REFRESH });
    endpoint.rotate = true;
    const { clock, secrets, unsaved, provider } = directSetup(endpoint.fetch);
    let writes = 0;
    secrets.write = async () => {
      writes += 1;
      // The first write attempt fails, and while it was in flight the lease's budget ran out.
      clock.advance(REFRESH_LEASE_TTL_MS);
      const error = new Error("simulated write failure");
      error.name = "AccessDeniedException";
      throw error;
    };
    await provider.issue(undefined, "read");
    expect(writes).toBe(1);
    expect(unsaved).toEqual(["LeaseDeadlineExceeded"]);
  });

  it("gives up rather than risk a second exchange once the lease is nearly spent, even when a peer's newer refresh token is available", async () => {
    let calls = 0;
    const { clock, secrets, provider } = directSetup(async () => {
      calls += 1;
      // While this (doomed) attempt was in flight, a peer rotated and saved, and the lease's budget ran out.
      secrets.values[SECRET] = JSON.stringify({ ...CLIENT, refreshToken: "refresh-token-rotated-1" });
      clock.advance(REFRESH_LEASE_TTL_MS - 500);
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    await expect(provider.issue(undefined, "read")).rejects.toThrow(CredentialUnavailable);
    expect(calls).toBe(1);
  });

  it("falls back to a short 300 s lifetime when expires_in is missing, rather than a full hour", async () => {
    let presented = 0;
    const { clock, provider } = directSetup(async (_url, init) => {
      presented += 1;
      const form = new URLSearchParams(init?.body as string);
      expect(form.get("refresh_token")).toBe(REFRESH);
      return Response.json({ access_token: `access-${presented}`, token_type: "bearer" });
    });
    const first = await provider.issue(undefined, "read");
    clock.advance(140_000);
    expect(await provider.issue(undefined, "read")).toEqual(first);
    expect(presented).toBe(1);
    clock.advance(20_000);
    const second = await provider.issue(undefined, "read");
    expect(second.token).not.toBe(first.token);
    expect(presented).toBe(2);
  });

  it("accepts a numeric-string expires_in", async () => {
    let calls = 0;
    const { clock, provider } = directSetup(async () => Response.json({ access_token: `access-${++calls}`, token_type: "bearer", expires_in: "1200" }));
    const first = await provider.issue(undefined, "read");
    clock.advance(899_000);
    expect(await provider.issue(undefined, "read")).toEqual(first);
    clock.advance(2_000);
    const second = await provider.issue(undefined, "read");
    expect(second.token).not.toBe(first.token);
  });

  it("clamps an implausibly long expires_in to 24 hours", async () => {
    let calls = 0;
    const { clock, provider } = directSetup(async () => Response.json({ access_token: `access-${++calls}`, token_type: "bearer", expires_in: 99_999_999 }));
    const first = await provider.issue(undefined, "read");
    clock.advance(86_099_000);
    expect(await provider.issue(undefined, "read")).toEqual(first);
    clock.advance(2_000);
    const second = await provider.issue(undefined, "read");
    expect(second.token).not.toBe(first.token);
  });

  it("clamps a non-positive expires_in to the short fallback rather than treating it as usable", async () => {
    let calls = 0;
    const { clock, provider } = directSetup(async () => Response.json({ access_token: `access-${++calls}`, token_type: "bearer", expires_in: -5 }));
    const first = await provider.issue(undefined, "read");
    clock.advance(140_000);
    expect(await provider.issue(undefined, "read")).toEqual(first);
    clock.advance(20_000);
    const second = await provider.issue(undefined, "read");
    expect(second.token).not.toBe(first.token);
  });

  it("clamps a too-small positive expires_in up to one minute, rather than the short fallback", async () => {
    let calls = 0;
    const { clock, provider } = directSetup(async () => Response.json({ access_token: `access-${++calls}`, token_type: "bearer", expires_in: 10 }));
    // 10 s clamped to 60 s; margin = min(300 s, 30 s) = 30 s, so the refresh cutoff is 30 s in, not 150 s (the 300 s fallback's cutoff).
    const first = await provider.issue(undefined, "read");
    clock.advance(29_000);
    expect(await provider.issue(undefined, "read")).toEqual(first);
    clock.advance(2_000);
    const second = await provider.issue(undefined, "read");
    expect(second.token).not.toBe(first.token);
  });

  it("re-reads the secret immediately before writing a rotated token back, so a concurrent admin change to the client survives", async () => {
    const endpoint = fakeTokenEndpoint({ ...CLIENT, refreshToken: REFRESH });
    endpoint.rotate = true;
    const { secrets, provider } = directSetup(endpoint.fetch);
    let reads = 0;
    secrets.read = async (name: string) => {
      reads += 1;
      if (reads === 2) {
        // Between the exchange-triggering read and the write-back's re-read, an admin rotated the client secret.
        secrets.values[SECRET] = JSON.stringify({ ...CLIENT, clientSecret: "admin-rotated-secret-value", refreshToken: REFRESH });
      }
      return secrets.values[name];
    };
    await provider.issue(undefined, "read");
    expect(JSON.parse(secrets.values[SECRET]!)).toEqual({ ...CLIENT, clientSecret: "admin-rotated-secret-value", refreshToken: "refresh-token-rotated-1" });
  });
});
