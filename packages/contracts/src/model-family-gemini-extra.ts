// TE-F2 part A: Gemini and Vertex reply shapes for the operations a RAG pilot hits that F0a's `model-family-gemini.ts` does not build: `embedContent`, `batchEmbedContents`, the models list and get, and Vertex's `:predict`
// embeddings. Shapes are from Google's public API reference (https://ai.google.dev/api/embeddings, https://ai.google.dev/api/models, https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/text-embeddings-api),
// written WITHOUT a network: all of them are UNVERIFIED against a client. The vectors are seeded filler (see `model-family-vectors.ts`).
//
// ROUTING IS NOT HERE. F0a's `routeGeminiRequest` routes `embedContent` and `batchEmbedContents` (so those two are served by `model-serve-replies.ts`), but it does not route `GET /v1beta/models`, `GET /v1beta/models/<m>`,
// Vertex `...:predict` or the Files upload (`/upload/v1beta/files`, `/v1beta/files`): those need F0a's router to learn the paths, and the Files upload is a resumable two-step protocol. They are listed for Part B in the
// report; the shapes below are ready for them. PURE.
import { seededId } from "./model-family-common.js";
import { VECTOR_MAX_DIMENSIONS, VECTOR_MAX_ITEMS, seededVector } from "./model-family-vectors.js";

export const GEMINI_EMBEDDING_DEFAULT_DIMENSIONS = 768;
type JsonObject = Record<string, unknown>;

const clampCount = (value: number): number => Math.min(VECTOR_MAX_ITEMS, Math.max(1, Math.trunc(Number.isFinite(value) ? value : 1)));
const clampDims = (value: number | undefined): number => Math.min(VECTOR_MAX_DIMENSIONS, Math.max(1, Math.trunc(value ?? GEMINI_EMBEDDING_DEFAULT_DIMENSIONS)));

/** `embedContent`: `{"embedding": {"values": [...]}}`. */
export function buildGeminiEmbedContent(options: { seed: string; dimensions: number | undefined }): JsonObject {
  return { embedding: { values: seededVector(`${options.seed}:gemini-embed:0`, clampDims(options.dimensions)) } };
}

/** `batchEmbedContents`: `{"embeddings": [{"values": [...]}, ...]}`, one per request in the batch. */
export function buildGeminiBatchEmbedContents(options: { seed: string; count: number; dimensions: number | undefined }): JsonObject {
  const dimensions = clampDims(options.dimensions);
  return { embeddings: Array.from({ length: clampCount(options.count) }, (_, index) => ({ values: seededVector(`${options.seed}:gemini-embed:${String(index)}`, dimensions) })) };
}

/** One `Model` resource of the models list and get. */
export function buildGeminiModel(name: string): JsonObject {
  const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name) ? name : "unknown-model";
  return { name: `models/${id}`, version: "001", displayName: id, description: "Scripted by Rovara", inputTokenLimit: 1_048_576, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens", "embedContent"] };
}

/** `GET /v1beta/models`: `{"models": [...]}`. At most 128 names. */
export function buildGeminiModelsList(names: readonly string[]): JsonObject {
  return { models: names.slice(0, 128).map(buildGeminiModel) };
}

/** Vertex `:predict` on a text-embedding model: `{"predictions": [{"embeddings": {"values": [...], "statistics": {"truncated": false, "token_count": n}}}], "metadata": {...}}`. */
export function buildVertexPredictEmbeddings(options: { seed: string; count: number; dimensions: number | undefined; tokenCount: number }): JsonObject {
  const dimensions = clampDims(options.dimensions);
  const tokens = Number.isSafeInteger(options.tokenCount) && options.tokenCount >= 0 ? options.tokenCount : 0;
  return {
    predictions: Array.from({ length: clampCount(options.count) }, (_, index) => ({ embeddings: { values: seededVector(`${options.seed}:vertex-embed:${String(index)}`, dimensions), statistics: { truncated: false, token_count: tokens } } })),
    metadata: { billableCharacterCount: tokens * 4 },
    deployedModelId: seededId(`${options.seed}:deployed`),
  };
}
