import { beforeAll as beforeNetworkTests } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeNetworkTests(denyNetwork);
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TASK_KEY_PURPOSE, TASK_KEY_PURPOSE_MEMBER, TASK_TOKEN_ALGORITHM, TASK_TOKEN_TYPE, TASK_TOKEN_AUDIENCE, TASK_TOKEN_SECONDS, TASK_TOKEN_CLAIMS, parseTaskClaims } from "../../packages/model-gateway/src/model-gateway-token.js";
import { claims, mint, verifier } from "./model-gateway-fixture.js";

describe("TC-1 task tokens", () => {
  it("accepts the runtime RSA vector", async () => { expect(await verifier()(mint())).toEqual(claims); });
  it.each([
    ["aud", { aud: "agentx-developer" }, {}], ["typ", {}, { typ: "JWT" }], ["none", {}, { alg: "none" }], ["HS256", {}, { alg: "HS256" }], ["lifetime", { exp: claims.iat + 901 }, {}], ["unknown claim", { extra: "secret" }, {}], ["cid", { cid: undefined }, {}], ["models", { mdl: [] }, {}], ["crit", {}, { crit: [] }], ["expired", { iat: claims.iat - 1000, nbf: claims.nbf - 1000, exp: claims.exp - 1000 }, {}], ["future", { nbf: claims.iat + 31 }, {}], ["kid", {}, { kid: "developer-key" }], ["install", { iss: "https://untrusted.example/v1/auth" }, {}], ["enum", { src: "surprise" }, {}], ["payer", { pay: { kind: "member", developerId: "wrong" } }, {}], ["wrong type", { iat: "1800000000" }, {}], ["header URL", {}, { jku: "https://untrusted.example" }], ["negative lifetime", { exp: claims.iat - 1 }, {}],
  ])("rejects %s with the same result", async (_name, changes, header) => { expect(await verifier()(mint(changes as Record<string, unknown>, header as Record<string, unknown>))).toBeUndefined(); });
  it("rejects altered signatures and malformed/oversize input without throwing", async () => { for (const token of [mint().slice(0, -10), "x", "x".repeat(6000), "a.b.c"]) expect(await verifier()(token)).toBeUndefined(); });
  it("validates every required claim and payer variant at runtime", () => {
    for (const field of TASK_TOKEN_CLAIMS.filter((c) => c.required)) expect(parseTaskClaims({ ...claims, [field.name]: undefined })).toBeUndefined();
    expect(parseTaskClaims({ ...claims, per: undefined })).toBeDefined();
    for (const pay of [{ kind: "project", project: "web" }, { kind: "chain", chainId: `chn_${"a".repeat(20)}` }, { kind: "agent", agentId: "rovara-code" }]) expect(parseTaskClaims({ ...claims, pay })).toBeDefined();
  });
  it("agrees byte for byte with the shared contract and pins its digest", () => {
    const bytes = readFileSync("contracts/shared/model-gateway-token.v1.json");
    const contract = JSON.parse(bytes.toString()) as { constants: unknown; claims: unknown; testVector: { header: unknown; claims: { runPrice?: unknown }; expectedVerifyResult: boolean } };
    expect(contract.constants).toEqual({ typ: TASK_TOKEN_TYPE, aud: TASK_TOKEN_AUDIENCE, alg: TASK_TOKEN_ALGORITHM, lifetime: TASK_TOKEN_SECONDS, keyPurpose: TASK_KEY_PURPOSE, keyPurposeMember: TASK_KEY_PURPOSE_MEMBER });
    expect(contract.claims).toEqual(TASK_TOKEN_CLAIMS);
    expect(contract.testVector.claims.runPrice).toBeDefined();
    expect(parseTaskClaims(contract.testVector.claims)).toBeDefined();
    expect(contract.testVector.expectedVerifyResult).toBe(true);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("3543671eb6c61e7a621b98320e43dd730e1ae5a58cceb4c3bc710e294cde3d97");
  });
});
it("rejects a valid RSA signature from a JWKS key that is not the pinned task key", async () => {
  const { createTaskTokenVerifier } = await import("../../packages/model-gateway/src/token.js");
  const { StaticInstallRegistry } = await import("../../packages/model-gateway/src/installs.js");
  const { jwk, now } = await import("./model-gateway-fixture.js");
  const verify = createTaskTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: claims.iss, jwksUrl: `${claims.iss}/.well-known/jwks.json`, taskKids: ["different-task-kid"] }]), readJwks: async () => [jwk], now: () => now });
  expect(await verify(mint())).toBeUndefined();
});
it("accepts the shared JSON vector signed by an injected runtime signer", async () => {
  const { kid, keys } = await import("./model-gateway-fixture.js");
  const { sign } = await import("node:crypto");
  const vector = (JSON.parse(readFileSync("contracts/shared/model-gateway-token.v1.json", "utf8")) as { testVector: { header: Record<string, unknown>; claims: Record<string, unknown> } }).testVector;
  const signer = { kid, sign: (input: Uint8Array) => sign("RSA-SHA256", input, keys.privateKey) };
  const input = [JSON.stringify({ ...vector.header, kid: signer.kid }), JSON.stringify(vector.claims)].map((p) => Buffer.from(p).toString("base64url")).join(".");
  expect(await verifier()(`${input}.${signer.sign(Buffer.from(input)).toString("base64url")}`)).toEqual(vector.claims);
});
it("ADDENDUM-2 accepts absent src but still rejects an unknown origin", async () => {
  const { src: _origin, ...withoutOrigin } = claims; void _origin;
  expect(await verifier()(mint({ src: undefined }))).toEqual(withoutOrigin);
  expect(await verifier()(mint({ src: "unknown" }))).toBeUndefined();
});
it("ADDENDUM-4 requires task purpose even for a matching pinned RSA kid", async () => {
  const { createTaskTokenVerifier } = await import("../../packages/model-gateway/src/token.js");
  const { StaticInstallRegistry } = await import("../../packages/model-gateway/src/installs.js");
  const { jwk, kid, now, call, setup } = await import("./model-gateway-fixture.js");
  const registry = new StaticInstallRegistry([{ issuer: claims.iss, jwksUrl: `${claims.iss}/.well-known/jwks.json`, taskKids: [kid] }]);
  // Same valid signature/kid throughout: purpose is the only changed field.
  for (const purpose of ["task", "developer", undefined, "secret-purpose", null, 1, {}]) {
    const verify = createTaskTokenVerifier({ registry, readJwks: async () => [{ ...jwk, rovara_purpose: purpose }], now: () => now });
    if (purpose === "task") { expect(await verify(mint())).toEqual(claims); continue; }
    expect(await verify(mint())).toBeUndefined();
    const f = setup({ verifyToken: verify }); const r = await call(f.deps);
    expect(r.status).toBe(401); expect(r.text()).toBe('{"error":{"type":"authentication_error","message":"invalid or expired model access"}}'); expect(f.calls).toHaveLength(0);
    expect(JSON.stringify(f.logs)).not.toContain("secret-purpose");
  }
});
