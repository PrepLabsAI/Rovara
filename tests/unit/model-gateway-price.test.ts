import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, expect, it } from "vitest";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
it.each([undefined, NaN, 0, -1, 1.5, 1_000_000_001])("uses the cautious estimate for unknown or invalid price %s", async (v) => {
  const price = await resolvePrice({ priceFor: () => v === undefined ? undefined : { inputMicrosPerMTok: v, outputMicrosPerMTok: v } }, "anthropic", "model");
  expect(price).toEqual({ inputMicrosPerMTok: 100_000_000, outputMicrosPerMTok: 100_000_000, estimated: true });
});
it("throwing prices are unknown; hint only raises the ceiling; known price is smaller", async () => {
  expect((await resolvePrice({ priceFor: () => { throw new Error("key"); } }, "anthropic", "model")).estimated).toBe(true);
  expect((await resolvePrice({ priceFor: () => undefined, dearestKnown: () => 200_000_000 }, "anthropic", "model")).inputMicrosPerMTok).toBe(300_000_000);
  expect((await resolvePrice({ priceFor: () => ({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 2 }) }, "anthropic", "model")).estimated).toBe(false);
});
