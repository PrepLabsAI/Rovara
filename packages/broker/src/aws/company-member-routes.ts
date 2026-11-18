// Lane W part 4 (plan v3.2 section 2.4; T3b's membership store, PR #707): the company administrator's routes on the deployed developer API. Cloud's admin screens call
// these AS the signed-in administrator, through a full-access sign-in client (DEC ANSWER-4: the route table gives them `full`, never a named scope).
//
//   GET  /v1/dev/company/members[?cursor=&limit=]               the company's people and roles, one page (T3b's list)
//   GET  /v1/dev/company/members/{personId}/removal-preview[?successorId=]  what removing the person would take from them and what would move to the successor
//   POST /v1/dev/company/members/{personId}/removal  { requestId, expectedRole, successorId? }  remove them (T3b's revoke) and hand what they own to the successor
//   GET  /v1/dev/company/members/handovers                      DEC 254zzz101: the hand-overs that did not finish after the membership ended (the latest removal of each person)
//   POST /v1/dev/company/members/{personId}/handover  { requestId, successorId }  finish one of them, to a successor picked now (website only)
//   PUT  /v1/dev/company/members/{personId}/role                 change their role (T3b's role-set)
//
// Rules:
//   - The company is the caller's LIVE membership (read here from the sign-in table), never a header, a query, a body or a token claim. The member writes and the list go
//     ONLY through T3b's companyMemberActionsThroughLambda, which re-reads that membership and builds the identity request itself; this module never names a request kind.
//   - A plain member, and anyone whose membership does not read, gets the same answers as the invitation routes (404 "not found" / 401 sign in again).
//   - A person of another company, a missing person and an id that does not read all answer the same "member not found".
//   - Only an owner may change or remove an owner, or make someone an owner (DEC 232e). Nobody changes their own role or removes themselves here.
//   - DEC 254zzz73: there is no step-up; a removal or a role change needs the signed-in admin's live membership and the role rules above, read now, and (DEC 254zzz91)
//     the Rovara website's own client (`webApp`): the CLI's token or an AI tool's is refused with ON_THE_WEBSITE_MESSAGE.
//   - DEC 254zzz84 (5), removal with a hand-over (company-member-handover.ts): the remover picks a successor (default: themselves), a live member of the same company.
//     The removal fences the role the remover saw and the live successor inside T3b's own transaction, then moves what the person owned (agents, chains, open tasks
//     the successor can own) in ONE transaction with the removal record and the audit record. The request id makes it idempotent: the same id finishes or repeats
//     nothing; the same id for another removal is refused. The company's last owner is never removed (T3b's witness).
//   - Bodies and queries are validated at runtime and strictly; every refusal is a fixed sentence that never echoes what was sent.
//   - Reads are bounded in total; past a bound the whole answer is refused, never a partial one.
//   - L4-GH2: a removal takes the person's GitHub link (core/people/github-links.ts) with it, in the same request, only after the removal itself succeeded. The cleanup is conditional and idempotent, never blocks
//     the removal (a failure is logged in fixed words, no cause), and a repeat of the same removal request retries it (the repeat is still answered "already removed"). Only this company's rows are read or removed.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, ON_THE_WEBSITE_MESSAGE, OrgIdSchema, agentXError, companyLog, type DocumentStore, type OrgRole } from "@agentx/contracts";
import type { AdaptedHttpRequest } from "./lambda.js";
import { Membership, membershipKey, recordInCompany } from "./company-check.js";
import { unlinkGithubAccount } from "../core/people/github-links.js";
import { profileDisplayName } from "../developer/github-profile.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { companyMemberActionsThroughLambda } from "./company-member-forwarding.js";
import {
  CompanyMember, MEMBER_CHANGED, MEMBER_LAST_OWNER, MEMBER_ONLY_OWNER, MEMBER_REVOKED, MEMBER_SUCCESSOR_INVALID, memberCursorPerson, type CompanyMemberReply,
} from "../developer/company-member-contract.js";
import {
  HANDOVER_TOO_BIG, HandOverRaced, HandOverTooBig, dropStartedRemoval, finishHandOver, finishReceipt, pendingHandOver, pendingHandOvers, planHandOver, readRemoval, sameRemoval, startRemoval,
  type HandOverContext, type MemberRemovalRecord,
} from "./company-member-handover.js";

