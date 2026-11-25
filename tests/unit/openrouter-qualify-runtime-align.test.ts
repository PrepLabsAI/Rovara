// Ruling (a): a harness PASS row is installable as-is by the gateway's own validator, and the harness sends exactly the request the gateway
// sends. Q1 (stricter scope): runtime no-cache-write enforcement is the write proof ONLY for the relaxed list, in ONE place.
import { expect, it } from "vitest";
import { openRouterHold, openRouterPolicy, openRouterRequest, OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION } from "../../packages/model-gateway/src/openrouter-policy.js";
const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
type Row = Record<string, unknown> & { model: string; route: string; status: string; verifiedAt: number; expiresAt: number; max_completion_tokens: number; zeroPriceProof: Record<string, { source: string }> };
type Body = { model: string; messages: unknown[]; max_tokens: number; stream?: boolean; provider: { max_price: Record<string, number> } } & Record<string, unknown>;
type Report = { status: string; models: { resumed?: boolean; model: string; causes: string[]; providers: { calls: { holdMicros: number }[]; checks: Record<string, string>; cause?: string }[] }[]; failuresByCause: Record<string, number>; proposedTariffRows: Row[]; installSelection: { installable: Row[]; refused: { reason: string }[] }; preCallHoldsMicros: number };
const mod = await import(script) as { qualify: (options: Record<string, unknown>) => Promise<Report>; ZERO_PROOF_RULES: { cacheWriteRuntimeEnforced: (tariff: Record<string, unknown>, calls: unknown[]) => boolean; assumedMayBeProven: string[] } };
const { qualify, ZERO_PROOF_RULES } = mod;
const at = Date.UTC(2026, 10, 23);
const PRICES = { prompt: "0.0000015", completion: "0.0000075", internal_reasoning: "0.0000075", request: "0", input_cache_read: "0.000001", input_cache_write: "0.000001" };
async function run(options: { id?: string; pricing?: Record<string, string>; ceiling?: number; tag?: string; endpointPricing?: Record<string, string>; resumeReport?: unknown } = {}) {
 const id = options.id ?? "vendor/align-model"; const pricing = options.pricing ?? PRICES; const ceiling = options.ceiling ?? 4096;
 const bodies: Body[] = []; let generation: Record<string, unknown> = {};
 const fetcher: typeof fetch = async (url, init) => {
  const request = new Request(url, init);
  if (request.method !== "POST") return Response.json({ data: generation });
  const body = await request.json() as Body; bodies.push(body);
  const n = (key: string) => Number((pricing as Record<string, string | undefined>)[key] ?? 0);
  if (Object.entries({ prompt: n("prompt") * 1e6, completion: Math.max(n("completion"), n("internal_reasoning")) * 1e6, request: n("request") }).some(([key, value]) => value > 0 && body.provider.max_price[key] === 0)) return Response.json({ error: { message: "No endpoints found that satisfy the max price for this request" } }, { status: 404 });
  const promptCost = 10 * n("prompt"); const outputCost = 20 * n("completion");
  const cost = (promptCost + outputCost + n("request")).toFixed(12);
  generation = { model: body.model, provider_name: "Fixture", native_tokens_prompt: 10, native_tokens_completion: 20, native_tokens_reasoning: 8, native_tokens_cached: 0, total_cost: cost, is_byok: false };
  return Response.json({ id: `gen-a-${bodies.length}`, model: body.model, choices: [{ message: { content: "four" } }], usage: { prompt_tokens: 10, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 8 }, cost, cost_details: { upstream_inference_cost: cost, upstream_inference_prompt_cost: promptCost.toFixed(12), upstream_inference_completions_cost: outputCost.toFixed(12) } } });
 };
 const report = await qualify({ allModels: true, catalogue: { models: { data: [{ id, pricing, supported_parameters: ["tools"], top_provider: { max_completion_tokens: ceiling } }] }, endpoints: { [id]: { data: { endpoints: [{ tag: options.tag ?? "fixture/fp8", provider_name: "Fixture", pricing: options.endpointPricing ?? pricing, supported_parameters: ["tools"], max_completion_tokens: ceiling }] } } } }, env: { OPENROUTER_API_KEY: "align-fixture-only" }, now: () => at, fetch: fetcher, sleep: async () => {}, ...(options.resumeReport ? { resumeReport: options.resumeReport } : {}) });
 return { report, bodies };
}
const bare = (row: Row) => Object.fromEntries(["model", "route", "pricing", "max_completion_tokens", "reasoning", "verifiedAt", "expiresAt", "evidence", "cacheWriteBasis", "cacheWriteEnforcementVersion"].filter(key => row[key] !== undefined).map(key => [key, row[key]]));

