import { describe, expect, it, vi } from "vitest";
import { createPkceParameters, loginWithPkce, tokenStoreKey } from "../../packages/cli/src/auth.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

describe("browser PKCE authentication", () => {
  it("uses state and S256 PKCE and stores tokens without returning them to output", async () => {
    const store = new InMemoryTokenStore();
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          authorization_endpoint: "https://identity.example.test/authorize",
          token_endpoint: "https://identity.example.test/token",
        });
      }
      if (url === "https://identity.example.test/token") {
        expect(init?.body).toBeInstanceOf(URLSearchParams);
        expect(init?.body instanceof URLSearchParams ? init.body.toString() : "").toContain("code_verifier=");
        return Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600 });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const login = {
      issuer: "https://identity.example.test",
      clientId: "agentx-client",
      audience: "agentx-api",
      tokenStore: store,
      fetchImplementation,
      openBrowser: async (authorizationUrl: string) => {
        const authorization = new URL(authorizationUrl);
        expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorization.searchParams.get("scope")).toBe("openid");
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        callback.searchParams.set("code", "authorization-code");
        await fetch(callback);
      },
    };

    await expect(loginWithPkce(login)).resolves.toMatchObject({ accessToken: "access-secret" });
    await expect(store.get(tokenStoreKey(login))).resolves.toMatchObject({ refreshToken: "refresh-secret" });
  });

  it("requests offline access only when the provider advertises support", async () => {
    const store = new InMemoryTokenStore();
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          authorization_endpoint: "https://identity.example.test/authorize",
          token_endpoint: "https://identity.example.test/token",
          scopes_supported: ["openid", "offline_access"],
        });
      }
      if (url === "https://identity.example.test/token") {
        expect(init?.body).toBeInstanceOf(URLSearchParams);
        return Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    await loginWithPkce({
      issuer: "https://identity.example.test",
      clientId: "agentx-client",
      audience: "agentx-api",
      tokenStore: store,
      fetchImplementation,
      openBrowser: async (authorizationUrl: string) => {
        const authorization = new URL(authorizationUrl);
        expect(authorization.searchParams.get("scope")).toBe("openid offline_access");
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        callback.searchParams.set("code", "authorization-code");
        await fetch(callback);
      },
    });
  });

  it("creates verifier, challenge and state values with sufficient entropy", () => {
    const first = createPkceParameters();
    const second = createPkceParameters();
    expect(first.verifier.length).toBeGreaterThanOrEqual(43);
    expect(first.challenge).not.toBe(first.verifier);
    expect(first.state).not.toBe(second.state);
  });
});
