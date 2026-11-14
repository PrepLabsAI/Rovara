// TE-F2 part A: the Cohere family (v2): the request router (`/v2/chat`, `/v2/embed`, `/v2/rerank`) and the response builders: a chat answer, the named-event stream, embeddings by type, rerank results, the error envelope.
//
// Shapes are from Cohere's public API reference (https://docs.cohere.com/reference/chat, https://docs.cohere.com/reference/chat-stream, https://docs.cohere.com/reference/embed, https://docs.cohere.com/reference/rerank),
// written from the docs WITHOUT a network in this lane, and the Cohere SDK is not installed here, so NOTHING in this file was parsed by a Cohere client: the whole family is UNVERIFIED against its SDK. Specifically:
//   UNVERIFIED: the stream's event names and payload shapes (`message-start`, `content-start`, `content-delta`, `content-end`, `tool-plan-delta`, `tool-call-start`, `tool-call-delta`, `tool-call-end`, `message-end`), and
//               whether the stream carries `event:` lines or only `data:` lines with a `type` field (both are written; the `type` field is what the docs show).
//   UNVERIFIED: finish reasons: `COMPLETE`, `MAX_TOKENS`, `TOOL_CALL` are documented; `ERROR` for a scripted `safety` finish is a guess (Cohere documents no refusal marker).
//   UNVERIFIED: the error body (`{"message": "..."}`) and the 429 text.
//   UNVERIFIED: embedding types other than `float` (`int8`, `uint8`, `binary`, `ubinary`, `base64`) are filler of the right shape only.
//   UNVERIFIED: v1 (`/v1/chat`, `/v1/embed`, `/v1/rerank`) answers differently and is not served.
// PURE: no Node module, no socket, no clock, no randomness (ids come from the seed).
import { assertReplyBounds, chunkText, replyUsage, seededId, type ModelFinish, type ModelReply, type SseLineEnding } from "./model-family-common.js";
import { sseNamedBody, type NamedSseEvent } from "./model-sse-named.js";
import { VECTOR_MAX_DIMENSIONS, VECTOR_MAX_ITEMS, float32Base64, quantized, seededVector } from "./model-family-vectors.js";

export const COHERE_OPERATIONS = ["chat", "embed", "rerank"] as const;
export type CohereOperation = (typeof COHERE_OPERATIONS)[number];
export type CohereRouteResult = { ok: true; operation: CohereOperation } | { ok: false; reason: "method_not_allowed" | "bad_path" | "unsupported_path" | "too_large" };

const LEADING_SEGMENT = /^[A-Za-z0-9._~-]{1,64}$/u;
const LEADING_SEGMENTS_MAX = 6;

/** Chat v2, embed and rerank: the path ENDS in `v2/<operation>`. The row's `pathPrefix` (a gateway's own) is stripped first; what comes before `v2` is at most six plain segments and is not looked at. All three are POST. */
export function routeCohereRequest(request: { method: string; path: string; pathPrefix: string | undefined }): CohereRouteResult {
  const path = request.path;
  if (typeof path !== "string" || path.length > 512) return { ok: false, reason: "too_large" };
  if (!path.startsWith("/") || !/^[A-Za-z0-9._~/-]+$/u.test(path)) return { ok: false, reason: "bad_path" };
  let rest = path;
  const prefix = request.pathPrefix;
  if (prefix !== undefined && (rest === prefix || rest.startsWith(`${prefix}/`))) rest = rest.slice(prefix.length);
  const segments = rest.split("/").slice(1);
  if (segments.some((segment) => segment === "" || /^\.+$/u.test(segment))) return { ok: false, reason: "bad_path" };
  const name = segments[segments.length - 1];
  const operation = segments[segments.length - 2] === "v2" && (COHERE_OPERATIONS as readonly (string | undefined)[]).includes(name) ? (name as CohereOperation) : undefined;
  if (operation === undefined) return { ok: false, reason: "unsupported_path" };
  const leading = segments.slice(0, -2);
  if (leading.length > LEADING_SEGMENTS_MAX || leading.some((segment) => !LEADING_SEGMENT.test(segment))) return { ok: false, reason: "unsupported_path" };
  if (typeof request.method !== "string" || request.method.toUpperCase() !== "POST") return { ok: false, reason: "method_not_allowed" };
  return { ok: true, operation };
}

