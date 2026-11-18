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
  ChannelSpaceRefSchema, IMPLICIT_COMPANY_ID, channelBindingKey, channelBindingPartition, slackBindingPk, OrgIdSchema, PROJECT_REVISION_SK_PREFIX, ProjectDefinitionSchema, SLACK_CHANNEL, SlackChannelBindingSchema, memberGrantsPk, orgProjectCatalogKey, orgScoped, projectMetaKey, projectPk,
  projectRevisionKey, readChannelBindingItem, slackBindingKey, slackBindingOf, type OrgId, type SlackChannelBinding,
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

/** The partition of a Slack team's channel bindings for this company: a NAMED company's own (`ORG#<c>#SLACK_BINDING#<team>`), else the legacy `SLACK_BINDING#<team>`. */
export function slackChannelBindingPkFor(companyId: string | undefined, teamId: string): string {
  const company = namedCompany(companyId);
  return company === undefined ? channelBindingPartition(SLACK_CHANNEL, teamId) : slackBindingPk(company, teamId);
}

/** One Slack channel's binding key for this company (the ref is checked as the legacy key checks it). */
export function slackChannelBindingKeyFor(companyId: string | undefined, teamId: string, channelId: string): Key {
  const legacy = channelBindingKey({ channel: SLACK_CHANNEL, tenant: teamId, space: channelId });
  const company = namedCompany(companyId);
  return company === undefined ? legacy : slackBindingKey(company, teamId, channelId);
}

/**
 * A Slack channel's binding for a NAMED company, from the company's own partition only: `ORG#<company>#SLACK_BINDING#<team>` / `CHANNEL#<channel>` (slackBindingKey). Absent when
 * there is no row. A row whose key is not exactly that key, that names another team or channel, that names another company, or that does not parse, is absent too (never a guess,
 * never another company's row). The result names the company it was read for, so a caller can tell a company-scoped binding from a legacy one.
 */
export async function namedCompanySlackBinding(client: Client, tableName: string, company: OrgId, teamId: string, channelId: string): Promise<(SlackChannelBinding & { companyId: OrgId }) | undefined> {
  if (namedCompany(company) !== company) return undefined;
  const ref = { channel: SLACK_CHANNEL, tenant: teamId, space: channelId };
  if (!ChannelSpaceRefSchema.safeParse(ref).success) return undefined;
  const key: Key = slackChannelBindingKeyFor(company, teamId, channelId);
  const response = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined;
  const row = response?.Item;
  if (row === undefined || row.pk !== key.pk || row.sk !== key.sk || !ownPartitionRow(row, company)) return undefined;
  try {
    const binding = slackBindingOf(readChannelBindingItem(ref, row)!);
    return SlackChannelBindingSchema.safeParse(binding).success ? { ...binding, companyId: company } : undefined;
  } catch { return undefined; }
}

/**
 * R2-F1 review H1 (DEC 254zzz80): project names stay unique across the whole install while project grants are still keyed by name (lane 2). A named company's
 * registration claims its project's name install-wide with one row, `PROJECT_NAME_RESERVATION#<name>` / `RESERVATION` (the company that holds it), written in the
 * registration's own transaction (`projectNameReservationWrite`: only when absent, or already this company's). Every name check reads it (`projectNameReservedBy`).
 */
export function projectNameReservationKey(project: string): Key {
  return { pk: `PROJECT_NAME_RESERVATION#${project}`, sk: "RESERVATION" };
}

/** Who holds `project`'s install-wide name: undefined when nobody does; a row that names no valid company is reported as `"unreadable"` (callers refuse: fail closed). */
export async function projectNameReservedBy(client: Client, tableName: string, project: string): Promise<string | undefined> {
  const key = projectNameReservationKey(project);
  const row = (await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined)?.Item;
  if (row === undefined) return undefined;
  const company = OrgIdSchema.safeParse(row.companyId);
  return row.pk === key.pk && row.sk === key.sk && company.success ? company.data : "unreadable";
}

/** The registration transaction's item that claims (or keeps) `project`'s install-wide name for `company`: refused when another company holds it. */
export function projectNameReservationWrite(tableName: string, company: OrgId, project: string, at: string) {
  return { Update: {
    TableName: tableName, Key: projectNameReservationKey(project),
    UpdateExpression: "SET entityType = :entity, companyId = :company, #name = :name, reservedAt = if_not_exists(reservedAt, :at)",
    ConditionExpression: "attribute_not_exists(pk) OR companyId = :company",
    ExpressionAttributeNames: { "#name": "name" },
    ExpressionAttributeValues: { ":entity": "PROJECT_NAME_RESERVATION", ":company": company, ":name": project, ":at": at },
  } };
}

/** The most companies `projectNameHolder` looks through; more is refused as unreadable (fail closed), never a silent subset. */
export const PROJECT_NAME_HOLDER_COMPANIES_MAX = 500;

/**
 * Which company holds `project`'s name install-wide, read in a bounded way: its reservation (projects registered since R2-F1), else the own catalog row of every company the
 * core lists as in use (`CORE_ENGINE_IN_USE`, the one install-wide list of companies: a project made before the reservation existed, by the switch-over move or the core's own
 * writers, by a company that has ever run a task on the core). There is no other list of companies and no scan is made, so a named company that never ran a core task and
 * registered nothing since R2-F1 is not found here (the reservation backfill closes that). More companies than PROJECT_NAME_HOLDER_COMPANIES_MAX, a list row or catalog row
 * naming no valid company, or a catalog row naming another company: "unreadable" (refuse).
 */
export async function projectNameHolder(client: Client, tableName: string, project: string): Promise<string | undefined> {
  const reserved = await projectNameReservedBy(client, tableName, project);
  if (reserved !== undefined) return reserved;
  const companies: OrgId[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "CORE_ENGINE_IN_USE" },
      ConsistentRead: true, Limit: 100, ...(start === undefined ? {} : { ExclusiveStartKey: start }) })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> } | undefined;
    for (const item of page?.Items ?? []) {
      const company = OrgIdSchema.safeParse(item.orgId);
      if (!company.success || item.sk !== `ORG#${company.data}`) return "unreadable";
      if (company.data !== IMPLICIT_COMPANY_ID) companies.push(company.data);
    }
    if (companies.length > PROJECT_NAME_HOLDER_COMPANIES_MAX) return "unreadable";
    start = page?.LastEvaluatedKey;
  } while (start !== undefined);
  for (const company of companies) {
    const key = orgProjectCatalogKey(company, project);
    const row = (await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined)?.Item;
    if (row === undefined) continue;
    return ownPartitionRow(row, company) ? company : "unreadable";
  }
  return undefined;
}
