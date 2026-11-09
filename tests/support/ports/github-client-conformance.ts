// Port lane L7a: the GitHub client conformance suite (DEFERRED-CHECKS.md, "L2 GitHub client conformance").
//
// Every client put under the GitHub adapters (`GitHubCodeHostProvider`) runs this suite. It does not look at what the client returns; the CodeHost contract does that. It looks at
// what the client DOES on the network and with its tenant, the rules written on `GitHubCodeHostProvider`:
//   1. Tenant binding on every call: each call that names a tenant asks the binding hook again (a repeat, a cached installation and a cached token included), and a refused binding
//      stops the call before a token is minted or a repository is read.
//   2. Least privilege: a clone credential is minted with `contents: read` and a push credential with `contents: write`, nothing else, for the ONE repository asked for; no call
//      mints a token for more than one repository, and a read never mints a write permission.
//   3. No redirects, bounded requests: every request refuses redirects (or handles the one redirect GitHub documents by itself, with an allow-list) and carries a timeout; a redirect
//      answer is never followed to another host with a token.
//   4. A rate limit is the neutral `HostRateLimitError`; a branch name or a path never reaches an address unchecked.
//
// The network is a fake GitHub (`tests/support/ports/github-fixture-api.ts`), never the real one. `RecordingNetwork` wraps its `fetch` and records what the client asked for, including
// the `redirect` and `signal` options, and it follows redirects the way `fetch` does so that a client that forgot `redirect: "error"` is caught following one.
import { expect } from "vitest";
import { hostRateLimitRetryAt, type HostScope } from "../../../packages/contracts/src/index.js";
import type { GitHubCodeHostProvider } from "../../../packages/broker/src/plugins/code-host/github/provider.js";

export interface RecordedRequest {
  method: string;
  url: URL;
  /** The `redirect` option the client passed: undefined means `fetch`'s default, which follows. */
  redirect: "error" | "follow" | "manual" | undefined;
  hasSignal: boolean;
  /** The request body when it was text. */
  body: string | undefined;
  /** The request reached this address by a redirect `fetch` followed on the client's behalf. */
  viaRedirect: boolean;
}

/** Wraps a fake GitHub's `fetch`: records every request, applies `redirect` semantics, and can answer every request after the first token mint with a redirect or a rate limit. */
export class RecordingNetwork {
  readonly requests: RecordedRequest[] = [];
  private redirectTo: string | undefined;
  private limitedForSeconds: number | undefined;

  constructor(private readonly inner: typeof fetch) {}

  /** From now on every request that is not the installation lookup or the token mint is answered `302` to `location`. */
  redirectEverythingTo(location: string | undefined): void { this.redirectTo = location; }
  /** From now on every request is answered `429`. */
  limitEverythingFor(seconds: number | undefined): void { this.limitedForSeconds = seconds; }
  clear(): void { this.requests.length = 0; }
  /** The `POST .../access_tokens` bodies, parsed. */
  tokenRequests(): Array<{ permissions: Record<string, string>; repositories: string[] | undefined }> {
    return this.requests.filter((request) => request.method === "POST" && /\/access_tokens$/u.test(request.url.pathname)).map((request) => {
      const body = JSON.parse(request.body ?? "{}") as { permissions?: Record<string, string>; repositories?: string[] };
      return { permissions: body.permissions ?? {}, repositories: body.repositories };
    });
  }
  /** Requests that read a repository or used an installation token: everything but the App's own lookups (`/app`, `/repos/.../installation`). */
  repositoryReads(): RecordedRequest[] {
    return this.requests.filter((request) => request.url.pathname !== "/app" && !/\/installation$/u.test(request.url.pathname));
  }
  /** Where requests went, as hosts. */
  hosts(): string[] { return [...new Set(this.requests.map((request) => request.url.host))]; }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return this.serve(url, init, false);
  };

  private async serve(url: URL, init: RequestInit | undefined, viaRedirect: boolean): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    this.requests.push({
      method, url, redirect: init?.redirect, hasSignal: init?.signal !== undefined && init.signal !== null, body: typeof init?.body === "string" ? init.body : undefined, viaRedirect,
    });
    const isAppLookup = url.pathname === "/app" || /\/installation$/u.test(url.pathname) || /\/access_tokens$/u.test(url.pathname);
    if (this.limitedForSeconds !== undefined) return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(this.limitedForSeconds) } });
    if (this.redirectTo !== undefined && !isAppLookup && !viaRedirect) {
      const redirect = init?.redirect;
      if (redirect === "error") throw new TypeError("fetch failed: redirect mode is set to error");
      const answer = new Response(null, { status: 302, headers: { location: this.redirectTo } });
      if (redirect === "manual") return answer;
      // fetch's default: follow, with the same options.
      return this.serve(new URL(this.redirectTo), init, true);
    }
    return this.inner(url, init);
  }
}

