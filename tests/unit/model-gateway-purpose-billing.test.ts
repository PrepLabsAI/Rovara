import { beforeAll, expect, it, vi } from "vitest";
import * as agentAi from "../../packages/model-gateway/src/agent-ai.js";
import { createAnswersRoutes, ANSWERS_STEP } from "../../packages/model-gateway/src/answers-route.js";
import { createLearningRoutes, LEARNING_STEP } from "../../packages/model-gateway/src/learning-route.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import type { ChargeReceiptV1 } from "../../packages/model-gateway/src/charge-receipt.js";
import type { AgentAiSource, RovaraAi } from "../../packages/model-gateway/src/agent-ai.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import type { ProviderRequest } from "../../packages/model-gateway/src/provider.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import { handleGateway } from "../../packages/model-gateway/src/server.js";
import { answer, caps, claims, MemorySink, mint, now, requestBody, setup } from "./model-gateway-fixture.js";
import { denyNetwork } from "./model-gateway-no-network.js";

beforeAll(denyNetwork);
const model = claims.mdl[0]!;
const catalogModel = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const paths = ["/v1/answers/messages", "/v1/learning/messages", "/v1/answers/v1/messages"] as const;

async function world(exempt = false, limit = 1_000_000_000, ownKey = false) {
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 7, sources: { litellm: { fetchedAt: now - 100, count: 2, entries: [
    { provider: "bedrock", model: catalogModel, kind: "chat", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000,
      cacheReadMicrosPerMTok: 500_000, cacheWrite5mMicrosPerMTok: 1_000_000, cacheWrite1hMicrosPerMTok: 2_000_000 },
    { provider: "anthropic", model, kind: "chat", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000,
      cacheReadMicrosPerMTok: 500_000, cacheWrite5mMicrosPerMTok: 1_000_000, cacheWrite1hMicrosPerMTok: 2_000_000 },
  ] } } }), save: async () => false }, { now: () => now, overrides: [] });
  await prices.reload();
  let selected: AgentAiSource | undefined;
  let connected = ownKey;
  const sources = { sourceFor: async () => selected };
  let ownReads = 0, sent = 0;
  const identity = { sourceId: "src_own_anthropic", versionId: "11111111-1111-4111-8111-111111111111" };
  const keys = {
    identityFor: async () => connected ? identity : undefined,
    connected: async () => connected,
    resolveForCharge: async () => connected ? { source: { kind: "company_key" as const, id: identity.sourceId, name: "Company key", provider: "anthropic", connectionRevision: identity.versionId },
      key: async () => { ownReads++; return "fixture-own-key"; } } : undefined,
    keyFor: async () => { throw new Error("must open the revision-bound credential"); },
  };
  const disabled = new Set<string>();
  const ai: RovaraAi = { sourceId: "operator-serving-role-us-west-2", models: new Map([[model, catalogModel]]), exempt: new Set(exempt ? [claims.cid] : []),
    transport: async () => { sent++; return { status: 200, body: answer() }; } };
  const agentMeter = new InMemoryMeter(() => now);
  const meter = new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agentMeter });
  const reserve = vi.spyOn(meter, "reserve");
  const receipts: ChargeReceiptV1[] = [];
  const settle = meter.settleV2.bind(meter);
  meter.settleV2 = async input => { await settle(input); receipts.push(input.receipt); };
  const companyCaps = new FixedCapsSource({ ...caps, companyMonth: limit });
  const common = { keys, meter, companyCaps, modelLimits: { maxOutputTokens: () => 128_000 },
    transport: async (request: ProviderRequest) => { expect(request.key).toBe("fixture-own-key"); sent++; return { status: 200, body: answer() }; }, rovaraDefault: { ai, sources, disabled, switchedOn: new Set<string>() } };
  const stop = { enabled: vi.fn(async () => true) };
  const { deps } = setup({ rovaraAiSetting: stop, prices, meter: agentMeter, answers: createAnswersRoutes({ ...common, limits: { limitFor: async () => undefined } }),
    learning: createLearningRoutes({ ...common, lessons: { isOn: async () => true } }), chargeReceipts: { source: (_c, _m, resolved) => resolved } });
  const quote = () => answerRateQuote({ prices, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }), now: () => now,
    sources, keys, rovara: ai, disabled, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock", "anthropic"]) },
  { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  const grant = ((await quote()).body as { runPrice: RunPrice }).runPrice;
  expect(grant).toBeDefined();
  const send = async (path: typeof paths[number], changes: Record<string, unknown> = {}) => {
    const sink = new MemorySink();
    await handleGateway(deps, { method: "POST", url: path, headers: { "content-type": "application/json", "x-api-key": mint({
      stp: path.includes("learning") ? LEARNING_STEP : ANSWERS_STEP, pay: { kind: "project", project: claims.pid }, runPrice: grant, ...changes,
    }) }, body: (async function* () { yield Buffer.from(JSON.stringify(requestBody)); })() }, sink);
    return sink;
  };
  return { stop, deps, prices, ai, keys, identity, disabled, quote, meter, agentMeter, reserve, receipts, grant, send, counts: () => ({ sent, ownReads }),
    choose: (value: AgentAiSource) => { selected = value; }, connect: () => { connected = true; } };
}

