// DEC 243c: a model Rovara's AI serves through Bedrock's Converse needs a tool configuration whenever the conversation holds a tool call or a tool result, and the gateway refuses a turn without
// one. Every routed model call (the one place all of the worker's and the helpers' calls to the gateway pass) is held to that: tool blocks without declared tools never leave, in fixed words.
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { TOOL_DECLARATIONS_MISSING_WORDS, toolBlocksWithoutTools } from "../../packages/model-runtime/src/tool-history.js";

const ALIAS = "qwen.qwen3-coder-480b-a35b-v1:0";
const TOOL = { name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const history = (tools: Context["tools"]): Context => ({
  ...(tools === undefined ? {} : { tools }),
  messages: [
    { role: "user", content: "Read README.md", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "toolu_1", name: "read_file", arguments: { path: "README.md" } }], api: "anthropic-messages", provider: "rovara-route", model: ALIAS, usage, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "toolu_1", toolName: "read_file", content: [{ type: "text", text: "# Hello" }], isError: false, timestamp: 3 },
  ],
});
const plain: Context = { messages: [{ role: "user", content: "Say hi", timestamp: 1 }] };

function sse(events: Array<{ type: string } & Record<string, unknown>>) {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
const answer = () => sse([
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: ALIAS, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
]);

async function routed() {
  const bodies: Array<Record<string, unknown>> = [];
  const transport = vi.fn(async (_input: unknown, init?: RequestInit) => { bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>); return answer(); }) as unknown as typeof fetch;
  const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: ALIAS }, { fetch: transport, onUsage: () => undefined, proxy: { baseUrl: "https://gateway.example", apiKey: "task-key", route: { alias: ALIAS, api: "anthropic-messages", catalog: ALIAS } } });
  return { runtime, model: runtime.getModel("rovara-route", ALIAS)!, transport, bodies };
}

describe("tool blocks without declared tools (pure)", () => {
  it("finds a tool call or a tool result with no tool declared, and nothing otherwise", () => {
    const messages = history(undefined).messages;
    expect(toolBlocksWithoutTools({ messages })).toBe(true);
    expect(toolBlocksWithoutTools({ messages: messages.slice(0, 2) })).toBe(true);
    expect(toolBlocksWithoutTools({ messages: [messages[0]!, messages[2]!] })).toBe(true);
    expect(toolBlocksWithoutTools({ messages: [messages[0]!] })).toBe(false);
    const declared = [{ role: "system", content: "", toolsAdded: [TOOL], timestamp: 0 }, ...messages];
    expect(toolBlocksWithoutTools({ messages: declared })).toBe(false);
    // A tool added and then removed leaves none.
    const removed = [...declared, { role: "system", content: "", toolsRemoved: [{ name: "read_file" }], timestamp: 9 }];
    expect(toolBlocksWithoutTools({ messages: removed })).toBe(true);
    // Malformed input is treated as having tool blocks without tools only when it has them; it never throws.
    expect(toolBlocksWithoutTools({ messages: [null, 3, "x", {}] as never })).toBe(false);
    expect(toolBlocksWithoutTools({ messages: undefined as never })).toBe(false);
  });
});

describe("a routed model call (the gateway's agent route)", () => {
  it("declares the tools when the conversation holds tool blocks: the request carries tools, tool_use and tool_result (positive control)", async () => {
    const { runtime, model, bodies } = await routed();
    const message = await runtime.completeSimple(model, history([TOOL]));
    expect(message.stopReason).toBe("stop");
    expect(bodies).toHaveLength(1);
    const body = bodies[0]! as { tools?: Array<{ name: string }>; messages: Array<{ content: unknown }>; model: string };
    expect(body.model).toBe(ALIAS);
    expect(body.tools?.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(JSON.stringify(body.messages)).toContain("tool_use");
    expect(JSON.stringify(body.messages)).toContain("tool_result");
  });

  it("refuses a conversation with tool blocks and no declared tools: nothing is sent, fixed words", async () => {
    const { runtime, model, transport } = await routed();
    const message = await runtime.completeSimple(model, history(undefined));
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(TOOL_DECLARATIONS_MISSING_WORDS);
    expect(transport).not.toHaveBeenCalled();
    expect(JSON.stringify(message)).not.toContain("README.md");
  });

  it("sends a conversation with no tool blocks and no tools exactly as before", async () => {
    const { runtime, model, bodies } = await routed();
    const message = await runtime.completeSimple(model, plain);
    expect(message.stopReason).toBe("stop");
    expect((bodies[0]! as { tools?: unknown }).tools).toBeUndefined();
  });

  it("holds a call whose tools were all withdrawn after being used", async () => {
    const { runtime, model, transport } = await routed();
    const withdrawn = history([TOOL]);
    const message = await runtime.completeSimple(model, { ...withdrawn, messages: [...withdrawn.messages, { role: "system", content: "", toolsRemoved: [{ name: "read_file" }], timestamp: 9 } as never, { role: "user", content: "Again", timestamp: 10 }] });
    expect(message.stopReason).toBe("error");
    expect(transport).not.toHaveBeenCalled();
  });
});
