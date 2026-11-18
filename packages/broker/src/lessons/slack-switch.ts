// Lead 4 L4-SRC-SL: the person's own "Don't learn from my Slack messages" switch (owner's privacy decision, DEC 254zzz3). One row per person under the company's partition, so a company's switches are its own and a company
// erase (the partition) takes them:
//   pk `ORG#<company>#LESSON_SLACK_SWITCH`, sk `PERSON#<person>`   present = the person opted OUT; absent = their replies in Rovara's task threads may be learned from (when the project's source is on)
// The row holds the company, the person and a time, nothing else. It is read NOW at every read of a thread (`slack-source.ts`): a person who switches it on is dropped from the next task's read, and nothing they said earlier
// is read again. A read that fails is read as "opted out" by the caller (fail closed). The person's erase deletes the row (`erasePersonLessons`).
import { companyScoped, type DocumentStore, type OrgId } from "@agentx/contracts";

/** A person id as a key part: letters, digits, `_`, `.` and `-`, never a separator (the same shape the person erase accepts). */
const PERSON_ID = /^[A-Za-z0-9_.-]{1,100}$/u;

/** The key of one person's opt-out row. Throws for an id that cannot be a key part. */
export function slackSwitchKey(companyId: OrgId, personId: string): { pk: string; sk: string } {
  if (!PERSON_ID.test(personId)) throw new Error("not a person id");
  return { pk: companyScoped(companyId, "LESSON_SLACK_SWITCH"), sk: `PERSON#${personId}` };
}

/** Whether the person switched it on (opted out): any row at the person's key counts, whatever it holds (fail closed). Throws when the row cannot be read (the caller reads that as opted out). */
export async function readSlackOptOut(store: Pick<DocumentStore, "get">, companyId: OrgId, personId: string): Promise<boolean> {
  return (await store.get(slackSwitchKey(companyId, personId))) !== undefined;
}

/** Sets the switch for the person: `optOut: true` records the opt-out; `false` removes the row. Throws when it could not be saved. */
export async function writeSlackOptOut(store: Pick<DocumentStore, "put" | "delete">, companyId: OrgId, personId: string, optOut: boolean, now: number): Promise<void> {
  const key = slackSwitchKey(companyId, personId);
  if (optOut) await store.put({ item: { ...key, entityType: "LESSON_SLACK_SWITCH", companyId, personId, optOut: true, updatedAt: now } });
  else await store.delete({ key });
}

/** Removes the person's row (the person erase). Idempotent. */
export async function eraseSlackOptOut(store: Pick<DocumentStore, "delete">, companyId: OrgId, personId: string): Promise<number> {
  // An id that cannot be a key part never had a row (a write for it throws).
  if (!PERSON_ID.test(personId)) return 0;
  const result = await store.delete({ key: slackSwitchKey(companyId, personId), return: "old" });
  return result.applied && result.item !== undefined ? 1 : 0;
}
