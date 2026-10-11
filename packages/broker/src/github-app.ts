import { createSign } from "node:crypto";
import { agentXError, type AgentXError } from "@agentx/contracts";
import type { RepositoryAccess, RepositoryCredential } from "./repository-access.js";

const GITHUB_APP_ID = /^[1-9][0-9]*$/;

export interface GitHubAppCredentialProviderOptions {
  credentialRef: string;
  /** The App's id, or a function that reads it when first needed: an install's control plane
   * deploys before its GitHub App exists, and then reads the id from the App's secret. */
  appId: string | (() => Promise<string>);
  getPrivateKey: () => Promise<string>;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}

export interface GitHubPullRequestInput {
  repositoryUrl: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body?: string;
  /** Spec 025 FR-023: opens the pull request as a draft; GitHub's default applies when absent. */
  draft?: boolean;
}

export interface GitHubPullRequestResult {
  number: number;
  url: string;
  reconciled: boolean;
}

export interface GitHubPullRequestDetails {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  headCommit: string;
  mergeCommit?: string;
  title: string;
  body: string;
}

export interface GitHubPullRequestUpdate {
  title?: string;
  body?: string;
  state?: "open" | "closed";
}

/** A repository the App can reach: its installation, and the owner as GitHub spells it. */
interface InstalledRepository {
  owner: string;
  name: string;
  installationId: number;
}

/**
 * Credentials from one GitHub App for repositories in every account it is installed on (#123).
 * Each repository's installation is looked up by its owner and cached for the process's
 * lifetime. There is no account allowlist: only administrators register repositories, and an
 * installation's token reaches only that installation's repositories.
 */
