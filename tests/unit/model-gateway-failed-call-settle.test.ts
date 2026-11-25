// A call that FAILED AFTER it was sent (a stream that broke, a connection that dropped) settles at what was used, not at the full hold
// (packages/model-gateway/src/failed-call.ts). Prod 2026-11-23: callId cef02264, glm-5, ConverseStream, failed 0.46 s in with no usage,
// settled at the whole $0.559 hold. Rovara's AI on Bedrock, through the real transport (only https is faked).
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type https from "node:https";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRovaraAiModels, type AgentAiSource, type AgentAiSourceReader } from "../../packages/model-gateway/src/agent-ai.js";
import { createBedrockTransport } from "../../packages/model-gateway/src/bedrock-transport.js";
import { finishCharge, initialCharge } from "../../packages/model-gateway/src/charge-producer.js";
import { parseChargeReceiptV1 } from "../../packages/model-gateway/src/charge-receipt.js";
import { failedCallMicros, failedCallPhase, FAILED_CALL_INPUT_BYTES_PER_TOKEN, FAILED_CALL_OUTPUT_BYTES_PER_TOKEN } from "../../packages/model-gateway/src/failed-call.js";
import type { LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { handleGateway } from "../../packages/model-gateway/src/server.js";
import { UsageCollector } from "../../packages/model-gateway/src/usage.js";
import { call, claims, MemorySink, mint, now, setup } from "./model-gateway-fixture.js";
import { converseEvent, frame } from "./model-gateway-converse-fixture.js";
import { BedrockStreamToSse } from "../../packages/model-gateway/src/bedrock-event-stream.js";

const cid = claims.cid;
class Choices implements AgentAiSourceReader { saved = new Map<string, AgentAiSource>(); async sourceFor(c: string) { return this.saved.get(c); } }
const noKeys: LearningKeySource = { connected: async () => false, keyFor: async () => undefined };
/** What the fake Bedrock does: an answer (bytes), a connection that breaks after the head ("error"), one that resets after the TLS connect and before any head ("reset"), one that ends with no frame ("empty"), or one that never answers ("hang"). */
type Answer = Buffer | "error" | "empty" | "hang" | "reset";
function fakeBedrock(answers: Answer[]) {
  const sent: Array<{ path: string; text: string }> = [];
  const request = ((options: https.RequestOptions, onResponse: (r: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    const c = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void };
    c.destroy = () => undefined;
    c.end = (body: Buffer) => {
      sent.push({ path: String(options.path), text: body.toString("utf8") });
      const r = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } });
      const answer = answers.shift()!;
      r.on("error", () => undefined);
      if (answer === "reset") { setImmediate(() => { const socket = new EventEmitter(); c.emit("socket", socket); socket.emit("secureConnect"); c.emit("error", new Error("read ECONNRESET")); }); return; }
      setImmediate(() => {
        onResponse(r);
        if (answer === "error") r.destroy(new Error("socket hang up")); else if (answer === "empty") r.end(); else if (answer !== "hang") r.end(answer);
      });
    };
    return c;
  }) as unknown as typeof https.request;
  return { request, sent };
}
function gateway(answers: Answer[]) {
  const bedrock = fakeBedrock(answers);
  const choices = new Choices();
  const g = setup({
    agentKeys: noKeys,
    agentAi: { sources: choices, rovara: { models: parseRovaraAiModels("zai.glm-5=zai.glm-5", "us-west-2"), exempt: new Set([cid]), transport: createBedrockTransport({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), request: bedrock.request, now: () => Date.UTC(2026, 10, 15) }), maxOutputTokens: () => 8_192 } },
    keys: { keyFor: async () => { throw new Error("install key read"); } },
    prices: { priceFor: (provider) => provider === "bedrock" ? { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000 } : undefined },
  });
  choices.saved.set(cid, "rovara");
  return { ...g, bedrock };
}
const token = mint({ mdl: ["zai.glm-5"] });
const BODY = { model: "zai.glm-5", max_tokens: 8_192, system: "You are a coder.", messages: [{ role: "user", content: "Please read a.ts and tell me what it exports. ".repeat(40) }] };
const start = converseEvent("messageStart", { role: "assistant" });
const text = (t: string) => converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: t } });
const exception = (type: string) => frame({ ":exception-type": type, ":content-type": "application/json", ":message-type": "exception" }, Buffer.from('{"message":"boom"}'));
const reasons = (logs: unknown[]) => (logs as Array<{ event: string; reason?: string }>).filter((l) => l.event === "provider_error").map((l) => l.reason);
const settled = (g: Pick<ReturnType<typeof gateway>, "meter">) => g.meter.billedCalls(claims.iss, cid).map((l) => [l.settledMicros, l.estimated]);
/** The hold's own figure for this request: its bytes as input tokens at $1 a million, and the output limit at $4 a million. */
const holdOf = (g: ReturnType<typeof gateway>) => Buffer.byteLength(g.bedrock.sent[0]!.text) + 8_192 * 4;
const inputEstimate = (g: ReturnType<typeof gateway>) => Math.ceil(Buffer.byteLength(g.bedrock.sent[0]!.text) / FAILED_CALL_INPUT_BYTES_PER_TOKEN);

