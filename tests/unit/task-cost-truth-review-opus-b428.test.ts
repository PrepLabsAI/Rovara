// Opus money re-review of b428d30f5: the accepted run price takes the latest answer's expiry, and never more than that (no stale extension).
import { afterEach, expect, it, vi } from "vitest";
import { RunPriceSchema, type RunPrice } from "../../packages/contracts/src/index.js";
import { gatewayModelCost } from "../../packages/model-runtime/src/gateway-cost.js";
import { lazyModelProxy, modelAccessSource } from "../../packages/worker/src/model-access.js";

const NAME = "claude-haiku-4-5";
const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);
const runPriceAt = (expiresAt: number, input = 1.1): RunPrice => RunPriceSchema.parse({
  companyId: "org_aaaaaaaaaaaaaaaaaaaa", model: NAME, provider: "bedrock", sourceId: "src", connectionRevision: "r1", catalogModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0", snapshotHash: "b".repeat(64), snapshotVersion: 10, expiresAt,
  inputUsdPerMillion: input, outputUsdPerMillion: 5.5, cacheReadUsdPerMillion: 0.11, cacheWriteUsdPerMillion: 2.2,
});
afterEach(() => { vi.useRealTimers(); });
function proxyWith(prices: (() => RunPrice)[]) {
  let asked = 0;
  const transport = (async () => new Response(JSON.stringify({ baseUrl: "https://gateway.example", apiKey: `k${asked}`, expiresAt: T0 + 3_600_000, runPrice: prices[Math.min(asked++, prices.length - 1)]!() }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  return { proxy: lazyModelProxy({ baseUrl: "https://gateway.example", source: modelAccessSource({ controlPlaneUrl: "https://broker.example", capability: "cap", fetch: transport, requiredPriceModel: NAME }) }), asked: () => asked };
}
it("the stated expiry is exactly the latest gateway run price's (never later), and the ceiling's rates are kept", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
  const { proxy, asked } = proxyWith([() => runPriceAt(T0 + 300_000), () => runPriceAt(T0 + 600_000, 1.0)]);
  expect((await proxy.gatewayPricing()).runPrice?.expiresAt).toBe(T0 + 300_000);
  vi.setSystemTime(T0 + 301_000);
  const stated = await proxy.gatewayPricing();
  expect(asked()).toBe(2);
  expect(stated.runPrice?.expiresAt).toBe(T0 + 600_000);
  expect(stated.runPrice?.inputUsdPerMillion).toBe(1.1); // the dearer ceiling, never the cheaper renewal
  // At the gateway's own expiry the stated price is no longer usable by itself.
  expect(gatewayModelCost({ ...stated, now: T0 + 600_000 })).toBeUndefined();
});
it("a renewal that brings an already-expired (stale) run price is refused, never priced from the extended ceiling", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
  const { proxy } = proxyWith([() => runPriceAt(T0 + 300_000), () => runPriceAt(T0 + 300_500)]);
  await proxy.gatewayPricing();
  vi.setSystemTime(T0 + 301_000);
  await expect(proxy.gatewayPricing()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});
it("a renewal dearer than the ceiling is refused (the max() never pairs a newer expiry with rates the gateway no longer states)", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
  const { proxy } = proxyWith([() => runPriceAt(T0 + 300_000), () => runPriceAt(T0 + 600_000, 1.2)]);
  await proxy.gatewayPricing();
  vi.setSystemTime(T0 + 301_000);
  await expect(proxy.gatewayPricing()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});
