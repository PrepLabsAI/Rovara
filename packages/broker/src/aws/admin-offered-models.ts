// P0-14 (live test 0.5.28): which company the admin read GET /v1/admin/core/offered-models (DEC 254g) answers for. The route is for the install's administrator (the operator claim), and
// the agent model it checks is the whole install's, so the operator names the company (`?companyId=`, from `agentx config set coreEngine.agentModel <id> --company <company id>`).
// Before this the route only resolved the operator's OWN company membership, which an install operator usually lacks: that threw AUTH_REQUIRED ("your sign-in has ended") and the
// CLI looped on "login --admin". Without a named company the operator's membership is still used, and an operator with none is told to name one (never AUTH_REQUIRED).
//
// Read only. A named company must be a well-formed company id and one of Code's companies (its stored company record, or the built-in company); anything else is one fixed refusal
// (400) that never echoes the value. The administrator claim is checked by the caller first: a non-administrator never reaches this.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { IMPLICIT_COMPANY_ID, OrgIdSchema, agentXError } from "@agentx/contracts";
import { CompanyRecord, companyKey } from "../developer/company-membership.js";
import { OFFERED_MODELS_READ_FAILED } from "../core-host/offered-models-http.js";
import { resolveAdminCompany, type CompanyMembershipReader } from "./company-check.js";

/** The query parameter that names the company. */
export const OFFERED_MODELS_COMPANY_PARAMETER = "companyId";
/** A named company that is malformed, or not one of Code's companies. Fixed words: the value is never echoed. */
export const OFFERED_MODELS_UNKNOWN_COMPANY = "that company is not one of this install's companies; give a company id (org_ and 20 lowercase letters or digits) from Code's company records";
/** No company named, and the administrator's sign-in is in no company. */
export const OFFERED_MODELS_NAME_A_COMPANY = "this admin sign-in is not a member of a company, so name the company whose offered models to read";

export interface OfferedModelsCompanyInputs {
  /** The `companyId` query values (all of them: more than one is refused). */
  named: readonly string[];
  /** Code's company membership reader, where the company layer is on. */
  companies: CompanyMembershipReader | undefined;
  /** The administrator's own key, for the membership fallback. */
  ownerKey: string;
  /** Where Code's company records live, where developer sign-in is set up. */
  signIn: { documentClient: { send(command: unknown): Promise<unknown> }; signInTableName: string } | undefined;
}

async function companyIsKnown(signIn: OfferedModelsCompanyInputs["signIn"], companyId: string): Promise<boolean> {
  if (companyId === IMPLICIT_COMPANY_ID) return true;
  if (signIn === undefined) return false;
  const key = companyKey(companyId);
  let stored: unknown;
  try {
    stored = (await signIn.documentClient.send(new GetCommand({ TableName: signIn.signInTableName, Key: key, ConsistentRead: true })) as { Item?: unknown } | undefined)?.Item;
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", OFFERED_MODELS_READ_FAILED); }
  const record = CompanyRecord.safeParse(stored);
  return record.success && record.data.companyId === companyId;
}

/** The company whose offered models the administrator reads. Throws the fixed refusals above, or AUTH_REQUIRED only where the membership read itself failed. */
export async function offeredModelsCompany(input: OfferedModelsCompanyInputs): Promise<string> {
  if (input.named.length > 1) throw agentXError("CONFIG_INVALID", OFFERED_MODELS_UNKNOWN_COMPANY);
  if (input.named.length === 1) {
    const company = OrgIdSchema.safeParse(input.named[0]);
    if (!company.success || !await companyIsKnown(input.signIn, company.data)) throw agentXError("CONFIG_INVALID", OFFERED_MODELS_UNKNOWN_COMPANY);
    return company.data;
  }
  if (input.companies === undefined) throw agentXError("CONFIG_INVALID", OFFERED_MODELS_NAME_A_COMPANY);
  // A reader that fails keeps the fixed sign-in refusal (fail closed); only a clean "no membership" becomes the clear refusal.
  return (await resolveAdminCompany(input.companies, input.ownerKey, () => agentXError("CONFIG_INVALID", OFFERED_MODELS_NAME_A_COMPANY)))!;
}