export const MEMBER_NOT_FOUND = "member not found";
export const NOT_FOUND = "not found";
/** T3b's own words for DEC 232e; the route refuses first with the same sentence, and the store refuses again inside its transaction. */
export const OWNER_ONLY = MEMBER_ONLY_OWNER;
export const OWN_MEMBERSHIP = "you cannot change your own role or remove yourself here";
export const ROLE_BODY = "send the new role: member, admin or owner";
export const REMOVAL_BODY = "send a request id, the role the person has, and optionally who takes over";
export const PREVIEW_QUERY = "the preview takes only an optional successorId";
export const SUCCESSOR_INVALID = MEMBER_SUCCESSOR_INVALID;
export const REMOVAL_CHANGED = MEMBER_CHANGED;
export const REQUEST_REUSED = "this request id was already used for another removal; start the removal again";
export const FINISH_BODY = "send a request id and who takes over";
export const NO_PENDING_HANDOVER = "this person has no hand-over waiting to be finished";
export const HANDOVER_UNFINISHED = "the person was removed but the hand-over did not finish; try the removal again with the same request";
export const LIST_QUERY = "the list takes an optional cursor this list gave and a limit from 1 to 100";
export const TOO_MUCH_WORK = "This person has too much work to show in one preview. Hand some of it over first.";
export const MEMBERS_UNAVAILABLE = "the company's members could not be read or changed just now; try again";
const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";
const REQUEST_INVALID = "the request is not valid";

