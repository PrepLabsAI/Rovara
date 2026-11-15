// TE-F2 part A: the Anthropic Messages shapes: the router on every path form, golden bytes (whole body, named-event SSE in LF and CRLF), stop reasons, tool calls, token count and the error envelope. Pure: a test fails if
// anything opens a socket or calls fetch. The shapes are from Anthropic's public docs (UNVERIFIED items are listed in the file header).
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_ERROR_TYPES,
  ANTHROPIC_OPERATIONS,
  anthropicErrorBody,
  anthropicStopReason,
  anthropicStreamBody,
  buildAnthropicCountTokens,
  buildAnthropicMessage,
  buildAnthropicMessageStreamEvents,
  routeAnthropicRequest,
} from "../../packages/contracts/src/model-family-anthropic.js";
import { parseNamedSseText, sseNamedBody } from "../../packages/contracts/src/model-sse-named.js";
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
const route = (path: string, method = "POST", pathPrefix?: string) => routeAnthropicRequest({ method, path, pathPrefix });
const build = { model: "claude-test-1", seed: "seed-1" } as const;

describe("routeAnthropicRequest", () => {
  it("routes messages and count_tokens on any API version prefix", () => {
    expect([...ANTHROPIC_OPERATIONS]).toEqual(["messages", "count_tokens"]);
    for (const version of ["v1", "v2", "v1beta", "v10"]) {
      expect(route(`/${version}/messages`), version).toEqual({ ok: true, operation: "messages" });
      expect(route(`/${version}/messages/count_tokens`), version).toEqual({ ok: true, operation: "count_tokens" });
    }
    expect(route("/messages")).toEqual({ ok: true, operation: "messages" }); // a base URL that already ends in /v1
  });
  it("strips the row's path prefix first", () => {
    expect(route("/litellm/v1/messages", "POST", "/litellm")).toEqual({ ok: true, operation: "messages" });
    expect(route("/litellm/v1/messages/count_tokens", "POST", "/litellm")).toEqual({ ok: true, operation: "count_tokens" });
    expect(route("/v1/messages", "POST", "/litellm")).toEqual({ ok: true, operation: "messages" });
  });
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

const id = `msg_01${seededId("seed-1")}`;
const toolId = (index: number, name: string) => `toolu_01${seededId(`seed-1:${String(index)}:${name}`)}`;
const USAGE = '"usage":{"input_tokens":7,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}';

describe("buildAnthropicMessage: golden bytes", () => {
  it("a text answer", () => {
    expect(JSON.stringify(buildAnthropicMessage(reply(), build))).toBe(
      `{"id":"${id}","type":"message","role":"assistant","model":"claude-test-1","content":[{"type":"text","text":"Hello from the scripted reply."}],"stop_reason":"end_turn","stop_sequence":null,${USAGE}}`,
    );
  });
  it("a tool call: the text block first, then a tool_use block whose input is an object; stop_reason tool_use", () => {
    const body = JSON.stringify(buildAnthropicMessage(reply({ text: "Checking.", toolCalls: [{ name: "get_weather", args: { city: "Paris" } }], finish: "tool_calls" }), build));
    expect(body).toBe(
      `{"id":"${id}","type":"message","role":"assistant","model":"claude-test-1","content":[{"type":"text","text":"Checking."},{"type":"tool_use","id":"${toolId(0, "get_weather")}","name":"get_weather","input":{"city":"Paris"}}],"stop_reason":"tool_use","stop_sequence":null,${USAGE}}`,
    );
    const noText = buildAnthropicMessage(reply({ text: "", toolCalls: [{ name: "a", args: {} }], finish: "stop" }), build) as { content: { type: string }[]; stop_reason: string };
    expect(noText.content.map((block) => block.type)).toEqual(["tool_use"]);
    expect(noText.stop_reason).toBe("tool_use"); // a normal finish with tool calls stops for tool_use
  });
  it("an empty text answer still has one text block", () => {
    expect((buildAnthropicMessage(reply({ text: "" }), build) as { content: unknown[] }).content).toEqual([{ type: "text", text: "" }]);
  });
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
  it("is deterministic: the same seed gives the same bytes, another seed other ids", () => {
    expect(JSON.stringify(buildAnthropicMessage(reply(), build))).toBe(JSON.stringify(buildAnthropicMessage(reply(), build)));
    expect(JSON.stringify(buildAnthropicMessage(reply(), { ...build, seed: "seed-2" }))).not.toBe(JSON.stringify(buildAnthropicMessage(reply(), build)));
  });
});

const STREAM_LF = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"${id}","type":"message","role":"assistant","model":"claude-test-1","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n\n`,
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: ping\ndata: {"type":"ping"}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from the scripted reply."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

describe("the named-event stream: golden bytes", () => {
  it("a text answer, LF", () => {
    expect(anthropicStreamBody(buildAnthropicMessageStreamEvents(reply(), build), "lf")).toBe(STREAM_LF);
  });
  it("the same stream, CRLF", () => {
    expect(anthropicStreamBody(buildAnthropicMessageStreamEvents(reply(), build), "crlf")).toBe(STREAM_LF.replaceAll("\n", "\r\n"));
  });
  it("ends with message_stop and the event order is the documented one", () => {
    const parsed = parseNamedSseText(anthropicStreamBody(buildAnthropicMessageStreamEvents(reply({ text: "x".repeat(100) }), build), "lf"));
    expect(parsed.ok && parsed.complete).toBe(true);
    const names = parsed.ok ? parsed.events.map((event) => event.event) : [];
    expect(names[0]).toBe("message_start");
    expect(names[1]).toBe("content_block_start");
    expect(names.at(-3)).toBe("content_block_stop");
    expect(names.at(-2)).toBe("message_delta");
    expect(names.at(-1)).toBe("message_stop");
    expect(names.filter((name) => name === "content_block_delta")).toHaveLength(4); // 100 characters in pieces of 32
    // every payload carries its own event name as `type`
    if (parsed.ok) for (const event of parsed.events) expect((JSON.parse(event.data) as { type: string }).type).toBe(event.event);
  });
  it("the pieces join back to the text", () => {
    const text = "Pieces ".repeat(30);
    const parsed = parseNamedSseText(anthropicStreamBody(buildAnthropicMessageStreamEvents(reply({ text }), build), "lf"));
    const joined = parsed.ok ? parsed.events.filter((event) => event.event === "content_block_delta").map((event) => (JSON.parse(event.data) as { delta: { text: string } }).delta.text).join("") : "";
    expect(joined).toBe(text);
  });
  it("a tool call streams as input_json_delta pieces that join to the arguments", () => {
    const args = { city: "Paris", units: "metric", days: [1, 2, 3], note: "a longer value so the arguments need more than one piece" };
    const parsed = parseNamedSseText(anthropicStreamBody(buildAnthropicMessageStreamEvents(reply({ text: "", toolCalls: [{ name: "get_weather", args }], finish: "tool_calls" }), build), "lf"));
    expect(parsed.ok).toBe(true);
    const events = parsed.ok ? parsed.events : [];
    const start = JSON.parse(events.find((event) => event.event === "content_block_start")?.data ?? "{}") as { content_block: { type: string; id: string; name: string; input: unknown } };
    expect(start.content_block).toEqual({ type: "tool_use", id: toolId(0, "get_weather"), name: "get_weather", input: {} });
    const pieces = events.filter((event) => event.event === "content_block_delta").map((event) => (JSON.parse(event.data) as { delta: { type: string; partial_json: string } }).delta);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.type).toBe("input_json_delta");
    expect(JSON.parse(pieces.map((piece) => piece.partial_json).join(""))).toEqual(args);
    const delta = JSON.parse(events.find((event) => event.event === "message_delta")?.data ?? "{}") as { delta: { stop_reason: string } };
    expect(delta.delta.stop_reason).toBe("tool_use");
  });
  it("a text block and a tool block get indexes 0 and 1", () => {
    const parsed = parseNamedSseText(anthropicStreamBody(buildAnthropicMessageStreamEvents(reply({ text: "Looking.", toolCalls: [{ name: "a", args: {} }], finish: "tool_calls" }), build), "lf"));
    const starts = parsed.ok ? parsed.events.filter((event) => event.event === "content_block_start").map((event) => (JSON.parse(event.data) as { index: number }).index) : [];
    expect(starts).toEqual([0, 1]);
  });
  it("a long reply never makes more than 20,000 events of text", () => {
    const events = buildAnthropicMessageStreamEvents(reply({ text: "a".repeat(MODEL_REPLY_MAX_CHARS) }), build);
    expect(events.length).toBeLessThanOrEqual(20_010);
  });
  it("sseNamedBody frames each event as `event:` `data:` and a blank line", () => {
    expect(sseNamedBody([{ event: "a", data: "{}" }], "lf")).toBe("event: a\ndata: {}\n\n");
    expect(sseNamedBody([{ event: "a", data: "{}" }], "crlf")).toBe("event: a\r\ndata: {}\r\n\r\n");
  });
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
