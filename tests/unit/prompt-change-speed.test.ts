import "./prompt-change-offline.js";
import { expect, it } from "vitest";
import { detectPromptChanges, detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
import { sourceMode } from "../../packages/contracts/src/prompt-change-rules.js";
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
  ["tiny files", (n) => { const files = Array.from({ length: Math.floor(400 * n / (128 * 1024)) }, (_, i) => ({ path: `${i}.ts`, before: "", after: "", wholeFile: true })); return () => detectPromptChanges({ files }, { stats: true }); }],
  ["many hunks", (n) => { const text = "diff --git a/ai/a.ts b/ai/a.ts\n" + repeat("@@ -1 +1 @@\n-a\n+b\n", n); return () => detectPromptChangesInDiff(text, { stats: true }); }],
  ["bounded filename", (n) => { const path = "x".repeat(Math.floor(n / 256)) + ".prompt"; return () => source("new", path); }],
  ["CR-only diff", (n) => { const text = "diff --git a/a.prompt b/a.prompt\n@@ -1 +1 @@\n-old\n+" + repeat("text\rdiff --git ", n) + "\n"; return () => detectPromptChangesInDiff(text, { stats: true }); }],
  ["Unicode format bidi", (n) => { const text = repeat("\u200b\u202e", n); return () => source(text, "a.prompt"); }],
  ["keys without values", (n) => { const text = repeat("prompt temperature tools model ", n); return () => source(text); }],
];
const median = (run: () => PromptChangeResult) => {
  run(); const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now(); const result = run(); times.push(performance.now() - start);
    expect(result.stats).toBeDefined();
    expect(result.stats!.steps).toBeLessThanOrEqual(128 * (result.stats!.bytes + 1) + 10_000);
  }
  return times.sort((a, b) => a - b)[2]!;
};
it.each(corpora)("linear adversarial scan: %s", (name, make) => {
  const size = 128 * 1024;
  for (const factor of [1, 4]) {
    const result = make(size * factor)();
    expect(result.report.incompleteReasons).not.toEqual(expect.arrayContaining(["file_too_large"]));
    expect(result.report.incompleteReasons).not.toContain("total_too_large");
    expect(result.report.incompleteReasons).not.toContain("too_many_files");
    expect(result.stats!.scannedFiles).toBeGreaterThan(0);
  }
  const n = median(make(size)); const four = median(make(4 * size));
  console.info(JSON.stringify({ corpus: name, N: 128 * 1024, msN: +n.toFixed(2), ms4N: +four.toFixed(2), ratio: +(four / Math.max(n, 0.001)).toFixed(2) }));
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
  const size = 240;
  for (const factor of [1, 4]) {
    const result = make(size * factor)();
    expect(result.stats!.scannedFiles).toBe(1);
    expect(result.report.incompleteReasons).not.toContain("file_too_large");
    expect(result.report.incompleteReasons).not.toContain("total_too_large");
  }
  const n = median(make(size)); const four = median(make(size * 4));
  console.info(JSON.stringify({ corpus: name, N: size, msN: +n.toFixed(2), ms4N: +four.toFixed(2), ratio: +(four / Math.max(n, 0.001)).toFixed(2) }));
  expect(four).toBeLessThanOrEqual(8 * n + 50);
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
