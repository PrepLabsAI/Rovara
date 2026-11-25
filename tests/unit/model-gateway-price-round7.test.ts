import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { fixture, row, model, bedrock, alias, offer } from "./model-gateway-price-round5-fixture.js";
import { call, setup, scope, sse, requestBody, caps, now } from "./model-gateway-fixture.js";
import { runCorrections } from "../../packages/model-gateway/src/correction.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { estimateCall } from "../../packages/model-gateway/src/estimate.js";
beforeAll(denyNetwork);
const known = { cache_read_input_token_cost: 600e-6 };
async function gateway(f: ReturnType<typeof fixture>, input: number, read: number, write: number, output: number, meter = new InMemoryMeter(() => now)) {
  const g = setup({ prices: f.prices, meter, transport: async () => ({ status: 200, body: (async function* () {
    yield sse("message_start", { message: { usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write } } });
    yield sse("message_delta", { usage: { output_tokens: output } }); yield sse("message_stop");
  })() }) });
  expect((await call(g.deps, { ...requestBody, messages: [{ role: "user", content: "x".repeat(Math.max(10, input + read + write)) }] })).status).toBe(200);
  return meter;
}
const correct = (f: ReturnType<typeof fixture>, meter: InMemoryMeter) => runCorrections({ meter, prices: f.prices, caps: new FixedCapsSource(caps), now, runId: "round7" });
const amounts = async (meter: InMemoryMeter, spent: number, estimated: number) => expect((await meter.read(scope)).every((r) => r.spentMicros === spent && r.estimatedMicros === estimated)).toBe(true);
it("M1 partial correction accepts derived rates above raw max, repeats once per version, and preserves a racing settle", async () => {
  const f = fixture(); await f.fetch({ [model]: row(600, 600, { ...known, mode: "future-chat" }) });
  let interleave: (() => Promise<void>) | undefined;
  const meter = new InMemoryMeter(() => now, () => false, async (op) => { if (op === "correct") { const work = interleave; interleave = undefined; await work?.(); } });
  await gateway(f, 2, 3, 4, 5, meter); await amounts(meter, 16200, 16200);
  const pending = (await meter.pendingFor({ provider: "anthropic", model }, 10)).items[0]!;
  await f.fetch({ [model]: row(600, 600, known) }); await f.fetch({ [model]: row(600, 600, known) }); await f.restart();
  const reserved = await meter.reserve({ scope, caps, estimateMicros: 50 }); if (!reserved.ok) throw new Error("fixture");
  interleave = () => meter.settle(reserved.reservation, 50);
  expect(await correct(f, meter)).toMatchObject({ corrected: 1 }); await amounts(meter, 10850, 10800);
  expect(meter.ledger(pending.callKey)).toMatchObject({ status: "pending", settledMicros: 10800, deltaMicros: -5400 });
  expect(await correct(f, meter)).toMatchObject({ corrected: 0, already: 1 }); await amounts(meter, 10850, 10800);
  const all = { [model]: row(600, 600, { ...known, cache_creation_input_token_cost: 700e-6, cache_creation_input_token_cost_above_1hr: 800e-6 }) };
  await f.fetch(all); await f.fetch(all);
  expect(await correct(f, meter)).toMatchObject({ corrected: 1 }); await amounts(meter, 9250, 0);
  expect(meter.ledger(pending.callKey)).toMatchObject({ status: "corrected", deltaMicros: -1600 });
  expect((await meter.pendingKeys(10)).items).toEqual([]);
});
it("zero-usage derived tiers do not retain estimates or block correction", async () => {
  const f = fixture(); await f.fetch({ [model]: row(600, 600, { mode: "future-chat" }) });
  const meter = await gateway(f, 2, 0, 0, 5); await amounts(meter, 6300, 6300);
  await f.fetch({ [model]: row(600, 600) }); await f.fetch({ [model]: row(600, 600) });
  expect(await correct(f, meter)).toMatchObject({ corrected: 1 }); await amounts(meter, 4200, 0);
  const clean = await gateway(f, 2, 0, 0, 5); await amounts(clean, 4200, 0);
});
it.each([
  ["cached-read", 10, 90, 0, 0, 1000, { cache_read_input_token_cost: 1e-6 }, 190],
  ["cache-write", 0, 0, 100, 0, 2000, { cache_creation_input_token_cost: 12e-6, cache_creation_input_token_cost_above_1hr: 15e-6 }, 1500],
  ["long-context", 200001, 0, 0, 1, 4000120, { input_cost_per_token_above_200k_tokens: 15e-6, output_cost_per_token_above_200k_tokens: 70e-6 }, 3000085],
] as const)("M2 own %s fallback is estimated and later corrected", async (_name, input, read, write, output, initial, extra, final) => {
  const f = fixture(); const sibling = row(20, 60, { mode: "future-chat", cache_read_input_token_cost: 100e-6, input_cost_per_token_above_200k_tokens: 1e16 });
  await f.fetch({ [model]: row(10, 50), sibling });
  const meter = await gateway(f, input, read, write, output); await amounts(meter, initial, initial);
  const rows = { [model]: row(10, 50, extra), sibling }; await f.fetch(rows); await f.fetch(rows); await f.restart();
  expect(await correct(f, meter)).toMatchObject({ corrected: 1 }); await amounts(meter, final, 0);
});
it.each([1e16, 4000])("M3 own extreme tier %s saturates (raw or derived) and returns budget exceeded", async (rate) => {
  const f = fixture(); await f.fetch({ [model]: row(10, 50, { input_cost_per_token_above_200k_tokens: rate }) });
  const price = await f.price(); expect(price).toMatchObject({ estimated: true, operatorReview: true });
  expect(estimateCall(2_000_000, 1, price)).toBe(Number.MAX_SAFE_INTEGER);
  const g = setup({ prices: f.prices }); const result = await call(g.deps, { ...requestBody, messages: [{ role: "user", content: "x".repeat(2_000_000) }] });
  expect(result.status).toBe(422); expect(result.text()).toContain("budget_exceeded"); expect(result.text()).not.toContain(model);
});
it("M4 sibling source failures are irrelevant; own contributing failures reset lower confirmation", async () => {
  const f = fixture("bedrock", alias); const ll = { [alias]: bedrock(10, 50) };
  await f.fetch(ll, offer(100, 100, "Sibling")); const initial = await f.price();
  await f.fetch(ll, offer(10, 50, "Sibling")); await f.fetch(ll, "{");
  expect(await f.price()).toEqual({ ...initial, priceVersion: 3 });
  const own = fixture("bedrock", alias); await own.fetch(ll, offer(20, 60));
  await own.fetch(ll, offer(10, 50)); await own.fetch(ll, "{");
  expect((await own.price()).inputMicrosPerMTok).toBe(20e6);
  await own.fetch(ll, offer(10, 50)); expect((await own.price()).inputMicrosPerMTok).toBe(20e6);
  await own.fetch(ll, offer(10, 50)); expect((await own.price()).inputMicrosPerMTok).toBe(10e6);
});
it("unused uncertain components do not label known base usage estimated", async () => {
  const f = fixture(); await f.fetch({ [model]: row(10, 50, { cache_read_input_token_cost: 1e-6 }), [model.toUpperCase()]: row(1, 1, { mode: "future-chat", cache_read_input_token_cost: 100e-6 }) });
  const meter = await gateway(f, 2, 0, 0, 5); await amounts(meter, 270, 0);
});
it("property: seeded sibling changes never alter another identity with missing tiers", async () => {
  let seed = 574; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const own = fixture(); const peers = fixture();
  for (let i = 0; i < 40; i++) {
    const target = row(1 + random() % 10, 20 + random() % 40, i % 2 ? { cache_read_input_token_cost: (random() % 10) / 1e6 } : {});
    const sibling = row(20 + random() % 100, 60 + random() % 100, { mode: i % 2 ? "chat" : "future", cache_read_input_token_cost: (random() % 100) / 1e6, input_cost_per_token_above_200k_tokens: i % 7 ? 300e-6 : 1e16 });
    await own.fetch({ [model]: target }); await peers.fetch({ [model]: target, sibling });
    await own.restart(); await peers.restart(); expect(await peers.price()).toEqual(await own.price());
  }
});
it("partial deltas can rise, duplicate/stale versions cannot reapply, and expiry retains estimated spend", async () => {
  const f = fixture(); await f.fetch({ [model]: row(10, 50) }); const meter = await gateway(f, 0, 0, 100, 0);
  await amounts(meter, 2000, 2000);
  await f.fetch({ [model]: row(20, 50) });
  expect(await correct(f, meter)).toMatchObject({ corrected: 1 }); await amounts(meter, 4000, 4000);
  const pending = (await meter.pendingFor({ provider: "anthropic", model }, 10)).items[0]!;
  const input = { callKey: pending.callKey, caps, priceSource: { source: "litellm" as const, fetchedAt: now }, now, runId: "partial", priceVersion: pending.priceVersion!, estimated: true, realMicros: 123 };
  expect(await meter.correct(input)).toEqual({ status: "already" });
  expect(await meter.correct({ ...input, priceVersion: input.priceVersion - 1 })).toEqual({ status: "already" });
  const next = { ...input, priceVersion: input.priceVersion + 1, realMicros: 5000 };
  expect((await Promise.all([meter.correct(next), meter.correct(next)])).map((r) => r.status).sort()).toEqual(["already", "corrected"]);
  await amounts(meter, 5000, 5000);
  const logs: unknown[] = [];
  const { runExpirySweep } = await import("../../packages/model-gateway/src/correction.js");
  expect(await runExpirySweep({ meter, now: now + 63 * 86400000, runId: "expiry", log: (v) => logs.push(v) })).toMatchObject({ expired: 1 });
  await amounts(meter, 5000, 5000); expect(logs).toEqual([{ event: "price_expired" }]);
  expect((await meter.pendingKeys(10)).items).toEqual([]);
});
it("zero usage of an unknown write duration never blocks a known duration", async () => {
  const f = fixture(); await f.fetch({ [model]: row(10, 50, { cache_creation_input_token_cost: 12e-6 }) });
  const g = setup({ prices: f.prices, transport: async () => ({ status: 200, body: (async function* () {
    yield sse("message_start", { message: { usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } } } });
    yield sse("message_delta", { usage: { output_tokens: 0 } }); yield sse("message_stop");
  })() }) });
  expect((await call(g.deps)).status).toBe(200); await amounts(g.meter, 1200, 0);
});
it("provenance and correction version metadata reject malformed runtime values without leaking", async () => {
  const { validSnapshot } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const f = fixture(); await f.fetch({ [model]: row(10, 50) }); const snapshot = (await f.store.load())!;
  for (const field of ["derived", "uncertain"]) for (const invalid of [null, "private-canary", {}, [{ aboveTokens: -1, keys: [] }], [{ aboveTokens: 0, keys: ["private-canary"] }], [{ aboveTokens: 0, keys: ["inputMicrosPerMTok", "inputMicrosPerMTok"] }], [{ aboveTokens: 200000, keys: [] }, { aboveTokens: 0, keys: [] }]]) {
    const bad = structuredClone(snapshot); Object.assign(bad.effective![0]!, { [field]: invalid }); expect(validSnapshot(bad)).toBe(false);
  }
  const meter = await gateway(f, 0, 100, 0, 0); const pending = (await meter.pendingFor({ provider: "anthropic", model }, 1)).items[0]!;
  const input = { callKey: pending.callKey, realMicros: 50, caps, priceSource: { source: "litellm", fetchedAt: now }, now, runId: "runtime", estimated: true, priceVersion: 10 };
  for (const invalid of [{ priceVersion: NaN }, { priceVersion: -1 }, { priceVersion: "private-canary" }, { estimated: "private-canary" }, { estimated: undefined }, { priceVersion: undefined }]) {
    expect(await meter.correct({ ...input, ...invalid } as never)).toEqual({ status: "busy" });
  }
  await amounts(meter, 1000, 1000);
  const logs: unknown[] = [];
  for (const invalid of [{ estimated: "private-canary" }, { priceVersion: NaN }, { cacheWrite5mMicrosPerMTok: Infinity }]) {
    const prices = { priceFor: () => undefined, correctionFor: () => ({ ...f.prices.correctionFor("anthropic", model)!, ...invalid }) };
    expect(await runCorrections({ meter, prices: prices as never, caps: new FixedCapsSource(caps), now, runId: "invalid", log: (v) => logs.push(v) })).toMatchObject({ corrected: 0, skipped: 1 });
  }
  expect(JSON.stringify(logs)).not.toMatch(/private|claude|Infinity|NaN/); await amounts(meter, 1000, 1000);
});
