// DEC 243c follow-up (ROVARA-AI-REASONING-CARRYOVER): five reasoning models need their earlier reasoning sent back on the next turn of a
// tool loop: DeepSeek V3.2, Kimi K2 Thinking, Kimi K3, Kimi K3.1, MiniMax M2.5. For those ids only, Converse reasoningContent becomes an
// Anthropic `thinking` block in the answer (unsigned when Bedrock sends no signature, as in every real stream so far), and a `thinking`
// block in the history becomes reasoningContent again. Fakes only: the real 256-token streams (tests/fixtures/model-gateway-bedrock/
// converse-256) and hand-built ones for the signature, which no real stream has shown. Four of them are on the built-in list since the
// owner's real two-turn call passed (2026-11-16; the last tests); DeepSeek V3.2 failed it and stays off.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type https from "node:https";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRovaraAiModels, ROVARA_AI_US_CONVERSE_MODELS, type AgentAiSource } from "../../packages/model-gateway/src/agent-ai.js";
import { BEDROCK_CONVERSE_ID, ConverseStreamToSse, fromConverse, REASONING_CARRYOVER_MODEL, toConverse } from "../../packages/model-gateway/src/bedrock-converse.js";
import { EventStreamDecoder, type EventStreamMessage } from "../../packages/model-gateway/src/bedrock-event-stream.js";
import { createBedrockTransport } from "../../packages/model-gateway/src/bedrock-transport.js";
import { call, claims, mint, setup } from "./model-gateway-fixture.js";
import { converseEvent } from "./model-gateway-converse-fixture.js";

const CARRY = ["deepseek.v3.2", "moonshot.kimi-k2-thinking", "minimax.minimax-m2.5", "us.moonshotai.kimi-k3", "us.moonshotai.kimi-k3.1"];
const REASONING = CARRY.filter((id) => id !== "deepseek.v3.2"); // DeepSeek's real stream carries no reasoningContent at all.
const fixture = (id: string) => readFileSync(new URL(`../fixtures/model-gateway-bedrock/converse-256/${id.replace(/[^a-z0-9.-]/giu, "_")}.bin`, import.meta.url));
const decode = (bytes: Buffer): EventStreamMessage[] => { const d = new EventStreamDecoder(); const m = d.push(bytes); d.finish(); return m; };
const payloads = (bytes: Buffer, type: string) => decode(bytes).filter((m) => m.headers[":event-type"] === type).map((m) => JSON.parse(m.payload.toString("utf8")) as Record<string, unknown>);
const realReasoning = (id: string) => payloads(fixture(id), "contentBlockDelta").map((p) => (p.delta as { reasoningContent?: { text?: string } }).reasoningContent?.text ?? "").join("");
const sse = (bytes: Buffer, model: string, carry = true) => { const d = new EventStreamDecoder(); const s = new ConverseStreamToSse(model, "msg_1", false, carry); const out = s.convert(d.push(bytes)); d.finish(); return out.toString("utf8"); };
type Ev = Record<string, unknown> & { type: string; index?: number; delta?: Record<string, string>; content_block?: Record<string, unknown> };
const events = (text: string) => text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n")[1]!.replace(/^data: /u, "")) as Ev);
/** The message an Anthropic client builds from the events (as Pi's Anthropic client does: a signature_delta appends to the block's signature). */
function accumulate(evs: Ev[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const e of evs) {
    if (e.type === "content_block_start") blocks[e.index!] = { ...e.content_block! };
    else if (e.type === "content_block_delta") {
      const b = blocks[e.index!]!; const d = e.delta!;
      if (d.type === "text_delta") b.text = (b.text as string) + d.text;
      else if (d.type === "thinking_delta") b.thinking = (b.thinking as string) + d.thinking;
      else if (d.type === "signature_delta") b.signature = (b.signature as string) + d.signature;
      else if (d.type === "input_json_delta") b.partial = ((b.partial as string | undefined) ?? "") + d.partial_json;
    }
  }
  return blocks.map((b) => { if (b.type !== "tool_use") return b; const { partial, ...rest } = b; return { ...rest, input: JSON.parse((partial as string | undefined) ?? "{}") as unknown }; });
}
const stream = (...parts: Buffer[]) => Buffer.concat([converseEvent("messageStart", { role: "assistant" }), ...parts, converseEvent("messageStop", { stopReason: "tool_use" }), converseEvent("metadata", { usage: { inputTokens: 5, outputTokens: 7 } })]);
const reason = (index: number, delta: Record<string, unknown>) => converseEvent("contentBlockDelta", { contentBlockIndex: index, delta: { reasoningContent: delta } });
const stop = (index: number) => converseEvent("contentBlockStop", { contentBlockIndex: index });
const tools = [{ name: "ping", description: "Ping.", input_schema: { type: "object", properties: {} } }];

