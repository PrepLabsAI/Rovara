// TE-F2 part A (M2, release 0.5.19; DECISIONS 158, 161): the failure pack. Five ways a model call fails, in each served family's own shape, so a test can check the customer's code handles them. It fills the `errors` shape ids
// that F0a's rows name (`<family>.rate_limit`, `.token_limit`, `.refusal`, `.bad_tool_json`, `.cut_off_stream`).
//
// THE FAILURE PACK NEVER PROVES ANYTHING (DECISIONS 161): its result class is `failure_pack`, `replyCountsTowardProof` is false for it, and a test pins that. It informs ("handled" or "not handled"); it never makes a change
// "proven with scripted AI replies". It also never reads the project's reply set: its text is fixed here, so a customer cannot make a failure count by scripting it.
//
// The five modes (shapes are from the vendors' public docs, written without a network; anything not checked is UNVERIFIED in the row notes below and in the family files):
//   rate_limit      429 in the family's error envelope with `retry-after`. OpenAI `rate_limit_exceeded`, Anthropic `rate_limit_error`, Gemini `RESOURCE_EXHAUSTED`. F1-a's `rate_limit` class reads the same 429 status and
//                   body shapes (its branch was not pushed when this was written: the shapes follow the vendors' docs and are listed in the report for F1-a to compare).
//   cut_off_stream  the stream ends in the middle of an event with no finish marker (no `[DONE]`, no `message_stop`, no `finishReason`, no `message-end`); the JSON-array form is left unclosed; a call that did not ask for a
//                   stream gets a JSON body cut in half.
//   token_limit     `output`: a complete answer with the family's length stop (`finish_reason: "length"`, `stop_reason: "max_tokens"`, `finishReason: "MAX_TOKENS"`, `MAX_TOKENS`); `input`: the input-too-long 400.
//   refusal         OpenAI `refusal` (or `content_filter`), Anthropic `stop_reason: "refusal"`, Gemini `finishReason: "SAFETY"` (or `promptFeedback.blockReason`). Cohere documents no refusal marker: its answer is a refusal
//                   sentence with `COMPLETE` (UNVERIFIED).
//   bad_tool_json   a tool call whose arguments break the declared schema: OpenAI and Cohere send an unterminated JSON string (does not parse); Anthropic's stream sends an unterminated `partial_json` (the SDK's partial parser
//                   yields an object that does not match the schema, it is not a parse error); Gemini `args` and Anthropic's whole `input` are an OBJECT with the wrong keys and types.
// `afterCalls` (the first n calls succeed from the reply set, then the failure starts) is counted by `model-serve-replies.ts`. PURE: no Node module, no socket, no clock, no randomness.
import { z } from "zod";
import { sseBody, seededId, type ModelReply, type SseLineEnding } from "./model-family-common.js";
import { buildChatCompletion } from "./model-family-openai.js";
import { buildOpenAiResponse, openAiResponseStreamBody } from "./model-family-openai-ops.js";
import { anthropicErrorBody } from "./model-family-anthropic.js";
import { cohereErrorBody } from "./model-family-cohere.js";
import { JSON_CONTENT_TYPE, SSE_CONTENT_TYPE, isChatOperation, jsonAnswer, renderModelReply, type ModelAnswer, type ModelStreamKind, type ModelWire, type RenderContext } from "./model-render.js";
import type { ServedModelFamily } from "./model-served-family.js";
import { UNMATCHED_SENTENCE } from "./model-served-family.js";

export const FAILURE_MODES = ["rate_limit", "cut_off_stream", "token_limit", "refusal", "bad_tool_json"] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];
export const FAILURE_VARIANTS = ["output", "input", "refusal", "filter"] as const;
export type FailureVariant = (typeof FAILURE_VARIANTS)[number];
/** The result class of every call the pack answers. */
export const FAILURE_PACK_CLASS = "failure_pack" as const;
export const FAILURE_AFTER_CALLS_MAX = 10_000;
export const FAILURE_RETRY_AFTER_SECONDS = "1";

export const FailureSpecSchema = z
  .object({ mode: z.enum(FAILURE_MODES), afterCalls: z.number().int().min(0).max(FAILURE_AFTER_CALLS_MAX).optional(), variant: z.enum(FAILURE_VARIANTS).optional() })
  .strict()
  .superRefine((spec, context) => {
    const allowed: Partial<Record<FailureMode, readonly FailureVariant[]>> = { token_limit: ["output", "input"], refusal: ["refusal", "filter"] };
    if (spec.variant !== undefined && !(allowed[spec.mode] ?? []).includes(spec.variant)) context.addIssue({ code: "custom", path: ["variant"], message: "this variant does not belong to this mode" });
  });
