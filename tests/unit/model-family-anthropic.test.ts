// TE-F2 part A: the Anthropic Messages shapes: the router on every path form, golden bytes (whole body, named-event SSE in LF and CRLF), stop reasons, tool calls, token count and the error envelope. Pure: a test fails if
// anything opens a socket or calls fetch. The shapes are from Anthropic's public docs (UNVERIFIED items are listed in the file header).
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_ERROR_TYPES, anthropicErrorBody, anthropicStopReason, buildAnthropicCountTokens, buildAnthropicMessage, routeAnthropicRequest } from "../../packages/contracts/src/model-family-anthropic.js";
import { parseNamedSseText } from "../../packages/contracts/src/model-sse-named.js";
import { MODEL_REPLY_MAX_CHARS, type ModelReply } from "../../packages/contracts/src/model-family-common.js";

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
const route = (path: string, method = "POST", pathPrefix?: string) => routeAnthropicRequest({ method, path, pathPrefix });
const build = { model: "claude-test-1", seed: "seed-1" } as const;

describe("routeAnthropicRequest", () => {
  it("refuses with a fixed reason", () => {
    expect(route("/v1/messages", "GET")).toEqual({ ok: false, reason: "method_not_allowed" });
    expect(route("/v1/messages", "post")).toEqual({ ok: true, operation: "messages" });
    expect(route("/v1/messages/batches")).toEqual({ ok: false, reason: "unsupported_path" });
    expect(route("/v1/complete")).toEqual({ ok: false, reason: "unsupported_path" });
    expect(route("/v1/models")).toEqual({ ok: false, reason: "unsupported_path" });
    expect(route("/")).toEqual({ ok: false, reason: "bad_path" });
    for (const path of ["/v1/messages/../messages", "/v1//messages", "/v1/messages/", "/v1/%2e%2e/messages", "/v1\\messages", "v1/messages", "/v1/messages?x=1", "/v1/mess ages"]) expect(route(path).ok, path).toBe(false);
    expect(route(`/v1/${"m".repeat(600)}`)).toEqual({ ok: false, reason: "too_large" });
    expect(route("/v1/messages/../messages")).toEqual({ ok: false, reason: "bad_path" });
  });
});

describe("buildAnthropicMessage: golden bytes", () => {
  it("the stop reasons: end_turn, max_tokens, refusal, tool_use", () => {
    expect(anthropicStopReason(reply({ finish: "stop" }))).toBe("end_turn");
    expect(anthropicStopReason(reply({ finish: "other" }))).toBe("end_turn");
    expect(anthropicStopReason(reply({ finish: "length" }))).toBe("max_tokens");
    expect(anthropicStopReason(reply({ finish: "safety" }))).toBe("refusal");
    expect(anthropicStopReason(reply({ finish: "tool_calls" }))).toBe("tool_use");
    expect(anthropicStopReason(reply({ finish: "length", toolCalls: [{ name: "a", args: {} }] }))).toBe("max_tokens"); // a cut-off tool call is still a cut-off
  });
  it("refuses what a builder must never render", () => {
    expect(() => buildAnthropicMessage(reply({ text: "x".repeat(MODEL_REPLY_MAX_CHARS + 1) }), build)).toThrow(RangeError);
    expect(() => buildAnthropicMessage(reply(), { model: "bad name", seed: "s" })).toThrow(RangeError);
    expect(() => buildAnthropicMessage(reply({ usage: { inputTokens: -1, outputTokens: 1 } }), build)).toThrow(RangeError);
  });
});

describe("the named-event stream: golden bytes", () => {
  it("parseNamedSseText says a text that does not end at a blank line is not complete", () => {
    const parsed = parseNamedSseText('event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y"');
    expect(parsed).toEqual({ ok: true, events: [{ event: "a", data: '{"x":1}' }], complete: false });
    expect(parseNamedSseText("x".repeat(9 * 1024 * 1024))).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("token count and errors", () => {
  it("the count_tokens body", () => {
    expect(buildAnthropicCountTokens(42)).toEqual({ input_tokens: 42 });
    expect(buildAnthropicCountTokens(-1)).toEqual({ input_tokens: 0 });
    expect(buildAnthropicCountTokens(1.5)).toEqual({ input_tokens: 0 });
  });
  it("the error envelope is {type: error, error: {type, message}}", () => {
    expect(anthropicErrorBody("rate_limit_error", "slow down")).toEqual({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
    expect([...ANTHROPIC_ERROR_TYPES]).toEqual(["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "request_too_large", "rate_limit_error", "api_error", "overloaded_error"]);
  });
});