/** Total bounds for one preview: rows read per index, open tasks looked at, and the members one page names. */
// taskRows: the person's whole task index (closed tasks included), so a long-tenured person can still be previewed (DEC 254zzz84 (5) review); the 200 open-task bound is unchanged.
export const COMPANY_MEMBER_ROUTE_LIMITS = { projectRows: 500, taskRows: 5_000, openTasks: 200, page: 100 } as const;

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
  /** DEC 254zzz84 (5): Task People, as the task routes build it, so open tasks can be handed over. Absent: no task is handed over (each is counted as left). */
  taskHandOver?: HandOverContext["tasks"];
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
const MEMBER_ROUTE = /^\/v1\/dev\/company\/members\/([^/]+)\/(removal-preview|removal|role|handover)$/u;
/** DEC 254zzz101: the company's hand-overs waiting to be finished. */
const HANDOVERS = "/v1/dev/company/members/handovers";
const FinishBody = z.object({ requestId: z.uuid(), successorId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** The most pending hand-overs one answer lists; past it the whole list is refused. */
export const PENDING_HANDOVERS_MAX = 100;
const PersonId = z.string().regex(/^[a-f0-9]{64}$/);
const RoleBody = z.object({ role: z.enum(["member", "admin", "owner"]) }).strict();
const RemovalBody = z.object({ requestId: z.uuid(), expectedRole: z.enum(["member", "admin", "owner"]), successorId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const Limit = z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().int().min(1).max(COMPANY_MEMBER_ROUTE_LIMITS.page));
const Cursor = z.string().min(1).max(512);

/** Whether this module answers the path (the dispatcher sends it here before anything else is read). */
export function isCompanyMemberPath(path: string): boolean {
  return path === MEMBERS || path === HANDOVERS || MEMBER_ROUTE.test(path);
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
  if (message === MEMBER_LAST_OWNER) throw agentXError("LAST_OWNER", MEMBER_LAST_OWNER);
  if (message === MEMBER_REVOKED) throw agentXError("MEMBER_ALREADY_REMOVED", MEMBER_REVOKED);
  if (message === MEMBER_ONLY_OWNER) throw agentXError("FORBIDDEN", MEMBER_ONLY_OWNER);
  if (message === MEMBER_SUCCESSOR_INVALID) throw agentXError("SUCCESSOR_INVALID", MEMBER_SUCCESSOR_INVALID);
  if (message === MEMBER_CHANGED) throw agentXError("CHANGE_STALE", MEMBER_CHANGED);
  if (reply.error === "not_found") throw agentXError("NOT_FOUND", MEMBER_NOT_FOUND);
  if (reply.error === "invalid_request") throw agentXError("CONFIG_INVALID", REQUEST_INVALID);
  throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE);
}

/**
 * Company admin routes. The caller is already authenticated and its route row (`full`) applied; `companyId` is the company its live membership names (resolveCompany).
 * The membership is read again here, so a role or company that changed since is what counts.
 */
export async function routeCompanyMembers(ctx: CompanyMemberRouteContext, input: { caller: DeveloperCaller; companyId: string; webApp?: boolean }, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const { caller, companyId } = input;
  let me: z.infer<typeof Membership> | undefined;
  try { me = await membershipOf(ctx, caller.developerId); } catch { me = undefined; }
  if (me === undefined || me.companyId !== companyId || me.revokedAt !== undefined || !OrgIdSchema.safeParse(companyId).success) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (!isAdmin(me.role)) throw agentXError("NOT_FOUND", NOT_FOUND);

  if (url.pathname === MEMBERS) {
    if (request.method !== "GET") throw agentXError("NOT_FOUND", NOT_FOUND);
    return listMembers(ctx, caller, me.companyId, url);
  }
  if (url.pathname === HANDOVERS) {
    if (request.method !== "GET" || [...url.searchParams.keys()].length > 0) throw agentXError("NOT_FOUND", NOT_FOUND);
    return listPendingHandOvers(ctx, me.companyId);
  }

  const match = MEMBER_ROUTE.exec(url.pathname);
  const method = match === null ? undefined : match[2] === "role" ? "PUT" : match[2] === "removal" || match[2] === "handover" ? "POST" : "GET";
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
    const query = [...url.searchParams.entries()];
    if (query.some(([key]) => key !== "successorId") || query.length > 1) throw agentXError("CONFIG_INVALID", PREVIEW_QUERY);
    return removalPreview(ctx, me, target, query[0]?.[1] ?? me.personId);
  }
  if (targetId === caller.developerId) throw agentXError("FORBIDDEN", OWN_MEMBERSHIP);
  // Owner DEC 254zzz91: a role change or a removal is made only from the Rovara website's own client (never the CLI's or an AI tool's token); reads and the preview are not.
  if (input.webApp !== true) throw agentXError("FORBIDDEN", ON_THE_WEBSITE_MESSAGE);
  if (match[2] === "handover") {
    const parsed = FinishBody.safeParse(body(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", FINISH_BODY);
    return finishStuckHandOver(ctx, me, target, { requestId: parsed.data.requestId.toLowerCase(), successorId: parsed.data.successorId });
  }
  if (match[2] === "role") {
    const parsed = RoleBody.safeParse(body(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", ROLE_BODY);
    if ((target.role === "owner" || parsed.data.role === "owner") && me.role !== "owner") throw agentXError("FORBIDDEN", OWNER_ONLY);
    unwrap(await ctx.members.setRole(caller, { companyId: me.companyId, personId: targetId, role: parsed.data.role }));
    return { ok: true };
  }
  const removal = RemovalBody.safeParse(body(request));
  if (!removal.success) throw agentXError("CONFIG_INVALID", REMOVAL_BODY);
  if ((target.role === "owner" || removal.data.expectedRole === "owner") && me.role !== "owner") throw agentXError("FORBIDDEN", OWNER_ONLY);
  return removeWithHandOver(ctx, caller, me, target, { removalId: removal.data.requestId.toLowerCase(), expectedRole: removal.data.expectedRole, successorId: removal.data.successorId ?? me.personId });
}

// ---- removal with a hand-over (DEC 254zzz84 (5))

const handOverContext = (ctx: CompanyMemberRouteContext): HandOverContext => ({
  documentClient: ctx.documentClient, tableName: ctx.tableName, now: ctx.now, ...(ctx.taskHandOver === undefined ? {} : { tasks: ctx.taskHandOver }),
});

/** The successor as the remover named them: a live member of the same company, never the person removed. Any refusal is the one fixed sentence. */
async function liveSuccessor(ctx: CompanyMemberRouteContext, companyId: string, successorId: string, leaverId: string): Promise<z.infer<typeof Membership>> {
  if (!PersonId.safeParse(successorId).success || successorId === leaverId) throw agentXError("SUCCESSOR_INVALID", MEMBER_SUCCESSOR_INVALID);
  let successor: z.infer<typeof Membership> | undefined;
  try { successor = await membershipOf(ctx, successorId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE); }
  if (successor === undefined || successor.companyId !== companyId || successor.revokedAt !== undefined) throw agentXError("SUCCESSOR_INVALID", MEMBER_SUCCESSOR_INVALID);
  return successor;
}

/** How long a STARTED record may still END a membership (the screen's retry of an unknown outcome); after that the remover starts again. */
export const REMOVAL_RETRY_MS = 15 * 60_000;
/** Clock difference allowed between this broker and the sign-in function when telling whether a revoke was this removal's. */
const CLOCK_SKEW_MS = 60_000;

/** A finished removal's answer: who the hand-over went to (the successor named, or the one an owner or admin finished it to, DEC 254zzz101). */
const done = (record: MemberRemovalRecord, moved: NonNullable<MemberRemovalRecord["moved"]>) => ({ removalId: record.removalId, state: "DONE" as const, successorId: record.handedTo ?? record.successorId, moved });

/**
 * Remove the person and hand over what they own. Order: the record (STARTED) once per request id; T3b's revoke with the fences (role seen, live successor, last
 * owner); the GitHub link; then ONE transaction that moves everything, finishes the record and writes the audit. A repeat with the same request id resumes from
 * where the first stopped (the membership already ended by THIS removal: only the hand-over is finished), and answers DONE once it is done.
 */
async function removeWithHandOver(ctx: CompanyMemberRouteContext, caller: DeveloperCaller, me: z.infer<typeof Membership>, target: z.infer<typeof Membership>,
  request: { removalId: string; expectedRole: OrgRole; successorId: string }) {
  const handOver = handOverContext(ctx);
  const companyId = me.companyId, leaverId = target.personId;
  const asked = { leaverId, successorId: request.successorId, expectedRole: request.expectedRole, by: me.personId };
  if (request.successorId === leaverId) throw agentXError("SUCCESSOR_INVALID", MEMBER_SUCCESSOR_INVALID);
  let record: MemberRemovalRecord | undefined;
  try { record = await readRemoval(handOver, companyId, request.removalId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE); }
  if (record !== undefined && !sameRemoval(record, asked)) throw agentXError("IDEMPOTENCY_CONFLICT", REQUEST_REUSED);
  if (record?.state === "DONE" && record.moved !== undefined) return done(record, record.moved);
  if (target.revokedAt !== undefined) {
    // Ended before this request began, or by anyone but this removal's remover: "already removed", as before. A repeat retries a GitHub link a failed cleanup
    // left behind. Only the membership THIS removal ended (its remover, after it started) has its hand-over finished here.
    if (record === undefined || target.revokedBy !== record.by || Date.parse(target.revokedAt) < Date.parse(record.startedAt) - CLOCK_SKEW_MS) {
      await dropGithubLink(ctx, companyId, leaverId);
      throw agentXError("MEMBER_ALREADY_REMOVED", MEMBER_REVOKED);
    }
  } else {
    if (target.role !== request.expectedRole) throw agentXError("CHANGE_STALE", MEMBER_CHANGED);
    // A STARTED record ends a live membership only as the screen's prompt retry: an old one (a person restored or rejoined since) never does.
    if (record !== undefined && ctx.now() - Date.parse(record.startedAt) > REMOVAL_RETRY_MS) throw agentXError("IDEMPOTENCY_CONFLICT", REQUEST_REUSED);
    await liveSuccessor(ctx, companyId, request.successorId, leaverId);
    if (record === undefined) {
      // Too much to hand over in one transaction is refused BEFORE anyone is removed.
      try { await planHandOver(handOver, { companyId, ...asked, removalId: request.removalId, commit: false }); }
      catch (error) { throw error instanceof HandOverTooBig ? agentXError("CONFIG_INVALID", HANDOVER_TOO_BIG) : agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE); }
      try { record = await startRemoval(handOver, { companyId, removalId: request.removalId, ...asked }); } catch { throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE); }
      // Two first attempts with one request id: the one that lost reads the winner's record.
      if (!sameRemoval(record, asked)) throw agentXError("IDEMPOTENCY_CONFLICT", REQUEST_REUSED);
      if (record.state === "DONE" && record.moved !== undefined) return done(record, record.moved);
    }
    const revoked = await ctx.members.revoke(caller, { companyId, personId: leaverId, expectedRole: request.expectedRole, successorId: request.successorId });
    // A refused removal leaves no STARTED record that could end the membership later.
    if (!revoked.ok && revoked.error !== "unavailable") await dropStartedRemoval(handOver, record);
    else if (!revoked.ok && "message" in revoked) await dropStartedRemoval(handOver, record);
    unwrap(revoked);
    await dropGithubLink(ctx, companyId, leaverId);
  }
  if (record === undefined) throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE);
  // The successor was live when the membership ended (T3b's fence); they must still be when what was theirs moves.
  await liveSuccessor(ctx, companyId, request.successorId, leaverId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const plan = await planHandOver(handOver, { companyId, ...asked, removalId: request.removalId, commit: true });
      return done(record, await finishHandOver(handOver, record, plan));
    } catch (error) {
      if (error instanceof HandOverRaced) {
        // Another attempt with this request id may have finished it.
        const now = await readRemoval(handOver, companyId, request.removalId).catch(() => undefined);
        if (now?.state === "DONE" && now.moved !== undefined && sameRemoval(now, asked)) return done(now, now.moved);
        continue;
      }
      if (error instanceof HandOverTooBig) throw agentXError("CONFIG_INVALID", HANDOVER_TOO_BIG);
      break;
    }
  }
  // The membership has ended; only the hand-over is left. The same request id finishes it.
  throw agentXError("RUNTIME_UNAVAILABLE", HANDOVER_UNFINISHED);
}

// ---- finishing a stuck hand-over (DEC 254zzz101)

/** The company's hand-overs waiting to be finished: the person, their name, when the removal started, who removed them and who was to take over. */
async function listPendingHandOvers(ctx: CompanyMemberRouteContext, companyId: string) {
  let pending: MemberRemovalRecord[];
  try { pending = await pendingHandOvers(handOverContext(ctx), companyId, PENDING_HANDOVERS_MAX); } catch { throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE); }
  const handovers = await Promise.all(pending.map(async (record) => {
    const name = await personName(ctx, record.leaverId);
    return { personId: record.leaverId, ...(name === undefined ? {} : { name }), removalId: record.removalId, startedAt: record.startedAt, removedBy: record.by, successorId: record.successorId };
  }));
  return { handovers };
}

