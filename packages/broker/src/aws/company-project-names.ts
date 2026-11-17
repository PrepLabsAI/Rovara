// Guided onboarding L2-1 (DEC 254o a): per-company project names for projects a company creates (its owners and admins, PR 19).
//   - A project's id (its definition name, `PROJECT#<id>`, every route's `{project}`) stays globally unique, as every reader expects. A company's
//     project gets an id that is NOT derived only from its name: the name (cut to fit) plus "-" and six random characters (`web-k3j9x2`).
//   - The name the company chose is unique inside that company only: a claim row in the company's own partition (orgProjectNameClaimKey), written
//     in the SAME conditional transaction as the project's rows, plus a check that the company has no older project (id == name) of that name in
//     its own catalog. Only the company's own rows are read for a name, so no answer, refusal or timing depends on another company's names.
//   - The Rovara administrator's create and the admin `register` keep today's global names (id == name), byte-identical.
import { randomBytes } from "node:crypto";
import { AGENTX_NAME_PATTERN, AgentXError, errorStatus, OrgIdSchema, orgProjectCatalogKey, orgProjectNameClaimKey } from "@agentx/contracts";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { unavailable } from "./client-project-create.js";

/** The six random characters after a company project's name, and the most of the name kept in front of them (63-character ids). */
export const PROJECT_ID_SUFFIX_LENGTH = 6;
const NAME_PART_MAX = 63 - 1 - PROJECT_ID_SUFFIX_LENGTH;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** The largest multiple of 36 below 256: a byte at or above it is drawn again, so every character is equally likely. */
const UNBIASED_BELOW = 252;
export const PROJECT_NAME_CLAIM = "PROJECT_NAME_CLAIM";

type Store = { send(command: unknown): Promise<unknown> };

/** A new project id for a company's name `name`: never another company's input, never the name alone. `random` is for tests. */
export function companyProjectId(name: string, random: (size: number) => Uint8Array = randomBytes): string {
  if (!AGENTX_NAME_PATTERN.test(name)) throw new Error("invalid project name");
  let suffix = "";
  while (suffix.length < PROJECT_ID_SUFFIX_LENGTH) {
    for (const byte of random(PROJECT_ID_SUFFIX_LENGTH * 2)) {
      if (byte < UNBIASED_BELOW && suffix.length < PROJECT_ID_SUFFIX_LENGTH) suffix += ALPHABET[byte % ALPHABET.length];
    }
  }
  const id = `${name.slice(0, NAME_PART_MAX).replace(/-+$/, "")}-${suffix}`;
  if (!AGENTX_NAME_PATTERN.test(id)) throw new Error("invalid project id");
  return id;
}

/**
 * Whether `companyId` already uses `name`: its claim on the name, or an older project of the company whose id IS the name (its own catalog row).
 * Reads only the company's own partitions, consistently.
 */
export async function companyNameTaken(store: Store, tableName: string, companyId: string, name: string): Promise<boolean> {
  const company = OrgIdSchema.parse(companyId);
  const [claim, older] = await Promise.all([orgProjectNameClaimKey(company, name), orgProjectCatalogKey(company, name)].map(async (Key) =>
    ((await store.send(new GetCommand({ TableName: tableName, Key, ConsistentRead: true }))) as { Item?: unknown }).Item));
  return claim !== undefined || older !== undefined;
}

/**
 * The transaction items that claim `name` for `companyId` as project `projectId`: the claim row (only if absent) and a check that the company's
 * own catalog has no project named `name`. Either failing cancels the whole registration, so nothing is written. Only a company's project, and only
 * its first revision, claims a name: anything else is refused before any write.
 */
