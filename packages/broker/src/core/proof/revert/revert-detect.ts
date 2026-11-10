// Revert detection without the Team record. A Rovara pull request that is later reverted is a fact about the task ("reverted"), and it must not depend on the Team record (decision 41 puts that in Cloud).
// This module finds the revert from what the code host says, proves that a person with write access stands behind it, and records ONE `TASK_REVERT` row for the task. The track record, the lessons and the task page
// read that row (Cloud's Team record adapter reads it too, and so does not need its own tap).
//
// Two ways a revert is told, both by words, which anyone who can get a commit or a pull request onto the default branch can write; so each counts only when a person with write access is proved behind it:
//  - a merged revert PULL REQUEST (title `Revert "..."`, body `Reverts #12` or `This reverts commit <sha>`), merged into the default branch by an account that can write to the repository and is not a bot;
//  - a COMMIT pushed to the default branch (subject `Revert "..."`, a body line `This reverts commit <sha>`), when the host can show the commit (its author, its committer, whether it is a merge and verified)
//    and its author and the account that pushed it both can write. Port gap: the CodeHost port has no commit read, and the push event names no pusher, so the caller supplies `CommitReader` and `pusher`.
// Anything unproven records nothing. A revert of a revert names the first revert's commit, so it matches nothing and the task stays reverted (there is no un-revert).
import { when, type ChangeRequestRef, type CodeHost, type DocumentStore, type HostAccount, type HostScope, type OrgId, type RepositoryRef, COMMIT_ID_PATTERN, COMMIT_ID_SOURCE } from "@agentx/contracts";
import { providerOf } from "../../../plugins/routing.js";
import type { RovaraPullRequest, RovaraPullRequestIndex } from "./rovara-pull-request-index.js";

/** A commit id of any hash length (item C4): the core never decides it is SHA-1. */
const SHA = COMMIT_ID_PATTERN;
const REVERTS_COMMIT = new RegExp(`This reverts commit (${COMMIT_ID_SOURCE})\\b`, "giu");
/** The most revert targets one signal can name. */
const TARGETS_MAX = 20;

