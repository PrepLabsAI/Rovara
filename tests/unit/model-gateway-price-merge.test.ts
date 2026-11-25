import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
import { settleAmount, validUsage } from "../../packages/model-gateway/src/reported-cost.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { caps, scope, now } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
it("preserves R3a cache-write overrides and rejects invalid optional cache rates", async () => {
  const price = await resolvePrice({ priceFor: () => ({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 1_000_000, cacheWriteMicrosPerMTok: 3_000_000 }) }, "anthropic", "m");
  expect(price.cacheWriteMicrosPerMTok).toBe(3_000_000);
  expect(settleAmount({ price, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 4, cacheWrite5m: 4, cacheWrite1h: 0 }, reservationMicros: 100 })).toEqual({ actualMicros: 12, estimated: false });
  for (const cacheWriteMicrosPerMTok of [NaN, Infinity, 0, -1, 1.5, 1_000_000_001, "secret"]) expect((await resolvePrice({ priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, cacheWriteMicrosPerMTok }) as never }, "anthropic", "m")).estimated).toBe(true);
});
it("optional cache tier counts validate before settlement and never enter a malformed correction ledger", async () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 4 };
  expect(validUsage(usage)).toBe(true); expect(validUsage({ ...usage, cacheWrite5m: 3, cacheWrite1h: 1 })).toBe(true);
  const meter = new InMemoryMeter(() => now); const r = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!r.ok) throw new Error("fixture");
  for (const bad of [{ cacheWrite5m: -1, cacheWrite1h: 5 }, { cacheWrite5m: 1.5, cacheWrite1h: 2.5 }, { cacheWrite5m: NaN, cacheWrite1h: 4 }, { cacheWrite5m: 5, cacheWrite1h: 0 }, { cacheWrite5m: 4 }, { cacheWrite1h: 4 }, { cacheWrite5m: "secret", cacheWrite1h: 0 }]) {
    const malformed = { ...usage, ...bad }; expect(validUsage(malformed)).toBe(false);
    expect(settleAmount({ price: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, estimated: true }, usage: malformed as never, reservationMicros: 100 })).toEqual({ actualMicros: 100, estimated: true });
    await expect(meter.settle(r.reservation, 80, { provider: "anthropic", model: "m", kind: "chat", usage: malformed as never, settledAt: now })).rejects.toThrow(/^settlement unavailable$/);
  }
  expect((await meter.read(scope))[0]).toMatchObject({ spentMicros: 0, reservedMicros: 100 }); expect(await meter.pendingKeys(1)).toEqual({ items: [] });
});
