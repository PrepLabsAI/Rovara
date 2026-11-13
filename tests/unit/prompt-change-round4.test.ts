import "./prompt-change-offline.js";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { detectPromptChanges, detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
import { PromptChangeItemSchema, PromptChangeReportSchema, promptChangesNeedEval, promptChangesNeedSideBySide } from "../../packages/contracts/src/prompt-change.js";

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
  "const options = customBuilder()", "client.responses.create(params)", "client.responses.create({...options})",
  "const options = {[dynamicKey]: 'value'}", "provider = chooseProvider()", "model: configuredModel", "temperature: getTemperature()",
  "response_format: schemaFactory()", "custom_extension: 1", "model: 'gpt-x'; custom_extension: 1",
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
it("reads an actual report written at 17a2af971 and emits the new schema version", () => {
  const legacy: unknown = JSON.parse(readFileSync(new URL("../fixtures/prompt-change/report-v1.json", import.meta.url), "utf8"));
  const parsed = PromptChangeReportSchema.parse(legacy);
  expect(parsed.schemaVersion).toBe(2);
  expect(parsed.counts).toMatchObject({ model_setting: 1, provider: 0, retrieval: 0, context_assembly: 0, output_parsing: 0 });
  expect(promptChangesNeedSideBySide(parsed).needed).toBe(true);
  const fresh = run("", "provider: 'auto'", "ai/a.ts").report;
  expect(fresh.schemaVersion).toBe(2);
  expect(PromptChangeReportSchema.safeParse({ ...fresh, schemaVersion: 1 }).success).toBe(false);
});

it("unclassified control flow beside a known model never claims complete", () => {
  const report = run("", "import openai\nmodel = 'gpt-x'\nif enabled:\n    pass").report;
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
  expect(run("", "import openai\nconst options = {other: {}};").report.coverage).toBe("partial");
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
