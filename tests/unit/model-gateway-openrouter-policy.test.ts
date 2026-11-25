import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { beforeAll, expect, it } from "vitest";
import { toChatCompletions } from "../../packages/model-gateway/src/agent-openai.js";
import { denyNetwork } from "./model-gateway-no-network.js";
import { openRouterPolicy, openRouterRequest, openRouterHold, perMillionPrice, REVIEWED_OPENROUTER_POLICIES, CANDIDATE_OPENROUTER_POLICIES } from "../../packages/model-gateway/src/openrouter-policy.js";
beforeAll(denyNetwork);
const now = Date.UTC(2026, 10, 20);
const row = { model: "openai/gpt-5-mini", route: "fixture-provider", pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000003", request: "0.000004", input_cache_read: "0.0000005", input_cache_write: "0.000001" }, max_completion_tokens: 2048, reasoning: { mode: "bounded" as const, max_tokens: 1024 }, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "fixture only; not a vendor tariff" };
it("has only the reviewed v3 run 2 production rows (see model-gateway-openrouter-reviewed-v3r2.test.ts); exact reviewed routes expire and hash all restrictions", () => {
 expect(REVIEWED_OPENROUTER_POLICIES.length).toBeGreaterThan(0);
 expect(REVIEWED_OPENROUTER_POLICIES.every(r => r.evidence.includes(`TARIFFS PASS ${REVIEWED_OPENROUTER_POLICIES.length} (OpenRouter v3 owner paid run 2`))).toBe(true);
 expect(openRouterPolicy(row.model, now, [row])?.model).toBe(row.model);
 expect(openRouterPolicy(row.model, now, [row])?.hash).toMatch(/^[a-f0-9]{64}$/u);
 for (const patch of [{ expiresAt: now }, { verifiedAt: now + 1 }, { pricing: { ...row.pricing, prompt: "-1" } }, { route: "" }]) expect(openRouterPolicy(row.model, now, [{ ...row, ...patch }])).toBeUndefined();
 expect(openRouterPolicy("openai/gpt-5-mini:free", now, [row])).toBeUndefined();
 expect(openRouterPolicy(row.model, now, [row])?.hash).not.toBe(openRouterPolicy(row.model, now, [{ ...row, route: "other" }])?.hash);
});
it("pins route, maximum USD per million token rates and no fallback; caller overrides and unbounded features refuse", () => {
 const policy = openRouterPolicy(row.model, now, [row])!;
 const body = { model: row.model, messages: [{ role: "user", content: "hello" }], max_tokens: 2048, stream: true };
 expect(openRouterRequest(body, policy)).toMatchObject({ provider: { only: [row.route], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 1, completion: 3, request: 0.000004 } }, reasoning: { enabled: true, max_tokens: 1024 }, usage: { include: true } });
 for (const patch of [{ provider: {} }, { plugins: [] }, { models: ["other"] }, { reasoning: {} }, { model: "openrouter/auto" }, { max_tokens: 0 }, { messages: [{ role: "user", content: [{ type: "image_url" }] }] }]) expect(openRouterRequest({ ...body, ...patch }, policy)).toBeUndefined();
});

