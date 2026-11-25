// Owner rule (2026-11-23), harness side. A MISSING cache-write price is allowed for ANY model (the row carries the runtime no-write basis); an EXPLICIT zero write price and a
// MISSING read price stay refused; a reported write (tokens or a write-named cost part) fails the call and the model, so it is never installable. The CONTROL probes send
// reasoning OFF; models are spent on CHEAPEST FIRST. The gateway side is model-gateway-openrouter-cache-write-rule.test.ts; the align test at the end ties the two together.
import { expect, it } from "vitest";
import { cacheWriteCostReported } from "../../packages/model-gateway/src/agent-openai.js";
import { openRouterPolicy, OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION } from "../../packages/model-gateway/src/openrouter-policy.js";
const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
type Body = { model: string; messages: unknown[]; max_tokens: number; reasoning: { enabled: boolean; max_tokens?: number }; provider: { max_price: Record<string, number> } };
type Row = Record<string, unknown> & { model: string; route: string; status: string; verifiedAt: number; zeroPriceProof: Record<string, { source: string }> };
type Report = { status: string; models: { model: string; providers: { calls: { holdMicros: number; reasoningOffRefused?: boolean; requestControls: { reasoning: unknown } }[]; checks: Record<string, string> }[] }[]; proposedTariffRows: Row[]; installSelection: { installable: Row[]; refused: { model: string; reason: string }[] } };
const mod = await import(script) as { qualify: (options: Record<string, unknown>) => Promise<Report>; ZERO_PROOF_RULES: { cacheWriteRuntimeEnforced: (tariff: Record<string, unknown>, calls: unknown[]) => boolean } };
const { qualify, ZERO_PROOF_RULES } = mod;
const at = Date.UTC(2026, 10, 23);
const PRICES: Record<string, string> = { prompt: "0.0000015", completion: "0.0000075", internal_reasoning: "0.0000075", request: "0", input_cache_read: "0.000001", input_cache_write: "0.000001" };
const without = (prices: Record<string, string>, ...keys: string[]) => Object.fromEntries(Object.entries(prices).filter(([k]) => !keys.includes(k)));
const bare = (row: Row) => Object.fromEntries(["model", "route", "pricing", "max_completion_tokens", "reasoning", "verifiedAt", "expiresAt", "evidence", "cacheWriteBasis", "cacheWriteEnforcementVersion"].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
type Options = { models: { id: string; pricing: Record<string, string> }[]; writeTokens?: number; writeCostPart?: boolean; refuseReasoningOff?: boolean };
async function run(options: Options) {
 const bodies: Body[] = []; let generation: Record<string, unknown> = {};
 const pricingOf = (id: string) => options.models.find(m => m.id === id)!.pricing;
 const fetcher: typeof fetch = async (url, init) => {
  const request = new Request(url, init);
  if (request.method !== "POST") return Response.json({ data: generation });
  const body = await request.json() as Body; bodies.push(body);
  if (options.refuseReasoningOff && body.reasoning.enabled === false) return Response.json({ error: { message: "Reasoning is mandatory for this endpoint and cannot be disabled" } }, { status: 400 });
  const pricing = pricingOf(body.model); const n = (key: string) => Number(pricing[key] ?? 0);
  if (Object.entries({ prompt: n("prompt") * 1e6, completion: Math.max(n("completion"), n("internal_reasoning")) * 1e6, request: n("request") }).some(([key, value]) => value > 0 && body.provider.max_price[key] === 0)) return Response.json({ error: { message: "No endpoints found that satisfy the max price for this request" } }, { status: 404 });
  const promptCost = 10 * n("prompt"); const outputCost = 20 * n("completion");
  const cost = (promptCost + outputCost + n("request")).toFixed(12);
  generation = { model: body.model, provider_name: "Fixture", native_tokens_prompt: 10, native_tokens_completion: 20, native_tokens_reasoning: 8, native_tokens_cached: 0, total_cost: cost, is_byok: false };
  const details: Record<string, unknown> = { upstream_inference_cost: cost, upstream_inference_prompt_cost: promptCost.toFixed(12), upstream_inference_completions_cost: outputCost.toFixed(12) };
  if (options.writeCostPart) details.upstream_inference_cache_write_cost = "0.000001";
  return Response.json({ id: `gen-w-${bodies.length}`, model: body.model, choices: [{ message: { content: "four" } }], usage: { prompt_tokens: 10, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: options.writeTokens ?? 0 }, completion_tokens_details: { reasoning_tokens: 8 }, cost, cost_details: details } });
 };
 const catalogue = { models: { data: options.models.map(m => ({ id: m.id, pricing: m.pricing, supported_parameters: ["tools"], top_provider: { max_completion_tokens: 4096 } })) }, endpoints: Object.fromEntries(options.models.map(m => [m.id, { data: { endpoints: [{ tag: "fixture/fp8", provider_name: "Fixture", pricing: m.pricing, supported_parameters: ["tools"], max_completion_tokens: 4096 }] } }])) };
 const report = await qualify({ allModels: true, catalogue, env: { OPENROUTER_API_KEY: "cache-write-fixture-only" }, now: () => at, fetch: fetcher, sleep: async () => {}, spendCap: "15.00" });
 return { report, bodies };
}
const one = (pricing: Record<string, string>, extra: Omit<Options, "models"> = {}) => run({ models: [{ id: "vendor/cw-model", pricing }], ...extra });

