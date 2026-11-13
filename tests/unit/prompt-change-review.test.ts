import "./prompt-change-offline.js";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import * as contracts from "../../packages/contracts/src/index.js";
import { detectPromptChanges, detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
import { parseUnifiedDiff } from "../../packages/contracts/src/prompt-change-diff.js";
import { PromptChangeItemSchema, PromptChangeReportSchema, promptChangesNeedEval, promptChangesNeedSideBySide } from "../../packages/contracts/src/prompt-change.js";
const run = (after: string, before = "", path = "main.ts") => detectPromptChanges({ files: [{ path, before, after, wholeFile: true }] }, { stats: true });
const digest = (items: Array<{ id: string; fingerprintBefore: string | null; fingerprintAfter: string | null }>) => createHash("sha256").update(JSON.stringify(items.map((i) => [i.id, i.fingerprintBefore, i.fingerprintAfter]))).digest("hex");

it.each([".env".repeat(1024) + "/x", "é".repeat(2049) + ".ts", "x".repeat(1024 * 1024) + ".prompt"])("refuses overlong paths before rules and bounds fingerprint work", (path) => {
  const result = run("prompt: 'new'", "prompt: 'old'", path);
  expect(result.report.coverage).toBe("partial");
  expect(result.report.items[0]?.path).toBe("path_refused");
  expect(result.report.items[0]?.pathFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(result.stats!.steps).toBeLessThan(150_000);
});
it("also refuses overlong old paths", () => {
  const result = detectPromptChanges({ files: [{ path: "a.prompt", oldPath: "x".repeat(5000) + ".prompt", before: "old", after: "new", wholeFile: true }] });
  expect(result.report.coverage).toBe("partial");
  expect(result.report.items[0]?.oldPath).toBe("path_refused");
  expect(result.report.items[0]?.oldPathFingerprint).toMatch(/^[a-f0-9]{64}$/u);
});
it.each(["ts", "py"])("detects Anthropic system text blocks in %s", (extension) => {
  const source = extension === "ts" ? "import Anthropic from '@anthropic-ai/sdk'; client.messages.create({system:[{type:'text',text:'S1'}]})" : "import anthropic\nclient.messages.create(system=[{'type':'text','text':'S1'}])";
  const report = run(source.replace("S1", "S2"), source, `main.${extension}`).report;
  expect(report.items).toMatchObject([{ kind: "system_prompt", verb: "modified" }]);
});
it.each(["SYSTEM_PROMPT", "userInstruction", "TEMPLATE_TEXT", "SYSTEM_TEXT"])("detects named prompt constants: %s", (name) => {
  for (const extension of ["ts", "py"]) {
    const source = `import openai\n${name} = 'S1'`;
    const report = run(source.replace("S1", "S2"), source, `main.${extension}`).report;
    expect(report.items).toMatchObject([{ kind: "prompt_text", verb: "modified" }]);
  }
});
it.each([
  "generateText({prompt: value})", "generateText({prompt: 'prefix' + value})", "generateText({prompt: buildPrompt()})",
  "client.messages.create({system: value})", "client.chat.completions.create({messages: value})",
  "client.messages.create(system=value)", "client.chat.completions.create(messages=buildMessages())",
  "generate_content(value)", "generateText({prompt: ('a' + value)})",
  "client.messages.create({system:[{type:'text',text:value}]})",
  "client.chat.completions.create({messages:[{role:'user',content:value}]})",
  "generateText({prompt: 'prefix'\n + value})",
])("nonliteral prompt fails closed: %s", (source) => {
  const report = run(`import openai\n${source}`).report;
  expect(report.incompleteReasons).toContain("nonliteral_prompt");
  expect(report.coverage).toBe("partial");
  expect(promptChangesNeedEval(report).needed).toBe(true);
  expect(promptChangesNeedSideBySide(report).needed).toBe(true);
  expect(PromptChangeReportSchema.safeParse(report).success).toBe(true);
});
it.each(["html", "md", "mdx"])("embedded SDK sources cannot certify none_found in %s", (extension) => {
  for (const source of ["<script>import OpenAI from 'openai';</script>", "generateText({prompt: value})"]) {
    const report = run(source, "", `page.${extension}`).report;
    expect(report.coverage).toBe("partial");
    expect(promptChangesNeedEval(report).needed).toBe(true);
  }
});
it.each([
  ["weather.yaml", "model: ecmwf"], ["orm.ts", "const schema = {model: 'User'}"],
  ["view.py", "class Meta:\n    model = 'User'\n    template = 'user.html'"], ["component.ts", "Component({template:'<p>Hi</p>'})"],
])("requires AI signal for model/template in %s", (path, source) => {
  expect(run(source, "", path).report.status).toBe("none_found");
  const positive = run(`import openai\n${source}`, "", path).report;
  expect(positive.items.length).toBeGreaterThan(0);
  expect(positive.items.find((i) => i.kind === "model_name")?.family ?? null).toBeNull();
});
it.each(["rename from ", "+++ b/", "rename to ", "diff --git a/x b/"])("lone CR cannot turn hunk content into a header: %s", (header) => {
  const canary = ["canary", Math.random().toString(36).slice(2)].join("-");
  const source = `diff --git a/a.prompt b/a.prompt\n--- a/a.prompt\n+++ b/a.prompt\n@@ -1 +1 @@\n-old\r${header}${canary}\n+new\n`;
  const parsed = parseUnifiedDiff(source);
  expect(parsed.files).toMatchObject([{ path: "a.prompt", before: `old\r${header}${canary}`, after: "new" }]);
  expect(parsed.files).toHaveLength(1);
  expect(JSON.stringify(detectPromptChangesInDiff(source))).not.toContain(canary);
});
it.each(["", "\r"])("strips Git's trailing TAB on paths with spaces (CR=%s)", (cr) => {
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
it("schema verifies the digest of untruncated reports", () => {
  const report = run("new", "old", "a.prompt").report;
  expect(PromptChangeReportSchema.safeParse(report).success).toBe(true);
  expect(PromptChangeReportSchema.safeParse({ ...report, reportDigest: "0".repeat(64) }).success).toBe(false);
});
it("barrel exposes reports without raw-text diff readers", () => {
  expect(contracts).toHaveProperty("detectPromptChanges");
  expect(contracts).not.toHaveProperty("parsePromptDiffInternal");
  expect(contracts).not.toHaveProperty("parseUnifiedDiff");
});
it.each([
  "generateText({prompt})", "client.messages.create({system})", "client.chat.completions.create({messages})",
  "client.chat.completions.create({messages:[message]})", "client.messages.create({system:[...blocks]})",
])("unresolved prompt containers fail closed: %s", (source) => {
  const report = run(`import openai\n${source}`).report;
  expect(report.incompleteReasons).toContain("nonliteral_prompt");
  expect(promptChangesNeedSideBySide(report).needed).toBe(true);
});

it("path byte cap permits exactly 4096 bytes and refuses the next byte", () => {
  expect(run("new", "old", "x".repeat(4089) + ".prompt").report.coverage).toBe("complete");
  expect(run("new", "old", "x".repeat(4090) + ".prompt").report.coverage).toBe("partial");
});

it("charges bounded path classification work to steps", () => {
  const short = run("", "", "x.ts").stats!.steps;
  const long = run("", "", "x".repeat(3000) + ".ts").stats!.steps;
  expect(long - short).toBeGreaterThan(4 * 2999);
});
