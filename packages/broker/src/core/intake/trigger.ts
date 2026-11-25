// R1 + L1 6.2b (plan 4.2, DEC 254zzz466 b): the one rule for what asks for work on a hosted tracker, and the bound on how much one person's acts may start.
//
// Work is asked for when a ticket in the project's picked Linear team is assigned to Rovara's app user, or carries the label `rovara` (any case), whether set at creation or added later. Who made that act decides
// standing (the engine: a linked member starts, anyone else waits). The label word is a constant, not a setting (rules 1 and 2); it lives here, in Code's intake, not in the shared contracts.
import { change, orgScoped, when, INDEX_EXPIRY_ATTRIBUTE, type DocumentStore, type OrgId } from "@agentx/contracts";

export const ROVARA_TRIGGER_LABEL = "rovara";

/** The most tasks one person's tracker acts start in an hour (a bulk edit by a linked member, or a compromised account, stays bounded; the rest wait with a reason in words). Fixed; no setting. */
export const TRACKER_STARTS_PER_PERSON_HOUR = 10;

const hourOf = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 13);

/**
 * Takes one of the person's hourly tracker starts in one conditional update; false when the hour's allowance is used up. Counted when a start is attempted, so a start the budget then refuses still counts
 * (the bound is on attempts). The row is the company's, keyed by person and hour, and expires with the hour.
 */
export async function admitTrackerStart(table: { store: Pick<DocumentStore, "update">; now: () => number }, orgId: OrgId, developerId: string): Promise<boolean> {
  const now = table.now();
  const result = await table.store.update({
    key: { pk: orgScoped(orgId, "TRACKER_START_CAP"), sk: `PERSON#${developerId}#HOUR#${hourOf(now)}` },
    ops: [change.add("count", 1), change.set("entityType", "TRACKER_START_CAP"), change.set("orgId", orgId), change.set(INDEX_EXPIRY_ATTRIBUTE, Math.floor(now / 1000) + 2 * 3600)],
    condition: when.or(when.notExists("count"), when.lt("count", TRACKER_STARTS_PER_PERSON_HOUR)),
  });
  return result.applied;
}
