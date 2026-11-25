// Amazon Nova Pro writes its reasoning as plain text: "<thinking>...</thinking>" first, then the answer. For that model only, the
// gateway leaves out exactly that leading, well-formed block; anything else passes unchanged (DEC 243c).
import { describe, expect, it } from "vitest";
import { ConverseStreamToSse, fromConverse, LEADING_THINKING_MAX_CHARS, LEADING_THINKING_TEXT_MODEL, withoutLeadingThinking } from "../../packages/model-gateway/src/bedrock-converse.js";
import { EventStreamDecoder } from "../../packages/model-gateway/src/bedrock-event-stream.js";
import { converseEvent } from "./model-gateway-converse-fixture.js";

const NOVA = "us.amazon.nova-pro-v1:0";
const stream = (texts: string[], tool = true) => Buffer.concat([
  converseEvent("messageStart", { role: "assistant" }),
  ...texts.map((t) => converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: t } })),
  converseEvent("contentBlockStop", { contentBlockIndex: 0 }),
  ...(tool ? [converseEvent("contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tooluse_x", name: "ping" } } }), converseEvent("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: "{}" } } }), converseEvent("contentBlockStop", { contentBlockIndex: 1 })] : []),
  converseEvent("messageStop", { stopReason: tool ? "tool_use" : "end_turn" }), converseEvent("metadata", { usage: { inputTokens: 1, outputTokens: 1 } }),
]);
function agentSees(bytes: Buffer, model = NOVA) {
  const d = new EventStreamDecoder(); const s = new ConverseStreamToSse(model, "msg_1", LEADING_THINKING_TEXT_MODEL.test(model));
  const events = s.convert(d.push(bytes)).toString("utf8").split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n")[1]!.replace(/^data: /u, "")) as Record<string, unknown>);
  d.finish();
  const text = events.filter((e) => e.type === "content_block_delta" && (e.delta as { type: string }).type === "text_delta").map((e) => (e.delta as { text: string }).text).join("");
  const starts = events.filter((e) => e.type === "content_block_start").map((e) => e.index);
  expect(events.filter((e) => e.type === "content_block_stop").map((e) => e.index)).toEqual(starts);
  expect(starts).toEqual(starts.map((_, i) => i));
  return { text, blocks: events.filter((e) => e.type === "content_block_start").map((e) => (e.content_block as { type: string }).type) };
}

describe("Nova Pro's leading thinking block", () => {
  it("is left out when it is well formed, however the deltas split it; the rest is kept exactly", () => {
    expect(agentSees(stream(["<thinking> plan </thinking>\nDone."]))).toEqual({ text: "\nDone.", blocks: ["text", "tool_use"] });
    expect(agentSees(stream(["<thi", "nking>", " plan </th", "inking>", "Done", "."]))).toEqual({ text: "Done.", blocks: ["text", "tool_use"] });
    // Only thinking: no text block at all, the tool call stays at index 0.
    expect(agentSees(stream(["<thinking>", " x ", "</thinking>"]))).toEqual({ text: "", blocks: ["tool_use"] });
    // Only the first closing tag ends it; a second block in the answer is the answer's.
    expect(agentSees(stream(["<thinking>a</thinking>b<thinking>c</thinking>"])).text).toBe("b<thinking>c</thinking>");
  });
  it("anything else passes unchanged: not at the very start, never closed, a lookalike tag, too long, or another model", () => {
    for (const t of [[" <thinking>a</thinking>b"], ["Hi <thinking>a</thinking>"], ["<thinking>never closed"], ["<thinkingX>a</thinking>"], ["<think>a</think>b"], ["", "<thinking>a</thinking>b"]]) {
      const joined = t.join("");
      const out = agentSees(stream(t)).text;
      expect([joined, out]).toEqual([joined, joined === "<thinking>a</thinking>b" ? "b" : joined]);
    }
    const long = `<thinking>${"x".repeat(LEADING_THINKING_MAX_CHARS)}</thinking>ok`;
    expect(agentSees(stream([long.slice(0, 40_000), long.slice(40_000)])).text).toBe(long);
    expect(agentSees(stream(["<thinking>a</thinking>b"]), "qwen.qwen3-coder-480b-a35b-v1:0").text).toBe("<thinking>a</thinking>b");
    expect(agentSees(stream(["<thinking>a</thinking>b"]), "amazon.nova-2-lite-v1:0").text).toBe("<thinking>a</thinking>b");
  });
  it("a whole (non-streaming) answer: the same rule on its first text block only", () => {
    const answer = (texts: string[]) => ({ output: { message: { content: texts.map((t) => ({ text: t })) } }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } });
    expect(fromConverse(answer(["<thinking>a</thinking>Hi"]), NOVA, "m", true).content).toEqual([{ type: "text", text: "Hi" }]);
    expect(fromConverse(answer(["<thinking>a</thinking>", "<thinking>b</thinking>keep"]), NOVA, "m", true).content).toEqual([{ type: "text", text: "<thinking>b</thinking>keep" }]);
    expect(fromConverse(answer(["<thinking>open"]), NOVA, "m", true).content).toEqual([{ type: "text", text: "<thinking>open" }]);
    expect(fromConverse(answer(["<thinking>a</thinking>Hi"]), NOVA, "m", false).content).toEqual([{ type: "text", text: "<thinking>a</thinking>Hi" }]);
    expect(withoutLeadingThinking("<thinking></thinking>")).toBe("");
    for (const unchanged of [" <thinking>a</thinking>b", "Hi <thinking>a</thinking>", "<thinkingX>a</thinking>", "<thinking>open"]) {
      expect(withoutLeadingThinking(unchanged)).toBe(unchanged);
      expect(fromConverse(answer([unchanged]), NOVA, "m", true).content).toEqual([{ type: "text", text: unchanged }]);
    }
  });
});