export function companyNameClaimWrites(tableName: string, claim: { companyId: string | undefined; name: string; projectId: string; revision: number; by: string; at: string }) {
  const parsed = OrgIdSchema.safeParse(claim.companyId);
  if (!parsed.success || claim.revision !== 1) throw new AgentXError("FORBIDDEN", "a company's project name is claimed only by that company's first revision", errorStatus("FORBIDDEN"));
  const company = parsed.data;
  return [
    { Put: { TableName: tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
      ...orgProjectNameClaimKey(company, claim.name), entityType: PROJECT_NAME_CLAIM, companyId: company, name: claim.name, projectId: claim.projectId, claimedBy: claim.by, claimedAt: claim.at,
    } } },
    { ConditionCheck: { TableName: tableName, Key: orgProjectCatalogKey(company, claim.name), ConditionExpression: "attribute_not_exists(pk)" } },
  ];
}

/**
 * The id of the company's project called `name`, for a lookup by name (Slack `/rovara link <name>`, a picker): the company's own claim, else an
 * older project whose id is the name and whose catalog row is the company's. Undefined when the company has none; never another company's.
 */
export async function companyProjectIdByName(store: Store, tableName: string, companyId: string, name: string): Promise<string | undefined> {
  const company = OrgIdSchema.parse(companyId);
  const read = async (Key: { pk: string; sk: string }) => ((await store.send(new GetCommand({ TableName: tableName, Key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  const claim = await read(orgProjectNameClaimKey(company, name));
  if (claim !== undefined) {
    if (claim.entityType !== PROJECT_NAME_CLAIM || claim.companyId !== company || claim.name !== name || typeof claim.projectId !== "string" || !AGENTX_NAME_PATTERN.test(claim.projectId)) return undefined;
    // The project itself must still be the company's (its latest revision), whatever the claim says.
    const latest = ((await store.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :revision)",
      ExpressionAttributeValues: { ":pk": `PROJECT#${claim.projectId}`, ":revision": "REV#" }, ScanIndexForward: false, Limit: 1, ConsistentRead: true }))) as { Items?: Array<Record<string, unknown>> }).Items?.[0];
    return latest !== undefined && latest.companyId === company ? claim.projectId : undefined;
  }
  const older = await read(orgProjectCatalogKey(company, name));
  return older !== undefined && older.entityType === "PROJECT_CATALOG" && older.companyId === company && older.name === name ? name : undefined;
}

/** How a create names its project: absent, today's global names (the Rovara administrator); `perCompany`, the caller's company's own names (PR 19). */
export interface ClientProjectNaming { perCompany: true }
/** How many fresh ids a create tries before it answers `unavailable` (a clash of six random characters is already rare). */
export const PROJECT_ID_ATTEMPTS = 3;

/**
 * The naming rules one create uses. `projectExists` is the global id check (`PROJECT#<id>`), asked only of today's names and of a fresh random id;
 * `companyTaken` reads only the naming company's own rows.
 */
export function companyProjectNaming(projectExists: (id: string) => Promise<boolean>, companyTaken: (companyId: string, name: string) => Promise<boolean>) {
  return {
    /** The company whose names apply, or undefined for today's global names. Per-company naming without a company is refused (fail closed). */
    owner(naming: ClientProjectNaming | undefined, companyId: string | undefined): string | undefined {
      if (naming?.perCompany !== true) return undefined;
      if (companyId === undefined || !OrgIdSchema.safeParse(companyId).success) throw new AgentXError("FORBIDDEN", "only a Rovara administrator can create a project", errorStatus("FORBIDDEN"));
      return companyId;
    },
    /** Whether `name` is in use: globally for today's names, in the owner company only otherwise. */
    taken: (owner: string | undefined, name: string): Promise<boolean> => owner === undefined ? projectExists(name) : companyTaken(owner, name),
    /** The project's id: the name itself for today's names; a fresh id not in use for a company's. */
    async idFor(owner: string | undefined, name: string): Promise<string> {
      if (owner === undefined) return name;
      for (let attempt = 0; attempt < PROJECT_ID_ATTEMPTS; attempt++) {
        const id = companyProjectId(name);
        if (!await projectExists(id)) return id;
      }
      throw unavailable();
    },
    /** What registration claims in its transaction: nothing for today's names. */
    claim: (owner: string | undefined, name: string): { nameClaim?: { name: string } } => owner === undefined ? {} : { nameClaim: { name } },
  };
}
