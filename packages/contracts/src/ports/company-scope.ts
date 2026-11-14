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
