// Review tests (lead 4 Opus money, FAILED-CALL-SETTLE f9955eaf7). Rovara's AI on Bedrock through the real transport (only https is faked).
// R1-R3 FAIL on f9955eaf7: output Bedrock generated and billed (dropped reasoning; a whole answer that finished) is settled as input only.
// R4-R7 pass on f9955eaf7 and pin the rule (mutant killers).
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type https from "node:https";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRovaraAiModels, type AgentAiSource, type AgentAiSourceReader } from "../../packages/model-gateway/src/agent-ai.js";
import { createBedrockTransport } from "../../packages/model-gateway/src/bedrock-transport.js";
import { FAILED_CALL_INPUT_BYTES_PER_TOKEN, FAILED_CALL_OUTPUT_BYTES_PER_TOKEN } from "../../packages/model-gateway/src/failed-call.js";
import type { LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { handleGateway } from "../../packages/model-gateway/src/server.js";
import { claims, MemorySink, mint, setup, call } from "./model-gateway-fixture.js";
import { converseEvent, frame } from "./model-gateway-converse-fixture.js";

const cid = claims.cid;
class Choices implements AgentAiSourceReader { saved = new Map<string, AgentAiSource>(); async sourceFor(c: string) { return this.saved.get(c); } }
const noKeys: LearningKeySource = { connected: async () => false, keyFor: async () => undefined };
/** An answer: bytes then end, bytes then a hang (the caller leaves), or a whole answer whose body breaks after these bytes. */
type Answer = { bytes: Buffer; then: "end" | "hang" | "break" };
function fakeBedrock(answers: Answer[]) {
  const sent: string[] = [];
  const request = ((_options: https.RequestOptions, onResponse: (r: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    const c = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void };
    c.destroy = () => undefined;
    c.end = (body: Buffer) => {
      sent.push(body.toString("utf8"));
      const r = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
      r.on("error", () => undefined);
      const answer = answers.shift()!;
      setImmediate(() => {
        onResponse(r);
        if (answer.then === "end") r.end(answer.bytes);
        else if (answer.then === "hang") r.write(answer.bytes);
        else { r.write(answer.bytes); setImmediate(() => r.destroy(new Error("socket hang up"))); }
      });
    };
    return c;
  }) as unknown as typeof https.request;
  return { request, sent };
}
function gateway(model: string, answers: Answer[]) {
  const bedrock = fakeBedrock(answers);
  const choices = new Choices();
  const g = setup({
    agentKeys: noKeys,
    agentAi: { sources: choices, rovara: { models: parseRovaraAiModels(`${model}=${model}`, "us-west-2"), exempt: new Set([cid]), transport: createBedrockTransport({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), request: bedrock.request, now: () => Date.UTC(2026, 10, 15) }), maxOutputTokens: () => 8_192 } },
    keys: { keyFor: async () => { throw new Error("install key read"); } },
    prices: { priceFor: (provider) => provider === "bedrock" ? { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000 } : undefined },
  });
  choices.saved.set(cid, "rovara");
  return { ...g, bedrock };
}
const body = (model: string) => ({ model, max_tokens: 8_192, messages: [{ role: "user", content: "Explain the bug in a.ts. ".repeat(20) }] });
const start = converseEvent("messageStart", { role: "assistant" });
const reasoning = (t: string) => converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: t } } });
const text = (i: number, t: string) => converseEvent("contentBlockDelta", { contentBlockIndex: i, delta: { text: t } });
const stop = (i: number) => converseEvent("contentBlockStop", { contentBlockIndex: i });
const broke = frame({ ":exception-type": "modelStreamErrorException", ":content-type": "application/json", ":message-type": "exception" }, Buffer.from('{"message":"boom"}'));
const settled = (g: ReturnType<typeof gateway>) => g.meter.billedCalls(claims.iss, cid).map((l) => l.settledMicros);
const inputEstimate = (g: ReturnType<typeof gateway>) => Math.ceil(Buffer.byteLength(g.bedrock.sent[0]!) / FAILED_CALL_INPUT_BYTES_PER_TOKEN);
const hold = (g: ReturnType<typeof gateway>) => Buffer.byteLength(g.bedrock.sent[0]!) + 8_192 * 4;
/** 8,000 bytes of reasoning Bedrock generated (and bills) on a reasoning model whose reasoning the converter drops (glm-5: not REASONING_CARRYOVER_MODEL). */
const THOUGHT = "Let me think about the export list carefully. ".repeat(174).slice(0, 8_000);
const reasoningOutput = Math.ceil(8_000 / FAILED_CALL_OUTPUT_BYTES_PER_TOKEN) * 4;