it("W1: a MISSING write price (non-listed model) + 0 reported writes is PROVEN and installable by the gateway's own validator", async () => {
 const { report } = await one(without(PRICES, "input_cache_write"));
 const row = report.proposedTariffRows[0]!;
 expect(report.status).toBe("PASS");
 expect(row).toMatchObject({ status: "PROVEN", cacheWriteBasis: "never_requested_enforced", cacheWriteEnforcementVersion: OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION });
 expect(row.zeroPriceProof.input_cache_write!.source).toBe(`runtime_enforced:${OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION}`);
 expect(report.installSelection.installable).toHaveLength(1);
 expect(openRouterPolicy(row.model, row.verifiedAt + 1, [bare(row) as never])).toBeDefined();
});

it.each([
 ["write tokens", { writeTokens: 3 }],
 ["a write-named cost part", { writeCostPart: true }],
] as const)("W2: a MISSING write price + a reported write (%s): the model stops, FAILs and is never installable", async (_name, extra) => {
 const { report, bodies } = await one(without(PRICES, "input_cache_write"), extra);
 expect(report.status).toBe("FAIL");
 // The first call carries the write: the harness stops that model there (no 2nd control, no refusal probes).
 expect(bodies).toHaveLength(1);
 expect(report.models[0]!.providers[0]!.calls).toHaveLength(1);
 expect(report.proposedTariffRows).toEqual([]);
 expect(report.installSelection.installable).toEqual([]);
});

it("W3: an EXPLICIT zero write price stays refused (no basis, no write proof)", async () => {
 const { report } = await one({ ...PRICES, input_cache_write: "0" });
 const row = report.proposedTariffRows[0]!;
 expect(row).not.toHaveProperty("cacheWriteBasis");
 expect(row.status).toBe("CANDIDATE");
 expect(report.installSelection.installable).toEqual([]);
 expect(report.installSelection.refused).toEqual([expect.objectContaining({ model: "vendor/cw-model", reason: "unproven_zero:input_cache_write" })]);
});

it("W4: a MISSING read price stays refused even when the write price is also missing", async () => {
 const { report } = await one(without(PRICES, "input_cache_read", "input_cache_write"));
 expect(report.installSelection.installable).toEqual([]);
 expect(report.installSelection.refused.map(r => r.reason).join(",")).toContain("input_cache_read");
});

