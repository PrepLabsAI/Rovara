// BEDROCK-PRICE-ROWS (2026-11-16): every Bedrock id Rovara's AI offers must meet its AWS price list row, so a call is charged the
// model's real price, not the cautious estimate (1.5x the dearest known rate). The price fetcher folds an AWS name to lower case with
// dashes (fetchAWS); the price index folds the called id (normalizeBedrockModel). Both must meet, and no two offered models may meet
// on one identity.
//
// AWS price list rows: the REAL rows of the first staging price fetch (2026-11-17T02:24Z, PRICES snapshot slot 0, read-only via
// staging-aws.sh; release-artifacts/cloud-gateway-20261117b/price-rows-20261117T022459Z). fetchAWS read AWS's public
// AmazonBedrockFoundationModels offers (us-east-1, us-west-2) and kept 24 priced names, stored already folded (below). Only four
// offered models are among them; the other 19 have NO row in that offer and are priced from LiteLLM's Bedrock rows (or, without
// a clean LiteLLM row, charged the cautious estimate). Display names: tests/fixtures/model-gateway-prices/aws.json records
// "Claude Haiku 5.5" and "Claude Fable 5.2".
import { beforeAll, describe, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { ROVARA_AI_US_CONVERSE_MODELS, ROVARA_AI_US_MODELS, parseRovaraAiModels } from "../../packages/model-gateway/src/agent-ai.js";
import { identityKey, normalizeBedrockModel, normalizedModel } from "../../packages/model-gateway/src/price-identity.js";
import { fetchAWS, fetchLiteLLM } from "../../packages/model-gateway/src/price-sources.js";
import { InMemoryPriceSnapshotStore } from "../../packages/model-gateway/src/price-snapshot.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { PriceRefresher } from "../../packages/model-gateway/src/price-refresh.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
beforeAll(denyNetwork);

const now = Date.UTC(2026, 10, 16);
/** Every name in the AWS offer as fetched on staging 2026-11-17 (folded by fetchAWS). */
const FETCHED_AWS_ROWS = ["openai-gpt-5-4", "openai-gpt-6-1-sol", "claude-mythos-5", "claude-opus-4-8", "openai-gpt-6-luna", "claude-opus-5",
  "claude-fable-5-1", "claude-fable-5-2", "claude-sonnet-5", "openai-gpt-5-5", "claude-opus-5-5", "claude-mythos-preview", "openai-gpt-6-astra",
  "claude-opus-4-7", "claude-haiku-5-5", "openai-gpt-5-6-terra", "claude-sonnet-5-5", "openai-gpt-6-sol", "claude-mythos-5-2", "claude-fable-5",
  "openai-gpt-5-6-luna", "openai-gpt-5-6-sol", "openai-gpt-6-1-terra", "claude-mythos-5-1"] as const;
/** offered Bedrock id -> [its AWS row (a FETCHED_AWS_ROWS name), or null when the offer has none; the identity the id folds to]. */
const TABLE: Record<string, [string | null, string]> = {
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": [null, "claude-haiku-4-5"],
  "us.anthropic.claude-haiku-5-5": ["claude-haiku-5-5", "claude-haiku-5-5"],
  "us.anthropic.claude-sonnet-5-5": ["claude-sonnet-5-5", "claude-sonnet-5-5"],
  "us.anthropic.claude-opus-5-5": ["claude-opus-5-5", "claude-opus-5-5"],
  "us.anthropic.claude-fable-5-2": ["claude-fable-5-2", "claude-fable-5-2"],
  "qwen.qwen3-coder-480b-a35b-v1:0": [null, "qwen3-coder-480b-a35b"],
  "qwen.qwen3-coder-30b-a3b-v1:0": [null, "qwen3-coder-30b-a3b"],
  "qwen.qwen3-235b-a22b-2507-v1:0": [null, "qwen3-235b-a22b-2507"],
  "mistral.devstral-2-123b": [null, "devstral-2-123b"],
  "mistral.mistral-large-3-675b-instruct": [null, "mistral-large-3-675b-instruct"],
  "deepseek.v3-v1:0": [null, "deepseek-v3-1"],
  "moonshotai.kimi-k2.5": [null, "kimi-k2-5"],
  "zai.glm-5": [null, "glm-5"],
  "zai.glm-4.7": [null, "glm-4-7"],
  "us.amazon.nova-2-lite-v1:0": [null, "nova-2-lite"],
  "openai.gpt-oss-120b-1:0": [null, "gpt-oss-120b"],
  "openai.gpt-oss-20b-1:0": [null, "gpt-oss-20b"],
  "us.amazon.nova-pro-v1:0": [null, "nova-pro"],
  "moonshot.kimi-k2-thinking": [null, "kimi-k2-thinking"],
  "minimax.minimax-m2.5": [null, "minimax-m2-5"],
  "us.moonshotai.kimi-k3": [null, "kimi-k3"],
  "us.moonshotai.kimi-k3.1": [null, "kimi-k3-1"],
};
const offered = [...new Set([...parseRovaraAiModels(ROVARA_AI_US_MODELS, "us-west-2").values(), ...parseRovaraAiModels(ROVARA_AI_US_CONVERSE_MODELS, "us-west-2").values()])];
/** fetchAWS's own folding of an AWS "model" attribute (price-sources.ts). */
const awsFold = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

describe("every offered Bedrock id meets its AWS price list row", () => {
  it("the table covers exactly the offered ids (a new offered model needs a row here)", () => {
    expect(new Set(Object.keys(TABLE))).toEqual(new Set(offered));
  });
  for (const [id, [aws, identity]] of Object.entries(TABLE)) {
    it(`${id} folds to ${identity}, and meets ${aws === null ? "no fetched AWS row" : `the fetched AWS row ${aws}`}`, () => {
      expect(normalizeBedrockModel(id)).toBe(identity);
      // Its own fetched row and no other: an id never takes a neighbour's AWS price.
      const meets = FETCHED_AWS_ROWS.filter((row) => identityKey("bedrock", row) === identityKey("bedrock", id));
      expect([id, meets]).toEqual([id, aws === null ? [] : [aws]]);
      if (aws !== null) expect(normalizedModel("bedrock", awsFold(aws))).toBe(identity);
      // LiteLLM's Bedrock keys (bare, bedrock/, bedrock_converse/, a Region group) fold the same way.
      for (const key of [id, `bedrock/${id}`, `bedrock_converse/${id}`]) expect(normalizeBedrockModel(key)).toBe(identity);
    });
  }
  it("the fetched AWS rows are distinct identities that fold to themselves; the recorded display names meet them", () => {
    expect(new Set(FETCHED_AWS_ROWS.map((row) => identityKey("bedrock", row))).size).toBe(FETCHED_AWS_ROWS.length);
    for (const row of FETCHED_AWS_ROWS) expect([row, normalizedModel("bedrock", row)]).toEqual([row, row]);
    for (const [name, row] of [["Claude Haiku 5.5", "claude-haiku-5-5"], ["Claude Fable 5.2", "claude-fable-5-2"]]) expect(awsFold(name!)).toBe(row);
    // Neighbours in the fetched offer stay apart from the offered ids: Haiku 4.5 is not Haiku 5.5, Sonnet 5.5 is not Sonnet 5.
    expect(identityKey("bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0")).not.toBe(identityKey("bedrock", "claude-haiku-5-5"));
    expect(identityKey("bedrock", "us.anthropic.claude-sonnet-5-5")).not.toBe(identityKey("bedrock", "claude-sonnet-5"));
    expect(identityKey("bedrock", "us.anthropic.claude-fable-5-2")).not.toBe(identityKey("bedrock", "claude-fable-5"));
  });
  it("the dotted names meet whatever punctuation the price list uses", () => {
    for (const [id, names] of [["moonshotai.kimi-k2.5", ["Kimi K2.5", "Kimi-K2.5", "kimi k2 5", "Kimi K2_5"]], ["zai.glm-4.7", ["GLM 4.7", "GLM-4.7"]], ["minimax.minimax-m2.5", ["MiniMax M2.5", "MiniMax-M2.5"]], ["us.moonshotai.kimi-k3.1", ["Kimi K3.1", "Kimi-K3.1"]]] as const) {
      for (const name of names) expect([id, name, identityKey("bedrock", awsFold(name))]).toEqual([id, name, identityKey("bedrock", id)]);
    }
  });
  it("no two offered models share an identity", () => {
    const identities = offered.map((id) => identityKey("bedrock", id));
    expect(new Set(identities).size).toBe(offered.length);
    // Neighbours that differ only after a dot or a number stay apart.
    for (const [a, b] of [["us.moonshotai.kimi-k3", "us.moonshotai.kimi-k3.1"], ["zai.glm-5", "zai.glm-4.7"], ["openai.gpt-oss-120b-1:0", "openai.gpt-oss-20b-1:0"], ["moonshotai.kimi-k2.5", "moonshot.kimi-k2-thinking"], ["deepseek.v3-v1:0", "deepseek.v3.2"], ["us.amazon.nova-2-lite-v1:0", "us.amazon.nova-pro-v1:0"]]) {
      expect(normalizeBedrockModel(a!)).not.toBe(normalizeBedrockModel(b!));
    }
  });
  it("an identity folds to itself (a stored snapshot stays valid), and is never empty", () => {
    for (const id of [...offered, ...FETCHED_AWS_ROWS, "deepseek.v3.2", "us.deepseek.r1-v1:0", "foo_v3", "x-20240101-v1-v2", "...", "-", "us.", "a/b.c", "bedrock/", "-v1", "@1", "x//-v1", "/ -v1", ":0//--"]) {
      const once = normalizeBedrockModel(id);
      expect([id, normalizeBedrockModel(once)]).toEqual([id, once]);
      expect(once.length).toBeGreaterThan(0);
    }
  });
  it("reviewed ids not offered today meet their (assumed) AWS names; another version of them is not taken for them", () => {
    for (const [id, aws] of [["deepseek.v3.2", "DeepSeek V3.2"], ["us.deepseek.r1-v1:0", "DeepSeek R1"], ["deepseek.r1-v1:0", "DeepSeek-R1"]] as const) {
      expect([id, identityKey("bedrock", id)]).toEqual([id, identityKey("bedrock", awsFold(aws))]);
    }
    // Exact ids only: a later version of an aliased id is not priced as the aliased model (it gets the cautious price).
    for (const id of ["deepseek.v3-v2:0", "openai.gpt-oss-120b-2:0", "zai.glm-5:0", "zai.glm-5-1:0"]) {
      expect(Object.values(TABLE).map(([, identity]) => identity)).not.toContain(normalizeBedrockModel(id));
    }
  });
  it("every Region group and LiteLLM's punctuation fold away", () => {
    for (const group of ["us", "eu", "apac", "global", "jp", "au", "in", "ca", "us-gov"]) {
      expect([group, normalizeBedrockModel(`${group}.moonshotai.kimi-k2.5`)]).toEqual([group, "kimi-k2-5"]);
      expect([group, normalizeBedrockModel(`${group}.openai.gpt-oss-20b-1:0`)]).toEqual([group, "gpt-oss-20b"]);
    }
    expect(normalizeBedrockModel("  bedrock/MoonshotAI.Kimi-K2.5  ")).toBe("kimi-k2-5");
    expect(normalizeBedrockModel("bedrock/_kimi-k2.5_")).toBe("kimi-k2-5");
    // A version that only shows after folding (`_v3`) folds away too, so the identity folds to itself.
    expect(normalizeBedrockModel("foo_v3")).toBe("foo");
    expect(normalizedModel("bedrock", awsFold("(Kimi K2.5)"))).toBe("kimi-k2-5");
  });
  it("folding is idempotent for any text (fuzzed, fixed seed), so no LiteLLM key can make a snapshot invalid", () => {
    const alphabet = "av1-./: _@us9bk"; let seed = 1;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let n = 0; n < 20_000; n++) {
      const text = Array.from({ length: 1 + Math.floor(random() * 14) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
      const once = normalizeBedrockModel(text);
      expect([text, normalizeBedrockModel(once)]).toEqual([text, once]);
    }
  });
  it("a version dot is never taken for a provider (a bare dotted name keeps its whole name)", () => {
    expect(normalizeBedrockModel("kimi-k2.5")).toBe("kimi-k2-5");
    expect(normalizeBedrockModel("glm-4.5")).toBe("glm-4-5");
    expect(normalizeBedrockModel("us.kimi-k3.1")).toBe("kimi-k3-1");
    expect(normalizeBedrockModel("kimi-k2.5")).not.toBe(normalizeBedrockModel("glm-4.5"));
  });
});

const transport = (body: unknown) => ({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify(body)) }) });
/** An AWS offer with one input and one output product per name, each model at its own price (dollars per 1M tokens). */
function offer(models: ReadonlyArray<readonly [string, number]>) {
  const products: Record<string, unknown> = {}; const terms: Record<string, unknown> = {};
  models.forEach(([name, input], i) => {
    for (const [kind, usd] of [["input", input], ["output", input * 4]] as const) {
      const sku = `SKU${i}${kind}`;
      products[sku] = { attributes: { model: name, usagetype: `USW2-MP:USW2_${kind}_tokens_standard-Units` } };
      terms[sku] = { T: { priceDimensions: { D: { unit: "1M tokens", pricePerUnit: { USD: String(usd) } } } } };
    }
  });
  return { products, terms: { OnDemand: terms } };
}
async function refreshed(litellm: Record<string, unknown>, aws: ReadonlyArray<readonly [string, number]>) {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store, { now: () => now, overrides: [] });
  const r = await new PriceRefresher({ store, prices,
    litellm: (previous) => fetchLiteLLM(transport(litellm), { previous, now, minModels: 1 }),
    aws: (previous) => fetchAWS(transport(offer(aws)), { previous, now, minModels: 1, regions: ["us-west-2"] }),
  }).run(now);
  expect(r.ok).toBe(true);
  return prices;
}
const unrelated = { "gpt-x": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } };

