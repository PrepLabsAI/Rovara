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

  it("mints contents-write credentials only for push access", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const bodies: unknown[] = [];
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github-agentx-sdlc",
      account: "ps06756",
      appId: "5002502",
      installationId: "163046162",
      getPrivateKey: async () => pem,
      fetchImplementation: async (_url, init) => {
        if (typeof init?.body !== "string") throw new Error("expected JSON request body");
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ token: "push-token" }), { status: 201 });
      },
    });

    await provider.resolve(
      "github-agentx-sdlc",
      "https://github.com/ps06756/personal-website-test.git",
      "push",
    );
    expect(bodies).toEqual([{
      repositories: ["personal-website-test"],
      permissions: { contents: "write" },
    }]);
  });

  it("uses a repository-scoped PR token that can resolve private refs", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github-agentx-sdlc",
      account: "ps06756",
      appId: "5002502",
      installationId: "163046162",
      getPrivateKey: async () => pem,
      fetchImplementation: async (url, init) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        requests.push({ url: requestUrl, init });
        if (requestUrl.endsWith("/access_tokens")) {
          return new Response(JSON.stringify({ token: "pr-token" }), { status: 201 });
        }
        if (init?.method === "POST") {
          return new Response(JSON.stringify({
            number: 42,
            html_url: "https://github.com/ps06756/personal-website-test/pull/42",
          }), { status: 201 });
        }
        return new Response("[]", { status: 200 });
      },
    });

    await expect(provider.reconcilePullRequest({
      repositoryUrl: "https://github.com/ps06756/personal-website-test.git",
      headBranch: "agentx/00000000-0000-4000-8000-000000000001",
      baseBranch: "main",
      title: "Publish change",
    })).resolves.toEqual({
      number: 42,
      url: "https://github.com/ps06756/personal-website-test/pull/42",
      reconciled: false,
    });
    const tokenRequestBody = requests[0]?.init?.body;
    if (typeof tokenRequestBody !== "string") throw new Error("expected JSON request body");
    expect(JSON.parse(tokenRequestBody)).toEqual({
      repositories: ["personal-website-test"],
      permissions: { contents: "read", pull_requests: "write" },
    });
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe("Bearer pr-token");
    expect(requests[1]?.url).toContain("head=ps06756%3Aagentx%2F");
  });

  it("reconciles an existing PR and never reflects failed response bodies", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let mode: "existing" | "failure" = "existing";
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github-agentx-sdlc",
      account: "ps06756",
      appId: "5002502",
      installationId: "163046162",
      getPrivateKey: async () => pem,
      fetchImplementation: async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) {
          return new Response(JSON.stringify({ token: "pr-token" }), { status: 201 });
        }
        if (mode === "existing") {
          return new Response(JSON.stringify([{
            number: 7,
            html_url: "https://github.com/ps06756/personal-website-test/pull/7",
          }]), { status: 200 });
        }
        return new Response("sensitive-github-error", { status: 403 });
      },
    });
    const input = {
      repositoryUrl: "https://github.com/ps06756/personal-website-test.git",
      headBranch: "agentx/00000000-0000-4000-8000-000000000001",
      baseBranch: "main",
      title: "Publish change",
    };
    await expect(provider.reconcilePullRequest(input)).resolves.toMatchObject({ number: 7, reconciled: true });
    mode = "failure";
    await expect(provider.reconcilePullRequest(input)).rejects.toThrow(/HTTP 403/);
    await expect(provider.reconcilePullRequest(input)).rejects.not.toThrow(/sensitive-github-error/);
  });

  it("reconciles after an ambiguous create timeout instead of creating a duplicate", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let lookupCount = 0;
    let createCount = 0;
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github-agentx-sdlc",
      account: "ps06756",
      appId: "5002502",
      installationId: "163046162",
      getPrivateKey: async () => pem,
      fetchImplementation: async (url, init) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) {
          return new Response(JSON.stringify({ token: "pr-token" }), { status: 201 });
        }
        if (init?.method === "POST") {
          createCount += 1;
          throw new TypeError("socket closed after request body was sent");
        }
        lookupCount += 1;
        return new Response(JSON.stringify(lookupCount === 1 ? [] : [{
          number: 19,
          html_url: "https://github.com/ps06756/personal-website-test/pull/19",
        }]), { status: 200 });
      },
    });

    await expect(provider.reconcilePullRequest({
      repositoryUrl: "https://github.com/ps06756/personal-website-test.git",
      headBranch: "agentx/00000000-0000-4000-8000-000000000001",
      baseBranch: "main",
      title: "Publish change",
    })).resolves.toMatchObject({ number: 19, reconciled: true });
    expect(createCount).toBe(1);
    expect(lookupCount).toBe(2);
  });

  it("looks up canonical pull request state with read-only permissions", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github-agentx-sdlc",
      account: "ps06756",
      appId: "5002502",
      installationId: "163046162",
      getPrivateKey: async () => pem,
      fetchImplementation: async (url, init) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        requests.push({ url: requestUrl, init });
        if (requestUrl.endsWith("/access_tokens")) {
          return new Response(JSON.stringify({ token: "lookup-token" }), { status: 201 });
        }
        return new Response(JSON.stringify(pullRequestFixture()), { status: 200 });
      },
    });

    await expect(provider.getPullRequest(
      "https://github.com/ps06756/personal-website-test.git",
      42,
    )).resolves.toEqual({
      number: 42,
      url: "https://github.com/ps06756/personal-website-test/pull/42",
      state: "open",
      headBranch: "agentx/00000000-0000-4000-8000-000000000001",
      baseBranch: "main",
      headCommit: "a".repeat(40),
      title: "Current title",
      body: "Current body",
    });
    const tokenBody = requests[0]?.init?.body;
    if (typeof tokenBody !== "string") throw new Error("expected token body");
    expect((JSON.parse(tokenBody) as { permissions: unknown }).permissions)
      .toEqual({ contents: "read", pull_requests: "read" });
    expect(requests[1]?.url).toBe("https://api.github.com/repos/ps06756/personal-website-test/pulls/42");
  });

  it("updates metadata and state with pull-request write permission", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github-agentx-sdlc",
      account: "ps06756",
      appId: "5002502",
      installationId: "163046162",
      getPrivateKey: async () => pem,
      fetchImplementation: async (url, init) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        requests.push({ url: requestUrl, init });
        if (requestUrl.endsWith("/access_tokens")) {
          return new Response(JSON.stringify({ token: "update-token" }), { status: 201 });
        }
        return new Response(JSON.stringify({
          ...pullRequestFixture(),
          state: "closed",
          title: "Updated title",
          body: "Updated body",
        }), { status: 200 });
      },
    });

    await expect(provider.updatePullRequest(
      "https://github.com/ps06756/personal-website-test.git",
      42,
      { title: "Updated title", body: "Updated body", state: "closed" },
    )).resolves.toMatchObject({ state: "closed", title: "Updated title", body: "Updated body" });
    const tokenBody = requests[0]?.init?.body;
    const updateBody = requests[1]?.init?.body;
    if (typeof tokenBody !== "string" || typeof updateBody !== "string") throw new Error("expected JSON bodies");
    expect((JSON.parse(tokenBody) as { permissions: unknown }).permissions)
      .toEqual({ contents: "read", pull_requests: "write" });
    expect(requests[1]?.init?.method).toBe("PATCH");
    expect(JSON.parse(updateBody)).toEqual({ title: "Updated title", body: "Updated body", state: "closed" });
  });

  it("does not reflect GitHub bodies when pull request lookup or update fails", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github-agentx-sdlc",
      account: "ps06756",
      appId: "5002502",
      installationId: "163046162",
      getPrivateKey: async () => pem,
      fetchImplementation: async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        return requestUrl.endsWith("/access_tokens")
          ? new Response(JSON.stringify({ token: "token" }), { status: 201 })
          : new Response("sensitive-github-body", { status: 403 });
      },
    });
    await expect(provider.getPullRequest("https://github.com/ps06756/personal-website-test", 42))
      .rejects.not.toThrow(/sensitive-github-body/);
    await expect(provider.updatePullRequest("https://github.com/ps06756/personal-website-test", 42, { state: "closed" }))
      .rejects.not.toThrow(/sensitive-github-body/);
  });

  it("reconciles an ambiguous update when GitHub already applied the requested state", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let patchCount = 0;
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github-agentx-sdlc",
      account: "ps06756",
      appId: "5002502",
      installationId: "163046162",
      getPrivateKey: async () => pem,
      fetchImplementation: async (url, init) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) {
          return new Response(JSON.stringify({ token: "update-token" }), { status: 201 });
        }
        if (init?.method === "PATCH") {
          patchCount += 1;
          throw new TypeError("connection closed after request");
        }
        return new Response(JSON.stringify({ ...pullRequestFixture(), state: "closed" }), { status: 200 });
      },
    });
    await expect(provider.updatePullRequest(
      "https://github.com/ps06756/personal-website-test",
      42,
      { state: "closed" },
    )).resolves.toMatchObject({ state: "closed" });
    expect(patchCount).toBe(1);
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

function pullRequestFixture(): Record<string, unknown> {
  return {
    number: 42,
    html_url: "https://github.com/ps06756/personal-website-test/pull/42",
    state: "open",
    merged: false,
    merge_commit_sha: null,
    head: { ref: "agentx/00000000-0000-4000-8000-000000000001", sha: "a".repeat(40) },
    base: { ref: "main" },
    title: "Current title",
    body: "Current body",
  };
}