export interface CohereBuildOptions {
  readonly model: string;
  readonly seed: string;
  readonly chunkChars?: number;
}
type JsonObject = Record<string, unknown>;

const FINISH: Record<ModelFinish, string> = { stop: "COMPLETE", length: "MAX_TOKENS", safety: "ERROR", tool_calls: "TOOL_CALL", other: "COMPLETE" };
/** The finish reason of a reply: its own, except that a reply with tool calls that ended normally is `TOOL_CALL`. */
export function cohereFinishReason(reply: ModelReply): string {
  const calls = (reply.toolCalls ?? []).length > 0;
  return calls && (reply.finish === "stop" || reply.finish === "other" || reply.finish === "tool_calls") ? "TOOL_CALL" : FINISH[reply.finish];
}

const responseId = (seed: string): string => {
  const hex = seededId(seed) + seededId(`${seed}:2`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const callId = (seed: string, index: number, name: string): string => `${name.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 40)}_${seededId(`${seed}:${String(index)}:${name}`).slice(0, 12)}`;
const toolCalls = (reply: ModelReply, seed: string) => (reply.toolCalls ?? []).map((call, index) => ({ id: callId(seed, index, call.name), type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }));

function usageOf(reply: ModelReply): JsonObject {
  const usage = replyUsage(reply);
  return { billed_units: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }, tokens: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } };
}

/** One v2 chat answer: `finish_reason`, a `message` with text content (or a `tool_plan` and `tool_calls` when the reply calls tools) and `usage`. */
export function buildCohereChat(reply: ModelReply, options: CohereBuildOptions): JsonObject {
  assertReplyBounds(reply, options.model);
  const calls = toolCalls(reply, options.seed);
  const message: JsonObject = calls.length > 0 ? { role: "assistant", tool_plan: reply.text, tool_calls: calls } : { role: "assistant", content: [{ type: "text", text: reply.text }] };
  return { id: responseId(options.seed), finish_reason: cohereFinishReason(reply), message, usage: usageOf(reply) };
}

/** The events of a streamed chat answer, in the documented order, ending with `message-end` that carries the finish reason and usage. */
export function buildCohereChatStreamEvents(reply: ModelReply, options: CohereBuildOptions): NamedSseEvent[] {
  assertReplyBounds(reply, options.model);
  const events: NamedSseEvent[] = [];
  const push = (type: string, body: JsonObject): void => {
    events.push({ event: type, data: JSON.stringify({ type, ...body }) });
  };
  const calls = toolCalls(reply, options.seed);
  push("message-start", { id: responseId(options.seed), delta: { message: { role: "assistant", content: [], tool_plan: "", tool_calls: [], citations: [] } } });
  if (calls.length > 0) {
    for (const piece of chunkText(reply.text, options.chunkChars ?? 32)) push("tool-plan-delta", { delta: { message: { tool_plan: piece } } });
    calls.forEach((call, index) => {
      push("tool-call-start", { index, delta: { message: { tool_calls: { id: call.id, type: "function", function: { name: call.function.name, arguments: "" } } } } });
      for (const piece of chunkText(call.function.arguments, options.chunkChars ?? 32)) push("tool-call-delta", { index, delta: { message: { tool_calls: { function: { arguments: piece } } } } });
      push("tool-call-end", { index });
    });
  } else {
    push("content-start", { index: 0, delta: { message: { content: { type: "text", text: "" } } } });
    for (const piece of chunkText(reply.text, options.chunkChars ?? 32)) push("content-delta", { index: 0, delta: { message: { content: { text: piece } } } });
    push("content-end", { index: 0 });
  }
  push("message-end", { delta: { finish_reason: cohereFinishReason(reply), usage: usageOf(reply) } });
  return events;
}

