import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubAppCredentialProvider,
  createGitHubAppJwt,
  privateKeyFromSecret,
} from "../../packages/broker/src/github-app.js";

describe("GitHub App repository credentials", () => {
  it("mints a repository-scoped installation token", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      requests.push({ url: requestUrl, init });
      return new Response(JSON.stringify({ token: "installation-token", expires_at: "2030-01-01T00:00:00Z" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github-agentx-sdlc",
      account: "ps06756",
      appId: "5002502",
      installationId: "163046162",
      getPrivateKey: async () => pem,
      fetchImplementation,
      now: () => 1_800_000_000_000,
    });

    await expect(
      provider.resolve(
        "github-agentx-sdlc",
        "https://github.com/ps06756/personal-website-test.git",
      ),
    ).resolves.toEqual({ username: "x-access-token", password: "installation-token" });
    expect(requests[0]?.url).toBe(
      "https://api.github.com/app/installations/163046162/access_tokens",
    );
    const requestBody = requests[0]?.init?.body;
    if (typeof requestBody !== "string") throw new Error("expected a string request body");
    expect(JSON.parse(requestBody)).toEqual({
      repositories: ["personal-website-test"],
      permissions: { contents: "read" },
    });
    const authorization = new Headers(requests[0]?.init?.headers).get("authorization");
    const jwt = authorization?.replace(/^Bearer /, "") ?? "";
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))).toMatchObject({
      iss: "5002502",
      iat: 1_799_999_940,
      exp: 1_800_000_540,
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });

  it("rejects cross-account URLs before contacting GitHub", async () => {
    const fetchImplementation = vi.fn();
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github-agentx-sdlc",
      account: "ps06756",
      appId: "5002502",
      installationId: "163046162",
      getPrivateKey: async () => "not reached",
      fetchImplementation,
    });

    await expect(
      provider.resolve("github-agentx-sdlc", "https://github.com/another/private.git"),
    ).rejects.toThrow(/outside/i);
    expect(fetchImplementation).not.toHaveBeenCalled();
    await expect(
      provider.resolve("public-repositories", "https://github.com/another/public.git"),
    ).resolves.toEqual({});
  });

  it("accepts raw or JSON-wrapped PEM secrets without reflecting invalid secret data", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----";
    expect(privateKeyFromSecret(pem)).toBe(pem);
    expect(privateKeyFromSecret(JSON.stringify({ privateKey: pem }))).toBe(pem);
    expect(() => privateKeyFromSecret("sensitive-invalid-value")).toThrow(/not a PEM/i);
    expect(() => createGitHubAppJwt("5002502", "sensitive-invalid-value", Date.now())).toThrow(
      /could not sign/i,
    );
  });
});
