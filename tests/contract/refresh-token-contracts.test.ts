import { describe, expect, it } from "vitest";
import {
  CredentialRegistrationSchema, OAUTH_AUTHORIZATION_PROFILES, OAuthAppSecretSchema, OAuthRefreshTokenSecretSchema, oauthProfile,
} from "../../packages/contracts/src/index.js";

describe("oauth-refresh-token secrets and sign-in profiles (phase 7)", () => {
  it("parses the stored secret only with a client and a refresh token, and nothing that could redirect the broker", () => {
    const secret = { clientId: "1234567890", clientSecret: "client-secret-value", refreshToken: "refresh-token-value" };
    expect(OAuthRefreshTokenSecretSchema.parse(secret)).toEqual(secret);
    expect(OAuthRefreshTokenSecretSchema.safeParse({ clientId: "1234567890", clientSecret: "client-secret-value" }).success).toBe(false);
    expect(OAuthRefreshTokenSecretSchema.safeParse({ ...secret, refreshToken: "" }).success).toBe(false);
    expect(OAuthRefreshTokenSecretSchema.safeParse({ ...secret, tokenEndpoint: "https://evil.test" }).success).toBe(false);
  });

  it("reads the app secret before the first sign-in, still strictly", () => {
    expect(OAuthAppSecretSchema.parse({ clientId: "1234567890", clientSecret: "s" })).toEqual({ clientId: "1234567890", clientSecret: "s" });
    expect(OAuthAppSecretSchema.safeParse({ clientId: "1234567890", clientSecret: "s", refreshToken: "r" }).success).toBe(true);
    expect(OAuthAppSecretSchema.safeParse({ clientId: "1234567890", clientSecret: "s", redirectUri: "https://evil.test" }).success).toBe(false);
    expect(OAuthAppSecretSchema.safeParse({ clientId: "1234567890" }).success).toBe(false);
  });

  it("carries Asana's sign-in endpoints, proven live on 2026-09-24, and no profile for other types", () => {
    expect(OAUTH_AUTHORIZATION_PROFILES.asana).toEqual({
      authorizeUrl: "https://app.asana.com/-/oauth_authorize",
      tokenUrl: "https://app.asana.com/-/oauth_token",
      resource: "https://mcp.asana.com/v2/mcp",
      redirectUri: "http://localhost:8765/callback",
    });
    expect(oauthProfile("asana")).toBe(OAUTH_AUTHORIZATION_PROFILES.asana);
    expect(oauthProfile("linear")).toBeUndefined();
    expect(oauthProfile("toString")).toBeUndefined();
  });
});

describe("oauth-refresh-token registration (phase 7)", () => {
  it("registers an oauth-refresh-token credential with a connector secret name", () => {
    expect(CredentialRegistrationSchema.parse({ ref: "asana-bot", type: "oauth-refresh-token", secretName: "agentx/connectors/asana-bot" }))
      .toEqual({ ref: "asana-bot", type: "oauth-refresh-token", secretName: "agentx/connectors/asana-bot" });
    expect(CredentialRegistrationSchema.safeParse({ ref: "asana-bot", type: "oauth-refresh-token", secretName: "prod/asana" }).success).toBe(false);
  });
});
