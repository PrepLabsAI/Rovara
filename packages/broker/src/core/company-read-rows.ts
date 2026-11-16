// The company rule for the rows the company reads (lanes AU and EV) take: a row says which company it belongs to (`companyId`, or `orgId` on a row the hosted product wrote). A row that says nothing belongs to
// the implicit company only (an old row, from before companies). A row of another company is not shown. A stored company that is not a company id is never read as the implicit one: the row is not shown.
// The row's partition already names the company; this is the second check, on the row itself, so a row that was put in the wrong place still never leaves.
import { IMPLICIT_COMPANY_ID, OrgIdSchema } from "@agentx/contracts";

/** True when the stored row belongs to `companyId`. `companyId` must be a company id (the caller checks it first). */
export function rowBelongsToCompany(row: Readonly<Record<string, unknown>>, companyId: string): boolean {
  if (row["entityType"] === "WORKSPACE_COMPANY_POINTER") return false;
  const named = row["companyId"];
  const orgNamed = row["orgId"];
  if (named !== undefined && orgNamed !== undefined && named !== orgNamed) return false;
  // `undefined` is "says nothing"; a stored `null` (or anything else) is something that is not a company id.
  const stored = named === undefined ? orgNamed : named;
  if (stored === undefined) return companyId === IMPLICIT_COMPANY_ID;
  return typeof stored === "string" && OrgIdSchema.safeParse(stored).success && stored === companyId;
}