it("A1: every PASS row is accepted by the gateway's real validator just after verification and refused at expiry (freshness unchanged, 24 h)", async () => {
 const { report } = await run();
 expect(report.status).toBe("PASS");
 const row = report.proposedTariffRows[0]!;
 expect(row.expiresAt - row.verifiedAt).toBe(86_400_000);
 expect(row).toMatchObject({ max_completion_tokens: 2048, reasoning: { mode: "bounded", max_tokens: 1024 } });
 expect(openRouterPolicy(row.model, row.verifiedAt + 1, [bare(row) as never])).toBeDefined();
 expect(openRouterPolicy(row.model, row.expiresAt - 1, [bare(row) as never])).toBeDefined();
 expect(openRouterPolicy(row.model, row.expiresAt, [bare(row) as never])).toBeUndefined();
});

it("A2: every body the harness sends EQUALS the gateway's own request for the installed row (same provider order/only/max_price/reasoning)", async () => {
 const { report, bodies } = await run();
 const row = report.proposedTariffRows[0]!;
 const policy = openRouterPolicy(row.model, row.verifiedAt + 1, [bare(row) as never])!;
 expect(bodies.length).toBeGreaterThan(0);
 for (const body of bodies.filter(b => b.max_tokens === 2048)) {
  const gateway = openRouterRequest({ model: body.model, messages: body.messages, max_tokens: body.max_tokens, stream: false }, policy)!;
  // Owner rule 2026-11-23: the CONTROL probes send reasoning OFF; EVERYTHING else (pin, caps, ceiling, prompt shape) is the gateway's request. The reasoning probe is exact.
  const runtime = (body.reasoning as { enabled: boolean }).enabled === false ? { ...gateway, reasoning: { enabled: false } } : gateway;
  // Price-cap refusal probes differ ONLY in one max_price component being 0; every control is byte-for-byte the gateway's request.
  if (Object.values(body.provider.max_price).includes(0)) { expect({ ...body, provider: { ...body.provider, max_price: runtime.provider && (runtime.provider as { max_price: unknown }).max_price } }).toEqual(runtime); continue; }
  expect(body).toEqual(runtime);
 }
 const control = bodies[0]!;
 expect(control.provider).toEqual({ order: [row.route], only: [row.route], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 1.5, completion: 7.5, request: 0 } });
 expect(bodies.slice(0, 3).map(b => b.reasoning)).toEqual([{ enabled: false }, { enabled: false }, { enabled: false }]);
 expect(bodies[3]!.reasoning).toEqual({ enabled: true, max_tokens: 1024 });
});

it.each([
 ["a price finer than a micro-USD per MTok", { ...PRICES, completion: "0.0000000000015", internal_reasoning: "0.0000000000015" }],
 ["a 13-decimal prompt price", { ...PRICES, prompt: "0.0000000000007" }],
])("A4: %s is refused by runtime_policy before any send (cause runtime_policy_refused, hold 0)", async (_name, pricing) => {
 const { report, bodies } = await run({ pricing });
 expect(bodies).toEqual([]);
 expect(report.failuresByCause.runtime_policy_refused).toBe(1);
 expect(report.preCallHoldsMicros).toBe(0);
 expect(report.proposedTariffRows).toEqual([]);
 expect(report.installSelection).toEqual({ installable: [], refused: [] });
});
it("A4b: the same model with a clean price qualifies (the refusal above is not vacuous)", async () => {
 expect((await run()).report.status).toBe("PASS");
});