describe("which models carry their reasoning", () => {
  it("exactly the five, with or without the US profile prefix; no listed model and no Claude", () => {
    for (const id of CARRY) expect([id, REASONING_CARRYOVER_MODEL.test(id), BEDROCK_CONVERSE_ID.test(id)]).toEqual([id, true, true]);
    for (const id of ["deepseek.v3.2", "moonshot.kimi-k2-thinking", "minimax.minimax-m2.5", "moonshotai.kimi-k3", "moonshotai.kimi-k3.1"]) expect([id, REASONING_CARRYOVER_MODEL.test(`us.${id}`)]).toEqual([id, true]);
    for (const id of ["deepseek.v3-v1:0", "deepseek.v3.20", "deepseek.v3.2-x", "moonshotai.kimi-k2.5", "moonshotai.kimi-k3.10", "moonshotai.kimi-k3x", "minimax.minimax-m2", "minimax.minimax-m2.50", "openai.gpt-oss-120b-1:0", "us.amazon.nova-pro-v1:0", "eu.moonshotai.kimi-k3", "us.anthropic.claude-sonnet-5-5", "x.deepseek.v3.2"]) expect([id, REASONING_CARRYOVER_MODEL.test(id)]).toEqual([id, false]);
  });
});

describe("history to Converse: thinking blocks go back as reasoningContent", () => {
  const turn2 = (thinking: Record<string, unknown>[]) => ({
    tools,
    messages: [
      { role: "user", content: "Call ping." },
      { role: "assistant", content: [...thinking, { type: "tool_use", id: "tooluse_1", name: "ping", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tooluse_1", content: "pong" }] },
    ],
  });
  it("an unsigned block (no signature, or an empty one) goes back with its text exactly and no signature; a signed one with it; order is kept", () => {
    for (const unsigned of [{ type: "thinking", thinking: " Call ping.\n  Then answer. " }, { type: "thinking", thinking: " Call ping.\n  Then answer. ", signature: "" }]) {
      expect(toConverse(turn2([unsigned]), 64, true)?.messages).toEqual([
        { role: "user", content: [{ text: "Call ping." }] },
        { role: "assistant", content: [{ reasoningContent: { reasoningText: { text: " Call ping.\n  Then answer. " } } }, { toolUse: { toolUseId: "tooluse_1", name: "ping", input: {} } }] },
        { role: "user", content: [{ toolResult: { toolUseId: "tooluse_1", content: [{ text: "pong" }], status: "success" } }] },
      ]);
    }
    const signed = toConverse(turn2([{ type: "thinking", thinking: "a", signature: "SIG=" }, { type: "text", text: "mid" }, { type: "thinking", thinking: "b", signature: "SIG2" }]), 64, true)?.messages as Array<{ content: unknown[] }>;
    expect(signed[1]!.content).toEqual([
      { reasoningContent: { reasoningText: { text: "a", signature: "SIG=" } } }, { text: "mid" }, { reasoningContent: { reasoningText: { text: "b", signature: "SIG2" } } }, { toolUse: { toolUseId: "tooluse_1", name: "ping", input: {} } },
    ]);
  });
  it("a block that is blank and unsigned is left out; a message left empty by that is refused as before", () => {
    expect((toConverse(turn2([{ type: "thinking", thinking: "  \n" }, { type: "thinking", thinking: "" }]), 64, true)?.messages as Array<{ content: unknown[] }>)[1]!.content).toEqual([{ toolUse: { toolUseId: "tooluse_1", name: "ping", input: {} } }]);
    expect(toConverse({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "thinking", thinking: "" }] }] }, 8, true)).toBeUndefined();
  });
  it("a whitespace-only assistant text block (MiniMax writes one between its reasoning and the tool call) is left out for these models, and kept for every other", () => {
    const history = (carry: boolean) => (toConverse({ tools, messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "thinking", thinking: "a" }, { type: "text", text: "\n\n\n" }, { type: "tool_use", id: "t", name: "ping", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }] }, 8, carry)?.messages as Array<{ content: Array<Record<string, unknown>> }>)[1]!.content.map((c) => Object.keys(c)[0]);
    expect(history(true)).toEqual(["reasoningContent", "toolUse"]);
    const kept = toConverse({ tools, messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "text", text: "\n" }, { type: "tool_use", id: "t", name: "ping", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }] }, 8)?.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(kept[1]!.content[0]).toEqual({ text: "\n" });
    // Text that is not blank is kept as it is, spaces and all.
    expect((toConverse({ tools, messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "text", text: " x " }, { type: "tool_use", id: "t", name: "ping", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }] }, 8, true)!.messages as Array<{ content: unknown[] }>)[1]!.content[0]).toEqual({ text: " x " });
    // A user's whitespace-only text is the user's: never dropped.
    expect((toConverse({ messages: [{ role: "user", content: [{ type: "text", text: " " }] }] }, 8, true)!.messages as unknown[])).toEqual([{ role: "user", content: [{ text: " " }] }]);
  });
  it("refuses what it cannot send back whole: a blank block with a signature, a non-string text or signature, redacted thinking, thinking from the user", () => {
    for (const bad of [
      [{ type: "thinking", thinking: "", signature: "S" }], [{ type: "thinking", thinking: 5 }], [{ type: "thinking" }], [{ type: "thinking", thinking: "a", signature: 5 }], [{ type: "thinking", thinking: "a", signature: null }],
      [{ type: "redacted_thinking", data: "AAAA" }],
    ]) expect([JSON.stringify(bad), toConverse(turn2(bad), 64, true)]).toEqual([JSON.stringify(bad), undefined]);
    expect(toConverse({ messages: [{ role: "user", content: [{ type: "thinking", thinking: "a" }] }] }, 8, true)).toBeUndefined();
  });
  it("every other model still refuses a thinking block, as before", () => {
    expect(toConverse(turn2([{ type: "thinking", thinking: "a", signature: "S" }]), 64)).toBeUndefined();
    expect(toConverse(turn2([{ type: "thinking", thinking: "a", signature: "S" }]), 64, false)).toBeUndefined();
  });
  it("the thinking request field is still dropped (it shapes Claude's answer only)", () => {
    expect(toConverse({ thinking: { type: "enabled", budget_tokens: 1024 }, messages: [{ role: "user", content: "x" }] }, 8, true)).toEqual({ messages: [{ role: "user", content: [{ text: "x" }] }], inferenceConfig: { maxTokens: 8 } });
  });
});

