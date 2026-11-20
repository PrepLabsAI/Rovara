// The HTTP reader of the gateway's offered-models list (Cloud #72): GET <gateway>/v1/service/companies/<cid>/offered-models with a service token the install's broker signs with its task key.
// The token's shape is the gateway's contract (golden below); the company in the path is the company in the token; every refusal, bad answer and slow answer offers nothing, in fixed words.
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TASK_KEY_PURPOSE, type OrgId } from "@agentx/contracts";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE, taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { CORE_AGENT_MODEL_CHOICE_VARIABLE, OFFERED_MODELS_AUDIENCE, OFFERED_MODELS_READ_FAILED, SERVICE_TOKEN_TYP, offeredModelsReader, offeredModelsReaderFromEnvironment } from "../../packages/broker/src/core-host/offered-models-http.js";
import { hydrateBrokerSettings } from "../../packages/broker/src/aws/broker-environment.js";
import { GATEWAY_OFFERED_MODELS, offeredAnswer } from "../support/offered-models-fake.js";

const ORG_A = "org_offeredhttp00000000a" as OrgId;
const ORG_B = "org_offeredhttp00000000b" as OrgId;
const ISSUER = "https://api.staging.example/v1/auth";
const GATEWAY = "https://gateway.staging.example";
const NOW = 1_800_000_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = pair.publicKey.export({ type: "spki", format: "der" });
const exported = pair.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const KID = createHash("sha256").update(der).digest("base64url").slice(0, 16);
const signing = (overrides: Record<string, unknown> = {}): TokenSigner => ({
  publicJwk: async () => ({ kty: "RSA", n: exported.n, e: exported.e, kid: KID, alg: "RS256", use: "sig", rovara_purpose: TASK_KEY_PURPOSE, ...overrides }) as never,
  sign: async (input) => sign("sha256", input, pair.privateKey),
});
const reader = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof offeredModelsReader>[0]> = {}) => offeredModelsReader({ gatewayUrl: GATEWAY, issuer: ISSUER, signer: signing(), fetch: fetchImpl, now: () => NOW, timeoutMs: 50, ...extra });
const ok = (body: unknown = offeredAnswer(GATEWAY_OFFERED_MODELS)) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;

interface Seen { url: string; init: RequestInit }
function recording(answer: () => Response | Promise<Response> = () => ok()) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => { seen.push({ url: String(url), init: init ?? {} }); return answer(); }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}
const tokenOf = (seen: Seen) => String((seen.init.headers as Record<string, string>)["authorization"]).replace(/^Bearer /u, "");

