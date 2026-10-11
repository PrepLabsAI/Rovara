// GitHub as the E2E harness's broker and worker see it. Realistic by default where AgentX has been caught out live:
// a pull request's head lags a push to its branch, reviews and inline comments carry GitHub's own IDs (GraphQL sends
// database IDs as strings), and any call can be made to fail. In wire mode, `fetch` serves the REST and GraphQL
// endpoints the real GitHubAppCredentialProvider calls, so its parsing runs too.
import { createHash } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import type { GitHubFeedbackComment, GitHubFeedbackThread, GitHubPullRequestDetails, GitHubPullRequestFeedback, GitHubPullRequestInput, GitHubPullRequestResult, GitHubPullRequestUpdate } from "../../packages/broker/src/github-app.js";

export type GitHubReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | "DISMISSED";

/** A feedback item as GitHub holds it: the provider's view, plus a review's state and body as GitHub stores them. */
type StoredComment = GitHubFeedbackComment & { reviewState?: GitHubReviewState; rawBody?: string | null };

export type FakePullRequest = {
  number: number; url: string; headBranch: string; baseBranch: string; title: string; body?: string; draft?: boolean;
  /** The true head, as GitHub's branch has it. */
  commit: string; tree: string;
  state: "open" | "closed" | "merged"; comments: StoredComment[]; threads?: GitHubFeedbackThread[];
  /** While set, a read of the pull request still shows this older head (GitHub moves a PR's head a moment after a push). */
  lagged?: { commit: string; tree: string; reads: number };
};

const OWNER = "example";
const NAME = "demo";
const FULL_NAME = `${OWNER}/${NAME}`;
const INSTALLATION_ID = 77;
const API = `https://api.github.com/repos/${OWNER}/${NAME}`;

/** The gateway methods (and `push`) a test can make fail with `failNext`. */
export type FakeGitHubMethod = keyof FakeGitHub["gateway"] | "push";

export interface FakeGitHubOptions {
  /** Realism, on by default. `lag: false` needs a comment at the call site saying why. */
  realism?: { lag?: boolean };
}

/**
 * GitHub as the broker and worker see it: tokens it issued (and for which access), pushes made with them, commit
 * trees, and pull requests opened from a pushed branch.
 */
export class FakeGitHub {
  readonly tokens = new Map<string, "clone" | "push">();
  readonly pushes = new Map<string, { commit: string; tree: string; token: string }>();
  readonly commits = new Map<string, string>();
  /** Each pushed commit's parents. */
  readonly parents = new Map<string, string[]>();
  readonly pullRequests: FakePullRequest[] = [];
  /** The repository's files by path (as GitHub names them, inside the repository), for the plan's cited code. */
  readonly files = new Map<string, string>();
  /** Every token minted, with the kind of worker invocation running when it was (set by the harness). */
  readonly minted: Array<{ token: string; access: "clone" | "push"; during: string | undefined }> = [];
  /** Wire mode: every installation token the App asked for, with its permissions. */
  readonly appTokens: Array<{ token: string; permissions: Record<string, string> }> = [];
  /** The kind of worker invocation now running, or undefined between invocations. */
  during: string | undefined;
  /** Every push that moved a branch, in order, with the kind of worker invocation running when it was (AgentX's, or someone else's). */
  readonly pushLog: Array<{ branch: string; commit: string; tree: string; parents: string[]; token: string; during: string | undefined }> = [];

  private prHeadReads: number;
  private nextId = { discussion: 1_210_000_001, reviewComment: 1_780_000_001, review: 2_340_000_001, foreign: 1 };
  private readonly faults: Array<{ method: FakeGitHubMethod; failure: number | Error; remaining: number }> = [];
  private readonly graphqlIdTypes = new Set<string>();

  constructor(options: FakeGitHubOptions = {}) {
    this.prHeadReads = options.realism?.lag === false ? 0 : 1;
  }

