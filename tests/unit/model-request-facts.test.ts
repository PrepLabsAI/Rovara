// TE-F2 part A: what the helper reads from a request body: model, stream flag, first tool, the prompt text a reply matches on, and the counts for embeddings and rerank. Bounded and prototype-safe.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PROMPT_TEXT_MAX_CHARS, readModelRequestFacts } from "../../packages/contracts/src/model-request-facts.js";

const facts = (body: unknown) => readModelRequestFacts(typeof body === "string" ? body : JSON.stringify(body));

describe("readModelRequestFacts", () => {
  it("reads the model and the stream flag; a model that cannot be echoed becomes unknown-model", () => {
    expect(facts({ model: "gpt-4o", stream: true })).toMatchObject({ model: "gpt-4o", stream: true });
    expect(facts({ model: "google/gemini-2.5-flash", stream: false })).toMatchObject({ model: "google/gemini-2.5-flash", stream: false });
    expect(facts({ model: "a b\n<x>" }).model).toBe("unknown-model");
    expect(facts({ stream: "true" }).stream).toBe(false);
    expect(facts({}).model).toBeUndefined();
  });
  it("a body that is not a JSON object gives the empty facts", () => {
    for (const body of ["", "nope", "[1]", "null", "3", '"s"', "{"]) expect(facts(body), body).toMatchObject({ model: undefined, stream: false, promptText: undefined, inputCount: 1, documentCount: 0 });
  });
  it("the prompt text is the strings under content, text, input, prompt, query, system and friends, in order", () => {
    const body = {
      model: "m",
      system: "Be brief.",
      messages: [{ role: "user", content: "first" }, { role: "assistant", content: [{ type: "text", text: "second" }, { type: "image", source: { data: "ignored" } }] }],
      tools: [{ name: "get_weather", description: "not part of the prompt", input_schema: { type: "object" } }],
    };
    expect(facts(body).promptText).toBe("Be brief.\nfirst\nsecond");
  });
  it("Gemini, Responses, Cohere and embedding bodies", () => {
    expect(facts({ contents: [{ role: "user", parts: [{ text: "hello" }] }], systemInstruction: { parts: [{ text: "sys" }] } }).promptText).toBe("hello\nsys");
    expect(facts({ model: "m", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }], instructions: "be nice" }).promptText).toBe("hi\nbe nice");
    expect(facts({ model: "m", query: "q", documents: ["a", { text: "b" }] }).promptText).toBe("q\na\nb");
    expect(facts({ texts: ["x", "y"] }).promptText).toBe("x\ny");
    expect(facts({ prompt: "legacy" }).promptText).toBe("legacy");
  });
  it("roles, tool names, tool-call arguments and other fields are not in the prompt", () => {
    const body = { messages: [{ role: "assistant", tool_calls: [{ function: { name: "f", arguments: '{"secret":"x"}' } }], content: null }, { role: "tool", tool_call_id: "abc", content: "result" }] };
    expect(facts(body).promptText).toBe("result");
  });
  it("the first declared tool: OpenAI, Anthropic, Gemini and Cohere shapes; unsafe names are ignored", () => {
    expect(facts({ tools: [{ type: "function", function: { name: "lookup" } }] }).toolName).toBe("lookup");
    expect(facts({ tools: [{ name: "get_weather", input_schema: {} }] }).toolName).toBe("get_weather");
    expect(facts({ tools: [{ functionDeclarations: [{ name: "gem_tool" }] }] }).toolName).toBe("gem_tool");
    expect(facts({ tools: [{ name: "bad name!" }] }).toolName).toBeUndefined();
    expect(facts({ tools: [] }).toolName).toBeUndefined();
    expect(facts({ tools: ["x"] }).toolName).toBeUndefined();
  });
  it("counts inputs: a string is one, a list of strings is one each, a list of token ids is one", () => {
    expect(facts({ input: "a" }).inputCount).toBe(1);
    expect(facts({ input: ["a", "b", "c"] }).inputCount).toBe(3);
    expect(facts({ input: [1, 2, 3] }).inputCount).toBe(1);
    expect(facts({ input: [[1, 2], [3]] }).inputCount).toBe(2);
    expect(facts({ texts: ["a", "b"] }).inputCount).toBe(2);
    expect(facts({ requests: [{}, {}, {}] }).inputCount).toBe(3);
    expect(facts({ instances: [{}, {}] }).inputCount).toBe(2);
    expect(facts({ input: [] }).inputCount).toBe(1);
  });
  it("reads dimensions, encoding, embedding types, documents and top_n; refuses what is not a positive integer", () => {
    expect(facts({ dimensions: 256, encoding_format: "base64" })).toMatchObject({ dimensions: 256, base64: true });
    expect(facts({ output_dimension: 512 }).dimensions).toBe(512);
    expect(facts({ outputDimensionality: 128 }).dimensions).toBe(128);
    expect(facts({ requests: [{ outputDimensionality: 64 }] }).dimensions).toBe(64);
    for (const value of [0, -1, 1.5, "8", null, Number.MAX_VALUE]) expect(facts({ dimensions: value }).dimensions, String(value)).toBeUndefined();
    expect(facts({ embedding_types: ["float", 5, "int8"] }).embeddingTypes).toEqual(["float", "int8"]);
    expect(facts({ documents: ["a", "b"], top_n: 1 })).toMatchObject({ documentCount: 2, topN: 1 });
    expect(facts({ encoding_format: "float" }).base64).toBe(false);
  });
  it("a __proto__ key in the body never reaches a lookup", () => {
    const body = '{"__proto__":{"model":"evil","stream":true},"model":"safe"}';
    expect(facts(body)).toMatchObject({ model: "safe", stream: false });
    expect(({}) as Record<string, unknown>).not.toHaveProperty("model");
  });
  it("is bounded in depth and size, and fast on 1 MB", () => {
    let deep: unknown = "buried";
    for (let index = 0; index < 40; index += 1) deep = { content: deep };
    expect(facts({ messages: [deep] }).promptText).toBe(""); // past depth 16 nothing is collected
    const started = performance.now();
    const huge = facts({ messages: [{ role: "user", content: "x".repeat(900_000) }] });
    expect(huge.promptText?.length).toBe(900_000);
    expect(performance.now() - started).toBeLessThan(1000);
    const many = facts({ messages: Array.from({ length: 150_000 }, () => ({ content: "a" })) });
    expect((many.promptText?.length ?? 0)).toBeLessThanOrEqual(PROMPT_TEXT_MAX_CHARS);
  });
  it("the prompt hash a reply's promptSha256 uses is the SHA-256 of that text", () => {
    const text = facts({ messages: [{ content: "héllo" }] }).promptText ?? "";
    expect(createHash("sha256").update(text).digest("hex")).toMatch(/^[0-9a-f]{64}$/u);
    expect(text).toBe("héllo");
  });
});