describe("a whole Converse answer to Anthropic", () => {
  const answer = (content: unknown[]) => ({ output: { message: { role: "assistant", content } }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } });
  it("carried: reasoning becomes a thinking block in place, unsigned with an empty signature, signed with its signature", () => {
    const m = fromConverse(answer([{ reasoningContent: { reasoningText: { text: "why" } } }, { toolUse: { toolUseId: "t1", name: "ping", input: {} } }, { reasoningContent: { reasoningText: { text: "more", signature: "SIG=" } } }]), "m", "i", false, true);
    expect(m.content).toEqual([{ type: "thinking", thinking: "why", signature: "" }, { type: "tool_use", id: "t1", name: "ping", input: {} }, { type: "thinking", thinking: "more", signature: "SIG=" }]);
  });
  it("carried: a reasoning block that cannot be sent back whole throws (redacted, no text, extra fields, wrong types)", () => {
    for (const bad of [{ redactedContent: "AAAA" }, { reasoningText: {} }, { reasoningText: { text: 5 } }, { reasoningText: { text: "a", signature: 5 } }, { reasoningText: { text: "a", extra: 1 } }, { reasoningText: { text: "a" }, redactedContent: "AAAA" }, {}, "x"]) {
      expect(() => fromConverse(answer([{ reasoningContent: bad }]), "m", "i", false, true)).toThrow();
    }
    // Reasoning beside text or a tool call in one element is never dropped quietly.
    expect(() => fromConverse(answer([{ text: "hi", reasoningContent: { reasoningText: { text: "why" } } }]), "m", "i", false, true)).toThrow();
    expect(() => fromConverse(answer([{ toolUse: { toolUseId: "t", name: "ping", input: {} }, reasoningContent: { reasoningText: { text: "why" } } }]), "m", "i", false, true)).toThrow();
  });
  it("not carried: reasoning is dropped, as before", () => {
    expect(fromConverse(answer([{ reasoningContent: { reasoningText: { text: "why" } } }, { text: "hi" }]), "m", "i").content).toEqual([{ type: "text", text: "hi" }]);
    expect(fromConverse(answer([{ reasoningContent: { redactedContent: "AAAA" } }, { text: "hi" }]), "m", "i", false, false).content).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("the real 256-token streams to Anthropic SSE, carried", () => {
  for (const id of REASONING) {
    it(`${id}: one thinking block with the reasoning, exactly and unsigned, then the tool call; indexes from 0; each block stopped once`, () => {
      const evs = events(sse(fixture(id), id));
      const starts = evs.filter((e) => e.type === "content_block_start");
      expect(starts.map((e) => e.index)).toEqual(starts.map((_, i) => i));
      expect(evs.filter((e) => e.type === "content_block_stop").map((e) => e.index)).toEqual(starts.map((e) => e.index));
      const thinking = starts.filter((e) => e.content_block!.type === "thinking");
      expect(thinking).toHaveLength(1);
      expect(thinking[0]!.content_block).toEqual({ type: "thinking", thinking: "", signature: "" });
      const blocks = accumulate(evs);
      expect(blocks.find((b) => b.type === "thinking")).toEqual({ type: "thinking", thinking: realReasoning(id), signature: "" });
      expect(realReasoning(id).length).toBeGreaterThan(40);
      expect(evs.some((e) => e.type === "content_block_delta" && e.delta!.type === "signature_delta")).toBe(false);
      expect(blocks.filter((b) => b.type === "tool_use")).toEqual([expect.objectContaining({ name: "ping", input: {} })]);
      expect(evs.find((e) => e.type === "message_delta")).toMatchObject({ delta: { stop_reason: "tool_use" } });
    });
    it(`${id}: the next turn sends that reasoning back exactly, before the tool call, with the model's own tool id`, () => {
      const blocks = accumulate(events(sse(fixture(id), id)));
      const tool = blocks.find((b) => b.type === "tool_use") as { id: string };
      const next = toConverse({ tools, messages: [{ role: "user", content: "Call the ping tool." }, { role: "assistant", content: blocks }, { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "pong" }] }] }, 256, true);
      const assistant = (next!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>)[1]!;
      expect(assistant.content.map((c) => Object.keys(c)[0])).toEqual(["reasoningContent", "toolUse"]);
      expect(assistant.content[0]).toEqual({ reasoningContent: { reasoningText: { text: realReasoning(id) } } });
      expect(assistant.content[1]).toEqual({ toolUse: { toolUseId: tool.id, name: "ping", input: {} } });
      expect(blocks.some((b) => b.type === "text" && (b.text as string).trim() !== "")).toBe(false);
    });
    it(`${id}: without the carry flag the reasoning is dropped, as for every other model`, () => {
      const evs = events(sse(fixture(id), id, false));
      expect(evs.some((e) => e.content_block?.type === "thinking")).toBe(false);
      expect(JSON.stringify(evs)).not.toContain(realReasoning(id).slice(0, 30));
    });
  }
  it("deepseek.v3.2: its real stream has no reasoningContent, so no thinking block comes out (its raw tool-call markup in the text is untouched here)", () => {
    expect(realReasoning("deepseek.v3.2")).toBe("");
    const evs = events(sse(fixture("deepseek.v3.2"), "deepseek.v3.2"));
    expect(evs.some((e) => e.content_block?.type === "thinking")).toBe(false);
    expect(accumulate(evs).find((b) => b.type === "tool_use")).toMatchObject({ name: "ping" });
  });
});

describe("streamed reasoning: signature, and what is refused", () => {
  it("a signature arrives as a signature_delta after the text, and the accumulated block carries both back", () => {
    const evs = events(sse(stream(reason(0, { text: "a" }), reason(0, { text: "b" }), reason(0, { signature: "SIG" }), stop(0)), "deepseek.v3.2"));
    expect(evs.map((e) => e.type === "content_block_delta" ? e.delta!.type : e.type)).toEqual(["message_start", "content_block_start", "thinking_delta", "thinking_delta", "signature_delta", "content_block_stop", "message_delta", "message_stop"]);
    const blocks = accumulate(evs);
    expect(blocks).toEqual([{ type: "thinking", thinking: "ab", signature: "SIG" }]);
    expect(toConverse({ tools, messages: [{ role: "user", content: "x" }, { role: "assistant", content: [...blocks, { type: "tool_use", id: "t", name: "ping", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }] }, 8, true)!.messages).toMatchObject([{}, { content: [{ reasoningContent: { reasoningText: { text: "ab", signature: "SIG" } } }, {}] }, {}]);
  });
  it("text and signature in one delta, and an empty first delta, are one block", () => {
    const blocks = accumulate(events(sse(stream(reason(1, { text: "" }), reason(1, { text: "a", signature: "S" }), stop(1)), "deepseek.v3.2")));
    expect(blocks).toEqual([{ type: "thinking", thinking: "a", signature: "S" }]);
  });
  it("an empty signature delta is no signature: text may still follow, and the block stays unsigned", () => {
    expect(accumulate(events(sse(stream(reason(0, { text: "a" }), reason(0, { signature: "" }), reason(0, { text: "b" }), stop(0)), "deepseek.v3.2")))).toEqual([{ type: "thinking", thinking: "ab", signature: "" }]);
  });
  it("two reasoning blocks keep their own indexes and signatures, renumbered from 0 with the blocks between", () => {
    const evs = events(sse(stream(reason(0, { text: "a" }), stop(0), converseEvent("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "mid" } }), stop(1), reason(2, { text: "b" }), reason(2, { signature: "S2" }), stop(2)), "deepseek.v3.2"));
    expect(accumulate(evs)).toEqual([{ type: "thinking", thinking: "a", signature: "" }, { type: "text", text: "mid" }, { type: "thinking", thinking: "b", signature: "S2" }]);
  });
  it("fails the stream (never a partial block) on: redacted content, an unknown field, a wrong type, text after the signature, a second signature, reasoning into a text or tool block, text or tool input into a reasoning block", () => {
    const bad: Array<[string, Buffer]> = [
      ["redacted", stream(reason(0, { redactedContent: "AAAA" }), stop(0))],
      ["unknown field", stream(reason(0, { text: "a", other: 1 }), stop(0))],
      ["text type", stream(reason(0, { text: 5 }), stop(0))],
      ["signature type", stream(reason(0, { signature: 5 }), stop(0))],
      ["not an object", stream(converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: "x" } }), stop(0))],
      ["text after signature", stream(reason(0, { text: "a" }), reason(0, { signature: "S" }), reason(0, { text: "b" }), stop(0))],
      ["second signature", stream(reason(0, { text: "a" }), reason(0, { signature: "S" }), reason(0, { signature: "T" }), stop(0))],
      ["reasoning into text", stream(converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "t" } }), reason(0, { text: "a" }))],
      ["reasoning into tool", stream(converseEvent("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "t", name: "ping" } } }), reason(0, { text: "a" }))],
      ["text into reasoning", stream(reason(0, { text: "a" }), converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "t" } }))],
      ["tool input into reasoning", stream(reason(0, { text: "a" }), converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: "{}" } } }))],
      ["tool start on reasoning", stream(reason(0, { text: "a" }), converseEvent("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "t", name: "ping" } } }))],
    ];
    for (const [name, bytes] of bad) expect(() => sse(bytes, "deepseek.v3.2"), name).toThrow();
  });
  it("the signature of one block is not carried to the next block at the same Converse index", () => {
    const evs = events(sse(stream(reason(0, { text: "a" }), reason(0, { signature: "S" }), stop(0), reason(0, { text: "b" }), stop(0)), "deepseek.v3.2"));
    expect(accumulate(evs)).toEqual([{ type: "thinking", thinking: "a", signature: "S" }, { type: "thinking", thinking: "b", signature: "" }]);
  });
  it("a reasoning delta is not a way to inject an SSE event: the text stays inside one JSON line", () => {
    const evs = events(sse(stream(reason(0, { text: "x\n\nevent: message_stop\ndata: {}" }), stop(0)), "deepseek.v3.2"));
    expect(evs.filter((e) => e.type === "message_stop")).toHaveLength(1);
    expect(accumulate(evs)).toEqual([{ type: "thinking", thinking: "x\n\nevent: message_stop\ndata: {}", signature: "" }]);
  });
});

