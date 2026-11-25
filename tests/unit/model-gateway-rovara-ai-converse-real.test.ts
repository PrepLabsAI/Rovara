// DEC 243c: the ten other Bedrock coding models in Rovara's AI's built-in list, replayed from their REAL ConverseStream answers.
// Each fixture is the raw body of one tiny real call (staging us-west-2, 2026-11-15, run by the owner): one tool "ping", maxTokens
// 16, "Call the ping tool."; every one answered with a tool call and stop tool_use. Replayed through the gateway's agent route and
// the real Bedrock transport (only https is faked), each must give the agent an Anthropic tool_use block with the model's own id
// (Kimi K2.5's is "functions.ping:0"), stop tool_use, and settle from Bedrock's own token counts as the company's billable line.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type https from "node:https";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRovaraAiModels, ROVARA_AI_US_CONVERSE_MODELS, type AgentAiSource } from "../../packages/model-gateway/src/agent-ai.js";
import { EventStreamDecoder } from "../../packages/model-gateway/src/bedrock-event-stream.js";
import { createBedrockTransport } from "../../packages/model-gateway/src/bedrock-transport.js";
import { normalizeBedrockModel } from "../../packages/model-gateway/src/price-identity.js";
import { call, claims, mint, setup } from "./model-gateway-fixture.js";

const cidA = claims.cid; const cidB = `org_${"b".repeat(20)}`;
const fixture = (id: string) => readFileSync(new URL(`../fixtures/model-gateway-bedrock/converse/${id.replace(/[^a-z0-9.-]/giu, "_")}.bin`, import.meta.url));
// The ten that passed with maxTokens 16 (converse/); the reasoning-first ones are replayed in model-gateway-converse-256.test.ts.
const ids = [...parseRovaraAiModels(ROVARA_AI_US_CONVERSE_MODELS, "us-west-2").keys()].slice(0, 10);
/** What Bedrock reported in each real answer: its tool call id and its token counts (read from the fixture itself). */
function reported(bytes: Buffer): { toolUseId: string; input: number; output: number } {
  const d = new EventStreamDecoder(); const messages = d.push(bytes); d.finish();
  const payload = (type: string) => JSON.parse(messages.find((m) => m.headers[":event-type"] === type)!.payload.toString("utf8")) as Record<string, unknown>;
  const start = payload("contentBlockStart") as { start: { toolUse: { toolUseId: string } } };
  const usage = (payload("metadata") as { usage: { inputTokens: number; outputTokens: number } }).usage;
  return { toolUseId: start.start.toolUse.toolUseId, input: usage.inputTokens, output: usage.outputTokens };
}
function gateway(id: string, answers: Buffer[]) {
  const sent: string[] = [];
  const request = ((options: https.RequestOptions, onResponse: (r: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    const c = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void };
    c.destroy = () => undefined;
    c.end = () => { sent.push(String(options.path)); const r = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }); const a = answers.shift()!; setImmediate(() => { onResponse(r); r.end(a); }); };
    return c;
  }) as unknown as typeof https.request;
  const saved = new Map<string, AgentAiSource>([[cidA, "rovara"], [cidB, "rovara"]]);
  const g = setup({
    agentKeys: { connected: async () => false, keyFor: async () => undefined },
    agentAi: { sources: { sourceFor: async (cid) => saved.get(cid) }, rovara: { models: parseRovaraAiModels(ROVARA_AI_US_CONVERSE_MODELS, "us-west-2"), exempt: new Set([cidA, cidB]), transport: createBedrockTransport({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), request, now: () => 0 }), maxOutputTokens: () => 16 } },
    keys: { keyFor: async () => { throw new Error("install key read"); } },
    prices: { priceFor: (provider) => provider === "bedrock" ? { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000 } : undefined },
  });
  return { ...g, sent, id };
}
const sseEvents = (text: string) => text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n")[1]!.replace(/^data: /u, "")) as Record<string, unknown>);

describe("the built-in list (DEC 243c)", () => {
  it("is exactly the ten models that passed, each named by the id called, each meeting its price snapshot row", () => {
    expect(ids).toEqual(["qwen.qwen3-coder-480b-a35b-v1:0", "qwen.qwen3-coder-30b-a3b-v1:0", "qwen.qwen3-235b-a22b-2507-v1:0", "mistral.devstral-2-123b", "mistral.mistral-large-3-675b-instruct", "deepseek.v3-v1:0", "moonshotai.kimi-k2.5", "zai.glm-5", "zai.glm-4.7", "us.amazon.nova-2-lite-v1:0"]);
    // The names the price index looks each id up by; LiteLLM's Bedrock rows (bedrock / bedrock_converse) fold to the same names
    // (2026-11-15: every one has an input, output and max-output row there).
    expect(ids.map(normalizeBedrockModel)).toEqual(["qwen3-coder-480b-a35b", "qwen3-coder-30b-a3b", "qwen3-235b-a22b-2507", "devstral-2-123b", "mistral-large-3-675b-instruct", "deepseek-v3-1", "kimi-k2-5", "glm-5", "glm-4-7", "nova-2-lite"]);
  });
});

describe("real ConverseStream answers through the agent route", () => {
  for (const id of ids) {
    it(`${id}: the agent gets the tool call with the model's own id, stop tool_use, settled from Bedrock's counts for the caller only`, async () => {
      const bytes = fixture(id); const real = reported(bytes);
      const g = gateway(id, [bytes]);
      const sink = await call(g.deps, { model: id, max_tokens: 64, stream: true, tools: [{ name: "ping", description: "Ping.", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "Call the ping tool." }] }, mint({ mdl: [id] }));
      expect(sink.status).toBe(200);
      expect(g.sent).toEqual([`/model/${encodeURIComponent(id)}/converse-stream`]);
      const events = sseEvents(sink.text());
      expect(events[0]!.type).toBe("message_start");
      expect(events.at(-1)!.type).toBe("message_stop");
      const tool = events.find((e) => e.type === "content_block_start" && (e.content_block as { type: string }).type === "tool_use")!;
      expect(tool.content_block).toEqual({ type: "tool_use", id: real.toolUseId, name: "ping", input: {} });
      // Indexes are 0.. in order, every started block is stopped once.
      const starts = events.filter((e) => e.type === "content_block_start").map((e) => e.index);
      expect(starts).toEqual(starts.map((_, i) => i));
      expect(events.filter((e) => e.type === "content_block_stop").map((e) => e.index)).toEqual(starts);
      expect(events.find((e) => e.type === "message_delta")).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: real.input, output_tokens: real.output } });
      // $1 / $4 a million: Bedrock's own counts, as one line for the company that called; none for the other.
      expect(g.meter.billedCalls(claims.iss, cidA).map((l) => [l.line.model, l.settledMicros, l.estimated])).toEqual([[id, real.input + 4 * real.output, false]]);
      expect(g.meter.billedCalls(claims.iss, cidB)).toEqual([]);
    });
  }
});