export class GitHubAppCredentialProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly installations = new Map<string, Promise<{ id: number; login: string }>>();

  constructor(private readonly options: GitHubAppCredentialProviderOptions) {
    if (typeof options.appId === "string" && !GITHUB_APP_ID.test(options.appId)) throw new Error("GitHub App ID must be numeric");
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async resolve(
    credentialRef: string,
    repositoryUrl: string,
    access: RepositoryAccess = "clone",
  ): Promise<RepositoryCredential> {
    if (credentialRef !== this.options.credentialRef) return {};
    const token = await this.createInstallationToken(parseGitHubRepository(repositoryUrl), {
      contents: access === "push" ? "write" : "read",
    });
    return { username: "x-access-token", password: token };
  }

  /** Refuses, with CONFIG_INVALID, a repository of this App's credential that the App cannot reach. */
  async checkRepository(repository: { credentialRef: string; url: string }): Promise<void> {
    if (repository.credentialRef !== this.options.credentialRef) return;
    await this.installed(parseGitHubRepository(repository.url));
  }

  async issueCredentials(
    repository: { credentialRef: string; url: string },
    access: "read" | "write",
  ): Promise<{ owner: string; repo: string; token: string }> {
    if (repository.credentialRef !== this.options.credentialRef) {
      throw agentXError("FORBIDDEN", "repository does not use the configured GitHub App");
    }
    const parsed = parseGitHubRepository(repository.url);
    const installed = await this.installed(parsed);
    const token = await this.createInstallationToken(parsed, { issues: access });
    return { owner: installed.owner, repo: parsed.name, token };
  }

  async reconcilePullRequest(input: GitHubPullRequestInput): Promise<GitHubPullRequestResult> {
    const repository = await this.installed(parseGitHubRepository(input.repositoryUrl));
    // GitHub's pull-request endpoint needs to resolve the private repository's
    // base and head refs. Keep the token repository-scoped, but allow it to
    // read those refs in addition to creating the pull request.
    const token = await this.createInstallationToken(repository, {
      contents: "read",
      pull_requests: "write",
    });
    const existing = await this.findOpenPullRequest(repository, input, token);
    if (existing) return { ...existing, reconciled: true };

    try {
      const response = await this.fetchImplementation(
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls`,
        {
          method: "POST",
          headers: githubHeaders(token),
          body: JSON.stringify({
            title: input.title,
            head: input.headBranch,
            base: input.baseBranch,
            ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.draft === undefined ? {} : { draft: input.draft }),
          }),
        },
      );
      if (response.ok) return { ...parsePullRequest(await response.json(), repository), reconciled: false };
      const afterFailure = await this.findOpenPullRequest(repository, input, token);
      if (afterFailure) return { ...afterFailure, reconciled: true };
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request creation failed with HTTP ${response.status}`);
    } catch (error) {
      if (isAgentXError(error)) throw error;
      const afterFailure = await this.findOpenPullRequest(repository, input, token);
      if (afterFailure) return { ...afterFailure, reconciled: true };
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request creation outcome is unknown");
    }
  }

  async getPullRequest(repositoryUrl: string, number: number): Promise<GitHubPullRequestDetails> {
    const repository = await this.installed(parseGitHubRepository(repositoryUrl));
    const token = await this.createInstallationToken(repository, {
      contents: "read",
      pull_requests: "read",
    });
    return this.getPullRequestWithToken(repository, number, token);
  }

  /** Current authoritative feedback, including thread resolution, read with a repository-scoped token. */
  async getPullRequestFeedback(repositoryUrl: string, number: number): Promise<GitHubPullRequestFeedback> {
    const repository = await this.installed(parseGitHubRepository(repositoryUrl));
    const token = await this.createInstallationToken(repository, { contents: "read", pull_requests: "read", issues: "read" });
    const prUrl = pullRequestUrl(repository, number);
    const before = await this.getPullRequestWithToken(repository, number, token);
    if (before.number !== number) throw feedbackReadError("PR scope mismatch");
    const root = prUrl.replace(/\/pulls\/\d+$/, "");
    const comments: GitHubFeedbackComment[] = [];
    for (const [path, kind] of [[`${prUrl}/reviews`, "REVIEW"], [`${prUrl}/comments`, "REVIEW_COMMENT"], [`${root}/issues/${number}/comments`, "DISCUSSION"]] as const) {
      for (const value of await this.feedbackPages(path, token)) {
        const record = feedbackRecord(value);
        if (kind === "REVIEW" && record.state === "PENDING") continue;
        const parsed = parseFeedbackComment(record, repository, number, kind);
        if (kind !== "REVIEW" || parsed.body.trim()) comments.push(parsed);
      }
    }
    // REST reviews expose submitted_at rather than the current edit time. Bind their bytes to GraphQL updatedAt.
    let reviewCursor: string | null = null;
    const reviewCursors = new Set<string>();
    const currentReviewIds = new Set<string>();
    do {
      const data = await this.feedbackGraphql(token, `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
        repository(owner:$owner,name:$name) { nameWithOwner pullRequest(number:$number) { number headRefOid
          reviews(first:100,after:$cursor) { nodes { fullDatabaseId updatedAt url body } pageInfo { hasNextPage endCursor } }
        } }
      }`, { owner: repository.owner, name: repository.name, number, cursor: reviewCursor });
      const repo = feedbackRecord(data.repository); const pr = feedbackRecord(repo.pullRequest);
      if (repo.nameWithOwner !== `${repository.owner}/${repository.name}` || pr.number !== number || pr.headRefOid !== before.headCommit) throw feedbackReadError("review scope or head changed");
      const connection = feedbackConnection(pr.reviews);
      for (const value of connection.nodes) {
        const review = feedbackRecord(value);
        if (typeof review.fullDatabaseId !== "number" || !Number.isSafeInteger(review.fullDatabaseId) || review.fullDatabaseId < 1) throw feedbackReadError("invalid review ID");
        const id = `review:${review.fullDatabaseId}`;
        const comment = comments.find(c => c.id === id && c.kind === "REVIEW");
        if (!comment) continue; // Blank bodies and unpublished draft reviews were excluded by REST.
        if (currentReviewIds.has(id) || comment.url !== review.url || comment.body !== review.body
          || typeof review.updatedAt !== "string" || !Number.isFinite(Date.parse(review.updatedAt))) throw feedbackReadError("review changed during collection");
        currentReviewIds.add(id); comment.updatedAt = new Date(review.updatedAt).toISOString();
      }
      reviewCursor = nextFeedbackCursor(connection, reviewCursors);
    } while (reviewCursor !== null);
    if (comments.some(c => c.kind === "REVIEW" && !currentReviewIds.has(c.id))) throw feedbackReadError("review set changed during collection");
    const threads: GitHubFeedbackThread[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const data = await this.feedbackGraphql(token, `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
        repository(owner:$owner,name:$name) { nameWithOwner pullRequest(number:$number) { number headRefOid
          reviewThreads(first:100,after:$cursor) { nodes { ${FEEDBACK_THREAD_FIELDS} } pageInfo { hasNextPage endCursor } }
        } }
      }`, { owner: repository.owner, name: repository.name, number, cursor });
      const repo = feedbackRecord(data.repository);
      const pr = feedbackRecord(repo.pullRequest);
      if (repo.nameWithOwner !== `${repository.owner}/${repository.name}` || pr.number !== number || pr.headRefOid !== before.headCommit) throw feedbackReadError("PR scope or head changed");
      const connection = feedbackConnection(pr.reviewThreads);
      for (const value of connection.nodes) {
        const thread = feedbackRecord(value);
        validateFeedbackThread(thread, repository, number);
        const ids: string[] = [];
        let threadComments = feedbackConnection(thread.comments);
        const commentCursors = new Set<string>();
        for (;;) {
          for (const comment of threadComments.nodes) {
            const id = feedbackRecord(comment).fullDatabaseId;
            if ((typeof id !== "string" && typeof id !== "number") || !/^[1-9][0-9]*$/.test(String(id))
              || (typeof id === "number" && !Number.isSafeInteger(id))) throw feedbackReadError("invalid thread comment ID");
            ids.push(`review_comment:${id}`);
          }
          const next = nextFeedbackCursor(threadComments, commentCursors);
          if (next === null) break;
          const more = await this.feedbackGraphql(token, `query($threadId:ID!,$cursor:String) { node(id:$threadId) { ... on PullRequestReviewThread {
            id isResolved repository { nameWithOwner } pullRequest { number }
            comments(first:100,after:$cursor) { nodes { fullDatabaseId } pageInfo { hasNextPage endCursor } }
          } } }`, { threadId: thread.id, cursor: next });
          const node = feedbackRecord(more.node);
          validateFeedbackThread(node, repository, number);
          if (node.id !== thread.id || node.isResolved !== thread.isResolved) throw feedbackReadError("thread state changed during pagination");
          threadComments = feedbackConnection(node.comments);
        }
        threads.push({ id: thread.id as string, resolved: thread.isResolved as boolean, commentIds: ids });
      }
      cursor = nextFeedbackCursor(connection, seenCursors);
    } while (cursor !== null);
    const assignments = new Map<string, string>();
    const threadIds = new Set<string>();
    for (const thread of threads) {
      if (threadIds.has(thread.id)) throw feedbackReadError("duplicate thread in current state");
      threadIds.add(thread.id);
      for (const id of thread.commentIds) {
        if (assignments.has(id)) throw feedbackReadError("duplicate thread comment in current state");
        assignments.set(id, thread.id);
      }
    }
    const commentIds = new Set<string>();
    for (const comment of comments) {
      if (commentIds.has(comment.id)) throw feedbackReadError("duplicate comment in current state");
      commentIds.add(comment.id);
      if (comment.kind === "REVIEW_COMMENT") {
        const threadId = assignments.get(comment.id);
        if (!threadId) throw feedbackReadError("inline comment thread state is incomplete");
        comment.threadId = threadId;
      }
    }
    if ([...assignments.keys()].some(id => !commentIds.has(id))) throw feedbackReadError("thread and REST comment sets changed during collection");
    const after = await this.getPullRequestWithToken(repository, number, token);
    if (after.number !== number || after.headCommit !== before.headCommit || after.state !== before.state) throw feedbackReadError("PR head or state changed during collection");
    const headTreeSha = await this.getCommitTreeSha(repository, after.headCommit, token);
    const final = await this.getPullRequestWithToken(repository, number, token);
    if (final.number !== number || final.headCommit !== after.headCommit || final.state !== after.state) throw feedbackReadError("PR head or state changed during collection");
    return { pullRequest: { ...final, headTreeSha }, comments, threads };
  }

  /** The tree of a commit GitHub holds in the installed repository; throws when GitHub does not have that commit. */
  async getCommitTree(repositoryUrl: string, commitSha: string): Promise<string> {
    if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw agentXError("CONFIG_INVALID", "commit identity is invalid");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl));
    const token = await this.createInstallationToken(repository, { contents: "read" });
    return this.getCommitTreeSha(repository, commitSha, token);
  }

  /** The parents of a commit GitHub holds in the installed repository; throws when GitHub does not have that commit. */
  async getCommitParents(repositoryUrl: string, commitSha: string): Promise<string[]> {
    if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw agentXError("CONFIG_INVALID", "commit identity is invalid");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl));
    const token = await this.createInstallationToken(repository, { contents: "read" });
    const value = await this.getCommitObject(repository, commitSha, token);
    if (!Array.isArray(value.parents)) throw feedbackReadError("invalid commit parents");
    return value.parents.map((parent) => {
      const sha = feedbackRecord(parent).sha;
      if (typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha)) throw feedbackReadError("invalid commit parent identity");
      return sha;
    });
  }

  /** The commit a branch points at now, as GitHub says; throws when the branch does not exist. */
  async getBranchHead(repositoryUrl: string, branch: string): Promise<string> {
    if (!/^agentx\/[0-9a-f-]{36}$/iu.test(branch)) throw agentXError("CONFIG_INVALID", "branch name is invalid");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl));
    const token = await this.createInstallationToken(repository, { contents: "read" });
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/ref/heads/${branch}`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(8_000), redirect: "error" },
    );
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub branch lookup failed with HTTP ${response.status}`);
    const value = feedbackRecord(await response.json());
    const target = feedbackRecord(value.object);
    if (value.ref !== `refs/heads/${branch}` || target.type !== "commit" || typeof target.sha !== "string" || !/^[a-f0-9]{40}$/u.test(target.sha)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid branch reference");
    }
    return target.sha;
  }

  /** GitHub's immutable tree object identifies code content independently of publication commit metadata. */
  private async getCommitTreeSha(repository: InstalledRepository, commitSha: string, token: string): Promise<string> {
    const value = await this.getCommitObject(repository, commitSha, token);
    const tree = feedbackRecord(value.tree);
    if (typeof tree.sha !== "string" || !/^[a-f0-9]{40}$/u.test(tree.sha)) throw feedbackReadError("invalid PR head tree identity");
    return tree.sha;
  }

  /** GitHub's Git commit object (its tree and parents). */
  private async getCommitObject(repository: InstalledRepository, commitSha: string, token: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/commits/${commitSha}`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(8_000), redirect: "error" },
    );
    if (!response.ok) throw feedbackReadError(`head commit lookup HTTP ${response.status}`);
    return feedbackRecord(await response.json());
  }

  private async feedbackPages(path: string, token: string): Promise<unknown[]> {
    const values: unknown[] = [];
    let next: string | undefined = `${path}?per_page=100&page=1`;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next)) throw feedbackReadError("pagination did not advance");
      seen.add(next);
      const response = await this.fetchImplementation(next, { headers: githubHeaders(token), redirect: "error", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw feedbackReadError(`comment lookup HTTP ${response.status}`);
      const page: unknown = await response.json();
      if (!Array.isArray(page)) throw feedbackReadError("invalid comment page");
      for (const value of page as unknown[]) values.push(value);
      const link = response.headers.get("link");
      const linked = link?.split(",").map(part => /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(part)).find(match => match)?.[1];
      if (linked) {
        const url = new URL(linked);
        if (`${url.origin}${url.pathname}` !== path || url.username || url.password || url.hash
          || [...url.searchParams.keys()].some(key => key !== "per_page" && key !== "page")
          || url.searchParams.get("per_page") !== "100" || !/^[1-9][0-9]*$/.test(url.searchParams.get("page") ?? "")) throw feedbackReadError("pagination scope mismatch");
        next = url.href;
      } else if (!link && page.length === 100) {
        const url: URL = new URL(next); url.searchParams.set("page", String(Number(url.searchParams.get("page")) + 1)); next = url.href;
      } else next = undefined;
    }
    return values;
  }

  private async feedbackGraphql(token: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.fetchImplementation("https://api.github.com/graphql", {
      method: "POST", headers: githubHeaders(token), body: JSON.stringify({ query, variables }), redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw feedbackReadError(`thread lookup HTTP ${response.status}`);
    const body = feedbackRecord(await response.json());
    if (body.errors !== undefined) throw feedbackReadError("thread lookup incomplete");
    return feedbackRecord(body.data);
  }

  async updatePullRequest(
    repositoryUrl: string,
    number: number,
    update: GitHubPullRequestUpdate,
  ): Promise<GitHubPullRequestDetails> {
    if (update.title === undefined && update.body === undefined && update.state === undefined) {
      throw agentXError("CONFIG_INVALID", "pull request update is empty");
    }
    const repository = await this.installed(parseGitHubRepository(repositoryUrl));
    const token = await this.createInstallationToken(repository, {
      contents: "read",
      pull_requests: "write",
    });
    try {
      const response = await this.fetchImplementation(
        pullRequestUrl(repository, number),
        {
          method: "PATCH",
          headers: githubHeaders(token),
          body: JSON.stringify(update),
        },
      );
      if (response.ok) {
        return parsePullRequestDetails(await response.json(), repository);
      }
      const reconciled = await this.getPullRequestWithToken(repository, number, token);
      if (matchesUpdate(reconciled, update)) return reconciled;
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request update failed with HTTP ${response.status}`);
    } catch (error) {
      if (isAgentXError(error)) throw error;
      const reconciled = await this.getPullRequestWithToken(repository, number, token).catch(() => undefined);
      if (reconciled && matchesUpdate(reconciled, update)) return reconciled;
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request update outcome is unknown");
    }
  }

  private async getPullRequestWithToken(
    repository: InstalledRepository,
    number: number,
    token: string,
  ): Promise<GitHubPullRequestDetails> {
    const response = await this.fetchImplementation(
      pullRequestUrl(repository, number),
      { headers: githubHeaders(token) },
    );
    if (!response.ok) {
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request lookup failed with HTTP ${response.status}`);
    }
    return parsePullRequestDetails(await response.json(), repository);
  }

  /** The repository's installation, cached by owner; a failed lookup is not cached. */
  private async installed(repository: { owner: string; name: string }): Promise<InstalledRepository> {
    const key = repository.owner.toLowerCase();
    let installation = this.installations.get(key);
    if (installation === undefined) {
      installation = this.lookUpInstallation(repository);
      this.installations.set(key, installation);
      const pending = installation;
      pending.catch(() => {
        if (this.installations.get(key) === pending) this.installations.delete(key);
      });
    }
    const { id, login } = await installation;
    return { owner: login, name: repository.name, installationId: id };
  }

  private async lookUpInstallation(repository: { owner: string; name: string }): Promise<{ id: number; login: string }> {
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/installation`,
      { headers: await this.appHeaders(), signal: AbortSignal.timeout(5_000), redirect: "error" },
    );
    if (response.status === 404) {
      throw agentXError(
        "CONFIG_INVALID",
        `the GitHub App cannot access ${repository.owner}/${repository.name}; install it on ${repository.owner} with access to that repository`,
      );
    }
    if (!response.ok) {
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub App installation lookup failed with HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    const id = body && typeof body === "object" && "id" in body ? body.id : undefined;
    const account = body && typeof body === "object" && "account" in body ? body.account : undefined;
    const login = account && typeof account === "object" && "login" in account ? account.login : undefined;
    if (!Number.isSafeInteger(id) || (id as number) < 1 || typeof login !== "string" || login.toLowerCase() !== repository.owner.toLowerCase()) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid installation response");
    }
    return { id: id as number, login };
  }

  /** Spec 025 A13: how many accounts the App is installed on (the first 100), for the health route. */
  async installationCount(): Promise<number> {
    const response = await this.fetchImplementation("https://api.github.com/app/installations?per_page=100", {
      headers: await this.appHeaders(), signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub App installations lookup failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid installations response");
    return body.length;
  }

  private async appHeaders(): Promise<Record<string, string>> {
    const appId = typeof this.options.appId === "string" ? this.options.appId : await this.options.appId();
    if (!GITHUB_APP_ID.test(appId)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App ID must be numeric");
    const privateKey = await this.options.getPrivateKey();
    const jwt = createGitHubAppJwt(appId, privateKey, this.now());
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "user-agent": "agentx-control-plane",
      "x-github-api-version": "2022-11-28",
    };
  }

  /**
   * A token for one repository. When the cached installation is gone (the App was uninstalled
   * and installed again, which gives it a new ID), the installation is looked up once more.
   */
  private async createInstallationToken(
    repository: { owner: string; name: string },
    permissions: Record<string, "read" | "write">,
    retried = false,
  ): Promise<string> {
    const installed = await this.installed(repository);
    const response = await this.fetchImplementation(
      `https://api.github.com/app/installations/${installed.installationId}/access_tokens`,
      {
        method: "POST",
        headers: await this.appHeaders(),
        body: JSON.stringify({
          repositories: [installed.name],
          permissions,
        }),
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      },
    );
    if (response.status === 404 && !retried) {
      this.installations.delete(installed.owner.toLowerCase());
      return this.createInstallationToken(repository, permissions, true);
    }
    if (!response.ok) {
      throw agentXError(
        "RUNTIME_UNAVAILABLE",
        `GitHub App installation token request failed with HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("token" in body) || typeof body.token !== "string") {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid installation token response");
    }
    return body.token;
  }

  private async findOpenPullRequest(
    repository: InstalledRepository,
    input: GitHubPullRequestInput,
    token: string,
  ): Promise<Omit<GitHubPullRequestResult, "reconciled"> | undefined> {
    const query = new URLSearchParams({
      state: "open",
      head: `${repository.owner}:${input.headBranch}`,
      base: input.baseBranch,
      per_page: "2",
    });
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query.toString()}`,
      { headers: githubHeaders(token) },
    );
    if (!response.ok) {
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request lookup failed with HTTP ${response.status}`);
    }
    const value: unknown = await response.json();
    if (!Array.isArray(value)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
    }
    if (value.length === 0) return undefined;
    return parsePullRequest(value[0], repository);
  }
}

export interface GitHubFeedbackComment {
  id: string; threadId?: string; kind: "REVIEW" | "REVIEW_COMMENT" | "DISCUSSION";
  url: string; author: string; updatedAt: string; body: string; path?: string; line?: number;
}
export interface GitHubFeedbackThread { id: string; resolved: boolean; commentIds: string[] }
export interface GitHubPullRequestFeedback {
  pullRequest: GitHubPullRequestDetails & { headTreeSha: string }; comments: GitHubFeedbackComment[]; threads: GitHubFeedbackThread[];
}
const FEEDBACK_THREAD_FIELDS = `id isResolved repository { nameWithOwner } pullRequest { number }
  comments(first:100) { nodes { fullDatabaseId } pageInfo { hasNextPage endCursor } }`;
function feedbackReadError(reason: string): AgentXError { return agentXError("RUNTIME_UNAVAILABLE", `GitHub feedback read refused: ${reason}`); }
function feedbackRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw feedbackReadError("invalid record");
  return value as Record<string, unknown>;
}
function feedbackConnection(value: unknown): { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const record = feedbackRecord(value); const info = feedbackRecord(record.pageInfo);
  if (!Array.isArray(record.nodes) || typeof info.hasNextPage !== "boolean" || (info.endCursor !== null && typeof info.endCursor !== "string")) throw feedbackReadError("invalid pagination state");
  return { nodes: record.nodes, pageInfo: { hasNextPage: info.hasNextPage, endCursor: info.endCursor } };
}
function nextFeedbackCursor(connection: ReturnType<typeof feedbackConnection>, seen: Set<string>): string | null {
  if (!connection.pageInfo.hasNextPage) return null;
  const cursor = connection.pageInfo.endCursor;
  if (!cursor || seen.has(cursor)) throw feedbackReadError("pagination did not advance");
  seen.add(cursor); return cursor;
}
function validateFeedbackThread(thread: Record<string, unknown>, repo: InstalledRepository, number: number): void {
  if (typeof thread.id !== "string" || !thread.id || typeof thread.isResolved !== "boolean"
    || feedbackRecord(thread.repository).nameWithOwner !== `${repo.owner}/${repo.name}`
    || feedbackRecord(thread.pullRequest).number !== number) throw feedbackReadError("thread scope mismatch");
}
function parseFeedbackComment(record: Record<string, unknown>, repository: InstalledRepository, number: number, kind: GitHubFeedbackComment["kind"]): GitHubFeedbackComment {
  const prefix = kind === "REVIEW" ? "review" : kind === "REVIEW_COMMENT" ? "review_comment" : "discussion";
  const anchor = kind === "REVIEW" ? "pullrequestreview-" : kind === "REVIEW_COMMENT" ? "discussion_r" : "issuecomment-";
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id < 1) throw feedbackReadError("invalid comment ID");
  const commentId = record.id;
  const expected = `https://github.com/${repository.owner}/${repository.name}/pull/${number}#${anchor}${commentId}`;
  const api = `https://api.github.com/repos/${repository.owner}/${repository.name}`;
  const user = feedbackRecord(record.user);
  const timestamp = record.updated_at ?? record.submitted_at;
  if (record.html_url !== expected || (kind === "REVIEW_COMMENT" && record.pull_request_url !== `${api}/pulls/${number}`)
    || (kind === "DISCUSSION" && record.issue_url !== `${api}/issues/${number}`)) throw feedbackReadError("comment scope mismatch: non-canonical URL");
  if ((record.body !== null && typeof record.body !== "string") || typeof user.login !== "string" || !user.login || user.login.length > 100
    || typeof timestamp !== "string" || !/^\d{4}-\d\d-\d\dT/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) throw feedbackReadError("invalid comment content");
  if (record.path !== undefined && (typeof record.path !== "string" || record.path.length > 1024)) throw feedbackReadError("invalid comment path");
  if (record.line !== undefined && record.line !== null && (!Number.isSafeInteger(record.line) || (record.line as number) < 1)) throw feedbackReadError("invalid comment line");
  return { id: `${prefix}:${commentId}`, kind, url: expected, author: user.login, updatedAt: new Date(timestamp).toISOString(), body: (record.body) ?? "",
    ...(kind === "REVIEW_COMMENT" && typeof record.path === "string" ? { path: record.path } : {}),
    ...(kind === "REVIEW_COMMENT" && typeof record.line === "number" ? { line: record.line } : {}) };
}

function pullRequestUrl(repository: InstalledRepository, number: number): string {
  if (!Number.isInteger(number) || number < 1) throw agentXError("CONFIG_INVALID", "pull request number is invalid");
  return `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}`;
}

function matchesUpdate(details: GitHubPullRequestDetails, update: GitHubPullRequestUpdate): boolean {
  return (update.title === undefined || details.title === update.title) &&
    (update.body === undefined || details.body === update.body) &&
    (update.state === undefined || details.state === update.state);
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "agentx-control-plane",
    "x-github-api-version": "2022-11-28",
  };
}

function parsePullRequest(
  value: unknown,
  repository: InstalledRepository,
): Omit<GitHubPullRequestResult, "reconciled"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  }
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.number) || (candidate.number as number) < 1 || typeof candidate.html_url !== "string") {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  }
  const expected = `https://github.com/${repository.owner}/${repository.name}/pull/${String(candidate.number)}`;
  if (candidate.html_url !== expected) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned a non-canonical pull request URL");
  }
  return { number: candidate.number as number, url: candidate.html_url };
}

