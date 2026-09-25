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
      tokens, lease: memoryLease({ now: Date.now }), tokenEndpoint: endpointUrl, fetchImplementation: fetchSpy,
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
      tokenEndpoint: endpointUrl, fetchImplementation: endpoint.fetch,
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
});