describe("the request (golden)", () => {

  it("the service token has exactly the header and claims the gateway pins, signed RS256 by the task key", async () => {
    const r = recording();
    await reader(r.fetchImpl).offered(ORG_A);
    const [header, claims, signature] = tokenOf(r.seen[0]!).split(".") as [string, string, string];
    expect(Buffer.from(header, "base64url").toString()).toBe(JSON.stringify({ alg: "RS256", typ: "rovara-service+jwt", kid: KID }));
    const body = decode(claims);
    expect(Object.keys(body)).toEqual(["iss", "aud", "jti", "iat", "nbf", "exp", "cid"]);
    const iat = NOW / 1000;
    expect({ ...body, jti: "<uuid>" }).toEqual({ iss: ISSUER, aud: "rovara-model-gateway-offered-models", jti: "<uuid>", iat, nbf: iat - 30, exp: iat + 60, cid: ORG_A });
    expect(body["jti"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(OFFERED_MODELS_AUDIENCE).toBe("rovara-model-gateway-offered-models");
    expect(SERVICE_TOKEN_TYP).toBe("rovara-service+jwt");
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), pair.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("a company id that is not one is refused before anything is signed or sent", async () => {
    const r = recording();
    const signer = signing();
    const spy = vi.spyOn(signer, "sign");
    for (const bad of ["", "default", "org_x", `${ORG_A}/../${ORG_B}`, `${ORG_A}?x=1`, `${ORG_A}\n`, "ORG_OFFEREDHTTP000000A", 5 as never, undefined as never]) {
      await expect(reader(r.fetchImpl, { signer }).offered(bad), String(bad)).rejects.toThrow(OFFERED_MODELS_READ_FAILED);
    }
    expect(r.seen).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

});

describe("a read that fails offers nothing, in fixed words", () => {
  const refusals: Array<[string, () => Response | Promise<Response>]> = [
    ["a 401", () => new Response("{}", { status: 401 })], ["a 403", () => new Response('{"error":{"code":"x"}}', { status: 403 })], ["a 404", () => new Response("", { status: 404 })],
    ["a 500", () => new Response("secret-gateway-detail", { status: 500 })], ["a 503", () => new Response("", { status: 503 })], ["a 204", () => new Response(null, { status: 204 })],
    ["a 201 with a good body", () => new Response(JSON.stringify(offeredAnswer(GATEWAY_OFFERED_MODELS)), { status: 201 })],
    ["a redirect", () => new Response("", { status: 302, headers: { location: "https://elsewhere.example/" } })],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })], ["a body that is JSON null", () => new Response("null", { status: 200 })],
    ["an empty list", () => ok({ version: 1, models: [] })], ["a wrong version", () => ok({ version: 2, models: [{ model: "claude-sonnet-5-5" }] })],
    ["an extra member", () => ok({ version: 1, models: [{ model: "claude-sonnet-5-5" }], note: "x" })],
    ["a duplicate", () => ok({ version: 1, models: [{ model: "claude-sonnet-5-5" }, { model: "claude-sonnet-5-5" }] })],
    ["a model name with a space", () => ok({ version: 1, models: [{ model: "a b" }] })],
    ["a good body padded over the limit", () => new Response(`${JSON.stringify(offeredAnswer(GATEWAY_OFFERED_MODELS))}${" ".repeat(70_000)}`, { status: 200 })],
    ["a body that declares itself over the limit", () => new Response(JSON.stringify(offeredAnswer(GATEWAY_OFFERED_MODELS)), { status: 200, headers: { "content-length": "70000" } })],
    ["a fetch that throws", () => { throw new Error("connect ECONNREFUSED gateway.internal:443 Bearer abc"); }],
    ["a fetch that never answers", () => new Promise<Response>(() => undefined)],
  ];
  for (const [name, answer] of refusals) {
    it(name, async () => {
      const r = recording(answer);
      const failure = await reader(r.fetchImpl).offered(ORG_A).then(() => undefined, (error: unknown) => error as Error);
      expect(failure?.message).toBe(OFFERED_MODELS_READ_FAILED);
      expect(failure?.message).not.toMatch(/ECONNREFUSED|gateway\.internal|secret-gateway|Bearer|https?:/u);
      expect((failure as { cause?: unknown }).cause).toBeUndefined();
    });
  }

  it("a signer that fails, or a key that is not the task key, sends nothing", async () => {
    const r = recording();
    const bad: TokenSigner[] = [
      { publicJwk: async () => { throw new Error("kms down"); }, sign: async (input) => signing().sign(input) }, { publicJwk: async () => signing().publicJwk(), sign: async () => { throw new Error("kms down"); } },
      signing({ rovara_purpose: "sign-in" }), signing({ rovara_purpose: undefined }), signing({ kid: "short" }), signing({ kid: "has space 123456!" }), signing({ kid: undefined }),
      signing({ kty: "EC" }), signing({ alg: "ES256" }), signing({ use: "enc" }),
    ];
    for (const signer of bad) await expect(reader(r.fetchImpl, { signer }).offered(ORG_A)).rejects.toThrow(OFFERED_MODELS_READ_FAILED);
    expect(r.seen).toEqual([]);
  });

  it("an issuer that cannot fit a token sends nothing", async () => {
    const r = recording();
    const signer = signing();
    const keyRead = vi.spyOn(signer, "publicJwk");
    for (const issuer of ["https://x.example/".padEnd(4_000, "a"), "https://x.example/".padEnd(2_049, "a")]) await expect(reader(r.fetchImpl, { signer, issuer }).offered(ORG_A)).rejects.toThrow(OFFERED_MODELS_READ_FAILED);
    expect(r.seen).toEqual([]);
    // Refused before any key is read.
    expect(keyRead).not.toHaveBeenCalled();
  });
});

describe("the reader from the environment", () => {
  const ENV = { [CORE_MODEL_GATEWAY_URL_VARIABLE]: `${GATEWAY}/`, [CORE_AGENT_MODEL_VARIABLE]: "claude-sonnet-5-5", [CORE_AGENT_MODEL_CHOICE_VARIABLE]: "on" };
  const tokens = () => ({ signer: taskKeySigner(signing({ rovara_purpose: undefined })), issuer: ISSUER });
  it("is none unless the choice is switched on (default off), whatever else is configured", () => {
    for (const value of [undefined, "", "off", "true", "ON", "1", " on"]) {
      const env = { ...ENV, ...(value === undefined ? {} : { [CORE_AGENT_MODEL_CHOICE_VARIABLE]: value }) };
      if (value === undefined) delete (env as Record<string, unknown>)[CORE_AGENT_MODEL_CHOICE_VARIABLE];
      expect(offeredModelsReaderFromEnvironment(env, tokens), String(value)).toBeUndefined();
    }
    expect(offeredModelsReaderFromEnvironment(ENV, tokens)).toBeDefined();
  });
  // Live switches check 2026-11-18: a named install's broker gets the choice only packed (`mx`, the CoreAgentModelChoice stack parameter) beside the gateway settings (`gw`, `am`); unpacked as the
  // broker does at load, it reaches this reader. `off` (the parameter's default) and a missing piece offer no choice.
  it("reaches the reader from the packed settings a named install gets: mx=on builds it, mx=off or no mx does not", () => {
    const unpacked = (settings: string) => { const env: NodeJS.ProcessEnv = { AGENTX_SETTINGS: settings }; hydrateBrokerSettings(env); return env; };
    const gateway = "gw=gateway.staging.example,am=claude-sonnet-5-5";
    expect(unpacked(`${gateway},mx=on`)[CORE_AGENT_MODEL_CHOICE_VARIABLE]).toBe("on");
    expect(offeredModelsReaderFromEnvironment(unpacked(`${gateway},mx=on`), tokens)).toBeDefined();
    expect(offeredModelsReaderFromEnvironment(unpacked(`${gateway},mx=off`), tokens)).toBeUndefined();
    expect(offeredModelsReaderFromEnvironment(unpacked(gateway), tokens)).toBeUndefined();
  });
  it("is none without the gateway settings, with a broken setting, or without the task-token signer", () => {
    expect(offeredModelsReaderFromEnvironment({}, tokens)).toBeUndefined();
    expect(offeredModelsReaderFromEnvironment({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY }, tokens)).toBeUndefined();
    expect(offeredModelsReaderFromEnvironment({ ...ENV, [CORE_MODEL_GATEWAY_URL_VARIABLE]: "http://gateway.example" }, tokens)).toBeUndefined();
    expect(offeredModelsReaderFromEnvironment(ENV, undefined)).toBeUndefined();
    expect(offeredModelsReaderFromEnvironment(ENV, () => undefined)).toBeUndefined();
  });
  it("reads the configured gateway's route with the install's issuer and the task key (the key stamped with purpose `task`)", async () => {
    const r = recording();
    const read = offeredModelsReaderFromEnvironment(ENV, tokens, r.fetchImpl)!;
    expect(read).toBeDefined();
    await read.offered(ORG_B);
    expect(r.seen[0]!.url).toBe(`${GATEWAY}/v1/service/companies/${ORG_B}/offered-models`);
    const claims = decode(tokenOf(r.seen[0]!).split(".")[1]!);
    expect(claims).toMatchObject({ iss: ISSUER, cid: ORG_B, aud: OFFERED_MODELS_AUDIENCE });
  });
});
