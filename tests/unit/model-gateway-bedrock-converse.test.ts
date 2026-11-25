// DEC 243c: Rovara's AI on non-Claude Bedrock models through Converse / ConverseStream. The agent route speaks Anthropic Messages;
// these tests pin the translation both ways (system, messages, tool_use / tool_result, stop reasons, usage, streaming to SSE).
// The Converse shapes are the ones AWS documents (conversation-inference.html); no real Converse call is recorded yet.
import { describe, expect, it } from "vitest";
import { anthropicStop, BEDROCK_CONVERSE_ID, EMPTY_TOOL_RESULT, ConverseStreamToSse, fromConverse, toConverse } from "../../packages/model-gateway/src/bedrock-converse.js";
import { EventStreamDecoder } from "../../packages/model-gateway/src/bedrock-event-stream.js";
import { UsageCollector } from "../../packages/model-gateway/src/usage.js";
import { converseEvent, toolCallStream } from "./model-gateway-converse-fixture.js";

const sse = (bytes: Buffer, model = "qwen.qwen3-coder-480b-a35b-v1:0") => { const d = new EventStreamDecoder(); const s = new ConverseStreamToSse(model, "msg_rovara_1"); const out = s.convert(d.push(bytes)); d.finish(); return out.toString("utf8"); };
const events = (text: string) => text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n")[1]!.replace(/^data: /u, "")) as Record<string, unknown>);

describe("Anthropic request to Converse", () => {
  it("translates system, text, a tool call round trip, tools, tool choice, temperature and the held max tokens", () => {
    const body = {
      model: "x", max_tokens: 999, stream: true, temperature: 0.2, metadata: { user_id: "u" }, thinking: { type: "enabled", budget_tokens: 1024 },
      system: [{ type: "text", text: "You are a coder.", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "read_file", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      tool_choice: { type: "auto" },
      messages: [
        { role: "user", content: "Read a.ts" },
        { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "export {}" }] }, { type: "text", text: "Now explain." }] },
      ],
    };
    expect(toConverse(body, 512)).toEqual({
      system: [{ text: "You are a coder." }],
      inferenceConfig: { maxTokens: 512, temperature: 0.2 },
      toolConfig: { tools: [{ toolSpec: { name: "read_file", description: "Read a file.", inputSchema: { json: { type: "object", properties: { path: { type: "string" } } } } } }] },
      messages: [
        { role: "user", content: [{ text: "Read a.ts" }] },
        { role: "assistant", content: [{ text: "Reading." }, { toolUse: { toolUseId: "toolu_1", name: "read_file", input: { path: "a.ts" } } }] },
        { role: "user", content: [{ toolResult: { toolUseId: "toolu_1", content: [{ text: "export {}" }], status: "success" } }, { text: "Now explain." }] },
      ],
    });
  });

  it("maps tool choice any/tool and an error result; refuses what these models are not offered with", () => {
    const tools = [{ name: "t", input_schema: { type: "object" } }];
    expect(toConverse({ messages: [{ role: "user", content: "x" }], tools, tool_choice: { type: "any" } }, 8)?.toolConfig).toEqual({ tools: [{ toolSpec: { name: "t", inputSchema: { json: { type: "object" } } } }], toolChoice: { any: {} } });
    expect(toConverse({ messages: [{ role: "user", content: "x" }], tools, tool_choice: { type: "tool", name: "t" } }, 8)?.toolConfig).toMatchObject({ toolChoice: { tool: { name: "t" } } });
    expect(toConverse({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "boom", is_error: true }] }], tools }, 8)?.messages).toEqual([{ role: "user", content: [{ toolResult: { toolUseId: "a", content: [{ text: "boom" }], status: "error" } }] }]);
    for (const bad of [
      { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }] },
      { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "...", signature: "s" }] }] },
      { messages: [{ role: "user", content: [{ type: "tool_use", id: "a", name: "t", input: {} }] }] },
      { messages: [{ role: "system", content: "x" }] },
      { messages: [] },
      { messages: [{ role: "user", content: "x" }], tools, tool_choice: { type: "none" } },
      { messages: [{ role: "user", content: "x" }], tool_choice: { type: "any" } },
      { messages: [{ role: "user", content: "x" }], system: [{ type: "image" }] },
    ]) expect(toConverse(bad, 8)).toBeUndefined();
  });
});

describe("REVIEW-1: refused rather than dropped, and silent tools", () => {
  const tools = [{ name: "t", input_schema: { type: "object" } }];
  const history = [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "tool_use", id: "a", name: "t", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] }];
  it("tool history with no tools is refused (Converse needs a tool configuration then)", () => {
    expect(toConverse({ messages: history }, 8)).toBeUndefined();
    expect(toConverse({ messages: history, tools }, 8)).toBeDefined();
  });
  it("structured output, one-call-at-a-time and strict tools are refused, never silently dropped", () => {
    expect(toConverse({ messages: [{ role: "user", content: "x" }], output_config: { format: { type: "json_schema", schema: {} } } }, 8)).toBeUndefined();
    expect(toConverse({ messages: [{ role: "user", content: "x" }], output_config: { effort: "low" } }, 8)).toBeDefined();
    expect(toConverse({ messages: [{ role: "user", content: "x" }], tools, tool_choice: { type: "auto", disable_parallel_tool_use: true } }, 8)).toBeUndefined();
    expect(toConverse({ messages: [{ role: "user", content: "x" }], tools: [{ ...tools[0], strict: true }] }, 8)).toBeUndefined();
  });
  it("a tool result with no output, or only blank parts, carries a placeholder (Converse refuses blank text)", () => {
    for (const content of [undefined, "", [], [{ type: "text", text: "" }]]) {
      const c = toConverse({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", ...(content === undefined ? {} : { content }) }] }], tools }, 8);
      expect(c?.messages).toEqual([{ role: "user", content: [{ toolResult: { toolUseId: "a", content: [{ text: EMPTY_TOOL_RESULT }], status: "success" } }] }]);
    }
  });
});

