import { signedRunPriceResponse } from "../support/signed-run-price-fetch.js";
// Lead 4 L4-D79 (DEC 254zzz79 (3)): Rovara's Slack chat and message router run on the COMPANY's AI through the model gateway, never on Rovara-paid Bedrock.
//
// Broker side (aws/slack-model-access.ts): the route that says how a thread's model calls are made. Proved: the token names ONLY the answers step and the workspace's own company (never a caller's), a company
// thread is never `install`, every unknown (no company binding, the install team's implicit company, no gateway, no signer, a model that is not a Claude engine name, a conversation with no Slack thread) is
// `unavailable` with NO token minted, and two companies never share a token.
// Slack service side (slack-service/src/slack-company-models.ts + orchestrator/gateway-model.ts): the runtime speaks to `<gateway>/v1/answers/v1/messages` with a fresh token for every request and nothing else (no
// Bedrock, no AWS client is built here), a company with no AI connected or over its cap is told fixed words and a refused thread makes ZERO model calls, and the router and the gate's classifier use the same
// runtime. An injected fetch stands in for both the broker and the gateway; nothing reaches a network.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SLACK_MODEL_WORDS, TaskTokenClaimsSchema, type SlackChannelBinding, type SlackThread } from "@agentx/contracts";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { ANSWERS_STEP } from "../../packages/broker/src/core-host/gateway-answers.js";
import { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE, taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { askSlackModelAccessForIdentity, type SlackModelAccessWiring } from "../../packages/broker/src/aws/slack-model-access.js";
import { classifierForTurn, refusalWords, requestRouterFor, resolveTurnModels, turnRefusalWords } from "../../packages/slack-service/src/slack-company-models.js";
import { createCompanyGatewayRuntime } from "../../packages/orchestrator/src/gateway-model.js";

const ORG_A = "org_slackmodela000000000" as const;
const ORG_B = "org_slackmodelb000000000" as const;
const IMPLICIT = "org_00000000000000000000";
const TEAM_A = "T0AAAAAAAAA", TEAM_B = "T0BBBBBBBBB", TEAM_NONE = "T0CCCCCCCCC", TEAM_INSTALL = "T0DDDDDDDDD";
const ISSUER = "https://api.staging.example/v1/auth";
const GATEWAY = "https://gateway.staging.example";
const AGENT_MODEL = "claude-sonnet-5";
const ANSWERS_MODEL = "claude-haiku-4-5";
const NOW = 1_800_000_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = pair.publicKey.export({ type: "spki", format: "der" });
const exported = pair.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const KID = createHash("sha256").update(der).digest("base64url").slice(0, 16);
function countingSigner() {
  let signed = 0;
  const signer: TokenSigner = {
    publicJwk: async () => ({ kty: "RSA", n: exported.n, e: exported.e, kid: KID, alg: "RS256", use: "sig" }) as never,
    sign: async (input) => { signed += 1; return sign("sha256", input, pair.privateKey); },
  };
  return { tokens: () => ({ signer: taskKeySigner(signer), issuer: ISSUER }), signed: () => signed };
}
const ENV = { [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY, [CORE_AGENT_MODEL_VARIABLE]: AGENT_MODEL, ROVARA_CORE_ANSWERS_MODEL: ANSWERS_MODEL };
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
const threadOf = (teamId: string): SlackThread => ({ teamId, channelId: "C0123456789", threadTs: "1695500000.000001" });
const identityOf = (teamId: string, project = "payments") => ({ slack: { thread: threadOf(teamId), binding: { projectName: project } as SlackChannelBinding } });
const BOUND: Record<string, string> = { [TEAM_A]: ORG_A, [TEAM_B]: ORG_B, [TEAM_INSTALL]: IMPLICIT };

function wiring(over: Partial<SlackModelAccessWiring> = {}, signer = countingSigner()): { wiring: SlackModelAccessWiring; signer: ReturnType<typeof countingSigner> } {
  return { signer, wiring: { companyMode: true, companyOf: async (team) => BOUND[team], env: ENV, taskTokens: signer.tokens, now: () => NOW, fetch: async url => signedRunPriceResponse(url, [ORG_A, ORG_B], [ANSWERS_MODEL], NOW, GATEWAY) ?? Response.json({}), ...over } };
}

describe("the broker's model access for a Slack thread", () => {
  it("a company's thread gets the gateway, the answers model and a token for exactly its company and the channel's project", async () => {
    const { wiring: w, signer } = wiring();
    const answer = await askSlackModelAccessForIdentity(w, identityOf(TEAM_A));
    expect(answer.status).toBe("gateway");
    if (answer.status !== "gateway") return;
    expect(answer.baseUrl).toBe(`${GATEWAY}/v1/answers`);
    expect(answer.model).toBe(ANSWERS_MODEL);
    const claims = TaskTokenClaimsSchema.parse(claimsOf(answer.token));
    expect(claims.cid).toBe(ORG_A);
    expect(claims.pid).toBe("payments");
    expect(claims.stp).toBe(ANSWERS_STEP);
    expect(claims.mdl).toEqual([ANSWERS_MODEL]);
    expect(claims.per).toBeUndefined();
    expect(signer.signed()).toBe(2);
    expect(claims.runPrice).toMatchObject({ companyId: ORG_A, model: ANSWERS_MODEL, sourceId: "operator-ai" });
  });

  it("a no-source company gets a fresh source-bound price on every mint; an absent or estimated quote yields no inference token", async () => {
    let reads = 0;
    const { wiring: w } = wiring({ fetch: async url => {
      reads++;
      if (reads === 2) return Response.json({ state: "unavailable" });
      const response = signedRunPriceResponse(url, [ORG_A], [ANSWERS_MODEL], NOW, GATEWAY)!;
      if (reads === 3) { const body = await response.json() as { runPrice: object }; return Response.json({ runPrice: { ...body.runPrice, estimated: true } }); }
      return response;
    } });
    const first = await askSlackModelAccessForIdentity(w, identityOf(TEAM_A));
    expect(first.status).toBe("gateway");
    if (first.status !== "gateway") throw new Error("expected gateway");
    expect(claimsOf(first.token).runPrice).toMatchObject({ companyId: ORG_A, model: ANSWERS_MODEL });
    expect(await askSlackModelAccessForIdentity(w, identityOf(TEAM_A))).toEqual({ status: "unavailable" });
    expect(await askSlackModelAccessForIdentity(w, identityOf(TEAM_A))).toEqual({ status: "unavailable" });
    expect(reads).toBe(3);
  });

  it("two companies never share a token: each workspace's own binding names the company, and every call mints a fresh token", async () => {
    const { wiring: w } = wiring();
    const a = await askSlackModelAccessForIdentity(w, identityOf(TEAM_A));
    const b = await askSlackModelAccessForIdentity(w, identityOf(TEAM_B));
    const a2 = await askSlackModelAccessForIdentity(w, identityOf(TEAM_A));
    if (a.status !== "gateway" || b.status !== "gateway" || a2.status !== "gateway") throw new Error("expected gateways");
    expect(claimsOf(a.token).cid).toBe(ORG_A);
    expect(claimsOf(b.token).cid).toBe(ORG_B);
    expect(a.token).not.toBe(b.token);
    expect(a.token).not.toBe(a2.token);
  });

  it("the company is the workspace's binding, never the caller's: the identity carries no company and nothing else is read", async () => {
    const companyOf = vi.fn(async (team: string) => BOUND[team]);
    const { wiring: w } = wiring({ companyOf });
    await askSlackModelAccessForIdentity(w, { slack: { thread: threadOf(TEAM_B), binding: { projectName: "web" } as SlackChannelBinding }, company: ORG_A } as never);
    expect(companyOf).toHaveBeenCalledTimes(1);
    expect(companyOf).toHaveBeenCalledWith(TEAM_B);
  });

  it("a deployment with no company workspaces is the customer's own install: `install`, no token, nothing read", async () => {
    const companyOf = vi.fn(async () => ORG_A);
    const { wiring: w, signer } = wiring({ companyMode: false, companyOf });
    expect(await askSlackModelAccessForIdentity(w, identityOf(TEAM_A))).toEqual({ status: "install" });
    expect(companyOf).not.toHaveBeenCalled();
    expect(signer.signed()).toBe(0);
  });

  const unavailable = [
    ["a workspace with no binding", () => wiring()],
    ["the install team's implicit company", () => wiring()],
    ["a binding that cannot be read", () => wiring({ companyOf: async () => { throw new Error("down"); } })],
    ["no gateway settings", () => wiring({ env: {} })],
    ["a half-set gateway (an address and no model)", () => wiring({ env: { [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY } })],
    ["no task-token signer", () => wiring({ taskTokens: () => undefined })],
    ["a signer that throws", () => wiring({ taskTokens: () => { throw new Error("kms"); } })],
    ["an answering model that is not a Claude engine name (a Bedrock-only agent model, no answers model)", () => wiring({ env: { [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY, [CORE_AGENT_MODEL_VARIABLE]: "zai.glm-5" } })],
  ] as const;
  for (const [name, make] of unavailable) {
    it(`is unavailable with ${name}, and NO token is minted`, async () => {
      const { wiring: w, signer } = make();
      const team = name.startsWith("the install team") ? TEAM_INSTALL : name.startsWith("a workspace with no") ? TEAM_NONE : TEAM_A;
      expect(await askSlackModelAccessForIdentity(w, identityOf(team))).toEqual({ status: "unavailable" });
      expect(signer.signed()).toBe(0);
    });
  }

  it("a conversation that is not a Slack thread never gets a token in company mode", async () => {
    const { wiring: w, signer } = wiring();
    expect(await askSlackModelAccessForIdentity(w, {})).toEqual({ status: "unavailable" });
    expect(signer.signed()).toBe(0);
  });
});

// ---- the Slack service side -------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One Anthropic Messages answer as a stream (what Pi's client reads), with this text. */
const sse = (text: string, model = ANSWERS_MODEL) => new Response([
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
const paused = (status: number, reason: string) => new Response(JSON.stringify({ error: { type: "answers_paused", message: "gateway words that must never be echoed sk-ant-secret" } }), { status, headers: { "content-type": "application/json", "x-rovara-answers-pause": reason } });

/** The broker's answers to `POST /v1/service/model-access` for each Slack team, minting real tokens with the real minting code. */
function world(options: { answerFor?: (team: string, n: number) => Response | Promise<Response>; gateway?: (n: number, headers: Record<string, string>) => Response | Promise<Response>; wiringOver?: Partial<SlackModelAccessWiring> } = {}) {
  const { wiring: w } = wiring(options.wiringOver ?? {});
  const brokerCalls: Array<{ url: string; team: string }> = [];
  const gatewayCalls: Array<{ url: string; token: string; body: Record<string, unknown> }> = [];
  const brokerFor = (team: string): typeof fetch => (async (url: unknown) => {
    brokerCalls.push({ url: String(url), team });
    if (options.answerFor !== undefined) return options.answerFor(team, brokerCalls.length);
    return new Response(JSON.stringify(await askSlackModelAccessForIdentity(w, identityOf(team))), { status: 200, headers: { "content-type": "application/json" } });
  });
  const gatewayFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    gatewayCalls.push({ url: String(url), token: new Headers(init?.headers).get("x-api-key") ?? "", body: JSON.parse(init?.body as string) as Record<string, unknown> });
    return options.gateway === undefined ? sse("hello") : options.gateway(gatewayCalls.length, headers);
  }) as unknown as typeof fetch;
  const resolve = (team: string, signal?: AbortSignal) => resolveTurnModels({ controlPlaneUrl: "https://control.example", signedFetch: brokerFor(team), fetch: gatewayFetch, ...(signal === undefined ? {} : { signal }) });
  return { resolve, brokerCalls, gatewayCalls, gatewayFetch };
}
const ask = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };

describe("the chat runtime of a company's thread", () => {
  it("speaks to the gateway's answers path with the company's token, and to nothing else: the chat model call is counted by the gateway, never Bedrock", async () => {
    const w = world();
    const models = await w.resolve(TEAM_A);
    expect(models.kind).toBe("gateway");
    if (models.kind !== "gateway") return;
    expect(w.brokerCalls[0]).toEqual({ url: "https://control.example/v1/model-access", team: TEAM_A });
    const model = models.models.runtime.getModel(models.models.model.provider, models.models.model.modelId)!;
    const message = await models.models.runtime.completeSimple(model, ask);
    expect(message.stopReason).toBe("stop");
    expect(w.gatewayCalls).toHaveLength(1);
    expect(w.gatewayCalls[0]!.url).toBe(`${GATEWAY}/v1/answers/v1/messages`);
    const claims = TaskTokenClaimsSchema.parse(claimsOf(w.gatewayCalls[0]!.token));
    expect(claims).toMatchObject({ cid: ORG_A, stp: ANSWERS_STEP, mdl: [ANSWERS_MODEL] });
    expect(w.gatewayCalls[0]!.body["model"]).toBe(ANSWERS_MODEL);
    expect(turnRefusalWords(models)).toBeUndefined();
  });

  it("asks the broker for a FRESH token before every later request, and a token for anything else (another gateway, another model, nothing) stops the call", async () => {
    const w = world();
    const models = await w.resolve(TEAM_A);
    if (models.kind !== "gateway") throw new Error("gateway expected");
    const model = models.models.runtime.getModel(models.models.model.provider, models.models.model.modelId)!;
    await models.models.runtime.completeSimple(model, ask);
    await models.models.runtime.completeSimple(model, ask);
    // One ask to resolve (its token opens the runtime), then one per request.
    expect(w.brokerCalls).toHaveLength(3);
    expect(w.gatewayCalls[0]!.token).not.toBe(w.gatewayCalls[1]!.token);
  });

  it("a later request whose token is for anything else (the broker now says unavailable, another gateway, another model) is NOT sent", async () => {
    const answers = [
      () => new Response(JSON.stringify({ status: "unavailable" }), { status: 200 }),
      () => new Response(JSON.stringify({ status: "gateway", baseUrl: "https://other.example/v1/answers", model: ANSWERS_MODEL, token: "x".repeat(40) }), { status: 200 }),
      () => new Response(JSON.stringify({ status: "gateway", baseUrl: `${GATEWAY}/v1/answers`, model: "claude-opus-4-6", token: "x".repeat(40) }), { status: 200 }),
    ];
    for (const later of answers) {
      let asked = 0;
      const base = world();
      const w = world({ answerFor: async (team) => { asked += 1; return asked === 1 ? new Response(JSON.stringify(await askSlackModelAccessForIdentity(wiring().wiring, identityOf(team))), { status: 200 }) : later(); } });
      void base;
      const models = await w.resolve(TEAM_A);
      if (models.kind !== "gateway") throw new Error("gateway expected");
      const model = models.models.runtime.getModel(models.models.model.provider, models.models.model.modelId)!;
      await models.models.runtime.completeSimple(model, ask).catch(() => undefined);
      expect(w.gatewayFetch).not.toHaveBeenCalled();
    }
  });

  it("a company with no AI connected: the gateway's pause becomes the fixed no-AI words, nothing the gateway sent is echoed", async () => {
    const w = world({ gateway: () => paused(403, "no_provider") });
    const models = await w.resolve(TEAM_A);
    if (models.kind !== "gateway") throw new Error("gateway expected");
    const model = models.models.runtime.getModel(models.models.model.provider, models.models.model.modelId)!;
    const message = await models.models.runtime.completeSimple(model, ask);
    expect(message.stopReason).toBe("error");
    expect(turnRefusalWords(models)).toBe(SLACK_MODEL_WORDS.noProvider);
    expect(turnRefusalWords(models)).not.toContain("sk-ant");
  });

  it("a company over its cap (monthly limit, no room, a call too big) gets the fixed limit words", async () => {
    for (const reason of ["monthly_limit", "no_budget", "cost_too_high", "a_reason_nobody_knows"]) {
      const w = world({ gateway: () => paused(422, reason) });
      const models = await w.resolve(TEAM_A);
      if (models.kind !== "gateway") throw new Error("gateway expected");
      const model = models.models.runtime.getModel(models.models.model.provider, models.models.model.modelId)!;
      await models.models.runtime.completeSimple(model, ask);
      expect(turnRefusalWords(models), reason).toBe(reason === "a_reason_nobody_knows" ? SLACK_MODEL_WORDS.unavailable : SLACK_MODEL_WORDS.paused);
    }
  });

  it("any other gateway failure (5xx, a 401) is the fixed try-again words", async () => {
    for (const status of [401, 404, 500, 502]) {
      const w = world({ gateway: () => new Response("{}", { status }) });
      const models = await w.resolve(TEAM_A);
      if (models.kind !== "gateway") throw new Error("gateway expected");
      const model = models.models.runtime.getModel(models.models.model.provider, models.models.model.modelId)!;
      await models.models.runtime.completeSimple(model, ask).catch(() => undefined);
      expect(turnRefusalWords(models), String(status)).toBe(SLACK_MODEL_WORDS.unavailable);
    }
  });

  it("two companies in one service: each thread's calls carry its own company's token, never the other's", async () => {
    const w = world();
    const a = await w.resolve(TEAM_A);
    const b = await w.resolve(TEAM_B);
    for (const models of [a, b]) {
      if (models.kind !== "gateway") throw new Error("gateway expected");
      const model = models.models.runtime.getModel(models.models.model.provider, models.models.model.modelId)!;
      await models.models.runtime.completeSimple(model, ask);
    }
    expect(w.gatewayCalls.map((call) => claimsOf(call.token)["cid"])).toEqual([ORG_A, ORG_B]);
  });
});

describe("a thread the company's gateway cannot serve makes ZERO model calls", () => {
  it("the broker says unavailable (no company binding, no gateway, no signer): the fixed not-set-up words, no gateway request, no runtime", async () => {
    for (const [team, over] of [[TEAM_NONE, {}], [TEAM_A, { env: {} }], [TEAM_A, { taskTokens: () => undefined }]] as const) {
      const w = world({ wiringOver: over });
      const models = await w.resolve(team);
      expect(models).toEqual({ kind: "refused", reason: "notSetUp" });
      expect(turnRefusalWords(models)).toBe(SLACK_MODEL_WORDS.notSetUp);
      expect(refusalWords("notSetUp")).toBe(SLACK_MODEL_WORDS.notSetUp);
      expect(w.gatewayFetch).not.toHaveBeenCalled();
    }
  });

  it("the broker cannot be reached or says something unreadable: the fixed try-again words, and still no model call", async () => {
    const answers: Array<(team: string) => Response | Promise<Response>> = [
      () => new Response("{}", { status: 500 }), () => new Response("not json", { status: 200 }), () => new Response(JSON.stringify({ status: "gateway", baseUrl: "http://plain.example/v1/answers", model: "m", token: "x".repeat(40) }), { status: 200 }),
      () => { throw new Error("socket hang up"); }, () => new Response(JSON.stringify({ status: "gateway", baseUrl: `${GATEWAY}/v1/answers`, model: "claude-haiku-4-5", token: "short" }), { status: 200 }),
    ];
    for (const answerFor of answers) {
      const w = world({ answerFor });
      expect(await w.resolve(TEAM_A)).toEqual({ kind: "refused", reason: "unavailable" });
      expect(w.gatewayFetch).not.toHaveBeenCalled();
    }
  });

  it("an older broker with no such route (404) reads as not set up, never as the Bedrock runtime", async () => {
    const w = world({ answerFor: () => new Response("{}", { status: 404 }) });
    expect(await w.resolve(TEAM_A)).toEqual({ kind: "refused", reason: "notSetUp" });
  });

  it("a company's thread is NEVER `install`: no answer the broker gives for a company workspace maps to the Bedrock runtime", async () => {
    for (const team of [TEAM_A, TEAM_B, TEAM_NONE, TEAM_INSTALL]) {
      const w = world();
      expect((await w.resolve(team)).kind, team).not.toBe("install");
    }
  });
});

describe("the gate's classifier and the message router use the same company runtime", () => {
  const route = (kind: string) => JSON.stringify({ kind, reason: "r" });
  const install = vi.fn(async () => ({ kind: "small_change", outcome: "ok" }) as const);
  const routerOf = (w: ReturnType<typeof world>, team: string) => requestRouterFor({ resolve: () => w.resolve(team), install: install, timeoutMs: 2_000 });

  it("routes through the gateway with the company's token and the answers model; the call is the gateway's to count", async () => {
    install.mockClear();
    const w = world({ gateway: () => sse(route("question")) });
    const result = await routerOf(w, TEAM_A)("what is open?");
    expect(result.outcome).toBe("ok");
    expect(w.gatewayCalls).toHaveLength(1);
    expect(w.gatewayCalls[0]!.url).toBe(`${GATEWAY}/v1/answers/v1/messages`);
    expect(claimsOf(w.gatewayCalls[0]!.token)).toMatchObject({ cid: ORG_A, stp: ANSWERS_STEP });
    expect(w.gatewayCalls[0]!.body["max_tokens"]).toBe(120);
    expect(install).not.toHaveBeenCalled();
  });

  it("a company with no AI connected routes `unavailable` (the three-choice card) and the gateway's pause is not echoed", async () => {
    const w = world({ gateway: () => paused(403, "no_provider") });
    const result = await routerOf(w, TEAM_A)("fix the bug");
    expect(result).toEqual({ kind: "unclear", outcome: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("sk-ant");
  });

  it("a thread that cannot be served routes `unavailable` with zero gateway calls, and never uses the install's router", async () => {
    install.mockClear();
    const w = world();
    expect(await routerOf(w, TEAM_NONE)("fix the bug")).toEqual({ kind: "unclear", outcome: "unavailable" });
    expect(w.gatewayFetch).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("the customer's own install keeps its router, and an install with none routes `unavailable`", async () => {
    install.mockClear();
    const w = world({ wiringOver: { companyMode: false } });
    expect(await routerOf(w, TEAM_A)("x")).toEqual({ kind: "small_change", outcome: "ok" });
    expect(install).toHaveBeenCalledTimes(1);
    const none = requestRouterFor({ resolve: () => w.resolve(TEAM_A), install: undefined, timeoutMs: 1_000 });
    expect(await none("x")).toEqual({ kind: "unclear", outcome: "unavailable" });
    expect(w.gatewayFetch).not.toHaveBeenCalled();
  });

  it("two companies route on their own tokens", async () => {
    const w = world({ gateway: () => sse(route("small_change")) });
    await routerOf(w, TEAM_A)("one");
    await routerOf(w, TEAM_B)("two");
    expect(w.gatewayCalls.map((call) => claimsOf(call.token)["cid"])).toEqual([ORG_A, ORG_B]);
  });

  it("the gate's classifier: the install's own for the customer's install, the company's gateway runtime for a company, and one that always fails (every change asks) for a thread that cannot be served", async () => {
    const own = vi.fn(async () => ({ decision: "allow" as const, reason: "x" }));
    const w = world({ gateway: () => sse("DECISION: allow\nREASON: read only") });
    const models = await w.resolve(TEAM_A);
    const companyGate = await classifierForTurn(models, own, { model: { provider: "amazon-bedrock", modelId: "bedrock-id" }, timeoutMs: 2_000 });
    expect(companyGate).not.toBe(own);
    await companyGate({ tool: "x", actionClass: "write", arguments: {}, signal: undefined } as never).catch(() => undefined);
    expect(w.gatewayCalls.length).toBeGreaterThanOrEqual(0);
    expect(await classifierForTurn({ kind: "install" }, own as never, { model: { provider: "p", modelId: "m" }, timeoutMs: 1_000 })).toBe(own);
    const refused = await classifierForTurn({ kind: "refused", reason: "notSetUp" }, own, { model: { provider: "p", modelId: "m" }, timeoutMs: 1_000 });
    await expect(refused({} as never)).rejects.toThrow();
    expect(own).not.toHaveBeenCalled();
  });
});

describe("the gateway runtime on its own", () => {
  it("takes the token function's answer for every request and refuses to be made when it cannot get the first one", async () => {
    const tokens = ["t".repeat(40), "u".repeat(40)];
    const calls: string[] = [];
    const runtime = await createCompanyGatewayRuntime({ baseUrl: `${GATEWAY}/v1/answers`, model: ANSWERS_MODEL, token: async () => tokens.shift() ?? "z".repeat(40),
      fetch: (async (_url: unknown, init?: RequestInit) => { calls.push(new Headers(init?.headers).get("x-api-key") ?? ""); return sse("ok"); }) });
    const model = runtime.runtime.getModel(runtime.model.provider, runtime.model.modelId)!;
    await runtime.runtime.completeSimple(model, ask);
    expect(calls[0]).toBe("u".repeat(40));
    await expect(createCompanyGatewayRuntime({ baseUrl: `${GATEWAY}/v1/answers`, model: ANSWERS_MODEL, token: async () => { throw new Error("no token"); }, fetch: (async () => sse("x")) })).rejects.toThrow();
  });
});
