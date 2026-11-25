import { crc32 } from "node:zlib";
import { record } from "./model-gateway-token.js";

/**
 * AWS's binary event-stream framing (application/vnd.amazon.eventstream), as Bedrock's InvokeModelWithResponseStream answers:
 * each message is a 12-byte prelude (total length, headers length, prelude CRC32), typed headers, a payload and a message CRC32.
 * Node built-ins only (the gateway image holds no node_modules). Every malformed or oversized message throws; nothing is skipped.
 */
export const EVENT_STREAM_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const PRELUDE = 12;
const MAX_HEADERS = 32;

export interface EventStreamMessage { headers: Readonly<Record<string, string>>; payload: Buffer }
export class EventStreamError extends Error { constructor() { super("provider unavailable"); this.name = "EventStreamError"; } }

export class EventStreamDecoder {
  #pending = Buffer.alloc(0);
  push(bytes: Uint8Array): EventStreamMessage[] {
    this.#pending = this.#pending.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.#pending, bytes]);
    const out: EventStreamMessage[] = [];
    for (;;) {
      if (this.#pending.length < PRELUDE) return out;
      const total = this.#pending.readUInt32BE(0); const headersLength = this.#pending.readUInt32BE(4);
      // The prelude is checked before its lengths are trusted, so a bad length never makes the decoder wait for bytes.
      if ((crc32(this.#pending.subarray(0, 8)) >>> 0) !== this.#pending.readUInt32BE(8)) throw new EventStreamError();
      if (total > EVENT_STREAM_MAX_MESSAGE_BYTES || total < PRELUDE + 4 || headersLength > total - PRELUDE - 4) throw new EventStreamError();
      if (this.#pending.length < total) return out;
      const message = this.#pending.subarray(0, total);
      this.#pending = this.#pending.subarray(total);
      if ((crc32(message.subarray(0, total - 4)) >>> 0) !== message.readUInt32BE(total - 4)) throw new EventStreamError();
      out.push({ headers: readHeaders(message.subarray(PRELUDE, PRELUDE + headersLength)), payload: Buffer.from(message.subarray(PRELUDE + headersLength, total - 4)) });
    }
  }
  /** The stream ended: anything left over is a cut message. */
  finish(): void { if (this.#pending.length > 0) throw new EventStreamError(); }
}

/** Only string headers (type 7) are read; Bedrock's chunk and exception messages carry no other kind. Anything else throws. */
function readHeaders(bytes: Buffer): Record<string, string> {
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  let at = 0; let count = 0;
  while (at < bytes.length) {
    if (++count > MAX_HEADERS) throw new EventStreamError();
    const nameLength = bytes.readUInt8(at); const name = bytes.subarray(at + 1, at + 1 + nameLength).toString("utf8"); at += 1 + nameLength;
    if (nameLength === 0 || at + 3 > bytes.length || bytes.readUInt8(at) !== 7) throw new EventStreamError();
    const valueLength = bytes.readUInt16BE(at + 1); at += 3;
    if (at + valueLength > bytes.length) throw new EventStreamError();
    headers[name] = bytes.subarray(at, at + valueLength).toString("utf8"); at += valueLength;
  }
  return headers;
}

/** The Anthropic stream events an agent may receive (the meter's UsageCollector reads the same set). */
const ANTHROPIC_EVENTS: ReadonlySet<string> = new Set(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop", "ping"]);

/**
 * Bedrock chunks back to the Anthropic SSE the agent route speaks: each `chunk` message's payload is {"bytes": <base64 Anthropic
 * event JSON>, ...}; it is re-serialised (one line, so no event can inject another) as `event: <type>\ndata: <json>\n\n`,
 * without Bedrock's own `amazon-bedrock-invocationMetrics` field. An exception message, any other message, or a payload that is
 * not one known Anthropic event fails the stream: the call is then charged as any stream that broke after sending.
 */
/**
 * The HTTP status an exception message stands for, from its `:exception-type` (AWS's InvokeModelWithResponseStream errors), so an
 * exception that arrives before any output is answered (and accounted) like the same error before the stream: never charged.
 */
export function exceptionStatus(message: EventStreamMessage): number {
  const type = message.headers[":exception-type"] ?? "";
  return type === "throttlingException" ? 429 : type === "validationException" ? 400 : type === "modelTimeoutException" ? 408 : type === "serviceUnavailableException" ? 503 : type === "modelStreamErrorException" ? 424 : 500;
}

/** Bytes of answer content one Anthropic stream event carries (every string a block start or delta holds), zero for any other event. */
export function anthropicContentBytes(event: Record<string, unknown>): number {
  const bytes = (v: unknown): number => typeof v === "string" ? Buffer.byteLength(v, "utf8") : 0;
  const sum = (o: unknown): number => { const r = record(o); return r === undefined ? 0 : Object.entries(r).reduce<number>((n, [k, v]) => n + (k === "type" ? 0 : bytes(v)), 0); };
  if (event.type === "content_block_start") return sum(event.content_block);
  if (event.type === "content_block_delta") return sum(event.delta);
  return 0;
}
export class BedrockStreamToSse {
  readonly #decoder = new EventStreamDecoder();
  #events = 0; #outputBytes = 0;
  /** Whole events read, and bytes of answer content (text, tool name and input, thinking, signatures, redacted data). */
  progress(): { events: number; outputBytes: number } { return { events: this.#events, outputBytes: this.#outputBytes }; }
  /** The decoded messages of `bytes` (for the transport's look at the first one); `convert` turns them into SSE. */
  decode(bytes: Uint8Array): EventStreamMessage[] { return this.#decoder.push(bytes); }
  push(bytes: Uint8Array): Buffer { return this.convert(this.#decoder.push(bytes)); }
  convert(messages: readonly EventStreamMessage[]): Buffer {
    const out: Buffer[] = [];
    for (const message of messages) {
      if (message.headers[":message-type"] !== "event" || message.headers[":event-type"] !== "chunk") throw new EventStreamError();
      let event: Record<string, unknown> | undefined;
      try {
        const wrapper = record(JSON.parse(message.payload.toString("utf8")) as unknown);
        if (typeof wrapper?.bytes !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(wrapper.bytes)) throw new EventStreamError();
        event = record(JSON.parse(Buffer.from(wrapper.bytes, "base64").toString("utf8")) as unknown);
      } catch { throw new EventStreamError(); }
      if (event === undefined || typeof event.type !== "string" || !ANTHROPIC_EVENTS.has(event.type)) throw new EventStreamError();
      this.#events++; this.#outputBytes += anthropicContentBytes(event);
      const anthropic = Object.fromEntries(Object.entries(event).filter(([name]) => name !== "amazon-bedrock-invocationMetrics"));
      out.push(Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(anthropic)}\n\n`, "utf8"));
    }
    return Buffer.concat(out);
  }
  finish(): Buffer { this.#decoder.finish(); return Buffer.alloc(0); }
}
