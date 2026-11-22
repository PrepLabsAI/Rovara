import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { taskTokenClaimsFor, TASK_TOKEN_ALGORITHM, TASK_TOKEN_SIGNING_INPUT_MAX_BYTES, TASK_TOKEN_TYP, TASK_KEY_PURPOSE, type RunPrice, type TaskTokenClaims } from "@agentx/contracts";
import type { PublicSigningJwk } from "../../../developer/tokens.js";
import type { TaskTokenDeadline } from "../deadline.js";
import type { TaskTokenDeps, TaskTokenDescription, TaskTokenOperation } from "../token.js";
import { invalidModelAccess } from "./access-error.js";

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function claimsFor(deps: TaskTokenDeps, operation: TaskTokenOperation, description: TaskTokenDescription, runPrice: RunPrice | undefined): TaskTokenClaims {
  // An issuer alone over the total budget cannot fit; reject before allocation or key I/O.
  if (typeof deps.issuer !== "string" || Buffer.byteLength(deps.issuer) > TASK_TOKEN_SIGNING_INPUT_MAX_BYTES) throw invalidModelAccess();
  const iat = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const claims = taskTokenClaimsFor({
    ...(runPrice === undefined ? {} : { runPrice }),
    iss: deps.issuer, jti: description.reviewerGrant?.jti ?? randomUUID(), iat, cid: description.companyId, pid: description.project,
    ...(description.person === undefined ? {} : { per: description.person }), pay: description.payer, tid: description.taskId,
    ws: operation.workspaceId, op: operation.operationId, stp: description.step,
    ...(description.origin === undefined ? {} : { src: description.origin }), mdl: description.models,
    ...(description.reviewer === undefined ? {} : { reviewer: description.reviewer }),
  });
  if (claims === undefined) throw invalidModelAccess();
  return claims;
}

function checkRenewal(description: TaskTokenDescription, claims: TaskTokenClaims): void {
  const first = description.reviewerGrant;
  // A renewal changes only the clock. Its whole 120 s lifetime must fit in the original session.
  if (first !== undefined && (description.reviewer === undefined || claims.iat < first.iat || claims.exp > first.iat + 600
    || !isDeepStrictEqual({ ...claims, iat: first.iat, nbf: first.nbf, exp: first.exp }, first))) throw invalidModelAccess();
}

function signingInput(key: PublicSigningJwk, claims: TaskTokenClaims): Buffer {
  if (key.rovara_purpose !== TASK_KEY_PURPOSE || key.kty !== "RSA" || key.alg !== "RS256" || key.use !== "sig" || typeof key.kid !== "string" || !/^[A-Za-z0-9_-]{16}$/u.test(key.kid)) throw invalidModelAccess();
  const header = { alg: TASK_TOKEN_ALGORITHM, typ: TASK_TOKEN_TYP, kid: key.kid };
  const input = Buffer.from(`${base64url(header)}.${base64url(claims)}`);
  if (input.byteLength > TASK_TOKEN_SIGNING_INPUT_MAX_BYTES) throw invalidModelAccess();
  return input;
}

export async function signTaskToken(deps: TaskTokenDeps, operation: TaskTokenOperation, description: TaskTokenDescription, runPrice: RunPrice | undefined, deadline?: TaskTokenDeadline) {
  try {
    const claims = claimsFor(deps, operation, description, runPrice);
    checkRenewal(description, claims);
    const key = await deps.signer.publicJwk();
    deadline?.check();
    const input = signingInput(key, claims);
    const signature = await deps.signer.sign(input);
    deadline?.check();
    const token = `${input.toString()}.${signature.toString("base64url")}`;
    if (description.reviewer !== undefined) await deps.describer.reviewerMinted?.(operation, description, token, claims.exp * 1000);
    deadline?.check();
    return { token, expiresAt: claims.exp * 1000, companyId: claims.cid, models: [...claims.mdl], ...(runPrice === undefined ? {} : { runPrice }) };
  } catch {
    // Never expose signer diagnostics, malformed claims, or any credential.
    throw invalidModelAccess();
  }
}
