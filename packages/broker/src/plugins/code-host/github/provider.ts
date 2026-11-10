// Port lane L2: the GitHub client surface the GitHub adapters (code host and GitHub Actions check runner) are written against.
//
// In Cloud the adapters take `Pick<GitHubAppCredentialProvider, ...>` from `broker/src/github-app.ts`. This tree's `github-app.ts` is the older
// public client, which lacks about two thirds of these methods (status, feedback, merge, working branches, code owners, standing, path kinds)
// and has older result types. Porting Cloud's 2.8k-line client is the job of the task-flow and merge lanes (L6, L7), so the adapters are bound
// to THIS interface instead. Anything that implements it can sit under the adapters: Cloud's `GitHubAppCredentialProvider`, a client built on
// `gh` or a personal token for the local runtime (L4), or a test fixture. The types below are copies of Cloud's declarations in `github-app.ts`
// (same names, same fields); when a lane brings that client in, replace them with `export type { ... } from "../../../github-app.js"`.
import type { HostScope, ReadBudget } from "@agentx/contracts";
import type { PullRequestStatus } from "../../../github-pull-status.js";
import type { CommitFilesRequest } from "./commit-files.js";

export type { PullRequestCheck, PullRequestStatus } from "../../../github-pull-status.js";

export interface GitHubRepositoryIdentity { repositoryId: number; fullName: string; defaultBranch?: string; private?: boolean }

