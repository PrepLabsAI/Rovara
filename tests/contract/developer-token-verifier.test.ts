// Spec 025 D17: the broker verifies developer access tokens itself (no API Gateway JWT authorizer).
import { createHmac, createPublicKey, type JsonWebKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentXError } from "@agentx/contracts";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { issueAccessToken, kmsTokenSigner, type PublicSigningJwk } from "../../packages/broker/src/developer/tokens.js";
import { ISSUER, T0, fakeKms, localSigner } from "../support/developer-fakes.js";

const SUB = "d".repeat(64);
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: "agentx-developer", sub: SUB, amr: "slack", env: "staging", sid: "s-1",
  iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600, jti: "j-1", ...overrides,
});

async function setup(options: { keys?: () => Promise<unknown[]> } = {}) {
  const signer = localSigner();
  const jwk = await signer.publicJwk();
  let clock = T0;
  const fetches: number[] = [];
  const keys = options.keys ?? (async () => [jwk]);
  const verify = developerTokenVerifier({ issuer: ISSUER, keys: async () => { fetches.push(clock); return keys(); }, now: () => clock });
  const sign = async (payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: jwk.kid }) => {
    const input = `${b64(header)}.${b64(payload)}`;
    return `${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
  };
  return { signer, jwk, verify, sign, fetches, tick: (ms: number) => { clock += ms; } };
}

async function refusal(promise: Promise<unknown>): Promise<AgentXError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(AgentXError);
  return error as AgentXError;
}
const expectUnauthorized = async (promise: Promise<unknown>) => {
  const error = await refusal(promise);
  expect(error.code).toBe("AUTH_REQUIRED");
  // One answer for every failure: nothing that tells an attacker which check failed.
  expect(error.message).toBe("AUTH_REQUIRED: this route needs an AgentX developer sign-in; run agentx login <url>");
};

describe("the broker's developer token check (D17)", () => {
  it("accepts a token the sign-in server issued, and returns its claims", async () => {
    const h = await setup();
    const { token } = await issueAccessToken(h.signer, { issuer: ISSUER, subject: SUB, amr: "slack", env: "staging", sessionId: "s-1", now: T0 });
    expect(await h.verify(`Bearer ${token}`)).toMatchObject({ iss: ISSUER, aud: "agentx-developer", sub: SUB, amr: "slack", env: "staging", sid: "s-1" });
  });

  it.each([
    ["no Authorization header", undefined],
    ["an empty header", ""],
    ["another scheme", "Basic dXNlcjpwYXNz"],
    ["a token that is not a JWT", "Bearer agxr_notajwt"],
  ])("refuses %s", async (_name, header) => {
    const h = await setup();
    await expectUnauthorized(h.verify(header));
  });

  it("refuses alg none", async () => {
    const h = await setup();
    const token = `${b64({ alg: "none", typ: "JWT", kid: h.jwk.kid })}.${b64(claims())}.`;
    await expectUnauthorized(h.verify(`Bearer ${token}`));
  });

  it("refuses HS256 signed with the public key as the secret", async () => {
    const h = await setup();
    const pem = createPublicKey({ key: h.jwk as unknown as JsonWebKey, format: "jwk" }).export({ type: "spki", format: "pem" });
    const input = `${b64({ alg: "HS256", typ: "JWT", kid: h.jwk.kid })}.${b64(claims())}`;
    const token = `${input}.${createHmac("sha256", pem).update(input).digest("base64url")}`;
    await expectUnauthorized(h.verify(`Bearer ${token}`));
  });

  it("refuses another alg even with a valid RSA signature, a missing kid and a wrong kid", async () => {
    const h = await setup();
    await expectUnauthorized(h.verify(`Bearer ${await h.sign(claims(), { alg: "RS512", typ: "JWT", kid: h.jwk.kid })}`));
    await expectUnauthorized(h.verify(`Bearer ${await h.sign(claims(), { alg: "RS256", typ: "JWT" })}`));
    await expectUnauthorized(h.verify(`Bearer ${await h.sign(claims(), { alg: "RS256", typ: "JWT", kid: "not-our-key" })}`));
  });

  it("refuses a bad signature, and a token signed by another key under our kid", async () => {
    const h = await setup();
    const token = await h.sign(claims());
    const [header, payload, signature] = token.split(".");
    const flipped = `${signature!.slice(0, -2)}${signature!.endsWith("AA") ? "BB" : "AA"}`;
    await expectUnauthorized(h.verify(`Bearer ${header}.${payload}.${flipped}`));
    const other = kmsTokenSigner({ kms: fakeKms(), keyId: "arn:aws:kms:us-east-1:123456789012:key/other" });
    const input = `${b64({ alg: "RS256", typ: "JWT", kid: h.jwk.kid })}.${b64(claims())}`;
    await expectUnauthorized(h.verify(`Bearer ${input}.${(await other.sign(Buffer.from(input))).toString("base64url")}`));
  });

  it.each([
    ["a wrong issuer", { iss: "https://other.example.test/v1/auth" }],
    ["a wrong audience", { aud: "agentx-admin-client" }],
    ["an expired token, past the 30-second leeway", { exp: T0 / 1000 - 31 }],
    ["an nbf in the future, past the 30-second leeway", { nbf: T0 / 1000 + 31 }],
    ["no exp", { exp: undefined }],
    ["no sub", { sub: undefined }],
    ["a numeric sid", { sid: 7 }],
    ["no amr", { amr: undefined }],
    ["an array env", { env: ["staging"] }],
  ])("refuses %s", async (_name, overrides) => {
    const h = await setup();
    await expectUnauthorized(h.verify(`Bearer ${await h.sign(claims(overrides))}`));
  });

  it("allows 30 seconds of clock skew on exp and nbf", async () => {
    const h = await setup();
    expect(await h.verify(`Bearer ${await h.sign(claims({ exp: T0 / 1000 - 20 }))}`)).toMatchObject({ sid: "s-1" });
    expect(await h.verify(`Bearer ${await h.sign(claims({ nbf: T0 / 1000 + 20 }))}`)).toMatchObject({ sid: "s-1" });
  });

  it("fetches the keys once and keeps them", async () => {
    const h = await setup();
    const token = await h.sign(claims());
    await h.verify(`Bearer ${token}`);
    h.tick(10 * 60_000);
    await h.verify(`Bearer ${await h.sign(claims({ exp: T0 / 1000 + 7200 }))}`);
    expect(h.fetches).toHaveLength(1);
  });

  it("answers 503, not 401, when the keys cannot be fetched, and tries again on the next request", async () => {
    let fail = true;
    const published: { jwk?: PublicSigningJwk } = {};
    const h = await setup({ keys: async () => { if (fail) throw new Error("arn:aws:lambda:planted ResourceNotFound"); return [published.jwk]; } });
    published.jwk = h.jwk;
    const token = await h.sign(claims());
    const error = await refusal(h.verify(`Bearer ${token}`));
    expect(error.code).toBe("RUNTIME_UNAVAILABLE");
    expect(error.message).not.toContain("planted");
    fail = false;
    expect(await h.verify(`Bearer ${token}`)).toMatchObject({ sid: "s-1" });
  });

  it("refetches once on an unknown kid, at most once a minute, and then accepts a rotated key", async () => {
    const first = await setup();
    const rotated = kmsTokenSigner({ kms: fakeKms(), keyId: "arn:aws:kms:us-east-1:123456789012:key/rotated" });
    const rotatedJwk = await rotated.publicJwk();
    let served: PublicSigningJwk[] = [first.jwk];
    const h = await setup({ keys: async () => served });
    const signRotated = async () => {
      const input = `${b64({ alg: "RS256", typ: "JWT", kid: rotatedJwk.kid })}.${b64(claims())}`;
      return `${input}.${(await rotated.sign(Buffer.from(input))).toString("base64url")}`;
    };
    await expectUnauthorized(h.verify(`Bearer ${await signRotated()}`));
    expect(h.fetches).toHaveLength(1);
    // The rotated key is published, but the last fetch was under a minute ago: no refetch.
    served = [first.jwk, rotatedJwk];
    h.tick(30_000);
    await expectUnauthorized(h.verify(`Bearer ${await signRotated()}`));
    expect(h.fetches).toHaveLength(1);
    h.tick(31_000);
    expect(await h.verify(`Bearer ${await signRotated()}`)).toMatchObject({ sid: "s-1" });
    expect(h.fetches).toHaveLength(2);
  });
});
