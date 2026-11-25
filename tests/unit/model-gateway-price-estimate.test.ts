import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { resolvePrice, UnknownPriceSource } from "../../packages/model-gateway/src/price.js";
beforeAll(denyNetwork);
it("uses separate cautious rates below flat ceiling, selected by provider and kind", async () => {
  const { InMemoryPriceSnapshotStore } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const { SnapshotPriceSource } = await import("../../packages/model-gateway/src/price-index.js");
  const entries = [
    { provider: "anthropic", model: "a", kind: "chat" as const, inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
    { provider: "anthropic", model: "b", kind: "chat" as const, inputMicrosPerMTok: 5_000_000, outputMicrosPerMTok: 10_000_000 },
    { provider: "anthropic", model: "e", kind: "embedding" as const, inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 },
    { provider: "openai", model: "x", kind: "chat" as const, inputMicrosPerMTok: 100_000_000, outputMicrosPerMTok: 200_000_000 },
  ];
  const store = new InMemoryPriceSnapshotStore(); await store.save({ version: 1, sources: { litellm: { fetchedAt: 1, count: entries.length, entries } } }, 0);
  const source = new SnapshotPriceSource(store); await source.reload();
  const price = await resolvePrice(source, "anthropic", "unknown");
  expect(price).toEqual({ priceVersion: 1, cacheReadMicrosPerMTok: 7_500_000, cacheWrite5mMicrosPerMTok: 15_000_000, cacheWrite1hMicrosPerMTok: 15_000_000, inputMicrosPerMTok: 7_500_000, outputMicrosPerMTok: 22_500_000, estimated: true });
  for (const entry of entries.filter((e) => e.provider === "anthropic" && e.kind === "chat")) { expect(price.inputMicrosPerMTok).toBeGreaterThanOrEqual(entry.inputMicrosPerMTok); expect(price.outputMicrosPerMTok).toBeGreaterThanOrEqual(entry.outputMicrosPerMTok); }
  expect(await resolvePrice(source, "anthropic", "unknown", undefined, undefined, "embedding")).toEqual({ priceVersion: 1, cacheReadMicrosPerMTok: 1_500_000, cacheWrite5mMicrosPerMTok: 3_000_000, cacheWrite1hMicrosPerMTok: 3_000_000, inputMicrosPerMTok: 1_500_000, outputMicrosPerMTok: 3_000_000, estimated: true });
  expect(await resolvePrice(source, "missing", "unknown")).toEqual({ ...await resolvePrice(UnknownPriceSource, "missing", "unknown"), priceVersion: 1 });
  expect(source.priceFor("anthropic", "unknown")).toBeUndefined();
  expect(source.priceFor("anthropic", "a")).toMatchObject({ inputMicrosPerMTok: 3_000_000 });
});
it("fallback across kinds, garbage cautious rates and the maximum remain positive and bounded", async () => {
  const { InMemoryPriceSnapshotStore } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const { SnapshotPriceSource } = await import("../../packages/model-gateway/src/price-index.js");
  const store = new InMemoryPriceSnapshotStore(); await store.save({ version: 1, sources: { litellm: { fetchedAt: 1, count: 1, entries: [{ provider: "anthropic", model: "e", kind: "embedding", inputMicrosPerMTok: 999_999_999, outputMicrosPerMTok: 1_000_000_000 }] } } }, 0);
  const prices = new SnapshotPriceSource(store); await prices.reload();
  expect(await resolvePrice(prices, "anthropic", "new")).toEqual({ priceVersion: 1, cacheReadMicrosPerMTok: 1_499_999_999, cacheWrite5mMicrosPerMTok: 2_999_999_998, cacheWrite1hMicrosPerMTok: 2_999_999_998, inputMicrosPerMTok: 1_499_999_999, outputMicrosPerMTok: 1_500_000_000, estimated: true });
  for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(await resolvePrice({ priceFor: () => undefined, cautiousFor: () => ({ inputMicrosPerMTok: value, outputMicrosPerMTok: value }) }, "anthropic", "new")).toEqual(await resolvePrice(UnknownPriceSource, "anthropic", "new"));
  expect((await resolvePrice({ priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, estimated: true }) }, "anthropic", "new")).estimated).toBe(true);
});
it("Bedrock aliases fold into the dearest known rates within one source", async () => {
  const { InMemoryPriceSnapshotStore } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const { SnapshotPriceSource } = await import("../../packages/model-gateway/src/price-index.js");
  const store = new InMemoryPriceSnapshotStore();
  const e = { provider: "bedrock", model: "us.anthropic.claude-test-v1:0", kind: "chat" as const, inputMicrosPerMTok: 30, outputMicrosPerMTok: 20 };
  await store.save({ version: 1, sources: { litellm: { fetchedAt: 1, count: 2, entries: [e, { ...e, model: "global.anthropic.claude-test-v1:0", inputMicrosPerMTok: 10, outputMicrosPerMTok: 40 }] } } }, 0);
  const prices = new SnapshotPriceSource(store); await prices.reload();
  expect(prices.priceFor("bedrock", e.model)).toMatchObject({ inputMicrosPerMTok: 30, outputMicrosPerMTok: 40 });
});
