// Lane L4-LM1b (revert detection): the code host port's `recentCommits` read as the GitHub adapter gives it, over the fake GitHub HTTP server (tests/support/ports/github-fixture-api.ts; never the real GitHub). It proves the
// adapter's own mapping and bounds only (one request, read-only token, the web committer decided by account id, untrusted fields checked); it does not prove GitHub answers this way.
import { describe, expect, it } from "vitest";
import { RECENT_COMMITS_MAX, RECENT_COMMIT_MESSAGE_MAX, RecentCommitsReadSchema, hostRateLimitRetryAt } from "@agentx/contracts";
import { FakeHostModel } from "@agentx/broker/fakes";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { GITHUB_ORG_SCOPE, GITHUB_REPO_URL, GitHubFixtureApi, providerOver } from "../support/ports/github-fixture-api.js";
import { webhookSecretReader } from "../support/ports/github-deliveries.js";

const NOW = Date.parse("2026-10-30T10:00:00.000Z");
const sha = (n: number): string => n.toString(16).padStart(40, "a");

function world() {
  const model = new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" });
  const api = new GitHubFixtureApi(model);
  const provider = providerOver(api);
  const host = githubCodeHost(provider, { credentialRef: "github", now: () => NOW, webhookSecret: webhookSecretReader() });
  return { model, api, host, repository: { url: GITHUB_REPO_URL } };
}
const row = (n: number, over: Record<string, unknown> = {}) => ({
  sha: sha(n), commit: { message: `Revert "Add retry" (#${String(n)})\n\nThis reverts commit ${sha(1)}.`, verification: { verified: true } }, parents: [{ sha: sha(n - 1) }],
  author: { login: "maya", id: 10, type: "User" }, committer: { login: "web-flow", id: 19864447, type: "User" }, ...over,
});

