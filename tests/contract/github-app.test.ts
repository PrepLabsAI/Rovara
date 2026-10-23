import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DRAFT_REFUSED_PULL_REQUEST_NOTE,
  GitHubAppCredentialProvider,
  GithubMergeRateLimitError,
  appIdFromSecret,
  createGitHubAppJwt,
  pullRequestBodyWithDraftNote,
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
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
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
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
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

  it("reads a commit's parents with a contents-read token, and refuses an answer it cannot read", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
      getPrivateKey: async () => pem,
      fetchImplementation: async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "lookup-token" }), { status: 201 });
        if (requestUrl.endsWith(`/git/commits/${"e".repeat(40)}`)) return new Response(JSON.stringify({ tree: { sha: "d".repeat(40) }, parents: [{ sha: "a".repeat(40) }] }), { status: 200 });
        if (requestUrl.endsWith(`/git/commits/${"b".repeat(40)}`)) return new Response(JSON.stringify({ tree: { sha: "d".repeat(40) }, parents: [{ sha: "../x" }] }), { status: 200 });
        return new Response("not found", { status: 404 });
      },
    });
    await expect(provider.getCommitParents("https://github.com/ps06756/personal-website-test.git", "e".repeat(40))).resolves.toEqual(["a".repeat(40)]);
    await expect(provider.getCommitParents("https://github.com/ps06756/personal-website-test.git", "b".repeat(40))).rejects.toThrow(/parent/);
    await expect(provider.getCommitParents("https://github.com/ps06756/personal-website-test.git", "f".repeat(40))).rejects.toThrow(/HTTP 404/);
  });

  it("confirms a task's starting commit with a contents-read token and refuses one GitHub does not have", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
      getPrivateKey: async () => pem,
      fetchImplementation: async (url, init) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        requests.push({ url: requestUrl, init });
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "lookup-token" }), { status: 201 });
        if (requestUrl.endsWith(`/git/commits/${"e".repeat(40)}`)) return new Response(JSON.stringify({ tree: { sha: "d".repeat(40) } }), { status: 200 });
        return new Response("not found", { status: 404 });
      },
    });
    await expect(provider.getCommitTree("https://github.com/ps06756/personal-website-test.git", "e".repeat(40))).resolves.toBe("d".repeat(40));
    const tokenBody = requests[0]?.init?.body;
    if (typeof tokenBody !== "string") throw new Error("expected token body");
    expect((JSON.parse(tokenBody) as { permissions: unknown }).permissions).toEqual({ contents: "read" });
    expect(requests[1]?.url).toBe(`https://api.github.com/repos/ps06756/personal-website-test/git/commits/${"e".repeat(40)}`);
    await expect(provider.getCommitTree("https://github.com/ps06756/personal-website-test.git", "f".repeat(40))).rejects.toThrow(/HTTP 404/);
    await expect(provider.getCommitTree("https://github.com/ps06756/personal-website-test.git", "../x")).rejects.toThrow(/invalid/);
  });

  it("reads a file at a commit with a contents-read token and the raw media type", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sha = "e".repeat(40);
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem,
      fetchImplementation: async (url, init) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        requests.push({ url: requestUrl, init });
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "lookup-token" }), { status: 201 });
        if (requestUrl.includes("/contents/src/a%20b.ts?")) return new Response("line one\nline two\n", { status: 200 });
        if (requestUrl.includes("/contents/big.txt?")) return new Response("x", { status: 200, headers: { "content-length": "20971521" } });
        if (requestUrl.includes("/contents/broken.txt?")) return new Response("oops", { status: 500 });
        return new Response("not found", { status: 404 });
      },
    });
    const url = "https://github.com/ps06756/personal-website-test.git";
    await expect(provider.getFileAtCommit(url, "src/a b.ts", sha)).resolves.toBe("line one\nline two\n");
    const tokenBody = requests[0]?.init?.body;
    if (typeof tokenBody !== "string") throw new Error("expected token body");
    expect((JSON.parse(tokenBody) as { permissions: unknown }).permissions).toEqual({ contents: "read" });
    expect(requests[1]?.url).toBe(`https://api.github.com/repos/ps06756/personal-website-test/contents/src/a%20b.ts?ref=${sha}`);
    const headers = requests[1]?.init?.headers as Record<string, string>;
    expect(headers.accept).toBe("application/vnd.github.raw+json");
    expect(headers.authorization).toBe("Bearer lookup-token");
    expect(requests[1]?.init?.redirect).toBe("error");
    await expect(provider.getFileAtCommit(url, "missing.ts", sha)).resolves.toBeUndefined();
    await expect(provider.getFileAtCommit(url, "broken.txt", sha)).rejects.toThrow(/HTTP 500/);
    await expect(provider.getFileAtCommit(url, "big.txt", sha)).rejects.toThrow(/file too large/);
  });

  it("reads a directory as not found: GitHub answers a directory with a JSON listing, which is never shown as code", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sha = "e".repeat(40);
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem,
      fetchImplementation: async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "lookup-token" }), { status: 201 });
        if (requestUrl.includes("/contents/src?")) return new Response(JSON.stringify([{ name: "a.ts", type: "file" }]), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
        // A file read with the raw media type keeps its text, even when that text is JSON.
        return new Response("{\"name\":\"demo\"}\n", { status: 200, headers: { "content-type": "application/vnd.github.raw+json; charset=utf-8" } });
      },
    });
    const url = "https://github.com/ps06756/personal-website-test.git";
    await expect(provider.getFileAtCommit(url, "src", sha)).resolves.toBeUndefined();
    await expect(provider.getFileAtCommit(url, "package.json", sha)).resolves.toBe("{\"name\":\"demo\"}\n");
  });

  it("reads a cited file only up to the last line it needs and cancels the stream just past it", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sha = "e".repeat(40);
    const state = { bytes: 0, cancelled: false };
    const lineText = (number: number) => `line ${number} ${"x".repeat(90 - String(number).length)}\n`;
    // A 3 MB file of numbered lines, handed out 64 KB at a time.
    const stream = (): ReadableStream<Uint8Array> => {
      const whole = new TextEncoder().encode(Array.from({ length: 30_000 }, (_, index) => lineText(index + 1)).join(""));
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = whole.slice(sent, sent + 65_536);
          if (chunk.byteLength === 0) { controller.close(); return; }
          sent += chunk.byteLength;
          state.bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() { state.cancelled = true; },
      }, { highWaterMark: 0 });
    };
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem,
      fetchImplementation: async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "lookup-token" }), { status: 201 });
        if (requestUrl.includes("/contents/short.txt?")) return new Response("one\ntwo\nthree", { status: 200 });
        return new Response(stream(), { status: 200 });
      },
    });
    const url = "https://github.com/ps06756/personal-website-test.git";
    const text = await provider.getFileAtCommit(url, "large.txt", sha, { untilLine: 60 });
    expect(text).toBe(Array.from({ length: 60 }, (_, index) => lineText(index + 1)).join(""));
    expect(state.cancelled).toBe(true);
    expect(state.bytes).toBeLessThan(3_000_000);
    expect(state.bytes).toBeLessThanOrEqual(131_072);
    // A file that ends before the wanted line comes back whole.
    await expect(provider.getFileAtCommit(url, "short.txt", sha, { untilLine: 60 })).resolves.toBe("one\ntwo\nthree");
    // A line that ends exactly on a chunk boundary or without a newline at the very end is still returned.
    await expect(provider.getFileAtCommit(url, "short.txt", sha, { untilLine: 3 })).resolves.toBe("one\ntwo\nthree");
    await expect(provider.getFileAtCommit(url, "short.txt", sha, { untilLine: 2 })).resolves.toBe("one\ntwo\n");
  });

  it("keeps the text it read when closing the stream fails after the wanted line", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem,
      fetchImplementation: async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "lookup-token" }), { status: 201 });
        const body = new ReadableStream<Uint8Array>({
          pull(controller) { controller.enqueue(new TextEncoder().encode("one\ntwo\nthree\nfour\n")); },
          cancel() { throw new Error("the stream would not close"); },
        }, { highWaterMark: 0 });
        return new Response(body, { status: 200 });
      },
    });
    await expect(provider.getFileAtCommit("https://github.com/ps06756/personal-website-test.git", "a.txt", "e".repeat(40), { untilLine: 2 })).resolves.toBe("one\ntwo\n");
  });

  it("gives a file read 8 seconds unless the caller allows longer", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem,
      fetchImplementation: async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "lookup-token" }), { status: 201 });
        return new Response("one\n", { status: 200 });
      },
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const url = "https://github.com/ps06756/personal-website-test.git";
      await provider.getFileAtCommit(url, "a.txt", "e".repeat(40));
      await provider.getFileAtCommit(url, "a.txt", "e".repeat(40), { untilLine: 1, timeoutMs: 27_000 });
      // The installation and token lookups use their own 5 s limit; the file reads are the last two requests.
      expect(timeout.mock.calls.map(([ms]) => ms).slice(-2)).toEqual([8_000, 27_000]);
    } finally {
      timeout.mockRestore();
    }
  });

  it("holds a file to 20 MB by its declared size without a last line and by the bytes that arrive, without reading past the cap", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sha = "e".repeat(40);
    const cap = 20_971_520;
    const state = { pulls: 0, cancelled: false };
    const stream = (bytes: number): ReadableStream<Uint8Array> => {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulls += 1;
          const size = Math.min(65_536, bytes - sent);
          if (size === 0) { controller.close(); return; }
          sent += size;
          controller.enqueue(new Uint8Array(size).fill(97));
        },
        cancel() { state.cancelled = true; },
      }, { highWaterMark: 0 });
    };
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem,
      fetchImplementation: async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "lookup-token" }), { status: 201 });
        if (requestUrl.includes("/contents/declared.txt?")) return new Response(stream(10), { status: 200, headers: { "content-length": String(cap + 1) } });
        if (requestUrl.includes("/contents/exact.txt?")) return new Response(stream(cap), { status: 200 });
        if (requestUrl.includes("/contents/over.txt?")) return new Response(stream(cap * 2), { status: 200 });
        return new Response("not found", { status: 404 });
      },
    });
    const url = "https://github.com/ps06756/personal-website-test.git";
    await expect(provider.getFileAtCommit(url, "declared.txt", sha)).rejects.toThrow(/file too large/);
    expect(state).toEqual({ pulls: 0, cancelled: true });
    const exact = await provider.getFileAtCommit(url, "exact.txt", sha);
    expect(exact?.length).toBe(cap);
    state.pulls = 0;
    state.cancelled = false;
    await expect(provider.getFileAtCommit(url, "over.txt", sha)).rejects.toThrow(/file too large/);
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(322);
    // Twenty megabytes with no line break reached before the wanted line is too large to read up to that line.
    state.pulls = 0;
    state.cancelled = false;
    await expect(provider.getFileAtCommit(url, "over.txt", sha, { untilLine: 5 })).rejects.toThrow(/file too large to read up to the cited line/);
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(322);
    // A declared size over 20 MB does not refuse a read that stops at a line.
    await expect(provider.getFileAtCommit(url, "declared.txt", sha, { untilLine: 5 })).resolves.toBe("a".repeat(10));
  });

  it("refuses a body one byte over 20 MB and keeps encoded separators and punctuation inside one path segment", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sha = "e".repeat(40);
    const urls: string[] = [];
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem,
      fetchImplementation: async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "lookup-token" }), { status: 201 });
        urls.push(requestUrl);
        return new Response(requestUrl.includes("/contents/one-over.txt?") ? new Uint8Array(20_971_521) : "ok", { status: 200 });
      },
    });
    const url = "https://github.com/ps06756/personal-website-test.git";
    await expect(provider.getFileAtCommit(url, "one-over.txt", sha)).rejects.toThrow(/file too large/);
    await provider.getFileAtCommit(url, "a%2Fb/c?d#e.ts", sha);
    await provider.getFileAtCommit(url, `${"a/".repeat(255)}bc`, sha);
    expect(urls[1]).toBe(`https://api.github.com/repos/ps06756/personal-website-test/contents/a%252Fb/c%3Fd%23e.ts?ref=${sha}`);
    expect(urls).toHaveLength(3);
    await expect(provider.getFileAtCommit(url, `${"a/".repeat(255)}bcd`, sha)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("mints one contents-read token for a run of file reads in a repository and a new one after five minutes", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sha = "e".repeat(40);
    let minted = 0;
    let clock = 1_000_000;
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem, now: () => clock,
      fetchImplementation: async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) { minted += 1; return new Response(JSON.stringify({ token: `token-${minted}` }), { status: 201 }); }
        return new Response("ok", { status: 200 });
      },
    });
    const url = "https://github.com/ps06756/personal-website-test.git";
    await Promise.all([provider.getFileAtCommit(url, "a.ts", sha), provider.getFileAtCommit(url, "b.ts", sha)]);
    await provider.getFileAtCommit(url, "c.ts", sha);
    await provider.getFileAtCommit("https://github.com/PS06756/Personal-Website-Test.git", "d.ts", sha);
    expect(minted).toBe(1);
    clock += 5 * 60_000 + 1;
    await provider.getFileAtCommit(url, "e.ts", sha);
    expect(minted).toBe(2);
  });

  it("refuses an unsafe file path or commit before any request", async () => {
    const fetchImplementation = vi.fn(async () => new Response("never", { status: 200 }));
    const provider = appProvider({ credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => "unused", fetchImplementation });
    const url = "https://github.com/ps06756/personal-website-test.git";
    const sha = "e".repeat(40);
    for (const path of ["/etc/passwd", "../x", "a/../x", "a/./x", "a//x", "", "a\\b", "a/", `${"a/".repeat(256)}b`]) {
      await expect(provider.getFileAtCommit(url, path, sha), path).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    for (const commit of ["main", "E".repeat(40), "e".repeat(39), "../x"]) {
      await expect(provider.getFileAtCommit(url, "a.ts", commit), commit).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("reads a publication branch's head commit with a contents-read token and refuses other branch names", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const branch = "agentx/00000000-0000-4000-8000-000000000001";
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const provider = appProvider({
      credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem,
      fetchImplementation: async (url, init) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        requests.push({ url: requestUrl, init });
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "lookup-token" }), { status: 201 });
        if (requestUrl.endsWith(`/git/ref/heads/${branch}`)) return new Response(JSON.stringify({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: "e".repeat(40) } }), { status: 200 });
        return new Response("not found", { status: 404 });
      },
    });
    await expect(provider.getBranchHead("https://github.com/ps06756/personal-website-test.git", branch)).resolves.toBe("e".repeat(40));
    const tokenBody = requests[0]?.init?.body;
    if (typeof tokenBody !== "string") throw new Error("expected token body");
    expect((JSON.parse(tokenBody) as { permissions: unknown }).permissions).toEqual({ contents: "read" });
    expect(requests[1]?.url).toBe(`https://api.github.com/repos/ps06756/personal-website-test/git/ref/heads/${branch}`);
    await expect(provider.getBranchHead("https://github.com/ps06756/personal-website-test.git", "agentx/00000000-0000-4000-8000-000000000002")).rejects.toThrow(/HTTP 404/);
    await expect(provider.getBranchHead("https://github.com/ps06756/personal-website-test.git", "main")).rejects.toThrow(/invalid/);
  });

  it("looks up canonical pull request state with read-only permissions", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
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

  it("refuses a pull request whose head branch lives in another repository (a fork)", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const answer = (head: Record<string, unknown>) => appProvider({
      credentialRef: "github-agentx-sdlc",
      appId: "5002502",
      getPrivateKey: async () => pem,
      fetchImplementation: async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "lookup-token" }), { status: 201 });
        const fixture = pullRequestFixture();
        return new Response(JSON.stringify({ ...fixture, head: { ...(fixture.head as Record<string, unknown>), ...head } }), { status: 200 });
      },
    }).getPullRequest("https://github.com/ps06756/personal-website-test.git", 42);
    await expect(answer({ repo: { full_name: "someone-else/personal-website-test" } })).rejects.toThrow(/another repository/);
    // A fork that was deleted leaves no head repository at all.
    await expect(answer({ repo: null })).rejects.toThrow(/another repository/);
    // The same repository in other letter case is the same repository.
    await expect(answer({ repo: { full_name: "PS06756/Personal-Website-Test" } })).resolves.toMatchObject({ number: 42 });
  });

  it("updates metadata and state with pull-request write permission", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
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

  // Evaluation fix INTG1: GitHub answers 422 to a draft pull request on a private repository whose plan has no drafts (GitHub Free). That one answer, and only that, is retried once
  // as a normal pull request; every other 422 fails with a readable reason that is one of AgentX's own sentences, never GitHub's text.
  describe("a draft pull request that GitHub refuses (INTG1)", () => {
    const DRAFT_REFUSAL = { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "Draft pull requests are not supported in this repository." }],
      documentation_url: "https://docs.github.com/rest/pulls/pulls#create-a-pull-request" };
    const input = { repositoryUrl: "https://github.com/ps06756/personal-website-test.git", headBranch: "agentx/00000000-0000-4000-8000-000000000003", baseBranch: "main", title: "Draft change", body: "The change." };

    /** A provider whose create calls are answered, in order, by `answers` (a response, or a function of the request body); the requests and the lookups are kept. */
    function creating(answers: Array<Response | ((body: Record<string, unknown>) => Response)>) {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const created: Array<Record<string, unknown>> = [];
      let lookups = 0;
      const provider = appProvider({
        credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem,
        fetchImplementation: async (url, init) => {
          const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
          if (requestUrl.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "pr-token" }), { status: 201 });
          if (init?.method === "POST") {
            if (typeof init.body !== "string") throw new Error("expected JSON request body");
            const body = JSON.parse(init.body) as Record<string, unknown>;
            created.push(body);
            const answer = answers[created.length - 1];
            if (answer === undefined) throw new Error("an unexpected extra create request");
            return typeof answer === "function" ? answer(body) : answer;
          }
          lookups += 1;
          return new Response("[]", { status: 200 });
        },
      });
      return { provider, created, lookups: () => lookups };
    }
    const opened = () => new Response(JSON.stringify({ number: 43, html_url: "https://github.com/ps06756/personal-website-test/pull/43" }), { status: 201 });
    const refused = (body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 422 });

    it("opens a normal pull request once, with the do-not-merge note, and says that it did", async () => {
      const { provider, created } = creating([refused(DRAFT_REFUSAL), opened()]);
      const result = await provider.reconcilePullRequest({ ...input, draft: true });
      expect(result).toEqual({ number: 43, url: "https://github.com/ps06756/personal-website-test/pull/43", reconciled: false, draftRefused: true });
      expect(created).toEqual([
        { title: "Draft change", head: input.headBranch, base: "main", body: "The change.", draft: true },
        { title: "Draft change", head: input.headBranch, base: "main", body: `${DRAFT_REFUSED_PULL_REQUEST_NOTE}\n\nThe change.` },
      ]);
      expect(created[1]).not.toHaveProperty("draft");
    });

    it("keeps the whole body inside GitHub's limit when the note is added", () => {
      const longBody = "x".repeat(65_536);
      const withNote = pullRequestBodyWithDraftNote(longBody);
      expect(withNote.length).toBeLessThanOrEqual(65_536);
      expect(withNote.startsWith(DRAFT_REFUSED_PULL_REQUEST_NOTE)).toBe(true);
      expect(pullRequestBodyWithDraftNote(undefined)).toBe(DRAFT_REFUSED_PULL_REQUEST_NOTE);
    });

    it("retries only once: a second refusal fails, and a draft that opened was never retried", async () => {
      const twice = creating([refused(DRAFT_REFUSAL), refused(DRAFT_REFUSAL)]);
      await expect(twice.provider.reconcilePullRequest({ ...input, draft: true })).rejects.toThrow(/HTTP 422/);
      expect(twice.created).toHaveLength(2);
      const fine = creating([opened()]);
      await expect(fine.provider.reconcilePullRequest({ ...input, draft: true })).resolves.toEqual({ number: 43, url: "https://github.com/ps06756/personal-website-test/pull/43", reconciled: false });
      expect(fine.created).toHaveLength(1);
    });

    it("never retries a pull request that was not asked to be a draft", async () => {
      const { provider, created } = creating([refused(DRAFT_REFUSAL)]);
      await expect(provider.reconcilePullRequest(input)).rejects.toThrow(/HTTP 422: this repository does not allow draft pull requests/);
      expect(created).toHaveLength(1);
    });

    it.each([
      ["no commits between the branches", { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and agentx/x" }] }, /HTTP 422: the head branch has no commits that the base branch lacks/],
      ["a head branch GitHub cannot find", { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }] }, /HTTP 422: GitHub cannot find the head branch/],
      ["a base branch GitHub cannot find", { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "base", code: "invalid" }] }, /HTTP 422: GitHub cannot find the base branch/],
      ["a reason AgentX does not know", { message: "sensitive-github-error", errors: [{ message: "sensitive-github-error" }] }, /HTTP 422: GitHub rejected the pull request and gave a reason AgentX does not recognise/],
      ["an answer that is not JSON", "sensitive-github-error", /HTTP 422: GitHub rejected the pull request and gave a reason AgentX does not recognise/],
    ])("keeps failing, with a readable reason and no retry, for %s", async (_name, body, reason) => {
      const { provider, created } = creating([refused(body)]);
      const failure = await provider.reconcilePullRequest({ ...input, draft: true }).then(() => undefined, (error: unknown) => error as Error);
      expect(failure?.message).toMatch(reason);
      expect(failure?.message).not.toContain("sensitive-github-error");
      expect(created).toHaveLength(1);
    });

    it("tells the reason of the retry's own refusal, and does not read a 403 or a 500 as a draft refusal", async () => {
      const retried = creating([refused(DRAFT_REFUSAL), refused({ message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and x" }] })]);
      await expect(retried.provider.reconcilePullRequest({ ...input, draft: true })).rejects.toThrow(/HTTP 422: the head branch has no commits/);
      for (const status of [403, 500]) {
        const other = creating([new Response(JSON.stringify(DRAFT_REFUSAL), { status })]);
        await expect(other.provider.reconcilePullRequest({ ...input, draft: true })).rejects.toThrow(new RegExp(`GitHub pull request creation failed with HTTP ${status}$`));
        expect(other.created).toHaveLength(1);
      }
    });
  });
});

