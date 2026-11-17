// DEC 254g: `agentx config set coreEngine.agentModel` checks a model other than Claude against the model gateway's LIVE offered-models answer. Only the broker may sign the gateway's
// service token (the task key's policy permits only its role), so the CLI asks the broker's admin read GET /v1/admin/core/offered-models, for the administrator's own company. The
// read needs only the gateway's origin and the task-token signer (not the agent model, which is what is being chosen, nor the choice switch). Every failure is fixed words.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE, CORE_OFFERED_MODELS_ADMIN_PATH, TASK_KEY_PURPOSE, type OfferedAgentModels } from "@agentx/contracts";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { CORE_OFFERED_MODELS_NOT_SET_UP, OFFERED_MODELS_READ_FAILED, adminOfferedModelsFromEnvironment } from "../../packages/broker/src/core-host/offered-models-http.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";
import { GATEWAY_OFFERED_MODELS, offeredAnswer } from "../support/offered-models-fake.js";

const ORG_A = "org_adminoffered0000000a";
const ORG_B = "org_adminoffered0000000b";
const ISSUER = "https://api.staging.example/v1/auth";
const GATEWAY = "https://gateway.staging.example";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const exported = pair.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const KID = createHash("sha256").update(pair.publicKey.export({ type: "spki", format: "der" })).digest("base64url").slice(0, 16);
const signer: TokenSigner = {
  publicJwk: async () => ({ kty: "RSA", n: exported.n, e: exported.e, kid: KID, alg: "RS256", use: "sig", rovara_purpose: TASK_KEY_PURPOSE }) as never,
  sign: async (input) => sign("sha256", input, pair.privateKey),
};
const tokens = () => ({ signer, issuer: ISSUER });

function gateway(answer: (url: string) => Response | Promise<Response> = () => Response.json(offeredAnswer(GATEWAY_OFFERED_MODELS))) {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: unknown) => { urls.push(String(url)); return await answer(String(url)); }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

