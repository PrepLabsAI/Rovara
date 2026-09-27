import { createHash } from "node:crypto";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { issueAccessToken, kmsTokenSigner, pkceChallengeMatches, randomToken, sha256Hex } from "../../packages/broker/src/developer/tokens.js";
import { ISSUER, T0, fakeKms } from "../support/developer-fakes.js";

const KEY = "arn:aws:kms:us-east-1:123456789012:key/k1";
const issue = (signer: ReturnType<typeof kmsTokenSigner>, now = T0) =>
  issueAccessToken(signer, { issuer: ISSUER, subject: "d".repeat(64), amr: "slack", env: "staging", sessionId: "s-1", now });

describe("developer access tokens", () => {
  it("are RS256 JWTs with a kid that a JWKS verifier (API Gateway's JWT authorizer) accepts", async () => {
    const signer = kmsTokenSigner({ kms: fakeKms(), keyId: KEY });
    const { token, expiresIn } = await issue(signer);
    expect(expiresIn).toBe(3600);
    const jwk = await signer.publicJwk();
    expect(jwk).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect(decodeProtectedHeader(token)).toEqual({ alg: "RS256", typ: "JWT", kid: jwk.kid });
    const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: [jwk] }), { issuer: ISSUER, audience: "agentx-developer", currentDate: new Date(T0 + 1_000) });
    expect(payload).toMatchObject({ iss: ISSUER, aud: "agentx-developer", sub: "d".repeat(64), amr: "slack", env: "staging", sid: "s-1", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600 });
    expect(typeof payload.jti).toBe("string");
    // API Gateway passes array claims to the broker as strings, so every claim is a scalar.
    for (const value of Object.values(payload)) expect(["string", "number"]).toContain(typeof value);
  });

  it("stop verifying after one hour", async () => {
    const signer = kmsTokenSigner({ kms: fakeKms(), keyId: KEY });
    const { token } = await issue(signer);
    await expect(jwtVerify(token, createLocalJWKSet({ keys: [await signer.publicJwk()] }), { issuer: ISSUER, audience: "agentx-developer", currentDate: new Date(T0 + 3_601_000) })).rejects.toThrow(/exp/);
  });

  it("sign through KMS over the raw signing input, fetching the public key once", async () => {
    const kms = fakeKms();
    const signer = kmsTokenSigner({ kms, keyId: KEY });
    await issue(signer);
    await issue(signer);
    await signer.publicJwk();
    expect(kms.calls.filter((call) => call.name === "GetPublicKeyCommand")).toHaveLength(1);
    const signs = kms.calls.filter((call) => call.name === "SignCommand");
    expect(signs).toHaveLength(2);
    expect(signs[0]!.input).toMatchObject({ KeyId: KEY, MessageType: "RAW", SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256" });
  });

  it("derive the kid from the public key, so it never reveals the key ARN", async () => {
    const jwk = await kmsTokenSigner({ kms: fakeKms(), keyId: KEY }).publicJwk();
    expect(jwk.kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(jwk.kid).not.toContain("k1");
  });
});

describe("PKCE, random tokens and hashes", () => {
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  it("accepts only the S256 challenge of the verifier", () => {
    expect(pkceChallengeMatches(verifier, challenge)).toBe(true);
    expect(pkceChallengeMatches(verifier, verifier)).toBe(false);
    expect(pkceChallengeMatches("v".repeat(42), createHash("sha256").update("v".repeat(42)).digest("base64url"))).toBe(false);
    expect(pkceChallengeMatches("v".repeat(129), createHash("sha256").update("v".repeat(129)).digest("base64url"))).toBe(false);
    expect(pkceChallengeMatches(`${"v".repeat(42)} `, challenge)).toBe(false);
  });

  it("makes prefixed random tokens with 32 bytes of entropy", () => {
    const first = randomToken("agxr_");
    expect(first).toMatch(/^agxr_[A-Za-z0-9_-]{43}$/);
    expect(randomToken("agxr_")).not.toBe(first);
    expect(randomToken("")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes to lowercase hex SHA-256", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
