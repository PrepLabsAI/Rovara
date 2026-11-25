// Owner rule (2026-11-23), gateway side: a route whose catalogue write price is ABSENT carries the versioned no-write basis (ANY reviewed model). At runtime a
// reported cache write (write tokens, or a cost part named for a write) STOPS the call, SETTLES at max(hold, reported cost, token cost with the write rated at the
// highest listed price) and latches the source stop, so the route is refused afterwards. A priced-write route keeps its behaviour. The harness side is
// openrouter-qualify-cache-write-rule.test.ts; the two share the one name pattern (cacheWriteCostReported / CACHE_WRITE_NAME) and the align test pins them together.
import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { claims, now, setup, call, mint, requestBody, scope, caps } from "./model-gateway-fixture.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { cacheWriteCostReported, translatedAnswer } from "../../packages/model-gateway/src/agent-openai.js";
import { openRouterPolicy, openRouterRates, OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION } from "../../packages/model-gateway/src/openrouter-policy.js";
import { settleChargeAmount } from "../../packages/model-gateway/src/reported-cost.js";
beforeAll(denyNetwork);

const MODEL = "vendor/no-write-model"; // NOT on the relaxed list
const base = { model: MODEL, route: "fixture", pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000003", request: "0", input_cache_read: "0.0000005", input_cache_write: "0" }, max_completion_tokens: 2048, reasoning: { mode: "disabled" as const }, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "fixture" };
const noWrite = { ...base, cacheWriteBasis: "never_requested_enforced" as const, cacheWriteEnforcementVersion: OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION };
// The version key is OMITTED (not set to undefined: exactOptionalPropertyTypes), with the basis still claimed.
const withoutVersion = Object.fromEntries(Object.entries(noWrite).filter(([key]) => key !== "cacheWriteEnforcementVersion")) as typeof base & { cacheWriteBasis: "never_requested_enforced" };
const priced = { ...base, pricing: { ...base.pricing, input_cache_write: "0.000004" } };

it("G1: the validator accepts the no-write basis for ANY model with an explicit zero write price, and refuses it with a priced write or a stale version", () => {
 expect(openRouterPolicy(MODEL, now, [noWrite])).toMatchObject({ cacheWriteBasis: "never_requested_enforced", cacheWriteEnforcementVersion: OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION, pricing: { input_cache_write: "0" } });
 expect(openRouterPolicy(MODEL, now, [{ ...noWrite, pricing: { ...noWrite.pricing, input_cache_write: "0.000004" } }])).toBeUndefined();
 expect(openRouterPolicy(MODEL, now, [{ ...noWrite, cacheWriteEnforcementVersion: "openrouter-no-cache-write-v0" }])).toBeUndefined();
 expect(openRouterPolicy(MODEL, now, [withoutVersion])).toBeUndefined();
 expect(openRouterPolicy(MODEL, now, [{ ...base, cacheWriteBasis: "assumed" as never }])).toBeUndefined();
 // A priced row has no basis and is unchanged; the basis is part of the hash.
 expect(openRouterPolicy(MODEL, now, [priced])).toBeDefined();
 expect(openRouterPolicy(MODEL, now, [noWrite])!.hash).not.toBe(openRouterPolicy(MODEL, now, [base])!.hash);
});

it("G2: a no-write row rates a reported write at the HIGHEST listed per-token price; a priced row keeps max(prompt, write)", () => {
 const rates = openRouterRates(openRouterPolicy(MODEL, now, [noWrite])!);
 expect(rates).toMatchObject({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 3_000_000, cacheReadMicrosPerMTok: 500_000, cacheWrite5mMicrosPerMTok: 3_000_000, cacheWrite1hMicrosPerMTok: 3_000_000 });
 expect(openRouterRates(openRouterPolicy(MODEL, now, [priced])!)).toMatchObject({ cacheWrite5mMicrosPerMTok: 4_000_000, cacheWrite1hMicrosPerMTok: 4_000_000 });
 expect(openRouterRates(openRouterPolicy(MODEL, now, [{ ...base, pricing: { ...base.pricing, input_cache_write: "0.0000001" } }])!)).toMatchObject({ cacheWrite5mMicrosPerMTok: 1_000_000 });
});

it("G3: the settle floor for a reported write is max(hold, reported cost, token cost with the write at the highest price): never below it", () => {
 const policy = openRouterPolicy(MODEL, now, [noWrite])!;
 const price = openRouterRates(policy) as never;
 // 100,000 write tokens: at the stored zero write price that would be free; at the highest listed price (3 micro-USD/token) it is 300,000.
 const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 100_000 };
 const safe = settleChargeAmount({ retainMissingUsage: true, usage, price, reservationMicros: 100, reportedCostMicros: 1_000 });
 expect(safe.actualMicros).toBe(300_000);
 // The reported cost above everything wins; the hold wins when it is the largest.
 expect(settleChargeAmount({ retainMissingUsage: true, usage, price, reservationMicros: 100, reportedCostMicros: 900_000 }).actualMicros).toBe(900_000);
 expect(settleChargeAmount({ retainMissingUsage: true, usage, price, reservationMicros: 5_000_000, reportedCostMicros: 1_000 }).actualMicros).toBe(5_000_000);
});