describe("the price each offered id is charged, through the price fetch and the index", () => {
  it("every offered id would be charged its own AWS row's price, not an estimate (a row named as the identity, for each id)", async () => {
    const rows = Object.values(TABLE).map(([, identity], i) => [identity, i + 1] as const);
    const prices = await refreshed(unrelated, rows);
    for (const [i, id] of Object.keys(TABLE).entries()) {
      const p = await resolvePrice(prices, "bedrock", id);
      expect([id, p.estimated, p.inputMicrosPerMTok, p.outputMicrosPerMTok]).toEqual([id, false, (i + 1) * 1e6, (i + 1) * 4e6]);
    }
  });
  it("a LiteLLM Bedrock row for a dotted id pools with its AWS row (the dearer rate holds)", async () => {
    const prices = await refreshed({ ...unrelated, "moonshotai.kimi-k2.5": { litellm_provider: "bedrock_converse", mode: "chat", input_cost_per_token: 0.5e-6, output_cost_per_token: 9e-6 } }, [["Kimi K2.5", 1], ["GLM 4.7", 2]]);
    const p = await resolvePrice(prices, "bedrock", "moonshotai.kimi-k2.5");
    expect([p.estimated, p.inputMicrosPerMTok, p.outputMicrosPerMTok]).toEqual([false, 1e6, 9e6]);
  });
  it("a genuinely unknown model still gets the cautious estimate (1.5x the dearest known rate)", async () => {
    const prices = await refreshed(unrelated, [["Kimi K2.5", 1], ["GLM 4.7", 2]]);
    for (const id of ["moonshotai.kimi-k9.9", "zai.glm-4.8", "deepseek.v4-v1:0"]) {
      const p = await resolvePrice(prices, "bedrock", id);
      expect([id, p.estimated, p.inputMicrosPerMTok, p.outputMicrosPerMTok]).toEqual([id, true, 3e6, 12e6]);
    }
  });
});