/** What the client's tenant-binding hook was asked, and a way to make it refuse. */
export class TenantBinding {
  readonly calls: Array<{ orgId: string; installationId: number; repository: string | undefined }> = [];
  private refused = new Set<string>();
  refuse(orgId: string): void { this.refused.add(orgId); }
  allowAll(): void { this.refused.clear(); }
  readonly hook = async (orgId: string, installationId: number, repository?: { owner: string; name: string }): Promise<void> => {
    this.calls.push({ orgId, installationId, repository: repository === undefined ? undefined : `${repository.owner}/${repository.name}` });
    if (this.refused.has(orgId)) throw Object.assign(new Error("the installation is not bound to this organization"), { name: "AgentXError", code: "GITHUB_NOT_CONNECTED" });
  };
}

export interface GitHubClientFixture {
  /** A pull request of the repository, open, with a review comment in a thread. */
  number: number;
  headSha: string;
  commentId: string;
}

export interface GitHubClientWorld {
  client: GitHubCodeHostProvider;
  net: RecordingNetwork;
  binding: TenantBinding;
  /** The repository the App is installed on. */
  repositoryUrl: string;
  /** A repository the App is not installed on. */
  strangerUrl: string;
  /** The credential reference the client was configured with. */
  credentialRef: string;
  /** The organization scope calls are made for, and another organization's. */
  scope: { orgId: string };
  otherScope: { orgId: string };
  /** The installation and repository ids the fake GitHub holds (for the branch listing). */
  installationId: number;
  repositoryId: number;
  /** Puts a pull request in the fake GitHub, and answers where it is. */
  prepare(): Promise<GitHubClientFixture>;
}

interface Operation {
  name: string;
  /** Reads only: its tokens must not carry a write permission. */
  readOnly: boolean;
  /** Names a tenant (a scope): the binding hook must be asked. */
  tenant: boolean;
  run(world: GitHubClientWorld, fixture: GitHubClientFixture, scope: HostScope): Promise<unknown>;
}

const budget = () => ({ signal: new AbortController().signal, beforeRequest: () => undefined });

/** Every method of `GitHubCodeHostProvider` that makes a request, called with arguments that reach the network. */
function operations(): Operation[] {
  const op = (name: string, readOnly: boolean, run: Operation["run"], tenant = true): Operation => ({ name, readOnly, tenant, run });
  return [
    op("getRepositoryIdentity", true, (w, _f, s) => w.client.getRepositoryIdentity(w.repositoryUrl, s)),
    op("checkRepository", true, (w, _f, s) => w.client.checkRepository({ credentialRef: w.credentialRef, url: w.repositoryUrl }, s)),
    op("getRepositoryStanding", true, (w, _f, s) => w.client.getRepositoryStanding(w.repositoryUrl, "priya", s, budget())),
    op("resolveWithExpiry:clone", true, (w, _f, s) => w.client.resolveWithExpiry(w.credentialRef, w.repositoryUrl, "clone", s)),
    op("resolveWithExpiry:push", false, (w, _f, s) => w.client.resolveWithExpiry(w.credentialRef, w.repositoryUrl, "push", s)),
    op("getFileAtCommit", true, (w, f, s) => w.client.getFileAtCommit(w.repositoryUrl, "src/a.ts", f.headSha, s)),
    op("getPathKindAtCommit", true, (w, f, s) => w.client.getPathKindAtCommit?.(w.repositoryUrl, "src/a.ts", f.headSha, s) ?? Promise.resolve("none")),
    op("getCommitTree", true, (w, f, s) => w.client.getCommitTree(w.repositoryUrl, f.headSha, s)),
    op("getBranchHead", true, (w, _f, s) => w.client.getBranchHead(w.repositoryUrl, WORKING_BRANCH, s)),
    op("listWorkingBranches", true, (w, _f, s) => w.client.listWorkingBranches(w.repositoryUrl, { installationId: w.installationId, repositoryId: w.repositoryId }, s, 1)),
    op("getCommitParents", true, (w, f, s) => w.client.getCommitParents(w.repositoryUrl, f.headSha, s)),
    op("getDefaultBranchHead", true, (w, _f, s) => w.client.getDefaultBranchHead(w.repositoryUrl, "main", s)),
    op("getPullRequestMergeObservation", true, (w, f, s) => w.client.getPullRequestMergeObservation(w.repositoryUrl, f.number, budget(), s)),
    op("readCodeOwners", true, (w, _f, s) => w.client.readCodeOwners(w.repositoryUrl, "main", s)),
    op("reconcilePullRequest", false, (w, _f, s) => w.client.reconcilePullRequest({ repositoryUrl: w.repositoryUrl, headBranch: WORKING_BRANCH, baseBranch: "main", title: "Add a" }, s)),
    op("getPullRequest", true, (w, f, s) => w.client.getPullRequest(w.repositoryUrl, f.number, s)),
    op("updatePullRequest", false, (w, f, s) => w.client.updatePullRequest(w.repositoryUrl, f.number, { title: "Add a (edited)" }, s)),
    op("getPullRequestStatus", true, (w, f, s) => w.client.getPullRequestStatus(w.repositoryUrl, f.number, s, budget())),
    op("listPullRequestFiles", true, (w, f, s) => w.client.listPullRequestFiles(w.repositoryUrl, f.number, { page: 1 }, s)),
    op("getPullRequestFeedback", true, (w, f, s) => w.client.getPullRequestFeedback(w.repositoryUrl, f.number, s)),
    op("replyToReviewThread", false, (w, f, s) => w.client.replyToReviewThread(w.repositoryUrl, f.number, f.commentId, "Fixed in the latest push.", s, budget())),
    op("markPullRequestReady", false, (w, f, s) => w.client.markPullRequestReady(w.repositoryUrl, f.number, s, budget())),
    op("requestReviewers", false, (w, f, s) => w.client.requestReviewers(w.repositoryUrl, f.number, ["priya"], s, budget())),
    op("mergePullRequest", false, (w, f, s) => w.client.mergePullRequest(w.repositoryUrl, f.number, { sha: f.headSha, method: "squash" }, s)),
    op("getJobLogTail", true, (w, _f, s) => w.client.getJobLogTail(w.repositoryUrl, "4321", s, budget())),
    // No tenant: the lookup reads no organization's binding; its callers hand the answer to the hook.
    op("installationForRepository", true, (w) => w.client.installationForRepository("acme", "app", { fresh: true }), false),
  ];
}

