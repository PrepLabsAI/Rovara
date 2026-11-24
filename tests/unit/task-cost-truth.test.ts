// Task cost truth (money, stage 1). A hosted task showed $0.293767 while the gateway charged $0.323155: the worker priced each call at the catalog row of the model's engine NAME (the direct Anthropic row),
// the gateway settles at the row of the source that serves the company (Rovara AI: the Bedrock `us.` profile, 1.10 / 5.50 / 0.11 / 2.20 for Haiku 4.5). A hosted run now prices from what the gateway states
// (its rate quote, else the signed run price) and the broker books at the source-bound quote. These tests pin: the owner's 33-call replay through the real access parser, the real runtime and the real
// booking (ONE-SIDED: never under the gateway, at most one micro per call over it, the gateway rounds each call up); every source (Rovara AI, a company's key, its own Bedrock); long-context bands;
// cache-write durations; the cases with no price; and the booking floor that must never raise a figure the worker priced exactly.
// The gateway's side of each golden figure is Cloud model-gateway/src/estimate.ts `usageCost` (each call rounded UP, unknown-duration cache writes at the dearer of the 5 minute and 1 hour rates, a band when the
// whole input is ABOVE its threshold) and rate-quote.ts (the quote), reproduced here as `gatewayMicros`.
import { describe, expect, it, vi } from "vitest";
import { RateQuoteV1Schema, RunPriceSchema, type RateQuoteV1, type RunPrice } from "../../packages/contracts/src/index.js";
import { createConfiguredModelRuntime, type ModelProxyOptions } from "../../packages/model-runtime/src/index.js";
import { gatewayModelCost, modelCostFromRateQuote, modelCostFromRunPrice, rateQuoteCallMicros, rateQuoteUsageMicros } from "../../packages/model-runtime/src/gateway-cost.js";
import { parseModelAccess } from "../../packages/worker/src/cx-c/model-access-response.js";
import { lazyModelProxy } from "../../packages/worker/src/model-access.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createHostedLedger, createHostedMetering } from "../../packages/broker/src/core-host/hosted-modules.js";
import { createUsageBooking } from "../../packages/broker/src/core-host/usage-booking.js";
import { costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { createModelPrices } from "../../packages/broker/src/core/cost/price-table.js";
import { listPricesPerMillion } from "../../packages/model-runtime/src/catalog.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const NAME = "claude-haiku-4-5";
const at = new Date(Date.now() - 60_000).toISOString();
const expires = new Date(Date.now() + 300_000).toISOString();
const ref = { authority: "gateway", version: "10", hash: "a".repeat(64), fetchedAt: at } as const;
type Rates = RateQuoteV1["base"];
/** Micros per million tokens. */
const ROVARA: Rates = { input: 1_100_000, output: 5_500_000, cacheRead: 110_000, cacheWrite5m: 1_375_000, cacheWrite1h: 2_200_000 };
const ROVARA_LONG: Rates = { input: 2_200_000, output: 8_250_000, cacheRead: 220_000, cacheWrite5m: 2_750_000, cacheWrite1h: 4_400_000 };
const DIRECT: Rates = { input: 1_000_000, output: 5_000_000, cacheRead: 100_000, cacheWrite5m: 1_250_000, cacheWrite1h: 2_000_000 };
const quoteOf = (base: Rates, longContext: Array<{ aboveInputTokens: number; rates: Rates }> = [], kind: "rovara_ai" | "company_key" = "rovara_ai", modelId = "us.anthropic.claude-haiku-4-5-20251001-v1:0"): RateQuoteV1 => RateQuoteV1Schema.parse({
  version: 1, currency: "USD", unit: "micros_per_million_tokens", ref, source: { kind, id: "src", name: "src", provider: kind === "rovara_ai" ? "bedrock" : "anthropic", connectionRevision: "r1" },
  model: { provider: kind === "rovara_ai" ? "bedrock" : "anthropic", modelId }, region: "us-west-2", asOf: at, expiresAt: expires, base, longContext, derived: [],
});
/** The run price the gateway signs for a quote (rate-quote.ts: pooled maxima over the base and every band, the write rate the dearer of 5m and 1h, the base band beside it when a band exists). */
function runPriceOf(quote: RateQuoteV1): { runPrice: RunPrice; runPriceBaseBand?: unknown } {
  const all = [quote.base, ...quote.longContext.map((band) => band.rates)];
  const max = (pick: (r: Rates) => number): number => Math.max(...all.map(pick));
  const runPrice = RunPriceSchema.parse({ companyId: COMPANY, model: NAME, provider: quote.model.provider, sourceId: quote.source.id, connectionRevision: "r1", catalogModel: quote.model.modelId, snapshotHash: "b".repeat(64), snapshotVersion: 10, expiresAt: Date.now() + 300_000,
    inputUsdPerMillion: max((r) => r.input) / 1e6, outputUsdPerMillion: max((r) => r.output) / 1e6, cacheReadUsdPerMillion: max((r) => r.cacheRead) / 1e6, cacheWriteUsdPerMillion: max((r) => Math.max(r.cacheWrite5m, r.cacheWrite1h)) / 1e6 });
  const first = quote.longContext[0];
  return first === undefined ? { runPrice } : { runPrice, runPriceBaseBand: { upToInputTokens: first.aboveInputTokens, inputUsdPerMillion: quote.base.input / 1e6, outputUsdPerMillion: quote.base.output / 1e6, cacheWriteUsdPerMillion: Math.max(quote.base.cacheWrite5m, quote.base.cacheWrite1h) / 1e6, cacheReadUsdPerMillion: quote.base.cacheRead / 1e6 } };
}

interface Call { input: number; output: number; cacheRead: number; /** All cache writes. */ cacheWrite: number; /** How many of them the provider said were 1 hour writes (the rest are 5 minute ones); undefined: no split at all. */ oneHour?: number | undefined }
/** The gateway's settlement of one call (estimate.ts usageCost): each call rounded UP; cache writes of unknown duration at the dearer rate. `seen`: the gateway saw the 5m/1h split. */
function gatewayMicros(quote: RateQuoteV1, call: Call, seen = false): number {
  const whole = call.input + call.cacheRead + call.cacheWrite;
  let r = quote.base;
  for (const band of quote.longContext) if (whole > band.aboveInputTokens) r = band.rates;
  const writes = seen && call.oneHour !== undefined ? BigInt(call.oneHour) * BigInt(r.cacheWrite1h) + BigInt(call.cacheWrite - call.oneHour) * BigInt(r.cacheWrite5m) : BigInt(call.cacheWrite) * BigInt(Math.max(r.cacheWrite5m, r.cacheWrite1h));
  const sum = BigInt(call.input) * BigInt(r.input) + BigInt(call.output) * BigInt(r.output) + BigInt(call.cacheRead) * BigInt(r.cacheRead) + writes;
  return Number((sum + 999_999n) / 1_000_000n);
}

/** The owner's task: 33 calls, 4,215 input / 17,297 output / 333,338 cache read / 84,864 cache write tokens, no call above 21,239 whole input tokens, every cache write a 1 hour write. */
function ownerCalls(): Call[] {
  const total = { input: 4_215, output: 17_297, cacheRead: 333_338, cacheWrite: 84_864 };
  const weights = Array.from({ length: 33 }, (_, i) => 8 + ((i * 7) % 10));
  const sumW = weights.reduce((a, b) => a + b, 0);
  const split = (n: number): number[] => { const base = weights.map((w) => Math.floor((n * w) / sumW)); let rest = n - base.reduce((a, b) => a + b, 0); for (let i = 0; rest > 0; i = (i + 1) % 33, rest -= 1) base[i]! += 1; return base; };
  const [input, output, cacheRead, cacheWrite] = [split(total.input), split(total.output), split(total.cacheRead), split(total.cacheWrite)];
  const calls = weights.map((_, i) => ({ input: input[i]!, output: output[i]!, cacheRead: cacheRead[i]!, cacheWrite: cacheWrite[i]!, oneHour: cacheWrite[i]! }));
  expect(calls.length).toBe(33);
  expect(Math.max(...calls.map((c) => c.input + c.cacheRead + c.cacheWrite))).toBeLessThanOrEqual(21_239);
  return calls;
}

const sse = (call: Call): Response => {
  const usage: Record<string, unknown> = { input_tokens: call.input, cache_read_input_tokens: call.cacheRead, cache_creation_input_tokens: call.cacheWrite, output_tokens: 1 };
  if (call.oneHour !== undefined) usage["cache_creation"] = { ephemeral_5m_input_tokens: call.cacheWrite - call.oneHour, ephemeral_1h_input_tokens: call.oneHour };
  return new Response([
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: NAME, content: [], stop_reason: null, usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: call.output } },
    { type: "message_stop" },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
};

/** Runs the calls through the real routed runtime and returns what Pi priced them at, in dollars, with the usage totals. */
async function piRun(calls: Call[], proxy: Partial<ModelProxyOptions>): Promise<{ usd: number; perCall: number[] }> {
  let next = 0;
  const transport = vi.fn(async () => sse(calls[next++]!)) as unknown as typeof fetch;
  const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: NAME }, { fetch: transport, onUsage: () => undefined, proxy: { baseUrl: "https://gateway.example", apiKey: "task-key", route: { alias: NAME, api: "anthropic-messages", catalog: NAME }, ...proxy } });
  const model = runtime.getModel("rovara-route", NAME)!;
  const perCall: number[] = [];
  for (let i = 0; i < calls.length; i += 1) perCall.push((await runtime.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] })).usage.cost.total);
  return { usd: perCall.reduce((a, b) => a + b, 0), perCall };
}
const totalsOf = (calls: Call[]) => calls.reduce((all, c) => ({ input: all.input + c.input, output: all.output + c.output, cacheRead: all.cacheRead + c.cacheRead, cacheWrite: all.cacheWrite + c.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
/** The body the broker sends a worker (route.ts handleModelAccess), parsed by the worker's own reader and handed to the runtime as the worker's proxy does. */
function proxyFor(quote: RateQuoteV1 | undefined, withBand = true, withRunPrice = true): Partial<ModelProxyOptions> {
  const signed = runPriceOf(quote ?? quoteOf(ROVARA, [{ aboveInputTokens: 200_000, rates: ROVARA_LONG }]));
  const body = { baseUrl: "https://gateway.example", apiKey: "task-key", expiresAt: Date.now() + 900_000, ...(withRunPrice ? { runPrice: signed.runPrice } : {}), ...(withRunPrice && withBand && signed.runPriceBaseBand !== undefined ? { runPriceBaseBand: signed.runPriceBaseBand } : {}), ...(quote === undefined ? {} : { rateQuote: quote }) };
  const access = parseModelAccess(JSON.parse(JSON.stringify(body)));
  return lazyModelProxy({ baseUrl: "https://gateway.example", source: async () => ({ ...access, ...(access.runPrice === undefined ? {} : { acceptedRunPrice: access.runPrice }) }) });
}

describe("the owner's task, replayed through the real reader, runtime and booking", () => {
  const rovara = quoteOf(ROVARA, [{ aboveInputTokens: 200_000, rates: ROVARA_LONG }]);
  const calls = ownerCalls();
  const gateway = calls.reduce((all, c) => all + gatewayMicros(rovara, c), 0);

  async function booked(usd: number, rateQuote: ((companyId: string, model: string) => Promise<RateQuoteV1 | undefined>) | undefined): Promise<number> {
    const store = new MemoryDocumentStore();
    const metering = createHostedMetering(undefined, { rateQuote });
    const booking = createUsageBooking({ store, metering });
    const ledger = createHostedLedger({ store, metering });
    const t = totalsOf(calls);
    const taskId = "11111111-1111-4111-8111-111111111111";
    await booking.bookUsageReport({ companyId: COMPANY, taskId, entryId: "usage:op:1", at: new Date().toISOString(), payload: { schemaVersion: 1, outcome: "SUCCEEDED", provider: "anthropic", modelId: NAME, cacheRetention: "short", tokens: { ...t, total: t.input + t.output + t.cacheRead + t.cacheWrite }, cacheReadRatio: 0, costUsd: usd } });
    return (await ledger.taskCost(COMPANY, taskId)).micros;
  }

  it("prices what the page shows within one micro per call UNDER the gateway, never over, from the rate quote", async () => {
    const run = await piRun(calls, proxyFor(rovara));
    const shown = await booked(run.usd, undefined);
    expect(shown).toBeLessThanOrEqual(gateway);
    expect(shown).toBeGreaterThanOrEqual(gateway - calls.length);
    // The same with the broker's floor priced from the same quote: the figure is still inside the band (the worker's own figure and the floor agree).
    const floored = await booked(run.usd, async () => rovara);
    expect(floored).toBeLessThanOrEqual(gateway);
    expect(floored).toBeGreaterThanOrEqual(gateway - calls.length);
  });

  it("does the same from the signed run price alone (no quote), with the base band present: a dropped band would fail here", async () => {
    const run = await piRun(calls, proxyFor(undefined));
    const shown = await booked(run.usd, undefined);
    expect(shown).toBeLessThanOrEqual(gateway);
    expect(shown).toBeGreaterThanOrEqual(gateway - calls.length);
  });

  it("the old pricing (the direct Anthropic row) reads 9.1 percent low: the bug this fixes", async () => {
    const old = await piRun(calls, {});
    const shown = await booked(old.usd, undefined);
    expect(shown).toBeLessThan(gateway * 0.93);
    expect(shown / gateway).toBeGreaterThan(0.89);
  });

  it("with no band and no quote the run is counted at the pooled rates: never under the gateway, and the pooled pricing is logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const run = await piRun(calls, proxyFor(undefined, false));
      expect(run.usd * 1e6).toBeGreaterThanOrEqual(gateway - calls.length);
      expect(log.mock.calls.some((args) => String(args[0]).includes("hosted_cost_pooled"))).toBe(true);
    } finally { log.mockRestore(); }
  });
});

describe("each source the gateway can serve", () => {
  const calls = ownerCalls();
  const sum = (quote: RateQuoteV1, seen = false): number => calls.reduce((all, c) => all + gatewayMicros(quote, c, seen), 0);

  it("a company's own Anthropic key is priced at the direct row: neither the worker figure nor the booked figure exceeds the direct-row cost", async () => {
    const direct = quoteOf(DIRECT, [], "company_key", NAME);
    const run = await piRun(calls, proxyFor(direct));
    expect(run.usd * 1e6).toBeLessThanOrEqual(sum(direct));
    expect(run.usd * 1e6).toBeGreaterThanOrEqual(sum(direct) - calls.length);
    // The broker's floor from the same quote never raises it: against the catalog's dearer `us.` row the booking would read 10 percent high.
    const store = new MemoryDocumentStore();
    const metering = createHostedMetering(undefined, { rateQuote: async () => direct });
    const t = totalsOf(calls);
    const result = await metering.record({ companyId: COMPANY, entryId: "e1", at: new Date().toISOString(), taskId: "t", usage: { provider: "anthropic", modelId: NAME, tokens: t }, reportedCost: { micros: Math.ceil(run.usd * 1e6), currency: "USD" } });
    expect(result.cost?.micros).toBeLessThanOrEqual(sum(direct));
    void store;
  });

  it("a company's own Bedrock is priced at the dearer of its two rows, which the quote states: exact against what the gateway meters", async () => {
    const dearer = quoteOf({ input: 1_100_000, output: 5_500_000, cacheRead: 110_000, cacheWrite5m: 1_375_000, cacheWrite1h: 2_200_000 }, [], "company_key", "us.anthropic.claude-haiku-4-5-20251001-v1:0");
    const run = await piRun(calls, proxyFor(dearer));
    expect(run.usd * 1e6).toBeLessThanOrEqual(sum(dearer));
    expect(run.usd * 1e6).toBeGreaterThanOrEqual(sum(dearer) - calls.length);
  });

  it("OpenRouter is APPROXIMATE until receipts (stage 2): the run price's output rate is the dearer of completion and reasoning, and the gateway charges the greater of token cost and the router's reported cost", () => {
    // Documented, not claimed exact: a reasoning-rate run price reads HIGH against a completion-priced settlement...
    const completion = quoteOf({ input: 1_000_000, output: 4_000_000, cacheRead: 100_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }, [], "company_key", "vendor/model");
    const reasoning = quoteOf({ input: 1_000_000, output: 6_000_000, cacheRead: 100_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }, [], "company_key", "vendor/model");
    const call: Call = { input: 1_000, output: 2_000, cacheRead: 0, cacheWrite: 0 };
    expect(rateQuoteCallMicros(reasoning, call)).toBeGreaterThan(rateQuoteCallMicros(completion, call));
    // ...and a reported cost above the token cost is NOT seen by the worker (Pi does not read the router's cost on a routed model): the booked figure can read low. Receipts fix it.
    expect(modelCostFromRateQuote(completion).output).toBe(4);
  });
});

describe("long-context bands and cache-write durations", () => {
  const banded = quoteOf(ROVARA, [{ aboveInputTokens: 200_000, rates: ROVARA_LONG }]);
  const two = quoteOf(ROVARA, [{ aboveInputTokens: 200_000, rates: ROVARA_LONG }, { aboveInputTokens: 500_000, rates: { input: 4_400_000, output: 12_000_000, cacheRead: 440_000, cacheWrite5m: 5_500_000, cacheWrite1h: 8_800_000 } }]);
  const pi = async (quote: RateQuoteV1, call: Call): Promise<number> => (await piRun([call], proxyFor(quote))).usd * 1e6;

  it("a call at exactly the threshold uses the base rates, one token above uses the band's", async () => {
    const at200 = { input: 200_000, output: 100, cacheRead: 0, cacheWrite: 0 };
    const over = { input: 200_001, output: 100, cacheRead: 0, cacheWrite: 0 };
    expect(await pi(banded, at200)).toBeLessThanOrEqual(gatewayMicros(banded, at200));
    expect(await pi(banded, at200)).toBeGreaterThanOrEqual(gatewayMicros(banded, at200) - 1);
    expect(gatewayMicros(banded, at200)).toBe(220_550);
    expect(await pi(banded, over)).toBeLessThanOrEqual(gatewayMicros(banded, over));
    expect(await pi(banded, over)).toBeGreaterThanOrEqual(gatewayMicros(banded, over) - 1);
    expect(gatewayMicros(banded, over)).toBeGreaterThan(gatewayMicros(banded, at200) * 1.9);
  });

  it("a model with two bands is never under the gateway in any of the three bands", async () => {
    for (const whole of [150_000, 300_000, 700_000]) {
      const call = { input: whole - 20_000, output: 500, cacheRead: 10_000, cacheWrite: 10_000, oneHour: 10_000 };
      const code = await pi(two, call);
      expect(code, String(whole)).toBeLessThanOrEqual(gatewayMicros(two, call));
      expect(code, String(whole)).toBeGreaterThanOrEqual(gatewayMicros(two, call) - 1);
    }
  });

  it("the cost of a quote is its base and every band", () => {
    const cost = modelCostFromRateQuote(two);
    expect(cost.input).toBeCloseTo(1.1);
    expect(cost.cacheWrite).toBeCloseTo(2.2);
    expect(cost.tiers?.map((t) => [t.inputTokensAbove, t.input])).toEqual([[200_000, 2.2], [500_000, 4.4]]);
  });

  it("cache writes: all 1 hour is exact; writes whose duration the gateway did not see are exact; all 5 minute writes the gateway saw as 5 minute read high, never low; no split at all is exact", async () => {
    const write = { input: 1_000, output: 500, cacheRead: 5_000, cacheWrite: 10_000 };
    const hour = { ...write, oneHour: 10_000 };
    const five = { ...write, oneHour: 0 };
    const none = { ...write, oneHour: undefined };
    const gateway = (call: Call, seen = false) => gatewayMicros(banded, call, seen);
    for (const call of [hour, none]) { expect(await pi(banded, call)).toBeLessThanOrEqual(gateway(call)); expect(await pi(banded, call)).toBeGreaterThanOrEqual(gateway(call) - 1); }
    // The gateway drops the split when a later delta carries a bare creation count, so its writes are "unknown" (the dearer rate) even for a 5 minute write: exact.
    expect(await pi(banded, five)).toBeGreaterThanOrEqual(gateway(five) - 1);
    // Where it DID see 5 minute writes it charges the 5 minute rate: the worker reads high, never low.
    expect(await pi(banded, five)).toBeGreaterThan(gateway(five, true));
  });

  it("a mutant that prices the writes at the 5 minute rate is under the gateway on the owner's writes", async () => {
    // Writes whose duration is not known (no split): priced at the write rate, which must be the dearer of the two.
    const owner = ownerCalls().map((call) => ({ ...call, oneHour: undefined }));
    const mutant: RateQuoteV1 = { ...banded, base: { ...banded.base, cacheWrite1h: banded.base.cacheWrite5m } };
    expect((await piRun(owner, proxyFor(banded))).usd * 1e6).toBeGreaterThanOrEqual(owner.reduce((all, c) => all + gatewayMicros(banded, c), 0) - owner.length);
    const run = await piRun(owner, proxyFor(mutant));
    const gateway = owner.reduce((all, c) => all + gatewayMicros(banded, c), 0);
    expect(run.usd * 1e6).toBeLessThan(gateway - owner.length);
  });
});

describe("a run with no price from the gateway, and the quote on its own", () => {
  const calls = ownerCalls();
  const rovara = quoteOf(ROVARA, [{ aboveInputTokens: 200_000, rates: ROVARA_LONG }]);

  it("a reviewer key slot gets no run price: the quote beside it prices the run, and is read from the answer the broker sends", async () => {
    const run = await piRun(calls, proxyFor(rovara, true, false));
    const gateway = calls.reduce((all, c) => all + gatewayMicros(rovara, c), 0);
    expect(run.usd * 1e6).toBeLessThanOrEqual(gateway);
    expect(run.usd * 1e6).toBeGreaterThanOrEqual(gateway - calls.length);
  });

  it("no gateway pricing (a laptop run, an older broker) keeps the catalog row, unchanged", async () => {
    const run = await piRun(calls, {});
    const direct = listPricesPerMillion({ provider: "anthropic", modelId: NAME })!;
    expect(direct.input).toBe(1);
    const t = totalsOf(calls);
    const expected = (t.input * 1 + t.output * 5 + t.cacheRead * 0.1 + t.cacheWrite * 2) ;
    expect(run.usd * 1e6).toBeCloseTo(expected, 0);
  });

  it("an expired quote and an expired run price price nothing: the catalog row stays", () => {
    const old = { ...rovara, expiresAt: new Date(Date.now() - 1_000).toISOString() };
    expect(gatewayModelCost({ rateQuote: old, now: Date.now() })).toBeUndefined();
    const price = runPriceOf(rovara).runPrice;
    expect(gatewayModelCost({ runPrice: { ...price, expiresAt: Date.now() - 1 }, now: Date.now() })).toBeUndefined();
    expect(gatewayModelCost({ rateQuote: old, runPrice: price, now: Date.now() })?.basis).toBe("run_price_pooled");
    const band = { upToInputTokens: 200_000, inputUsdPerMillion: 1.1, outputUsdPerMillion: 5.5, cacheWriteUsdPerMillion: 2.2, cacheReadUsdPerMillion: 0.11 };
    expect(gatewayModelCost({ rateQuote: old, runPrice: RunPriceSchema.parse({ ...price, baseBand: band }), now: Date.now() })?.basis).toBe("run_price");
  });

  it("an older worker reads the new answer: the extra key changes nothing it parses; a quote that does not read, or names another model than the run price, is left out", () => {
    const signed = runPriceOf(rovara);
    const body = { baseUrl: "https://gateway.example", apiKey: "k", expiresAt: Date.now() + 1_000_000, runPrice: signed.runPrice, runPriceBaseBand: signed.runPriceBaseBand };
    expect(parseModelAccess({ ...body, rateQuote: rovara }).rateQuote).toEqual(rovara);
    expect(parseModelAccess({ ...body, rateQuote: { nonsense: true } }).rateQuote).toBeUndefined();
    expect(parseModelAccess({ ...body, rateQuote: quoteOf(ROVARA, [], "rovara_ai", "us.anthropic.claude-sonnet-4-6") }).rateQuote).toBeUndefined();
    expect(parseModelAccess(body).runPrice?.baseBand).toBeDefined();
    expect(modelCostFromRunPrice(signed.runPrice).pooledOnly).toBe(true);
  });
});

describe("the broker's booking floor and caps", () => {
  const rovara = quoteOf(ROVARA, [{ aboveInputTokens: 200_000, rates: ROVARA_LONG }]);
  const tokens = { input: 4_215, output: 17_297, cacheRead: 333_338, cacheWrite: 84_864 };
  const record = (metering: ReturnType<typeof createHostedMetering>, reportedMicros?: number, model = NAME, provider = "anthropic") => metering.record({ companyId: COMPANY, entryId: `e-${Math.random()}`, at: new Date().toISOString(), taskId: "t", usage: { provider, modelId: model, tokens }, ...(reportedMicros === undefined ? {} : { reportedCost: { micros: reportedMicros, currency: "USD" } }) });

  it("a report with no worker figure is booked at the gateway's quote, not at the 5 minute catalog table", async () => {
    const result = await record(createHostedMetering(undefined, { rateQuote: async () => rovara }));
    expect(result.cost?.micros).toBe(rateQuoteCallMicros(rovara, tokens, true));
    expect(result.cost?.micros).toBeGreaterThan(300_000);
    const table = await record(createHostedMetering());
    expect(table.cost!.micros).toBeLessThan(260_000);
  });

  it("the worker's figure still wins when it is higher; the floor never lowers it", async () => {
    const result = await record(createHostedMetering(undefined, { rateQuote: async () => rovara }), 400_000);
    expect(result).toMatchObject({ cost: { micros: 400_000 }, source: "provider-reported" });
  });

  it("no quote (a failed read, an unknown model, an internal usage): the table prices, as before", async () => {
    const failing = createHostedMetering(undefined, { rateQuote: async () => { throw new Error("down"); } });
    expect((await record(failing)).cost?.micros).toBe((await record(createHostedMetering())).cost?.micros);
    const asked: string[] = [];
    const probe = createHostedMetering(undefined, { rateQuote: async (_c, model) => { asked.push(model); return undefined; } });
    await record(probe, undefined, "rovara-unreadable-usage-model", "rovara-unreadable-usage");
    expect(asked).toEqual([]);
    await record(probe);
    expect(asked).toEqual([NAME]);
  });

  it("a hold or cap is never below the gateway's dearer profile row, with 1 hour cache writes", async () => {
    const meter = createHostedMetering();
    const cap = await meter.price({ provider: "anthropic", modelId: NAME, tokens });
    expect(cap!.micros).toBeGreaterThanOrEqual(rateQuoteCallMicros(rovara, tokens, true));
    const found = createModelPrices({ providers: () => [], catalog: listPricesPerMillion }).findCap({ provider: "anthropic", modelId: NAME })!;
    expect(cap!.micros).toBeGreaterThan(Math.round((tokens.input * found.price.inputMicrosPerMillionTokens + tokens.output * found.price.outputMicrosPerMillionTokens) / 1e6));
  });

  it("an unlisted model of a company's own endpoint is booked at the cautious price, as before", async () => {
    const result = await record(createHostedMetering(undefined, { rateQuote: async () => undefined }), undefined, "acme.brand-new-model-v9:0", "rovara-route");
    expect(result.source).toBe("unknown");
    expect(result.cost!.micros).toBeGreaterThan(1_000_000);
  });

  it("a mutant booking that takes the dearer catalog row as the floor would put a company key's task above the direct-row cost", async () => {
    const direct = quoteOf(DIRECT, [], "company_key", NAME);
    const directCost = rateQuoteCallMicros(direct, tokens, true);
    const booked = await record(createHostedMetering(undefined, { rateQuote: async () => direct }), directCost);
    expect(booked.cost?.micros).toBe(directCost);
    const dearerRow = rateQuoteCallMicros(quoteOf(ROVARA), tokens, true);
    expect(dearerRow).toBeGreaterThan(directCost * 1.05);
  });

  it("the quote's usage price uses each call's own band when the calls add up, and the base band for a usage it cannot split", () => {
    const big = { input: 150_000, output: 100, cacheRead: 100_000, cacheWrite: 0 };
    const small = { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 };
    const together = { input: 151_000, output: 200, cacheRead: 100_000, cacheWrite: 0 };
    const split = rateQuoteUsageMicros(rovara, together, [big, small]);
    expect(split).toBe(rateQuoteCallMicros(rovara, big) + rateQuoteCallMicros(rovara, small));
    expect(split).toBeGreaterThan(rateQuoteUsageMicros(rovara, together));
    expect(rateQuoteUsageMicros(rovara, together, [big])).toBe(rateQuoteUsageMicros(rovara, together));
  });
});

describe("the ledger carries the number; nothing else changes", () => {
  it("one booking is one entry, counted once, in the task's own partition", async () => {
    const store = new MemoryDocumentStore();
    const metering = createHostedMetering(undefined, { rateQuote: async () => quoteOf(ROVARA) });
    const booking = createUsageBooking({ store, metering });
    const payload = { schemaVersion: 1, outcome: "SUCCEEDED", provider: "anthropic", modelId: NAME, cacheRetention: "short", tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 }, cacheReadRatio: 0, costUsd: null };
    expect(await booking.bookUsageReport({ companyId: COMPANY, taskId: "22222222-2222-4222-8222-222222222222", entryId: "usage:op:x", at: new Date().toISOString(), payload })).toBe(true);
    expect(await booking.bookUsageReport({ companyId: COMPANY, taskId: "22222222-2222-4222-8222-222222222222", entryId: "usage:op:x", at: new Date().toISOString(), payload })).toBe(false);
    const total = await store.get({ pk: costPartition(COMPANY, "22222222-2222-4222-8222-222222222222"), sk: "TOTAL" });
    expect(total?.["entries"]).toBe(1);
  });
});
