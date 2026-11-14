// TE-F2 part A: the OpenAI Responses API and embeddings shapes, models list, and the Gemini/Vertex embedding and models shapes F0a does not build. Golden bytes; pure (a socket or fetch fails the test). Shapes are from the
// vendors' public docs; nothing was compared with a live answer (UNVERIFIED items are in the file headers). The repo's Node `openai` SDK parse is in the loopback check, not here.
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENAI_EMBEDDING_DEFAULT_DIMENSIONS, buildOpenAiEmbeddings, buildOpenAiModel, buildOpenAiModelsList, buildOpenAiResponse, buildOpenAiResponseStreamEvents, openAiResponseStreamBody } from "../../packages/contracts/src/model-family-openai-ops.js";
import { GEMINI_EMBEDDING_DEFAULT_DIMENSIONS, buildGeminiBatchEmbedContents, buildGeminiEmbedContent, buildGeminiModel, buildGeminiModelsList, buildVertexPredictEmbeddings } from "../../packages/contracts/src/model-family-gemini-extra.js";
import { float32Base64, quantized, seededVector } from "../../packages/contracts/src/model-family-vectors.js";
import { parseNamedSseText } from "../../packages/contracts/src/model-sse-named.js";
import { MODEL_REPLY_MAX_CHARS, seededId, type ModelReply } from "../../packages/contracts/src/model-family-common.js";