  /** How many reads of a pull request still show its old head after a push to its branch (default 1; 0 turns lag off). */
  lag(options: { prHeadReads: number }): void {
    this.prHeadReads = options.prHeadReads;
  }

  /** Fails the next `times` (default 1) calls of `method` with an HTTP status (as the real client reports it) or an error. */
  failNext(method: FakeGitHubMethod, failure: number | Error, times = 1): void {
    if (method !== "push" && !(method in this.gateway)) throw new Error(`FakeGitHub has no method ${String(method)}`);
    this.faults.push({ method, failure, remaining: times });
  }

  /** Throws the next queued failure for `method`, if any (the harness calls it for a call it routes elsewhere, as in wire mode). */
  fault(method: FakeGitHubMethod): void {
    const found = this.faults.find((entry) => entry.method === method && entry.remaining > 0);
    if (found === undefined) return;
    found.remaining -= 1;
    if (found.failure instanceof Error) throw found.failure;
    throw agentXError("RUNTIME_UNAVAILABLE", `GitHub ${method} failed with HTTP ${found.failure}`);
  }

  async resolveCredential(_reference: string, _url: string, access: "clone" | "push"): Promise<{ token: string }> {
    const token = `ghs_e2e_${access}_${this.tokens.size + 1}`;
    this.tokens.set(token, access);
    this.minted.push({ token, access, during: this.during });
    return { token };
  }

  push(token: string | undefined, headBranch: string, commit: string, tree: string, parents: readonly string[] = []): void {
    this.fault("push");
    if (token === undefined || this.tokens.get(token) !== "push") throw new Error(`GitHub refused the push to ${headBranch}: the token cannot push`);
    this.moveBranch(headBranch, commit, tree, parents, token);
  }

  private moveBranch(headBranch: string, commit: string, tree: string, parents: readonly string[], token: string): void {
    this.pushLog.push({ branch: headBranch, commit, tree, parents: [...parents], token, during: this.during });
    this.pushes.set(headBranch, { commit, tree, token });
    this.commits.set(commit, tree);
    this.parents.set(commit, [...parents]);
    // An open pull request from the branch now has the pushed commit as its head; reads see it a moment later.
    for (const pullRequest of this.pullRequests) {
      if (pullRequest.headBranch !== headBranch || pullRequest.state !== "open" || pullRequest.commit === commit) continue;
      const shown = this.visibleHead(pullRequest, false);
      if (this.prHeadReads > 0) pullRequest.lagged = { ...shown, reads: this.prHeadReads };
      Object.assign(pullRequest, { commit, tree });
    }
  }

  /** The head a read of the pull request sees now; `read` counts it against the lag. */
  private visibleHead(pullRequest: FakePullRequest, read: boolean): { commit: string; tree: string } {
    const lagged = pullRequest.lagged;
    if (lagged === undefined || lagged.reads <= 0) return { commit: pullRequest.commit, tree: pullRequest.tree };
    if (read) {
      lagged.reads -= 1;
      if (lagged.reads === 0) delete pullRequest.lagged;
    }
    return { commit: lagged.commit, tree: lagged.tree };
  }

  /** Someone comments on the pull request's conversation on GitHub. */
  comment(number: number, author: string, body: string): GitHubFeedbackComment {
    const pullRequest = this.find(number);
    const databaseId = this.nextId.discussion++;
    const comment: StoredComment = { id: `discussion:${databaseId}`, kind: "DISCUSSION", url: `${pullRequest.url}#issuecomment-${databaseId}`, author, updatedAt: new Date().toISOString(), body };
    pullRequest.comments.push(comment);
    return publicComment(comment);
  }

