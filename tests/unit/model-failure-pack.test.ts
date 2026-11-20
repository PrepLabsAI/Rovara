// TE-F2 part A: the failure pack. Five modes in each served family's shape; the pack NEVER counts as proof (pinned here); the shapes match the error ids F0a's rows name. Pure: a socket or fetch fails the test.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- these tests walk parsed JSON answers (`json()` returns any on purpose) */
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_AFTER_CALLS_MAX, FAILURE_MODES, FAILURE_PACK_CLASS, FAILURE_REFUSAL_TEXT, FAILURE_SHAPE_KEYS, FailureSpecSchema, buildFailureAnswer, failureShapeId, type FailureContext, type FailureMode } from "../../packages/contracts/src/model-failure-pack.js";
import { REPLY_RESULT_CLASSES, replyCountsTowardProof } from "../../packages/contracts/src/model-reply-provenance.js";
import { builtinModelCatalog } from "../../packages/contracts/src/model-catalog-rows.js";
import { SERVED_MODEL_FAMILIES } from "../../packages/contracts/src/model-served-family.js";
import { parseNamedSseText } from "../../packages/contracts/src/model-sse-named.js";
import { parseSseText } from "../../packages/contracts/src/model-family-common.js";

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

const ctx = (over: Partial<FailureContext>): FailureContext => ({ wire: "openai", operation: "chat_completions", model: "m1", stream: "none", seed: "seed-1", lineEnding: "lf", created: 1_700_000_000, enumEncoding: "string", toolName: "get_weather", ...over });
const json = (body: string): any => JSON.parse(body); // eslint-disable-line @typescript-eslint/no-explicit-any
const answer = (mode: FailureMode, over: Partial<FailureContext>, spec: { variant?: "output" | "input" | "refusal" | "filter" } = {}) => buildFailureAnswer({ mode, ...spec }, ctx(over));

/** The shapes a test drives: every wire, whole and streamed. */
const SHAPES: { name: string; over: Partial<FailureContext> }[] = [
  { name: "openai chat", over: { wire: "openai", operation: "chat_completions" } },
  { name: "openai chat stream", over: { wire: "openai", operation: "chat_completions", stream: "sse" } },
  { name: "openai responses", over: { wire: "openai", operation: "responses" } },
  { name: "openai responses stream", over: { wire: "openai", operation: "responses", stream: "sse" } },
  { name: "anthropic", over: { wire: "anthropic", operation: "messages" } },
  { name: "anthropic stream", over: { wire: "anthropic", operation: "messages", stream: "sse" } },
  { name: "cohere", over: { wire: "cohere", operation: "chat" } },
  { name: "cohere stream", over: { wire: "cohere", operation: "chat", stream: "sse" } },
  { name: "gemini", over: { wire: "gemini", operation: "generateContent" } },
  { name: "gemini sse", over: { wire: "gemini", operation: "streamGenerateContent", stream: "sse" } },
  { name: "gemini json array", over: { wire: "gemini", operation: "streamGenerateContent", stream: "json_array" } },
];

describe("the failure pack never counts as proof", () => {
  it("its class is failure_pack and replyCountsTowardProof is false for it", () => {
    expect(FAILURE_PACK_CLASS).toBe("failure_pack");
    expect(REPLY_RESULT_CLASSES).toContain(FAILURE_PACK_CLASS);
    expect(replyCountsTowardProof(FAILURE_PACK_CLASS)).toBe(false);
    for (const mode of FAILURE_MODES) expect(replyCountsTowardProof(mode)).toBe(false);
  });
});

describe("the five modes and the shape ids", () => {
  it("failureShapeId gives the ids the built-in rows name, for every served family a row exists for", () => {
    const rows = builtinModelCatalog().rows;
    const seen = new Set<string>();
    for (const row of rows) {
      if (!(SERVED_MODEL_FAMILIES as readonly string[]).includes(row.family)) continue;
      seen.add(row.family);
      for (const mode of FAILURE_MODES) expect(row.errors[FAILURE_SHAPE_KEYS[mode]], `${row.id} ${mode}`).toBe(failureShapeId(row.family as (typeof SERVED_MODEL_FAMILIES)[number], mode));
    }
    // F0a's built-in rows now cover openai_compatible, anthropic_messages, cohere, gemini and vertex.
    expect([...seen].sort()).toEqual([...SERVED_MODEL_FAMILIES].sort());
  });
});