/**
 * An owner or admin finishes a hand-over that stopped after the membership ended (for example, the successor left in between): what the removed person still owns
 * moves to a successor picked now, in the same one transaction as a removal's (record DONE, audit record, the pending row gone, this request's receipt). The person
 * must already be removed and have a pending hand-over; an owner's hand-over is finished only by an owner. The request id makes it idempotent.
 */
async function finishStuckHandOver(ctx: CompanyMemberRouteContext, me: z.infer<typeof Membership>, target: z.infer<typeof Membership>, request: { requestId: string; successorId: string }) {
  const handOver = handOverContext(ctx);
  const companyId = me.companyId, leaverId = target.personId;
  const finished = async (): Promise<ReturnType<typeof done> | undefined> => {
    const receipt = await finishReceipt(handOver, companyId, request.requestId);
    if (receipt === undefined) return undefined;
    if (receipt.leaverId !== leaverId || receipt.by !== me.personId || receipt.successorId !== request.successorId) throw agentXError("IDEMPOTENCY_CONFLICT", REQUEST_REUSED);
    const record = await readRemoval(handOver, companyId, receipt.removalId);
    if (record?.state !== "DONE" || record.moved === undefined) throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE);
    return done(record, record.moved);
  };
  let replay: ReturnType<typeof done> | undefined;
  try { replay = await finished(); } catch (error) { if (error instanceof AgentXError) throw error; throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE); }
  if (replay !== undefined) return replay;
  if (target.revokedAt === undefined) throw agentXError("NOT_FOUND", NO_PENDING_HANDOVER);
  let record: MemberRemovalRecord | undefined;
  try { record = await pendingHandOver(handOver, companyId, leaverId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE); }
  if (record === undefined) throw agentXError("NOT_FOUND", NO_PENDING_HANDOVER);
  if (record.expectedRole === "owner" && me.role !== "owner") throw agentXError("FORBIDDEN", OWNER_ONLY);
  await liveSuccessor(ctx, companyId, request.successorId, leaverId);
  const takeover = { successorId: request.successorId, by: me.personId, requestId: request.requestId };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const plan = await planHandOver(handOver, { companyId, leaverId, successorId: request.successorId, by: me.personId, removalId: record.removalId, commit: true });
      const moved = await finishHandOver(handOver, record, plan, takeover);
      return done({ ...record, handedTo: request.successorId }, moved);
    } catch (error) {
      if (error instanceof HandOverRaced) {
        const now = await finished().catch(() => undefined);
        if (now !== undefined) return now;
        continue;
      }
      if (error instanceof HandOverTooBig) throw agentXError("CONFIG_INVALID", HANDOVER_TOO_BIG);
      break;
    }
  }
  throw agentXError("RUNTIME_UNAVAILABLE", HANDOVER_UNFINISHED);
}

