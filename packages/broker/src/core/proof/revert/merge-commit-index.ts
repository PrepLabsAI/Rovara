// SRL-3 (owner decision 24b): the index from a pull request's merge commit to the Rovara task that made it, so a revert that names a commit ("This reverts commit <sha>") can be matched
// to a Rovara pull request. Until now the merge commit was seen by the GitHub reads that record a merge and kept nowhere a revert could find it.
//
//   pk ORG#<org>#GITHUB_MERGE    sk <owner/repo, lower case>#<40 hex, lower case>      (contracts `mergeCommitIndexKey`)
//
// The key is the company, the repository AND the commit (a commit id alone is not unique across repositories, forks or companies), and the row also names its company (`orgId`), which a
// reader checks. The company's close erases the partition (Cloud's company close; Code has one company). The row is written in the same transaction that records the merge (`merged-state.ts#mergedStateItems`), holds no person, and expires (the state table's TTL attribute) well after the
// longest time a revert is useful to the track record. The reader is `rovara-pull-request-index.ts`, and the revert detector (`revert-detect.ts`) is its consumer: no team record is involved. GitHub only, as the reverse links are.
import { INDEX_EXPIRY_ATTRIBUTE, mergeCommitIndexKey, type DocumentStore, type OrgId, type TransactItem, COMMIT_ID_PATTERN } from "@agentx/contracts";

export const MERGE_COMMIT_ENTITY = "GITHUB_WORKFLOW_MERGE";
/** How long a row is kept after it is written: a year and then some. */
export const MERGE_COMMIT_INDEX_KEPT_DAYS = 400;
/** A commit id of any hash length (item C4): the core never decides it is SHA-1. */
const SHA = COMMIT_ID_PATTERN;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const PULL_REQUEST_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,9})$/u;
const DAY_SECONDS = 86_400;

export interface MergeCommitRecord {
  pk: string;
  sk: string;
  entityType: typeof MERGE_COMMIT_ENTITY;
  orgId: OrgId;
  repositoryFullName: string;
  repositoryId: string;
  number: number;
  url: string;
  taskId: string;
  mergeCommit: string;
  createdAt: string;
  /** The expiry time, under the attribute the store sweeps (`ttlAttribute` of the store; the scheme default otherwise). */
  [ttl: string]: unknown;
}

/** The key of a company's repository and merge commit, or undefined when either is not one GitHub could have issued. The repository is lower-cased, the commit too. */
export function mergeCommitKey(orgId: OrgId, repositoryFullName: string, sha: string): { pk: string; sk: string } | undefined {
  const commit = sha.toLowerCase();
  if (!REPOSITORY.test(repositoryFullName) || !SHA.test(commit)) return undefined;
  return mergeCommitIndexKey(orgId, repositoryFullName, commit);
}

/** The repository and number a GitHub pull request address names, or undefined (another host, another shape). */
export function githubPullRequestAddress(url: string): { repositoryFullName: string; number: number } | undefined {
  const match = PULL_REQUEST_URL.exec(url);
  return match === null ? undefined : { repositoryFullName: match[1]!, number: Number(match[2]) };
}

export interface MergeCommitIndexInput { orgId: OrgId; repositoryFullName: string; repositoryId: string; number: number; url: string; taskId: string; mergeCommit: string; now: string }

/** The row for one merge, or undefined when its repository or commit cannot be keyed. */
export function mergeCommitIndexRecord(input: MergeCommitIndexInput, ttlAttribute: string = INDEX_EXPIRY_ATTRIBUTE): MergeCommitRecord | undefined {
  const key = mergeCommitKey(input.orgId, input.repositoryFullName, input.mergeCommit);
  const at = Date.parse(input.now);
  if (key === undefined || !Number.isFinite(at)) return undefined;
  return {
    ...key, entityType: MERGE_COMMIT_ENTITY, orgId: input.orgId, repositoryFullName: input.repositoryFullName.toLowerCase(), repositoryId: input.repositoryId, number: input.number, url: input.url,
    taskId: input.taskId, mergeCommit: input.mergeCommit.toLowerCase(), createdAt: input.now, [ttlAttribute]: Math.floor(at / 1000) + MERGE_COMMIT_INDEX_KEPT_DAYS * DAY_SECONDS,
  };
}

/** The step that goes in the merge's transaction. Unconditional: a replay writes the same values, and one commit is one row. */
export function mergeCommitIndexStep(input: MergeCommitIndexInput, ttlAttribute?: string): TransactItem | undefined {
  const record = mergeCommitIndexRecord(input, ttlAttribute);
  return record === undefined ? undefined : { kind: "put", item: record as unknown as Extract<TransactItem, { kind: "put" }>["item"] };
}

/**
 * The row for a repository's commit, or undefined. A row that does not say what its key says (its repository, its commit, its entity type) is not a row for this lookup. The caller still
 * has to check the company (`orgId`) and the task; nothing here grants anything.
 */
export async function findMergeCommit(store: Pick<DocumentStore, "get">, input: { orgId: OrgId; repositoryFullName: string; sha: string }): Promise<MergeCommitRecord | undefined> {
  const key = mergeCommitKey(input.orgId, input.repositoryFullName, input.sha);
  if (key === undefined) return undefined;
  const item = await store.get(key);
  if (item === undefined || item["entityType"] !== MERGE_COMMIT_ENTITY) return undefined;
  const { repositoryFullName, mergeCommit, orgId, repositoryId, url, taskId, number } = item;
  if (typeof repositoryFullName !== "string" || typeof mergeCommit !== "string" || orgId !== input.orgId || mergeCommitKey(input.orgId, repositoryFullName, mergeCommit)?.sk !== key.sk
    || typeof orgId !== "string" || typeof repositoryId !== "string" || typeof url !== "string" || typeof taskId !== "string" || typeof number !== "number" || !Number.isSafeInteger(number)) return undefined;
  return item as unknown as MergeCommitRecord;
}
