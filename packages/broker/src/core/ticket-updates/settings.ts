// A project's ticket updates settings and each tracker's write access as last seen, on the document store port. The settings are one item per project; an item that is missing or does not parse reads as
// the defaults (comments on, status changes OFF). A save is conditional on the revision the owner read, so two saves at once give a clear conflict, never a silent overwrite; the same request id again
// answers the stored settings and writes nothing. The key layout is Cloud's.
import {
  DEFAULT_TICKET_UPDATES, NEW_HOSTED_TICKET_UPDATES, TicketUpdatesSettingsSchema, agentXError, change, orgScoped, ticketUpdatesSettingsKey, ticketWriteAccessKey, when,
  type DocumentStore, type OrgId, type StoredDocument, type TicketUpdatesSettings,
} from "@agentx/contracts";

export interface TicketUpdatesTable {
  store: Pick<DocumentStore, "get" | "put" | "update" | "query">;
  now: () => number;
}

/**
 * What a NEW hosted project's first team pick saves (R1 + L1 6.2, owner DEC 254zzz466 c): the whole conversation (`level: "full"`) AND the ticket's status moved as the work goes (In Progress, In Review, Done).
 * Code's own constant: the shared `NEW_HOSTED_TICKET_UPDATES` still says `changeStatus: false` in the copy Cloud holds, and that file is changed on both sides together, never here alone.
 */
export const HOSTED_SEED_TICKET_UPDATES: Readonly<TicketUpdatesSettings> = { ...NEW_HOSTED_TICKET_UPDATES, changeStatus: true, statuses: { ...NEW_HOSTED_TICKET_UPDATES.statuses } };
/** The request id of the first save a team pick makes (`seedTicketUpdatesIfUnset`): a row that still has it was never chosen by a person. */
export const SEED_REQUEST_ID = "seed-new-hosted-default";

const defaults = (): TicketUpdatesSettings => ({ ...DEFAULT_TICKET_UPDATES, statuses: { ...DEFAULT_TICKET_UPDATES.statuses } });

/** The project's settings and the revision they were read at (0: never saved, the defaults). */
export async function readTicketUpdates(table: TicketUpdatesTable, orgId: OrgId, project: string): Promise<{ settings: TicketUpdatesSettings; revision: number; requestId?: string; at?: string }> {
  const item = await table.store.get(ticketUpdatesSettingsKey(orgId, project));
  if (item === undefined || item["orgId"] !== orgId || item["project"] !== project) return { settings: defaults(), revision: 0 };
  const parsed = TicketUpdatesSettingsSchema.safeParse(item["settings"]);
  const revision = typeof item["revision"] === "number" ? item["revision"] : 0;
  // A stored item that no longer parses is read as the safe defaults (status changes off), never as "on".
  return { settings: parsed.success ? parsed.data : defaults(), revision, ...(typeof item["requestId"] === "string" ? { requestId: item["requestId"] } : {}), ...(typeof item["at"] === "string" ? { at: item["at"] } : {}) };
}

/** Saves the project's settings, conditional on the revision read. The same request id again (already saved) answers what is stored. */
export async function saveTicketUpdates(table: TicketUpdatesTable, input: { orgId: OrgId; project: string; settings: TicketUpdatesSettings; requestId: string; by: string }): Promise<TicketUpdatesSettings> {
  const current = await readTicketUpdates(table, input.orgId, input.project);
  if (current.requestId === input.requestId) {
    if (JSON.stringify(current.settings) !== JSON.stringify(input.settings)) throw agentXError("CONFIG_INVALID", "requestId: this request id was used for other settings");
    return current.settings;
  }
  const written = await table.store.put({
    item: {
      ...ticketUpdatesSettingsKey(input.orgId, input.project), entityType: "TICKET_UPDATES", orgId: input.orgId, project: input.project, settings: JSON.parse(JSON.stringify(input.settings)) as StoredDocument,
      revision: current.revision + 1, requestId: input.requestId, by: input.by, at: new Date(table.now()).toISOString(),
    },
    condition: current.revision === 0 ? when.absent() : when.eq("revision", current.revision),
  });
  if (!written.applied) throw agentXError("CHANGE_STALE", "These settings changed just now. Reload and try again.");
  return input.settings;
}

/**
 * Saves `settings` for a project that has NONE saved yet, and nothing otherwise: one put conditional on the item being absent, so a saved choice (including a saved `status_only`, or an item that does not parse) is
 * never overwritten and two calls at once save once. "seeded" when this call wrote them, "kept" when something was already there.
 */
