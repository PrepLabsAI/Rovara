import { randomUUID } from "node:crypto";
import { agentXError, taskTokenClaimsFor, TASK_TOKEN_ALGORITHM, TASK_TOKEN_SIGNING_INPUT_MAX_BYTES, TASK_TOKEN_TYP, TASK_KEY_PURPOSE, type Payer, type WorkOrigin } from "@agentx/contracts";
import type { TokenSigner } from "../../developer/tokens.js";
import type { TaskTokenRecords } from "./records.js";
import type { TaskTokenDeadline } from "./deadline.js";

export type TaskTokenSigner = TokenSigner;
export interface TaskTokenOperation { workspaceId: string; operationId: string; fence: number }
export interface TaskTokenDescription { companyId: string; project: string; person?: string; payer: Payer; taskId: string; step: string; origin?: WorkOrigin; models: string[] }
export interface TaskTokenDescriber {
  /** The route passes its checked records so the default describer reads each record only once per request. */
  describe(operation: TaskTokenOperation, records?: TaskTokenRecords): Promise<TaskTokenDescription | undefined>;
}
export interface TaskTokenDeps { signer: TaskTokenSigner; issuer: string; describer: TaskTokenDescriber; now?: () => number }
export const MODEL_ACCESS_INVALID = "invalid or expired model access";
export const invalidModelAccess = () => agentXError("AUTH_REQUIRED", MODEL_ACCESS_INVALID);
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export async function mintTaskToken(deps: TaskTokenDeps, operation: TaskTokenOperation, records?: TaskTokenRecords, deadline?: TaskTokenDeadline): Promise<{ token: string; expiresAt: number }> {
  deadline?.check();
  const description = await deps.describer.describe(operation, records);
  deadline?.check();
  if (description === undefined) throw agentXError("CALLBACK_FORBIDDEN", "this operation has no model access");
  // A description never changes the tenant, task or project the route checked.
  if (records !== undefined && (description.companyId !== records.operation.companyId || description.project !== records.workspace.projectName || description.taskId !== records.task.taskId)) throw invalidModelAccess();
  try {
    // An issuer alone over the total budget cannot fit; reject before allocation or key I/O.
    if (typeof deps.issuer !== "string" || Buffer.byteLength(deps.issuer) > TASK_TOKEN_SIGNING_INPUT_MAX_BYTES) throw invalidModelAccess();
    const iat = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    const claims = taskTokenClaimsFor({
      iss: deps.issuer, jti: randomUUID(), iat, cid: description.companyId, pid: description.project,
      ...(description.person === undefined ? {} : { per: description.person }), pay: description.payer, tid: description.taskId,
      ws: operation.workspaceId, op: operation.operationId, stp: description.step,
      ...(description.origin === undefined ? {} : { src: description.origin }), mdl: description.models,
    });
    if (claims === undefined) throw invalidModelAccess();
    const key = await deps.signer.publicJwk();
    deadline?.check();
    if (key.rovara_purpose !== TASK_KEY_PURPOSE || key.kty !== "RSA" || key.alg !== "RS256" || key.use !== "sig" || typeof key.kid !== "string" || !/^[A-Za-z0-9_-]{16}$/u.test(key.kid)) throw invalidModelAccess();
    const header = { alg: TASK_TOKEN_ALGORITHM, typ: TASK_TOKEN_TYP, kid: key.kid };
    const input = Buffer.from(`${base64url(header)}.${base64url(claims)}`);
    if (input.byteLength > TASK_TOKEN_SIGNING_INPUT_MAX_BYTES) throw invalidModelAccess();
    const signature = await deps.signer.sign(input);
    deadline?.check();
    return { token: `${input.toString()}.${signature.toString("base64url")}`, expiresAt: claims.exp * 1000 };
  } catch {
    // Never expose signer diagnostics, malformed claims, or any credential.
    throw invalidModelAccess();
  }
}
