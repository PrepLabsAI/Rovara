// DEC 254b (b): an operator copies one company of the install's old layout (State table: ORG#<company>/META, ORG#<company>/MEMBER#<person>, the
// DEVELOPER_ORG pointer, the ban list) into Code's own company records (sign-in table: the company record, COMPANY_MEMBER#<person>/COMPANY and its
// member mirror), before Code's company sign-in is switched on. The company id stays the same, so no other data moves.
// A preview reads only. An apply and its undo are admin changes, written by the sign-in Lambda. Every answer names people by their opaque id, never an email.
import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { OrgRoleSchema } from "./company-scope.js";

const PersonId = z.string().regex(/^[a-f0-9]{64}$/);
/** The most members one import (or undo) reads and writes. More refuses the whole run, never a partial copy. */
export const COMPANY_IMPORT_MEMBERS_MAX = 200;

/** Why a person is left as they are. Each is shown with their id. */
export const CompanyImportSkipReasonSchema = z.enum([
  /** Their sign-in was merged into another: the survivor is imported from their own member record, never this id. */
  "merged",
  /** The install banned them from the company. */
  "banned",
  /** Their member record says they were removed, or their company pointer does not name this company. */
  "removed",
  /** Their sign-in is revoked. */
  "sign_in_revoked",
  /** Already a member of this same company in Code's records. */
  "already_member",
  /** Undo: their row changed after the import (a role change, a removal, or any other write), so the undo keeps it. */
  "changed_since_import",
]);
/** Why the whole run is refused. Nothing is written. */
export const CompanyImportRefusalSchema = z.enum([
  /** A role Code does not know (the install's Auditor, say). */
  "unknown_role",
  /** Already a member (live or removed) of ANOTHER company in Code's records. */
  "member_of_another_company",
  /** A record that does not read: a malformed member record, pointer, sign-in record or merge chain, or a stray Code record. */
  "unreadable_record",
]);

export const CompanyImportPreviewSchema = z.object({
  mode: z.enum(["import", "undo"]),
  companyId: OrgIdSchema,
  /** True: an apply would do exactly this. False: refused (see `refusal` and `refused`) and nothing would be written. */
  ready: z.boolean(),
  /** A refusal of the whole run that names no person: no such open company in the install's records, too many members, no owner after the import, a
   * record that does not read (the company's, a member record's key, Code's company record), or the built-in company. */
  refusal: z.enum(["no_open_company", "too_many_members", "no_owner", "unreadable", "built_in_company"]).optional(),
  /** import: "write" makes the company record, "exists" keeps the one already there. undo: "delete" removes the record the import made, "keep" leaves it. */
  company: z.enum(["write", "exists", "delete", "keep"]),
  /** import: the rows to write (one membership and one mirror each). undo: the imported rows to delete. */
  members: z.array(z.object({ personId: PersonId, role: OrgRoleSchema }).strict()).max(COMPANY_IMPORT_MEMBERS_MAX),
  skipped: z.array(z.object({ personId: PersonId, reason: CompanyImportSkipReasonSchema, survivorId: PersonId.optional() }).strict()).max(COMPANY_IMPORT_MEMBERS_MAX),
  refused: z.array(z.object({ personId: PersonId, reason: CompanyImportRefusalSchema }).strict()).max(COMPANY_IMPORT_MEMBERS_MAX),
}).strict();
export type CompanyImportPreview = z.infer<typeof CompanyImportPreviewSchema>;
