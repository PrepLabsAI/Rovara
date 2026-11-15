// TE-F2 part A: the rest of the OpenAI-compatible family that F0a's `model-family-openai.ts` leaves out: the Responses API (`/v1/responses`, whole body and the named-event stream) and embeddings (`/v1/embeddings`,
// float lists and the base64 form the Python SDK asks for by default). F0a's file already holds the router and the chat-completion builders; this file does not change it (the brief's "new model-family-openai.ts" is F0a's).
//
// Shapes are from OpenAI's public API reference (https://platform.openai.com/docs/api-reference/responses, .../responses-streaming, .../embeddings), written from the docs and the SDK types WITHOUT a network in this lane:
// nothing here was compared with a live answer. The Node SDK in the repo's node_modules (`openai`) parses the bodies in this lane's loopback check; the Python SDK was not run. Anything finer than that is UNVERIFIED:
//   UNVERIFIED: the exact field set of a `response` object (the SDKs do not validate; extra and missing optional fields are tolerated).
//   UNVERIFIED: the Responses stream's event order for refusals (`response.refusal.delta`) and for function calls (`response.function_call_arguments.*`).
//   UNVERIFIED: `usage.input_tokens_details` / `output_tokens_details` contents.
// PURE: no Node module, no socket, no clock (`created` is passed in), no randomness (ids come from the seed).
import { MODEL_ECHO_PATTERN, assertReplyBounds, chunkText, replyUsage, seededId, type ModelReply, type SseLineEnding } from "./model-family-common.js";
import { sseNamedBody, type NamedSseEvent } from "./model-sse-named.js";
import { VECTOR_MAX_DIMENSIONS, VECTOR_MAX_ITEMS, float32Base64, seededVector } from "./model-family-vectors.js";

export interface OpenAiResponsesBuildOptions {
  readonly model: string;
  readonly seed: string;
  readonly created: number;
  readonly chunkChars?: number;
  /** Render the text as a refusal content part (`{"type":"refusal"}`) instead of `output_text`. */
  readonly refusal?: boolean;
}

type JsonObject = Record<string, unknown>;

const itemIds = (seed: string) => ({ response: `resp_${seededId(seed)}`, message: `msg_${seededId(`${seed}:message`)}` });

function outputItems(reply: ModelReply, options: OpenAiResponsesBuildOptions, status: "completed" | "in_progress"): JsonObject[] {
  const ids = itemIds(options.seed);
  const items: JsonObject[] = [];
  const done = status === "completed";
  if (reply.text.length > 0 || (reply.toolCalls ?? []).length === 0) {
    const part: JsonObject = options.refusal === true ? { type: "refusal", refusal: reply.text } : { type: "output_text", text: reply.text, annotations: [] };
    items.push({ type: "message", id: ids.message, status, role: "assistant", content: done ? [part] : [] });
  }
  (reply.toolCalls ?? []).forEach((call, index) => {
    const callId = `call_${seededId(`${options.seed}:${String(index)}:${call.name}`)}`;
    items.push({ type: "function_call", id: `fc_${seededId(`${options.seed}:fc:${String(index)}:${call.name}`)}`, call_id: callId, name: call.name, arguments: done ? JSON.stringify(call.args) : "", status });
  });
  return items;
}

function responseObject(reply: ModelReply, options: OpenAiResponsesBuildOptions, state: "completed" | "in_progress"): JsonObject {
  const usage = replyUsage(reply);
  const incomplete = state === "completed" && (reply.finish === "length" || reply.finish === "safety");
  return {
    id: itemIds(options.seed).response,
    object: "response",
    created_at: options.created,
    status: state === "in_progress" ? "in_progress" : incomplete ? "incomplete" : "completed",
    error: null,
    incomplete_details: incomplete ? { reason: reply.finish === "length" ? "max_output_tokens" : "content_filter" } : null,
    instructions: null,
    max_output_tokens: null,
    model: options.model,
    output: state === "completed" ? outputItems(reply, options, "completed") : [],
    parallel_tool_calls: true,
    previous_response_id: null,
    store: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: state === "completed" ? { input_tokens: usage.inputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: usage.outputTokens, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: usage.inputTokens + usage.outputTokens } : null,
    user: null,
    metadata: {},
  };
}

/** One `response` object (the whole body of a non-streamed `POST /v1/responses`). `length` is an incomplete response (`max_output_tokens`), `safety` an incomplete one with `content_filter`. */
export function buildOpenAiResponse(reply: ModelReply, options: OpenAiResponsesBuildOptions): JsonObject {
  assertReplyBounds(reply, options.model);
  return responseObject(reply, options, "completed");
}

