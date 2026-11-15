import { describe, expect, it } from "vitest";
import { mintTaskToken, type TaskTokenDescription } from "../../packages/broker/src/core/model-gateway/token.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { issueAccessToken } from "../../packages/broker/src/developer/tokens.js";
import { claimVector, signingWorld } from "../support/model-gateway.js";
const v = claimVector();
const operation = { workspaceId: v.ws, operationId: v.op, fence: 1 };
const description = (): TaskTokenDescription => ({ companyId: v.cid, project: v.pid, person: v.per!, payer: v.pay, taskId: v.tid, step: v.stp, origin: "app", models: v.mdl });
const setup = () => { const world = signingWorld(); return { ...world, deps: { signer: world.signer, issuer: v.iss, now: () => v.iat * 1000, describer: { describe: async () => description() } } }; };
describe("task token mint", () => {
  it("mints the vector with the exact header, fresh jti, lifetime and skew", async () => {
    const w = setup(); const a = await mintTaskToken(w.deps, operation); const b = await mintTaskToken(w.deps, operation);
    const actual = w.reference(a.token)!; expect(actual.jti).toMatch(/^[0-9a-f-]{36}$/u);
    expect({ ...actual, jti: v.jti }).toEqual(v);
    expect(w.reference(a.token)?.jti).not.toBe(w.reference(b.token)?.jti);
    expect(a.expiresAt).toBe(1800000900000);
    expect(JSON.parse(Buffer.from(a.token.split(".")[0]!, "base64url").toString())).toEqual({ alg: "RS256", typ: "rovara-task+jwt", kid: w.published.kid });
  });
  it("mints old descriptions without src or per", async () => {
    const w = setup(); const old = description(); delete old.origin; delete old.person;
    const result = await mintTaskToken({ ...w.deps, describer: { describe: async () => old } }, operation);
    expect(w.reference(result.token)).not.toHaveProperty("src"); expect(w.reference(result.token)).not.toHaveProperty("per");
  });
  it.each([
    { companyId: undefined }, { person: "bad" }, { payer: { kind: "other" } }, { step: "Build" }, { origin: "unknown" }, { models: [] }, { models: ["a".repeat(129)] },
  ])("refuses malformed descriptions before signing with fixed words", async patch => {
    const w = setup();
    await expect(mintTaskToken({ ...w.deps, describer: { describe: async () => ({ ...description(), ...patch }) as TaskTokenDescription } }, operation)).rejects.toThrow("invalid or expired model access");
    expect(w.signs()).toBe(0);
  });
  it("refuses the total signing-input byte limit before signing", async () => {
    const w = setup();
    await expect(mintTaskToken({ ...w.deps, describer: { describe: async () => ({ ...description(), models: Array<string>(16).fill("a".repeat(128)) }) } }, operation)).rejects.toThrow("invalid or expired model access");
    expect(w.signs()).toBe(0);
  });
  it("mints all sixteen allowed models without dropping any", async () => {
    const w = setup(); const models = Array.from({ length: 16 }, (_value, i) => `model-${i}`);
    const result = await mintTaskToken({ ...w.deps, describer: { describe: async () => ({ ...description(), models }) } }, operation);
    expect(w.reference(result.token)?.mdl).toEqual(models);
  });
  it("refuses undefined access before touching the signer", async () => {
    const w = setup(); await expect(mintTaskToken({ ...w.deps, describer: { describe: async () => undefined } }, operation)).rejects.toThrow("this operation has no model access"); expect(w.signs()).toBe(0);
  });
  it.each([{ kid: 1234567890123456 }, { kid: "short" }, { kty: "EC" }, { alg: "HS256" }, { use: "enc" }])("refuses malformed signer metadata before signing", async patch => {
    const w = setup();
    w.deps.signer.publicJwk = async () => ({ ...w.published, ...patch }) as typeof w.published;
    await expect(mintTaskToken(w.deps, operation)).rejects.toThrow("invalid or expired model access");
    expect(w.signs()).toBe(0);
  });
  it("separates sign-in and task tokens in both directions", async () => {
    const w = setup(); const task = await mintTaskToken(w.deps, operation);
    const verify = developerTokenVerifier({ issuer: v.iss, now: w.deps.now, keys: async () => [w.published] });
    await expect(verify(`Bearer ${task.token}`)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const access = await issueAccessToken(w.signer, { issuer: v.iss, subject: v.per!, amr: "slack", env: "test", sessionId: "session", now: w.deps.now() });
    expect(w.reference(access.token)).toBeUndefined();
  });
  it.each([
    ["aud", { aud: "agentx-developer" }, {}], ["lifetime", { exp: v.iat + 901 }, {}], ["unknown claim", { secret: "marker" }, {}], ["cid", { cid: undefined }, {}], ["models", { mdl: [] }, {}],
    ["expiry", { iat: v.iat - 1000, exp: v.iat - 31 }, {}], ["not before", { nbf: v.iat + 31 }, {}], ["missing nbf", { nbf: undefined }, {}],
    ["typ", {}, { typ: "JWT" }], ["none", {}, { alg: "none" }], ["HS256", {}, { alg: "HS256" }], ["crit", {}, { crit: ["test"] }],
  ])("reference rejects the single changed %s", async (_label, claims, header) => {
    const w = setup(); expect(w.reference(await w.signed(v))).toBeDefined();
    expect(w.reference(await w.signed({ ...v, ...claims }, { alg: "RS256", typ: "rovara-task+jwt", kid: w.published.kid, ...header }))).toBeUndefined();
  });
});

it.each([false, true])("signs the largest fitting input and refuses the next larger one (compact=%s)", async compact => {
  const w = setup(); const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "rovara-task+jwt", kid: w.published.kid })).toString("base64url");
  const d = description(); const fixture = { ...v };
  if (compact) { delete d.person; delete fixture.per; d.payer = { kind: "project", project: v.pid }; fixture.pay = d.payer; }
  const deps = { ...w.deps, describer: { describe: async () => d } };
  let issuer = v.iss;
  const bytes = (iss: string) => Buffer.byteLength(`${header}.${Buffer.from(JSON.stringify({ ...fixture, iss })).toString("base64url")}`);
  while (bytes(`${issuer}a`) <= 3500) issuer += "a";
  const minted = await mintTaskToken({ ...deps, issuer }, operation);
  const parts = minted.token.split("."); expect(Buffer.byteLength(`${parts[0]}.${parts[1]}`)).toBeLessThanOrEqual(3500);
  expect(w.signs()).toBe(1);
  await expect(mintTaskToken({ ...deps, issuer: `${issuer}a` }, operation)).rejects.toThrow("invalid or expired model access"); expect(w.signs()).toBe(1);
});

it("rejects an issuer larger than the whole byte budget before a key read", async () => {
  const w = setup(); let keys = 0; const key = w.deps.signer.publicJwk.bind(w.deps.signer);
  w.deps.signer.publicJwk = async () => { keys += 1; return key(); };
  const start = performance.now();
  await expect(mintTaskToken({ ...w.deps, issuer: "a".repeat(1000000) }, operation)).rejects.toThrow("invalid or expired model access");
  expect(performance.now() - start).toBeLessThan(1000); expect(keys).toBe(0); expect(w.signs()).toBe(0);
});

it.each(["developer", undefined, "untrusted-purpose-marker", null, 3])("refuses a signer without task purpose (%s), without a token or key diagnostics", async purpose => {
  const w = setup();
  w.deps.signer.publicJwk = async () => ({ ...w.published, rovara_purpose: purpose }) as typeof w.published;
  await expect(mintTaskToken(w.deps, operation)).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: "AUTH_REQUIRED: invalid or expired model access" });
  expect(w.signs()).toBe(0);
});
