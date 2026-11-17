// Web task channel: the task's People as attention recipients. A core task on AWS keeps its People list at `DEVTASK#<task>/PEOPLE` (the broker's own record, written by the People commit); an entry
// names a person by the sign-in developer id the hosted core uses as the principal's person id. The notices (`queueAttention`) name people by `developerIdOf(principal)`, so each entry is mapped to that
// id here, with the deployment's own identity provider. Only ids come out: the queue keeps pointers and delivery and the inbox check each person's live access, so a stale or odd entry tells nobody
// anything they may not read. Anything that does not read as expected (not this company's task, a malformed list, a failing read) is "nobody extra": the task's own person is told as before.
import type { AgentSessionRecord, DocumentStore } from "@agentx/contracts";
import { HOSTED_IDENTITY_PROVIDER } from "../core-host/hosted-modules.js";
import { developerIdOf } from "../core/sessions/create.js";
import type { PeopleOf, PeopleRecipients } from "../core/notify/attention.js";

/** Most People entries read from one list. */
export const PEOPLE_RECIPIENTS_MAX = 50;
const HEX64 = /^[a-f0-9]{64}$/u;
const none: PeopleRecipients = { owners: [], commenters: [] };

export function taskPeopleRecipients(store: Pick<DocumentStore, "get">): PeopleOf {
  return async (session: AgentSessionRecord): Promise<PeopleRecipients> => {
    if (session.subject.kind !== "task") return none;
    const taskId = session.subject.taskId;
    // The task is the session's own company's: a session never names another company's list.
    const task = await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
    if (task === undefined || task["companyId"] !== session.orgId) return none;
    const list = await store.get({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE" });
    const entries: unknown = list?.["people"];
    if (!Array.isArray(entries) || entries.length > PEOPLE_RECIPIENTS_MAX) return none;
    const owners: string[] = [];
    const commenters: string[] = [];
    for (const entry of entries as unknown[]) {
      if (entry === null || typeof entry !== "object") return none;
      const { developerId, role } = entry as { developerId?: unknown; role?: unknown };
      if (typeof developerId !== "string" || !HEX64.test(developerId) || typeof role !== "string") return none;
      const id = developerIdOf({ provider: HOSTED_IDENTITY_PROVIDER, personId: developerId });
      if (role === "owner") owners.push(id);
      else if (role === "commenter") commenters.push(id);
    }
    return { owners, commenters };
  };
}
