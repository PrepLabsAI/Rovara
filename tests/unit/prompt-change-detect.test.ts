import "./prompt-change-offline.js";
import { describe, expect, it } from "vitest";
import { detectPromptChanges, detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
import { PromptChangeReportSchema, promptChangesNeedEval, promptChangesNeedSideBySide } from "../../packages/contracts/src/prompt-change.js";
import { builtinModelCatalog } from "../../packages/contracts/src/model-catalog-rows.js";

const run = (after: string, before = "", path = "ai/example.ts") => detectPromptChanges({ files: [{ path, before, after, wholeFile: true }] });
const kinds = (source: string, path?: string) => run(source, "", path).report.items.map((item) => item.kind);

describe("prompt change detection", () => {
  it.each(["a.prompt", "a.prompty", "a.dotprompt", "a.jinja", "a.jinja2", "a.j2", "a.hbs", "a.handlebars", "a.mustache", "nested/prompts/a.md", "prompt/a.txt", "system-prompts/a.yaml", "prompts/a.yml", "prompts/a.json", "prompts/a.toml", "a.prompt.md", "a_prompt.txt", "system-guide.txt"])("recognizes prompt path %s", (path) => {
    expect(run("new prose", "old prose", path).report.items).toMatchObject([{ kind: "prompt_file", verb: "modified", basis: "path_rule" }]);
  });
  it.each([
    ["client.chat.completions.create({messages: [{role: 'user', content: 'hello'}]})", "prompt_text"],
    ["client.chat.completions.create(messages=[{'role': 'system', 'content': 'hello'}])", "system_prompt"],
    ["client.messages.create(system='hello')", "system_prompt"],
    ["client.messages.create({system: 'hello'})", "system_prompt"],
    ["client.models.generate_content(system_instruction='hello')", "system_prompt"],
    ["model.generateContent({systemInstruction: 'hello'})", "system_prompt"],
    ["model.generate_content(system_instructions='hello')", "system_prompt"],
    ["generateText({prompt: 'hello'})", "prompt_text"],
    ["streamText({prompt: `hello ${person.name}`})", "prompt_text"],
    ["generate_text('hello')", "prompt_text"],
    ["model.generate_content('hello')", "prompt_text"],
    ["model.generateContent('hello')", "prompt_text"],
    ["generateText('hello')", "prompt_text"],
    ["streamText('hello')", "prompt_text"],
    ["chain.invoke('hello')", "prompt_text"],
    ["PromptTemplate('hello')", "prompt_text"],
    ["PromptTemplate.from_template('hello')", "prompt_text"],
    ["ChatPromptTemplate.from_messages([('system', 'hello')])", "system_prompt"],
    ["ChatPromptTemplate.from_messages([['human', 'hello']])", "prompt_text"],
    ["co.chat(message='hello')", "prompt_text"],
    ["client.responses.create({instructions: 'hello', input: 'there'})", "system_prompt"],
    ["client.models.generate_content(contents='hello')", "prompt_text"],
    ["model.generateContent({contents: [{parts: [{text: 'hello'}]}]})", "prompt_text"],
    ["prompt = '''hello\nthere'''", "prompt_text"],
    ['prompt = """hello\nthere"""', "prompt_text"],
    ["prompt = f'hello {person}'", "prompt_text"],
    ["prompt = r'hello\\nthere'", "prompt_text"],
    ["prompt = 'hello\\\nthere'", "prompt_text"],
  ])("reads literal %s", (source, kind) => {
    expect(kinds(source)).toContain(kind);
    expect(PromptChangeReportSchema.safeParse(run(source).report).success).toBe(true);
  });
  it("uses role in the same object, even after content", () => {
    const report = run("messages = [{content: 'hello', role: 'system'}, {role: 'user', content: 'other'}]").report;
    expect(report.counts.system_prompt).toBe(1);
    expect(report.counts.prompt_text).toBe(1);
  });
  it("ignores variables, unrelated content/input, comments and calls outside the SDK", () => {
    expect(kinds("prompt = variable; const a = {content: 'text', input: 'text'}; fn('text'); // prompt: 'fake'\n/* model: 'gpt-x' */")).toEqual([]);
  });
  it.each(["model", "model_name", "modelName", "model_id", "modelId", "deployment", "deployment_name"])("model key %s accepts unknown names with no family", (key) => {
    expect(run(`${key}: 'local-widget'`).report.items).toMatchObject([{ kind: "model_name", family: null, after: "local-widget" }]);
  });
  it.each(["openai('gpt-4o')", "google('gemini-flash')", "anthropic('claude-sonnet')", "getGenerativeModel({model:'gemini-flash'})", "ChatOpenAI(model='gpt-4o')", "init_chat_model('gpt-4o')"])("provider helper %s", (source) => expect(kinds(source)).toContain("model_name"));
  it.each([["gpt-4o", "openai_compatible"], ["o1", "openai_compatible"], ["o3-mini", "openai_compatible"], ["o4-mini", "openai_compatible"], ["claude-sonnet", "anthropic_messages"], ["gemini-flash", "gemini"], ["models/gemini-flash", "gemini"], ["command-r", "cohere"], ["embed-v4", "cohere"], ["text-embedding-3-small", "openai_compatible"]])("model family %s", (name, family) => expect(run(`model: '${name}'`).report.items[0]?.family).toBe(family));
  it.each(["has space", 'has"quote', "line\nfeed", "<html>", "[name](url)", "@mention", "#123", "x".repeat(129)])("fingerprints unsafe model names without echo", (value) => {
    const report = run(`model: ${JSON.stringify(value)}`).report;
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).not.toHaveProperty("after");
    expect(report.items[0]?.fingerprintAfter).toMatch(/^[a-f0-9]{64}$/u);
  });
  it.each(["temperature", "top_p", "topP", "top_k", "topK", "max_tokens", "maxTokens", "max_output_tokens", "maxOutputTokens", "max_completion_tokens", "seed", "frequency_penalty", "presencePenalty", "thinking_budget", "thinkingBudget"])("numeric setting %s", (key) => {
    expect(run(`${key}: 0.5`).report.items).toMatchObject([{ kind: "model_setting", after: 0.5 }]);
  });
  it.each(["stop_sequences", "stopSequences", "response_format", "responseFormat", "reasoning_effort", "reasoningEffort", "tool_choice", "toolChoice"])("fingerprints setting %s", (key) => expect(kinds(`${key}: ['private stop']`)).toContain("model_setting"));
  it("echoes only finite numbers and enumerated words", () => {
    const report = run("temperature: 1e999; reasoning_effort: 'high'; tool_choice: 'a-secret-word'; stop: ['halt']").report;
    expect(report.items.filter((i) => 'after' in i).map((i) => 'after' in i ? i.after : null)).toEqual(["high"]);
    expect(report.items).toHaveLength(4);
  });
  it.each(["tools", "functions", "function_declarations", "functionDeclarations", "input_schema", "tool_schema"])("tool schema %s", (key) => expect(kinds(`${key}: [{description: 'private words', parameters: {type:'object'}}]`)).toContain("tool_schema"));
  it("only counts parameters in a tool", () => {
    expect(kinds("parameters: {type: 'object'}")).toEqual([]);
    expect(kinds("tools: [{parameters: {type: 'object'}}]")).toEqual(["tool_schema"]);
  });
  it.each(["json", "yaml", "yml", "toml", "env", "env.local", "ini"])("config %s uses narrow keys and signal", (ext) => {
    const report = run('model = "gpt-4o"\ntemperature = 0.2\nsystem_prompt = "hello"', "", `settings.${ext}`).report;
    expect(report.counts).toMatchObject({ model_name: 1, model_setting: 1, system_prompt: 1 });
  });
  it("precision rule refuses weather settings and recognizes real SDK imports", () => {
    expect(run("temperature: 20", "", "weather.yaml").report.status).toBe("none_found");
    for (const prefix of ['import OpenAI from "openai";', 'import anthropic', 'from google import genai', 'const ai = require("@ai-sdk/openai")', 'from langchain.prompts import PromptTemplate']) {
      expect(run(`${prefix}\ntemperature: 0.2`, "", "app.py").report.counts.model_setting).toBe(1);
    }
    expect(run('const note = "openai"; temperature: 20', "", "weather.js").report.status).toBe("none_found");
  });
  it("finds catalog hosts with their families and never echoes endpoints", () => {
    for (const row of builtinModelCatalog().rows) {
      const host = row.hosts[0];
      if (!host) continue;
      const items = run(`const endpoint = 'https://${host}/v1'`).report.items;
      expect(items).toMatchObject([{ kind: "model_endpoint", basis: "catalog_host", family: builtinModelCatalog().rows.filter((r) => r.hosts.includes(host)).every((r) => r.family === row.family) ? row.family : null }]);
      expect(JSON.stringify(items)).not.toContain(host);
    }
  });
  it("normalizes whitespace, CRLF, format characters, line wrapping and literal escapes", () => {
    expect(run("hello   world\n\nnext\u200b", "hello\r\nworld\nnext", "a.prompt").report.status).toBe("none_found");
    expect(run("prompt: `hello\n world`", "prompt: 'hello world'").report.status).toBe("none_found");
    expect(run('prompt: "hello\\nworld"', "prompt: 'hello world'").report.status).toBe("none_found");
  });
  it("has stable anchors and lines after moving a prompt, and matches equal fingerprints before anchors", () => {
    const first = run("prompt: 'new'", "prompt: 'old'").report.items[0];
    const moved = run("\n\nconst x = 1;\nprompt: 'new'", "\nprompt: 'old'").report.items[0];
    expect(moved?.id).toBe(first?.id);
    expect(moved?.line).toBe(4);
    expect(run("prompt: 'same'; prompt: 'new'", "prompt: 'old'; prompt: 'same'").report.items).toMatchObject([{ verb: "modified" }]);
  });
  it("covers added, removed and renamed prompt files including edits on rename", () => {
    const files = [{ path: "new.prompt", after: "new", status: "added" as const, wholeFile: true }, { path: "gone.prompt", before: "old", status: "removed" as const, wholeFile: true }, { path: "moved.prompt", oldPath: "old.prompt", before: "same", after: "same", wholeFile: true }];
    const report = detectPromptChanges({ files }).report;
    expect(new Set(report.items.map((i) => i.verb))).toEqual(new Set(["added", "removed", "renamed"]));
    expect(report.items.find((i) => i.verb === "renamed")).toMatchObject({ oldPath: "old.prompt", path: "moved.prompt" });
    expect(detectPromptChanges({ files: [{ ...files[2]!, after: "different" }] }).report.items[0]?.verb).toBe("renamed");
  });
  it("is deterministic under file permutations, including truncated reports", () => {
    const files = Array.from({ length: 510 }, (_, i) => ({ path: `${i}.prompt`, before: "old", after: "new", wholeFile: true }));
    const a = detectPromptChanges({ files }).report;
    expect(detectPromptChanges({ files: [...files].reverse() }).report).toEqual(a);
    expect(a.items).toHaveLength(500);
    expect(a.itemsTruncated).toBe(true);
    expect(a.counts.prompt_file).toBe(510);
    expect(a.status).toBe("changes");
  });
  it("never echoes content canaries and allows a filename canary only in path/oldPath (Q1)", () => {
    const content = ["canary", String(Math.floor(Math.random() * 1e9))].join("-");
    const filename = ["filename", String(Math.floor(Math.random() * 1e9))].join("-");
    const result = detectPromptChanges({ files: [
      { path: `${filename}.prompt`, oldPath: `${filename}-old.prompt`, before: "old words", after: content, wholeFile: true },
      { path: "ai/a.ts", before: "", after: `system: '${content}'; prompt: '${content}'; tools: [{description:'${content}'}]; unrelated: '${content}'`, wholeFile: true },
      { path: "plain.yaml", before: "", after: `unrelated: '${content}'`, wholeFile: true },
    ] }, { stats: true });
    expect(result.report.items.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(result)).not.toContain(content);
    expect(JSON.stringify(result)).not.toContain("old words");
    const walk = (value: unknown, key = "") => {
      if (typeof value === "string" && value.includes(filename)) expect(["path", "oldPath"]).toContain(key);
      if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
    };
    walk(result);
  });
  it.each(["[link](url).prompt", "![image](url).prompt", "[x][ref].prompt", "@mention.prompt", "#123.prompt", "<b>.prompt", "# > --- ``` ~~~.prompt", "---.prompt", "hidden\u200b.prompt", "variant\ufe0f.prompt", `${"x".repeat(1024 * 1024)}.prompt`])("refuses unsafe and oversized paths", (path) => {
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
    expect(promptChangesNeedSideBySide(run("temperature: 1").report).needed).toBe(false);
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
it("large refused paths are hashed once per file and cannot multiply item work", () => {
  const result = detectPromptChanges({ files: [{ path: "x".repeat(100_000) + ".ts", before: "", after: "prompt: 'private';".repeat(3000), wholeFile: true }] }, { stats: true });
  expect(result.stats!.steps).toBeLessThanOrEqual(2048 * (result.stats!.bytes + 1) + 100_000);
  expect(result.report.counts.prompt_text).toBe(3000);
});
it("bounds total bytes including oversized path metadata", () => {
  const report = detectPromptChanges({ files: [{ path: "x".repeat(200) + ".ts", before: "", after: "", wholeFile: true }] }, { maxTotalBytes: 100 }).report;
  expect(report.incompleteReasons).toContain("total_too_large");
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
it("normalizes structured tool layout without changing literal punctuation", () => {
  const before = "tools:[{name:'call', parameters:{type:'object'}}]";
  const after = "tools: [\n { name: 'call', parameters: { type: 'object' } }\n]";
  expect(run(after, before).report.status).toBe("none_found");
});
