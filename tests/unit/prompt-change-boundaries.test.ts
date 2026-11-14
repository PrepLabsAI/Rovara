import "./prompt-change-offline.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { detectPromptChanges, detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
import { PromptChangeItemSchema, PromptChangeReportSchema } from "../../packages/contracts/src/prompt-change.js";

it("has no production callers outside contracts and imports no effectful runtime APIs", () => {
  const pending = ["packages"]; const callers: string[] = [];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (new Set(["node_modules", "dist"]).has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(path, "utf8");
        if (!path.startsWith("packages/contracts/") && /(?:from|import)\s*\(?["'][^"']*prompt-change/u.test(source)) callers.push(path);
        if (path.startsWith("packages/contracts/src/prompt-change")) {
          expect(source).not.toMatch(/(?:node:(?:fs|http|https|net|child_process)|\bprocess\.|\bDate\.|\bMath\.random|\beval\(|new Function|\bimport\()/u);
        }
      }
    }
  }
  expect(callers).toEqual([]);
});
it("schema rejects inconsistent counts, refused-path references and variant fields", () => {
  const report = detectPromptChanges({ files: [{ path: "a.prompt", before: "old", after: "new", wholeFile: true }] }).report;
  for (const item of [
    { ...report.items[0], path: "path_refused" },
    { ...report.items[0], oldPath: "path_refused", verb: "renamed" },
    { ...report.items[0], verb: "renamed" },
    { ...report.items[0], before: "private" },
    { ...report.items[0], settingKey: "temperature" },
    { ...report.items[0], verb: "added" },
    { ...report.items[0], verb: "removed" },
    { ...report.items[0], fingerprintAfter: report.items[0]!.fingerprintBefore },
  ]) expect(PromptChangeItemSchema.safeParse(item).success).toBe(false);
  expect(PromptChangeReportSchema.safeParse({ ...report, counts: { ...report.counts, prompt_file: 0 } }).success).toBe(false);
  expect(PromptChangeReportSchema.safeParse({ ...report, status: "incomplete", coverage: "complete" }).success).toBe(false);
});
it("handles a hunkless prompt rename without inventing content fingerprints", () => {
  const report = detectPromptChangesInDiff("diff --git a/a.prompt b/b.prompt\nsimilarity index 100%\nrename from a.prompt\nrename to b.prompt\n").report;
  expect(report.items).toMatchObject([{ verb: "renamed", fingerprintBefore: null, fingerprintAfter: null }]);
  expect(report.coverage).toBe("hunks_only");
});
it("unsupported config aliases and malformed diffs cannot certify no changes", () => {
  const files = [{ path: "a.yaml", before: "", after: "base: &value\nclone: *value\n<<: *value", wholeFile: true }];
  expect(detectPromptChanges({ files }).report.coverage).toBe("partial");
  for (const source of ['diff --git "a/missing b/missing\n', 'diff --git "a/\\377.ts" "b/\\377.ts"\n', 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n', 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n+extra']) {
    expect(detectPromptChangesInDiff(source).report.coverage).toBe("partial");
  }
});
it("separate hunks retain unique stable IDs and after-side line numbers", () => {
  const source = "diff --git a/ai/a.ts b/ai/a.ts\n@@ -1 +10 @@\n-prompt: 'old1'\n+prompt: 'new1'\n@@ -20 +30 @@\n-prompt: 'old2'\n+prompt: 'new2'\n";
  const items = detectPromptChangesInDiff(source).report.items;
  expect(new Set(items.map((item) => item.id)).size).toBe(2);
  expect(items.map((item) => item.line).sort()).toEqual([10, 30]);
});
it("counts nested template holes toward the container depth limit", () => {
  const source = "[".repeat(60) + "prompt: `hello ${" + "{".repeat(5) + "0" + "}".repeat(6) + "`" + "]".repeat(60);
  expect(detectPromptChanges({ files: [{ path: "ai/a.ts", before: "", after: source, wholeFile: true }] }).report.coverage).toBe("partial");
});
it("does not lose changes in huge lists to spread-argument limits", () => {
  const count = 70_000;
  const report = detectPromptChanges({ files: [{ path: "a.py", before: "", after: "prompt='a';".repeat(count), wholeFile: true }] }).report;
  expect(report.counts.prompt_text).toBe(count);
  expect(report.itemsTruncated).toBe(true);
});
it("selectors inspect counts for prompt changes omitted from the truncated item list", async () => {
  const { promptChangesNeedSideBySide } = await import("../../packages/contracts/src/prompt-change.js");
  const files = Array.from({ length: 500 }, (_, i) => ({ path: `ai/${i}.ts`, before: "", after: "temperature: 1", wholeFile: true }));
  files.push({ path: "z.prompt", before: "old", after: "new", wholeFile: true });
  const report = detectPromptChanges({ files }).report;
  expect(report.items.every((item) => item.kind === "model_setting")).toBe(true);
  expect(promptChangesNeedSideBySide(report).needed).toBe(true);
});
it("digest covers fingerprints of omitted items as well as displayed items", () => {
  const files = Array.from({ length: 501 }, (_, i) => ({ path: `${String(i).padStart(4, "0")}.prompt`, before: "old", after: "new", wholeFile: true }));
  const before = detectPromptChanges({ files }).report;
  files[500]!.after = "different";
  const after = detectPromptChanges({ files }).report;
  expect(after.items).toEqual(before.items);
  expect(after.reportDigest).not.toBe(before.reportDigest);
});
it("does not trust caller-provided hunk text or offsets outside file-side caps", () => {
  const report = detectPromptChanges({ files: [{ path: "ai/a.ts", before: "", after: "prompt: 'public shape'", wholeFile: true, hunks: [{ before: "", after: "model: 'injected-model'", beforeLine: 1, afterLine: Infinity }] }] }).report;
  expect(report.counts.prompt_text).toBe(1);
  expect(report.counts.model_name).toBe(0);
  expect(PromptChangeReportSchema.safeParse(report).success).toBe(true);
});
it("refuses overflowing after-side line offsets", () => {
  const source = `diff --git a/ai/a.ts b/ai/a.ts\n@@ -1,2 +${Number.MAX_SAFE_INTEGER},2 @@\n context\n-old\n+prompt: 'new'\n`;
  const report = detectPromptChangesInDiff(source).report;
  expect(report.coverage).toBe("partial");
  expect(PromptChangeReportSchema.safeParse(report).success).toBe(true);
});
it.each(["added", "removed"])("diff detection respects %s file status", (status) => {
  const added = status === "added";
  const source = `diff --git a/a.prompt b/a.prompt\n${added ? "new" : "deleted"} file mode 100644\n@@ -${added ? "0,0" : "1"} +${added ? "1" : "0,0"} @@\n${added ? "+" : "-"}words\n`;
  expect(detectPromptChangesInDiff(source).report.items[0]?.verb).toBe(status);
});
it("refuses malformed runtime flags and statuses", () => {
  for (const extra of [{ wholeFile: "yes" }, { status: "unexpected" }]) {
    const files = [{ path: "a.ts", before: "", after: "", wholeFile: true, ...extra }];
    expect(detectPromptChanges({ files } as never).report.status).toBe("incomplete");
  }
});
it("keeps cap refusals deterministic when oversized metadata and binary files are shuffled", () => {
  const files = [{ path: "x".repeat(200), before: "", after: "", wholeFile: true }, { path: "binary", binary: true, wholeFile: true }];
  expect(detectPromptChanges({ files }, { maxTotalBytes: 100 }).report).toEqual(detectPromptChanges({ files: [...files].reverse() }, { maxTotalBytes: 100 }).report);
});