export interface FailureSpec {
  readonly mode: FailureMode;
  /** The first n calls are served from the reply set; the failure starts at call n+1. Default 0: every call fails. */
  readonly afterCalls?: number | undefined;
  /** `token_limit`: `output` (default) or `input`. `refusal`: `refusal` (default) or `filter`. */
  readonly variant?: FailureVariant | undefined;
}

/** The key of F0a's row `errors` object that names each mode's shape id. */
export const FAILURE_SHAPE_KEYS = { rate_limit: "rateLimit", cut_off_stream: "cutOffStream", token_limit: "tokenLimit", refusal: "refusal", bad_tool_json: "badToolJson" } as const satisfies Record<FailureMode, string>;
/** The shape id a row of this family names for a mode (`openai_compatible.rate_limit`): the same text F0a's built-in rows carry. */
export function failureShapeId(family: ServedModelFamily, mode: FailureMode): string {
  return `${family}.${mode}`;
}

// ---- the family's error envelope

export const FAILURE_ERROR_KINDS = ["rate_limit", "input_too_long", "no_script", "not_applicable"] as const;
export type FailureErrorKind = (typeof FAILURE_ERROR_KINDS)[number];

const WORDS: Record<FailureErrorKind, string> = {
  rate_limit: "Rate limit exceeded: too many requests (scripted by the Rovara failure pack).",
  input_too_long: "The input is too long for this model: it exceeds the context window (scripted by the Rovara failure pack).",
  no_script: UNMATCHED_SENTENCE,
  not_applicable: "not run: this failure mode does not apply to this operation",
};
const STATUS: Record<FailureErrorKind, number> = { rate_limit: 429, input_too_long: 400, no_script: 400, not_applicable: 400 };