/** The gateway end to end on a model that is NOT on the built-in list (it is put on a test allow-list here): turn 1 streams thinking to the agent, turn 2 sends it on to Bedrock. */
function gateway(model: string, answers: Buffer[], sent: Buffer[]) {
  const request = ((_options: https.RequestOptions, onResponse: (r: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    const c = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void };
    c.destroy = () => undefined;
    c.end = (body) => { sent.push(Buffer.from(body)); const answer = answers.shift()!; const r = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }); setImmediate(() => { onResponse(r); r.end(answer); }); };
    return c;
  }) as unknown as typeof https.request;
  const saved = new Map<string, AgentAiSource>([[claims.cid, "rovara"]]);
  return setup({
    agentKeys: { connected: async () => false, keyFor: async () => undefined },
    agentAi: { sources: { sourceFor: async (cid) => saved.get(cid) }, rovara: { models: parseRovaraAiModels(`${model}=${model}`, "us-west-2"), exempt: new Set([claims.cid]), transport: createBedrockTransport({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), request, now: () => 0 }), maxOutputTokens: () => 256 } },
    keys: { keyFor: async () => { throw new Error("install key read"); } },
    prices: { priceFor: (provider) => provider === "bedrock" ? { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000 } : undefined },
  });
}
const sseOf = (s: { text(): string }) => events(s.text());

