// Owner decision D1 (2026-11-08): Rovara may force-push a branch only when ONLY Rovara has ever written to it. This is the record that proves it, and it errs the safe way.
//
// One row per BRANCH (company, repository, branch name, lower case), not per task or pull request: a second task, or a reopened pull request, on a branch a person once pushed to does not start clean.
//  - the row is CREATED, as `rovara_only`, only by `openBranchWriters`, called by the publish path when Rovara opens the pull request on a branch it just created. A tracking pass never creates a
//    `rovara_only` row, so a deleted or expired row, or a branch Rovara did not create, stays `unknown` (not a proof);
//  - a tracking pass calls `noteBranchHead` with the STRICT fact: is the head one of the commits Rovara itself pushed (its recorded push set)? An optimistic "the push is still pending" is not that fact.
//    A head that is not Rovara's sets `personPushed: true`, for good (a person who pushed once and then put the branch back is still a person who wrote to it). A head that is Rovara's writes nothing;
//  - a force-push the host refused (a protected branch, a lost lease) sets `restackRefused: true`, so the next try is a merge.
// No row means nobody has looked, which is not the same as "nobody else has written": a branch with no row is NOT Rovara-only.
import { plainBranchName } from "./restack.js";
import { companyScoped, when, type DocumentStore, type OrgId } from "@agentx/contracts";

export interface BranchWritersKey { orgId: OrgId; repositoryId: string; branch: string }

export type BranchWriters =
  /** The branch was created by Rovara and no pass has seen a head that is not Rovara's. */
  | { state: "rovara_only"; restackRefused: boolean }
  /** A person's push was seen at some time. */
  | { state: "person_pushed"; restackRefused: boolean }
  /** No record is held: not a proof of anything. */
  | { state: "unknown" };

const REPOSITORY_PART = /^[A-Za-z0-9_.:-]{1,200}$/u;
/** A branch name as the record keys it: the same characters `forcePushLease` allows in a git argument. */
const BRANCH_PART = /^[A-Za-z0-9._/+-]{1,250}$/u;

export function branchWritersKey(key: BranchWritersKey): { pk: string; sk: string } {
  // The branch as the name alone: a `refs/heads/` spelling is the same branch; any other `refs/` spelling, HEAD or a force marker is not a branch name.
  const branch = plainBranchName(key.branch);
  if (!REPOSITORY_PART.test(key.repositoryId) || !BRANCH_PART.test(key.branch) || branch === undefined) throw new Error("the branch writers row names a repository and a branch");
  return { pk: companyScoped(key.orgId, "BRANCH_WRITERS"), sk: `${key.repositoryId.toLowerCase()}#${branch}` };
}

/** Rovara created this branch and opened its pull request: from now on passes may tell whether anyone else wrote to it. Created once; a row that exists (even one that says a person pushed) is left as it is. */
export async function openBranchWriters(store: Pick<DocumentStore, "put">, key: BranchWritersKey, now: string): Promise<void> {
  await store.put({ item: { ...branchWritersKey(key), entityType: "BRANCH_WRITERS", orgId: key.orgId, repositoryId: key.repositoryId, branch: key.branch, personPushed: false, createdAt: now }, condition: when.absent() });
}

/**
 * What a tracking pass saw of the head. `headIsRecordedRovaraPush` is strict: the head is one of the commits Rovara itself recorded pushing to this branch. It must NOT be merge tracking's optimistic
 * `headByRovara`, which reads "mine" while a Rovara push is pending, so a person's push in that window would be missed. A head that is not Rovara's makes the branch a person's, for good (even when no row
 * exists yet: the row then says so from the first sighting and `rovara_only` can never be created over it). A head that is Rovara's writes nothing.
 */
export async function noteBranchHead(store: Pick<DocumentStore, "update">, key: BranchWritersKey, seen: { headIsRecordedRovaraPush: boolean; now: string }): Promise<void> {
  if (seen.headIsRecordedRovaraPush) return;
  await store.update({ key: branchWritersKey(key), ops: [
    { op: "set", path: ["personPushed"], value: true }, { op: "setIfAbsent", path: ["firstPersonPushAt"], value: seen.now },
    { op: "setIfAbsent", path: ["entityType"], value: "BRANCH_WRITERS" }, { op: "setIfAbsent", path: ["orgId"], value: key.orgId },
    { op: "setIfAbsent", path: ["repositoryId"], value: key.repositoryId }, { op: "setIfAbsent", path: ["branch"], value: key.branch },
  ] });
}

/** A force-push the host refused: from now on this branch is merged, never restacked. */
export async function noteRestackRefused(store: Pick<DocumentStore, "update">, key: BranchWritersKey, now: string): Promise<void> {
  await store.update({ key: branchWritersKey(key), ops: [{ op: "set", path: ["restackRefused"], value: true }, { op: "setIfAbsent", path: ["restackRefusedAt"], value: now }], condition: when.present() });
}

export async function readBranchWriters(store: Pick<DocumentStore, "get">, key: BranchWritersKey): Promise<BranchWriters> {
  const row = await store.get(branchWritersKey(key));
  if (row === undefined || row["entityType"] !== "BRANCH_WRITERS" || row["orgId"] !== key.orgId || typeof row["personPushed"] !== "boolean") return { state: "unknown" };
  const restackRefused = row["restackRefused"] === true;
  return row["personPushed"] ? { state: "person_pushed", restackRefused } : { state: "rovara_only", restackRefused };
}
