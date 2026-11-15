// The company rule for rows read on the developer routes (decision 45.6, ending): a row says which company it belongs to
// (`companyId`, or `orgId` on a record the hosted product wrote). A row that says nothing belongs to the implicit company only.
// A row of another company is read as missing, the same as a row that does not exist. A stored company that is not an
// organisation id is never read as the implicit one: the row is refused.
import { IMPLICIT_COMPANY_ID, OrgIdSchema } from "@agentx/contracts";

/** The company a stored row names; `undefined` when it names none; `null` when what it names is not an organisation id. */
export function rowCompany(row: Record<string, unknown>): string | undefined | null {
  const named = row["companyId"] !== undefined ? row["companyId"] : row["orgId"];
  if (named === undefined) return undefined;
  return typeof named === "string" && OrgIdSchema.safeParse(named).success ? named : null;
}

/** Whether `row` belongs to `companyId` (the implicit company when a call names none). */
export function rowInCompany(row: Record<string, unknown>, companyId: string | undefined): boolean {
  const wanted = companyId ?? IMPLICIT_COMPANY_ID;
  const stored = rowCompany(row);
  if (stored === null) return false;
  return stored === undefined ? wanted === IMPLICIT_COMPANY_ID : stored === wanted;
}
