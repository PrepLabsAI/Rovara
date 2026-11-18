// Whether a task is shared beyond its owner, read from the company's own records (hosted). It is the `taskShared` seam of the ticket updates (`ticket-updates/handler.ts`): a task only its owner can see is never written
// above `status_only` to a tracker that cannot make an internal comment, because a Linear comment is seen by everyone who can see the ticket (design B5). Fail closed: every answer that is not a plain "yes, shared" is `false`.
//
// A task is shared when someone other than its owner was given it in a record the task or its session keeps:
//   - the session has a share row (a person, a project or the whole company: `SHARE#` items of the session);
//   - the task's People list names a commenter or a viewer, or more than one owner (a `web` entry counts only while that person's grant on the task's project is live now, below);
//   - the task was taken over (a second person owns it now), or it is a shared Slack thread task (its `share` field).
// A People entry is a record of what was granted once. A `web` entry (a person who signed in on the web: a `method`, no chat account id) says nothing about whether that person can still see the task, so it counts only when the
// company's own members reader finds the person a live member of THIS company holding a grant on the task's project NOW (the reader `sessions/access.ts` uses for a session's levels: `deployedSessionMembers` on a
// hosted install). A person who lost the grant, left the company, a read that fails, a host with no reader and an entry of a shape that is neither kind all fail closed: the entry does not count. The entry that does not count
// is only that entry (a session share, a takeover or a live person beside it still decide). A `slack` entry keeps counting as before (its live proof is the Slack channel, not a grant).
// What does NOT count: the project's own members seeing every task of the project by default, which the records do not list (no roster is read here), and a People entry that only denies someone.
// The task must be this company's (its own record names the company); a task of another company, a missing one or one whose People list does not read is not shared. Every key is the company's own (the session's
// items are under the company's partition), so another company's share rows are never read.
import { SessionIdSchema, type DocumentStore, type OrgId } from "@agentx/contracts";
import { taskPeopleEntryKind } from "@agentx/contracts";
import { peopleOfItem, readSessionShares, sessionPersonOf, type SessionMembers } from "../sessions/access.js";
import { taskKey } from "../task-flow/keys.js";

export interface TaskSharedDependencies {
  store: Pick<DocumentStore, "get" | "query">;
  /**
   * How a `web` People entry is checked live: the members reader of the session levels, and the identity provider name the host's principals carry (a person's session id is a hash of provider and person id, and the hosted reader
   * finds a person only by the principal it hashes from). Absent: a `web` entry cannot be checked and does not count.
   */
  webPeople?: { members: SessionMembers; provider: string } | undefined;
}

/** Whether the person a `web` People entry names holds a grant on the task's project now, as the session levels read it. Any fault is "no". */
async function webEntryLive(deps: TaskSharedDependencies, orgId: OrgId, project: unknown, developerId: string): Promise<boolean> {
  const web = deps.webPeople;
  if (web === undefined || typeof project !== "string" || project === "") return false;
  try {
    // In the broker's own records the People entry's developer id is the person's id (the grant is keyed by it).
    const person = sessionPersonOf({ companyId: orgId, personId: developerId, displayName: "member", roles: [], provider: web.provider });
    if (await web.members.companyRole(person) === undefined) return false;
    return await web.members.projectGrant(person, project) !== undefined;
  } catch {
    return false;
  }
}

/** The answer the ticket updates ask: whether this company's task is visible to anyone beyond its owner. */
export function taskSharedOf(deps: TaskSharedDependencies): (orgId: OrgId, taskId: string) => Promise<boolean> {
  return async (orgId, taskId) => {
    const task = await deps.store.get(taskKey(taskId));
    if (task === undefined || (task["orgId"] ?? task["companyId"]) !== orgId) return false;
    // A shared Slack thread task, or a task someone took over: a second person is on it.
    if (typeof task["share"] === "object" && task["share"] !== null) return true;
    if (typeof task["currentOwner"] === "object" && task["currentOwner"] !== null) return true;
    const peopleItem = await deps.store.get({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE" });
    const people = peopleOfItem(peopleItem);
    // A People list that does not read says nothing reliable about who may see the task: not shared (fail closed), whatever else the records hold.
    if (people === "unreadable") return false;
    if (people !== undefined) {
      // Which people are not Slack entries (read from the item peopleOfItem just validated).
      const checked = new Set<string>();
      const seen = new Set<string>();
      for (const entry of (peopleItem as unknown as { people: Array<Record<string, unknown> & { developerId: string }> }).people) {
        // The real People reader refuses a list that names a person twice (task-people.ts `parsePeople`): so does this, and a later entry cannot loosen how an earlier one is checked.
        if (seen.has(entry.developerId)) return false;
        seen.add(entry.developerId);
        if (taskPeopleEntryKind(entry) !== "slack") checked.add(entry.developerId);
      }
      const counts = async (developerId: string): Promise<boolean> => !checked.has(developerId) || await webEntryLive(deps, orgId, task["project"], developerId);
      const owners: string[] = [];
      for (const [developerId, role] of people) {
        if (role === "commenter" || role === "viewer") { if (await counts(developerId)) return true; }
        else if (role === "owner") owners.push(developerId);
      }
      // Two owners make it shared; a lone owner is the task's own person, so nobody is read when there is only one.
      if (owners.length > 1) {
        let live = 0;
        for (const developerId of owners) {
          if (await counts(developerId)) live += 1;
          if (live > 1) return true;
        }
      }
    }
    const session = SessionIdSchema.safeParse(task["sessionId"]);
    if (!session.success) return false;
    return (await readSessionShares(deps.store, orgId, session.data)).length > 0;
  };
}
