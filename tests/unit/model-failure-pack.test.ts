// TE-F2 part A: the failure pack. Five modes in each served family's shape; the pack NEVER counts as proof (pinned here); the shapes match the error ids F0a's rows name. Pure: a socket or fetch fails the test.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- these tests walk parsed JSON answers (`json()` returns any on purpose) */
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_AFTER_CALLS_MAX,
  FAILURE_MODES,
  FAILURE_PACK_CLASS,
  FAILURE_REFUSAL_TEXT,
  FAILURE_SHAPE_KEYS,
  FailureSpecSchema,
  buildFailureAnswer,
  failureShapeId,
  familyErrorAnswer,
  type FailureContext,
  type FailureMode,
} from "../../packages/contracts/src/model-failure-pack.js";
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
  it("it never reads a reply set: the text of every answer is fixed in code", () => {
    for (const shape of SHAPES) {
      const a = answer("token_limit", shape.over);
      expect(a.body, shape.name).toContain("This is the start of an answer");
    }
  });
});

describe("the five modes and the shape ids", () => {
  it("are exactly the five, and each has the F0a row key", () => {
    expect([...FAILURE_MODES]).toEqual(["rate_limit", "cut_off_stream", "token_limit", "refusal", "bad_tool_json"]);
    expect(FAILURE_SHAPE_KEYS).toEqual({ rate_limit: "rateLimit", cut_off_stream: "cutOffStream", token_limit: "tokenLimit", refusal: "refusal", bad_tool_json: "badToolJson" });
  });
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

describe("rate_limit", () => {
  it("is a 429 with retry-after in each family's own envelope", () => {
    for (const shape of SHAPES) {
      const a = answer("rate_limit", shape.over);
      expect(a.status, shape.name).toBe(429);
      expect(a.headers["retry-after"], shape.name).toBe("1");
      expect(a.headers["content-type"], shape.name).toBe("application/json");
    }
    expect(json(answer("rate_limit", { wire: "openai" }).body)).toEqual({ error: { message: expect.any(String), type: "requests", param: null, code: "rate_limit_exceeded" } });
    expect(json(answer("rate_limit", { wire: "anthropic", operation: "messages" }).body)).toEqual({ type: "error", error: { type: "rate_limit_error", message: expect.any(String) } });
    expect(json(answer("rate_limit", { wire: "gemini", operation: "generateContent" }).body)).toEqual({ error: { code: 429, message: expect.any(String), status: "RESOURCE_EXHAUSTED" } });
    expect(json(answer("rate_limit", { wire: "cohere", operation: "chat" }).body)).toEqual({ message: expect.any(String) });
  });
  it("reads as a plain rate limit to F1-a's classifier (its branch is not merged: its two word lists are copied here)", () => {
    // From pr/te-f1a-model-egress-core, model-egress/classify.ts (a329e8e02 base): a 429 is `quota` when the body has a QUOTA word and `rate_limit` otherwise. The pack's 429 must stay a rate limit.
    const QUOTA_WORDS = /insufficient_quota|credit balance is too low|billing details|per ?day|daily|spending cap|prepayment|out of credits/iu;
    const RATE_WORDS = /rate_limit|rate limit|per ?minute|too many requests|retry/iu;
    for (const shape of SHAPES) {
      const a = answer("rate_limit", shape.over);
      expect(QUOTA_WORDS.test(a.body), shape.name).toBe(false);
      expect(RATE_WORDS.test(a.body), shape.name).toBe(true);
    }
  });
  it("applies to every operation, embeddings included", () => {
    expect(answer("rate_limit", { wire: "openai", operation: "embeddings" }).status).toBe(429);
    expect(answer("rate_limit", { wire: "cohere", operation: "rerank" }).status).toBe(429);
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
  it("a call that did not ask for a stream gets a JSON body cut in half", () => {
    for (const shape of SHAPES.filter((entry) => entry.over.stream === undefined)) {
      const a = answer("cut_off_stream", shape.over);
      expect(a.status, shape.name).toBe(200);
      expect(() => JSON.parse(a.body), shape.name).toThrow();
      expect(a.body.length, shape.name).toBeGreaterThan(10);
    }
  });
  it("does not apply to an embedding: a fixed not-applicable error, never a made-up success", () => {
    const a = answer("cut_off_stream", { wire: "openai", operation: "embeddings" });
    expect(a.status).toBe(400);
    expect(json(a.body).error.message).toBe("not run: this failure mode does not apply to this operation");
  });
});

describe("token_limit", () => {
  it("output: a complete answer with the family's length stop", () => {
    expect(json(answer("token_limit", { wire: "openai", operation: "chat_completions" }).body).choices[0].finish_reason).toBe("length");
    expect(json(answer("token_limit", { wire: "anthropic", operation: "messages" }).body).stop_reason).toBe("max_tokens");
    expect(json(answer("token_limit", { wire: "gemini", operation: "generateContent" }).body).candidates[0].finishReason).toBe("MAX_TOKENS");
    expect(json(answer("token_limit", { wire: "cohere", operation: "chat" }).body).finish_reason).toBe("MAX_TOKENS");
    expect(json(answer("token_limit", { wire: "openai", operation: "responses" }).body)).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    expect(answer("token_limit", { wire: "openai", operation: "chat_completions" }).status).toBe(200);
  });
  it("output, streamed: the last event carries the length stop and the stream is complete", () => {
    expect(answer("token_limit", { wire: "openai", operation: "chat_completions", stream: "sse" }).body).toContain('"finish_reason":"length"');
    expect(answer("token_limit", { wire: "openai", operation: "chat_completions", stream: "sse" }).body.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(answer("token_limit", { wire: "anthropic", operation: "messages", stream: "sse" }).body).toContain('"stop_reason":"max_tokens"');
    expect(answer("token_limit", { wire: "gemini", operation: "streamGenerateContent", stream: "sse" }).body).toContain('"finishReason":"MAX_TOKENS"');
    expect(answer("token_limit", { wire: "gemini", operation: "streamGenerateContent", stream: "json_array" }).body.endsWith("]")).toBe(true);
    expect(answer("token_limit", { wire: "cohere", operation: "chat", stream: "sse" }).body).toContain('"finish_reason":"MAX_TOKENS"');
  });
  it("input: a 400 input-too-long in each family's envelope", () => {
    const openai = answer("token_limit", { wire: "openai" }, { variant: "input" });
    expect(openai.status).toBe(400);
    expect(json(openai.body).error).toMatchObject({ type: "invalid_request_error", code: "context_length_exceeded", param: "messages" });
    expect(json(answer("token_limit", { wire: "anthropic", operation: "messages" }, { variant: "input" }).body)).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(json(answer("token_limit", { wire: "gemini", operation: "generateContent" }, { variant: "input" }).body).error).toMatchObject({ code: 400, status: "INVALID_ARGUMENT" });
    expect(answer("token_limit", { wire: "cohere", operation: "chat" }, { variant: "input" }).status).toBe(400);
  });
  it("an operation with no output to cut (embeddings) gets the input-too-long 400", () => {
    expect(answer("token_limit", { wire: "openai", operation: "embeddings" }).status).toBe(400);
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
  it("OpenAI chat streamed: a refusal delta, then [DONE]", () => {
    const body = answer("refusal", { wire: "openai", operation: "chat_completions", stream: "sse" }).body;
    expect(body).toContain(`"delta":{"refusal":${JSON.stringify(FAILURE_REFUSAL_TEXT)}}`);
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(answer("refusal", { wire: "openai", operation: "chat_completions", stream: "sse" }, { variant: "filter" }).body).toContain('"finish_reason":"content_filter"');
  });
  it("OpenAI Responses: a refusal content part (or incomplete with content_filter)", () => {
    expect(json(answer("refusal", { wire: "openai", operation: "responses" }).body).output[0].content).toEqual([{ type: "refusal", refusal: FAILURE_REFUSAL_TEXT }]);
    expect(json(answer("refusal", { wire: "openai", operation: "responses" }, { variant: "filter" }).body)).toMatchObject({ status: "incomplete", incomplete_details: { reason: "content_filter" } });
    expect(answer("refusal", { wire: "openai", operation: "responses", stream: "sse" }).body).toContain("response.refusal.delta");
  });
  it("Anthropic: stop_reason refusal, whole and streamed", () => {
    expect(json(answer("refusal", { wire: "anthropic", operation: "messages" }).body).stop_reason).toBe("refusal");
    expect(answer("refusal", { wire: "anthropic", operation: "messages", stream: "sse" }).body).toContain('"stop_reason":"refusal"');
  });
  it("Gemini: finishReason SAFETY, or promptFeedback.blockReason in the filter variant (whole, SSE and JSON array)", () => {
    expect(json(answer("refusal", { wire: "gemini", operation: "generateContent" }).body).candidates[0].finishReason).toBe("SAFETY");
    const blocked = json(answer("refusal", { wire: "gemini", operation: "generateContent" }, { variant: "filter" }).body);
    expect(blocked.promptFeedback.blockReason).toBe("SAFETY");
    expect(blocked.candidates).toBeUndefined();
    expect(answer("refusal", { wire: "gemini", operation: "streamGenerateContent", stream: "sse" }, { variant: "filter" }).body).toContain('"blockReason":"SAFETY"');
    expect(json(answer("refusal", { wire: "gemini", operation: "streamGenerateContent", stream: "json_array" }, { variant: "filter" }).body)[0].promptFeedback.blockReason).toBe("SAFETY");
  });
  it("Cohere has no documented refusal marker: a refusal sentence with COMPLETE (UNVERIFIED)", () => {
    const body = json(answer("refusal", { wire: "cohere", operation: "chat" }).body);
    expect(body.finish_reason).toBe("COMPLETE");
    expect(body.message.content[0].text).toBe(FAILURE_REFUSAL_TEXT);
  });
  it("does not apply to an embedding", () => {
    expect(answer("refusal", { wire: "openai", operation: "embeddings" }).status).toBe(400);
  });
});

describe("bad_tool_json", () => {
  it("OpenAI chat and Responses: arguments that do not parse", () => {
    const chat = json(answer("bad_tool_json", { wire: "openai", operation: "chat_completions" }).body).choices[0].message.tool_calls[0];
    expect(chat.function.name).toBe("get_weather");
    expect(() => JSON.parse(chat.function.arguments)).toThrow();
    const resp = json(answer("bad_tool_json", { wire: "openai", operation: "responses" }).body).output[0];
    expect(resp.type).toBe("function_call");
    expect(() => JSON.parse(resp.arguments)).toThrow();
    const stream = answer("bad_tool_json", { wire: "openai", operation: "chat_completions", stream: "sse" }).body;
    expect(stream).not.toContain("rovara_bad_tool_json");
    const args = parseSseText(stream, { requireSpace: true });
    const pieces = args.ok ? args.events.filter((event) => event !== "[DONE]").map((event) => JSON.parse(event).choices[0]?.delta?.tool_calls?.[0]?.function?.arguments).filter((piece): piece is string => typeof piece === "string") : [];
    expect(pieces.length).toBeGreaterThan(0);
    expect(() => JSON.parse(pieces.join(""))).toThrow();
  });
  it("Cohere: arguments that do not parse, whole and streamed", () => {
    const body = json(answer("bad_tool_json", { wire: "cohere", operation: "chat" }).body);
    expect(() => JSON.parse(body.message.tool_calls[0].function.arguments)).toThrow();
    const stream = parseNamedSseText(answer("bad_tool_json", { wire: "cohere", operation: "chat", stream: "sse" }).body);
    const joined = stream.ok ? stream.events.filter((event) => event.event === "tool-call-delta").map((event) => JSON.parse(event.data).delta.message.tool_calls.function.arguments).join("") : "";
    expect(() => JSON.parse(joined)).toThrow();
    expect(answer("bad_tool_json", { wire: "cohere", operation: "chat", stream: "sse" }).body).not.toContain("rovara_bad_tool_json");
  });
  it("Anthropic: a whole input of the wrong shape, and an unterminated partial_json when streamed (the SDK's partial parser then yields an object that breaks the schema)", () => {
    const whole = json(answer("bad_tool_json", { wire: "anthropic", operation: "messages" }).body);
    expect(whole.content[0]).toMatchObject({ type: "tool_use", name: "get_weather", input: { rovara_wrong_key: ["not", "the", "declared", "type"] } });
    const stream = parseNamedSseText(answer("bad_tool_json", { wire: "anthropic", operation: "messages", stream: "sse" }).body);
    const joined = stream.ok ? stream.events.filter((event) => event.event === "content_block_delta").map((event) => JSON.parse(event.data).delta.partial_json).join("") : "";
    expect(() => JSON.parse(joined)).toThrow(); // the stream's pieces are never a complete JSON text
  });
  it("M4: Gemini functionCall.args is an OBJECT with the wrong keys and types, never a string (google-genai Python needs an object)", () => {
    const wrong = { rovara_wrong_key: ["not", "the", "declared", "type"] };
    const whole = json(answer("bad_tool_json", { wire: "gemini", operation: "generateContent" }).body);
    expect(whole.candidates[0].content.parts[0].functionCall).toEqual({ name: "get_weather", args: wrong });
    expect(typeof whole.candidates[0].content.parts[0].functionCall.args).toBe("object");
    expect(answer("bad_tool_json", { wire: "gemini", operation: "streamGenerateContent", stream: "sse" }).body).toContain(`"args":${JSON.stringify(wrong)}`);
    expect(json(answer("bad_tool_json", { wire: "gemini", operation: "streamGenerateContent", stream: "json_array" }).body)[0].candidates[0].content.parts.at(-1).functionCall.args).toEqual(wrong);
  });
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
  it("familyErrorAnswer carries fixed words and a retry-after on a 429 only", () => {
    expect(familyErrorAnswer("openai", "no_script").headers["retry-after"]).toBeUndefined();
    expect(familyErrorAnswer("openai", "rate_limit").headers["retry-after"]).toBe("1");
    expect(json(familyErrorAnswer("anthropic", "no_script").body).error.message).toBe("not run: no scripted reply for this request");
  });
});

describe("determinism", () => {
  it("the same context gives the same bytes; another seed gives other ids", () => {
    for (const shape of SHAPES) for (const mode of FAILURE_MODES) expect(answer(mode, shape.over), `${shape.name} ${mode}`).toEqual(answer(mode, shape.over));
    expect(answer("token_limit", { seed: "other" }).body).not.toBe(answer("token_limit", {}).body);
  });
});