/** The SSE text of a streamed chat answer: `event: <type>`, `data: <json>`, a blank line after each. */
export function cohereStreamBody(events: readonly NamedSseEvent[], lineEnding: SseLineEnding): string {
  return sseNamedBody(events, lineEnding);
}

export const COHERE_EMBEDDING_TYPES = ["float", "int8", "uint8", "binary", "ubinary", "base64"] as const;
export type CohereEmbeddingType = (typeof COHERE_EMBEDDING_TYPES)[number];
export const COHERE_EMBEDDING_DEFAULT_DIMENSIONS = 1024;

export interface CohereEmbedOptions {
  readonly seed: string;
  /** The texts in the request (1 to 2,048; Cohere takes at most 96, which is not enforced here). */
  readonly textCount: number;
  readonly dimensions: number | undefined;
  /** The requested `embedding_types`; empty means `float`. Types this builder does not know are dropped. */
  readonly types: readonly string[];
  readonly inputTokens: number;
}

/** An `embeddings_by_type` answer: one list per requested type, one vector per text (seeded filler). */
export function buildCohereEmbed(options: CohereEmbedOptions): JsonObject {
  const count = Math.min(VECTOR_MAX_ITEMS, Math.max(1, Math.trunc(options.textCount)));
  const dimensions = Math.min(VECTOR_MAX_DIMENSIONS, Math.max(1, Math.trunc(options.dimensions ?? COHERE_EMBEDDING_DEFAULT_DIMENSIONS)));
  const known = [...new Set(options.types.filter((type): type is CohereEmbeddingType => (COHERE_EMBEDDING_TYPES as readonly string[]).includes(type)))];
  const types: CohereEmbeddingType[] = known.length > 0 ? known : ["float"];
  const vectors = Array.from({ length: count }, (_, index) => seededVector(`${options.seed}:embed:${String(index)}`, dimensions));
  const embeddings: JsonObject = {};
  for (const type of types) {
    const render = (values: readonly number[]): unknown => {
      switch (type) {
        case "float":
          return values;
        case "int8":
        case "uint8":
          return quantized(values, type);
        case "binary":
          return quantized(values.slice(0, Math.ceil(values.length / 8)), "int8");
        case "ubinary":
          return quantized(values.slice(0, Math.ceil(values.length / 8)), "uint8");
        case "base64":
          return float32Base64(values);
      }
    };
    Object.defineProperty(embeddings, type, { value: vectors.map(render), enumerable: true, writable: true, configurable: true });
  }
  const tokens = Number.isSafeInteger(options.inputTokens) && options.inputTokens >= 0 ? options.inputTokens : 0;
  return { id: responseId(options.seed), embeddings, texts: [], meta: { api_version: { version: "2" }, billed_units: { input_tokens: tokens } }, response_type: "embeddings_by_type" };
}

export interface CohereRerankOptions {
  readonly seed: string;
  readonly documentCount: number;
  /** `top_n`; undefined returns every document. */
  readonly topN: number | undefined;
}

/** Rerank results, best first: the documents in order with falling scores (document 0 scores highest), cut to `top_n`. Filler that depends only on the counts. */
export function buildCohereRerank(options: CohereRerankOptions): JsonObject {
  const total = Math.min(VECTOR_MAX_ITEMS, Math.max(0, Math.trunc(options.documentCount)));
  const keep = options.topN === undefined ? total : Math.min(total, Math.max(0, Math.trunc(options.topN)));
  const results = Array.from({ length: keep }, (_, index) => ({ index, relevance_score: Math.round((0.99 - index * (0.9 / Math.max(1, total))) * 1_000_000) / 1_000_000 }));
  return { id: responseId(options.seed), results, meta: { api_version: { version: "2" }, billed_units: { search_units: 1 } } };
}

/** The error body: `{"message": <message>}`. UNVERIFIED against the SDK's error parsing. */
export function cohereErrorBody(message: string): JsonObject {
  return { message };
}
