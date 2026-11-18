// Shared member reply validation; importing this never exposes operator dispatch or writes.
import { z } from "zod";
import { OrgIdSchema } from "@agentx/contracts";
import { Membership } from "../aws/company-check.js";

export const MemberPersonId = z.string().regex(/^[a-f0-9]{64}$/);
export const CompanyMember = Membership.extend({
  personId: MemberPersonId,
  revokedBy: z.union([z.literal("operator"), MemberPersonId]).optional(),
  updatedAt: z.iso.datetime().optional(),
  updatedBy: z.union([z.literal("operator"), MemberPersonId]).optional(),
});
export const MEMBER_STEP_UP = "this role change needs a fresh sign-in check; sign in again and retry";
export const MEMBER_LAST_OWNER = "a company must keep at least one active owner";
export const MEMBER_ONLY_OWNER = "only an owner can change or remove an owner";
export const MEMBER_REVOKED = "restore this member before changing their role";
/** DEC 254zzz84 (5): a removal's successor is no longer a live member of the company (checked inside the removal's own transaction). */
export const MEMBER_SUCCESSOR_INVALID = "pick someone who is still in the company to take over";
/** DEC 254zzz84 (5): the person's role is not the one the remover saw (`expectedRole`), checked inside the removal's own transaction. */
export const MEMBER_CHANGED = "this person's role changed; review the removal again";
export const MemberFailure = z.union([
  z.object({ ok: z.literal(false), error: z.enum(["invalid_request", "unavailable", "not_found"]) }).strict(),
  z.object({ ok: z.literal(false), error: z.literal("step_up_required"), message: z.literal(MEMBER_STEP_UP) }).strict(),
  z.object({ ok: z.literal(false), error: z.literal("unavailable"), message: z.enum([MEMBER_LAST_OWNER, MEMBER_REVOKED, MEMBER_ONLY_OWNER, MEMBER_SUCCESSOR_INVALID, MEMBER_CHANGED]) }).strict(),
]);
export class CompanyMemberRefusal extends Error {
  constructor(readonly response: z.infer<typeof MemberFailure>) { super("company member request refused"); }
}
const CursorData = z.object({ v: z.literal(1), companyId: OrgIdSchema, personId: MemberPersonId }).strict();
export const MemberCursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
export const MemberListInput = z.object({ companyId: OrgIdSchema, cursor: MemberCursor.optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
export function memberCursor(companyId: string, personId: string): string {
  return Buffer.from(JSON.stringify(CursorData.parse({ v: 1, companyId, personId }))).toString("base64url");
}
export function memberCursorPerson(companyId: string, cursor: string): string {
  try {
    const encoded = MemberCursor.parse(cursor);
    const data = CursorData.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (data.companyId !== companyId || memberCursor(data.companyId, data.personId) !== cursor) throw new Error("invalid cursor");
    return data.personId;
  } catch { throw new CompanyMemberRefusal({ ok: false, error: "invalid_request" }); }
}
export const MemberList = z.object({ members: z.array(CompanyMember).max(100), more: z.boolean(), cursor: MemberCursor.optional() }).strict()
  .refine((page) => page.more === (page.cursor !== undefined));
export const MemberReply = z.union([z.object({ ok: z.literal(true) }).strict(), MemberList.safeExtend({ ok: z.literal(true) }), MemberFailure]);
export type CompanyMemberReply = z.infer<typeof MemberReply>;