describe("the recentCommits read", () => {
  it("is ONE read-only request for the branch with the count asked, with a contents-read token for this one repository", async () => {
    const { api, host, repository } = world();
    api.recentCommits.rows = [row(5), row(4)];
    const read = await host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 50 });
    expect(api.recentCommitRequests).toEqual([{ sha: "main", perPage: "50" }]);
    expect(api.requests.filter((request) => request.method === "GET" && /\/commits(\?|$)/u.test(request.path))).toHaveLength(1);
    expect(api.tokens.at(-1)).toMatchObject({ permissions: { contents: "read" }, repositories: ["app"] });
    expect(Object.keys(api.tokens.at(-1)!.permissions)).toEqual(["contents"]);
    expect(api.requests.filter((request) => request.method !== "GET" && !/\/access_tokens$/u.test(request.path))).toEqual([]);
    expect(read.complete).toBe(true);
    expect(read.commits).toHaveLength(2);
    expect(RecentCommitsReadSchema.safeParse(read).success).toBe(true);
  });

  it("maps each commit to what a revert check needs: message, parent count, verification, the author and committer by login and numeric id", async () => {
    const { api, host, repository } = world();
    api.recentCommits.rows = [row(5, { parents: [{ sha: sha(1) }, { sha: sha(2) }], commit: { message: "Merge", verification: { verified: false } } })];
    const [commit] = (await host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 10 })).commits;
    expect(commit).toEqual({ sha: sha(5), message: "Merge", parents: 2, verified: false, author: { login: "maya", hostUserId: "10" }, authorIsBot: false, committer: { login: "web-flow", hostUserId: "19864447" }, webFlow: true });
  });

  it("the web committer is decided by the numeric account id only: a person named web-flow, or a message that says so, is not it", async () => {
    const { api, host, repository } = world();
    api.recentCommits.rows = [
      row(5, { committer: { login: "web-flow", id: 123, type: "User" } }),
      row(4, { committer: { login: "someone", id: 19864447, type: "User" } }),
      row(3, { commit: { message: "Committed via web-flow\n\nCo-authored-by: GitHub <noreply@github.com>", verification: { verified: true } }, committer: { login: "maya", id: 10, type: "User" } }),
    ];
    const read = await host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 10 });
    expect(read.commits.map((commit) => commit.webFlow === true)).toEqual([false, true, false]);
  });

  it("a bot author is marked, by account type or by a [bot] login; an author or committer GitHub could not link is simply absent", async () => {
    const { api, host, repository } = world();
    api.recentCommits.rows = [row(5, { author: { login: "dependabot[bot]", id: 7, type: "Bot" } }), row(4, { author: { login: "ci[bot]", id: 8, type: "User" } }), row(3, { author: null, committer: null })];
    const read = await host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 10 });
    expect(read.commits.map((commit) => commit.authorIsBot)).toEqual([true, true, undefined]);
    expect(read.commits[2]).toMatchObject({ sha: sha(3) });
    expect(read.commits[2]!.author).toBeUndefined();
    expect(read.commits[2]!.committer).toBeUndefined();
  });

  it("cuts a message at the port's bound, and keeps the top lines (the subject and the 'This reverts' line)", async () => {
    const { api, host, repository } = world();
    api.recentCommits.rows = [row(5, { commit: { message: `Revert "x"\n\nThis reverts commit ${sha(1)}.\n${"y".repeat(RECENT_COMMIT_MESSAGE_MAX * 2)}`, verification: { verified: true } } })];
    const [commit] = (await host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 10 })).commits;
    expect(commit!.message).toHaveLength(RECENT_COMMIT_MESSAGE_MAX);
    expect(commit!.message.startsWith(`Revert "x"\n\nThis reverts commit ${sha(1)}.`)).toBe(true);
  });

  it("says the list is not the whole when GitHub has another page, or an entry was unusable (that entry is left out, never guessed)", async () => {
    const { api, host, repository } = world();
    api.recentCommits.rows = [row(5)];
    api.recentCommits.next = true;
    expect((await host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 10 })).complete).toBe(false);
    api.recentCommits.next = false;
    api.recentCommits.rows = [row(5), { sha: "not-a-sha", commit: { message: "x" }, parents: [] }, { sha: sha(3), commit: { message: 42 }, parents: [] }, row(2)];
    const read = await host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 10 });
    expect(read.commits.map((commit) => commit.sha)).toEqual([sha(5), sha(2)]);
    expect(read.complete).toBe(false);
  });

  it("refuses an answer that is not a list, or has more commits than asked, as unavailable (never as 'no commits')", async () => {
    const { api, host, repository } = world();
    api.recentCommits.rows = [row(5), row(4), row(3)];
    await expect(host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 2 })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    api.recentCommits.http = 500;
    await expect(host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 2 })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("refuses a branch name or count the port does not allow, before any request", async () => {
    const { api, host, repository } = world();
    for (const branch of ["", "bad\u0000name", "a".repeat(300)]) await expect(host.recentCommits!(repository, branch, GITHUB_ORG_SCOPE, { max: 10 }), branch).rejects.toThrow();
    for (const max of [0, -1, 1.5, RECENT_COMMITS_MAX + 1, Number.NaN]) await expect(host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max }), String(max)).rejects.toThrow();
    expect(api.recentCommitRequests).toEqual([]);
  });

  it("counts the request against the pass's allowance, and stops with the allowance's own error when it is used up", async () => {
    const { api, host, repository } = world();
    api.recentCommits.rows = [row(5)];
    let counted = 0;
    await host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 10 }, { beforeRequest: () => { counted += 1; } });
    expect(counted).toBe(1);
    const exhausted = new Error("allowance used up");
    await expect(host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 10 }, { beforeRequest: () => { throw exhausted; } })).rejects.toBe(exhausted);
  });

  it("tells a rate limit from a refusal with the neutral signal", async () => {
    const { api, host, repository } = world();
    api.recentCommits.http = 429;
    api.recentCommits.headers = { "retry-after": "120" };
    expect(hostRateLimitRetryAt(await host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 10 }).catch((error: unknown) => error))).toBe(NOW + 120_000);
    api.recentCommits.http = 403;
    api.recentCommits.headers = {};
    api.recentCommits.message = "You have exceeded a secondary rate limit.";
    expect(hostRateLimitRetryAt(await host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 10 }).catch((error: unknown) => error))).toBeGreaterThan(NOW);
    api.recentCommits.message = undefined;
    expect(hostRateLimitRetryAt(await host.recentCommits!(repository, "main", GITHUB_ORG_SCOPE, { max: 10 }).catch((error: unknown) => error))).toBeUndefined();
  });

  it("is checked against the port's schema: an entry it does not name is refused, not passed on", () => {
    expect(RecentCommitsReadSchema.safeParse({ commits: [{ sha: sha(1), message: "x", parents: 1, verified: true, extra: 1 }], complete: true }).success).toBe(false);
    expect(RecentCommitsReadSchema.safeParse({ commits: Array.from({ length: RECENT_COMMITS_MAX + 1 }, (_, i) => ({ sha: sha(i + 1), message: "x", parents: 1, verified: true })), complete: true }).success).toBe(false);
  });
});
