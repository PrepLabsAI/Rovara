// Rovara's AI (DEC 240): the agent route calls Bedrock's InvokeModelWithResponseStream with the Anthropic body. Bedrock answers in
// AWS's binary event-stream framing, not SSE; the gateway turns each chunk back into the Anthropic SSE event the agent expects.
//
// The fixture is the raw response body of ONE real call (2026-11-15, staging, us.anthropic.claude-haiku-4-5-20251001-v1:0,
// max_tokens 8, "Say hi.", SigV4 service "bedrock"): content type application/vnd.amazon.eventstream, nine `:event-type chunk`
// frames whose JSON payload is {"bytes": <base64 Anthropic event JSON>, "p": <padding>}. No account id or credential in it.
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BedrockStreamToSse, EventStreamDecoder, EVENT_STREAM_MAX_MESSAGE_BYTES } from "../../packages/model-gateway/src/bedrock-event-stream.js";
import { UsageCollector } from "../../packages/model-gateway/src/usage.js";

const real = readFileSync(new URL("../fixtures/model-gateway-bedrock/invoke-with-response-stream-haiku-4-5.bin", import.meta.url));

/** One event-stream message with string headers (type 7), as AWS frames it. */
function frame(headers: Record<string, string>, payload: Buffer): Buffer {
  const head = Buffer.concat(Object.entries(headers).map(([name, value]) => {
    const n = Buffer.from(name); const v = Buffer.from(value);
    const h = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    h.writeUInt8(n.length, 0); n.copy(h, 1); h.writeUInt8(7, 1 + n.length); h.writeUInt16BE(v.length, 2 + n.length); v.copy(h, 4 + n.length);
    return h;
  }));
  const total = 12 + head.length + payload.length + 4;
  const prelude = Buffer.alloc(8); prelude.writeUInt32BE(total, 0); prelude.writeUInt32BE(head.length, 4);
  const preludeCrc = Buffer.alloc(4); preludeCrc.writeUInt32BE(crc32(prelude) >>> 0, 0);
  const body = Buffer.concat([prelude, preludeCrc, head, payload]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([body, crc]);
}
const chunk = (event: Record<string, unknown>) => frame({ ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" }, Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64"), p: "abc" })));
const sseEvents = (text: string) => text.split("\n\n").filter(Boolean).map((block) => {
  const [eventLine, dataLine] = block.split("\n");
  return { event: eventLine!.replace(/^event: /u, ""), data: JSON.parse(dataLine!.replace(/^data: /u, "")) as Record<string, unknown> };
});

describe("event-stream decoder", () => {
  it("decodes the real Bedrock answer into its nine chunk messages, byte by byte as well as whole", () => {
    for (const step of [real.length, 1, 7]) {
      const decoder = new EventStreamDecoder();
      const messages = [];
      for (let at = 0; at < real.length; at += step) messages.push(...decoder.push(real.subarray(at, at + step)));
      decoder.finish();
      expect(messages).toHaveLength(9);
      expect(messages.every((m) => m.headers[":event-type"] === "chunk" && m.headers[":message-type"] === "event")).toBe(true);
    }
  });

  it("refuses a message whose prelude or message checksum is wrong", () => {
    const good = chunk({ type: "message_stop" });
    const badPrelude = Buffer.from(good); badPrelude[9] = badPrelude[9]! ^ 0xff;
    expect(() => new EventStreamDecoder().push(badPrelude)).toThrow();
    const badBody = Buffer.from(good); badBody[good.length - 6] = badBody[good.length - 6]! ^ 0xff;
    expect(() => new EventStreamDecoder().push(badBody)).toThrow();
  });

  it("refuses a message larger than its bound before buffering it, and a stream that stops mid-message", () => {
    const huge = Buffer.alloc(12); huge.writeUInt32BE(EVENT_STREAM_MAX_MESSAGE_BYTES + 1, 0); huge.writeUInt32BE(0, 4); huge.writeUInt32BE(crc32(huge.subarray(0, 8)) >>> 0, 8);
    expect(() => new EventStreamDecoder().push(huge)).toThrow();
    const decoder = new EventStreamDecoder();
    decoder.push(chunk({ type: "message_stop" }).subarray(0, 20));
    expect(() => decoder.finish()).toThrow();
  });
});

describe("Bedrock chunks to Anthropic SSE", () => {
  it("re-emits the real answer as the Anthropic events, in order, with the usage the meter reads", () => {
    const sse = new BedrockStreamToSse();
    const text = Buffer.concat([sse.push(real), sse.finish()]).toString("utf8");
    const events = sseEvents(text);
    expect(events.map((e) => e.event)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(events.every((e) => e.data.type === e.event)).toBe(true);
    // The meter's own SSE reader takes the token counts from these events, exactly as from Anthropic.
    const usage = new UsageCollector();
    usage.push(Buffer.from(text));
    expect(usage.finish()).toMatchObject({ input: 10, output: 8, cacheRead: 0, cacheWrite: 0 });
  });

  it("an exception frame mid-stream fails the stream (never a silent partial answer)", () => {
    const sse = new BedrockStreamToSse();
    sse.push(chunk({ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } }));
    const exception = frame({ ":exception-type": "throttlingException", ":content-type": "application/json", ":message-type": "exception" }, Buffer.from('{"message":"slow down"}'));
    expect(() => sse.push(exception)).toThrow();
  });

  it("refuses a chunk that is not base64 Anthropic event JSON, or an event type it does not know", () => {
    const notJson = frame({ ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" }, Buffer.from("not json"));
    expect(() => new BedrockStreamToSse().push(notJson)).toThrow();
    expect(() => new BedrockStreamToSse().push(chunk({ type: "evil\ndata: x" }))).toThrow();
    const other = frame({ ":event-type": "somethingElse", ":content-type": "application/json", ":message-type": "event" }, Buffer.from("{}"));
    expect(() => new BedrockStreamToSse().push(other)).toThrow();
  });
});