it("a truncated paid call settles at the input estimate, never final and with unknown billable usage (failed-call.ts)", async () => {
  const g = await world();
  g.ai.transport = async () => ({ status: 200, body: (async function* () { yield Buffer.from("event: ping\ndata: {}\n\n"); })() });
  expect((await g.send(paths[0])).status).toBe(200);
  expect(g.receipts).toHaveLength(1);
  expect(g.receipts[0]).toMatchObject({ billing: "customer", status: "estimated", reason: "missing_usage", neverConfirmed: true, usageComplete: false, billableMicros: { state: "unavailable" } });
  const amount = (g.receipts[0]!.amountMicros as { value: number }).value, held = (g.receipts[0]!.originalReservationMicros as { value: number }).value;
  expect(amount).toBeGreaterThan(0);
  expect(amount).toBeLessThan(held);
});

it("a refused paid provider call settles a zero-bill receipt", async () => {
  const g = await world();
  g.ai.transport = async () => ({ status: 403, body: (async function* () { yield Buffer.from("{}"); })() });
  expect((await g.send(paths[0])).status).toBe(503);
  expect(g.receipts).toMatchObject([{ billing: "customer", status: "final", amountMicros: { state: "available", value: 0 }, billableMicros: { state: "available", value: 0 } }]);
  expect((await g.agentMeter.read(scope)).find(r => r.item === "company")?.spentMicros).toBe(0);
});

it.each(["settlement", "identity"])("missing receipt %s refuses before a paid call", async capability => {
  const g = await world();
  if (capability === "settlement") Reflect.set(g.meter, "settleV2", undefined);
  else g.deps.chargeReceipts = { source: () => undefined };
  expect((await g.send(paths[0])).status).toBe(capability === "settlement" ? 409 : 503);
  expect(g.counts().sent).toBe(0);
  expect(g.receipts).toEqual([]);
});
const scope = { iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid };

