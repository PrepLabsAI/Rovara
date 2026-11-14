// TE-F2 part A: deterministic filler vectors for the embedding operations (OpenAI `embeddings`, Cohere `embed`) and rerank scores. An embedding call still needs a matching scripted reply to be served (the reply says "this
// call is expected"); the numbers themselves are filler that depends only on the seed, never a clock or a random source. PURE.
import { seededId } from "./model-family-common.js";

export const VECTOR_MAX_DIMENSIONS = 4096;
export const VECTOR_MAX_ITEMS = 2048;

/** A stream of 32-bit values from a seed (xorshift32 seeded by `seededId`). */
function stream(seed: string): () => number {
  let state = Number.parseInt(seededId(seed).slice(0, 8), 16) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** A float32-exact vector of `dimensions` numbers in about [-1, 1], scaled so its length is near 1. `dimensions` is clamped to 1..4096. */
export function seededVector(seed: string, dimensions: number): number[] {
  const size = Math.min(VECTOR_MAX_DIMENSIONS, Math.max(1, Math.trunc(Number.isFinite(dimensions) ? dimensions : 1)));
  const next = stream(seed);
  const scale = 1 / Math.sqrt(size);
  return Array.from({ length: size }, () => Math.fround(((next() / 0xffffffff) * 2 - 1) * scale));
}

/** The base64 of the vector as little-endian float32 (what a client asks for with `encoding_format: "base64"`). */
export function float32Base64(values: readonly number[]): string {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  let binary = "";
  const bytes = new Uint8Array(view.buffer);
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index] ?? 0);
  return btoa(binary);
}

/** Integer codes for a vector: int8 (-128..127) or uint8 (0..255). */
export function quantized(values: readonly number[], kind: "int8" | "uint8"): number[] {
  return values.map((value) => (kind === "int8" ? Math.max(-128, Math.min(127, Math.round(value * 127))) : Math.max(0, Math.min(255, Math.round((value + 1) * 127.5)))));
}
