// Port lane L11: the GitHub code host for a laptop (`githubTokenCodeHost`): "find my sign-in" (`resolveCredentials`), "test my connection" (`checkAccess`), what it is wired as, and that it passes
// the CodeHost contract with the sign-in resolved from the environment, the key file or the GitHub CLI, over the fake GitHub.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretValue, type ModelKeyStore } from "@agentx/contracts";
import { createFileModelKeyStore } from "../../packages/broker/src/ports/index.js";
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

const emptyKeys: ModelKeyStore = { get: async () => undefined, providers: async () => [] };
const keysWith = (token: string): ModelKeyStore => ({ get: async (_company, provider) => (provider === "github" ? new SecretValue(token) : undefined), providers: async () => ["github"] });

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

describe("resolveCredentials (find my sign-in)", () => {
  it("says where the sign-in was found and starts no network call, from the key file, the environment or the GitHub CLI", async () => {
    const token = makeToken();
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("{}"));
    const base = { companyId: COMPANY, fetch: fetchSpy, gh: vi.fn(async () => undefined as string | undefined) };
    const fromKeys = await githubTokenCodeHost({ ...registered, ...base, keyFile: keysWith(token), environment: { GH_TOKEN: "other" } }).resolveCredentials!();
    expect(fromKeys).toEqual({ found: true, source: "the key file", summary: "A GitHub token is available from the key file." });
    const fromEnvironment = await githubTokenCodeHost({ ...registered, ...base, keyFile: emptyKeys, environment: { GH_TOKEN: token } }).resolveCredentials!();
    expect(fromEnvironment).toMatchObject({ found: true, source: "the environment" });
    const cli = vi.fn(async (args: readonly string[]) => (args[1] === "status" ? "Logged in" : token));
    const fromCli = await githubTokenCodeHost({ ...registered, ...base, gh: cli, keyFile: emptyKeys, environment: {} }).resolveCredentials!();
    expect(fromCli).toMatchObject({ found: true, source: "the GitHub CLI" });
    // Only whether the CLI is signed in is asked; its token is not fetched for this.
    expect(cli.mock.calls.map(([args]) => args[1])).toEqual(["status"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const found of [fromKeys, fromEnvironment, fromCli]) expect(JSON.stringify(found)).not.toContain(token);
  });

  it("says how to sign in when there is none, and what to fix when the key file cannot be read", async () => {
    const none = await githubTokenCodeHost({ ...registered, companyId: COMPANY, keyFile: emptyKeys, environment: {}, gh: async () => undefined }).resolveCredentials!();
    expect(none).toMatchObject({ found: false, summary: "No GitHub access was found." });
    expect(none.fix).toContain("gh auth login");
    const dir = await mkdtemp(join(tmpdir(), "rovara-l11-keys-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "keys.json");
    await writeFile(file, '{"github":"x"}', { mode: 0o600 });
    await chmod(file, 0o644);
    const unreadable = await githubTokenCodeHost({ ...registered, companyId: COMPANY, keyFile: createFileModelKeyStore(file), environment: {}, keyFilePath: file }).resolveCredentials!();
    expect(unreadable).toMatchObject({ found: false });
    expect(unreadable.summary).toContain("must not be readable by other users");
    expect(unreadable.fix).toBe(`Fix the file's permissions with \`chmod 600 ${file}\`.`);
    expect(JSON.stringify(unreadable)).not.toContain('"x"');
  });
});

describe("checkAccess warns about a token that reaches every repository (M1, L6)", () => {
  const check = async (token: string, headers: Record<string, string>, extra: { allowBroadTokenForWorker?: boolean; source?: "gh" } = {}) => {
    const host = githubTokenCodeHost({
      ...registered, companyId: COMPANY, keyFile: emptyKeys, environment: extra.source === "gh" ? {} : { GH_TOKEN: token }, allowBroadTokenForWorker: extra.allowBroadTokenForWorker === true,
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
    const host = githubTokenCodeHost({ ...registered, companyId: COMPANY, keyFile: emptyKeys, environment: { GH_TOKEN: makeBroadToken() }, fetch: async () => new Response("{}", { status: 401 }), gh: async () => undefined });
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
    return { token, fetchSpy, host: githubTokenCodeHost({ ...registered, companyId: COMPANY, keyFile: keysWith(token), environment: extra.environment ?? {}, fetch: fetchSpy, gh: async () => undefined }) };
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
    const none = await githubTokenCodeHost({ ...registered, companyId: COMPANY, keyFile: emptyKeys, environment: {}, gh: async () => undefined }).checkAccess!();
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
    ...registered, companyId: COMPANY, keyFile: source === "keys" ? keysWith(token) : emptyKeys, environment: source === "environment" ? { GH_TOKEN: token } : {},
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

  it("reads the sign-in again after 30 seconds, so a new `gh auth login` is picked up without a restart", async () => {
    const first = makeToken();
    const second = makeToken();
    let current = first;
    let now = NOW;
    const model = new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" });
    const seen: string[] = [];
    const host = githubTokenCodeHost({
      ...registered, companyId: COMPANY, keyFile: emptyKeys, environment: {}, gh: async (args) => (args[1] === "status" ? "ok" : `${current}\n`), now: () => now,
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
