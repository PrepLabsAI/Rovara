import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubAppCredentialProvider,
  appIdFromSecret,
  createGitHubAppJwt,
  privateKeyFromSecret,
  webhookSecretFromSecret,
} from "../../packages/broker/src/github-app.js";

/** A provider whose installation lookups GitHub answers for any owner, as installation 163046162. */
function appProvider(options: ConstructorParameters<typeof GitHubAppCredentialProvider>[0]): GitHubAppCredentialProvider {
  const inner = options.fetchImplementation ?? fetch;
  const answering = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/[^/]+\/installation$/.exec(requestUrl);
    if (match) return new Response(JSON.stringify({ id: 163046162, account: { login: decodeURIComponent(match[1]!) } }), { status: 200 });
    return inner(url, init);
  }) as typeof fetch;
  return new GitHubAppCredentialProvider({ ...options, fetchImplementation: answering });
}

describe("GitHub App repository credentials", () => {
  it("mints fresh issue-only tokens for the selected repository and rejects unregistered credentials", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const getPrivateKey = vi.fn(async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ token: "issue-token" }), { status: 201 }));
    const provider = appProvider({
      credentialRef: "github-app", appId: "123",
      getPrivateKey, fetchImplementation,
    });
    const repository = { credentialRef: "github-app", url: "https://github.com/example/demo.git" };
    for (const access of ["read", "write"] as const) {
      await expect(provider.issueCredentials(repository, access)).resolves.toEqual({ owner: "example", repo: "demo", token: "issue-token" });
      expect(fetchImplementation).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
        body: JSON.stringify({ repositories: ["demo"], permissions: { issues: access } }), redirect: "error",
      }));
    }
    await expect(provider.issueCredentials({ ...repository, credentialRef: "unregistered" }, "write")).rejects.toThrow();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    // One installation lookup (then cached) and one token per call, each signed as the App.
    expect(getPrivateKey).toHaveBeenCalledTimes(3);
  });

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
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
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
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
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
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
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
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
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
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
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
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
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
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
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
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
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
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
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

  it("looks up each owner's installation once, and uses the owner as GitHub spells it", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const installations: Record<string, { id: number; login: string }> = {
      ps06756: { id: 163046162, login: "ps06756" },
      preplabsai: { id: 165573514, login: "PrepLabsAI" },
    };
    const urls: string[] = [];
    const fetchImplementation = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      urls.push(requestUrl);
      const lookup = /\/repos\/([^/]+)\/[^/]+\/installation$/.exec(requestUrl);
      if (lookup) {
        const installation = installations[lookup[1]!.toLowerCase()]!;
        return new Response(JSON.stringify({ id: installation.id, account: { login: installation.login } }), { status: 200 });
      }
      return new Response(JSON.stringify({ token: "token" }), { status: 201 });
    });
    const provider = new GitHubAppCredentialProvider({ credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem, fetchImplementation });

    await provider.resolve("github-agentx-sdlc", "https://github.com/ps06756/personal-website-test.git");
    await provider.resolve("github-agentx-sdlc", "https://github.com/ps06756/personal-website-test.git", "push");
    await expect(provider.issueCredentials({ credentialRef: "github-agentx-sdlc", url: "https://github.com/preplabsai/Sample-Project-A.git" }, "read"))
      .resolves.toEqual({ owner: "PrepLabsAI", repo: "Sample-Project-A", token: "token" });
    expect(urls).toEqual([
      "https://api.github.com/repos/ps06756/personal-website-test/installation",
      "https://api.github.com/app/installations/163046162/access_tokens",
      "https://api.github.com/app/installations/163046162/access_tokens",
      "https://api.github.com/repos/preplabsai/Sample-Project-A/installation",
      "https://api.github.com/app/installations/165573514/access_tokens",
    ]);
  });

  it("refuses a repository the App cannot see, without caching the refusal", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let installed = false;
    const fetchImplementation = vi.fn(async () => installed
      ? new Response(JSON.stringify({ id: 165573514, account: { login: "PrepLabsAI" } }), { status: 200 })
      : new Response("{\"message\":\"Not Found\"}", { status: 404 }));
    const provider = new GitHubAppCredentialProvider({ credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem, fetchImplementation });
    const repository = { credentialRef: "github-agentx-sdlc", url: "https://github.com/PrepLabsAI/Sample-Project-A.git" };

    await expect(provider.checkRepository(repository)).rejects.toThrow(/CONFIG_INVALID: the GitHub App cannot access PrepLabsAI\/Sample-Project-A; install it on PrepLabsAI/);
    installed = true;
    await expect(provider.checkRepository(repository)).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("matches a webhook repository against its registered URL, App installation and GitHub numeric ID", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const requests: string[] = [];
    const fetchImplementation = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      requests.push(requestUrl);
      if (requestUrl.endsWith("/installation")) return new Response(JSON.stringify({ id: 555, account: { login: "Example" } }), { status: 200 });
      if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "fixture-token" }), { status: 201 });
      return new Response(JSON.stringify({ id: 1234, full_name: "Example/Demo" }), { status: 200 });
    });
    const provider = new GitHubAppCredentialProvider({ credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem, fetchImplementation });
    const repositoryUrl = "https://github.com/Example/Demo.git";

    await expect(provider.verifyWebhookRepository(repositoryUrl, { installationId: 555, repositoryId: 1234, fullName: "example/demo" })).resolves.toBe(true);
    await expect(provider.verifyWebhookRepository(repositoryUrl, { installationId: 556, repositoryId: 1234, fullName: "example/demo" })).resolves.toBe(false);
    await expect(provider.verifyWebhookRepository(repositoryUrl, { installationId: 555, repositoryId: 9999, fullName: "example/demo" })).resolves.toBe(false);
    await expect(provider.verifyWebhookRepository(repositoryUrl, { installationId: 555, repositoryId: 1234, fullName: "other/demo" })).resolves.toBe(false);
    expect(requests).toContain("https://api.github.com/repos/Example/Demo");
  });

  it("looks the installation up again when the App was reinstalled", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let installationId = 111;
    const urls: string[] = [];
    const fetchImplementation = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      urls.push(requestUrl);
      if (requestUrl.endsWith("/installation")) return new Response(JSON.stringify({ id: installationId, account: { login: "ps06756" } }), { status: 200 });
      return requestUrl.includes(`/installations/${installationId}/`)
        ? new Response(JSON.stringify({ token: "token" }), { status: 201 })
        : new Response("{}", { status: 404 });
    });
    const provider = new GitHubAppCredentialProvider({ credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem, fetchImplementation });
    const url = "https://github.com/ps06756/personal-website-test.git";

    await provider.resolve("github-agentx-sdlc", url);
    installationId = 222;
    await expect(provider.resolve("github-agentx-sdlc", url)).resolves.toEqual({ username: "x-access-token", password: "token" });
    expect(urls.slice(2)).toEqual([
      "https://api.github.com/app/installations/111/access_tokens",
      "https://api.github.com/repos/ps06756/personal-website-test/installation",
      "https://api.github.com/app/installations/222/access_tokens",
    ]);
  });

  it("never asks GitHub about another credential's repository or a non-canonical URL", async () => {
    const fetchImplementation = vi.fn();
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
      getPrivateKey: async () => "not reached",
      fetchImplementation,
    });

    await expect(provider.resolve("public-repositories", "https://github.com/another/public.git")).resolves.toEqual({});
    await expect(provider.checkRepository({ credentialRef: "public-repositories", url: "https://github.com/another/public.git" })).resolves.toBeUndefined();
    await expect(provider.resolve("github-agentx-sdlc", "https://github.com/another/private/tree/main")).rejects.toThrow(/canonical GitHub HTTPS URL/);
    await expect(provider.resolve("github-agentx-sdlc", "https://gitlab.com/another/private.git")).rejects.toThrow(/canonical GitHub HTTPS URL/);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("accepts raw or JSON-wrapped PEM secrets without reflecting invalid secret data", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----";
    expect(privateKeyFromSecret(pem)).toBe(pem);
    expect(privateKeyFromSecret(JSON.stringify({ privateKey: pem }))).toBe(pem);
    const webhookSecret = "hook-secret-fixture-value-32-characters";
    expect(webhookSecretFromSecret(JSON.stringify({ privateKey: pem, webhookSecret }))).toBe(webhookSecret);
    expect(() => webhookSecretFromSecret(pem)).toThrow(/webhook secret/i);
    expect(() => privateKeyFromSecret("sensitive-invalid-value")).toThrow(/not a PEM/i);
    expect(() => createGitHubAppJwt("5002502", "sensitive-invalid-value", Date.now())).toThrow(
      /could not sign/i,
    );
  });

  it("reads the App id from the secret agentx init stores, without reflecting invalid secret data", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----";
    expect(appIdFromSecret(JSON.stringify({ appId: "5002502", slug: "agentx-acme", account: "acme", privateKey: pem }))).toBe("5002502");
    for (const secret of [pem, JSON.stringify({ privateKey: pem }), JSON.stringify({ appId: "12a", privateKey: pem }), "sensitive-invalid-value"]) {
      expect(() => appIdFromSecret(secret)).toThrow("GitHub App secret holds no appId; set the control plane's GitHubAppId parameter");
    }
  });

  it("signs as an App id it reads only when first needed, as a control plane deployed before its App does", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ token: "installation-token" }), { status: 201 }));
    const appId = vi.fn(async () => "5002502");
    const provider = appProvider({ credentialRef: "github-agentx-sdlc", appId, getPrivateKey: async () => pem, fetchImplementation });
    expect(appId).not.toHaveBeenCalled();
    await expect(provider.resolve("github-agentx-sdlc", "https://github.com/acme/demo.git")).resolves.toEqual({ username: "x-access-token", password: "installation-token" });
    const authorization = new Headers((fetchImplementation.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get("authorization") ?? "";
    const payload = JSON.parse(Buffer.from(authorization.replace(/^Bearer /, "").split(".")[1] ?? "", "base64url").toString("utf8")) as { iss?: unknown };
    expect(payload.iss).toBe("5002502");

    const unreadable = appProvider({ credentialRef: "github-agentx-sdlc", appId: async () => "not-a-number", getPrivateKey: async () => pem, fetchImplementation: vi.fn() });
    await expect(unreadable.resolve("github-agentx-sdlc", "https://github.com/acme/demo.git")).rejects.toThrow("GitHub App ID must be numeric");
  });

  it("opens a draft only when asked", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const created: unknown[] = [];
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem,
      fetchImplementation: async (url, init) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "pr-token" }), { status: 201 });
        if (init?.method === "POST") {
          if (typeof init.body !== "string") throw new Error("expected JSON request body");
          created.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ number: 43, html_url: "https://github.com/ps06756/personal-website-test/pull/43" }), { status: 201 });
        }
        return new Response("[]", { status: 200 });
      },
    });
    const input = { repositoryUrl: "https://github.com/ps06756/personal-website-test.git", headBranch: "agentx/00000000-0000-4000-8000-000000000002", baseBranch: "main", title: "Draft change" };
    await provider.reconcilePullRequest({ ...input, draft: true });
    await provider.reconcilePullRequest(input);
    expect(created).toEqual([
      { title: "Draft change", head: input.headBranch, base: "main", draft: true },
      { title: "Draft change", head: input.headBranch, base: "main" },
    ]);
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


