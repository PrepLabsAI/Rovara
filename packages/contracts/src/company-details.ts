// #1613: the caller's own company, and its new name.
//
//   GET /v1/dev/company/details   any member of the company       -> CompanyDetailsView
//   PUT /v1/dev/company/details   owner or admin of the company   { name } -> CompanyDetailsView (the new name)
//
// The company and the role are always the caller's LIVE membership, never a body, query, header or claim. A person in no company is told so (FORBIDDEN, NOT_IN_A_COMPANY_MESSAGE).
import { z } from "zod";
import { OrgIdSchema, OrgRoleSchema } from "./company-scope.js";
import { CompanySelfServeNameSchema } from "./company-invites.js";

export const COMPANY_DETAILS_PATH = "/v1/dev/company/details";

/** The rename: the company's new name, with the same rules as a new company's (1 to 80 characters, trimmed, no control or formatting characters). Nothing else is accepted. */
export const CompanyRenameBodySchema = z.object({ name: CompanySelfServeNameSchema }).strict();
export type CompanyRenameBody = z.infer<typeof CompanyRenameBodySchema>;

/**
 * What the read (and a rename) answers:
 *   companyId  the company's id;
 *   name       its name (null only where the company has no stored record);
 *   role       the caller's own role in it;
 *   members    how many people are in it now (removed people are not counted);
 *   membersAtLeast  true when there are more than the read counts (`members` is then a lower bound).
 */
export const CompanyDetailsViewSchema = z.object({
  companyId: OrgIdSchema,
  name: z.string().min(1).max(80).nullable(),
  role: OrgRoleSchema,
  members: z.number().int().min(0),
  membersAtLeast: z.literal(true).optional(),
}).strict();
export type CompanyDetailsView = z.infer<typeof CompanyDetailsViewSchema>;