export interface GitHubPullRequestInput {
  repositoryUrl: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export interface GitHubPullRequestResult {
  number: number;
  url: string;
  reconciled: boolean;
  /** Set when the pull request was asked to be a draft, GitHub refused drafts for this repository, and it was opened once as a normal pull request instead. */
  draftRefused?: true;
}

export interface GitHubPullRequestDetails {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  headCommit: string;
  mergeCommit?: string;
  /** When GitHub says it merged (a merged pull request only). */
  mergedAt?: string;
  /** The login of the account that merged it, when GitHub says (a merged pull request only). */
  mergedBy?: string;
  title: string;
  body: string;
  /** The login of the account that created it, and the id of the repository it is against, when GitHub says. */
  authorLogin?: string;
  baseRepositoryId?: string;
  /** Whether that account is this App's own bot (set by `getPullRequest` only; absent when the App's login cannot be read, and never a yes on a laptop's personal token). */
  authoredByApp?: boolean;
}

export interface GitHubPullRequestUpdate {
  title?: string;
  body?: string;
  state?: "open" | "closed";
}

export interface GitHubPullRequestChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/** What a merge came to: merged (by the method asked, or the other one when the repository does not allow it), merged already, or refused for a fixed reason. */
export type MergePullRequestResult =
  | { outcome: "merged"; method: "squash" | "merge"; fellBack: boolean; mergeCommitSha?: string }
  | { outcome: "already_merged" }
  | { outcome: "refused"; reason: "head_changed" | "not_mergeable" | "closed" | "forbidden"; githubMessage?: string };

export interface GitHubFeedbackComment {
  id: string;
  threadId?: string;
  kind: "REVIEW" | "REVIEW_COMMENT" | "DISCUSSION";
  /** In-memory identity only; never part of feedback bundles or refs. */
  authorId?: string;
  authorType?: string;
  url: string;
  author: string;
  updatedAt: string;
  body: string;
  path?: string;
  line?: number;
}
/** A comment on a pull request's conversation as GitHub reports it (lane L12): the facts only. */
export interface GitHubIssueComment {
  id: string;
  /** The repository and the pull request (issue) number GitHub says it is on. */
  onRepositoryUrl: string;
  number: number;
  body: string;
  authorLogin: string;
  authorId?: string;
  isBot: boolean;
  createdAt: string;
  updatedAt: string;
  url: string;
}
export interface GitHubFeedbackThread { id: string; resolved: boolean; commentIds: string[] }
export interface GitHubPullRequestFeedback {
  pullRequest: GitHubPullRequestDetails & { headTreeSha: string };
  comments: GitHubFeedbackComment[];
  threads: GitHubFeedbackThread[];
  /** Comment id to whether the host records an edit of it. A comment not listed is unknown. */
  edits?: Readonly<Record<string, boolean>>;
}

export interface WorkingBranchPage { branches: string[]; page: number; mayHaveMore: boolean; omittedUnsupported: boolean }

/** The credential a clone or push gets: the account name and a token, with the time GitHub stops accepting it. */
export interface GitHubRepositoryCredential { username?: string; password?: string; expiresAt?: string }

/** Whose work a call is made for. The same shape as the neutral `HostScope`. */
export type GitHubTokenScope = HostScope;

/**
 * The rules a GitHub client must keep. The adapter cannot enforce these from above, so a client is held to them by a conformance suite that the lane bringing the client must run
 * (DEFERRED-CHECKS.md, "L2 GitHub client conformance"). Cloud's client keeps all of them:
 *  - **Tenant binding.** Every call is bound to `scope`: an organization scope reaches only the repositories of that organization's installation, checked on every call, not once. A call
 *    for a repository outside it throws; it never answers for another tenant.
 *  - **Least privilege.** A token minted for `clone` carries `contents: read`, one for `push` carries `contents: write`, nothing else, for the one repository asked for. A token is never
 *    reused across repositories, and `resolveWithExpiry` reports the expiry GitHub stated (none stated: no `expiresAt`, which the adapter refuses).
 *  - **No redirects, bounded requests.** Every request refuses redirects, has a timeout, and reads a bounded body. A branch or path is never placed in an address without being checked.
 *  - **Rate limits** are signalled with the neutral `HostRateLimitError`, never as a failure of the pull request.
 *  - **Untrusted text** (comments, logs, bodies) is returned as data; the client never follows an instruction in it.
 */
export interface GitHubCodeHostProvider {
  getRepositoryIdentity(repositoryUrl: string, scope: GitHubTokenScope): Promise<GitHubRepositoryIdentity | undefined>;
  checkRepository(repository: { credentialRef: string; url: string }, scope: GitHubTokenScope): Promise<void>;
  getRepositoryStanding(repositoryUrl: string, login: string, scope: GitHubTokenScope, budget?: ReadBudget): Promise<{ permission: "admin" | "write" | "read" | "none"; userType?: string }>;
  resolveWithExpiry(credentialRef: string, repositoryUrl: string, access: "clone" | "push", scope: GitHubTokenScope): Promise<GitHubRepositoryCredential>;
  getFileAtCommit(repositoryUrl: string, path: string, commitSha: string, scope: GitHubTokenScope, options?: { untilLine?: number; timeoutMs?: number; maxBytes?: number }): Promise<string | undefined>;
  /** Optional: a client that cannot tell a file from a directory leaves it out, and the adapter then has no `pathKind`. */
  getPathKindAtCommit?(repositoryUrl: string, path: string, commitSha: string, scope: GitHubTokenScope, options?: { timeoutMs?: number }): Promise<"file" | "dir" | "symlink" | "none">;
  /** Optional (item C1): puts text files on a Rovara lessons branch (see `commit-files.ts`). A client without it leaves the adapter without `commitFiles`. */
  commitFilesToBranch?(repositoryUrl: string, request: CommitFilesRequest, scope: GitHubTokenScope): Promise<{ revision: string; changed: boolean }>;
  /** Optional (item C1): the pull request (any state) made from one of Rovara's lessons branches. */
  findLessonsPullRequest?(repositoryUrl: string, branch: string, scope: GitHubTokenScope): Promise<{ number: number; url: string } | undefined>;
  /** Optional (item C1): deletes one of Rovara's lessons branches. */
  deleteLessonsBranch?(repositoryUrl: string, branch: string, scope: GitHubTokenScope): Promise<"deleted" | "gone">;
  getCommitTree(repositoryUrl: string, commitSha: string, scope: GitHubTokenScope): Promise<string>;
  getBranchHead(repositoryUrl: string, branch: string, scope: GitHubTokenScope): Promise<string>;
  listWorkingBranches(repositoryUrl: string, expected: { installationId: number; repositoryId: number }, scope: GitHubTokenScope, page?: number): Promise<WorkingBranchPage>;
  getCommitParents(repositoryUrl: string, commitSha: string, scope: GitHubTokenScope): Promise<string[]>;
  getDefaultBranchHead(repositoryUrl: string, branch: string, scope: GitHubTokenScope): Promise<string>;
  getPullRequestMergeObservation(repositoryUrl: string, number: number, budget: ReadBudget, scope: GitHubTokenScope): Promise<GitHubPullRequestDetails & { headTreeSha: string }>;
  installationForRepository(owner: string, name: string, options?: { fresh?: boolean }): Promise<{ installationId: number } | undefined>;
  readCodeOwners(repositoryUrl: string, branch: string, scope: GitHubTokenScope): Promise<string | undefined>;
  reconcilePullRequest(input: GitHubPullRequestInput, scope: GitHubTokenScope): Promise<GitHubPullRequestResult>;
  getPullRequest(repositoryUrl: string, number: number, scope: GitHubTokenScope): Promise<GitHubPullRequestDetails>;
  updatePullRequest(repositoryUrl: string, number: number, update: GitHubPullRequestUpdate, scope: GitHubTokenScope): Promise<GitHubPullRequestDetails>;
  getPullRequestStatus(repositoryUrl: string, number: number, scope: GitHubTokenScope, budget?: ReadBudget): Promise<PullRequestStatus>;
  listPullRequestFiles(repositoryUrl: string, number: number, options: { page: number }, scope: GitHubTokenScope): Promise<{ files: Array<GitHubPullRequestChangedFile & { previous_filename?: string }>; nextPage?: number }>;
  getPullRequestFeedback(repositoryUrl: string, number: number, scope: GitHubTokenScope): Promise<GitHubPullRequestFeedback>;
  replyToReviewThread(repositoryUrl: string, number: number, commentId: string, body: string, scope: GitHubTokenScope, budget?: ReadBudget): Promise<"replied" | "gone">;
  /** Optional (lane L12): the comments on a pull request's conversation, fetch only. A client that cannot leaves it out and the adapter has no `comments`. */
  listPullRequestComments?(repositoryUrl: string, number: number, options: { since?: string; page?: number }, scope: GitHubTokenScope, budget?: ReadBudget): Promise<{ comments: GitHubIssueComment[]; nextPage?: number }>;
  /** Optional (lane L12): one comment of Rovara's own fixed text on a pull request's conversation. */
  postPullRequestComment?(repositoryUrl: string, number: number, text: string, scope: GitHubTokenScope, budget?: ReadBudget): Promise<"posted" | "gone">;
  markPullRequestReady(repositoryUrl: string, number: number, scope: GitHubTokenScope, budget?: ReadBudget): Promise<"ready" | "already_ready">;
  requestReviewers(repositoryUrl: string, number: number, reviewers: readonly string[], scope: GitHubTokenScope, budget?: ReadBudget): Promise<"requested" | "refused">;
  mergePullRequest(repositoryUrl: string, number: number, input: { sha: string; method: "squash" | "merge" }, scope: GitHubTokenScope): Promise<MergePullRequestResult>;
  /** The tail of a GitHub Actions job's log (untrusted text). Used by the GitHub Actions check runner. */
  getJobLogTail(repositoryUrl: string, jobId: string, scope: GitHubTokenScope, budget?: ReadBudget): Promise<string | undefined>;
}

/** What the GitHub Actions check runner needs of the client. */
export type GitHubActionsProvider = Pick<GitHubCodeHostProvider, "getPullRequestStatus" | "getJobLogTail">;

/** The methods a client must have before an adapter is built over it: a client built from an older tree is refused at start-up, not at its first call. */
export const GITHUB_CODE_HOST_PROVIDER_METHODS = [
  "getRepositoryIdentity", "checkRepository", "getRepositoryStanding", "resolveWithExpiry", "getFileAtCommit", "getCommitTree", "getBranchHead", "listWorkingBranches", "getCommitParents",
  "getDefaultBranchHead", "getPullRequestMergeObservation", "installationForRepository", "readCodeOwners", "reconcilePullRequest", "getPullRequest", "updatePullRequest", "getPullRequestStatus",
  "listPullRequestFiles", "getPullRequestFeedback", "replyToReviewThread", "markPullRequestReady", "requestReviewers", "mergePullRequest", "getJobLogTail",
] as const satisfies readonly (keyof GitHubCodeHostProvider)[];

/** The names of the required methods the client lacks (empty when it is complete). Values are never read, only the method names. */
export function missingGitHubProviderMethods(provider: unknown): string[] {
  const holder = provider as Record<string, unknown> | null | undefined;
  return GITHUB_CODE_HOST_PROVIDER_METHODS.filter((name) => typeof holder?.[name] !== "function");
}
