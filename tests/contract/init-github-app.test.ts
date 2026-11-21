import { createServer, request as httpRequest } from "node:http";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import { githubAppSecretName, githubAppStep, githubNewAppUrl, githubRestApi, parseManifestCallback, startManifestListener } from "../../packages/cli/src/init/github-app.js";
import { emptyProgress, type InstallProgress } from "../../packages/cli/src/init/install-state.js";
import { terminalPrompter } from "../../packages/cli/src/init/prompts.js";
import { problemText } from "../../packages/cli/src/init/retry.js";
import { githubCard } from "../../packages/cli/src/init/ui/cards.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";
import type { PreMadeGitHubApp } from "../../packages/cli/src/init/context.js";
import type { ProgressHandle } from "../../packages/cli/src/init/steps.js";
import { allStackOutputs, browserThatCreatesGitHubApp, fakeGitHubApi, initContext, memoryInitSecrets, progressHandle, sampleAnswers, scriptedDeployer, scriptedPrompter, T0, TEST_PRIVATE_KEY, type ScriptedAnswer, type TestInitContext } from "../support/init-fakes.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });
const SECRET = githubAppSecretName("staging");
const WEBHOOK_URL = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/github/webhooks";
const GITHUB_WEBHOOK_SECRET = "github-made-webhook-secret-".padEnd(40, "g");

/** Spec 048 FR-032: an InitContext and ProgressHandle for the GitHub step, built like every other
 * test's `initContext()` and `progressHandle()`, extended with a seeded `githubPending`, a scripted
 * prompter's answers, and a surface that records the cards shown. A browser that plays GitHub's
 * manifest flow is wired in by default, since every path here but a plain resume can end up making
 * a new GitHub App. Every context's `home` is queued for cleanup, as the other tests in this file do. */
async function githubContext(input: {
  secrets?: TestInitContext["secrets"];
  pending?: InstallProgress["githubPending"];
  script?: ScriptedAnswer[];
  cards?: WizardCard[];
} = {}): Promise<{ context: TestInitContext; progress: ProgressHandle & { value(): InstallProgress } }> {
  const context = initContext({
    openBrowser: browserThatCreatesGitHubApp([]),
    ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
    ...(input.script === undefined ? {} : { prompter: scriptedPrompter(input.script) }),
    ...(input.cards === undefined ? {} : { surface: { card: (card: WizardCard) => { input.cards?.push(card); } } }),
  });
  homes.push(context.home);
  const progress = progressHandle({ ...emptyProgress("staging", T0), ...(input.pending === undefined ? {} : { githubPending: input.pending }) });
  return { context, progress };
}

