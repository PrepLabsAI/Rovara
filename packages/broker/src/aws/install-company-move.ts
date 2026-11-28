// #1612: move an install's old built-in-company records into the install's own company, so an install made before #1612 (or one whose people signed in before it had a company)
// works on the core with no manual steps. Operator-run (init and upgrade run it with the operator's own AWS credentials); re-runnable; a preview unless `apply` is set; legacy rows are
// never deleted or changed, and every write is conditional, so a second run writes nothing.
//   1. Projects: every project in the built-in company's catalog, through the project backfill (core-project-backfill.ts), as #1300 moved production's.
//   2. People: each person who holds a legacy project grant and has already signed in joins the install's company by the install rule (install-company.ts; the email index names
//      the owner, who takes the owner seat). People who have not signed in yet join when they first sign in.
//   3. Grants: every legacy project grant is copied into the company's layout under the same person id (a legacy grant is already keyed by the id that person signs in with, even
//      before their first sign-in), so access is there the moment they are a member.
// The Slack workspace, its channels and the GitHub installations move separately. Reports carry counts only: no project names, people or ids.
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { IMPLICIT_COMPANY_ID, OrgIdSchema, orgProjectCatalogPk } from "@agentx/contracts";
import { CompanySignInStore } from "../developer/company-membership.js";
import { InstallCompanyStore } from "../developer/install-company.js";
import { backfillCorePage } from "./core-project-backfill.js";
import { grantKeyFor, projectMemberRowKeyFor } from "./company-layout.js";

export interface InstallMoveDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table. */
  tableName: string;
  signInTableName: string;
  now?: () => number;
}

export interface InstallMoveCounts { found: number; written: number; existing: number; conflicts: number }
export interface InstallMoveReport {
  companyId: string;
  apply: boolean;
  projects: InstallMoveCounts;
  /** Grant holders who have signed in: `written` joined now, `existing` were already members of the install's company, `conflicts` are in another company or were removed. */
  people: InstallMoveCounts;
  /** Grant holders who have not signed in yet: they join on their first sign-in. */
  notSignedIn: number;
  grants: InstallMoveCounts;
  /** A read or write failed: nothing after it ran; run the move again. */
  failed: boolean;
}

type Row = Record<string, unknown>;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PERSON = /^[a-f0-9]{64}$/;
const MAX_PROJECTS = 100;
const MAX_GRANTS_PER_PROJECT = 500;
const LegacyGrant = z.object({ entityType: z.literal("MEMBERSHIP"), ownerKey: z.string().regex(PERSON), projectName: z.string().regex(NAME), role: z.enum(["developer", "administrator"]) }).passthrough();
const SignedInPerson = z.object({ entityType: z.literal("DEVELOPER"), revoked: z.literal(false), companyless: z.unknown().optional(), mergedInto: z.unknown().optional() }).passthrough();
const counts = (): InstallMoveCounts => ({ found: 0, written: 0, existing: 0, conflicts: 0 });
const conditional = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

export async function moveIntoInstallCompany(deps: InstallMoveDependencies, input: { companyId: string; apply: boolean }): Promise<InstallMoveReport> {
  const companyId = OrgIdSchema.refine((id) => id !== IMPLICIT_COMPANY_ID).parse(input.companyId);
  const result: InstallMoveReport = { companyId, apply: input.apply, projects: counts(), people: counts(), notSignedIn: 0, grants: counts(), failed: false };
  try {
    const company = new CompanySignInStore({ documentClient: deps.documentClient, tableName: deps.signInTableName, now: deps.now ?? Date.now });
    const install = new InstallCompanyStore({ company, documentClient: deps.documentClient, tableName: deps.signInTableName, now: deps.now ?? Date.now });
    // Only ever into the install's own company, checked before anything is read or written.
    if (await install.companyId() !== companyId) throw new Error("not the install's company");
    const projects = await legacyProjects(deps);
    result.projects.found = projects.length;
    await moveProjects(deps, companyId, projects, input.apply, result.projects);
    const grants = (await Promise.all(projects.map(async (project) => await legacyGrants(deps, project)))).flat();
    result.grants.found = grants.length;
    await seatPeople(deps, { company, install }, companyId, [...new Set(grants.map((grant) => grant.ownerKey))], input.apply, result);
    for (const grant of grants) await copyGrant(deps, companyId, grant, input.apply, result.grants);
  } catch { result.failed = true; }
  return result;
}

/** The projects in the built-in company's catalog. */
async function legacyProjects(deps: InstallMoveDependencies): Promise<string[]> {
  const answer = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :project)",
    ExpressionAttributeValues: { ":pk": orgProjectCatalogPk(IMPLICIT_COMPANY_ID), ":project": "PROJECT#" }, ConsistentRead: true, Limit: MAX_PROJECTS + 1 })) as { Items?: Row[] };
  const names = (answer.Items ?? []).map((row) => String(row["sk"]).slice("PROJECT#".length)).filter((name) => NAME.test(name));
  if (names.length > MAX_PROJECTS) throw new Error("too many projects");
  return names;
}

