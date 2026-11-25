import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { fetchLiteLLM } from "../../packages/model-gateway/src/price-sources.js";
import { InMemoryPriceSnapshotStore, validSnapshot } from "../../packages/model-gateway/src/price-snapshot.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { PriceRefresher } from "../../packages/model-gateway/src/price-refresh.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
import { MAX_ENTRIES_PER_SOURCE } from "../../packages/model-gateway/src/price-constants.js";
import { settleAmount } from "../../packages/model-gateway/src/reported-cost.js";
beforeAll(denyNetwork);
const row = { mode: "chat", litellm_provider: "anthropic", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
const transport = (data: unknown) => ({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify(data)) }) });
it("persists per-request fallback separately from fixed reports, survives reload and settles at flat rates", async () => {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store);
  const result = await fetchLiteLLM(transport({ ordinary: row, "private-request": { ...row, cost_per_request: 0.01 }, "private-no-base": { mode: "chat", litellm_provider: "anthropic", cost_per_request: 0.01 } }), { minModels: 1 });
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.floors).toEqual([expect.objectContaining({ provider: "anthropic", model: "private-request", perRequest: true, inputMicrosPerMTok: 1e6 })]);
  expect(result.fallbacks).toEqual([{ provider: "anthropic", model: "private-no-base", kind: "chat", reason: "per_request_price" }]);
  expect(JSON.stringify(result.report)).not.toMatch(/private|ordinary/);
  const refresher = new PriceRefresher({ store, prices, litellm: async () => result, aws: async () => ({ ok: false, reason: "invalid source" }) });
  await refresher.run(1);
  const reloaded = new SnapshotPriceSource(store); await reloaded.reload();
  for (const model of ["private-request", "private-no-base"]) {
    expect(reloaded.priceFor("anthropic", model)).toBeUndefined();
    const price = await resolvePrice(reloaded, "anthropic", model);
    expect(price).toMatchObject({ estimated: true, inputMicrosPerMTok: 100_000_000, outputMicrosPerMTok: 100_000_000 });
    expect(settleAmount({ price, usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }, reservationMicros: 2000 })).toMatchObject({ actualMicros: 1100, estimated: true });
  }
  expect(await resolvePrice(reloaded, "anthropic", "ordinary-unknown")).toMatchObject({ inputMicrosPerMTok: 2_250_000, outputMicrosPerMTok: 4_500_000 });
  expect((await store.load())?.sources.litellm?.fallbacks).toEqual(result.fallbacks);
  const saved = JSON.stringify(await store.load());
  await new PriceRefresher({ store, prices, litellm: async () => ({ ...result, fallbacks: [{ provider: "anthropic", model: "secret", reason: "unknown" }] } as unknown as typeof result), aws: async () => ({ ok: false, reason: "invalid source" }) }).run(2);
  expect(JSON.stringify(await store.load())).toBe(saved);
});
it("validates fallback fields, duplicate/colliding keys and one total entry bound without partial acceptance", async () => {
  const e = { provider: "anthropic", model: "ordinary", kind: "chat", inputMicrosPerMTok: 1, outputMicrosPerMTok: 2 };
  const fallback = { provider: "anthropic", model: "private", reason: "per_request_price" };
  const snapshot = (fallbacks: unknown, entries: unknown[] = [e]) => ({ version: 1, sources: { litellm: { fetchedAt: 1, count: entries.length, entries, fallbacks } } });
  for (const bad of [null, {}, [null], [{ ...fallback, reason: "unknown" }], [{ ...fallback, provider: "unknown" }], [{ ...fallback, model: 3 }], [{ ...fallback, model: "" }], [{ ...fallback, model: "x".repeat(513) }], [{ ...fallback, model: "bad\nvalue" }], [fallback, fallback], [{ ...fallback, model: "ordinary" }]]) expect(validSnapshot(snapshot(bad))).toBe(false);
  const full = Array.from({ length: MAX_ENTRIES_PER_SOURCE - 1 }, (_, i) => ({ ...fallback, model: `fallback-${i}` }));
  const started = performance.now(); expect(validSnapshot(snapshot(full))).toBe(true); expect(performance.now() - started).toBeLessThan(2000);
  expect(validSnapshot(snapshot([...full, fallback]))).toBe(false);
  const old = { version: 1, sources: { litellm: { fetchedAt: 1, count: 1, entries: [e] } } };
  const store = new InMemoryPriceSnapshotStore(); expect(await store.save(old as never, 0)).toBe(true); expect(JSON.stringify(await store.load())).toBe(JSON.stringify(old));
});
it("fallback is model scoped, normalized for Bedrock, blocks overrides and disappears only after a good replacement", async () => {
  const store = new InMemoryPriceSnapshotStore();
  const e = { provider: "bedrock", model: "other", kind: "chat" as const, inputMicrosPerMTok: 1, outputMicrosPerMTok: 2 };
  const source = { fetchedAt: 1, count: 1, entries: [e], fallbacks: [{ provider: "bedrock", model: "us.anthropic.private-v1:0", reason: "per_request_price" as const }] };
  await store.save({ version: 1, sources: { litellm: source, aws: { fetchedAt: 1, count: 1, entries: [{ ...e, model: "private" }] } } }, 0);
  const prices = new SnapshotPriceSource(store, { now: () => Date.UTC(2026, 0, 2), overrides: [{ provider: "bedrock", model: "global.anthropic.private-v1:0", kind: "chat", rates: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 2 }, reason: "verified gap", verifiedOn: "2026-01-01", expiresOn: "2026-02-01" }] }); await prices.reload();
  expect(prices.priceFor("bedrock", "global.anthropic.private-v1:0")).toBeUndefined();
  expect(await resolvePrice(prices, "bedrock", "global.anthropic.private-v1:0")).toMatchObject({ inputMicrosPerMTok: 100_000_000 });
  expect(await resolvePrice(prices, "anthropic", "private")).toMatchObject({ inputMicrosPerMTok: 100_000_000 });
  await store.save({ version: 2, sources: { litellm: { ...source, fallbacks: [], count: 2, entries: [e, { ...e, model: "us.anthropic.private-v1:0" }] } } }, 1);
  await prices.reload(); expect(await resolvePrice(prices, "bedrock", "global.anthropic.private-v1:0")).toMatchObject({ estimated: false, inputMicrosPerMTok: 1 });
});
it("model fallback policy failures use fixed flat rates and never echo a failure", async () => {
  for (const fallbackFor of [() => { throw new Error("secret"); }, () => "secret" as never]) {
    const price = await resolvePrice({ fallbackFor, priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 2 }), cautiousFor: () => ({ inputMicrosPerMTok: 2, outputMicrosPerMTok: 3 }) }, "anthropic", "model");
    expect(price).toEqual({ inputMicrosPerMTok: 100_000_000, outputMicrosPerMTok: 100_000_000, estimated: true }); expect(JSON.stringify(price)).not.toContain("secret");
  }
});
