// The merge core's `MergePeople` for a HOSTED company: the identity port's own reader (`createIdentityMergePeople`) with ONE hosted rule, for who asked for a task.
//
// The core keeps a task's owner id as the requester whose own approval may not count (core/merge/approval.ts `requesterIds`). A hosted task's workflow owner id is the per-task key
// `taskOwnerKey(creator, taskId)` (core/task-flow/start.ts), which is no person and has no GitHub account: with the default rule (self-approval off) every hosted merge after another member's
// approval refused "Link your GitHub account". And a takeover (`takeOwnership`) writes only the task People list, never the workflow owner id, so the key says nothing about who drives the task now.
// So hosted never asks the core's `requesterIds`. The requesters are:
//   - the task's CREATOR, while they are a member of this company (one who left drops out: they cannot approve, and a dead account must not block the task), and
//   - every CURRENT OWNER of the task's People list (a takeover makes the new owner a requester; the creator stays one while a member). Owners who are not members of this company drop out the same way.
// A task with no People list has the creator as its only owner. Nobody left (the creator left and no one holds the task): the answer is "no_owner", a plain refusal that says so; a requester is never guessed.
//
// Only the lookup of the requesters changes. Every requester must still have a linked account ("unlinked" otherwise), a People list that cannot be read is "unlinked" (fail closed), and the requesters' accounts
// are still left out of the approvals that count. The stored owner id is never read or rewritten here. The press (`aws/hosted-merge-deps.ts`) and merge tracking (`aws/core-job-services.ts`) both build
// their people here, so they judge a task's requesters alike. (`startedBy` is never set on a hosted task.)
import type { IdentityProvider, OrgId } from "@agentx/contracts";
import { createIdentityMergePeople, type MergePeople } from "../core/merge/people.js";
import type { RequesterAccounts } from "../core/merge/approval.js";
import type { MergeTask } from "../core/merge/seams.js";
import { taskOwnerDevelopers, type TaskPeopleDependencies } from "../developer/task-people.js";

/** What the People list is read through: the state table's document client and name (the same the task People routes use). */
export type HostedTaskPeopleSource = Pick<TaskPeopleDependencies, "documentClient" | "tableName">;

/** The people who asked for the task, before membership: the creator, then the People list's current owners; "unreadable" when the list cannot be read. */
async function candidatesOf(task: MergeTask, taskPeople: HostedTaskPeopleSource): Promise<string[] | "unreadable"> {
  const owners = await taskOwnerDevelopers(taskPeople, task.taskId).catch(() => "unreadable" as const);
  if (owners === "unreadable") return "unreadable";
  return [...new Set([...(task.creatorId === undefined ? [] : [task.creatorId]), ...(owners ?? [])])];
}

/** `MergePeople` for the hosted install over its identity point and the task People list. */
export function createHostedMergePeople(identity: IdentityProvider, taskPeople: HostedTaskPeopleSource): MergePeople {
  const base = createIdentityMergePeople(identity, { hostProvider: "github" });
  const requestersOf = async (orgId: OrgId, task: MergeTask): Promise<RequesterAccounts> => {
    const candidates = await candidatesOf(task, taskPeople);
    if (candidates === "unreadable") return "unlinked";
    const accounts: string[] = [];
    let requesters = 0;
    for (const personId of candidates) {
      if (await identity.getPrincipal(orgId, personId) === undefined) continue;
      requesters += 1;
      const own = (await base.hostAccountsOf?.(orgId, personId)) ?? [];
      if (own.length === 0) return "unlinked";
      accounts.push(...own);
    }
    return requesters === 0 ? "no_owner" : [...new Set(accounts)];
  };
  return { ...base, requestersOf };
}
