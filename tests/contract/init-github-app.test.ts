import { createVerify } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  githubAppJwt, githubAppManifest, githubAppSecretName, githubAppStep, githubNewAppUrl, githubRestApi, manifestFormPage, parseManifestCallback, startManifestListener,
} from "../../packages/cli/src/init/github-app.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { terminalPrompter } from "../../packages/cli/src/init/prompts.js";
import {
  browserThatCreatesGitHubApp, fakeGitHubApi, initContext, memoryInitSecrets, progressHandle, sampleAnswers, scriptedPrompter, T0, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY,
} from "../support/init-fakes.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });
const SECRET = githubAppSecretName("staging");

describe("GitHub App manifest", () => {
  it("asks for exactly the permissions AgentX uses, no webhook and no events", () => {
    expect(githubAppManifest({ appName: "AgentX acme staging", redirectUrl: "http://127.0.0.1:50123/github/created" })).toEqual({
      name: "AgentX acme staging",
      url: "https://github.com/PrepLabsAI/AgentX",
      redirect_url: "http://127.0.0.1:50123/github/created",
      public: false,
      default_permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
      default_events: [],
    });
  });

  it("opens the new-app page for an organization or a personal account", () => {
    expect(githubNewAppUrl({ account: "acme", accountType: "organization", state: "s1" })).toBe("https://github.com/organizations/acme/settings/apps/new?state=s1");
    expect(githubNewAppUrl({ account: "alice", accountType: "user", state: "s1" })).toBe("https://github.com/settings/apps/new?state=s1");
  });

  it("posts the manifest from an auto-submitting form, escaping everything", () => {
    const page = manifestFormPage({ actionUrl: "https://github.com/settings/apps/new?state=s1", manifest: githubAppManifest({ appName: "A\"<b>'&", redirectUrl: "http://127.0.0.1:1/github/created" }) });
    expect(page).toContain('<form id="manifest-form" method="post" action="https://github.com/settings/apps/new?state=s1">');
    expect(page).toContain('name="manifest" value="{&quot;name&quot;:&quot;A\\&quot;&lt;b&gt;&#39;&amp;&quot;');
    expect(page).not.toContain("<b>");
    expect(page).toContain('document.getElementById("manifest-form").submit()');
  });

  it("takes a pasted redirect address or a bare code, and refuses another run's address", () => {
    expect(parseManifestCallback("http://127.0.0.1:50123/github/created?code=abc123def456&state=s1", "s1")).toBe("abc123def456");
    expect(parseManifestCallback("  abc123def456\n", "s1")).toBe("abc123def456");
    expect(() => parseManifestCallback("http://127.0.0.1:1/github/created?code=abc123def456&state=other", "s1")).toThrow("that address is from a different agentx init run");
    expect(() => parseManifestCallback("http://127.0.0.1:1/github/created?state=s1", "s1")).toThrow("that address has no code");
    expect(() => parseManifestCallback("no", "s1")).toThrow("that is not a GitHub manifest code");
  });

  it("signs an app JWT GitHub accepts: RS256, issued a minute early, nine minutes long", () => {
    const jwt = githubAppJwt({ appId: "424242", privateKey: TEST_PRIVATE_KEY, nowSeconds: 1_800_000_000 });
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: "424242" });
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(TEST_PUBLIC_KEY, Buffer.from(signature!, "base64url"))).toBe(true);
  });
});

describe("manifest listener", () => {
  it("serves the form on a free loopback port and resolves the code only for the right state", async () => {
    const listener = await startManifestListener({ state: "s1", page: (redirect) => `<p>${redirect}</p>`, timeoutMs: 60_000 });
    try {
      expect(listener.port).toBeGreaterThan(0);
      expect(listener.port).not.toBe(8765);
      expect(await (await fetch(listener.startUrl)).text()).toBe(`<p>${listener.redirectUrl}</p>`);
      expect((await fetch(`${listener.redirectUrl}?code=abc&state=wrong`)).status).toBe(400);
      const done = await fetch(`${listener.redirectUrl}?code=abc123def456&state=s1`);
      expect(done.status).toBe(200);
      expect(await done.text()).toContain("You can close this tab");
      await expect(listener.code).resolves.toBe("abc123def456");
    } finally {
      listener.close();
    }
  });
});

