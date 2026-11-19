// Rovara Code (Plan 6 Task 19): whose approval on the code host counts toward a merge (Finding 1), and who the requesters of a task are. Port lane L7a: the rules are Cloud's, unchanged; the lookups of people go through `MergePeople` (people.ts). Rovara's rules govern only its own Merge button: merging
// on GitHub is governed by the repository's own branch protection. Pure: the lookups of who is a member are read by the callers (through `MergePeople`) and passed in.
import type { HostAccountKind, HostPermission, OrgId, ReviewState } from "@agentx/contracts";
import type { MergePeople } from "./people.js";
import type { MergeTask } from "./seams.js";

/** A review as the approval rules read it: the neutral review of the code-host port, with the reviewer's host account id always set (see `approvalReviewsOf`). */
export interface ApprovalReview {
  hostUserId: string;
  login: string;
  accountType: HostAccountKind;
  state: ReviewState;
  commitId: string;
  submittedAt: string;
}

export type RepositoryPermission = HostPermission;

export type ApprovalRefusal = "none" | "no_write" | "self_only" | "unlinked_requester" | "stale" | "changes_requested";
export type HumanApproval =
  | { approved: true; by: { hostUserId: string; login: string }; commitId: string; approvers: Array<{ hostUserId: string; login: string }> }
  | { approved: false; reason: ApprovalRefusal };

export interface ApprovalInput {
  reviews: readonly ApprovalReview[];
  headSha: string;
  /** The head the pull request had before a run of clean merges of the base (Task 17's `syncedFrom`): an approval of that head carries when CI passes on the merged head. */
  syncedFrom: string | undefined;
  ciPassingOnHead: boolean;
  /** The live permission of each reviewer, by login. A login with no entry has no access. */
  permissions: ReadonlyMap<string, RepositoryPermission>;
  /** The code-host accounts of the task's requesters, or "unlinked" when any requester has no linked account. */
  requesterHostUserIds: readonly string[] | "unlinked";
  /** The code-host accounts (among the reviewers) that are linked to a member of the org. */
  linkedHostUserIds: ReadonlySet<string>;
  /** The host account Rovara acts as: never counts, whatever its type says. */
  appUserId?: string | undefined;
  allowSelfApproval: boolean;
  /**
   * Host accounts (among the reviewers) that are linked to a person whose company role is not a writer's (the Auditor). Their approval never counts, in either mode: with self-approval on,
   * any account with write access would otherwise count, linked or not (I2). Absent: none known, which is how a caller built before this field behaves.
   */
  excludedHostUserIds?: ReadonlySet<string> | undefined;
}

const permissionOf = (permissions: ReadonlyMap<string, RepositoryPermission>, login: string): RepositoryPermission => permissions.get(login) ?? permissions.get(login.toLowerCase()) ?? "none";
const writes = (permission: RepositoryPermission): boolean => permission === "admin" || permission === "write";

/** The reviewers whose standing counts for a decision: each one's latest review among approving, asking for changes and dismissal (comments say nothing), a person and not a dismissed one. */
export function latestReviewers(reviews: readonly ApprovalReview[], appUserId?: string): ApprovalReview[] {
  const latest = new Map<string, ApprovalReview>();
  const ordered = reviews.map((review, index) => ({ review, index })).sort((left, right) => left.review.submittedAt.localeCompare(right.review.submittedAt) || left.index - right.index);
  for (const { review } of ordered) {
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED" && review.state !== "DISMISSED") continue;
    latest.set(review.hostUserId, review);
  }
  return [...latest.values()].filter((review) => review.state !== "DISMISSED" && review.accountType === "person" && review.hostUserId !== appUserId);
}

/**
 * Whose approval counts. Only a person (not an App or a bot) with write access counts; one of them asking for changes refuses; an approval counts on the head, or on the head before
 * a run of clean merges of the base when CI passes on the merged head. With self-approval off, the requesters must all have a linked host account and only an account linked to a
 * member who is not a requester counts.
 */
export function humanApprovalOf(input: ApprovalInput): HumanApproval {
  const people = latestReviewers(input.reviews, input.appUserId);
  const withWrite = people.filter((review) => writes(permissionOf(input.permissions, review.login)));
  if (withWrite.some((review) => review.state === "CHANGES_REQUESTED")) return { approved: false, reason: "changes_requested" };
  if (!people.some((review) => review.state === "APPROVED")) return { approved: false, reason: "none" };
  const writeApprovals = withWrite.filter((review) => review.state === "APPROVED" && input.excludedHostUserIds?.has(review.hostUserId) !== true);
  if (writeApprovals.length === 0) return { approved: false, reason: "no_write" };
  const fresh = writeApprovals.filter((review) => review.commitId === input.headSha || (input.syncedFrom !== undefined && review.commitId === input.syncedFrom && input.ciPassingOnHead));
  if (fresh.length === 0) return { approved: false, reason: "stale" };
  let counted = fresh;
  if (!input.allowSelfApproval) {
    if (input.requesterHostUserIds === "unlinked") return { approved: false, reason: "unlinked_requester" };
    const requesters = input.requesterHostUserIds;
    counted = fresh.filter((review) => input.linkedHostUserIds.has(review.hostUserId) && !requesters.includes(review.hostUserId));
    if (counted.length === 0) return { approved: false, reason: fresh.some((review) => requesters.includes(review.hostUserId)) ? "self_only" : "none" };
  }
  const newest = counted[counted.length - 1]!;
  return {
    approved: true, by: { hostUserId: newest.hostUserId, login: newest.login }, commitId: newest.commitId,
    approvers: counted.map((review) => ({ hostUserId: review.hostUserId, login: review.login })).reverse(),
  };
}

// ---- the people (read through MergePeople)

/** The people who asked for the task: its owner, its creator and whoever started it, each once. */
export function requesterIds(task: Pick<MergeTask, "ownerId" | "creatorId" | "startedBy">): string[] {
  return [...new Set([task.creatorId, task.startedBy?.developerId, task.ownerId].filter((id): id is string => typeof id === "string" && id !== ""))];
}

/** The requesters' code-host accounts, or "unlinked" when any of them has none (their approval cannot be told from a reviewer's). */
export function requesterHostIds(people: MergePeople, orgId: OrgId, task: MergeTask): Promise<string[] | "unlinked"> {
  return people.requestersOf(orgId, task);
}

/** Which of these accounts are linked to a person in the company who may approve. */
export function linkedAmong(people: MergePeople, orgId: OrgId, hostUserIds: readonly string[]): Promise<Set<string>> {
  return people.linkedAmong(orgId, [...new Set(hostUserIds)]);
}

/** Which of these accounts are linked to a person who is in the company but may not approve: their approval counts for nothing. */
export function nonWritersAmong(people: MergePeople, orgId: OrgId, hostUserIds: readonly string[]): Promise<Set<string>> {
  return people.nonWritersAmong(orgId, [...new Set(hostUserIds)]);
}
