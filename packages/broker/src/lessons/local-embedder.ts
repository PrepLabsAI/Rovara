// The learning point's adapters that run on a laptop with no network and no model download.
//
//   `createLocalLearningAdapter()`  gives no embedder: lessons are compared on code-aware keywords and cited paths (`similarity.ts`), which is what the ranking falls back to anyway. This is the default.
//   `createHashingEmbedder()`       an embedder that runs in the process: words and letter triples of each word hashed into a fixed number of buckets (the "hashing trick"), signed so unrelated words cancel,
//                                   then scaled to length 1. It finds lexical likeness (shared words and word forms), not meaning; it is deterministic and has no state. `createLocalLearningAdapter({ embedder: true })` uses it.
//   `createLoopbackEmbedder()`      a small open embedding model (bge-small class, decision 23) served on THIS machine by an embedding server the owner runs (any server with the common `/embeddings` route:
//                                   Ollama, llama.cpp's server, text-embeddings-inference, LM Studio). Only a loopback address is accepted, so lesson text never leaves the machine and no paid service is called.
//                                   `ROVARA_LESSONS_EMBEDDER=http://127.0.0.1:<port>/v1` with `ROVARA_LESSONS_EMBEDDER_MODEL` (and `ROVARA_LESSONS_EMBEDDER_DIMENSION`, default 384) chooses it (`learningAdapterFromEnvironment`).
//                                   Every failure is one fixed code and nothing of the text or the server's answer is kept: the callers then rank on keywords and cited paths alone.
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

export function createLocalLearningAdapter(options: { embedder?: boolean | LessonEmbedder } = {}): LearningAdapter {
  const embedder = options.embedder === true ? createHashingEmbedder() : options.embedder === false || options.embedder === undefined ? undefined : options.embedder;
  const kind = embedder === undefined ? "local" : options.embedder === true ? "local-hash" : "local-model";
  return { kind, ...(embedder === undefined ? {} : { embedder: () => embedder }) };
}

// ---- a small open model served on this machine

/** The limits of one call: texts per request, characters per text (a longer text is cut), the longest wait, and the largest answer read (16 vectors of 8,192 numbers fit well inside it). */
export const LOOPBACK_EMBEDDER_LIMITS = { maxTexts: 16, maxTextChars: 24_000, timeoutMs: 10_000, maxResponseBytes: 8 * 1024 * 1024 } as const;
export const LOOPBACK_EMBEDDER_CODES = ["NOT_LOOPBACK", "BAD_CONFIG", "UNREACHABLE", "BAD_RESPONSE"] as const;
export type LoopbackEmbedderCode = (typeof LOOPBACK_EMBEDDER_CODES)[number];
/** A refusal or failure with a fixed code. The message is the code, so it is safe to log. */
export class LoopbackEmbedderError extends Error {
  constructor(readonly code: LoopbackEmbedderCode) { super(`embedder: ${code}`); this.name = "LoopbackEmbedderError"; }
}

// Literal loopback addresses only: a name such as `localhost` is resolved through the hosts file and may point anywhere, and other spellings (0.0.0.0, an IPv4-mapped IPv6 address) are refused.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;

/** The server's base address, accepted only on this machine (http or https to 127.0.0.1 or [::1], no user name or password, no query). Undefined otherwise. */
export function loopbackBase(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

export interface LoopbackEmbedderOptions {
  /** The server's base address, e.g. `http://127.0.0.1:11434/v1`; `/embeddings` is added. Loopback only. */
  url: string;
  /** The model's name on that server (for example a bge-small build). Part of the vectors' `spec`, so a changed model makes the stored vectors stale. */
  model: string;
  /** The model's vector size (384 for the bge-small class). An answer of another size is refused. */
  dimension?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** One vector, checked: the size asked for, every number finite and not all zero; scaled to length 1 here (servers differ in whether they do). */
function unitVector(value: unknown, dimension: number): number[] {
  if (!Array.isArray(value) || value.length !== dimension) throw new LoopbackEmbedderError("BAD_RESPONSE");
  let sum = 0;
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) throw new LoopbackEmbedderError("BAD_RESPONSE");
    sum += item * item;
  }
  if (sum === 0) throw new LoopbackEmbedderError("BAD_RESPONSE");
  const length = Math.sqrt(sum);
  return (value as number[]).map((item) => item / length);
}

