// SRL-3 (owner decision 24b), ported by lane L7a: the index from a pull request's merge commit to the Rovara task that made it, so a revert that names a commit ("This reverts commit <sha>")
// can be matched to a Rovara pull request without any team record (lane L7b reads it with `findMergeCommit`).
//
//   pk ORG#<org>#GITHUB_MERGE    sk <owner/repo, lower case>#<40 hex, lower case>      (contracts `mergeCommitIndexKey`)
//
// The key is the company, the repository AND the commit (a commit id alone is not unique across repositories, forks or companies), and the row also names its company (`orgId`), which a
// reader checks. The row is written in the same transaction that records the merge (`merged-state.ts#mergedStateItems`), holds no person, and expires (the store's time-to-live attribute)
// well after the longest time a revert is useful. The backfill from the track record's samples is Cloud's (there is no track record in Code) and is not ported.
import { INDEX_EXPIRY_ATTRIBUTE, mergeCommitIndexKey, type DocumentStore, type OrgId, type TransactItem } from "@agentx/contracts";
import { codeHostRepositoryKey } from "./repository-key.js";
import { plain } from "./store.js";

export const MERGE_COMMIT_ENTITY = "GITHUB_WORKFLOW_MERGE";
/** How long a row is kept after it is written: a year and then some. */
export const MERGE_COMMIT_INDEX_KEPT_DAYS = 400;
const SHA = /^[0-9a-f]{40}$/u;
// Decision 51 gap: the index key is the repository's `owner/name` spelling, which only GitHub-shaped addresses have (`repository-key.ts`). A host whose key is `<kind>:<address>` gets no row
// (counted as a miss by `mergedStateItems`), so a revert on such a host is not matched until the key spelling is widened with both owners' say.
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
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
  [INDEX_EXPIRY_ATTRIBUTE]: number;
}

/** The key of a company's repository and merge commit, or undefined when either is not one the index can hold. The repository is lower-cased, the commit too. */
export function mergeCommitKey(orgId: OrgId, repositoryFullName: string, sha: string): { pk: string; sk: string } | undefined {
  const commit = sha.toLowerCase();
  if (!REPOSITORY.test(repositoryFullName) || !SHA.test(commit)) return undefined;
  return mergeCommitIndexKey(orgId, repositoryFullName, commit);
}

/**
 * The repository key and number a change request address names for this code host, or undefined (another shape). The pull request's address is the one the workflow recorded; only the
 * host's own kind says how to read it.
 */
export function changeRequestAddress(hostKind: string, url: string): { repositoryFullName: string; number: number } | undefined {
  const match = /^(.*)\/(?:pull|pulls|merge_requests|-\/merge_requests)\/([1-9][0-9]{0,9})$/u.exec(url);
  if (match === null) return undefined;
  const repositoryFullName = codeHostRepositoryKey(hostKind, match[1]!);
  return repositoryFullName === undefined ? undefined : { repositoryFullName, number: Number(match[2]) };
}

export interface MergeCommitIndexInput { orgId: OrgId; repositoryFullName: string; repositoryId: string; number: number; url: string; taskId: string; mergeCommit: string; now: string }

/** The row for one merge, or undefined when its repository or commit cannot be keyed. */
export function mergeCommitIndexRecord(input: MergeCommitIndexInput): MergeCommitRecord | undefined {
  const key = mergeCommitKey(input.orgId, input.repositoryFullName, input.mergeCommit);
  const at = Date.parse(input.now);
  if (key === undefined || !Number.isFinite(at)) return undefined;
  return {
    ...key, entityType: MERGE_COMMIT_ENTITY, orgId: input.orgId, repositoryFullName: input.repositoryFullName.toLowerCase(), repositoryId: input.repositoryId, number: input.number, url: input.url,
    taskId: input.taskId, mergeCommit: input.mergeCommit.toLowerCase(), createdAt: input.now, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at / 1000) + MERGE_COMMIT_INDEX_KEPT_DAYS * DAY_SECONDS,
  };
}

/** The Put that goes in the merge's transaction. Unconditional: a replay writes the same values, and one commit is one row. */
export function mergeCommitIndexItem(input: MergeCommitIndexInput): TransactItem | undefined {
  const record = mergeCommitIndexRecord(input);
  return record === undefined ? undefined : { kind: "put", item: plain(record) };
}

/**
 * The row for a repository's commit, or undefined. A row that does not say what its key says (its repository, its commit, its entity type) is not a row for this lookup. The caller still
 * has to check the company (`orgId`) and the task; nothing here grants anything. Revert detection (lane L7b) reads the index through this function, with no team record.
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