describe("GitHub App step", () => {
  it("creates the app, stores its key straight into Secrets Manager, and waits for an installation with repositories", async () => {
    const opened: string[] = [];
    const api = fakeGitHubApi({ installAfterPolls: 2 });
    const context = initContext({ openBrowser: browserThatCreatesGitHubApp(opened) });
    homes.push(context.home);
    const progress = progressHandle();
    const outcome = await githubAppStep(api).run(context, progress);
    expect(outcome.status).toBe("done");
    expect(api.conversions).toEqual(["0123456789abcdef0123"]);
    expect(JSON.parse(context.secrets.values.get(SECRET)!)).toEqual({ appId: "424242", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY });
    expect(progress.value().github).toEqual({ account: "acme", appId: "424242", slug: "agentx-acme-staging", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", installationId: "777" });
    expect(opened).toContain("https://github.com/apps/agentx-acme-staging/installations/new");
    expect(context.lines.join("\n")).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(progress.value())).not.toContain("PRIVATE KEY");
  });

  it("refuses an app created under another account, saving nothing and saying how to delete it", async () => {
    const context = initContext({ openBrowser: browserThatCreatesGitHubApp([]) });
    homes.push(context.home);
    let message = "";
    try { await githubAppStep(fakeGitHubApi({ owner: "someone-else", ownerType: "User" })).run(context, progressHandle()); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("the GitHub App was created under someone-else, not acme; nothing was saved. Delete it at https://github.com/settings/apps/agentx-acme-staging/advanced and run agentx init again");
    expect(message).not.toContain("PRIVATE KEY");
    expect(context.secrets.values.size).toBe(0);
  });

  it("resumes after the app was created: never creates a second app, reads the key back from the secret", async () => {
    const api = fakeGitHubApi();
    const secrets = memoryInitSecrets({ [SECRET]: JSON.stringify({ appId: "424242", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
    const context = initContext({ secrets });
    homes.push(context.home);
    const progress = progressHandle({ ...emptyProgress("staging", T0), github: { account: "acme", appId: "424242", slug: "agentx-acme-staging", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" } });
    await githubAppStep(api).run(context, progress);
    expect(api.conversions).toEqual([]);
    expect(progress.value().github?.installationId).toBe("777");
  });

  it("recovers an app whose secret was stored just before a crash, without creating another", async () => {
    const api = fakeGitHubApi();
    const secrets = memoryInitSecrets({ [SECRET]: JSON.stringify({ appId: "424242", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
    const context = initContext({ secrets });
    homes.push(context.home);
    const progress = progressHandle();
    await githubAppStep(api).run(context, progress);
    expect(api.conversions).toEqual([]);
    expect(context.lines).toContain("Found the GitHub App agentx-acme-staging an earlier run created.");
  });

  it("waits until the installation can see at least one repository", async () => {
    const context = initContext({ openBrowser: browserThatCreatesGitHubApp([]) });
    homes.push(context.home);
    await githubAppStep(fakeGitHubApi({ repositoryCounts: [0, 0, 2] })).run(context, progressHandle());
    expect(context.lines.join("\n")).toContain("The app is installed but can see no repositories. Choose at least one at https://github.com/organizations/acme/settings/installations/777");
  });

  it("gives up waiting for an installation after 15 minutes, naming the install page", async () => {
    const context = initContext({ openBrowser: browserThatCreatesGitHubApp([]) });
    homes.push(context.home);
    await expect(githubAppStep(fakeGitHubApi({ installAfterPolls: 1_000_000 })).run(context, progressHandle()))
      .rejects.toThrow("the GitHub App was not installed on acme within 15 minutes; install it at https://github.com/apps/agentx-acme-staging/installations/new, then run agentx init again");
  });

  it("with --no-browser, takes the pasted redirect address", async () => {
    const api = fakeGitHubApi();
    const context = initContext({ prompter: scriptedPrompter(["0123456789abcdef0123"]) });
    delete (context as { openBrowser?: unknown }).openBrowser;
    homes.push(context.home);
    await githubAppStep(api).run(context, progressHandle());
    expect(api.conversions).toEqual(["0123456789abcdef0123"]);
    expect(context.lines.join("\n")).toContain("ssh -L");
  });

  it("stores a GitHub App key given with Windows line endings with plain ones", async () => {
    const context = initContext({
      preMadeGitHubApp: { appId: "424242", installationId: "777" },
      secretFlags: { githubPrivateKey: { envName: "GH_KEY" } },
      processEnv: { GH_KEY: `${TEST_PRIVATE_KEY.replaceAll("\n", "\r\n")}\r\n` },
    });
    homes.push(context.home);
    await githubAppStep(fakeGitHubApi()).run(context, progressHandle());
    expect((JSON.parse(context.secrets.values.get(SECRET)!) as { privateKey: string }).privateKey).toBe(TEST_PRIVATE_KEY);
  });

  it("on resume, refuses --github-app-id for a different app than the one this install recorded", async () => {
    const api = fakeGitHubApi({ installationId: 555 });
    const secrets = memoryInitSecrets({ [SECRET]: JSON.stringify({ appId: "424242", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
    const context = initContext({ secrets, preMadeGitHubApp: { appId: "999999", installationId: "555" }, secretFlags: { githubPrivateKey: { envName: "GH_KEY" } }, processEnv: { GH_KEY: TEST_PRIVATE_KEY } });
    homes.push(context.home);
    const progress = progressHandle({ ...emptyProgress("staging", T0), github: { account: "acme", appId: "424242", slug: "agentx-acme-staging", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" } });
    await expect(githubAppStep(api).run(context, progress))
      .rejects.toThrow("this install already uses GitHub App 424242, not 999999 from --github-app-id; pass --github-app-id 424242, or leave the GitHub App flags off to continue with the recorded app");
    expect(progress.value().github?.installationId).toBeUndefined();
    expect(api.polls()).toBe(0);
  });

  it("uses a GitHub App made beforehand, checking its owner and installation", async () => {
    const api = fakeGitHubApi({ installationId: 555 });
    const context = initContext({
      preMadeGitHubApp: { appId: "424242", installationId: "555" },
      secretFlags: { githubPrivateKey: { envName: "GH_KEY" } },
      processEnv: { GH_KEY: `${TEST_PRIVATE_KEY}\n` },
      answers: sampleAnswers(),
    });
    homes.push(context.home);
    const progress = progressHandle();
    await githubAppStep(api).run(context, progress);
    expect(api.conversions).toEqual([]);
    expect(progress.value().github?.installationId).toBe("555");

    const wrong = initContext({ preMadeGitHubApp: { appId: "424242", installationId: "999" }, secretFlags: { githubPrivateKey: { envName: "GH_KEY" } }, processEnv: { GH_KEY: TEST_PRIVATE_KEY } });
    homes.push(wrong.home);
    await expect(githubAppStep(fakeGitHubApi({ installationId: 555 })).run(wrong, progressHandle())).rejects.toThrow("installation 999 of GitHub App 424242 is not on acme");
  });
});

describe("manifest listener, every path closes it", () => {
  it("answers 404 elsewhere, gives up after its timeout, and stops listening once closed", async () => {
    const listener = await startManifestListener({ state: "s1", page: () => "<p>form</p>", timeoutMs: 20 });
    try {
      expect((await fetch(`http://127.0.0.1:${listener.port}/elsewhere`)).status).toBe(404);
      expect((await fetch(`${listener.redirectUrl}?state=s1`)).status).toBe(400);
      await expect(listener.code).rejects.toThrow(/no GitHub App was created within \d+ minutes; run agentx init again/);
    } finally {
      listener.close();
    }
    await expect(fetch(listener.startUrl)).rejects.toThrow();
  });

  it("closes the listener when opening the browser fails", async () => {
    const opened: string[] = [];
    const context = initContext({ openBrowser: async (url) => { opened.push(url); throw new Error("no browser here"); } });
    homes.push(context.home);
    await expect(githubAppStep(fakeGitHubApi()).run(context, progressHandle())).rejects.toThrow("no browser here");
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/github\/start$/);
    await expect(fetch(opened[0]!)).rejects.toThrow();
  });

  it("falls back to the pasted address when the browser cannot open, and still closes the listener", async () => {
    const opened: string[] = [];
    const api = fakeGitHubApi();
    const context = initContext({ openBrowser: async (url) => { opened.push(url); return false; }, prompter: scriptedPrompter(["0123456789abcdef0123"]) });
    homes.push(context.home);
    const progress = progressHandle();
    expect((await githubAppStep(api).run(context, progress)).status).toBe("done");
    expect(api.conversions).toEqual(["0123456789abcdef0123"]);
    expect(context.lines.join("\n")).toContain("ssh -L");
    // The install page is offered too; a browser that fails there does not stop the step.
    expect(opened).toContain("https://github.com/apps/agentx-acme-staging/installations/new");
    expect(progress.value().github?.installationId).toBe("777");
    await expect(fetch(opened[0]!)).rejects.toThrow();
  });

  it("closes the listener when the pasted address is refused", async () => {
    const context = initContext({ prompter: scriptedPrompter(["http://127.0.0.1:1/github/created?code=abc123def456&state=other"]) });
    delete (context as { openBrowser?: unknown }).openBrowser;
    homes.push(context.home);
    await expect(githubAppStep(fakeGitHubApi()).run(context, progressHandle())).rejects.toThrow("that address is from a different agentx init run");
    const startUrl = /Open (http:\/\/127\.0\.0\.1:\d+\/github\/start)/.exec(context.lines.join("\n"))?.[1];
    expect(startUrl).toBeDefined();
    await expect(fetch(startUrl!)).rejects.toThrow();
  });
});

describe("GitHub REST client", () => {
  const recordingFetch = (responses: Array<{ status: number; body: unknown }>) => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const queue = [...responses];
    const fetchImplementation = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, method: init?.method ?? "GET", headers: init?.headers as Record<string, string> });
      const next = queue.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { calls, fetchImplementation };
  };

  it("converts a manifest code with an unauthenticated POST and reads the app with the JWT", async () => {
    const { calls, fetchImplementation } = recordingFetch([
      { status: 201, body: { id: 1, slug: "s", pem: TEST_PRIVATE_KEY, owner: { login: "acme", type: "Organization" } } },
      { status: 200, body: { slug: "s", owner: { login: "acme", type: "Organization" } } },
      { status: 201, body: { token: "ghs_x", expires_at: "2026-09-27T01:00:00Z" } },
      { status: 200, body: { total_count: 3, repositories: [] } },
    ]);
    const api = githubRestApi(fetchImplementation);
    expect((await api.convertManifest("abc123def456")).id).toBe(1);
    expect((await api.getApp("jwt-value")).slug).toBe("s");
    expect(await api.installationToken("jwt-value", "777")).toEqual({ token: "ghs_x", expiresAt: Date.parse("2026-09-27T01:00:00Z") });
    expect(await api.repositoryCount("ghs_x")).toBe(3);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://api.github.com/app-manifests/abc123def456/conversions",
      "GET https://api.github.com/app",
      "POST https://api.github.com/app/installations/777/access_tokens",
      "GET https://api.github.com/installation/repositories?per_page=1",
    ]);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[1]!.headers.authorization).toBe("Bearer jwt-value");
    expect(calls[3]!.headers.authorization).toBe("Bearer ghs_x");
  });

  it("never puts a response body in its error", async () => {
    const { fetchImplementation } = recordingFetch([{ status: 422, body: { message: "bad", pem: TEST_PRIVATE_KEY } }]);
    let message = "";
    try { await githubRestApi(fetchImplementation).convertManifest("abc123def456"); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("GitHub manifest conversion (the code is valid for one hour) failed with HTTP 422");
    expect(message).not.toContain("PRIVATE KEY");
  });
});

describe("GitHub App made beforehand", () => {
  it("refuses a hidden paste of the multi-line private key, asking for a file or an environment variable", async () => {
    const prompter = terminalPrompter({
      readLine: async () => { throw new Error("test setup: no line expected"); },
      readSecret: async () => { throw new Error("test setup: the key must not be read from a hidden prompt"); },
      write: () => undefined,
    });
    const context = initContext({ preMadeGitHubApp: { appId: "424242", installationId: "555" }, prompter });
    homes.push(context.home);
    await expect(githubAppStep(fakeGitHubApi({ installationId: 555 })).run(context, progressHandle()))
      .rejects.toThrow("pass --github-private-key-file <path> or --github-private-key-env <NAME>");
    expect(context.secrets.values.size).toBe(0);
  });

  it("reads the key from an environment variable whole, stores it trimmed, and never prints it", async () => {
    const context = initContext({ preMadeGitHubApp: { appId: "424242", installationId: "777" }, secretFlags: { githubPrivateKey: { envName: "GH_KEY" } }, processEnv: { GH_KEY: `\n${TEST_PRIVATE_KEY}\r\n` } });
    homes.push(context.home);
    const progress = progressHandle();
    await githubAppStep(fakeGitHubApi()).run(context, progress);
    expect((JSON.parse(context.secrets.values.get(SECRET)!) as { privateKey: string }).privateKey).toBe(TEST_PRIVATE_KEY);
    expect(`${context.lines.join("\n")}${JSON.stringify(progress.value())}`).not.toContain("PRIVATE KEY");
  });

  it("refuses an app that belongs to another account without telling the owner to delete it", async () => {
    const context = initContext({ preMadeGitHubApp: { appId: "424242", installationId: "555" }, secretFlags: { githubPrivateKey: { envName: "GH_KEY" } }, processEnv: { GH_KEY: TEST_PRIVATE_KEY } });
    homes.push(context.home);
    let message = "";
    try { await githubAppStep(fakeGitHubApi({ owner: "someone-else", ownerType: "User" })).run(context, progressHandle()); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("GitHub App 424242 belongs to someone-else, not acme; nothing was saved. Check --github-app-id and run agentx init again");
    expect(message).not.toContain("Delete it");
    expect(context.secrets.values.size).toBe(0);
  });
});

describe("fix round 1 hardening", () => {
  const getWithHost = (url: string, host: string) => new Promise<{ status: number; body: string }>((resolvePromise, reject) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });

  it("stops listening when its timeout passes, even though nobody awaited the code", async () => {
    const listener = await startManifestListener({ state: "s1", page: () => "<p>form</p>", timeoutMs: 20 });
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
      await expect(fetch(listener.startUrl)).rejects.toThrow();
    } finally {
      listener.close();
    }
  });

  it("refuses a request whose Host is not the listener's own address, without revealing the state", async () => {
    const listener = await startManifestListener({ state: "0123abcd", page: (redirect) => `<p>${redirect}?state=0123abcd</p>`, timeoutMs: 60_000 });
    try {
      for (const host of ["evil.example", `evil.example:${listener.port}`, `localhost:${listener.port}`, "127.0.0.1"]) {
        const start = await getWithHost(listener.startUrl, host);
        expect(start.status).toBe(403);
        expect(start.body).not.toContain("0123abcd");
        expect((await getWithHost(`${listener.redirectUrl}?code=abc123def456&state=0123abcd`, host)).status).toBe(403);
      }
      expect((await getWithHost(listener.startUrl, `127.0.0.1:${listener.port}`)).status).toBe(200);
    } finally {
      listener.close();
    }
  });

  it("says what to do when the loopback port cannot be opened", async () => {
    const taken = createServer();
    await new Promise<void>((resolvePromise) => taken.listen(0, "127.0.0.1", () => resolvePromise()));
    const address = taken.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      await expect(startManifestListener({ state: "s1", page: () => "", timeoutMs: 60_000, port }))
        .rejects.toThrow(/could not open a local port on 127\.0\.0\.1 for the GitHub App page \(EADDRINUSE\); .*run agentx init again/);
    } finally {
      taken.close();
    }
  });

  it("refuses a pasted address with a code but no state, and still takes a bare code", () => {
    expect(() => parseManifestCallback("http://127.0.0.1:1/github/created?code=abc123def456", "s1")).toThrow("that address has no state");
    expect(parseManifestCallback("abc123def456", "s1")).toBe("abc123def456");
  });

  it("names the app and how to delete it when storing its key fails after the conversion", async () => {
    const secrets = memoryInitSecrets();
    secrets.create = async () => { throw Object.assign(new Error("User is not authorized to perform secretsmanager:CreateSecret"), { name: "AccessDeniedException" }); };
    const context = initContext({ secrets, openBrowser: browserThatCreatesGitHubApp([]) });
    homes.push(context.home);
    let message = "";
    try { await githubAppStep(fakeGitHubApi()).run(context, progressHandle()); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("could not store the private key of the new GitHub App agentx-acme-staging in agentx/staging/github-app (AccessDeniedException)");
    expect(message).toContain("delete the app at https://github.com/organizations/acme/settings/apps/agentx-acme-staging/advanced and run agentx init again");
    expect(message).not.toContain("PRIVATE KEY");
    expect(context.lines.join("\n")).not.toContain("PRIVATE KEY");
  });

  it("refuses a leftover secret for a different app than --github-app-id", async () => {
    const secrets = memoryInitSecrets({ [SECRET]: JSON.stringify({ appId: "111", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
    const context = initContext({ secrets, preMadeGitHubApp: { appId: "424242", installationId: "777" } });
    homes.push(context.home);
    const progress = progressHandle();
    await expect(githubAppStep(fakeGitHubApi()).run(context, progress))
      .rejects.toThrow("secret agentx/staging/github-app holds GitHub App 111, not 424242 from --github-app-id");
    expect(progress.value().github).toBeUndefined();
  });

  it("creates one installation token for a wait of several polls", async () => {
    const context = initContext({ openBrowser: browserThatCreatesGitHubApp([]) });
    homes.push(context.home);
    const api = fakeGitHubApi({ repositoryCounts: [0, 0, 0, 0, 2] });
    await githubAppStep(api).run(context, progressHandle());
    expect(api.tokens()).toBe(1);
  });

  it("creates a new installation token about five minutes before the old one expires", async () => {
    const context = initContext({ openBrowser: browserThatCreatesGitHubApp([]) });
    homes.push(context.home);
    // Expires 6 minutes after T0, so from T0 + 1 minute on it is renewed; polls are 5 seconds apart.
    const api = fakeGitHubApi({ repositoryCounts: [...Array<number>(14).fill(0), 2], tokenExpiresAt: T0 + 6 * 60_000 });
    await githubAppStep(api).run(context, progressHandle());
    expect(api.tokens()).toBeGreaterThan(1);
    expect(api.tokens()).toBeLessThan(15);
  });
});
