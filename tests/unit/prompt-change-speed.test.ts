import "./prompt-change-offline.js";
import { expect, it } from "vitest";
import { detectPromptChanges, detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
import type { PromptChangeResult } from "../../packages/contracts/src/prompt-change-detect.js";
import { expectLinearScaling } from "../support/scaling.js";
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
// Timing samples batch the SAME N-sized input when needed (scaling helper); N and 4N use equal batch counts.
// Deterministic work assertions always compare one scan, so batching cannot hide superlinear work.
const workBound = (result: PromptChangeResult) => {
  expect(result.stats).toBeDefined();
  expect(result.stats!.steps).toBeLessThanOrEqual(13 * (result.stats!.bytes + 1) + 10_000);
};
// timedMake / unitBytes / timedN describe ONLY the timed ratio check: expectLinearScaling refuses an 8N input over 256 KiB (it leaves the CPU cache and CI reads a steady ratio of about 25 for linear code), so the timed
// check runs on a small input while the deterministic work counts below always run at the full size and 4x.
const measurePair = (name: string, size: number, make: (n: number) => () => PromptChangeResult, timedN = size / 2, timedMake = make, unitBytes = 1) => {
  const small = make(size); const large = make(size * 4);
  const a = small(); const b = large();
  for (const result of [a, b]) {
    workBound(result);
    for (const reason of ["file_too_large", "total_too_large", "too_many_files"]) expect(result.report.incompleteReasons).not.toContain(reason);
    expect(result.stats!.scannedFiles).toBeGreaterThan(0);
    if (name === "nesting") expect(result.report.incompleteReasons).not.toContain("unreadable_diff");
  }
  expect(b.stats!.steps).toBeLessThanOrEqual(4.5 * a.stats!.steps);
  {
    // Time is a scaling check on top of the deterministic work counts above: the same scan at N and at 8N (8N is the old 4N size), fastest of several runs of each,
    // must not cost more than 24 times as much. There is no fixed millisecond bound: a slow runner makes both sizes slower, and the work counts above already refuse super-linear work exactly.
    const timed = expectLinearScaling(timedMake, { n: timedN, unitBytes, label: `prompt change scan: ${name}` });
    console.info(JSON.stringify({ corpus: name, N: timedN, batches: timed.batches, bytesN: a.stats!.bytes, stepsN: a.stats!.steps, steps4N: b.stats!.steps,
      msN: +timed.ms.toFixed(2), ms8N: +timed.msK.toFixed(2), ratio: +timed.ratio.toFixed(2) }));
    return { n: 0, four: 0 };
  }
  return { n: 0, four: 0 };
};
// The timed N is 8 KiB (8N = 64 KiB); the work counts above still run at 128 KiB and 512 KiB.
it.each(corpora)("linear adversarial scan: %s", (name, make) => {
  measurePair(name, 128 * 1024, make, 8 * 1024);
});


