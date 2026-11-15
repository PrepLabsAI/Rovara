import "./prompt-change-offline.js";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { detectPromptChanges, detectPromptChangesInDiff } from "../../packages/contracts/src/prompt-change-detect.js";
import { planRecording } from "../../packages/contracts/src/model-record-policy.js";
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

// Round 2: the value of an extended construct continues on later lines. A change there must be detected or partial, never none_found.
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

// Round 3: a trailing backslash continues the value on the next line (Python).
it.each([
  ["conditional tail", "messages = [{'role': 'user'}] \\\n  if cond else []", "messages = [{'role': 'user'}] \\\n  if cond2 else []"],
  ["backslash after else", "messages = [1] if cond else \\\n  [2]", "messages = [1] if cond else \\\n  [3]"],
])("a trailing backslash continues an extended value: %s", (_name, before, after) => {
  const report = run(`import openai\n${before}`, `import openai\n${after}`, "m.py").report;
  expect(report.status).not.toBe("none_found");
  expect(promptChangesNeedEval(report).needed).toBe(true);
  expect(run(`import openai\n${before}`, `import openai\n${before}`, "m.py").report.status).toBe("none_found");
});
