// Lane W part 4 (plan v3.2 section 2.4; T3b's membership store, PR #707): the company administrator's routes on the deployed developer API. Cloud's admin screens call
// these AS the signed-in administrator, through a full-access sign-in client (DEC ANSWER-4: the route table gives them `full`, never a named scope).
//
//   GET  /v1/dev/company/members[?cursor=&limit=]               the company's people and roles, one page (T3b's list)
//   GET  /v1/dev/company/members/{personId}/removal-preview      what removing the person would take from them: open tasks, decisions waiting on them, projects
//   POST /v1/dev/company/members/{personId}/removal              remove them (T3b's revoke); fresh step-up
//   PUT  /v1/dev/company/members/{personId}/role                 change their role (T3b's role-set); fresh step-up
//
// Rules:
//   - The company is the caller's LIVE membership (read here from the sign-in table), never a header, a query, a body or a token claim. The member writes and the list go
//     ONLY through T3b's companyMemberActionsThroughLambda, which re-reads that membership and builds the identity request itself; this module never names a request kind.
//   - A plain member, and anyone whose membership does not read, gets the same answers as the invitation routes (404 "not found" / 401 sign in again).
//   - A person of another company, a missing person and an id that does not read all answer the same "member not found".
//   - Only an owner may change or remove an owner, or make someone an owner (DEC 232e). Nobody changes their own role or removes themselves here.
//   - A removal or a role change needs a FRESH step-up from the verified token (lane ID's contract, #682's check), every time.
//   - Bodies and queries are validated at runtime and strictly; every refusal is a fixed sentence that never echoes what was sent.
//   - Reads are bounded in total; past a bound the whole answer is refused, never a partial one.
//   - L4-GH2: a removal takes the person's GitHub link (core/people/github-links.ts) with it, in the same request, only after the removal itself succeeded. The cleanup is conditional and idempotent, never blocks
//     the removal (a failure is logged in fixed words, no cause), and a repeat of the same removal request retries it (the repeat is still answered "already removed"). Only this company's rows are read or removed.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { OrgIdSchema, agentXError, companyLog, type DocumentStore, type OrgRole } from "@agentx/contracts";
import type { AdaptedHttpRequest } from "./lambda.js";
import { Membership, membershipKey, ownPartitionRow, recordInCompany } from "./company-check.js";
import { grantsPkFor, namedCompany } from "./company-layout.js";
import { unlinkGithubAccount } from "../core/people/github-links.js";
import { profileDisplayName } from "../developer/github-profile.js";
import { requireFreshStepUp, type CallerStepUp } from "./step-up-check.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { companyMemberActionsThroughLambda } from "./company-member-forwarding.js";
import { CompanyMember, MEMBER_LAST_OWNER, MEMBER_ONLY_OWNER, MEMBER_REVOKED, MEMBER_STEP_UP, memberCursorPerson, type CompanyMemberReply } from "../developer/company-member-contract.js";

export const MEMBER_NOT_FOUND = "member not found";
export const NOT_FOUND = "not found";
/** T3b's own words for DEC 232e; the route refuses first with the same sentence, and the store refuses again inside its transaction. */
export const OWNER_ONLY = MEMBER_ONLY_OWNER;
export const OWN_MEMBERSHIP = "you cannot change your own role or remove yourself here";
export const REMOVAL_STEP_UP = "this removal needs a fresh sign-in check; sign in again and retry";
export const ROLE_BODY = "send the new role: member, admin or owner";
export const REMOVAL_BODY = "a removal takes no body";
export const LIST_QUERY = "the list takes an optional cursor this list gave and a limit from 1 to 100";
export const TOO_MUCH_WORK = "This person has too much work to show in one preview. Hand some of it over first.";
export const MEMBERS_UNAVAILABLE = "the company's members could not be read or changed just now; try again";
const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";
const REQUEST_INVALID = "the request is not valid";

/** Total bounds for one preview: rows read per index, open tasks looked at, and the members one page names. */
export const COMPANY_MEMBER_ROUTE_LIMITS = { projectRows: 500, taskRows: 500, openTasks: 200, page: 100 } as const;

export type CompanyMemberActions = ReturnType<typeof companyMemberActionsThroughLambda>;

