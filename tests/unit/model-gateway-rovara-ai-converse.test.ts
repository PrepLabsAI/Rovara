// DEC 243c: Rovara's AI on non-Claude Bedrock models. An agent loop on fakes: the agent route (Anthropic Messages, streaming)
// through the real Bedrock transport (only https is faked) to ConverseStream and back, one tool call round trip per model:
// turn 1 asks, the model calls a tool; turn 2 sends the tool result, the model answers. Each turn settles from the reported
// usage as one billable line for the company that made it. Two companies never meet.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type https from "node:https";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentAiSource, AgentAiSourceReader } from "../../packages/model-gateway/src/agent-ai.js";
import { parseRovaraAiModels } from "../../packages/model-gateway/src/agent-ai.js";
import { createBedrockTransport } from "../../packages/model-gateway/src/bedrock-transport.js";
import type { LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { ROVARA_AI_FEATURE } from "../../packages/model-gateway/src/server.js";
import { call, claims, mint, setup } from "./model-gateway-fixture.js";
import { converseEvent, frame, toolCallStream } from "./model-gateway-converse-fixture.js";

const cidA = claims.cid; const cidB = `org_${"b".repeat(20)}`;
/** The candidate non-Claude coding models (staging us-west-2, 2026-11-15): engine name = Bedrock model id; id = what is called. */
const MODELS: ReadonlyArray<readonly [string, string]> = [
  ["openai.gpt-oss-120b-1:0", "openai.gpt-oss-120b-1:0"], ["qwen.qwen3-coder-480b-a35b-v1:0", "qwen.qwen3-coder-480b-a35b-v1:0"],
  ["mistral.devstral-2-123b", "mistral.devstral-2-123b"], ["deepseek.v3.2", "deepseek.v3.2"], ["moonshotai.kimi-k2.5", "moonshotai.kimi-k2.5"],
  ["minimax.minimax-m2.5", "minimax.minimax-m2.5"], ["zai.glm-5", "zai.glm-5"], ["us.moonshotai.kimi-k3.1", "us.moonshotai.kimi-k3.1"],
  ["us.amazon.nova-2-lite-v1:0", "us.amazon.nova-2-lite-v1:0"], ["us.xai.grok-4.7", "us.xai.grok-4.7"],
];
class Choices implements AgentAiSourceReader { saved = new Map<string, AgentAiSource>(); async sourceFor(cid: string) { return this.saved.get(cid); } }
const noKeys: LearningKeySource = { connected: async () => false, keyFor: async () => undefined };

interface Sent { path: string; body: Record<string, unknown> }
function fakeBedrock(answers: Buffer[]) {
  const sent: Sent[] = [];
  const request = ((options: https.RequestOptions, onResponse: (r: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    const c = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void };
    c.destroy = () => undefined;
    c.end = (body: Buffer) => {
      sent.push({ path: String(options.path), body: JSON.parse(body.toString("utf8")) as Record<string, unknown> });
      const r = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } });
      const answer = answers.shift()!;
      setImmediate(() => { onResponse(r); r.end(answer); });
    };
    return c;
  }) as unknown as typeof https.request;
  return { request, sent };
}
const textStream = (text: string) => Buffer.concat([
  converseEvent("messageStart", { role: "assistant" }), converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text } }), converseEvent("contentBlockStop", { contentBlockIndex: 0 }),
  converseEvent("messageStop", { stopReason: "end_turn" }), converseEvent("metadata", { usage: { inputTokens: 200, outputTokens: 12 } }),
]);
const TOOLS = [{ name: "read_file", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

function gateway(name: string, id: string, answers: Buffer[]) {
  const bedrock = fakeBedrock(answers);
  const choices = new Choices();
  const g = setup({
    agentKeys: noKeys,
    agentAi: { sources: choices, rovara: { models: parseRovaraAiModels(`${name}=${id}`, "us-west-2"), exempt: new Set([cidA, cidB]), transport: createBedrockTransport({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), request: bedrock.request, now: () => Date.UTC(2026, 10, 15) }), maxOutputTokens: () => 16_384 } },
    keys: { keyFor: async () => { throw new Error("install key read"); } },
    prices: { priceFor: (provider) => provider === "bedrock" ? { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000 } : undefined },
  });
  choices.saved.set(cidA, "rovara"); choices.saved.set(cidB, "rovara");
  return { ...g, bedrock, choices };
}
const sseEvents = (text: string) => text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n")[1]!.replace(/^data: /u, "")) as Record<string, unknown>);

describe("agent loop on Rovara's AI through Converse (fakes)", () => {
  for (const [name, id] of MODELS) {
    it(`${name}: a tool call round trip, each turn settled as the company's own billable line`, async () => {
      const g = gateway(name, id, [toolCallStream(), textStream("a.ts exports nothing.")]);
      const token = mint({ mdl: [name] });
      const turn1 = { model: name, max_tokens: 32_000, stream: true, system: "You are a coder.", tools: TOOLS, messages: [{ role: "user", content: "What is in a.ts?" }] };
      const one = await call(g.deps, turn1, token);
      expect(one.status).toBe(200);
      const e1 = sseEvents(one.text());
      const toolUse = e1.find((e) => e.type === "content_block_start" && (e.content_block as { type: string }).type === "tool_use")!.content_block as { id: string; name: string };
      expect(toolUse).toMatchObject({ id: "tooluse_abc123", name: "read_file" });
      expect(e1.find((e) => e.type === "message_delta")).toMatchObject({ delta: { stop_reason: "tool_use" } });
      // What went to Bedrock: ConverseStream on the allow-listed id, held to the model's own limit, with the tools translated.
      expect(g.bedrock.sent[0]!.path).toBe(`/model/${encodeURIComponent(id)}/converse-stream`);
      expect(g.bedrock.sent[0]!.body).toMatchObject({ system: [{ text: "You are a coder." }], inferenceConfig: { maxTokens: 16_384 }, toolConfig: { tools: [{ toolSpec: { name: "read_file" } }] } });

      const input = e1.filter((e) => e.type === "content_block_delta" && (e.delta as { type: string }).type === "input_json_delta").map((e) => (e.delta as { partial_json: string }).partial_json).join("");
      const turn2 = { ...turn1, messages: [...turn1.messages, { role: "assistant", content: [{ type: "tool_use", id: toolUse.id, name: toolUse.name, input: JSON.parse(input) as unknown }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "export {}" }] }] };
      const two = await call(g.deps, turn2, token);
      expect(two.status).toBe(200);
      expect(two.text()).toContain('"text":"a.ts exports nothing."');
      expect(g.bedrock.sent[1]!.body.messages).toEqual([
        { role: "user", content: [{ text: "What is in a.ts?" }] },
        { role: "assistant", content: [{ toolUse: { toolUseId: "tooluse_abc123", name: "read_file", input: { path: "a.ts" } } }] },
        { role: "user", content: [{ toolResult: { toolUseId: "tooluse_abc123", content: [{ text: "export {}" }], status: "success" } }] },
      ]);
      // Usage: turn 1 120 in / 30 out, turn 2 200 in / 12 out, at $1 and $4 a million: 240 and 248 micro-dollars.
      expect(g.meter.billedCalls(claims.iss, cidA).map((l) => [l.line.model, l.line.charge, l.settledMicros])).toEqual([[id, "exempt", 240], [id, "exempt", 248]]);
      expect(g.meter.billedCalls(claims.iss, cidB)).toEqual([]);
    });
  }

  it("a request these models are not offered with is refused before any hold (an image); the other company is unaffected", async () => {
    const g = gateway("deepseek.v3.2", "deepseek.v3.2", [textStream("ok")]);
    const token = mint({ mdl: ["deepseek.v3.2"] });
    const refused = await call(g.deps, { model: "deepseek.v3.2", max_tokens: 100, stream: true, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }] }, token);
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.text())).toEqual({ error: { type: ROVARA_AI_FEATURE.code, message: ROVARA_AI_FEATURE.message } });
    expect(g.bedrock.sent).toEqual([]);
    expect(g.meter.billedCalls(claims.iss, cidA)).toEqual([]);
    expect((await call(g.deps, { model: "deepseek.v3.2", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }, mint({ cid: cidB, mdl: ["deepseek.v3.2"] }))).status).toBe(200);
    expect(g.meter.billedCalls(claims.iss, cidB)).toHaveLength(1);
  });

  it("money: a whole (non-streaming) answer settles from its usage; an exception before output is free; after output, or no usage, charges what was used", async () => {
    const whole = Buffer.from(JSON.stringify({ output: { message: { role: "assistant", content: [{ text: "hi" }] } }, stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10 } }));
    const g1 = gateway("deepseek.v3.2", "deepseek.v3.2", [whole]);
    const body = { model: "deepseek.v3.2", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };
    const token = mint({ mdl: ["deepseek.v3.2"] });
    const one = await call(g1.deps, { ...body, stream: false }, token);
    expect(one.status).toBe(200);
    expect(JSON.parse(one.text())).toMatchObject({ type: "message", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } });
    expect(g1.bedrock.sent[0]!.path).toBe("/model/deepseek.v3.2/converse");
    expect(g1.meter.billedCalls(claims.iss, cidA).map((l) => [l.settledMicros, l.estimated])).toEqual([[140, false]]);

    const exception = frame({ ":exception-type": "throttlingException", ":content-type": "application/json", ":message-type": "exception" }, Buffer.from('{"message":"slow"}'));
    const g2 = gateway("deepseek.v3.2", "deepseek.v3.2", [exception]);
    // A throttle before any output is the honest quota answer (429), and still free.
    const early = await call(g2.deps, { ...body, stream: true }, token);
    expect(early.status).toBe(429);
    expect((JSON.parse(early.text()) as { error: { type: string } }).error.type).toBe("rate_limit_error");
    expect(g2.meter.billedCalls(claims.iss, cidA).map((l) => l.settledMicros)).toEqual([0]);

    // A stream that broke after output started, or ended with no usage: what was used (the input estimate plus the output seen), never the hold
    // (failed-call.ts; the full rules are in model-gateway-failed-call-settle.test.ts). Never free, never above the hold.
    const afterStart = Buffer.concat([converseEvent("messageStart", { role: "assistant" }), converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "partial" } }), exception]);
    const noUsage = Buffer.concat([converseEvent("messageStart", { role: "assistant" }), converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "x" } }), converseEvent("contentBlockStop", { contentBlockIndex: 0 }), converseEvent("messageStop", { stopReason: "end_turn" })]);
    for (const answer of [afterStart, noUsage]) {
      const g = gateway("deepseek.v3.2", "deepseek.v3.2", [answer]);
      const sink = await call(g.deps, { ...body, stream: true }, token);
      const [line] = g.meter.billedCalls(claims.iss, cidA);
      expect(line!.settledMicros).toBeGreaterThan(0);
      expect(line!.settledMicros).toBeLessThan(Buffer.byteLength(JSON.stringify(g.bedrock.sent[0]!.body)) + 100 * 4);
      expect(line!.estimated).toBe(true);
      // A throttle exception AFTER output started is not the quota answer: the stream broke mid-answer.
      expect(sink.text()).not.toContain("rate_limit_error");
    }
  });

  it("the transport calls Claude only through InvokeModel and every other model only through Converse; nothing else is sent", async () => {
    const bedrock = fakeBedrock([]);
    const transport = createBedrockTransport({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), request: bedrock.request, now: () => 0 });
    for (const path of ["/model/us.anthropic.claude-haiku-5-5/converse-stream", "/model/qwen.qwen3-coder-480b-a35b-v1%3A0/invoke-with-response-stream", "/model/global.xai.grok-4.7/converse", "/model/us.anthropic.claude-haiku-5-5/converse", "/model/in.anthropic.claude-x/converse", "/model/us-gov.anthropic.claude-x/converse"]) {
      await expect(transport({ body: Buffer.from("{}"), headers: {}, key: "m", signal: new AbortController().signal, path })).rejects.toThrow();
    }
    expect(bedrock.sent).toEqual([]);
  });

  it("allow-list: a non-Claude entry is named exactly by the Bedrock id called (as Code's catalog names it), in this Region or on its own geography's profile", () => {
    expect([...parseRovaraAiModels("qwen.qwen3-coder-480b-a35b-v1:0=qwen.qwen3-coder-480b-a35b-v1:0,us.moonshotai.kimi-k3.1=us.moonshotai.kimi-k3.1", "us-west-2")]).toHaveLength(2);
    for (const bad of ["qwen-coder=qwen.qwen3-coder-480b-a35b-v1:0", "global.moonshotai.kimi-k3.1=global.moonshotai.kimi-k3.1", "eu.moonshotai.kimi-k3.1=eu.moonshotai.kimi-k3.1", "moonshotai.kimi-k3.1=us.moonshotai.kimi-k3.1", "claude-x=anthropic.claude-x"]) {
      expect(() => parseRovaraAiModels(bad, "us-west-2")).toThrow();
    }
  });
});
