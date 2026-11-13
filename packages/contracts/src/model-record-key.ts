// TE-F8 (release 0.5.19, additive, no callers): the record key of one model call, and what a request says of itself.
//
// The key is the SHA-256 of the family's CANONICAL request: the row, the operation, the model, whether the call streams, the generation settings, the messages (or contents), the system prompt and the tools; keys sorted at every
// level, so field order never matters. Left out: every credential and every request id (headers are not read at all, except three that change what the provider answers), the query key `key`, and the per-family VOLATILE body
// fields (`user`, a `metadata` block, a cache key: they change per run and never change the answer's meaning). A streaming call and a non-streaming call of the same prompt have different keys.
//
// PURE: no clock, no randomness, no I/O. It never throws: a request it cannot key (not JSON, too deep, a malformed frame) is a refusal word, and an unkeyed request is never recorded or replayed. The record cache (design
// te-f1 section 6, phase A) owns this key: TE-F1-c imports `modelRecordKey` and does not build its own.
import { parseModelEgressFrame, type ModelEgressFrame } from "./model-egress/frame.js";
import type { ModelEgressFamily } from "./model-egress/schemes.js";
import { sha256HexOf } from "./service-catalog-verify.js";

export const MODEL_RECORD_KEY_VERSION = 1;
/** The deepest JSON nesting the key reads; a body nested deeper is `too_deep` (never a stack overflow). */
export const MODEL_RECORD_DEPTH_MAX = 64;
/** The most text segments one request yields for prompt matching (the rest are not matched: a request with more is matched on the first ones only). */
export const MODEL_RECORD_SEGMENTS_MAX = 2000;
/** The longest single text segment that is fingerprinted. */
export const MODEL_RECORD_SEGMENT_CHARS_MAX = 1024 * 1024;

export const MODEL_RECORD_KEY_REFUSALS = ["bad_frame", "body_not_json", "too_deep"] as const;
export type ModelRecordKeyRefusal = (typeof MODEL_RECORD_KEY_REFUSALS)[number];

/** Body fields that differ per run and never change what the call means, per family. Top level only. */
export const MODEL_RECORD_VOLATILE_FIELDS: Readonly<Record<ModelEgressFamily, readonly string[]>> = {
  openai_compatible: ["user", "metadata", "safety_identifier", "prompt_cache_key", "service_tier", "store", "request_id"],
  anthropic_messages: ["metadata", "service_tier", "request_id"],
  gemini: ["labels", "request_id"],
  vertex: ["labels", "request_id"],
  cohere: ["request_id"],
  bedrock: ["request_id"],
};

/** The request headers that change what a provider answers, so they are part of the key. Every other header (credentials, request ids, user agents, SDK versions) is ignored. */
export const MODEL_RECORD_KEPT_HEADERS = ["anthropic-beta", "anthropic-version", "openai-beta"] as const;

export interface ModelRequestView {
  readonly family: ModelEgressFamily;
  readonly row: string;
  /** The path with its version segment and any project or location left out: `chat/completions`, `messages`, `<model>:generateContent`. */
  readonly operation: string;
  readonly model: string | undefined;
  readonly streaming: boolean;
  /** The kept query pairs (`alt`, `$alt` as `alt`, `api-version`), sorted. */
  readonly query: ReadonlyArray<readonly [string, string]>;
  /** The kept headers, lower-cased names, sorted. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** The parsed JSON body (an object). */
  readonly body: Readonly<Record<string, unknown>>;
}

export type ModelRequestRead = { readonly ok: true; readonly view: ModelRequestView } | { readonly ok: false; readonly reason: ModelRecordKeyRefusal };

const VERSION_SEGMENT = /^v\d{1,3}(?:[a-z]{1,8}\d{0,3})?$/u;
const GEMINI_OPERATION = /(?:^|\/)models\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([A-Za-z]{1,40})$/u;

/** The family a path belongs to, when the caller does not say: Gemini and Vertex paths name a model and an operation; the rest are told apart by their tail. */
function inferFamily(path: string): ModelEgressFamily {
  if (GEMINI_OPERATION.test(path)) return path.includes("/publishers/") ? "vertex" : "gemini";
  if (/(?:^|\/)messages(?:\/count_tokens)?$/u.test(path)) return "anthropic_messages";
  if (/^\/v[12]\/(?:chat|embed|rerank)$/u.test(path)) return "cohere";
  return "openai_compatible";
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads the frame and its JSON body. Never throws. */
export function readModelRequest(input: unknown, options: { readonly family?: ModelEgressFamily } = {}): ModelRequestRead {
  const parsed = parseModelEgressFrame(input);
  if (!parsed.ok) return { ok: false, reason: "bad_frame" };
  const frame: ModelEgressFrame = parsed.frame;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.body)) as unknown;
  } catch {
    return { ok: false, reason: "body_not_json" };
  }
  if (!isRecord(body)) return { ok: false, reason: "body_not_json" };
  const family = options.family ?? inferFamily(frame.path);
  const segments = frame.path.split("/").filter((segment) => segment !== "");
  const stripped = segments[0] !== undefined && VERSION_SEGMENT.test(segments[0]) ? segments.slice(1) : segments;
  let operation = stripped.join("/");
  let model: string | undefined;
  let streaming: boolean;
  const gemini = GEMINI_OPERATION.exec(frame.path);
  if (gemini !== null && (family === "gemini" || family === "vertex")) {
    model = gemini[1];
    operation = `${gemini[1] as string}:${gemini[2] as string}`;
    streaming = (gemini[2] as string).startsWith("stream");
  } else {
    model = typeof body.model === "string" ? body.model : undefined;
    streaming = body.stream === true;
  }
  const query: Array<readonly [string, string]> = [];
  for (const part of frame.query.split("&")) {
    if (part === "") continue;
    const equals = part.indexOf("=");
    const rawName = equals === -1 ? part : part.slice(0, equals);
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return { ok: false, reason: "bad_frame" };
    }
    if (name.toLowerCase() === "key") continue;
    query.push([name === "$alt" ? "alt" : name, equals === -1 ? "" : part.slice(equals + 1)]);
  }
  query.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0));
  const kept = new Map<string, string>();
  for (const [name, value] of frame.headers) {
    const lower = name.toLowerCase();
    if ((MODEL_RECORD_KEPT_HEADERS as readonly string[]).includes(lower) && !kept.has(lower)) kept.set(lower, value.trim());
  }
  const headers = [...kept.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1));
  return { ok: true, view: { family, row: frame.row, operation, model, streaming, query, headers, body } };
}