describe("cut_off_stream", () => {
  it("SSE and JSON-array streams end mid-event with no finish marker", () => {
    const markers = ["[DONE]", "message_stop", "message-end", "response.completed", "finishReason", "finish_reason\":\"stop", "content_block_stop"];
    for (const shape of SHAPES.filter((entry) => entry.over.stream !== undefined)) {
      for (const lineEnding of ["lf", "crlf"] as const) {
        const a = answer("cut_off_stream", { ...shape.over, lineEnding });
        expect(a.status, shape.name).toBe(200);
        const separator = lineEnding === "crlf" ? "\r\n\r\n" : "\n\n";
        for (const marker of markers) expect(a.body, `${shape.name} ${marker}`).not.toContain(marker);
        if (shape.over.stream === "json_array") {
          expect(a.body.startsWith("[{"), shape.name).toBe(true);
          expect(a.body.endsWith("]"), shape.name).toBe(false);
          expect(() => JSON.parse(a.body), shape.name).toThrow();
        } else {
          expect(a.body.endsWith(separator), `${shape.name} ${lineEnding}`).toBe(false);
          const lastLine = a.body.split(/\r\n|\n/u).filter((line) => line.startsWith("data:")).at(-1) ?? "";
          expect(() => JSON.parse(lastLine.slice(5)), `${shape.name} last data line is cut`).toThrow();
          expect(a.body.includes("data:"), shape.name).toBe(true);
        }
      }
    }
  });
  it("some events arrive whole before the cut (it is a stream that begins well)", () => {
    const a = answer("cut_off_stream", { wire: "openai", operation: "chat_completions", stream: "sse" });
    const parsed = parseSseText(a.body, { requireSpace: true });
    expect(parsed.ok && parsed.events.length).toBeGreaterThanOrEqual(2);
    const named = parseNamedSseText(answer("cut_off_stream", { wire: "anthropic", operation: "messages", stream: "sse" }).body);
    expect(named.ok && !named.complete).toBe(true);
    expect(named.ok && named.events.length).toBeGreaterThanOrEqual(3);
  });
  it("does not apply to an embedding: a fixed not-applicable error, never a made-up success", () => {
    const a = answer("cut_off_stream", { wire: "openai", operation: "embeddings" });
    expect(a.status).toBe(400);
    expect(json(a.body).error.message).toBe("not run: this failure mode does not apply to this operation");
  });
});

describe("token_limit", () => {
  it("input: a 400 input-too-long in each family's envelope", () => {
    const openai = answer("token_limit", { wire: "openai" }, { variant: "input" });
    expect(openai.status).toBe(400);
    expect(json(openai.body).error).toMatchObject({ type: "invalid_request_error", code: "context_length_exceeded", param: "messages" });
    expect(json(answer("token_limit", { wire: "anthropic", operation: "messages" }, { variant: "input" }).body)).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(json(answer("token_limit", { wire: "gemini", operation: "generateContent" }, { variant: "input" }).body).error).toMatchObject({ code: 400, status: "INVALID_ARGUMENT" });
    expect(answer("token_limit", { wire: "cohere", operation: "chat" }, { variant: "input" }).status).toBe(400);
  });
});

