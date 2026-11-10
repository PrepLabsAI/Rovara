// Port lane L11: the GitHub code host for a laptop (`githubTokenCodeHost`): "find my sign-in" (`resolveCredentials`), "test my connection" (`checkAccess`), what it is wired as, and that it passes
// the CodeHost contract with the sign-in resolved from the environment, the key file or the GitHub CLI, over the fake GitHub.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretValue, type ModelKeyStore, type SecretStore } from "@agentx/contracts";
import { createFileModelKeyStore, createLocalSecretStore } from "../../packages/broker/src/ports/index.js";
import { parseIssueUrl } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { githubTokenCodeHost } from "../../packages/broker/src/plugins/code-host/github/token-code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { codeHostChecks, type CodeHostWorld } from "../support/ports/code-host-conformance.js";
import { runContract } from "../support/ports/plugin-contract-kit.js";
import { GITHUB_OTHER_URL, GITHUB_REPO_URL, GITHUB_ORG_SCOPE, GitHubFixtureApi } from "../support/ports/github-fixture-api.js";

const NOW = Date.parse("2026-10-30T10:00:00.000Z");
const WORKING_BRANCH = (n: number) => `agentx/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PREFIX = (...parts: string[]): string => parts.join("_");
/** Built at runtime and far too short to be real. Fine-grained: the kind a worker may be given. */
const makeToken = (): string => `${PREFIX("github", "pat")}_fixture${randomBytes(8).toString("hex")}`;
const makeBroadToken = (): string => `${PREFIX("gho")}_fixture${randomBytes(8).toString("hex")}`;
const registered = { registeredRepositories: () => [GITHUB_REPO_URL] };
const COMPANY = GITHUB_ORG_SCOPE.orgId;

// The stored token is read through the `secrets` socket as { key: "github" } (owner decision 60).
const secretsOver = (keyFile: ModelKeyStore): SecretStore => createLocalSecretStore({ environment: {}, keyFile });
const emptyKeys: SecretStore = secretsOver({ get: async () => undefined, providers: async () => [] });
const keysWith = (token: string): SecretStore => secretsOver({ get: async (_company, provider) => (provider === "github" ? new SecretValue(token) : undefined), providers: async () => ["github"] });

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

describe("resolveCredentials (find my sign-in)", () => {
  it("says where the sign-in was found and starts no network call, from the key file, the environment or the GitHub CLI", async () => {
    const token = makeToken();
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("{}"));
    const base = { companyId: COMPANY, fetch: fetchSpy, gh: vi.fn(async () => undefined as string | undefined) };
    const fromKeys = await githubTokenCodeHost({ ...registered, ...base, secrets: keysWith(token), environment: { GH_TOKEN: "other" } }).resolveCredentials!();
    expect(fromKeys).toEqual({ found: true, source: "the key file", summary: "A GitHub token is available from the key file." });
    const fromEnvironment = await githubTokenCodeHost({ ...registered, ...base, secrets: emptyKeys, environment: { GH_TOKEN: token } }).resolveCredentials!();
    expect(fromEnvironment).toMatchObject({ found: true, source: "the environment" });
    const cli = vi.fn(async (args: readonly string[]) => (args[1] === "status" ? "Logged in" : token));
    const fromCli = await githubTokenCodeHost({ ...registered, ...base, gh: cli, secrets: emptyKeys, environment: {} }).resolveCredentials!();
    expect(fromCli).toMatchObject({ found: true, source: "the GitHub CLI" });
    // Only whether the CLI is signed in is asked; its token is not fetched for this.
    expect(cli.mock.calls.map(([args]) => args[1])).toEqual(["status"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const found of [fromKeys, fromEnvironment, fromCli]) expect(JSON.stringify(found)).not.toContain(token);
  });

  it("says how to sign in when there is none, and what to fix when the key file cannot be read", async () => {
    const none = await githubTokenCodeHost({ ...registered, companyId: COMPANY, secrets: emptyKeys, environment: {}, gh: async () => undefined }).resolveCredentials!();
    expect(none).toMatchObject({ found: false, summary: "No GitHub access was found." });
    expect(none.fix).toContain("gh auth login");
    const dir = await mkdtemp(join(tmpdir(), "rovara-l11-keys-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "keys.json");
    await writeFile(file, '{"github":"x"}', { mode: 0o600 });
    await chmod(file, 0o644);
    const unreadable = await githubTokenCodeHost({ ...registered, companyId: COMPANY, secrets: secretsOver(createFileModelKeyStore(file)), environment: {}, keyFilePath: file }).resolveCredentials!();
    expect(unreadable).toMatchObject({ found: false });
    expect(unreadable.summary).toContain("must not be readable by other users");
    expect(unreadable.fix).toBe(`Fix the file's permissions with \`chmod 600 ${file}\`.`);
    expect(JSON.stringify(unreadable)).not.toContain('"x"');
  });
});

