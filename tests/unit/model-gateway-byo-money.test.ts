import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { answer, call, caps, claims, mint, now, requestBody, scope, setup } from "./model-gateway-fixture.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { UnknownPriceSource, type PriceSource } from "../../packages/model-gateway/src/price.js";
import { estimateCall } from "../../packages/model-gateway/src/estimate.js";
import { guardRequest } from "../../packages/model-gateway/src/guard.js";
import { fetchAWS } from "../../packages/model-gateway/src/price-sources.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import type { InMemoryMeter, ReserveInput } from "../../packages/model-gateway/src/meter.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { translatedAnswer } from "../../packages/model-gateway/src/agent-openai.js";
import { storedLearningKeys } from "../../packages/model-gateway/src/learning-keys.js";
import { createAnswersRoutes, ANSWERS_PATH, ANSWERS_STEP, ANSWERS_PAUSE_HEADER } from "../../packages/model-gateway/src/answers-route.js";
import { createLearningRoutes, LEARNING_PATH, LEARNING_STEP, LEARNING_PAUSE_HEADER } from "../../packages/model-gateway/src/learning-route.js";
import { handleGateway } from "../../packages/model-gateway/src/server.js";
import { MemorySink } from "./model-gateway-fixture.js";
import { AGENT_SOURCE_NOT_OFFERED } from "../../packages/model-gateway/src/server.js";
import { answerOfferedModels } from "../../packages/model-gateway/src/offered-models.js";
import { BEDROCK_SOURCE_ID } from "../../packages/model-gateway/src/product-keys.js";
import { storeKit, change, PRODUCT_COMPANY_OWNER } from "./model-gateway-product-fixture.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
beforeAll(denyNetwork);
async function meterStop(meter: InMemoryMeter | DynamoMeter, source: "bedrock_byo" | "openrouter") { return (await meter.sourceStop(scope.iss, scope.cid, source, "agent"))?.stopId; }
const alias = "claude-haiku-4-5", id = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const body = { ...requestBody, model: alias, stream: false };
const price = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 };
function world(prices: PriceSource = { priceFor: () => price }, input = 2, durable = false) {
  const sent = vi.fn(async () => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ type: "message", content: [], usage: { input_tokens: input, output_tokens: 1 } })); })() }));
  const assumed = vi.fn(async () => ({ ok: true as const, credentials: { accessKeyId: "fixture", secretAccessKey: "fixture", sessionToken: "fixture" } }));
  const w = setup({ prices, agentKeys: { connected: async () => false, keyFor: async () => undefined } });
  let wire: WireDynamo | undefined;
  if (durable) {
    const tables = { meter: "meter", ledger: "ledger", markers: "markers" };
    wire = new WireDynamo(Object.values(tables));
    w.deps.meter = new DynamoMeter({ db: new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "fixture", secretAccessKey: "fixture" }), transport: wire.transport }), tables, now: () => now });
  }
  const meter = w.deps.meter as InMemoryMeter | DynamoMeter;
  const settlements = vi.spyOn(meter, "settleV2");
  const holds: ReserveInput[] = [];
  const reserve = meter.reserve.bind(meter);
  vi.spyOn(meter, "reserve").mockImplementation(async value => { holds.push(value); return reserve(value); });
  w.deps.agentAi = { sources: { sourceFor: async () => "bedrock_byo" }, byo: {
    connection: async (iss, cid) => ({ row: { iss, cid, owner: "_company", sourceId: "own", versionId: "r1" }, connection: { scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-fixture", region: "us-west-2", models: { [alias]: id }, allowGlobal: false } }),
    sessions: { credentials: assumed, forget: () => undefined }, transport: () => sent,
  } };
  return { ...w, meter, wire, holds, assumed, sent, settlements };
}
for (const kind of ["image", "document", "audio", "unknown"] as const) it(`M1 refuses no-runPrice ${kind} before hold, STS and transport`, async () => {
  const w = world(UnknownPriceSource);
  const result = await call(w.deps, { ...body, messages: [{ role: "user", content: [{ type: kind, source: { type: "url", url: "https://image.example/large.png" } }, { type: "text", text: "Describe" }] }] }, mint({ mdl: [alias] }));
  expect(result.status).toBe(409); expect(w.holds).toEqual([]); expect(w.assumed).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
});
it("a refused no-runPrice Bedrock-account call logs which check refused, and the answer is unchanged", async () => {
  const CHANGED = JSON.stringify({ error: { type: "run_price_authorization_required", message: "AI source or price changed; pause this run for fresh authorization." } });
  const cases: Array<[string, PriceSource, unknown, (w: ReturnType<typeof world>) => void]> = [
    ["price_estimated", UnknownPriceSource, body, () => undefined],
    ["input_unbounded", { priceFor: () => price }, { ...body, messages: [{ role: "user", content: [{ type: 1 }] }] }, () => undefined],
    ["price_usage_estimated", { priceFor: () => ({ ...price, operatorReview: true }) }, body, () => undefined],
    ["settlement_unavailable", { priceFor: () => price }, body, (w) => { Reflect.set(w.meter, "settleV2", undefined); }],
  ];
  for (const [reason, prices, request, arrange] of cases) {
    const w = world(prices); const logs: unknown[] = []; w.deps.log = (event) => logs.push(event); arrange(w);
    const result = await call(w.deps, request, mint({ mdl: [alias] }));
    expect(result.status).toBe(409); expect(result.text()).toBe(CHANGED);
    expect(logs.filter((line) => (line as { event?: unknown }).event === "refused")).toEqual([{ event: "refused", code: "run_price_authorization_required", status: 409, route: "agent", payer: "bedrock_byo", reason }]);
    expect(w.holds).toEqual([]); expect(w.sent).not.toHaveBeenCalled();
  }
});
it("M1 refuses bounded no-runPrice input at an estimated price", async () => {
  const w = world(UnknownPriceSource);
  expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(409);
  expect(w.holds).toEqual([]); expect(w.assumed).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
});
for (const durable of [false, true]) {
  it(`legacy known bounded input works with exact worst-case hold (${durable})`, async () => {
    const w = world(undefined, 2, durable);
    expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(200);
    const guarded = guardRequest(Buffer.from(JSON.stringify(body)), { "content-type": "application/json" }, [alias], w.deps.modelLimits);
    if (!guarded.ok) throw new Error("fixture refused");
    // Bedrock's forwarded envelope replaces model/stream with anthropic_version.
    const rest = Object.fromEntries(Object.entries(JSON.parse(guarded.bytes.toString()) as Record<string, unknown>).filter(([key]) => !["model", "stream", "metadata"].includes(key)));
    const bytes = Buffer.byteLength(JSON.stringify({ anthropic_version: "bedrock-2023-05-31", ...rest }));
    const resolved = await resolvePrice(w.deps.prices!, "bedrock", id);
    expect(w.holds[0]?.estimateMicros).toBe(estimateCall(bytes, 10, resolved, 0, true));
    expect((await w.meter.read(scope)).every(row => row.spentMicros <= w.holds[0]!.estimateMicros)).toBe(true);
  });
  it(`M1 records true 100002 usage cost above hold, alarms and stops subsequent calls (${durable})`, async () => {
    const w = world(undefined, 100_000, durable);
    w.deps.caps = new FixedCapsSource({ ...caps, task: 1000, companyMonth: 1000 });
    expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(200);
    const hold = w.holds[0]!.estimateMicros;
    if (w.wire !== undefined) {
      const ledger = [...w.wire.fake.items.values()].find(row => typeof row.sk === "string" && row.sk.startsWith("CALL#"));
      expect(ledger).toMatchObject({ settledMicros: 100002, receipt: { amountMicros: { value: 100002 }, usage: { value: { input: 100000, output: 1 } } } });
      const tables = { meter: "meter", ledger: "ledger", markers: "markers" };
      const fresh = new DynamoMeter({ db: new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "fixture", secretAccessKey: "fixture" }), transport: w.wire.transport }), tables, now: () => now });
      expect(await fresh.reserve({ scope: { ...scope, tid: "task_3" }, caps, estimateMicros: 1, customerSource: "bedrock_byo", routeClass: "agent" })).toMatchObject({ ok: false, reason: "overrun" });
    }
    const rows = await w.meter.read(scope);
    expect(rows.every(row => row.spentMicros === 100002)).toBe(true);
    expect(rows.filter(row => row.overrun).map(row => row.item).sort()).toEqual(["company", "task"]);
    expect(await w.meter.sourceStop(scope.iss, scope.cid, "bedrock_byo", "agent")).toMatchObject({ stopped: true });
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "customer_source_over_reservation", source: "bedrock_byo", costMicros: 100002, heldMicros: hold, overageMicros: 100002 - hold }));
    expect((await call(w.deps, body, mint({ mdl: [alias], tid: "task_2" }))).status).toBe(422);
    expect(w.assumed).toHaveBeenCalledTimes(1); expect(w.sent).toHaveBeenCalledTimes(1);
    const receipt = w.settlements.mock.calls[0]![0].receipt;
    const revised = { ...receipt, revision: 2, replacesRevision: 1, amountMicros: { state: "available" as const, value: 100003 } };
    expect(await w.meter.applyChargeReceipt(revised)).toMatchObject({ result: "applied", deltaMicros: 1 });
    expect(await w.meter.applyChargeReceipt(revised)).toMatchObject({ result: "duplicate", deltaMicros: 0 });
    expect((await w.meter.read(scope)).every(row => row.spentMicros === 100003)).toBe(true);
    expect((await w.meter.read(scope)).filter(row => row.overrun).map(row => row.item).sort()).toEqual(["company", "task"]);
    if (w.wire !== undefined) {
      const stop = await meterStop(w.meter, "bedrock_byo");
      expect(await w.meter.clearSourceStop({ iss: scope.iss, cid: scope.cid, source: "bedrock_byo", routeClass: "agent", expectedStopId: stop!, actor: "arn:aws:iam::111111111111:user/operator", reason: "Invoice reviewed" })).toBe(true);
      w.deps.caps = new FixedCapsSource(caps);
      // Clearing a SOURCE stop never wipes separate accounting-cap overruns.
      expect((await call(w.deps, body, mint({ mdl: [alias], tid: "task_cleared" }))).status).toBe(422);
      expect(w.sent).toHaveBeenCalledTimes(1);
    }
  });
  for (const item of ["task", "companyMonth"] as const) it(`bounded no-runPrice ${item} admission cap before STS (${durable})`, async () => {
    const w = world(undefined, 2, durable); w.deps.caps = new FixedCapsSource({ ...caps, [item]: 1 });
    expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(422);
    expect(w.assumed).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
  });
}
it("DEC 263 replaces M2: non-exempt setup_draft defaults to company-billed Rovara AI", async () => {
  const w = setup({ agentKeys: { connected: async () => false, keyFor: async () => undefined } });
  const transport = vi.fn(async () => ({ status: 200, body: answer() }));
  w.deps.agentAi = { sources: { sourceFor: async () => undefined }, rovara: { models: new Map([[alias, id]]), exempt: new Set([`org_${"b".repeat(20)}`]), transport } };
  expect((await call(w.deps, { ...body, stream: true }, mint({ mdl: [alias], stp: "setup_draft" }))).status).toBe(200);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(w.meter.billedCalls(claims.iss, claims.cid)).toMatchObject([{ line: { charge: "customer" } }]);
});

