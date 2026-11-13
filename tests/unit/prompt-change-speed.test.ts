import "./prompt-change-offline.js";
import { expect, it } from "vitest";
import { detectPromptChanges, detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
import type { PromptChangeResult } from "../../packages/contracts/src/prompt-change-detect.js";
const MiB = 1024 * 1024;
const source = (text: string, path = "ai/a.ts") => detectPromptChanges({ files: [{ path, before: "", after: text, wholeFile: true }] }, { stats: true });
const repeat = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit))).slice(0, Math.floor(bytes / (Buffer.byteLength(unit) / unit.length)));
const corpora: Array<[string, (n: number) => () => PromptChangeResult]> = [
  ["minified literals", (n) => { const text = repeat('const a="abc";', n); return () => source(text); }],
  ["unterminated triples", (n) => { const text = "prompt = '''" + "a".repeat(n - 12); return () => source(text, "ai/a.py"); }],
  ["nesting", (n) => { const text = repeat("{[", n); return () => source(text); }],
  ["backslashes", (n) => { const text = 'prompt="' + "\\".repeat(n - 10) + '"'; return () => source(text); }],
  ["escaped quotes", (n) => { const text = repeat('\\"', n); return () => source(text); }],
  ["template holes", (n) => { const text = "prompt=`" + repeat("${", n - 8); return () => source(text); }],
  ["spaces then key", (n) => { const text = " ".repeat(n - 12) + "prompt: 'x'"; return () => source(text); }],
  ["tiny files", (n) => { const files = Array.from({ length: Math.floor(100_000 * n / MiB) }, (_, i) => ({ path: `${i}.ts`, before: "", after: "", wholeFile: true })); return () => detectPromptChanges({ files }, { stats: true }); }],
  ["many hunks", (n) => { const text = "diff --git a/ai/a.ts b/ai/a.ts\n" + repeat("@@ -1 +1 @@\n-a\n+b\n", n); return () => detectPromptChangesInDiff(text, { stats: true }); }],
  ["huge filename", (n) => { const path = "x".repeat(n) + ".prompt"; return () => source("new", path); }],
  ["CR-only diff", (n) => { const text = repeat("diff --git a/a.ts b/a.ts\rold mode 100644\rnew mode 100755\r", n); return () => detectPromptChangesInDiff(text, { stats: true }); }],
  ["Unicode format bidi", (n) => { const text = repeat("\u200b\u202e", n); return () => source(text, "a.prompt"); }],
  ["keys without values", (n) => { const text = repeat("prompt temperature tools model ", n); return () => source(text); }],
];
const median = (run: () => PromptChangeResult) => {
  run(); const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now(); const result = run(); times.push(performance.now() - start);
    expect(result.stats).toBeDefined();
    expect(result.stats!.steps).toBeLessThanOrEqual(2048 * (result.stats!.bytes + 1) + 100_000);
  }
  return times.sort((a, b) => a - b)[2]!;
};
it.each(corpora)("linear adversarial scan: %s", (name, make) => {
  const n = median(make(MiB)); const four = median(make(4 * MiB));
  console.info(JSON.stringify({ corpus: name, N: MiB, msN: +n.toFixed(2), ms4N: +four.toFixed(2), ratio: +(four / Math.max(n, 0.001)).toFixed(2) }));
  expect(four).toBeLessThanOrEqual(8 * n + 50);
  expect(n).toBeLessThan(1000);
});
it("scales actual scanned files and bounds a 5000-file 32 MiB diff", () => {
  const one = "prompt: '" + "a".repeat(MiB - 12) + "'";
  const make = (count: number) => () => detectPromptChanges({ files: Array.from({ length: count }, (_, i) => ({ path: `ai/${i}.ts`, before: "", after: one, wholeFile: true })) }, { stats: true });
  const n = median(make(1)); const four = median(make(4)); console.info(JSON.stringify({ corpus: "four scanned files", N: MiB, msN: +n.toFixed(2), ms4N: +four.toFixed(2), ratio: +(four / n).toFixed(2) })); expect(four).toBeLessThanOrEqual(8 * n + 50);
  const chunk = "x".repeat(6600); const diff = Array.from({ length: 5000 }, (_, i) => `diff --git a/${i}.ts b/${i}.ts\n@@ -1 +1 @@\n-old\n+${chunk}\n`).join("");
  const start = performance.now(); const report = detectPromptChangesInDiff(diff).report;
  expect(performance.now() - start).toBeLessThan(10_000); expect(report.coverage).toBe("partial");
});
it("long ancestor identifiers cannot multiply token work", () => {
  const report = source("x".repeat(100_000) + " = {" + "other: 1,".repeat(20_000) + "}");
  expect(report.stats!.steps).toBeLessThanOrEqual(2048 * (report.stats!.bytes + 1) + 100_000);
});