/** The commits a pushed commit reverts, only when it has git's own revert shape: a subject that starts `Revert "` and a body line that STARTS with "This reverts commit <sha>". */
export function gitRevertedCommits(message: string): string[] {
  const subject = message.split("\n", 1)[0] ?? "";
  if (!/^Revert\s+["“']/iu.test(subject.trim())) return [];
  const out = new Set<string>();
  for (const match of message.matchAll(new RegExp(`^This reverts commit (${COMMIT_ID_SOURCE})\\b`, "gimu"))) out.add(match[1]!.toLowerCase());
  return [...out].slice(0, TARGETS_MAX);
}

/** Full commit ids named by "This reverts commit <sha>". */
export function revertedCommits(message: string): string[] {
  const out = new Set<string>();
  for (const match of message.matchAll(REVERTS_COMMIT)) out.add(match[1]!.toLowerCase());
  return [...out].slice(0, TARGETS_MAX);
}

/** Pull request numbers named by GitHub's revert body, "Reverts owner/repo#12" or "Reverts #12". Another repository's number is not ours. */
export function revertedPullRequests(body: string, fullName: string): number[] {
  const out = new Set<number>();
  for (const match of body.matchAll(/\bReverts\s+(?:([\w.-]+\/[\w.-]+))?#(\d{1,9})\b/giu)) {
    if (match[1] !== undefined && match[1].toLowerCase() !== fullName.toLowerCase()) continue;
    out.add(Number(match[2]));
  }
  return [...out].slice(0, 5);
}

/** What the host shows of a commit. Supplied by the adapter (port gap, see the header). */
export interface CommitFacts {
  sha: string;
  message: string;
  /** More than one parent: a merge commit never counts as a revert. */
  parents: number;
  verified: boolean;
  author?: HostAccount | undefined;
  committer?: HostAccount | undefined;
  /** The host's own web committer (GitHub's squash and web edits): its commit has the author as the person. The adapter MUST set it from the host's web-flow account id, never from a login or the message text. */
  webFlow?: boolean | undefined;
  authorIsBot?: boolean | undefined;
}
export type CommitReader = (repository: RepositoryRef, sha: string) => Promise<CommitFacts | undefined>;

export interface RevertDetectorDependencies {
  store: Pick<DocumentStore, "put">;
  companyId: OrgId;
  /** The code host of the repository the signal came from (chosen by the caller from the repository's record, never by the address). */
  codeHost: Pick<CodeHost, "kind" | "getChangeRequest" | "repositoryIdentity" | "standing">;
  index: RovaraPullRequestIndex;
  readCommit?: CommitReader | undefined;
  /** Accounts that never count as a person behind a revert (a service account, an excluded user). Cloud's company exclusion list plugs in here. */
  isExcluded?: ((login: string) => boolean) | undefined;
  now: () => number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export interface RevertFinding {
  taskId: string;
  project: string;
  number: number;
  url: string;
  /** The reverting commit, or the reverting pull request's merge commit (or its address). */
  via: string;
  /** The person credited, proved to have write access. */
  reverter: string;
}

/** The key of the row that says a task was reverted: in the task's partition, one per pull request. */
export const revertRecordKey = (taskId: string, repositoryKey: string, number: number): { pk: string; sk: string } => ({ pk: `DEVTASK#${taskId}`, sk: `REVERT#${repositoryKey.toLowerCase()}#${String(number).padStart(10, "0")}` });

/**
 * A person who can change the repository's code: write or admin standing, and not a bot or an excluded account. Unreadable standing is unproven.
 * Known weakening against Cloud (accepted for Code, one company): Cloud required a live company MEMBER; here a collaborator with write access counts, because Code has no member list beyond the host's.
 */
async function canWrite(deps: RevertDetectorDependencies, repository: RepositoryRef, person: HostAccount | undefined, scope: HostScope, isBot?: boolean): Promise<boolean> {
  if (person === undefined || isBot === true || /\[bot\]$/iu.test(person.login) || deps.isExcluded?.(person.login) === true) return false;
  try {
    const standing = await deps.codeHost.standing(repository, person, scope);
    return (standing.permission === "write" || standing.permission === "admin") && standing.accountType === "person";
  } catch {
    return false;
  }
}

async function record(deps: RevertDetectorDependencies, repositoryFullName: string, target: RovaraPullRequest, via: string, reverter: string): Promise<RevertFinding | undefined> {
  const written = await deps.store.put({
    item: {
      ...revertRecordKey(target.taskId, repositoryFullName, target.number), entityType: "TASK_REVERT", orgId: deps.companyId, taskId: target.taskId, project: target.project, repositoryFullName: repositoryFullName.toLowerCase(),
      number: target.number, url: target.url, via, reverter, detectedAt: new Date(deps.now()).toISOString(),
    },
    condition: when.absent(),
  });
  // One revert per Rovara pull request, however many deliveries or ways tell us of it.
  return written.applied ? { taskId: target.taskId, project: target.project, number: target.number, url: target.url, via, reverter } : undefined;
}

/** A change request that was merged: if it is a revert of Rovara pull requests merged by a person who can write, each is recorded as reverted. Returns what was newly recorded. */
export async function detectRevertFromMergedChangeRequest(deps: RevertDetectorDependencies, ref: ChangeRequestRef, scope: HostScope): Promise<RevertFinding[]> {
  const identity = await deps.codeHost.repositoryIdentity(ref.repository, scope);
  if (identity?.defaultBranch === undefined) return [];
  const details = await deps.codeHost.getChangeRequest(ref, scope);
  if (details.state !== "merged" || details.targetBranch !== identity.defaultBranch || !/^revert\s+["“']/iu.test(details.title.trim())) return [];
  const targets: RovaraPullRequest[] = [];
  // Rows are filed by the connection's PROVIDER, so a GitHub connection of any name is read (review N3); an older row under the connection's own name is still found.
  const host = providerOf(deps.codeHost);
  const connection = deps.codeHost.kind;
  for (const number of revertedPullRequests(details.body, identity.fullName)) {
    const found = await deps.index.byNumber({ host, connection, repo: identity.fullName, number });
    if (found !== undefined) targets.push(found);
  }
  for (const sha of revertedCommits(details.body)) {
    const found = await deps.index.byMergeCommit({ host, connection, repo: identity.fullName, sha });
    if (found !== undefined) targets.push(found);
  }
  if (targets.length === 0) return [];
  // A revert pull request counts only when it was MERGED by an account that can write: the host's `mergedBy`, whoever opened it (a bot or an outsider can open one that a person then merges).
  const merger: HostAccount | undefined = details.mergedBy === undefined ? undefined : { login: details.mergedBy };
  if (!(await canWrite(deps, ref.repository, merger, scope))) {
    deps.log?.("revert.unproven", { host });
    return [];
  }
  const via = details.mergeRevision ?? ref.url ?? ref.id;
  const seen = new Set<string>();
  const found: RevertFinding[] = [];
  for (const target of targets.filter((entry) => !seen.has(entry.taskId) && seen.add(entry.taskId)).slice(0, TARGETS_MAX)) {
    const made = await record(deps, identity.fullName, target, via, merger!.login);
    if (made !== undefined) found.push(made);
  }
  return found;
}

/** A commit pushed to the default branch: if it is a git revert of Rovara pull requests, authored and pushed by people who can write, each is recorded as reverted. */
export async function detectRevertFromPushedCommit(
  deps: RevertDetectorDependencies,
  /** `pushedShas`: the commits of THIS push (the host's compare of before..after, whole, not truncated). A commit the push did not carry is not a revert by this push. */
  input: { repository: RepositoryRef; branch: string; sha: string; pusher: HostAccount | undefined; pushedShas: readonly string[] }, scope: HostScope,
): Promise<RevertFinding[]> {
  if (deps.readCommit === undefined || !SHA.test(input.sha) || !input.pushedShas.includes(input.sha)) return [];
  const identity = await deps.codeHost.repositoryIdentity(input.repository, scope);
  if (identity?.defaultBranch === undefined || input.branch !== identity.defaultBranch) return [];
  const commit = await deps.readCommit(input.repository, input.sha);
  if (commit === undefined || commit.sha !== input.sha) return [];
  const targets: RovaraPullRequest[] = [];
  for (const sha of gitRevertedCommits(commit.message)) {
    const found = await deps.index.byMergeCommit({ host: providerOf(deps.codeHost), connection: deps.codeHost.kind, repo: identity.fullName, sha });
    if (found !== undefined) targets.push(found);
  }
  if (targets.length === 0) return [];
  // The commit must be an ordinary verified commit whose AUTHOR can write, committed by that author (or the host's web committer), and pushed by an account that can write.
  // By id only: a login can be renamed or reused.
  const sameCommitter = commit.webFlow === true || (commit.committer?.hostUserId !== undefined && commit.committer.hostUserId === commit.author?.hostUserId);
  const proven = commit.parents === 1 && commit.verified && sameCommitter
    && await canWrite(deps, input.repository, commit.author, scope, commit.authorIsBot) && await canWrite(deps, input.repository, input.pusher, scope);
  if (!proven) {
    deps.log?.("revert.unproven", { host: deps.codeHost.kind });
    return [];
  }
  const seen = new Set<string>();
  const found: RevertFinding[] = [];
  for (const target of targets.filter((entry) => !seen.has(entry.taskId) && seen.add(entry.taskId)).slice(0, TARGETS_MAX)) {
    const made = await record(deps, identity.fullName, target, commit.sha, commit.author!.login);
    if (made !== undefined) found.push(made);
  }
  return found;
}