/** The answer's text, read only up to `max` bytes: a larger answer (by its declared length or as it streams) is refused before it is held whole or parsed. */
async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw new LoopbackEmbedderError("BAD_RESPONSE");
  if (response.body === null) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read() as { done: true; value?: undefined } | { done: false; value: Uint8Array };
    if (chunk.done) break;
    const value = chunk.value;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => undefined); throw new LoopbackEmbedderError("BAD_RESPONSE"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createLoopbackEmbedder(options: LoopbackEmbedderOptions): LessonEmbedder {
  const base = loopbackBase(options.url);
  if (base === undefined) throw new LoopbackEmbedderError("NOT_LOOPBACK");
  const dimension = options.dimension ?? HASHING_EMBEDDER_DIMENSION;
  if (!MODEL_NAME.test(options.model) || !Number.isSafeInteger(dimension) || dimension < 8 || dimension > 8192) throw new LoopbackEmbedderError("BAD_CONFIG");
  const doFetch = options.fetch ?? fetch;
  const clock = options.now ?? Date.now;
  const spec = `loopback:${options.model}:${String(dimension)}`.slice(0, 200);

  async function request(texts: string[], deadline: number | undefined): Promise<number[][]> {
    const left = deadline === undefined ? LOOPBACK_EMBEDDER_LIMITS.timeoutMs : Math.min(LOOPBACK_EMBEDDER_LIMITS.timeoutMs, deadline - clock());
    if (left < 1) throw new LoopbackEmbedderError("UNREACHABLE");
    let body: unknown;
    try {
      const response = await doFetch(`${base}/embeddings`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: options.model, input: texts }),
        signal: AbortSignal.timeout(left), redirect: "error",
      });
      if (!response.ok) throw new LoopbackEmbedderError("UNREACHABLE");
      body = JSON.parse(await readCapped(response, LOOPBACK_EMBEDDER_LIMITS.maxResponseBytes)) as unknown;
    } catch (error) {
      if (error instanceof LoopbackEmbedderError) throw error;
      throw new LoopbackEmbedderError("UNREACHABLE");
    }
    const data = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { data?: unknown }).data : undefined;
    if (!Array.isArray(data) || data.length !== texts.length) throw new LoopbackEmbedderError("BAD_RESPONSE");
    const out = new Array<number[] | undefined>(texts.length).fill(undefined);
    data.forEach((entry: unknown, position) => {
      // Every entry must be an object: a null, a number or a list is a refusal with the fixed code, never a TypeError.
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new LoopbackEmbedderError("BAD_RESPONSE");
      const fields = entry as { index?: unknown; embedding?: unknown };
      const index = fields.index ?? position;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= texts.length || out[index] !== undefined) throw new LoopbackEmbedderError("BAD_RESPONSE");
      out[index] = unitVector(fields.embedding, dimension);
    });
    return out as number[][];
  }

  async function embedMany(texts: readonly string[], _kind?: "query" | "document", call?: { deadline?: number }): Promise<number[][]> {
    const cleaned = texts.map((text) => (typeof text === "string" ? text.trim() : "").slice(0, LOOPBACK_EMBEDDER_LIMITS.maxTextChars));
    // A blank text has nothing to compare: it is the zero vector (near nothing), and the server, which may refuse an empty input, is not asked about it.
    const asked = cleaned.flatMap((text, index) => (text === "" ? [] : [index]));
    const vectors: number[][] = cleaned.map(() => new Array<number>(dimension).fill(0));
    for (let at = 0; at < asked.length; at += LOOPBACK_EMBEDDER_LIMITS.maxTexts) {
      const batch = asked.slice(at, at + LOOPBACK_EMBEDDER_LIMITS.maxTexts);
      const answered = await request(batch.map((index) => cleaned[index]!), call?.deadline);
      batch.forEach((index, position) => { vectors[index] = answered[position]!; });
    }
    return vectors;
  }

  return {
    dimension, spec,
    async embed(text) { return (await embedMany([text]))[0]!; },
    embedMany,
  };
}

/**
 * The learning adapter `rovara up` registers, from its environment: no `ROVARA_LESSONS_EMBEDDER`, keywords and cited paths; `local`, the in-process hashing embedder; a loopback address, the model served there
 * (`ROVARA_LESSONS_EMBEDDER_MODEL` is then required). Anything else is refused with a fixed message, so a typo never quietly means "no embedder".
 */
export function learningAdapterFromEnvironment(environment: Readonly<Record<string, string | undefined>>, options: { fetch?: typeof fetch } = {}): LearningAdapter {
  const chosen = environment["ROVARA_LESSONS_EMBEDDER"];
  if (chosen === undefined || chosen === "") return createLocalLearningAdapter();
  if (chosen === "local") return createLocalLearningAdapter({ embedder: true });
  const model = environment["ROVARA_LESSONS_EMBEDDER_MODEL"];
  const dimensionText = environment["ROVARA_LESSONS_EMBEDDER_DIMENSION"];
  const dimension = dimensionText === undefined || dimensionText === "" ? undefined : /^[0-9]{1,5}$/u.test(dimensionText) ? Number(dimensionText) : Number.NaN;
  if (loopbackBase(chosen) === undefined) throw new Error("ROVARA_LESSONS_EMBEDDER must be `local` or an address on this machine (http://127.0.0.1:<port>/...): lesson text is not sent off the machine");
  if (model === undefined || model === "") throw new Error("ROVARA_LESSONS_EMBEDDER_MODEL must name the embedding model the server at ROVARA_LESSONS_EMBEDDER serves");
  try {
    return createLocalLearningAdapter({ embedder: createLoopbackEmbedder({ url: chosen, model, ...(dimension === undefined ? {} : { dimension }), ...(options.fetch === undefined ? {} : { fetch: options.fetch }) }) });
  } catch {
    throw new Error("ROVARA_LESSONS_EMBEDDER_MODEL or ROVARA_LESSONS_EMBEDDER_DIMENSION is not valid (a model name, and a vector size from 8 to 8192)");
  }
}
