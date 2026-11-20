// TE-F2 part A: the OpenAI Responses API and embeddings shapes, models list, and the Gemini/Vertex embedding and models shapes F0a does not build. Golden bytes; pure (a socket or fetch fails the test). Shapes are from the
// vendors' public docs; nothing was compared with a live answer (UNVERIFIED items are in the file headers). The repo's Node `openai` SDK parse is in the loopback check, not here.
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENAI_EMBEDDING_DEFAULT_DIMENSIONS, buildOpenAiEmbeddings, buildOpenAiModel, buildOpenAiModelsList, buildOpenAiResponseStreamEvents, openAiResponseStreamBody } from "../../packages/contracts/src/model-family-openai-ops.js";
import { GEMINI_EMBEDDING_DEFAULT_DIMENSIONS, buildGeminiEmbedContent, buildGeminiModel, buildGeminiModelsList, buildVertexPredictEmbeddings } from "../../packages/contracts/src/model-family-gemini-extra.js";
import { seededVector } from "../../packages/contracts/src/model-family-vectors.js";
import { type ModelReply } from "../../packages/contracts/src/model-family-common.js";

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
});
