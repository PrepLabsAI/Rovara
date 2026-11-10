// Plug-in foundations, task P3: GitHub's words to the neutral ones, and back. Pure functions: no I/O, and `github-app.ts` is not edited. Every untrusted
// text from GitHub is cut to the port's bounds here, so a long comment never fails a read that was otherwise fine.
import { agentXError, GITHUB_ACTIONS_APP_ID, type Check, type HostAccountKind, type MergeableState, type ChangeRequestDetails, type ChangeRequestFeedback, type ChangeRequestFile, type ChangeRequestRef, type ChangeRequestStatus, type HostScope, type MergeResult } from "@agentx/contracts";
import type {
  GitHubPullRequestChangedFile, GitHubPullRequestDetails, GitHubPullRequestFeedback, MergePullRequestResult, PullRequestCheck, PullRequestStatus,
} from "./provider.js";

const TEXT_MAX = 65_536;
const cut = (value: string, max: number): string => (value.length <= max ? value : [...value].slice(0, max).join(""));

/** The number of a change request GitHub knows: digits only, no leading zero. Anything else is refused before GitHub is asked. */
export function pullRequestNumber(ref: ChangeRequestRef): number {
  if (!/^[1-9][0-9]{0,9}$/.test(ref.id)) throw agentXError("CONFIG_INVALID", "the change request id is invalid");
  return Number(ref.id);
}

export function refOf(repositoryUrl: string, number: number, url: string): ChangeRequestRef {
  return { repository: { url: repositoryUrl }, id: String(number), url };
}

export function detailsOf(repositoryUrl: string, details: GitHubPullRequestDetails): ChangeRequestDetails {
  return {
    ref: refOf(repositoryUrl, details.number, details.url), state: details.state, sourceBranch: details.headBranch, targetBranch: details.baseBranch, headRevision: details.headCommit,
    ...(details.mergeCommit === undefined ? {} : { mergeRevision: details.mergeCommit }), ...(details.mergedAt === undefined ? {} : { mergedAt: details.mergedAt }), ...(details.mergedBy === undefined ? {} : { mergedBy: details.mergedBy }),
    title: cut(details.title, 500), body: cut(details.body, TEXT_MAX),
    ...(details.authoredByApp === undefined ? {} : { authoredByRovara: details.authoredByApp }), ...(details.baseRepositoryId === undefined ? {} : { baseRepositoryId: details.baseRepositoryId }),
  };
}

/** GitHub's account types in Rovara's words: a `User` is a person, a `Bot` a bot, anything else (an `Organization`, a type GitHub adds, nothing) is `other`. */
export function accountKindOf(type: string | undefined): HostAccountKind {
  return type === "User" ? "person" : type === "Bot" ? "bot" : "other";
}

/** GitHub's `mergeable_state` in Rovara's words: `dirty` is a conflict, `has_hooks` (mergeable, with passing commit statuses) is clean; the rest keep their meaning. */
export function mergeableStateOf(state: PullRequestStatus["mergeableState"]): MergeableState {
  return state === "dirty" ? "conflicted" : state === "has_hooks" ? "clean" : state;
}

export function checkOf(check: PullRequestCheck): Check {
  return {
    name: check.name, state: check.status === "completed" ? "completed" : "pending", ...(check.conclusion === undefined ? {} : { conclusion: check.conclusion }),
    required: check.required, url: check.url, ...(check.jobId === undefined ? {} : { runId: check.jobId }), ...(check.appId === undefined ? {} : { source: String(check.appId) }),
    // A GitHub Actions job (or a check with no app named) has a log the check runner can read by its job id; any other app's check has none here.
    ...(check.jobId !== undefined && (check.appId === undefined || check.appId === GITHUB_ACTIONS_APP_ID) ? { logReadable: true } : {}),
  };
}

export function statusOf(status: PullRequestStatus): ChangeRequestStatus {
  return {
    id: String(status.number), state: status.state, draft: status.draft, headRevision: status.headSha, targetBranch: status.baseBranch, mergeableState: mergeableStateOf(status.mergeableState),
    ...(status.mergeable === undefined ? {} : { mergeable: status.mergeable }), ...(status.behindBy === undefined ? {} : { behindBy: status.behindBy }),
    checks: status.checks.map(checkOf), ...(status.checksUnavailable === true ? { checksUnavailable: true as const } : {}),
    requiredChecks: status.requiredChecks.map((check) => ({ name: check.name, ...(check.appId === undefined ? {} : { source: String(check.appId) }) })),
    ...(status.reviewsIncomplete === true ? { reviewsIncomplete: true as const } : {}), targetHasRequiredChecks: status.baseHasRequiredChecks, headDefinesChecks: status.headHasWorkflowFiles,
    requestedReviewers: status.requestedReviewers, ...(status.requestedReviewerIds === undefined ? {} : { requestedReviewerIds: status.requestedReviewerIds }),
    reviews: status.reviews.map((review) => ({
      reviewer: { login: review.login, hostUserId: review.githubUserId }, accountType: accountKindOf(review.userType), state: review.state, revision: review.commitId, submittedAt: review.submittedAt,
    })),
  };
}

export function fileOf(file: GitHubPullRequestChangedFile & { previous_filename?: string }): ChangeRequestFile {
  return {
    path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions,
    ...(file.patch === undefined ? {} : { patch: file.patch }), ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
  };
}

export function feedbackOf(repositoryUrl: string, feedback: GitHubPullRequestFeedback): ChangeRequestFeedback {
  return {
    changeRequest: { ...detailsOf(repositoryUrl, feedback.pullRequest), headTreeRevision: feedback.pullRequest.headTreeSha },
    comments: feedback.comments.map((comment) => ({
      id: comment.id, ...(comment.threadId === undefined ? {} : { threadId: comment.threadId }), kind: comment.kind === "REVIEW" ? "review" as const : comment.kind === "REVIEW_COMMENT" ? "review_comment" as const : "discussion" as const,
      url: comment.url, author: comment.author, updatedAt: comment.updatedAt, body: cut(comment.body, TEXT_MAX),
      ...(comment.path === undefined ? {} : { path: comment.path }), ...(comment.line === undefined ? {} : { line: comment.line }),
    })),
    threads: feedback.threads.map((thread) => ({ id: thread.id, resolved: thread.resolved, commentIds: thread.commentIds })),
  };
}

export function mergeResultOf(result: MergePullRequestResult): MergeResult {
  if (result.outcome === "merged") return { outcome: "merged", method: result.method, fellBack: result.fellBack, ...(result.mergeCommitSha === undefined ? {} : { mergeRevision: result.mergeCommitSha }) };
  if (result.outcome === "already_merged") return { outcome: "already_merged" };
  return { outcome: "refused", reason: result.reason, ...(result.githubMessage === undefined ? {} : { hostMessage: result.githubMessage }) };
}

/**
 * The GitHub comment id a neutral id names, when it is one Rovara can reply to: an inline review comment, as `review_comment:<n>` or the bare number.
 * A review summary or a conversation comment (`review:`, `discussion:`) is not in a thread, so there is nothing to reply to. Anything else is not an id.
 */
export function replyTargetOf(commentId: string): { kind: "thread"; id: string } | { kind: "none" } {
  const match = /^(?:(review_comment|review|discussion):)?([1-9][0-9]{0,18})$/.exec(commentId);
  if (match === null) return { kind: "none" };
  return match[1] === undefined || match[1] === "review_comment" ? { kind: "thread", id: match[2]! } : { kind: "none" };
}

export type { HostScope };