  /** Someone comments on a line of the pull request's diff on GitHub, which opens a review thread of its own. */
  reviewComment(number: number, author: string, body: string, path: string, line: number): GitHubFeedbackComment {
    const pullRequest = this.find(number);
    const databaseId = this.nextId.reviewComment++;
    const threadId = `PRRT_kwDOe2e${databaseId}`;
    const comment: StoredComment = { id: `review_comment:${databaseId}`, threadId, kind: "REVIEW_COMMENT", url: `${pullRequest.url}#discussion_r${databaseId}`,
      author, updatedAt: new Date().toISOString(), body, path, line };
    pullRequest.comments.push(comment);
    (pullRequest.threads ??= []).push({ id: threadId, resolved: false, commentIds: [comment.id] });
    return publicComment(comment);
  }

  /**
   * Someone submits a review: its body (null for none, as GitHub sends a review with no summary) and state, and its inline
   * comments, each opening a thread of its own. A review with a blank body or still PENDING is not feedback.
   */
  review(number: number, author: string, input: { body: string | null; state: GitHubReviewState; comments?: Array<{ body: string; path: string; line: number }> }): { review: GitHubFeedbackComment; comments: GitHubFeedbackComment[] } {
    const pullRequest = this.find(number);
    const databaseId = this.nextId.review++;
    const review: StoredComment = { id: `review:${databaseId}`, kind: "REVIEW", url: `${pullRequest.url}#pullrequestreview-${databaseId}`, author,
      updatedAt: new Date().toISOString(), body: input.body ?? "", rawBody: input.body, reviewState: input.state };
    pullRequest.comments.push(review);
    const comments = (input.comments ?? []).map((comment) => this.reviewComment(number, author, comment.body, comment.path, comment.line));
    return { review: publicComment(review), comments };
  }

  /** Someone edits a comment or review body on GitHub. */
  editComment(id: string, body: string): GitHubFeedbackComment {
    const { comment } = this.findComment(id);
    Object.assign(comment, { body, updatedAt: new Date(Math.max(Date.now(), Date.parse(comment.updatedAt) + 1)).toISOString() });
    if (comment.kind === "REVIEW") comment.rawBody = body;
    return publicComment(comment);
  }

  /** Someone deletes a comment on GitHub; a review thread whose last comment goes goes with it. */
  deleteComment(id: string): void {
    const { pullRequest, comment } = this.findComment(id);
    pullRequest.comments.splice(pullRequest.comments.indexOf(comment), 1);
    for (const thread of pullRequest.threads ?? []) thread.commentIds = thread.commentIds.filter((entry) => entry !== id);
    pullRequest.threads = (pullRequest.threads ?? []).filter((thread) => thread.commentIds.length > 0);
  }

  /** Someone resolves (or unresolves) a review thread on GitHub. */
  resolveThread(threadId: string, resolved = true): void {
    const thread = this.pullRequests.flatMap((pullRequest) => pullRequest.threads ?? []).find((entry) => entry.id === threadId);
    if (thread === undefined) throw new Error(`GitHub has no review thread ${threadId}`);
    thread.resolved = resolved;
  }

  /** Someone other than AgentX pushes a commit onto the pull request's branch (with no token AgentX minted). */
  foreignPush(number: number, options: { tree?: string } = {}): { commit: string; tree: string } {
    const pullRequest = this.find(number);
    const serial = this.nextId.foreign++;
    const commit = createHash("sha1").update(`foreign-commit-${number}-${serial}`).digest("hex");
    const tree = options.tree ?? createHash("sha1").update(`foreign-tree-${number}-${serial}`).digest("hex");
    this.moveBranch(pullRequest.headBranch, commit, tree, [pullRequest.commit], "ghp_someone_else");
    return { commit, tree };
  }

  /** Someone closes the pull request on GitHub without merging it. */
  close(number: number): void {
    this.find(number).state = "closed";
  }

  /** Someone merges the pull request on GitHub, at its current head. */
  merge(number: number): void {
    const pullRequest = this.find(number);
    pullRequest.state = "merged";
    delete pullRequest.lagged;
  }

  /** The types GraphQL answers carried `fullDatabaseId` as, in wire mode (GitHub sends strings). */
  graphqlDatabaseIdTypes(): Set<string> {
    return new Set(this.graphqlIdTypes);
  }

