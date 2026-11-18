// DEC 254zzz6 D2 (rows 3651/3655): the old /v1/admin project routes find an administrator's grant by project NAME only (`MEMBER#<owner>` / `PROJECT#<name>`), with no
// company in the key. While a named company (any company but the implicit one) also has a project of that name, a name-only grant could reach that company's records.
// Until those routes are retired for multi-company installs (row 3656), a name-only admin route refuses such a name with one fixed answer. The checks are point reads
// only (no scan), each consistent:
//   1. the legacy project's latest revision (`PROJECT#<name>` / newest `REV#`): a named company's `companyId` there means the name is that company's project;
//   2. the legacy catalog row (`PROJECT_CATALOG` / `PROJECT#<name>`): the same;
//   3. the caller's live company (the sign-in table's membership, where company sign-in is on): when it is a named company, that company's own catalog row
//      (`ORG#<company>#PROJECT_CATALOG` / `PROJECT#<name>`).
// Not read: OTHER named companies' own catalogs (the State table has no index listing companies, and no scan is made). A name only another company's own partition
// holds, with unstamped or absent legacy rows, is not detected here; retiring these routes (row 3656) or a company index closes that.
// The implicit company's own legacy projects (no `companyId`, or the implicit company's) answer exactly as before. Any read that fails or any company value that does not
// parse refuses with the same fixed answer: never a cause, a name or a company.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, IMPLICIT_COMPANY_ID, OrgIdSchema, orgProjectCatalogKey, projectCatalogKey } from "@agentx/contracts";
import type { CompanyMembershipReader } from "./company-check.js";
import { queryAllItems } from "./admin-reads.js";

/** The one answer for a name-only admin route on a name a named company also uses. Fixed words: no project, company or cause. */
export const ADMIN_NAME_COLLISION_MESSAGE = "this project name is also used by a company's project; manage it from that company's own pages";

export interface AdminNameCollisionDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The live company membership reader (company sign-in); absent, check 3 is skipped. */
  companies?: CompanyMembershipReader | undefined;
}

class Collision extends Error {}

/** A row's company: undefined (or the implicit company) is the implicit company's; a named company collides; anything else is unreadable and refuses. */
function namedCompanyOwns(row: Record<string, unknown> | undefined): boolean {
  if (row === undefined || !Object.hasOwn(row, "companyId") || row["companyId"] === undefined) return false;
  const company = OrgIdSchema.safeParse(row["companyId"]);
  if (!company.success) throw new Collision();
  return company.data !== IMPLICIT_COMPANY_ID;
}

async function callerCompanyHasName(deps: AdminNameCollisionDependencies, personId: string, projectName: string): Promise<boolean> {
  if (deps.companies === undefined) return false;
  const value = await deps.companies.companyOf(personId);
  // No live membership (an install administrator outside every company): nothing more to read; the legacy checks still apply.
  if (value === undefined) return false;
  const company = OrgIdSchema.safeParse(value);
  if (!company.success) throw new Collision();
  if (company.data === IMPLICIT_COMPANY_ID) return false;
  const answer = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgProjectCatalogKey(company.data, projectName), ConsistentRead: true })) as { Item?: unknown };
  return answer?.Item !== undefined;
}

/**
 * Refuses (FORBIDDEN, fixed words) when `projectName` is also a named company's project, by the three point reads above. Asked only after the route's own claim and grant
 * checks, so a caller without the grant learns nothing new from it.
 */
export async function refuseNamedCompanyName(deps: AdminNameCollisionDependencies, personId: string, projectName: string): Promise<void> {
  let collides: boolean;
  try {
    const [latest, catalog, own] = await Promise.all([
      // The latest revision only (newest first, one item, consistent), as admin-reads.ts latestProjectRecord reads it.
      queryAllItems(deps, `PROJECT#${projectName}`, "REV#", { limit: 1, newestFirst: true }),
      deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectCatalogKey(projectName), ConsistentRead: true })) as Promise<{ Item?: Record<string, unknown> } | undefined>,
      callerCompanyHasName(deps, personId, projectName),
    ]);
    collides = namedCompanyOwns(latest[0]) || namedCompanyOwns(catalog?.Item) || own;
  } catch {
    // Unreadable is refused, never allowed: no cause leaves this function.
    collides = true;
  }
  if (collides) throw agentXError("FORBIDDEN", ADMIN_NAME_COLLISION_MESSAGE);
}
