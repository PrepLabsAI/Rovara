import "./prompt-change-offline.js";
import { expect, it } from "vitest";
import { detectPromptChanges, detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
import { sourceMode } from "../../packages/contracts/src/prompt-change-rules.js";
import type { PromptChangeResult } from "../../packages/contracts/src/prompt-change-detect.js";
const MiB = 1024 * 1024;
const source = (text: string, path = "ai/a.ts") => detectPromptChanges({ files: [{ path, before: "", after: text, wholeFile: true }] }, { stats: true });
const repeat = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit))).slice(0, Math.floor(bytes / (Buffer.byteLength(unit) / unit.length)));
const corpora: Array<[string, (n: number) => () => PromptChangeResult]> = [
  ["nested retrieval", (n) => { const text = "retrieval: {".repeat(48) + "value: '" + "a".repeat(n) + "'" + "}".repeat(48); return () => source(text); }],
  ["retrieval config", (n) => { const text = "retrieval: {collection_name: '" + "a".repeat(n) + "'}"; return () => source(text); }],
  ["context examples", (n) => { const text = "examples: ['" + "a".repeat(n) + "']"; return () => source(text); }],
  ["output schema", (n) => { const text = "response_schema: {description: '" + "a".repeat(n) + "'}"; return () => source(text); }],
  ["provider literal", (n) => { const text = "provider: '" + "a".repeat(n) + "'"; return () => source(text); }],
  ["message builder", (n) => { const text = "function buildMessages(x) { return ['" + "a".repeat(n) + "']; }"; return () => source(text); }],
  ["minified literals", (n) => { const text = repeat('const a="abc";', n); return () => source(text); }],
  ["unterminated triples", (n) => { const text = "prompt = '''" + "a".repeat(n - 12); return () => source(text, "ai/a.py"); }],
  ["nesting", (n) => { const unit = "[{other:0}],"; const text = unit.repeat(Math.floor(n / unit.length)); return () => source(text); }],
  ["backslashes", (n) => { const text = 'prompt="' + "\\".repeat(n - 10) + '"'; return () => source(text); }],
  ["escaped quotes", (n) => { const text = repeat('\\"', n); return () => source(text); }],
  ["template holes", (n) => { const text = "prompt=`" + repeat("${", n - 8); return () => source(text); }],
  ["spaces then key", (n) => { const text = " ".repeat(n - 12) + "prompt: 'x'"; return () => source(text); }],
  ["tiny files", (n) => { const files = Array.from({ length: Math.floor(400 * n / (128 * 1024)) }, (_, i) => ({ path: `${i}.ts`, before: "", after: "", wholeFile: true })); return () => detectPromptChanges({ files }, { stats: true }); }],
  ["many hunks", (n) => { const text = "diff --git a/ai/a.ts b/ai/a.ts\n" + repeat("@@ -1 +1 @@\n-a\n+b\n", n); return () => detectPromptChangesInDiff(text, { stats: true }); }],
  ["bounded filename", (n) => { const path = "x".repeat(Math.floor(n / 256)) + ".prompt"; return () => source("new", path); }],
  ["CR-only diff", (n) => { const text = "diff --git a/a.prompt b/a.prompt\n@@ -1 +1 @@\n-old\n+" + repeat("text\rdiff --git ", n) + "\n"; return () => detectPromptChangesInDiff(text, { stats: true }); }],
  ["Unicode format bidi", (n) => { const text = repeat("\u200b\u202e", n); return () => source(text, "a.prompt"); }],
  ["keys without values", (n) => { const text = repeat("prompt temperature tools model ", n); return () => source(text); }],
];
// Timing samples batch the SAME N-sized input when needed; N and 4N use equal batch counts.
// Deterministic work assertions always compare one scan, so batching cannot hide superlinear work.
const workBound = (result: PromptChangeResult) => {
  expect(result.stats).toBeDefined();
  expect(result.stats!.steps).toBeLessThanOrEqual(13 * (result.stats!.bytes + 1) + 10_000);
};
const measurePair = (name: string, size: number, make: (n: number) => () => PromptChangeResult) => {
  const small = make(size); const large = make(size * 4);
  const a = small(); const b = large();
  for (const result of [a, b]) {
    workBound(result);
    for (const reason of ["file_too_large", "total_too_large", "too_many_files"]) expect(result.report.incompleteReasons).not.toContain(reason);
    expect(result.stats!.scannedFiles).toBeGreaterThan(0);
    if (name === "nesting") expect(result.report.incompleteReasons).not.toContain("unreadable_diff");
  }
  expect(b.stats!.steps).toBeLessThanOrEqual(4.5 * a.stats!.steps);
  const sample = (run: () => PromptChangeResult, batches: number) => {
    const start = performance.now();
    for (let i = 0; i < batches; i++) run();
    return performance.now() - start;
  };
  let batches = 1;
  while (sample(small, batches) < 8 && batches < 4096) batches *= 2;
  const median = (run: () => PromptChangeResult) => {
    sample(run, batches); // warm-up
    return Array.from({ length: 5 }, () => sample(run, batches)).sort((x, y) => x - y)[2]!;
  };
  const n = median(small); const four = median(large);
  console.info(JSON.stringify({ corpus: name, N: size, batches, bytesN: a.stats!.bytes, stepsN: a.stats!.steps, steps4N: b.stats!.steps,
    msN: +n.toFixed(2), ms4N: +four.toFixed(2), ratio: +(four / n).toFixed(2) }));
  expect(n).toBeGreaterThan(1);
  expect(four).toBeLessThanOrEqual(8 * n + 50);
  return { n: n / batches, four: four / batches };
};
it.each(corpora)("linear adversarial scan: %s", (name, make) => {
  const { n } = measurePair(name, 128 * 1024, make);
  expect(n).toBeLessThan(1000);
});
it("scales actual scanned files and bounds a 5000-file 32 MiB diff", () => {
  const one = "prompt: '" + "a".repeat(MiB - 12) + "'";
  const make = (count: number) => () => detectPromptChanges({ files: Array.from({ length: count }, (_, i) => ({ path: `ai/${i}.ts`, before: "", after: one, wholeFile: true })) }, { stats: true });
  const { n } = measurePair("four scanned files", 1, make);
  expect(n).toBeLessThan(1000);
  const chunk = "x".repeat(6600); const diff = Array.from({ length: 5000 }, (_, i) => `diff --git a/${i}.ts b/${i}.ts\n@@ -1 +1 @@\n-old\n+${chunk}\n`).join("");
  const start = performance.now(); const report = detectPromptChangesInDiff(diff).report;
  expect(performance.now() - start).toBeLessThan(10_000); expect(report.coverage).toBe("partial");
});
it("long ancestor identifiers cannot multiply token work", () => {
  const report = source("x".repeat(100_000) + " = {" + "other: 1,".repeat(20_000) + "}");
  expect(report.stats!.steps).toBeLessThanOrEqual(128 * (report.stats!.bytes + 1) + 10_000);
});

it.each(["env suffix", "path times hunks", "deep nesting"])("review scaling below caps: %s", (name) => {
  const make = (n: number) => () => {
    if (name === "env suffix") return source("prompt: 'new'", ".env".repeat(n) + "/x");
    if (name === "deep nesting") return source("[".repeat(60) + "0,".repeat(n * 8) + "]".repeat(60));
    const path = ".env".repeat(n) + ".ts";
    const diff = `diff --git a/${path} b/${path}\n` + "@@ -1 +1 @@\n-a\n+b\n".repeat(n * 8);
    return detectPromptChangesInDiff(diff, { stats: true });
  };
  const { four } = measurePair(name, 240, make);
  expect(four).toBeLessThan(300);
});

it("env basename classifier stays linear within the path byte cap", () => {
  const measure = (n: number) => {
    const path = ".env".repeat(n) + "/x";
    const times: number[] = [];
    for (let sample = 0; sample < 6; sample++) {
      const start = performance.now();
      for (let i = 0; i < 256; i++) expect(sourceMode(path)).toBe("other");
      if (sample > 0) times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[2]!;
  };
  const n = measure(240); const four = measure(960);
  expect(four).toBeLessThanOrEqual(8 * n + 50);
});
