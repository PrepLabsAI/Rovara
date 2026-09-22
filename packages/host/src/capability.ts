import { createHmac, timingSafeEqual } from "node:crypto";
import { agentXError } from "@agentx/contracts";

export interface CallbackClaims {
  workspaceId: string;
  operationId: string;
  fence: number;
  expiresAt: string;
}

export interface MintCallbackCapabilityInput extends CallbackClaims {
  key: Uint8Array | string;
}

export interface VerifyCallbackCapabilityInput {
  key: Uint8Array | string;
  capability: string;
  workspaceId: string;
  operationId: string;
  fence: number;
  now?: Date;
}

/**
 * Mint the capability a worker presents on its callbacks.
 *
 * The capability is `base64url(claims).base64url(hmac)`. **It is authenticated, not
 * confidential:** anyone holding it can read the claims, so nothing secret belongs in
 * them. What it proves is that this host issued it for exactly this workspace,
 * operation and writer generation, and that it has not been edited.
 */
export function mintCallbackCapability(input: MintCallbackCapabilityInput): string {
  const claims: CallbackClaims = {
    workspaceId: input.workspaceId,
    operationId: input.operationId,
    fence: input.fence,
    expiresAt: input.expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(input.key, payload)}`;
}

/**
 * Verify a presented capability against the operation it claims to act on.
 *
 * A worker's own statement never grants authority: every callback is checked against
 * the host's record. The fence must match the current writer generation, so a
 * capability minted for a superseded attempt cannot write to the operation that
 * replaced it, and an expired capability is refused even if it is otherwise valid.
 */
export function verifyCallbackCapability(input: VerifyCallbackCapabilityInput): CallbackClaims {
  const parts = input.capability.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw agentXError("CALLBACK_FORBIDDEN", "callback capability is malformed");
  }
  const [payload, signature] = parts as [string, string];
  const expected = Buffer.from(sign(input.key, payload), "utf8");
  const presented = Buffer.from(signature, "utf8");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    throw agentXError("CALLBACK_FORBIDDEN", "callback capability is not valid");
  }

  let claims: CallbackClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CallbackClaims;
  } catch {
    throw agentXError("CALLBACK_FORBIDDEN", "callback capability is malformed");
  }
  if (
    claims.workspaceId !== input.workspaceId ||
    claims.operationId !== input.operationId ||
    claims.fence !== input.fence
  ) {
    throw agentXError("CALLBACK_FORBIDDEN", "callback capability targets another operation");
  }
  const now = input.now ?? new Date();
  const expiresAt = Date.parse(claims.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw agentXError("CALLBACK_FORBIDDEN", "callback capability has expired");
  }
  return claims;
}

function sign(key: Uint8Array | string, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}
