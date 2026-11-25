import { beforeAll as beforeNetworkTests } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeNetworkTests(denyNetwork);
import { expect, it } from "vitest";
import { estimateCall, usageCost } from "../../packages/model-gateway/src/estimate.js";
const price = { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, estimated: false };
it("rounds up whole micros, uses the applied output limit and the entire byte input", () => {
  expect(estimateCall(1, 128_000, price)).toBe(1);
  expect(estimateCall(3_000_000, 1, price)).toBe(7);
  expect(estimateCall(0, 128_000, { ...price, outputMicrosPerMTok: 1_000_000 })).toBe(128_000);
  expect(usageCost({ input: 2, output: 5, cacheRead: 3, cacheWrite: 4 }, { ...price, inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 })).toBe(23);
});

import { settleChargeAmount } from "../../packages/model-gateway/src/reported-cost.js";
import { UsageCollector } from "../../packages/model-gateway/src/usage.js";
it("exact price without usage retains this call's reservation provisionally", () => {
  expect(settleChargeAmount({ price, reservationMicros: 87 })).toMatchObject({ actualMicros: 87, estimated: true, status: "awaiting_usage", reason: "missing_usage" });
});
it("every truncated stream and a stream with no final usage frame remains awaiting usage", () => {
  const frames = ['data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n', 'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n', 'data: {"type":"message_stop"}\n\n'].join("");
  for (let i = 0; i < frames.length; i++) {
    const collector = new UsageCollector(); collector.push(Buffer.from(frames.slice(0, i)));
    const usage = collector.finish();
    expect(settleChargeAmount({ price, ...(usage === undefined ? {} : { usage }), reservationMicros: 87 }), String(i)).toMatchObject({ actualMicros: 87, estimated: true, status: "awaiting_usage" });
  }
});
it("authoritative provider money without tokens can finalize external value", () => {
  expect(settleChargeAmount({ price, reservationMicros: 87, reportedCostMicros: 30 })).toMatchObject({ actualMicros: 30, status: "final", reason: "reported_cost", estimated: false });
});
