// DEC 254a: operator invite codes gate self-serve company creation (DEC 253z). A code is shown once, where it is made
// (the operator's CLI), and only its SHA-256 ever leaves that process: the change, the sign-in table, the list and every log
// carry the hash or its short id, never the code.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/** A fixed prefix, so a leaked code is recognisable (secret scanners, logs, chat). */
export const COMPANY_INVITE_CODE_PREFIX = "rvinv_";
/** 24 random bytes: 192 bits, URL-safe. */
const CODE_BYTES = 24;
export const CompanyInviteCodeHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** The opaque id an operator lists and revokes by: the first 16 hex characters of the hash. */
export const CompanyInviteCodeIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const CompanyInviteExpiryHoursSchema = z.number().int().min(1).max(720);
/** The longest code the create route reads; anything longer is the same uniform refusal. */
export const COMPANY_INVITE_CODE_MAX = 128;

export function companyInviteCodeHash(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}
export const companyInviteCodeId = (hash: string): string => CompanyInviteCodeHashSchema.parse(hash).slice(0, 16);
/** A new code, its hash and its id. Only the caller that made it ever holds the code. */
export function newCompanyInviteCode(): { code: string; codeHash: string; codeId: string } {
  const code = `${COMPANY_INVITE_CODE_PREFIX}${randomBytes(CODE_BYTES).toString("base64url")}`;
  const codeHash = companyInviteCodeHash(code);
  return { code, codeHash, codeId: companyInviteCodeId(codeHash) };
}

/** What an operator's list shows for one code: never the code, never the full hash. */
export const CompanyInviteViewSchema = z.object({
  codeId: CompanyInviteCodeIdSchema,
  status: z.enum(["live", "used", "revoked", "expired"]),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  usedAt: z.iso.datetime().optional(),
  revokedAt: z.iso.datetime().optional(),
}).strict();
export type CompanyInviteView = z.infer<typeof CompanyInviteViewSchema>;
export const CompanyInviteListSchema = z.object({ invites: z.array(CompanyInviteViewSchema).max(100), more: z.boolean(), selfServe: z.enum(["open", "closed"]) }).strict();
export type CompanyInviteList = z.infer<typeof CompanyInviteListSchema>;

/** A self-serve company's name: trimmed, NFC, 1 to 80 characters, no control or invisible formatting characters (bidirectional overrides included). */
export const CompanySelfServeNameSchema = z.string().trim().min(1).max(80).refine((name) => name === name.normalize("NFC") && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(name), "no control or formatting characters");
/** `POST /v1/dev/company`: the person's new company's name and an operator's invite code. */
export const CompanySelfCreateBodySchema = z.object({ name: CompanySelfServeNameSchema, inviteCode: z.unknown().optional() }).strict();
export const CompanySelfCreateResponseSchema = z.object({ companyId: z.string(), companyName: z.string().min(1).max(80), companyRole: z.literal("owner") }).strict();
export type CompanySelfCreateResponse = z.infer<typeof CompanySelfCreateResponseSchema>;

/** The fixed answers of `POST /v1/dev/company`. Never anything the request carried. */
export const COMPANY_SELF_CREATE_TEXT = {
  /** 403, for every code problem (unknown, used, revoked, expired, malformed) and while self-serve is closed. */
  refused: "This invite code can't be used. Ask the Rovara team for a new one.",
  /** 409, for a person with a company membership, live or ended. */
  alreadyMember: "You're already in a company.",
  /** 429. */
  rateLimited: "Too many tries. Wait an hour and try again.",
  /** 400. */
  badName: "Give your company a name of 1 to 80 characters.",
} as const;

/**
 * DEC 254h: an invite link's single-use secret. The broker makes one with each company pre-approval and answers it ONCE; only its SHA-256 is
 * stored (in the company's own partition, bound to that pre-approval). Sign-in spends it, whatever the sign-in method, in the one transaction
 * that writes the membership. A fixed prefix, so a leaked one is recognisable.
 */
export const COMPANY_INVITE_LINK_PREFIX = "rvlink_";
/** The longest `invite=` value sign-in reads; a longer one is refused before anything is stored. */
export const COMPANY_INVITE_LINK_MAX = 256;
/** A new link secret (24 random bytes: 192 bits, URL-safe) and its hash. Only the caller that made it ever holds the secret. */
export function newCompanyInviteLink(): { secret: string; secretHash: string } {
  const secret = `${COMPANY_INVITE_LINK_PREFIX}${randomBytes(CODE_BYTES).toString("base64url")}`;
  return { secret, secretHash: companyInviteCodeHash(secret) };
}
/** `POST /v1/dev/company/preapprovals`'s answer: the link secret, shown once, and when it (and its pre-approval) ends. */
export const CompanyPreapprovalCreatedSchema = z.object({ ok: z.literal(true), invite: z.object({ secret: z.string().startsWith(COMPANY_INVITE_LINK_PREFIX), expiresAt: z.iso.datetime() }).strict() }).strict();
export type CompanyPreapprovalCreated = z.infer<typeof CompanyPreapprovalCreatedSchema>;
