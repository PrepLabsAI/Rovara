import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { fetchLiteLLM, type PriceFetchResult } from "../../packages/model-gateway/src/price-sources.js";
import { InMemoryPriceSnapshotStore, validSnapshot, type PriceEntry } from "../../packages/model-gateway/src/price-snapshot.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { PriceRefresher } from "../../packages/model-gateway/src/price-refresh.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
import { estimateCall } from "../../packages/model-gateway/src/estimate.js";
import { settleAmount } from "../../packages/model-gateway/src/reported-cost.js";
import { InMemoryMeter, costView } from "../../packages/model-gateway/src/meter.js";
import { runCorrections } from "../../packages/model-gateway/src/correction.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { now, caps, scope, setup, call, answer, requestBody } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
const entry: PriceEntry = { provider: "anthropic", model: "old", kind: "chat", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 };
const base = { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 3e-6, output_cost_per_token: 15e-6 };
const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
const good = (entries: PriceEntry[]): PriceFetchResult => ({ ok: true, entries, report: { skipped: [], ignoredLower: 0 } });
const failed = async (): Promise<PriceFetchResult> => ({ ok: false, reason: "secret-upstream" });
async function fetchRows(rows: unknown) { return fetchLiteLLM({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify(rows)) }) }, { now, minModels: 1 }); }
async function fromRows(rows: unknown) {
  const result = await fetchRows(rows); expect(result.ok).toBe(true); if (!result.ok) throw new Error("fixture");
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store, { now: () => now });
  const refresher = new PriceRefresher({ store, prices, litellm: async () => result, aws: failed }); await refresher.run(now);
  return { result, store, prices };
}
it.each([
  ["unsupported price field", { future_feature_cost_per_query: { secret: 1 } }, 15e-6, 75e-6],
  // A deprecated row with every field known now prices its identity (model-gateway-price-bands.test.ts); one with an unknown field stays a floor.
  ["deprecated model", { deprecation_date: "2020-01-01", future_feature_cost_per_query: 1e-6 }, 15e-6, 75e-6],
  ["token rate exceeds maximum", {}, 0.002, 0.003],
] as const)("retains own known floor for %s through hold, settlement and correction", async (reason, extra, input, output) => {
  const { result, store, prices } = await fromRows({ old: base, "claude-sonnet-4-5": { ...base, ...extra, input_cost_per_token: input, output_cost_per_token: output } });
  expect(result.report.skipped).toContain(reason); expect(JSON.stringify(result.report)).not.toMatch(/secret|claude|sonnet/);
  const p = await resolvePrice(prices, "anthropic", "claude-sonnet-4-5");
  expect(p).toMatchObject({ estimated: true, inputMicrosPerMTok: Math.ceil(input * 1e12 * 1.5), outputMicrosPerMTok: Math.ceil(output * 1e12 * 1.5) });
  expect(prices.priceFor("anthropic", "claude-sonnet-4-5")).toBeUndefined();
  expect(estimateCall(1_000_000, 1_000_000, p)).toBe(4 * p.inputMicrosPerMTok + 2 * p.outputMicrosPerMTok);
  expect(settleAmount({ price: p, usage, reservationMicros: 1 })).toMatchObject({ actualMicros: 2 * (p.inputMicrosPerMTok + p.outputMicrosPerMTok), estimated: true });
  expect((await resolvePrice(prices, "anthropic", "unlisted")).inputMicrosPerMTok).toBe(p.inputMicrosPerMTok * 1.5);
  // A different requested kind must still respect this model's own floor.
  expect((await resolvePrice(prices, "anthropic", "claude-sonnet-4-5", undefined, undefined, "embedding")).outputMicrosPerMTok).toBeGreaterThanOrEqual(p.outputMicrosPerMTok);
  const f = setup({ prices }); let held = 0; f.deps.transport = async () => { held = (await f.meter.read(scope))[0]!.reservedMicros; return { status: 200, body: answer() }; };
  expect((await call(f.deps)).status).toBe(200); expect(held).toBeGreaterThan(0);
  expect(costView(await f.meter.read(scope)).every((r) => r.estimated)).toBe(true);
  const previous = await store.load();
  await store.save({ version: previous!.version + 1, sources: { litellm: { fetchedAt: now + 1, count: 1, entries: [{ ...entry, model: "claude-sonnet-4-5", cacheReadMicrosPerMTok: 3_000_000, cacheWrite5mMicrosPerMTok: 6_000_000, cacheWrite1hMicrosPerMTok: 6_000_000 }] } } }, previous!.version);
  await prices.reload(); expect((await runCorrections({ meter: f.meter, prices, caps: new FixedCapsSource(caps), now: now + 1, runId: "run" })).corrected).toBe(1);
  expect(costView(await f.meter.read(scope)).every((r) => !r.estimated)).toBe(true);
});
it("overflow floors hold and settle the largest safe amount, flag review, and still obey caps", async () => {
  const rows = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`old-${i}`, base]));
  const { prices } = await fromRows({ ...rows, "claude-sonnet-4-5": { ...base, input_cost_per_token: 1e10, output_cost_per_token: 1e10 } });
  const p = await resolvePrice(prices, "anthropic", "claude-sonnet-4-5");
  expect(p).toMatchObject({ estimated: true, operatorReview: true });
  expect(estimateCall(1, 1, p)).toBe(Number.MAX_SAFE_INTEGER);
  expect(settleAmount({ price: p, usage, reservationMicros: Number.MAX_SAFE_INTEGER }).actualMicros).toBe(Number.MAX_SAFE_INTEGER);
  const maxCaps = { task: Number.MAX_SAFE_INTEGER, personMonth: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER, companyMonth: Number.MAX_SAFE_INTEGER };
  const f = setup({ prices, caps: new FixedCapsSource(maxCaps) });
  expect((await call(f.deps)).status).toBe(200); expect((await f.meter.read(scope))[0]?.spentMicros).toBe(Number.MAX_SAFE_INTEGER);
  expect(f.logs).toContainEqual({ event: "price_operator_review" });
  const capped = setup({ prices }); expect((await call(capped.deps)).status).toBe(422); expect(capped.calls).toHaveLength(0);
});
it("known-price post-send faults retain the full hold provisionally", async () => {
  const f = setup({ transport: async () => { throw new Error("secret-upstream"); } });
  expect((await call(f.deps)).status).toBe(502);
  expect(costView(await f.meter.read(scope)).every((r) => r.spentMicros > 0 && r.estimated)).toBe(true);
  expect(JSON.stringify(f.logs)).not.toContain("secret-upstream");
});
async function add(meter: InMemoryMeter, settledAt: number, limit = caps) {
  const reserved = await meter.reserve({ scope, caps: limit, estimateMicros: 10 }); if (!reserved.ok) throw new Error("fixture");
  await meter.settle(reserved.reservation, 10, { provider: "anthropic", model: "secret-model", kind: "chat", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, settledAt });
  return JSON.stringify([scope.iss, scope.cid, reserved.reservation.id]);
}
const real = { priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } }) };
it("unknown corrections advance past a stuck call, back off individually, and stop after bounded attempts", async () => {
  const meter = new InMemoryMeter(() => now); const ids: string[] = []; for (let i = 0; i < 4; i++) ids.push(await add(meter, now + i));
  const correct = meter.correct.bind(meter); let attempts = 0;
  meter.correct = async (input) => { if (input.callKey === ids[0]) { attempts++; return { status: "unknown" }; } return correct(input); };
  const logs: unknown[] = []; const options = { meter, prices: real, caps: new FixedCapsSource(caps), now, runId: "secret-run", log: (line: unknown) => logs.push(line) };
  expect(await runCorrections(options)).toMatchObject({ corrected: 3, unknown: 1 });
  expect(ids.slice(1).every((id) => meter.ledger(id)?.status === "corrected")).toBe(true);
  await runCorrections(options); expect(attempts).toBe(1);
  await runCorrections({ ...options, now: now + 60_000 }); expect(attempts).toBe(2);
  await runCorrections({ ...options, now: now + 120_000 }); expect(attempts).toBe(2);
  await runCorrections({ ...options, now: now + 180_000 }); expect(attempts).toBe(3);
  await runCorrections({ ...options, now: now + 1_000_000 }); expect(attempts).toBe(3);
  expect(logs).toContainEqual({ event: "price_correction_operator_review" }); expect(JSON.stringify(logs)).not.toMatch(/secret|org_|https/);
  expect(meter.ledger(ids[0]!)?.status).toBe("pending");
});
it("a hung first transaction has its own deadline so three later calls finish in the same run", async () => {
  let first = true; let release!: () => void;
  const meter = new InMemoryMeter(() => now, () => false, (operation) => operation === "correct" && first ? (first = false, new Promise<void>((r) => { release = r; })) : undefined);
  const ids: string[] = []; for (let i = 0; i < 4; i++) ids.push(await add(meter, now + i));
  vi.useFakeTimers();
  try {
    const pending = runCorrections({ meter, prices: real, caps: new FixedCapsSource(caps), now, runId: "run" });
    await vi.advanceTimersByTimeAsync(1000); expect(await pending).toMatchObject({ unknown: 1, corrected: 3 });
    release(); await Promise.resolve(); expect(meter.ledger(ids[0]!)?.status).toBe("pending"); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
}, 2000);
it("logs each upward correction crossing a cap, including later calls after the cap is already exceeded", async () => {
  const meter = new InMemoryMeter(() => now); const limit = { ...caps, companyMonth: 30 };
  await add(meter, now, limit); await add(meter, now + 1, limit);
  const logs: unknown[] = [];
  const options = { meter, prices: { priceFor: () => ({ inputMicrosPerMTok: 30_000_000, outputMicrosPerMTok: 1, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } }) }, caps: new FixedCapsSource(limit), now, runId: "secret-run", log: (line: unknown) => logs.push(line) };
  expect((await runCorrections(options)).corrected).toBe(2);
  expect(logs.filter((line) => (line as { event: string }).event === "price_correction_cap_exceeded")).toHaveLength(2);
  expect((await meter.read(scope)).find((r) => r.item === "company")?.spentMicros).toBe(60);
  await runCorrections(options); expect(logs).toHaveLength(4); expect(JSON.stringify(logs)).not.toMatch(/secret|org_|https/);
});
it("holds a >50% AWS drop until consecutive confirmation, accepts rises immediately, and persists confirmation", async () => {
  const old = { ...entry, provider: "bedrock" }; const low = { ...old, inputMicrosPerMTok: 1, outputMicrosPerMTok: 2 };
  const store = new InMemoryPriceSnapshotStore(); await store.save({ version: 1, sources: { aws: { fetchedAt: now, count: 1, entries: [old] } } }, 0);
  const prices = new SnapshotPriceSource(store); await prices.reload(); let response = good([low]); const logs: unknown[] = [];
  const options = { store, prices, litellm: failed, aws: async () => response, log: (line: unknown) => logs.push(line) };
  await new PriceRefresher(options).run(now + 1); expect((await resolvePrice(prices, "bedrock", "old")).inputMicrosPerMTok).toBe(old.inputMicrosPerMTok);
  expect(logs).toContainEqual({ event: "price_sanity_held" });
  await new PriceRefresher(options).run(now + 2); expect((await resolvePrice(prices, "bedrock", "old")).inputMicrosPerMTok).toBe(1);
  response = good([old]); await new PriceRefresher(options).run(now + 3); expect((await resolvePrice(prices, "bedrock", "old")).inputMicrosPerMTok).toBe(old.inputMicrosPerMTok);
  expect(JSON.stringify(logs)).not.toMatch(/secret|bedrock|old/);
});
it("new clean prices are exact regardless of the provider/kind median", async () => {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store); let response = good([entry]);
  const refresher = new PriceRefresher({ store, prices, litellm: async () => response, aws: failed }); await refresher.run(now);
  response = good([entry, { ...entry, model: "secret-new", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }]); await refresher.run(now + 1);
  expect(await resolvePrice(prices, "anthropic", "secret-new")).toMatchObject({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, estimated: false });
});
it("snapshot floor metadata validates unknown types/reasons and shares the source item bound", () => {
  const floor = { ...entry, reason: "unsupported price field" };
  const snapshot = (floors: unknown) => ({ version: 1, sources: { litellm: { fetchedAt: now, count: 0, entries: [], floors } } });
  expect(validSnapshot(snapshot([floor]))).toBe(true);
  for (const invalid of [null, {}, [{ ...floor, reason: "secret" }], [{ ...floor, inputMicrosPerMTok: Infinity }], [{ ...floor, operatorReview: "secret" }], [floor, floor], Array.from({ length: 20_001 }, (_, i) => ({ ...floor, model: String(i) }))]) expect(validSnapshot(snapshot(invalid))).toBe(false);
});
it("preserves a floors-only source and prices known identities independently of dearer siblings", async () => {
  const { prices } = await fromRows({ "claude-sonnet-4-5": { ...base, future_feature_cost_per_query: 1, cache_creation_input_token_cost: 20e-6 } });
  expect(await resolvePrice(prices, "anthropic", "claude-sonnet-4-5")).toMatchObject({ estimated: true, inputMicrosPerMTok: 4_500_000, outputMicrosPerMTok: 22_500_000, cacheWrite5mMicrosPerMTok: 30_000_000 });
  const other = await fromRows({ old: { ...base, input_cost_per_token: 30e-6, output_cost_per_token: 60e-6 }, new: { ...base, unknown_cost: 1 }, foreign: { ...base, litellm_provider: "openai", input_cost_per_token: 500e-6 } });
  expect(await resolvePrice(other.prices, "anthropic", "new")).toMatchObject({ inputMicrosPerMTok: 4_500_000, outputMicrosPerMTok: 22_500_000, estimated: true });
});
it("integer factor overflow is detected independently of upstream conversion overflow", async () => {
  const { cautiousPrice } = await import("../../packages/model-gateway/src/price.js");
  const safe = Math.floor(Number.MAX_SAFE_INTEGER / 3) * 2;
  expect(cautiousPrice({ inputMicrosPerMTok: safe, outputMicrosPerMTok: 1 })).toEqual({ inputMicrosPerMTok: safe + Math.ceil(safe / 2), outputMicrosPerMTok: 2 });
  expect(cautiousPrice({ inputMicrosPerMTok: safe + 2, outputMicrosPerMTok: 1 })).toMatchObject({ operatorReview: true, inputMicrosPerMTok: Number.MAX_SAFE_INTEGER });
});
it("confirms every LiteLLM drop through the real fetcher", async () => {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store); let input = 3e-6;
  const refresher = new PriceRefresher({ store, prices, aws: failed, litellm: (previous) => fetchLiteLLM({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ old: { ...base, input_cost_per_token: input } })) }) }, { previous, now, minModels: 1 }) });
  await refresher.run(now); input = 1e-6; await refresher.run(now + 1); expect((await resolvePrice(prices, "anthropic", "old")).inputMicrosPerMTok).toBe(3_000_000);
  await refresher.run(now + 2); expect((await resolvePrice(prices, "anthropic", "old")).inputMicrosPerMTok).toBe(1_000_000);
  input = 0.5e-6; await refresher.run(now + 3); expect((await resolvePrice(prices, "anthropic", "old")).inputMicrosPerMTok).toBe(1_000_000);
  await refresher.run(now + 4); expect((await resolvePrice(prices, "anthropic", "old")).inputMicrosPerMTok).toBe(500_000);
});
it("failed fetch invalidates pending confirmation across refresher restarts without changing last-good rates or age", async () => {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store); const low = { ...entry, inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }; let result = good([entry]);
  const options = { store, prices, litellm: async () => result, aws: failed };
  await new PriceRefresher(options).run(now); result = good([low]); await new PriceRefresher(options).run(now + 1);
  result = await failed(); await new PriceRefresher(options).run(now + 2);
  expect((await store.load())?.sources.litellm).toMatchObject({ fetchedAt: now + 1, entries: [low] });
  result = good([low]); await new PriceRefresher(options).run(now + 3); expect((await resolvePrice(prices, "anthropic", "old")).inputMicrosPerMTok).toBe(entry.inputMicrosPerMTok);
  await new PriceRefresher(options).run(now + 4); expect((await resolvePrice(prices, "anthropic", "old")).inputMicrosPerMTok).toBe(1);
});
it("pooled sanity preserves provider/kind boundaries and bounded 20,000-row work", async () => {
  const { effectivePrices } = await import("../../packages/model-gateway/src/price-sanity.js");
  const rows = Array.from({ length: 20_000 }, (_, i) => ({ ...entry, model: String(i) }));
  const start = performance.now(); const sources = { litellm: { fetchedAt: now, count: rows.length, entries: rows } };
  expect(effectivePrices(sources, [], undefined, start + 5000)).toHaveLength(20_000);
  expect(performance.now() - start).toBeLessThan(5000);
  const candidates = [{ ...entry, inputMicrosPerMTok: 1_500_000 }, { ...entry, model: "edge", inputMicrosPerMTok: 300_000 }, { ...entry, model: "embedding", kind: "embedding" as const, inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }, { ...entry, provider: "openai", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }];
  expect(effectivePrices({ litellm: { fetchedAt: now, entries: candidates, count: candidates.length } })).toHaveLength(4);
  expect(() => effectivePrices(sources, [], undefined, 0)).toThrow(/^refresh failed$/);
});
it("new confirmation metadata fails closed for malformed fields and duplicate keys", () => {
  for (const confirmations of [null, {}, [{ ...entry, inputMicrosPerMTok: 0 }], [{ ...entry, kind: "secret" }], [entry, entry], Array(20_001).fill(entry)]) {
    expect(validSnapshot({ version: 1, sources: { litellm: { fetchedAt: now, count: 1, entries: [entry], confirmations } } })).toBe(false);
  }
});
it("upward correction reports a cap crossed by outstanding holds too", async () => {
  const meter = new InMemoryMeter(() => now); const limit = { ...caps, companyMonth: 30 }; const id = await add(meter, now, limit);
  expect((await meter.reserve({ scope, caps: limit, estimateMicros: 20 })).ok).toBe(true);
  expect(await meter.correct({ callKey: id, caps: limit, realMicros: 20, now, runId: "run", priceVersion: 1, estimated: false, priceSource: { source: "litellm", fetchedAt: now } })).toMatchObject({ status: "corrected", capExceeded: true });
});
it("a source report counts Anthropic skip reasons without exposing model names", async () => {
  const result = await fetchRows({ old: base, "secret-model": { ...base, future_feature_cost_per_query: 1 } });
  expect(result.ok && result.report).toMatchObject({ anthropicSkipped: { "unsupported price field": 1 } });
  expect(JSON.stringify(result.ok && result.report)).not.toContain("secret-model");
});
it("large LiteLLM rises are immediate and even hundredfold drops can confirm on the second fetch", async () => {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store); let rate = 3e-6;
  const refresher = new PriceRefresher({ store, prices, aws: failed, litellm: (previous) => fetchLiteLLM({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ old: { ...base, input_cost_per_token: rate } })) }) }, { previous, now, minModels: 1 }) });
  await refresher.run(now); rate = 900e-6; await refresher.run(now + 1); expect((await resolvePrice(prices, "anthropic", "old")).inputMicrosPerMTok).toBe(900_000_000);
  rate = 1e-6; await refresher.run(now + 2); expect((await resolvePrice(prices, "anthropic", "old")).inputMicrosPerMTok).toBe(900_000_000);
  await refresher.run(now + 3); expect((await resolvePrice(prices, "anthropic", "old")).inputMicrosPerMTok).toBe(1_000_000);
});
it("records cap crossing atomically even if the correction acknowledgement is lost", async () => {
  const meter = new InMemoryMeter(() => now); const limit = { ...caps, companyMonth: 15 }; const id = await add(meter, now, limit);
  const correct = meter.correct.bind(meter); meter.correct = async (input) => { await correct(input); throw new Error("secret acknowledgement"); };
  expect((await runCorrections({ meter, prices: { priceFor: () => ({ inputMicrosPerMTok: 30_000_000, outputMicrosPerMTok: 1, priceVersion: 1, origin: { source: "litellm", fetchedAt: now } }) }, caps: new FixedCapsSource(limit), now, runId: "run" })).unknown).toBe(1);
  expect(meter.ledger(id)).toMatchObject({ status: "corrected", capExceeded: true });
});
it("an unrepresentable estimated total saturates without a price refusal even when individual rates fit", async () => {
  const price = { inputMicrosPerMTok: 4_000_000_000_000_000, outputMicrosPerMTok: 4_000_000_000_000_000, estimated: true };
  expect(estimateCall(2_000_000, 2_000_000, price)).toBe(Number.MAX_SAFE_INTEGER);
  expect(settleAmount({ usage: { ...usage, input: 2_000_000, output: 2_000_000 }, price, reservationMicros: Number.MAX_SAFE_INTEGER }).actualMicros).toBe(Number.MAX_SAFE_INTEGER);
  const f = setup({ prices: { priceFor: () => undefined, cautiousFor: () => ({ inputMicrosPerMTok: price.inputMicrosPerMTok, outputMicrosPerMTok: price.outputMicrosPerMTok }) }, caps: new FixedCapsSource({ task: Number.MAX_SAFE_INTEGER, companyMonth: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER }) });
  expect((await call(f.deps, { ...requestBody, messages: [{ role: "user", content: "x".repeat(3_000_000) }] })).status).toBe(200);
  expect(f.logs).toContainEqual({ event: "price_operator_review" });
});
it("an unreadable or malformed model floor saturates with fixed review metadata instead of guessing lower", async () => {
  for (const floorFor of [() => { throw new Error("secret-model"); }, () => ({ inputMicrosPerMTok: "secret", outputMicrosPerMTok: 1 }), () => null]) {
    const price = await resolvePrice({ floorFor: floorFor as never, priceFor: () => entry }, "anthropic", "secret-model");
    expect(price).toMatchObject({ estimated: true, operatorReview: true, inputMicrosPerMTok: Number.MAX_SAFE_INTEGER });
    expect(JSON.stringify(price)).not.toContain("secret");
  }
});
it("a model floor overrides a cheaper provider kind and rounds fractional micros upwards", async () => {
  const { prices } = await fromRows({ expensive: { ...base, unknown_cost: 1, input_cost_per_token: 1.0000001e-6, output_cost_per_token: 75e-6 }, cheap: { ...base, mode: "embedding", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 } });
  expect(await resolvePrice(prices, "anthropic", "expensive", undefined, undefined, "embedding")).toMatchObject({ inputMicrosPerMTok: 1_500_002, outputMicrosPerMTok: 112_500_000, estimated: true });
});
it("changed confirmation candidates restart the two-fetch requirement and mixed changes accept the rising component", async () => {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store); let result = good([entry]);
  const refresher = new PriceRefresher({ store, prices, litellm: async () => result, aws: failed });
  await refresher.run(now); result = good([{ ...entry, inputMicrosPerMTok: 1, outputMicrosPerMTok: 30_000_000 }]); await refresher.run(now + 1);
  expect(await resolvePrice(prices, "anthropic", "old")).toMatchObject({ inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 30_000_000 });
  result = good([{ ...entry, inputMicrosPerMTok: 2, outputMicrosPerMTok: 30_000_000 }]); await refresher.run(now + 2);
  expect((await resolvePrice(prices, "anthropic", "old")).inputMicrosPerMTok).toBe(3_000_000);
  await refresher.run(now + 3); expect((await resolvePrice(prices, "anthropic", "old")).inputMicrosPerMTok).toBe(2);
});
it("untrusted drop candidates fail the whole source and retain last-good bytes", async () => {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store); let result: PriceFetchResult = good([entry]);
  const refresher = new PriceRefresher({ store, prices, litellm: async () => result, aws: failed }); await refresher.run(now);
  const before = JSON.stringify(await store.load());
  for (const drops of [null, {}, [entry, entry], [{ ...entry, model: "secret" }], [{ ...entry, inputMicrosPerMTok: "secret" }]]) {
    result = { ...good([entry]), drops } as PriceFetchResult;
    expect((await refresher.run(now + 1)).ok).toBe(false); expect(JSON.stringify(await store.load())).toBe(before);
    expect(JSON.stringify(prices.health())).not.toContain("secret");
  }
});
it("retry bookkeeping is bounded and saturation explicitly flags operator review", async () => {
  // Adapter pages are synthetic: 20,001 ledger records, never a customer-sized scan in a run.
  const calls = Array.from({ length: 20_001 }, (_, i) => ({ ...scope, callKey: String(i), provider: "anthropic", model: "private", kind: "chat" as const, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, settledAt: now, settledMicros: 1, status: "pending" as const, month: "2026-11" }));
  const meter = new InMemoryMeter(() => now); let attempts = 0;
  meter.pendingKeys = async () => ({ items: [{ provider: "anthropic", model: "private" }] });
  meter.pendingFor = async (_key, limit, cursor) => { const start = Number(cursor ?? 0); const end = Math.min(start + limit, calls.length); return { items: calls.slice(start, end), ...(end === calls.length ? {} : { cursor: String(end) }) }; };
  meter.correct = async () => { attempts++; return { status: "unknown" }; };
  let reviewed = 0; const start = performance.now();
  for (let i = 0; i < 101; i++) {
    const before = attempts; await runCorrections({ meter, prices: real, caps: new FixedCapsSource(caps), now, runId: "run", log: (line) => { if (line.event === "price_correction_operator_review") reviewed++; } });
    expect(attempts - before).toBeLessThanOrEqual(200);
  }
  expect(attempts).toBe(20_000); expect(reviewed).toBe(1); expect(performance.now() - start).toBeLessThan(5000);
}, 10_000);
it("concurrent correction runners reserve one unknown attempt after asynchronous caps reads", async () => {
  const meter = new InMemoryMeter(() => now); await add(meter, now); let attempts = 0;
  meter.correct = async () => { attempts++; return { status: "unknown" }; };
  const options = { meter, prices: real, caps: { capsFor: async () => { await Promise.resolve(); return caps; } }, now, runId: "run" };
  const reports = await Promise.all([runCorrections(options), runCorrections(options)]);
  expect(attempts).toBe(1); expect(reports.reduce((sum, r) => sum + r.unknown, 0)).toBe(1);
});
it("a batch of cheap clean models keeps its exact prices without depressing dearer siblings", async () => {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store); let result = good([entry]);
  const refresher = new PriceRefresher({ store, prices, litellm: async () => result, aws: failed }); await refresher.run(now);
  result = good([entry, ...Array.from({ length: 100 }, (_, i) => ({ ...entry, model: String(i), inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }))]);
  await refresher.run(now + 1);
  for (let i = 0; i < 100; i++) expect(await resolvePrice(prices, "anthropic", String(i))).toMatchObject({ estimated: false, inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 });
  expect(await resolvePrice(prices, "anthropic", "old")).toMatchObject({ inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 });
});
