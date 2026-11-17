// DEC 254: the company records an install created before Code's company sign-in (the T1 company-scoped layout), read for the access check (POST /v1/dev/access).
// Staging's data lives only there: the person's company pointer `DEVELOPER_ORG#<person>` / `ORG` (State table), the company's own record `ORG#<company>` / `META`, its
// member record `ORG#<company>` / `MEMBER#<person>` (the role always comes from here, never from the pointer), its ban list `ORG#<company>#BAN` / <person>, and the
// project grants `ORG#<company>#MEMBER#<person>` / `PROJECT#<name>`, catalog `ORG#<company>#PROJECT_CATALOG` and revisions `ORG#<company>#PROJECT#<name>` / `REV#…`.
//
// A sign-in that was MERGED into another (`DEVELOPER#<id>` / `META` `mergedInto` in the sign-in table) is read as the person it was merged into: the survivor holds the
// company link and the grants. The walk is bounded (MERGE_HOPS_MAX) and refuses a loop or a revoked survivor; it never guesses.
//
// Read only when Code's own company sign-in layer is OFF (no `companies` reader). With it on, Code's live membership is the only authority (company-check.ts).
// Every read here is consistent and shares one bounded budget (boundedCompanyReads); any fault or unreadable record refuses, it never falls back to another company.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  OrgIdSchema, OrgRoleSchema, MEMBER_GRANT_SK_PREFIX, PROJECT_REVISION_SK_PREFIX, SLACK_BINDING_SK_PREFIX, memberGrantsPk, orgPk, orgProjectCatalogPk, orgScoped, projectPk, slackBindingPk,
  type OrgId, type OrgRole, type SlackChannelBinding,
} from "@agentx/contracts";

/** The longest merge chain followed (the same bound the install that wrote the merges used for its own readers). */
export const MERGE_HOPS_MAX = 8;
/** Projects one company may hold in this answer; more refuses the whole answer, never a silent cut. */
export const INSTALL_COMPANY_PROJECTS_MAX = 500;

type Client = { send(command: unknown): Promise<unknown> };
type Item = Record<string, unknown>;
const PersonId = z.string().regex(/^[a-f0-9]{64}$/);

export const developerOrgPointerKey = (personId: string) => ({ pk: `DEVELOPER_ORG#${PersonId.parse(personId)}`, sk: "ORG" });
export const installCompanyKey = (companyId: OrgId) => ({ pk: orgPk(OrgIdSchema.parse(companyId)), sk: "META" });
export const installCompanyMemberKey = (companyId: OrgId, personId: string) => ({ pk: orgPk(OrgIdSchema.parse(companyId)), sk: `MEMBER#${PersonId.parse(personId)}` });
export const installCompanyBanKey = (companyId: OrgId, personId: string) => ({ pk: orgScoped(OrgIdSchema.parse(companyId), "BAN"), sk: PersonId.parse(personId) });

/** Refused: the caller answers its one fixed refusal. Carries no cause. */
export class InstallCompanyRefused extends Error {
  constructor() { super("install company refused"); this.name = "InstallCompanyRefused"; }
}
const refuse = (): never => { throw new InstallCompanyRefused(); };

const Developer = z.object({ displayName: z.string().optional(), displayNameChosen: z.boolean().optional(), slackUserId: z.string().optional(), revoked: z.boolean().optional(), mergedInto: z.unknown().optional() }).passthrough();
export type MergeWalkRecord = z.infer<typeof Developer>;

/**
 * The person a signed-in id stands for: the end of its `mergedInto` chain. Every record on the walk must read; the first (the signed-in id) and the
 * survivor must not be revoked. A loop, a chain longer than MERGE_HOPS_MAX, a missing record or a malformed `mergedInto` refuses.
 */
export async function mergeSurvivor(read: (personId: string) => Promise<unknown>, personId: string): Promise<{ survivorId: string; signedIn: MergeWalkRecord; survivor: MergeWalkRecord }> {
  const seen = new Set<string>([personId]);
  let current = personId;
  let first: MergeWalkRecord | undefined;
  for (let hop = 0; hop <= MERGE_HOPS_MAX; hop += 1) {
    const parsed = Developer.safeParse(await read(current));
    if (!parsed.success) return refuse();
    const record = parsed.data;
    first ??= record;
    if (first.revoked === true) return refuse();
    const next = record.mergedInto;
    if (next === undefined) {
      if (record.revoked === true) return refuse();
      return { survivorId: current, signedIn: first, survivor: record };
    }
    if (!PersonId.safeParse(next).success || seen.has(next as string)) return refuse();
    seen.add(next as string);
    current = next as string;
  }
  return refuse();
}

