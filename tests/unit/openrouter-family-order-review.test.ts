// Opus money review of 9c284988d (DEC 254zzz419): pins the vendor-segment-only family match and the exact over-cap install rows.
import { expect, it } from "vitest";
import { openRouterFamilyRank } from "../../packages/model-gateway/src/openrouter-policy.js";
const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
type Row = Record<string, unknown> & { model: string; route: string };
type Selection = { installable: Record<string, unknown>[]; refused: { model?: string; route?: string; reason: string }[] };
const { selectInstallRows } = await import(script) as { selectInstallRows: (rows: unknown) => Selection };
const at = Date.UTC(2026, 10, 23);
const base = { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000002", request: "0.000001", input_cache_read: "0.0000005", input_cache_write: "0.000001" };
const row = (model: string, cents = 0): Row => {
 const price = ((2 + cents) / 1_000_000).toFixed(6);
 return { model, route: "r", pricing: { ...base, completion: price, internal_reasoning: price }, max_completion_tokens: 2048, reasoning: { mode: "bounded", max_tokens: 1024 }, verifiedAt: at, expiresAt: at + 86_400_000,
  evidence: "CANDIDATE ONLY: fixture", status: "PROVEN", observedModelIds: [model], zeroPriceProof: {}, assumedZero: [], reasoningBilledAtCompletion: true };
};
it("R-1: family match is the exact lowercase vendor segment only (no case folding, no substring, no look-alike vendor)", () => {
 for (const id of ["OpenAI/gpt-x", "ANTHROPIC/c", "openai-clone/gpt", "notopenai/gpt", "openai.evil/gpt", "vendor/openai-gpt", "vendor/anthropic", "qwenx/q", "meta/llama", "mistral/m", "google-ai/g"]) expect([id, openRouterFamilyRank(id)]).toEqual([id, 7]);
});
it("R-2: over the cap each installed row is exactly the row the under-cap path would install (the stripped tariff row: no policy hash, no defaulted prices)", () => {
 const rows = [...Array.from({ length: 66 }, (_, i) => row(`vendor/o${String(i).padStart(3, "0")}`, i % 13)), row("openai/a", 40)];
 const s = selectInstallRows(rows);
 expect(s.installable).toHaveLength(64);
 for (const installed of s.installable) {
  expect(Object.hasOwn(installed, "hash")).toBe(false);
  expect(installed).toEqual(selectInstallRows([rows.find(r => r.model === installed.model)]).installable[0]);
 }
});
