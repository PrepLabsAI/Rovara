import { SchedulerError, type ScheduleEntry } from "./scheduler.js";
import { OrgIdSchema } from "../browser-ids.js";
import type { DocumentChange, DocumentChangeFeed } from "./document-store.js";

// Decision 45.6: Code runs as one implicit company and keeps Cloud's company-scoped key scheme, so Cloud and Code share one
// key layout (`ORG#<company>#<name>`). The scope is part of the key string, so a store never needs to know about companies.

/** The prefix of every company-scoped partition key. The letters are the scheme Cloud already stores; Code keeps them. */
export const COMPANY_KEY_PREFIX = "ORG#";

/** The company id Code uses when it runs alone. Cloud ids look like `org_<20 base-36 characters>`; this one has the same shape. */
export const IMPLICIT_COMPANY_ID = "org_00000000000000000000";

/** `ORG#<company>#<name>`: the partition key (or key prefix) for one named thing inside one company. */
export function companyScoped(companyId: string, name: string): string {
  if (companyId === "" || /[#\s]/.test(companyId)) throw new Error("a company id has no '#' or white space");
  return `${COMPANY_KEY_PREFIX}${companyId}#${name}`;
}

/** The company a scoped partition key belongs to, or undefined for a key that is not company-scoped. */
export function companyOfKey(partitionKey: string): string | undefined {
  if (!partitionKey.startsWith(COMPANY_KEY_PREFIX)) return undefined;
  const end = partitionKey.indexOf("#", COMPANY_KEY_PREFIX.length);
  return end === -1 ? partitionKey.slice(COMPANY_KEY_PREFIX.length) || undefined : partitionKey.slice(COMPANY_KEY_PREFIX.length, end) || undefined;
}

/** Ownership of a committed change. A present but invalid or contradictory owner is never legacy data. */
export function companyOfChange(change: DocumentChange): string | undefined {
  if (typeof change?.key?.pk !== "string" || typeof change.key.sk !== "string" || !["insert", "modify", "remove"].includes(change.kind)) return undefined;
  const pk = change.key.pk;
  let owner = companyOfKey(pk);
  if (pk.startsWith(COMPANY_KEY_PREFIX) && !OrgIdSchema.safeParse(owner).success) return undefined;
  for (const image of [change.before, change.after]) {
    if (image === undefined) continue;
    if (image === null || typeof image !== "object" || Array.isArray(image)) return undefined;
    for (const field of ["companyId", "orgId"] as const) {
      if (!Object.hasOwn(image, field)) continue;
      const parsed = OrgIdSchema.safeParse(image[field]);
      if (!parsed.success || (owner !== undefined && owner !== parsed.data)) return undefined;
      owner = parsed.data;
    }
  }
  return owner ?? IMPLICIT_COMPANY_ID;
}

/** Company-bound view of an install-wide feed. Reports ambiguity without exposing any row or claimed company. */
export function companyChangeFeed(feed: DocumentChangeFeed, companyId: string, onAmbiguous?: (event: "company_change.ambiguous") => void): DocumentChangeFeed {
  if (!OrgIdSchema.safeParse(companyId).success) throw new Error("invalid company");
  const select = (changes: readonly DocumentChange[], report: boolean): DocumentChange[] => {
    const selected: DocumentChange[] = [];
    for (const change of changes) {
      const owner = companyOfChange(change);
      if (owner === undefined) { if (report) onAmbiguous?.("company_change.ambiguous"); }
      else if (owner === companyId) selected.push(change);
    }
    return selected;
  };
  return {
    subscribe(consumer, handler, options) {
      return feed.subscribe(consumer, async (changes) => {
        const selected = select(changes, true);
        if (selected.length > 0) await handler(selected);
      }, { onPoison: (changes) => {
        const selected = select(changes, false);
        if (selected.length > 0) options?.onPoison?.(selected, new Error("company change handler failed"));
      } });
    },
  };
}

/** Shared runtime refusal before a scheduler stores or reads an entry. */
export function checkScheduleCompany(entry: ScheduleEntry): void {
  if (!OrgIdSchema.safeParse(entry?.companyId).success) throw new SchedulerError("refused", "invalid schedule company");
  const ref = entry?.target?.ref;
  if (ref === null || typeof ref !== "object" || Array.isArray(ref) || typeof entry.target.kind !== "string" || typeof entry.enabled !== "boolean" || entry.when === null || typeof entry.when !== "object" || !["cron", "every"].includes(entry.when.kind)) throw new SchedulerError("refused", "invalid schedule");
  for (const field of ["companyId", "orgId"] as const) if (Object.hasOwn(ref, field) && ref[field] !== entry.companyId) throw new SchedulerError("refused", "invalid schedule company");
  if (entry.when.kind === "cron" && (typeof entry.when.cron !== "string" || typeof entry.when.timezone !== "string")) throw new SchedulerError("refused", "invalid schedule");
}
