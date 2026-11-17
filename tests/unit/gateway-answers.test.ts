// Lead 4 L4-AG: the hosted answers adapter over the gateway's "answers" purpose (Cloud #125, DEC 254z-amend2). An injected fetch stands in for the gateway; nothing reaches a network and no key exists.
// What is proved: the token names ONLY the answers step and the caller's company, on the one answers path; a pause or a missing key is its own fixed outcome; two companies never share a token, a
// reservation or a refusal; nothing the gateway or the model sent is echoed.
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TASK_KEY_PURPOSE, TaskTokenClaimsSchema, type OrgId } from "@agentx/contracts";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE, taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import {
  ANSWERS_CALL_FAILED, ANSWERS_MESSAGES_PATH, ANSWERS_PAUSE_HEADER, ANSWERS_STEP, createHttpAnswersGateway, hostedAnswersModel,
} from "../../packages/broker/src/core-host/gateway-answers.js";
import { AnswersGatewayError, createGatewayAnswerModel } from "../../packages/broker/src/core/answers/gateway-model.js";
import { AnswerModelRefused, type AnswerModelTurn } from "../../packages/broker/src/core/answers/ports.js";

const ORG_A = "org_answersgw0000000000a" as OrgId;
const ORG_B = "org_answersgw0000000000b" as OrgId;
const ISSUER = "https://api.staging.example/v1/auth";
const GATEWAY = "https://gateway.staging.example";
const MODEL = "claude-sonnet-5";
const NOW = 1_800_000_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = pair.publicKey.export({ type: "spki", format: "der" });
const exported = pair.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const KID = createHash("sha256").update(der).digest("base64url").slice(0, 16);
const bareKey = (overrides: Record<string, unknown> = {}): TokenSigner => ({
  publicJwk: async () => ({ kty: "RSA", n: exported.n, e: exported.e, kid: KID, alg: "RS256", use: "sig", ...overrides }) as never,
  sign: async (input) => sign("sha256", input, pair.privateKey),
});
const taskKey = (): TokenSigner => taskKeySigner(bareKey());
const ANSWER_ID_A = `a${"1".repeat(31)}`;
const ANSWER_ID_B = `a${"2".repeat(31)}`;
const key = (answerId: string) => `answer:${answerId}`;

const turn = (over: Partial<AnswerModelTurn> = {}): AnswerModelTurn => ({ system: "fixed rules", transcript: "the question, framed as data", maxOutputTokens: 1_500, signal: new AbortController().signal, remainingCents: 15, ...over });
const reply = (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ model: MODEL, content: [{ type: "text", text: "Refunds " }, { type: "text", text: "last 30 days." }], usage: { input_tokens: 1_200, output_tokens: 80 }, ...over }), { status: 200, headers: { "content-type": "application/json", ...headers } });
const refusal = (status: number, type: string, reason?: string) =>
  new Response(JSON.stringify({ error: { type, message: "gateway words that must never be echoed sk-ant-secret" } }), { status, headers: { "content-type": "application/json", ...(reason === undefined ? {} : { [ANSWERS_PAUSE_HEADER]: reason }) } });

interface Seen { url: string; init: RequestInit }
function recording(answer: (n: number) => Response | Promise<Response> = () => reply()) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => { seen.push({ url: String(url), init: init ?? {} }); return answer(seen.length - 1); }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}
const gatewayWith = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createHttpAnswersGateway>[0]> = {}) =>
  createHttpAnswersGateway({ gatewayUrl: GATEWAY, issuer: ISSUER, signer: taskKey(), model: MODEL, fetch: fetchImpl, now: () => NOW, timeoutMs: 200, ...extra });
const tokenOf = (seen: Seen) => (seen.init.headers as Record<string, string>)["x-api-key"]!;
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
const headerOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()) as Record<string, unknown>;
const reserveFor = (g: ReturnType<typeof gatewayWith>, companyId: string = ORG_A, answerId = ANSWER_ID_A, project = "alpha") =>
  g.reserve({ companyId, project, personId: "ada", idempotencyKey: key(answerId), ceilingCents: 15 });