/** The events of a streamed Responses answer, in order, each with its `sequence_number`. The last is `response.completed` (or `response.incomplete`); there is no `[DONE]`. */
export function buildOpenAiResponseStreamEvents(reply: ModelReply, options: OpenAiResponsesBuildOptions): NamedSseEvent[] {
  assertReplyBounds(reply, options.model);
  let sequence = 0;
  const events: NamedSseEvent[] = [];
  const push = (type: string, body: JsonObject): void => {
    events.push({ event: type, data: JSON.stringify({ type, ...body, sequence_number: sequence }) });
    sequence += 1;
  };
  const final = responseObject(reply, options, "completed");
  push("response.created", { response: responseObject(reply, options, "in_progress") });
  push("response.in_progress", { response: responseObject(reply, options, "in_progress") });
  const finals = outputItems(reply, options, "completed");
  const starts = outputItems(reply, options, "in_progress");
  finals.forEach((item, outputIndex) => {
    const start = starts[outputIndex] as JsonObject;
    const itemId = String(item.id);
    push("response.output_item.added", { output_index: outputIndex, item: start });
    if (item.type === "message") {
      const refusal = options.refusal === true;
      push("response.content_part.added", { item_id: itemId, output_index: outputIndex, content_index: 0, part: refusal ? { type: "refusal", refusal: "" } : { type: "output_text", text: "", annotations: [] } });
      for (const piece of chunkText(reply.text, options.chunkChars ?? 32)) push(refusal ? "response.refusal.delta" : "response.output_text.delta", { item_id: itemId, output_index: outputIndex, content_index: 0, delta: piece });
      push(refusal ? "response.refusal.done" : "response.output_text.done", { item_id: itemId, output_index: outputIndex, content_index: 0, ...(refusal ? { refusal: reply.text } : { text: reply.text }) });
      push("response.content_part.done", { item_id: itemId, output_index: outputIndex, content_index: 0, part: refusal ? { type: "refusal", refusal: reply.text } : { type: "output_text", text: reply.text, annotations: [] } });
    } else {
      push("response.function_call_arguments.delta", { item_id: itemId, output_index: outputIndex, delta: String(item.arguments) });
      push("response.function_call_arguments.done", { item_id: itemId, output_index: outputIndex, arguments: String(item.arguments) });
    }
    push("response.output_item.done", { output_index: outputIndex, item });
  });
  push(final.status === "incomplete" ? "response.incomplete" : "response.completed", { response: final });
  return events;
}

/** The SSE text of a streamed Responses answer: `event: <type>` then `data: <json>`, a blank line after each. */
export function openAiResponseStreamBody(reply: ModelReply, options: OpenAiResponsesBuildOptions, lineEnding: SseLineEnding): string {
  return sseNamedBody(buildOpenAiResponseStreamEvents(reply, options), lineEnding);
}

export interface OpenAiEmbeddingsOptions {
  readonly model: string;
  readonly seed: string;
  /** How many inputs the request had (1 to 2,048). */
  readonly inputCount: number;
  /** The requested `dimensions`, or undefined for the default (1536). Clamped to 1..4096. */
  readonly dimensions: number | undefined;
  /** `encoding_format: "base64"`: the Python SDK asks for it by default and decodes little-endian float32. */
  readonly base64: boolean;
  readonly promptTokens: number;
}
export const OPENAI_EMBEDDING_DEFAULT_DIMENSIONS = 1536;

/** A `list` of `embedding` objects. The numbers are seeded filler; the count of items equals the count of inputs. */
export function buildOpenAiEmbeddings(options: OpenAiEmbeddingsOptions): JsonObject {
  const count = Math.min(VECTOR_MAX_ITEMS, Math.max(1, Math.trunc(options.inputCount)));
  const dimensions = Math.min(VECTOR_MAX_DIMENSIONS, Math.max(1, Math.trunc(options.dimensions ?? OPENAI_EMBEDDING_DEFAULT_DIMENSIONS)));
  const tokens = Number.isSafeInteger(options.promptTokens) && options.promptTokens >= 0 ? options.promptTokens : 0;
  return {
    object: "list",
    data: Array.from({ length: count }, (_, index) => {
      const values = seededVector(`${options.seed}:embedding:${String(index)}`, dimensions);
      return { object: "embedding", index, embedding: options.base64 ? float32Base64(values) : values };
    }),
    model: options.model,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  };
}

/** `GET /v1/models`: a `list` of `model` objects, one per id. Ids must be plain names; others are dropped. At most 128. */
export function buildOpenAiModelsList(ids: readonly string[], created: number): JsonObject {
  const plain = ids.filter((id) => MODEL_ECHO_PATTERN.test(id)).slice(0, 128);
  return { object: "list", data: plain.map((id) => buildOpenAiModel(id, created)) };
}

/** `GET /v1/models/<id>`: one `model` object. UNVERIFIED: `owned_by` is a placeholder. */
export function buildOpenAiModel(id: string, created: number): JsonObject {
  return { id: MODEL_ECHO_PATTERN.test(id) ? id : "unknown-model", object: "model", created, owned_by: "rovara-scripted" };
}