let connects = 0;
let fetches = 0;
beforeEach(() => {
  connects = 0;
  fetches = 0;
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function stub(this: net.Socket) {
    connects += 1;
    throw new Error("a socket was opened in an offline test");
  });
  vi.stubGlobal("fetch", () => {
    fetches += 1;
    throw new Error("fetch was called in an offline test");
  });
});
afterEach(() => {
  expect(connects).toBe(0);
  expect(fetches).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const reply = (over: Partial<ModelReply> = {}): ModelReply => ({ text: "Hello from the scripted reply.", finish: "stop", usage: { inputTokens: 7, outputTokens: 5 }, ...over });
const build = { model: "gpt-test", seed: "seed-1", created: 1_700_000_000 } as const;
const respId = `resp_${seededId("seed-1")}`;
const msgId = `msg_${seededId("seed-1:message")}`;

describe("the Responses API: whole body", () => {
  it("a text answer: golden bytes", () => {
    expect(JSON.stringify(buildOpenAiResponse(reply(), build))).toBe(
      `{"id":"${respId}","object":"response","created_at":1700000000,"status":"completed","error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"model":"gpt-test","output":[{"type":"message","id":"${msgId}","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello from the scripted reply.","annotations":[]}]}],"parallel_tool_calls":true,"previous_response_id":null,"store":true,"temperature":1,"tool_choice":"auto","tools":[],"top_p":1,"truncation":"disabled","usage":{"input_tokens":7,"input_tokens_details":{"cached_tokens":0},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":12},"user":null,"metadata":{}}`,
    );
  });
  it("a function call is an output item with a call id and the arguments as a JSON string", () => {
    const body = buildOpenAiResponse(reply({ text: "", toolCalls: [{ name: "get_weather", args: { city: "Paris" } }], finish: "tool_calls" }), build) as { output: Record<string, unknown>[] };
    expect(body.output).toHaveLength(1);
    expect(body.output[0]).toEqual({ type: "function_call", id: `fc_${seededId("seed-1:fc:0:get_weather")}`, call_id: `call_${seededId("seed-1:0:get_weather")}`, name: "get_weather", arguments: '{"city":"Paris"}', status: "completed" });
  });
  it("length is incomplete with max_output_tokens, safety is incomplete with content_filter", () => {
    expect(buildOpenAiResponse(reply({ finish: "length" }), build)).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    expect(buildOpenAiResponse(reply({ finish: "safety" }), build)).toMatchObject({ status: "incomplete", incomplete_details: { reason: "content_filter" } });
    expect(buildOpenAiResponse(reply({ finish: "stop" }), build)).toMatchObject({ status: "completed", incomplete_details: null });
  });
  it("a refusal option renders a refusal content part", () => {
    const body = buildOpenAiResponse(reply({ text: "No." }), { ...build, refusal: true }) as { output: { content: unknown[] }[] };
    expect(body.output[0]?.content).toEqual([{ type: "refusal", refusal: "No." }]);
  });
  it("refuses what a builder must never render", () => {
    expect(() => buildOpenAiResponse(reply({ text: "x".repeat(MODEL_REPLY_MAX_CHARS + 1) }), build)).toThrow(RangeError);
    expect(() => buildOpenAiResponse(reply(), { ...build, model: "a b" })).toThrow(RangeError);
  });
});

describe("the Responses API: the named-event stream", () => {
  it("event order for a text answer, with sequence numbers and no [DONE]", () => {
    const events = buildOpenAiResponseStreamEvents(reply(), build);
    expect(events.map((event) => event.event)).toEqual([
      "response.created", "response.in_progress", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed",
    ]);
    events.forEach((event, index) => {
      const data = JSON.parse(event.data) as { type: string; sequence_number: number };
      expect(data.type).toBe(event.event);
      expect(data.sequence_number).toBe(index);
    });
    const body = openAiResponseStreamBody(reply(), build, "lf");
    expect(body).not.toContain("[DONE]");
    expect(body.startsWith("event: response.created\ndata: {")).toBe(true);
    expect(body.endsWith("\n\n")).toBe(true);
    expect(openAiResponseStreamBody(reply(), build, "crlf")).toBe(body.replaceAll("\n", "\r\n"));
  });
  it("the deltas join to the text and the last event holds the whole response", () => {
    const text = "Pieces ".repeat(30);
    const events = buildOpenAiResponseStreamEvents(reply({ text }), build);
    expect(events.filter((event) => event.event === "response.output_text.delta").map((event) => (JSON.parse(event.data) as { delta: string }).delta).join("")).toBe(text);
    const last = JSON.parse(events.at(-1)?.data ?? "{}") as { response: unknown };
    expect(last.response).toEqual(buildOpenAiResponse(reply({ text }), build));
  });
  it("a length stop ends with response.incomplete", () => {
    expect(buildOpenAiResponseStreamEvents(reply({ finish: "length" }), build).at(-1)?.event).toBe("response.incomplete");
  });
  it("a function call streams its arguments and ends the item", () => {
    const events = buildOpenAiResponseStreamEvents(reply({ text: "", toolCalls: [{ name: "f", args: { a: 1 } }], finish: "tool_calls" }), build);
    expect(events.map((event) => event.event)).toEqual(["response.created", "response.in_progress", "response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done", "response.completed"]);
    expect((JSON.parse(events[4]?.data ?? "{}") as { arguments: string }).arguments).toBe('{"a":1}');
  });
  it("a refusal streams refusal events", () => {
    const names = buildOpenAiResponseStreamEvents(reply({ text: "No." }), { ...build, refusal: true }).map((event) => event.event);
    expect(names).toContain("response.refusal.delta");
    expect(names).toContain("response.refusal.done");
    expect(names).not.toContain("response.output_text.delta");
  });
  it("round-trips through the named-SSE parser", () => {
    const parsed = parseNamedSseText(openAiResponseStreamBody(reply(), build, "crlf"));
    expect(parsed.ok && parsed.complete && parsed.events.length).toBe(9);
  });
});

describe("embeddings", () => {
  it("a list with one embedding per input, the default dimension, usage", () => {
    const body = buildOpenAiEmbeddings({ model: "te", seed: "s", inputCount: 2, dimensions: undefined, base64: false, promptTokens: 6 }) as { object: string; data: { object: string; index: number; embedding: number[] }[]; model: string; usage: unknown };
    expect(body.object).toBe("list");
    expect(body.data.map((item) => [item.object, item.index, item.embedding.length])).toEqual([["embedding", 0, OPENAI_EMBEDDING_DEFAULT_DIMENSIONS], ["embedding", 1, OPENAI_EMBEDDING_DEFAULT_DIMENSIONS]]);
    expect(body.usage).toEqual({ prompt_tokens: 6, total_tokens: 6 });
    expect(body.data[0]?.embedding).not.toEqual(body.data[1]?.embedding);
  });
  it("the base64 form (the Python SDK's default) decodes to the same float32 numbers", () => {
    const floats = buildOpenAiEmbeddings({ model: "te", seed: "s", inputCount: 1, dimensions: 8, base64: false, promptTokens: 1 }) as { data: { embedding: number[] }[] };
    const encoded = buildOpenAiEmbeddings({ model: "te", seed: "s", inputCount: 1, dimensions: 8, base64: true, promptTokens: 1 }) as { data: { embedding: string }[] };
    const raw = Buffer.from(encoded.data[0]?.embedding ?? "", "base64");
    expect(raw.byteLength).toBe(32);
    const decoded = Array.from({ length: 8 }, (_, index) => raw.readFloatLE(index * 4));
    expect(decoded).toEqual(floats.data[0]?.embedding);
  });
  it("is deterministic and bounded; dimensions and counts are clamped", () => {
    const one = JSON.stringify(buildOpenAiEmbeddings({ model: "te", seed: "s", inputCount: 1, dimensions: 4, base64: false, promptTokens: 1 }));
    expect(one).toBe(JSON.stringify(buildOpenAiEmbeddings({ model: "te", seed: "s", inputCount: 1, dimensions: 4, base64: false, promptTokens: 1 })));
    const big = buildOpenAiEmbeddings({ model: "te", seed: "s", inputCount: 99_999, dimensions: 99_999, base64: false, promptTokens: -5 }) as { data: { embedding: number[] }[]; usage: { prompt_tokens: number } };
    expect(big.data).toHaveLength(2048);
    expect(big.data[0]?.embedding).toHaveLength(4096);
    expect(big.usage.prompt_tokens).toBe(0);
    expect((buildOpenAiEmbeddings({ model: "te", seed: "s", inputCount: 0, dimensions: 0, base64: false, promptTokens: 1 }) as { data: unknown[] }).data).toHaveLength(1);
  });
});

describe("models list and get", () => {
  it("OpenAI: a list of model objects; unsafe ids are dropped", () => {
    expect(buildOpenAiModelsList(["gpt-test", "bad name", "google/gemini-2.5-flash"], 5)).toEqual({
      object: "list",
      data: [{ id: "gpt-test", object: "model", created: 5, owned_by: "rovara-scripted" }, { id: "google/gemini-2.5-flash", object: "model", created: 5, owned_by: "rovara-scripted" }],
    });
    expect(buildOpenAiModel("a b", 1)).toMatchObject({ id: "unknown-model" });
    expect((buildOpenAiModelsList(Array.from({ length: 500 }, (_, index) => `m${String(index)}`), 1) as { data: unknown[] }).data).toHaveLength(128);
  });
  it("Gemini: a models list of Model resources", () => {
    expect(buildGeminiModel("gemini-2.5-flash")).toMatchObject({ name: "models/gemini-2.5-flash", displayName: "gemini-2.5-flash" });
    expect(buildGeminiModel("a b")).toMatchObject({ name: "models/unknown-model" });
    expect((buildGeminiModelsList(["a", "b"]) as { models: unknown[] }).models).toHaveLength(2);
  });
});

describe("Gemini and Vertex embeddings", () => {
  it("embedContent: one embedding with values (default 768)", () => {
    const body = buildGeminiEmbedContent({ seed: "s", dimensions: undefined }) as { embedding: { values: number[] } };
    expect(body.embedding.values).toHaveLength(GEMINI_EMBEDDING_DEFAULT_DIMENSIONS);
    expect(Object.keys(body)).toEqual(["embedding"]);
  });
  it("batchEmbedContents: one embedding per request", () => {
    const body = buildGeminiBatchEmbedContents({ seed: "s", count: 3, dimensions: 4 }) as { embeddings: { values: number[] }[] };
    expect(body.embeddings.map((item) => item.values.length)).toEqual([4, 4, 4]);
    expect(body.embeddings[0]?.values).not.toEqual(body.embeddings[1]?.values);
  });
  it("Vertex :predict: predictions with embeddings.values and statistics", () => {
    const body = buildVertexPredictEmbeddings({ seed: "s", count: 2, dimensions: 4, tokenCount: 3 }) as { predictions: { embeddings: { values: number[]; statistics: unknown } }[] };
    expect(body.predictions).toHaveLength(2);
    expect(body.predictions[0]?.embeddings.statistics).toEqual({ truncated: false, token_count: 3 });
    expect(body.predictions[0]?.embeddings.values).toHaveLength(4);
  });
});

describe("filler vectors", () => {
  it("are float32-exact, near unit length and stable", () => {
    const vector = seededVector("x", 64);
    expect(vector).toEqual(seededVector("x", 64));
    for (const value of vector) expect(Math.fround(value)).toBe(value);
    const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(length).toBeGreaterThan(0.3);
    expect(length).toBeLessThan(1.2);
    expect(seededVector("x", 0)).toHaveLength(1);
    expect(seededVector("x", Number.NaN)).toHaveLength(1);
    expect(seededVector("x", 1e9)).toHaveLength(4096);
  });
  it("base64 and quantized forms have the right shapes", () => {
    expect(float32Base64([1])).toBe("AACAPw==");
    expect(quantized([-1, 0, 1], "int8")).toEqual([-127, 0, 127]);
    expect(quantized([-1, 0, 1], "uint8")).toEqual([0, 128, 255]);
  });
});