it("M3 refuses a mixed-unit partial AWS token tariff", async () => {
  const dims = { cheap: { unit: "1M tokens", pricePerUnit: { USD: "1" } }, dearer: { unit: "1000 tokens", pricePerUnit: { USD: "1" } } };
  const offer = { products: { i: { attributes: { model: "Claude Haiku 4.5", usagetype: "US_input_tokens_standard-Units" } }, o: { attributes: { model: "Claude Haiku 4.5", usagetype: "US_output_tokens_standard-Units" } } }, terms: { OnDemand: { i: { t: { priceDimensions: dims } }, o: { t: { priceDimensions: dims } } } } };
  expect((await fetchAWS({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify(offer)) }) }, { now, minModels: 1, regions: ["us-west-2"] })).ok).toBe(false);
});
it("unknown exact Bedrock price is refused even if an Anthropic alias is known", async () => {
  const w = world({ priceFor: provider => provider === "anthropic" ? price : undefined });
  expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(409);
  expect(w.holds).toEqual([]); expect(w.assumed).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
});
for (const path of ["chosen", "default", "fallback"] as const) for (const item of ["task", "companyMonth"] as const) it(`caps apply to ${path} Bedrock admission: ${item}`, async () => {
  const w = world();
  if (path === "default") w.deps.agentAi = { ...w.deps.agentAi!, sources: { sourceFor: async () => undefined }, rovara: { models: new Map([[alias, id]]), exempt: new Set([claims.cid]), transport: w.deps.transport } };
  if (path === "fallback") w.deps.agentAi!.sources = { sourceFor: async () => "rovara", orderFor: async () => ({ source: "rovara", fallback: ["bedrock_byo"] }) };
  w.deps.caps = new FixedCapsSource({ ...caps, [item]: 1 });
  expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(422);
  expect(w.assumed).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
});

