import { createHash, randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, canonicalJson, companyScoped } from "@agentx/contracts";

export const COMPANY_SIGN_IN_METHODS = ["web", "slack", "github", "cli", "invite"] as const;
export const COMPANY_SIGN_IN_CAUSES = ["not_invited", "member_elsewhere", "member_revoked", "person_revoked", "company_signin_mismatch", "sign_in_failed"] as const;
export type CompanySignInMethod = typeof COMPANY_SIGN_IN_METHODS[number];
export type CompanySignInCause = typeof COMPANY_SIGN_IN_CAUSES[number];
export interface CompanySignInAuditInput {
  companyId: string;
  developerId: string;
  method: CompanySignInMethod;
  outcome: "succeeded" | "refused";
  cause?: CompanySignInCause;
}

interface AuditWriterDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

/** Writes one allowlisted Code company-audit row; callers must supply company attribution from membership. */
export function createCompanySignInAuditWriter(deps: AuditWriterDependencies): (input: CompanySignInAuditInput) => Promise<void> {
  return async (input) => {
    if (!OrgIdSchema.safeParse(input.companyId).success || !/^[a-f0-9]{64}$/u.test(input.developerId)
      || !COMPANY_SIGN_IN_METHODS.includes(input.method)
      || (input.outcome !== "succeeded" && input.outcome !== "refused")
      || (input.outcome === "refused" && (input.cause === undefined || !COMPANY_SIGN_IN_CAUSES.includes(input.cause)))
      || (input.outcome === "succeeded" && input.cause !== undefined)) throw new TypeError("sign-in audit input is not valid");
    const eventId = `signin_${randomUUID()}`;
    const at = new Date(deps.now()).toISOString();
    const actor = { type: "person" as const, id: input.developerId };
    const action = `signin.${input.outcome}`;
    const details = { method: input.method, ...(input.cause === undefined ? {} : { cause: input.cause }) };
    const digest = createHash("sha256").update(canonicalJson({ companyId: input.companyId, actor, action, subject: null, details })).digest("hex");
    const item = {
      pk: companyScoped(input.companyId, "AUDIT"), sk: `EVENT#${eventId}`,
      entityType: "AUDIT", eventId, companyId: input.companyId, at, actor, action, details, digest,
    };
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  };
}