/** The person's company in the install's records, or undefined when they have no company pointer (a legacy install: the caller reads the legacy keys). */
export async function installCompanyOf(client: Client, tableName: string, personId: string): Promise<{ companyId: OrgId; role: OrgRole; name?: string } | undefined> {
  const get = async (key: { pk: string; sk: string }): Promise<Item | undefined> => {
    const answer = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
    const item = answer?.Item;
    if (item !== undefined && (item.pk !== key.pk || item.sk !== key.sk)) return refuse();
    return item;
  };
  const pointer = await get(developerOrgPointerKey(personId));
  if (pointer === undefined) return undefined;
  const company = OrgIdSchema.safeParse(pointer.orgId);
  if (!company.success) return refuse();
  const companyId: OrgId = company.data;
  const [member, ban, meta] = await Promise.all([get(installCompanyMemberKey(companyId, personId)), get(installCompanyBanKey(companyId, personId)), get(installCompanyKey(companyId))]);
  // No member record (removed), a ban, or a company that is gone or closed: no company, and never a fallback to another one.
  if (member === undefined || ban !== undefined || meta === undefined || meta.closedAt !== undefined) return refuse();
  // Only a role Code knows; the install's Auditor (and anything else) refuses rather than reading as some other role.
  const role = OrgRoleSchema.safeParse(member.role);
  if (!role.success) return refuse();
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  return { companyId, role: role.data, ...(name.length >= 1 && name.length <= 80 ? { name } : {}) };
}

/** Every item under `pk` with the sort-key prefix, each page consistent; the shared budget bounds the total. */
async function queryAll(client: Client, tableName: string, pk: string, prefix: string): Promise<Item[]> {
  const items: Item[] = [];
  let start: Item | undefined;
  do {
    const answer = await client.send(new QueryCommand({
      TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: unknown; LastEvaluatedKey?: Item };
    if (!Array.isArray(answer?.Items)) return refuse();
    for (const item of answer.Items as Item[]) {
      if (item?.pk !== pk || typeof item.sk !== "string" || !item.sk.startsWith(prefix)) return refuse();
      items.push(item);
    }
    if (items.length > INSTALL_COMPANY_PROJECTS_MAX * 4) return refuse();
    start = answer.LastEvaluatedKey;
  } while (start !== undefined);
  return items;
}

/** The names a person's grants in one company give task use of (`developer` or `administrator` rows, as Code's own grants read). */
export async function installCompanyGrants(client: Client, tableName: string, companyId: OrgId, personId: string, mayUse: (role: unknown) => boolean): Promise<string[]> {
  const rows = await queryAll(client, tableName, memberGrantsPk(companyId, PersonId.parse(personId)), MEMBER_GRANT_SK_PREFIX);
  return rows.flatMap((row) => typeof row.projectName === "string" && row.sk === `${MEMBER_GRANT_SK_PREFIX}${row.projectName}` && mayUse(row.role) ? [row.projectName] : []);
}

/** Every project in the company's catalog (a company owner or admin reaches each one). */
export async function installCompanyCatalog(client: Client, tableName: string, companyId: OrgId): Promise<string[]> {
  const rows = await queryAll(client, tableName, orgProjectCatalogPk(companyId), "PROJECT#");
  const names = rows.flatMap((row) => {
    const name = typeof row.name === "string" ? row.name : (row.sk as string).slice("PROJECT#".length);
    return name.length > 0 && row.sk === `PROJECT#${name}` ? [name] : [];
  });
  if (names.length > INSTALL_COMPANY_PROJECTS_MAX) return refuse();
  return names;
}

/** The install's Slack team's channel bindings inside one company. */
export async function installCompanyBindings(client: Client, tableName: string, companyId: OrgId, teamId: string): Promise<SlackChannelBinding[]> {
  const rows = await queryAll(client, tableName, slackBindingPk(companyId, teamId), SLACK_BINDING_SK_PREFIX);
  return rows.flatMap((row) => typeof row.projectName === "string" && typeof row.channelId === "string" && row.sk === `${SLACK_BINDING_SK_PREFIX}${row.channelId}`
    ? [{ ...(row as unknown as SlackChannelBinding), teamId: typeof row.teamId === "string" ? row.teamId : teamId }] : []);
}

/** A project's latest revision in one company: its number and task policy. Undefined when it has none. */
export async function installCompanyLatestDefinition(client: Client, tableName: string, companyId: OrgId, project: string): Promise<{ revision: number; developerTasks?: unknown } | undefined> {
  const pk = projectPk(companyId, project);
  const answer = await client.send(new QueryCommand({
    TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": PROJECT_REVISION_SK_PREFIX },
    ScanIndexForward: false, Limit: 1, ConsistentRead: true,
  })) as { Items?: Item[] };
  const row = answer?.Items?.[0];
  if (row === undefined) return undefined;
  const definition = row.definition as { revision?: unknown; developerTasks?: unknown } | undefined;
  if (row.pk !== pk || typeof definition?.revision !== "number") return undefined;
  return { revision: definition.revision, ...(definition.developerTasks === undefined ? {} : { developerTasks: definition.developerTasks }) };
}
