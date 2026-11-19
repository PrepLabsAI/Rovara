// The `learning` point: in-memory lesson vectors and a tiny fixed embedder, for the conformance suite and for tests of the lessons library that need a learning
// adapter without a document store. Code's default (`local`, keywords; `ROVARA_LESSONS_EMBEDDER=local` adds the in-process hashing embedder, a loopback address a model served on this machine) is `lessons/local-embedder.ts`,
// and Code keeps vectors beside the lessons in the document store (`lessons/document-vectors.ts`).
import type { LearningAdapter, LessonEmbedder, LessonVectors, StoredLessonVector } from "@agentx/contracts";

/** Lesson vectors in a map, keyed by company, project and lesson: one vector per lesson (a new spec replaces the old one). */
export function createMemoryLessonVectors(): LessonVectors & { size(): number } {
  const held = new Map<string, { spec: string; stored: StoredLessonVector }>();
  const keyOf = (workspaceId: string, project: string, id: string): string => JSON.stringify([workspaceId, project, id]);
  return {
    async get(workspaceId, project, spec, ids) {
      const found = new Map<string, StoredLessonVector>();
      for (const id of new Set(ids)) {
        const entry = held.get(keyOf(workspaceId, project, id));
        if (entry !== undefined && entry.spec === spec) found.set(id, { hash: entry.stored.hash, vector: [...entry.stored.vector] });
      }
      return found;
    },
    async put(workspaceId, project, spec, id, stored) {
      held.set(keyOf(workspaceId, project, id), { spec, stored: { hash: stored.hash, vector: Array.from(new Float32Array(stored.vector)) } });
    },
    async remove(workspaceId, project, id) {
      held.delete(keyOf(workspaceId, project, id));
    },
    size: () => held.size,
  };
}

/**
 * A fixed embedder for tests: each text becomes a unit vector from its character codes (the same text, the same vector; no meaning). `spec` names it so its vectors are
 * never compared with another embedder's.
 */
export function createFixedLessonEmbedder(options: { dimension?: number; spec?: string } = {}): LessonEmbedder {
  const dimension = options.dimension ?? 8;
  const vectorOf = (text: string): number[] => {
    const vector = new Array<number>(dimension).fill(0);
    for (let i = 0; i < text.length; i += 1) vector[i % dimension]! += (text.charCodeAt(i) % 31) + 1;
    const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return length === 0 ? vector : vector.map((value) => value / length);
  };
  return {
    dimension,
    spec: options.spec ?? `fixed-test-${String(dimension)}`,
    async embed(text) { return vectorOf(text); },
    async embedMany(texts, _kind, call) {
      if (call?.deadline !== undefined && Date.now() > call.deadline) throw new Error("the embedding deadline passed");
      return texts.map(vectorOf);
    },
    async warm() { return true; },
  };
}

/** A learning adapter over the two above (or what it is given). */
export function createMemoryLearningAdapter(options: { embedder?: LessonEmbedder; vectors?: LessonVectors } = {}): LearningAdapter {
  return {
    kind: "memory",
    ...(options.embedder === undefined ? {} : { embedder: () => options.embedder }),
    ...(options.vectors === undefined ? {} : { vectors: () => options.vectors }),
  };
}
