// L4-SF (c): the words a registration is refused with when the core's copy of the project is refused (aws/core-project-backfill.ts `planCoreProjectWrites`).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { IMPLICIT_COMPANY_ID, OrgIdSchema } from "@agentx/contracts";
import { setupApplyKey } from "../core/setup-agent/apply.js";

/** What a registration is told when the core's copy of the project is refused. */
export const CORE_COPY_REFUSED = "core project copy refused";
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/**
 * The same refusal, in clearer words when the cause is a setup change waiting for approval (hosted setup approval: the core holds a candidate revision the old registry has not been given). The check only reads
 * the registering company's own proposal row; anything it cannot read or does not find gives the plain words, and nothing stored is echoed.
 */
export async function coreCopyRefusalWords(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }, company: string | undefined, project: string): Promise<string> {
  try {
    const owner = OrgIdSchema.safeParse(company === undefined ? IMPLICIT_COMPANY_ID : company);
    if (!owner.success || !PROJECT_NAME.test(project)) return CORE_COPY_REFUSED;
    const row = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: setupApplyKey(owner.data, project), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
    if (row?.["entityType"] === "SETUP_APPLY" && row["state"] === "checking") return `${CORE_COPY_REFUSED}: a setup change for this project is waiting for approval. Approve or discard it, then register again`;
  } catch { /* the plain words */ }
  return CORE_COPY_REFUSED;
}
