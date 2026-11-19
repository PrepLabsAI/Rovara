// The learning point: how a host makes lessons comparable. The lessons themselves live in the `storage` point (a document store), their model calls go through `model-provider`, their spend through
// `admission` and `metering`, their audit through `audit-sink` and their approvals through `approvers`; what is left that differs between installs is the text similarity. That is the whole interface:
// an optional embedder (text to a vector) and an optional place to keep a lesson's vector. With neither, lessons are compared on keywords and cited paths alone, which is what a laptop with no
// model service does; Code also ships a small embedder that runs in the process (`@agentx/local-adapters`, no network, no model download).

/** One embedding call's own limit: `deadline` is an absolute time (Date.now milliseconds). The call never waits past it and starts no retry that could not finish by it. */
export interface EmbedderCall { deadline?: number }

export interface Embedder { embed(text: string): Promise<number[]> }

/**
 * The lessons' embedder: a text-to-vector function with a fixed dimension. `spec` names the model and revision the vectors come from: a vector is only compared with, or stored beside, vectors of the same
 * spec, and a changed spec makes every stored lesson vector stale (it is made again, a few at a time).
 */
export interface LessonEmbedder extends Embedder {
  readonly dimension: number;
  readonly spec: string;
  embedMany(texts: readonly string[], kind?: "query" | "document", call?: EmbedderCall): Promise<number[][]>;
  /** Whether the embedder is ready now or within `waitMs` (loading is not part of a ranking's time budget). Absent: always ready. Rejects only when the embedder can never be ready: that is "unavailable", not "loading". */
  warm?(waitMs: number): Promise<boolean>;
}

/** A lesson's stored vector: the hash of the text it was made from (an edited lesson is embedded again) and the vector. */
export interface StoredLessonVector { hash: string; vector: readonly number[] }

/**
 * The lesson vectors, kept WITH the lessons (one item beside each lesson in the project's partition, so every deletion of the lesson or the project reaches it). There is no vector index: a project holds
 * at most about 2,000 lessons, so the search is a brute-force cosine in memory over the vectors read for one call. Every call carries the company and project: a vector of another company is impossible.
 */
export interface LessonVectors {
  /** The stored vectors of these lessons that were made by this embedder spec (a lesson with none, or with another spec's, is simply absent). */
  get(workspaceId: string, project: string, spec: string, ids: readonly string[]): Promise<Map<string, StoredLessonVector>>;
  put(workspaceId: string, project: string, spec: string, id: string, vector: StoredLessonVector): Promise<void>;
  /** Deletes the lesson's vector, whatever its spec. Idempotent. */
  remove(workspaceId: string, project: string, id: string): Promise<void>;
}

/**
 * A learning adapter. Every part is optional: an adapter that gives nothing leaves lessons on keyword and cited-path similarity. A hosted adapter gives its embedder service and its vector storage; Code's
 * `local` adapter gives the in-process embedder and keeps the vectors in the document store beside the lessons.
 */
export interface LearningAdapter {
  readonly kind?: string;
  /** The embedder for this company's lessons, or `undefined` for none. Read once, when the lessons start, so a host that has one starts it first. */
  embedder?(company: string): LessonEmbedder | undefined;
  /** Where this company's lesson vectors are kept. Absent: beside the lessons in the document store. */
  vectors?(company: string): LessonVectors | undefined;
}