describe("the admin read of the gateway's offered models (adminOfferedModelsFromEnvironment)", () => {
  it("needs only the gateway's origin: no agent model and no choice switch, and reads the named company's list", async () => {
    const g = gateway();
    const read = adminOfferedModelsFromEnvironment({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY }, tokens, g.fetchImpl);
    expect(read).toBeDefined();
    expect(await read!(ORG_A)).toEqual(offeredAnswer(GATEWAY_OFFERED_MODELS));
    expect(g.urls).toEqual([`${GATEWAY}/v1/service/companies/${ORG_A}/offered-models`]);
  });

  it("is absent without a gateway origin, or with one that is not an https origin", () => {
    for (const env of [{}, { [CORE_MODEL_GATEWAY_URL_VARIABLE]: "" }, { [CORE_MODEL_GATEWAY_URL_VARIABLE]: "http://gateway.staging.example" }, { [CORE_MODEL_GATEWAY_URL_VARIABLE]: "https://u:p@gateway.staging.example" },
      { [CORE_MODEL_GATEWAY_URL_VARIABLE]: "https://gateway.staging.example/path" }, { [CORE_AGENT_MODEL_VARIABLE]: "zai.glm-5" }]) {
      expect(adminOfferedModelsFromEnvironment(env, tokens), JSON.stringify(env)).toBeUndefined();
    }
  });

  it("fails in fixed words without a task-token signer or issuer, for a malformed company, or for any answer that is not the contract", async () => {
    const env = { [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY };
    await expect(adminOfferedModelsFromEnvironment(env, () => undefined)!(ORG_A)).rejects.toThrow(OFFERED_MODELS_READ_FAILED);
    await expect(adminOfferedModelsFromEnvironment(env, () => ({ signer, issuer: "" }))!(ORG_A)).rejects.toThrow(OFFERED_MODELS_READ_FAILED);
    await expect(adminOfferedModelsFromEnvironment(env, () => { throw new Error("kms secret-arn"); })!(ORG_A)).rejects.toThrow(OFFERED_MODELS_READ_FAILED);
    const g = gateway();
    await expect(adminOfferedModelsFromEnvironment(env, tokens, g.fetchImpl)!("org_../../x")).rejects.toThrow(OFFERED_MODELS_READ_FAILED);
    expect(g.urls).toEqual([]);
    for (const answer of [() => Response.json({ version: 1, models: [] }), () => new Response("secret-host", { status: 500 }), () => { throw new TypeError("connect secret-host"); }]) {
      const error = await adminOfferedModelsFromEnvironment(env, tokens, gateway(answer).fetchImpl)!(ORG_A).then(() => undefined, (caught: unknown) => caught as Error);
      expect(error?.message).toBe(OFFERED_MODELS_READ_FAILED);
    }
  });
});

describe(`GET ${CORE_OFFERED_MODELS_ADMIN_PATH}`, () => {
  const companies = (company: string | undefined) => {
    const asked: string[] = [];
    return { asked, linking: { companies: { companyOf: async (person: string) => { asked.push(person); return company; } } } };
  };
  const reads = () => {
    const asked: string[] = [];
    const lists = new Map<string, OfferedAgentModels>([[ORG_A, offeredAnswer(["claude-sonnet-5-5", "zai.glm-5"]) as OfferedAgentModels], [ORG_B, offeredAnswer(["claude-sonnet-5-5"]) as OfferedAgentModels]]);
    return { asked, read: async (company: string) => { asked.push(company); const list = lists.get(company); if (list === undefined) throw new Error("no list for secret-company"); return list; } };
  };

  it("answers the administrator's own company's list, and only that company's", async () => {
    for (const [company, expected] of [[ORG_A, ["claude-sonnet-5-5", "zai.glm-5"]], [ORG_B, ["claude-sonnet-5-5"]]] as const) {
      const people = companies(company);
      const gatewayReads = reads();
      const { handler } = await createAdminBroker({ linking: people.linking as never, coreOfferedModels: gatewayReads.read });
      const answer = await adminCall(handler, { method: "GET", path: CORE_OFFERED_MODELS_ADMIN_PATH });
      expect(answer.status, company).toBe(200);
      expect(answer.body, company).toEqual(offeredAnswer(expected));
      expect(gatewayReads.asked, company).toEqual([company]);
      expect(people.asked.length, company).toBe(1);
    }
  });

  it("is for administrators only, and reads nothing otherwise", async () => {
    const gatewayReads = reads();
    const { handler } = await createAdminBroker({ linking: companies(ORG_A).linking as never, coreOfferedModels: gatewayReads.read });
    expect(await adminCall(handler, { method: "GET", path: CORE_OFFERED_MODELS_ADMIN_PATH, admin: false })).toMatchObject({ status: 403 });
    expect(gatewayReads.asked).toEqual([]);
  });

  it("says the gateway is not set up where the deployment has none (404), so config set can say to set it first", async () => {
    const { handler } = await createAdminBroker({ linking: companies(ORG_A).linking as never });
    expect(await adminCall(handler, { method: "GET", path: CORE_OFFERED_MODELS_ADMIN_PATH })).toMatchObject({ status: 404, body: { error: { message: CORE_OFFERED_MODELS_NOT_SET_UP } } });
    const noCompanies = await createAdminBroker({ coreOfferedModels: reads().read });
    expect(await adminCall(noCompanies.handler, { method: "GET", path: CORE_OFFERED_MODELS_ADMIN_PATH })).toMatchObject({ status: 404 });
  });

  it("a failed read is the fixed words only (fail closed), never the cause", async () => {
    const { handler } = await createAdminBroker({ linking: companies("org_adminoffered0000000c").linking as never, coreOfferedModels: reads().read });
    const answer = await adminCall(handler, { method: "GET", path: CORE_OFFERED_MODELS_ADMIN_PATH });
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).toContain(OFFERED_MODELS_READ_FAILED);
    expect(JSON.stringify(answer.body)).not.toContain("secret");
  });

  it("serves GET only", async () => {
    const gatewayReads = reads();
    const { handler } = await createAdminBroker({ linking: companies(ORG_A).linking as never, coreOfferedModels: gatewayReads.read });
    expect((await adminCall(handler, { method: "POST", path: CORE_OFFERED_MODELS_ADMIN_PATH, body: {} })).status).not.toBe(200);
    expect(gatewayReads.asked).toEqual([]);
  });
});
