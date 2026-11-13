import "./prompt-change-offline.js";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseUnifiedDiff } from "../../packages/contracts/src/prompt-change-diff.js";
import { detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
const diff = 'diff --git "a/prompts/hello world.prompt" "b/prompts/hello world.prompt"\n--- "a/prompts/hello world.prompt"\n+++ "b/prompts/hello world.prompt"\n@@ -10,2 +20,2 @@\n context\n-old\n+new\n\\ No newline at end of file\n';
it("reads quoted paths, CRLF, exact hunk lines and newline markers", () => {
  const parsed = parseUnifiedDiff(diff.replaceAll("\n", "\r\n"));
  expect(parsed.coverage).toBe("hunks_only");
  expect(parsed.files[0]).toMatchObject({ path: "prompts/hello world.prompt", before: "context\nold", after: "context\nnew", wholeFile: false });
  expect(detectPromptChangesInDiff(diff).report.items[0]?.line).toBe(20);
});
it("decodes git octal UTF-8 and keeps both rename names", () => {
  const parsed = parseUnifiedDiff('diff --git "a/\\303\\274.prompt" b/new.prompt\nsimilarity index 100%\nrename from "\\303\\274.prompt"\nrename to new.prompt\n');
  expect(parsed.files[0]).toMatchObject({ path: "new.prompt", oldPath: "ü.prompt", status: "renamed" });
});
it.each(["new", "deleted"])("reads %s files and /dev/null", (verb) => {
  const added = verb === "new";
  const parsed = parseUnifiedDiff(`diff --git a/a.prompt b/a.prompt\n${verb} file mode 100644\n--- ${added ? "/dev/null" : "a/a.prompt"}\n+++ ${added ? "b/a.prompt" : "/dev/null"}\n@@ -${added ? "0,0" : "1"} +${added ? "1" : "0,0"} @@\n${added ? "+" : "-"}words\n`);
  expect(parsed.files[0]?.status).toBe(added ? "added" : "removed");
});
it.each(["[workspace diff truncated", "[the commit this workspace was prepared at is not in this repository", "garbage", "diff --git a/a b/a\n@@ nonsense", "diff --git a/a b/a\n@@ -1,2 +1,2 @@\n-one\n+two"])("fails closed on incomplete input", (source) => {
  const report = detectPromptChangesInDiff(source).report;
  expect(report.coverage).toBe("partial");
  expect(report.status).toBe("incomplete");
});
it("marks binary and hunkless diff as incomplete and empty diff as hunks only", () => {
  expect(detectPromptChangesInDiff('diff --git a/a b/a\nBinary files a/a and b/a differ\n').report.incompleteReasons).toContain("binary_file");
  expect(detectPromptChangesInDiff("").report.status).toBe("incomplete");
});
it("does not join separated hunks into invented adjacent code", () => {
  const source = 'diff --git a/ai/a.ts b/ai/a.ts\n@@ -1 +1 @@\n-const one = 1;\n+prompt:\n@@ -30 +30 @@\n-old;\n+"not adjacent"\n';
  expect(detectPromptChangesInDiff(source).report.items).toEqual([]);
});
it("reads a small actual repository-history diff without interpreting documentation as source", () => {
  const source = readFileSync(new URL("../fixtures/prompt-change/history.diff", import.meta.url), "utf8");
  const parsed = parseUnifiedDiff(source);
  expect(parsed.files.map((f) => f.path)).toContain("README.md");
  expect(parsed.incompleteReasons).toEqual(["hunks_only"]);
  expect(detectPromptChangesInDiff(source).report.items).toEqual([]);
});
it("keeps status incomplete when detected changes came from incomplete input", () => {
  const report = detectPromptChangesInDiff(diff + "[workspace diff truncated]\n").report;
  expect(report.items.length).toBeGreaterThan(0);
  expect(report.status).toBe("incomplete");
});
it.each(["[workspace diff truncated]", "[the commit this workspace was prepared at is not in this repository]"])("preserves workspace note reason %s", (note) => {
  expect(detectPromptChangesInDiff(diff + note).report.incompleteReasons).toContain("diff_truncated");
});
it("checks hunk counts independently of source syntax", () => {
  const source = 'diff --git a/a.prompt b/a.prompt\n@@ -1,2 +1,2 @@\n-old\n+new\n';
  expect(parseUnifiedDiff(source).incompleteReasons).toContain("unreadable_diff");
});
it("caps diff text before parsing and caps kept file entries", () => {
  expect(parseUnifiedDiff("x".repeat(100), { maxTotalBytes: 99 }).incompleteReasons).toContain("total_too_large");
  expect(parseUnifiedDiff("é".repeat(50), { maxTotalBytes: 99 }).incompleteReasons).toContain("total_too_large");
  const source = ['a', 'b'].map((name) => `diff --git a/${name}.prompt b/${name}.prompt\n@@ -1 +1 @@\n-old\n+new\n`).join("");
  const parsed = parseUnifiedDiff(source, { maxFiles: 1 });
  expect(parsed.files).toHaveLength(1);
  expect(parsed.incompleteReasons).toContain("too_many_files");
});
