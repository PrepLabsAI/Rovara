import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
const now = Date.UTC(2026, 10, 14);
const base = { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
const transport = (value: unknown) => ({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify(value)) }) });
it("fetches LiteLLM using provider identity, kinds, maxima and fixed reports", async () => {
  const { fetchLiteLLM } = await import("../../packages/model-gateway/src/price-sources.js");
  const result = await fetchLiteLLM(transport({ "openai/not-openai": base, "gemini/m": { ...base, litellm_provider: "gemini", mode: "embedding" }, skipped: { ...base, private_price: "private-canary" }, image: { ...base, mode: "image" } }), { now, minModels: 1 });
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.entries).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "anthropic", model: "openai/not-openai", kind: "chat" }), expect.objectContaining({ provider: "gemini", model: "gemini/m", kind: "embedding" })]));
  expect(result.entries).toHaveLength(2); expect(result.report.skipped.length).toBe(2);
  expect(JSON.stringify(result.report)).not.toMatch(/private|not-openai|gemini/);
});
it("rejects missing, truncated, oversized, shallow floods and too-small sources with fixed reasons", async () => {
  const { fetchLiteLLM } = await import("../../packages/model-gateway/src/price-sources.js");
  for (const t of [transport({}), transport({ m: base }), { get: async () => ({ status: 500, body: Buffer.from("private-canary") }) }, { get: async () => ({ status: 200, body: Buffer.from('{"m":') }) }, { get: async () => ({ status: 200, body: Buffer.alloc(20_000_000) }) }]) {
    const r = await fetchLiteLLM(t, { now }); expect(r.ok).toBe(false); expect(JSON.stringify(r)).not.toContain("private-canary");
  }
});
it("parsers retain ordinary decreases for identity confirmation and keep shrink validation", async () => {
  const { fetchLiteLLM } = await import("../../packages/model-gateway/src/price-sources.js");
  const previous = [{ provider: "anthropic", model: "m", kind: "chat" as const, inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 }];
  const lower = await fetchLiteLLM(transport({ m: { ...base, input_cost_per_token: 0.5e-6 } }), { now, minModels: 1, previous });
  expect(lower.ok && lower.entries).toEqual([{ ...previous[0], inputMicrosPerMTok: 500_000 }]); expect(lower.ok && lower.report.ignoredLower).toBe(0);
  expect((await fetchLiteLLM(transport({ m: { ...base, input_cost_per_token: 200e-6 } }), { now, minModels: 1, previous })).ok).toBe(true);
  expect((await fetchLiteLLM(transport({ m: base }), { now, minModels: 1, previous: [...previous, { ...previous[0]!, model: "other" }] })).ok).toBe(false);
});
it("reported-cost and overrides obey precedence, expiry, runtime validity and rounded micros", async () => {
  const { parseReportedCost, settleAmount } = await import("../../packages/model-gateway/src/reported-cost.js");
  const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
  expect(parseReportedCost("openrouter", { cost: 0.00000101, total_tokens: 1 })).toBe(2);
  for (const cost of [undefined, 0, -1, NaN, Infinity, "0.1"]) expect(parseReportedCost("openrouter", { cost, total_tokens: 1 })).toBeUndefined();
  expect(parseReportedCost("anthropic", { cost: 0.1 })).toBeUndefined();
  const price = { inputMicrosPerMTok: 1, outputMicrosPerMTok: 2, estimated: true };
  expect(settleAmount({ usage, price, reservationMicros: 100, reportedCostMicros: 7 })).toMatchObject({ actualMicros: 7, estimated: false });
  expect(settleAmount({ usage, price, reservationMicros: 100 })).toMatchObject({ actualMicros: 1, estimated: true, usage });
  expect(settleAmount({ price, reservationMicros: 100 })).toEqual({ actualMicros: 100, estimated: true });
  expect(settleAmount({ usage: { ...usage, input: 0 }, price, reservationMicros: 100 })).toEqual({ actualMicros: 100, estimated: true });
  const { validOverrides } = await import("../../packages/model-gateway/src/price-overrides.js");
  const good = { provider: "anthropic", model: "gap", kind: "chat", rates: { inputMicrosPerMTok: 10, outputMicrosPerMTok: 20 }, reason: "verified gap", verifiedOn: "2026-11-01", expiresOn: "2026-12-01" };
  expect(validOverrides([good], now)).toHaveLength(1);
  for (const extra of [{ expiresOn: "2026-11-02" }, { expiresOn: "2027-12-01" }, { kind: "image" }, { rates: { inputMicrosPerMTok: 0 } }]) expect(validOverrides([{ ...good, ...extra }], now)).toEqual([]);
});
it("AWS fixture folds geo, global, long context and cache write maxima, with cross-source component maxima", async () => {
  const { readFile } = await import("node:fs/promises");
  const offer: unknown = JSON.parse(await readFile(new URL("../fixtures/model-gateway-prices/aws.json", import.meta.url), "utf8"));
  const { fetchAWS } = await import("../../packages/model-gateway/src/price-sources.js");
  const result = await fetchAWS(transport(offer), { now, minModels: 2, regions: ["us-west-2"] });
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.entries).toEqual(expect.arrayContaining([
    { provider: "bedrock", model: "claude-haiku-5-5", kind: "chat", inputMicrosPerMTok: 110000, outputMicrosPerMTok: 550000, longContext: [{ aboveTokens: 200000, cacheWrite5mMicrosPerMTok: 687500, outputMicrosPerMTok: 2750000 }] },
    { provider: "bedrock", model: "claude-fable-5-2", kind: "chat", inputMicrosPerMTok: 8800000, outputMicrosPerMTok: 44000000, cacheWrite1hMicrosPerMTok: 17600000 },
  ]));
  const { InMemoryPriceSnapshotStore } = await import("../../packages/model-gateway/src/price-snapshot.js");
  const { SnapshotPriceSource } = await import("../../packages/model-gateway/src/price-index.js");
  const store = new InMemoryPriceSnapshotStore(); await store.save({ version: 1, sources: { aws: { fetchedAt: now, count: 2, entries: result.entries }, litellm: { fetchedAt: now, count: 1, entries: [{ ...result.entries[0]!, model: "us.anthropic.claude-haiku-5-5-20261101-v1:0", inputMicrosPerMTok: 1000000 }] } } }, 0);
  const source = new SnapshotPriceSource(store); await source.reload();
  expect(source.priceFor("bedrock", "us.anthropic.claude-haiku-5-5-20261101-v1:0")?.inputMicrosPerMTok).toBe(1000000);
});
it("malformed AWS priced tiers cannot silently retain a cheaper base", async () => {
  const { readFile } = await import("node:fs/promises");
  const offer = JSON.parse(await readFile(new URL("../fixtures/model-gateway-prices/aws.json", import.meta.url), "utf8")) as { terms: { OnDemand: Record<string, Record<string, { priceDimensions: Record<string, { pricePerUnit: { USD: string } }> }>> } };
  offer.terms.OnDemand.SKU2!["SKU2.T"]!.priceDimensions["SKU2.T.D"]!.pricePerUnit.USD = "private-canary";
  const { fetchAWS } = await import("../../packages/model-gateway/src/price-sources.js");
  const result = await fetchAWS(transport(offer), { now, minModels: 1, regions: ["us-west-2"] });
  expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("private-canary");
});
it("shares AWS total bytes across regions and refuses invalid region config before transport", async () => {
  const { readFile } = await import("node:fs/promises");
  const body = await readFile(new URL("../fixtures/model-gateway-prices/aws.json", import.meta.url));
  const { fetchAWS } = await import("../../packages/model-gateway/src/price-sources.js");
  const fixture = { get: async () => ({ status: 200, body }) };
  expect((await fetchAWS(fixture, { now, minModels: 1, maxBytes: body.length * 2 - 1 })).ok).toBe(false);
  for (const regions of [[], ["private?leak"], Array.from({ length: 5 }, (_, i) => `us-east-${i + 1}`)]) {
    let called = false; expect((await fetchAWS({ get: async () => { called = true; return { status: 200, body }; } }, { regions })).ok).toBe(false); expect(called).toBe(false);
  }
});
it("rejects syntactically valid 20MB LiteLLM input before parsing", async () => {
  const { fetchLiteLLM } = await import("../../packages/model-gateway/src/price-sources.js");
  const body = Buffer.from(JSON.stringify({ m: { ...base, metadata: "x".repeat(20_000_000) } })); const start = performance.now();
  expect((await fetchLiteLLM({ get: async () => ({ status: 200, body }) }, { minModels: 1 })).ok).toBe(false); expect(performance.now() - start).toBeLessThan(5000);
});
it("reads the hand-made LiteLLM fixture and the explicitly assumed OpenRouter fixture offline", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fetchLiteLLM } = await import("../../packages/model-gateway/src/price-sources.js");
  const { parseReportedCost } = await import("../../packages/model-gateway/src/reported-cost.js");
  const body = await readFile(new URL("../fixtures/model-gateway-prices/litellm.json", import.meta.url));
  const result = await fetchLiteLLM({ get: async () => ({ status: 200, body }) }, { minModels: 1 });
  expect(result.ok && result.entries).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "anthropic", model: "tiered", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheWrite1hMicrosPerMTok: 7_000_000 })]));
  const router = JSON.parse(await readFile(new URL("../fixtures/model-gateway-prices/openrouter.json", import.meta.url), "utf8")) as { provenance: string; finalChunk: { usage: unknown } };
  expect(router.provenance).toBe("assumed, verify on staging"); expect(parseReportedCost("openrouter", router.finalChunk.usage)).toBe(13);
});
