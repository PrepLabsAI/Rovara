// Saved project images: how many rebuilds run at once (design SAVED-IMAGES 3.2, SI-2). Fixed slot rows, not a counter, so there is nothing to drift:
//   company slots   `SAVED_ENV_COMPANY_SLOTS` rows (2) in the company's own partition (`ORG#<company>` / `SAVED_ENV_SLOT#<i>`);
//   install slots   `SAVED_ENV_INSTALL_SLOTS` rows (4) in one install-wide partition (`SAVED_ENV_SLOTS` / `SLOT#<i>`), each naming only ids: the company, the project, the job and when its lease ends. No code, no name, no text.
// A slot is held by a JOB id (never by the project), so one job can never hold two slots of a scope and a retry of the same job takes its own again. A slot is FREE when it is absent, when its lease has run out, or when the
// job asking is the one that holds it. The claim is a conditional put carried in the start's own transaction (`saved-env-run.ts`), so a lost race fails the whole start instead of leaving half of it; the condition
// repeats the free test, so a stale read can never take a slot another job holds. Release is a conditional delete by job id. The lease is the job lease (`SAVED_ENV_JOB_LEASE_MS`, 3 hours), so a release that is
// lost heals by itself: worst case one install slot is out of use for up to three hours. The rows expire a day after their lease (the store's expiry), so a damaged row cannot block a slot for ever.
import { INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, SAVED_ENV_COMPANY_SLOTS, SAVED_ENV_INSTALL_SLOTS, SAVED_ENV_JOB_LEASE_MS, orgPk, when, type DocumentKey, type DocumentStore, type StoredDocument, type TransactItem } from "@agentx/contracts";

/** The install-wide partition of the install slots. Its rows hold ids only. */
export const SAVED_ENV_INSTALL_SLOT_PARTITION = "SAVED_ENV_SLOTS";
const KEEP_AFTER_LEASE_SECONDS = 86_400;

export const companySlotKey = (orgId: string, index: number): DocumentKey => ({ pk: orgPk(OrgIdSchema.parse(orgId)), sk: `SAVED_ENV_SLOT#${String(index)}` });
export const installSlotKey = (index: number): DocumentKey => ({ pk: SAVED_ENV_INSTALL_SLOT_PARTITION, sk: `SLOT#${String(index)}` });

/** Which slot of each scope a start takes. */
export interface SlotPick { company: number; install: number }
export type SlotPickResult = ({ ok: true } & SlotPick) | { ok: false; full: "company" | "install" };

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

/** Whether a stored slot row may be taken by `jobId` at `nowMs`: absent, its own, or one whose lease is over. A row that does not say when its lease ends is not free (its expiry removes it). */
function freeFor(row: { [attribute: string]: unknown } | undefined, jobId: string, nowMs: number): boolean {
  if (row === undefined || row["jobId"] === jobId) return true;
  const until = typeof row["leaseUntil"] === "string" ? Date.parse(row["leaseUntil"]) : Number.NaN;
  return Number.isFinite(until) && until <= nowMs;
}

/** The first free slot of the company and of the install for this job, read now. */
export async function pickSlots(store: Pick<DocumentStore, "get">, orgId: string, jobId: string, nowMs: number): Promise<SlotPickResult> {
  const company = (await Promise.all(range(SAVED_ENV_COMPANY_SLOTS).map(async (index) => ((freeFor(await store.get(companySlotKey(orgId, index)), jobId, nowMs)) ? index : -1)))).find((index) => index >= 0);
  if (company === undefined) return { ok: false, full: "company" };
  const install = (await Promise.all(range(SAVED_ENV_INSTALL_SLOTS).map(async (index) => ((freeFor(await store.get(installSlotKey(index)), jobId, nowMs)) ? index : -1)))).find((index) => index >= 0);
  if (install === undefined) return { ok: false, full: "install" };
  return { ok: true, company, install };
}

/** The two puts that take the picked slots, for the start's transaction (company first, then install). Each holds only while the slot is still free for this job. */
export function slotClaimItems(orgId: string, pick: SlotPick, holder: { project: string; jobId: string; nowMs: number }): [TransactItem, TransactItem] {
  const leaseUntilMs = holder.nowMs + SAVED_ENV_JOB_LEASE_MS;
  const row = (key: DocumentKey): StoredDocument => ({
    ...key, entityType: "SAVED_ENV_SLOT", orgId, project: holder.project, jobId: holder.jobId, takenAt: new Date(holder.nowMs).toISOString(), leaseUntil: new Date(leaseUntilMs).toISOString(),
    [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(leaseUntilMs / 1000) + KEEP_AFTER_LEASE_SECONDS,
  });
  const free = when.or(when.absent(), when.lte("leaseUntil", new Date(holder.nowMs).toISOString()), when.eq("jobId", holder.jobId));
  return [
    { kind: "put", item: row(companySlotKey(orgId, pick.company)), condition: free },
    { kind: "put", item: row(installSlotKey(pick.install)), condition: free },
  ];
}

/** Gives back every slot this job holds, in both scopes (a conditional delete by job id: another job's slot is never touched). Returns how many were released. Never throws into its caller. */
export async function releaseSlots(store: Pick<DocumentStore, "delete">, orgId: string, jobId: string): Promise<number> {
  const keys = [...range(SAVED_ENV_COMPANY_SLOTS).map((index) => companySlotKey(orgId, index)), ...range(SAVED_ENV_INSTALL_SLOTS).map((index) => installSlotKey(index))];
  let released = 0;
  for (const key of keys) {
    try {
      if ((await store.delete({ key, condition: when.and(when.eq("jobId", jobId), when.eq("orgId", orgId)) })).applied) released += 1;
    } catch {
      // The lease runs out on its own.
    }
  }
  return released;
}
