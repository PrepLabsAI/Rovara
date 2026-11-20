import { describe, expect, it, vi } from "vitest";
import { CredentialUnavailable, REFRESH_LEASE_TTL_MS, REFRESH_TOKEN_CACHE_KEY, oauthRefreshTokenProvider } from "../../packages/gateway/src/index.js";
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

  it("treats a server error or a response without an access token as transient, never as not connected", async () => {
    const { endpoint, container } = setup();
    endpoint.fail = { status: 503, body: `upstream down ${REFRESH}` };
    const failure = await container().issue(undefined, "read").catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(CredentialUnavailable);
    expect((failure as Error).message).toBe("token endpoint returned HTTP 503");
    endpoint.fail = { status: 200, body: "{}" };
    await expect(container().issue(undefined, "read")).rejects.toThrow("token endpoint returned no access token");
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

  it("never overwrites a refresh token an administrator's re-authorize wrote while this refresh rotated the old one", async () => {
    const endpoint = fakeTokenEndpoint({ ...CLIENT, refreshToken: REFRESH });
    endpoint.rotate = true;
    const { secrets, unsaved, clock, provider } = directSetup(endpoint.fetch);
    const REAUTHORIZED = "refresh-token-from-a-new-sign-in";
    let reads = 0;
    secrets.read = async (name: string) => {
      reads += 1;
      // Between the read under the lease and the write-back's re-read, `authorize` stored a new sign-in.
      if (reads === 2) secrets.values[SECRET] = JSON.stringify({ ...CLIENT, refreshToken: REAUTHORIZED });
      return secrets.values[name];
    };
    const issued = await provider.issue(undefined, "read");
    expect(issued.token).toBe(endpoint.accessTokens[0]);
    expect(secrets.writes).toEqual([]);
    expect(JSON.parse(secrets.values[SECRET]!)).toEqual({ ...CLIENT, refreshToken: REAUTHORIZED });
    expect(unsaved).toEqual(["SecretChanged"]);
    // The rotated token from the old grant is dropped, not kept in memory: the next refresh uses the new sign-in.
    clock.advance(56 * 60_000);
    await provider.issue(undefined, "read").catch(() => undefined);
    expect(endpoint.presented).toEqual([REFRESH, REAUTHORIZED]);
  });
  it("drops a rotated token it holds unsaved once a new sign-in has replaced the secret's refresh token, and never writes it over the new one", async () => {
    const { secrets, endpoint, clock, unsaved, container } = setup({ rotate: true });
    secrets.failWrites = 2;
    const provider = container();
    await provider.issue(undefined, "read");
    expect(unsaved).toEqual(["AccessDeniedException"]);
    // An administrator re-authorizes: a new sign-in replaces the secret's refresh token.
    const REAUTHORIZED = "refresh-token-from-a-new-sign-in";
    secrets.values[SECRET] = JSON.stringify({ ...CLIENT, refreshToken: REAUTHORIZED });
    clock.advance(56 * 60_000);
    await provider.issue(undefined, "read").catch(() => undefined);
    expect(endpoint.presented).toEqual([REFRESH, REAUTHORIZED]);
    expect(secrets.writes).toEqual([]);
    expect(JSON.parse(secrets.values[SECRET] ?? "")).toEqual({ ...CLIENT, refreshToken: REAUTHORIZED });
    expect(unsaved).toEqual(["AccessDeniedException", "SecretChanged"]);
  });
  it("clears a rotated token it holds unsaved without reporting it once the secret already holds that same token", async () => {
    const { secrets, endpoint, clock, unsaved, container } = setup({ rotate: true });
    secrets.failWrites = 2;
    const provider = container();
    await provider.issue(undefined, "read");
    expect(unsaved).toEqual(["AccessDeniedException"]);
    // The write landed after all (or a peer saved the same rotation): the secret holds the unsaved token.
    secrets.values[SECRET] = JSON.stringify({ ...CLIENT, refreshToken: "refresh-token-rotated-1" });
    clock.advance(56 * 60_000);
    await provider.issue(undefined, "read");
    expect(endpoint.presented).toEqual([REFRESH, "refresh-token-rotated-1"]);
    expect(unsaved).toEqual(["AccessDeniedException"]);
    expect(JSON.parse(secrets.values[SECRET] ?? "")).toEqual({ ...CLIENT, refreshToken: "refresh-token-rotated-2" });
  });
});
