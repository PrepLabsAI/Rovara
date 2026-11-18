// The attention queue's reverse index (web task channel C8, option b): which person a session's hashed person id (`developerIdOf`) stands for, so a host that tells people by email can find the person's own
// sign-in record. The hash cannot be reversed, so the row is written where the person is known for certain: when attention rows are written for a task session, from the task's own stored record
// (`DEVTASK#<task>/META`, written by the task's start from the signed-in principal), and only for the person that record names as the task's owner.
//
// Scoped to one company: the partition is the company's, the row repeats it, and a row is only ever written for a task record of that same company. Reading checks all of it again, and that the hash
// of the person the row names IS the id asked about (so a row can never point one hashed id at another person). The caller still checks the person's live membership before using the answer.
import { INDEX_EXPIRY_ATTRIBUTE, type DocumentStore, type OrgId } from "@agentx/contracts";
import { developerIdOf } from "../sessions/create.js";
import type { SessionChange } from "../sessions/summary.js";

/** How long a row is kept after it was last written (each new attention row for the owner writes it again). */
export const ATTENTION_PERSON_KEEP_SECONDS = 90 * 86_400;
const HASHED_ID = /^[a-f0-9]{64}$/u;
const PERSON_ID = /^[^\s#]{1,256}$/u;

/** The row for one hashed person id in one company (exported for the person erase). */
export const attentionPersonKey = (orgId: string, developerId: string) => ({ pk: `ATTENTION_PERSON#${orgId}`, sk: `DEV#${developerId}` });

/**
 * After attention rows were written for a change: remembers which person the task's owner is. Only a task session; only when the task's stored record is of the change's company, names the sign-in
 * `provider` given, and hashes to the session's owner. Anything else writes nothing. Never throws (an index is never a reason for the queue to fail); answers whether it wrote.
 */
export async function rememberAttentionOwner(
  deps: { store: Pick<DocumentStore, "get" | "put">; provider: string; now?: () => Date; log?: (entry: Record<string, unknown>) => void },
  change: Pick<SessionChange, "orgId" | "sessionId" | "session">,
): Promise<boolean> {
  try {
    const { session } = change;
    if (session.subject.kind !== "task" || session.orgId !== change.orgId) return false;
    const owner = session.owner.developerId;
    if (!HASHED_ID.test(owner)) return false;
    const task = await deps.store.get({ pk: `DEVTASK#${session.subject.taskId}`, sk: "META" });
    const personId = task?.["developerId"];
    if (task === undefined || task["companyId"] !== change.orgId || task["provider"] !== deps.provider || typeof personId !== "string" || !PERSON_ID.test(personId)) return false;
    if (task["sessionId"] !== undefined && task["sessionId"] !== change.sessionId) return false;
    if (developerIdOf({ provider: deps.provider, personId }) !== owner) return false;
    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    await deps.store.put({ item: { ...attentionPersonKey(change.orgId, owner), entityType: "ATTENTION_PERSON", orgId: change.orgId, developerId: owner, personId, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + ATTENTION_PERSON_KEEP_SECONDS } });
    return true;
  } catch (error) {
    deps.log?.({ event: "attention.person_index_failed", error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

/**
 * The person a hashed id stands for in this company, or undefined. The row must be this company's, name this id, and the person it names must hash to this id under `provider`.
 * The caller checks the person's live membership in the company before it uses the answer.
 */
export async function attentionPersonOf(store: Pick<DocumentStore, "get">, provider: string, orgId: OrgId, developerId: string): Promise<string | undefined> {
  if (!HASHED_ID.test(developerId)) return undefined;
  const row = await store.get(attentionPersonKey(orgId, developerId));
  const personId = row?.["personId"];
  if (row === undefined || row["orgId"] !== orgId || row["developerId"] !== developerId || typeof personId !== "string" || !PERSON_ID.test(personId)) return undefined;
  return developerIdOf({ provider, personId }) === developerId ? personId : undefined;
}
