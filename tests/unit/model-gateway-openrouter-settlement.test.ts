import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { claims, now, setup, call, mint, requestBody, scope, sse, caps } from "./model-gateway-fixture.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { fromChatCompletion, translatedAnswer } from "../../packages/model-gateway/src/agent-openai.js";
beforeAll(denyNetwork);
it.each([
 { floor: undefined, output: 5 }, { floor: 1000, output: 5 }, { floor: 20_000, output: 5 },
 { floor: undefined, output: 1_000_000 }, { floor: 1000, output: 1_000_000 },
])("retains max(hold, incomplete money $floor, valid token cost for $output output tokens)", async ({ floor, output }) => {
 const model = "vendor/model";
 const tariff = { model, route: "fixture", pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000002", request: "0.01", input_cache_read: "0", input_cache_write: "0.000001" }, max_completion_tokens: 2048, reasoning: { mode: "disabled" as const }, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "fixture" };
 const prices = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }, { now: () => now, openRouterTariffs: [tariff] }); await prices.reload();
 const source = { kind: "company_key" as const, id: "src_router", name: "Fixture", provider: "openrouter", connectionRevision: "r1" };
 const keys = { connected: async () => true, keyFor: async () => "fixture", resolveForCharge: async () => ({ source, key: async () => "fixture" }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) };
 const sources = { sourceFor: async () => "openrouter_key" as const };
 const quote = await answerRateQuote({ prices, keys, sources, now: () => now, region: "us-west-2", switchedOn: new Set(["openrouter"]), offeredProviders: new Set(["openrouter"]), openRouterTariffs: [tariff], verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
 const w = setup({ prices, agentKeys: keys, openRouterTariffs: [tariff], chargeReceipts: { source: (_c, _m, resolved) => resolved }, agentAi: { sources, switchedOn: new Set(["openrouter"]), openrouter: { transport: async () => ({ status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } }); yield sse("message_delta", { usage: { output_tokens: output } }); yield sse("message_stop"); })(), ...(floor === undefined ? {} : { reportedCostMicros: () => floor, reportedCostComplete: () => false }) }) } } });
 const reserve = vi.spyOn(w.meter, "reserve"); const settle = vi.spyOn(w.meter, "settleV2");
 await call(w.deps, { ...requestBody, model }, mint({ mdl: [model], runPrice: (quote.body as { runPrice: RunPrice }).runPrice }));
 const held = reserve.mock.calls[0]![0].estimateMicros; const tokenCost = 2 + 4 + 2 * output; const expected = Math.max(held, floor ?? 0, tokenCost);
 expect(held).toBeGreaterThan(10_000);
 expect(settle.mock.calls[0]?.[0].receipt).toMatchObject({ status: expected > held ? "estimated" : "awaiting_usage", reason: expected > held ? "derived_rate" : "missing_usage", amountMicros: { state: "available", value: expected } });
 expect((await w.meter.read(scope)).every(r => r.spentMicros === expected && r.estimatedMicros === expected)).toBe(true);
 expect(settle.mock.calls[0]?.[0].receipt.usage).toMatchObject({ state: "available", value: { input: 2, output } });
 const stop = await w.meter.sourceStop(claims.iss, claims.cid, "openrouter", "agent");
 expect(stop?.stopped === true).toBe(expected > held);
 if (expected > held) {
  expect(stop).toMatchObject({ costMicros: expected, heldMicros: held });
  expect(await w.meter.reserve({ scope: { ...scope, tid: "task_next" }, caps, estimateMicros: 1, customerSource: "openrouter", routeClass: "agent" })).toMatchObject({ ok: false, reason: "overrun" });
 }
 if (expected > held) expect(w.logs).toContainEqual({ event: "openrouter_over_reservation", costMicros: expected, holdMicros: held, sourceId: source.id });
 expect(prices.correctionFor("openrouter", model)).toBeUndefined();
});
it("never loses a known total debit because cost_details is malformed", () => {
 const result = fromChatCompletion({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 1, cost_details: { upstream_inference_cost: -1 } } }, "openrouter", "vendor/model", "fixture");
 expect(result.reportedCost).toBe(1_000_000);
});