it("A5: the control hold at the row ceiling equals an independent exact calculation (prompt bytes, 2048 output, request)", async () => {
 const { report, bodies } = await run({ pricing: { ...PRICES, request: "0.000004" } });
 const call = report.models[0]!.providers[0]!.calls[0]!;
 const promptBytes = Buffer.byteLength(JSON.stringify(bodies[0]));
 // micro-USD: prompt 1.5/token (max(prompt, read=1) + write 1 = 2.5 per prompt token), output 7.5/token * 2048, request 4.
 expect(call.holdMicros).toBe(Math.ceil(promptBytes * 2.5 + 2048 * 7.5 + 4));
});

it("A6 (ruling d): an extended id still qualifies in the harness as before, but the install selection refuses it", async () => {
 const { report } = await run({ id: "vendor/align-model:thinking" });
 expect(report.status).toBe("PASS");
 expect(report.installSelection.installable).toEqual([]);
 expect(report.installSelection.refused).toEqual([expect.objectContaining({ reason: "extended_id" })]);
});

it("S13: the report carries the install selection (a PROVEN, validator-clean row is chosen, bare, one per model)", async () => {
 const { report } = await run();
 expect(report.proposedTariffRows[0]!.status).toBe("PROVEN");
 expect(report.installSelection.installable).toHaveLength(1);
 expect(report.installSelection.installable[0]).toEqual(bare(report.proposedTariffRows[0]!));
 expect(report.installSelection.refused).toEqual([]);
});

