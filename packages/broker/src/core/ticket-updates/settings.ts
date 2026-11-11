// A project's ticket updates settings and each tracker's write access as last seen, on the document store port. The settings are one item per project; an item that is missing or does not parse reads as
// the defaults (comments on, status changes OFF). A save is conditional on the revision the owner read, so two saves at once give a clear conflict, never a silent overwrite; the same request id again
// answers the stored settings and writes nothing. The key layout is Cloud's.
import {
  DEFAULT_TICKET_UPDATES, TicketUpdatesSettingsSchema, agentXError, change, orgScoped, ticketUpdatesSettingsKey, ticketWriteAccessKey, when,
  type DocumentStore, type OrgId, type StoredDocument, type TicketUpdatesSettings,
} from "@agentx/contracts";

export interface TicketUpdatesTable {
  store: Pick<DocumentStore, "get" | "put" | "update" | "query">;
  now: () => number;
}

const defaults = (): TicketUpdatesSettings => ({ ...DEFAULT_TICKET_UPDATES, statuses: { ...DEFAULT_TICKET_UPDATES.statuses } });

/** The project's settings and the revision they were read at (0: never saved, the defaults). */
export async function readTicketUpdates(table: TicketUpdatesTable, orgId: OrgId, project: string): Promise<{ settings: TicketUpdatesSettings; revision: number; requestId?: string }> {
  const item = await table.store.get(ticketUpdatesSettingsKey(orgId, project));
  if (item === undefined || item["orgId"] !== orgId || item["project"] !== project) return { settings: defaults(), revision: 0 };
  const parsed = TicketUpdatesSettingsSchema.safeParse(item["settings"]);
  const revision = typeof item["revision"] === "number" ? item["revision"] : 0;
  // A stored item that no longer parses is read as the safe defaults (status changes off), never as "on".
  return { settings: parsed.success ? parsed.data : defaults(), revision, ...(typeof item["requestId"] === "string" ? { requestId: item["requestId"] } : {}) };
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
