// Port lane L2: a GitHub client (`GitHubCodeHostProvider`) served from the shared in-memory model, with GitHub's own shapes: pull request numbers,
// `PullRequestStatus` with GitHub's check and review records, a merge result with GitHub's words. The GitHub adapters run the same conformance
// suites as the fakes over it, so a mapping that drifts from what a GitHub client returns fails here.
//
// Cloud runs these suites through its real `GitHubAppCredentialProvider` against a fixture of GitHub's HTTP API. That client is not in this tree yet
// (see `provider.ts`), so the fixture stops one level higher. The client's own request choreography is tested with the client, in the lane that brings it.
import { agentXError, HostRateLimitError, type HostScope, type ReadBudget } from "../../../packages/contracts/src/index.js";
import { githubAccountType, githubMergeableState } from "./github-fixture-api.js";
import type {
  GitHubCodeHostProvider, GitHubFeedbackComment, GitHubPullRequestChangedFile, GitHubPullRequestDetails, GitHubPullRequestFeedback, GitHubPullRequestInput, GitHubPullRequestResult,
  GitHubPullRequestUpdate, GitHubRepositoryCredential, GitHubRepositoryIdentity, MergePullRequestResult, PullRequestCheck, PullRequestStatus, WorkingBranchPage,
} from "../../../packages/broker/src/plugins/code-host/github/provider.js";
import type { CommitFilesRequest } from "../../../packages/broker/src/plugins/code-host/github/commit-files.js";
import type { FakeChangeRequest, FakeHostModel } from "@agentx/broker/fakes";

export const GITHUB_OWNER = "acme";
export const GITHUB_NAME = "app";
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_NAME}`;
export const GITHUB_OTHER_URL = `https://github.com/${GITHUB_OWNER}/other`;
export const GITHUB_ORG_SCOPE = { orgId: "org_aaaaaaaaaaaaaaaaaaaa" } as const;
export const INSTALLATION_ID = 77;
const APP_SLUG = "rovara-app";

export class GitHubFixtureProvider implements GitHubCodeHostProvider {
  /** Every client call served, in order: the method name. */
  readonly calls: string[] = [];
  /** The `expiresAt` the next credentials carry: an hour from the model's clock by default, a given time, or none (null). */
  tokenExpiry: string | null | undefined;
  private minted = 0;

  constructor(private readonly model: FakeHostModel) {}

  private serve(name: string, repositoryUrl?: string, scope?: HostScope): void {
    this.calls.push(name);
    if (scope !== undefined && !("orgId" in scope || "system" in scope)) throw agentXError("CONFIG_INVALID", "the plug-in call has no valid scope");
    if (repositoryUrl !== undefined && repositoryUrl !== this.model.url) throw agentXError("CONFIG_INVALID", "the repository is not reachable through the GitHub App");
  }

  /** A budgeted read counts against the pass's allowance, and a client that GitHub has told to slow down throws the neutral signal. */
  private spend(budget: ReadBudget | undefined): void {
    budget?.beforeRequest();
    if (this.model.rateLimitedUntil !== undefined) throw new HostRateLimitError(this.model.rateLimitedUntil);
  }

