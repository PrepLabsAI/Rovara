// DEC 254zzz80 (owner, 2026-11-18, R2-F1): for a NAMED company, the company's own partition (`ORG#<company>#...`) is the one place its projects and project
// grants live. The built-in (implicit) company, and a Code with no company, keep the legacy unscoped keys exactly as before. Every reader and writer that
// picks a project-revision or project-grant key goes through these helpers, so the choice is made in one place.
//
//   revisions: `ORG#<c>#PROJECT#<name>` / `REV#<12 digits>`   (legacy `PROJECT#<name>` / `REV#…`)
//   grants:    `ORG#<c>#MEMBER#<person>` / `PROJECT#<name>`   (legacy `MEMBER#<person>` / `PROJECT#<name>`)
//   reverse:   `ORG#<c>#PROJECT_MEMBERS#<name>` / `DEVELOPER#<person>`   (legacy `PROJECT_MEMBERS#<name>` / `DEVELOPER#<person>`)
//
// The company always comes from the caller's LIVE membership (or, for a stored record, the company the record itself names), never from a request.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  IMPLICIT_COMPANY_ID, OrgIdSchema, PROJECT_REVISION_SK_PREFIX, ProjectDefinitionSchema, memberGrantsPk, orgProjectCatalogKey, orgScoped, projectMetaKey, projectPk, projectRevisionKey, type OrgId,
} from "@agentx/contracts";
import { ownPartitionRow } from "./company-check.js";

type Client = { send(command: unknown): Promise<unknown> };
type Key = { pk: string; sk: string };

/** The company whose own partition holds its projects: a valid, NAMED company. Undefined: no company, the built-in company, or an id that does not parse. */
export function namedCompany(companyId: string | undefined): OrgId | undefined {
  if (companyId === undefined || companyId === IMPLICIT_COMPANY_ID) return undefined;
  const parsed = OrgIdSchema.safeParse(companyId);
  return parsed.success ? parsed.data : undefined;
}

/** The partition of a project's revisions for this company. */
export function revisionPkFor(companyId: string | undefined, project: string): string {
  const company = namedCompany(companyId);
  return company === undefined ? `PROJECT#${project}` : projectPk(company, project);
}

/** One revision's key for this company. */
export function revisionKeyFor(companyId: string | undefined, project: string, revision: number): Key {
  const company = namedCompany(companyId);
  return company === undefined ? { pk: `PROJECT#${project}`, sk: `REV#${String(revision).padStart(12, "0")}` } : projectRevisionKey(company, project, revision);
}

/** The partition of a person's project grants for this company. */
export function grantsPkFor(companyId: string | undefined, personId: string): string {
  const company = namedCompany(companyId);
  return company === undefined ? `MEMBER#${personId}` : memberGrantsPk(company, personId);
}

/** A person's grant on one project, for this company. */
export function grantKeyFor(companyId: string | undefined, personId: string, project: string): Key {
  return { pk: grantsPkFor(companyId, personId), sk: `PROJECT#${project}` };
}

/** The partition listing a project's members (the grant's reverse rows), for this company. */
export function projectMembersPkFor(companyId: string | undefined, project: string): string {
  const company = namedCompany(companyId);
  return company === undefined ? `PROJECT_MEMBERS#${project}` : orgScoped(company, `PROJECT_MEMBERS#${project}`);
}

/** One member's reverse row on a project, for this company. */
export function projectMemberRowKeyFor(companyId: string | undefined, project: string, personId: string): Key {
  return { pk: projectMembersPkFor(companyId, project), sk: `DEVELOPER#${personId}` };
}

/**
 * A named company's project's latest revision row, in the core's own order (core/task-flow/project-source.ts): the catalog row's pointer, else the newest
 * revision that is not a candidate (a setup waiting for approval). The pointer's row is taken even when it still says `candidate`: an approved setup moves
 * the catalog onto its candidate revision and leaves that flag on the row (core/setup-agent/apply.ts), and the core reads it the same way. A row that does
 * not parse as a project, or that names another company, is absent.
 */
export async function namedCompanyLatestRevisionRow(client: Client, tableName: string, company: OrgId, project: string): Promise<Record<string, unknown> | undefined> {
  const pk = projectPk(company, project);
  const usable = (row: Record<string, unknown> | undefined) =>
    row !== undefined && row.pk === pk && ownPartitionRow(row, company) && ProjectDefinitionSchema.safeParse(row.definition).success
    && typeof (row.definition as { revision?: unknown }).revision === "number" ? row : undefined;
  const get = async (key: Key) => (await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined)?.Item;
  const catalogKey = orgProjectCatalogKey(company, project);
  const catalog = await get(catalogKey);
  const pointer = catalog?.latestRevision;
  if (catalog !== undefined && catalog.pk === catalogKey.pk && catalog.sk === catalogKey.sk && typeof pointer === "number" && Number.isSafeInteger(pointer) && pointer > 0) {
    const named = usable(await get(projectRevisionKey(company, project, pointer)));
    if (named !== undefined) return named;
  }
  const response = await client.send(new QueryCommand({
    TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
    ExpressionAttributeValues: { ":pk": pk, ":rev": PROJECT_REVISION_SK_PREFIX }, ScanIndexForward: false, Limit: 20, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> } | undefined;
  return usable((response?.Items ?? []).find((item) => item.candidate !== true));
}

/**
 * Whether a named company's project is archived: its META row (`projectMetaKey`) says `archived`, as the core's own project source reads it
 * (core/task-flow/project-source.ts). An archived project stays readable (so it can be restored) but takes no new work. A META row that names
 * another company is drift and counts as archived (fail closed). The legacy layout has no archive state.
 */
export async function namedCompanyProjectArchived(client: Client, tableName: string, company: OrgId, project: string): Promise<boolean> {
  const key = projectMetaKey(company, project);
  const row = (await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined)?.Item;
  if (row === undefined) return false;
  return row.status === "archived" || !ownPartitionRow(row, company);
}

/**
 * The latest revision row of a project for this company: a named company's own partition (namedCompanyLatestRevisionRow), else the legacy partition's newest row
 * (unchanged: the caller still applies its own company check to it, `recordInCompany`). `projection` is passed only to the legacy read, as before.
 */
export async function latestRevisionRowFor(client: Client, tableName: string, companyId: string | undefined, project: string): Promise<Record<string, unknown> | undefined> {
  const company = namedCompany(companyId);
  if (company !== undefined) return namedCompanyLatestRevisionRow(client, tableName, company, project);
  const response = await client.send(new QueryCommand({
    TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":rev": "REV#" }, ScanIndexForward: false, Limit: 1, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> } | undefined;
  return response?.Items?.[0];
}