const WORKING_BRANCH = "agentx/00000000-0000-4000-8000-000000000001";

/** Runs one operation and swallows what it throws: the suites below look at what it did, not at whether GitHub's fake had something to answer. */
async function attempt(run: () => Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

const writes = (permissions: Record<string, string>): string[] => Object.entries(permissions).filter(([, level]) => level !== "read").map(([name]) => name);

export interface GitHubClientConformanceCheck {
  readonly name: string;
  run(world: GitHubClientWorld): Promise<void>;
}

export const githubClientChecks: readonly GitHubClientConformanceCheck[] = [
  {
    name: "tenant: every call that names a tenant asks the binding, again on a repeat of the same call (installation and token caches do not skip it)",
    async run(world) {
      const fixture = await world.prepare();
      for (const operation of operations().filter((entry) => entry.tenant)) {
        const before = world.binding.calls.length;
        await attempt(() => operation.run(world, fixture, world.scope));
        const first = world.binding.calls.length;
        expect(first, `${operation.name} did not ask the tenant binding`).toBeGreaterThan(before);
        await attempt(() => operation.run(world, fixture, world.scope));
        expect(world.binding.calls.length, `${operation.name} did not ask the tenant binding again on a repeat`).toBeGreaterThan(first);
        expect(world.binding.calls.slice(before).every((call) => call.orgId === world.scope.orgId), `${operation.name} asked the binding for another organization`).toBe(true);
      }
    },
  },
  {
    name: "tenant: a refused binding stops every call before a token is minted or a repository is read, even after a warm-up that cached the installation and a read token",
    async run(world) {
      const fixture = await world.prepare();
      // Warm every cache first, so a check that only runs on a cold client would pass here.
      for (const operation of operations().filter((entry) => entry.tenant)) await attempt(() => operation.run(world, fixture, world.scope));
      world.binding.refuse(world.scope.orgId);
      for (const operation of operations().filter((entry) => entry.tenant)) {
        world.net.clear();
        const result = await attempt(() => operation.run(world, fixture, world.scope));
        expect(result.ok, `${operation.name} answered although the tenant binding was refused`).toBe(false);
        expect(world.net.tokenRequests(), `${operation.name} minted a token after the binding was refused`).toEqual([]);
        expect(world.net.repositoryReads().map((request) => `${request.method} ${request.url.pathname}`), `${operation.name} read the repository after the binding was refused`).toEqual([]);
      }
    },
  },
  {
    name: "tenant: another organization's refusal does not stop this organization, and its own scope is the one asked",
    async run(world) {
      const fixture = await world.prepare();
      world.binding.refuse(world.otherScope.orgId);
      expect((await attempt(() => world.client.getPullRequest(world.repositoryUrl, fixture.number, world.otherScope))).ok).toBe(false);
      expect((await attempt(() => world.client.getPullRequest(world.repositoryUrl, fixture.number, world.scope))).ok).toBe(true);
      expect(world.binding.calls.some((call) => call.orgId === world.otherScope.orgId)).toBe(true);
    },
  },
  {
    name: "tenant: a repository the App is not installed on gets no token and no read",
    async run(world) {
      await world.prepare();
      world.net.clear();
      const result = await attempt(() => world.client.resolveWithExpiry(world.credentialRef, world.strangerUrl, "clone", world.scope));
      expect(result.ok).toBe(false);
      expect(world.net.tokenRequests()).toEqual([]);
      const read = await attempt(() => world.client.getFileAtCommit(world.strangerUrl, "src/a.ts", "a".repeat(40), world.scope));
      expect(read.ok).toBe(false);
      expect(world.net.tokenRequests()).toEqual([]);
    },
  },
  {
    name: "credentials: a clone credential is minted with contents read and a push credential with contents write, nothing else, for the one repository",
    async run(world) {
      await world.prepare();
      world.net.clear();
      await world.client.resolveWithExpiry(world.credentialRef, world.repositoryUrl, "clone", world.scope);
      expect(world.net.tokenRequests()).toEqual([{ permissions: { contents: "read" }, repositories: ["app"] }]);
      world.net.clear();
      await world.client.resolveWithExpiry(world.credentialRef, world.repositoryUrl, "push", world.scope);
      expect(world.net.tokenRequests()).toEqual([{ permissions: { contents: "write" }, repositories: ["app"] }]);
    },
  },
  {
    name: "credentials: a push token is not reused for a clone, and a clone token is not reused for a push",
    async run(world) {
      await world.prepare();
      world.net.clear();
      const push = await world.client.resolveWithExpiry(world.credentialRef, world.repositoryUrl, "push", world.scope);
      const clone = await world.client.resolveWithExpiry(world.credentialRef, world.repositoryUrl, "clone", world.scope);
      const again = await world.client.resolveWithExpiry(world.credentialRef, world.repositoryUrl, "push", world.scope);
      expect(world.net.tokenRequests().map((request) => request.permissions.contents)).toEqual(["write", "read", "write"]);
      expect(new Set([push.password, clone.password, again.password]).size).toBe(3);
    },
  },
  {
    name: "credentials: a credential carries the expiry GitHub stated, or none when it stated none",
    async run(world) {
      await world.prepare();
      const credential = await world.client.resolveWithExpiry(world.credentialRef, world.repositoryUrl, "clone", world.scope);
      expect(credential.username).toBe("x-access-token");
      expect(typeof credential.password).toBe("string");
      expect(Number.isFinite(Date.parse(credential.expiresAt ?? ""))).toBe(true);
      // A credential reference the client was not set up with is no credential at all.
      expect(await world.client.resolveWithExpiry("another-reference", world.repositoryUrl, "clone", world.scope)).toEqual({});
    },
  },
  {
    name: "least privilege: every token any call mints names exactly one repository, the one asked for, and a read never asks for a write permission",
    async run(world) {
      const fixture = await world.prepare();
      for (const operation of operations()) {
        world.net.clear();
        await attempt(() => operation.run(world, fixture, world.scope));
        for (const mint of world.net.tokenRequests()) {
          expect(mint.repositories, `${operation.name} minted a token that is not for the one repository`).toEqual(["app"]);
          if (operation.readOnly) expect(writes(mint.permissions), `${operation.name} is a read and minted ${JSON.stringify(mint.permissions)}`).toEqual([]);
          expect(Object.keys(mint.permissions).length, `${operation.name} minted a token with no permission`).toBeGreaterThan(0);
        }
      }
    },
  },
  {
    name: "network: every request refuses redirects (or handles the one documented redirect itself) and carries a timeout",
    async run(world) {
      const fixture = await world.prepare();
      world.net.clear();
      for (const operation of operations()) await attempt(() => operation.run(world, fixture, world.scope));
      expect(world.net.requests.length).toBeGreaterThan(0);
      const followsRedirects = world.net.requests.filter((request) => request.redirect !== "error" && request.redirect !== "manual").map((request) => `${request.method} ${request.url.pathname}`);
      expect(followsRedirects, "requests that would follow a redirect").toEqual([]);
      const withoutTimeout = world.net.requests.filter((request) => !request.hasSignal).map((request) => `${request.method} ${request.url.pathname}`);
      expect(withoutTimeout, "requests with no timeout or abort signal").toEqual([]);
    },
  },
  {
    name: "network: a redirect answer is never followed to another host, and no installation token is sent anywhere but GitHub",
    async run(world) {
      const fixture = await world.prepare();
      // Get the installation and a read token cached first, so only the redirect is new.
      for (const operation of operations()) await attempt(() => operation.run(world, fixture, world.scope));
      world.net.clear();
      world.net.redirectEverythingTo("https://attacker.example.test/collect");
      for (const operation of operations()) await attempt(() => operation.run(world, fixture, world.scope));
      expect(world.net.hosts().filter((host) => host.includes("attacker")), "a redirect was followed to another host").toEqual([]);
      expect(world.net.requests.filter((request) => request.viaRedirect)).toEqual([]);
    },
  },
  {
    name: "network: a redirect answer is an error for a call, never an answer from the target of the redirect",
    async run(world) {
      const fixture = await world.prepare();
      await attempt(() => world.client.getPullRequest(world.repositoryUrl, fixture.number, world.scope));
      world.net.redirectEverythingTo("https://api.github.com/repos/acme/other");
      for (const operation of operations().filter((entry) => ["getPullRequest", "getPullRequestStatus", "getFileAtCommit", "getCommitTree", "getBranchHead"].includes(entry.name))) {
        const result = await attempt(() => operation.run(world, fixture, world.scope));
        expect(result.ok, `${operation.name} took an answer from a redirect`).toBe(false);
      }
    },
  },
  {
    name: "limits: GitHub's rate limit is the neutral error with a time to try again, not a failure of the pull request",
    async run(world) {
      const fixture = await world.prepare();
      // Warm the installation and tokens, then limit every read.
      await attempt(() => world.client.getPullRequestStatus(world.repositoryUrl, fixture.number, world.scope, budget()));
      world.net.limitEverythingFor(30);
      const result = await attempt(() => world.client.getPullRequestStatus(world.repositoryUrl, fixture.number, world.scope, budget()));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(hostRateLimitRetryAt(result.error)).toBeTypeOf("number");
    },
  },
  {
    name: "inputs: a branch name or a path that is not safe never reaches an address",
    async run(world) {
      const fixture = await world.prepare();
      world.net.clear();
      for (const branch of ["main", "feature/x", "../../orgs/acme", "agentx/../x", "agentx/00000000-0000-4000-8000-00000000000g", "agentx/%2e%2e"]) {
        expect((await attempt(() => world.client.getBranchHead(world.repositoryUrl, branch, world.scope))).ok, `getBranchHead(${branch})`).toBe(false);
      }
      for (const path of ["", "../secrets", "a/../b", "a//b", "a\\b", "./a"]) {
        expect((await attempt(() => world.client.getFileAtCommit(world.repositoryUrl, path, fixture.headSha, world.scope))).ok, `getFileAtCommit(${path})`).toBe(false);
      }
      expect((await attempt(() => world.client.getFileAtCommit(world.repositoryUrl, "src/a.ts", "not-a-sha", world.scope))).ok).toBe(false);
      expect(world.net.repositoryReads().map((request) => request.url.pathname), "a request was made for an unsafe input").toEqual([]);
    },
  },
  {
    name: "inputs: the branch listing is for an organization and takes pages 1 to 1000 only",
    async run(world) {
      await world.prepare();
      world.net.clear();
      const expected = { installationId: world.installationId, repositoryId: world.repositoryId };
      for (const page of [0, -1, 1_001, 1.5]) expect((await attempt(() => world.client.listWorkingBranches(world.repositoryUrl, expected, world.scope, page))).ok, `page ${String(page)}`).toBe(false);
      expect((await attempt(() => world.client.listWorkingBranches(world.repositoryUrl, expected, { system: "private-install" } as never, 1))).ok).toBe(false);
      expect(world.net.tokenRequests()).toEqual([]);
    },
  },
];

/** Registers one test per check on a fresh world. The caller supplies `describe` and `it` (vitest's) so the suite file has no test-runner import of its own. */
export function runGitHubClientConformance(
  label: string,
  makeWorld: () => Promise<GitHubClientWorld> | GitHubClientWorld,
  runner: { describe: (name: string, body: () => void) => void; it: (name: string, body: () => Promise<void>) => void },
): void {
  runner.describe(label, () => {
    for (const check of githubClientChecks) runner.it(check.name, async () => { await check.run(await makeWorld()); });
  });
}
