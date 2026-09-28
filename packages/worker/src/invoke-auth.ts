import { createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  WORKER_INVOKE_AUTHORIZATION_SCHEME,
  WorkerInvokeTokenClaimsSchema,
  type WorkerInvocation,
  type WorkerInvokeTokenClaims,
} from "@agentx/contracts";

const MAX_TOKEN_LENGTH = 2_048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What an EC2 worker needs to authenticate invocations: the dispatcher's KMS public key, and the
 * workspace and session generation it was booted for. The worker never holds a signing key, so a
 * compromised worker cannot mint tokens for another workspace.
 */
export interface InvokeAuthentication {
  publicKey: KeyObject;
  workspaceId: string;
  generation: number;
  /** Epoch seconds; injectable for tests. */
  now?: () => number;
}

export type InvokeRejection =
  | "missing"
  | "malformed"
  | "bad_signature"
  | "wrong_workspace"
  | "wrong_generation"
  | "expired"
  | "invocation_mismatch";

export type InvokeVerification =
  | { ok: true; claims: WorkerInvokeTokenClaims }
  | { ok: false; reason: InvokeRejection };

const ENVIRONMENT_KEYS = ["AGENTX_INVOKE_PUBLIC_KEY", "AGENTX_WORKSPACE_ID", "AGENTX_SESSION_GENERATION"] as const;

/**
 * Reads required invoke authentication from the EC2 boot environment.
 */
export function invokeAuthenticationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): InvokeAuthentication {
  const present = ENVIRONMENT_KEYS.filter((key) => environment[key]);
  if (present.length !== ENVIRONMENT_KEYS.length) {
    const missing = ENVIRONMENT_KEYS.filter((key) => !environment[key]);
    throw new Error(`invoke authentication is partly configured; missing ${missing.join(", ")}`);
  }
  const workspaceId = environment.AGENTX_WORKSPACE_ID!;
  if (!UUID.test(workspaceId)) throw new Error("AGENTX_WORKSPACE_ID must be a UUID");
  const generationText = environment.AGENTX_SESSION_GENERATION!;
  const generation = Number(generationText);
  if (!/^[1-9]\d*$/.test(generationText) || !Number.isSafeInteger(generation)) {
    throw new Error("AGENTX_SESSION_GENERATION must be a positive integer");
  }
  return { publicKey: invokePublicKey(environment.AGENTX_INVOKE_PUBLIC_KEY!), workspaceId, generation };
}

/**
 * Accepts a PEM public key, or the base64 DER SubjectPublicKeyInfo that KMS GetPublicKey returns.
 * Only a P-256 EC key is accepted, matching the ECC_NIST_P256 signing key.
 */
export function invokePublicKey(encoded: string): KeyObject {
  const text = encoded.trim();
  const key = text.startsWith("-----BEGIN")
    ? createPublicKey(text)
    : createPublicKey({ key: Buffer.from(text, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("the invoke public key must be a P-256 EC key");
  }
  return key;
}

/** Checks the Authorization header alone, so an unauthenticated request is refused before its body is read. */
export function verifyInvokeAuthorization(
  header: string | null,
  authentication: InvokeAuthentication,
): InvokeVerification {
  if (!header) return { ok: false, reason: "missing" };
  const separator = header.indexOf(" ");
  const scheme = separator < 0 ? header : header.slice(0, separator);
  if (scheme.toLowerCase() !== WORKER_INVOKE_AUTHORIZATION_SCHEME.toLowerCase()) return { ok: false, reason: "missing" };
  const token = header.slice(separator + 1).trim();
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts.every((part) => BASE64URL.test(part))) return { ok: false, reason: "malformed" };
  const [payload, signature] = parts as [string, string];

  // The signature is checked before the claims are even decoded.
  let signed: boolean;
  try {
    signed = verify(
      "sha256",
      Buffer.from(payload, "ascii"),
      { key: authentication.publicKey, dsaEncoding: "der" },
      Buffer.from(signature, "base64url"),
    );
  } catch {
    signed = false;
  }
  if (!signed) return { ok: false, reason: "bad_signature" };

  let claims: WorkerInvokeTokenClaims;
  try {
    claims = WorkerInvokeTokenClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (claims.workspaceId !== authentication.workspaceId) return { ok: false, reason: "wrong_workspace" };
  if (claims.generation !== authentication.generation) return { ok: false, reason: "wrong_generation" };
  const now = authentication.now?.() ?? Math.floor(Date.now() / 1_000);
  if (claims.expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

/**
 * A token is signed for one operation at one fence. Checked after the body is parsed and before it
 * is journaled, so a captured token cannot carry a different invocation.
 */
export function invocationMatchesClaims(invocation: WorkerInvocation, claims: WorkerInvokeTokenClaims): boolean {
  return (
    invocation.workspaceId === claims.workspaceId &&
    invocation.operationId === claims.operationId &&
    invocation.fence === claims.fence
  );
}
