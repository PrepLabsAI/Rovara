import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { fetchLiteLLM } from "../../packages/model-gateway/src/price-sources.js";
import { InMemoryPriceSnapshotStore, validSnapshot } from "../../packages/model-gateway/src/price-snapshot.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { PriceRefresher } from "../../packages/model-gateway/src/price-refresh.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
import { estimateCall } from "../../packages/model-gateway/src/estimate.js";
import { settleAmount } from "../../packages/model-gateway/src/reported-cost.js";
import { now, setup, call, answer, scope } from "./model-gateway-fixture.js";
import { fixture as pooledFixture, row as pooledRow, bedrock as bedrockRow, offer as awsOffer, alias as bedrockAlias } from "./model-gateway-price-round5-fixture.js";
beforeAll(denyNetwork);
const model = "claude-sonnet-4-5";
const row = (input = 15, extra: Record<string, unknown> = {}) => ({ litellm_provider: "anthropic", mode: "chat", input_cost_per_token: input / 1e6, output_cost_per_token: input * 5 / 1e6, ...extra });
const skipped = { future_feature_cost_per_query: { private: 1 } };
const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
function fixture() {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store, { now: () => now });
  let rows: unknown; let tick = now;
  const logs: unknown[] = [];
  const refresher = () => new PriceRefresher({ store, prices, log: (line) => logs.push(line), aws: async () => ({ ok: false, reason: "invalid source" }), litellm: (previous) => fetchLiteLLM({ get: async () => ({ status: 200, body: Buffer.from(typeof rows === "string" ? rows : JSON.stringify(rows)) }) }, { previous, now, minModels: 1 }) });
  return { store, prices, logs, async fetch(next: unknown) { rows = next; await refresher().run(tick++); }, async price(name = model, kind: "chat" | "embedding" = "chat") { return resolvePrice(prices, "anthropic", name, undefined, undefined, kind); } };
}
async function money(f: ReturnType<typeof fixture>, minimum: number) {
  const p = await f.price();
  expect(p.inputMicrosPerMTok).toBeGreaterThanOrEqual(minimum * 1e6);
  expect(p.outputMicrosPerMTok).toBeGreaterThanOrEqual(minimum * 5e6);
  expect(estimateCall(1_000_000, 1_000_000, p)).toBeGreaterThanOrEqual(minimum * 6e6);
  expect(settleAmount({ price: p, usage, reservationMicros: 1 }).actualMicros).toBeGreaterThanOrEqual(minimum * 6e6);
  return p;
}
it.each(["future-chat", null, 7, {}, "embedding-new"])("unknown mode %j retains own floor and raises every provider kind", async (mode) => {
  const f = fixture(); await f.fetch({ peer: row(3), embed: row(1, { mode: "embedding" }), [model]: row(15, { mode }) });
  expect((await money(f, 22.5)).estimated).toBe(true);
  for (const kind of ["chat", "embedding"] as const) expect(await f.price("unlisted", kind)).toMatchObject({ inputMicrosPerMTok: 33_750_000, outputMicrosPerMTok: 168_750_000 });
  const gateway = setup({ prices: f.prices }); let held = 0;
  gateway.deps.transport = async () => { held = (await gateway.meter.read(scope))[0]!.reservedMicros; return { status: 200, body: answer() }; };
  expect((await call(gateway.deps)).status).toBe(200); expect(held).toBeGreaterThanOrEqual(765);
  expect((await gateway.meter.read(scope))[0]?.spentMicros).toBe(855);
  expect(JSON.stringify(f.logs)).not.toMatch(/claude|future|private/);
});
it.each([
  ["floor to floor", skipped, skipped, 22.5, 0.75],
  ["floor to known", skipped, {}, 22.5, 0.5],
  ["known to floor", {}, skipped, 15, 0.75],
] as const)("confirms effective drops: %s", async (_name, before, after, previous, confirmed) => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(15, before) }); await money(f, previous);
  const lower = { peer: row(3), [model]: row(0.5, after) };
  await f.fetch(lower); expect((await money(f, previous)).estimated).toBe(true);
  await f.fetch(lower); expect((await f.price()).inputMicrosPerMTok).toBe(confirmed * 1e6); await money(f, confirmed);
});
it("holds a transition's smaller decrease too; a first lower fetch is never known", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(15, skipped) });
  await f.fetch({ peer: row(3), [model]: row(15) }); expect((await money(f, 22.5)).estimated).toBe(true);
  await f.fetch({ peer: row(3), [model]: row(15) }); expect(await f.price()).toMatchObject({ inputMicrosPerMTok: 15_000_000, estimated: false });
});
it("failed fetches and changed lower numbers reset confirmation across restarts; rises apply immediately", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(15, skipped) });
  await f.fetch({ peer: row(3), [model]: row(1, skipped) }); await money(f, 22.5);
  await f.fetch("{bad-private"); await money(f, 22.5);
  await f.fetch({ peer: row(3), [model]: row(1, skipped) }); await money(f, 22.5);
  await f.fetch({ peer: row(3), [model]: row(4, skipped) }); await money(f, 22.5);
  await f.fetch({ peer: row(3), [model]: row(30, skipped) }); await money(f, 45);
  await f.fetch({ peer: row(3), [model]: row(4, skipped) }); await money(f, 45);
  await f.fetch({ peer: row(3), [model]: row(4, skipped) }); expect((await f.price()).inputMicrosPerMTok).toBe(6e6);
  expect(JSON.stringify(f.logs)).not.toMatch(/private|claude/);
});
it("confirms a fallback only after two successful absent or unpriceable observations", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(15, skipped) });
  await f.fetch({ peer: row(3) }); await money(f, 22.5);
  await f.fetch({ peer: row(3), [model]: { mode: "future-chat", litellm_provider: "anthropic" } });
  expect(await f.price()).toMatchObject({ inputMicrosPerMTok: 4.5e6, outputMicrosPerMTok: 22.5e6, estimated: true });
});
it("property: pooled multi-source aliases obey component maxima, consecutive drops and exact confirmed clean prices", async () => {
  let seed = 0x31415926;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  let drops = 0; let uncertain = 0; let mixed = 0;
  const variants = [{}, { mode: "future-chat" }, { unknown_price: 1 }, { cost_per_request: 1 }, { deprecation_date: {} }];
  for (let sequence = 0; sequence < 8; sequence++) {
    const f = pooledFixture("bedrock", bedrockAlias); let prior = [0, 0]; let preceding: number[] | undefined;
    let lastLL: number[] = [0, 0]; let lastAWS: number[] = [0, 0];
    let previousRows: Record<string, unknown> = {}; let previousOffer = awsOffer(1); let previousLL = [0, 0]; let previousAWS = [0, 0];
    for (let step = 0; step < 40; step++) {
      const rates = Array.from({ length: 6 }, () => [2, 6, 10, 40, 100][random() % 5]!);
      const classification = random() % variants.length; const extra = variants[classification]!;
      const factor = classification === 0 ? 1 : 1.5; if (factor > 1) uncertain++;
      let llCandidate = [Math.max(rates[0]!, rates[2]! * factor, classification === 3 ? 100 : 0), Math.max(rates[1]!, rates[3]! * factor, classification === 3 ? 100 : 0)];
      let awsCandidate = [rates[4]!, rates[5]!];
      let rows: Record<string, unknown> = { [bedrockAlias]: bedrockRow(rates[0], rates[1]), " GLOBAL.ANTHROPIC.EXAMPLE-v1:0 ": bedrockRow(rates[2], rates[3], extra), foreign: pooledRow(200, 200), embedding: pooledRow(1, 2, { mode: "embedding" }) };
      let amazon = awsOffer(rates[4]!, rates[5]);
      // Repeated observations force temporal assertions to execute, including mixed directions.
      if (step % 4 === 3) { rows = previousRows; amazon = previousOffer; llCandidate = previousLL; awsCandidate = previousAWS; }
      const failedLL = step > 0 && step % 11 === 0; const failedAWS = step > 0 && step % 13 === 0;
      await f.fetch(failedLL ? "{" : rows, failedAWS ? "{" : amazon); await f.restart();
      if (!failedLL) lastLL = llCandidate; if (!failedAWS) lastAWS = awsCandidate;
      const candidate = [Math.max(lastLL[0]!, lastAWS[0]!), Math.max(lastLL[1]!, lastAWS[1]!)];
      const p = await f.price(); const current = [p.inputMicrosPerMTok / 1e6, p.outputMicrosPerMTok / 1e6];
      expect(current[0]).toBeGreaterThanOrEqual(candidate[0]!); expect(current[1]).toBeGreaterThanOrEqual(candidate[1]!);
      expect(estimateCall(1_000_000, 1_000_000, p)).toBeGreaterThanOrEqual((candidate[0]! + candidate[1]!) * 1e6);
      expect(settleAmount({ price: p, usage, reservationMicros: 1 }).actualMicros).toBeGreaterThanOrEqual((candidate[0]! + candidate[1]!) * 1e6);
      if (current.some((n, i) => n < prior[i]!)) { drops++; expect(failedLL || failedAWS).toBe(false); expect(candidate).toEqual(preceding); }
      if (candidate[0]! > prior[0]! && candidate[1]! < prior[1]!) { mixed++; expect(current[0]).toBe(candidate[0]); }
      preceding = failedLL || failedAWS ? undefined : candidate; prior = current;
      previousRows = rows; previousOffer = amazon; previousLL = llCandidate; previousAWS = awsCandidate;
    }
    const clean = { [bedrockAlias]: bedrockRow(15), "global.anthropic.example-v1:0": bedrockRow(15), foreign: pooledRow(200, 200), embedding: pooledRow(1, 2, { mode: "embedding" }) };
    await f.fetch(clean, awsOffer(15)); await f.fetch(clean, awsOffer(15));
    expect(await f.price()).toMatchObject({ inputMicrosPerMTok: 15e6, outputMicrosPerMTok: 75e6, estimated: false });
  }
  expect(drops).toBeGreaterThan(10); expect(uncertain).toBeGreaterThan(50); expect(mixed).toBeGreaterThan(10);
});
it("accepts legacy snapshots byte-for-byte and validates new floor metadata at runtime", async () => {
  const f = fixture(); await f.fetch({ peer: row(3) }); const old = await f.store.load(); expect(validSnapshot(old)).toBe(true);
  const saved = JSON.stringify(old); await f.prices.reload(); expect(JSON.stringify(await f.store.load())).toBe(saved);
});
it("compares the identity effective price separately for each component", async () => {
  const f = fixture(); await f.fetch({ peer: row(30), [model]: row(15, skipped) });
  const lower = { peer: row(3), [model]: row(0.5, { ...skipped, input_cost_per_token: 60e-6 }) };
  await f.fetch(lower); expect(await f.price()).toMatchObject({ inputMicrosPerMTok: 90e6, outputMicrosPerMTok: 112.5e6, estimated: true });
  await f.fetch(lower); expect(await f.price()).toMatchObject({ inputMicrosPerMTok: 90e6, outputMicrosPerMTok: 3.75e6 });
});
it("confirms over-max and overflow floors without clipping or losing operator review early", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(1e16) });
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.fetch({ peer: row(3), [model]: row(2000) }); const p = await f.price();
    expect(estimateCall(1, 1, p)).toBe(attempt === 0 ? Number.MAX_SAFE_INTEGER : 21_000);
    expect(settleAmount({ price: p, usage: { ...usage, input: 1, output: 1 }, reservationMicros: 1 }).actualMicros).toBe(attempt === 0 ? Number.MAX_SAFE_INTEGER : 18_000);
  }
});
it("validates unknown-kind floors and unbounded confirmations while rejecting malformed kinds and reasons", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(2000, { mode: "future-chat" }) });
  await f.fetch({ peer: row(3), [model]: row(500, { mode: "future-chat" }) });
  const snapshot = (await f.store.load())!;
  expect(snapshot.effective?.find((e) => e.model === model)?.pendingLower).toBeDefined(); expect(validSnapshot(snapshot)).toBe(true);
  for (const invalid of [{ kind: "private" }, { kind: null }, { reason: "private" }, { inputMicrosPerMTok: Infinity }]) {
    const bad = structuredClone(snapshot); Object.assign(bad.sources.litellm!.floors![0]!, invalid); expect(validSnapshot(bad)).toBe(false);

  }
});
it("scales the 20,000-row mixed source linearly (within 15x of 2,000 rows) and never hangs", async () => {
  // Relative bound, not a wall-clock one: a slow CI runner slows both runs alike. Linear is about 10x; a quadratic pass would be about 100x.
  const run = async (count: number) => {
    const f = fixture(); const rows = Object.fromEntries(Array.from({ length: count }, (_, i) => [i === 0 ? model : `model-${i}`, row(15, i % 2 ? { mode: "future-chat" } : skipped)]));
    const start = performance.now(); await f.fetch(rows); await money(f, 22.5);
    const elapsed = performance.now() - start;
    expect((await f.store.load())?.sources.litellm?.floors).toHaveLength(count);
    return elapsed;
  };
  await run(2_000); // warm-up so the timed 2,000-row run is not dominated by first-call compilation
  const t2k = await run(2_000); const t20k = await run(20_000);
  expect(t20k / Math.max(t2k, 50)).toBeLessThanOrEqual(15);
  expect(t20k).toBeLessThan(15_000);
});
it("unknown-kind Bedrock alias floors raise both kinds even when a later alias is classified", async () => {
  const f = fixture(); await f.fetch({
    "us.anthropic.example-v1:0": row(15, { litellm_provider: "bedrock", mode: "future-chat" }),
    "global.anthropic.example-v1:0": row(3, { litellm_provider: "bedrock", ...skipped }),
    embedding: row(1, { litellm_provider: "bedrock", mode: "embedding" }),
  });
  for (const kind of ["chat", "embedding"] as const) expect(await resolvePrice(f.prices, "bedrock", "unlisted", undefined, undefined, kind)).toMatchObject({ inputMicrosPerMTok: 33_750_000, outputMicrosPerMTok: 168_750_000 });
});
it("retention across a later per-request fallback preserves both the flat policy and any dearer prior floor", async () => {
  for (const rate of [15, 2000]) {
    const f = fixture(); await f.fetch({ peer: row(3), [model]: row(rate, skipped) });
    await f.fetch({ peer: row(3), [model]: row(1, { cost_per_request: 1 }) });
    const p = await f.price(); expect(p.inputMicrosPerMTok).toBeGreaterThanOrEqual(Math.max(100, rate * 1.5) * 1e6);
    expect(p.outputMicrosPerMTok).toBeGreaterThanOrEqual(Math.max(100, rate * 7.5) * 1e6);
  }
});
it("confirmation matches output independently of input and retains tiny amounts with upward rounding", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(15, skipped) });
  await f.fetch({ peer: row(3), [model]: row(4, skipped) }); await money(f, 22.5);
  const changedOutput = { peer: row(3), [model]: row(4, { ...skipped, output_cost_per_token: 25e-6 }) };
  await f.fetch(changedOutput); await money(f, 22.5);
  await f.fetch(changedOutput); expect(await f.price()).toMatchObject({ inputMicrosPerMTok: 6e6, outputMicrosPerMTok: 37.5e6 });
  const tiny = fixture(); await tiny.fetch({ peer: row(0.000001), [model]: row(0.000013) });
  await tiny.fetch({ peer: row(0.000001), [model]: row(0.000001, skipped) }); await money(tiny, 0.000013);
});
it("preserves the previous effective floor when its expensive provider peer disappears", async () => {
  const f = fixture(); await f.fetch({ peer: row(30), [model]: row(15, skipped) }); await money(f, 22.5);
  await f.fetch({ [model]: row(0.5, skipped) }); await money(f, 22.5);
});