  private find(number: number): FakePullRequest {
    const found = this.pullRequests.find((pullRequest) => pullRequest.number === number);
    if (found === undefined) throw new Error(`GitHub has no pull request #${number}`);
    return found;
  }

  private findComment(id: string): { pullRequest: FakePullRequest; comment: StoredComment } {
    for (const pullRequest of this.pullRequests) {
      const comment = pullRequest.comments.find((entry) => entry.id === id);
      if (comment !== undefined) return { pullRequest, comment };
    }
    throw new Error(`GitHub has no comment ${id}`);
  }

  private details(pullRequest: FakePullRequest, head: { commit: string }): GitHubPullRequestDetails {
    return {
      number: pullRequest.number, url: pullRequest.url, state: pullRequest.state, headBranch: pullRequest.headBranch,
      baseBranch: pullRequest.baseBranch, headCommit: head.commit, title: pullRequest.title, body: pullRequest.body ?? "",
    };
  }

  /** The feedback GitHub holds, as the provider hands it on: submitted reviews with a body, and every comment. */
  private feedbackComments(pullRequest: FakePullRequest): StoredComment[] {
    return pullRequest.comments.filter((comment) => comment.kind !== "REVIEW" || (comment.reviewState !== "PENDING" && comment.body.trim() !== ""));
  }

