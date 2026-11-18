// Lead 4 L4-HW2: the hosted lessons' learning port (core-host/hosted-learning.ts) over the gateway's learning route. An injected fetch stands in for the gateway; nothing reaches a network and no key exists.
// What is proved: the token names ONLY the learning step and the port's own company; the company is never a call's argument; every "unknown" (no gateway, no signer, a non-Claude agent model, no project, another
// company's workspace) is a refusal with nothing sent; a gateway pause is a fixed code and nothing is echoed; two companies never share a token.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CORE_LEARNING_MODEL_DEFAULT, CORE_LEARNING_MODEL_VARIABLE, TaskTokenClaimsSchema, type OrgId } from "@agentx/contracts";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE, taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { hostedLessonsLearning, worstCaseUsd } from "../../packages/broker/src/core-host/hosted-learning.js";
import { COMPANY_LEARNING_MODEL_ENTITY, companyLearningModelKey, installLearningModel } from "../../packages/broker/src/core-host/company-learning-model.js";
import { LEARNING_CALL_FAILED, LEARNING_CALL_STEP, LEARNING_MESSAGES_PATH, LEARNING_PAUSE_HEADER, LEARNING_NOT_AVAILABLE } from "../../packages/broker/src/lessons/gateway-learning.js";
import { isLearningRefusal } from "../../packages/broker/src/lessons/pause.js";

const ORG_A = "org_hwlearning000000a000" as OrgId;
const ORG_B = "org_hwlearning000000b000" as OrgId;
const ISSUER = "https://api.staging.example/v1/auth";
const GATEWAY = "https://gateway.staging.example";
const MODEL = "claude-sonnet-5";
const NOW = 1_800_000_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = pair.publicKey.export({ type: "spki", format: "der" });
const exported = pair.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const KID = createHash("sha256").update(der).digest("base64url").slice(0, 16);
const bareKey = (): TokenSigner => ({
  publicJwk: async () => ({ kty: "RSA", n: exported.n, e: exported.e, kid: KID, alg: "RS256", use: "sig" }) as never,
  sign: async (input) => sign("sha256", input, pair.privateKey),
});
const tokens = () => ({ signer: taskKeySigner(bareKey()), issuer: ISSUER });
// DEC 254zzz58: the learning model is its own setting (these cases set it; the agent model is irrelevant to learning, see "the learning model").
const ENV = { [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY, [CORE_AGENT_MODEL_VARIABLE]: MODEL, [CORE_LEARNING_MODEL_VARIABLE]: MODEL };

const reply = (headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ model: MODEL, content: [{ type: "text", text: "{\"candidates\":[]}" }], usage: { input_tokens: 900, output_tokens: 40 } }), { status: 200, headers: { "content-type": "application/json", ...headers } });
const refusal = (status: number, type: string, reason?: string) =>
  new Response(JSON.stringify({ error: { type, message: "gateway words that must never be echoed sk-ant-secret" } }), { status, headers: { "content-type": "application/json", ...(reason === undefined ? {} : { [LEARNING_PAUSE_HEADER]: reason }) } });

interface Seen { url: string; init: RequestInit }
function recording(answer: (n: number) => Response | Promise<Response> = () => reply()) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => { seen.push({ url: String(url), init: init ?? {} }); return answer(seen.length - 1); }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}
const tokenOf = (seen: Seen) => (seen.init.headers as Record<string, string>)["x-api-key"]!;
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
const call = (companyId: string, over: Record<string, unknown> = {}) =>
  ({ purpose: "reflect" as const, system: "fixed rules", user: "the task, framed as data", maxOutputTokens: 1_500, workspaceId: companyId, project: "payments", budgetUsd: 0.15, ...over });
const factory = (fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = ENV, signerTokens: Parameters<typeof hostedLessonsLearning>[1] = tokens) =>
  hostedLessonsLearning(env, signerTokens, { fetch: fetchImpl, now: () => NOW, timeoutMs: 500 });
const refusedWith = async (action: Promise<unknown>) => {
  const error = await action.then(() => undefined, (caught: unknown) => caught);
  expect(isLearningRefusal(error)).toBe(true);
  return (error as { code: string; message: string });
};

