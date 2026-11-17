// Whether a task is shared beyond its owner, read from the company's own records (hosted). It is the `taskShared` seam of the ticket updates (`ticket-updates/handler.ts`): a task only its owner can see is never written
// above `status_only` to a tracker that cannot make an internal comment, because a Linear comment is seen by everyone who can see the ticket (design B5). Fail closed: every answer that is not a plain "yes, shared" is `false`.
//
// A task is shared when someone other than its owner was given it in a record the task or its session keeps:
//   - the session has a share row (a person, a project or the whole company: `SHARE#` items of the session);
//   - the task's People list names a commenter or a viewer, or more than one owner;
//   - the task was taken over (a second person owns it now), or it is a shared Slack thread task (its `share` field).
// What does NOT count: the project's own members seeing every task of the project by default, which the records do not list (no roster is read here), and a People entry that only denies someone.
// The task must be this company's (its own record names the company); a task of another company, a missing one or one whose People list does not read is not shared. Every key is the company's own (the session's
// items are under the company's partition), so another company's share rows are never read.
import { SessionIdSchema, type DocumentStore, type OrgId } from "@agentx/contracts";
import { peopleOfItem, readSessionShares } from "../sessions/access.js";
import { taskKey } from "../task-flow/keys.js";

export interface TaskSharedDependencies {
  store: Pick<DocumentStore, "get" | "query">;
}

/** The answer the ticket updates ask: whether this company's task is visible to anyone beyond its owner. */
export function taskSharedOf(deps: TaskSharedDependencies): (orgId: OrgId, taskId: string) => Promise<boolean> {
  return async (orgId, taskId) => {
    const task = await deps.store.get(taskKey(taskId));
    if (task === undefined || (task["orgId"] ?? task["companyId"]) !== orgId) return false;
    // A shared Slack thread task, or a task someone took over: a second person is on it.
    if (typeof task["share"] === "object" && task["share"] !== null) return true;
    if (typeof task["currentOwner"] === "object" && task["currentOwner"] !== null) return true;
    const people = peopleOfItem(await deps.store.get({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE" }));
    // A People list that does not read says nothing reliable about who may see the task: not shared (fail closed), whatever else the records hold.
    if (people === "unreadable") return false;
    if (people !== undefined) {
      let owners = 0;
      for (const role of people.values()) {
        if (role === "commenter" || role === "viewer") return true;
        if (role === "owner") owners += 1;
      }
      if (owners > 1) return true;
    }
    const session = SessionIdSchema.safeParse(task["sessionId"]);
    if (!session.success) return false;
    return (await readSessionShares(deps.store, orgId, session.data)).length > 0;
  };
}