for (const limit of ["none", "task", "companyMonth"] as const) it(`valid signed Bedrock price retains admission and caps: ${limit}`, async () => {
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 1, sources: { litellm: { fetchedAt: now - 1, count: 1, entries: [{ provider: "bedrock", model: id, kind: "chat", ...price }] } } }), save: async () => false }, { now: () => now, overrides: [] }); await prices.reload();
  const w = world(prices);
  const quoted = await answerRateQuote({ prices, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]), sources: w.deps.agentAi!.sources, keys: w.deps.agentKeys!, byo: w.deps.agentAi!.byo!, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${alias}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  const grant = (quoted.body as { runPrice?: RunPrice }).runPrice; expect(grant).toBeDefined();
  if (limit !== "none") w.deps.caps = new FixedCapsSource({ ...caps, [limit]: 1 });
  expect((await call(w.deps, body, mint({ mdl: [alias], runPrice: grant }))).status).toBe(limit === "none" ? 200 : 422);
  expect(w.assumed).toHaveBeenCalledTimes(limit === "none" ? 1 : 0); expect(w.sent).toHaveBeenCalledTimes(limit === "none" ? 1 : 0);
});

for (const durable of [false, true]) it(`OpenRouter reports true above-hold money, alarms and refuses until operator clear (${durable})`, async () => {
  const w = world(undefined, 2, durable);
  const model = "openai/gpt-5-mini";
  const tariff = { model, route: "fixture", pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000002", request: "0", input_cache_read: "0.000001", input_cache_write: "0.000001" }, max_completion_tokens: 2048, reasoning: { mode: "disabled" as const }, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "offline-fixture" };
  const prices = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }, { now: () => now, openRouterTariffs: [tariff] }); await prices.reload();
  const source = { kind: "company_key" as const, id: "router", name: "Company OpenRouter", provider: "openrouter", connectionRevision: "r1" };
  const sent = vi.fn(async () => translatedAnswer("openrouter", { model, streaming: false }, 200, (async function* () { yield Buffer.from(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0.100002 } })); })(), () => undefined));
  w.deps.prices = prices; w.deps.openRouterTariffs = [tariff];
  w.deps.agentKeys = { connected: async () => true, keyFor: async () => "fixture", resolveForCharge: async () => ({ source, key: async () => "fixture" }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) };
  w.deps.agentAi = { sources: { sourceFor: async () => "openrouter_key" }, switchedOn: new Set(["openrouter"]), openrouter: { transport: sent } };
  w.deps.chargeReceipts = { source: (_claims, _model, resolved) => resolved };
  const quote = await answerRateQuote({ prices, keys: w.deps.agentKeys, sources: w.deps.agentAi.sources, now: () => now, region: "us-west-2", switchedOn: new Set(["openrouter"]), offeredProviders: new Set(["openrouter"]), openRouterTariffs: [tariff], verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  const runPrice = (quote.body as { runPrice: RunPrice }).runPrice;
  expect(runPrice).toBeDefined();
  const request = { ...body, model };
  const token = (tid: string) => mint({ mdl: [model], runPrice, tid });
  expect((await call(w.deps, request, token(claims.tid))).status).toBe(200);
  const hold = w.holds[0]!.estimateMicros;
  expect(hold).toBeLessThan(100002);
  expect(w.settlements.mock.calls[0]![0].receipt).toMatchObject({ amountMicros: { value: 100002 }, providerCostMicros: { value: 100002 } });
  expect((await w.meter.read(scope)).every(row => row.spentMicros === 100002)).toBe(true);
  expect(await w.meter.sourceStop(scope.iss, scope.cid, "openrouter", "agent")).toMatchObject({ stopped: true });
  expect(w.logs).toContainEqual(expect.objectContaining({ event: "customer_source_over_reservation", source: "openrouter", costMicros: 100002, heldMicros: hold, overageMicros: 100002 - hold }));
  expect((await call(w.deps, request, token("task_2"))).status).toBe(422);
  expect(sent).toHaveBeenCalledTimes(1);
  const receipt = w.settlements.mock.calls[0]![0].receipt;
  const revised = { ...receipt, revision: 2, replacesRevision: 1, amountMicros: { state: "available" as const, value: 100003 }, providerCostMicros: { state: "available" as const, value: 100003 } };
  expect(await w.meter.applyChargeReceipt(revised)).toMatchObject({ result: "applied", deltaMicros: 1 });
  expect((await w.meter.read(scope)).every(row => row.spentMicros === 100003)).toBe(true);
  if (w.wire !== undefined) {
    expect(w.wire.items("ledger").find(row => String(row.sk).startsWith("CALL#"))).toMatchObject({ settledMicros: 100003, receipt: { amountMicros: { value: 100003 } } });
    expect(await w.meter.clearSourceStop({ iss: scope.iss, cid: scope.cid, source: "openrouter", routeClass: "agent", expectedStopId: (await meterStop(w.meter, "openrouter"))!, actor: "arn:aws:iam::111111111111:user/operator", reason: "Invoice reviewed" })).toBe(true);
    expect((await call(w.deps, request, token("task_cleared"))).status).toBe(200);
    expect(sent).toHaveBeenCalledTimes(2);
  }
});