function pullRequestFixture(): Record<string, unknown> {
  return {
    number: 42,
    html_url: "https://github.com/ps06756/personal-website-test/pull/42",
    state: "open",
    merged: false,
    merge_commit_sha: null,
    head: { ref: "agentx/00000000-0000-4000-8000-000000000001", sha: "a".repeat(40), repo: { full_name: "ps06756/personal-website-test" } },
    base: { ref: "main", repo: { full_name: "ps06756/personal-website-test" } },
    title: "Current title",
    body: "Current body",
  };
}

describe("bounded pull request merge observation", () => {
  const NOW = Date.parse("2026-10-11T12:00:00.000Z");
  type RequestKind = "installation" | "token" | "pull" | "tree";
  function fixture(options: {
    response?: (kind: RequestKind, ordinal: number) => Response | undefined;
    mutatePull?: (value: Record<string, unknown>, pullRead: number) => Record<string, unknown>;
    tree?: unknown;
    beforeRequest?: () => void;
  } = {}) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const requests: string[] = [];
    let pullReads = 0;
    let attempts = 0;
    const fetchImplementation = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      requests.push(requestUrl);
      const kind: RequestKind = requestUrl.endsWith("/installation") ? "installation"
        : requestUrl.endsWith("/access_tokens") ? "token"
          : requestUrl.includes("/git/commits/") ? "tree" : "pull";
      const override = options.response?.(kind, requests.length);
      if (override) return override;
      if (kind === "installation") return Response.json({ id: 163046162, account: { login: "ps06756" } });
      if (kind === "token") return Response.json({ token: "merge-read-token" });
      if (kind === "tree") return Response.json(options.tree ?? { sha: "a".repeat(40), tree: { sha: "b".repeat(40) } });
      pullReads += 1;
      const value = options.mutatePull?.(pullRequestFixture(), pullReads) ?? pullRequestFixture();
      return Response.json(value);
    });
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github-agentx-sdlc", appId: "5002502",
      getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      fetchImplementation, now: () => NOW,
    });
    const controller = new AbortController();
    const budget = {
      signal: controller.signal,
      beforeRequest: options.beforeRequest ?? (() => { attempts += 1; }),
    };
    return { provider, requests, fetchImplementation, controller, budget, attempts: () => attempts };
  }

  it("reads PR, exact head tree, and PR again using five bounded read-only HTTP attempts", async () => {
    const f = fixture();
    await expect(f.provider.getPullRequestMergeObservation(
      "https://github.com/ps06756/personal-website-test.git", 42, f.budget,
    )).resolves.toEqual({
      number: 42,
      url: "https://github.com/ps06756/personal-website-test/pull/42",
      state: "open",
      headBranch: "agentx/00000000-0000-4000-8000-000000000001",
      baseBranch: "main",
      headCommit: "a".repeat(40),
      headTreeSha: "b".repeat(40),
      title: "Current title",
      body: "Current body",
    });
    expect(f.attempts()).toBe(5);
    const tokenInit = (f.fetchImplementation.mock.calls[1] as unknown as [string, RequestInit])[1];
    if (typeof tokenInit.body !== "string") throw new Error("expected token request body");
    expect(JSON.parse(tokenInit.body)).toEqual({ repositories: ["personal-website-test"], permissions: { contents: "read", pull_requests: "read" } });
    expect(f.requests).toEqual([
      "https://api.github.com/repos/ps06756/personal-website-test/installation",
      "https://api.github.com/app/installations/163046162/access_tokens",
      "https://api.github.com/repos/ps06756/personal-website-test/pulls/42",
      `https://api.github.com/repos/ps06756/personal-website-test/git/commits/${"a".repeat(40)}`,
      "https://api.github.com/repos/ps06756/personal-website-test/pulls/42",
    ]);
    expect(f.requests.join("\n")).not.toMatch(/comments|reviews|graphql|compare|commits\/[^/]+\/parents/i);
  });

  it.each([
    ["head", (value: Record<string, unknown>) => ({ ...value, head: { ...(value.head as Record<string, unknown>), sha: "c".repeat(40) } })],
    ["state", (value: Record<string, unknown>) => ({ ...value, state: "closed" })],
    ["merge commit", (value: Record<string, unknown>) => ({ ...value, state: "closed", merged: true, merge_commit_sha: "c".repeat(40) })],
  ] as const)("refuses a %s change between the two PR reads", async (_label, second) => {
    const f = fixture({ mutatePull: (value, read) => read === 2 ? second(value) : value });
    await expect(f.provider.getPullRequestMergeObservation("https://github.com/ps06756/personal-website-test", 42, f.budget))
      .rejects.toThrow(/changed/);
  });

  it.each([
    ["64-character head", { mutatePull: (value: Record<string, unknown>) => ({ ...value, head: { ...(value.head as Record<string, unknown>), sha: "a".repeat(64) } }) }],
    ["uppercase head", { mutatePull: (value: Record<string, unknown>) => ({ ...value, head: { ...(value.head as Record<string, unknown>), sha: "A".repeat(40) } }) }],
    ["missing tree", { tree: { sha: "a".repeat(40), tree: {} } }],
    ["uppercase tree", { tree: { sha: "a".repeat(40), tree: { sha: "B".repeat(40) } } }],
  ] as const)("refuses a %s identity", async (_label, shape) => {
    const f = fixture({
      ...("tree" in shape ? { tree: shape.tree } : {}),
      ...("mutatePull" in shape ? { mutatePull: (value) => shape.mutatePull(value) } : {}),
    });
    await expect(f.provider.getPullRequestMergeObservation("https://github.com/ps06756/personal-website-test", 42, f.budget))
      .rejects.toThrow(/invalid/);
  });

  it.each([
    ["number", (value: Record<string, unknown>) => ({ ...value, number: 43, html_url: "https://github.com/ps06756/personal-website-test/pull/43" })],
    ["URL", (value: Record<string, unknown>) => ({ ...value, html_url: "https://github.com/ps06756/other/pull/42" })],
    ["head repository", (value: Record<string, unknown>) => ({ ...value, head: { ...(value.head as Record<string, unknown>), repo: { full_name: "other/personal-website-test" } } })],
  ] as const)("refuses the wrong PR %s", async (_label, mutatePull) => {
    const f = fixture({ mutatePull: (value) => mutatePull(value) });
    await expect(f.provider.getPullRequestMergeObservation("https://github.com/ps06756/personal-website-test", 42, f.budget))
      .rejects.toThrow();
  });

  it("refuses the wrong installation owner", async () => {
    const f = fixture({ response: (kind) => kind === "installation" ? Response.json({ id: 1, account: { login: "other" } }) : undefined });
    await expect(f.provider.getPullRequestMergeObservation("https://github.com/ps06756/personal-website-test", 42, f.budget))
      .rejects.toThrow(/installation/);
  });

  it("keeps an inaccessible installation retryable", async () => {
    const f = fixture({ response: (kind) => kind === "installation" ? new Response("not found", { status: 404 }) : undefined });
    await expect(f.provider.getPullRequestMergeObservation("https://github.com/ps06756/personal-website-test", 42, f.budget))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it.each([404, 500])("keeps HTTP %i unavailable rather than treating it as merge proof", async (status) => {
    const f = fixture({ response: (kind) => kind === "pull" ? new Response("sensitive body", { status }) : undefined });
    await expect(f.provider.getPullRequestMergeObservation("https://github.com/ps06756/personal-website-test", 42, f.budget))
      .rejects.not.toThrow(/sensitive body/);
  });

  it.each([
    ["retry-after", 429, { "retry-after": "120" }, NOW + 120_000],
    ["reset", 429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 180_000) / 1_000) }, NOW + 180_000],
    ["fallback", 429, { "retry-after": "bad", "x-ratelimit-reset": "bad" }, NOW + 300_000],
    ["403 retry-after", 403, { "retry-after": "60" }, NOW + 60_000],
    ["403 exhausted", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 240_000) / 1_000) }, NOW + 240_000],
    ["later reset", 429, { "retry-after": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 240_000) / 1_000) }, NOW + 240_000],
  ] as const)("classifies %s without reflecting response content", async (_label, status, headers, retryAt) => {
    const f = fixture({ response: (kind) => kind === "pull" ? new Response("secret response", { status, headers }) : undefined });
    const error = await f.provider.getPullRequestMergeObservation("https://github.com/ps06756/personal-website-test", 42, f.budget).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GithubMergeRateLimitError);
    expect(error).toMatchObject({ name: "GithubMergeRateLimitError", retryAt });
    expect(String(error)).not.toContain("secret response");
  });

  it("keeps an ordinary 403 distinct from rate exhaustion", async () => {
    const f = fixture({ response: (kind) => kind === "pull" ? new Response("secret response", { status: 403 }) : undefined });
    const error = await f.provider.getPullRequestMergeObservation("https://github.com/ps06756/personal-website-test", 42, f.budget).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(GithubMergeRateLimitError);
    expect(String(error)).not.toContain("secret response");
  });

  it("starts no request after cancellation or after beforeRequest refuses admission", async () => {
    const aborted = fixture();
    aborted.controller.abort(new Error("budget expired"));
    await expect(aborted.provider.getPullRequestMergeObservation("https://github.com/ps06756/personal-website-test", 42, aborted.budget)).rejects.toThrow();
    expect(aborted.fetchImplementation).not.toHaveBeenCalled();

    let admitted = 0;
    const exhausted = fixture({ beforeRequest: () => { admitted += 1; if (admitted > 2) throw new Error("request budget exhausted"); } });
    await expect(exhausted.provider.getPullRequestMergeObservation("https://github.com/ps06756/personal-website-test", 42, exhausted.budget))
      .rejects.toThrow(/budget exhausted/);
    expect(exhausted.fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("does not share the bounded reader's installation cache with ordinary provider calls", async () => {
    const f = fixture();
    const url = "https://github.com/ps06756/personal-website-test";
    await f.provider.getPullRequest(url, 42);
    await f.provider.getPullRequestMergeObservation(url, 42, f.budget);
    await f.provider.getPullRequest(url, 42);
    expect(f.requests.filter(request => request.endsWith("/installation"))).toHaveLength(2);
    expect(f.requests.filter(request => request.endsWith("/access_tokens"))).toHaveLength(3);
  });
});


describe("current PR feedback API reads", () => {
  function fixture(options: { wrongScope?: boolean; changedHead?: boolean; nested?: boolean; exactReviewTime?: boolean; numericIds?: boolean; emptyReview?: boolean } = {}) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const root = "https://github.com/ps06756/personal-website-test/pull/42";
    const api = "https://api.github.com/repos/ps06756/personal-website-test";
    let reads = 0;
    const requests: string[] = [];
    const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
    const comment = (id: number, anchor: string) => ({ id, body: `comment ${id}`, html_url: `${root}#${anchor}${id}`, user: { login: "reviewer" }, updated_at: "2026-10-05T12:00:00Z", submitted_at: "2026-10-05T12:00:00Z", path: "src/file.ts", line: 3, pull_request_url: `${api}/pulls/42`, issue_url: `${api}/issues/42` });
    // GitHub serializes GraphQL fullDatabaseId (a BigInt) as a string. Numbers stay supported.
    const gid = (id: number): string | number => options.numericIds ? id : String(id);
    const provider = appProvider({ credentialRef: "github-app", appId: "123", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      fetchImplementation: async (url, init) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url; requests.push(requestUrl);
        if (requestUrl.endsWith("access_tokens")) return new Response(JSON.stringify({ token: "fixture" }));
        if (requestUrl === `${api}/pulls/42`) return Response.json({ ...pullRequestFixture(), head: { ref: "branch", sha: options.changedHead && reads++ ? "b".repeat(40) : "a".repeat(40), repo: { full_name: "ps06756/personal-website-test" } } });
        if (requestUrl.includes("/git/commits/")) return Response.json({ tree: { sha: "b".repeat(40) } });
        if (requestUrl === "https://api.github.com/graphql") {
          const requestBody = typeof init?.body === "string" ? init.body : "";
          const request = JSON.parse(requestBody) as { variables: Record<string, unknown>; query: string };
          const variables = request.variables;
          if (request.query.includes("reviews(first")) return Response.json({ data: { repository: { nameWithOwner: "ps06756/personal-website-test", pullRequest: { number: 42, headRefOid: "a".repeat(40), reviews: page(options.emptyReview
            ? [{ fullDatabaseId: "5480349109", body: "", updatedAt: "2026-10-05T13:00:00Z", url: `${root}#pullrequestreview-5480349109` }]
            : [{ fullDatabaseId: gid(1), body: "comment 1", updatedAt: "2026-10-05T13:00:00Z", url: `${root}#pullrequestreview-1` }]) } } } });
          const threadId = typeof variables.threadId === "string" ? variables.threadId : undefined;
          const connection = page([{ fullDatabaseId: gid(2) }], !!options.nested && !threadId, "comment-next");
          const thread = { id: "thread-1", isResolved: !options.emptyReview, repository: { nameWithOwner: "ps06756/personal-website-test" }, pullRequest: { number: 42 }, comments: threadId ? page([{ fullDatabaseId: gid(4) }]) : connection };
          return Response.json({ data: threadId ? { node: thread } : { repository: { nameWithOwner: "ps06756/personal-website-test", pullRequest: { number: 42, headRefOid: "a".repeat(40), reviewThreads: page([thread]) } } } });
        }
        if (requestUrl.includes("/reviews?")) {
          const review = options.emptyReview ? { ...comment(5480349109, "pullrequestreview-"), body: "", state: "COMMENTED" } : comment(1, "pullrequestreview-");
          if (options.exactReviewTime) { const { updated_at: _updatedAt, ...withoutUpdatedAt } = review; void _updatedAt; return Response.json([withoutUpdatedAt]); }
          return Response.json([review]);
        }
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
    expect(typeof provider.getPullRequestFeedback).toBe("function");
    const result = await provider.getPullRequestFeedback("https://github.com/ps06756/personal-website-test.git", 42);
    expect(result.pullRequest.headCommit).toBe("a".repeat(40));
    expect(result.pullRequest.headTreeSha).toBe("b".repeat(40));
    expect(result.comments.map(c => c.id)).toEqual(["review:1", "review_comment:2", "review_comment:4", "discussion:3"]);
    expect(result.comments[1]).toMatchObject({ threadId: "thread-1", body: "comment 2", path: "src/file.ts", line: 3 });
    expect(result.threads).toEqual([{ id: "thread-1", resolved: true, commentIds: ["review_comment:2", "review_comment:4"] }]);
    expect(requests).toContain("https://api.github.com/repos/ps06756/personal-website-test/issues/42/comments?per_page=100&page=2");
  });
  it("reads GraphQL string review IDs and skips an empty-body review while keeping the inline comment", async () => {
    const { provider } = fixture({ emptyReview: true });
    const result = await provider.getPullRequestFeedback("https://github.com/ps06756/personal-website-test.git", 42);
    expect(result.comments.map(c => c.id)).toEqual(["review_comment:2", "discussion:3"]);
    expect(result.comments[0]).toMatchObject({ threadId: "thread-1", path: "src/file.ts", line: 3 });
    expect(result.threads).toEqual([{ id: "thread-1", resolved: false, commentIds: ["review_comment:2"] }]);
  });
  it("still accepts numeric GraphQL database IDs", async () => {
    const { provider } = fixture({ numericIds: true });
    const result = await provider.getPullRequestFeedback("https://github.com/ps06756/personal-website-test.git", 42);
    expect(result.comments.map(c => c.id)).toEqual(["review:1", "review_comment:2", "discussion:3"]);
  });
  it("binds review bodies to their current edit time when REST exposes only submitted_at", async () => {
    const { provider } = fixture({ exactReviewTime: true });
    const result = await provider.getPullRequestFeedback("https://github.com/ps06756/personal-website-test.git", 42);
    expect(result.comments.find(c => c.id === "review:1")?.updatedAt).toBe("2026-10-05T13:00:00.000Z");
  });
  it("refuses comments returned outside the exact linked repository and PR", async () => {
    const { provider } = fixture({ wrongScope: true });
    expect(typeof provider.getPullRequestFeedback).toBe("function");
    await expect(provider.getPullRequestFeedback("https://github.com/ps06756/personal-website-test.git", 42)).rejects.toThrow(/scope|canonical/);
  });
  it("refuses a head change during paginated feedback collection", async () => {
    const { provider } = fixture({ changedHead: true });
    expect(typeof provider.getPullRequestFeedback).toBe("function");
    await expect(provider.getPullRequestFeedback("https://github.com/ps06756/personal-website-test.git", 42)).rejects.toThrow(/changed/);
  });
});
