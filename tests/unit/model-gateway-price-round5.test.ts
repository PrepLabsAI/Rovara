import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { parseReportedCost, settleAmount } from "../../packages/model-gateway/src/reported-cost.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
import { setup, call, answer, scope } from "./model-gateway-fixture.js";
import { fixture, row, bedrock, offer, money, model, alias, usage } from "./model-gateway-price-round5-fixture.js";
beforeAll(denyNetwork);
it.each(["same-source", "new-alias", "cross-source"])("M1 pools cheap uncertain aliases with dearer clean rows: %s", async (which) => {
  const f = fixture("bedrock", alias); const high = { [alias]: bedrock(15) };
  if (which === "new-alias") { await f.fetch(high); await money(f, 15, 75, false); }
  await f.fetch({ ...(which === "cross-source" ? {} : high), " GLOBAL.ANTHROPIC.EXAMPLE-v1:0 ": bedrock(0.5, 2.5, { mode: "future-chat" }) }, which === "cross-source" ? offer(15) : undefined);
  await money(f, 15, 75, false); // Per-row x1.0/x1.5; a cheap uncertain alias does not raise the clean maximum.
});
it("M2 a newly appearing source cannot erase a dearer successful source; components pool independently", async () => {
  for (const output of [750, 20]) {
    const f = fixture("bedrock", alias); await f.fetch({ [alias]: bedrock(150, output) });
    await f.fetch({ [alias]: bedrock(150, output) }, offer(15, 75)); await money(f, 150, Math.max(output, 75), false);
  }
});
it.each([" CLAUDE-SONNET-4-5 ", "CLAUDE-SONNET-4-5", "claude-sonnet-4-5 "])("pools case/whitespace aliases %s", async (key) => {
  const f = fixture(); await f.fetch({ [model]: row(3), [key]: row(15, 75, { mode: "future-chat" }) }); await money(f, 22.5, 112.5, true);
});
it.each(["single", "cross-source", "cross-expensive"])("M3 per-request max preserves every known token component: %s", async (which) => {
  const f = which === "single" ? fixture() : fixture("bedrock", alias);
  await f.fetch(which === "single" ? { peer: row(3), [model]: row(2000, 10000, { cost_per_request: 1 }) } : { [alias]: bedrock(which === "cross-expensive" ? 2000 : 1, which === "cross-expensive" ? 10000 : 2, { cost_per_request: 1 }) }, which === "single" ? undefined : offer(150));
  await money(f, which === "cross-source" ? 150 : 3000, which === "cross-source" ? 750 : 15000, which !== "cross-source");
});
it("M4 clean prices are exact, including tiny clean models among dearer peers", async () => {
  const f = fixture(); await f.fetch({ peer: row(200), [model]: row(15), cheap: row(0.01) }); await money(f, 15, 75, false);
  expect(await f.price("cheap")).toMatchObject({ inputMicrosPerMTok: 10000, outputMicrosPerMTok: 50000, estimated: false });
});
it.each([" Anthropic ", null, {}, "private-unknown"])("M5 exact previously identified row retains rising rates under malformed provider %j", async (litellm_provider) => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(15, 75, { mode: "future-chat" }) }); await f.restart();
  for (const rate of [150, 200]) { await f.fetch({ peer: row(3), [model]: row(rate, rate * 5, { litellm_provider, mode: "future-chat" }) }); await money(f, rate * 1.5, rate * 7.5, true); await f.restart(); }
  expect(JSON.stringify(f.logs)).not.toMatch(/private|claude|Anthropic/);
});
it("never guesses a provider for an unseen id", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), unknown: row(150, 750, { litellm_provider: "unknown" }) });
  expect(await f.price("unknown")).toMatchObject({ inputMicrosPerMTok: 100e6, outputMicrosPerMTok: 100e6, estimated: true });
});
it("provider fallback includes uncertain candidates, while a contributing model uses its own candidate", async () => {
  const f = fixture(); await f.fetch({ peer: row(30), [model]: row(15, 75, { mode: "future-chat" }) }); await money(f, 22.5, 112.5, true);
  expect(await f.price("new")).toMatchObject({ inputMicrosPerMTok: 45e6, outputMicrosPerMTok: 225e6, estimated: true });
  const g = fixture(); await g.fetch({ [model]: row(15, 75, { mode: "future-chat" }) });
  expect(await g.price("new")).toMatchObject({ inputMicrosPerMTok: 33.75e6, outputMicrosPerMTok: 168.75e6, estimated: true });
});
it("all effective decreases need equal consecutive candidates, including small clean drops and classification", async () => {
  const f = fixture(); await f.fetch({ [model]: row(15) });
  await f.fetch({ [model]: row(14) }); await money(f, 15, 75, true); await f.restart();
  await f.fetch({ [model]: row(14) }); await money(f, 14, 70, false);
  await f.fetch({ [model]: row(15, 75, { mode: "future-chat" }) }); await money(f, 22.5, 112.5, true);
  await f.fetch({ [model]: row(15) }); await money(f, 22.5, 112.5, true);
  await f.fetch({ [model]: row(15) }); await money(f, 15, 75, false);
});
it("source/alias disappearance and per-request flag removal use the same confirmation", async () => {
  const f = fixture("bedrock", alias); const low = { [alias]: bedrock(15), ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`peer-${i}`, bedrock(3)])) };
  await f.fetch({ ...low, "global.anthropic.example-v1:0": bedrock(150) }, offer(15));
  await f.fetch(low, offer(15)); await money(f, 150, 750, true);
  await f.fetch(low, offer(15)); await money(f, 15, 75, false);
  await f.fetch({ ...low, [alias]: bedrock(15, 75, { cost_per_request: 1 }) }, offer(15)); await money(f, 100, 112.5, true);
  await f.fetch(low, offer(15)); await money(f, 100, 112.5, true);
  await f.fetch(low, offer(15)); await money(f, 15, 75, false);
  await f.fetch(low, offer(150)); await money(f, 150, 750, false);
  await f.fetch(low, offer(3, 15, "Peer")); await money(f, 150, 750, true);
  await f.fetch(low, offer(3, 15, "Peer")); await money(f, 15, 75, false);
});
it("failed contributing sources break confirmation without lowering rates or fetchedAt", async () => {
  const f = fixture("bedrock", alias); const high = { [alias]: bedrock(150) }; const low = { [alias]: bedrock(15) };
  await f.fetch(high, offer(150)); await f.fetch(low, offer(15));
  const before = (await f.store.load())!.sources.aws;
  await f.fetch(low, "{"); expect((await f.store.load())!.sources.aws).toEqual(before); await money(f, 150, 750, true);
  await f.fetch(low, offer(15)); await money(f, 150, 750, true);
  await f.fetch(low, offer(15)); await money(f, 15, 75, false);
});
it("L1 reported cost cannot undercut known token usage; absent usage still retains the hold", async () => {
  // Exercise reported-cost arithmetic independently of the unqualified OpenRouter tariff gate.
  const f = fixture("anthropic", "route"); await f.fetch({ route: row(150, 750, { mode: "future-chat" }) });
  const price = await f.price(); const reportedCostMicros = parseReportedCost("openrouter", { cost: 0.000001 });
  if (reportedCostMicros === undefined) throw new Error("fixture");
  expect(settleAmount({ price, usage, reservationMicros: 1, reportedCostMicros })).toMatchObject({ actualMicros: 2700e6, estimated: true });
  expect(settleAmount({ price, usage, reservationMicros: 1, reportedCostMicros: 3000e6 })).toMatchObject({ actualMicros: 3000e6, estimated: false });
  expect(settleAmount({ price, reservationMicros: 999, reportedCostMicros: 1 })).toMatchObject({ actualMicros: 999 });
  const unknown = await resolvePrice({ priceFor: () => undefined }, "openrouter", "unseen");
  expect(settleAmount({ price: unknown, usage, reservationMicros: 999, reportedCostMicros: 1 })).toMatchObject({ actualMicros: 1, estimated: false });
});
it.each(["ordinary", "per-request", "unknown-provider"])("real gateway uses effective pricing: %s", async (kind) => {
  const f = fixture(); if (kind === "unknown-provider") await f.fetch({ peer: row(3), [model]: row(15, 75, { mode: "future-chat" }) });
  const rate = kind === "per-request" ? 2000 : kind === "unknown-provider" ? 150 : 15;
  await f.fetch({ peer: row(3), [model]: row(rate, rate * 5, kind === "per-request" ? { cost_per_request: 1 } : kind === "unknown-provider" ? { litellm_provider: null, mode: "future-chat" } : {}) });
  const gateway = setup({ prices: f.prices }); let held = 0;
  gateway.deps.transport = async () => { held = (await gateway.meter.read(scope))[0]!.reservedMicros; return { status: 200, body: answer() }; };
  expect((await call(gateway.deps)).status).toBe(200);
  const expected = rate * (kind === "ordinary" ? 38 : 57);
  expect((await gateway.meter.read(scope))[0]!.spentMicros).toBe(expected); expect(held).toBeGreaterThanOrEqual(expected);
});
it("AWS positive over-max base/tier rates retain an uncertain candidate and overflow review", async () => {
  const f = fixture("bedrock", alias); await f.fetch({ [alias]: bedrock(15) }, offer(2000, 3000)); await money(f, 3000, 4500, true);
  await f.fetch({ [alias]: bedrock(15) }, offer(1e16, 1e16)); expect(await f.price()).toMatchObject({ operatorReview: true, estimated: true });
});
it("clean and uncertain tier maxima survive alias pooling and reported-cost settlement", async () => {
  const f = fixture("bedrock", alias);
  await f.fetch({ [alias]: bedrock(15, 75, { cache_creation_input_token_cost: 40e-6 }), "global.anthropic.example-v1:0": bedrock(10, 20, { input_cost_per_token_above_200k_tokens: 60e-6, mode: "future-chat" }) }, offer(30, 100));
  const price = await f.price();
  expect(price).toMatchObject({ inputMicrosPerMTok: 30e6, outputMicrosPerMTok: 100e6, cacheWrite5mMicrosPerMTok: 40e6, longContext: [{ aboveTokens: 200000, inputMicrosPerMTok: 90e6 }] });
  expect(settleAmount({ price, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 1_000_000 }, reservationMicros: 1, reportedCostMicros: 1 }).actualMicros).toBe(180e6);
});
it("compatibility sources preserve per-request token minima and overflow settlement", async () => {
  const price = await resolvePrice({ priceFor: () => ({ inputMicrosPerMTok: 150e6, outputMicrosPerMTok: 750e6 }), fallbackFor: () => "per_request_price" }, "bedrock", "example");
  expect(price).toMatchObject({ inputMicrosPerMTok: 150e6, outputMicrosPerMTok: 750e6, estimated: false });
  const review = await resolvePrice({ priceFor: () => undefined, floorFor: () => { throw new Error("private-canary"); } }, "anthropic", model);
  expect(settleAmount({ price: review, usage, reservationMicros: 1, reportedCostMicros: 1 }).actualMicros).toBe(Number.MAX_SAFE_INTEGER);
});
it("persisted effective identities and unidentified rows validate before any read or write", async () => {
  const { validSnapshot } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const f = fixture(); await f.fetch({ [model]: row(15) }); await f.fetch({ [model]: row(14) });
  const snapshot = (await f.store.load())!; expect(validSnapshot(snapshot)).toBe(true);
  for (const invalid of [{ estimated: "private" }, { knownTokenPrice: false }, { sources: ["private"] }, { sources: [] }, { aliases: [] }, { aliases: [null] }, { aliases: ["bad\nvalue"] }, { kind: "private" }, { pendingLower: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, estimated: "private" } }, { origin: { source: "private", fetchedAt: 1 } }, { inputMicrosPerMTok: Infinity }, { tokenPrice: { inputMicrosPerMTok: 1, outputMicrosPerMTok: NaN } }, { model: " CLAUDE-SONNET-4-5 " }]) {
    const bad = structuredClone(snapshot); Object.assign(bad.effective![0]!, invalid); expect(validSnapshot(bad)).toBe(false);
  }
  for (const invalid of [null, {}, [{ model: "private", rates: { inputMicrosPerMTok: 1, outputMicrosPerMTok: "private" } }], [{ model: "private", kind: "private" }], [{ model: "private", perRequest: false }]]) {
    const bad = structuredClone(snapshot); Object.assign(bad.sources.litellm!, { unidentified: invalid }); expect(validSnapshot(bad)).toBe(false);
  }
  expect(JSON.stringify(f.logs)).not.toMatch(/private|claude/);
});
it("the complete pooled identity/alias bound resolves in bounded time and oldest alias history is evicted", async () => {
  const { effectivePrices } = await import("../../packages/model-gateway/src/price-sanity.js");
  const { validSnapshot } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const entry = { provider: "bedrock", model: "m", kind: "chat" as const, inputMicrosPerMTok: 1, outputMicrosPerMTok: 2, cacheReadMicrosPerMTok: 0, cacheWrite5mMicrosPerMTok: 2, cacheWrite1hMicrosPerMTok: 3, longContext: [{ aboveTokens: 128000, inputMicrosPerMTok: 3 }, { aboveTokens: 200000, inputMicrosPerMTok: 4 }] };
  const sourcesOf = (n: number) => {
    const entries = Array.from({ length: n }, (_, i) => ({ ...entry, model: `us.anthropic.model-${i}-v1:0` }));
    return { litellm: { fetchedAt: 1, count: entries.length, entries }, aws: { fetchedAt: 1, count: entries.length, entries: entries.map((e, i) => ({ ...e, model: `model-${i}` })) } };
  };
  // One full refresh at n entries per source: resolve, validate, and resolve again against the previous identities.
  const timed = (sources: ReturnType<typeof sourcesOf>) => {
    const start = performance.now();
    const first = effectivePrices(sources); const valid = validSnapshot({ version: 1, sources, effective: first }); const again = effectivePrices(sources, first);
    return { ms: performance.now() - start, first, valid, again };
  };
  // Bounded time as a SCALING check, not a wall-clock bound (a fixed 5 s flaked on loaded CI runners in 2 of 4 runs): 8x the
  // entries must take roughly 8x the time (measured 7.8-8.5x with the fastest-of-runs below). A resolver that scans what it has resolved per entry (quadratic)
  // measured 24-26x and fails the 16x ratio; a hang still fails the generous 30 s limit. Both runs share the runner's load.
  const small = sourcesOf(2_500); const sources = sourcesOf(20_000);
  timed(sourcesOf(500)); // warm-up: JIT and allocation, so the small run is not timed cold
  // The fastest of a few runs at each size: the runner's load only ever adds time, so the minimum is the steadiest estimate.
  const smallMs = Math.min(timed(small).ms, timed(small).ms, timed(small).ms);
  const big = timed(sources); const bigMs = Math.min(big.ms, timed(sources).ms); const effective = big.first;
  expect(effective).toHaveLength(20_000);
  expect(effective.every((e) => e.aliases.length === 2)).toBe(true); expect(big.valid).toBe(true);
  expect(big.again).toHaveLength(20_000);
  expect(big.ms).toBeLessThan(30_000);
  expect(bigMs / Math.max(smallMs, 1)).toBeLessThan(16);
  const next = structuredClone(sources); next.litellm.entries[0]!.model = "eu.anthropic.model-0-v1:0";
  const pruned = effectivePrices(next, effective);
  expect(pruned.flatMap((e) => e.aliases)).toHaveLength(40_000);
  expect(validSnapshot({ version: 2, sources: next, effective: pruned })).toBe(true);
  expect(validSnapshot({ version: 1, sources, effective: [...effective, ...effective] })).toBe(false);
}, 120_000);
it("successful complete disappearance confirms the provider fallback, while source failure never does", async () => {
  const f = fixture(); const peers = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`peer-${i}`, row(3)]));
  await f.fetch({ ...peers, [model]: row(15) }); await f.fetch(peers); await money(f, 15, 75, true);
  await f.fetch("{"); await f.fetch(peers); await money(f, 15, 75, true);
  await f.fetch(peers); await money(f, 4.5, 22.5, true);
});