function errorBody(wire: ModelWire, kind: FailureErrorKind): unknown {
  const message = WORDS[kind];
  switch (wire) {
    case "openai":
      return {
        error: {
          message,
          type: kind === "rate_limit" ? "requests" : "invalid_request_error",
          param: kind === "input_too_long" ? "messages" : null,
          code: { rate_limit: "rate_limit_exceeded", input_too_long: "context_length_exceeded", no_script: "no_scripted_reply", not_applicable: "failure_mode_not_applicable" }[kind],
        },
      };
    case "anthropic":
      return anthropicErrorBody(kind === "rate_limit" ? "rate_limit_error" : "invalid_request_error", message);
    case "cohere":
      return cohereErrorBody(message);
    case "gemini":
      return { error: { code: STATUS[kind], message, status: kind === "rate_limit" ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT" } };
  }
}

/** An error answer in the wire's own envelope. A 429 carries `retry-after`. The words are fixed here, never data. */
export function familyErrorAnswer(wire: ModelWire, kind: FailureErrorKind): ModelAnswer {
  const answer = jsonAnswer(STATUS[kind], errorBody(wire, kind));
  return kind === "rate_limit" ? { ...answer, headers: { ...answer.headers, "retry-after": FAILURE_RETRY_AFTER_SECONDS } } : answer;
}

// ---- the pack

export interface FailureContext {
  readonly wire: ModelWire;
  readonly operation: string;
  readonly model: string;
  readonly stream: ModelStreamKind;
  readonly seed: string;
  readonly lineEnding: SseLineEnding;
  readonly created: number;
  readonly enumEncoding: "string" | "int";
  /** The first tool the request declared; `unknown_tool` when none. */
  readonly toolName?: string | undefined;
}

/** The text every failure uses: long enough to stream in several pieces, fixed so a failure never depends on the reply set. */
export const FAILURE_PACK_TEXT = "This is the start of an answer from the Rovara failure pack. It is long enough to arrive in several pieces, so a client sees a stream that begins well.";
export const FAILURE_REFUSAL_TEXT = "I can't help with that request.";
const BAD_ARGS_PLACEHOLDER = { rovara_bad_tool_json: 1 } as const;
const BAD_ARGS_TEXT = '{"value": [1, 2';
/** Arguments that are an object but break the declared schema (wrong keys, wrong types): google-genai (Python) raises on non-object args before customer code runs, so the object form is what a test of the customer's own validation needs. */
const WRONG_SHAPE_ARGS = { rovara_wrong_key: ["not", "the", "declared", "type"] } as const;

const renderContext = (context: FailureContext): RenderContext => ({ wire: context.wire, operation: context.operation, model: context.model, stream: context.stream, seed: context.seed, lineEnding: context.lineEnding, created: context.created, enumEncoding: context.enumEncoding });

/** Cuts an SSE body inside an event: the first half of the events whole, then half of the next event's data. No terminal event is ever reached. */
function cutSse(body: string, lineEnding: SseLineEnding): string {
  const separator = lineEnding === "crlf" ? "\r\n\r\n" : "\n\n";
  const events = body.split(separator).filter((event) => event.length > 0);
  const keep = Math.floor(events.length / 2);
  const victim = events[keep] ?? "";
  const dataStart = Math.max(0, victim.indexOf("data:"));
  const cutAt = dataStart + Math.max(6, Math.floor((victim.length - dataStart) / 2));
  return [...events.slice(0, keep).map((event) => `${event}${separator}`), victim.slice(0, Math.min(cutAt, victim.length - 1))].join("");
}

function cutOff(context: FailureContext): ModelAnswer | undefined {
  if (!isChatOperation(context.wire, context.operation)) return undefined;
  const reply: ModelReply = { text: FAILURE_PACK_TEXT, finish: "stop", usage: { inputTokens: 12, outputTokens: 36 } };
  const full = renderModelReply(reply, renderContext(context));
  if (full === undefined) return undefined;
  if (context.stream === "sse") return { status: 200, headers: { "content-type": SSE_CONTENT_TYPE }, body: cutSse(full.body, context.lineEnding) };
  if (context.stream === "json_array") {
    // `[{...},\n{...},\n{...}]`: keep the first half of the elements and an unclosed piece of the next; the closing `]` never comes.
    const parts = full.body.slice(1, -1).split(",\n");
    const keep = Math.floor(parts.length / 2);
    const next = parts[keep] ?? "";
    return { status: 200, headers: { "content-type": JSON_CONTENT_TYPE }, body: `[${[...parts.slice(0, keep), next.slice(0, Math.max(1, Math.floor(next.length / 2)))].join(",\n")}` };
  }
  return { status: 200, headers: { "content-type": JSON_CONTENT_TYPE }, body: full.body.slice(0, Math.max(1, Math.floor(full.body.length / 2))) };
}

function tokenLimit(spec: FailureSpec, context: FailureContext): ModelAnswer {
  if (spec.variant === "input" || !isChatOperation(context.wire, context.operation)) return familyErrorAnswer(context.wire, "input_too_long");
  const reply: ModelReply = { text: FAILURE_PACK_TEXT, finish: "length", usage: { inputTokens: 12, outputTokens: 36 } };
  return renderModelReply(reply, renderContext(context)) ?? familyErrorAnswer(context.wire, "not_applicable");
}

/** OpenAI's own refusal shapes, which `ModelReply` cannot carry: `message.refusal` (finish `stop`), or a `content_filter` finish with no content. */
function openAiChatRefusal(spec: FailureSpec, context: FailureContext): ModelAnswer {
  const filter = spec.variant === "filter";
  if (context.stream === "none") {
    const body = buildChatCompletion({ text: "", finish: "stop", usage: { inputTokens: 12, outputTokens: 8 } }, { model: context.model, seed: context.seed, created: context.created }) as { choices: [{ message: Record<string, unknown>; finish_reason: string }] };
    body.choices[0].message = filter ? { role: "assistant", content: null } : { role: "assistant", content: null, refusal: FAILURE_REFUSAL_TEXT };
    body.choices[0].finish_reason = filter ? "content_filter" : "stop";
    return jsonAnswer(200, body);
  }
  const id = `chatcmpl-${seededId(context.seed)}`;
  const chunk = (delta: Record<string, unknown>, finish: string | null) => JSON.stringify({ id, object: "chat.completion.chunk", created: context.created, model: context.model, choices: [{ index: 0, delta, finish_reason: finish }] });
  const payloads = filter
    ? [chunk({ role: "assistant", content: "" }, null), chunk({}, "content_filter"), "[DONE]"]
    : [chunk({ role: "assistant", content: null }, null), chunk({ refusal: FAILURE_REFUSAL_TEXT }, null), chunk({}, "stop"), "[DONE]"];
  return { status: 200, headers: { "content-type": SSE_CONTENT_TYPE }, body: sseBody(payloads, context.lineEnding) };
}

function refusal(spec: FailureSpec, context: FailureContext): ModelAnswer {
  if (!isChatOperation(context.wire, context.operation)) return familyErrorAnswer(context.wire, "not_applicable");
  const filter = spec.variant === "filter";
  const usage = { inputTokens: 12, outputTokens: 8 };
  switch (context.wire) {
    case "openai": {
      if (context.operation === "chat_completions") return openAiChatRefusal(spec, context);
      const reply: ModelReply = { text: filter ? "" : FAILURE_REFUSAL_TEXT, finish: filter ? "safety" : "stop", usage };
      const build = { model: context.model, seed: context.seed, created: context.created, refusal: !filter } as const;
      return context.stream === "none" ? jsonAnswer(200, buildOpenAiResponse(reply, build)) : { status: 200, headers: { "content-type": SSE_CONTENT_TYPE }, body: openAiResponseStreamBody(reply, build, context.lineEnding) };
    }
    case "anthropic":
      return renderModelReply({ text: FAILURE_REFUSAL_TEXT, finish: "safety", usage }, renderContext(context)) ?? familyErrorAnswer(context.wire, "not_applicable");
    case "cohere":
      return renderModelReply({ text: FAILURE_REFUSAL_TEXT, finish: "stop", usage }, renderContext(context)) ?? familyErrorAnswer(context.wire, "not_applicable");
    case "gemini": {
      if (!filter) return renderModelReply({ text: "", finish: "safety", usage }, renderContext(context)) ?? familyErrorAnswer(context.wire, "not_applicable");
      const blocked = JSON.stringify({ promptFeedback: { blockReason: "SAFETY", safetyRatings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "HIGH" }] }, usageMetadata: { promptTokenCount: usage.inputTokens, totalTokenCount: usage.inputTokens } });
      if (context.stream === "sse") return { status: 200, headers: { "content-type": SSE_CONTENT_TYPE }, body: sseBody([blocked], context.lineEnding) };
      return { status: 200, headers: { "content-type": JSON_CONTENT_TYPE }, body: context.stream === "json_array" ? `[${blocked}]` : blocked };
    }
  }
}

