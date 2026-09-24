import { describe, expect, it, vi } from "vitest";
import {
  CredentialUnavailable, oauthClientCredentialsProvider, parseConnectorSecret, scopeKey, staticSecretProvider,
  type CachedToken, type SecretSource, type TokenCache,
} from "../../packages/gateway/src/credentials.js";

const secrets = (values: Record<string, string>) => ({
  read: vi.fn(async (name: string) => values[name]),
} satisfies SecretSource);
function memoryCache(): TokenCache & { items: Map<string, CachedToken> } {
  const items = new Map<string, CachedToken>();
  return { items, get: async (key) => items.get(key), put: async (key, value) => { items.set(key, value); }, delete: async (key) => { items.delete(key); } };
}
const client = JSON.stringify({ clientId: "client-id", clientSecret: "client-secret-value", scopes: ["write", "read"] });
const endpoint = new URL("https://auth.vendor.test/oauth/token");

describe("static-secret provider", () => {
  it("returns the API key, rereads after five minutes or after invalidate, and never binds routing values", async () => {
    let now = 0;
    const source = secrets({ "agentx/connectors/jira": JSON.stringify({ apiKey: "key-1" }) });
    const provider = staticSecretProvider({ ref: "jira", secretName: "agentx/connectors/jira", secrets: source, now: () => now });
    expect(await provider.issue(undefined, "read")).toEqual({ token: "key-1", bindings: {} });
    await provider.issue(undefined, "write");
    expect(source.read).toHaveBeenCalledOnce();
    now = 300_000;
    await provider.issue(undefined, "read");
    expect(source.read).toHaveBeenCalledTimes(2);
    await provider.invalidate?.(undefined);
    await provider.issue(undefined, "read");
    expect(source.read).toHaveBeenCalledTimes(3);
  });

  it("reports a missing or malformed secret as unavailable without echoing its content", async () => {
    const missing = staticSecretProvider({ ref: "jira", secretName: "agentx/connectors/jira", secrets: secrets({}) });
    await expect(missing.issue(undefined, "read")).rejects.toThrow(new CredentialUnavailable("credential jira: secret agentx/connectors/jira was not found"));
    const malformed = staticSecretProvider({ ref: "jira", secretName: "agentx/connectors/jira", secrets: secrets({ "agentx/connectors/jira": JSON.stringify({ token: "leaky-value" }) }) });
    const error = await malformed.issue(undefined, "read").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialUnavailable);
    expect((error as Error).message).toBe('credential jira: secret agentx/connectors/jira must be JSON {"apiKey": "..."}');
    expect((error as Error).message).not.toContain("leaky-value");
  });
});

describe("parseConnectorSecret", () => {
  it("parses each type's shape and names only the secret when it is missing or malformed", () => {
    expect(parseConnectorSecret("static-secret", JSON.stringify({ apiKey: "k" }), "jira", "agentx/connectors/jira")).toEqual({ apiKey: "k" });
    expect(parseConnectorSecret("oauth-client-credentials", client, "linear", "agentx/connectors/linear")).toEqual({ clientId: "client-id", clientSecret: "client-secret-value", scopes: ["write", "read"] });
    expect(() => parseConnectorSecret("static-secret", undefined, "jira", "agentx/connectors/jira")).toThrow(new CredentialUnavailable("credential jira: secret agentx/connectors/jira was not found"));
    expect(() => parseConnectorSecret("oauth-client-credentials", JSON.stringify({ apiKey: "leaky-value" }), "linear", "agentx/connectors/linear"))
      .toThrow(new CredentialUnavailable('credential linear: secret agentx/connectors/linear must be JSON {"clientId": "...", "clientSecret": "...", "scopes": ["..."]}'));
    expect(() => parseConnectorSecret("static-secret", "not json leaky-value", "jira", "agentx/connectors/jira")).toThrow('credential jira: secret agentx/connectors/jira must be JSON {"apiKey": "..."}');
  });
});

