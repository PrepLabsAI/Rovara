// Spec 025 FR-001 and FR-005 (R1: RS256). The broker verifies these tokens itself (D17).
// The private key never leaves KMS; this file builds the JWS signing input and asks KMS to sign it.
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { DEVELOPER_ACCESS_TOKEN_SECONDS, DEVELOPER_TOKEN_AUDIENCE, type DeveloperSignInMethod } from "@agentx/contracts";

export interface PublicSigningJwk { kty: "RSA"; n: string; e: string; kid: string; alg: "RS256"; use: "sig" }

export interface TokenSigner {
  publicJwk(): Promise<PublicSigningJwk>;
  sign(signingInput: Buffer): Promise<Buffer>;
}

const KMS_RAW_MESSAGE_LIMIT = 4096;
const NOT_BEFORE_SKEW_SECONDS = 30;

export function kmsTokenSigner(input: { kms: { send(command: unknown): Promise<unknown> }; keyId: string }): TokenSigner {
  let jwk: Promise<PublicSigningJwk> | undefined;
  return {
    publicJwk() {
      jwk ??= input.kms.send(new GetPublicKeyCommand({ KeyId: input.keyId })).then((response) => {
        const { PublicKey: der, KeyUsage: keyUsage } = response as { PublicKey?: Uint8Array; KeyUsage?: string };
        if (der === undefined) throw new Error("KMS returned no public key for the developer token key");
        if (keyUsage !== "SIGN_VERIFY") throw new Error("the developer token key is not usable for signing");
        const keyObject = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
        const exported = keyObject.export({ format: "jwk" });
        if (exported.kty !== "RSA" || typeof exported.n !== "string" || typeof exported.e !== "string") {
          throw new Error("the developer token key is not an RSA key");
        }
        const modulusLength = keyObject.asymmetricKeyDetails?.modulusLength;
        if (modulusLength === undefined || modulusLength < 2048) {
          throw new Error("the developer token key does not meet the minimum key size");
        }
        const kid = createHash("sha256").update(Buffer.from(der)).digest("base64url").slice(0, 16);
        return { kty: "RSA" as const, n: exported.n, e: exported.e, kid, alg: "RS256" as const, use: "sig" as const };
      }).catch((error: unknown) => {
        jwk = undefined;
        throw error;
      });
      return jwk;
    },
    async sign(signingInput) {
      if (signingInput.length > KMS_RAW_MESSAGE_LIMIT) throw new Error("developer token signing input is too large for KMS");
      const response = await input.kms.send(new SignCommand({
        KeyId: input.keyId,
        Message: signingInput,
        MessageType: "RAW",
        SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
      })) as { Signature?: Uint8Array };
      if (response.Signature === undefined) throw new Error("KMS returned no signature");
      return Buffer.from(response.Signature);
    },
  };
}

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export async function issueAccessToken(signer: TokenSigner, input: {
  issuer: string; subject: string; amr: DeveloperSignInMethod; env: string; sessionId: string; now: number;
}): Promise<{ token: string; expiresIn: number }> {
  const { kid } = await signer.publicJwk();
  const iat = Math.floor(input.now / 1000);
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = {
    iss: input.issuer,
    aud: DEVELOPER_TOKEN_AUDIENCE,
    sub: input.subject,
    amr: input.amr,
    env: input.env,
    sid: input.sessionId,
    iat,
    // Backdated, so a verifier whose clock runs a little behind still accepts a fresh token.
    nbf: iat - NOT_BEFORE_SKEW_SECONDS,
    exp: iat + DEVELOPER_ACCESS_TOKEN_SECONDS,
    jti: randomUUID(),
  };
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = await signer.sign(Buffer.from(signingInput));
  return { token: `${signingInput}.${signature.toString("base64url")}`, expiresIn: DEVELOPER_ACCESS_TOKEN_SECONDS };
}

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function pkceChallengeMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  const expected = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function randomToken(prefix: "agxr_" | "agxc_" | ""): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
