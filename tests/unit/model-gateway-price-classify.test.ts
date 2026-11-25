import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
const base = { mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
it("ports every dearest tier and rounds upwards independently", async () => {
  const { ratesOf, rateMicros } = await import("../../packages/model-gateway/src/price-classify.js");
  const inputs = ["cache_creation_input_token_cost", "cache_creation_input_token_cost_above_1hr", "input_cost_per_token_above_200k_tokens", "cache_read_input_token_cost", "input_cost_per_token_batches", "input_cost_per_token_flex", "input_cost_per_token_cache_hit"];
  const outputs = ["output_cost_per_reasoning_token", "output_cost_per_token_above_200k_tokens", "output_cost_per_token_batches", "output_cost_per_token_flex"];
  for (const field of inputs) {
    const optional = field === "cache_creation_input_token_cost" ? "cacheWrite5mMicrosPerMTok" : field === "cache_creation_input_token_cost_above_1hr" ? "cacheWrite1hMicrosPerMTok" : field === "cache_read_input_token_cost" || field === "input_cost_per_token_cache_hit" ? "cacheReadMicrosPerMTok" : undefined;
    expect(ratesOf({ ...base, [field]: 10.0000001e-6 }, 0)).toEqual({ inputMicrosPerMTok: optional !== undefined || field.includes("above_200k") ? 1_000_000 : 10_000_001, outputMicrosPerMTok: 2_000_000,
      ...(optional === undefined ? {} : { [optional]: 10_000_001 }), ...(field.includes("above_200k") ? { longContext: [{ aboveTokens: 200000, inputMicrosPerMTok: 10_000_001 }] } : {}) });
  }
  for (const field of outputs) expect(ratesOf({ ...base, [field]: 20e-6 }, 0)).toEqual({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: field.includes("above_200k") ? 2_000_000 : 20_000_000, ...(field.includes("above_200k") ? { longContext: [{ aboveTokens: 200000, outputMicrosPerMTok: 20_000_000 }] } : {}) });
  expect(rateMicros(1.0000001e-6)).toBe(1_000_001);
  expect(rateMicros(1.0000000000000002e-6)).toBe(1_000_000);
});
it("unknown price fields stay unknown, metadata is harmless, invalid and unit prices have fixed reasons", async () => {
  const { ratesOf } = await import("../../packages/model-gateway/src/price-classify.js");
  expect(ratesOf({ ...base, harmless_metadata: "private-canary" }, 0)).toEqual({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 });
  for (const extra of [{ secret_price: 1 }, { cost_per_request: 0 }, { input_cost_per_token: 0 }, { output_cost_per_token: -1 }, { input_cost_per_token: 0.002 }, { mode: "image" }, { deprecation_date: "private-canary" }]) {
    const result = ratesOf({ ...base, ...extra }, 0); expect(typeof result).toBe("string"); expect(JSON.stringify(result)).not.toContain("private-canary");
  }
});
it("unserved cost fields name known gateway features", async () => {
  const { UNSERVED_FEATURE_COST_FIELDS } = await import("../../packages/model-gateway/src/price-classify.js");
  const { GATEWAY_FEATURE_NAMES } = await import("../../packages/model-gateway/src/guard.js");
  for (const [field, entry] of Object.entries(UNSERVED_FEATURE_COST_FIELDS)) {
    expect(GATEWAY_FEATURE_NAMES, `${field} must name a known gateway feature`).toContain(entry.feature);
    expect(entry.reason).toEqual(expect.any(String));
  }
});
it("unserved cost fields cannot exclude exposed gateway features", async () => {
  const { UNSERVED_FEATURE_COST_FIELDS } = await import("../../packages/model-gateway/src/price-classify.js");
  const { GATEWAY_EXPOSED_FEATURES } = await import("../../packages/model-gateway/src/guard.js");
  expect(GATEWAY_EXPOSED_FEATURES).toBeDefined();
  for (const [field, { feature }] of Object.entries(UNSERVED_FEATURE_COST_FIELDS)) {
    expect(GATEWAY_EXPOSED_FEATURES.has(feature), `${field} is listed as unserved but ${feature} is now exposed; remove the entry so the row is priced or marked uncertain`).toBe(false);
  }
});
// LiteLLM's real Bedrock rows for two offered models (raw.githubusercontent.com/BerriAI/litellm main, 2026-11-17). Before the fix
// their priority cache prices and flex cache prices were "unsupported price field", so the staging price fetch (2026-11-17T02:24Z)
// charged them the cautious estimate. Nova Pro and Kimi K3.1 carry the same fields.
const NOVA_2_LITE_US = { litellm_provider: "bedrock_converse", mode: "chat", cache_read_input_token_cost: 8.25e-8, cache_read_input_token_cost_flex: 4.125e-8, cache_read_input_token_cost_priority: 1.44375e-7, input_cost_per_token: 3.3e-7, input_cost_per_token_batches: 1.65e-7, input_cost_per_token_flex: 1.65e-7, input_cost_per_token_priority: 5.775e-7, output_cost_per_token: 2.75e-6, output_cost_per_token_batches: 1.375e-6, output_cost_per_token_flex: 1.375e-6, output_cost_per_token_priority: 4.8125e-6 };
const KIMI_K3_US = { litellm_provider: "bedrock_converse", mode: "chat", cache_creation_input_token_cost: 4.125e-6, cache_creation_input_token_cost_flex: 2.0625e-6, cache_creation_input_token_cost_priority: 7.21875e-6, cache_read_input_token_cost: 3.3e-7, cache_read_input_token_cost_flex: 1.65e-7, cache_read_input_token_cost_priority: 5.775e-7, input_cost_per_token: 3.3e-6, input_cost_per_token_flex: 1.65e-6, input_cost_per_token_priority: 5.775e-6, output_cost_per_token: 1.65e-5, output_cost_per_token_flex: 8.25e-6, output_cost_per_token_priority: 2.8875e-5 };
it("priority cache prices are an unserved feature; flex and batch cache prices are cheaper tiers of known keys (real Nova/Kimi rows)", async () => {
  const { ratesOf } = await import("../../packages/model-gateway/src/price-classify.js");
  expect(ratesOf(NOVA_2_LITE_US, 0)).toEqual({ inputMicrosPerMTok: 330_000, outputMicrosPerMTok: 2_750_000, cacheReadMicrosPerMTok: 82_500 });
  expect(ratesOf(KIMI_K3_US, 0)).toEqual({ inputMicrosPerMTok: 3_300_000, outputMicrosPerMTok: 16_500_000, cacheReadMicrosPerMTok: 330_000, cacheWrite5mMicrosPerMTok: 4_125_000 });
  // Each field alone: priority cache prices are left out; every flex/batch cache price is its key's rate (the dearest is kept).
  expect(ratesOf({ ...base, cache_read_input_token_cost_priority: 9e-6 }, 0)).toEqual({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 });
  expect(ratesOf({ ...base, cache_creation_input_token_cost_priority: 9e-6 }, 0)).toEqual({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 });
  for (const [field, key] of [["cache_read_input_token_cost_flex", "cacheReadMicrosPerMTok"], ["cache_read_input_token_cost_batches", "cacheReadMicrosPerMTok"], ["input_cost_per_token_cache_hit_flex", "cacheReadMicrosPerMTok"], ["cache_creation_input_token_cost_flex", "cacheWrite5mMicrosPerMTok"], ["cache_creation_input_token_cost_batches", "cacheWrite5mMicrosPerMTok"], ["cache_creation_input_token_cost_above_1hr_flex", "cacheWrite1hMicrosPerMTok"], ["cache_creation_input_token_cost_above_1hr_batches", "cacheWrite1hMicrosPerMTok"]] as const) {
    // Alone (no plain price for its key), a cheaper tier never stands in for the billed rate: the row stays unknown.
    expect([field, ratesOf({ ...base, [field]: 3e-6 }, 0)]).toEqual([field, "unsupported price field"]);
    const plain = key === "cacheReadMicrosPerMTok" ? "cache_read_input_token_cost" : key === "cacheWrite5mMicrosPerMTok" ? "cache_creation_input_token_cost" : "cache_creation_input_token_cost_above_1hr";
    expect([field, ratesOf({ ...base, [plain]: 2e-6, [field]: 1e-6 }, 0)]).toEqual([field, { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, [key]: 2_000_000 }]);
    // A dearer tier variant wins over the plain rate: the dearest is kept.
    expect([field, ratesOf({ ...base, [plain]: 2e-6, [field]: 3e-6 }, 0)]).toEqual([field, { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, [key]: 3_000_000 }]);
    // A plain price of another key or another band does not count.
    const other = key === "cacheReadMicrosPerMTok" ? "cache_creation_input_token_cost" : "cache_read_input_token_cost";
    expect([field, ratesOf({ ...base, [other]: 2e-6, [field]: 3e-6 }, 0)]).toEqual([field, "unsupported price field"]);
    expect([field, ratesOf({ ...base, [`${plain}_above_200k_tokens`]: 2e-6, [field]: 3e-6 }, 0)]).toEqual([field, "unsupported price field"]);
    // Another cheaper tier of the same key is not a plain price either.
    const sibling = field.endsWith("_flex") ? field.replace(/_flex$/u, "_batches") : field.replace(/_batches$/u, "_flex");
    expect([field, ratesOf({ ...base, [sibling]: 2e-6, [field]: 3e-6 }, 0)]).toEqual([field, "unsupported price field"]);
  }
  // Still unknown: other priority prices that are not reviewed, other suffixes, a priority long-context cache band.
  for (const field of ["cache_read_input_audio_token_cost_priority", "cache_read_input_token_cost_above_200k_tokens_priority", "cache_read_input_token_cost_spot", "cache_creation_input_token_cost_above_12hr_priority", "cache_read_input_token_cost_above_300k_tokens", "input_cost_per_token_above_1100k_tokens", "input_cost_per_token_priority_above_300k_tokens"]) {
    expect([field, ratesOf({ ...base, [field]: 1e-6 }, 0)]).toEqual([field, "unsupported price field"]);
  }
});
