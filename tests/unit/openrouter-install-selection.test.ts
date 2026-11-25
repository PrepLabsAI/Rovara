// Rulings (c) tie-break, (d) extended ids refused, (e) only PROVEN rows, plus the offer-name and runtime-policy refusals of the install selection.
import { expect, it } from "vitest";
import { openRouterPolicy, openRouterHold } from "../../packages/model-gateway/src/openrouter-policy.js";
const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
type Row = Record<string, unknown> & { model: string; route: string };
type Selection = { installable: Row[]; refused: { model?: string; route?: string; reason: string }[] };
const { selectInstallRows, REFERENCE_PROMPT_TOKENS } = await import(script) as { selectInstallRows: (rows: unknown) => Selection; REFERENCE_PROMPT_TOKENS: number };
const at = Date.UTC(2026, 10, 23);
const base = { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000002", request: "0.000001", input_cache_read: "0.0000005", input_cache_write: "0.000001" };
const proof = { attempt: 1, source: "fixture", billed: "0", model: "x", totalCost: "0" };
const row = (route: string, over: Record<string, unknown> = {}, pricing: Record<string, string> = {}, model = "vendor/model-a"): Row => ({
 model, route, pricing: { ...base, ...pricing }, max_completion_tokens: 2048, reasoning: { mode: "bounded", max_tokens: 1024 }, verifiedAt: at, expiresAt: at + 86_400_000,
 evidence: "CANDIDATE ONLY: fixture", status: "PROVEN", observedModelIds: [model], zeroPriceProof: {}, assumedZero: [], reasoningBilledAtCompletion: true, ...over,
});
const BARE = ["model", "route", "pricing", "max_completion_tokens", "reasoning", "verifiedAt", "expiresAt", "evidence"];
const bareOf = (r: Row): never => Object.fromEntries(Object.entries(r).filter(([key]) => BARE.includes(key))) as never;
const only = (rows: Row[]) => selectInstallRows(rows).installable.map(r => r.route);
const reasonOf = (selection: Selection, route: string) => selection.refused.find(r => r.route === route)?.reason;

it("S1/S14: one surviving route is chosen and returned as the bare row the gateway source holds (no harness-only evidence)", () => {
 const selection = selectInstallRows([row("only-route")]);
 expect(selection.installable).toHaveLength(1);
 expect(Object.keys(selection.installable[0]!).sort()).toEqual(["evidence", "expiresAt", "max_completion_tokens", "model", "pricing", "reasoning", "route", "verifiedAt"]);
 expect(openRouterPolicy("vendor/model-a", at + 1, selection.installable as never)).toBeDefined();
 expect(selection.refused).toEqual([]);
});
it("S2: two PASS routes -> the cheaper one at the common output size, in every input order (the model is never refused)", () => {
 const cheap = row("cheap", {}, { completion: "0.000002", internal_reasoning: "0.000002" });
 const dear = row("dear", {}, { completion: "0.000003", internal_reasoning: "0.000003" });
 for (const rows of [[cheap, dear], [dear, cheap]]) { const s = selectInstallRows(rows); expect(s.installable.map(r => r.route)).toEqual(["cheap"]); expect(reasonOf(s, "dear")).toBe("route_not_chosen"); }
});
it("S2b: the first key compares PRICE at ONE common size, not each row's own ceiling (a cheaper route with the higher ceiling wins)", () => {
 const a = row("a-cheap-high-ceiling", { max_completion_tokens: 2048 }, { completion: "0.000002", internal_reasoning: "0.000002" });
 const b = row("b-dear-low-ceiling", { max_completion_tokens: 1500 }, { completion: "0.0000025", internal_reasoning: "0.0000025" });
 // Own-ceiling holds would pick b (1500 * 2.5 < 2048 * 2): the mistake this test pins.
 for (const rows of [[a, b], [b, a]]) expect(only(rows)).toEqual(["a-cheap-high-ceiling"]);
 // The independent check: at ONE common size (1500) route a really is the cheaper hold; at its own ceiling it is not.
 const holdOf = (r: Row, size: number) => openRouterHold(openRouterPolicy("vendor/model-a", at + 1, [bareOf(r)])!, REFERENCE_PROMPT_TOKENS, size);
 expect(holdOf(a, 1500)).toBeLessThan(holdOf(b, 1500));
 expect(holdOf(b, 1500)).toBeLessThan(holdOf(a, 2048));
});
it("S2c: only the request fee differs -> the lower hold wins (key 1), though its route tag sorts last", () => {
 const dear = row("a-dear-request", {}, { request: "0.000003" }); const cheap = row("z-cheap-request", {}, { request: "0.000001" });
 for (const rows of [[dear, cheap], [cheap, dear]]) expect(only(rows)).toEqual(["z-cheap-request"]);
});
it("S3: equal holds -> the lower completion-class price wins (key 2)", () => {
 // Equal hold at 2048 output: 2048 * 2e-6 + 0.002048 request == 2048 * 3e-6 + 0 request.
 // The winner sorts LAST by route tag, so only key (2) can pick it.
 const a = row("z-low-output-high-request", {}, { completion: "0.000002", internal_reasoning: "0.000002", request: "0.002048" });
 const b = row("a-high-output-zero-request", { zeroPriceProof: { request: proof } }, { completion: "0.000003", internal_reasoning: "0.000003", request: "0" });
 for (const rows of [[a, b], [b, a]]) expect(only(rows)).toEqual(["z-low-output-high-request"]);
});
it("S4: equal hold and output price -> the lower prompt price wins (key 3)", () => {
 const a = row("z-low-prompt", {}, { prompt: "0.000001", input_cache_write: "0.000001" });
 const b = row("a-high-prompt", { zeroPriceProof: { input_cache_write: proof } }, { prompt: "0.000002", input_cache_write: "0" });
 for (const rows of [[a, b], [b, a]]) expect(only(rows)).toEqual(["z-low-prompt"]);
});
it("S5: all prices equal -> the stricter (lower) ceiling wins (key 4); S6: a full tie -> route tag by code-point order (key 5)", () => {
 const hi = row("a-high", { max_completion_tokens: 2048 }); const lo = row("z-low", { max_completion_tokens: 1500 });
 for (const rows of [[hi, lo], [lo, hi]]) expect(only(rows)).toEqual(["z-low"]);
 const x = row("b-route"); const y = row("a-route");
 for (const rows of [[x, y], [y, x]]) expect(only(rows)).toEqual(["a-route"]);
});
it("S7: a cheaper route that is only CANDIDATE never beats a PROVEN dearer one, and the model is not refused", () => {
 const cheapCandidate = row("cheap", { status: "CANDIDATE" }, { completion: "0.0000015", internal_reasoning: "0.0000015" });
 const dearProven = row("dear", {}, { completion: "0.000003", internal_reasoning: "0.000003" });
 const s = selectInstallRows([cheapCandidate, dearProven]);
 expect(s.installable.map(r => r.route)).toEqual(["dear"]);
 expect(reasonOf(s, "cheap")).toMatch(/^unproven_zero:/u);
});
it("S8: no usable route -> the model is absent and every route lists its reason", () => {
 const s = selectInstallRows([row("a", { status: "CANDIDATE" }), row("b", {}, { prompt: "0.0000000000001" })]);
 expect(s.installable).toEqual([]);
 expect(reasonOf(s, "a")).toMatch(/^unproven_zero:/u);
 expect(reasonOf(s, "b")).toBe("runtime_policy_refused");
});
it.each(["vendor/model:thinking", "~vendor/model", "vendor/model:free"])("S9 (ruling d): extended id %s is refused even when PROVEN", model => {
 const s = selectInstallRows([row("r", {}, {}, model)]);
 expect(s.installable).toEqual([]); expect(reasonOf(s, "r")).toBe("extended_id");
});
it("S10 (ruling e): a CANDIDATE row, and a PROVEN label with a zero component that has no proof, are refused with the unproven keys", () => {
 expect(reasonOf(selectInstallRows([row("c", { status: "CANDIDATE" }, { request: "0", input_cache_write: "0" })]), "c")).toBe("unproven_zero:request,input_cache_write");
 expect(reasonOf(selectInstallRows([row("forged", { status: "PROVEN", zeroPriceProof: { request: proof } }, { request: "0", input_cache_write: "0" })]), "forged")).toBe("unproven_zero:input_cache_write");
 expect(only([row("ok", { zeroPriceProof: { request: proof, input_cache_write: proof } }, { request: "0", input_cache_write: "0" })])).toEqual(["ok"]);
});
it.each([
 ["a ceiling not above the reasoning bound", { max_completion_tokens: 1024 }, {}],
 ["reasoning below 1024", { reasoning: { mode: "bounded", max_tokens: 256 } }, {}],
 ["a price finer than a micro-USD per MTok", {}, { completion: "0.0000000000015", internal_reasoning: "0.0000000000015" }],
 ["a zero prompt price", { zeroPriceProof: { prompt: proof } }, { prompt: "0" }],
 ["a stripped row with a bad route", { route: "" }, {}],
] as const)("S11: the gateway's own validator refuses %s -> runtime_policy_refused", (_name, over, pricing) => {
 const r = row("r", over, pricing);
 const s = selectInstallRows([r]);
 expect(s.installable).toEqual([]); expect(s.refused[0]!.reason).toBe("runtime_policy_refused");
});
it("S12: the reference prompt size is pinned (a change is a visible diff)", () => { expect(REFERENCE_PROMPT_TOKENS).toBe(100000); });
it.each([["uppercase vendor", "Vendor/model-a"], ["uppercase model", "vendor/Model-A"], ["a half over 63 characters", `vendor/${"m".repeat(64)}`]])("S15 (offer name): %s cannot be offered, so it is refused offer_name even though the gateway validator accepts it", (_name, model) => {
 // The validator itself accepts these ids (so the refusal below is the offer-name check, not the policy):
 expect(openRouterPolicy(model, at + 1, [bareOf(row("r", {}, {}, model))])).toBeDefined();
 const s = selectInstallRows([row("r", {}, {}, model)]);
 expect(s.installable).toEqual([]); expect(reasonOf(s, "r")).toBe("offer_name");
 expect(only([row("r", {}, {}, "vendor/model-a")])).toEqual(["r"]);
});
it("S16: models are independent (each picks its own route) and the output order is by model", () => {
 const s = selectInstallRows([row("z", {}, {}, "vendor/zeta"), row("b2", {}, { completion: "0.000003", internal_reasoning: "0.000003" }, "vendor/alpha"), row("b1", {}, {}, "vendor/alpha")]);
 expect(s.installable.map(r => `${r.model}:${r.route}`)).toEqual(["vendor/alpha:b1", "vendor/zeta:z"]);
});