it("distinguishes an upstream-only floor from complete total money on the real translator", async () => {
 const raw = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, cost_details: { upstream_inference_cost: 0.02 } } };
 const response = translatedAnswer("openrouter", { model: "vendor/model", streaming: false }, 200, (async function* () { yield Buffer.from(JSON.stringify(raw)); })(), () => undefined);
 for await (const chunk of response.body) expect(chunk.byteLength).toBeGreaterThan(0);
 expect(response.reportedCostMicros?.()).toBe(20_000);
 expect(Reflect.get(response, "reportedCostComplete")?.()).toBe(false);
});

// The request refusal and response accounting use the real builder/translator and both meters.
it.each([false, true].flatMap(stream => [false, true].flatMap(durable => [0.02, 0.000001].map(debit => ({ stream, durable, debit })))))("refuses unexpected cache writes and retains the debit (stream=$stream durable=$durable debit=$debit)", async ({ stream, durable, debit }) => {
 const model = "openai/gpt-5-mini";
 const tariff = { model, route: "fixture", pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0", request: "0", input_cache_read: "0", input_cache_write: "0" }, cacheWriteBasis: "never_requested_enforced" as const, cacheWriteEnforcementVersion: "openrouter-no-cache-write-v1", max_completion_tokens: 2048, reasoning: { mode: "disabled" as const }, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "fixture" };
 // Qualification normalizes the sparse catalog and retains its enforcement proof.
 const tariffs = [tariff];
 const prices = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }, { now: () => now, openRouterTariffs: tariffs }); await prices.reload();
 const source = { kind: "company_key" as const, id: "src_router", name: "Fixture", provider: "openrouter", connectionRevision: "r1" };
 const open = vi.fn(async () => "fixture-key");
 const keys = { connected: async () => true, keyFor: open, resolveForCharge: async () => ({ source, key: open }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) };
 const sources = { sourceFor: async () => "openrouter_key" as const };
 const quote = await answerRateQuote({ prices, keys, sources, now: () => now, region: "us-west-2", switchedOn: new Set(["openrouter"]), offeredProviders: new Set(["openrouter"]), openRouterTariffs: tariffs, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
 expect(quote.status).toBe(200); expect(quote.body).toHaveProperty("runPrice");
 const w = setup({ prices, agentKeys: keys, openRouterTariffs: tariffs, chargeReceipts: { source: (_c, _m, resolved) => resolved } });
 let meter: typeof w.meter | DynamoMeter = w.meter;
 if (durable) {
  const tables = { meter: "meter", ledger: "ledger", markers: "markers" }; const wire = new WireDynamo(Object.values(tables));
  meter = new DynamoMeter({ db: new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "fixture", secretAccessKey: "fixture" }), transport: wire.transport }), tables, now: () => now });
 }
 w.deps.meter = meter;
 const usage = { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1 }, cost: debit };
 const transport = vi.fn(async () => translatedAnswer("openrouter", { model, streaming: stream }, 200, (async function* () {
  if (stream) {
   yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
  } else yield Buffer.from(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage }));
 })(), () => undefined));
 w.deps.agentAi = { sources, switchedOn: new Set(["openrouter"]), openrouter: { transport } };
 const token = mint({ mdl: [model], runPrice: (quote.body as { runPrice: RunPrice }).runPrice });
 const body = { ...requestBody, model, stream };
 for (const cache of [{ cache_control: {} }, { prompt_caching: true }]) {
  expect((await call(w.deps, { ...body, ...cache }, token)).status).toBeGreaterThanOrEqual(400);
 }
 expect(transport).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
 const reserve = vi.spyOn(meter, "reserve"); const settle = vi.spyOn(meter, "settleV2");
 const result = await call(w.deps, body, token);
 expect(stream ? result.destroyed : result.status === 502).toBe(true);
 const held = reserve.mock.calls[0]![0].estimateMicros;
 const expected = Math.max(held, Math.ceil(debit * 1_000_000));
 expect(settle.mock.calls[0]?.[0].receipt).toMatchObject({ status: expected > held ? "estimated" : "awaiting_usage", amountMicros: { state: "available", value: expected }, usage: { value: { cacheWriteUnknown: 1 } } });
 expect(await meter.sourceStop(claims.iss, claims.cid, "openrouter", "agent")).toMatchObject({ stopped: true });
 expect((await call(w.deps, body, token)).status).toBeGreaterThanOrEqual(400); expect(transport).toHaveBeenCalledTimes(1);
});