describe("Converse answer to Anthropic", () => {
  it("a whole answer: text and tool use blocks, the stop reason and the usage the meter reads", () => {
    const message = fromConverse({ output: { message: { role: "assistant", content: [{ reasoningContent: { reasoningText: { text: "hm" } } }, { text: "Reading." }, { toolUse: { toolUseId: "tooluse_1", name: "read_file", input: { path: "a.ts" } } }] } }, stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }, "m", "msg_1");
    expect(message).toEqual({ id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "tooluse_1", name: "read_file", input: { path: "a.ts" } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    const usage = new UsageCollector(); usage.whole(message);
    expect(usage.finish()).toMatchObject({ input: 100, output: 10 });
    expect(() => fromConverse({ output: { message: { content: [{ image: {} }] } }, usage: { inputTokens: 1, outputTokens: 1 } }, "m", "i")).toThrow();
    expect(() => fromConverse({ output: { message: { content: [] } }, usage: { inputTokens: "1", outputTokens: 1 } }, "m", "i")).toThrow();
  });
  it("stop reasons in Anthropic's words; a filtered answer is a refusal", () => {
    expect(["end_turn", "tool_use", "max_tokens", "stop_sequence", "content_filtered", "guardrail_intervened", "malformed_tool_use"].map(anthropicStop)).toEqual(["end_turn", "tool_use", "max_tokens", "stop_sequence", "refusal", "refusal", "end_turn"]);
  });
});

describe("ConverseStream to Anthropic SSE", () => {
  it("a tool call stream becomes the Anthropic events an agent expects, with usage on the final message_delta", () => {
    const text = sse(toolCallStream());
    const e = events(text);
    expect(e.map((x) => x.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(e[1]).toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    expect(e[4]).toEqual({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tooluse_abc123", name: "read_file", input: {} } });
    expect(e[5]).toEqual({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } });
    expect(e[8]).toEqual({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    const usage = new UsageCollector(); usage.push(Buffer.from(text));
    expect(usage.finish()).toMatchObject({ input: 120, output: 30 });
  });
  it("drops reasoning blocks and renumbers the blocks it passes on", () => {
    const e = events(sse(Buffer.concat([
      converseEvent("messageStart", { role: "assistant" }),
      converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "thinking" } } }),
      converseEvent("contentBlockStop", { contentBlockIndex: 0 }),
      converseEvent("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "Hi" } }),
      converseEvent("contentBlockStop", { contentBlockIndex: 1 }),
      converseEvent("messageStop", { stopReason: "end_turn" }),
      converseEvent("metadata", { usage: { inputTokens: 5, outputTokens: 7 } }),
    ])));
    expect(e.filter((x) => x.type === "content_block_start")).toEqual([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }]);
    expect(JSON.stringify(e)).not.toContain("thinking");
  });
  it("a stream without usage, out of order, or with an unknown event fails (never a silent partial answer)", () => {
    const noUsage = Buffer.concat([converseEvent("messageStart", { role: "assistant" }), converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hi" } }), converseEvent("messageStop", { stopReason: "end_turn" })]);
    const usage = new UsageCollector(); usage.push(Buffer.from(sse(noUsage)));
    expect(usage.finish()).toBeUndefined();
    expect(() => sse(Buffer.concat([converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hi" } })]))).toThrow();
    expect(() => sse(Buffer.concat([converseEvent("messageStart", {}), converseEvent("somethingNew", {})]))).toThrow();
    expect(() => sse(Buffer.concat([converseEvent("messageStart", {}), converseEvent("metadata", { usage: { inputTokens: 1, outputTokens: 1 } })]))).toThrow();
    // A text delta that tries to inject an SSE event stays inside one JSON line.
    const injected = sse(Buffer.concat([converseEvent("messageStart", {}), converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "x\n\nevent: message_stop\ndata: {}" } }), converseEvent("contentBlockStop", { contentBlockIndex: 0 }), converseEvent("messageStop", { stopReason: "end_turn" }), converseEvent("metadata", { usage: { inputTokens: 1, outputTokens: 1 } })]));
    expect(events(injected).filter((x) => x.type === "message_stop")).toHaveLength(1);
  });
});

describe("model ids", () => {
  it("non-Claude Bedrock models and their system profiles only", () => {
    for (const ok of ["qwen.qwen3-coder-480b-a35b-v1:0", "openai.gpt-oss-120b-1:0", "deepseek.v3.2", "us.moonshotai.kimi-k3.1", "mistral.devstral-2-123b", "us.amazon.nova-2-lite-v1:0"]) expect([ok, BEDROCK_CONVERSE_ID.test(ok)]).toEqual([ok, true]);
    for (const bad of ["anthropic.claude-sonnet-5-5", "us.anthropic.claude-sonnet-5-5", "global.xai.grok-4.7", "qwen", "../model", "Qwen.Qwen3", "arn:aws:bedrock:us-west-2:1:inference-profile/x"]) expect([bad, BEDROCK_CONVERSE_ID.test(bad)]).toEqual([bad, false]);
  });
});