// ---- the member list

const MemberView = CompanyMember.extend({ name: z.string().optional(), email: z.string().optional() });
// A GitHub name is cut by github-profile.ts, so any stored length is read; every other person's name keeps the old 200-character limit (checked below).
const PersonRecord = z.object({ displayName: z.string().max(100_000).optional(), email: z.string().max(320).optional(), provider: z.unknown().optional(), issuer: z.unknown().optional(), subject: z.unknown().optional() });

/** A person's shown name from their sign-in record (as the member list shows it), or undefined when it does not read. */
async function personName(ctx: CompanyMemberRouteContext, personId: string): Promise<string | undefined> {
  try {
    const answer = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: { pk: `DEVELOPER#${personId}`, sk: "META" }, ConsistentRead: true })) as { Item?: unknown };
    const parsed = PersonRecord.safeParse(answer.Item);
    return parsed.success && (parsed.data.provider === "github" || (parsed.data.displayName ?? "").length <= 200) ? profileDisplayName(parsed.data) : undefined;
  } catch { return undefined; }
}

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
async function removalPreview(ctx: CompanyMemberRouteContext, me: z.infer<typeof Membership>, target: z.infer<typeof Membership>, successorId: string) {
  const companyId = me.companyId, personId = target.personId;
  // Nobody removes themselves here, so there is nothing to preview for them.
  if (personId === me.personId) throw agentXError("FORBIDDEN", OWN_MEMBERSHIP);
  await liveSuccessor(ctx, companyId, successorId, personId);
  const grants = await rowsBounded(ctx, `MEMBER#${personId}`, "PROJECT#", COMPANY_MEMBER_ROUTE_LIMITS.projectRows);
  const administered: string[] = [], used: string[] = [];
  for (const row of grants) {
    if (typeof row["projectName"] !== "string" || row["sk"] !== `PROJECT#${row["projectName"]}`) continue;
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
  let handOver: Awaited<ReturnType<typeof planHandOver>>;
  try { handOver = await planHandOver(handOverContext(ctx), { companyId, leaverId: personId, successorId, by: me.personId, removalId: "00000000-0000-4000-8000-000000000000", commit: false }); }
  catch (error) { throw error instanceof HandOverTooBig ? agentXError("CONFIG_INVALID", TOO_MUCH_WORK) : agentXError("RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE); }
  const [name, successorName] = await Promise.all([personName(ctx, personId), personName(ctx, successorId)]);
  return {
    personId, role: target.role, ...(name === undefined ? {} : { name }), openTasks, awaitingTheirDecision, ownedProjects, projectGrants,
    successor: { personId: successorId, ...(successorName === undefined ? {} : { name: successorName }) },
    handOver: { agents: handOver.agents, chains: handOver.chains, projects: handOver.projects, tasks: handOver.tasks, tasksLeft: handOver.tasksLeft },
    // What the caller would be refused before pressing: an owner only by an owner, never themselves.
    mayRemove: personId !== me.personId && (target.role !== "owner" || me.role === "owner"),
  };
}