// ---- Q1 (stricter scope): the ONE place the cache-write exception lives ----
const RELAXED = { prompt: "0.00000025", completion: "0.000002", request: "0", input_cache_read: "0.000000025" }; // real catalogue shape: write and reasoning ABSENT
it("E-R1: a relaxed-list id with an ABSENT write price, explicit zero request and a zero-residual bill is PROVEN with the runtime-enforced write proof", async () => {
 const { report } = await run({ id: "openai/gpt-5-mini", pricing: RELAXED });
 const row = report.proposedTariffRows[0]!;
 expect(row).toMatchObject({ cacheWriteBasis: "never_requested_enforced", cacheWriteEnforcementVersion: OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION, status: "PROVEN" });
 expect(row.zeroPriceProof.input_cache_write!.source).toBe(`runtime_enforced:${OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION}`);
 expect(row.zeroPriceProof.request!.source).toContain("zero residual");
 expect(report.installSelection.installable).toHaveLength(1);
 expect(openRouterPolicy(row.model, row.verifiedAt + 1, [bare(row) as never])).toBeDefined();
});
it("E-R2 (owner rule 2026-11-23): the same shape for a NON-relaxed id is PROVEN with the same basis, installable by the gateway's validator", async () => {
 const { report } = await run({ id: "vendor/not-relaxed", pricing: RELAXED });
 const row = report.proposedTariffRows[0]!;
 expect(row).toMatchObject({ cacheWriteBasis: "never_requested_enforced", cacheWriteEnforcementVersion: OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION, status: "PROVEN" });
 expect(row.zeroPriceProof.input_cache_write!.source).toBe(`runtime_enforced:${OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION}`);
 expect(report.installSelection.installable).toHaveLength(1);
 expect(openRouterPolicy(row.model, row.verifiedAt + 1, [bare(row) as never])).toMatchObject({ cacheWriteBasis: "never_requested_enforced", pricing: { input_cache_write: "0" } });
});
it("E-R3: a relaxed-list id whose catalogue states an EXPLICIT zero write price gets no basis and stays CANDIDATE", async () => {
 const { report } = await run({ id: "openai/gpt-5-mini", pricing: { ...RELAXED, input_cache_write: "0" } });
 const row = report.proposedTariffRows[0]!;
 expect(row).not.toHaveProperty("cacheWriteBasis"); expect(row.status).toBe("CANDIDATE");
});
it("E-R4: the rule itself: every condition is required (basis, CURRENT version, absent catalogue write price, zero reported writes on every call; ANY model)", () => {
 const call = { usage: { cache_write_tokens: 0 } };
 const good = { model: "openai/gpt-5-mini", cacheWriteBasis: "never_requested_enforced", cacheWriteEnforcementVersion: OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION, assumedZero: ["input_cache_write"] };
 const rule = ZERO_PROOF_RULES.cacheWriteRuntimeEnforced;
 expect(rule(good, [call, call])).toBe(true);
 expect(rule({ ...good, model: "vendor/other-model" }, [call])).toBe(true); // any model (owner rule 2026-11-23)
 expect(rule({ ...good, cacheWriteEnforcementVersion: "openrouter-no-cache-write-v0" }, [call])).toBe(false);
 expect(rule({ ...good, cacheWriteEnforcementVersion: undefined }, [call])).toBe(false);
 expect(rule({ ...good, cacheWriteBasis: "assumed" }, [call])).toBe(false);
 expect(rule({ ...good, assumedZero: [] }, [call])).toBe(false);
 expect(rule({ ...good, assumedZero: undefined }, [call])).toBe(false);
 expect(rule(good, [])).toBe(false);
 expect(rule(good, [call, { usage: { cache_write_tokens: 1 } }])).toBe(false);
 expect(rule(good, [call, { usage: { cache_write_tokens: null } }])).toBe(false);
 expect(rule(good, [call, { usage: {} }])).toBe(false);
 expect(ZERO_PROOF_RULES.assumedMayBeProven).toEqual(["request"]);
});
it("E-R5 (Q-B): the REAL gpt-5-mini catalogue shape (request, reasoning and write all ABSENT) is PROVEN: absent request from the exact bill + the zero wire cap, write from runtime enforcement; it is installable", async () => {
 const absentRequest: Record<string, string> = { ...RELAXED }; delete absentRequest.request;
 const { report, bodies } = await run({ id: "openai/gpt-5-mini", pricing: absentRequest });
 const row = report.proposedTariffRows[0]!;
 expect(row.status).toBe("PROVEN");
 expect(row.zeroPriceProof.request!.source).toContain("zero residual");
 expect(row.zeroPriceProof.input_cache_write!.source).toBe(`runtime_enforced:${OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION}`);
 expect((row as unknown as { assumedZero: string[] }).assumedZero).toEqual(expect.arrayContaining(["request", "input_cache_write"]));
 for (const body of bodies) expect(body.provider).toMatchObject({ order: [row.route], only: [row.route], allow_fallbacks: false, max_price: { request: 0 } });
 expect(report.installSelection.installable).toHaveLength(1);
 // The widening is exactly one component (no other absent price is ever proven).
 expect(ZERO_PROOF_RULES.assumedMayBeProven).toEqual(["request"]);
});
it("hold sanity: the runtime hold at the ceiling for the installed row is what the gateway would reserve", async () => {
 const { report } = await run();
 const row = report.proposedTariffRows[0]!;
 const policy = openRouterPolicy(row.model, row.verifiedAt + 1, [bare(row) as never])!;
 expect(openRouterHold(policy, 100_000, 2048)).toBe(Math.ceil(100_000 * 2.5 + 2048 * 7.5));
});
it("E-R6: a relaxed-list PASS (with its no-write basis) resumes without new spend, and an edited basis forces requalification", async () => {
 const first = await run({ id: "openai/gpt-5-mini", pricing: RELAXED });
 const next = await run({ id: "openai/gpt-5-mini", pricing: RELAXED, resumeReport: structuredClone(first.report) });
 expect(next.bodies).toEqual([]); expect(next.report.models[0]!.resumed).toBe(true);
 expect(next.report.proposedTariffRows[0]).toEqual(first.report.proposedTariffRows[0]);
 const forged = structuredClone(first.report); delete forged.proposedTariffRows[0]!.cacheWriteBasis;
 const requalified = await run({ id: "openai/gpt-5-mini", pricing: RELAXED, resumeReport: forged });
 expect(requalified.bodies.length).toBeGreaterThan(0);
});