it("converts per-token decimal prices to per-million caps exactly, including nanodollars", () => {
 expect(perMillionPrice("0.000000001")).toBe("0.001");
 expect(perMillionPrice("0.00003")).toBe("30");
 expect(perMillionPrice("1e-9")).toBe("0.001");
 expect(perMillionPrice("0.000001234567")).toBe("1.234567");
});
it("holds prompt, dearer reasoning/output, request and all possible cache writes rounded up", () => {
 const policy = openRouterPolicy(row.model, now, [row])!;
 expect(openRouterHold(policy, 3, 2048)).toBe(6154);
 const nano = openRouterPolicy(row.model, now, [{ ...row, pricing: { ...row.pricing, prompt: "1e-9", completion: "1e-9", internal_reasoning: "1e-9", request: "0", input_cache_read: "0", input_cache_write: "0" } }])!;
 expect(openRouterHold(nano, 1, 2048)).toBe(3);
 expect(openRouterRequest({ model: row.model, messages: [{ role: "user", content: "x" }], max_tokens: 2048 }, nano)).toMatchObject({ provider: { max_price: { prompt: 0.001, completion: 0.001 } } });
});
it("refuses unbounded fees, conditional tariffs, aliases and output/reasoning limits", () => {
 for (const extra of [{ web_search: "0.01" }, { image: "0.01" }, { audio: "0.01" }, { overrides: [{}] }, { discount: "0.1" }, { input_cache_write_1h: "0.01" }, { unknown_fee: "0.01" }]) {
  expect(openRouterPolicy(row.model, now, [{ ...row, pricing: { ...row.pricing, ...extra } }])).toBeUndefined();
 }
 for (const patch of [{ max_completion_tokens: 0 }, { reasoning: { mode: "bounded", max_tokens: 2048 } }, { model: "openrouter/auto" }, { model: "vendor/model:free" }]) expect(openRouterPolicy(String(patch.model ?? row.model), now, [{ ...row, ...patch } as typeof row])).toBeUndefined();
 const policy = openRouterPolicy(row.model, now, [row])!;
 const body = { model: row.model, messages: [{ role: "user", content: "x" }], max_tokens: 2048 };
 expect(openRouterRequest({ ...body, max_tokens: 2049 }, policy)).toBeUndefined();
 expect(openRouterRequest({ ...body, max_tokens: 1024 }, policy)).toBeUndefined();
});

it("normalizes only absent optional prices to zero and holds reasoning at the output rate", () => {
 const pricing = { ...row.pricing, input_cache_write: "0" };
 for (const key of ["internal_reasoning", "request", "input_cache_read"]) Reflect.deleteProperty(pricing, key);
 const policy = openRouterPolicy(row.model, now, [{ ...row, pricing }])!;
 expect(policy?.pricing).toEqual({ prompt: row.pricing.prompt, completion: row.pricing.completion, internal_reasoning: "0", request: "0", input_cache_read: "0", input_cache_write: "0" });
 expect(openRouterHold(policy, 10, 1280)).toBe(2570);
 expect(openRouterPolicy(row.model, now, [{ ...row, pricing: { ...policy.pricing } }])?.hash).toBe(policy.hash);
 expect(pricing).not.toHaveProperty("request");
 for (const key of ["prompt", "completion"]) {
  const missing = { ...pricing }; Reflect.deleteProperty(missing, key);
  expect(openRouterPolicy(row.model, now, [{ ...row, pricing: missing }])).toBeUndefined();
  expect(openRouterPolicy(row.model, now, [{ ...row, pricing: { ...pricing, [key]: "0" } }])).toBeUndefined();
 }
 for (const key of ["internal_reasoning", "request", "input_cache_read", "input_cache_write"]) {
  for (const value of [undefined, null, 0, "-1", "bad"]) expect(openRouterPolicy(row.model, now, [{ ...row, pricing: { ...pricing, [key]: value } }])).toBeUndefined();
 }
});
it("refuses server search tools, search controls and every variant before OpenRouter transport", () => {
 const policy = openRouterPolicy(row.model, now, [row])!;
 const body = { model: row.model, messages: [{ role: "user", content: "hello" }], max_tokens: 1280 };
 const patches = [{ plugins: [{ id: "web" }] }, { web_search_options: {} },
  ...["web_search", "web_search_preview", "web_search_20250305", "unknown"].map(type => ({ tools: [{ type }] }))];
 for (const patch of patches) {
  expect(openRouterRequest({ ...body, ...patch }, policy)).toBeUndefined();
  expect(toChatCompletions({ ...body, ...patch }, row.model, 1280, "openrouter", policy)).toBeUndefined();
 }
 expect(openRouterRequest({ ...body, tools: [{ type: "function", function: { name: "search_local", parameters: {} } }] }, policy)).toHaveProperty("tools");
 for (const suffix of [":online", ":free", ":nitro", ":other"]) {
  const model = row.model + suffix;
  expect(openRouterRequest({ ...body, model }, { ...policy, model })).toBeUndefined();
  expect(toChatCompletions({ ...body, model }, model, 1280, "openrouter")).toBeUndefined();
 }
});