// LIVE6: keep admission/holds dearer, settle inclusive reasoning at completion's rate.
it.each([false, true].flatMap(stream => [false, true].flatMap(durable => [
 { debit: 0.000012, expected: 20 }, // tokens dominate: 10 * 1 + 5 * 2
 { debit: 0.000022, expected: 22 }, // reported dominates, below the old dearer 25
 { debit: 0.000030, expected: 30 },
].map(money => ({ stream, durable, ...money })))))('LIVE6 settles max(reported, cheapest token cost) stream=$stream durable=$durable debit=$debit', async ({ stream, durable, debit, expected }) => {
 const model = 'vendor/model';
 const tariff = { model, route: 'fixture', pricing: { prompt: '0.000001', completion: '0.000002', internal_reasoning: '0.000003', request: '0.000004', input_cache_read: '0', input_cache_write: '0' }, max_completion_tokens: 2048, reasoning: { mode: 'bounded' as const, max_tokens: 1024 }, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: 'fixture' };
 const prices = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }, { now: () => now, openRouterTariffs: [tariff] }); await prices.reload();
 const source = { kind: 'company_key' as const, id: 'src_router', name: 'Fixture', provider: 'openrouter', connectionRevision: 'r1' };
 const keys = { connected: async () => true, keyFor: async () => 'fixture', resolveForCharge: async () => ({ source, key: async () => 'fixture' }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) };
 const sources = { sourceFor: async () => 'openrouter_key' as const };
 const quote = await answerRateQuote({ prices, keys, sources, now: () => now, region: 'us-west-2', switchedOn: new Set(['openrouter']), offeredProviders: new Set(['openrouter']), openRouterTariffs: [tariff], verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: 'GET', url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: 'Bearer fixture' } });
 expect(quote.status).toBe(200);
 const w = setup({ prices, agentKeys: keys, openRouterTariffs: [tariff], chargeReceipts: { source: (_c, _m, resolved) => resolved } });
 let meter: typeof w.meter | DynamoMeter = w.meter;
 if (durable) {
  const tables = { meter: 'meter', ledger: 'ledger', markers: 'markers' }; const wire = new WireDynamo(Object.values(tables));
  meter = new DynamoMeter({ db: new Dynamo({ region: 'us-west-2', credentials: async () => ({ accessKeyId: 'fixture', secretAccessKey: 'fixture' }), transport: wire.transport }), tables, now: () => now });
 }
 w.deps.meter = meter;
 // Reasoning exceeds both completion and the requested reasoning cap; never double-bill it.
 const usage = { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 1200 }, cost: debit, cost_details: { upstream_inference_cost: debit } };
 w.deps.agentAi = { sources, switchedOn: new Set(['openrouter']), openrouter: { transport: async () => translatedAnswer('openrouter', { model, streaming: stream }, 200, (async function* () {
  if (stream) yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`);
  else yield Buffer.from(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage }));
 })(), () => undefined) } };
 const reserve = vi.spyOn(meter, 'reserve'); const settle = vi.spyOn(meter, 'settleV2');
 const result = await call(w.deps, { ...requestBody, model, stream, max_tokens: 1280 }, mint({ mdl: [model], runPrice: (quote.body as { runPrice: RunPrice }).runPrice }));
 expect(result.status).toBe(200); expect(result.destroyed).toBe(false);
 // Original dearer output hold remains: 1280 * 3 plus prompt and request.
 expect(reserve.mock.calls[0]?.[0].estimateMicros).toBeGreaterThan(3840);
 expect(settle.mock.calls[0]?.[0].receipt).toMatchObject({ status: 'final', amountMicros: { value: expected }, providerCostMicros: { value: Math.ceil(debit * 1_000_000) }, usage: { value: { input: 10, output: 5 } } });
 expect((await meter.read(scope)).every(row => row.spentMicros === expected && row.estimatedMicros === 0)).toBe(true);
 expect((await meter.sourceStop(claims.iss, claims.cid, 'openrouter', 'agent'))?.stopped ?? false).toBe(false);
 expect(w.logs).toContainEqual({ event: 'settled', estimated: false, costMicros: expected, appliedMaxOutputTokens: 1280 });
});