describe("the per-call cap is Code's (the gateway reads no budget)", () => {
  it("worst case = every prompt byte as one input token + every output token, from the catalog's list prices, rounded up (claude-sonnet-5: $2 in, $10 out, $2.5 cache write per million)", () => {
    expect(worstCaseUsd(MODEL, { system: "a".repeat(1_000), user: "b".repeat(9_000), maxOutputTokens: 1_800 })).toBeCloseTo(((10_000 + 256) * 2.5 + 1_800 * 10) / 1_000_000, 6);
    // Multi-byte text counts by bytes, never fewer.
    expect(worstCaseUsd(MODEL, { system: "", user: "é".repeat(100), maxOutputTokens: 1 })).toBeCloseTo(((200 + 256) * 2.5 + 10) / 1_000_000, 6);
    expect(worstCaseUsd("claude-not-a-model-9", { system: "", user: "x", maxOutputTokens: 10 })).toBeUndefined();
    expect(worstCaseUsd(MODEL, { system: "", user: "x", maxOutputTokens: 0 })).toBeUndefined();
  });

  it("an ordinary full-size reflector call (a ~1.7 KB system text, 27 KB of input, 1,800 output tokens) fits Public's $0.15 per-task cap on claude-sonnet-5", async () => {
    const port = factory(recording().fetchImpl)(ORG_A)!;
    const quoted = await port.model.quote!({ ...call(ORG_A), system: "s".repeat(1_700), user: "u".repeat(27_000), maxOutputTokens: 1_800, maxHoldUsd: 0.15 });
    expect(quoted.ok).toBe(true);
    expect(quoted.ok ? quoted.usd : 1).toBeLessThan(0.15);
  });

  it("the cap and the admitted amount are separate locks: a call above its cap is refused even when it was admitted for more, and a call with no cap is judged by the amount alone; a quote with no cap is the worst case", async () => {
    const r = recording();
    const port = factory(r.fetchImpl)(ORG_A)!;
    const big = { user: "x".repeat(60_000) };
    expect((await refusedWith(port.model.complete(call(ORG_A, { ...big, maxHoldUsd: 0.01, budgetUsd: 5 })))).code).toBe("cost_too_high");
    expect((await refusedWith(port.model.complete(call(ORG_A, { ...big, budgetUsd: 0.01 })))).code).toBe("cost_too_high");
    expect(r.seen).toEqual([]);
    expect(await port.model.quote!({ ...call(ORG_A), ...big })).toEqual({ ok: true, usd: worstCaseUsd(MODEL, { ...call(ORG_A), ...big }) });
    // A quote exactly equal to the cap is allowed (the cap is a ceiling, not an exclusive bound).
    const exact = worstCaseUsd(MODEL, call(ORG_A))!;
    expect(await port.model.quote!({ ...call(ORG_A), maxHoldUsd: exact })).toEqual({ ok: true, usd: exact });
  });

  it("quote answers the worst case, or why not: another company's workspace, a call above its cap, a model nobody priced", async () => {
    const r = recording();
    const port = factory(r.fetchImpl)(ORG_A)!;
    const request = { ...call(ORG_A), maxHoldUsd: 0.15 };
    expect(await port.model.quote!(request)).toEqual({ ok: true, usd: worstCaseUsd(MODEL, request) });
    expect(await port.model.quote!({ ...request, maxHoldUsd: 0.000001 })).toEqual({ ok: false, code: "cost_too_high" });
    expect(await port.model.quote!({ ...request, user: "x".repeat(200_000) })).toEqual({ ok: false, code: "cost_too_high" });
    expect(await port.model.quote!({ ...request, workspaceId: ORG_B })).toEqual({ ok: false, code: "no_provider" });
    const unpriced = factory(r.fetchImpl, { ...ENV, [CORE_LEARNING_MODEL_VARIABLE]: "claude-not-a-model-9" })(ORG_A)!;
    expect(await unpriced.model.quote!(request)).toEqual({ ok: false, code: "no_suitable_model" });
    expect(r.seen).toEqual([]);
  });

  it("a call above its cap, above the amount it was admitted for, or on a model nobody priced is refused BEFORE any token is minted: nothing is sent", async () => {
    const r = recording();
    const port = factory(r.fetchImpl)(ORG_A)!;
    const big = { user: "x".repeat(200_000) };
    expect((await refusedWith(port.model.complete(call(ORG_A, { ...big, maxHoldUsd: 0.15 })))).code).toBe("cost_too_high");
    expect((await refusedWith(port.model.complete(call(ORG_A, { ...big, budgetUsd: 0.15 })))).code).toBe("cost_too_high");
    expect((await refusedWith(port.model.complete(call(ORG_A, { budgetUsd: 0.000001 })))).code).toBe("cost_too_high");
    const unpriced = factory(r.fetchImpl, { ...ENV, [CORE_LEARNING_MODEL_VARIABLE]: "claude-not-a-model-9" })(ORG_A)!;
    expect((await refusedWith(unpriced.model.complete(call(ORG_A)))).code).toBe("no_suitable_model");
    expect(r.seen).toEqual([]);
    // Exactly the quoted amount is allowed: the call a quote admitted goes through.
    const request = { ...call(ORG_A), maxHoldUsd: 0.15 };
    const quoted = await port.model.quote!(request);
    await port.model.complete({ ...request, budgetUsd: quoted.ok ? quoted.usd : 0 });
    expect(r.seen).toHaveLength(1);
  });
});