const callOf = (g: ReturnType<typeof gatewayWith>, reservationId: string, over: Partial<AnswerModelTurn> = {}) => {
  const t = turn(over);
  return g.call({ reservationId, system: t.system, transcript: t.transcript, maxOutputTokens: t.maxOutputTokens, signal: t.signal, remainingCents: t.remainingCents });
};
const reasonOf = async (action: Promise<unknown>) => {
  const error = await action.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(AnswersGatewayError);
  return (error as AnswersGatewayError).reason;
};

describe("the request (golden)", () => {
  it("is one Anthropic Messages POST to /v1/answers/messages with the call's own token, the fixed rules as system and the transcript as the one user turn", async () => {
    const r = recording();
    const g = gatewayWith(r.fetchImpl);
    const { reservationId } = await reserveFor(g);
    const out = await callOf(g, reservationId);
    expect(out).toEqual({ text: "Refunds last 30 days.", model: MODEL, tokens: { input: 1_200, output: 80 } });
    expect(r.seen).toHaveLength(1);
    const { url, init } = r.seen[0]!;
    expect(url).toBe(`${GATEWAY}/v1/answers/messages`);
    expect(ANSWERS_MESSAGES_PATH).toBe("/v1/answers/messages");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(Object.keys(init.headers as object).sort()).toEqual(["anthropic-version", "content-type", "x-api-key"]);
    expect(JSON.parse(init.body as string)).toEqual({ model: MODEL, max_tokens: 1_500, system: "fixed rules", messages: [{ role: "user", content: "the question, framed as data" }] });
    // No tools, no streaming, no key of the company or of Rovara anywhere in the request.
    expect(init.body as string).not.toMatch(/tools|stream|api_key/u);
  });

  it("uses the gateway's own cost figure when it gives a readable one, in whole cents rounded up, and none otherwise", async () => {
    const withCost = recording(() => reply({}, { "x-rovara-cost-usd": "0.0123" }));
    const g = gatewayWith(withCost.fetchImpl);
    expect((await callOf(g, (await reserveFor(g)).reservationId)).costCents).toBe(2);
    for (const bad of ["abc", "-1", "NaN", "Infinity", "1e9"]) {
      const odd = recording(() => reply({}, { "x-rovara-cost-usd": bad }));
      const h = gatewayWith(odd.fetchImpl);
      expect((await callOf(h, (await reserveFor(h)).reservationId)).costCents, bad).toBeUndefined();
    }
  });

  it("reports no tokens when the reply does not say, and the configured model when the reply names none or a long one", async () => {
    const r = recording(() => reply({ usage: undefined, model: "m".repeat(200) }));
    const g = gatewayWith(r.fetchImpl);
    const out = await callOf(g, (await reserveFor(g)).reservationId);
    expect(out.tokens).toBeUndefined();
    expect(out.model).toBe(MODEL);
    const odd = recording(() => reply({ usage: { input_tokens: -1, output_tokens: 1.5 } }));
    const h = gatewayWith(odd.fetchImpl);
    expect((await callOf(h, (await reserveFor(h)).reservationId)).tokens).toBeUndefined();
  });
});

