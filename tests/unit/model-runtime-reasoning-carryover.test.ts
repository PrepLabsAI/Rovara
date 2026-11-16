// ROVARA-AI-REASONING-CARRYOVER, Code side. Five reasoning models (DeepSeek V3.2, Kimi K2 Thinking, Kimi K3, Kimi K3.1, MiniMax M2.5) need
// their earlier reasoning sent back on the next turn of a tool loop. Rovara's gateway returns it as Anthropic `thinking` blocks WITHOUT a
// signature (no real Bedrock stream for these models carries one). Pi keeps such a block in the history, but its Anthropic client turns an
// unsigned thinking block into a plain TEXT block unless the model's compat says `allowEmptySignature` (pi-ai anthropic-messages.js,
// convertMessages: the "!hasThinkingSignature" branch). This pins that a routed model of those five is registered with that flag, so the
// next request carries the reasoning as a `thinking` block with an empty signature, and that every other routed model is unchanged.
import { describe, expect, it } from "vitest";
import type { InvocationModelRoute } from "@agentx/contracts";
import { ROUTE_PROVIDER } from "../../packages/model-runtime/src/catalog.js";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { carriesUnsignedReasoning } from "../../packages/model-runtime/src/transport.js";
import { fakeFetch, sse, type RecordedRequest } from "../support/e2e-provider-fakes.js";

const FIVE = ["deepseek.v3.2", "moonshot.kimi-k2-thinking", "minimax.minimax-m2.5", "us.moonshotai.kimi-k3", "us.moonshotai.kimi-k3.1"];
const REASONING_TEXT = " The user asked me to call ping.\n  I will call it. ";
const route = (catalog: string): InvocationModelRoute => ({ alias: `org.src_aaaaaaaaaaaaaaaaaaaa.${catalog.replaceAll(".", "-")}`, api: "anthropic-messages", catalog });

/** What Rovara's gateway streams for one of the five: an unsigned thinking block, an empty text block, then a tool call (the shape of the real Bedrock answers, translated). */
const gatewayAnswer = (model: string) => sse([
  { event: "message_start", data: { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: REASONING_TEXT } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tooluse_1", name: "ping", input: {} } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 12, output_tokens: 9 } } },
  { event: "message_stop", data: { type: "message_stop" } },
]);
const tools = [{ name: "ping", description: "Ping.", parameters: { type: "object", properties: {} } }];

/** Two turns through the routed model runtime, as the engine runs them: the answer of turn 1 is the history of turn 2. Returns the two requests the gateway received. */
async function twoTurns(catalog: string): Promise<RecordedRequest[]> {
  const { fetch: transport, requests } = fakeFetch(() => gatewayAnswer(catalog));
  const r = route(catalog);
  const runtime = await createConfiguredModelRuntime({ provider: ROUTE_PROVIDER, modelId: r.alias }, { proxy: { baseUrl: "https://gateway.invalid", apiKey: "test-key-not-real", route: r }, fetch: transport });
  const model = runtime.getModel(ROUTE_PROVIDER, r.alias)!;
  const first = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Call the ping tool.", timestamp: 0 }], tools } as never);
  expect(first.content.map((b) => b.type)).toEqual(["thinking", "toolCall"]);
  expect(first.content[0]).toMatchObject({ type: "thinking", thinking: REASONING_TEXT, thinkingSignature: "" });
  await runtime.completeSimple(model, { messages: [{ role: "user", content: "Call the ping tool.", timestamp: 0 }, first, { role: "toolResult", toolCallId: "tooluse_1", toolName: "ping", content: [{ type: "text", text: "pong" }], isError: false, timestamp: 1 }], tools } as never);
  return requests;
}

describe("a routed model that needs its reasoning back keeps it, unsigned, on the next request", () => {
  for (const id of FIVE) {
    it(`${id}: turn 2 carries the reasoning as a thinking block with an empty signature, in front of the tool call`, async () => {
      const requests = await twoTurns(id);
      expect(requests).toHaveLength(2);
      const assistant = (requests[1]!.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).find((m) => m.role === "assistant")!;
      expect(assistant.content.map((c) => c.type)).toEqual(["thinking", "tool_use"]);
      expect(assistant.content[0]).toEqual({ type: "thinking", thinking: REASONING_TEXT, signature: "" });
      // Not downgraded to the visible reply.
      expect(JSON.stringify(assistant.content)).not.toContain('"type":"text"');
    });
  }
  it("any other routed model is unchanged: an unsigned thinking block is still sent as plain text (Anthropic refuses an empty signature)", async () => {
    for (const id of ["claude-sonnet-5-5", "qwen.qwen3-coder-480b-a35b-v1:0", "deepseek.v3-v1:0", "openai.gpt-oss-120b-1:0"]) {
      const requests = await twoTurns(id);
      const assistant = (requests[1]!.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).find((m) => m.role === "assistant")!;
      expect([id, assistant.content.map((c) => c.type)]).toEqual([id, ["text", "tool_use"]]);
    }
  });
});

describe("which routes carry unsigned reasoning", () => {
  it("exactly the five, by their catalog name in any spelling the catalog uses; nothing else", () => {
    for (const id of FIVE) expect([id, carriesUnsignedReasoning(id)]).toEqual([id, true]);
    for (const id of ["moonshotai.kimi-k3", "kimi-k3", "kimi-k3-1", "deepseek-v3-2", "minimax-m2-5", "kimi-k2-thinking"]) expect([id, carriesUnsignedReasoning(id)]).toEqual([id, true]);
    for (const id of ["claude-sonnet-5-5", "us.anthropic.claude-sonnet-5-5", "deepseek.v3-v1:0", "moonshotai.kimi-k2.5", "kimi-k2", "minimax.minimax-m2", "gpt-5.4", "", "kimi-k3-10", "x-kimi-k3"]) expect([id, carriesUnsignedReasoning(id)]).toEqual([id, false]);
  });
  it("the registered model carries the flag only for those, and keeps the shared rules (no threads, no mid-conversation system messages)", async () => {
    const compatOf = async (catalog: string) => {
      const r = route(catalog);
      const runtime = await createConfiguredModelRuntime({ provider: ROUTE_PROVIDER, modelId: r.alias }, { proxy: { baseUrl: "https://gateway.invalid", apiKey: "k", route: r }, fetch: fakeFetch(() => gatewayAnswer(catalog)).fetch });
      return (runtime).getModel(ROUTE_PROVIDER, r.alias)!.compat as Record<string, unknown>;
    };
    expect(await compatOf("us.moonshotai.kimi-k3")).toMatchObject({ allowEmptySignature: true, supportsMessageThreads: false, supportsMidConvoSystemMessages: false });
    expect(await compatOf("claude-sonnet-5-5")).not.toHaveProperty("allowEmptySignature");
  });
});