  private cr(number: number): FakeChangeRequest {
    const found = this.model.changeRequests.find((entry) => entry.id === String(number));
    if (found === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub has no such pull request");
    return found;
  }

  private detailsOf(cr: FakeChangeRequest): GitHubPullRequestDetails {
    return {
      number: Number(cr.id), url: this.model.crUrl(cr.id), state: cr.state, headBranch: cr.sourceBranch, baseBranch: cr.targetBranch, headCommit: this.model.headRevisionOf(cr),
      ...(cr.mergeRevision === undefined ? {} : { mergeCommit: cr.mergeRevision }), ...(cr.mergedAt === undefined ? {} : { mergedAt: cr.mergedAt }), ...(cr.mergedBy === undefined ? {} : { mergedBy: cr.mergedBy }),
      title: cr.title, body: cr.body, authorLogin: cr.author, baseRepositoryId: this.model.id, authoredByApp: cr.author === `${APP_SLUG}[bot]`,
    };
  }

  async getRepositoryIdentity(repositoryUrl: string, scope: HostScope): Promise<GitHubRepositoryIdentity | undefined> {
    this.serve("getRepositoryIdentity", undefined, scope);
    return repositoryUrl === this.model.url ? { repositoryId: Number(this.model.id), fullName: this.model.fullName, defaultBranch: this.model.defaultBranch } : undefined;
  }
  async checkRepository(repository: { credentialRef: string; url: string }, scope: HostScope): Promise<void> {
    this.serve("checkRepository", repository.url, scope);
  }
  async getRepositoryStanding(repositoryUrl: string, login: string, scope: HostScope, budget?: ReadBudget): Promise<{ permission: "admin" | "write" | "read" | "none"; userType?: string }> {
    this.serve("getRepositoryStanding", repositoryUrl, scope);
    this.spend(budget);
    const account = this.model.accounts.get(login);
    return account === undefined ? { permission: "none" } : { permission: account.permission, userType: githubAccountType(account.accountType) };
  }
  async resolveWithExpiry(_credentialRef: string, repositoryUrl: string, access: "clone" | "push", scope: HostScope): Promise<GitHubRepositoryCredential> {
    this.serve(`resolve:${access}`, repositoryUrl, scope);
    this.minted += 1;
    const expiresAt = this.tokenExpiry === undefined ? new Date(Date.parse(this.model.now()) + 3_600_000).toISOString() : this.tokenExpiry ?? undefined;
    return { username: "x-access-token", password: `fixture-token-${String(this.minted)}`, ...(expiresAt === undefined ? {} : { expiresAt }) };
  }
  async getFileAtCommit(repositoryUrl: string, path: string, commitSha: string, scope: HostScope, options?: { untilLine?: number; timeoutMs?: number; maxBytes?: number }): Promise<string | undefined> {
    this.serve("getFileAtCommit", repositoryUrl, scope);
    const content = this.model.revision(commitSha).files.get(path);
    if (content === undefined) return undefined;
    if (options?.maxBytes !== undefined && Buffer.byteLength(content, "utf8") > options.maxBytes) throw agentXError("CONFIG_INVALID", "file too large");
    return options?.untilLine === undefined ? content : content.split("\n").slice(0, options.untilLine).join("\n");
  }
  async getPathKindAtCommit(repositoryUrl: string, path: string, commitSha: string, scope: HostScope): Promise<"file" | "dir" | "symlink" | "none"> {
    this.serve("getPathKindAtCommit", repositoryUrl, scope);
    const found = this.model.revision(commitSha);
    const files = found.files;
    if (found.symlinks.has(path)) return "symlink";
    for (const link of found.symlinks) if (path.startsWith(`${link}/`)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub reports a symbolic link as a parent of this path");
    if (files.has(path)) return "file";
    for (const name of files.keys()) if (name.startsWith(`${path}/`)) return "dir";
    return "none";
  }
  async commitFilesToBranch(repositoryUrl: string, request: CommitFilesRequest, scope: HostScope): Promise<{ revision: string; changed: boolean }> {
    this.serve("commitFilesToBranch", repositoryUrl, scope);
    return this.model.commitLessonFiles({ repository: { url: repositoryUrl }, ...request, files: [...request.files], ...(request.previous === undefined ? {} : { previous: [...request.previous] }) } as never);
  }
  async findLessonsPullRequest(repositoryUrl: string, branch: string, scope: HostScope): Promise<{ number: number; url: string } | undefined> {
    this.serve("findLessonsPullRequest", repositoryUrl, scope);
    const found = this.model.changeRequestForLessonBranch(branch);
    return found === undefined ? undefined : { number: Number(found.id), url: this.model.crUrl(found.id) };
  }
  async deleteLessonsBranch(repositoryUrl: string, branch: string, scope: HostScope): Promise<"deleted" | "gone"> {
    this.serve("deleteLessonsBranch", repositoryUrl, scope);
    return this.model.deleteLessonBranch(branch);
  }
  async getCommitTree(repositoryUrl: string, commitSha: string, scope: HostScope): Promise<string> {
    this.serve("getCommitTree", repositoryUrl, scope);
    return this.model.revision(commitSha).tree;
  }
  async getBranchHead(repositoryUrl: string, branch: string, scope: HostScope): Promise<string> {
    this.serve("getBranchHead", repositoryUrl, scope);
    return this.model.headOf(branch);
  }
  async listWorkingBranches(repositoryUrl: string, _expected: { installationId: number; repositoryId: number }, scope: HostScope, page = 1): Promise<WorkingBranchPage> {
    this.serve("listWorkingBranches", repositoryUrl, scope);
    if (!Number.isSafeInteger(page) || page < 1) throw agentXError("CONFIG_INVALID", "the page is invalid");
    const all = [...this.model.branches.keys()].sort();
    return { branches: all.slice((page - 1) * 100, page * 100), page, mayHaveMore: all.length > page * 100, omittedUnsupported: false };
  }
  async getCommitParents(repositoryUrl: string, commitSha: string, scope: HostScope): Promise<string[]> {
    this.serve("getCommitParents", repositoryUrl, scope);
    return [...this.model.revision(commitSha).parents];
  }
  async getDefaultBranchHead(repositoryUrl: string, branch: string, scope: HostScope): Promise<string> {
    this.serve("getDefaultBranchHead", repositoryUrl, scope);
    return this.model.headOf(branch);
  }
  async getPullRequestMergeObservation(repositoryUrl: string, number: number, budget: ReadBudget, scope: HostScope): Promise<GitHubPullRequestDetails & { headTreeSha: string }> {
    this.serve("getPullRequestMergeObservation", repositoryUrl, scope);
    this.spend(budget);
    const cr = this.cr(number);
    this.spend(budget);
    return { ...this.detailsOf(cr), headTreeSha: this.model.revision(this.model.headRevisionOf(cr)).tree };
  }
  async installationForRepository(owner: string, name: string): Promise<{ installationId: number } | undefined> {
    this.serve("installationForRepository");
    return `https://github.com/${owner}/${name}` === this.model.url ? { installationId: INSTALLATION_ID } : undefined;
  }
  async readCodeOwners(repositoryUrl: string, branch: string, scope: HostScope): Promise<string | undefined> {
    this.serve("readCodeOwners", repositoryUrl, scope);
    const files = this.model.revision(this.model.headOf(branch)).files;
    return files.get(".github/CODEOWNERS") ?? files.get("CODEOWNERS") ?? files.get("docs/CODEOWNERS");
  }
  async reconcilePullRequest(input: GitHubPullRequestInput, scope: HostScope): Promise<GitHubPullRequestResult> {
    this.serve("reconcilePullRequest", input.repositoryUrl, scope);
    const { cr, reconciled } = this.model.reconcile({
      sourceBranch: input.headBranch, targetBranch: input.baseBranch, title: input.title, ...(input.body === undefined ? {} : { body: input.body }), ...(input.draft === undefined ? {} : { draft: input.draft }),
    });
    return { number: Number(cr.id), url: this.model.crUrl(cr.id), reconciled, ...(cr.draftRefused && !reconciled ? { draftRefused: true as const } : {}) };
  }
  async getPullRequest(repositoryUrl: string, number: number, scope: HostScope): Promise<GitHubPullRequestDetails> {
    this.serve("getPullRequest", repositoryUrl, scope);
    return this.detailsOf(this.cr(number));
  }
  async updatePullRequest(repositoryUrl: string, number: number, update: GitHubPullRequestUpdate, scope: HostScope): Promise<GitHubPullRequestDetails> {
    this.serve("updatePullRequest", repositoryUrl, scope);
    const cr = this.cr(number);
    this.model.update(cr.id, { ...(update.title === undefined ? {} : { title: update.title }), ...(update.body === undefined ? {} : { body: update.body }), ...(update.state === undefined ? {} : { state: update.state }) });
    return this.detailsOf(cr);
  }
  async getPullRequestStatus(repositoryUrl: string, number: number, scope: HostScope, budget?: ReadBudget): Promise<PullRequestStatus> {
    this.serve("getPullRequestStatus", repositoryUrl, scope);
    this.spend(budget);
    const cr = this.cr(number);
    const head = this.model.headRevisionOf(cr);
    const checks: PullRequestCheck[] = this.model.checksOf(head).map((check) => ({
      name: check.name, status: check.state, ...(check.conclusion === undefined ? {} : { conclusion: check.conclusion }), required: this.model.requiredChecks.includes(check.name),
      url: check.url, ...(check.runId === undefined ? {} : { jobId: check.runId }),
    }));
    return {
      number, state: cr.state, draft: cr.draft, headSha: head, baseBranch: cr.targetBranch, mergeableState: githubMergeableState(this.model.mergeableState(cr)) as PullRequestStatus["mergeableState"], mergeable: !cr.conflicts, checks,
      requiredChecks: this.model.requiredChecks.map((name) => ({ name })), baseHasRequiredChecks: this.model.requiredChecks.length > 0,
      headHasWorkflowFiles: [...this.model.revision(head).files.keys()].some((name) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(name)) || this.model.revision(head).files.has(".ci/checks.yml"),
      requestedReviewers: cr.requestedReviewers.length,
      ...(cr.requestedReviewers.length === 0 ? {} : { requestedReviewerIds: cr.requestedReviewers.map((login) => this.model.accounts.get(login)?.hostUserId ?? login) }),
      reviews: cr.reviews.map((review) => ({
        githubUserId: this.model.accounts.get(review.reviewer.login)?.hostUserId ?? "1", login: review.reviewer.login, userType: githubAccountType(review.accountType), state: review.state, commitId: review.revision, submittedAt: review.submittedAt,
      })),
    };
  }
  async listPullRequestFiles(repositoryUrl: string, number: number, options: { page: number }, scope: HostScope): Promise<{ files: Array<GitHubPullRequestChangedFile & { previous_filename?: string }>; nextPage?: number }> {
    this.serve("listPullRequestFiles", repositoryUrl, scope);
    if (!Number.isSafeInteger(options.page) || options.page < 1) throw agentXError("CONFIG_INVALID", "the page is invalid");
    const all = this.model.changedFiles(this.cr(number).id);
    const files = all.slice((options.page - 1) * 100, options.page * 100).map((file) => ({ filename: file.path, status: file.status, additions: file.additions, deletions: file.deletions }));
    return { files, ...(all.length > options.page * 100 ? { nextPage: options.page + 1 } : {}) };
  }
  async getPullRequestFeedback(repositoryUrl: string, number: number, scope: HostScope): Promise<GitHubPullRequestFeedback> {
    this.serve("getPullRequestFeedback", repositoryUrl, scope);
    const cr = this.cr(number);
    const head = this.model.headRevisionOf(cr);
    // Rovara's own comments are not feedback.
    const own = new Set(cr.comments.filter((comment) => comment.author === `${APP_SLUG}[bot]`).map((comment) => comment.id));
    const kinds = { review: "REVIEW", review_comment: "REVIEW_COMMENT", discussion: "DISCUSSION" } as const;
    const comments: GitHubFeedbackComment[] = cr.comments.filter((comment) => !own.has(comment.id)).map((comment) => ({
      id: comment.id, ...(comment.threadId === undefined ? {} : { threadId: comment.threadId }), kind: kinds[comment.kind], url: `${this.model.crUrl(cr.id)}#c${comment.id}`,
      author: comment.author, updatedAt: comment.updatedAt, body: comment.body, ...(comment.path === undefined ? {} : { path: comment.path }), ...(comment.line === undefined ? {} : { line: comment.line }),
    }));
    return {
      pullRequest: { ...this.detailsOf(cr), headTreeSha: this.model.revision(head).tree }, comments,
      threads: cr.threads.map((thread) => ({ id: thread.id, resolved: thread.resolved, commentIds: thread.commentIds.filter((id) => !own.has(id)) })),
    };
  }
  async replyToReviewThread(repositoryUrl: string, number: number, commentId: string, body: string, scope: HostScope, budget?: ReadBudget): Promise<"replied" | "gone"> {
    this.serve("replyToReviewThread", repositoryUrl, scope);
    this.spend(budget);
    return this.model.reply(this.cr(number).id, commentId, body, `${APP_SLUG}[bot]`);
  }
  async markPullRequestReady(repositoryUrl: string, number: number, scope: HostScope, budget?: ReadBudget): Promise<"ready" | "already_ready"> {
    this.serve("markPullRequestReady", repositoryUrl, scope);
    this.spend(budget);
    return this.model.markReady(this.cr(number).id);
  }
  async requestReviewers(repositoryUrl: string, number: number, reviewers: readonly string[], scope: HostScope, budget?: ReadBudget): Promise<"requested" | "refused"> {
    this.serve("requestReviewers", repositoryUrl, scope);
    this.spend(budget);
    if (reviewers.length === 0 || reviewers.length > 10) throw agentXError("CONFIG_INVALID", "reviewers must be one to ten names");
    return this.model.requestReviewers(this.cr(number).id, reviewers);
  }
  async mergePullRequest(repositoryUrl: string, number: number, input: { sha: string; method: "squash" | "merge" }, scope: HostScope): Promise<MergePullRequestResult> {
    this.serve("mergePullRequest", repositoryUrl, scope);
    const result = this.model.merge(this.cr(number).id, { revision: input.sha, method: input.method });
    if (result.outcome === "merged") return { outcome: "merged", method: result.method, fellBack: result.fellBack, ...(result.mergeRevision === undefined ? {} : { mergeCommitSha: result.mergeRevision }) };
    if (result.outcome === "already_merged") return { outcome: "already_merged" };
    return { outcome: "refused", reason: result.reason, ...(result.hostMessage === undefined ? {} : { githubMessage: result.hostMessage }) };
  }
  async getJobLogTail(repositoryUrl: string, jobId: string, scope: HostScope, budget?: ReadBudget): Promise<string | undefined> {
    this.serve("getJobLogTail", repositoryUrl, scope);
    this.spend(budget);
    return this.model.logOf(jobId);
  }
}