describe("the request (golden)", () => {
  it("is one Anthropic Messages POST to /v1/learning/messages with a learning token of the company's own, tool-less, and the answer is the text", async () => {
    const r = recording();
    const port = factory(r.fetchImpl)(ORG_A)!;
    const out = await port.model.complete(call(ORG_A));
    expect(out).toMatchObject({ text: "{\"candidates\":[]}", model: MODEL, costUsd: 0.15 });
    expect(r.seen).toHaveLength(1);
    const { url, init } = r.seen[0]!;
    expect(url).toBe(`${GATEWAY}${LEARNING_MESSAGES_PATH}`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(Object.keys(init.headers as object).sort()).toEqual(["anthropic-version", "content-type", "x-api-key"]);
    expect(JSON.parse(init.body as string)).toEqual({ model: MODEL, max_tokens: 1_500, system: "fixed rules", messages: [{ role: "user", content: "the task, framed as data" }] });
    expect(init.body as string).not.toMatch(/tools|stream|api_key/u);
  });

  it("the token is a task token of the LEARNING step only: this company and project, paid by the project, one model, no person, a fresh id every call", async () => {
    const r = recording();
    const port = factory(r.fetchImpl)(ORG_A)!;
    await port.model.complete(call(ORG_A));
    await port.model.complete(call(ORG_A));
    const first = claimsOf(tokenOf(r.seen[0]!));
    const second = claimsOf(tokenOf(r.seen[1]!));
    expect(TaskTokenClaimsSchema.safeParse(first).success).toBe(true);
    expect(first).toMatchObject({ cid: ORG_A, pid: "payments", pay: { kind: "project", project: "payments" }, stp: LEARNING_CALL_STEP, mdl: [MODEL], iss: ISSUER, aud: "rovara-model-gateway" });
    expect(first).not.toHaveProperty("per");
    expect(first).not.toHaveProperty("src");
    expect(String(first.tid)).toMatch(/^learning:[0-9a-f-]{36}$/u);
    expect(second.jti).not.toBe(first.jti);
    expect(second.tid).not.toBe(first.tid);
    expect(LEARNING_CALL_STEP).toBe("rovara-lessons-learning-call");
  });

  it("the spend look always answers ok: the gateway holds the company's learning limit and is the one place that decides", async () => {
    const port = factory(recording().fetchImpl)(ORG_A)!;
    expect(await port.spend.admit(ORG_A, 0.15)).toBe(true);
    expect(await port.spend.look!(ORG_A, 0.15)).toBe("ok");
  });
});

describe("two companies through the one deployment", () => {
  it("never share a token: each port's token names its own company, whatever order the calls come in", async () => {
    const r = recording();
    const make = factory(r.fetchImpl);
    const a = make(ORG_A)!;
    const b = make(ORG_B)!;
    await b.model.complete(call(ORG_B));
    await a.model.complete(call(ORG_A));
    expect(r.seen.map((seen) => claimsOf(tokenOf(seen)).cid)).toEqual([ORG_B, ORG_A]);
  });

  it("a port refuses a call for another company's workspace: no token, nothing sent", async () => {
    const r = recording();
    const a = factory(r.fetchImpl)(ORG_A)!;
    const refused = await refusedWith(a.model.complete(call(ORG_B)));
    expect(refused.code).toBe("no_provider");
    expect(refused.message).toBe(LEARNING_NOT_AVAILABLE);
    expect(r.seen).toEqual([]);
  });
});

describe("unknown is refusal: nothing is sent and nothing is spent", () => {
  it("a call with no project, or a project that is not a name, gets no token", async () => {
    const r = recording();
    const port = factory(r.fetchImpl)(ORG_A)!;
    for (const project of [undefined, "", "has space", "../x", "a".repeat(200), 7 as never]) {
      const over = project === undefined ? { project: undefined } : { project };
      expect((await refusedWith(port.model.complete(call(ORG_A, over)))).code, String(project)).toBe("no_provider");
    }
    expect(r.seen).toEqual([]);
  });

  it("no port without the gateway's settings, a signer and issuer, a learning model that is a Claude engine name when set, and a well-formed company", () => {
    const r = recording();
    expect(factory(r.fetchImpl, {})(ORG_A)).toBeUndefined();
    expect(factory(r.fetchImpl, { [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY })(ORG_A)).toBeUndefined();
    expect(factory(r.fetchImpl, { ...ENV, [CORE_MODEL_GATEWAY_URL_VARIABLE]: "http://gateway.example" })(ORG_A)).toBeUndefined();
    for (const learning of ["zai.glm-5", "us.anthropic.claude-sonnet-4-6-v1:0", "Claude-sonnet-5", "claude-", `claude-${"m".repeat(40)}`]) {
      expect(factory(r.fetchImpl, { ...ENV, [CORE_LEARNING_MODEL_VARIABLE]: learning })(ORG_A), learning).toBeUndefined();
    }
    expect(hostedLessonsLearning(ENV, undefined, { fetch: r.fetchImpl })(ORG_A)).toBeUndefined();
    expect(factory(r.fetchImpl, ENV, () => undefined)(ORG_A)).toBeUndefined();
    expect(factory(r.fetchImpl, ENV, () => ({ signer: taskKeySigner(bareKey()), issuer: "" }))(ORG_A)).toBeUndefined();
    expect(factory(r.fetchImpl, ENV, () => { throw new Error("no keys"); })(ORG_A)).toBeUndefined();
    expect(factory(r.fetchImpl)("not-a-company")).toBeUndefined();
    expect(r.seen).toEqual([]);
  });

  it("a signer that is not the task key (wrong purpose) mints nothing: the call is refused and nothing is sent", async () => {
    const r = recording();
    const port = factory(r.fetchImpl, ENV, () => ({ signer: bareKey(), issuer: ISSUER }))(ORG_A)!;
    await refusedWith(port.model.complete(call(ORG_A)));
    expect(r.seen).toEqual([]);
  });
});

describe("what the gateway refuses", () => {
  it("a company with no connected account, no room or lessons off at the gateway is a pause with the gateway's fixed code, and nothing the gateway sent is echoed", async () => {
    for (const [status, reason] of [[403, "no_provider"], [422, "monthly_limit"], [422, "no_budget"], [422, "cost_too_high"], [403, "lessons_off"], [403, "something_new"]] as const) {
      const r = recording(() => refusal(status, "lessons_paused", reason));
      const port = factory(r.fetchImpl)(ORG_A)!;
      const refused = await refusedWith(port.model.complete(call(ORG_A)));
      expect(refused.code).toBe(reason === "something_new" ? "model_failed" : reason);
      expect(refused.message).not.toMatch(/sk-ant|gateway words/u);
      expect(r.seen).toHaveLength(1);
    }
  });

  it("a fault (503, a redirect, a bad body, an unreachable gateway) is an ordinary failure in fixed words, never a pause", async () => {
    for (const answer of [() => refusal(503, "api_error"), () => new Response("", { status: 302, headers: { location: "https://elsewhere.example" } }), () => new Response("not json", { status: 200 }), () => { throw new Error("connect ECONNREFUSED sk-ant-secret"); }]) {
      const r = recording(answer);
      const port = factory(r.fetchImpl)(ORG_A)!;
      const error = await port.model.complete(call(ORG_A)).then(() => undefined, (caught: unknown) => caught);
      expect(isLearningRefusal(error)).toBe(false);
      expect((error as Error).message).toBe(LEARNING_CALL_FAILED);
    }
  });
});

// DEC 254zzz58/63: learning has its OWN model, never the agent model: the company's choice, else the install's, else Claude Haiku 5.5.
describe("the learning model", () => {
  const GLM = "zai.glm-5";
  const glm = (learning?: string): NodeJS.ProcessEnv => ({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY, [CORE_AGENT_MODEL_VARIABLE]: GLM, ...(learning === undefined ? {} : { [CORE_LEARNING_MODEL_VARIABLE]: learning }) });
  const rows = () => {
    const held = new Map<string, Record<string, unknown>>();
    const reads: string[] = [];
    const store = { get: async (key: { pk: string; sk: string }) => { reads.push(key.pk); return held.get(`${key.pk}|${key.sk}`); } };
    const choose = (companyId: OrgId, model: string, over: Record<string, unknown> = {}) => { const key = companyLearningModelKey(companyId); held.set(`${key.pk}|${key.sk}`, { ...key, entityType: COMPANY_LEARNING_MODEL_ENTITY, orgId: companyId, version: 1, model, updatedAt: "2026-11-18T00:00:00.000Z", updatedBy: "p", ...over }); };
    return { store, choose, reads, clear: () => held.clear() };
  };
  const modelOf = (seen: Seen) => [claimsOf(tokenOf(seen)).mdl, (JSON.parse(seen.init.body as string) as { model: string }).model];

  it("the install's model: ROVARA_CORE_LEARNING_MODEL when it is a Claude engine name, Claude Haiku 5.5 when empty, nothing (not set up) for anything else", () => {
    expect(CORE_LEARNING_MODEL_DEFAULT).toBe("claude-haiku-5-5");
    expect(installLearningModel({})).toBe(CORE_LEARNING_MODEL_DEFAULT);
    expect(installLearningModel({ [CORE_LEARNING_MODEL_VARIABLE]: "  " })).toBe(CORE_LEARNING_MODEL_DEFAULT);
    expect(installLearningModel({ [CORE_LEARNING_MODEL_VARIABLE]: " claude-sonnet-5-5 " })).toBe("claude-sonnet-5-5");
    for (const value of [GLM, "us.anthropic.claude-haiku-4-5-v1:0", "anthropic.claude-3", "CLAUDE-HAIKU-4-5", "claude-a=b", "claude-a,b", `claude-${"x".repeat(33)}`]) {
      expect(installLearningModel({ [CORE_LEARNING_MODEL_VARIABLE]: value }), value).toBeUndefined();
    }
  });

  it("agent model zai.glm-5, nothing chosen: lessons learn on Claude Haiku 5.5 (the token's one model and the request's), never the agent model", async () => {
    const r = recording();
    const port = hostedLessonsLearning(glm(), tokens, { fetch: r.fetchImpl, now: () => NOW })(ORG_A)!;
    await port.model.complete(call(ORG_A));
    expect(modelOf(r.seen[0]!)).toEqual([[CORE_LEARNING_MODEL_DEFAULT], CORE_LEARNING_MODEL_DEFAULT]);
    expect(JSON.stringify(r.seen)).not.toContain(GLM);
  });

  it("agent model zai.glm-5, the install's learning model set: that model", async () => {
    const r = recording();
    const port = hostedLessonsLearning(glm(MODEL), tokens, { fetch: r.fetchImpl, now: () => NOW })(ORG_A)!;
    await port.model.complete(call(ORG_A));
    expect(modelOf(r.seen[0]!)).toEqual([[MODEL], MODEL]);
  });

  it("the company's own choice wins over the install's, read on every call (a change applies to the next call; a clear goes back to the install's)", async () => {
    const r = recording();
    const company = rows();
    const port = hostedLessonsLearning(glm(MODEL), tokens, { fetch: r.fetchImpl, now: () => NOW })(ORG_A, { settings: company.store })!;
    company.choose(ORG_A, "claude-haiku-4-5");
    expect(await port.model.quote!(call(ORG_A))).toEqual({ ok: true, usd: worstCaseUsd("claude-haiku-4-5", call(ORG_A)) });
    await port.model.complete(call(ORG_A));
    company.clear();
    await port.model.complete(call(ORG_A));
    expect(r.seen.map(modelOf)).toEqual([[["claude-haiku-4-5"], "claude-haiku-4-5"], [[MODEL], MODEL]]);
    expect(company.reads.every((pk) => pk === companyLearningModelKey(ORG_A).pk)).toBe(true);
  });

  it("a company setting that cannot be read, or is not exactly this company's Claude choice, is a failure in fixed words: nothing is sent, never the default in its place", async () => {
    for (const over of [{ orgId: ORG_B }, { model: GLM }, { entityType: "COMPANY_ENGINE_MODEL" }, { version: 2 }]) {
      const r = recording();
      const company = rows();
      company.choose(ORG_A, MODEL, over);
      const port = hostedLessonsLearning(glm(), tokens, { fetch: r.fetchImpl, now: () => NOW })(ORG_A, { settings: company.store })!;
      for (const action of [port.model.quote!(call(ORG_A)), port.model.complete(call(ORG_A))]) {
        const error = await action.then(() => undefined, (caught: unknown) => caught);
        expect(isLearningRefusal(error), JSON.stringify(over)).toBe(false);
        expect((error as Error).message).toBe("The learning model could not be chosen.");
      }
      expect(r.seen).toEqual([]);
    }
    const r = recording();
    const broken = { get: async () => { throw new Error("dynamo sk-ant-secret"); } };
    const port = hostedLessonsLearning(glm(), tokens, { fetch: r.fetchImpl, now: () => NOW })(ORG_A, { settings: broken })!;
    const error = await port.model.complete(call(ORG_A)).then(() => undefined, (caught: unknown) => caught);
    expect((error as Error).message).toBe("The learning model could not be chosen.");
    expect(r.seen).toEqual([]);
  });

  it("a company's choice the catalog cannot price is refused as no_suitable_model before anything is sent", async () => {
    const r = recording();
    const company = rows();
    company.choose(ORG_A, "claude-not-a-model-9");
    const port = hostedLessonsLearning(glm(), tokens, { fetch: r.fetchImpl, now: () => NOW })(ORG_A, { settings: company.store })!;
    expect(await port.model.quote!(call(ORG_A))).toEqual({ ok: false, code: "no_suitable_model" });
    expect((await refusedWith(port.model.complete(call(ORG_A)))).code).toBe("no_suitable_model");
    expect(r.seen).toEqual([]);
  });

  it("a call for another company's workspace, or with no project, is refused before the company's setting is read", async () => {
    const r = recording();
    const company = rows();
    const port = hostedLessonsLearning(glm(), tokens, { fetch: r.fetchImpl, now: () => NOW })(ORG_A, { settings: company.store })!;
    expect(await port.model.quote!(call(ORG_B))).toEqual({ ok: false, code: "no_provider" });
    expect((await refusedWith(port.model.complete(call(ORG_B)))).code).toBe("no_provider");
    expect((await refusedWith(port.model.complete(call(ORG_A, { project: undefined })))).code).toBe("no_provider");
    expect(company.reads).toEqual([]);
    expect(r.seen).toEqual([]);
  });

  it("two companies through one store: each port reads only its own company's row and learns on its own choice (or the default)", async () => {
    const r = recording();
    const company = rows();
    company.choose(ORG_B, "claude-haiku-4-5");
    const make = hostedLessonsLearning(glm(), tokens, { fetch: r.fetchImpl, now: () => NOW });
    const a = make(ORG_A, { settings: company.store })!;
    const b = make(ORG_B, { settings: company.store })!;
    await b.model.complete(call(ORG_B));
    await a.model.complete(call(ORG_A));
    expect(r.seen.map((seen) => [claimsOf(tokenOf(seen)).cid, claimsOf(tokenOf(seen)).mdl])).toEqual([[ORG_B, ["claude-haiku-4-5"]], [ORG_A, [CORE_LEARNING_MODEL_DEFAULT]]]);
    expect(company.reads).toEqual([companyLearningModelKey(ORG_B).pk, companyLearningModelKey(ORG_A).pk]);
  });
});
