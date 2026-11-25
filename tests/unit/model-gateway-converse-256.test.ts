// DEC 243c: the eight reasoning-first Bedrock models, from their REAL ConverseStream answers to one tool, maxTokens 256 (staging
// us-west-2, 2026-11-15, run by the owner): all eight ended with a tool call. Three are listed: gpt-oss 120B / 20B (their reasoning
// is dropped; OpenAI only recommends passing it back after tool calls) and Nova Pro (its leading "<thinking>...</thinking>" text is
// left out). The other five carry their reasoning back (model-gateway-converse-reasoning.test.ts); four of them were listed after the real two-turn call (2026-11-16), and DeepSeek V3.2 is not, which this file pins.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type https from "node:https";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRovaraAiModels, ROVARA_AI_US_CONVERSE_MODELS, type AgentAiSource } from "../../packages/model-gateway/src/agent-ai.js";
import { EventStreamDecoder, type EventStreamMessage } from "../../packages/model-gateway/src/bedrock-event-stream.js";
import { createBedrockTransport } from "../../packages/model-gateway/src/bedrock-transport.js";
import { call, claims, mint, setup } from "./model-gateway-fixture.js";

const cidA = claims.cid; const cidB = `org_${"b".repeat(20)}`;
const fixture = (id: string) => readFileSync(new URL(`../fixtures/model-gateway-bedrock/converse-256/${id.replace(/[^a-z0-9.-]/giu, "_")}.bin`, import.meta.url));
const decode = (bytes: Buffer): EventStreamMessage[] => { const d = new EventStreamDecoder(); const m = d.push(bytes); d.finish(); return m; };
const payloads = (bytes: Buffer, type: string) => decode(bytes).filter((m) => m.headers[":event-type"] === type).map((m) => JSON.parse(m.payload.toString("utf8")) as Record<string, unknown>);
const LISTED = ["openai.gpt-oss-120b-1:0", "openai.gpt-oss-20b-1:0", "us.amazon.nova-pro-v1:0"];
const NOT_LISTED = ["deepseek.v3.2"]; // the other four reasoning models were listed after the real two-turn call (model-gateway-converse-reasoning.test.ts)

function gateway(answer: Buffer) {
  const request = ((_options: https.RequestOptions, onResponse: (r: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    const c = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void };
    c.destroy = () => undefined;
    c.end = () => { const r = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }); setImmediate(() => { onResponse(r); r.end(answer); }); };
    return c;
  }) as unknown as typeof https.request;
  const saved = new Map<string, AgentAiSource>([[cidA, "rovara"]]);
  return setup({
    agentKeys: { connected: async () => false, keyFor: async () => undefined },
    agentAi: { sources: { sourceFor: async (cid) => saved.get(cid) }, rovara: { models: parseRovaraAiModels(ROVARA_AI_US_CONVERSE_MODELS, "us-west-2"), exempt: new Set([cidA, cidB]), transport: createBedrockTransport({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), request, now: () => 0 }), maxOutputTokens: () => 256 } },
    keys: { keyFor: async () => { throw new Error("install key read"); } },
    prices: { priceFor: (provider) => provider === "bedrock" ? { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000 } : undefined },
  });
}
const sseEvents = (text: string) => text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n")[1]!.replace(/^data: /u, "")) as Record<string, unknown>);

describe("the listed reasoning-first models, replayed", () => {
  it("are on the built-in list; DeepSeek V3.2 is not", () => {
    const listed = [...parseRovaraAiModels(ROVARA_AI_US_CONVERSE_MODELS, "us-west-2").keys()];
    for (const id of LISTED) expect(listed).toContain(id);
    for (const id of NOT_LISTED) expect(listed).not.toContain(id);
  });
  for (const id of LISTED) {
    it(`${id}: the agent gets the tool call and no reasoning text, stop tool_use, settled from Bedrock's counts`, async () => {
      const bytes = fixture(id);
      const tool = (payloads(bytes, "contentBlockStart")[0]!.start as { toolUse: { toolUseId: string } }).toolUse;
      const usage = (payloads(bytes, "metadata")[0]!.usage as { inputTokens: number; outputTokens: number });
      const reasoning = payloads(bytes, "contentBlockDelta").map((p) => (p.delta as { reasoningContent?: { text?: string } }).reasoningContent?.text ?? "").join("");
      const g = gateway(bytes);
      const sink = await call(g.deps, { model: id, max_tokens: 256, stream: true, tools: [{ name: "ping", description: "Ping.", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "Call the ping tool." }] }, mint({ mdl: [id] }));
      expect(sink.status).toBe(200);
      const events = sseEvents(sink.text());
      expect(events.find((e) => e.type === "content_block_start" && (e.content_block as { type: string }).type === "tool_use")!.content_block).toEqual({ type: "tool_use", id: tool.toolUseId, name: "ping", input: {} });
      const text = events.filter((e) => e.type === "content_block_delta" && (e.delta as { type: string }).type === "text_delta").map((e) => (e.delta as { text: string }).text).join("");
      expect(text).not.toContain("<thinking");
      expect(text).not.toContain("</thinking>");
      if (reasoning.length > 0) expect(sink.text()).not.toContain(JSON.stringify(reasoning).slice(1, 40));
      const starts = events.filter((e) => e.type === "content_block_start").map((e) => e.index);
      expect(starts).toEqual(starts.map((_, i) => i));
      expect(events.filter((e) => e.type === "content_block_stop").map((e) => e.index)).toEqual(starts);
      expect(events.find((e) => e.type === "message_delta")).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } });
      expect(g.meter.billedCalls(claims.iss, cidA).map((l) => [l.line.model, l.settledMicros])).toEqual([[id, usage.inputTokens + 4 * usage.outputTokens]]);
      expect(g.meter.billedCalls(claims.iss, cidB)).toEqual([]);
    });
  }
  it("Nova Pro's real answer starts with the thinking block the gateway leaves out", () => {
    const text = payloads(fixture("us.amazon.nova-pro-v1:0"), "contentBlockDelta").map((p) => (p.delta as { text?: string }).text ?? "").join("");
    expect(text.startsWith("<thinking>")).toBe(true);
    expect(text).toContain("</thinking>");
  });
});

describe("why DeepSeek V3.2 is not listed (from its real answers)", () => {
  it("DeepSeek V3.2 writes raw tool-call markup into its text beside the real tool call", () => {
    const text = payloads(fixture("deepseek.v3.2"), "contentBlockDelta").map((p) => (p.delta as { text?: string }).text ?? "").join("");
    expect(text).toContain("DSML");
  });
  it("Kimi K2 Thinking / K3 / K3.1 and MiniMax M2.5 reason in reasoningContent blocks, which their providers require (K3 family) or do not document as optional for tool loops", () => {
    for (const id of ["moonshot.kimi-k2-thinking", "minimax.minimax-m2.5", "us.moonshotai.kimi-k3", "us.moonshotai.kimi-k3.1"]) {
      const kinds = payloads(fixture(id), "contentBlockDelta").map((p) => Object.keys(p.delta as object)[0]);
      expect([id, kinds.includes("reasoningContent")]).toEqual([id, true]);
    }
  });
});