it("G4: cacheWriteCostReported: a write-named cost part that is not exactly zero counts; zero, absent and unrelated parts do not", () => {
 expect(cacheWriteCostReported({ cost: 1, cost_details: { upstream_inference_cost: 1, upstream_inference_cache_write_cost: 0.0000005 } })).toBe(true);
 expect(cacheWriteCostReported({ cost_details: { cache_creation_cost: "0.1" } })).toBe(true);
 expect(cacheWriteCostReported({ cost_details: { input_cache_write: "unreadable" } })).toBe(true);
 expect(cacheWriteCostReported({ cache_write_cost: 0.001 })).toBe(true);
 expect(cacheWriteCostReported({ cost_details: { upstream_inference_cache_write_cost: 0 } })).toBe(false);
 expect(cacheWriteCostReported({ cost_details: { upstream_inference_cache_write_cost: "0" } })).toBe(false);
 expect(cacheWriteCostReported({ cost: 1, cost_details: { upstream_inference_cost: 1, upstream_inference_prompt_cost: 0.5 } })).toBe(false);
 expect(cacheWriteCostReported({ prompt_tokens_details: { cache_write_tokens: 5 } })).toBe(false); // token counts are read by anthropicUsageOf, not here
 expect(cacheWriteCostReported(undefined)).toBe(false);
});

