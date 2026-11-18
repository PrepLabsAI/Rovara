// DEC 254g: `agentx config set coreEngine.agentModel` checks a model other than Claude against the model gateway's LIVE offered-models answer. Only the broker may sign the gateway's
// service token (the task key's policy permits only its role), so the CLI asks the broker's admin read GET /v1/admin/core/offered-models, for the administrator's own company. The
// read needs only the gateway's origin and the task-token signer (not the agent model, which is what is being chosen, nor the choice switch). Every failure is fixed words.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE, CORE_OFFERED_MODELS_ADMIN_PATH, TASK_KEY_PURPOSE, type OfferedAgentModels } from "@agentx/contracts";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { CORE_OFFERED_MODELS_NOT_SET_UP, OFFERED_MODELS_READ_FAILED, adminOfferedModelsFromEnvironment } from "../../packages/broker/src/core-host/offered-models-http.js";
import { requireGatewayOffers } from "../../packages/cli/src/config/gateway-offered.js";
import { OFFERED_MODELS_NAME_A_COMPANY, OFFERED_MODELS_UNKNOWN_COMPANY } from "../../packages/broker/src/aws/admin-offered-models.js";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { adminCall, createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
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
      expect(answer.body, company).toMatchObject(offeredAnswer(expected));
      expect(Object.keys(answer.body).sort(), company).toEqual(["models", "requestId", "version"]);
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
    // P0-14: a deployment with no company layer has no membership to fall back on, so the operator is told to name the company (400), not that the gateway is missing.
    const noCompanies = await createAdminBroker({ coreOfferedModels: reads().read });
    expect(await adminCall(noCompanies.handler, { method: "GET", path: CORE_OFFERED_MODELS_ADMIN_PATH })).toMatchObject({ status: 400, body: { error: { message: OFFERED_MODELS_NAME_A_COMPANY } } });
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

describe("config set's live check, end to end through the broker's admin read and the gateway's offered-models answer", () => {
  const SESSION = { controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "admin-token-for-tests" };
  /** The CLI's fetch, into the broker in process as the administrator. */
  const brokerFetch = (handler: AdminHandler) => (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const answer = await adminCall(handler, { method: init?.method ?? "GET", path: url.pathname });
    return Response.json(answer.body, { status: answer.status });
  }) as typeof fetch;
  const broker = async (offered: readonly string[] | "down") => {
    const g = gateway(() => (offered === "down" ? new Response("", { status: 502 }) : Response.json(offeredAnswer(offered))));
    const read = adminOfferedModelsFromEnvironment({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY }, tokens, g.fetchImpl)!;
    const { handler } = await createAdminBroker({ linking: { companies: { companyOf: async () => ORG_A } } as never, coreOfferedModels: read });
    return { handler, urls: g.urls };
  };
  const check = (handler: AdminHandler, value: string) => requireGatewayOffers({ key: "coreEngine.agentModel", env: "staging", value, session: SESSION, fetch: brokerFetch(handler) });

  it("accepts a GLM id the gateway offers this company, reading the company's own list", async () => {
    const { handler, urls } = await broker(GATEWAY_OFFERED_MODELS);
    await expect(check(handler, "zai.glm-5")).resolves.toBeUndefined();
    expect(urls).toEqual([`${GATEWAY}/v1/service/companies/${ORG_A}/offered-models`]);
  });

  it("refuses an id the gateway does not offer", async () => {
    const { handler } = await broker(["claude-sonnet-5-5", "zai.glm-4.7"]);
    await expect(check(handler, "zai.glm-5")).rejects.toThrow("coreEngine.agentModel was not changed: the model gateway does not offer zai.glm-5 to this company; it offers zai.glm-4.7, claude-sonnet-5-5; nothing changed");
  });

  it("fails closed when the gateway does not answer", async () => {
    const { handler } = await broker("down");
    await expect(check(handler, "zai.glm-5")).rejects.toThrow("the models the model gateway offers could not be read just now, so zai.glm-5 could not be checked; nothing changed, try again");
  });

  it("says to set the gateway first where the broker has none", async () => {
    const { handler } = await createAdminBroker({ linking: { companies: { companyOf: async () => ORG_A } } as never });
    await expect(check(handler, "zai.glm-5")).rejects.toThrow("set coreEngine.modelGatewayUrl first");
  });
});