describe("the token: the answers step, this company, nothing else", () => {
  it("names exactly the answers step, the caller's company and project, one model, no person, no task origin, signed RS256 by the task key", async () => {
    const r = recording();
    const g = gatewayWith(r.fetchImpl);
    const { reservationId } = await reserveFor(g, ORG_A, ANSWER_ID_A, "alpha");
    await callOf(g, reservationId);
    const token = tokenOf(r.seen[0]!);
    const [header, body, signature] = token.split(".") as [string, string, string];
    expect(headerOf(token)).toEqual({ alg: "RS256", typ: "rovara-task+jwt", kid: KID });
    const claims = claimsOf(token);
    expect(TaskTokenClaimsSchema.safeParse(claims).success).toBe(true);
    const iat = NOW / 1000;
    expect({ ...claims, jti: "<uuid>", ws: "<uuid>", op: "<uuid>" }).toEqual({
      iss: ISSUER, aud: "rovara-model-gateway", jti: "<uuid>", iat, nbf: iat - 30, exp: iat + 900, cid: ORG_A, pid: "alpha", pay: { kind: "project", project: "alpha" },
      tid: key(ANSWER_ID_A), ws: "<uuid>", op: "<uuid>", stp: "rovara-answers-call", mdl: [MODEL],
    });
    expect(ANSWERS_STEP).toBe("rovara-answers-call");
    // No person (no person pays), no work origin.
    expect(claims["per"]).toBeUndefined();
    expect(claims["src"]).toBeUndefined();
    expect(verify("sha256", Buffer.from(`${header}.${body}`), pair.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("is a fresh token for every call (new jti, workspace and operation) inside one reservation", async () => {
    const r = recording();
    const g = gatewayWith(r.fetchImpl);
    const { reservationId } = await reserveFor(g);
    await callOf(g, reservationId);
    await callOf(g, reservationId);
    const [one, two] = r.seen.map((seen) => claimsOf(tokenOf(seen)));
    expect(one!["jti"]).not.toBe(two!["jti"]);
    expect(one!["ws"]).not.toBe(two!["ws"]);
    expect(one!["op"]).not.toBe(two!["op"]);
    expect({ ...one, jti: 0, ws: 0, op: 0 }).toEqual({ ...two, jti: 0, ws: 0, op: 0 });
  });

  it("is made only with the task key (purpose `task`): the bare KMS key mints nothing, and nothing is sent", async () => {
    const r = recording();
    const g = gatewayWith(r.fetchImpl, { signer: bareKey() });
    const { reservationId } = await reserveFor(g);
    expect(await reasonOf(callOf(g, reservationId))).toBe("unavailable");
    expect(r.seen).toEqual([]);
  });

  it("a signer that fails, or a key the gateway would not accept, sends nothing and says nothing of why", async () => {
    for (const signer of [{ publicJwk: async () => { throw new Error("kms down arn:aws:kms:secret"); }, sign: async () => Buffer.alloc(0) } as TokenSigner, taskKeySigner(bareKey({ kid: "short" })), taskKeySigner(bareKey({ alg: "RS512" }))]) {
      const r = recording();
      const g = gatewayWith(r.fetchImpl, { signer });
      const { reservationId } = await reserveFor(g);
      const error = await callOf(g, reservationId).catch((caught: unknown) => caught);
      expect((error as AnswersGatewayError).reason).toBe("unavailable");
      expect(String((error as Error).message)).not.toContain("kms");
      expect(r.seen).toEqual([]);
    }
  });

  it("is never sent anywhere but the answers path of the gateway's own origin, and a redirect is a failed call that is not followed", async () => {
    const r = recording(() => new Response(null, { status: 307, headers: { location: "https://evil.example/steal" } }));
    const g = gatewayWith(r.fetchImpl);
    expect(await reasonOf(callOf(g, (await reserveFor(g)).reservationId))).toBe("unavailable");
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]!.url).toBe(`${GATEWAY}/v1/answers/messages`);
    // Only an https origin with no path, credentials, query or fragment is a gateway address.
    for (const bad of ["http://gateway.example", `${GATEWAY}/v1/messages`, "https://user:pw@gateway.example", `${GATEWAY}?x=1`, "not a url", ""]) {
      expect(() => gatewayWith(r.fetchImpl, { gatewayUrl: bad }), bad).toThrow();
    }
  });
});

describe("the company is the reservation's, never a call's", () => {
  it("two companies interleaved: each token carries only its own company, project and answer, and a reservation is only its own", async () => {
    const r = recording();
    const g = gatewayWith(r.fetchImpl);
    const a = await reserveFor(g, ORG_A, ANSWER_ID_A, "alpha");
    const b = await reserveFor(g, ORG_B, ANSWER_ID_B, "beta");
    expect(a.reservationId).not.toBe(b.reservationId);
    await callOf(g, b.reservationId);
    await callOf(g, a.reservationId);
    await callOf(g, b.reservationId);
    const claims = r.seen.map((seen) => claimsOf(tokenOf(seen)));
    expect(claims.map((c) => [c["cid"], c["pid"], c["tid"]])).toEqual([[ORG_B, "beta", key(ANSWER_ID_B)], [ORG_A, "alpha", key(ANSWER_ID_A)], [ORG_B, "beta", key(ANSWER_ID_B)]]);
    // Settling A's reservation leaves B's alone, and a settled reservation can no longer call.
    await g.settle({ reservationId: a.reservationId });
    expect(await reasonOf(callOf(g, a.reservationId))).toBe("unavailable");
    expect(await callOf(g, b.reservationId)).toMatchObject({ text: "Refunds last 30 days." });
    expect(r.seen).toHaveLength(4);
  });

  it("through the model made for a company: company A's model never reserves for company B, and its token is A's", async () => {
    const r = recording();
    const g = gatewayWith(r.fetchImpl);
    const modelA = createGatewayAnswerModel(g, ORG_A);
    const modelB = createGatewayAnswerModel(g, ORG_B);
    await expect(modelA.open({ companyId: ORG_B, project: "alpha", personId: "ada", answerId: ANSWER_ID_A, ceilingCents: 15 })).rejects.toMatchObject({ reason: "unavailable" });
    expect(r.seen).toEqual([]);
    const sessionA = await modelA.open({ companyId: ORG_A, project: "alpha", personId: "ada", answerId: ANSWER_ID_A, ceilingCents: 15 });
    const sessionB = await modelB.open({ companyId: ORG_B, project: "alpha", personId: "bo", answerId: ANSWER_ID_B, ceilingCents: 15 });
    await sessionA.complete(turn());
    await sessionB.complete(turn());
    expect(r.seen.map((seen) => claimsOf(tokenOf(seen))["cid"])).toEqual([ORG_A, ORG_B]);
    await sessionA.finish({ tokens: 1_280 });
    await sessionB.finish({ tokens: 1_280 });
  });

  it("a refusal of one company's call changes nothing for the other", async () => {
    const r = recording((n) => (n === 0 ? refusal(422, "answers_paused", "monthly_limit") : reply()));
    const g = gatewayWith(r.fetchImpl);
    const a = await reserveFor(g, ORG_A, ANSWER_ID_A);
    const b = await reserveFor(g, ORG_B, ANSWER_ID_B);
    expect(await reasonOf(callOf(g, a.reservationId))).toBe("paused");
    expect(await callOf(g, b.reservationId)).toMatchObject({ text: "Refunds last 30 days." });
  });

  it("refuses what a company, a project, an answer key or a ceiling is not, and an unknown or guessed reservation, before anything is signed or sent", async () => {
    const r = recording();
    const g = gatewayWith(r.fetchImpl);
    for (const input of [
      { companyId: "not-a-company", project: "alpha", idempotencyKey: key(ANSWER_ID_A), ceilingCents: 15 },
      { companyId: ORG_A, project: "Alpha/../x", idempotencyKey: key(ANSWER_ID_A), ceilingCents: 15 },
      { companyId: ORG_A, project: "alpha", idempotencyKey: "answer:a1", ceilingCents: 15 },
      { companyId: ORG_A, project: "alpha", idempotencyKey: key(ANSWER_ID_A), ceilingCents: 0 },
      { companyId: ORG_A, project: "alpha", idempotencyKey: key(ANSWER_ID_A), ceilingCents: 1.5 },
    ]) expect(await reasonOf(g.reserve({ personId: "ada", ...input })), JSON.stringify(input)).toBe("unavailable");
    expect(await g.available({ companyId: "not-a-company" })).toBe(false);
    expect(await g.available({ companyId: ORG_A })).toBe(true);
    for (const reservationId of ["res-1", "", "00000000-0000-4000-8000-000000000000"]) expect(await reasonOf(callOf(g, reservationId))).toBe("unavailable");
    expect(r.seen).toEqual([]);
  });

  it("a second reservation for an answer that is still open is refused (one answer, one reservation), and a settled one can be reserved again", async () => {
    const g = gatewayWith(recording().fetchImpl);
    const first = await reserveFor(g);
    expect(await reasonOf(reserveFor(g))).toBe("unavailable");
    await g.settle({ reservationId: first.reservationId });
    await g.settle({ reservationId: first.reservationId });
    await expect(reserveFor(g)).resolves.toHaveProperty("reservationId");
  });

  it("one company cannot fill the pool for the others: it holds at most 32 open reservations and another company still reserves", async () => {
    const g = gatewayWith(recording().fetchImpl);
    for (let n = 0; n < 32; n += 1) await reserveFor(g, ORG_A, `a${String(n).padStart(31, "0")}`);
    expect(await reasonOf(reserveFor(g, ORG_A, ANSWER_ID_A))).toBe("unavailable");
    await expect(reserveFor(g, ORG_B, ANSWER_ID_B)).resolves.toBeDefined();
  });

  it("holds at most a bounded number of open reservations and forgets one that was never settled", async () => {
    let now = NOW;
    const g = gatewayWith(recording().fetchImpl, { now: () => now });
    const company = (n: number) => `org_pool${String(n).padStart(16, "0")}`;
    for (let n = 0; n < 256; n += 1) await reserveFor(g, company(Math.floor(n / 16)), `a${String(n).padStart(31, "0")}`);
    expect(await reasonOf(reserveFor(g, company(99), ANSWER_ID_A))).toBe("unavailable");
    now += 11 * 60_000;
    await expect(reserveFor(g, company(99), ANSWER_ID_A)).resolves.toBeDefined();
  });
});

describe("what the gateway says", () => {
  const run = async (answer: Response | (() => Response | Promise<Response>)) => {
    const r = recording(typeof answer === "function" ? answer : () => answer);
    const g = gatewayWith(r.fetchImpl);
    return reasonOf(callOf(g, (await reserveFor(g)).reservationId));
  };

  it("maps answers_paused by its reason: no provider is 'not set up'; a used-up month, no budget and a call too big for the limit are 'paused'", async () => {
    expect(await run(refusal(403, "answers_paused", "no_provider"))).toBe("not_set_up");
    expect(await run(refusal(422, "answers_paused", "monthly_limit"))).toBe("paused");
    expect(await run(refusal(422, "answers_paused", "no_budget"))).toBe("paused");
    expect(await run(refusal(422, "answers_paused", "cost_too_high"))).toBe("paused");
    // An answers_paused with a reason this code does not know is still a pause, never a call that went through.
    expect(await run(refusal(422, "answers_paused", "something_new"))).toBe("paused");
    expect(await run(refusal(422, "answers_paused"))).toBe("paused");
  });

  it("reads a pause only from the pair of an answers_paused error AND a refusal status; the same words on another status are a fault", async () => {
    expect(await run(refusal(402, "answers_paused", "monthly_limit"))).toBe("unavailable");
    expect(await run(refusal(500, "answers_paused", "monthly_limit"))).toBe("unavailable");
    expect(await run(refusal(429, "answers_paused", "monthly_limit"))).toBe("unavailable");
    expect(await run(refusal(422, "invalid_request", "monthly_limit"))).toBe("unavailable");
    expect(await run(refusal(403, "lessons_paused", "no_provider"))).toBe("unavailable");
  });

  it("a gateway without the answers purpose yet (404) is 'not set up'; the fixed 401 for a wrong step or an unknown token, a busy 429 and any fault are 'unavailable'", async () => {
    expect(await run(refusal(404, "not_found"))).toBe("not_set_up");
    // A provider's own 404 (an unknown model) is a fault, never "not set up".
    expect(await run(refusal(404, "not_found_error"))).toBe("unavailable");
    expect(await run(refusal(401, "authentication_error"))).toBe("unavailable");
    expect(await run(refusal(403, "task_ended"))).toBe("unavailable");
    expect(await run(refusal(429, "budget_held"))).toBe("unavailable");
    expect(await run(refusal(503, "unavailable"))).toBe("unavailable");
    expect(await run(refusal(502, "provider_error"))).toBe("unavailable");
    expect(await run(new Response("<html>bad gateway</html>", { status: 502 }))).toBe("unavailable");
    expect(await run(() => { throw new Error("socket hang up sk-ant-secret"); })).toBe("unavailable");
  });

  it("a malformed success is a failed call: no content, a non-object block, an oversized body, a body that is not JSON", async () => {
    expect(await run(reply({ content: undefined }))).toBe("unavailable");
    expect(await run(reply({ content: ["text"] }))).toBe("unavailable");
    expect(await run(new Response("not json", { status: 200 }))).toBe("unavailable");
    // Only a 200 is an answer, whatever the body says.
    expect(await run(new Response(JSON.stringify({ content: [{ type: "text", text: "x" }] }), { status: 201 }))).toBe("unavailable");
    expect(await run(new Response("x".repeat(1_100_000), { status: 200 }))).toBe("unavailable");
  });

  it("says only fixed words: nothing the gateway or the model sent, no token and no URL is in an error", async () => {
    const r = recording(() => refusal(503, "unavailable"));
    const g = gatewayWith(r.fetchImpl);
    const error = await callOf(g, (await reserveFor(g)).reservationId).catch((caught: unknown) => caught);
    for (const text of [String((error as Error).message), JSON.stringify(error), String((error as Error).stack ?? "").split("\n")[0]!]) {
      expect(text).not.toContain("sk-ant");
      expect(text).not.toContain("gateway words");
      expect(text).not.toContain(tokenOf(r.seen[0]!));
      expect(text).not.toContain("gateway.staging");
    }
    expect(ANSWERS_CALL_FAILED).toBe("The answers call did not complete.");
  });

  it("a call stops at the turn's own signal and at its own time limit, and a spent ceiling is refused before a token is made", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const hung = recording(() => new Promise<Response>(() => undefined));
    const g = gatewayWith(hung.fetchImpl, { timeoutMs: 20 });
    expect(await reasonOf(callOf(g, (await reserveFor(g)).reservationId))).toBe("unavailable");
    const r = recording();
    const h = gatewayWith(r.fetchImpl);
    const { reservationId } = await reserveFor(h);
    expect(await reasonOf(callOf(h, reservationId, { signal: aborted.signal }))).toBe("unavailable");
    expect(await reasonOf(callOf(h, reservationId, { remainingCents: 0 }))).toBe("over_budget");
    expect(await reasonOf(callOf(h, reservationId, { remainingCents: -3 }))).toBe("over_budget");
    expect(await reasonOf(callOf(h, reservationId, { maxOutputTokens: 0 }))).toBe("unavailable");
    expect(await reasonOf(callOf(h, reservationId, { maxOutputTokens: 1.5 }))).toBe("unavailable");
    expect(r.seen).toEqual([]);
  });
});

describe("through the answer model (what the service sees)", () => {
  it("a pause on the first turn reaches the service as the 'paused' refusal, no key as 'not set up', a fault as 'unavailable'", async () => {
    for (const [answer, expected] of [[refusal(422, "answers_paused", "monthly_limit"), "paused"], [refusal(403, "answers_paused", "no_provider"), "not_set_up"], [refusal(500, "x"), "unavailable"]] as const) {
      const model = createGatewayAnswerModel(gatewayWith(recording(() => answer).fetchImpl), ORG_A);
      const session = await model.open({ companyId: ORG_A, project: "alpha", personId: "ada", answerId: ANSWER_ID_A, ceilingCents: 15 });
      const error = await session.complete(turn()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AnswerModelRefused);
      expect((error as AnswerModelRefused).reason).toBe(expected);
      await session.finish({ tokens: 0 });
    }
  });

  it("settles once and releases the reservation, whatever happened", async () => {
    const r = recording();
    const g = gatewayWith(r.fetchImpl);
    const model = createGatewayAnswerModel(g, ORG_A);
    const session = await model.open({ companyId: ORG_A, project: "alpha", personId: "ada", answerId: ANSWER_ID_A, ceilingCents: 15 });
    await session.complete(turn());
    await session.finish({ costCents: 3, tokens: 1_280 });
    // The same answer can be reserved again only after the settle.
    const again = await model.open({ companyId: ORG_A, project: "alpha", personId: "ada", answerId: ANSWER_ID_A, ceilingCents: 15 });
    await again.finish({ tokens: 0 });
  });
});

describe("the deployment's wiring (hostedAnswersModel)", () => {
  const ENV = { [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY, [CORE_AGENT_MODEL_VARIABLE]: MODEL };
  const tokens = () => ({ signer: taskKey(), issuer: ISSUER });

  it("is a model for each company when the gateway is configured and the install can sign, and none otherwise (the fixed 'not set up' outcome)", async () => {
    const r = recording();
    const factory = hostedAnswersModel(ENV, tokens, r.fetchImpl)!;
    expect(factory).toBeTypeOf("function");
    const modelA = factory(ORG_A)!;
    expect(await modelA.available()).toBe(true);
    const session = await modelA.open({ companyId: ORG_A, project: "alpha", personId: "ada", answerId: ANSWER_ID_A, ceilingCents: 15 });
    await session.complete(turn());
    expect(claimsOf(tokenOf(r.seen[0]!))).toMatchObject({ cid: ORG_A, stp: "rovara-answers-call", mdl: [MODEL], iss: ISSUER });
    await session.finish({ tokens: 0 });
    expect(factory("not-a-company")).toBeUndefined();
    expect(hostedAnswersModel({}, tokens, r.fetchImpl)).toBeUndefined();
    expect(hostedAnswersModel(ENV, undefined, r.fetchImpl)).toBeUndefined();
    expect(hostedAnswersModel(ENV, () => undefined, r.fetchImpl)).toBeUndefined();
    expect(hostedAnswersModel(ENV, () => ({ signer: taskKey(), issuer: "" }), r.fetchImpl)).toBeUndefined();
    expect(hostedAnswersModel(ENV, () => { throw new Error("no keys"); }, r.fetchImpl)).toBeUndefined();
  });

  it("answers only on a Claude model the company's own Anthropic account can serve: a Bedrock-only model or a half-set gateway is 'not set up'", () => {
    const r = recording();
    expect(hostedAnswersModel({ ...ENV, [CORE_AGENT_MODEL_VARIABLE]: "zai.glm-5" }, tokens, r.fetchImpl)).toBeUndefined();
    expect(hostedAnswersModel({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY }, tokens, r.fetchImpl)).toBeUndefined();
    expect(hostedAnswersModel({ ...ENV, [CORE_MODEL_GATEWAY_URL_VARIABLE]: "http://gateway.example" }, tokens, r.fetchImpl)).toBeUndefined();
    expect(r.seen).toEqual([]);
  });

  it("two companies through the one deployment never share a token or a reservation", async () => {
    const r = recording();
    const factory = hostedAnswersModel(ENV, tokens, r.fetchImpl)!;
    const a = await factory(ORG_A)!.open({ companyId: ORG_A, project: "alpha", personId: "ada", answerId: ANSWER_ID_A, ceilingCents: 15 });
    const b = await factory(ORG_B)!.open({ companyId: ORG_B, project: "alpha", personId: "bo", answerId: ANSWER_ID_B, ceilingCents: 15 });
    await b.complete(turn());
    await a.complete(turn());
    expect(r.seen.map((seen) => claimsOf(tokenOf(seen))["cid"])).toEqual([ORG_B, ORG_A]);
    await a.finish({ tokens: 0 });
    await b.finish({ tokens: 0 });
  });
});

describe("the key never reaches Code", () => {
  it("the adapter takes no provider key, reads none, and the only secret it handles is the call's own signed token, sent to the gateway only", async () => {
    const r = recording();
    const g = gatewayWith(r.fetchImpl);
    await callOf(g, (await reserveFor(g)).reservationId);
    const { init } = r.seen[0]!;
    expect(Object.keys(init.headers as object).filter((name) => /key|authorization/iu.test(name))).toEqual(["x-api-key"]);
    expect(tokenOf(r.seen[0]!)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(init.body as string).not.toContain(tokenOf(r.seen[0]!));
    expect(TASK_KEY_PURPOSE).toBe("task");
  });
});
