import { expect } from "vitest";
import { fetchAWS, fetchLiteLLM } from "../../packages/model-gateway/src/price-sources.js";
import { InMemoryPriceSnapshotStore } from "../../packages/model-gateway/src/price-snapshot.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { PriceRefresher } from "../../packages/model-gateway/src/price-refresh.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
import { estimateCall } from "../../packages/model-gateway/src/estimate.js";
import { settleAmount } from "../../packages/model-gateway/src/reported-cost.js";
import { now } from "./model-gateway-fixture.js";
export const model = "claude-sonnet-4-5";
export const alias = "us.anthropic.example-v1:0";
export const row = (input = 15, output = input * 5, extra: Record<string, unknown> = {}) => ({ litellm_provider: "anthropic", mode: "chat", input_cost_per_token: input / 1e6, output_cost_per_token: output / 1e6, ...extra });
export const bedrock = (input = 15, output = input * 5, extra: Record<string, unknown> = {}) => row(input, output, { litellm_provider: "bedrock", ...extra });
export const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
const transport = (body: unknown) => ({ get: async () => ({ status: 200, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) }) });
export function offer(input: number, output = input * 5, name = "Example") {
  return {
    products: { I: { attributes: { model: name, usagetype: "USW2_input_tokens_standard-Units" } }, O: { attributes: { model: name, usagetype: "USW2_output_tokens_standard-Units" } } },
    terms: { OnDemand: { I: { T: { priceDimensions: { D: { unit: "1M tokens", pricePerUnit: { USD: String(input) } } } } }, O: { T: { priceDimensions: { D: { unit: "1M tokens", pricePerUnit: { USD: String(output) } } } } } } },
  };
}
export function fixture(provider = "anthropic", name = model) {
  const store = new InMemoryPriceSnapshotStore(); let tick = now;
  let prices = new SnapshotPriceSource(store, { now: () => now, overrides: [] });
  const logs: unknown[] = [];
  return {
    store, logs, get prices() { return prices; },
    async fetch(ll: unknown, aws?: unknown) {
      return new PriceRefresher({ store, prices, log: (line) => logs.push(line),
        litellm: async (previous) => { const r = await fetchLiteLLM(transport(ll), { previous, now, minModels: 1 }); expect(r.ok).toBe(typeof ll !== "string"); return r; },
        aws: async (previous) => { if (aws === undefined) return { ok: false, reason: "private-source" }; const r = await fetchAWS(transport(aws), { previous, now, minModels: 1, regions: ["us-west-2"] }); expect(r.ok).toBe(typeof aws !== "string"); return r; },
      }).run(tick++);
    },
    async restart() { prices = new SnapshotPriceSource(store, { now: () => now, overrides: [] }); await prices.reload(); },
    price(query = name) { return resolvePrice(prices, provider, query); },
  };
}
export async function money(f: ReturnType<typeof fixture>, input: number, output = input * 5, estimated?: boolean) {
  const p = await f.price();
  expect(p.inputMicrosPerMTok).toBe(input * 1e6); expect(p.outputMicrosPerMTok).toBe(output * 1e6);
  if (estimated !== undefined) expect(p.estimated).toBe(estimated);
  const longFactor = p.knownTokenPrice ? 2 : 1; // Own missing long tiers use 2x base; wholly unknown provider fallback is unchanged.
  expect(estimateCall(1_000_000, 1_000_000, p)).toBe((input * 2 + output) * longFactor * 1e6);
  expect(settleAmount({ price: p, usage, reservationMicros: 1 }).actualMicros).toBe((input + output) * longFactor * 1e6);
  return p;
}