describe("oauth-client-credentials provider", () => {
  const tokenResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("mints with the fixed scope set, form-encoded, without following redirects", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ access_token: "token-1", expires_in: 3600, token_type: "Bearer" }));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation, now: () => 0 });
    expect(await provider.issue(undefined, "read")).toEqual({ token: "token-1", bindings: {} });
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(String(url as URL)).toBe(endpoint.href);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body as string)))).toEqual({ grant_type: "client_credentials", client_id: "client-id", client_secret: "client-secret-value", scope: "write read" });
  });

  it("reuses a token until five minutes before expiry, from memory and then from the shared cache", async () => {
    let now = 0;
    let callCount = 0;
    const tokens = memoryCache();
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ access_token: `token-${++callCount}`, expires_in: 3600 }));
    const options = { ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens, tokenEndpoint: endpoint, fetchImplementation, now: () => now };
    const first = oauthClientCredentialsProvider(options);
    await first.issue(undefined, "read");
    await first.issue(undefined, "read");
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(tokens.items.get(scopeKey(["read", "write"]))).toEqual({ token: "token-1", expiresAt: 3_600_000 });
    // Another container reads the shared cache instead of minting.
    expect(await oauthClientCredentialsProvider(options).issue(undefined, "read")).toMatchObject({ token: "token-1" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    now = 3_600_000 - 300_000;
    expect(await first.issue(undefined, "read")).toMatchObject({ token: "token-2" });
  });

  it("invalidate deletes the cached token and rereads the secret, so a rotated secret is used", async () => {
    const tokens = memoryCache();
    const source = secrets({ s: client });
    let callCount = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ access_token: `token-${++callCount}`, expires_in: 3600 }));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: source, tokens, tokenEndpoint: endpoint, fetchImplementation, now: () => 0 });
    await provider.issue(undefined, "read");
    await provider.invalidate?.(undefined);
    expect(tokens.items.size).toBe(0);
    expect(await provider.issue(undefined, "read")).toMatchObject({ token: "token-2" });
    expect(source.read).toHaveBeenCalledTimes(2);
  });

  it("reports refused client credentials as unavailable with only the OAuth error code", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ error: "invalid_client", error_description: "bad client-secret-value" }, 401));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation });
    const error = await provider.issue(undefined, "read").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialUnavailable);
    expect((error as Error).message).toBe("credential linear: the token endpoint refused the client credentials with HTTP 401 (invalid_client)");
  });

  it("treats a server error or a response without a token as transient, never echoing the body", async () => {
    for (const response of [new Response("oops client-secret-value", { status: 502 }), tokenResponse({ token_type: "Bearer" })]) {
      const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation: vi.fn<typeof fetch>(async () => response) });
      const error = await provider.issue(undefined, "read").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(CredentialUnavailable);
      expect((error as Error).message).not.toContain("client-secret-value");
    }
  });

  it("assumes one hour when the endpoint omits expires_in", async () => {
    const tokens = memoryCache();
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens, tokenEndpoint: endpoint, fetchImplementation: vi.fn<typeof fetch>(async () => tokenResponse({ access_token: "t" })), now: () => 10 });
    await provider.issue(undefined, "read");
    expect([...tokens.items.values()]).toEqual([{ token: "t", expiresAt: 3_600_010 }]);
  });

  // --- fix round 1 -----------------------------------------------------------------------

  it("aborts a token response over the size limit without reading or echoing the body", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response("x".repeat(70_000), { status: 200 }));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation });
    const error = await provider.issue(undefined, "read").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CredentialUnavailable);
    expect((error as Error).message).toBe("token endpoint response exceeded limit");
    expect((error as Error).message).not.toContain("x".repeat(100));
  });

  it("counts UTF-8 bytes rather than UTF-16 length when checking the response size", async () => {
    // 40,000 UTF-16 units (under the limit) but ~80,000 UTF-8 bytes (over it) — a length check on the
    // decoded string would miss this.
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response("é".repeat(40_000), { status: 200 }));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation });
    const error = await provider.issue(undefined, "read").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CredentialUnavailable);
    expect((error as Error).message).toBe("token endpoint response exceeded limit");
  });

  it("rejects a response early from a declared content-length, before reading the body", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200, headers: { "content-length": "999999" } }));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation });
    const error = await provider.issue(undefined, "read").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CredentialUnavailable);
    expect((error as Error).message).toBe("token endpoint response exceeded limit");
  });

  it("reuses a short-lived token within half its lifetime, even though that is under the fixed refresh margin", async () => {
    let now = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ access_token: "short-token", expires_in: 60 }));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation, now: () => now });
    await provider.issue(undefined, "read");
    now = 15_000;
    expect(await provider.issue(undefined, "read")).toEqual({ token: "short-token", bindings: {} });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("remints a short-lived token once half its lifetime has passed", async () => {
    let now = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ access_token: "short-token", expires_in: 60 }));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation, now: () => now });
    await provider.issue(undefined, "read");
    now = 31_000; // just past half of the 60s lifetime (30s margin)
    await provider.issue(undefined, "read");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent issue() calls into a single mint", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ access_token: "shared-token", expires_in: 3600 }));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation });
    const [first, second] = await Promise.all([provider.issue(undefined, "read"), provider.issue(undefined, "read")]);
    expect(first).toEqual({ token: "shared-token", bindings: {} });
    expect(second).toEqual({ token: "shared-token", bindings: {} });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("clears the in-flight promise on a failed mint so the next call retries", async () => {
    let attempt = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return tokenResponse({ access_token: "recovered-token", expires_in: 3600 });
    });
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation });
    await expect(provider.issue(undefined, "read")).rejects.toThrow("network down");
    await expect(provider.issue(undefined, "read")).resolves.toEqual({ token: "recovered-token", bindings: {} });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("invalidate deletes the shared-cache entry even before any issue on this instance", async () => {
    const tokens = memoryCache();
    await tokens.put(scopeKey(["read", "write"]), { token: "preexisting", expiresAt: 999_999_999 });
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens, tokenEndpoint: endpoint, fetchImplementation: vi.fn<typeof fetch>() });
    await provider.invalidate?.(undefined);
    expect(tokens.items.size).toBe(0);
  });

  it("invalidate just clears memory, without throwing, when the secret cannot be read", async () => {
    const tokens = memoryCache();
    await tokens.put(scopeKey(["read", "write"]), { token: "unrelated", expiresAt: 999_999_999 });
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "missing", secrets: secrets({}), tokens, tokenEndpoint: endpoint, fetchImplementation: vi.fn<typeof fetch>() });
    await expect(provider.invalidate?.(undefined)).resolves.toBeUndefined();
    expect(tokens.items.size).toBe(1); // the key could not be computed, so nothing was deleted
  });

  it("does not persist a token from a mint that was still in flight when invalidate() ran", async () => {
    const tokens = memoryCache();
    let resolveFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const fetchImplementation = vi.fn<typeof fetch>(() => pending);
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens, tokenEndpoint: endpoint, fetchImplementation, now: () => 0 });
    const issuing = provider.issue(undefined, "read");
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());
    await provider.invalidate?.(undefined);
    resolveFetch(tokenResponse({ access_token: "stale-token", expires_in: 3600 }));
    await expect(issuing).resolves.toEqual({ token: "stale-token", bindings: {} });
    expect(tokens.items.size).toBe(0);
    fetchImplementation.mockImplementation(async () => tokenResponse({ access_token: "fresh-token", expires_in: 3600 }));
    await expect(provider.issue(undefined, "read")).resolves.toEqual({ token: "fresh-token", bindings: {} });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("drops a refusal error code that fails the safe pattern", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ error: "Invalid Client!" }, 401));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation });
    const error = await provider.issue(undefined, "read").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialUnavailable);
    expect((error as Error).message).toBe("credential linear: the token endpoint refused the client credentials with HTTP 401");
  });

  it("also raises CredentialUnavailable for HTTP 400 and 403 refusals", async () => {
    for (const status of [400, 403] as const) {
      const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ error: "invalid_scope" }, status));
      const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation });
      const error = await provider.issue(undefined, "read").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CredentialUnavailable);
      expect((error as Error).message).toBe(`credential linear: the token endpoint refused the client credentials with HTTP ${status} (invalid_scope)`);
    }
  });

  it("propagates a fetch rejection as a non-CredentialUnavailable error", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => { throw new Error("network down"); });
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation });
    const error = await provider.issue(undefined, "read").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CredentialUnavailable);
    expect((error as Error).message).toBe("network down");
  });

  it("includes an abort signal on the token request", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ access_token: "token-1", expires_in: 3600 }));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation });
    await provider.issue(undefined, "read");
    const [, init] = fetchImplementation.mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  // --- fix round 2 -----------------------------------------------------------------------

  it("mints fresh for an issue() after invalidate(), even while an earlier mint for the same key is still in flight", async () => {
    const tokens = memoryCache();
    let resolveStale!: (response: Response) => void;
    const pendingStale = new Promise<Response>((resolve) => { resolveStale = resolve; });
    let callCount = 0;
    const fetchImplementation = vi.fn<typeof fetch>(() => {
      callCount += 1;
      if (callCount === 1) return pendingStale;
      return Promise.resolve(tokenResponse({ access_token: "new-token", expires_in: 3600 }));
    });
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens, tokenEndpoint: endpoint, fetchImplementation, now: () => 0 });

    const issuingA = provider.issue(undefined, "read");
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());
    await provider.invalidate?.(undefined);

    const resultB = await provider.issue(undefined, "read");
    expect(resultB).toEqual({ token: "new-token", bindings: {} });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);

    resolveStale(tokenResponse({ access_token: "stale-token", expires_in: 3600 }));
    await expect(issuingA).resolves.toEqual({ token: "stale-token", bindings: {} });
    expect(tokens.items.get(scopeKey(["read", "write"]))).toEqual({ token: "new-token", expiresAt: 3_600_000 });
    expect(tokens.items.size).toBe(1);

    // memory must still hold B's token: a third call reuses it rather than minting again.
    expect(await provider.issue(undefined, "read")).toEqual({ token: "new-token", bindings: {} });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("deletes a token whose shared-cache write was still in flight when invalidate() ran", async () => {
    const items = new Map<string, CachedToken>();
    let releasePut!: () => void;
    const putGate = new Promise<void>((resolve) => { releasePut = resolve; });
    let putStarted = false;
    const tokens: TokenCache = {
      get: async (k) => items.get(k),
      put: async (k, v) => { putStarted = true; await putGate; items.set(k, v); },
      delete: async (k) => { items.delete(k); },
    };
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ access_token: "token-1", expires_in: 3600 }));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens, tokenEndpoint: endpoint, fetchImplementation, now: () => 0 });

    const issuing = provider.issue(undefined, "read");
    await vi.waitFor(() => expect(putStarted).toBe(true));
    await provider.invalidate?.(undefined);
    releasePut();
    await issuing;
    expect(items.size).toBe(0);
  });

  it("cancels the response body on the early content-length rejection", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); },
      cancel() { cancelled = true; },
    });
    const response = new Response(stream, { status: 200, headers: { "content-length": "999999" } });
    const fetchImplementation = vi.fn<typeof fetch>(async () => response);
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation });
    const error = await provider.issue(undefined, "read").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CredentialUnavailable);
    expect((error as Error).message).toBe("token endpoint response exceeded limit");
    expect(cancelled).toBe(true);
  });

  // --- fix round 3 -----------------------------------------------------------------------

  it("does not let an old task's finally delete a newer task's still-active in-flight entry", async () => {
    const tokens = memoryCache();
    let resolveA!: (response: Response) => void;
    const pendingA = new Promise<Response>((resolve) => { resolveA = resolve; });
    let resolveB!: (response: Response) => void;
    const pendingB = new Promise<Response>((resolve) => { resolveB = resolve; });
    let callCount = 0;
    const fetchImplementation = vi.fn<typeof fetch>(() => {
      callCount += 1;
      if (callCount === 1) return pendingA;
      if (callCount === 2) return pendingB;
      return Promise.resolve(tokenResponse({ access_token: "unexpected-token", expires_in: 3600 }));
    });
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens, tokenEndpoint: endpoint, fetchImplementation, now: () => 0 });

    // A: a mint starts and is held.
    const issuingA = provider.issue(undefined, "read");
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());

    // invalidate() drops A's in-flight entry, but A's own mint keeps running in the background.
    await provider.invalidate?.(undefined);

    // B: a fresh mint starts under the same key (A's entry is gone), also held.
    const issuingB = provider.issue(undefined, "read");
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(2));

    // Let A settle *first* — its own finally must not touch B's still-active in-flight entry.
    resolveA(tokenResponse({ access_token: "stale-token", expires_in: 3600 }));
    await expect(issuingA).resolves.toEqual({ token: "stale-token", bindings: {} });

    // C arrives while B is still in flight. If A's finally wrongly deleted B's entry above, C
    // would start a third mint here instead of joining B's.
    const issuingC = provider.issue(undefined, "read");
    await new Promise((resolve) => { setImmediate(resolve); });
    resolveB(tokenResponse({ access_token: "shared-token", expires_in: 3600 }));

    await expect(issuingB).resolves.toEqual({ token: "shared-token", bindings: {} });
    await expect(issuingC).resolves.toEqual({ token: "shared-token", bindings: {} });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
