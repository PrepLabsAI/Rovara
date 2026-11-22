import { agentXError, type Payer, type WorkOrigin, type RunPrice, type TaskTokenClaims, type GatewayModelIdentity } from "@agentx/contracts";
import type { TokenSigner } from "../../developer/tokens.js";
import type { TaskTokenRecords } from "./records.js";
import type { TaskTokenDeadline } from "./deadline.js";
import { invalidModelAccess } from "./cx-a/access-error.js";
import { taskRunPrice } from "./cx-a/run-price.js";
import { signTaskToken } from "./cx-a/sign-token.js";

export type TaskTokenSigner = TokenSigner;
export interface TaskTokenOperation { workspaceId: string; operationId: string; fence: number; reviewerSlot?: string }
export interface TaskTokenDescription { companyId: string; project: string; person?: string; payer: Payer; taskId: string; step: string; origin?: WorkOrigin; models: string[]; identity?: GatewayModelIdentity; reviewer?: TaskTokenClaims["reviewer"]; /** Server-side first issuance, never request input. */ reviewerGrant?: TaskTokenClaims }
export interface TaskTokenDescriber {
  /** The route passes its checked records so the default describer reads each record only once per request. */
  describe(operation: TaskTokenOperation, records?: TaskTokenRecords): Promise<TaskTokenDescription | undefined>;
  /** Only a hosted root installs this. Generic slot requests remain refused. */
  describeReviewer?(operation: TaskTokenOperation, records: TaskTokenRecords, slot: string): Promise<TaskTokenDescription | undefined>;
  reviewerMinted?(operation: TaskTokenOperation, description: TaskTokenDescription, token: string, expiresAt: number): Promise<void>;
}
export interface TaskTokenDeps { signer: TaskTokenSigner; issuer: string; describer: TaskTokenDescriber; now?: () => number; runPrice?: (model: string) => Promise<RunPrice | undefined> }
export { MODEL_ACCESS_INVALID, invalidModelAccess } from "./cx-a/access-error.js";

export async function mintTaskToken(deps: TaskTokenDeps, operation: TaskTokenOperation, records?: TaskTokenRecords, deadline?: TaskTokenDeadline): Promise<{ token: string; expiresAt: number; companyId: string; models: string[]; runPrice?: RunPrice }> {
  deadline?.check();
  const description = operation.reviewerSlot === undefined ? await deps.describer.describe(operation, records)
    : records === undefined ? undefined : await deps.describer.describeReviewer?.(operation, records, operation.reviewerSlot);
  deadline?.check();
  if (description === undefined) throw operation.reviewerSlot === undefined ? agentXError("CALLBACK_FORBIDDEN", "this operation has no model access") : invalidModelAccess();
  if ((operation.reviewerSlot === undefined) !== (description.reviewer === undefined) || (description.reviewer !== undefined && (description.reviewer.slot !== operation.reviewerSlot || deps.describer.reviewerMinted === undefined))) throw invalidModelAccess();
  // A description never changes the tenant, task or project the route checked.
  if (records !== undefined && (description.companyId !== records.operation.companyId || description.project !== records.workspace.projectName || description.taskId !== records.task.taskId)) throw invalidModelAccess();
  const runPrice = await taskRunPrice(deps, operation, description, deadline);
  return signTaskToken(deps, operation, description, runPrice, deadline);
}
