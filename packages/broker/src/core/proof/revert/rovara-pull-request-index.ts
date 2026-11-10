// Finds Rovara's own pull requests, for the revert detector. It replaces the Team record's `RovaraPullRequestIndexPort` (Cloud-only): Code keeps its own small port, and this is its
// implementation over the document store. The lookup by merge commit sits beside the index it reads (`merge-commit-index.ts`); the task records and the reverse links are the task flow's.
//
// Only a pull request this returns is a Rovara pull request: a branch name alone proves nothing.
import { OrgIdSchema, type DocumentStore, type OrgId, type TransactItem } from "@agentx/contracts";
import { taskKey, type DeveloperTaskRecord } from "../../../developer/task-records.js";
import { findLinkedChangeRequest } from "./linked-change-requests.js";
import { findMergeCommit, githubPullRequestAddress, mergeCommitIndexStep } from "./merge-commit-index.js";

export interface RovaraPullRequest {
  taskId: string;
  project: string;
  number: number;
  url: string;
  /** The last commit Rovara itself pushed to the pull request's branch. */
  candidateHeadSha: string;
  mergeCommitSha?: string;
}

export interface RovaraPullRequestIndex {
  /** `host` is the PROVIDER (`github`); `connection` is the code host connection's own name, read only to find a row an earlier build filed under it. */
  byNumber(input: { host: string; connection?: string | undefined; repo: string; number: number }): Promise<RovaraPullRequest | undefined>;
  byMergeCommit(input: { host: string; connection?: string | undefined; repo: string; sha: string }): Promise<RovaraPullRequest | undefined>;
  /**
   * The step that keeps a merge commit, to go in the transaction that records the merge (lane L7a): the merge commit is the default branch's commit, not the pull request's head. Holds no person.
   * Undefined when the repository or the commit cannot be keyed.
   */
  mergeStep(input: { repo: string; repositoryId: string; number: number; url: string; taskId: string; mergeCommitSha: string; now: string }): TransactItem | undefined;
}

export interface RovaraPullRequestIndexDependencies {
  store: Pick<DocumentStore, "get"> & { ttlAttribute?: string | undefined };
  /** The company the index belongs to: Code's one implicit company, or Cloud's company. */
  companyId: OrgId;
}

export function createRovaraPullRequestIndex(deps: RovaraPullRequestIndexDependencies): RovaraPullRequestIndex {
  async function byNumber({ host, connection, repo, number }: { host: string; connection?: string | undefined; repo: string; number: number }): Promise<RovaraPullRequest | undefined> {
    if (host !== "github") return undefined;
    const linked = await findLinkedChangeRequest(deps.store, { hostKind: "github", connectionKind: connection, repositoryAddress: `https://github.com/${repo}`, id: String(number) });
    // The link must belong to THIS company: a pull request number is only unique inside a repository, and a repository belongs to one company's installation.
    if (linked === undefined || linked.workspaceId === undefined) return undefined;
    const task = (await deps.store.get(taskKey(linked.taskId))) as unknown as DeveloperTaskRecord | undefined;
    if (task === undefined || (task as { orgId?: string }).orgId !== deps.companyId) return undefined;
    const entry = task.workflow?.pullRequests?.find((pullRequest) => pullRequest.number === number && pullRequest.url === linked.url);
    if (entry?.headSha === undefined) return undefined;
    return { taskId: task.taskId, project: task.project, number, url: linked.url, candidateHeadSha: entry.headSha };
  }

  return {
    byNumber,
    // The pull request merged as this commit: the index row (repository + commit) names a pull request, which must then be that company's Rovara pull request, linked to the task the row
    // names, at the address the row names. Anything that does not agree is a miss: a revert is then not recorded, never recorded against the wrong task.
    async byMergeCommit({ host, connection, repo, sha }) {
      if (host !== "github") return undefined;
      const org = OrgIdSchema.safeParse(deps.companyId);
      if (!org.success) return undefined;
      const row = await findMergeCommit(deps.store, { orgId: org.data, repositoryFullName: repo, sha });
      if (row === undefined || row.orgId !== deps.companyId) return undefined;
      const address = githubPullRequestAddress(row.url);
      if (address === undefined || address.number !== row.number || address.repositoryFullName.toLowerCase() !== repo.toLowerCase()) return undefined;
      const found = await byNumber({ host, connection, repo, number: row.number });
      if (found === undefined || found.taskId !== row.taskId || found.url !== row.url) return undefined;
      return { ...found, mergeCommitSha: row.mergeCommit };
    },
    mergeStep(input) {
      return mergeCommitIndexStep({ orgId: deps.companyId, repositoryFullName: input.repo, repositoryId: input.repositoryId, number: input.number, url: input.url, taskId: input.taskId, mergeCommit: input.mergeCommitSha, now: input.now }, deps.store.ttlAttribute);
    },
  };
}