it("W5: the CONTROL probes send reasoning OFF; the reasoning probe sends the gateway's exact bounded request; nothing else differs", async () => {
 const { report, bodies } = await one(without(PRICES, "input_cache_write"));
 expect(report.status).toBe("PASS");
 expect(bodies.slice(0, 3).map(b => b.reasoning)).toEqual([{ enabled: false }, { enabled: false }, { enabled: false }]);
 expect(bodies[3]!.reasoning).toEqual({ enabled: true, max_tokens: 1024 });
 for (const b of bodies.slice(0, 3)) expect(JSON.stringify({ ...b, reasoning: bodies[3]!.reasoning, messages: bodies[3]!.messages })).toBe(JSON.stringify(bodies[3]));
 expect(report.models[0]!.providers[0]!.calls.map(c => c.requestControls.reasoning)).toEqual([{ enabled: false }, { enabled: false }, { enabled: false }, { enabled: true, max_tokens: 1024 }]);
});

it("W6: a route that refuses reasoning OFF (HTTP 400, $0) falls back ONCE to the gateway's bounded request and still qualifies", async () => {
 const { report, bodies } = await one(without(PRICES, "input_cache_write"), { refuseReasoningOff: true });
 expect(report.status).toBe("PASS");
 const calls = report.models[0]!.providers[0]!.calls;
 expect(calls[0]).toMatchObject({ reasoningOffRefused: true, requestControls: { reasoning: { enabled: true, max_tokens: 1024 } } });
 // One refused attempt in total (later controls go straight to the gateway request), then every call is the bounded one.
 expect(bodies.filter(b => b.reasoning.enabled === false)).toHaveLength(1);
 expect(calls.map(c => c.requestControls.reasoning)).toEqual(Array(4).fill({ enabled: true, max_tokens: 1024 }));
});

it("W7: models are spent on CHEAPEST FIRST (by the route's max listed price), ties by id; report rows keep catalogue order", async () => {
 const price = (k: number) => ({ ...PRICES, prompt: String(1.5e-6 * k), completion: String(7.5e-6 * k), internal_reasoning: String(7.5e-6 * k), input_cache_read: String(1e-6 * k), input_cache_write: String(1e-6 * k) });
 const models = [{ id: "vendor/dear", pricing: price(8) }, { id: "vendor/mid", pricing: price(4) }, { id: "vendor/b-cheap", pricing: price(1) }, { id: "vendor/a-cheap", pricing: price(1) }];
 const { report, bodies } = await run({ models });
 const firstSeen = [...new Set(bodies.map(b => b.model))];
 expect(firstSeen).toEqual(["vendor/a-cheap", "vendor/b-cheap", "vendor/mid", "vendor/dear"]);
 expect(report.models.map(m => m.model)).toEqual(["vendor/dear", "vendor/mid", "vendor/b-cheap", "vendor/a-cheap"]);
 // Every model's calls are contiguous (a model is finished before the next starts).
 const order = bodies.map(b => b.model); expect(order).toEqual([...order].sort((a, b) => firstSeen.indexOf(a) - firstSeen.indexOf(b)));
});

it("W8 (align): the harness rule and the gateway agree on what a reported write is: the same name pattern, the same zero test", () => {
 const rule = ZERO_PROOF_RULES.cacheWriteRuntimeEnforced;
 const good = { cacheWriteBasis: "never_requested_enforced", cacheWriteEnforcementVersion: OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION, assumedZero: ["input_cache_write"] };
 const callWith = (parts: string[]) => ({ usage: { cache_write_tokens: 0, cost_details: { unrecognized_components: parts } } });
 for (const name of ["upstream_inference_cache_write_cost", "cache_creation_cost", "input_cache_write", "cache-write-fee", "cacheWrite", "cache_creation_input_cost"]) {
  expect(rule(good, [callWith([name])]), name).toBe(false);
  expect(cacheWriteCostReported({ cost_details: { [name]: 0.0001 } }), name).toBe(true);
 }
 for (const name of ["upstream_inference_prompt_cost", "web_search", "cache_read_cost", "image"]) {
  expect(rule(good, [callWith([name])]), name).toBe(true);
  expect(cacheWriteCostReported({ cost_details: { [name]: 0.0001 } }), name).toBe(false);
 }
 expect(rule(good, [{ usage: { cache_write_tokens: 1, cost_details: { unrecognized_components: [] } } }])).toBe(false);
});
