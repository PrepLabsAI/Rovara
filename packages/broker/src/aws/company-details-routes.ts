// #1613: the caller's own company on the deployed developer API (contracts company-details.ts), for `rovara company show` and `rovara company rename`.
//
//   GET /v1/dev/company/details   any member of the company       -> { companyId, name, role, members[, membersAtLeast] }
//   PUT /v1/dev/company/details   owner or admin of the company   { name } -> the same view, with the new name
//
// Rules:
//   - The company and role are the caller's LIVE membership (sign-in table), read at every call; never a body, query, header or token claim. Full access only (the route table's row).
//   - A person with no membership, a removed one, or one still in the built-in company is told they are not in a company (FORBIDDEN, NOT_IN_A_COMPANY_MESSAGE), never "sign in again":
//     signing in again would not change it. A membership row that does not read refuses with the sign-in words (fail closed); a read that FAILED is the retryable 503.
//   - The rename is written by the sign-in service (`company-rename`, handled by the sign-in Lambda), which checks the person's live role again inside the same write and records it in the
//     company's log (who and when). The broker has no write on the company record. Every place that shows the name reads the record, so it shows the new name at once.
//   - Every refusal is fixed words: no name, company id or cause is echoed. Log lines carry the event and opaque ids only.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { CompanyRenameBodySchema, IMPLICIT_COMPANY_ID, NOT_IN_A_COMPANY_MESSAGE, OrgIdSchema, agentXError, companyLog, companyScoped, type CompanyDetailsView } from "@agentx/contracts";
import { Membership, membershipKey } from "./company-check.js";
import type { ChannelMembersInvokeResult, DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { CompanyRecord, companyKey } from "../developer/company-membership.js";
import { readingMembership } from "../core/membership-read.js";

export const COMPANY_RENAME_ADMIN_ONLY = "Only a company owner or admin can rename the company.";
export const COMPANY_RENAME_BODY_INVALID = "Send the company's new name, 1 to 80 characters with no control characters, as { \"name\": \"<name>\" }.";
export const COMPANY_DETAILS_UNAVAILABLE = "The company's details could not be read or saved just now; try again.";
const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";
/** The member count reads at most this many pages of member rows; past them the count is a lower bound. */
const MEMBER_PAGES = 10;
const MEMBER_PAGE = 1_000;

/** The sign-in service's rename, as the broker forwards it (companyRenameThroughLambda). */
export type CompanyRename = (input: { companyId: string; name: string; createdBy: string }) => Promise<{ ok: true } | { ok: false; error: "not_found" | "unavailable" }>;

export interface CompanyDetailsContext {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The sign-in table (memberships, the company record and its member rows). */
  signInTableName: string;
  /** Absent: a rename is refused as unavailable. */
  rename?: CompanyRename;
  /** The broker's log sink; every line goes through companyLog. */
  log: (entry: Record<string, unknown>) => void;
}

export function isCompanyDetailsPath(path: string): boolean {
  return path === "/v1/dev/company/details";
}

async function liveMembership(ctx: CompanyDetailsContext, caller: DeveloperCaller): Promise<z.infer<typeof Membership>> {
  const response = await readingMembership(() => ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(caller.developerId), ConsistentRead: true }))) as { Item?: unknown };
  if (response.Item === undefined) throw agentXError("FORBIDDEN", NOT_IN_A_COMPANY_MESSAGE);
  const member = Membership.safeParse(response.Item);
  if (!member.success || member.data.personId !== caller.developerId || !OrgIdSchema.safeParse(member.data.companyId).success) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (member.data.revokedAt !== undefined || member.data.companyId === IMPLICIT_COMPANY_ID) throw agentXError("FORBIDDEN", NOT_IN_A_COMPANY_MESSAGE);
  return member.data;
}

