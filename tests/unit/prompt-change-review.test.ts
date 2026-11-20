import "./prompt-change-offline.js";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { detectPromptChanges, detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
import { parseUnifiedDiff } from "../../packages/contracts/src/prompt-change-diff.js";
import { PromptChangeItemSchema, PromptChangeReportSchema, promptChangesNeedEval, promptChangesNeedSideBySide } from "../../packages/contracts/src/prompt-change.js";
const run = (after: string, before = "", path = "main.ts") => detectPromptChanges({ files: [{ path, before, after, wholeFile: true }] }, { stats: true });
const digest = (items: Array<{ id: string; fingerprintBefore: string | null; fingerprintAfter: string | null }>) => createHash("sha256").update(JSON.stringify(items.map((i) => [i.id, i.fingerprintBefore, i.fingerprintAfter]))).digest("hex");

it("also refuses overlong old paths", () => {
  const result = detectPromptChanges({ files: [{ path: "a.prompt", oldPath: "x".repeat(5000) + ".prompt", before: "old", after: "new", wholeFile: true }] });
  expect(result.report.coverage).toBe("partial");
  expect(result.report.items[0]?.oldPath).toBe("path_refused");
  expect(result.report.items[0]?.oldPathFingerprint).toMatch(/^[a-f0-9]{64}$/u);
});
it.each([
  "client.chat.completions.create({messages:[{role:'user',content:value}]})",
])("nonliteral prompt fails closed: %s", (source) => {
  const report = run(`import openai\n${source}`).report;
  expect(report.incompleteReasons).toContain("nonliteral_prompt");
  expect(report.coverage).toBe("partial");
  expect(promptChangesNeedEval(report).needed).toBe(true);
  expect(promptChangesNeedSideBySide(report).needed).toBe(true);
  expect(PromptChangeReportSchema.safeParse(report).success).toBe(true);
});
it.each([
  ["view.py", "class Meta:\n    model = 'User'\n    template = 'user.html'"],
])("requires AI signal for model/template in %s", (path, source) => {
  expect(run(source, "", path).report.status).toBe("none_found");
  const positive = run(`import openai\n${source}`, "", path).report;
  expect(positive.items.length).toBeGreaterThan(0);
  expect(positive.items.find((i) => i.kind === "model_name")?.family ?? null).toBeNull();
});
it.each(["\r"])("strips Git's trailing TAB on paths with spaces (CR=%s)", (cr) => {
  const source = `diff --git a/prompts/my file.md b/prompts/my file.md\n--- a/prompts/my file.md\t\n+++ b/prompts/my file.md\t\n@@ -1 +1 @@\n-old\n+new\n`.replaceAll("\n", `${cr}\n`);
  expect(parseUnifiedDiff(source).files[0]?.path).toBe("prompts/my file.md");
  expect(detectPromptChangesInDiff(source).report.items[0]?.path).toBe("prompts/my file.md");
});
it("schema rejects duplicate reasons", () => {
  const report = detectPromptChangesInDiff("").report;
  expect(PromptChangeReportSchema.safeParse({ ...report, incompleteReasons: ["hunks_only", "hunks_only"] }).success).toBe(false);
});
it("schema rejects unsorted items even with a matching digest", () => {
  const report = detectPromptChanges({ files: ["a", "b"].map((p) => ({ path: `${p}.prompt`, before: "old", after: "new", wholeFile: true })) }).report;
  const items = [...report.items].reverse();
  expect(PromptChangeReportSchema.safeParse({ ...report, items, reportDigest: digest(items) }).success).toBe(false);
});
it("schema rejects duplicate item ids even with matching counts and digest", () => {
  const report = run("prompt:'new'", "prompt:'old'").report;
  const items = [report.items[0]!, report.items[0]!];
  expect(PromptChangeReportSchema.safeParse({ ...report, items, counts: { ...report.counts, prompt_text: 2 }, reportDigest: digest(items) }).success).toBe(false);
});
it("schema refuses path fingerprints on safe or absent paths", () => {
  const item = run("new", "old", "a.prompt").report.items[0]!;
  expect(PromptChangeItemSchema.safeParse({ ...item, pathFingerprint: "a".repeat(64) }).success).toBe(false);
  expect(PromptChangeItemSchema.safeParse({ ...item, oldPath: "b.prompt", oldPathFingerprint: "a".repeat(64) }).success).toBe(false);
  expect(PromptChangeItemSchema.safeParse({ ...item, oldPathFingerprint: "a".repeat(64) }).success).toBe(false);
});
it.each([
"client.messages.create({system:[...blocks]})",
])("unresolved prompt containers fail closed: %s", (source) => {
  const report = run(`import openai\n${source}`).report;
  expect(report.incompleteReasons).toContain("nonliteral_prompt");
  expect(promptChangesNeedSideBySide(report).needed).toBe(true);
});

it.each(["html"])("round 3 embedded prose stays complete: %s", (extension) => {
  for (const source of ["Please create an account", "Join our chat", "the ai is cool", "We create(x) for the chat", "sdk.create is a method"]) {
    expect(run(source, "", `page.${extension}`).report.status).toBe("none_found");
  }
  for (const source of ["import { generateText } from 'ai'", "from ai import generateText", "Uses @ai-sdk/openai", "Uses @google/genai", "client.messages.create ({system: value})"]) {
    expect(run(source, "", `page.${extension}`).report.coverage).toBe("partial");
  }
});