describe("GitHub App manifest", () => {

  it("opens the new-app page for an organization or a personal account", () => {
    expect(githubNewAppUrl({ account: "acme", accountType: "organization", state: "s1" })).toBe("https://github.com/organizations/acme/settings/apps/new?state=s1");
    expect(githubNewAppUrl({ account: "alice", accountType: "user", state: "s1" })).toBe("https://github.com/settings/apps/new?state=s1");
  });

  it("takes a pasted redirect address or a bare code, and refuses another run's address", () => {
    expect(parseManifestCallback("http://127.0.0.1:50123/github/created?code=abc123def456&state=s1", "s1")).toBe("abc123def456");
    expect(parseManifestCallback("  abc123def456\n", "s1")).toBe("abc123def456");
    expect(() => parseManifestCallback("http://127.0.0.1:1/github/created?code=abc123def456&state=other", "s1")).toThrow("that address is from a different agentx init run");
    expect(() => parseManifestCallback("http://127.0.0.1:1/github/created?state=s1", "s1")).toThrow("that address has no code");
    expect(() => parseManifestCallback("no", "s1")).toThrow("that is not a GitHub manifest code");
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

  it("falls back to the control plane's API endpoint for the webhook URL", async () => {
    const outputs = { ...allStackOutputs() };
    const controlPlane = environmentStackName("staging", "control-plane");
    outputs[controlPlane] = Object.fromEntries(Object.entries(outputs[controlPlane]!).filter(([key]) => key !== "GithubWebhookUrl"));
    const pages: string[] = [];
    const context = initContext({
      openBrowser: async () => true,
      manifestHost: async (host) => {
        pages.push(host.page("http://127.0.0.1:50123/github/created"));
        return { startUrl: "http://127.0.0.1:50123/github/start", redirectUrl: "http://127.0.0.1:50123/github/created", port: 50123, code: Promise.resolve("0123456789abcdef0123"), close: () => undefined };
      },
    });
    context.deployment = async () => ({ deployer: scriptedDeployer(outputs, Object.keys(outputs)), store: context.store, secrets: context.secrets, holder: context.holder, partition: "aws", cleanup: async () => undefined });
    homes.push(context.home);
    await githubAppStep(fakeGitHubApi()).run(context, progressHandle());
    expect(pages[0]).toContain(WEBHOOK_URL);
  });

  it("stores GitHub's webhook secret with the App credentials without printing it", async () => {
    // GitHub made the hook from the manifest, so its URL is already right.
    const api = fakeGitHubApi({ webhookSecret: GITHUB_WEBHOOK_SECRET, hookUrl: WEBHOOK_URL });
    const context = initContext({ openBrowser: browserThatCreatesGitHubApp([]) });
    homes.push(context.home);
    const progress = progressHandle();
    await githubAppStep(api).run(context, progress);
    expect(JSON.parse(context.secrets.values.get(SECRET)!)).toEqual({ appId: "424242", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY, webhookSecret: GITHUB_WEBHOOK_SECRET });
    // Kept as GitHub made it, and sent back to GitHub as it is.
    expect(api.hookWrites).toEqual([{ url: WEBHOOK_URL, secret: GITHUB_WEBHOOK_SECRET }]);
    expect(context.lines.join("\n")).not.toContain(GITHUB_WEBHOOK_SECRET);
    expect(JSON.stringify(progress.value())).not.toContain(GITHUB_WEBHOOK_SECRET);
  });

  it("an App given by ID gets a generated webhook secret and its hook configured", async () => {
    const api = fakeGitHubApi({ installationId: 555, events: ["pull_request"] });
    const context = initContext({
      preMadeGitHubApp: { appId: "424242", installationId: "555" },
      secretFlags: { githubPrivateKey: { envName: "GH_KEY" } },
      processEnv: { GH_KEY: TEST_PRIVATE_KEY },
    });
    homes.push(context.home);
    await githubAppStep(api).run(context, progressHandle());
    const stored = JSON.parse(context.secrets.values.get(SECRET)!) as { webhookSecret: string; privateKey: string };
    expect(stored.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.privateKey).toBe(TEST_PRIVATE_KEY);
    expect(api.hookWrites).toEqual([{ url: WEBHOOK_URL, secret: stored.webhookSecret }]);
    expect(context.lines).toContain("GitHub webhook: configured");
    // An App made beforehand may have no webhook, and GitHub's API cannot switch it on.
    expect(context.lines).toContain("GitHub webhook: turn on Active at https://github.com/organizations/acme/settings/apps/agentx-acme-staging if it is off");
    // The App made beforehand may not listen for the events: say which and where, never the secret.
    expect(context.lines).toContain("GitHub webhook: tick these events on https://github.com/organizations/acme/settings/apps/agentx-acme-staging/permissions: pull_request_review, pull_request_review_comment, issue_comment");
    expect(context.lines.join("\n")).not.toContain(stored.webhookSecret);
  });

  it("does not print the secret when storing it fails", async () => {
    const api = fakeGitHubApi({ installationId: 555 });
    const context = initContext({
      preMadeGitHubApp: { appId: "424242", installationId: "555" },
      secretFlags: { githubPrivateKey: { envName: "GH_KEY" } },
      processEnv: { GH_KEY: TEST_PRIVATE_KEY },
    });
    homes.push(context.home);
    let written = "";
    context.secrets.put = async (_name, value) => { written = value; throw Object.assign(new Error(`access denied for ${value}`), { name: "AccessDeniedException" }); };
    const failure = await githubAppStep(api).run(context, progressHandle()).catch((error: unknown) => error);
    const generated = (JSON.parse(written) as { webhookSecret: string }).webhookSecret;
    expect(problemText(failure)).toContain("could not store the webhook secret");
    expect(`${String(failure)} ${problemText(failure)} ${context.lines.join("\n")}`).not.toContain(generated);
    expect(`${String(failure)} ${problemText(failure)}`).not.toContain("PRIVATE KEY");
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

  it("gives up waiting for an installation after 15 minutes, naming the install page", async () => {
    const context = initContext({ openBrowser: browserThatCreatesGitHubApp([]) });
    homes.push(context.home);
    await expect(githubAppStep(fakeGitHubApi({ installAfterPolls: 1_000_000 })).run(context, progressHandle()))
      .rejects.toThrow("the GitHub App was not installed on acme within 15 minutes; install it at https://github.com/apps/agentx-acme-staging/installations/new, then run agentx init again");
  });

  describe("a wait that fails on the page shows a failed card", () => {
    const recorded = () => ({
      secrets: memoryInitSecrets({ [SECRET]: JSON.stringify({ appId: "424242", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY }) }),
      progress: progressHandle({ ...emptyProgress("staging", T0), github: { account: "acme", appId: "424242", slug: "agentx-acme-staging", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" } }),
    });

    it("a repositories wait that times out shows the failed GitHub card", async () => {
      const { secrets, progress } = recorded();
      const cards: WizardCard[] = [];
      const context = initContext({ secrets, surface: { card: (card) => { cards.push(card); } } });
      homes.push(context.home);
      const failure = await githubAppStep(fakeGitHubApi({ repositoryCounts: [0] })).run(context, progress).then(() => undefined, (error: unknown) => error);
      expect((failure as Error).message).toContain("the GitHub App can see no repositories");
      expect(cards.map((card) => card.status)).toEqual(["waiting", "waiting", "failed"]);
      expect(cards.at(-1)).toEqual(githubCard({ stage: "failed", problem: problemText(failure) }));
    });

    it("a failure before any GitHub card shows none", async () => {
      const cards: WizardCard[] = [];
      const context = initContext({ surface: { card: (card) => { cards.push(card); } }, preMadeGitHubApp: { appId: "999" } as PreMadeGitHubApp });
      homes.push(context.home);
      const { progress } = recorded();
      await expect(githubAppStep(fakeGitHubApi()).run(context, progress)).rejects.toThrow("this install already uses GitHub App 424242, not 999 from --github-app-id");
      expect(cards).toEqual([]);
    });
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
    const listener = await startManifestListener({ state: "s1", page: () => "<p>form</p>", timeoutMs: 1_000 });
    try {
      expect((await fetch(`http://127.0.0.1:${listener.port}/elsewhere`)).status).toBe(404);
      expect((await fetch(`${listener.redirectUrl}?state=s1`)).status).toBe(400);
      await expect(listener.code).rejects.toThrow(/no GitHub App was created within \d+ minutes; run agentx init again/);
    } finally {
      listener.close();
    }
    await expect(fetch(listener.startUrl)).rejects.toThrow();
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

});

describe("spec 048 FR-032: a GitHub app made but not stored", () => {

  it("on resume, Replace sends the user to delete the old app, then makes a new one", async () => {
    const api = fakeGitHubApi();
    const cards: WizardCard[] = [];
    const { context, progress } = await githubContext({ pending: { account: "acme", appId: "424242", slug: "agentx-acme-staging" }, script: ["replace", true], cards });
    await expect(githubAppStep(api).run(context, progress)).resolves.toMatchObject({ status: "done" });
    expect(api.conversions).toHaveLength(1);
    const recover = cards.find((card) => card.lines.some((line) => line.includes("cannot show that key again")));
    expect(recover?.link?.url).toBe("https://github.com/organizations/acme/settings/apps/agentx-acme-staging/advanced");
  });

  it("links to the pending app's owner when the current answers name a different owner", async () => {
    const cards: WizardCard[] = [];
    const { context, progress } = await githubContext({ pending: { account: "oldco", appId: "424242", slug: "agentx-oldco-staging" }, script: ["finish", TEST_PRIVATE_KEY], cards });
    context.answers = sampleAnswers({ github: { account: "newco", accountType: "organization", appName: "AgentX newco (staging)" } });
    await expect(githubAppStep(fakeGitHubApi({ owner: "oldco" })).run(context, progress)).rejects.toThrow("created under oldco, not newco");
    expect(cards.find((card) => card.lines.some((line) => line.includes("cannot show that key again")))?.link?.url).toBe("https://github.com/organizations/oldco/settings/apps/agentx-oldco-staging/advanced");
  });

});