describe("review: output Bedrock generated is counted (FAIL on f9955eaf7)", () => {
  it("R1 the provider breaks after dropped reasoning and a short answer: the reasoning seen is charged as output, not input + 1 token", async () => {
    const g = gateway("zai.glm-5", [{ bytes: Buffer.concat([start, reasoning(THOUGHT), stop(0), text(1, "ok"), broke]), then: "end" }]);
    await call(g.deps, { ...body("zai.glm-5"), stream: true }, token("zai.glm-5"));
    const [micros] = settled(g);
    expect(micros).toBeGreaterThanOrEqual(Math.min(hold(g), inputEstimate(g) + reasoningOutput));
  });

  it("R2 the CALLER leaves right after the visible answer (before Converse's metadata): its reasoning is not free", async () => {
    const g = gateway("zai.glm-5", [{ bytes: Buffer.concat([start, reasoning(THOUGHT), stop(0), text(1, "ok"), stop(1)]), then: "hang" }]);
    const controller = new AbortController(); const sink = new MemorySink();
    const done = handleGateway(g.deps, { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": token("zai.glm-5") }, body: (async function* () { yield Buffer.from(JSON.stringify({ ...body("zai.glm-5"), stream: true })); })(), signal: controller.signal }, sink);
    // Everything Bedrock sent has been read (the secret scanner may still hold the last bytes back from the caller).
    for (let i = 0; i < 400 && !sink.text().includes("message_start"); i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));
    controller.abort(); await done;
    const [micros] = settled(g);
    expect(micros).toBeGreaterThanOrEqual(Math.min(hold(g), inputEstimate(g) + reasoningOutput));
  });

  it("R3 a whole (non-streaming) answer that finished (200 head) and then broke in transfer: Bedrock billed the whole generation, so the hold rule, not input only", async () => {
    const g = gateway("zai.glm-5", [{ bytes: Buffer.from('{"output":{"message":{"role":"assistant","content":[{"text":"'), then: "break" }]);
    await call(g.deps, { ...body("zai.glm-5"), stream: false }, token("zai.glm-5"));
    expect(settled(g)).toEqual([hold(g)]);
  });
});

describe("review: the rule as built (pass on f9955eaf7)", () => {
  it("R4 a provider break after the 200 head and before any event is the input estimate (F3: Bedrock accepted the request); the same after the caller left is the same", async () => {
    // The fake always sends the 200 head, so "free" (no head at all) is pinned in model-gateway-failed-call-settle.test.ts ("reset").
    const g1 = gateway("zai.glm-5", [{ bytes: Buffer.alloc(0), then: "break" }]);
    await call(g1.deps, { ...body("zai.glm-5"), stream: true }, token("zai.glm-5"));
    expect(settled(g1)).toEqual([inputEstimate(g1)]);
    const g2 = gateway("zai.glm-5", [{ bytes: Buffer.alloc(0), then: "hang" }]);
    const controller = new AbortController();
    const done = handleGateway(g2.deps, { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": token("zai.glm-5") }, body: (async function* () { yield Buffer.from(JSON.stringify({ ...body("zai.glm-5"), stream: true })); })(), signal: controller.signal }, new MemorySink());
    for (let i = 0; i < 200 && g2.bedrock.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    controller.abort(); await done;
    expect(settled(g2)).toEqual([inputEstimate(g2)]);
  });

  it("R5 the caller leaves after visible text: input + the text seen at 2 bytes a token (never free, never the hold)", async () => {
    const answer = "x".repeat(1_000);
    const g = gateway("zai.glm-5", [{ bytes: Buffer.concat([start, text(0, answer), stop(0)]), then: "hang" }]);
    const controller = new AbortController(); const sink = new MemorySink();
    const done = handleGateway(g.deps, { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": token("zai.glm-5") }, body: (async function* () { yield Buffer.from(JSON.stringify({ ...body("zai.glm-5"), stream: true })); })(), signal: controller.signal }, sink);
    for (let i = 0; i < 400 && !sink.text().includes("message_start"); i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));
    controller.abort(); await done;
    // 1,000 text bytes + 1 for the block's start, at 2 bytes a token, at $4 a million.
    expect(settled(g)).toEqual([inputEstimate(g) + 501 * 4]);
    expect(g.logs.filter((l) => (l as { event: string }).event === "provider_error")).toEqual([{ event: "provider_error", reason: "aborted_after_output" }]);
  });

  it("R6 a stream that started (message_start only) and broke: the input estimate, logged provider_before_output", async () => {
    const g = gateway("zai.glm-5", [{ bytes: start, then: "break" }]);
    await call(g.deps, { ...body("zai.glm-5"), stream: true }, token("zai.glm-5"));
    expect(settled(g)).toEqual([inputEstimate(g)]);
  });

  it("R7 a gateway-side stop (the secret scanner sees the caller's token in the answer) keeps the hold, never the estimate", async () => {
    const g = gateway("zai.glm-5", [{ bytes: Buffer.concat([start, text(0, `leak ${token("zai.glm-5")} end`), stop(0)]), then: "hang" }]);
    const out = await call(g.deps, { ...body("zai.glm-5"), stream: true }, token("zai.glm-5"));
    expect(out.text()).not.toContain(token("zai.glm-5"));
    expect(settled(g)).toEqual([hold(g)]);
    expect(g.logs.filter((l) => (l as { event: string }).event === "provider_error")).toEqual([{ event: "provider_error", reason: "gateway_error" }]);
  });
});
function token(model: string) { return mint({ mdl: [model] }); }

const sse = (type: string, data: Record<string, unknown>) => Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
describe("review: who stopped it, and only Rovara's AI on Bedrock", () => {
  it("R8 a company's own key (anthropic_key) whose stream breaks after output keeps the hold: the rule is Rovara-AI-on-Bedrock only", async () => {
    const choices = new Choices();
    const g = setup({
      agentKeys: { connected: async () => true, keyFor: async () => "company-key-0123456789" },
      agentAi: { sources: choices },
      transport: async () => ({ status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 0, output_tokens: 0 } } }); yield sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }); yield sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "partial" } }); throw new Error("socket hang up"); })() }),
    });
    choices.saved.set(cid, "anthropic_key");
    await call(g.deps, { model: claims.mdl[0], max_tokens: 8_192, stream: true, messages: [{ role: "user", content: "hi" }] }, mint());
    // The company-key call is not a billed line; the settle log carries what the meter was settled at (the hold: 8,192 output tokens at $2 a million plus the input).
    const settle = g.logs.find((l) => (l as { event: string }).event === "settled") as { costMicros: number; estimated: boolean };
    expect(settle.costMicros).toBeGreaterThan(8_192 * 2);
    expect(g.logs.filter((l) => (l as { event: string }).event === "provider_error")).toEqual([{ event: "provider_error", reason: "provider_after_output" }]);
  });

  it("R9 the task ends mid-stream (a chunk arrives after the end): our cut, so input + output seen, logged aborted_after_output (not the gateway's hold)", async () => {
    const choices = new Choices();
    const hooks: { ended?: () => void } = {};
    const g = setup({
      agentKeys: noKeys,
      agentAi: { sources: choices, rovara: { models: parseRovaraAiModels("zai.glm-5=zai.glm-5", "us-west-2"), exempt: new Set([cid]), maxOutputTokens: () => 8_192,
        transport: async () => ({ status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 0, output_tokens: 0 } } }); yield sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }); yield sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x".repeat(99) } }); hooks.ended!(); yield sse("content_block_stop", { index: 0 }); })() }) } },
      keys: { keyFor: async () => { throw new Error("install key read"); } },
      prices: { priceFor: (provider) => provider === "bedrock" ? { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000 } : undefined },
    });
    hooks.ended = () => g.ended.end(claims.iss, cid, claims.tid);
    choices.saved.set(cid, "rovara");
    await call(g.deps, { ...body("zai.glm-5"), stream: true }, token("zai.glm-5"));
    expect(g.logs.filter((l) => (l as { event: string }).event === "provider_error")).toEqual([{ event: "provider_error", reason: "aborted_after_output" }]);
    const [line] = g.meter.billedCalls(claims.iss, cid);
    expect(line!.settledMicros).toBeLessThan(8_192 * 4);
    expect(line!.estimated).toBe(true);
  });
});
