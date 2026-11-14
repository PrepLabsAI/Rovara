// TE-F2 part A: the Anthropic Messages family: the request router (`/v1/messages`, `/v1/messages/count_tokens`) and the response builders: a whole `message`, the named-event stream (`message_start`, `content_block_start`,
// `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`), the token count and the error envelope.
//
// Shapes are from Anthropic's public API reference and streaming guide (https://docs.anthropic.com/en/api/messages, https://docs.anthropic.com/en/api/messages-streaming, https://docs.anthropic.com/en/api/messages-count-tokens,
// https://docs.anthropic.com/en/api/errors), written from the docs WITHOUT a network in this lane. The Node SDK in the repo's node_modules (`@anthropic-ai/sdk`) parses the bodies in this lane's loopback check; the Python
// SDK was not run. Anything finer than that is UNVERIFIED:
//   UNVERIFIED: the `usage` object's extra fields (cache creation and read tokens are sent as 0; `service_tier` is not sent).
//   UNVERIFIED: whether the SDKs need the `ping` event (it is sent once, after `content_block_start`, as the docs show).
//   UNVERIFIED: `stop_reason: "refusal"` on a streamed answer (the docs list `refusal` as a stop reason; no client was run against it).
//   UNVERIFIED: the Batches API, the Files API and the Models list are not served.
// The SDK adds `?beta=true` for its beta namespace: the router reads the path only. PURE: no Node module, no socket, no clock, no randomness (ids come from the seed).
import { assertReplyBounds, chunkText, replyUsage, seededId, type ModelFinish, type ModelReply, type SseLineEnding } from "./model-family-common.js";
import { sseNamedBody, type NamedSseEvent } from "./model-sse-named.js";

export const ANTHROPIC_OPERATIONS = ["messages", "count_tokens"] as const;
export type AnthropicOperation = (typeof ANTHROPIC_OPERATIONS)[number];
export type AnthropicRouteResult = { ok: true; operation: AnthropicOperation } | { ok: false; reason: "method_not_allowed" | "bad_path" | "unsupported_path" | "too_large" };

const LEADING_SEGMENT = /^[A-Za-z0-9._~-]{1,64}$/u;
const LEADING_SEGMENTS_MAX = 6;

/**
 * The operation of an Anthropic request: the END of the path is `messages` or `messages/count_tokens`. The row's `pathPrefix` (`/v1`, or a gateway's own) is stripped when present; what comes before the operation (a version,
 * a gateway's segments) is at most six plain segments and is not looked at, because the client's base URL decides it (the same rule as F0a's OpenAI router). Both operations are POST. Never throws; looks at the length first.
 */
export function routeAnthropicRequest(request: { method: string; path: string; pathPrefix: string | undefined }): AnthropicRouteResult {
  const path = request.path;
  if (typeof path !== "string" || path.length > 512) return { ok: false, reason: "too_large" };
  if (!path.startsWith("/") || !/^[A-Za-z0-9._~/-]+$/u.test(path)) return { ok: false, reason: "bad_path" };
  let rest = path;
  const prefix = request.pathPrefix;
  if (prefix !== undefined && (rest === prefix || rest.startsWith(`${prefix}/`))) rest = rest.slice(prefix.length);
  const segments = rest.split("/").slice(1);
  if (segments.some((segment) => segment === "" || /^\.+$/u.test(segment))) return { ok: false, reason: "bad_path" };
  const last = segments[segments.length - 1];
  const count = last === "count_tokens" && segments[segments.length - 2] === "messages";
  const operation: AnthropicOperation | undefined = count ? "count_tokens" : last === "messages" ? "messages" : undefined;
  if (operation === undefined) return { ok: false, reason: "unsupported_path" };
  const leading = segments.slice(0, segments.length - (count ? 2 : 1));
  if (leading.length > LEADING_SEGMENTS_MAX || leading.some((segment) => !LEADING_SEGMENT.test(segment))) return { ok: false, reason: "unsupported_path" };
  if (typeof request.method !== "string" || request.method.toUpperCase() !== "POST") return { ok: false, reason: "method_not_allowed" };
  return { ok: true, operation };
}

export interface AnthropicBuildOptions {
  readonly model: string;
  readonly seed: string;
  readonly chunkChars?: number;
}

type JsonObject = Record<string, unknown>;