function parsePullRequestDetails(
  value: unknown,
  repository: InstalledRepository,
): GitHubPullRequestDetails {
  const basic = parsePullRequest(value, repository);
  const candidate = value as Record<string, unknown>;
  const head = candidate.head;
  const base = candidate.base;
  if (
    (candidate.state !== "open" && candidate.state !== "closed") ||
    typeof candidate.merged !== "boolean" ||
    !head || typeof head !== "object" || Array.isArray(head) ||
    !base || typeof base !== "object" || Array.isArray(base) ||
    typeof (head as Record<string, unknown>).ref !== "string" ||
    typeof (head as Record<string, unknown>).sha !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test((head as Record<string, unknown>).sha as string) ||
    typeof (base as Record<string, unknown>).ref !== "string" ||
    typeof candidate.title !== "string" ||
    (candidate.body !== null && typeof candidate.body !== "string") ||
    (candidate.merge_commit_sha !== null && typeof candidate.merge_commit_sha !== "string")
  ) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  }
  return {
    ...basic,
    state: candidate.merged ? "merged" : candidate.state,
    headBranch: (head as Record<string, unknown>).ref as string,
    baseBranch: (base as Record<string, unknown>).ref as string,
    headCommit: (head as Record<string, unknown>).sha as string,
    ...(typeof candidate.merge_commit_sha === "string" ? { mergeCommit: candidate.merge_commit_sha } : {}),
    title: candidate.title,
    body: candidate.body ?? "",
  };
}