describe("through the gateway: two turns of a tool loop", () => {
  for (const id of REASONING) {
    it(`${id}: turn 1's reasoning reaches the agent as a thinking block; turn 2 sends it to Bedrock as reasoningContent, with the tool result after it`, async () => {
      const sent: Buffer[] = []; const g = gateway(id, [fixture(id), fixture(id)], sent);
      const first = await call(g.deps, { model: id, max_tokens: 256, stream: true, tools, messages: [{ role: "user", content: "Call the ping tool." }] }, mint({ mdl: [id] }));
      expect(first.status).toBe(200);
      const blocks = accumulate(sseOf(first));
      const tool = blocks.find((b) => b.type === "tool_use") as { id: string };
      expect(blocks.find((b) => b.type === "thinking")).toEqual({ type: "thinking", thinking: realReasoning(id), signature: "" });
      const second = await call(g.deps, { model: id, max_tokens: 256, stream: true, tools, messages: [{ role: "user", content: "Call the ping tool." }, { role: "assistant", content: blocks }, { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "pong" }] }] }, mint({ mdl: [id] }));
      expect(second.status).toBe(200);
      expect(sent).toHaveLength(2);
      const body = JSON.parse(sent[1]!.toString("utf8")) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
      const assistant = body.messages.find((m) => m.role === "assistant")!;
      expect(assistant.content.map((c) => Object.keys(c)[0])).toEqual(["reasoningContent", "toolUse"]);
      expect(assistant.content[0]).toEqual({ reasoningContent: { reasoningText: { text: realReasoning(id) } } });
      expect(body.messages.at(-1)).toEqual({ role: "user", content: [{ toolResult: { toolUseId: tool.id, content: [{ text: "pong" }], status: "success" } }] });
    });
  }
  it("a model that does not carry its reasoning (gpt-oss) still refuses a thinking block in the history, free, and sends nothing", async () => {
    const id = "openai.gpt-oss-120b-1:0"; const sent: Buffer[] = []; const g = gateway(id, [fixture(id)], sent);
    const sink = await call(g.deps, { model: id, max_tokens: 256, stream: true, tools, messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "thinking", thinking: "a", signature: "" }, { type: "tool_use", id: "t", name: "ping", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }] }, mint({ mdl: [id] }));
    expect(sink.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
  it("a carried model refuses redacted thinking in the history, free, and sends nothing", async () => {
    const id = "us.moonshotai.kimi-k3"; const sent: Buffer[] = []; const g = gateway(id, [fixture(id)], sent);
    const sink = await call(g.deps, { model: id, max_tokens: 256, stream: true, tools, messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "redacted_thinking", data: "AAAA" }, { type: "tool_use", id: "t", name: "ping", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }] }, mint({ mdl: [id] }));
    expect(sink.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
  it("a whole (non-streamed) answer carries the reasoning too", async () => {
    const id = "moonshot.kimi-k2-thinking"; const sent: Buffer[] = [];
    const whole = Buffer.from(JSON.stringify({ output: { message: { role: "assistant", content: [{ reasoningContent: { reasoningText: { text: "why" } } }, { toolUse: { toolUseId: "tooluse_1", name: "ping", input: {} } }] } }, stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 7 } }));
    const g = gateway(id, [whole], sent);
    const sink = await call(g.deps, { model: id, max_tokens: 256, tools, messages: [{ role: "user", content: "x" }] }, mint({ mdl: [id] }));
    expect(sink.status).toBe(200);
    expect((JSON.parse(sink.text()) as { content: unknown[] }).content).toEqual([{ type: "thinking", thinking: "why", signature: "" }, { type: "tool_use", id: "tooluse_1", name: "ping", input: {} }]);
  });
});