const STOP_REASON: Record<ModelFinish, string> = { stop: "end_turn", length: "max_tokens", safety: "refusal", tool_calls: "tool_use", other: "end_turn" };
/** The stop reason of a reply: its own, except that a reply with tool calls that ended normally stops for `tool_use`. */
export function anthropicStopReason(reply: ModelReply): string {
  const calls = (reply.toolCalls ?? []).length > 0;
  return calls && (reply.finish === "stop" || reply.finish === "other" || reply.finish === "tool_calls") ? "tool_use" : STOP_REASON[reply.finish];
}

const messageId = (seed: string): string => `msg_01${seededId(seed)}`;
const toolId = (seed: string, index: number, name: string): string => `toolu_01${seededId(`${seed}:${String(index)}:${name}`)}`;

function usageOf(reply: ModelReply): { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } {
  const usage = replyUsage(reply);
  return { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

/** One `message` (the whole body of a non-streamed `POST /v1/messages`): a text block when there is text (or no tool call), then one `tool_use` block per tool call. */
export function buildAnthropicMessage(reply: ModelReply, options: AnthropicBuildOptions): JsonObject {
  assertReplyBounds(reply, options.model);
  const calls = reply.toolCalls ?? [];
  const content: JsonObject[] = [
    ...(reply.text.length > 0 || calls.length === 0 ? [{ type: "text", text: reply.text }] : []),
    ...calls.map((call, index) => ({ type: "tool_use", id: toolId(options.seed, index, call.name), name: call.name, input: call.args })),
  ];
  return { id: messageId(options.seed), type: "message", role: "assistant", model: options.model, content, stop_reason: anthropicStopReason(reply), stop_sequence: null, usage: usageOf(reply) };
}

/**
 * The events of a streamed answer, in the documented order: `message_start`, `content_block_start`, one `ping`, the `content_block_delta`s, `content_block_stop`, the tool blocks the same way (the arguments as
 * `input_json_delta` pieces), `message_delta` with the stop reason and the output tokens, `message_stop`.
 */
export function buildAnthropicMessageStreamEvents(reply: ModelReply, options: AnthropicBuildOptions): NamedSseEvent[] {
  assertReplyBounds(reply, options.model);
  const usage = usageOf(reply);
  const events: NamedSseEvent[] = [];
  const push = (event: string, body: JsonObject): void => {
    events.push({ event, data: JSON.stringify({ type: event, ...body }) });
  };
  const calls = reply.toolCalls ?? [];
  push("message_start", { message: { id: messageId(options.seed), type: "message", role: "assistant", model: options.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
  let index = 0;
  if (reply.text.length > 0 || calls.length === 0) {
    push("content_block_start", { index, content_block: { type: "text", text: "" } });
    push("ping", {});
    for (const piece of chunkText(reply.text, options.chunkChars ?? 32)) push("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
    push("content_block_stop", { index });
    index += 1;
  }
  calls.forEach((call, callIndex) => {
    push("content_block_start", { index, content_block: { type: "tool_use", id: toolId(options.seed, callIndex, call.name), name: call.name, input: {} } });
    if (reply.text.length === 0 && callIndex === 0) push("ping", {});
    for (const piece of chunkText(JSON.stringify(call.args), options.chunkChars ?? 32)) push("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: piece } });
    push("content_block_stop", { index });
    index += 1;
  });
  push("message_delta", { delta: { stop_reason: anthropicStopReason(reply), stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  push("message_stop", {});
  return events;
}

/** The SSE text of a streamed answer: `event: <name>`, `data: <json>`, a blank line after each. It ends with `message_stop`. */
export function anthropicStreamBody(events: readonly NamedSseEvent[], lineEnding: SseLineEnding): string {
  return sseNamedBody(events, lineEnding);
}

/** The body of `POST /v1/messages/count_tokens`. */
export function buildAnthropicCountTokens(inputTokens: number): JsonObject {
  return { input_tokens: Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : 0 };
}

export const ANTHROPIC_ERROR_TYPES = ["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "request_too_large", "rate_limit_error", "api_error", "overloaded_error"] as const;
export type AnthropicErrorType = (typeof ANTHROPIC_ERROR_TYPES)[number];

/** The error envelope: `{"type":"error","error":{"type":<type>,"message":<message>}}`. */
export function anthropicErrorBody(type: AnthropicErrorType, message: string): JsonObject {
  return { type: "error", error: { type, message } };
}
