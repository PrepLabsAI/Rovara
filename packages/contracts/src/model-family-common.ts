// TE-F0a: what the model families share: the scripted reply a builder turns into one family's bytes, the bounds, a seeded id, text chunking, and the SSE framing and its parser. PURE: no Node module, no socket, no clock,
// no randomness (an id comes from a passed-in seed).

export const MODEL_REPLY_MAX_CHARS = 1_000_000;
export const MODEL_NAME_MAX_CHARS = 128;
/** A stream is never cut into more chunks than this: a long reply grows its chunks instead. */
export const MODEL_STREAM_MAX_CHUNKS = 20_000;
export const MODEL_REQUEST_BODY_MAX_BYTES = 1024 * 1024;
export const MODEL_SSE_PARSE_MAX_CHARS = 8 * 1024 * 1024;

export type ModelFinish = "stop" | "length" | "safety" | "tool_calls" | "other";
export interface ModelToolCall {
  readonly name: string;
  /** Plain JSON. */
  readonly args: Readonly<Record<string, unknown>>;
}
/** One scripted answer, in no family's shape: TE-F2 writes these, a family builder renders them. */
export interface ModelReply {
  readonly text: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly finish: ModelFinish;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}
export type SseLineEnding = "lf" | "crlf";

/** A model name in a Gemini path. */
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** A model name a builder may write into an answer: gateways name models `google/gemini-2.5-flash` or `openai/gpt-4o:free`. */
export const MODEL_ECHO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;

/** Refuses (RangeError, fixed words) what a builder must never render: a reply or a name past its bound, a token count that is not a small integer. */
export function assertReplyBounds(reply: ModelReply, model: string): void {
  if (reply.text.length > MODEL_REPLY_MAX_CHARS) throw new RangeError("the scripted reply is too long");
  if (!MODEL_ECHO_PATTERN.test(model)) throw new RangeError("the model name is not valid");
  const calls = reply.toolCalls ?? [];
  if (calls.length > 32 || calls.some((call) => call.name.length === 0 || call.name.length > MODEL_NAME_MAX_CHARS || JSON.stringify(call.args).length > MODEL_REPLY_MAX_CHARS)) throw new RangeError("the scripted tool calls are out of bounds");
  for (const count of [reply.usage?.inputTokens ?? 0, reply.usage?.outputTokens ?? 0]) if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000) throw new RangeError("a token count is out of bounds");
}

/** Token counts for a reply: the scripted ones, or a rough count (a quarter of the characters) when none was scripted. */
export function replyUsage(reply: ModelReply): { inputTokens: number; outputTokens: number } {
  return { inputTokens: reply.usage?.inputTokens ?? 0, outputTokens: reply.usage?.outputTokens ?? Math.ceil(reply.text.length / 4) };
}

/** A 16-hex-digit id that depends only on the text: two 32-bit FNV-1a passes with different offsets. Not a security function; ids in a scripted reply only have to be stable. */
export function seededId(seed: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0xdeadbeef;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The text in pieces of at most `maxChars` code points (never splitting a surrogate pair), at most `MODEL_STREAM_MAX_CHUNKS` of them: a longer text gets bigger pieces. An empty text is no pieces. */
export function chunkText(text: string, maxChars: number): string[] {
  if (text.length === 0) return [];
  const size = Math.max(1, Math.floor(maxChars), Math.ceil(text.length / MODEL_STREAM_MAX_CHUNKS));
  const pieces: string[] = [];
  let piece = "";
  let count = 0;
  for (const point of text) {
    piece += point;
    count += 1;
    if (count === size) {
      pieces.push(piece);
      piece = "";
      count = 0;
    }
  }
  if (piece.length > 0) pieces.push(piece);
  return pieces;
}

const EOL: Record<SseLineEnding, string> = { lf: "\n", crlf: "\r\n" };

/** One SSE body: each payload as `data: <payload>` and a blank line. The payload must not hold a newline (JSON text never does). */
export function sseBody(payloads: readonly string[], lineEnding: SseLineEnding): string {
  const eol = EOL[lineEnding];
  return payloads.map((payload) => `data: ${payload}${eol}${eol}`).join("");
}

export type ParsedSse = { ok: true; events: string[] } | { ok: false; reason: "too_large" | "missing_space" };

/**
 * The events of an SSE text the way the clients of the redirect check read it: events end at a blank line (`\n\n`, `\r\r` or `\r\n\r\n`), each data line starts with `data:`. `requireSpace` models the Python client,
 * which needs `data: ` WITH the space. Used by the tests and by the helper's own checks; bounded.
 */
export function parseSseText(text: string, options: { requireSpace: boolean }): ParsedSse {
  if (text.length > MODEL_SSE_PARSE_MAX_CHARS) return { ok: false, reason: "too_large" };
  const events: string[] = [];
  for (const block of text.split(/\r\n\r\n|\n\n|\r\r/u)) {
    if (block.length === 0) continue;
    const data: string[] = [];
    for (const line of block.split(/\r\n|\n|\r/u)) {
      if (!line.startsWith("data:")) continue;
      if (options.requireSpace && !line.startsWith("data: ")) return { ok: false, reason: "missing_space" };
      data.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
    }
    if (data.length > 0) events.push(data.join("\n"));
  }
  return { ok: true, events };
}

/** A header map from a request: lowercase names, a value each (the first of an array), own properties only, at most 200 of them. */
export function lowerHeaders(headers: Readonly<Record<string, string | readonly string[] | undefined>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(headers).slice(0, 200)) {
    const first = typeof value === "string" ? value : Array.isArray(value) ? (value as readonly unknown[])[0] : undefined;
    if (typeof first === "string" && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), first.length > 4096 ? first.slice(0, 4096) : first);
  }
  return out;
}

export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

/** The decoded query pairs of a raw query string (a leading `?` is tolerated), or undefined when it is too long, has too many pairs or does not decode. Never builds an object from the keys. */
export function parseQuery(raw: string): Map<string, string> | undefined {
  const text = raw.startsWith("?") ? raw.slice(1) : raw;
  if (text.length > 2048) return undefined;
  const pairs = new Map<string, string>();
  if (text.length === 0) return pairs;
  const parts = text.split("&");
  if (parts.length > 32) return undefined;
  try {
    for (const part of parts) {
      if (part.length === 0) continue;
      const at = part.indexOf("=");
      const key = decodeURIComponent((at < 0 ? part : part.slice(0, at)).replaceAll("+", " "));
      const value = at < 0 ? "" : decodeURIComponent(part.slice(at + 1).replaceAll("+", " "));
      if (!pairs.has(key)) pairs.set(key, value);
    }
  } catch {
    return undefined;
  }
  return pairs;
}