for (const path of paths) {
  it(`${path}: own Anthropic key accepts the gateway quote that new Code signs (lead 4 probe)`, async () => {
    const g = await world(false, 1_000_000_000, true);
    expect(g.grant).toMatchObject({ provider: "anthropic", sourceId: g.identity.sourceId, connectionRevision: g.identity.versionId });
    expect((await g.send(path)).status).toBe(200);
    expect(g.counts()).toEqual({ sent: 1, ownReads: 1 });
    expect(g.receipts).toMatchObject([{ billing: "external_provider", source: { kind: "company_key", id: g.identity.sourceId }, billableMicros: { value: 0 } }]);
    expect(g.meter.billedCalls(claims.iss, claims.cid)).toEqual([]);
  });
  it(`${path}: rotated or missing own-key binding refuses before a hold or key read`, async () => {
    for (const missing of [false, true]) {
      const g = await world(false, 1_000_000_000, true);
      if (missing) g.keys.resolveForCharge = async () => undefined;
      else g.identity.versionId = "22222222-2222-4222-8222-222222222222";
      expect((await g.send(path)).status).toBe(missing ? 403 : 409);
      expect(g.counts()).toEqual({ sent: 0, ownReads: 0 });
      expect(g.reserve).not.toHaveBeenCalled();
      expect((await g.meter.read(scope)).every(r => r.committed === 0)).toBe(true);
    }
  });
  it(`${path}: disabling a Rovara model invalidates quotes and refuses a previously signed call before any hold`, async () => {
    const g = await world(); g.disabled.add(model);
    expect((await g.quote()).body).toMatchObject({ state: "unavailable" });
    expect((await g.send(path)).status).toBe(400);
    expect(g.counts()).toEqual({ sent: 0, ownReads: 0 }); expect(g.receipts).toEqual([]);
    expect(g.reserve).not.toHaveBeenCalled();
    expect((await g.meter.read(scope)).every(r => r.committed === 0)).toBe(true);
  });
  it(`${path}: consults the shared source gate before any hold`, async () => {
    const g = await world();
    const gate = vi.spyOn(agentAi, "agentSourceSwitchedOn").mockReturnValue(false);
    try {
      expect((await g.send(path)).status).toBe(403);
      expect(gate).toHaveBeenCalledWith("rovara", expect.any(Set));
      expect(g.counts()).toEqual({ sent: 0, ownReads: 0 }); expect(g.receipts).toEqual([]);
      expect(g.reserve).not.toHaveBeenCalled();
      expect((await g.meter.read(scope)).every(r => r.committed === 0)).toBe(true);
    } finally { gate.mockRestore(); }
  });
  it(`${path}: bills a no-source company once, with an exact receipt and one combined-company debit`, async () => {
    const g = await world();
    expect((await g.send(path)).status).toBe(200);
    expect(g.counts()).toEqual({ sent: 1, ownReads: 0 });
    expect(g.receipts).toHaveLength(1);
    // 2 input + 5 output*2 + 3 cache read*0.5 + 4 cache write*2 = ceil(21.5) = 22 micros.
    expect(g.receipts[0]).toMatchObject({ billing: "customer", status: "final", amountMicros: { state: "available", value: 22 },
      billableMicros: { state: "available", value: 22 }, source: { kind: "rovara_ai", id: g.grant.sourceId, connectionRevision: g.grant.connectionRevision } });
    expect(g.meter.billedCalls(claims.iss, claims.cid)).toMatchObject([{ line: { charge: "customer" }, settledMicros: 22 }]);
    expect((await g.meter.read(scope)).find(r => r.item === "company")?.spentMicros).toBe(22);
    expect((await g.agentMeter.read(scope)).find(r => r.item === "company")?.spentMicros).toBe(22);
    const receipt = g.receipts[0]!;
    await g.meter.settleV2({ reservationId: receipt.callId, receipt });
    expect((await g.agentMeter.read(scope)).find(r => r.item === "company")?.spentMicros).toBe(22);
    expect(g.meter.billedCalls(claims.iss, claims.cid)).toHaveLength(1);
  });
  it(`${path}: only the configured exempt company is free; its spend still counts`, async () => {
    const g = await world(true);
    expect((await g.send(path)).status).toBe(200);
    expect(g.receipts).toMatchObject([{ billing: "exempt", billableMicros: { state: "available", value: 0 }, amountMicros: { value: 22 } }]);
    expect(g.meter.billedCalls(claims.iss, claims.cid)).toMatchObject([{ line: { charge: "exempt" } }]);
    expect((await g.agentMeter.read(scope)).find(r => r.item === "company")?.spentMicros).toBe(22);
  });
  it(`${path}: refuses missing authorization before spend, including exempt companies`, async () => {
    for (const exempt of [false, true]) {
      const g = await world(exempt);
      expect((await g.send(path, { runPrice: undefined })).status).toBe(409);
      expect(g.counts().sent).toBe(0); expect(g.receipts).toEqual([]);
    }
  });
  it(`${path}: the hosted-purpose admission refusal logs which check refused, and the answer is unchanged`, async () => {
    const cases: Array<[string, (g: Awaited<ReturnType<typeof world>>) => void, Record<string, unknown>]> = [
      ["rovara_signed_price_missing", () => undefined, { runPrice: undefined }],
      ["receipts_unavailable", (g) => { delete g.deps.chargeReceipts; }, {}],
      ["settlement_unavailable", (g) => { Reflect.set(g.meter, "settleV2", undefined); }, {}],
    ];
    for (const [reason, arrange, changes] of cases) {
      const g = await world(); const logs: unknown[] = []; g.deps.log = (event) => logs.push(event);
      arrange(g);
      const sink = await g.send(path, changes);
      expect(sink.status).toBe(409);
      expect(sink.text()).toBe(JSON.stringify({ error: { type: "run_price_authorization_required", message: "AI source or price changed; pause this run for fresh authorization." } }));
      expect(logs.filter((line) => (line as { event?: unknown }).event === "refused")).toEqual([{ event: "refused", code: "run_price_authorization_required", status: 409, route: path.includes("learning") ? "learning" : "answers", payer: "rovara", reason }]);
      expect(g.counts().sent).toBe(0);
    }
  });
  it(`${path}: unpriced or estimated rows refuse before any reservation or send`, async () => {
    for (const missing of [false, true]) {
      const g = await world();
      const exact = g.prices.effectiveFor("bedrock", catalogModel, "chat");
      g.deps.prices = missing ? { priceFor: () => undefined } : {
        priceFor: () => undefined, quoteBasis: g.prices.quoteBasis.bind(g.prices), effectiveFor: () => ({ ...exact, estimated: true, knownTokenPrice: true }),
      };
      expect((await g.send(path)).status).toBe(409);
      expect(g.counts().sent).toBe(0); expect(g.receipts).toEqual([]);
      expect(g.reserve).not.toHaveBeenCalled();
      expect((await g.meter.read(scope)).every(r => r.committed === 0)).toBe(true);
    }
  });
  it(`${path}: a company cap stops spend`, async () => {
    const g = await world(false, 0);
    expect((await g.send(path)).status).toBe(422);
    expect(g.counts().sent).toBe(0); expect(g.receipts).toEqual([]);
  });
  it.each(["bedrock_byo", "openai_key", "custom_endpoint", "openrouter_key"] as const)(`${path}: saved %s refuses without an Anthropic or Rovara fallback`, async saved => {
    const g = await world(); g.choose(saved); g.connect();
    const sink = await g.send(path);
    expect(sink.status).toBe(403);
    expect(sink.text()).toContain("selected AI source cannot serve");
    expect(g.counts()).toEqual({ sent: 0, ownReads: 0 });
    expect(g.receipts).toEqual([]);
    expect(g.reserve).not.toHaveBeenCalled();
    expect(g.meter.billedCalls(claims.iss, claims.cid)).toEqual([]);
    expect((await g.agentMeter.read(scope)).every(r => r.committed === 0)).toBe(true);
  });
  it(`${path}: explicit Rovara choice wins over a connected key`, async () => {
    const g = await world(); g.choose("rovara"); g.connect();
    expect((await g.send(path)).status).toBe(200);
    expect(g.counts()).toEqual({ sent: 1, ownReads: 0 });
  });
  it(`${path}: stale source binding or unavailable receipts cannot spend`, async () => {
    for (const missingReceipts of [false, true]) {
      const g = await world();
      if (missingReceipts) delete g.deps.chargeReceipts;
      const sink = await g.send(path, missingReceipts ? {} : { runPrice: { ...g.grant, connectionRevision: "stale" } });
      expect(sink.status).toBe(409); expect(g.counts().sent).toBe(0); expect(g.receipts).toEqual([]);
    }
  });
}

// DEC 328: answers, learning and Slack company chat use this same gateway admission.
it.each(paths)("%s: the install pause beats every hold/send even when Demo is exempt", async path => {
  const g = await world(true);
  g.stop.enabled.mockResolvedValue(false);
  const sink = await g.send(path);
  expect(sink.status).toBe(403);
  expect(JSON.parse(sink.text())).toEqual({ error: { type: "not_allowed", message: "Rovara's AI is paused on this install. Your work is safe; try again later or use your own AI source." } });
  expect(g.reserve).not.toHaveBeenCalled();
  expect(g.counts()).toEqual({ sent: 0, ownReads: 0 });
  expect(g.receipts).toEqual([]);
  expect(g.meter.billedCalls(claims.iss, claims.cid)).toEqual([]);
});
it.each(paths)("%s: own-key purpose calls ignore the install pause", async path => {
  const g = await world(false, 1_000_000_000, true);
  g.stop.enabled.mockResolvedValue(false);
  expect((await g.send(path)).status).toBe(200);
  expect(g.stop.enabled).not.toHaveBeenCalled();
});
