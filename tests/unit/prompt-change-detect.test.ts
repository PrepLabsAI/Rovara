import "./prompt-change-offline.js";
import { describe, expect, it } from "vitest";
import { detectPromptChanges, detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
import { PromptChangeReportSchema, promptChangesNeedEval, promptChangesNeedSideBySide } from "../../packages/contracts/src/prompt-change.js";

const run = (after: string, before = "", path = "ai/example.ts") => detectPromptChanges({ files: [{ path, before, after, wholeFile: true }] });
const kinds = (source: string, path?: string) => run(source, "", path).report.items.map((item) => item.kind);

describe("prompt change detection", () => {
  it.each(["a.prompt.md", "a_prompt.txt"])("recognizes prompt path %s", (path) => {
    expect(run("new prose", "old prose", path).report.items).toMatchObject([{ kind: "prompt_file", verb: "modified", basis: "path_rule" }]);
  });
  it.each([
    ["generate_text('hello')", "prompt_text"],
    ["ChatPromptTemplate.from_messages([('system', 'hello')])", "system_prompt"],
    ["ChatPromptTemplate.from_messages([['human', 'hello']])", "prompt_text"],
    ["co.chat(message='hello')", "prompt_text"],
    ["prompt = f'hello {person}'", "prompt_text"],
    ["prompt = r'hello\\nthere'", "prompt_text"],
    ["prompt = 'hello\\\nthere'", "prompt_text"],
  ])("reads literal %s", (source, kind) => {
    expect(kinds(source)).toContain(kind);
    expect(PromptChangeReportSchema.safeParse(run(source).report).success).toBe(true);
  });
  it("ignores variables, unrelated content/input, comments and calls outside the SDK", () => {
    expect(kinds("prompt = variable; const a = {content: 'text', input: 'text'}; fn('text'); // prompt: 'fake'\n/* model: 'gpt-x' */")).toEqual([]);
  });
  it.each(["openai('gpt-4o')"])("provider helper %s", (source) => expect(kinds(source)).toContain("model_name"));
  it.each(['has"quote'])("fingerprints unsafe model names without echo", (value) => {
    const report = run(`model: ${JSON.stringify(value)}`).report;
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).not.toHaveProperty("after");
    expect(report.items[0]?.fingerprintAfter).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("echoes only finite numbers and enumerated words", () => {
    const report = run("temperature: 1e999; reasoning_effort: 'high'; tool_choice: 'a-secret-word'; stop: ['halt']").report;
    expect(report.items.filter((i) => 'after' in i).map((i) => 'after' in i ? i.after : null)).toEqual(["high"]);
    expect(report.items).toHaveLength(4);
  });
  it("only counts parameters in a tool", () => {
    expect(kinds("parameters: {type: 'object'}")).toEqual([]);
    expect(kinds("tools: [{parameters: {type: 'object'}}]")).toEqual(["tool_schema"]);
  });
  it("precision rule refuses weather settings and recognizes real SDK imports", () => {
    expect(run("temperature: 20", "", "weather.yaml").report.status).toBe("none_found");
    for (const prefix of ['import OpenAI from "openai";', 'import anthropic', 'from google import genai', 'const ai = require("@ai-sdk/openai")', 'from langchain.prompts import PromptTemplate']) {
      expect(run(`${prefix}\ntemperature: 0.2`, "", "app.py").report.counts.model_setting).toBe(1);
    }
    expect(run('const note = "openai"; temperature: 20', "", "weather.js").report.status).toBe("none_found");
  });
  it("covers added, removed and renamed prompt files including edits on rename", () => {
    const files = [{ path: "new.prompt", after: "new", status: "added" as const, wholeFile: true }, { path: "gone.prompt", before: "old", status: "removed" as const, wholeFile: true }, { path: "moved.prompt", oldPath: "old.prompt", before: "same", after: "same", wholeFile: true }];
    const report = detectPromptChanges({ files }).report;
    expect(new Set(report.items.map((i) => i.verb))).toEqual(new Set(["added", "removed", "renamed"]));
    expect(report.items.find((i) => i.verb === "renamed")).toMatchObject({ oldPath: "old.prompt", path: "moved.prompt" });
    expect(detectPromptChanges({ files: [{ ...files[2]!, after: "different" }] }).report.items[0]?.verb).toBe("renamed");
  });
  it.each(["[link](url).prompt"])("refuses unsafe and oversized paths", (path) => {
    const result = run("new", "old", path);
    expect(result.report.items[0]?.path).toBe("path_refused");
    expect(result.report.items[0]?.pathFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result).length).toBeLessThan(2000);
  });
  it("fail closed and selectors stay conservative on incomplete coverage", () => {
    const report = detectPromptChangesInDiff("diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\n").report;
    expect(report.status).toBe("incomplete");
    expect(report.coverage).toBe("hunks_only");
    expect(promptChangesNeedEval(report)).toMatchObject({ needed: true, reason: "incomplete" });
    expect(promptChangesNeedSideBySide(report)).toMatchObject({ needed: true, reason: "incomplete" });
    expect(promptChangesNeedSideBySide(run("temperature: 1").report).needed).toBe(true);
    expect(promptChangesNeedEval(run("temperature: 1").report).needed).toBe(true);
    expect(promptChangesNeedSideBySide(run("prompt: 'hello'").report).needed).toBe(true);
    expect(promptChangesNeedEval(run("").report).needed).toBe(false);
  });
  it("caps files, each UTF-8 side, total bytes and never lets options increase defaults", () => {
    const file = { path: "a.prompt", before: "", after: "éé", wholeFile: true };
    expect(detectPromptChanges({ files: [file, file] }, { maxFiles: 1 }).report.incompleteReasons).toContain("too_many_files");
    expect(detectPromptChanges({ files: [file] }, { maxFileBytes: 3 }).report.incompleteReasons).toContain("file_too_large");
    expect(detectPromptChanges({ files: [file] }, { maxTotalBytes: 3 }).report.incompleteReasons).toContain("total_too_large");
    expect(detectPromptChanges({ files: [{ ...file, after: "x".repeat(1024 * 1024 + 1) }] }, { maxFileBytes: Infinity }).report.incompleteReasons).toContain("file_too_large");
    expect(detectPromptChanges({ files: [{ path: "a.ts", wholeFile: true }] }).report.status).toBe("incomplete");
  });
  it("refuses excessive nesting and unterminated literals without throwing", () => {
    for (const source of ["[".repeat(65) + "]".repeat(65), "prompt: '''unterminated", "prompt: `hello ${" + "{".repeat(65)]) {
      expect(run(source).report.status).toBe("incomplete");
      expect(run(source).report.incompleteReasons).toContain("unreadable_diff");
    }
  });
  it("contains any malformed runtime input in a fixed incomplete result", () => {
    for (const value of [null, 1, {}, { files: [null] }, { files: [{ path: 42 }] }]) {
      expect(detectPromptChanges(value as never).report.status).toBe("incomplete");
    }
    const hostile = { get files(): never { throw new Error("private content"); } };
    expect(JSON.stringify(detectPromptChanges(hostile))).not.toContain("private content");
  });
});

it("refuses unsupported executable languages instead of certifying no changes", () => {
  expect(run('client.call("hello")', "", "main.rb").report.status).toBe("incomplete");
});
it("duplicate file paths cannot create order-dependent reports", () => {
  const files = ["a", "b"].map((after) => ({ path: "a.prompt", before: "old", after, wholeFile: true }));
  expect(detectPromptChanges({ files }).report).toEqual(detectPromptChanges({ files: [...files].reverse() }).report);
  expect(detectPromptChanges({ files }).report.coverage).toBe("partial");
});
it("does not echo interpolated model names or enum-like numeric strings", () => {
  expect(run("model: `gpt-${name}`; temperature: '123'").report.items.every((i) => !("after" in i))).toBe(true);
});
it("ignores nonliteral expressions, while reading YAML bare scalars and blocks", () => {
  expect(run("prompt: 'a' + variable; temperature: 1 + offset").report.items).toEqual([]);
  const report = run('model: gpt-4o\nsystem_prompt: |\n  hello world\n  another line\ntemperature: 0.1', "", "config.yaml").report;
  expect(report.counts).toMatchObject({ model_name: 1, system_prompt: 1, model_setting: 1 });
  expect(report.items.find((i) => i.kind === "model_name")).toMatchObject({ after: "gpt-4o" });
});
it("reads indented YAML tool schemas and nested system/message parts", () => {
  const yaml = 'tools:\n  - name: search\n    description: private words\n    parameters:\n      type: object\n';
  expect(run(yaml, "", "config.yaml").report.counts.tool_schema).toBe(1);
  const nestedSystem = "model.generateContent({systemInstruction: {parts: [{text: 'system words'}]}})";
  expect(run(nestedSystem).report.counts.system_prompt).toBe(1);
  const multipart = "client.chat.completions.create({messages:[{role:'system', content:[{type:'text', text:'system words'}]}]})";
  expect(run(multipart).report.counts.system_prompt).toBe(1);
});
