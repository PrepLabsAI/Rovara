// TE-F2 part A: the Cohere v2 shapes: the router, golden bytes (chat whole body and named-event stream in LF and CRLF, tool calls, embeddings by type, rerank) and the error body. Pure: a test fails if anything opens a
// socket or calls fetch. NOTHING here was parsed by a Cohere client (the SDK is not installed offline): the family is UNVERIFIED, as the file header says.
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COHERE_EMBEDDING_DEFAULT_DIMENSIONS,
  COHERE_OPERATIONS,
  buildCohereChat,
  buildCohereChatStreamEvents,
  buildCohereEmbed,
  buildCohereRerank,
  cohereErrorBody,
  cohereFinishReason,
  cohereStreamBody,
  routeCohereRequest,
} from "../../packages/contracts/src/model-family-cohere.js";
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
const route = (path: string, method = "POST", pathPrefix?: string) => routeCohereRequest({ method, path, pathPrefix });
const build = { model: "command-test", seed: "seed-1" } as const;
const hex = seededId("seed-1") + seededId("seed-1:2");
const chatId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
const USAGE = '"usage":{"billed_units":{"input_tokens":7,"output_tokens":5},"tokens":{"input_tokens":7,"output_tokens":5}}';

describe("routeCohereRequest", () => {
  it("routes chat, embed and rerank on v2 only", () => {
    expect([...COHERE_OPERATIONS]).toEqual(["chat", "embed", "rerank"]);
    for (const operation of COHERE_OPERATIONS) expect(route(`/v2/${operation}`), operation).toEqual({ ok: true, operation });
    for (const path of ["/v1/chat", "/v1/embed", "/v3/chat", "/chat", "/v2/classify", "/v2/chat/extra", "/v2/models"]) expect(route(path), path).toEqual({ ok: false, reason: "unsupported_path" });
  });
  it("strips the row's path prefix", () => {
    expect(route("/gateway/v2/chat", "POST", "/gateway")).toEqual({ ok: true, operation: "chat" });
    expect(route("/v2/chat", "POST", "/gateway")).toEqual({ ok: true, operation: "chat" });
  });
  it("refuses with a fixed reason", () => {
    expect(route("/v2/chat", "GET")).toEqual({ ok: false, reason: "method_not_allowed" });
    expect(route("/v2/chat", "post")).toEqual({ ok: true, operation: "chat" });
    for (const path of ["/v2/../v2/chat", "/v2//chat", "/v2/chat/", "/v2/%63hat", "v2/chat", "/v2\\chat", "/v2/chat?x=1"]) expect(route(path).ok, path).toBe(false);
    expect(route("/v2/../v2/chat")).toEqual({ ok: false, reason: "bad_path" });
    expect(route(`/v2/${"c".repeat(600)}`)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("chat: golden bytes", () => {
  it("a text answer", () => {
    expect(JSON.stringify(buildCohereChat(reply(), build))).toBe(`{"id":"${chatId}","finish_reason":"COMPLETE","message":{"role":"assistant","content":[{"type":"text","text":"Hello from the scripted reply."}]},${USAGE}}`);
  });
  it("a tool call: tool_plan and tool_calls (arguments are a JSON string), TOOL_CALL", () => {
    const body = buildCohereChat(reply({ text: "I will check.", toolCalls: [{ name: "get_weather", args: { city: "Paris" } }], finish: "tool_calls" }), build) as { finish_reason: string; message: { tool_plan: string; tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[]; content?: unknown } };
    expect(body.finish_reason).toBe("TOOL_CALL");
    expect(body.message.tool_plan).toBe("I will check.");
    expect(body.message.content).toBeUndefined();
    expect(body.message.tool_calls).toEqual([{ id: `get_weather_${seededId("seed-1:0:get_weather").slice(0, 12)}`, type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }]);
  });
  it("finish reasons: COMPLETE, MAX_TOKENS, TOOL_CALL, and ERROR for a scripted safety finish (UNVERIFIED)", () => {
    expect(cohereFinishReason(reply({ finish: "stop" }))).toBe("COMPLETE");
    expect(cohereFinishReason(reply({ finish: "other" }))).toBe("COMPLETE");
    expect(cohereFinishReason(reply({ finish: "length" }))).toBe("MAX_TOKENS");
    expect(cohereFinishReason(reply({ finish: "tool_calls" }))).toBe("TOOL_CALL");
    expect(cohereFinishReason(reply({ finish: "safety" }))).toBe("ERROR");
    expect(cohereFinishReason(reply({ finish: "stop", toolCalls: [{ name: "a", args: {} }] }))).toBe("TOOL_CALL");
  });
  it("refuses what a builder must never render", () => {
    expect(() => buildCohereChat(reply({ text: "x".repeat(MODEL_REPLY_MAX_CHARS + 1) }), build)).toThrow(RangeError);
    expect(() => buildCohereChat(reply(), { model: "bad name", seed: "s" })).toThrow(RangeError);
  });
});

const STREAM_LF = [
  `event: message-start\ndata: {"type":"message-start","id":"${chatId}","delta":{"message":{"role":"assistant","content":[],"tool_plan":"","tool_calls":[],"citations":[]}}}\n\n`,
  'event: content-start\ndata: {"type":"content-start","index":0,"delta":{"message":{"content":{"type":"text","text":""}}}}\n\n',
  'event: content-delta\ndata: {"type":"content-delta","index":0,"delta":{"message":{"content":{"text":"Hello from the scripted reply."}}}}\n\n',
  'event: content-end\ndata: {"type":"content-end","index":0}\n\n',
  `event: message-end\ndata: {"type":"message-end","delta":{"finish_reason":"COMPLETE",${USAGE}}}\n\n`,
].join("");

describe("chat stream: golden bytes", () => {
  it("a text answer, LF", () => {
    expect(cohereStreamBody(buildCohereChatStreamEvents(reply(), build), "lf")).toBe(STREAM_LF);
  });
  it("the same stream, CRLF", () => {
    expect(cohereStreamBody(buildCohereChatStreamEvents(reply(), build), "crlf")).toBe(STREAM_LF.replaceAll("\n", "\r\n"));
  });
  it("ends with message-end and the pieces join to the text", () => {
    const text = "Pieces ".repeat(30);
    const parsed = parseNamedSseText(cohereStreamBody(buildCohereChatStreamEvents(reply({ text }), build), "lf"));
    expect(parsed.ok && parsed.complete).toBe(true);
    const events = parsed.ok ? parsed.events : [];
    expect(events.at(-1)?.event).toBe("message-end");
    expect(events[0]?.event).toBe("message-start");
    expect(events.filter((event) => event.event === "content-delta").map((event) => (JSON.parse(event.data) as { delta: { message: { content: { text: string } } } }).delta.message.content.text).join("")).toBe(text);
    for (const event of events) expect((JSON.parse(event.data) as { type: string }).type).toBe(event.event);
  });
  it("a tool call streams a tool plan, then start, argument deltas and end for each call", () => {
    const args = { city: "Paris", note: "a long enough value that the arguments need several pieces to stream" };
    const parsed = parseNamedSseText(cohereStreamBody(buildCohereChatStreamEvents(reply({ text: "Planning.", toolCalls: [{ name: "get_weather", args }], finish: "tool_calls" }), build), "lf"));
    const events = parsed.ok ? parsed.events : [];
    expect(events.map((event) => event.event).filter((name, index, all) => all.indexOf(name) === index)).toEqual(["message-start", "tool-plan-delta", "tool-call-start", "tool-call-delta", "tool-call-end", "message-end"]);
    const pieces = events.filter((event) => event.event === "tool-call-delta").map((event) => (JSON.parse(event.data) as { delta: { message: { tool_calls: { function: { arguments: string } } } } }).delta.message.tool_calls.function.arguments);
    expect(pieces.length).toBeGreaterThan(1);
    expect(JSON.parse(pieces.join(""))).toEqual(args);
    expect((JSON.parse(events.at(-1)?.data ?? "{}") as { delta: { finish_reason: string } }).delta.finish_reason).toBe("TOOL_CALL");
  });
});

describe("embed and rerank", () => {
  it("embeddings by type: one vector per text, the default dimension, float32-exact numbers", () => {
    const body = buildCohereEmbed({ seed: "s", textCount: 2, dimensions: undefined, types: [], inputTokens: 9 }) as { embeddings: { float: number[][] }; response_type: string; meta: { billed_units: { input_tokens: number } } };
    expect(body.response_type).toBe("embeddings_by_type");
    expect(Object.keys(body.embeddings)).toEqual(["float"]);
    expect(body.embeddings.float).toHaveLength(2);
    expect(body.embeddings.float[0]).toHaveLength(COHERE_EMBEDDING_DEFAULT_DIMENSIONS);
    expect(body.embeddings.float[0]).not.toEqual(body.embeddings.float[1]);
    for (const value of body.embeddings.float[0] ?? []) expect(Math.fround(value)).toBe(value);
    expect(body.meta.billed_units.input_tokens).toBe(9);
  });
  it("is deterministic and bounded", () => {
    const a = JSON.stringify(buildCohereEmbed({ seed: "s", textCount: 1, dimensions: 8, types: ["float"], inputTokens: 1 }));
    expect(a).toBe(JSON.stringify(buildCohereEmbed({ seed: "s", textCount: 1, dimensions: 8, types: ["float"], inputTokens: 1 })));
    expect(a).not.toBe(JSON.stringify(buildCohereEmbed({ seed: "t", textCount: 1, dimensions: 8, types: ["float"], inputTokens: 1 })));
    const big = buildCohereEmbed({ seed: "s", textCount: 99_999, dimensions: 99_999, types: ["float"], inputTokens: 1 }) as { embeddings: { float: number[][] } };
    expect(big.embeddings.float).toHaveLength(2048);
    expect(big.embeddings.float[0]).toHaveLength(4096);
  });
  it("each requested type has its own shape; an unknown type is dropped; none means float", () => {
    const body = buildCohereEmbed({ seed: "s", textCount: 1, dimensions: 16, types: ["float", "int8", "uint8", "binary", "ubinary", "base64", "nope", "float"], inputTokens: 1 }) as { embeddings: Record<string, unknown[]> };
    expect(Object.keys(body.embeddings)).toEqual(["float", "int8", "uint8", "binary", "ubinary", "base64"]);
    expect((body.embeddings.int8?.[0] as number[]).every((value) => value >= -128 && value <= 127 && Number.isInteger(value))).toBe(true);
    expect((body.embeddings.uint8?.[0] as number[]).every((value) => value >= 0 && value <= 255 && Number.isInteger(value))).toBe(true);
    expect(body.embeddings.binary?.[0]).toHaveLength(2);
    expect(typeof body.embeddings.base64?.[0]).toBe("string");
    expect(Object.keys((buildCohereEmbed({ seed: "s", textCount: 1, dimensions: 4, types: ["nope", "__proto__"], inputTokens: 1 }) as { embeddings: object }).embeddings)).toEqual(["float"]);
    expect(Object.getPrototypeOf((buildCohereEmbed({ seed: "s", textCount: 1, dimensions: 4, types: ["__proto__"], inputTokens: 1 }) as { embeddings: object }).embeddings)).toBe(Object.prototype);
  });
  it("rerank: results best first, cut to top_n", () => {
    expect(buildCohereRerank({ seed: "s", documentCount: 3, topN: undefined })).toEqual({
      id: chatIdOf("s"),
      results: [{ index: 0, relevance_score: 0.99 }, { index: 1, relevance_score: 0.69 }, { index: 2, relevance_score: 0.39 }],
      meta: { api_version: { version: "2" }, billed_units: { search_units: 1 } },
    });
    expect((buildCohereRerank({ seed: "s", documentCount: 3, topN: 2 }) as { results: unknown[] }).results).toHaveLength(2);
    expect((buildCohereRerank({ seed: "s", documentCount: 3, topN: 99 }) as { results: unknown[] }).results).toHaveLength(3);
    expect((buildCohereRerank({ seed: "s", documentCount: 0, topN: undefined }) as { results: unknown[] }).results).toEqual([]);
  });
  it("the error body is {message}", () => {
    expect(cohereErrorBody("too many requests")).toEqual({ message: "too many requests" });
  });
});

function chatIdOf(seed: string): string {
  const value = seededId(seed) + seededId(`${seed}:2`);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}
