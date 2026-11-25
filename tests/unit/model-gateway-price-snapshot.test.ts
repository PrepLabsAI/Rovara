import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
const entry = { provider: "anthropic", model: "a", kind: "chat" as const, inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 };
it("CAS and defensive copies preserve snapshots; age never drops or inflates a known price", async () => {
  const { InMemoryPriceSnapshotStore } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const { SnapshotPriceSource } = await import("../../packages/model-gateway/src/price-index.js");
  const { STALE_ALARM_MS } = await import("../../packages/model-gateway/src/price-constants.js");
  let now = 100;
  const store = new InMemoryPriceSnapshotStore(); const snapshot = { version: 1, sources: { litellm: { fetchedAt: now, count: 1, entries: [entry] } } };
  expect(await store.save(snapshot, 0)).toBe(true); expect(await store.save({ ...snapshot, sources: {} }, 0)).toBe(false);
  snapshot.sources.litellm.entries = [];
  const source = new SnapshotPriceSource(store, { now: () => now }); await source.reload(); const price = source.priceFor("anthropic", "a");
  now += STALE_ALARM_MS + 1;
  expect(source.health().litellm).toMatchObject({ fetchedAt: 100, count: 1, stale: true, ageMs: STALE_ALARM_MS + 1 }); expect(source.priceFor("anthropic", "a")).toEqual(price);
});
it("refresh failure keeps its source byte identical while the other source updates; single flight", async () => {
  const { InMemoryPriceSnapshotStore } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const { SnapshotPriceSource } = await import("../../packages/model-gateway/src/price-index.js");
  const { PriceRefresher } = await import("../../packages/model-gateway/src/price-refresh.js");
  const store = new InMemoryPriceSnapshotStore(); await store.save({ version: 1, sources: { litellm: { fetchedAt: 1, count: 1, entries: [entry] } } }, 0);
  const prices = new SnapshotPriceSource(store); await prices.reload();
  const before = JSON.stringify((await store.load())?.sources.litellm); let calls = 0; let corrections = 0;
  const refresher = new PriceRefresher({ store, prices, litellm: async () => { calls++; return { ok: false, reason: "invalid source" }; }, aws: async () => ({ ok: true, entries: [{ ...entry, provider: "bedrock" }], report: { skipped: [], ignoredLower: 0 } }), correctedKeys: async () => { corrections++; } });
  const first = refresher.run(2); expect(refresher.run(3)).toBe(first); await first;
  expect(calls).toBe(1); expect(corrections).toBe(1); expect(JSON.stringify((await store.load())?.sources.litellm)).toBe(before); expect((await store.load())?.sources.aws?.fetchedAt).toBe(2);
});
it("each source rejection preserves stored bytes and fetchedAt, including bounded large inputs", async () => {
  const { fetchLiteLLM } = await import("../../packages/model-gateway/src/price-sources.js");
  const { InMemoryPriceSnapshotStore } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const { SnapshotPriceSource } = await import("../../packages/model-gateway/src/price-index.js");
  const { PriceRefresher } = await import("../../packages/model-gateway/src/price-refresh.js");
  const base = { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
  let deep: unknown = 1; for (let i = 0; i < 18; i++) deep = { deeper: deep };
  const bodies = [Buffer.from("private-canary"), Buffer.from('{"m":'), Buffer.alloc(20_000_000), Buffer.from('{}'), Buffer.from(JSON.stringify({ m: { ...base, nested: deep } }))];
  for (const body of bodies) {
    const store = new InMemoryPriceSnapshotStore(); const snapshot = { version: 1, sources: { litellm: { fetchedAt: 1, count: 1, entries: [{ ...entry, model: "m" }] } } }; await store.save(snapshot, 0);
    const source = new SnapshotPriceSource(store); await source.reload(); const before = JSON.stringify(await store.load());
    const refresher = new PriceRefresher({ store, prices: source, litellm: (previous) => fetchLiteLLM({ get: async () => ({ status: 200, body }) }, { now: 2, minModels: 1, previous }), aws: async () => ({ ok: false, reason: "private-canary" }) });
    expect((await refresher.run(2)).ok).toBe(false); expect(JSON.stringify(await store.load())).toBe(before); expect(JSON.stringify(source.health())).not.toContain("private-canary");
  }
});
it("source entry/node maximum is enforced in bounded time without model-pattern products", async () => {
  const { fetchLiteLLM } = await import("../../packages/model-gateway/src/price-sources.js");
  const base = { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
  const map = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`model-${i}`, base]));
  const start = performance.now(); const good = await fetchLiteLLM({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify(map)) }) });
  expect(good.ok && good.entries.length).toBe(20_000); expect(performance.now() - start).toBeLessThan(5000);
  const flood = Object.fromEntries(Array.from({ length: 1_000_001 }, (_, i) => [String(i), 0]));
  const began = performance.now(); const bad = await fetchLiteLLM({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ m: { ...base, metadata: flood } })) }) }, { minModels: 1 });
  expect(bad.ok).toBe(false); expect(performance.now() - began).toBeLessThan(5000);
  // Exactly one million walker nodes: root + model + four scalar fields + metadata + 999,993 leaves.
  for (let i = 999_993; i <= 1_000_000; i++) delete flood[String(i)];
  const atLimit = await fetchLiteLLM({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ m: { ...base, metadata: flood } })) }) }, { minModels: 1 });
  expect(atLimit.ok).toBe(true);
}, 10_000);
it("source prices beat overrides, expired overrides disappear on reads", async () => {
  const { InMemoryPriceSnapshotStore } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const { SnapshotPriceSource } = await import("../../packages/model-gateway/src/price-index.js");
  const store = new InMemoryPriceSnapshotStore(); await store.save({ version: 1, sources: { litellm: { fetchedAt: 1, count: 1, entries: [entry] } } }, 0);
  let clock = Date.UTC(2026, 10, 14);
  const override = { provider: "anthropic", model: "gap", kind: "chat", rates: { inputMicrosPerMTok: 99, outputMicrosPerMTok: 99 }, reason: "verified gap", verifiedOn: "2026-11-01", expiresOn: "2026-11-15" };
  const prices = new SnapshotPriceSource(store, { now: () => clock, overrides: [override, { ...override, model: "a" }] }); await prices.reload();
  expect(prices.priceFor("anthropic", "a")?.inputMicrosPerMTok).toBe(1_000_000); expect(prices.health().redundantOverrides).toBe(1); expect(prices.priceFor("anthropic", "gap")?.inputMicrosPerMTok).toBe(99);
  clock = Date.UTC(2026, 10, 15); expect(prices.priceFor("anthropic", "gap")).toBeUndefined();
});
it("keeps one snapshot hash with the built price snapshot", async () => {
  const { createHash } = await import("node:crypto");
  const { InMemoryPriceSnapshotStore } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const { SnapshotPriceSource } = await import("../../packages/model-gateway/src/price-index.js");
  const now = Date.UTC(2026, 10, 18);
  const snapshot = { version: 1, sources: { litellm: { fetchedAt: now - 1000, count: 1, entries: [entry] } } };
  const store = new InMemoryPriceSnapshotStore(); await store.save(snapshot, 0);
  const prices = new SnapshotPriceSource(store, { now: () => now }); await prices.reload();
  const expected = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  expect(prices.quoteBasis("anthropic", "a")?.hash).toBe(expected);
  expect(prices.quoteBasis("anthropic", "a")?.hash).toBe(expected);
});
