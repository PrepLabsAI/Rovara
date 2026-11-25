// Lane W calls this only AFTER authenticating a web person and applying route scopes.
// It deliberately exposes no operator dispatch or unchecked member transport.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { OrgIdSchema, OrgRoleSchema } from "@agentx/contracts";
import { membershipKey } from "./company-check.js";
import type { ChannelMembersInvokeResult, DeveloperCaller } from "./developer-routes.js";
import { CompanyMember, MemberListInput, MemberPersonId, MemberReply, memberCursorPerson, type CompanyMemberReply } from "../developer/company-member-contract.js";
import { failedReadOr, readingMembership } from "../core/membership-read.js";

const Request = z.discriminatedUnion("kind", [
  // DEC 254zzz84 (5): the removal's fences (the role the remover saw, the live successor); the identity side checks both inside its transaction.
  z.object({ kind: z.literal("company-member-revoke"), companyId: OrgIdSchema, personId: MemberPersonId, expectedRole: OrgRoleSchema.optional(), successorId: MemberPersonId.optional() }).strict(),
  z.object({ kind: z.literal("company-member-role-set"), companyId: OrgIdSchema, personId: MemberPersonId, role: OrgRoleSchema }).strict(),
  MemberListInput.extend({ kind: z.literal("company-member-list") }).strict(),
]);
const Caller = z.object({ developerId: MemberPersonId, sessionId: z.string().min(1).max(256), amr: z.enum(["oidc", "slack", "github"]), name: z.string(), slackUserId: z.string().optional(), email: z.string().optional(), clientId: z.string().optional(), authTime: z.number().int().positive().optional() }).strict();
export function companyMembersThroughLambda(deps: {
  documentClient: { send(command: unknown): Promise<unknown> }; tableName: string;
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>;
}): (caller: DeveloperCaller, request: unknown) => Promise<CompanyMemberReply> {
  return async (caller, request) => {
    const input = Request.safeParse(request);
    if (!input.success) return { ok: false, error: "invalid_request" };
    const authenticated = Caller.safeParse(caller);
    if (!authenticated.success) return { ok: false, error: "not_found" };
    let member: z.infer<typeof CompanyMember>;
    try {
      const response = await readingMembership(() => deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: membershipKey(authenticated.data.developerId), ConsistentRead: true }))) as { Item?: unknown };
      if (Buffer.byteLength(JSON.stringify(response)) > 409_600) return { ok: false, error: "not_found" };
      member = CompanyMember.parse(response.Item);
      if (member.personId !== authenticated.data.developerId || member.companyId !== input.data.companyId || member.revokedAt !== undefined || (member.role !== "admin" && member.role !== "owner")) return { ok: false, error: "not_found" };
    } catch (error) {
      // A membership read that FAILED is not "not a member": the caller's route answers the retryable 503 (membership-read.ts); a row that reads and refuses is the "not_found" it always was.
      return failedReadOr<CompanyMemberReply>(error, { ok: false, error: "not_found" }, { ok: false, error: "unavailable" });
    }
    try {
      // Only validated payload fields cross the boundary. Both authority fields come
      // from the live membership, never from caller claims or the requested company.
      const forwarded = { ...input.data, companyId: member.companyId,
        ...(input.data.kind === "company-member-list" ? {} : { createdBy: member.personId }),
      };
      // An actorless write would be an operator invoke. Refuse before transport.
      if ("personId" in input.data && !MemberPersonId.safeParse(forwarded.createdBy).success) return { ok: false, error: "unavailable" };
      if (input.data.kind === "company-member-list" && input.data.cursor !== undefined) {
        try { memberCursorPerson(member.companyId, input.data.cursor); }
        catch { return { ok: false, error: "invalid_request" }; }
      }
      const answer = await deps.invoke(Buffer.from(JSON.stringify(forwarded)));
      if (answer.FunctionError !== undefined || answer.Payload === undefined || answer.Payload.byteLength > 1_100_000) return { ok: false, error: "unavailable" };
      const parsed = MemberReply.safeParse(JSON.parse(Buffer.from(answer.Payload).toString("utf8")));
      if (!parsed.success) return { ok: false, error: "unavailable" };
      const reply = parsed.data;
      if (reply.ok) {
        if (input.data.kind === "company-member-list") {
          if (!("members" in reply) || reply.members.length > (input.data.limit ?? 100) || reply.members.some((row) => row.companyId !== member.companyId)) return { ok: false, error: "unavailable" };
          if (reply.cursor !== undefined) memberCursorPerson(member.companyId, reply.cursor);
        } else if ("members" in reply) return { ok: false, error: "unavailable" };
      }
      return reply;
    } catch { return { ok: false, error: "unavailable" }; }
  };
}

/** Lane W chooses a method; only this module constructs the corresponding kind. */
export function companyMemberActionsThroughLambda(deps: Parameters<typeof companyMembersThroughLambda>[0]) {
  const forward = companyMembersThroughLambda(deps);
  const action = (schema: z.ZodObject, kind: z.infer<typeof Request>["kind"]) => async (caller: DeveloperCaller, request: unknown): Promise<CompanyMemberReply> => {
    const parsed = schema.safeParse(request);
    return parsed.success ? forward(caller, { ...parsed.data, kind }) : { ok: false, error: "invalid_request" };
  };
  return {
    revoke: action(Request.options[0].omit({ kind: true }), "company-member-revoke"),
    setRole: action(Request.options[1].omit({ kind: true }), "company-member-role-set"),
    list: action(Request.options[2].omit({ kind: true }), "company-member-list"),
  };
}
