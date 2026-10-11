// The E2E harness's GitHub behaves like GitHub where AgentX has been caught out live: a pull request's head lags a push,
// reviews and inline comments arrive with their own IDs (GraphQL sends database IDs as strings), and any call can fail.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { FakeGitHub } from "../support/workflow-e2e-github.js";

const REPO = "https://github.com/example/demo.git";
const BRANCH = "agentx/0b7f8a52-6a4c-4c1e-9d0e-0f2a6f1e9c11";
const sha = (seed: string) => seed.repeat(40).slice(0, 40);

async function openPullRequest(github: FakeGitHub): Promise<{ push: string; number: number }> {
  const { token: push } = await github.resolveCredential("github-app", REPO, "push");
  github.commits.set(sha("b"), sha("e"));
  github.push(push, BRANCH, sha("a"), sha("1"), [sha("b")]);
  const { number } = await github.gateway.reconcilePullRequest({ repositoryUrl: REPO, headBranch: BRANCH, baseBranch: "main", title: "t", draft: true });
  return { push, number };
}

describe("FakeGitHub v2", () => {
  it("lags a pull request's head behind a push to its branch for one read by default; the branch head is current at once", async () => {
    const github = new FakeGitHub();
    const { push, number } = await openPullRequest(github);
    github.push(push, BRANCH, sha("c"), sha("2"), [sha("a")]);
    expect(await github.gateway.getBranchHead(REPO, BRANCH)).toBe(sha("c"));
    expect((await github.gateway.getPullRequest(REPO, number)).headCommit).toBe(sha("a"));
    expect((await github.gateway.getPullRequest(REPO, number)).headCommit).toBe(sha("c"));
    // The record of the truth is current; only reads lag.
    expect(github.pullRequests[0]).toMatchObject({ commit: sha("c"), tree: sha("2") });
  });

  it("lag({ prHeadReads }) sets how many reads lag, across getPullRequest and getPullRequestFeedback (head and tree)", async () => {
    const github = new FakeGitHub();
    github.lag({ prHeadReads: 2 });
    const { push, number } = await openPullRequest(github);
    github.push(push, BRANCH, sha("c"), sha("2"), [sha("a")]);
    const feedback = await github.gateway.getPullRequestFeedback(REPO, number);
    expect(feedback.pullRequest).toMatchObject({ headCommit: sha("a"), headTreeSha: sha("1") });
    expect((await github.gateway.getPullRequest(REPO, number)).headCommit).toBe(sha("a"));
    expect((await github.gateway.getPullRequestFeedback(REPO, number)).pullRequest).toMatchObject({ headCommit: sha("c"), headTreeSha: sha("2") });
  });

  it("does not lag a pull request opened after the push, and the opt-out turns lag off", async () => {
    const github = new FakeGitHub();
    const { number } = await openPullRequest(github);
    expect((await github.gateway.getPullRequest(REPO, number)).headCommit).toBe(sha("a"));
    // No lag: a unit test of the fake itself.
    const instant = new FakeGitHub({ realism: { lag: false } });
    const opened = await openPullRequest(instant);
    instant.push(opened.push, BRANCH, sha("c"), sha("2"), [sha("a")]);
    expect((await instant.gateway.getPullRequest(REPO, opened.number)).headCommit).toBe(sha("c"));
  });

  it("review() makes a review item and inline comments in new threads; a blank or pending review is not feedback", async () => {
    const github = new FakeGitHub();
    const { number } = await openPullRequest(github);
    const made = github.review(number, "octocat", { body: "Looks close.", state: "CHANGES_REQUESTED", comments: [{ body: "Trim this.", path: "greeting.ts", line: 2 }] });
    expect(made.review.id).toMatch(/^review:\d+$/);
    expect(made.review.url).toBe(`https://github.com/example/demo/pull/${number}#pullrequestreview-${made.review.id.slice("review:".length)}`);
    expect(made.comments).toEqual([expect.objectContaining({ kind: "REVIEW_COMMENT", path: "greeting.ts", line: 2, body: "Trim this." })]);
    github.review(number, "octocat", { body: null, state: "APPROVED" });
    github.review(number, "octocat", { body: "draft", state: "PENDING" });
    await github.gateway.getPullRequest(REPO, number);
    const feedback = await github.gateway.getPullRequestFeedback(REPO, number);
    expect(feedback.comments.map((comment) => comment.kind)).toEqual(["REVIEW", "REVIEW_COMMENT"]);
    expect(feedback.threads).toEqual([{ id: made.comments[0]!.threadId, resolved: false, commentIds: [made.comments[0]!.id] }]);
  });

  it("edits, deletes and resolves", async () => {
    const github = new FakeGitHub();
    const { number } = await openPullRequest(github);
    const discussion = github.comment(number, "octocat", "first");
    expect(discussion.id).toMatch(/^discussion:\d+$/);
    const inline = github.reviewComment(number, "octocat", "inline", "greeting.ts", 1);
    github.editComment(discussion.id, "edited");
    github.resolveThread(inline.threadId!);
    let feedback = await github.gateway.getPullRequestFeedback(REPO, number);
    expect(feedback.comments.find((comment) => comment.id === discussion.id)?.body).toBe("edited");
    expect(feedback.threads[0]?.resolved).toBe(true);
    github.deleteComment(inline.id);
    feedback = await github.gateway.getPullRequestFeedback(REPO, number);
    expect(feedback.comments.map((comment) => comment.id)).toEqual([discussion.id]);
    expect(feedback.threads).toEqual([]);
  });

  it("foreignPush() moves the branch to a commit AgentX did not make; close() closes without merging", async () => {
    const github = new FakeGitHub({ realism: { lag: false } });
    const { number } = await openPullRequest(github);
    const foreign = github.foreignPush(number);
    expect(foreign.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await github.gateway.getBranchHead(REPO, BRANCH)).toBe(foreign.commit);
    expect(await github.gateway.getCommitParents(REPO, foreign.commit)).toEqual([sha("a")]);
    expect(github.minted.some((entry) => entry.token === github.pushes.get(BRANCH)?.token)).toBe(false);
    github.close(number);
    expect((await github.gateway.getPullRequest(REPO, number)).state).toBe("closed");
  });

  it("failNext() fails the next call of a gateway method, or a push, once", async () => {
    const github = new FakeGitHub();
    const { push, number } = await openPullRequest(github);
    github.failNext("getPullRequest", 502);
    await expect(github.gateway.getPullRequest(REPO, number)).rejects.toThrow(/HTTP 502/);
    await expect(github.gateway.getPullRequest(REPO, number)).resolves.toMatchObject({ number });
    github.failNext("getBranchHead", new Error("socket hang up"));
    await expect(github.gateway.getBranchHead(REPO, BRANCH)).rejects.toThrow("socket hang up");
    github.failNext("push", 403);
    expect(() => github.push(push, BRANCH, sha("c"), sha("2"), [sha("a")])).toThrow(/403/);
    expect(github.pushes.get(BRANCH)?.commit).toBe(sha("a"));
    expect(() => github.failNext("noSuchMethod" as never, 500)).toThrow(/no method/);
  });

  it("failNext() reports a status as the real client does: a missing file or repository is an answer, a feedback read is refused", async () => {
    const github = new FakeGitHub();
    const { number } = await openPullRequest(github);
    github.files.set("greeting.ts", "x");
    github.failNext("getFileAtCommit", 404);
    await expect(github.gateway.getFileAtCommit(REPO, "greeting.ts")).resolves.toBeUndefined();
    github.failNext("verifyWebhookRepository", 404);
    await expect(github.gateway.verifyWebhookRepository()).resolves.toBe(false);
    github.failNext("getFileAtCommit", 500);
    await expect(github.gateway.getFileAtCommit(REPO, "greeting.ts")).rejects.toThrow("GitHub getFileAtCommit failed with HTTP 500");
    github.failNext("getPullRequestFeedback", 502);
    await expect(github.gateway.getPullRequestFeedback(REPO, number)).rejects.toThrow("GitHub feedback read refused: head commit lookup HTTP 502");
  });

  it("atOneMoment() shows every read of a pull request inside it the same head, and the lag counts once", async () => {
    const github = new FakeGitHub();
    github.lag({ prHeadReads: 2 });
    const { push, number } = await openPullRequest(github);
    github.push(push, BRANCH, sha("c"), sha("2"), [sha("a")]);
    const heads = await github.atOneMoment(async () => [
      (await github.gateway.getPullRequest(REPO, number)).headCommit, (await github.gateway.getPullRequestFeedback(REPO, number)).pullRequest.headCommit,
      (await github.gateway.getPullRequest(REPO, number)).headCommit,
    ]);
    expect(heads).toEqual([sha("a"), sha("a"), sha("a")]);
    expect((await github.gateway.getPullRequest(REPO, number)).headCommit).toBe(sha("a"));
    expect((await github.gateway.getPullRequest(REPO, number)).headCommit).toBe(sha("c"));
  });

  describe("wire mode", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const provider = (github: FakeGitHub) => new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: "123", getPrivateKey: async () => privateKey, fetchImplementation: github.fetch });

    it("serves the real provider's feedback read, with GraphQL database IDs as strings", async () => {
      const github = new FakeGitHub({ realism: { lag: false } });
      const { number } = await openPullRequest(github);
      const discussion = github.comment(number, "octocat", "Please trim.");
      const made = github.review(number, "hubot", { body: "Two notes.", state: "COMMENTED", comments: [{ body: "Here.", path: "greeting.ts", line: 2 }] });
      github.review(number, "hubot", { body: null, state: "APPROVED" });
      const feedback = await provider(github).getPullRequestFeedback(REPO, number);
      expect(feedback.pullRequest).toMatchObject({ number, headCommit: sha("a"), headTreeSha: sha("1"), state: "open", headBranch: BRANCH });
      expect(feedback.comments.map((comment) => comment.id).sort()).toEqual([discussion.id, made.review.id, made.comments[0]!.id].sort());
      expect(feedback.threads).toEqual([{ id: made.comments[0]!.threadId, resolved: false, commentIds: [made.comments[0]!.id] }]);
      expect(github.graphqlDatabaseIdTypes()).toEqual(new Set(["string"]));
      // The App's installation tokens are read-only for a feedback read.
      expect(github.appTokens.map((entry) => entry.permissions)).toEqual([{ contents: "read", pull_requests: "read", issues: "read" }]);
    });

    it("lags the PR head on the wire too, so a read straight after a push sees the old head", async () => {
      const github = new FakeGitHub();
      const { push, number } = await openPullRequest(github);
      github.push(push, BRANCH, sha("c"), sha("2"), [sha("a")]);
      expect((await provider(github).getPullRequest(REPO, number)).headCommit).toBe(sha("a"));
      expect((await provider(github).getPullRequest(REPO, number)).headCommit).toBe(sha("c"));
      expect(await provider(github).getBranchHead(REPO, BRANCH)).toBe(sha("c"));
    });
  });
});
