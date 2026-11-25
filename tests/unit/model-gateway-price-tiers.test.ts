import type { PriceEntry } from "../../packages/model-gateway/src/price-snapshot.js";
import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { fixture, row, model } from "./model-gateway-price-round5-fixture.js";
import { call, setup, scope, sse, requestBody } from "./model-gateway-fixture.js";
import { estimateCall, usageCost } from "../../packages/model-gateway/src/estimate.js";
import { settleAmount } from "../../packages/model-gateway/src/reported-cost.js";
beforeAll(denyNetwork);
const tiers = { cache_read_input_token_cost: 1e-6, cache_creation_input_token_cost: 12.5e-6, cache_creation_input_token_cost_above_1hr: 20e-6,
  input_cost_per_token_above_200k_tokens: 30e-6, output_cost_per_token_above_200k_tokens: 90e-6, cache_read_input_token_cost_above_200k_tokens: 3e-6 };
it.each([
  ["cached-heavy", 10, 90, 0, 0, 0, 190],
  ["5m-write-heavy", 10, 0, 90, 90, 0, 1225],
  ["1h-write-heavy", 10, 0, 90, 0, 90, 1900],
  ["long-context", 200001, 0, 0, 0, 0, 6000120],
  ["long-cached", 20001, 180000, 0, 0, 0, 1140120],
] as const)("tier settlement via fetch/reload/gateway: %s", async (name, input, read, write, five, hour, expected) => {
  const f = fixture(); await f.fetch({ [model]: row(10, 50, tiers) }); await f.restart();
  const gateway = setup({ prices: f.prices }); let held = 0;
  const output = name.startsWith("long") ? 1 : 0;
  gateway.deps.transport = async () => {
    held = (await gateway.meter.read(scope))[0]!.reservedMicros;
    return { status: 200, body: (async function* () {
      yield sse("message_start", { message: { usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_5m_input_tokens: five, ephemeral_1h_input_tokens: hour } } } });
      yield sse("message_delta", { usage: { output_tokens: output } }); yield sse("message_stop");
    })() };
  };
  expect((await call(gateway.deps, { ...requestBody, messages: [{ role: "user", content: "x".repeat(input + read + write) }] })).status).toBe(200);
  expect((await gateway.meter.read(scope))[0]!.spentMicros).toBe(expected);
  expect(held).toBeGreaterThanOrEqual(expected);
  const price = await f.price();
  expect(settleAmount({ price, usage: { input, output, cacheRead: read, cacheWrite: write, cacheWrite5m: five, cacheWrite1h: hour }, reportedCostMicros: 1, reservationMicros: held }).actualMicros).toBe(expected);
});
it("unknown tiers fall back independently using own input/read, 2x write and 2x long rates", async () => {
  const f = fixture(); await f.fetch({ [model]: row(10, 50), sibling: row(20, 60, { ...tiers, cache_read_input_token_cost: 25e-6 }), embedding: row(100, 200, { mode: "embedding", cache_read_input_token_cost: 500e-6 }) });
  const p = await f.price();
  expect(usageCost({ input: 10, output: 0, cacheRead: 90, cacheWrite: 0 }, p)).toBe(1000);
  expect(usageCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 100, cacheWrite5m: 100, cacheWrite1h: 0 }, p)).toBe(2000);
  expect(usageCost({ input: 200001, output: 1, cacheRead: 0, cacheWrite: 0 }, p)).toBe(4000120);
  expect(estimateCall(200001, 1, p)).toBeGreaterThanOrEqual(4000120);
});
it("tier rates pool independently, scale uncertainty once, and drops wait through restart for confirmation", async () => {
  const f = fixture(); const clean = { [model]: row(10, 50, tiers) };
  await f.fetch({ ...clean, [model.toUpperCase()]: row(1, 2, { ...tiers, cache_read_input_token_cost: 4e-6, mode: "future" }) });
  const u = { input: 10, output: 0, cacheRead: 90, cacheWrite: 0 };
  expect(usageCost(u, await f.price())).toBe(640);
  await f.fetch({ ...clean, [model.toUpperCase()]: row(1, 2, tiers) }); await f.restart();
  expect(usageCost(u, await f.price())).toBe(640);
  await f.fetch({ ...clean, [model.toUpperCase()]: row(1, 2, tiers) });
  expect(usageCost(u, await f.price())).toBe(190);
});
it("AWS preserves base, read, both write durations and long-context dimensions independently", async () => {
  const { fetchAWS } = await import("../../packages/model-gateway/src/price-sources.js");
  const { InMemoryPriceSnapshotStore } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const { SnapshotPriceSource } = await import("../../packages/model-gateway/src/price-index.js");
  const { resolvePrice } = await import("../../packages/model-gateway/src/price.js");
  const dims = [["input", 10], ["output", 50], ["cache_read", 1], ["cache_write", 12.5], ["cache_write_tokens_1h", 20], ["input_tokens_long_ctx", 30], ["output_tokens_long_ctx", 90], ["cache_read_tokens_long_ctx", 3]] as const;
  const products = Object.fromEntries(dims.map(([kind], i) => [i, { attributes: { model: "Example", usagetype: `USW2_${kind.includes("tokens") ? kind : `${kind}_tokens`}_standard-Units` } }]));
  const terms = { OnDemand: Object.fromEntries(dims.map(([, rate], i) => [i, { T: { priceDimensions: { D: { unit: "1M tokens", pricePerUnit: { USD: String(rate) } } } } }])) };
  const result = await fetchAWS({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ products, terms })) }) }, { minModels: 1, regions: ["us-west-2"] });
  expect(result.ok).toBe(true); if (!result.ok) throw new Error("fixture");
  const store = new InMemoryPriceSnapshotStore(); await store.save({ version: 1, sources: { aws: { fetchedAt: 1, count: 1, entries: result.entries } } }, 0);
  const source = new SnapshotPriceSource(store, { overrides: [] }); await source.reload(); const p = await resolvePrice(source, "bedrock", "example");
  expect(usageCost({ input: 10, output: 0, cacheRead: 90, cacheWrite: 0 }, p)).toBe(190);
  expect(usageCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 100, cacheWrite5m: 40, cacheWrite1h: 60 }, p)).toBe(1700);
  expect(usageCost({ input: 20001, output: 1, cacheRead: 180000, cacheWrite: 0 }, p)).toBe(1140120);
});
it("long thresholds count the whole prompt and leave the boundary at its base tier", async () => {
  const f = fixture(); await f.fetch({ [model]: row(10, 50, tiers) }); const p = await f.price();
  expect(usageCost({ input: 20000, output: 1, cacheRead: 180000, cacheWrite: 0 }, p)).toBe(380050);
  expect(usageCost({ input: 20001, output: 1, cacheRead: 180000, cacheWrite: 0 }, p)).toBe(1140120);
});
it("runtime rejects malformed tier state as a whole and retains the last valid snapshot", async () => {
  const { validPrice } = await import("../../packages/model-gateway/src/price.js");
  const { validSnapshot } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const f = fixture(); await f.fetch({ [model]: row(10, 50, tiers) }); const p = await f.price();
  for (const bad of [NaN, Infinity, -1, "private-canary", null, 1.5]) expect(validPrice({ ...p, estimated: false, cacheReadMicrosPerMTok: bad })).toBe(false);
  for (const longContext of [null, {}, [{ aboveTokens: 200000 }, { aboveTokens: 128000 }], [{ aboveTokens: 128000 }, { aboveTokens: 128000 }], Array.from({ length: 3 }, () => ({ aboveTokens: 200000 })), [{ aboveTokens: 42, inputMicrosPerMTok: 1 }], [{ aboveTokens: 200000, inputMicrosPerMTok: "private-canary" }], [{ aboveTokens: 200000, extra: 1 }]]) {
    const snapshot = (await f.store.load())!; snapshot.effective![0]!.longContext = longContext as never;
    expect(validSnapshot(snapshot)).toBe(false); expect(await f.store.save({ ...snapshot, version: snapshot.version + 1 }, snapshot.version)).toBe(false);
  }
  expect(await f.price()).toEqual(p);
});
it("property tier extension: seeded aliases and sources preserve each candidate, confirm drops and converge to clean rates", async () => {
  const { effectivePrices } = await import("../../packages/model-gateway/src/price-sanity.js");
  const { RATE_KEYS } = await import("../../packages/model-gateway/src/price-tiers.js");
  const { InMemoryPriceSnapshotStore } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const { SnapshotPriceSource } = await import("../../packages/model-gateway/src/price-index.js");
  const { resolvePrice } = await import("../../packages/model-gateway/src/price.js");
  let seed = 12345; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const keys = RATE_KEYS.slice(0, 5); let drops = 0;
  for (let run = 0; run < 8; run++) {
    let effective: ReturnType<typeof effectivePrices> = []; let previous: number[] | undefined; let last: number[][] = [];
    for (let step = 0; step < 40; step++) {
      const values = step % 3 === 2 ? last : Array.from({ length: 3 }, () => Array.from({ length: 10 }, () => (1 + random() % 20) * 2e6)); last = values;
      const make = (v: number[], model: string) => ({ provider: "bedrock", model, kind: "chat" as const, ...Object.fromEntries(keys.map((k, i) => [k, v[i]])), longContext: [{ aboveTokens: 200000, ...Object.fromEntries(keys.map((k, i) => [k, v[i + 5]])) }] }) as PriceEntry;
      const sources = { litellm: { fetchedAt: step, count: 1, entries: [make(values[0]!, "us.anthropic.example-v1:0")], floors: [{ ...make(values[1]!, "global.anthropic.example-v1:0"), reason: "unsupported mode" as const }] }, aws: { fetchedAt: step, count: 1, entries: [make(values[2]!, "example")] } };
      // Unrelated identities, including uncertain/extreme tiers, cannot affect this identity.
      const sibling = make(Array.from({ length: 10 }, () => (1 + random() % 1000) * 2e6), "unrelated");
      const withSibling = { ...sources, aws: { ...sources.aws, count: 2, entries: [...sources.aws.entries, sibling] } };
      expect(effectivePrices(withSibling, effective).find((e) => e.model === "example")).toEqual(effectivePrices(sources, effective)[0]);
      const candidate = values[0]!.map((v, i) => Math.max(v, values[1]![i]! * 1.5, values[2]![i]!));
      const prior = effective[0]; effective = effectivePrices(sources, effective);
      const store = new InMemoryPriceSnapshotStore(); await store.save({ version: 1, sources, effective }, 0);
      const source = new SnapshotPriceSource(store, { overrides: [] }); await source.reload(); const p = await resolvePrice(source, "bedrock", "example");
      const current = [...keys.map((k) => p[k]!), ...keys.map((k) => p.longContext![0]![k]!)];
      for (let i = 0; i < current.length; i++) expect(current[i]).toBeGreaterThanOrEqual(candidate[i]!);
      if (prior !== undefined) {
        const before = [...keys.map((k) => prior[k]!), ...keys.map((k) => prior.longContext![0]![k]!)];
        if (current.some((n, i) => n < before[i]!)) { drops++; expect(candidate).toEqual(previous); }
      }
      previous = candidate;
    }
    const clean = { litellm: { fetchedAt: 50, count: 1, entries: [{ provider: "bedrock", model: "example", kind: "chat" as const, inputMicrosPerMTok: 10, outputMicrosPerMTok: 20, cacheReadMicrosPerMTok: 1, cacheWrite5mMicrosPerMTok: 12, cacheWrite1hMicrosPerMTok: 20, longContext: [{ aboveTokens: 200000, inputMicrosPerMTok: 30, outputMicrosPerMTok: 60, cacheReadMicrosPerMTok: 3, cacheWrite5mMicrosPerMTok: 36, cacheWrite1hMicrosPerMTok: 60 }] }] } };
    effective = effectivePrices(clean, effective); effective = effectivePrices(clean, effective);
    expect(effective[0]).toMatchObject({ ...clean.litellm.entries[0], estimated: false });
  }
  expect(drops).toBeGreaterThan(20);
});
it("a newly explicit long tier cannot lower the previously billed base before confirmation", async () => {
  const f = fixture(); await f.fetch({ [model]: row(100, 100) });
  await f.fetch({ [model]: row(10, 50, tiers) });
  expect(usageCost({ input: 200001, output: 1, cacheRead: 0, cacheWrite: 0 }, await f.price())).toBe(40000400);
  await f.fetch({ [model]: row(10, 50, tiers) });
  expect(usageCost({ input: 200001, output: 1, cacheRead: 0, cacheWrite: 0 }, await f.price())).toBe(6000120);
});
it("unknown-tier fallbacks settle through the gateway and correction keeps known cached rates", async () => {
  const { runCorrections } = await import("../../packages/model-gateway/src/correction.js");
  const { FixedCapsSource } = await import("../../packages/model-gateway/src/caps.js");
  const { caps, now } = await import("./model-gateway-fixture.js");
  const f = fixture(); const rows = { [model]: row(10, 50, { mode: "future" }), sibling: row(20, 60, { ...tiers, cache_read_input_token_cost: 25e-6 }) };
  await f.fetch(rows);
  const gateway = setup({ prices: f.prices, transport: async () => ({ status: 200, body: (async function* () {
    yield sse("message_start", { message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } } } });
    yield sse("message_delta", { usage: { output_tokens: 0 } }); yield sse("message_stop");
  })() }) });
  expect((await call(gateway.deps, { ...requestBody, messages: [{ role: "user", content: "x".repeat(200) }] })).status).toBe(200);
  expect((await gateway.meter.read(scope))[0]!.spentMicros).toBe(4500); // 10*15 + 90*15 + 100*30.
  const clean = { ...rows, [model]: row(10, 50, tiers) };
  await f.fetch(clean); await f.fetch(clean); await f.restart();
  expect(await runCorrections({ meter: gateway.meter, prices: f.prices, caps: new FixedCapsSource(caps), now, runId: "tier-correction" })).toMatchObject({ corrected: 1 });
  expect((await gateway.meter.read(scope))[0]!.spentMicros).toBe(1440); // 10*10 + 90*1 + 100*12.5.
});
it("known zero cached reads remain zero and distinct long thresholds retain their rates", async () => {
  const f = fixture(); await f.fetch({ [model]: row(10, 50, { ...tiers, cache_read_input_token_cost: 0, input_cost_per_token_above_128k_tokens: 20e-6 }) });
  const p = await f.price();
  expect(usageCost({ input: 0, output: 0, cacheRead: 100, cacheWrite: 0 }, p)).toBe(0);
  expect(usageCost({ input: 128001, output: 0, cacheRead: 0, cacheWrite: 0 }, p)).toBe(2560020);
  expect(usageCost({ input: 200001, output: 0, cacheRead: 0, cacheWrite: 0 }, p)).toBe(6000030);
});
it("unknown long-context components use own doubled input and derive writes from it", async () => {
  const f = fixture(); await f.fetch({ [model]: row(10, 50, { cache_creation_input_token_cost: 12.5e-6 }), sibling: row(20, 60, { input_cost_per_token_above_200k_tokens: 30e-6, cache_creation_input_token_cost_above_200k_tokens: 25e-6 }) });
  const p = await f.price();
  expect(usageCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 200001, cacheWrite5m: 200001, cacheWrite1h: 0 }, p)).toBe(8000040);
  expect(usageCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 200001, cacheWrite5m: 0, cacheWrite1h: 200001 }, p)).toBe(8000040);
});
it("a derived 2x write fallback that overflows keeps the operator-review maximum", async () => {
  const { completePrice } = await import("../../packages/model-gateway/src/price-tiers.js");
  const p = { inputMicrosPerMTok: Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1, outputMicrosPerMTok: 1, estimated: true };
  expect(completePrice(p)).toMatchObject({ operatorReview: true });
  expect(usageCost({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, p)).toBe(Number.MAX_SAFE_INTEGER);
  expect(estimateCall(1, 1, p)).toBe(Number.MAX_SAFE_INTEGER);
});