export interface CompanyMemberRouteContext {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table (project grants, task index, tasks). */
  tableName: string;
  /** The sign-in table (memberships, people). */
  signInTableName: string;
  now: () => number;
  /** T3b's helper: the ONLY way to list, revoke or set a role. */
  members: CompanyMemberActions;
  /** Of these project names, the ones whose latest revision belongs to the company. */
  projectsInCompany(names: readonly string[], companyId: string): Promise<ReadonlySet<string>>;
  /** L4-GH2: where the members' GitHub links live (the core's own store) and the broker's log sink. Absent: a removal removes no link (the install has none). */
  githubLinks?: { store: Pick<DocumentStore, "get" | "delete" | "transact">; log: (entry: Record<string, unknown>) => void };
}

/** The removed person's GitHub link in their own company. Never throws: the removal has happened, and a failure is only logged (event name and person id; never the cause). */
async function dropGithubLink(ctx: CompanyMemberRouteContext, companyId: string, personId: string): Promise<void> {
  if (ctx.githubLinks === undefined) return;
  try {
    await unlinkGithubAccount(ctx.githubLinks.store, companyId, personId);
  } catch {
    try { companyLog(companyId, ctx.githubLinks.log)({ event: "member_removal.github_link_not_removed", level: "error", person: personId }); } catch { /* a log sink that fails must not turn a finished removal into an error */ }
  }
}

const MEMBERS = "/v1/dev/company/members";
const MEMBER_ROUTE = /^\/v1\/dev\/company\/members\/([^/]+)\/(removal-preview|removal|role)$/u;
const PersonId = z.string().regex(/^[a-f0-9]{64}$/);
const RoleBody = z.object({ role: z.enum(["member", "admin", "owner"]) }).strict();
const RemovalBody = z.object({}).strict();
const Limit = z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().int().min(1).max(COMPANY_MEMBER_ROUTE_LIMITS.page));
const Cursor = z.string().min(1).max(512);

/** Whether this module answers the path (the dispatcher sends it here before anything else is read). */
export function isCompanyMemberPath(path: string): boolean {
  return path === MEMBERS || MEMBER_ROUTE.test(path);
}

function body(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { return undefined; }
}

const isAdmin = (role: OrgRole) => role === "admin" || role === "owner";

/** A person's live membership row, as the sign-in table holds it now; undefined when it is missing or does not read. */
async function membershipOf(ctx: CompanyMemberRouteContext, personId: string): Promise<z.infer<typeof Membership> | undefined> {
  const answer = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(personId), ConsistentRead: true })) as { Item?: unknown };
  const row = Membership.safeParse(answer.Item);
  return row.success && row.data.personId === personId ? row.data : undefined;
}

/** T3b's answer, as this API's fixed answers. A refusal's words are T3b's fixed ones or this module's; nothing the request carried. */
function unwrap(reply: CompanyMemberReply): Extract<CompanyMemberReply, { ok: true }> {
  if (reply.ok) return reply;
  const message = "message" in reply ? reply.message : undefined;
  if (reply.error === "step_up_required") throw agentXError("REAUTH_REQUIRED", MEMBER_STEP_UP);
  if (message === MEMBER_LAST_OWNER) throw agentXError("LAST_OWNER", MEMBER_LAST_OWNER);
  if (message === MEMBER_REVOKED) throw agentXError("MEMBER_ALREADY_REMOVED", MEMBER_REVOKED);
  if (message === MEMBER_ONLY_OWNER) throw agentXError("FORBIDDEN", MEMBER_ONLY_OWNER);
  if (reply.error === "not_found") throw agentXError("NOT_FOUND", MEMBER_NOT_FOUND);
  if (reply.error === "invalid_request") throw agentXError("CONFIG_INVALID", REQUEST_INVALID);
  throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE);
}

/**
 * Company admin routes. The caller is already authenticated and its route row (`full`) applied; `companyId` is the company its live membership names (resolveCompany).
 * The membership is read again here, so a role or company that changed since is what counts.
 */
