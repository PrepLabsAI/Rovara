// TE-F2 part A: the Cohere v2 shapes: the router, golden bytes (chat whole body and named-event stream in LF and CRLF, tool calls, embeddings by type, rerank) and the error body. Pure: a test fails if anything opens a
// socket or calls fetch. NOTHING here was parsed by a Cohere client (the SDK is not installed offline): the family is UNVERIFIED, as the file header says.
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COHERE_EMBEDDING_DEFAULT_DIMENSIONS, COHERE_OPERATIONS, buildCohereChatStreamEvents, buildCohereEmbed, buildCohereRerank, cohereFinishReason, cohereStreamBody, routeCohereRequest } from "../../packages/contracts/src/model-family-cohere.js";
import { parseNamedSseText } from "../../packages/contracts/src/model-sse-named.js";
import { seededId, type ModelReply } from "../../packages/contracts/src/model-family-common.js";

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
  it("finish reasons: COMPLETE, MAX_TOKENS, TOOL_CALL, and ERROR for a scripted safety finish (UNVERIFIED)", () => {
    expect(cohereFinishReason(reply({ finish: "stop" }))).toBe("COMPLETE");
    expect(cohereFinishReason(reply({ finish: "other" }))).toBe("COMPLETE");
    expect(cohereFinishReason(reply({ finish: "length" }))).toBe("MAX_TOKENS");
    expect(cohereFinishReason(reply({ finish: "tool_calls" }))).toBe("TOOL_CALL");
    expect(cohereFinishReason(reply({ finish: "safety" }))).toBe("ERROR");
    expect(cohereFinishReason(reply({ finish: "stop", toolCalls: [{ name: "a", args: {} }] }))).toBe("TOOL_CALL");
  });
});

describe("chat stream: golden bytes", () => {
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
});

function chatIdOf(seed: string): string {
  const value = seededId(seed) + seededId(`${seed}:2`);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}
