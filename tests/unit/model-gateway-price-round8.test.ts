import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { fixture, row, model } from "./model-gateway-price-round5-fixture.js";
import { call, setup, scope, sse, caps, now, requestBody } from "./model-gateway-fixture.js";
import { estimateCall } from "../../packages/model-gateway/src/estimate.js";
import { runCorrections } from "../../packages/model-gateway/src/correction.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { effectivePrices } from "../../packages/model-gateway/src/price-sanity.js";
import { validSnapshot } from "../../packages/model-gateway/src/price-snapshot.js";
beforeAll(denyNetwork);
const claude = (extra: Record<string, unknown> = {}) => row(3, 15, {
  cache_read_input_token_cost: 0.3e-6, cache_creation_input_token_cost: 3.75e-6, cache_creation_input_token_cost_above_1hr: 6e-6,
  input_cost_per_token_above_200k_tokens: 6e-6, output_cost_per_token_above_200k_tokens: 22.5e-6,
  cache_read_input_token_cost_above_200k_tokens: 0.6e-6, cache_creation_input_token_cost_above_200k_tokens: 7.5e-6, ...extra });
const usage = { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 };
const transport = async () => ({ status: 200, body: (async function* () {
  yield sse("message_start", { message: { usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  yield sse("message_delta", { usage: { output_tokens: 1000 } }); yield sse("message_stop"); })() });
const run = (meter: InMemoryMeter, prices: SnapshotPriceSource, log?: (v: unknown) => void) => runCorrections({ meter, prices, caps: new FixedCapsSource(caps), now, runId: "round8", ...(log ? { log } : {}) });
async function add(meter: InMemoryMeter, name = model, settledAt = now, priceVersion?: number) {
  const r = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!r.ok) throw new Error("fixture");
  await meter.settle(r.reservation, 100, { provider: "anthropic", model: name, kind: "chat", usage, settledAt, ...(priceVersion === undefined ? {} : { priceVersion }) });
  return JSON.stringify([scope.iss, scope.cid, r.reservation.id]);
}
it("M1 refuses the $9-billion correction, counts and logs it, and keeps every row unchanged", async () => {
  const f = fixture(); await f.fetch({ [model]: row(600, 600, { mode: "future-chat" }) });
  const g = setup({ prices: f.prices }); expect((await call(g.deps)).status).toBe(200);
  const before = await g.meter.read(scope); const pending = await g.meter.pendingFor({ provider: "anthropic", model }, 10);
  await f.fetch({ [model]: row(600, 600, { mode: "future-chat", input_cost_per_token_above_200k_tokens: 1e16 }) });
  const logs: unknown[] = [];
  expect(await run(g.meter, f.prices, (v) => logs.push(v))).toMatchObject({ corrected: 0, skipped: 1, more: true });
  expect(await g.meter.read(scope)).toEqual(before); expect(await g.meter.pendingFor({ provider: "anthropic", model }, 10)).toEqual(pending);
  expect(logs).toEqual([{ event: "price_correction_operator_review" }]);
});
it("M1 atomically refuses saturation of a meter row even when the correction amount itself is finite", async () => {
  const meter = new InMemoryMeter(() => now); const id = await add(meter);
  const r = await meter.reserve({ scope, caps, estimateMicros: 0 }); if (!r.ok) throw new Error("fixture");
  await meter.settle(r.reservation, Number.MAX_SAFE_INTEGER - 200);
  const before = await meter.read(scope);
  expect(await meter.correct({ callKey: id, realMicros: 200, caps, priceVersion: 1, estimated: false, priceSource: { source: "litellm", fetchedAt: now }, now, runId: "saturation" })).toEqual({ status: "busy" });
  expect(await meter.read(scope)).toEqual(before); expect(meter.ledger(id)?.status).toBe("pending");
});
it("M2 records settle version atomically with the price and rejects an older replica's 18000 correction to 27000", async () => {
  const f = fixture(); await f.fetch({ [model]: claude() });
  const stale = new SnapshotPriceSource(f.store, { now: () => now, overrides: [] }); await stale.reload();
  await f.fetch({ [model]: claude(), [model.toUpperCase()]: claude({ mode: "future-chat" }) });
  const g = setup({ prices: f.prices, transport }); expect((await call(g.deps)).status).toBe(200);
  const before = await g.meter.read(scope); expect(before[0]?.spentMicros).toBe(27000);
  const pending = await g.meter.pendingFor({ provider: "anthropic", model }, 10); expect(pending.items[0]).toMatchObject({ priceVersion: 2 });
  expect(await run(g.meter, stale)).toMatchObject({ corrected: 0, already: 1 });
  expect(await run(g.meter, f.prices)).toMatchObject({ corrected: 0, already: 1 });
  expect(await g.meter.read(scope)).toEqual(before); expect(await g.meter.pendingFor({ provider: "anthropic", model }, 10)).toEqual(pending);
});
it("M2 legacy version zero needs a newer version, including after a partial correction", async () => {
  const meter = new InMemoryMeter(() => now); const id = await add(meter);
  const input = { callKey: id, realMicros: 90, caps, priceSource: { source: "litellm" as const, fetchedAt: now }, now, runId: "version", estimated: true };
  expect(await meter.correct({ ...input, priceVersion: 0 })).toEqual({ status: "already" });
  expect(await meter.correct(input)).toEqual({ status: "busy" });
  expect(await meter.correct({ ...input, priceVersion: 2 })).toMatchObject({ status: "corrected" });
  expect(await meter.correct({ ...input, priceVersion: 1 })).toEqual({ status: "already" });
  expect(await meter.correct({ ...input, priceVersion: 2 })).toEqual({ status: "already" });
  expect(meter.ledger(id)).toMatchObject({ settledMicros: 90, priceVersion: 2, status: "pending" });
});
it("M3 web-search-only cost stays clean at x1.0 and two parallel plain calls both run", async () => {
  const f = fixture(); await f.fetch({ [model]: claude({ search_context_cost_per_query: { search_context_size_low: 0.01 } }) });
  expect(await f.price()).toMatchObject({ estimated: false, inputMicrosPerMTok: 3e6, outputMicrosPerMTok: 15e6 });
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void; const started = new Promise<void>((r) => { entered = r; });
  let count = 0;
  const g = setup({ prices: f.prices, transport: async () => { count++; entered(); if (count === 1) await gate; return transport(); } });
  const first = call(g.deps); await started;
  try { expect((await call(g.deps)).status).toBe(200); } finally { release(); await first; }
  expect((await g.meter.read(scope))[0]?.spentMicros).toBe(36000);
  expect((await g.meter.pendingKeys(10)).items).toEqual([]);
  for (const field of ["future_cost", "input_cost_per_audio_token_future", "search_context_cost_per_query_override", "search_context_above_128k_tokens_cost_per_query", "search_context_cost_per_query_above_200k_tokens"]) {
    const other = fixture(); await other.fetch({ [model]: claude({ [field]: 1 }) });
    expect(await other.price()).toMatchObject({ estimated: true, inputMicrosPerMTok: 4.5e6 });
  }
});
it("L1 short plain requests reserve only possible input and output, retaining the long-context ceiling", async () => {
  const f = fixture(); await f.fetch({ [model]: claude() });
  let held = 0; const body = { ...requestBody, max_tokens: 64000 };
  const g = setup({ prices: f.prices, transport: async () => { held = (await g.meter.read(scope))[0]!.reservedMicros; return transport(); } });
  expect((await call(g.deps, body)).status).toBe(200);
  expect(held).toBe(Buffer.byteLength(JSON.stringify(body)) * 3 + 64000 * 15);
  // Default estimator remains conservative for cache-capable callers; impossible bands still excluded.
  expect(estimateCall(200, 64000, await f.price())).toBe(961200);
  expect(estimateCall(200001, 64000, await f.price())).toBeGreaterThan(64000 * 22.5);
});
it("L2 never-seen estimates hold a sibling drop until two matching fetches, including after reload", async () => {
  const f = fixture(); await f.fetch({ [model]: row(3, 15), dear: row(15, 75) }); const before = await f.price("unseen");
  await f.fetch({ [model]: row(3, 15), dear: row(1, 5) }); await f.restart();
  expect((await f.price("unseen")).inputMicrosPerMTok).toBe(before.inputMicrosPerMTok);
  expect((await f.price("unseen")).outputMicrosPerMTok).toBe(before.outputMicrosPerMTok);
  await f.fetch({ [model]: row(3, 15), dear: row(1, 5) }); expect((await f.price("unseen")).inputMicrosPerMTok).toBe(4.5e6);
});
it("L3 evicts oldest retained aliases at 40000 and successive refreshes remain valid and bounded", () => {
  const entry = { provider: "anthropic", model, kind: "chat" as const, inputMicrosPerMTok: 3e6, outputMicrosPerMTok: 15e6 };
  const sources = { litellm: { fetchedAt: now, count: 1, entries: [entry] } };
  const old = effectivePrices(sources); old[0]!.aliases = Array.from({ length: 40000 }, (_, i) => `alias-${i}`);
  const start = performance.now(); const next = effectivePrices(sources, old);
  expect(next.flatMap((e) => e.aliases)).toHaveLength(40000);
  expect(next[0]!.aliases).not.toContain("alias-0"); expect(next[0]!.aliases).toContain(model);
  expect(validSnapshot({ version: 2, sources, effective: next })).toBe(true);
  expect(validSnapshot({ version: 3, sources, effective: effectivePrices(sources, next) })).toBe(true);
  expect(performance.now() - start).toBeLessThan(3000);
});
it("L4 an endless fallback-only prefix cannot starve another model's correction", async () => {
  const meter = new InMemoryMeter(() => now); for (let i = 0; i < 450; i++) await add(meter, "fallback", now + i);
  const id = await add(meter, model, now + 500);
  const f = fixture(); await f.fetch({ [model]: claude(), fallback: row(1, 1, { mode: "future-chat" }) });
  await run(meter, f.prices); await f.fetch({ [model]: claude(), fallback: row(1, 1, { mode: "future-chat" }) });
  await run(meter, f.prices); expect(meter.ledger(id)?.status).toBe("corrected");
});
it.each(["input_cost_per_token_priority", "output_cost_per_token_priority", "input_cost_per_audio_token", "output_cost_per_audio_token", "input_cost_per_image_token", "output_cost_per_image_token"])("L5 %s cannot raise or lower the standard token price", async (field) => {
  for (const rate of [0.01e-6, 999e-6]) for (const suffix of ["", "_above_128k_tokens", "_above_200k_tokens"]) {
    const f = fixture(); await f.fetch({ [model]: claude({ [field + suffix]: rate }) });
    expect(await f.price()).toMatchObject({ estimated: false, inputMicrosPerMTok: 3e6, outputMicrosPerMTok: 15e6 });
  }
});
it("M1 refuses a saturated used rate even when usage multiplication yields a finite amount", async () => {
  const meter = new InMemoryMeter(() => now); const id = await add(meter); const before = await meter.read(scope); const logs: unknown[] = [];
  const price = { inputMicrosPerMTok: 1, outputMicrosPerMTok: Number.MAX_SAFE_INTEGER, estimated: true, priceVersion: 1, origin: { source: "litellm" as const, fetchedAt: now } };
  expect(await runCorrections({ meter, prices: { priceFor: () => undefined, correctionFor: () => price }, caps: new FixedCapsSource(caps), now, runId: "saturated-rate", log: (v) => logs.push(v) })).toMatchObject({ corrected: 0, skipped: 1, more: true });
  expect(await meter.read(scope)).toEqual(before); expect(meter.ledger(id)?.status).toBe("pending"); expect(logs).toEqual([{ event: "price_correction_operator_review" }]);
});
it("M2 a refresh during streaming cannot replace the version of the price actually used", async () => {
  const f = fixture(); await f.fetch({ [model]: row(3, 15, { mode: "future-chat" }) });
  const g = setup({ prices: f.prices, transport: async () => { await f.fetch({ [model]: row(6, 30, { mode: "future-chat" }) }); return transport(); } });
  expect((await call(g.deps)).status).toBe(200);
  expect((await g.meter.pendingFor({ provider: "anthropic", model }, 10)).items[0]).toMatchObject({ priceVersion: 1, settledMicros: 27000 });
});
it("M2 malformed settle and effective versions fail closed without echoing input", async () => {
  const { resolvePrice } = await import("../../packages/model-gateway/src/price.js");
  for (const version of [-1, NaN, Infinity, "private-canary", {}, 0.5]) {
    const meter = new InMemoryMeter(() => now); const r = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!r.ok) throw new Error("fixture");
    await expect(meter.settle(r.reservation, 100, { provider: "anthropic", model, kind: "chat", usage, settledAt: now, priceVersion: version as number })).rejects.toThrow(/^settlement unavailable$/);
    expect((await meter.read(scope))[0]?.spentMicros).toBe(0);
    expect(await resolvePrice({ priceFor: () => undefined, effectiveFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, estimated: false, priceVersion: version as number }) }, "anthropic", model)).toMatchObject({ operatorReview: true });
  }
});
it("M3 listed features remain unavailable through the gateway", async () => {
  for (const extra of [{ tools: [{ type: "web_search_20250305", name: "web_search" }] }, { service_tier: "priority" }, { modalities: ["audio"] }]) {
    const g = setup(); const response = await call(g.deps, { ...requestBody, ...extra });
    expect(response.status).toBe(400); expect(response.text()).toBe('{"error":{"type":"invalid_request","message":"request not allowed"}}'); expect(g.calls).toHaveLength(0);
  }
});
it("L4 a growing final fallback key yields back to corrections on earlier keys", async () => {
  const meter = new InMemoryMeter(() => now); const id = await add(meter, model, now);
  for (let i = 0; i < 450; i++) await add(meter, "fallback", now + i + 1);
  const f = fixture(); await f.fetch({ [model]: row(1, 1, { mode: "future-chat" }), fallback: row(1, 1, { mode: "future-chat" }) });
  await run(meter, f.prices);
  await f.fetch({ [model]: claude(), fallback: row(1, 1, { mode: "future-chat" }) });
  await run(meter, f.prices); expect(meter.ledger(id)?.status).toBe("corrected");
});
it("M1 an overflowing usage total is counted and logged without changing spend", async () => {
  const meter = new InMemoryMeter(() => now); const r = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!r.ok) throw new Error("fixture");
  await meter.settle(r.reservation, 100, { provider: "anthropic", model, kind: "chat", usage: { ...usage, output: 2000000 }, settledAt: now });
  const before = await meter.read(scope); const logs: unknown[] = [];
  const price = { inputMicrosPerMTok: 1, outputMicrosPerMTok: Number.MAX_SAFE_INTEGER - 1, estimated: false, priceVersion: 1, origin: { source: "litellm" as const, fetchedAt: now } };
  expect(await runCorrections({ meter, prices: { priceFor: () => undefined, correctionFor: () => price }, caps: new FixedCapsSource(caps), now, runId: "total", log: (v) => logs.push(v) })).toMatchObject({ corrected: 0, skipped: 1, more: true });
  expect(await meter.read(scope)).toEqual(before); expect(logs).toEqual([{ event: "price_correction_operator_review" }]);
});
it("M1 a reviewed non-saturated replacement corrects only after its two confirmations", async () => {
  const f = fixture(); await f.fetch({ [model]: row(600, 600, { mode: "future-chat" }) }); const g = setup({ prices: f.prices }); await call(g.deps);
  await f.fetch({ [model]: row(600, 600, { mode: "future-chat", input_cost_per_token_above_200k_tokens: 1e16 }) });
  const clean = { [model]: row(600, 600, { cache_read_input_token_cost: 600e-6, cache_creation_input_token_cost: 600e-6, cache_creation_input_token_cost_above_1hr: 600e-6 }) };
  await f.fetch(clean); expect((await run(g.meter, f.prices)).corrected).toBe(0);
  await f.fetch(clean); expect((await run(g.meter, f.prices)).corrected).toBe(1);
  expect((await g.meter.read(scope))[0]).toMatchObject({ spentMicros: 8400, estimatedMicros: 0 });
});
it("L3 a full 40000-identity replacement evicts oldest history without freezing refresh", () => {
  const make = (provider: string, prefix: string) => Array.from({ length: 20000 }, (_, i) => ({ provider, model: `${prefix}-${i}`, kind: "chat" as const, inputMicrosPerMTok: 1, outputMicrosPerMTok: 2 }));
  const sources = (prefix: string) => ({ litellm: { fetchedAt: now, count: 20000, entries: make("anthropic", prefix) }, aws: { fetchedAt: now, count: 20000, entries: make("bedrock", prefix) } });
  const oldSources = sources("old"); const old = effectivePrices(oldSources);
  const nextSources = sources("new"); const start = performance.now(); const next = effectivePrices(nextSources, old);
  expect(next).toHaveLength(40000); expect(next.some((e) => e.model.startsWith("old-"))).toBe(false);
  expect(validSnapshot({ version: 2, sources: nextSources, effective: next })).toBe(true);
  // A quadratic replacement would take minutes. 45 s keeps real headroom for a loaded runner: this took 2.0 s on a quiet machine and 7.3 s on CI (#1478), which failed a 5 s bound.
  expect(performance.now() - start).toBeLessThan(45_000);
});
