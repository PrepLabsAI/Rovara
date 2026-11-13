// TE-F0a: the OpenAI-compatible family: the operation router and the chat-completion builders (JSON, and SSE ending in `data: [DONE]`). It serves every row of that family (Gemini's OpenAI endpoint, OpenRouter, Vercel,
// Cloudflare, Portkey, a company's LiteLLM): a new provider here is a data row, not code. PURE: no Node module, no socket, no clock, no randomness.
import { MODEL_ECHO_PATTERN, assertReplyBounds, chunkText, replyUsage, seededId, sseBody, type ModelFinish, type ModelReply, type SseLineEnding } from "./model-family-common.js";

export const OPENAI_OPERATIONS = ["chat_completions", "embeddings", "responses", "models"] as const;
export type OpenAiOperation = (typeof OPENAI_OPERATIONS)[number];

/** The operation a path tail names (`chat/completions`, `embeddings`, `responses`, `models`), or undefined. The tail has no version and no prefix. */
export function openAiOperationOfTail(tail: string): OpenAiOperation | undefined {
  switch (tail) {
    case "chat/completions":
      return "chat_completions";
    case "embeddings":
    case "responses":
    case "models":
      return tail;
    default:
      return undefined;
  }
}

export type OpenAiRouteResult = { ok: true; operation: OpenAiOperation } | { ok: false; reason: "method_not_allowed" | "bad_path" | "unsupported_path" | "too_large" };
const LEADING_SEGMENT = /^[A-Za-z0-9._~-]{1,64}$/u;
const LEADING_SEGMENTS_MAX = 6;

/**
 * The operation of an OpenAI-compatible request. The row's `pathPrefix` (the provider's own, like `/v1beta/openai`) is stripped when present. The operation is the END of the path (`chat/completions`, `embeddings`,
 * `responses`, `models`); what comes before it (a version, a Cloudflare `/v1/<account>/<gateway>/openai`, an Azure `/openai/deployments/<name>`) is at most six plain segments and is not looked at, because the client's base
 * URL decides it. `models` is a GET; every other operation is a POST.
 */
export function routeOpenAiCompatibleRequest(request: { method: string; path: string; pathPrefix: string | undefined }): OpenAiRouteResult {
  const path = request.path;
  if (typeof path !== "string" || path.length > 512) return { ok: false, reason: "too_large" };
  if (!path.startsWith("/") || !/^[A-Za-z0-9._~/-]+$/u.test(path)) return { ok: false, reason: "bad_path" };
  let rest = path;
  const prefix = request.pathPrefix;
  if (prefix !== undefined && (rest === prefix || rest.startsWith(`${prefix}/`))) rest = rest.slice(prefix.length);
  const segments = rest.split("/").slice(1);
  if (segments.some((segment) => segment === "" || /^\.+$/u.test(segment))) return { ok: false, reason: "bad_path" };
  const last = segments[segments.length - 1];
  const chat = last === "completions" && segments[segments.length - 2] === "chat";
  const operation = chat ? "chat_completions" : last === undefined ? undefined : openAiOperationOfTail(last);
  if (operation === undefined || (operation === "chat_completions" && !chat)) return { ok: false, reason: "unsupported_path" };
  const leading = segments.slice(0, segments.length - (chat ? 2 : 1));
  if (leading.length > LEADING_SEGMENTS_MAX || leading.some((segment) => !LEADING_SEGMENT.test(segment))) return { ok: false, reason: "unsupported_path" };
  if (typeof request.method !== "string" || request.method.toUpperCase() !== (operation === "models" ? "GET" : "POST")) return { ok: false, reason: "method_not_allowed" };
  return { ok: true, operation };
}

const FINISH: Record<ModelFinish, string> = { stop: "stop", length: "length", safety: "content_filter", tool_calls: "tool_calls", other: "stop" };

export interface OpenAiBuildOptions {
  readonly model: string;
  readonly seed: string;
  /** `created` is a passed-in number (this code has no clock). */
  readonly created: number;
  readonly chunkChars?: number;
}
const toolCalls = (reply: ModelReply, seed: string) =>
  (reply.toolCalls ?? []).map((call, index) => ({ id: `call_${seededId(`${seed}:${String(index)}:${call.name}`)}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }));

/** One `chat.completion` object. */
export function buildChatCompletion(reply: ModelReply, options: OpenAiBuildOptions): Record<string, unknown> {
  assertReplyBounds(reply, options.model);
  const usage = replyUsage(reply);
  const calls = toolCalls(reply, options.seed);
  return {
    id: `chatcmpl-${seededId(options.seed)}`,
    object: "chat.completion",
    created: options.created,
    model: options.model,
    choices: [{ index: 0, message: { role: "assistant", content: reply.text.length > 0 || calls.length === 0 ? reply.text : null, ...(calls.length > 0 ? { tool_calls: calls } : {}) }, finish_reason: FINISH[reply.finish] }],
    usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens },
  };
}

/** A streamed answer: a role chunk, the text pieces, the last chunk with the finish reason, then `data: [DONE]`. */
export function buildChatCompletionStream(reply: ModelReply, options: OpenAiBuildOptions, lineEnding: SseLineEnding): string {
  assertReplyBounds(reply, options.model);
  const id = `chatcmpl-${seededId(options.seed)}`;
  const chunk = (delta: Record<string, unknown>, finish: string | null) => JSON.stringify({ id, object: "chat.completion.chunk", created: options.created, model: options.model, choices: [{ index: 0, delta, finish_reason: finish }] });
  const calls = toolCalls(reply, options.seed).map((call, index) => ({ index, ...call }));
  const payloads = [
    chunk({ role: "assistant", content: "" }, null),
    ...chunkText(reply.text, options.chunkChars ?? 32).map((piece) => chunk({ content: piece }, null)),
    ...(calls.length > 0 ? [chunk({ tool_calls: calls }, null)] : []),
    chunk({}, FINISH[reply.finish]),
    "[DONE]",
  ];
  return sseBody(payloads, lineEnding);
}

/** A model name from a request body that is safe to put in an answer: a plain name, or `unknown-model`. */
export function echoableModelName(candidate: unknown): string {
  return typeof candidate === "string" && MODEL_ECHO_PATTERN.test(candidate) ? candidate : "unknown-model";
}
