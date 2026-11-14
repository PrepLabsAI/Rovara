// TE-F2 part A: turns one `ModelReply` into the bytes of a family's answer (whole body, SSE, JSON array), and answers the operations that need no reply text (token counts, embeddings, rerank). The shapes come from the
// family files (F0a's `model-family-gemini.ts` and `model-family-openai.ts`, and this lane's anthropic, cohere and openai-ops files); this file only picks which one. PURE.
//
// "wire" is the answer's shape, not the row's family: a Gemini or Vertex row answers its OpenAI-compatible endpoint in the OpenAI shape.
import { buildChatCompletion, buildChatCompletionStream } from "./model-family-openai.js";
import { buildGeminiGenerateContent, buildGeminiStreamChunks, geminiJsonArrayBody, geminiSseBody } from "./model-family-gemini.js";
import { buildAnthropicCountTokens, buildAnthropicMessage, buildAnthropicMessageStreamEvents, anthropicStreamBody } from "./model-family-anthropic.js";
import { buildCohereChat, buildCohereChatStreamEvents, buildCohereEmbed, buildCohereRerank, cohereStreamBody } from "./model-family-cohere.js";
import { buildOpenAiEmbeddings, buildOpenAiResponse, openAiResponseStreamBody } from "./model-family-openai-ops.js";
import { anthropicErrorBody } from "./model-family-anthropic.js";
import { cohereErrorBody } from "./model-family-cohere.js";
import { buildGeminiBatchEmbedContents, buildGeminiEmbedContent } from "./model-family-gemini-extra.js";
import type { ModelReply, SseLineEnding } from "./model-family-common.js";
import type { ModelRequestFacts } from "./model-request-facts.js";

export const MODEL_WIRES = ["openai", "anthropic", "cohere", "gemini"] as const;
export type ModelWire = (typeof MODEL_WIRES)[number];
export type ModelStreamKind = "none" | "sse" | "json_array";

/** One answer: a status, lowercase header names, a body. */
export interface ModelAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface RenderContext {
  readonly wire: ModelWire;
  readonly operation: string;
  readonly model: string;
  readonly stream: ModelStreamKind;
  readonly seed: string;
  readonly lineEnding: SseLineEnding;
  readonly created: number;
  readonly enumEncoding: "string" | "int";
}

export const JSON_CONTENT_TYPE = "application/json";
export const SSE_CONTENT_TYPE = "text/event-stream";
export const jsonAnswer = (status: number, value: unknown): ModelAnswer => ({ status, headers: { "content-type": JSON_CONTENT_TYPE }, body: JSON.stringify(value) });
export const sseAnswer = (body: string): ModelAnswer => ({ status: 200, headers: { "content-type": SSE_CONTENT_TYPE }, body });

/** The operations whose answer is built from a reply's text, tool calls, finish reason and usage. */
export function isChatOperation(wire: ModelWire, operation: string): boolean {
  switch (wire) {
    case "openai":
      return operation === "chat_completions" || operation === "responses";
    case "anthropic":
      return operation === "messages";
    case "cohere":
      return operation === "chat";
    case "gemini":
      return operation === "generateContent" || operation === "streamGenerateContent";
  }
}

/** A reply as the answer of a chat-like operation, or undefined when the operation is not one (the caller says so). May throw RangeError for a reply or a model name past its bound. */
export function renderModelReply(reply: ModelReply, context: RenderContext): ModelAnswer | undefined {
  const streamed = context.stream !== "none";
  switch (context.wire) {
    case "openai": {
      if (context.operation === "chat_completions") {
        const build = { model: context.model, seed: context.seed, created: context.created } as const;
        return streamed ? sseAnswer(buildChatCompletionStream(reply, build, context.lineEnding)) : jsonAnswer(200, buildChatCompletion(reply, build));
      }
      if (context.operation === "responses") {
        const build = { model: context.model, seed: context.seed, created: context.created } as const;
        return streamed ? sseAnswer(openAiResponseStreamBody(reply, build, context.lineEnding)) : jsonAnswer(200, buildOpenAiResponse(reply, build));
      }
      return undefined;
    }
    case "anthropic": {
      if (context.operation !== "messages") return undefined;
      const build = { model: context.model, seed: context.seed } as const;
      return streamed ? sseAnswer(anthropicStreamBody(buildAnthropicMessageStreamEvents(reply, build), context.lineEnding)) : jsonAnswer(200, buildAnthropicMessage(reply, build));
    }
    case "cohere": {
      if (context.operation !== "chat") return undefined;
      const build = { model: context.model, seed: context.seed } as const;
      return streamed ? sseAnswer(cohereStreamBody(buildCohereChatStreamEvents(reply, build), context.lineEnding)) : jsonAnswer(200, buildCohereChat(reply, build));
    }
    case "gemini": {
      if (context.operation !== "generateContent" && context.operation !== "streamGenerateContent") return undefined;
      const build = { model: context.model, seed: context.seed, enumEncoding: context.enumEncoding } as const;
      if (context.operation === "generateContent") return jsonAnswer(200, buildGeminiGenerateContent(reply, build));
      const chunks = buildGeminiStreamChunks(reply, build);
      return context.stream === "sse" ? sseAnswer(geminiSseBody(chunks, context.lineEnding)) : { status: 200, headers: { "content-type": JSON_CONTENT_TYPE }, body: geminiJsonArrayBody(chunks) };
    }
  }
}