// P0-14 (live test 0.5.28): the install's operator signs in with no Code company membership. The route used to resolve only the operator's OWN company, which threw AUTH_REQUIRED
// ("your AgentX sign-in has ended") although the same sign-in read /v1/admin/company-invites, and config set looped on "login --admin". Now the operator names the company.
describe(`GET ${CORE_OFFERED_MODELS_ADMIN_PATH} for an operator in no company (P0-14)`, () => {
  const SIGN_IN_TABLE = "signin";
  const lists = new Map<string, OfferedAgentModels>([[ORG_A, offeredAnswer(["claude-sonnet-5-5", "zai.glm-5"]) as OfferedAgentModels], [ORG_B, offeredAnswer(["claude-sonnet-5-5"]) as OfferedAgentModels],
    [IMPLICIT_COMPANY_ID, offeredAnswer(["claude-sonnet-5-5", "zai.glm-4.7"]) as OfferedAgentModels]]);
  /** Code's company records for ORG_A and ORG_B, an operator with no membership (`member` undefined) and the gateway's per-company lists. */
  const world = async (member: string | undefined = undefined, options: { companyLayer?: boolean } = {}) => {
    const asked: string[] = [];
    const membershipAsked: string[] = [];
    const companies = { companyOf: async (person: string) => { membershipAsked.push(person); return member; } };
    const broker = await createAdminBroker({
      linking: { ...(options.companyLayer === false ? {} : { companies }), signInTableName: SIGN_IN_TABLE } as never,
      coreOfferedModels: async (company: string) => { asked.push(company); const list = lists.get(company); if (list === undefined) throw new Error("no list for secret-company"); return list; },
    });
    for (const companyId of [ORG_A, ORG_B]) {
      broker.db.set({ pk: `ORG#${companyId}#COMPANY`, sk: "META", entityType: "COMPANY", companyId, name: `Company ${companyId.slice(-1)}`, status: "active", createdAt: "2026-11-01T00:00:00.000Z", createdBy: "operator" });
    }
    return { ...broker, asked, membershipAsked };
  };
  const named = (company: string) => `${CORE_OFFERED_MODELS_ADMIN_PATH}?companyId=${encodeURIComponent(company)}`;

  it("answers 200 with the named company's list, and only that company's, without reading the operator's membership", async () => {
    for (const [company, expected] of [[ORG_A, ["claude-sonnet-5-5", "zai.glm-5"]], [ORG_B, ["claude-sonnet-5-5"]], [IMPLICIT_COMPANY_ID, ["claude-sonnet-5-5", "zai.glm-4.7"]]] as const) {
      const w = await world();
      const answer = await adminCall(w.handler, { method: "GET", path: named(company) });
      expect(answer.status, company).toBe(200);
      expect(answer.body, company).toMatchObject(offeredAnswer(expected));
      expect(w.asked, company).toEqual([company]);
      expect(w.membershipAsked, company).toEqual([]);
    }
  });

  it("an operator who IS a member of A may still name B (the agent model is the install's), and gets B's list, not A's", async () => {
    const w = await world(ORG_A);
    const answer = await adminCall(w.handler, { method: "GET", path: named(ORG_B) });
    expect(answer).toMatchObject({ status: 200, body: offeredAnswer(["claude-sonnet-5-5"]) });
    expect(w.asked).toEqual([ORG_B]);
  });

  it("without a named company, an operator in no company is told to name one (400), never AUTH_REQUIRED, and nothing is read from the gateway", async () => {
    for (const member of [undefined, "not-a-company", ""]) {
      const w = await world(member);
      const answer = await adminCall(w.handler, { method: "GET", path: CORE_OFFERED_MODELS_ADMIN_PATH });
      expect(answer, String(member)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: OFFERED_MODELS_NAME_A_COMPANY } } });
      expect(w.asked, String(member)).toEqual([]);
    }
  });

  it("without a named company, a member operator still gets its own company's list", async () => {
    const w = await world(ORG_B);
    expect(await adminCall(w.handler, { method: "GET", path: CORE_OFFERED_MODELS_ADMIN_PATH })).toMatchObject({ status: 200, body: offeredAnswer(["claude-sonnet-5-5"]) });
    expect(w.asked).toEqual([ORG_B]);
  });

  it("refuses an unknown, malformed or repeated company with one clear fixed 400, never echoing it, and reads nothing from the gateway", async () => {
    const unknown = "org_unknowncompany000000";
    for (const query of [`companyId=${unknown}`, "companyId=org_..%2F..%2Fx", "companyId=", "companyId=ORG_ADMINOFFERED0000000A", `companyId=${ORG_A}&companyId=${ORG_B}`, `companyId=${ORG_A}%20`]) {
      const w = await world();
      const answer = await adminCall(w.handler, { method: "GET", path: `${CORE_OFFERED_MODELS_ADMIN_PATH}?${query}` });
      expect(answer, query).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: OFFERED_MODELS_UNKNOWN_COMPANY } } });
      expect(JSON.stringify(answer.body), query).not.toContain("unknowncompany");
      expect(w.asked, query).toEqual([]);
    }
  });

  it("a stored row under the company's key that is not that company's record is not a company", async () => {
    const w = await world();
    w.db.set({ pk: `ORG#${ORG_A}#COMPANY`, sk: "META", entityType: "COMPANY", companyId: ORG_B, name: "Drift", status: "active", createdAt: "2026-11-01T00:00:00.000Z", createdBy: "operator" });
    expect(await adminCall(w.handler, { method: "GET", path: named(ORG_A) })).toMatchObject({ status: 400 });
    expect(w.asked).toEqual([]);
  });

  it("only the built-in company is known where developer sign-in (Code's company records) is not set up", async () => {
    const { handler } = await createAdminBroker({ coreOfferedModels: async (company: string) => lists.get(company)! });
    expect(await adminCall(handler, { method: "GET", path: named(IMPLICIT_COMPANY_ID) })).toMatchObject({ status: 200 });
    expect(await adminCall(handler, { method: "GET", path: named(ORG_A) })).toMatchObject({ status: 400 });
  });

  it("a named company works with the company layer off, too", async () => {
    const w = await world(undefined, { companyLayer: false });
    expect(await adminCall(w.handler, { method: "GET", path: named(ORG_A) })).toMatchObject({ status: 200 });
  });

  it("a failed company-record read is the fixed read failure (503), never the cause", async () => {
    const w = await world();
    w.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk?: string } | undefined)?.pk === `ORG#${ORG_A}#COMPANY`, error: { name: "InternalServerError", message: "secret-table broke" } });
    const answer = await adminCall(w.handler, { method: "GET", path: named(ORG_A) });
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).toContain(OFFERED_MODELS_READ_FAILED);
    expect(JSON.stringify(answer.body)).not.toContain("secret");
    expect(w.asked).toEqual([]);
  });

  it("a membership read that fails keeps the fixed sign-in refusal (fail closed)", async () => {
    const { handler } = await createAdminBroker({ linking: { companies: { companyOf: async () => { throw new Error("secret-table"); } }, signInTableName: SIGN_IN_TABLE } as never, coreOfferedModels: async () => { throw new Error("must not be read"); } });
    const answer = await adminCall(handler, { method: "GET", path: CORE_OFFERED_MODELS_ADMIN_PATH });
    expect(answer.status).toBe(401);
    expect(JSON.stringify(answer.body)).not.toContain("secret");
  });

  it("is never looser for a non-administrator: refused (403) for a named company or none, and nothing is read", async () => {
    for (const path of [named(ORG_A), named(IMPLICIT_COMPANY_ID), CORE_OFFERED_MODELS_ADMIN_PATH]) {
      const w = await world(ORG_A);
      expect(await adminCall(w.handler, { method: "GET", path, admin: false }), path).toMatchObject({ status: 403 });
      expect(w.asked, path).toEqual([]);
      expect(w.membershipAsked, path).toEqual([]);
    }
  });

  it("config set, end to end through the broker as an operator in no company: --company is checked against that company's list; without it, a clear way out", async () => {
    const SESSION = { controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "admin-token-for-tests" };
    const g = gateway((url) => Response.json(offeredAnswer(url.includes(ORG_A) ? ["claude-sonnet-5-5", "zai.glm-5"] : ["claude-sonnet-5-5", "zai.glm-4.7"])));
    const read = adminOfferedModelsFromEnvironment({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY }, tokens, g.fetchImpl)!;
    const broker = await createAdminBroker({ linking: { companies: { companyOf: async () => undefined }, signInTableName: SIGN_IN_TABLE } as never, coreOfferedModels: read });
    broker.db.set({ pk: `ORG#${ORG_A}#COMPANY`, sk: "META", entityType: "COMPANY", companyId: ORG_A, name: "A", status: "active", createdAt: "2026-11-01T00:00:00.000Z", createdBy: "operator" });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const answer = await adminCall(broker.handler, { method: init?.method ?? "GET", path: `${url.pathname}${url.search}` });
      return Response.json(answer.body, { status: answer.status });
    }) as typeof fetch;
    const check = (value: string, company?: string) => requireGatewayOffers({ key: "coreEngine.agentModel", env: "staging", value, session: SESSION, fetch: fetchImpl, ...(company === undefined ? {} : { company }) });
    await expect(check("zai.glm-5", ORG_A)).resolves.toBeUndefined();
    expect(g.urls).toEqual([`${GATEWAY}/v1/service/companies/${ORG_A}/offered-models`]);
    await expect(check("zai.glm-5", IMPLICIT_COMPANY_ID)).rejects.toThrow("the model gateway does not offer zai.glm-5 to this company; it offers zai.glm-4.7, claude-sonnet-5-5; nothing changed");
    await expect(check("zai.glm-5")).rejects.toThrow("coreEngine.agentModel was not changed: this computer's admin sign-in for staging is not a member of a company, so name the company whose offered models to check: agentx --env staging config set coreEngine.agentModel zai.glm-5 --company <company id>; nothing changed");
    await expect(check("zai.glm-5", "org_unknowncompany000000")).rejects.toThrow("coreEngine.agentModel was not changed: org_unknowncompany000000 is not one of the companies on staging, so zai.glm-5 cannot be checked for it");
    const before = g.urls.length;
    await expect(check("zai.glm-5", "org_../x")).rejects.toThrow("--company must be a company id (org_ and 20 lowercase letters or digits); nothing changed");
    expect(g.urls).toHaveLength(before);
    // Never the old loop: none of these says to log in again.
    for (const company of [undefined, "org_unknowncompany000000"]) {
      const error = await check("zai.glm-5", company).then(() => undefined, (caught: unknown) => caught as Error);
      expect(error?.message, String(company)).not.toContain("login --admin");
    }
  });
});
