// DEC 254t (a), row A2: the company's own OpenAI or OpenRouter key as its agents' AI. The agent route keeps speaking Anthropic Messages;
// agent-openai.ts translates the request to Chat Completions and the answer back, refusing what it cannot translate faithfully (free,
// before any hold). OpenRouter's reported cost reaches settleAmount. Keys are the company's sealed accounts; two companies never meet.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type https from "node:https";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import {
  ChatStreamToSse, createChatCompletionsTransport, fromChatCompletion, MAX_UPSTREAM_STREAM_BYTES, OPENAI_AGENT_DEFAULT_MAX_OUTPUT_TOKENS, OPENAI_AGENT_UPSTREAM, toChatCompletions,
} from "../../packages/model-gateway/src/agent-openai.js";
import { CompanyAgentAiSource, type AgentAiSource, type CompanyChatAi } from "../../packages/model-gateway/src/agent-ai.js";
import type { CompanyKeyProvider, LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { applyAgentOwnKeyBackfill, planAgentOwnKeyBackfill } from "../../packages/model-gateway/src/agent-own-key-backfill.js";
import { answerOfferedModels, ANTHROPIC_KEY_AGENT_MODELS, OFFERED_CHAT_OFF, OFFERED_EMPTY, OFFERED_SWITCHED_OFF, OPENAI_KEY_AGENT_MODELS } from "../../packages/model-gateway/src/offered-models.js";
import { NotSentError, type ProviderRequest, type ProviderResponse, type ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { AGENT_CHAT_FEATURE, AGENT_CHAT_NOT_OFFERED, AGENT_KEY_MISSING, AGENT_KEY_REFUSED, AGENT_SOURCE_SWITCHED_OFF, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { UsageCollector } from "../../packages/model-gateway/src/usage.js";
import { call, claims, jwk, kid, mint, now, scope, setup } from "./model-gateway-fixture.js";

type Json = Record<string, unknown>;
const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
const MODEL = "gpt-5-mini";
const ROUTER_MODEL = "openai/gpt-5-mini";
// Built at run time: never a key-shaped literal.
const keyOf = (cid: string, provider: string) => ["sk", provider, "company", cid, "z".repeat(16)].join("-");
const chunk = (value: Json | string) => Buffer.from(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
const delta = (d: Json, finish: string | null = null) => chunk({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason: finish }] });
const usage = (extra: Json = {}) => chunk({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 }, ...extra } });
// OpenRouter's real final usage chunk: ONE choice with a content-free delta that REPEATS the finish reason, plus usage (OpenAI's own has choices: []).
const usageWithFinish = (finish: string, extra: Json = {}, d: Json = { role: "assistant", content: "" }, withUsage = true) => chunk({
  id: "c1", object: "chat.completion.chunk",
  choices: [{ index: 0, delta: d, finish_reason: finish, native_finish_reason: finish }],
  ...(withUsage ? { usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0000867, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 12 }, ...extra } } : {}),
});
function* toolStream(extra: Json = {}): Generator<Buffer> {
  yield Buffer.from(": OPENROUTER PROCESSING\n\n");
  yield delta({ role: "assistant", content: null });
  yield delta({ content: "Calling." });
  yield delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "ping", arguments: "" } }] });
  yield delta({ tool_calls: [{ index: 0, function: { arguments: "{\"a\":" } }] });
  yield delta({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] });
  yield delta({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "pong", arguments: "{}" } }] });
  yield delta({}, "tool_calls");
  yield usage(extra);
  yield chunk("[DONE]");
}
interface Event { type: string; index?: number; content_block?: Json; delta?: Json; usage?: Json; message?: Json }
const events = (sse: Buffer): Event[] => sse.toString("utf8").split("\n\n").filter(Boolean).map((block) => JSON.parse(block.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as Event);
function convert(parts: Iterable<Buffer>, provider: "openai" | "openrouter" | "endpoint" = "openai") {
  const c = new ChatStreamToSse(provider, MODEL, "msg_test");
  const out: Buffer[] = [];
  for (const part of parts) for (const byte of [part]) out.push(c.push(byte));
  out.push(c.finish());
  return { sse: Buffer.concat(out), cost: c.reportedCost };
}

describe("Anthropic Messages to Chat Completions", () => {
  const body: Json = {
    model: MODEL, max_tokens: 500, stream: true, temperature: 0.2, stop_sequences: [],
    system: [{ type: "text", text: "You are a coder.", cache_control: { type: "ephemeral" } }],
    metadata: { user_id: "u1" },
    tools: [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [
      { role: "user", content: "Read a.ts" },
      { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "export {}" }] }, { type: "text", text: "Now explain." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "no such file", is_error: true }] },
    ],
  };

  it("translates system, messages, tools, tool choice, tool results and max tokens (an empty stop list is nothing)", () => {
    expect(toChatCompletions(body, MODEL, 400, "openai")).toEqual({
      model: MODEL, stream: true, max_completion_tokens: 400, temperature: 0.2,
      messages: [
        { role: "system", content: "You are a coder." },
        { role: "user", content: "Read a.ts" },
        { role: "assistant", content: "Reading.", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }] },
        { role: "tool", tool_call_id: "toolu_1", content: "export {}" },
        { role: "user", content: "Now explain." },
        { role: "assistant", content: null, tool_calls: [{ id: "toolu_2", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "toolu_2", content: "Error: no such file" },
      ],
      tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
      tool_choice: "auto", parallel_tool_calls: false, stream_options: { include_usage: true },
    });
  });

  it("OpenRouter: max_tokens, and usage accounting so the cost arrives", () => {
    const out = toChatCompletions(body, ROUTER_MODEL, 400, "openrouter")!;
    expect(out).toMatchObject({ model: ROUTER_MODEL, max_tokens: 400, usage: { include: true } });
    expect(out.max_completion_tokens).toBeUndefined();
  });

  it.each([
    ["any", { type: "any" }, "required"], ["tool", { type: "tool", name: "read" }, { type: "function", function: { name: "read" } }], ["none", { type: "none" }, "none"], ["a string", "auto", "auto"],
  ])("tool_choice %s", (_name, choice, expected) => {
    expect(toChatCompletions({ ...body, tool_choice: choice }, MODEL, 10, "openai")!.tool_choice).toEqual(expected);
  });

  const refused: Array<[string, Json]> = [
    ["an image", { ...body, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }] }],
    ["an image beside text", { ...body, messages: [{ role: "user", content: [{ type: "text", text: "see this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }] }],
    ["a document", { ...body, messages: [{ role: "user", content: [{ type: "document", source: { type: "text", data: "x" } }] }] }],
    ["a thinking block", { ...body, messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "s" }] }] }],
    ["thinking switched on", { ...body, thinking: { type: "enabled", budget_tokens: 1024 } }],
    ["a server tool", { ...body, tools: [{ type: "web_search_20250305", name: "web_search" }] }],
    ["a strict tool", { ...body, tools: [{ name: "read", input_schema: { type: "object" }, strict: true }] }],
    ["an unknown tool key beside eager_input_streaming", { ...body, tools: [{ name: "read", input_schema: { type: "object" }, eager_input_streaming: true, defer_loading: true }] }],
    ["a non-boolean eager_input_streaming", { ...body, tools: [{ name: "read", input_schema: { type: "object" }, eager_input_streaming: "yes" }] }],
    ["structured output", { ...body, output_config: { format: { type: "json_schema" } } }],
    ["top_k", { ...body, top_k: 5 }],
    ["five stop sequences", { ...body, stop_sequences: ["a", "b", "c", "d", "e"] }],
    // REVIEW-1 L4: a matched stop sequence comes back as a plain "stop", so it is refused rather than answered as end_turn.
    ["a stop sequence", { ...body, stop_sequences: ["END"] }],
    ["stop sequences that are not a list", { ...body, stop_sequences: "END" }],
    ["tool history without tools", { ...body, tools: undefined, tool_choice: undefined }],
    ["a forced tool without tools", { model: MODEL, messages: [{ role: "user", content: "x" }], tool_choice: { type: "any" } }],
    ["an unknown tool choice", { ...body, tool_choice: { type: "auto_but_different" } }],
    ["a tool result with an image", { ...body, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: {} }] }] }] }],
    ["a system image", { ...body, system: [{ type: "image" }] }],
    ["an empty user turn", { ...body, messages: [{ role: "user", content: [] }] }],
    ["an unknown role", { ...body, messages: [{ role: "developer", content: "x" }] }],
    ["an extra message field", { ...body, messages: [{ role: "user", content: "x", name: "eve" }] }],
  ];
  it.each(refused)("refuses %s as a whole", (_name, input) => {
    expect(toChatCompletions(JSON.parse(JSON.stringify(input)) as Json, MODEL, 10, "openai")).toBeUndefined();
  });

  it("thinking: enabled (or adaptive) is refused for openai and endpoint as today, dropped for openrouter, disabled is accepted everywhere", () => {
    const enabled = { type: "enabled", budget_tokens: 1024, display: "summarized" };
    for (const provider of ["openai", "endpoint"] as const) {
      for (const thinking of [enabled, { type: "adaptive" }, {}, "enabled"]) expect(toChatCompletions({ ...body, thinking }, MODEL, 10, provider), `${provider} ${JSON.stringify(thinking)}`).toBeUndefined();
      expect(toChatCompletions({ ...body, thinking: { type: "disabled" } }, MODEL, 10, provider)).toBeDefined();
    }
    for (const thinking of [enabled, { type: "adaptive" }, {}, "enabled", null, { type: "enabled", budget_tokens: 10_000_000 }]) {
      const out = toChatCompletions({ ...body, thinking }, ROUTER_MODEL, 400, "openrouter")!;
      expect(out).toBeDefined();
      expect(out).not.toHaveProperty("thinking");
      expect(JSON.stringify(out)).not.toContain("budget_tokens");
      expect(out).toEqual(toChatCompletions(body, ROUTER_MODEL, 400, "openrouter"));
    }
    expect(toChatCompletions({ ...body, thinking: { type: "disabled" } }, ROUTER_MODEL, 400, "openrouter")).toEqual(toChatCompletions(body, ROUTER_MODEL, 400, "openrouter"));
  });

  it("drops Anthropic's eager_input_streaming tool hint (Pi 1.5.2 sends it on every tool) and nothing else", () => {
    const tools = [{ name: "read", description: "Read a file.", eager_input_streaming: true, input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }, { name: "ls", eager_input_streaming: false, input_schema: { type: "object" } }];
    for (const provider of ["openai", "endpoint"] as const) {
      const out = toChatCompletions({ ...body, tools }, MODEL, 10, provider)!;
      expect(out.tools).toEqual([{ type: "function", function: { name: "read", description: "Read a file.", parameters: { type: "object" } } }, { type: "function", function: { name: "ls", parameters: { type: "object" } } }]);
      expect(JSON.stringify(out)).not.toContain("eager_input_streaming");
    }
  });

  it("refuses a model name the sources do not accept", () => {
    for (const model of ["", "../x", "a b", "x".repeat(200)]) expect(toChatCompletions(body, model, 10, "openai")).toBeUndefined();
  });
});