/**
 * The operations that need a matched reply to be "expected" but whose bytes do not come from its text: token counts, embeddings and rerank. The numbers are filler that depends on the request's counts and the seed only.
 * Undefined when the operation is not one of these.
 */
/** What the helper serves for an embedding call: at most this many inputs and dimensions per family, and at most `EMBEDDING_NUMBERS_MAX` numbers (inputs x dimensions x types) in one answer. */
export const EMBEDDING_LIMITS = {
  openai: { inputs: 2048, dimensions: 3072, defaultDimensions: 1536 },
  cohere: { inputs: 96, dimensions: 4096, defaultDimensions: 1024 },
  gemini: { inputs: 100, dimensions: 3072, defaultDimensions: 768 },
} as const;
export const EMBEDDING_NUMBERS_MAX = 262_144;
export const EMBEDDING_TOO_BIG_SENTENCE = "not run: this embedding request is larger than the model helper serves";

function tooBigAnswer(wire: ModelWire): ModelAnswer {
  switch (wire) {
    case "anthropic":
      return jsonAnswer(400, anthropicErrorBody("invalid_request_error", EMBEDDING_TOO_BIG_SENTENCE));
    case "cohere":
      return jsonAnswer(400, cohereErrorBody(EMBEDDING_TOO_BIG_SENTENCE));
    case "gemini":
      return jsonAnswer(400, { error: { code: 400, message: EMBEDDING_TOO_BIG_SENTENCE, status: "INVALID_ARGUMENT" } });
    case "openai":
      return jsonAnswer(400, { error: { message: EMBEDDING_TOO_BIG_SENTENCE, type: "invalid_request_error", param: null, code: "embedding_request_too_large" } });
  }
}

/** Whether an embedding request is within the limits above, judged BEFORE anything is built (a fixed 400 otherwise, never a RangeError, never a big allocation). */
function embeddingWithinLimits(kind: keyof typeof EMBEDDING_LIMITS, inputs: number, dimensions: number | undefined, types: number): boolean {
  const limit = EMBEDDING_LIMITS[kind];
  const dims = dimensions ?? limit.defaultDimensions;
  return inputs <= limit.inputs && dims <= limit.dimensions && inputs * dims * types <= EMBEDDING_NUMBERS_MAX;
}

export function renderUtilityOperation(facts: ModelRequestFacts, requestBytes: number, context: RenderContext): ModelAnswer | undefined {
  const approxTokens = Math.ceil(requestBytes / 4);
  if (context.wire === "openai" && context.operation === "embeddings") {
    if (!embeddingWithinLimits("openai", facts.inputCount, facts.dimensions, 1)) return tooBigAnswer("openai");
    return jsonAnswer(200, buildOpenAiEmbeddings({ model: context.model, seed: context.seed, inputCount: facts.inputCount, dimensions: facts.dimensions, base64: facts.base64, promptTokens: Math.ceil((facts.promptText ?? "").length / 4) }));
  }
  if (context.wire === "anthropic" && context.operation === "count_tokens") return jsonAnswer(200, buildAnthropicCountTokens(approxTokens));
  if (context.wire === "cohere" && context.operation === "embed") {
    if (!embeddingWithinLimits("cohere", facts.inputCount, facts.dimensions, Math.max(1, new Set(facts.embeddingTypes).size))) return tooBigAnswer("cohere");
    return jsonAnswer(200, buildCohereEmbed({ seed: context.seed, textCount: facts.inputCount, dimensions: facts.dimensions, types: facts.embeddingTypes, inputTokens: Math.ceil((facts.promptText ?? "").length / 4) }));
  }
  if (context.wire === "cohere" && context.operation === "rerank") return jsonAnswer(200, buildCohereRerank({ seed: context.seed, documentCount: facts.documentCount, topN: facts.topN }));
  if (context.wire === "gemini" && (context.operation === "embedContent" || context.operation === "batchEmbedContents") && !embeddingWithinLimits("gemini", context.operation === "embedContent" ? 1 : facts.inputCount, facts.dimensions, 1)) return tooBigAnswer("gemini");
  if (context.wire === "gemini" && context.operation === "embedContent") return jsonAnswer(200, buildGeminiEmbedContent({ seed: context.seed, dimensions: facts.dimensions }));
  if (context.wire === "gemini" && context.operation === "batchEmbedContents") return jsonAnswer(200, buildGeminiBatchEmbedContents({ seed: context.seed, count: facts.inputCount, dimensions: facts.dimensions }));
  return undefined;
}
