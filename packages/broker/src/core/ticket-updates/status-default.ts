// The one-time flip of the ticket status move (R1 + L1 6.2, owner DEC 254zzz466 c; plan 0.1 #9). Write-back did not run on hosted before, so every project that got a team pick was seeded with the status move OFF
// (`seedTicketUpdatesIfUnset`, request id `seed-new-hosted-default`, revision 1) by default, not by choice. Those rows, and only those, are turned ON here, once:
//   - only a row that still has the seed's request id AND revision 1 (nobody saved over it) and has the move off; a saved choice (any other request id or revision, even "off") is never touched;
//   - the new row is revision 2, request id `dec-254zzz463-status-default`, by `system`, and every other setting of the row is kept as it was;
//   - one audit row per project, recorded BEFORE the row changes (a ledger that cannot take it refuses the change, as every settings change does), with a fixed event id so a repeat records once;
//   - the change is one conditional write on revision 1 and the seed's request id, so a person saving at the same moment wins and a second run changes nothing;
//   - a company's whole pass is marked done only when every project was settled, so a pass that failed half way runs again and never skips a project;
//   - it does NOT run until an operator has released it for that company (controller decision, 2026-11-24: the owner tells the company first, then the operator writes the go row). Until then each pass reads the go
//     row, finds none, logs `ticket_update.status_default_flip_waiting` and changes nothing. The go row is one item in the same company partition as the done marker:
//       pk `ORG#<company id>#TICKET_STATUS_FLIP`, sk `GO`, entityType `TICKET_STATUS_FLIP`, orgId `<company id>`, by `<operator>`, at `<ISO time>`
//     written by the operator through the operator guard (`staging-aws.sh` on staging) as a plain put, after the read-only count (`seededStatusRows`). New projects are seeded ON regardless (`HOSTED_SEED_TICKET_UPDATES`).
import { TicketUpdatesSettingsSchema, orgScoped, ticketUpdatesSettingsKey, when, type AuditEvent, type DocumentStore, type OrgId, type StoredDocument } from "@agentx/contracts";
import { SEED_REQUEST_ID, readTicketUpdates } from "./settings.js";

export const STATUS_DEFAULT_REQUEST_ID = "dec-254zzz463-status-default";
const markerKey = (orgId: OrgId) => ({ pk: orgScoped(orgId, "TICKET_STATUS_FLIP"), sk: "ONCE" });
/** The operator's go for one company's flip (see the header): absent, the flip waits. */
export const statusFlipGoKey = (orgId: OrgId) => ({ pk: orgScoped(orgId, "TICKET_STATUS_FLIP"), sk: "GO" });

/** Writes the operator's go for one company (what the documented put writes; tests and a future operator command call it). */
export async function releaseStatusFlip(table: { store: Pick<DocumentStore, "put">; now: () => number }, orgId: OrgId, by: string): Promise<void> {
  await table.store.put({ item: { ...statusFlipGoKey(orgId), entityType: "TICKET_STATUS_FLIP", orgId, by: by.slice(0, 100), at: new Date(table.now()).toISOString() } });
}

export interface StatusFlipTable {
  store: Pick<DocumentStore, "get" | "put" | "update" | "query">;
  now: () => number;
  audit: { record(event: AuditEvent): Promise<unknown> };
  /** Every project of the company (its catalog). Throws when it cannot be read: the pass is then not marked done. */
  projects: () => Promise<readonly string[]>;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

/** The projects whose settings are a seed nobody saved over, with the move off: what the flip would change (a read only; the controller's preview counts these before the first run). */
export async function seededStatusRows(table: Pick<StatusFlipTable, "store" | "now" | "projects">, orgId: OrgId): Promise<string[]> {
  const found: string[] = [];
  for (const project of await table.projects()) {
    const read = await readTicketUpdates(table, orgId, project);
    if (read.requestId === SEED_REQUEST_ID && read.revision === 1 && !read.settings.changeStatus) found.push(project);
  }
  return found;
}

/** Runs the flip for one company if it has not run and the operator released it. Returns how many projects it turned on (0 when it had already run, or is not released). A failure throws; the next pass tries again. */
export async function flipSeededStatusDefaults(table: StatusFlipTable, orgId: OrgId): Promise<number> {
  if ((await table.store.get(markerKey(orgId))) !== undefined) return 0;
  const go = await table.store.get(statusFlipGoKey(orgId));
  if (go?.["orgId"] !== orgId) { table.log?.("ticket_update.status_default_flip_waiting", { orgId }); return 0; }
  let flipped = 0;
  for (const project of await table.projects()) {
    const read = await readTicketUpdates(table, orgId, project);
    if (read.requestId !== SEED_REQUEST_ID || read.revision !== 1 || read.settings.changeStatus) continue;
    const at = new Date(table.now()).toISOString();
    await table.audit.record({
      eventId: `ticket_updates.status_default_on:${orgId}:${project}`, companyId: orgId, at, actor: { type: "system", id: "rovara" }, action: "ticket_updates.status_default_on",
      subject: { type: "project", id: project }, details: { project, requestId: STATUS_DEFAULT_REQUEST_ID, changeStatus: true },
    });
    const settings = TicketUpdatesSettingsSchema.parse({ ...read.settings, changeStatus: true });
    const written = await table.store.put({
      item: {
        ...ticketUpdatesSettingsKey(orgId, project), entityType: "TICKET_UPDATES", orgId, project, settings: JSON.parse(JSON.stringify(settings)) as StoredDocument,
        revision: 2, requestId: STATUS_DEFAULT_REQUEST_ID, by: "system", at,
      },
      condition: when.and(when.eq("revision", 1), when.eq("requestId", SEED_REQUEST_ID)),
    });
    if (written.applied) { flipped += 1; table.log?.("ticket_update.status_default_on", { orgId, project }); }
  }
  await table.store.put({ item: { ...markerKey(orgId), entityType: "TICKET_STATUS_FLIP", orgId, at: new Date(table.now()).toISOString(), flipped } });
  return flipped;
}
