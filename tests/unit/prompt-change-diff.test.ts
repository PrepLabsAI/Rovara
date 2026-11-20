import "./prompt-change-offline.js";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseUnifiedDiff } from "../../packages/contracts/src/prompt-change-diff.js";
import { detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
it.each(["[workspace diff truncated", "garbage"])("fails closed on incomplete input", (source) => {
  const report = detectPromptChangesInDiff(source).report;
  expect(report.coverage).toBe("partial");
  expect(report.status).toBe("incomplete");
});
it("marks binary and hunkless diff as incomplete and empty diff as hunks only", () => {
  expect(detectPromptChangesInDiff('diff --git a/a b/a\nBinary files a/a and b/a differ\n').report.incompleteReasons).toContain("binary_file");
  expect(detectPromptChangesInDiff("").report.status).toBe("incomplete");
});
it("reads a small actual repository-history diff without interpreting documentation as source", () => {
  const source = readFileSync(new URL("../fixtures/prompt-change/history.diff", import.meta.url), "utf8");
  const parsed = parseUnifiedDiff(source);
  expect(parsed.files.map((f) => f.path)).toContain("README.md");
  expect(parsed.incompleteReasons).toEqual(["hunks_only"]);
  expect(detectPromptChangesInDiff(source).report.items).toEqual([]);
});
it("caps diff text before parsing and caps kept file entries", () => {
  expect(parseUnifiedDiff("x".repeat(100), { maxTotalBytes: 99 }).incompleteReasons).toContain("total_too_large");
  expect(parseUnifiedDiff("é".repeat(50), { maxTotalBytes: 99 }).incompleteReasons).toContain("total_too_large");
  const source = ['a', 'b'].map((name) => `diff --git a/${name}.prompt b/${name}.prompt\n@@ -1 +1 @@\n-old\n+new\n`).join("");
  const parsed = parseUnifiedDiff(source, { maxFiles: 1 });
  expect(parsed.files).toHaveLength(1);
  expect(parsed.incompleteReasons).toContain("too_many_files");
});