describe("a call that failed after it was sent settles at what was used (streaming)", () => {
  it("(a) the connection resets before Bedrock's response head: free, and the log says why", async () => {
    const g = gateway(["reset"]);
    const out = await call(g.deps, { ...BODY, stream: true }, token);
    expect(out.status).not.toBe(0);
    expect(settled(g)).toEqual([[0, false]]);
    expect(reasons(g.logs)).toEqual(["provider_before_events"]);
  });

  it("(c) Bedrock's 2xx head arrived and the answer broke or ended before its first event: it accepted the request, so the INPUT estimate (not free)", async () => {
    for (const answer of ["error", "empty"] as const) {
      const g = gateway([answer]);
      await call(g.deps, { ...BODY, stream: true }, token);
      expect(settled(g)).toEqual([[inputEstimate(g), true]]);
      expect(reasons(g.logs)).toEqual(["provider_before_output"]);
    }
  });

  it("(a) an exception as the very first frame is still free (the quota lane's rule is unchanged)", async () => {
    const g = gateway([exception("throttlingException")]);
    const out = await call(g.deps, { ...BODY, stream: true }, token);
    expect(out.status).toBe(429);
    expect(settled(g)).toEqual([[0, false]]);
  });

  it("(c) the stream started but no answer came, and no usage: the INPUT estimate only, never the output hold", async () => {
    const g = gateway([Buffer.concat([start, exception("internalServerException")])]);
    await call(g.deps, { ...BODY, stream: true }, token);
    const [[micros, estimated]] = settled(g) as [[number, boolean]];
    expect(micros).toBe(inputEstimate(g));
    expect(estimated).toBe(true);
    expect(micros).toBeLessThan(holdOf(g) / 4);
    expect(reasons(g.logs)).toEqual(["provider_before_output"]);
  });

  it("(b) answer text came and then the stream broke: the input estimate plus the output seen, not the hold", async () => {
    const g = gateway([Buffer.concat([start, text("partial"), exception("modelStreamErrorException")])]);
    const out = await call(g.deps, { ...BODY, stream: true }, token);
    expect(out.status).toBe(200);
    expect(out.destroyed).toBe(true);
    const outputTokens = Math.ceil(7 / FAILED_CALL_OUTPUT_BYTES_PER_TOKEN);
    expect(settled(g)).toEqual([[inputEstimate(g) + outputTokens * 4, true]]);
    expect(reasons(g.logs)).toEqual(["provider_after_output"]);
  });

  it("(b) the events before a broken frame in the SAME chunk are counted", async () => {
    const g = gateway([Buffer.concat([start, text("first-words " + "y".repeat(300)), exception("modelStreamErrorException")])]);
    await call(g.deps, { ...BODY, stream: true }, token);
    expect(settled(g)).toEqual([[inputEstimate(g) + Math.ceil(313 / FAILED_CALL_OUTPUT_BYTES_PER_TOKEN) * 4, true]]);
  });

  it("(b) reasoning Bedrock generated counts as output though the converter drops it (glm-5): a break after it is charged for it", async () => {
    const thought = "t".repeat(8_000);
    const reasoning = converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: thought } } });
    const g = gateway([Buffer.concat([start, reasoning, exception("modelStreamErrorException")])]);
    const out = await call(g.deps, { ...BODY, stream: true }, token);
    expect(out.text()).not.toContain("tttt");
    expect(settled(g)).toEqual([[inputEstimate(g) + 4_000 * 4, true]]);
    expect(reasons(g.logs)).toEqual(["provider_after_output"]);
  });

  it("(b) a stream that ended whole but reported no usage is the same: estimated from what came", async () => {
    const whole = Buffer.concat([start, text("x"), converseEvent("contentBlockStop", { contentBlockIndex: 0 }), converseEvent("messageStop", { stopReason: "end_turn" })]);
    const g = gateway([whole]);
    await call(g.deps, { ...BODY, stream: true }, token);
    expect(settled(g)).toEqual([[inputEstimate(g) + 1 * 4, true]]);
  });

  it("a call WE cut short is never free: the caller leaves before any event, and the input estimate is charged", async () => {
    const g = gateway(["hang"]);
    const controller = new AbortController();
    const sink = new MemorySink();
    const done = handleGateway(g.deps, { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": token }, body: (async function* () { yield Buffer.from(JSON.stringify({ ...BODY, stream: true })); })(), signal: controller.signal }, sink);
    for (let i = 0; i < 200 && g.bedrock.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await done;
    expect(settled(g)).toEqual([[inputEstimate(g), true]]);
    expect(reasons(g.logs)).toEqual(["aborted_before_events"]);
  });

  it("measured usage is never replaced by an estimate", async () => {
    const full = Buffer.concat([start, text("hi"), converseEvent("contentBlockStop", { contentBlockIndex: 0 }), converseEvent("messageStop", { stopReason: "end_turn" }), converseEvent("metadata", { usage: { inputTokens: 1_000, outputTokens: 20 } })]);
    const g = gateway([full]);
    await call(g.deps, { ...BODY, stream: true }, token);
    expect(settled(g)).toEqual([[1_000 + 80, false]]);
    expect(reasons(g.logs)).toEqual([]);
  });

  it("the estimate is never above the hold, and a failed call settles once and leaves nothing held for the sweep", async () => {
    const g = gateway([Buffer.concat([start, text("a".repeat(100_000)), exception("modelStreamErrorException")])]);
    await call(g.deps, { ...BODY, max_tokens: 100, stream: true }, token);
    const [[micros]] = settled(g) as [[number, boolean]];
    expect(micros).toBeLessThanOrEqual(Buffer.byteLength(g.bedrock.sent[0]!.text) + 100 * 4);
    expect(await g.meter.sweepOpenHolds(now + 48 * 3_600_000, 10)).toEqual({ swept: 0, already: 0, failed: 0, more: false });
    expect(settled(g)).toEqual([[micros, true]]);
  });
});

describe("a call that failed after it was sent settles at what was used (whole answer)", () => {
  it("(a) the connection resets after the connect and before any answer: free", async () => {
    const g = gateway(["reset"]);
    const out = await call(g.deps, { ...BODY, stream: false }, token);
    expect(out.status).toBe(502);
    expect(settled(g)).toEqual([[0, false]]);
    expect(reasons(g.logs)).toEqual(["provider_before_events"]);
  });

  it("a whole answer whose 2xx head arrived and whose body then broke was finished and billed by Bedrock: the HOLD", async () => {
    const g = gateway(["error"]);
    await call(g.deps, { ...BODY, stream: false }, token);
    expect(settled(g)).toEqual([[holdOf(g), true]]);
  });

  it("a whole answer that came but could not be read keeps the hold, never free and never the estimate", async () => {
    const g = gateway([Buffer.from("not json")]);
    const out = await call(g.deps, { ...BODY, stream: false }, token);
    expect(out.status).toBe(502);
    expect(settled(g)).toEqual([[holdOf(g), true]]);
  });
});

describe("the rule's arithmetic and the receipt", () => {
  const price = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000, cacheReadMicrosPerMTok: 100_000, cacheWrite5mMicrosPerMTok: 1_250_000, cacheWrite1hMicrosPerMTok: 2_000_000, estimated: false };
  const base = { inputBytes: 4_000, outputBytes: 0, price, plainInput: true, reservationMicros: 100_000, cause: "provider" as const };
  it("phases: nothing, started, answered", () => {
    expect(failedCallPhase({ streaming: true, answered: false, received: 0, progress: { events: 0, outputBytes: 0 } })).toBe("before_events");
    expect(failedCallPhase({ streaming: true, answered: true, received: 0, progress: { events: 0, outputBytes: 0 } })).toBe("before_output");
    // Reasoning the converter drops still counts as answer content (the transport's count).
    expect(failedCallPhase({ streaming: true, answered: true, received: 90, progress: { events: 2, outputBytes: 8_000 } })).toBe("after_output");
    expect(failedCallPhase({ streaming: true, answered: true, received: 90, progress: { events: 1, outputBytes: 0 } })).toBe("before_output");
    expect(failedCallPhase({ streaming: true, answered: true, received: 90, progress: { events: 2, outputBytes: 3 } })).toBe("after_output");
    expect(failedCallPhase({ streaming: true, answered: true, received: 22, progress: { events: 0, outputBytes: 0 } })).toBe("before_output");
    expect(failedCallPhase({ streaming: false, answered: false, received: 0 })).toBe("before_events");
    expect(failedCallPhase({ streaming: false, answered: true, received: 0 })).toBe("before_output");
  });
  it("free only when the provider broke before any event; our own cut is charged the input; a gateway fault keeps the hold rule", () => {
    expect(failedCallMicros({ ...base, phase: "before_events" })).toBe(0);
    expect(failedCallMicros({ ...base, phase: "before_events", cause: "aborted" })).toBe(1_000);
    expect(failedCallMicros({ ...base, phase: "before_output" })).toBe(1_000);
    // Before any answer content, no output is charged even if a byte count is passed.
    expect(failedCallMicros({ ...base, phase: "before_output", outputBytes: 400 })).toBe(1_000);
    expect(failedCallMicros({ ...base, phase: "after_output", outputBytes: 400 })).toBe(1_000 + 200 * 4);
    expect(failedCallMicros({ ...base, phase: "after_output", cause: "gateway" })).toBeUndefined();
    // A whole answer whose head arrived is finished and billed: the hold, whoever stopped the call.
    for (const cause of ["provider", "aborted"] as const) expect(failedCallMicros({ ...base, phase: "before_output", cause, wholeAnswer: true })).toBeUndefined();
  });
  it("the provider's own prompt count wins over the byte estimate; the hold caps it; prompt caching is priced at its dearest input rate", () => {
    expect(failedCallMicros({ ...base, phase: "before_output", inputTokens: 5_000 })).toBe(5_000);
    expect(failedCallMicros({ ...base, phase: "before_output", inputBytes: 40_000_000 })).toBe(100_000);
    expect(failedCallMicros({ ...base, phase: "before_output", plainInput: false, inputTokens: 1_000 })).toBe(2_000);
    expect(failedCallMicros({ ...base, phase: "before_output", inputBytes: 1 })).toBe(1);
  });
  it("images are counted as the hold counts them: their tokens are added, never divided by the bytes-per-token figure", () => {
    expect(failedCallMicros({ ...base, phase: "before_output", fixedInputTokens: 3_000 })).toBe(1_000 + 3_000);
    expect(failedCallMicros({ ...base, phase: "before_output", fixedInputTokens: 3_000, inputTokens: 5_000 })).toBe(5_000);
  });
  it("the stream reader says how far the stream got", () => {
    const u = new UsageCollector();
    const line = (type: string, data: Record<string, unknown>) => Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    u.push(line("message_start", { message: { usage: { input_tokens: 5, output_tokens: 0 } } }));
    expect(u.progress()).toEqual({ events: 1, outputBytes: 0 });
    u.push(line("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    u.push(line("content_block_delta", { index: 0, delta: { type: "text_delta", text: "héllo" } }));
    expect(u.progress()).toEqual({ events: 3, outputBytes: 1 + 6 });
    expect(u.actualInputTokens()).toBe(5);
  });
  it("a failed-call estimate is a valid never-confirmed receipt below the hold, not billable, for a customer line too", () => {
    const tokenClaims = { iss: claims.iss, cid, pid: claims.pid, tid: claims.tid, op: claims.op, per: claims.per, pay: { kind: "project", project: claims.pid } } as never;
    const price2 = { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, estimated: false, cacheReadMicrosPerMTok: 1, cacheWrite5mMicrosPerMTok: 1, cacheWrite1hMicrosPerMTok: 1 } as never;
    for (const billing of ["customer", "exempt"] as const) {
      const initial = initialCharge(tokenClaims, { provider: "bedrock", modelId: "zai.glm-5" }, { source: { kind: "rovara_ai", id: "rovara-ai", name: "Rovara AI", provider: "bedrock", connectionRevision: "r" }, billing }, 559_153, now, price2);
      const receipt = finishCharge(initial, { price: price2, notSent: false, now, failedMicros: 12_000 });
      expect(parseChargeReceiptV1(receipt)).toBeDefined();
      expect(receipt).toMatchObject({ status: "estimated", reason: "missing_usage", neverConfirmed: true, usageComplete: false, amountMicros: { state: "available", value: 12_000 }, originalReservationMicros: { state: "available", value: 559_153 } });
      expect(receipt.billableMicros.state === "available" ? receipt.billableMicros.value : undefined).toBe(billing === "customer" ? undefined : 0);
      expect(finishCharge(initial, { price: price2, notSent: true, now, failedMicros: 0 })).toMatchObject({ status: "final", reason: "confirmed_not_sent", amountMicros: { value: 0 } });
    }
  });
});

describe("an inline image is counted in the input estimate as the hold counts it", () => {
  it("a Claude call with a 28x28 image that breaks after its start event is charged the image's 257 tokens on top of the text", async () => {
    const png = Buffer.alloc(33); Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(png); png.writeUInt32BE(28, 16); png.writeUInt32BE(28, 20);
    const line = (type: string, data: Record<string, unknown>) => Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const run = async (content: unknown) => {
      const choices = new Choices();
      const g = setup({
        agentKeys: noKeys,
        agentAi: { sources: choices, rovara: { models: parseRovaraAiModels("claude-sonnet-5-5=us.anthropic.claude-sonnet-5-5", "us-west-2"), exempt: new Set([cid]), maxOutputTokens: () => 64,
          transport: async () => ({ status: 200, body: (async function* () { yield line("message_start", { message: { usage: { input_tokens: 0, output_tokens: 0 } } }); throw new Error("socket hang up"); })() }) } },
        keys: { keyFor: async () => { throw new Error("install key read"); } },
        prices: { priceFor: (provider) => provider === "bedrock" ? { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000 } : undefined },
      });
      choices.saved.set(cid, "rovara");
      await call(g.deps, { model: "claude-sonnet-5-5", max_tokens: 64, stream: true, messages: [{ role: "user", content }] }, mint({ mdl: ["claude-sonnet-5-5"] }));
      return (settled(g)[0] as [number, boolean])[0];
    };
    const plain = await run("describe it");
    const withImage = await run([{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }, { type: "text", text: "describe it" }]);
    expect(withImage - plain).toBeGreaterThanOrEqual(257);
    expect(withImage - plain).toBeLessThan(257 + 60);
  });
});

describe("the Claude (InvokeModel) stream counts every answer string it reads", () => {
  it("thinking, its signature, a redacted block, a tool name and its input are all output seen", () => {
    const chunk = (event: Record<string, unknown>) => frame({ ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" }, Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") })));
    const sse = new BedrockStreamToSse();
    sse.convert(sse.decode(Buffer.concat([
      chunk({ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
      chunk({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      chunk({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "abcd" } }),
      chunk({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "S".repeat(100) } }),
      chunk({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "R".repeat(50) } }),
      chunk({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "", name: "read_file", input: {} } }),
      chunk({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"a":1}' } }),
    ])));
    expect(sse.progress()).toEqual({ events: 7, outputBytes: 4 + 100 + 50 + 9 + 7 });
  });
});
