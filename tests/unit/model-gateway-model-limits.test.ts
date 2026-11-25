import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { guardRequest } from "../../packages/model-gateway/src/guard.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { PriceRefresher } from "../../packages/model-gateway/src/price-refresh.js";
import { InMemoryPriceSnapshotStore, validSnapshot, type PriceSnapshot } from "../../packages/model-gateway/src/price-snapshot.js";
import { fetchLiteLLM } from "../../packages/model-gateway/src/price-sources.js";
import { modelLimitsFrom } from "../../packages/model-gateway/src/process.js";

const row = (max?: unknown, provider = "anthropic") => ({ litellm_provider: provider, mode: "chat", input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5, ...(max === undefined ? {} : { max_output_tokens: max }) });

describe("model output ceilings from the price rows (DEC 165/180)", () => {
  it("the LiteLLM fetch keeps each row's max_output_tokens, and drops a malformed one", async () => {
    const body = Buffer.from(JSON.stringify({ "claude-a": row(64_000), "claude-b": row(8_192), "claude-c": row(-1), "claude-d": row("big"), "claude-e": row(), "mystery/x": row(5, "nobody") }));
    const result = await fetchLiteLLM({ get: async () => ({ status: 200, body }) }, { minModels: 1 });
    expect(result.ok && result.limits).toEqual([
      { provider: "anthropic", model: "claude-a", maxOutputTokens: 64_000 },
      { provider: "anthropic", model: "claude-b", maxOutputTokens: 8_192 },
    ]);
  });

  it("a snapshot's limits are validated, carried through a refresh, and looked up by the price identity (own key, then aliases, smallest wins)", async () => {
    const store = new InMemoryPriceSnapshotStore();
    const prices = new SnapshotPriceSource(store);
    const litellm = Buffer.from(JSON.stringify({ "claude-a": row(64_000), "claude-a-20250101": row(32_000), "claude-b": row(8_192) }));
    const refresher = new PriceRefresher({
      store, prices,
      litellm: () => fetchLiteLLM({ get: async () => ({ status: 200, body: litellm }) }, { minModels: 1 }),
      aws: async () => ({ ok: false, reason: "not in this test" }),
    });
    await refresher.run(1_800_000_000_000);
    const saved = (await store.load())!;
    expect(saved.sources.litellm?.limits).toHaveLength(3);
    expect(prices.maxOutputTokens("anthropic", "claude-b")).toBe(8_192);
    expect(prices.maxOutputTokens("anthropic", "Claude-B")).toBe(8_192);
    expect(prices.maxOutputTokens("anthropic", "claude-a")).toBe(64_000);
    expect(prices.maxOutputTokens("anthropic", "claude-unknown")).toBeUndefined();
    const bad = (limits: unknown): PriceSnapshot => ({ ...saved, sources: { ...saved.sources, litellm: { ...saved.sources.litellm!, limits } } }) as PriceSnapshot;
    expect(validSnapshot(bad([{ provider: "anthropic", model: "x", maxOutputTokens: 0 }]))).toBe(false);
    expect(validSnapshot(bad([{ provider: "anthropic", model: "x", maxOutputTokens: 5, extra: 1 }]))).toBe(false);
    expect(validSnapshot(bad([{ provider: "anthropic", model: "x", maxOutputTokens: 5 }, { provider: "anthropic", model: "x", maxOutputTokens: 6 }]))).toBe(false);
    expect(validSnapshot(bad([{ provider: "anthropic", model: "x", maxOutputTokens: 5 }]))).toBe(true);
  });

  it("a request naming no max_tokens is held and forwarded at the row's own ceiling, and one above it is refused", () => {
    const limits = modelLimitsFrom({ maxOutputTokens: (_p, model) => (model === "claude-b" ? 8_192 : undefined) });
    const body = (extra: Record<string, unknown>) => Buffer.from(JSON.stringify({ model: "claude-b", messages: [{ role: "user", content: "hi" }], ...extra }));
    const headers = { "content-type": "application/json" };
    const open = guardRequest(body({}), headers, ["claude-b"], limits);
    expect(open.ok && [open.maxTokens, (JSON.parse(open.bytes.toString()) as { max_tokens: number }).max_tokens]).toEqual([8_192, 8_192]);
    expect(guardRequest(body({ max_tokens: 8_193 }), headers, ["claude-b"], limits).ok).toBe(false);
  });
});