// LiteLLM's real Bedrock rows (raw.githubusercontent.com/BerriAI/litellm main, 2026-11-17) for the offered models the AWS offer has
// no row for, and that the first staging fetch (2026-11-17T02:24Z) charged the cautious estimate.
const LITELLM_REAL: Record<string, Record<string, unknown>> = {
  "us.amazon.nova-2-lite-v1:0": { litellm_provider: "bedrock_converse", mode: "chat", cache_read_input_token_cost: 8.25e-8, cache_read_input_token_cost_flex: 4.125e-8, cache_read_input_token_cost_priority: 1.44375e-7, input_cost_per_token: 3.3e-7, input_cost_per_token_batches: 1.65e-7, input_cost_per_token_flex: 1.65e-7, input_cost_per_token_priority: 5.775e-7, output_cost_per_token: 2.75e-6, output_cost_per_token_batches: 1.375e-6, output_cost_per_token_flex: 1.375e-6, output_cost_per_token_priority: 4.8125e-6 },
  "us.amazon.nova-pro-v1:0": { litellm_provider: "bedrock_converse", mode: "chat", cache_read_input_token_cost: 2e-7, cache_read_input_token_cost_flex: 1e-7, cache_read_input_token_cost_priority: 3.5e-7, input_cost_per_token: 8e-7, input_cost_per_token_batches: 4e-7, input_cost_per_token_flex: 4e-7, input_cost_per_token_priority: 1.4e-6, output_cost_per_token: 3.2e-6, output_cost_per_token_batches: 1.6e-6, output_cost_per_token_flex: 1.6e-6, output_cost_per_token_priority: 5.6e-6 },
  "us.moonshotai.kimi-k3": { litellm_provider: "bedrock_converse", mode: "chat", cache_creation_input_token_cost: 4.125e-6, cache_creation_input_token_cost_flex: 2.0625e-6, cache_creation_input_token_cost_priority: 7.21875e-6, cache_read_input_token_cost: 3.3e-7, cache_read_input_token_cost_flex: 1.65e-7, cache_read_input_token_cost_priority: 5.775e-7, input_cost_per_token: 3.3e-6, input_cost_per_token_flex: 1.65e-6, input_cost_per_token_priority: 5.775e-6, output_cost_per_token: 1.65e-5, output_cost_per_token_flex: 8.25e-6, output_cost_per_token_priority: 2.8875e-5 },
  "us.moonshotai.kimi-k3.1": { litellm_provider: "bedrock_converse", mode: "chat", cache_creation_input_token_cost: 5.5e-6, cache_creation_input_token_cost_flex: 2.75e-6, cache_creation_input_token_cost_priority: 9.625e-6, cache_read_input_token_cost: 2.2e-7, cache_read_input_token_cost_flex: 1.1e-7, cache_read_input_token_cost_priority: 3.85e-7, input_cost_per_token: 4.4e-6, input_cost_per_token_flex: 2.2e-6, input_cost_per_token_priority: 7.7e-6, output_cost_per_token: 2.2e-5, output_cost_per_token_flex: 1.1e-5, output_cost_per_token_priority: 3.85e-5 },
  // Haiku 5.5: a long-context band from 100k tokens, which the price tiers do not hold (128k and 200k only).
  "us.anthropic.claude-haiku-5-5": { litellm_provider: "bedrock_converse", mode: "chat", input_cost_per_token: 1.1e-7, output_cost_per_token: 5.5e-7, cache_read_input_token_cost: 1.1e-8, cache_creation_input_token_cost: 1.375e-7, cache_creation_input_token_cost_above_1hr: 2.2e-7, input_cost_per_token_above_100k_tokens: 5.5e-7, output_cost_per_token_above_100k_tokens: 2.75e-6, cache_read_input_token_cost_above_100k_tokens: 5.5e-8, cache_creation_input_token_cost_above_100k_tokens: 6.875e-7, cache_creation_input_token_cost_above_1hr_above_100k_tokens: 1.1e-6 },
  // Haiku 4.5: its EU profile's row is past its deprecation date; it pools into the one Haiku 4.5 identity.
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": { litellm_provider: "bedrock_converse", mode: "chat", input_cost_per_token: 1.1e-6, output_cost_per_token: 5.5e-6, cache_read_input_token_cost: 1.1e-7, cache_creation_input_token_cost: 1.375e-6, cache_creation_input_token_cost_above_1hr: 2.2e-6 },
  "eu.anthropic.claude-haiku-4-5-20251001-v1:0": { litellm_provider: "bedrock_converse", mode: "chat", deprecation_date: "2026-10-15", input_cost_per_token: 1.1e-6, output_cost_per_token: 5.5e-6, cache_read_input_token_cost: 1.1e-7, cache_creation_input_token_cost: 1.375e-6, cache_creation_input_token_cost_above_1hr: 2.2e-6, input_cost_per_token_batches: 5.5e-7, output_cost_per_token_batches: 2.75e-6 },
};
describe("offered models with no AWS row, priced from their real LiteLLM rows", () => {
  it("Nova 2 Lite, Nova Pro, Kimi K3 and Kimi K3.1 get their LiteLLM row's price, not an estimate", async () => {
    const prices = await refreshed({ ...unrelated, ...LITELLM_REAL }, [["Claude Opus 5.5", 5]]);
    for (const [id, input, output] of [["us.amazon.nova-2-lite-v1:0", 330_000, 2_750_000], ["us.amazon.nova-pro-v1:0", 800_000, 3_200_000], ["us.moonshotai.kimi-k3", 3_300_000, 16_500_000], ["us.moonshotai.kimi-k3.1", 4_400_000, 22_000_000]] as const) {
      const p = await resolvePrice(prices, "bedrock", id);
      expect([id, p.estimated, p.inputMicrosPerMTok, p.outputMicrosPerMTok]).toEqual([id, false, input, output]);
    }
  });
  it("Haiku 5.5 (its AWS row, banded at LiteLLM's 100k) and Haiku 4.5 (its live US row; the deprecated EU row is only an alias) get their real price", async () => {
    const prices = await refreshed({ ...unrelated, ...LITELLM_REAL }, [["Claude Haiku 5.5", 0.11]]);
    for (const [id, input, output] of [["us.anthropic.claude-haiku-5-5", 110_000, 550_000], ["us.anthropic.claude-haiku-4-5-20251001-v1:0", 1_100_000, 5_500_000]] as const) {
      const p = await resolvePrice(prices, "bedrock", id);
      expect([id, p.estimated, p.inputMicrosPerMTok, p.outputMicrosPerMTok]).toEqual([id, false, input, output]);
    }
    expect((await resolvePrice(prices, "bedrock", "us.anthropic.claude-haiku-5-5")).longContext).toEqual([{ aboveTokens: 100_000, inputMicrosPerMTok: 550_000, outputMicrosPerMTok: 2_750_000, cacheReadMicrosPerMTok: 55_000, cacheWrite5mMicrosPerMTok: 687_500, cacheWrite1hMicrosPerMTok: 1_100_000 }]);
  });
});