type Variant = { name: string; tariff: typeof noWrite | typeof priced; usage: Record<string, unknown>; stops: boolean; refusesAfter: boolean };
const variants = (debit: number): Variant[] => [
 { name: "no-write + write tokens", tariff: noWrite, usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1 }, cost: debit }, stops: true, refusesAfter: true },
 { name: "no-write + a write cost part only (0 write tokens)", tariff: noWrite, usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, cost: debit, cost_details: { upstream_inference_cost: debit, upstream_inference_cache_write_cost: 0.0000005 } }, stops: true, refusesAfter: true },
 { name: "no-write + zero writes", tariff: noWrite, usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, cost: debit, cost_details: { upstream_inference_cost: debit } }, stops: false, refusesAfter: false },
 { name: "PRICED write + write tokens (unchanged: billed, not stopped)", tariff: priced, usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1 }, cost: debit, cost_details: { upstream_inference_cost: debit } }, stops: false, refusesAfter: false },
];
it.each(
 [false, true].flatMap(stream => [false, true].flatMap(durable => [0.02, 0.000001].flatMap(debit => variants(debit).map(v => ({ stream, durable, debit, v }))))),
)("G5 $v.name (stream=$stream durable=$durable debit=$debit)", async ({ stream, durable, debit, v }) => {
 const tariffs = [v.tariff];
 const prices = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }, { now: () => now, openRouterTariffs: tariffs }); await prices.reload();
 const source = { kind: "company_key" as const, id: "src_router", name: "Fixture", provider: "openrouter", connectionRevision: "r1" };
 const open = vi.fn(async () => "fixture-key");
 const keys = { connected: async () => true, keyFor: open, resolveForCharge: async () => ({ source, key: open }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) };
 const sources = { sourceFor: async () => "openrouter_key" as const };
 const quote = await answerRateQuote({ prices, keys, sources, now: () => now, region: "us-west-2", switchedOn: new Set(["openrouter"]), offeredProviders: new Set(["openrouter"]), openRouterTariffs: tariffs, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${MODEL}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
 expect(quote.status).toBe(200);
 const w = setup({ prices, agentKeys: keys, openRouterTariffs: tariffs, chargeReceipts: { source: (_c, _m, resolved) => resolved } });
 let meter: typeof w.meter | DynamoMeter = w.meter;
 if (durable) {
  const tables = { meter: "meter", ledger: "ledger", markers: "markers" }; const wire = new WireDynamo(Object.values(tables));
  meter = new DynamoMeter({ db: new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "fixture", secretAccessKey: "fixture" }), transport: wire.transport }), tables, now: () => now });
 }
 w.deps.meter = meter;
 const transport = vi.fn(async () => translatedAnswer("openrouter", { model: MODEL, streaming: stream }, 200, (async function* () {
  if (stream) yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: v.usage })}\n\ndata: [DONE]\n\n`);
  else yield Buffer.from(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: v.usage }));
 })(), () => undefined));
 w.deps.agentAi = { sources, switchedOn: new Set(["openrouter"]), openrouter: { transport } };
 const token = mint({ mdl: [MODEL], runPrice: (quote.body as { runPrice: RunPrice }).runPrice });
 const body = { ...requestBody, model: MODEL, stream };
 const reserve = vi.spyOn(meter, "reserve"); const settle = vi.spyOn(meter, "settleV2");
 const result = await call(w.deps, body, token);
 const held = reserve.mock.calls[0]![0].estimateMicros;
 const receipt = settle.mock.calls[0]![0].receipt;
 const reported = Math.ceil(debit * 1_000_000);
 if (v.stops) {
  // The call STOPS (the answer is refused; a stream is destroyed) ...
  expect(stream ? result.destroyed : result.status === 502).toBe(true);
  // ... and SETTLES SAFELY: never below max(hold, reported cost, token cost with the write rated at the highest listed price (3 micro-USD/token here)).
  // 10 prompt tokens: 1 write (marker or real) at 3, 9 input at 1, 1 output at 2.
  const tokenCost = 9 * 1 + 1 * 2 + 1 * 3;
  const expected = Math.max(held, reported, tokenCost);
  expect(receipt).toMatchObject({ status: expected > held ? "estimated" : "awaiting_usage", amountMicros: { state: "available", value: expected } });
  expect(receipt.usage).toMatchObject({ state: "available", value: { cacheWriteUnknown: 1 } });
  // ... and the ROUTE IS REFUSED afterwards (the durable source stop), with no second call sent.
  expect(await meter.sourceStop(claims.iss, claims.cid, "openrouter", "agent")).toMatchObject({ stopped: true });
  expect((await call(w.deps, body, token)).status).toBeGreaterThanOrEqual(400);
  expect(transport).toHaveBeenCalledTimes(1);
 } else {
  expect(stream ? result.destroyed : result.status === 200).toBe(stream ? false : true);
  expect(receipt.status === "final" || debit <= held / 1_000_000).toBe(true);
  expect((await meter.sourceStop(claims.iss, claims.cid, "openrouter", "agent"))?.stopped ?? false).toBe(debit * 1_000_000 > held);
 }
 void scope; void caps;
});