export async function routeCompanyMembers(ctx: CompanyMemberRouteContext, input: { caller: DeveloperCaller; stepUp?: CallerStepUp | undefined; companyId: string }, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const { caller, companyId } = input;
  let me: z.infer<typeof Membership> | undefined;
  try { me = await membershipOf(ctx, caller.developerId); } catch { me = undefined; }
  if (me === undefined || me.companyId !== companyId || me.revokedAt !== undefined || !OrgIdSchema.safeParse(companyId).success) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (!isAdmin(me.role)) throw agentXError("NOT_FOUND", NOT_FOUND);

  if (url.pathname === MEMBERS) {
    if (request.method !== "GET") throw agentXError("NOT_FOUND", NOT_FOUND);
    return listMembers(ctx, caller, me.companyId, url);
  }

  const match = MEMBER_ROUTE.exec(url.pathname);
  const method = match === null ? undefined : match[2] === "role" ? "PUT" : match[2] === "removal" ? "POST" : "GET";
  if (match === null || request.method !== method) throw agentXError("NOT_FOUND", NOT_FOUND);
  let targetId: string | undefined;
  try { targetId = decodeURIComponent(match[1]!); } catch { targetId = undefined; }
  if (targetId === undefined || !PersonId.safeParse(targetId).success) throw agentXError("NOT_FOUND", MEMBER_NOT_FOUND);
  let target: z.infer<typeof Membership> | undefined;
  try { target = await membershipOf(ctx, targetId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE); }
  // The company check before anything else about the person: another company's person and nobody look the same.
  if (target === undefined || target.companyId !== me.companyId) throw agentXError("NOT_FOUND", MEMBER_NOT_FOUND);

  if (match[2] === "removal-preview") {
    if (target.revokedAt !== undefined) throw agentXError("NOT_FOUND", MEMBER_NOT_FOUND);
    return removalPreview(ctx, me, target);
  }
  if (targetId === caller.developerId) throw agentXError("FORBIDDEN", OWN_MEMBERSHIP);
  if (match[2] === "role") {
    const parsed = RoleBody.safeParse(body(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", ROLE_BODY);
    if ((target.role === "owner" || parsed.data.role === "owner") && me.role !== "owner") throw agentXError("FORBIDDEN", OWNER_ONLY);
    requireFreshStepUp(input.stepUp, ctx.now(), MEMBER_STEP_UP);
    unwrap(await ctx.members.setRole(caller, { companyId: me.companyId, personId: targetId, role: parsed.data.role }));
    return { ok: true };
  }
  if (!RemovalBody.safeParse(body(request)).success) throw agentXError("CONFIG_INVALID", REMOVAL_BODY);
  if (target.role === "owner" && me.role !== "owner") throw agentXError("FORBIDDEN", OWNER_ONLY);
  if (target.revokedAt !== undefined) {
    // A repeat of a removal retries a link left behind by an earlier cleanup that failed. It takes away only what a removed member still holds, so it needs no step-up.
    await dropGithubLink(ctx, me.companyId, targetId);
    throw agentXError("MEMBER_ALREADY_REMOVED", MEMBER_REVOKED);
  }
  requireFreshStepUp(input.stepUp, ctx.now(), REMOVAL_STEP_UP);
  unwrap(await ctx.members.revoke(caller, { companyId: me.companyId, personId: targetId }));
  await dropGithubLink(ctx, me.companyId, targetId);
  return { ok: true };
}

// ---- the member list

const MemberView = CompanyMember.extend({ name: z.string().optional(), email: z.string().optional() });
// A GitHub name is cut by github-profile.ts, so any stored length is read; every other person's name keeps the old 200-character limit (checked below).
const PersonRecord = z.object({ displayName: z.string().max(100_000).optional(), email: z.string().max(320).optional(), provider: z.unknown().optional(), issuer: z.unknown().optional(), subject: z.unknown().optional() });

async function listMembers(ctx: CompanyMemberRouteContext, caller: DeveloperCaller, companyId: string, url: URL) {
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if ((key !== "cursor" && key !== "limit") || key in query) throw agentXError("CONFIG_INVALID", LIST_QUERY);
    query[key] = value;
  }
  const cursor = query["cursor"] === undefined ? undefined : Cursor.safeParse(query["cursor"]);
  const limit = query["limit"] === undefined ? undefined : Limit.safeParse(query["limit"]);
  if (cursor?.success === false || limit?.success === false) throw agentXError("CONFIG_INVALID", LIST_QUERY);
  // A cursor this company's list did not give (another company's, or forged) is refused here, in the list's own words, before anything is forwarded.
  if (cursor !== undefined) { try { memberCursorPerson(companyId, cursor.data); } catch { throw agentXError("CONFIG_INVALID", LIST_QUERY); } }
  const page = unwrap(await ctx.members.list(caller, { companyId, ...(cursor === undefined ? {} : { cursor: cursor.data }), ...(limit === undefined ? {} : { limit: limit.data }) }));
  if (!("members" in page)) throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE);
  if (page.members.length > COMPANY_MEMBER_ROUTE_LIMITS.page || page.members.some((member) => member.companyId !== companyId)) throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE);
  // Names and emails for the admin screen, from each person's sign-in record (one bounded read each); a record that does not read just leaves them out.
  const members = await Promise.all(page.members.map(async (member) => {
    let person: z.infer<typeof PersonRecord> | undefined;
    try {
      const answer = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: { pk: `DEVELOPER#${member.personId}`, sk: "META" }, ConsistentRead: true })) as { Item?: unknown };
      const parsed = PersonRecord.safeParse(answer.Item);
      person = parsed.success && (parsed.data.provider === "github" || (parsed.data.displayName ?? "").length <= 200) ? parsed.data : undefined;
    } catch { throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE); }
    const name = person === undefined ? undefined : profileDisplayName(person);
    return MemberView.parse({ ...member, ...(name === undefined ? {} : { name }), ...(person?.email === undefined ? {} : { email: person.email }) });
  }));
  return { members, more: page.more, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
}

