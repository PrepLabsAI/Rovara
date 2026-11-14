// Plug-in foundations P5a-c: how Rovara Code's consumers (merge, merge tracking, CI fix, feedback autonomy) reach a repository's code host.
//
// They no longer hold a GitHub provider. They ask for the repository of a task's project and get back the address, the code host that serves it and, where there is one, the check runner
// for its builds. The code host is chosen by the repository's `host` record (task P7: `CodeHostRouter.forRecord`), never by the address and never by a default: a kind with no
// registered adapter is refused with a fixed sentence, so a repository on an unknown host is not read through GitHub by accident.
//
// Two small things that the CodeHost port does not carry yet live here, named, so the gap is visible and not silent:
//   - `isTeamMember`: whether a person is in a team of the repository's organization (CODEOWNERS teams). GitHub-only today; absent means "unknown", which fails closed.
//   - (P6 closed the rate-limit gap: a host's limit is the neutral `HostRateLimitError`, which GitHub's class extends.)
import { hostRateLimitRetryAt, type ChangeRequestFile, type ChangeRequestRef, type ChangeRequestStatus, type CheckRunner, type CodeHost, type HostScope, type OrgId, type Review } from "@agentx/contracts";
import type { ApprovalReview } from "./approval.js";

/** One repository of a task's project, as the consumers read it. */
export interface ConsumerRepository {
  /** The address the project pins. */
  url: string;
  /** The code host the repository's record names. */
  codeHost: CodeHost;
  /** The runner that reads this host's builds (their log tails), when the host has one registered. */
  checkRunner?: CheckRunner | undefined;
  /** Whether a person is in a team (`org/slug`) of the repository's organization. Absent: no team can be told, so a code-owner team is never matched. */
  isTeamMember?: ((team: string, login: string, scope: HostScope) => Promise<"member" | "not_member" | "unknown">) | undefined;
}

/**
 * The repository of a task's project, by the project's pinned revision. Undefined where the project has no such repository. Throws (CONFIG_INVALID, a fixed sentence) when the
 * repository's record names a code host this install has not registered.
 */
export type RepositoryResolver = (project: string, revision: number, repositoryId: string, orgId: OrgId) => Promise<ConsumerRepository | undefined>;

/** The change request an id names at a repository (a host that numbers its change requests gives the number; any other host its own string, item C4). */
export const changeRequestRef = (repositoryUrl: string, id: number | string): ChangeRequestRef => ({ repository: { url: repositoryUrl }, id: String(id), url: "" });

/**
 * The reviews of a change request in the shape the approval rules read (`approval.ts` is not edited: the Auditor filter and the write-access rules stay exactly as they are).
 * A review whose host gives no account id for the reviewer can never be linked to a member, so it cannot be checked against the Auditor exclusion: it may BLOCK (changes requested,
 * told apart by `login:<name>`) but it never counts as an approval, with self-approval on or off. Dropping an approval can only leave an earlier review of the same person in
 * force, so it never turns a refusal into a pass.
 */
export function approvalReviewsOf(reviews: ChangeRequestStatus["reviews"] | readonly Review[]): ApprovalReview[] {
  return reviews.filter((review) => review.reviewer.hostUserId !== undefined || review.state !== "APPROVED").map((review) => ({
    hostUserId: review.reviewer.hostUserId ?? `login:${review.reviewer.login.toLowerCase()}`, login: review.reviewer.login, accountType: review.accountType, state: review.state,
    commitId: review.revision, submittedAt: review.submittedAt,
  }));
}

/** The retry time of a host's rate limit, when the error is one: the neutral `HostRateLimitError` of any host (GitHub's class is one). */
export function rateLimitRetryAt(error: unknown): number | undefined {
  return hostRateLimitRetryAt(error);
}

export const isHostRateLimit = (error: unknown): boolean => rateLimitRetryAt(error) !== undefined;

export const CHANGED_PATH_PAGES = 10;
/** The files a change request changes, as the host lists them (at most `CHANGED_PATH_PAGES` pages), and whether that is all of them. `beforeRequest` is the caller's read allowance. */
export async function readChangeRequestFiles(codeHost: CodeHost, ref: ChangeRequestRef, scope: HostScope, beforeRequest?: () => void): Promise<{ files: ChangeRequestFile[]; complete: boolean }> {
  const files: ChangeRequestFile[] = [];
  for (let page = 1; page <= CHANGED_PATH_PAGES; page += 1) {
    beforeRequest?.();
    const read = await codeHost.changedFiles(ref, page, scope);
    files.push(...read.files);
    if (read.nextPage === undefined) return { files, complete: true };
  }
  return { files, complete: false };
}
/** Every path a change request touches, a renamed file under both names, and whether that is all of them (the code-owner check). At most `CHANGED_PATH_PAGES` pages of the host's files. */
export async function changedPathsOf(codeHost: CodeHost, ref: ChangeRequestRef, scope: HostScope): Promise<{ paths: string[]; complete: boolean }> {
  const paths: string[] = [];
  for (let page = 1; page <= CHANGED_PATH_PAGES; page += 1) {
    const read = await codeHost.changedFiles(ref, page, scope);
    for (const file of read.files) paths.push(file.path, ...(file.previousPath === undefined ? [] : [file.previousPath]));
    if (read.nextPage === undefined) return { paths, complete: true };
  }
  return { paths, complete: false };
}