/** The project backfill, a page at a time (it previews unless `apply`). */
async function moveProjects(deps: InstallMoveDependencies, companyId: string, projects: string[], apply: boolean, into: InstallMoveCounts): Promise<void> {
  if (projects.length === 0) return;
  let continuation: string | undefined;
  for (let page = 0; page < 100; page++) {
    const report = await backfillCorePage({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.signInTableName, ...(deps.now === undefined ? {} : { now: deps.now }) },
      { companyId, projectNames: projects, dryRun: !apply, ...(continuation === undefined ? {} : { continuation }) });
    if (report.refused !== undefined || report.failed > 0) throw new Error("project backfill failed");
    into.written += report.written; into.existing += report.skippedExisting; into.conflicts += report.skippedConflict;
    if (!report.more) return;
    continuation = report.continuation;
  }
  throw new Error("project backfill did not finish");
}

/** A project's legacy grants: its reverse rows, each checked against the person's own grant row. */
async function legacyGrants(deps: InstallMoveDependencies, project: string): Promise<Array<z.infer<typeof LegacyGrant>>> {
  const answer = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :developer)",
    ExpressionAttributeValues: { ":pk": projectMemberRowKeyFor(undefined, project, "x").pk, ":developer": "DEVELOPER#" }, ConsistentRead: true, Limit: MAX_GRANTS_PER_PROJECT + 1 })) as { Items?: Row[] };
  if ((answer.Items?.length ?? 0) > MAX_GRANTS_PER_PROJECT) throw new Error("too many grants");
  const grants: Array<z.infer<typeof LegacyGrant>> = [];
  for (const row of answer.Items ?? []) {
    const personId = String(row["sk"]).slice("DEVELOPER#".length);
    if (!PERSON.test(personId)) continue;
    const grant = LegacyGrant.safeParse(await get(deps, grantKeyFor(undefined, personId, project)));
    if (grant.success && grant.data.ownerKey === personId && grant.data.projectName === project) grants.push(grant.data);
  }
  return grants;
}

/** Each grant holder who has signed in joins the install's company by the install rule; one who has not is counted, and joins on their first sign-in. */
async function seatPeople(deps: InstallMoveDependencies, stores: { company: CompanySignInStore; install: InstallCompanyStore }, companyId: string, people: string[], apply: boolean, result: InstallMoveReport): Promise<void> {
  for (const personId of people) {
    const outcome = await seatPerson(deps, stores, companyId, personId, apply);
    if (outcome === "not_signed_in") { result.notSignedIn++; continue; }
    result.people.found++;
    result.people[outcome]++;
  }
}

async function seatPerson(deps: InstallMoveDependencies, stores: { company: CompanySignInStore; install: InstallCompanyStore }, companyId: string, personId: string, apply: boolean): Promise<"not_signed_in" | "written" | "existing" | "conflicts"> {
  const record = SignedInPerson.safeParse(await get(deps, { pk: `DEVELOPER#${personId}`, sk: "META" }, deps.signInTableName));
  // A record first written with no company, or merged into another person, is never seated here (as the legacy rule: company-membership.ts).
  if (!record.success || record.data.companyless !== undefined || record.data.mergedInto !== undefined) return "not_signed_in";
  const member = await stores.company.membership(personId);
  if (member !== undefined) return member.companyId === companyId && member.revokedAt === undefined ? "existing" : "conflicts";
  if (!apply) return "written";
  const joined = await stores.install.join({ personId, byEmailIndex: true });
  if (joined.ok) return "written";
  if (joined.readFailed === true) throw new Error("join failed");
  return "conflicts";
}

/** One legacy grant into the company's layout: the grant and its reverse row, only while the legacy grant still says the same, and never over a different row. */
async function copyGrant(deps: InstallMoveDependencies, companyId: string, grant: z.infer<typeof LegacyGrant>, apply: boolean, into: InstallMoveCounts): Promise<void> {
  const key = grantKeyFor(companyId, grant.ownerKey, grant.projectName);
  const reverseKey = projectMemberRowKeyFor(companyId, grant.projectName, grant.ownerKey);
  const [existing, reverse] = [await get(deps, key), await get(deps, reverseKey)];
  if (existing !== undefined || reverse !== undefined) {
    const same = existing?.["role"] === grant.role && existing["ownerKey"] === grant.ownerKey && reverse?.["role"] === grant.role;
    if (same) into.existing++; else into.conflicts++;
    return;
  }
  if (!apply) { into.written++; return; }
  const grantedAt = typeof grant["grantedAt"] === "string" ? grant["grantedAt"] : new Date((deps.now ?? Date.now)()).toISOString();
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: deps.tableName, Key: grantKeyFor(undefined, grant.ownerKey, grant.projectName), ConditionExpression: "#role = :role AND ownerKey = :person", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": grant.role, ":person": grant.ownerKey } } },
      { Put: { TableName: deps.tableName, Item: { ...key, entityType: "MEMBERSHIP", ownerKey: grant.ownerKey, projectName: grant.projectName, role: grant.role, grantId: typeof grant["grantId"] === "string" ? grant["grantId"] : randomUUID(), grantedAt }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: deps.tableName, Item: { ...reverseKey, entityType: "PROJECT_MEMBER", role: grant.role, grantedAt }, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
    into.written++;
  } catch (error) { if (!conditional(error)) throw error; into.conflicts++; }
}

async function get(deps: InstallMoveDependencies, key: { pk: string; sk: string }, tableName = deps.tableName): Promise<Row | undefined> {
  const answer = await deps.documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Row };
  return answer.Item;
}
