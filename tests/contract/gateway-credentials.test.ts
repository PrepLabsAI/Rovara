import { describe, expect, it, vi } from "vitest";
import {
  CredentialUnavailable, oauthClientCredentialsProvider, scopeKey, staticSecretProvider,
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
});
