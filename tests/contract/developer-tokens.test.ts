import { createHash, generateKeyPairSync } from "node:crypto";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { issueAccessToken, kmsTokenSigner, pkceChallengeMatches, randomToken, sha256Hex } from "../../packages/broker/src/developer/tokens.js";
import { ISSUER, T0, fakeKms, rsaKeyPair } from "../support/developer-fakes.js";

const KEY = "arn:aws:kms:us-east-1:123456789012:key/k1";
const issue = (signer: ReturnType<typeof kmsTokenSigner>, now = T0) =>
  issueAccessToken(signer, { issuer: ISSUER, subject: "d".repeat(64), amr: "slack", env: "staging", sessionId: "s-1", now });

/** Runs `publicJwk()` to rejection and returns the error, for asserting on its message. */
async function publicJwkError(kms: { send(command: unknown): Promise<unknown> }): Promise<Error> {
  try {
    await kmsTokenSigner({ kms, keyId: KEY }).publicJwk();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected publicJwk() to reject");
}

describe("developer access tokens", () => {
  it("are RS256 JWTs with a kid that a JWKS verifier (the broker, D17) accepts", async () => {
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

  it("derive the kid deterministically from the public key, so it never reveals the key ARN", async () => {
    const keys = rsaKeyPair();
    const der = keys.publicKey.export({ format: "der", type: "spki" });
    const expectedKid = createHash("sha256").update(der).digest("base64url").slice(0, 16);

    const jwk = await kmsTokenSigner({ kms: fakeKms(keys), keyId: KEY }).publicJwk();
    expect(jwk.kid).toBe(expectedKid);
    expect(jwk.kid).not.toContain(KEY);

    // A second signer over the same key derives the same kid.
    const jwk2 = await kmsTokenSigner({ kms: fakeKms(keys), keyId: KEY }).publicJwk();
    expect(jwk2.kid).toBe(jwk.kid);
  });

  it("rejects a key whose KeyUsage is not SIGN_VERIFY, without naming the key", async () => {
    const der = new Uint8Array(rsaKeyPair().publicKey.export({ format: "der", type: "spki" }));
    const error = await publicJwkError({ send: async () => ({ KeyUsage: "ENCRYPT_DECRYPT", PublicKey: der }) });
    expect(error.message).toMatch(/signing/i);
    expect(error.message).not.toContain(KEY);
  });

  it("rejects an RSA key under 2048 bits, without naming the key", async () => {
    const weakKey = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey;
    const der = new Uint8Array(weakKey.export({ format: "der", type: "spki" }));
    const error = await publicJwkError({ send: async () => ({ KeyUsage: "SIGN_VERIFY", PublicKey: der }) });
    expect(error.message).toMatch(/key size/i);
    expect(error.message).not.toContain(KEY);
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