it.each(["vendor/model", "openai/gpt-5", "openai/gpt-5-mini-other", "perplexity/sonar-deep-research"])("requires every price for non-allowlisted %s at runtime", model => {
 for (const field of ["internal_reasoning", "request", "input_cache_read", "input_cache_write"]) {
  const pricing = { ...row.pricing }; Reflect.deleteProperty(pricing, field);
  expect(openRouterPolicy(model, now, [{ ...row, model, pricing }])).toBeUndefined();
 }
 // Strict models still work with a complete, bounded six-field tariff.
 expect(openRouterPolicy(model, now, [{ ...row, model }])).toBeDefined();
});
it.each(["openai/gpt-5-mini", "openai/gpt-5-nano"])("holds %s at the higher cache-read price with an explicit zero write price", model => {
 const pricing = { ...row.pricing, input_cache_read: "0.000004", input_cache_write: "0", request: "0" };
 const policy = openRouterPolicy(model, now, [{ ...row, model, pricing }])!;
 expect(policy?.pricing.input_cache_write).toBe("0");
 // 10 * 4 micro-USD + 1280 * 3 micro-USD = 3880, independent of cheaper prompt rate.
 expect(openRouterHold(policy, 10, 1280)).toBe(3880);
});
it.each([false, true])("refuses direct caching hints and strips translated Anthropic cache markers (stream=%s)", stream => {
 const policy = openRouterPolicy(row.model, now, [row])!;
 const body = { model: row.model, messages: [{ role: "user", content: "hello" }], max_tokens: 1280, stream };
 for (const key of ["cache_control", "caching", "cache", "prompt_cache_key", "prompt_cache_retention", "prompt_caching"]) {
  expect(openRouterRequest({ ...body, [key]: {} }, policy)).toBeUndefined();
  expect(openRouterRequest({ ...body, messages: [{ ...body.messages[0], [key]: {} }] }, policy)).toBeUndefined();
  expect(openRouterRequest({ ...body, tools: [{ type: "function", function: { name: "read", parameters: {} }, [key]: {} }] }, policy)).toBeUndefined();
  expect(toChatCompletions({ ...body, [key]: {} }, row.model, 1280, "openrouter", policy)).toBeUndefined();
 }
 const translated = toChatCompletions({ ...body,
  system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
  messages: [
   { role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] },
   { role: "assistant", content: [{ type: "tool_use", id: "call", name: "read", input: {}, cache_control: { type: "ephemeral" } }] },
   { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "text", text: "result", cache_control: { type: "ephemeral" } }], cache_control: { type: "ephemeral" } }] },
  ], tools: [{ name: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
 }, row.model, 1280, "openrouter", policy);
 expect(translated).toMatchObject({ messages: [{ role: "system", content: "system" }, { role: "user", content: "hello" }, { role: "assistant", content: null }, { role: "tool", content: "result" }] });
 expect(JSON.stringify(translated)).not.toMatch(/cache_control|caching|prompt_cache/u);
});

it.each(["openai/gpt-5-mini", "openai/gpt-5-nano"])("bounds absent cache-write for %s only with current enforced proof", model => {
 const pricing = { ...row.pricing }; Reflect.deleteProperty(pricing, "input_cache_write");
 const proof = { cacheWriteBasis: "never_requested_enforced" as const, cacheWriteEnforcementVersion: "openrouter-no-cache-write-v1" };
 const policy = openRouterPolicy(model, now, [{ ...row, model, pricing, ...proof }])!;
 expect(policy).toMatchObject({ ...proof, pricing: { input_cache_write: "0" } });
 expect(openRouterHold(policy, 10, 1280)).toBe(3854);
 expect(openRouterPolicy(model, now, [policy])?.hash).toBe(policy.hash);
 for (const patch of [{}, { ...proof, cacheWriteEnforcementVersion: "old" }, { ...proof, cacheWriteBasis: "assumed" }]) {
  expect(openRouterPolicy(model, now, [{ ...row, model, pricing, ...patch }])).toBeUndefined();
 }
 expect(openRouterPolicy("vendor/model", now, [{ ...row, model: "vendor/model", pricing, ...proof }])).toBeUndefined();
 expect(openRouterPolicy(model, now, [{ ...row, model, ...proof }])).toBeUndefined();
 const explicit = openRouterPolicy(model, now, [{ ...row, model, pricing: { ...pricing, input_cache_write: "0" } }])!;
 expect(explicit.hash).not.toBe(policy.hash);
});