describe("checkAccess warns about a token that reaches every repository (M1, L6)", () => {
  const check = async (token: string, headers: Record<string, string>, extra: { allowBroadTokenForWorker?: boolean; source?: "gh" } = {}) => {
    const host = githubTokenCodeHost({
      ...registered, companyId: COMPANY, secrets: emptyKeys, environment: extra.source === "gh" ? {} : { GH_TOKEN: token }, allowBroadTokenForWorker: extra.allowBroadTokenForWorker === true,
      gh: async (args) => (extra.source === "gh" ? (args[1] === "status" ? "ok" : `${token}\n`) : undefined),
      fetch: async () => Response.json({ login: "octo-dev" }, { headers }),
    });
    return host.checkAccess!();
  };

  it("warns on a classic token and on the GitHub CLI's, names the wide scopes, and recommends a fine-grained token limited to the project's repositories", async () => {
    const classic = await check(makeBroadToken(), { "x-oauth-scopes": "repo, read:org, gist, admin:public_key" });
    expect(classic.status).toBe("warn");
    expect(classic.summary).toContain("reach every repository you can");
    expect(classic.summary).toMatch(/scopes: repo, read:org, gist, admin:public_key/u);
    expect(classic.summary).toContain("will not give it to a task's worker unless you set allowBroadTokenForWorker");
    expect(classic.fix).toContain("fine-grained");
    expect(classic.fix).toContain("limited to the repositories of your Rovara projects");
    const cli = await check(makeBroadToken(), {}, { source: "gh" });
    expect(cli).toMatchObject({ status: "warn" });
    expect(cli.summary).toContain("token from the GitHub CLI");
  });

  it("says the owner allowed it when the config does, and stays ok for a fine-grained token", async () => {
    expect((await check(makeBroadToken(), {}, { allowBroadTokenForWorker: true })).summary).toContain("You have allowed it to be given to a task's worker.");
    expect(await check(makeToken(), {})).toMatchObject({ status: "ok" });
  });

  it("recommends a fine-grained token, not a classic one, when GitHub rejects the token", async () => {
    const host = githubTokenCodeHost({ ...registered, companyId: COMPANY, secrets: emptyKeys, environment: { GH_TOKEN: makeBroadToken() }, fetch: async () => new Response("{}", { status: 401 }), gh: async () => undefined });
    const rejected = await host.checkAccess!();
    expect(rejected.status).toBe("fail");
    expect(rejected.fix).toContain("fine-grained");
    expect(rejected.fix).not.toContain("with the `repo` scope");
  });
});