// DEC 263 supersedes round C R2-M2 refusal: every operator admission is billed by membership only.
for (const durable of [false, true]) for (const selected of ["default", "saved", "fallback"] as const) for (const signed of [false, true]) for (const exempt of [false, true]) it(`operator admission ${selected}, signed=${signed}, exempt=${exempt}, durable=${durable}`, async () => {
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 1, sources: { litellm: { fetchedAt: now - 1, count: 1, entries: [{ provider: "bedrock", model: id, kind: "chat", ...price }] } } }), save: async () => false }, { now: () => now, overrides: [] }); await prices.reload();
  const w = world(prices, 2, durable);
  const transport = vi.fn(async () => ({ status: 200, body: answer() }));
  const rovara = { sourceId: "operator", models: new Map([[alias, id]]), exempt: new Set(exempt ? [claims.cid] : []), transport };
  const sources = selected === "fallback" ? { sourceFor: async () => "bedrock_byo" as const, orderFor: async () => ({ source: "bedrock_byo" as const, fallback: ["rovara" as const] }) } : { sourceFor: async () => selected === "saved" ? "rovara" as const : undefined };
  w.deps.agentAi = { sources, rovara };
  w.deps.chargeReceipts = { source: (_claims, _model, resolved) => resolved };
  // Quote the same company and its actual source configuration, then bind the quote at dispatch.
  const quote = await answerRateQuote({ prices, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]), sources: { sourceFor: async () => "rovara" }, keys: w.deps.agentKeys!, rovara, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${alias}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  const runPrice = (quote.body as { runPrice?: RunPrice }).runPrice; expect(runPrice).toBeDefined();
  const r = await call(w.deps, { ...body, stream: true }, mint({ mdl: [alias], stp: "setup_draft", ...(signed ? { runPrice } : {}) }));
  expect(r.status).toBe(200);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(w.holds).toHaveLength(1);
  expect(w.holds[0]?.line?.charge).toBe(exempt ? "exempt" : "customer");
  expect(w.settlements.mock.calls[0]![0].receipt).toMatchObject({ billing: exempt ? "exempt" : "customer", source: { kind: "rovara_ai" }, usage: { state: "available" }, amountMicros: { state: "available" } });
  expect((await w.meter.read(scope)).every(row => row.spentMicros > 0)).toBe(true);
  if (w.wire) expect(w.wire.items("ledger").find(row => String(row.sk).startsWith("CALL#"))).toMatchObject({ receipt: { billing: exempt ? "exempt" : "customer" } });
});
for (const durable of [false, true]) it(`Bedrock reviewer records true cost, alarms and stops (${durable})`, async () => {
  const { InMemoryReviewerGrants } = await import("../../packages/model-gateway/src/reviewer-grants.js");
  const w = world(undefined, 100_000, durable);
  w.deps.reviewerGrants = new InMemoryReviewerGrants();
  const r = await call(w.deps, body, mint({ mdl: [alias], stp: "second_review", exp: now / 1000 + 120, reviewer: { kind: "second_review", slot: "second_review", ceilingUsd: 1 } }));
  expect(r.status).toBe(200);
  expect(w.logs).toContainEqual(expect.objectContaining({ event: "customer_source_over_reservation", source: "bedrock_byo", costMicros: 100002 }));
  expect((await w.meter.read(scope)).every(row => row.spentMicros === 100002)).toBe(true);
  expect((await call(w.deps, body, mint({ mdl: [alias], tid: "task_after_review" }))).status).toBe(422);
  expect(w.sent).toHaveBeenCalledTimes(1);
});
it("Bedrock reviewer-specific refusal precedes legacy unsafe-price/media refusal", async () => {
  const { InMemoryReviewerGrants } = await import("../../packages/model-gateway/src/reviewer-grants.js");
  const w = world(UnknownPriceSource); w.deps.reviewerGrants = new InMemoryReviewerGrants();
  const r = await call(w.deps, { ...body, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://image.example/test.png" } }] }] }, mint({ mdl: [alias], stp: "second_review", exp: now / 1000 + 120, reviewer: { kind: "second_review", slot: "second_review", ceilingUsd: 1 } }));
  expect(r.status).toBe(422); expect(w.holds).toEqual([]); expect(w.assumed).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
});
it("regional and global profile aliases retain the dearest regional premium in the hold", async () => {
  const { estimateCall } = await import("../../packages/model-gateway/src/estimate.js");
  const entries = ["global", "us", "eu", "apac"].map((geo, i) => ({ provider: "bedrock", model: `${geo}.anthropic.claude-haiku-4-5-20251001-v1:0`, kind: "chat" as const, inputMicrosPerMTok: 1_000_000 + i * 100_000, outputMicrosPerMTok: 2_000_000 + i * 200_000 }));
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 1, sources: { litellm: { fetchedAt: now - 1, count: 4, entries } } }), save: async () => false }, { now: () => now, overrides: [] }); await prices.reload();
  for (const entry of entries) {
    const resolved = await resolvePrice(prices, "bedrock", entry.model);
    expect(resolved.inputMicrosPerMTok).toBe(1_300_000); expect(resolved.outputMicrosPerMTok).toBe(2_600_000);
    expect(estimateCall(100, 100, resolved, 0, true)).toBeGreaterThanOrEqual(estimateCall(100, 100, entry, 0, true));
  }
});

