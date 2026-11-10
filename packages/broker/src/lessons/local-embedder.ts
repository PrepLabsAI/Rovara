// The learning point's adapters that run on a laptop with no network and no model download.
//
//   `createLocalLearningAdapter()`  gives no embedder: lessons are compared on code-aware keywords and cited paths (`similarity.ts`), which is what the ranking falls back to anyway. This is the default.
//   `createHashingEmbedder()`       an embedder that runs in the process: words and letter triples of each word hashed into a fixed number of buckets (the "hashing trick"), signed so unrelated words cancel,
//                                   then scaled to length 1. It finds lexical likeness (shared words and word forms), not meaning; it is deterministic and has no state. `createLocalLearningAdapter({ embedder: true })` uses it.
import type { LearningAdapter, LessonEmbedder } from "@agentx/contracts";

/** The vector size of the in-process embedder: the same as the small open models hosted installs use, so a stored vector has the same shape either way (its `spec` differs, so the two are never compared). */
export const HASHING_EMBEDDER_DIMENSION = 384;
export const HASHING_EMBEDDER_SPEC = "local-hash-v1-384";

/** FNV-1a over the UTF-16 code units: small, fast and the same on every machine. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Splits camelCase and snake_case so `withRetry` and `with_retry` share their words. */
const wordsOf = (text: string): string[] =>
  text.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);

function vectorOf(text: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  const add = (feature: string, weight: number): void => {
    const h = hash(feature);
    vector[h % dimension]! += (h & 0x80000000) === 0 ? weight : -weight;
  };
  for (const word of wordsOf(text)) {
    add(`w:${word}`, 1);
    if (word.length > 3) for (let i = 0; i + 3 <= word.length; i += 1) add(`t:${word.slice(i, i + 3)}`, 0.35);
  }
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return length === 0 ? vector : vector.map((value) => value / length);
}

export function createHashingEmbedder(options: { dimension?: number } = {}): LessonEmbedder {
  const dimension = options.dimension ?? HASHING_EMBEDDER_DIMENSION;
  const spec = dimension === HASHING_EMBEDDER_DIMENSION ? HASHING_EMBEDDER_SPEC : `local-hash-v1-${String(dimension)}`;
  return {
    dimension, spec,
    async embed(text) { return vectorOf(text, dimension); },
    async embedMany(texts) { return texts.map((text) => vectorOf(text, dimension)); },
    async warm() { return true; },
  };
}

export function createLocalLearningAdapter(options: { embedder?: boolean } = {}): LearningAdapter {
  const embedder = options.embedder === true ? createHashingEmbedder() : undefined;
  return { kind: options.embedder === true ? "local-hash" : "local", ...(embedder === undefined ? {} : { embedder: () => embedder }) };
}