describe("Chat Completions stream to Anthropic SSE", () => {
  it("text, then each tool call as its own block, the stop reason, usage with cached tokens; the meter's reader reads it", () => {
    const { sse, cost } = convert(toolStream());
    const list = events(sse);
    expect(list.map((e) => e.type)).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
    ]);
    expect(list[1]!.content_block).toEqual({ type: "text", text: "" });
    expect(list[4]!.content_block).toEqual({ type: "tool_use", id: "call_1", name: "ping", input: {} });
    expect([list[5]!.delta, list[6]!.delta]).toEqual([{ type: "input_json_delta", partial_json: "{\"a\":" }, { type: "input_json_delta", partial_json: "1}" }]);
    expect(list[8]!.content_block).toMatchObject({ type: "tool_use", id: "call_2", name: "pong" });
    expect(list[11]).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } });
    expect(cost).toBeUndefined();
    const reader = new UsageCollector(); reader.push(sse);
    expect(reader.finish()).toEqual({ input: 100, output: 30, cacheRead: 20, cacheWrite: 0 });
  });

  it("finish reasons in Anthropic's words", () => {
    for (const [finish, stop] of [["stop", "end_turn"], ["length", "max_tokens"], ["content_filter", "refusal"], ["tool_calls", "tool_use"]] as const) {
      const { sse } = convert([delta({ content: "x" }), delta({}, finish), usage(), chunk("[DONE]")]);
      expect(events(sse).find((e) => e.type === "message_delta")!.delta).toMatchObject({ stop_reason: stop });
    }
  });

  it("OpenRouter: the final usage's cost, in micro-dollars (rounded up)", () => {
    expect(convert(toolStream({ cost: 0.0000123 }), "openrouter").cost).toBe(13);
    expect(convert(toolStream({ cost: 0 }), "openrouter").cost).toBeUndefined();
    expect(convert(toolStream({ cost: 0.5 }), "openai").cost).toBeUndefined();
  });

  const broken: Array<[string, Buffer[]]> = [
    ["no [DONE]", [delta({ content: "x" }), delta({}, "stop"), usage()]],
    ["no usage", [delta({ content: "x" }), delta({}, "stop"), chunk("[DONE]")]],
    ["no finish reason", [delta({ content: "x" }), usage(), chunk("[DONE]")]],
    ["data after [DONE]", [delta({ content: "x" }), delta({}, "stop"), usage(), chunk("[DONE]"), delta({ content: "late" })]],
    ["an unknown finish reason", [delta({ content: "x" }), delta({}, "weird"), usage(), chunk("[DONE]")]],
    ["an error chunk", [chunk({ error: { message: "boom" } })]],
    ["arguments before the call is named", [delta({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }), delta({}, "tool_calls"), usage(), chunk("[DONE]")]],
    ["two choices", [chunk({ choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] })]],
    ["usage that is not counts", [delta({ content: "x" }), delta({}, "stop"), chunk({ choices: [], usage: { prompt_tokens: -1, completion_tokens: 1 } }), chunk("[DONE]")]],
    ["cached above the prompt", [delta({ content: "x" }), delta({}, "stop"), chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } } }), chunk("[DONE]")]],
    ["not SSE", [Buffer.from("hello\n\n")]],
    ["broken JSON", [chunk("{oops")]],
    // A repeated finish reason is accepted ONLY as the SAME reason, on a chunk with usage, with no content (OpenRouter's usage chunk); all else is broken.
    ["a second finish reason on a chunk without usage", [delta({ content: "x" }, "stop"), delta({}, "stop"), usage(), chunk("[DONE]")]],
    ["a repeated finish reason without usage (even before a usage chunk)", [delta({ content: "x" }, "stop"), usageWithFinish("stop", {}, { content: "" }, false), usage(), chunk("[DONE]")]],
    ["a second, different finish reason on the usage chunk", [delta({ content: "x" }, "stop"), usageWithFinish("tool_calls"), chunk("[DONE]")]],
    ["a repeated finish reason whose delta carries text", [delta({ content: "x" }, "stop"), usageWithFinish("stop", {}, { content: "y" }), chunk("[DONE]")]],
    ["a repeated finish reason whose delta carries a refusal", [delta({ content: "x" }, "stop"), usageWithFinish("stop", {}, { refusal: "no" }), chunk("[DONE]")]],
    ["a repeated finish reason whose delta carries a tool call", [delta({ content: "x" }, "stop"), usageWithFinish("stop", {}, { tool_calls: [{ index: 0, id: "a", function: { name: "x" } }] }), chunk("[DONE]")]],
    ["a third finish reason", [delta({ content: "x" }, "stop"), usageWithFinish("stop"), usageWithFinish("stop"), chunk("[DONE]")]],
    ["a real mid-stream error chunk (error plus finish_reason error)", [delta({ content: "x" }), chunk({ error: { message: "upstream" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }), chunk("[DONE]")]],
    ["a tool call that returns after another started", [delta({ tool_calls: [{ index: 0, id: "a", function: { name: "x" } }] }), delta({ tool_calls: [{ index: 1, id: "b", function: { name: "y" } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] })]],
  ];
  it.each(broken)("throws on %s (a broken stream, never a partial success)", (_name, parts) => {
    expect(() => convert(parts)).toThrow("unreadable answer");
  });

  describe("OpenRouter repeats the finish reason on its final usage chunk (accounting, not a second end)", () => {
    // The shapes use cost 0.0000867 = 87 micros.
    const tools = (): Buffer[] => [
      delta({ role: "assistant", content: null }),
      delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } }] }),
      delta({}, "tool_calls"),
      usageWithFinish("tool_calls"),
      chunk("[DONE]"),
    ];
    it.each(["openrouter", "endpoint"] as const)("settles the whole answer on the %s dialect", (provider) => {
      const { sse, cost } = convert(tools(), provider);
      const evs = events(sse);
      const md = evs.filter((e) => e.type === "message_delta");
      expect(md).toHaveLength(1);
      expect(md[0]!.delta).toEqual({ stop_reason: "tool_use", stop_sequence: null });
      expect(md[0]!.usage).toMatchObject({ input_tokens: 120, output_tokens: 30 });
      expect(evs.map((e) => e.type).slice(-2)).toEqual(["message_delta", "message_stop"]);
      expect(evs.filter((e) => e.type === "content_block_start")).toHaveLength(1);
      if (provider === "openrouter") expect(cost).toBe(87);
    });
    it("a text answer ends once at end_turn, and the cost is the reported one (complete)", () => {
      const c = new ChatStreamToSse("openrouter", ROUTER_MODEL, "msg_t");
      const out: Buffer[] = [];
      for (const part of [delta({ role: "assistant", content: "Hi" }), delta({ content: " there" }, "stop"), usageWithFinish("stop"), chunk("[DONE]")]) out.push(c.push(part));
      out.push(c.finish());
      const evs = events(Buffer.concat(out));
      expect(evs.filter((e) => e.type === "message_delta")).toHaveLength(1);
      expect(evs.find((e) => e.type === "message_delta")!.delta).toEqual({ stop_reason: "end_turn", stop_sequence: null });
      expect(evs.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta!.text)).toEqual(["Hi", " there"]);
      expect(c.reportedCost).toBe(87);
      expect(c.reportedCostComplete).toBe(true);
    });
    // REVIEW-OPUS: only a cost at or after the answer's end, with no answer after it, is final (a failed stream may settle at it).
    it("reportedCostFinal: true for the usage chunk after the finish, false for a cost before or followed by output", () => {
      const feed = (parts: Buffer[]) => { const c = new ChatStreamToSse("openrouter", ROUTER_MODEL, "msg_f"); for (const p of parts) { try { c.push(p); } catch { break; } } return c; };
      expect(feed([delta({ content: "Hi" }, "stop"), usageWithFinish("stop")]).reportedCostFinal).toBe(true);
      expect(feed([delta({ content: "Hi" }, "stop"), usageWithFinish("length")]).reportedCostFinal).toBe(true);
      expect(feed([delta({ content: "Hi" }), chunk({ choices: [{ index: 0, delta: { content: "!" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 } })]).reportedCostFinal).toBe(true);
      expect(feed([usage({ cost: 0.000001 }), delta({ content: "Hi" })]).reportedCostFinal).toBe(false);
      expect(feed([delta({ content: "Hi" }, "stop"), usage({ cost: 0.000001 }), delta({ content: "more" })]).reportedCostFinal).toBe(false);
      expect(feed([delta({ content: "Hi" }, "stop"), usageWithFinish("stop", {}, { content: "y" })]).reportedCostFinal).toBe(false);
      expect(feed([delta({ content: "Hi" })]).reportedCostFinal).toBe(false);
    });
    it("a reasoning model: reasoning fields are dropped, the text and the stop remain", () => {
      const reasoning = { reasoning: "thinking...", reasoning_details: [{ type: "reasoning.text", text: "thinking...", index: 0 }], content: null };
      const parts = [
        delta({ role: "assistant", ...reasoning }),
        delta({ ...reasoning, reasoning: " more" }),
        delta({ content: "Answer." }),
        delta({ content: "", reasoning: null }, "stop"),
        usageWithFinish("stop", {}, { role: "assistant", content: "", reasoning: null, reasoning_details: [] }),
        chunk("[DONE]"),
      ];
      const { sse, cost } = convert(parts, "openrouter");
      const evs = events(sse);
      expect(evs.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta!.text)).toEqual(["Answer."]);
      expect(sse.toString("utf8")).not.toContain("thinking");
      expect(evs.find((e) => e.type === "message_delta")!.delta).toEqual({ stop_reason: "end_turn", stop_sequence: null });
      expect(cost).toBe(87);
    });
  });

  it("REVIEW-1 L5: upstream bytes that make no output are bounded too (comments past the cap break the stream)", () => {
    const c = new ChatStreamToSse("openai", MODEL, "m");
    // Each comment is its own event (a blank line after it), so only the total cap can stop them, not the per-event limit.
    const comment = Buffer.from(`: ${"x".repeat(1024 * 1024 - 4)}\n\n`);
    expect(() => { for (let i = 0; i <= MAX_UPSTREAM_STREAM_BYTES / comment.byteLength; i += 1) c.push(comment); }).toThrow("unreadable answer");
    // Below the cap, the same comments are fine.
    const ok = new ChatStreamToSse("openai", MODEL, "m");
    for (let i = 0; i < 3; i += 1) expect(ok.push(comment).byteLength).toBe(0);
  });

  it("a whole answer becomes an Anthropic message (and OpenRouter's cost)", () => {
    const whole = { choices: [{ index: 0, message: { role: "assistant", content: "Sure.", tool_calls: [{ id: "call_9", type: "function", function: { name: "read", arguments: "{\"path\":\"b\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.002 } };
    expect(fromChatCompletion(whole, "openrouter", ROUTER_MODEL, "msg_1")).toEqual({
      message: { id: "msg_1", type: "message", role: "assistant", model: ROUTER_MODEL, content: [{ type: "text", text: "Sure." }, { type: "tool_use", id: "call_9", name: "read", input: { path: "b" } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      reportedCost: 2000,
    });
    for (const bad of [{}, { choices: [] }, { ...whole, usage: undefined }, { ...whole, choices: [{ message: { tool_calls: [{ id: "c", function: { name: "x", arguments: "[1]" } }] }, finish_reason: "tool_calls" }] }]) expect(() => fromChatCompletion(bad, "openai", MODEL, "m")).toThrow("unreadable answer");
  });
});

// ---- the transport (fake https.request: nothing leaves the process)

function fakeHttps(status: number, parts: Buffer[]) {
  const seen: Array<{ options: Json; body: Buffer }> = [];
  const request = ((options: Json, onResponse: (response: PassThrough & { statusCode: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void };
    req.destroy = () => { req.emit("close"); };
    req.end = (body: Buffer) => {
      seen.push({ options, body: Buffer.from(body) });
      const socket = new EventEmitter(); req.emit("socket", socket); socket.emit("secureConnect");
      const response = Object.assign(new PassThrough(), { statusCode: status });
      onResponse(response);
      for (const part of parts) response.write(part);
      response.end();
    };
    return req;
  }) as unknown as typeof https.request;
  return { request, seen };
}
const drain = async (response: ProviderResponse) => { const out: Buffer[] = []; for await (const part of response.body) out.push(Buffer.from(part)); return Buffer.concat(out); };

describe("the Chat Completions transport", () => {
  it.each(["openai", "openrouter"] as const)("%s: fixed host, port and path, TLS, no agent, the key only as a bearer token; the answer translated", async (provider) => {
    const https = fakeHttps(200, [...toolStream({ cost: 0.001 })]);
    const key = keyOf(cidA, provider);
    const body = Buffer.from(JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "x" }] }));
    const response = await createChatCompletionsTransport(provider, https.request)({ body, headers: { "content-type": "application/json", "x-extra": "dropped" }, key, signal: new AbortController().signal, path: OPENAI_AGENT_UPSTREAM[provider].path });
    expect(https.seen[0]!.options).toMatchObject({ hostname: OPENAI_AGENT_UPSTREAM[provider].host, port: 443, path: OPENAI_AGENT_UPSTREAM[provider].path, method: "POST", agent: false, rejectUnauthorized: true });
    expect(https.seen[0]!.options.headers).toEqual({ "content-type": "application/json", authorization: `Bearer ${key}`, "content-length": String(body.byteLength) });
    const sse = await drain(response);
    expect(events(sse).at(-1)!.type).toBe("message_stop");
    expect(response.reportedCostMicros?.()).toBe(provider === "openrouter" ? 1000 : undefined);
  });

  // REVIEW-1 M1: the money split. A failure before the TLS handshake finished was never sent ($0); after it, the request may have reached
  // the provider and is charged at its hold.
  function handshake(connected: boolean) {
    return (() => {
      const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
      req.destroy = () => { req.emit("close"); };
      req.end = () => { const socket = new EventEmitter(); req.emit("socket", socket); if (connected) socket.emit("secureConnect"); req.emit("error", new Error("reset")); req.emit("close"); };
      return req;
    }) as unknown as typeof https.request;
  }
  it.each(["openai", "openrouter"] as const)("%s: an error after the TLS handshake is a sent call; before it, not sent", async (provider) => {
    const input = { body: Buffer.from(JSON.stringify({ model: MODEL, stream: true, messages: [] })), headers: {}, key: "x".repeat(20), path: OPENAI_AGENT_UPSTREAM[provider].path };
    const after = createChatCompletionsTransport(provider, handshake(true))({ ...input, signal: new AbortController().signal });
    await expect(after).rejects.toThrow("provider unavailable");
    await expect(after).rejects.not.toBeInstanceOf(NotSentError);
    await expect(createChatCompletionsTransport(provider, handshake(false))({ ...input, signal: new AbortController().signal })).rejects.toBeInstanceOf(NotSentError);
  });
  it("on the route: after the handshake the hold is charged; before it, $0", async () => {
    for (const [connected, charged] of [[true, true], [false, false]] as const) {
      const r = route({ transport: () => createChatCompletionsTransport("openai", handshake(connected)) });
      const sink = await call(r.deps, anthropicBody, token());
      expect(sink.status).toBe(502);
      expect((await committedOf(r.meter)) > 0).toBe(charged);
    }
  });

  it("never sends to any other path, or a body it did not build", async () => {
    const https = fakeHttps(200, []);
    const transport = createChatCompletionsTransport("openai", https.request);
    const ok = Buffer.from(JSON.stringify({ model: MODEL, messages: [] }));
    for (const input of [{ body: ok, path: "/v1/other" }, { body: ok }, { body: Buffer.from("not json"), path: OPENAI_AGENT_UPSTREAM.openai.path }]) {
      await expect(transport({ ...input, headers: {}, key: "x".repeat(20), signal: new AbortController().signal })).rejects.toBeInstanceOf(NotSentError);
    }
    expect(https.seen).toEqual([]);
  });

  it("a refusal passes through untranslated for the route to classify", async () => {
    const https = fakeHttps(401, [Buffer.from("{\"error\":{\"message\":\"bad key\"}}")]);
    const response = await createChatCompletionsTransport("openai", https.request)({ body: Buffer.from(JSON.stringify({ model: MODEL, stream: true, messages: [] })), headers: {}, key: "x".repeat(20), signal: new AbortController().signal, path: OPENAI_AGENT_UPSTREAM.openai.path });
    expect(response.status).toBe(401);
  });
});

// ---- the agent route on a company's own OpenAI / OpenRouter key

class CompanyKeys implements LearningKeySource {
  readonly connectedTo = new Map<string, Set<CompanyKeyProvider>>([[cidA, new Set(["openai", "openrouter", "anthropic"])], [cidB, new Set(["openai"])]]);
  asked: string[] = []; reads: string[] = []; refusedOf: string[] = [];
  async connected(_iss: string, cid: string, provider: CompanyKeyProvider): Promise<boolean> { this.asked.push(`${cid}:${provider}`); return this.connectedTo.get(cid)?.has(provider) === true; }
  async keyFor(_iss: string, cid: string, provider: CompanyKeyProvider): Promise<string | undefined> { this.reads.push(`${cid}:${provider}`); return this.connectedTo.get(cid)?.has(provider) === true ? keyOf(cid, provider) : undefined; }
  async refused(_iss: string, cid: string, provider: CompanyKeyProvider): Promise<void> { this.refusedOf.push(`${cid}:${provider}`); }
}
const anthropicBody = { model: MODEL, max_tokens: 200, stream: true, tools: [{ name: "ping", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "hello" }] };
function route(options: { saved?: Record<string, string>; switchedOn?: string[]; transport?: (provider: "openai" | "openrouter") => ProviderTransport; prices?: GatewayDependencies["prices"]; openrouterLimit?: number; offered?: { openai?: boolean; openrouter?: boolean } } = {}) {
  const keys = new CompanyKeys();
  const sent: Array<ProviderRequest & { provider: string }> = [];
  const priced: Array<[string, string]> = [];
  const make = (provider: "openai" | "openrouter"): CompanyChatAi => ({
    transport: async (request) => { sent.push({ ...request, provider }); return (options.transport?.(provider) ?? (async () => ({ status: 200, body: (async function* () { yield* toolStream(provider === "openrouter" ? { cost: 0.0005 } : {}); })() })))(request).then(async (response) => {
      // The real transport translates; this fake runs the same converter over the fake upstream body.
      if (response.status !== 200) return response;
      const converter = new ChatStreamToSse(provider, MODEL, "msg_x");
      const upstream = response.body;
      return { status: 200, reportedCostMicros: () => converter.reportedCost, body: (async function* () { for await (const part of upstream) { const out = converter.push(part); if (out.length) yield out; } const last = converter.finish(); if (last.length) yield last; })() };
    }); },
    ...(provider === "openrouter" && options.openrouterLimit !== undefined ? { maxOutputTokens: () => options.openrouterLimit } : {}),
  });
  const saved = options.saved ?? { [cidA]: "openai_key" };
  const base = setup({
    agentKeys: keys,
    agentAi: {
      sources: { sourceFor: async (cid) => saved[cid] as AgentAiSource | undefined },
      switchedOn: new Set(options.switchedOn ?? ["openai", "openrouter"]),
      ...(options.offered?.openai === false ? {} : { openai: make("openai") }),
      ...(options.offered?.openrouter === false ? {} : { openrouter: make("openrouter") }),
    },
    transport: async () => { throw new Error("the Anthropic transport is never used for these sources"); },
    prices: options.prices ?? { priceFor: (provider, model) => { priced.push([provider, model]); return undefined; } },
  });
  return { ...base, keys, sent, priced };
}
const errorOf = (sink: { text(): string }) => (JSON.parse(sink.text()) as { error: { type: string; message: string } }).error;
const committedOf = async (meter: { read(s: typeof scope): Promise<ReadonlyArray<{ item: string; committed: number; reservedMicros: number }>> }, cid = cidA) => (await meter.read({ ...scope, cid })).filter((row) => row.item === "company").reduce((sum, row) => sum + row.committed + row.reservedMicros, 0);
const token = (cid = cidA) => mint({ cid, mdl: [MODEL, ROUTER_MODEL] });

describe("the agent route on the company's own OpenAI or OpenRouter key", () => {
  it("OpenAI: the translated call on the company's OpenAI key, the answer back as Anthropic SSE, priced as openai, settled from usage", async () => {
    const r = route();
    const sink = await call(r.deps, anthropicBody, token());
    expect(sink.status).toBe(200);
    expect(sink.headers["content-type"]).toContain("text/event-stream");
    expect(events(Buffer.from(sink.text())).map((e) => e.type)).toContain("message_stop");
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ provider: "openai", key: keyOf(cidA, "openai"), path: OPENAI_AGENT_UPSTREAM.openai.path });
    const upstream = JSON.parse(Buffer.from(r.sent[0]!.body).toString("utf8")) as Json;
    expect(upstream).toMatchObject({ model: MODEL, stream: true, max_completion_tokens: 200, tools: [{ type: "function", function: { name: "ping" } }] });
    expect(r.keys.reads).toEqual([`${cidA}:openai`]);
    expect(r.priced[0]).toEqual(["openai", MODEL]);
    // Unknown price: the cautious estimate, never $0.
    expect(await committedOf(r.meter)).toBeGreaterThan(0);
  });

  it("holds a call to the model's own output limit (and the default when there is none)", async () => {
    const big = { ...anthropicBody, max_tokens: 60_000 };
    const r = route({ saved: { [cidA]: "openrouter_key" }, openrouterLimit: 1_000 });
    expect((await call(r.deps, big, token())).status).toBe(409);
    expect(r.sent).toEqual([]); // No legacy unpriced OpenRouter call, even with a token cap.
    const d = route();
    await call(d.deps, big, token());
    expect((JSON.parse(Buffer.from(d.sent[0]!.body).toString("utf8")) as Json).max_completion_tokens).toBe(OPENAI_AGENT_DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("OpenRouter without a reviewed tariff and signed ceiling never holds, opens a key or sends", async () => {
    const r = route({ saved: { [cidA]: "openrouter_key" } });
    expect((await call(r.deps, anthropicBody, token())).status).toBe(409);
    expect(r.sent).toEqual([]); expect(r.keys.reads).toEqual([]);
    expect(await committedOf(r.meter)).toBe(0);
  });

  it("a known token price does not authorize unbounded reported OpenRouter cost", async () => {
    const known = { priceFor: () => ({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 }) };
    const r = route({ saved: { [cidA]: "openrouter_key" }, prices: known });
    expect((await call(r.deps, anthropicBody, token())).status).toBe(409);
    expect(r.sent).toEqual([]); expect(r.keys.reads).toEqual([]);
  });

  it("the switch: a kind that is off is refused before anything is read, held or sent", async () => {
    const r = route({ switchedOn: ["openrouter"] });
    const sink = await call(r.deps, anthropicBody, token());
    expect(errorOf(sink)).toEqual({ type: AGENT_SOURCE_SWITCHED_OFF.code, message: AGENT_SOURCE_SWITCHED_OFF.message });
    expect(r.sent).toEqual([]); expect(r.keys.asked).toEqual([]);
    expect(await committedOf(r.meter)).toBe(0);
  });

  it("not built on this gateway: refused, never sent elsewhere", async () => {
    const r = route({ offered: { openai: false } });
    expect(errorOf(await call(r.deps, anthropicBody, token()))).toEqual({ type: AGENT_CHAT_NOT_OFFERED.code, message: AGENT_CHAT_NOT_OFFERED.message });
    expect(r.sent).toEqual([]);
  });

  it("no key of THAT provider connected: refused before any hold (an Anthropic key is never a stand-in)", async () => {
    const r = route({ saved: { [cidB]: "openai_key" } });
    r.keys.connectedTo.get(cidB)!.delete("openai");
    const sink = await call(r.deps, anthropicBody, token(cidB));
    expect(errorOf(sink)).toEqual({ type: AGENT_KEY_MISSING.code, message: AGENT_KEY_MISSING.message });
    expect(r.keys.asked).toEqual([`${cidB}:openai`]); expect(r.keys.reads).toEqual([]); expect(r.sent).toEqual([]);
  });

  it("two companies: each call carries only its own company's key", async () => {
    const r = route({ saved: { [cidA]: "openai_key", [cidB]: "openai_key" } });
    expect((await call(r.deps, anthropicBody, token(cidA))).status).toBe(200);
    expect((await call(r.deps, anthropicBody, token(cidB))).status).toBe(200);
    expect(r.sent.map((s) => s.key)).toEqual([keyOf(cidA, "openai"), keyOf(cidB, "openai")]);
    expect(r.keys.reads).toEqual([`${cidA}:openai`, `${cidB}:openai`]);
  });

  it("the provider refuses the key: free, fixed words, the company's settings page told; nothing of the answer echoed", async () => {
    const r = route({ transport: () => async () => ({ status: 401, body: (async function* () { yield Buffer.from(`{"error":{"message":"bad ${keyOf(cidA, "openai")}"}}`); })() }) });
    const sink = await call(r.deps, anthropicBody, token());
    expect(errorOf(sink)).toEqual({ type: AGENT_KEY_REFUSED.code, message: AGENT_KEY_REFUSED.message });
    expect(sink.text()).not.toContain("bad");
    expect(await committedOf(r.meter)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.keys.refusedOf).toEqual([`${cidA}:openai`]);
  });

  it("any other error answer: free (no output), the fixed provider error", async () => {
    for (const status of [400, 429, 500, 503]) {
      const r = route({ transport: () => async () => ({ status, body: (async function* () { yield Buffer.from("upstream words"); })() }) });
      const sink = await call(r.deps, anthropicBody, token());
      expect(errorOf(sink)).toEqual({ type: "provider_error", message: "provider unavailable" });
      expect(await committedOf(r.meter)).toBe(0);
    }
  });

  it("Rovara-cloud#319: the log line of a provider's error answer carries its HTTP status, never its body", async () => {
    for (const status of [400, 404, 429, 500]) {
      const r = route({ transport: () => async () => ({ status, body: (async function* () { yield Buffer.from("PROVIDER-CANARY your organization must be verified"); })() }) });
      await call(r.deps, anthropicBody, token());
      const refused = r.logs.filter((line) => (line as { event?: unknown }).event === "refused");
      expect(refused, String(status)).toEqual([expect.objectContaining({ event: "refused", code: "provider_error", status: 502, upstreamStatus: status, route: "agent", payer: "openai_key" })]);
      expect(JSON.stringify(r.logs)).not.toContain("PROVIDER-CANARY");
    }
    // A refusal the gateway makes itself (nothing sent) has no provider status.
    const r = route();
    await call(r.deps, { ...anthropicBody, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }] }, token());
    expect(r.logs.filter((line) => (line as { event?: unknown }).event === "refused").every((line) => !Object.hasOwn(line as object, "upstreamStatus"))).toBe(true);
  });

  it("a request with something it cannot translate: refused before any hold, in fixed words", async () => {
    const r = route();
    const sink = await call(r.deps, { ...anthropicBody, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }] }, token());
    expect(sink.status).toBe(400);
    expect(errorOf(sink)).toEqual({ type: AGENT_CHAT_FEATURE.code, message: AGENT_CHAT_FEATURE.message });
    expect(r.sent).toEqual([]); expect(r.keys.reads).toEqual([]);
    expect(await committedOf(r.meter)).toBe(0);
  });

  it("a stream that breaks: charged at its hold, the agent's stream destroyed (never a partial success)", async () => {
    const r = route({ transport: () => async () => ({ status: 200, body: (async function* () { yield delta({ content: "x" }); })() }) });
    const sink = await call(r.deps, anthropicBody, token());
    expect(sink.destroyed).toBe(true);
    expect(await committedOf(r.meter)).toBeGreaterThan(0);
  });

  it("an answer carrying the company's key is stopped by the gateway's scanner", async () => {
    const r = route({ transport: () => async () => ({ status: 200, body: (async function* () { yield delta({ content: `leak ${keyOf(cidA, "openai")}` }); yield delta({}, "stop"); yield usage(); yield chunk("[DONE]"); })() }) });
    const sink = await call(r.deps, anthropicBody, token());
    expect(sink.text()).not.toContain(keyOf(cidA, "openai").slice(-20));
    expect(sink.destroyed).toBe(true);
  });
});

describe("the models a company on its own key may use (offered-models)", () => {
  const ask = (source: string | undefined, options: { switchedOn?: string[]; chat?: { openai?: boolean; openrouter?: boolean } } = {}) => answerOfferedModels({
    verify: async () => ({ iss: claims.iss, aud: "rovara-model-gateway-offered-models", jti: "00000000-0000-4000-8000-000000000000", iat: 0, nbf: 0, exp: 60, cid: cidA }),
    sources: { sourceFor: async () => source as AgentAiSource | undefined }, disabled: new Set(),
    switchedOn: new Set(options.switchedOn ?? ["openai", "openrouter"]), chat: options.chat ?? { openai: true, openrouter: true },
    // No reviewed OpenRouter tariff (the release rows are time-limited): the list must wait for one.
    openRouterTariffs: [],
  }, { method: "GET", url: `/v1/service/companies/${cidA}/offered-models`, headers: { authorization: "Bearer t" } });
  const refusal = (o: { status: number; code: string; message: string }) => ({ status: o.status, body: { error: { type: o.code, message: o.message } } });

  it("own OpenAI key: the OpenAI list; OpenRouter waits for an enforceable reviewed tariff", async () => {
    expect(await ask("openai_key")).toEqual({ status: 200, body: { version: 1, models: OPENAI_KEY_AGENT_MODELS.map((model) => ({ model })) } });
    expect(await ask("openrouter_key")).toEqual(refusal(OFFERED_EMPTY as { status: number; code: string; message: string }));
  });

  it("switched off or not built: refused like the agent route; saved own sources unchanged", async () => {
    expect(await ask("openai_key", { switchedOn: [] })).toEqual(refusal(OFFERED_SWITCHED_OFF as { status: number; code: string; message: string }));
    expect(await ask("openai_key", { chat: {} })).toEqual(refusal(OFFERED_CHAT_OFF as { status: number; code: string; message: string }));
    expect((await ask("anthropic_key", { switchedOn: [] })).status).toBe(200);

  });

  it("C-1: an own-key company has a real saved choice after backfill; a new unconnected company gets Rovara AI", async () => {
    const wire = new WireDynamo(["companies", "product-keys"], { namespaceTables: true });
    const db = new Dynamo({ region: "us-east-1", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
    await db.put("product-keys", { pk: `CO#${JSON.stringify([claims.iss, cidA])}`, sk: "doc#_learning", v: 1, f_removed: [], f_sources: [{ sourceId: "src_anthropic", provider: "anthropic", connectedBy: "d".repeat(64), connectedAt: 1, updatedAt: 1, currentVersion: "00000000-0000-4000-8000-000000000001" }] });
    const input = { db, companyTable: "companies", productTable: "product-keys", issuer: claims.iss, companies: [cidA, cidB] };
    const plan = await planAgentOwnKeyBackfill(input);
    expect(await applyAgentOwnKeyBackfill(input, plan)).toEqual({ written: 1, conflicted: 0 });
    const sources = new CompanyAgentAiSource(db, "companies");
    expect(await sources.sourceFor(cidA)).toBe("anthropic_key");
    expect(await sources.sourceFor(cidB)).toBeUndefined();
    const read = (cid: string) => answerOfferedModels({
      verify: async () => ({ iss: claims.iss, aud: "rovara-model-gateway-offered-models", jti: "00000000-0000-4000-8000-000000000000", iat: 0, nbf: 0, exp: 60, cid }),
      sources, disabled: new Set(), switchedOn: new Set(),
      rovara: { models: new Map([["claude-sonnet-5-5", "us.anthropic.claude-sonnet-5-5"]]), exempt: new Set() },
    }, { method: "GET", url: `/v1/service/companies/${cid}/offered-models`, headers: { authorization: "Bearer t" } });
    expect(await read(cidA)).toEqual({ status: 200, body: { version: 1, models: ANTHROPIC_KEY_AGENT_MODELS.map((model) => ({ model })) } });
    expect(await read(cidB)).toEqual({ status: 200, body: { version: 1, models: [{ model: "claude-sonnet-5-5" }] } });
  });
});

// ---- the deployed process: the own-key sources are built in company-key mode and gated by GATEWAY_AI_SOURCE_KINDS

class FakeResponse extends EventEmitter {
  statusCode = 0; chunks: Buffer[] = []; headersSent = false; destroyed = false;
  writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; }
  write(bytes: Uint8Array) { this.chunks.push(Buffer.from(bytes)); return true; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("finish"); this.emit("close"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
}
const running: RunningGateway[] = [];
afterEach(async () => { for (const g of running.splice(0)) await g.drain(); });

describe("the gateway process serves the own-key sources", () => {
  const ENV = {
    [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
    [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
    [GATEWAY_ENV.meterTable]: "gw-meter", [GATEWAY_ENV.ledgerTable]: "gw-ledger", [GATEWAY_ENV.markersTable]: "gw-markers", [GATEWAY_ENV.pricesTable]: "gw-prices", [GATEWAY_ENV.companyTable]: "cloud-companies",
    [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/test/model-gateway/provider/anthropic-AbCdEf",
    [GATEWAY_ENV.productKeysTable]: "gw-product-keys", [GATEWAY_ENV.productKeysKey]: "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-3333-4444-555555555555",
    [GATEWAY_ENV.productMeterTable]: "gw-product-meter", [GATEWAY_ENV.productLedgerTable]: "gw-product-ledger", [GATEWAY_ENV.productMarkersTable]: "gw-product-markers", [GATEWAY_ENV.evalStagesTable]: "gw-eval-stages",
    [GATEWAY_ENV.agentKeys]: "company",
  };
  async function serve(kinds: string | undefined) {
    const wire = new WireDynamo(["gw-meter", "gw-ledger", "gw-markers", "gw-prices", "cloud-companies"], { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    await db.put("cloud-companies", { pk: `COMPANY#${cidA}`, sk: "SETTINGS", companyId: cidA, version: 1, settings: { budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } } });
    await db.put("cloud-companies", { pk: `COMPANY#${cidA}`, sk: "AGENT_AI", companyId: cidA, source: "openai_key", version: 1 });
    const config: ServeConfig = { ...(readGatewayConfig({ ...ENV, ...(kinds === undefined ? {} : { [GATEWAY_ENV.aiSourceKinds]: kinds }) }) as ServeConfig), port: 0 };
    delete (config as { product?: unknown }).product;
    const sent: ProviderRequest[] = [];
    const gateway = await startServe(config, {
      db, fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), now: () => now, listen: false, log: () => undefined,
      keys: { keyFor: async () => "rovara-install-key" }, agentKeys: new CompanyKeys(),
      transport: async () => { throw new Error("never the Anthropic transport"); },
      openaiAgentTransport: async (request) => {
        sent.push(request);
        const converter = new ChatStreamToSse("openai", MODEL, "msg_p");
        return { status: 200, body: (async function* () { for (const part of toolStream()) { const out = converter.push(part); if (out.length) yield out; } yield converter.finish(); })() };
      },
    });
    running.push(gateway);
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(anthropicBody))]), { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": token() } });
    const res = new FakeResponse();
    const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
    gateway.server.emit("request", req, res);
    return { res: await done, sent };
  }

  it("switched on: the company's own OpenAI key through the deployed transport; switched off: refused, nothing sent", async () => {
    const on = await serve("openai");
    expect(on.res.statusCode).toBe(200);
    expect(on.sent.map((r) => r.key)).toEqual([keyOf(cidA, "openai")]);
    const off = await serve(undefined);
    expect(off.res.statusCode).toBe(403);
    expect(off.sent).toEqual([]);
  });
});