for (const durable of [false, true]) for (const limit of ["task", "companyMonth"] as const) it(`non-exempt default admission respects ${limit} before send (${durable})`, async () => {
  const w = world(undefined, 2, durable);
  w.deps.agentAi = { sources: { sourceFor: async () => undefined }, rovara: { models: new Map([[alias, id]]), exempt: new Set(), transport: w.sent } };
  w.deps.caps = new FixedCapsSource({ ...caps, [limit]: 1 });
  expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(422);
  expect(w.sent).not.toHaveBeenCalled(); expect(w.assumed).not.toHaveBeenCalled();
  expect((await w.meter.read(scope)).every(row => row.committed === 0)).toBe(true);
});

// C-1 / Opus fa9c3427a: removing the adapter cannot change a connected company's payer.
async function missingBedrockAdapter(durable: boolean) {
  const w = world(undefined, 2, durable);
  const kit = storeKit({ bedrockCheck: async () => ({ result: "ok", models: { [id]: "ready" } }) });
  await kit.store.connect({ ...change(PRODUCT_COMPANY_OWNER, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: JSON.stringify({ scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-fixture", region: "us-west-2", models: { [alias]: id }, allowGlobal: false }) });
  const opened = vi.spyOn(kit.store, "useKey").mockImplementation(async () => { throw new Error("metadata must not open credentials"); });
  w.deps.agentKeys = storedLearningKeys(kit.store);
  w.deps.agentAi = { sources: { sourceFor: async () => undefined }, rovara: { models: new Map([[alias, id]]), exempt: new Set(), transport: w.sent } };
  w.deps.chargeReceipts = { source: (_claims, _model, resolved) => resolved };
  w.deps.upkeep = { limitFor: async () => 1_000_000_000 };
  return { ...w, kit, opened };
}
for (const durable of [false, true]) for (const mode of ["agent", "nonstream", "setup_draft", "nightly"] as const) it(`missing Bedrock adapter refuses ${mode} without a Rovara receipt or ledger line (${durable})`, async () => {
  const w = await missingBedrockAdapter(durable);
  const result = await call(w.deps, { ...body, stream: mode !== "nonstream" }, mint({ mdl: [alias], ...(mode === "setup_draft" ? { stp: "setup_draft" } : {}), ...(mode === "nightly" ? { src: "nightly" } : {}) }));
  // Assert money side effects first: the pre-fix route sends and settles on the wrong payer.
  expect(w.sent).not.toHaveBeenCalled();
  expect(w.holds).toEqual([]); expect(w.settlements).not.toHaveBeenCalled();
  if (w.wire !== undefined) expect(w.wire.items("ledger")).toEqual([]);
  else expect((w.meter as InMemoryMeter).billedCalls(claims.iss, claims.cid)).toEqual([]);
  expect(result.status).toBe(AGENT_SOURCE_NOT_OFFERED.status);
  expect(JSON.parse(result.text())).toMatchObject({ error: { type: AGENT_SOURCE_NOT_OFFERED.code } });
  expect(w.opened).not.toHaveBeenCalled(); expect(w.assumed).not.toHaveBeenCalled();
  expect((await w.meter.read(scope)).every(row => row.committed === 0)).toBe(true);
});
it("missing Bedrock adapter refuses offered models using metadata only", async () => {
  const w = await missingBedrockAdapter(false);
  const sources = w.deps.agentAi!.sources, keys = w.deps.agentKeys!, rovara = w.deps.agentAi!.rovara!;
  const offered = await answerOfferedModels({ sources, keys, rovara, disabled: new Set(), verify: async () => ({ ...claims, aud: "rovara-model-gateway-offered-models" }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/offered-models`, headers: { authorization: "Bearer fixture" } });
  expect(offered).toMatchObject({ status: 403, body: { error: { type: AGENT_SOURCE_NOT_OFFERED.code } } });
  expect(w.opened).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
});
it("missing Bedrock adapter never quotes Rovara AI using metadata only", async () => {
  const w = await missingBedrockAdapter(false);
  const sources = w.deps.agentAi!.sources, keys = w.deps.agentKeys!, rovara = w.deps.agentAi!.rovara!;
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 1, sources: { litellm: { fetchedAt: now - 1, count: 1, entries: [{ provider: "bedrock", model: id, kind: "chat", ...price }] } } }), save: async () => false }, { now: () => now, overrides: [] }); await prices.reload();
  const quote = await answerRateQuote({ sources, keys, rovara, prices, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]), verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${alias}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  expect(quote).toEqual({ status: 200, body: { state: "unavailable", reason: "missing_price" } });
  expect(w.opened).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
});
it("missing Bedrock adapter with unreadable metadata refuses before hold or send", async () => {
  const w = await missingBedrockAdapter(true);
  vi.spyOn(w.kit.store, "companyBedrock").mockRejectedValue(new Error("metadata unavailable"));
  expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(503);
  expect(w.holds).toEqual([]); expect(w.settlements).not.toHaveBeenCalled();
  expect(w.wire!.items("ledger")).toEqual([]); expect(w.opened).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
});

for (const purpose of ["answers", "learning"] as const) it(`missing Bedrock adapter preserves ${purpose} no_provider for an exempt company`, async () => {
  const w = await missingBedrockAdapter(false);
  const ai = w.deps.agentAi!.rovara!;
  const common = { keys: w.deps.agentKeys!, meter: w.meter, companyCaps: new FixedCapsSource(caps), modelLimits: w.deps.modelLimits, transport: w.sent,
    rovaraDefault: { ai: { ...ai, exempt: new Set([claims.cid]) }, sources: w.deps.agentAi!.sources } };
  if (purpose === "answers") w.deps.answers = createAnswersRoutes({ ...common, limits: { limitFor: async () => 1_000_000_000 } });
  else w.deps.learning = createLearningRoutes({ ...common, lessons: { isOn: async () => true } });
  const sink = new MemorySink();
  await handleGateway(w.deps, { method: "POST", url: purpose === "answers" ? ANSWERS_PATH : LEARNING_PATH, headers: { "content-type": "application/json", "x-api-key": mint({ mdl: [alias], stp: purpose === "answers" ? ANSWERS_STEP : LEARNING_STEP }) }, body: (async function* () { yield Buffer.from(JSON.stringify({ ...body, stream: true })); })() }, sink);
  expect(sink.status).toBe(403);
  expect(sink.headers[purpose === "answers" ? ANSWERS_PAUSE_HEADER : LEARNING_PAUSE_HEADER]).toBe("no_provider");
  expect(w.sent).not.toHaveBeenCalled(); expect(w.opened).not.toHaveBeenCalled(); expect(w.settlements).not.toHaveBeenCalled();
});