describe("what is listed", () => {
  it("the four that passed the owner's real two-turn call (2026-11-16) are on the built-in list; DeepSeek V3.2, whose turn 1 made no tool call, is not", () => {
    const listed = [...parseRovaraAiModels(ROVARA_AI_US_CONVERSE_MODELS, "us-west-2").keys()];
    for (const id of REASONING) expect(listed).toContain(id);
    expect(listed).not.toContain("deepseek.v3.2");
  });
});

/** The owner's real two-turn answers (tests/fixtures/model-gateway-bedrock/two-turn-real: the Anthropic blocks the gateway gave the agent). */
const real = (id: string, turn: 1 | 2) => JSON.parse(readFileSync(new URL(`../fixtures/model-gateway-bedrock/two-turn-real/${id}.turn${turn}.json`, import.meta.url), "utf8")) as { status: number; stop: string; complete: boolean; usage: { input: number; output: number }; blocks: Array<Record<string, unknown>> };
describe("the owner's real two-turn answers", () => {
  for (const id of REASONING) {
    it(`${id}: turn 1 was a tool call with a thinking block; the next turn sends that reasoning back, exactly, and turn 2 ended normally`, () => {
      const one = real(id, 1); const two = real(id, 2);
      expect([one.status, one.stop, one.complete, two.status, two.stop, two.complete]).toEqual([200, "tool_use", true, 200, "end_turn", true]);
      expect(one.usage.output).toBeGreaterThan(0); expect(two.usage.output).toBeGreaterThan(0);
      const thinking = one.blocks.filter((b) => b.type === "thinking") as Array<{ thinking: string; signature: string }>;
      const tool = one.blocks.find((b) => b.type === "tool_use") as { id: string; name: string };
      expect([thinking.length, tool.name]).toEqual([1, "ping"]);
      expect(thinking[0]!.thinking.trim()).not.toBe("");
      const next = toConverse({ tools, messages: [{ role: "user", content: "Call the ping tool." }, { role: "assistant", content: one.blocks }, { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "pong" }] }] }, 256, true);
      const assistant = (next!.messages as Array<{ content: Array<Record<string, unknown>> }>)[1]!.content;
      expect(assistant[0]).toEqual({ reasoningContent: { reasoningText: { text: thinking[0]!.thinking } } });
      expect(assistant.filter((c) => "toolUse" in c)).toEqual([{ toolUse: { toolUseId: tool.id, name: "ping", input: {} } }]);
      // Blank text between the blocks (MiniMax's "\n\n\n") is not sent back.
      expect(assistant.filter((c) => "text" in c && String(c.text).trim() === "")).toEqual([]);
    });
  }
  it("deepseek.v3.2 (not listed): turn 1 ended end_turn with no tool call and no thinking", () => {
    const one = real("deepseek.v3.2", 1);
    expect([one.status, one.stop]).toEqual([200, "end_turn"]);
    expect(one.blocks.map((b) => b.type)).toEqual(["text"]);
  });
});
