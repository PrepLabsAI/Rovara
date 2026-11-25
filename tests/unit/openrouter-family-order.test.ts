// DEC 254zzz419: never more than OFFERED_MODELS_MAX (64) installable rows or offered OpenRouter models; over it the best-known families first, then the cheapest hold.
import { expect, it } from "vitest";
import { OFFERED_MODELS_MAX, offeredOpenRouterModels } from "../../packages/model-gateway/src/offered-models.js";
import { OPENROUTER_FAMILY_PREFIXES, openRouterCapOrder, openRouterFamilyRank, openRouterPolicy, type OpenRouterTariff } from "../../packages/model-gateway/src/openrouter-policy.js";
const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
type Row = Record<string, unknown> & { model: string; route: string };
type Selection = { installable: Row[]; refused: { model?: string; route?: string; reason: string }[] };
const { selectInstallRows } = await import(script) as { selectInstallRows: (rows: unknown) => Selection };
const at = Date.UTC(2026, 10, 23);
const base = { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000002", request: "0.000001", input_cache_read: "0.0000005", input_cache_write: "0.000001" };
/** `cents` makes the row dearer: completion and reasoning price = (2 + cents) micro-USD per token. */
const row = (model: string, cents = 0, over: Record<string, unknown> = {}): Row => {
 const price = ((2 + cents) / 1_000_000).toFixed(6);
 return { model, route: "r", pricing: { ...base, completion: price, internal_reasoning: price }, max_completion_tokens: 2048, reasoning: { mode: "bounded", max_tokens: 1024 }, verifiedAt: at, expiresAt: at + 86_400_000,
  evidence: "CANDIDATE ONLY: fixture", status: "PROVEN", observedModelIds: [model], zeroPriceProof: {}, assumedZero: [], reasoningBilledAtCompletion: true, ...over };
};
const FAMILIES = ["openai", "anthropic", "google", "mistralai", "meta-llama", "deepseek", "qwen"];
const names = (s: Selection) => s.installable.map(r => r.model);
const overCap = (s: Selection) => s.refused.filter(r => r.reason === "over_cap").map(r => r.model);
const others = (count: number, start = 0): Row[] => Array.from({ length: count }, (_, i) => row(`vendor/o${String(i).padStart(3, "0")}`, ((i + start) * 7) % 61));
/** A deterministic reshuffle that is not the input order. */
const shuffled = <T,>(rows: T[]): T[] => rows.map((r, i) => ({ r, k: (i * 37 + 11) % 997 })).sort((a, b) => a.k - b.k).map(x => x.r);
const asTariff = (r: Row): OpenRouterTariff => ({ model: r.model, route: r.route, pricing: r.pricing as never, max_completion_tokens: 2048, reasoning: { mode: "bounded", max_tokens: 1024 }, verifiedAt: at, expiresAt: at + 86_400_000, evidence: "x" });

it("F1: the cap is 64 and the family order is the owner's (a visible diff if either changes)", () => {
 expect(OFFERED_MODELS_MAX).toBe(64);
 expect(OPENROUTER_FAMILY_PREFIXES).toEqual(["openai/", "anthropic/", "google/", "mistralai/", "meta-llama/", "deepseek/", "qwen/"]);
 expect(["openai/gpt-x", "anthropic/c", "google/g", "mistralai/m", "meta-llama/l", "deepseek/d", "qwen/q", "vendor/z", "openaix/a", "x/openai/a"].map(openRouterFamilyRank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 7, 7]);
});
it.each([0, 1, 40, 63, 64])("F2: %i installable rows -> unchanged (model order, nothing over_cap)", count => {
 const rows = shuffled(Array.from({ length: count }, (_, i) => row(`${FAMILIES[i % 7]}/m${String(i).padStart(3, "0")}`, (i * 5) % 40)));
 const s = selectInstallRows(rows);
 expect(names(s)).toEqual(rows.map(r => r.model).sort());
 expect(overCap(s)).toEqual([]); expect(s.refused).toEqual([]);
});
it("F3: 65 rows of one family -> the 64 cheapest, the dearest is over_cap (and only it)", () => {
 const rows = shuffled(Array.from({ length: 65 }, (_, i) => row(`vendor/m${String(i).padStart(3, "0")}`, i)));
 const s = selectInstallRows(rows);
 expect(s.installable).toHaveLength(64);
 expect(names(s)).toEqual(Array.from({ length: 64 }, (_, i) => `vendor/m${String(i).padStart(3, "0")}`)); // cheapest first
 expect(s.refused).toEqual([{ model: "vendor/m064", route: "r", reason: "over_cap" }]);
});
it("F4: 65 rows where the DEAREST belongs to a best-known family -> it is kept, the dearest other model is dropped", () => {
 const rows = [...others(64), row("openai/gpt-dear", 500)];
 const s = selectInstallRows(rows);
 expect(names(s)[0]).toBe("openai/gpt-dear");
 expect(s.installable).toHaveLength(64);
 const dropped = overCap(s);
 expect(dropped).toHaveLength(1);
 expect(names(s)).not.toContain(dropped[0]);
 const dearestOther = others(64).sort((a, b) => Number((b.pricing as Record<string, string>).completion) - Number((a.pricing as Record<string, string>).completion) || (a.model < b.model ? 1 : -1))[0]!;
 expect(dropped[0]).toBe(dearestOther.model);
});
it("F5: 190 rows -> families first in the owner's order, cheapest first inside a family, then the cheapest others; dropped are over_cap", () => {
 const fam = FAMILIES.flatMap((f, fi) => Array.from({ length: 4 }, (_, i) => row(`${f}/x${i}`, (fi * 3 + i * 11) % 29))); // 28 family rows
 const rest = others(162); // 190 total
 const s = selectInstallRows(shuffled([...fam, ...rest]));
 expect(s.installable).toHaveLength(64);
 const expectedFamilies = FAMILIES.flatMap((f, fi) => Array.from({ length: 4 }, (_, i) => ({ model: `${f}/x${i}`, cents: (fi * 3 + i * 11) % 29 })).sort((a, b) => a.cents - b.cents || (a.model < b.model ? -1 : 1)).map(x => x.model));
 expect(names(s).slice(0, 28)).toEqual(expectedFamilies);
 const cheapestOthers = [...rest].sort((a, b) => Number((a.pricing as Record<string, string>).completion) - Number((b.pricing as Record<string, string>).completion) || (a.model < b.model ? -1 : 1)).slice(0, 36).map(r => r.model);
 expect(names(s).slice(28)).toEqual(cheapestOthers);
 expect(overCap(s)).toHaveLength(190 - 64);
 expect(new Set([...names(s), ...overCap(s)]).size).toBe(190);
});
it("F6: 70 family rows (10 each) -> the 64 are the first families in order; the 6 over_cap are the dearest of the LAST family", () => {
 const rows = FAMILIES.flatMap((f, fi) => Array.from({ length: 10 }, (_, i) => row(`${f}/x${i}`, (i * 3 + fi) % 30)));
 const s = selectInstallRows(shuffled(rows));
 const byFamily = (f: string) => names(s).filter(m => m.startsWith(`${f}/`));
 expect(names(s).map(m => m.split("/")[0])).toEqual(FAMILIES.flatMap(f => Array.from({ length: f === "qwen" ? 4 : 10 }, () => f)));
 expect(byFamily("qwen")).toHaveLength(4);
 const qwen = rows.filter(r => r.model.startsWith("qwen/")).sort((a, b) => Number((a.pricing as Record<string, string>).completion) - Number((b.pricing as Record<string, string>).completion) || (a.model < b.model ? -1 : 1)).map(r => r.model);
 expect(byFamily("qwen")).toEqual(qwen.slice(0, 4));
 expect(overCap(s)).toEqual(qwen.slice(4));
});
it("F7: the result does not depend on the input order, and equal prices fall back to the model name", () => {
 const rows = [...others(70), ...FAMILIES.map(f => row(`${f}/same`, 3)), row("openai/aaa", 3), row("openai/zzz", 3)];
 const a = selectInstallRows(rows); const b = selectInstallRows([...rows].reverse()); const c = selectInstallRows(shuffled(rows));
 expect(names(b)).toEqual(names(a)); expect(names(c)).toEqual(names(a));
 expect(names(a).slice(0, 3)).toEqual(["openai/aaa", "openai/same", "openai/zzz"]);
 expect(overCap(b).sort()).toEqual(overCap(a).sort());
});
it("F8: earlier refusals keep their own reason and do not count toward the cap", () => {
 const good = others(60); const bad = [row("vendor/ext:free"), row("vendor/cand", 0, { status: "CANDIDATE" }), row("Vendor/Upper"), row("vendor/bad-ceiling", 0, { max_completion_tokens: 1024 })];
 const twoRoutes = [row("vendor/two", 0, { route: "a" }), row("vendor/two", 9, { route: "b" })];
 const s = selectInstallRows([...good, ...bad, ...twoRoutes]); // 61 installable
 expect(s.installable).toHaveLength(61); expect(overCap(s)).toEqual([]);
 expect(s.refused.map(r => r.reason).sort()).toEqual(["extended_id", "offer_name", "route_not_chosen", "runtime_policy_refused", "unproven_zero:"]);
 // 66 installable AND the same four refusals: those reasons are unchanged, plus 2 over_cap (the dearest model is one of them).
 const t = selectInstallRows([...others(65), ...bad, row("vendor/z-extra", 99)]);
 expect(t.installable).toHaveLength(64);
 expect(t.refused.filter(r => r.reason !== "over_cap").map(r => r.reason).sort()).toEqual(["extended_id", "offer_name", "runtime_policy_refused", "unproven_zero:"]);
 expect(overCap(t)).toContain("vendor/z-extra");
 expect(overCap(t)).toHaveLength(2);
});
it("F9: the cap order itself: at or under max it is the input order and nothing is dropped; over it kept + dropped partition the input", () => {
 const policies = others(5).map(r => openRouterPolicy(r.model, at + 1, [asTariff(r)])!);
 expect(openRouterCapOrder(policies, 5)).toEqual({ kept: policies, dropped: [] });
 const two = openRouterCapOrder(policies, 2);
 expect(two.kept).toHaveLength(2); expect(two.dropped).toHaveLength(3);
 expect(new Set([...two.kept, ...two.dropped].map(p => p.model))).toEqual(new Set(policies.map(p => p.model)));
});
it("F10: the offered list caps at 64 in the SAME order and models as the install selection (the report, the tariff and the list stay identical)", () => {
 const fam = FAMILIES.flatMap((f, fi) => Array.from({ length: 5 }, (_, i) => row(`${f}/x${i}`, (fi * 3 + i * 11) % 29)));
 const rows = shuffled([...fam, ...others(155)]); // 190
 const s = selectInstallRows(rows);
 const tariffs = rows.map(asTariff);
 const list = offeredOpenRouterModels(tariffs, at + 1, tariffs);
 expect(list).toHaveLength(64);
 expect(list).toEqual(names(s));
});
it.each([0, 1, 63, 64])("F11: %i valid tariff rows -> every model, in the tariff's own order (unchanged)", count => {
 const rows = shuffled(Array.from({ length: count }, (_, i) => row(`${FAMILIES[i % 7]}/m${String(i).padStart(3, "0")}`, (i * 5) % 40)));
 const tariffs = rows.map(asTariff);
 expect(offeredOpenRouterModels(tariffs, at + 1, tariffs)).toEqual(rows.map(r => r.model));
});
it("F12: the offered list counts only rows valid NOW (an expired row does not take a slot) and never exceeds 64", () => {
 const rows = others(70);
 const tariffs = rows.map((r, i) => i < 10 ? { ...asTariff(r), expiresAt: at + 1000, verifiedAt: at } : asTariff(r));
 const list = offeredOpenRouterModels(tariffs, at + 5000, tariffs);
 expect(list).toHaveLength(60);
 expect(list).not.toContain(rows[0]!.model);
 expect(offeredOpenRouterModels(tariffs, at + 1, tariffs)).toHaveLength(64);
});
const filler = Array.from({ length: 63 }, (_, i) => row(`vendor/c${String(i).padStart(2, "0")}`));
const proof = { attempt: 1, source: "fixture", billed: "0", model: "x", totalCost: "0" };
// Two rows with the SAME hold at the common size; 63 cheaper rows fill the list, so the loser of the first differing key is the 65th row (over_cap).
it.each([
 ["key 3: the lower completion-class price wins", row("vendor/zz-win", 0, { pricing: { ...base, completion: "0.000002", internal_reasoning: "0.000002", request: "0.002048" } }), row("vendor/aa-lose", 0, { zeroPriceProof: { request: proof }, pricing: { ...base, completion: "0.000003", internal_reasoning: "0.000003", request: "0" } })],
 ["key 1: only the request fee differs -> the lower hold wins", row("vendor/zz-win", 0), row("vendor/aa-lose", 0, { pricing: { ...base, request: "0.000003" } })],
 ["key 1b: the hold is compared at ONE common output size, not each row's own ceiling", row("vendor/zz-win", 0), row("vendor/aa-lose", 0, { max_completion_tokens: 1500, pricing: { ...base, completion: "0.0000025", internal_reasoning: "0.0000025" } })],
 ["key 3 (reasoning is the dearer price)", row("vendor/zz-win", 0, { pricing: { ...base, completion: "0.000002", internal_reasoning: "0.000002", request: "0.002048" } }), row("vendor/aa-lose", 0, { zeroPriceProof: { request: proof }, pricing: { ...base, completion: "0.000001", internal_reasoning: "0.000003", request: "0" } })],
 ["key 3 (completion is the dearer price)", row("vendor/zz-win", 0, { pricing: { ...base, completion: "0.000002", internal_reasoning: "0.000002", request: "0.002048" } }), row("vendor/aa-lose", 0, { zeroPriceProof: { request: proof }, pricing: { ...base, completion: "0.000003", internal_reasoning: "0.000001", request: "0" } })],
 ["key 4: the lower prompt price wins", row("vendor/zz-win", 0, { pricing: { ...base, completion: "0.000040", internal_reasoning: "0.000040", prompt: "0.000001", input_cache_write: "0.000001" } }), row("vendor/aa-lose", 0, { zeroPriceProof: { input_cache_write: proof }, pricing: { ...base, completion: "0.000040", internal_reasoning: "0.000040", prompt: "0.000002", input_cache_write: "0" } })],
 ["key 5: the lower (stricter) ceiling wins", row("vendor/zz-win", 0, { max_completion_tokens: 1500, pricing: { ...base, completion: "0.000040", internal_reasoning: "0.000040" } }), row("vendor/aa-lose", 0, { max_completion_tokens: 2048, pricing: { ...base, completion: "0.000040", internal_reasoning: "0.000040" } })],
] as const)("F13 (%s): the loser, though it sorts FIRST by name, is the one dropped over_cap", (_name, win, lose) => {
 const s = selectInstallRows([...filler, win, lose]);
 expect(s.installable).toHaveLength(64);
 expect(names(s)).toContain("vendor/zz-win"); expect(overCap(s)).toEqual(["vendor/aa-lose"]);
 expect(overCap(selectInstallRows([lose, win, ...filler]))).toEqual(["vendor/aa-lose"]);
});