describe("current PR feedback API reads", () => {
  function fixture(options: { wrongScope?: boolean; changedHead?: boolean; nested?: boolean; exactReviewTime?: boolean } = {}) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const root = "https://github.com/ps06756/personal-website-test/pull/42";
    const api = "https://api.github.com/repos/ps06756/personal-website-test";
    let reads = 0;
    const requests: string[] = [];
    const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
    const comment = (id: number, anchor: string) => ({ id, body: `comment ${id}`, html_url: `${root}#${anchor}${id}`, user: { login: "reviewer" }, updated_at: "2026-10-05T12:00:00Z", submitted_at: "2026-10-05T12:00:00Z", path: "src/file.ts", line: 3, pull_request_url: `${api}/pulls/42`, issue_url: `${api}/issues/42` });
    const provider = appProvider({ credentialRef: "github-app", appId: "123", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      fetchImplementation: async (url, init) => {
        const requestUrl = String(url); requests.push(requestUrl);
        if (requestUrl.endsWith("access_tokens")) return new Response(JSON.stringify({ token: "fixture" }));
        if (requestUrl === `${api}/pulls/42`) return Response.json({ ...pullRequestFixture(), head: { ref: "branch", sha: options.changedHead && reads++ ? "b".repeat(40) : "a".repeat(40) } });
        if (requestUrl === "https://api.github.com/graphql") {
          const request = JSON.parse(String(init?.body));
          const variables = request.variables;
          if (request.query.includes("reviews(first")) return Response.json({ data: { repository: { nameWithOwner: "ps06756/personal-website-test", pullRequest: { number: 42, headRefOid: "a".repeat(40), reviews: page([{ fullDatabaseId: "1", body: "comment 1", updatedAt: "2026-10-05T13:00:00Z", url: `${root}#pullrequestreview-1` }]) } } } });
          const connection = page([{ fullDatabaseId: "2" }], !!options.nested && !variables.threadId, "comment-next");
          const thread = { id: "thread-1", isResolved: true, repository: { nameWithOwner: "ps06756/personal-website-test" }, pullRequest: { number: 42 }, comments: variables.threadId ? page([{ fullDatabaseId: "4" }]) : connection };
          return Response.json({ data: variables.threadId ? { node: thread } : { repository: { nameWithOwner: "ps06756/personal-website-test", pullRequest: { number: 42, headRefOid: "a".repeat(40), reviewThreads: page([thread]) } } } });
        }
        if (requestUrl.includes("/reviews?")) { const review = comment(1, "pullrequestreview-"); if (options.exactReviewTime) delete (review as any).updated_at; return Response.json([review]); }
        if (requestUrl.includes("/pulls/42/comments?")) return Response.json(options.nested ? [comment(2, "discussion_r"), comment(4, "discussion_r")] : [comment(2, "discussion_r")]);
        if (requestUrl.includes("/issues/42/comments?")) {
          if (requestUrl.includes("page=2")) return Response.json([{ ...comment(3, "issuecomment-"), ...(options.wrongScope ? { html_url: "https://github.com/other/repo/pull/42#issuecomment-3" } : {}) }]);
          return new Response("[]", { headers: { link: `<${api}/issues/42/comments?per_page=100&page=2>; rel="next"` } });
        }
        throw new Error(`unexpected request ${requestUrl}`);
      } });
    return { provider, requests };
  }
  it("collects paginated discussion, review bodies and inline comment IDs with current thread state", async () => {
    const { provider, requests } = fixture({ nested: true });
    expect(provider.getPullRequestFeedback).toBeTypeOf("function");
    const result = await provider.getPullRequestFeedback("https://github.com/ps06756/personal-website-test.git", 42);
    expect(result.pullRequest.headCommit).toBe("a".repeat(40));
    expect(result.comments.map(c => c.id)).toEqual(["review:1", "review_comment:2", "review_comment:4", "discussion:3"]);
    expect(result.comments[1]).toMatchObject({ threadId: "thread-1", body: "comment 2", path: "src/file.ts", line: 3 });
    expect(result.threads).toEqual([{ id: "thread-1", resolved: true, commentIds: ["review_comment:2", "review_comment:4"] }]);
    expect(requests).toContain("https://api.github.com/repos/ps06756/personal-website-test/issues/42/comments?per_page=100&page=2");
  });
  it("binds review bodies to their current edit time when REST exposes only submitted_at", async () => {
    const { provider } = fixture({ exactReviewTime: true });
    const result = await provider.getPullRequestFeedback("https://github.com/ps06756/personal-website-test.git", 42);
    expect(result.comments.find(c => c.id === "review:1")?.updatedAt).toBe("2026-10-05T13:00:00.000Z");
  });
  it("refuses comments returned outside the exact linked repository and PR", async () => {
    const { provider } = fixture({ wrongScope: true });
    expect(provider.getPullRequestFeedback).toBeTypeOf("function");
    await expect(provider.getPullRequestFeedback("https://github.com/ps06756/personal-website-test.git", 42)).rejects.toThrow(/scope|canonical/);
  });
  it("refuses a head change during paginated feedback collection", async () => {
    const { provider } = fixture({ changedHead: true });
    expect(provider.getPullRequestFeedback).toBeTypeOf("function");
    await expect(provider.getPullRequestFeedback("https://github.com/ps06756/personal-website-test.git", 42)).rejects.toThrow(/changed/);
  });
});
