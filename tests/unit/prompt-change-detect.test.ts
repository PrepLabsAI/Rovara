import "./prompt-change-offline.js";
import { describe, expect, it } from "vitest";
import { detectPromptChanges, detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
import { PromptChangeReportSchema, promptChangesNeedEval, promptChangesNeedSideBySide, PromptChangeItemSchema } from "../../packages/contracts/src/prompt-change.js";
import { builtinModelCatalog } from "../../packages/contracts/src/model-catalog-rows.js";
import { readFileSync } from "node:fs";
import { planRecording } from "../../packages/contracts/src/model-record-policy.js";

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
  it.each(["stop_sequences", "stopSequences", "reasoning_effort", "reasoningEffort", "tool_choice", "toolChoice"])("fingerprints setting %s", (key) => expect(kinds(`${key}: ['private stop']`)).toContain("model_setting"));
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

describe("DEC170 goldens, AI signals and new change kinds", () => {
  const run = (before: string, after: string, path = "main.ts") => detectPromptChanges({ files: [{ path, before, after, wholeFile: true }] }, { stats: true });
  // Breaks caught: dropping any DEC170 category, import signal, call/key rule or fingerprint.
  const goldens = [
    ["provider key TS", "ts", "import { generateText } from 'ai';", "provider: 'old'", "provider: 'new'", "provider"],
    ["provider key Python", "py", "import litellm", "model_provider = 'old'", "model_provider = 'new'", "provider"],
    ["provider constructor", "ts", "import { generateText } from 'ai';", "const client = new OpenAI()", "const client = new Anthropic()", "provider"],
    ["provider import TS", "ts", "", "import Client from 'openai';", "import Client from '@anthropic-ai/sdk';", "provider"],
    ["provider import Python", "py", "", "from openai import Client", "from anthropic import Client", "provider"],
    ["LangChain provider Python", "py", "", "from langchain_openai import Client", "from langchain_anthropic import Client", "provider"],
    ["LangChain provider TS", "ts", "", "import { Client } from '@langchain/openai';", "import { Client } from '@langchain/anthropic';", "provider"],
    ["LlamaIndex Python", "py", "from llama_index.core import VectorStoreIndex", "retriever = index.as_retriever(similarity_top_k=2)", "retriever = index.as_retriever(similarity_top_k=5)", "retrieval"],
    ["LlamaIndex TS", "ts", "import { VectorStoreIndex } from 'llamaindex';", "const retriever = index.asRetriever({similarityTopK: 2});", "const retriever = index.asRetriever({similarityTopK: 5});", "retrieval"],
    ["LangChain Python", "py", "from langchain_core.retrievers import BaseRetriever", "retriever = store.as_retriever(search_kwargs={'k': 2})", "retriever = store.as_retriever(search_kwargs={'k': 5})", "retrieval"],
    ["LangChain TS", "ts", "import { BaseRetriever } from '@langchain/core/retrievers';", "const search = store.asRetriever({k: 2});", "const search = store.asRetriever({k: 5});", "retrieval"],
    ["index name", "ts", "import { generateText } from 'ai';", "indexName: 'old'", "indexName: 'new'", "retrieval"],
    ["collection name", "py", "import llama_index", "collection_name = 'old'", "collection_name = 'new'", "retrieval"],
    ["chunking", "py", "from llama_index.core.node_parser import SentenceSplitter", "splitter = SentenceSplitter(chunk_size=128, chunk_overlap=16)", "splitter = SentenceSplitter(chunk_size=256, chunk_overlap=16)", "retrieval"],
    ["embedding model", "ts", "import { generateText } from 'ai';", "embeddingModel: 'old'", "embeddingModel: 'new'", "retrieval"],
    ["context examples Python", "py", "from langchain_core.prompts import FewShotPromptTemplate", "examples = [{'question': 'old'}]", "examples = [{'question': 'new'}]", "context_assembly"],
    ["context examples TS", "ts", "import { FewShotPromptTemplate } from '@langchain/core/prompts';", "fewShotExamples: [{question: 'old'}]", "fewShotExamples: [{question: 'new'}]", "context_assembly"],
    ["message builder Python", "py", "import openai", "def build_messages(topic):\n    return [{'role': 'user', 'content': topic}]", "def build_messages(topic):\n    return [{'role': 'user', 'content': topic.upper()}]", "context_assembly"],
    ["message builder TS", "ts", "import OpenAI from 'openai';", "function buildMessages(topic) { return [{role: 'user', content: topic}]; }", "function buildMessages(topic) { return [{role: 'user', content: topic.toUpperCase()}]; }", "context_assembly"],
    ["template construction", "ts", "import { ChatPromptTemplate } from '@langchain/core/prompts';", "const template = ChatPromptTemplate.fromMessages([['user', 'old']]);", "const template = ChatPromptTemplate.fromMessages([['system', 'old']]);", "context_assembly"],
    ["OpenAI response_format Python", "py", "import openai", "client.chat.completions.create(response_format={'type':'json_schema','json_schema':{'name':'old'}})", "client.chat.completions.create(response_format={'type':'json_schema','json_schema':{'name':'new'}})", "output_parsing"],
    ["OpenAI response_format TS", "ts", "import OpenAI from 'openai';", "client.chat.completions.create({response_format: {type:'json_schema',json_schema:{name:'old'}}});", "client.chat.completions.create({response_format: {type:'json_schema',json_schema:{name:'new'}}});", "output_parsing"],
    ["OpenAI structured TS", "ts", "import { zodTextFormat } from 'openai/helpers/zod';", "client.responses.parse({text: {format: zodTextFormat(Old, 'answer')}});", "client.responses.parse({text: {format: zodTextFormat(New, 'answer')}});", "output_parsing"],
    ["OpenAI structured Python", "py", "import openai", "client.responses.parse(text_format=Old)", "client.responses.parse(text_format=New)", "output_parsing"],
    ["Pydantic output parser", "py", "from langchain_core.output_parsers import PydanticOutputParser", "parser = PydanticOutputParser(pydantic_object=Old)", "parser = PydanticOutputParser(pydantic_object=New)", "output_parsing"],
    ["structured output TS", "ts", "import { ChatOpenAI } from '@langchain/openai';", "const chain = model.withStructuredOutput(Old);", "const chain = model.withStructuredOutput(New);", "output_parsing"],
    ["structured output Python", "py", "from langchain_openai import ChatOpenAI", "chain = model.with_structured_output(Old)", "chain = model.with_structured_output(New)", "output_parsing"],
    ["response schema", "ts", "import { generateText } from 'ai';", "responseSchema: {type: 'string'}", "responseSchema: {type: 'number'}", "output_parsing"],
  ] as const;
  it.each(goldens)("DEC170 golden: %s", (_name, ext, signal, before, after, kind) => {
    const result = run(`${signal}\n${before}`, `${signal}\n${after}`, `main.${ext}`);
    const items = result.report.items.filter((item) => item.kind === kind);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.fingerprintAfter ?? item.fingerprintBefore).toMatch(/^[a-f0-9]{64}$/u);
      expect(item).not.toHaveProperty("before"); expect(item).not.toHaveProperty("after");
    }
    expect(promptChangesNeedEval(result.report).needed).toBe(true);
    expect(promptChangesNeedSideBySide(result.report).needed).toBe(true);
    expect(PromptChangeReportSchema.safeParse(result.report).success).toBe(true);
  });

  it.each(["provider", "retriever", "indexName", "collection_name", "chunk_size", "embeddingModel", "examples", "fewShotExamples", "response_format", "responseSchema", "output_parser"])("requires an AI signal for %s", (key) => {
    expect(run(`${key}: 'old'`, `${key}: 'new'`).report).toMatchObject({ status: "none_found", items: [] });
  });
  it.each(["asRetriever", "SentenceSplitter", "withStructuredOutput", "PydanticOutputParser", "buildMessages"])("does not infer AI from the ordinary call %s", (call) => {
    expect(run(`${call}('old')`, `${call}('new')`).report).toMatchObject({ status: "none_found", items: [] });
  });
  it.each(["llamaindex-like", "llama_indexer", "langchainish", "@langchainish/core"])("package lookalike %s is not an AI signal", (pkg) => {
    expect(run(`import X from '${pkg}'; provider: 'old'`, `import X from '${pkg}'; provider: 'new'`).report.items).toEqual([]);
  });
  it.each([
    "client.chat.create({options: customBuilder()})", "client.responses.create(params)", "client.responses.create({...options})",
    "client.chat.create({[dynamicKey]: 'value'})", "provider = chooseProvider()", "model: configuredModel", "temperature: getTemperature()",
    "response_format: schemaFactory()", "client.chat.create({custom_extension: 1})", "model: 'gpt-x'; custom_extension: 1",
    "const reply = client.chat.completions.create({messages: [], max_retries: 2})", "const client = new OpenAI(); console.log(client)",
  ])("unclassified AI construct is partial: %s", (source) => {
    const report = run("", `import OpenAI from 'openai';\n${source}`).report;
    expect(report.coverage).toBe("partial");
    expect(report.incompleteReasons).toContain("unclassified_ai");
    expect(promptChangesNeedEval(report).needed).toBe(true);
    expect(promptChangesNeedSideBySide(report).needed).toBe(true);
  });
  it("both selectors include sampling and endpoint-only changes", () => {
    for (const source of ["temperature: 0.2", "endpoint: 'https://api.openai.com/v1'"]) {
      const report = run("", source, "ai/a.ts").report;
      expect(report.items).toHaveLength(1);
      expect(report.coverage).toBe("complete");
      expect(promptChangesNeedSideBySide(report)).toEqual({ needed: true, reason: "changes" });
    }
  });
  it("new kinds never echo even safe enum words, numbers or hostile text", () => {
    const hostile = ["canary", String(Math.random()), "[![x](url)](url) @person #123 <b>\u200b\ufe0f\n# > --- ``` ~~~"].join(" ");
    for (const key of ["provider", "retrieval", "examples", "response_schema"]) for (const value of [hostile, "auto", 123]) {
      const result = run("", `${key}: ${JSON.stringify(value)}`, "ai/a.ts");
      expect(result.report.items).toHaveLength(1);
      const item = result.report.items[0]!;
      expect(item).not.toHaveProperty("after");
      expect(PromptChangeItemSchema.safeParse({ ...item, after: value }).success).toBe(false);
      expect(JSON.stringify(result)).not.toContain(hostile);
    }
  });
  it("normalizes new structured values and preserves a change inside them", () => {
    for (const key of ["retrieval", "examples", "response_schema"]) {
      const before = `${key}: { nested: ['a', 'b'] }`;
      expect(run(before, `${key}: {\n nested : [ 'a' , 'b' ]\n}`, "ai/a.ts").report.status).toBe("none_found");
      expect(run(before, `${key}: { nested: ['a', 'c'] }`, "ai/a.ts").report.items).toHaveLength(1);
    }
  });
  it("detects new kinds in hunks and conservatively selects their incomplete reports", () => {
    const report = detectPromptChangesInDiff("diff --git a/ai/a.py b/ai/a.py\n@@ -1 +1 @@\n-collection_name = 'old'\n+collection_name = 'new'\n").report;
    expect(report.items).toMatchObject([{ kind: "retrieval", verb: "modified" }]);
    expect(report.coverage).toBe("hunks_only");
  });
  it("reads an actual report written at 17a2af971 as v1 and emits the new schema version when fresh", () => {
    const legacy: unknown = JSON.parse(readFileSync(new URL("../fixtures/prompt-change/report-v1.json", import.meta.url), "utf8"));
    const parsed = PromptChangeReportSchema.parse(legacy);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.counts).toMatchObject({ model_setting: 1, provider: 0, retrieval: 0, context_assembly: 0, output_parsing: 0 });
    expect(promptChangesNeedSideBySide(parsed).needed).toBe(true);
    const fresh = run("", "provider: 'auto'", "ai/a.ts").report;
    expect(fresh.schemaVersion).toBe(2);
    expect(PromptChangeReportSchema.safeParse({ ...fresh, schemaVersion: 1 }).success).toBe(false);
  });

  it("unclassified control flow beside a known model never claims complete", () => {
    const report = run("", "import openai\nmodel = 'gpt-x'; if enabled: pass").report;
    expect(report.coverage).toBe("partial");
  });
  it("changed message roles and assembly methods produce context items", () => {
    for (const [before, after] of [
      ["messages = [{role: 'user', content: 'same'}]", "messages = [{role: 'system', content: 'same'}]"],
      ["messages.push({role:'user', content: value})", "messages.unshift({role:'user', content: value})"],
    ]) {
      const report = run(`import openai\n${before}`, `import openai\n${after}`).report;
      expect(report.items.some((item) => item.kind === "context_assembly")).toBe(true);
    }
  });
  it("nested content in an AI container with no classified rule stays partial", () => {
    expect(run("", "import openai\nconst r = client.chat.completions.create({other: {}});").report.coverage).toBe("partial");
  });
  it.each(["import { openai } from './ordinary';", "import openai from './ordinary';", "from ordinary import openai", "const note = 'llamaindex';"])("SDK-looking symbols are not module signals: %s", (prefix) => {
    expect(run(`${prefix}\nprovider: 'old'`, `${prefix}\nprovider: 'new'`).report.items).toEqual([]);
  });
  it("Python builder fingerprint stops at the next unindented statement", () => {
    const builder = "import openai\ndef build_messages(x):\n    return [{'role': 'user', 'content': x}]\n";
    expect(run(builder + "unrelated = 1", builder + "unrelated = 2", "main.py").report.items).toEqual([]);
  });
  it("structured YAML new keys include their indented values", () => {
    const before = "retrieval:\n  collection_name: old\n  similarity_top_k: 3\n";
    const report = run(before, before.replace("old", "new"), "ai/config.yaml").report;
    expect(report.items).toMatchObject([{ kind: "retrieval", verb: "modified" }]);
  });
  it("model-looking fields inside extended values remain fingerprint-only", () => {
    const canary = ['private', String(Math.floor(Math.random() * 1e9))].join('-');
    for (const key of ["provider", "retrieval", "examples", "response_schema"]) {
      const result = run("", `${key}: {model: '${canary}', temperature: 123}`, "ai/a.ts");
      expect(result.report.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(result.report.items.every((item) => !("after" in item) && !("before" in item))).toBe(true);
    }
  });
  it("an opaque AI-file expression without a known construct is partial", () => {
    expect(run("", "opaque", "ai/a.ts").report.coverage).toBe("partial");
  });
  it("ordinary array methods do not become context changes beside an AI import", () => {
    expect(run("import openai\nitems.push(1)", "import openai\nitems.unshift(1)").report.items).toEqual([]);
  });

  // M-1: a v1 detector could not see provider/retrieval/context/output changes, so its "nothing found" proves less.
  const withoutNewCounts = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).filter(([name]) => !NEW.includes(name)));
  const NEW = ["provider", "retrieval", "context_assembly", "output_parsing"];
  const v1NoneFound = () => {
    const fresh = run("", "").report;
    return { ...fresh, schemaVersion: 1, counts: withoutNewCounts(fresh.counts) };
  };
  it("a v1 none_found report reads as v1 and both selectors treat it as incomplete for the new kinds", () => {
    const legacy = v1NoneFound();
    expect(legacy).toMatchObject({ status: "none_found", coverage: "complete", items: [] });
    const parsed = PromptChangeReportSchema.parse(legacy);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.counts).toMatchObject({ provider: 0, retrieval: 0, context_assembly: 0, output_parsing: 0 });
    expect(promptChangesNeedEval(parsed)).toEqual({ needed: true, reason: "incomplete" });
    expect(promptChangesNeedSideBySide(parsed)).toEqual({ needed: true, reason: "incomplete" });
    const fresh = PromptChangeReportSchema.parse(run("", "").report);
    expect(fresh.schemaVersion).toBe(2);
    expect(promptChangesNeedEval(fresh)).toEqual({ needed: false, reason: "none_found" });
    expect(promptChangesNeedSideBySide(fresh)).toEqual({ needed: false, reason: "none_found" });
  });
  it("v1 reports may state the new counts only as zero; v2 must state every count", () => {
    const legacy = v1NoneFound();
    expect(PromptChangeReportSchema.safeParse({ ...legacy, counts: { ...legacy.counts, provider: 0 } }).success).toBe(true);
    expect(PromptChangeReportSchema.safeParse({ ...legacy, counts: { ...legacy.counts, provider: 1 } }).success).toBe(false);
    const fresh = run("", "provider: 'a'", "ai/a.ts").report;
    for (const kind of ["provider", "retrieval", "context_assembly", "output_parsing"] as const) {
      const counts = Object.fromEntries(Object.entries(fresh.counts).filter(([name]) => name !== kind));
      expect(PromptChangeReportSchema.safeParse({ ...fresh, counts }).success).toBe(false);
    }
  });
  it("a v1 truncated report cannot carry new-kind counts", () => {
    const fresh = run("", Array.from({ length: 501 }, (_, n) => `/* ${n} */ temperature: ${n}`).join("\n"), "ai/a.ts").report;
    expect(fresh.itemsTruncated).toBe(true);
    const oldCounts = withoutNewCounts(fresh.counts);
    expect(PromptChangeReportSchema.safeParse({ ...fresh, schemaVersion: 1, counts: oldCounts }).success).toBe(true);
    expect(PromptChangeReportSchema.safeParse({ ...fresh, schemaVersion: 1, counts: { ...oldCounts, provider: 3 } }).success).toBe(false);
  });

  // M-2: an AI SDK import alone must not make unrelated code partial. Only constructs inside or beside an AI region do.
  const unrelated = ["console.log('x')", "export default {name: 'app'}", "const unrelated = {a: {b: 1}}", "doThing(1, 2)", "const x = [...items]", "if (ready) { go() }"];
  it.each(unrelated)("unrelated code in an AI-importing file stays complete and classified: %s", (line) => {
    const same = run(`import OpenAI from 'openai';\n${line}`, `import OpenAI from 'openai';\n${line}`).report;
    expect(same).toMatchObject({ status: "none_found", coverage: "complete", items: [] });
    const changed = run(`import OpenAI from 'openai';\n${line}\nconst SYSTEM = 'old';`, `import OpenAI from 'openai';\n${line}\nconst SYSTEM = 'new';`).report;
    expect(changed).toMatchObject({ status: "changes", coverage: "complete" });
    expect(changed.items).toMatchObject([{ kind: "prompt_text", verb: "modified" }]);
    expect(promptChangesNeedEval(same)).toEqual({ needed: false, reason: "none_found" });
  });
  it("Python AI imports with unrelated defs and main guards are complete", () => {
    const source = "import openai\n\ndef helper(x):\n    return x + 1\n\nif __name__ == '__main__':\n    print(helper(1))\n";
    expect(run(source, source, "main.py").report).toMatchObject({ status: "none_found", coverage: "complete" });
  });
  it("a provider constructor beside an unrelated call line is complete when they do not share a line", () => {
    const source = "import OpenAI from 'openai';\nconst client = new OpenAI();\nconsole.log('ready');";
    expect(run(source, source).report).toMatchObject({ status: "none_found", coverage: "complete" });
  });
  it.each([
    "client.chat.completions.create({model: 'gpt-x', messages: build(x)})",
    "client.chat.completions.create({model: 'gpt-x', weird_option: {nested: 1}})",
    "client.chat.completions.create({model: 'gpt-x', ...extra})",
  ])("a construct it cannot classify inside an AI call stays partial: %s", (source) => {
    const report = run("", `import OpenAI from 'openai';\n${source}`).report;
    expect(report.coverage).toBe("partial");
    expect(report.incompleteReasons).toContain("unclassified_ai");
  });
  it("work stays linear for thousands of items in an AI-importing file", () => {
    const body = (n: number) => "import OpenAI from 'openai';\n" + Array.from({ length: n }, (_, k) => `console.log(${k}); client.chat.create({custom_${k}: 1});\n`).join("");
    const a = run("", body(500), "main.ts").stats!.steps; const b = run("", body(2000), "main.ts").stats!.steps;
    expect(b).toBeLessThanOrEqual(4.6 * a);
  });
  it("a non-provider SDK import with only unrelated code is complete", () => {
    const source = "import { RunnableLambda } from 'langchain/runnables';\nconsole.log('x');";
    expect(run(source, source).report).toMatchObject({ status: "none_found", coverage: "complete", items: [] });
  });

  // The value of an extended construct continues on later lines. A change there must be detected or partial, never none_found.
  it.each([
    ["filter", "const messages = [{role:'user',content:'a'}]\n  .filter(isOk);", "const messages = [{role:'user',content:'a'}]\n  .filter(isBad);"],
    ["map", "const messages = [{role:'user',content:'a'}]\n  .map(f);", "const messages = [{role:'user',content:'a'}]\n  .map(g);"],
    ["slice", "const examples = [{q: 'a'}]\n  .slice(0, 2);", "const examples = [{q: 'a'}]\n  .slice(0, 3);"],
    ["property", "const retrieval = {k: 2}\n  .k;", "const retrieval = {k: 2}\n  .z;"],
    ["multi-line container", "const messages = [\n  {role:'user',content:'a'},\n].filter(isOk);", "const messages = [\n  {role:'user',content:'a'},\n].filter(isBad);"],
    ["trailing operator", "const examples = [{q: 'a'}] +\n  extraOne;", "const examples = [{q: 'a'}] +\n  extraTwo;"],
    ["optional chain", "const retrieval = {k: 2}\n  ?.k;", "const retrieval = {k: 2}\n  ?.z;"],
  ])("a continuation of an extended value on a later line is not missed: %s", (_name, before, after) => {
    const report = run(`import OpenAI from 'openai';\n${before}`, `import OpenAI from 'openai';\n${after}`).report;
    expect(report.status).not.toBe("none_found");
    expect(promptChangesNeedEval(report).needed).toBe(true);
    expect(promptChangesNeedSideBySide(report).needed).toBe(true);
    const same = run(`import OpenAI from 'openai';\n${before}`, `import OpenAI from 'openai';\n${before}`).report;
    expect(same.status).toBe("none_found");
  });
  it("a following statement on a later line is not swallowed into the extended value", () => {
    const source = (tail: string) => `import OpenAI from 'openai';\nconst examples = [{q: 'a'}]\n${tail}`;
    expect(run(source("const other = 1;"), source("const other = 2;")).report.status).toBe("none_found");
  });
  it("a v1 none_found report plans recording as ready with no items, and F10 selects work", () => {
    const parsed = PromptChangeReportSchema.parse(v1NoneFound());
    expect(planRecording(v1NoneFound())).toEqual({ status: "ready", items: [], itemsOmitted: false });
    expect(promptChangesNeedSideBySide(parsed)).toEqual({ needed: true, reason: "incomplete" });
  });

  // A trailing backslash continues the value on the next line (Python).
  it.each([
    ["conditional tail", "messages = [{'role': 'user'}] \\\n  if cond else []", "messages = [{'role': 'user'}] \\\n  if cond2 else []"],
    ["backslash after else", "messages = [1] if cond else \\\n  [2]", "messages = [1] if cond else \\\n  [3]"],
  ])("a trailing backslash continues an extended value: %s", (_name, before, after) => {
    const report = run(`import openai\n${before}`, `import openai\n${after}`, "m.py").report;
    expect(report.status).not.toBe("none_found");
    expect(promptChangesNeedEval(report).needed).toBe(true);
    expect(run(`import openai\n${before}`, `import openai\n${before}`, "m.py").report.status).toBe("none_found");
  });
});