/** The company's stored name; null where it has no record. A record that does not read, or names another company, is refused. */
async function companyName(ctx: CompanyDetailsContext, companyId: string): Promise<string | null> {
  const key = companyKey(companyId);
  const stored = (await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  if (stored === undefined) return null;
  const record = CompanyRecord.safeParse(stored);
  if (!record.success || record.data.companyId !== companyId || stored["pk"] !== key.pk || stored["sk"] !== key.sk) throw new Error("company record");
  return record.data.name;
}

/** The people in the company now: its member rows without an end, read a bounded number of pages. */
async function memberCount(ctx: CompanyDetailsContext, companyId: string): Promise<{ members: number; membersAtLeast?: true }> {
  const pk = companyScoped(companyId, "MEMBERS");
  let members = 0, after: Record<string, unknown> | undefined;
  for (let page = 0; page < MEMBER_PAGES; page++) {
    const answer = await ctx.documentClient.send(new QueryCommand({ TableName: ctx.signInTableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk },
      ProjectionExpression: "pk, sk, revokedAt", ConsistentRead: true, Limit: MEMBER_PAGE, ...(after === undefined ? {} : { ExclusiveStartKey: after }) })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    if (!Array.isArray(answer.Items)) throw new Error("member rows");
    members += answer.Items.filter((row) => row["pk"] === pk && typeof row["sk"] === "string" && row["sk"].startsWith("MEMBER#") && row["revokedAt"] === undefined).length;
    if (answer.LastEvaluatedKey === undefined) return { members };
    after = answer.LastEvaluatedKey;
  }
  return { members, membersAtLeast: true };
}

async function viewOf(ctx: CompanyDetailsContext, member: z.infer<typeof Membership>): Promise<CompanyDetailsView> {
  try {
    const [name, count] = await Promise.all([companyName(ctx, member.companyId), memberCount(ctx, member.companyId)]);
    return { companyId: member.companyId, name, role: member.role, ...count };
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", COMPANY_DETAILS_UNAVAILABLE); }
}

function bodyOf(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return undefined;
  try { return JSON.parse(request.body) as unknown; } catch { return undefined; }
}

export async function routeCompanyDetails(ctx: CompanyDetailsContext, caller: DeveloperCaller, request: AdaptedHttpRequest): Promise<CompanyDetailsView> {
  if (request.method !== "GET" && request.method !== "PUT") throw agentXError("NOT_FOUND", "not found");
  const member = await liveMembership(ctx, caller);
  if (request.method === "GET") return await viewOf(ctx, member);

  // PUT: the live role first, then the body; the sign-in service checks the role again inside its write.
  if (member.role !== "owner" && member.role !== "admin") throw agentXError("FORBIDDEN", COMPANY_RENAME_ADMIN_ONLY);
  const body = CompanyRenameBodySchema.safeParse(bodyOf(request));
  if (!body.success) throw agentXError("CONFIG_INVALID", COMPANY_RENAME_BODY_INVALID);
  if (ctx.rename === undefined) throw agentXError("RUNTIME_UNAVAILABLE", COMPANY_DETAILS_UNAVAILABLE);
  let answer: Awaited<ReturnType<CompanyRename>>;
  try { answer = await ctx.rename({ companyId: member.companyId, name: body.data.name, createdBy: member.personId }); } catch { answer = { ok: false, error: "unavailable" }; }
  if (!answer.ok) throw agentXError("RUNTIME_UNAVAILABLE", COMPANY_DETAILS_UNAVAILABLE);
  companyLog(member.companyId, ctx.log)({ event: "company.renamed", actor: caller.developerId });
  return await viewOf(ctx, member);
}

const RenameReply = z.union([z.object({ ok: z.literal(true) }).passthrough(), z.object({ ok: z.literal(false), error: z.string() }).passthrough()]);

/** #1613: the rename, forwarded to the sign-in service. Only the fields built here cross: the company and the actor come from the route's live membership read. */
export function companyRenameThroughLambda(deps: { invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult> }): CompanyRename {
  return async (input) => {
    const answer = await deps.invoke(Buffer.from(JSON.stringify({ kind: "company-rename", companyId: input.companyId, name: input.name, createdBy: input.createdBy })));
    if (answer.FunctionError !== undefined || answer.Payload === undefined || answer.Payload.byteLength > 65_536) return { ok: false, error: "unavailable" };
    const reply = RenameReply.safeParse(JSON.parse(Buffer.from(answer.Payload).toString("utf8")));
    if (!reply.success) return { ok: false, error: "unavailable" };
    return reply.data.ok ? { ok: true } : { ok: false, error: reply.data.error === "not_found" ? "not_found" : "unavailable" };
  };
}