it("refuses CANDIDATE tariff rows even when explicitly supplied as reviewed pricing", () => {
 const candidate = { ...row, status: "CANDIDATE" };
 expect(openRouterPolicy(row.model, now, [candidate])).toBeUndefined();
 // Existing explicitly reviewed rows still work; promotion requires removing the candidate label.
 expect(openRouterPolicy(row.model, now, [row])).toBeDefined();
});

it("keeps both run-8 candidates out of default and explicitly supplied pricing until reviewed promotion", async () => {
 expect(CANDIDATE_OPENROUTER_POLICIES).toHaveLength(2);
 expect(CANDIDATE_OPENROUTER_POLICIES.map(r => r.model)).toEqual(["openai/gpt-5-mini", "openai/gpt-5-nano"]);
 for (const [index, candidate] of CANDIDATE_OPENROUTER_POLICIES.entries()) {
  expect(candidate.status).toBe("CANDIDATE");
  expect(candidate.evidence).toContain("briefs/codex/providers-fast/M2-LIVE-REPORT-run8.json");
  const clock = () => candidate.verifiedAt + 1; // Test while fresh: expiry must not hide candidate activation.
  expect(openRouterPolicy(candidate.model, clock())).toBeUndefined();
  const store = { load: async () => undefined, save: async () => false };
  for (const options of [{}, { openRouterTariffs: CANDIDATE_OPENROUTER_POLICIES }]) {
   const prices = new SnapshotPriceSource(store, { now: clock, ...options }); await prices.reload();
   expect(prices.priceFor("openrouter", candidate.model)).toBeUndefined();
   expect(prices.quoteBasis("openrouter", candidate.model)).toBeUndefined();
   expect(prices.effectiveFor("openrouter", candidate.model, "chat")).toMatchObject({ estimated: true, operatorReview: true });
   expect(prices.runPriceSnapshotVersion()).toBeUndefined();
  }
  // Simulate the existing reviewed source edit; no runtime promotion or installation occurs.
  const promoted = { ...candidate }; Reflect.deleteProperty(promoted, "status");
  const reviewed = new SnapshotPriceSource(store, { now: clock, openRouterTariffs: [promoted] }); await reviewed.reload();
  expect(reviewed.priceFor("openrouter", candidate.model)).toMatchObject(index === 0
   ? { inputMicrosPerMTok: 250000, outputMicrosPerMTok: 2000000, estimated: false }
   : { inputMicrosPerMTok: 50000, outputMicrosPerMTok: 400000, estimated: false });
  expect(reviewed.quoteBasis("openrouter", candidate.model)?.hash).toMatch(/^[a-f0-9]{64}$/u);
  expect(openRouterPolicy(candidate.model, candidate.expiresAt, [promoted])).toBeUndefined();
 }
});

it("A7: the validator's bounded-reasoning floor is unchanged (reasoning >= 1024 and strictly below the ceiling; request above the reasoning)", () => {
 const bounded = (max_tokens: number, ceiling: number) => ({ ...row, max_completion_tokens: ceiling, reasoning: { mode: "bounded" as const, max_tokens } });
 expect(openRouterPolicy(row.model, now, [bounded(1023, 2048)])).toBeUndefined();
 expect(openRouterPolicy(row.model, now, [bounded(256, 2048)])).toBeUndefined();
 expect(openRouterPolicy(row.model, now, [bounded(1024, 1024)])).toBeUndefined();
 expect(openRouterPolicy(row.model, now, [bounded(1024, 1025)])).toBeDefined();
 const policy = openRouterPolicy(row.model, now, [bounded(1024, 1025)])!;
 const body = { model: row.model, messages: [{ role: "user", content: "x" }] };
 expect(openRouterRequest({ ...body, max_tokens: 1025 }, policy)).toBeDefined();
 expect(openRouterRequest({ ...body, max_tokens: 1024 }, policy)).toBeUndefined();
 expect(openRouterRequest({ ...body, max_tokens: 1026 }, policy)).toBeUndefined();
});
it("Q4: the outgoing provider object pins the proven endpoint in order AND only with no fallback (exact shape)", () => {
 const policy = openRouterPolicy(row.model, now, [row])!;
 const sent = openRouterRequest({ model: row.model, messages: [{ role: "user", content: "x" }], max_tokens: 2048 }, policy)!;
 expect(sent.provider).toEqual({ order: [row.route], only: [row.route], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 1, completion: 3, request: 0.000004 } });
});