  readonly gateway = {
    reconcilePullRequest: async (input: GitHubPullRequestInput): Promise<GitHubPullRequestResult> => {
      this.fault("reconcilePullRequest");
      const pushed = this.pushes.get(input.headBranch);
      if (pushed === undefined) throw new Error(`GitHub has no branch ${input.headBranch}`);
      const existing = this.pullRequests.find((pullRequest) => pullRequest.headBranch === input.headBranch && pullRequest.state === "open");
      if (existing !== undefined) return { number: existing.number, url: existing.url, reconciled: true };
      const number = this.pullRequests.length + 1;
      const url = `https://github.com/${FULL_NAME}/pull/${number}`;
      this.pullRequests.push({
        number, url, headBranch: input.headBranch, baseBranch: input.baseBranch, title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }), ...(input.draft === undefined ? {} : { draft: input.draft }),
        commit: pushed.commit, tree: pushed.tree, state: "open", comments: [],
      });
      return { number, url, reconciled: false };
    },
    getPullRequest: async (_repositoryUrl: string, number: number): Promise<GitHubPullRequestDetails> => {
      this.fault("getPullRequest");
      const pullRequest = this.find(number);
      return this.details(pullRequest, this.visibleHead(pullRequest, true));
    },
    updatePullRequest: async (_repositoryUrl: string, number: number, update: GitHubPullRequestUpdate): Promise<GitHubPullRequestDetails> => {
      this.fault("updatePullRequest");
      const pullRequest = this.find(number);
      if (update.title !== undefined) pullRequest.title = update.title;
      if (update.body !== undefined) pullRequest.body = update.body;
      if (update.state !== undefined) pullRequest.state = update.state;
      return this.details(pullRequest, this.visibleHead(pullRequest, true));
    },
    verifyWebhookRepository: async (): Promise<boolean> => {
      this.fault("verifyWebhookRepository");
      return true;
    },
    getBranchHead: async (_repositoryUrl: string, branch: string): Promise<string> => {
      this.fault("getBranchHead");
      const pushed = this.pushes.get(branch);
      if (pushed === undefined) throw new Error(`GitHub has no branch ${branch}`);
      return pushed.commit;
    },
    getCommitTree: async (_repositoryUrl: string, commit: string): Promise<string> => {
      this.fault("getCommitTree");
      const tree = this.commits.get(commit);
      if (tree === undefined) throw new Error(`GitHub has no commit ${commit}`);
      return tree;
    },
    getFileAtCommit: async (_repositoryUrl: string, path: string): Promise<string | undefined> => {
      this.fault("getFileAtCommit");
      return this.files.get(path);
    },
    getCommitParents: async (_repositoryUrl: string, commit: string): Promise<string[]> => {
      this.fault("getCommitParents");
      const parents = this.parents.get(commit);
      if (parents === undefined) throw new Error(`GitHub has no commit ${commit}`);
      return parents;
    },
    getPullRequestFeedback: async (_repositoryUrl: string, number: number): Promise<GitHubPullRequestFeedback> => {
      this.fault("getPullRequestFeedback");
      const pullRequest = this.find(number);
      const head = this.visibleHead(pullRequest, true);
      return { pullRequest: { ...this.details(pullRequest, head), headTreeSha: head.tree }, comments: this.feedbackComments(pullRequest).map(publicComment),
        threads: (pullRequest.threads ?? []).map((thread) => ({ ...thread, commentIds: [...thread.commentIds] })) };
    },
  };

  /**
   * Wire mode: GitHub's REST and GraphQL API as the real GitHubAppCredentialProvider reads it (installation lookup,
   * installation tokens, pull requests, comments, reviews, review threads, commits and branch refs). GraphQL sends
   * `fullDatabaseId` as a string, as GitHub does. A pull request read counts against the head lag.
   */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (!/^Bearer \S+$/.test(headers.get("authorization") ?? "")) return answer(401, { message: "Requires authentication" });
    const path = url.pathname;
    if (method === "GET" && path === `/repos/${FULL_NAME}/installation`) return answer(200, { id: INSTALLATION_ID, account: { login: OWNER } });
    if (method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      const body = JSON.parse((typeof init?.body === "string" ? init.body : "{}")) as { permissions?: Record<string, string> };
      const token = `ghs_wire_${this.appTokens.length + 1}`;
      this.appTokens.push({ token, permissions: body.permissions ?? {} });
      return answer(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    const token = headers.get("authorization")!.slice("Bearer ".length);
    if (!this.appTokens.some((entry) => entry.token === token)) return answer(401, { message: "Bad credentials" });
    if (method === "POST" && path === "/graphql") return answer(200, this.graphql(JSON.parse((typeof init?.body === "string" ? init.body : "{}")) as { query: string; variables: Record<string, unknown> }));
    if (method !== "GET") return answer(404, { message: "Not Found" });
    let match = new RegExp(`^/repos/${FULL_NAME}/pulls/(\\d+)$`).exec(path);
    if (match) {
      const pullRequest = this.pullRequests.find((entry) => entry.number === Number(match![1]));
      return pullRequest === undefined ? answer(404, { message: "Not Found" }) : answer(200, this.restPullRequest(pullRequest, this.visibleHead(pullRequest, true)));
    }
    match = new RegExp(`^/repos/${FULL_NAME}/(pulls|issues)/(\\d+)/(reviews|comments)$`).exec(path);
    if (match) {
      const pullRequest = this.pullRequests.find((entry) => entry.number === Number(match![2]));
      if (pullRequest === undefined) return answer(404, { message: "Not Found" });
      const kind = match[1] === "issues" ? "DISCUSSION" : match[3] === "reviews" ? "REVIEW" : "REVIEW_COMMENT";
      if (match[1] === "issues" && match[3] !== "comments") return answer(404, { message: "Not Found" });
      // One page: AgentX's tests never hold 100 of a kind.
      return answer(200, pullRequest.comments.filter((comment) => comment.kind === kind).map((comment) => this.restComment(pullRequest, comment)));
    }
    match = new RegExp(`^/repos/${FULL_NAME}/git/commits/([0-9a-f]{40})$`).exec(path);
    if (match) {
      const tree = this.commits.get(match[1]!);
      if (tree === undefined) return answer(404, { message: "Not Found" });
      return answer(200, { sha: match[1], tree: { sha: tree }, parents: (this.parents.get(match[1]!) ?? []).map((sha) => ({ sha })) });
    }
    match = new RegExp(`^/repos/${FULL_NAME}/git/ref/heads/(.+)$`).exec(path);
    if (match) {
      const pushed = this.pushes.get(match[1]!);
      return pushed === undefined ? answer(404, { message: "Not Found" }) : answer(200, { ref: `refs/heads/${match[1]}`, object: { type: "commit", sha: pushed.commit } });
    }
    return answer(404, { message: "Not Found" });
  };

  private restPullRequest(pullRequest: FakePullRequest, head: { commit: string }): Record<string, unknown> {
    return {
      number: pullRequest.number, html_url: pullRequest.url, state: pullRequest.state === "open" ? "open" : "closed", merged: pullRequest.state === "merged",
      draft: pullRequest.draft ?? false, title: pullRequest.title, body: pullRequest.body ?? null, merge_commit_sha: null,
      head: { ref: pullRequest.headBranch, sha: head.commit, repo: { full_name: FULL_NAME } }, base: { ref: pullRequest.baseBranch, repo: { full_name: FULL_NAME } },
    };
  }

  private restComment(pullRequest: FakePullRequest, comment: StoredComment): Record<string, unknown> {
    const id = Number(comment.id.slice(comment.id.indexOf(":") + 1));
    const common = { id, html_url: comment.url, user: { login: comment.author } };
    if (comment.kind === "REVIEW") {
      // REST sends a review's submitted time, not its edit time, and "" for a review with no summary.
      return { ...common, body: comment.rawBody ?? "", state: comment.reviewState, submitted_at: comment.updatedAt };
    }
    if (comment.kind === "REVIEW_COMMENT") {
      return { ...common, body: comment.body, updated_at: comment.updatedAt, path: comment.path, line: comment.line, pull_request_url: `${API}/pulls/${pullRequest.number}` };
    }
    return { ...common, body: comment.body, updated_at: comment.updatedAt, issue_url: `${API}/issues/${pullRequest.number}` };
  }

  private graphql(request: { query: string; variables: Record<string, unknown> }): Record<string, unknown> {
    const databaseId = (comment: StoredComment) => {
      const value = comment.id.slice(comment.id.indexOf(":") + 1);
      this.graphqlIdTypes.add(typeof value);
      return value;
    };
    const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    const pullRequest = this.pullRequests.find((entry) => entry.number === request.variables.number);
    if (pullRequest === undefined || request.variables.owner !== OWNER || request.variables.name !== NAME) {
      return { data: { repository: null }, errors: [{ message: "Could not resolve to a PullRequest" }] };
    }
    const head = this.visibleHead(pullRequest, true);
    const pr: Record<string, unknown> = { number: pullRequest.number, headRefOid: head.commit };
    if (/\breviews\(first:100/.test(request.query)) {
      pr.reviews = page(pullRequest.comments.filter((comment) => comment.kind === "REVIEW" && comment.reviewState !== "PENDING")
        .map((comment) => ({ fullDatabaseId: databaseId(comment), updatedAt: comment.updatedAt, url: comment.url, body: comment.rawBody ?? "" })));
    } else if (/\breviewThreads\(first:100/.test(request.query)) {
      pr.reviewThreads = page((pullRequest.threads ?? []).map((thread) => ({
        id: thread.id, isResolved: thread.resolved, repository: { nameWithOwner: FULL_NAME }, pullRequest: { number: pullRequest.number },
        comments: page(thread.commentIds.map((id) => ({ fullDatabaseId: databaseId(pullRequest.comments.find((comment) => comment.id === id)!) }))),
      })));
    } else {
      return { errors: [{ message: "FakeGitHub does not serve this query" }] };
    }
    return { data: { repository: { nameWithOwner: FULL_NAME, pullRequest: pr } } };
  }
}

function publicComment(comment: StoredComment): GitHubFeedbackComment {
  const { reviewState: _state, rawBody: _raw, ...rest } = comment;
  void _state;
  void _raw;
  return { ...rest };
}

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