export async function seedTicketUpdatesIfUnset(table: TicketUpdatesTable, input: { orgId: OrgId; project: string; settings: TicketUpdatesSettings; by: string }): Promise<"seeded" | "kept"> {
  const parsed = TicketUpdatesSettingsSchema.parse(input.settings);
  const written = await table.store.put({
    item: {
      ...ticketUpdatesSettingsKey(input.orgId, input.project), entityType: "TICKET_UPDATES", orgId: input.orgId, project: input.project, settings: JSON.parse(JSON.stringify(parsed)) as StoredDocument,
      revision: 1, requestId: SEED_REQUEST_ID, by: input.by, at: new Date(table.now()).toISOString(),
    },
    condition: when.absent(),
  });
  return written.applied ? "seeded" : "kept";
}

/** Notes that a write to a tracker was skipped because its sign-in may not write (or the tracker refused it). Best effort: a failure to note is not the task's. */
export async function noteWriteAccessMissing(table: TicketUpdatesTable, orgId: OrgId, tracker: string): Promise<void> {
  await table.store.put({ item: { ...ticketWriteAccessKey(orgId, tracker), entityType: "TICKET_WRITE_ACCESS", orgId, tracker, state: "needs_write_access", at: new Date(table.now()).toISOString() } });
}

/** A write to the tracker worked: whatever was noted is cleared (a cheap conditional write that changes nothing when nothing was noted). */
export async function noteWriteAccessOk(table: TicketUpdatesTable, orgId: OrgId, tracker: string): Promise<void> {
  await table.store.update({
    key: ticketWriteAccessKey(orgId, tracker), ops: [change.set("state", "ok"), change.set("at", new Date(table.now()).toISOString())],
    condition: when.and(when.present(), when.not(when.eq("state", "ok"))),
  });
}

/** One tracker's write access as last seen. */
export interface WriteAccessView { tracker: string; state: "ok" | "needs_write_access"; at?: string }

/** Each of these trackers' write access as last seen (one query of the company's small partition). A tracker never written to reads `ok`. */
export async function readWriteAccess(table: TicketUpdatesTable, orgId: OrgId, trackers: readonly string[]): Promise<WriteAccessView[]> {
  const page = await table.store.query({ pk: orgScoped(orgId, "TICKET_WRITE_ACCESS"), limit: 50 });
  const found = new Map<string, StoredDocument>();
  for (const item of page.items) if (item["orgId"] === orgId && typeof item["tracker"] === "string") found.set(item["tracker"], item);
  return trackers.map((tracker) => {
    const item = found.get(tracker);
    return item?.["state"] === "needs_write_access" && typeof item["at"] === "string" ? { tracker, state: "needs_write_access" as const, at: item["at"] } : { tracker, state: "ok" as const };
  });
}

/** The small table the status-missing notes need (the handler's store has all of it). */
export interface StatusNoteTable { store: Pick<DocumentStore, "get" | "put" | "delete" | "query">; now: () => number }
const statusMissingKey = (orgId: OrgId, tracker: string, project: string, moment: string) => ({ pk: orgScoped(orgId, "TICKET_STATUS_MISSING"), sk: `TRACKER#${tracker}#PROJECT#${project}#MOMENT#${moment}` });

/**
 * Notes that the tracker's team has no status with a name a project asked for ("In Review"), so the move was skipped and the comment still went. One row per company, tracker, project and moment, holding the name
 * asked for (the project's own word). Best effort: a failure to note is not the task's. Read by the project's ticket-updates card in the Cloud half; it is NOT part of `TicketWriteAccessView` (a new state there
 * is a change to a copy Cloud parses strictly: it ships with the Cloud half).
 */
export async function noteStatusMissing(table: StatusNoteTable, orgId: OrgId, tracker: string, project: string, moment: string, name: string): Promise<void> {
  await table.store.put({ item: { ...statusMissingKey(orgId, tracker, project, moment), entityType: "TICKET_STATUS_MISSING", orgId, tracker, project, moment, name: name.slice(0, 100), at: new Date(table.now()).toISOString() } });
}

/** A status move worked for this project and moment: whatever was noted as missing for it is cleared. */
export async function clearStatusMissing(table: StatusNoteTable, orgId: OrgId, tracker: string, project: string, moment: string): Promise<void> {
  await table.store.delete({ key: statusMissingKey(orgId, tracker, project, moment) });
}

/** The statuses a project asked for that its team does not have, as last seen: `{ moment: name }`. Empty when none was noted. */
export async function readStatusMissing(table: StatusNoteTable, orgId: OrgId, tracker: string, project: string): Promise<Record<string, string>> {
  const page = await table.store.query({ pk: orgScoped(orgId, "TICKET_STATUS_MISSING"), sk: { op: "beginsWith", prefix: `TRACKER#${tracker}#PROJECT#${project}#MOMENT#` }, limit: 20 });
  const found: Record<string, string> = {};
  for (const item of page.items) if (item["orgId"] === orgId && item["project"] === project && typeof item["moment"] === "string" && typeof item["name"] === "string") found[item["moment"]] = item["name"];
  return found;
}