describe("refusal", () => {
  it("OpenAI chat: message.refusal with no content; the filter variant is content_filter", () => {
    const refusal = json(answer("refusal", { wire: "openai", operation: "chat_completions" }).body).choices[0];
    expect(refusal.message).toEqual({ role: "assistant", content: null, refusal: FAILURE_REFUSAL_TEXT });
    expect(refusal.finish_reason).toBe("stop");
    const filter = json(answer("refusal", { wire: "openai", operation: "chat_completions" }, { variant: "filter" }).body).choices[0];
    expect(filter.finish_reason).toBe("content_filter");
    expect(filter.message.refusal).toBeUndefined();
  });
  it("OpenAI Responses: a refusal content part (or incomplete with content_filter)", () => {
    expect(json(answer("refusal", { wire: "openai", operation: "responses" }).body).output[0].content).toEqual([{ type: "refusal", refusal: FAILURE_REFUSAL_TEXT }]);
    expect(json(answer("refusal", { wire: "openai", operation: "responses" }, { variant: "filter" }).body)).toMatchObject({ status: "incomplete", incomplete_details: { reason: "content_filter" } });
    expect(answer("refusal", { wire: "openai", operation: "responses", stream: "sse" }).body).toContain("response.refusal.delta");
  });
  it("Gemini: finishReason SAFETY, or promptFeedback.blockReason in the filter variant (whole, SSE and JSON array)", () => {
    expect(json(answer("refusal", { wire: "gemini", operation: "generateContent" }).body).candidates[0].finishReason).toBe("SAFETY");
    const blocked = json(answer("refusal", { wire: "gemini", operation: "generateContent" }, { variant: "filter" }).body);
    expect(blocked.promptFeedback.blockReason).toBe("SAFETY");
    expect(blocked.candidates).toBeUndefined();
    expect(answer("refusal", { wire: "gemini", operation: "streamGenerateContent", stream: "sse" }, { variant: "filter" }).body).toContain('"blockReason":"SAFETY"');
    expect(json(answer("refusal", { wire: "gemini", operation: "streamGenerateContent", stream: "json_array" }, { variant: "filter" }).body)[0].promptFeedback.blockReason).toBe("SAFETY");
  });
  it("does not apply to an embedding", () => {
    expect(answer("refusal", { wire: "openai", operation: "embeddings" }).status).toBe(400);
  });
});

describe("bad_tool_json", () => {
  it("uses the declared tool name, or unknown_tool", () => {
    expect(answer("bad_tool_json", { wire: "openai", toolName: undefined }).body).toContain('"name":"unknown_tool"');
    expect(answer("bad_tool_json", { wire: "openai", toolName: "lookup_order" }).body).toContain('"name":"lookup_order"');
  });
  it("never serves a good tool call: the answer is refused if the swap would change nothing", () => {
    // An operation outside the chat family has no tool call at all.
    expect(answer("bad_tool_json", { wire: "cohere", operation: "rerank" }).status).toBe(400);
  });
});

describe("the spec", () => {
  it("is strict, with an afterCalls bound and variants that belong to their mode", () => {
    expect(FailureSpecSchema.safeParse({ mode: "rate_limit" }).success).toBe(true);
    expect(FailureSpecSchema.safeParse({ mode: "rate_limit", afterCalls: 3 }).success).toBe(true);
    expect(FailureSpecSchema.safeParse({ mode: "token_limit", variant: "input" }).success).toBe(true);
    expect(FailureSpecSchema.safeParse({ mode: "refusal", variant: "filter" }).success).toBe(true);
    for (const bad of [{ mode: "nope" }, { mode: "rate_limit", extra: 1 }, { mode: "rate_limit", afterCalls: -1 }, { mode: "rate_limit", afterCalls: FAILURE_AFTER_CALLS_MAX + 1 }, { mode: "rate_limit", afterCalls: 1.5 }, { mode: "rate_limit", variant: "input" }, { mode: "refusal", variant: "input" }, { mode: "token_limit", variant: "filter" }, { mode: "bad_tool_json", variant: "output" }]) {
      expect(FailureSpecSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(FailureSpecSchema.safeParse(JSON.parse('{"mode":"rate_limit","__proto__":{"x":1}}')).success).toBe(false);
  });
});

describe("determinism", () => {
  it("the same context gives the same bytes; another seed gives other ids", () => {
    for (const shape of SHAPES) for (const mode of FAILURE_MODES) expect(answer(mode, shape.over), `${shape.name} ${mode}`).toEqual(answer(mode, shape.over));
    expect(answer("token_limit", { seed: "other" }).body).not.toBe(answer("token_limit", {}).body);
  });
});