/** Replaces every occurrence of `from` in `body` with `to`; the answer is refused if nothing was replaced (so a builder change cannot silently turn this into a good tool call). */
function swap(body: string, from: string, to: string): string | undefined {
  const parts = body.split(from);
  return parts.length > 1 ? parts.join(to) : undefined;
}

function badToolJson(context: FailureContext): ModelAnswer {
  if (!isChatOperation(context.wire, context.operation)) return familyErrorAnswer(context.wire, "not_applicable");
  const name = context.toolName ?? "unknown_tool";
  const reply: ModelReply = { text: "", toolCalls: [{ name, args: BAD_ARGS_PLACEHOLDER }], finish: "tool_calls", usage: { inputTokens: 12, outputTokens: 8 } };
  const good = renderModelReply(reply, renderContext(context));
  if (good === undefined) return familyErrorAnswer(context.wire, "not_applicable");
  const placeholder = JSON.stringify(BAD_ARGS_PLACEHOLDER);
  // Arguments carried as a string (OpenAI, Cohere, Anthropic's `partial_json`): an unterminated JSON text (for Anthropic's stream the SDK's partial parser turns it into an object that breaks the schema, not a parse error). Arguments carried as an object (Gemini `args`, Anthropic's whole `input`): an object with the wrong keys and types, never a string.
  const asString = swap(good.body, JSON.stringify(placeholder), JSON.stringify(BAD_ARGS_TEXT));
  const asObject = swap(good.body, `"args":${placeholder}`, `"args":${JSON.stringify(WRONG_SHAPE_ARGS)}`) ?? swap(good.body, `"input":${placeholder}`, `"input":${JSON.stringify(WRONG_SHAPE_ARGS)}`);
  const body = asString ?? asObject;
  return body === undefined ? familyErrorAnswer(context.wire, "not_applicable") : { ...good, body };
}

/** The pack's answer for one call. A mode that does not fit the operation (a refusal for an embedding) answers a fixed "not applicable" error, never a made-up success. Never throws on a valid context. */
export function buildFailureAnswer(spec: FailureSpec, context: FailureContext): ModelAnswer {
  switch (spec.mode) {
    case "rate_limit":
      return familyErrorAnswer(context.wire, "rate_limit");
    case "cut_off_stream":
      return cutOff(context) ?? familyErrorAnswer(context.wire, "not_applicable");
    case "token_limit":
      return tokenLimit(spec, context);
    case "refusal":
      return refusal(spec, context);
    case "bad_tool_json":
      return badToolJson(context);
  }
}