export function createGitHubAppJwt(appId: string, privateKey: string, nowMilliseconds: number): string {
  const issuedAt = Math.floor(nowMilliseconds / 1_000) - 60;
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({ iat: issuedAt, exp: issuedAt + 600, iss: appId });
  const signingInput = `${header}.${payload}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${signer.sign(privateKey).toString("base64url")}`;
  } catch (error) {
    if (isAgentXError(error)) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private key could not sign a token");
  }
}

export function privateKeyFromSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (
      value &&
      typeof value === "object" &&
      "privateKey" in value &&
      typeof value.privateKey === "string" &&
      value.privateKey.trim().startsWith("-----BEGIN")
    ) {
      return value.privateKey.trim();
    }
  } catch {
    // Report one stable error below without reflecting secret contents.
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private-key secret is not a PEM key");
}

/** The App's id from the secret `agentx init` stores (`{"appId", "privateKey", ...}`). A secret
 * holding only a PEM key has none: its control plane passes GITHUB_APP_ID instead. */
export function appIdFromSecret(secret: string): string {
  try {
    const value = JSON.parse(secret.trim()) as unknown;
    if (value && typeof value === "object" && "appId" in value && typeof value.appId === "string" && GITHUB_APP_ID.test(value.appId)) {
      return value.appId;
    }
  } catch {
    // Report one stable error below without reflecting secret contents.
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App secret holds no appId; set the control plane's GitHubAppId parameter");
}

function parseGitHubRepository(repositoryUrl: string): { owner: string; name: string } {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw agentXError("CONFIG_INVALID", "GitHub repository URL is invalid");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    segments.length !== 2 ||
    segments.some((segment) => segment.includes("%"))
  ) {
    throw agentXError("CONFIG_INVALID", "credentialed repository must be a canonical GitHub HTTPS URL");
  }
  const [owner, rawName] = segments;
  const name = rawName?.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (
    !owner ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
    !name ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(name)
  ) {
    throw agentXError("CONFIG_INVALID", "credentialed repository must be a canonical GitHub HTTPS URL");
  }
  return { owner, name };
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function isAgentXError(error: unknown): error is AgentXError {
  return error instanceof Error && error.name === "AgentXError";
}