class TooDeep extends Error {}

/** JSON text with keys sorted at every level and no whitespace; `undefined` members dropped. Bounded depth; iterative on arrays is not needed at 64 levels. */
function canonical(value: unknown, depth: number): string {
  if (depth > MODEL_RECORD_DEPTH_MAX) throw new TooDeep();
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item === undefined ? null : item, depth + 1)).join(",")}]`;
  if (isRecord(value)) {
    const parts: string[] = [];
    for (const name of Object.keys(value).sort()) {
      const held = value[name];
      if (held !== undefined) parts.push(`${JSON.stringify(name)}:${canonical(held, depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export type ModelRecordKeyResult =
  | { readonly ok: true; readonly key: string; readonly view: ModelRequestView }
  | { readonly ok: false; readonly reason: ModelRecordKeyRefusal };

/** The key of an already-read request. Never throws. */
export function modelRecordKeyOfView(view: ModelRequestView): { readonly ok: true; readonly key: string } | { readonly ok: false; readonly reason: "too_deep" } {
  const volatile = new Set(MODEL_RECORD_VOLATILE_FIELDS[view.family]);
  const kept: Record<string, unknown> = {};
  for (const name of Object.keys(view.body)) {
    if (volatile.has(name)) continue;
    Object.defineProperty(kept, name, { value: view.body[name], enumerable: true, configurable: true, writable: true });
  }
  try {
    const text = canonical(["rovara.model-record-key.v1", view.family, view.row, view.operation, view.model ?? null, view.streaming, view.query, view.headers, kept], 0);
    return { ok: true, key: sha256HexOf(new TextEncoder().encode(text)) };
  } catch {
    return { ok: false, reason: "too_deep" };
  }
}

/**
 * THE record key: 64 lower-case hex characters. `family` is inferred from the path unless the caller says (a caller that has the catalog row passes its family). Never throws; never echoes the frame.
 */
export function modelRecordKey(frame: unknown, options: { readonly family?: ModelEgressFamily } = {}): ModelRecordKeyResult {
  const read = readModelRequest(frame, options);
  if (!read.ok) return read;
  const keyed = modelRecordKeyOfView(read.view);
  return keyed.ok ? { ok: true, key: keyed.key, view: read.view } : keyed;
}

export const MODEL_RECORD_KEY_PATTERN = /^[a-f0-9]{64}$/u;

export interface ModelPromptSegments {
  /** Text of system and developer messages, `system`, `instructions`, `systemInstruction`, `preamble`. */
  readonly system: readonly string[];
  /** Text of every other message and prompt field. */
  readonly prompt: readonly string[];
}

/**
 * The text segments of a request, for matching against F4's fingerprints: every string content and every text part on its own, and the joined text of a message with several parts. Bounded in count, length and depth;
 * never throws; a request in a shape it does not know yields no segments (which matches no changed prompt: fail closed on money).
 */
export function modelPromptSegments(view: ModelRequestView): ModelPromptSegments {
  const system: string[] = [];
  const prompt: string[] = [];
  const full = (): boolean => system.length + prompt.length >= MODEL_RECORD_SEGMENTS_MAX;
  const add = (into: string[], text: string): void => {
    if (text !== "" && text.length <= MODEL_RECORD_SEGMENT_CHARS_MAX && !full()) into.push(text);
  };
  /** The text leaves of a content value (a string, a part, or a list of parts), in order. */
  const leaves = (value: unknown, depth: number, found: string[]): void => {
    if (depth > 8 || found.length >= 256) return;
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) for (const item of value) leaves(item, depth + 1, found);
    else if (isRecord(value)) {
      if (typeof value.text === "string") found.push(value.text);
      else if (value.content !== undefined) leaves(value.content, depth + 1, found);
      else if (value.parts !== undefined) leaves(value.parts, depth + 1, found);
    }
  };
  const addContent = (into: string[], value: unknown): void => {
    const found: string[] = [];
    leaves(value, 0, found);
    for (const text of found) add(into, text);
    if (found.length > 1) add(into, found.join(" "));
  };
  const body = view.body;
  for (const name of ["system", "instructions", "systemInstruction", "system_instruction", "preamble"]) if (body[name] !== undefined) addContent(system, body[name]);
  for (const name of ["messages", "contents", "input"]) {
    const held = body[name];
    for (const message of Array.isArray(held) ? held : held === undefined ? [] : [held]) {
      if (isRecord(message) && (message.role === "system" || message.role === "developer")) addContent(system, message.content ?? message.parts);
      else if (isRecord(message)) addContent(prompt, message.content ?? message.parts ?? message.text);
      else addContent(prompt, message);
    }
  }
  for (const name of ["prompt", "message"]) if (typeof body[name] === "string") add(prompt, body[name]);
  return { system, prompt };
}