describe("checkAccess (test my connection)", () => {
  const host = (answer: () => Response | Promise<Response> | Error, extra: { environment?: NodeJS.ProcessEnv; token?: string } = {}) => {
    const token = extra.token ?? makeToken();
    const fetchSpy = vi.fn<typeof fetch>(async () => { const result = await answer(); if (result instanceof Error) throw result; return result; });
    return { token, fetchSpy, host: githubTokenCodeHost({ ...registered, companyId: COMPANY, secrets: keysWith(token), environment: extra.environment ?? {}, fetch: fetchSpy, gh: async () => undefined }) };
  };

  it("tests the token once with GET /user, no redirects and a time limit, and sends it to api.github.com only", async () => {
    const { host: h, fetchSpy, token } = host(() => Response.json({ login: "octo-dev" }));
    const result = await h.checkAccess!();
    expect(result).toEqual({ status: "ok", summary: "GitHub access works as octo-dev (token from the key file).", account: "octo-dev" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [address, init] = fetchSpy.mock.calls[0]!;
    expect(address).toBe("https://api.github.com/user");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("says a rejected token, a GitHub that is unwell, an offline machine, and a classic token with no repo scope, each with the fix", async () => {
    expect(await host(() => new Response("{}", { status: 401 })).host.checkAccess!()).toMatchObject({ status: "fail", summary: "GitHub rejected the token from the key file." });
    expect(await host(() => new Response("{}", { status: 503 })).host.checkAccess!()).toEqual({ status: "warn", summary: "GitHub answered HTTP 503 when the token was checked.", fix: "Try again in a minute." });
    const offline = await host(() => new TypeError("offline")).host.checkAccess!();
    expect(offline).toMatchObject({ status: "warn", summary: "GitHub could not be reached to check the token." });
    const noScope = await host(() => Response.json({ login: "octo-dev" }, { headers: { "x-oauth-scopes": "read:user" } }), { token: makeBroadToken() }).host.checkAccess!();
    expect(noScope).toMatchObject({ status: "warn", account: "octo-dev" });
    expect(noScope.summary).toContain("no `repo` scope");
    // A fine-grained token lists no scopes and is limited to chosen repositories, so there is nothing to warn about.
    expect((await host(() => Response.json({ login: "octo-dev" })).host.checkAccess!()).status).toBe("ok");
    const none = await githubTokenCodeHost({ ...registered, companyId: COMPANY, secrets: emptyKeys, environment: {}, gh: async () => undefined }).checkAccess!();
    expect(none).toMatchObject({ status: "fail", summary: "No GitHub access was found." });
  });
});

function adapterWorld(source: "environment" | "keys" | "cli"): CodeHostWorld {
  const token = makeToken();
  const model = new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" });
  const api = new GitHubFixtureApi(model, { personalToken: token });
  let limited: number | undefined;
  const fetchImplementation: typeof fetch = async (input, init) => {
    if (limited !== undefined) return new Response("{}", { status: 429, headers: { "retry-after": String(limited) } });
    return api.fetch(input, init);
  };
  const host = githubTokenCodeHost({
    ...registered, companyId: COMPANY, secrets: source === "keys" ? keysWith(token) : emptyKeys, environment: source === "environment" ? { GH_TOKEN: token } : {},
    gh: source === "cli" ? async (args) => (args[1] === "status" ? "ok" : `${token}\n`) : async () => undefined, fetch: fetchImplementation, now: () => NOW,
  });
  return {
    host, model, repository: { url: GITHUB_REPO_URL }, unregistered: { url: GITHUB_OTHER_URL }, scope: GITHUB_ORG_SCOPE, now: () => NOW, branch: WORKING_BRANCH,
    limitReads: (retryAt) => { limited = (retryAt - NOW) / 1_000; },
  };
}

for (const source of ["environment", "keys", "cli"] as const) {
  runContract(`the laptop GitHub code host passes the CodeHost contract with the sign-in from ${source}`, codeHostChecks, () => adapterWorld(source));
}

describe("the laptop GitHub code host", () => {
  it("is the github code host with no webhooks (a laptop has no address for GitHub to call)", () => {
    const { host } = adapterWorld("environment");
    expect(host.kind).toBe("github");
    expect(host.capabilities.webhooks).toBe(false);
    expect(host.events).toEqual({ mode: "poll" });
    expect(host.capabilities.credentialKinds).toEqual(["basic"]);
  });

  it("hands the owner's own token to the worker as a basic credential that expires inside the hour", async () => {
    const world = adapterWorld("cli");
    const credential = await world.host.issueGitCredential(world.repository, "push", world.scope);
    expect(credential).toMatchObject({ kind: "basic", username: "x-access-token" });
    expect(Date.parse(credential.kind === "basic" ? credential.expiresAt : "")).toBeLessThanOrEqual(NOW + 3_600_000);
  });

  it("reads the comments of a pull request's conversation and posts Rovara's own comment with its marker (lane L12, decision 66: fetch only)", async () => {
    const world = adapterWorld("environment");
    world.model.commit(WORKING_BRANCH(1), { "a.txt": "x" });
    const cr = world.model.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "A change" }).cr;
    world.model.setAccount("dana", "write");
    const comment = world.model.addDiscussionComment(cr.id, "dana", "/rovara approve");
    const ref = { repository: world.repository, id: cr.id, url: "" };
    const page = await world.host.comments!(ref, {}, world.scope);
    expect(page).toEqual({ comments: [{
      id: comment.id, ref: expect.objectContaining({ id: cr.id }) as unknown, author: { login: "dana", hostUserId: expect.any(String) as unknown, isBot: false },
      body: "/rovara approve", createdAt: comment.createdAt, updatedAt: comment.updatedAt,
    }] });
    // The place is what GitHub reported for the comment (its issue address), not what was asked.
    expect(page.comments[0]!.ref).toMatchObject({ repository: { url: GITHUB_REPO_URL.replace(/\.git$/u, "") }, id: cr.id });
    // Nothing in it is a judgement: whether it approves, is fresh or is from someone who may is the core's.
    expect(Object.keys(page.comments[0]!).sort()).toEqual(["author", "body", "createdAt", "id", "ref", "updatedAt"]);
    expect((await world.host.comments!(ref, { since: new Date(Date.parse(comment.updatedAt) + 60_000).toISOString() }, world.scope)).comments).toEqual([]);
    expect(await world.host.postComment!(ref, "Approved.", world.scope)).toBe("posted");
    const after = await world.host.comments!(ref, {}, world.scope);
    expect(after.comments.at(-1)!.body).toBe("Approved.\n\n<!-- rovara-reply -->");
    await expect(world.host.postComment!(ref, "@dana thanks", world.scope)).rejects.toThrow();
  });

  it("reads the sign-in again after 30 seconds, so a new `gh auth login` is picked up without a restart", async () => {
    const first = makeToken();
    const second = makeToken();
    let current = first;
    let now = NOW;
    const model = new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" });
    const seen: string[] = [];
    const host = githubTokenCodeHost({
      ...registered, companyId: COMPANY, secrets: emptyKeys, environment: {}, gh: async (args) => (args[1] === "status" ? "ok" : `${current}\n`), now: () => now,
      fetch: async (input, init) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        // The fake accepts whichever token is current, for the repository read only.
        const api = new GitHubFixtureApi(model, { personalToken: current });
        return api.fetch(input, init);
      },
    });
    const repository = { url: GITHUB_REPO_URL };
    expect(await host.repositoryIdentity(repository, GITHUB_ORG_SCOPE)).toMatchObject({ id: "4242" });
    current = second;
    now += 29_000;
    await host.issueGitCredential(repository, "clone", GITHUB_ORG_SCOPE).catch(() => undefined);
    expect(seen.every((header) => header === `Bearer ${first}`)).toBe(true);
    now += 31_000;
    // 60 seconds on, the cached look at the repository has also lapsed; the next read uses the new sign-in.
    const credential = await host.issueGitCredential(repository, "clone", GITHUB_ORG_SCOPE);
    expect(credential).toMatchObject({ kind: "basic", password: second });
  });
});

describe("where a comment says it is (N4: the API origin the request went to, matched exactly)", () => {
  it("reads github.com and a GitHub Enterprise server's address, and nothing from another origin", () => {
    expect(parseIssueUrl("https://api.github.com/repos/acme/app/issues/12", "https://api.github.com")).toEqual({ repositoryUrl: "https://github.com/acme/app", number: 12 });
    // A GitHub Enterprise server: its API origin, with /api/v3 in front.
    expect(parseIssueUrl("https://ghes.example.test/api/v3/repos/acme/app/issues/7", "https://ghes.example.test")).toEqual({ repositoryUrl: "https://ghes.example.test/acme/app", number: 7 });
    // Another origin than the one asked, a look-alike, a different scheme or port, an extra query or a path that is not an issue: nothing.
    expect(parseIssueUrl("https://api.github.com/repos/acme/app/issues/12", "https://ghes.example.test")).toBeUndefined();
    expect(parseIssueUrl("https://api.github.com.evil.example/repos/acme/app/issues/12", "https://api.github.com")).toBeUndefined();
    expect(parseIssueUrl("http://api.github.com/repos/acme/app/issues/12", "https://api.github.com")).toBeUndefined();
    expect(parseIssueUrl("https://api.github.com:8443/repos/acme/app/issues/12", "https://api.github.com")).toBeUndefined();
    expect(parseIssueUrl("https://api.github.com/repos/acme/app/issues/12?x=1", "https://api.github.com")).toBeUndefined();
    expect(parseIssueUrl("https://api.github.com/repos/acme/app/pulls/12", "https://api.github.com")).toBeUndefined();
    expect(parseIssueUrl("not a url", "https://api.github.com")).toBeUndefined();
  });
});