// ---- the removal preview

/** Every row under one partition and prefix, refusing the whole answer past `max` rows. */
async function rowsBounded(ctx: CompanyMemberRouteContext, pk: string, prefix: string, max: number): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ctx.documentClient.send(new QueryCommand({
      TableName: ctx.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ConsistentRead: true, Limit: max + 1 - rows.length, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: unknown; LastEvaluatedKey?: Record<string, unknown> };
    if (!Array.isArray(page.Items)) throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE);
    rows.push(...(page.Items as Array<Record<string, unknown>>));
    if (rows.length > max) throw agentXError("CONFIG_INVALID", TOO_MUCH_WORK);
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return rows;
}

/**
 * What removing the person would take from them in this company: the open tasks they own (and how many wait on their decision), the projects they administer and
 * the projects they may use. Read-only; the removal itself is T3b's revoke.
 */
async function removalPreview(ctx: CompanyMemberRouteContext, me: z.infer<typeof Membership>, target: z.infer<typeof Membership>) {
  const companyId = me.companyId, personId = target.personId;
  // DEC 254zzz80: the person's grants in THIS company (a named company's own partition, company-layout.ts); a row there naming another company is not one.
  const grantsPk = grantsPkFor(companyId, personId), named = namedCompany(companyId);
  const grants = await rowsBounded(ctx, grantsPk, "PROJECT#", COMPANY_MEMBER_ROUTE_LIMITS.projectRows);
  const administered: string[] = [], used: string[] = [];
  for (const row of grants) {
    if (typeof row["projectName"] !== "string" || row["sk"] !== `PROJECT#${row["projectName"]}`) continue;
    if (named !== undefined && (row["pk"] !== grantsPk || !ownPartitionRow(row, named))) continue;
    if (row["role"] === "administrator") administered.push(row["projectName"]);
    else if (row["role"] === "developer") used.push(row["projectName"]);
  }
  const inCompany = await ctx.projectsInCompany([...administered, ...used], companyId);
  const index = await rowsBounded(ctx, `DEVELOPER#${personId}`, "TASK#", COMPANY_MEMBER_ROUTE_LIMITS.taskRows);
  const open = index.filter((row) => row["status"] !== "CLOSED" && typeof row["taskId"] === "string");
  if (open.length > COMPANY_MEMBER_ROUTE_LIMITS.openTasks) throw agentXError("CONFIG_INVALID", TOO_MUCH_WORK);
  let openTasks = 0, awaitingTheirDecision = 0;
  for (const row of open) {
    const task = (await ctx.documentClient.send(new GetCommand({ TableName: ctx.tableName, Key: { pk: `DEVTASK#${row["taskId"] as string}`, sk: "META" }, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
    if (task === undefined || task["developerId"] !== personId || task["closedAt"] !== undefined || task["status"] === "CLOSED" || !recordInCompany(task, companyId)) continue;
    openTasks++;
    const workflow = task["workflow"] as { state?: unknown } | undefined;
    if (workflow !== undefined && workflow !== null && typeof workflow === "object" && workflow.state === "WAITING") awaitingTheirDecision++;
  }
  const ownedProjects = [...new Set(administered.filter((name) => inCompany.has(name)))].sort();
  const projectGrants = [...new Set(used.filter((name) => inCompany.has(name) && !ownedProjects.includes(name)))].sort();
  return {
    personId, role: target.role, openTasks, awaitingTheirDecision, ownedProjects, projectGrants,
    // What the caller would be refused before pressing: an owner only by an owner, never themselves.
    mayRemove: personId !== me.personId && (target.role !== "owner" || me.role === "owner"),
    stepUpRequired: true,
  };
}
