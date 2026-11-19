// The conformance suites of the `learning` point: one for an embedder (`LessonEmbedder`), one for where lesson vectors are kept (`LessonVectors`). Code's hashing
// embedder, the fixed test embedder, the document-store vectors and the memory vectors run them; a hosted embedder service and its vector store run them later.
import { describe, expect, it } from "vitest";
import type { LessonEmbedder, LessonVectors } from "@agentx/contracts";

export interface EmbedderHarness {
  create(): Promise<{ embedder: LessonEmbedder; dispose?: () => Promise<void> }>;
}

export function runLessonEmbedderConformance(name: string, harness: EmbedderHarness): void {
  async function withEmbedder<T>(body: (embedder: LessonEmbedder) => Promise<T>): Promise<T> {
    const { embedder, dispose } = await harness.create();
    try { return await body(embedder); } finally { await dispose?.(); }
  }

  describe(`lesson embedder conformance: ${name}`, () => {
    it("names its vectors with a spec and gives every vector its fixed dimension, finite numbers only", () => withEmbedder(async (embedder) => {
      expect(embedder.spec).toMatch(/^\S{1,100}$/u);
      expect(Number.isInteger(embedder.dimension) && embedder.dimension > 0).toBe(true);
      const one = await embedder.embed("Retry the upload with backoff.");
      expect(one).toHaveLength(embedder.dimension);
      expect(one.every((value) => Number.isFinite(value))).toBe(true);
    }));

    it("embeds many texts in order, one vector each, the same as one at a time", () => withEmbedder(async (embedder) => {
      const texts = ["Retry the upload with backoff.", "Warm the cache before the deploy.", ""];
      const many = await embedder.embedMany(texts, "document");
      expect(many).toHaveLength(texts.length);
      for (const [index, vector] of many.entries()) {
        expect(vector).toHaveLength(embedder.dimension);
        const single = await embedder.embed(texts[index]!);
        for (const [i, value] of vector.entries()) expect(value).toBeCloseTo(single[i]!, 4);
      }
      expect(await embedder.embedMany([], "query")).toEqual([]);
    }));

    it("is deterministic for one text", () => withEmbedder(async (embedder) => {
      const [a, b] = await Promise.all([embedder.embed("Use the shared retry helper."), embedder.embed("Use the shared retry helper.")]);
      for (const [i, value] of a.entries()) expect(value).toBeCloseTo(b[i]!, 6);
    }));

    it("says whether it is ready without throwing for a ready embedder", () => withEmbedder(async (embedder) => {
      if (embedder.warm === undefined) return;
      expect(typeof (await embedder.warm(1_000))).toBe("boolean");
    }));
  });
}

export interface VectorsHarness {
  /** `ensureLesson` makes the lesson exist where the vectors need it to (a store that refuses a vector of a lesson it does not hold). */
  create(): Promise<{ vectors: LessonVectors; ensureLesson?: (workspaceId: string, project: string, id: string) => Promise<void>; dispose?: () => Promise<void> }>;
}

const COMPANY = "org_00000000000000000000";
const OTHER = "org_11111111111111111111";

export function runLessonVectorsConformance(name: string, harness: VectorsHarness): void {
  async function withVectors<T>(body: (vectors: LessonVectors, ensure: (workspaceId: string, project: string, id: string) => Promise<void>) => Promise<T>): Promise<T> {
    const { vectors, ensureLesson, dispose } = await harness.create();
    try { return await body(vectors, ensureLesson ?? (async () => undefined)); } finally { await dispose?.(); }
  }

  describe(`lesson vectors conformance: ${name}`, () => {
    it("keeps a lesson's vector and gives it back for the same spec (as 32-bit floats)", () => withVectors(async (vectors, ensure) => {
      await ensure(COMPANY, "web", "les_1");
      await vectors.put(COMPANY, "web", "spec-a", "les_1", { hash: "h1", vector: [0.1, 0.2, 0.3] });
      const found = await vectors.get(COMPANY, "web", "spec-a", ["les_1", "les_missing"]);
      expect([...found.keys()]).toEqual(["les_1"]);
      expect(found.get("les_1")?.hash).toBe("h1");
      expect(found.get("les_1")?.vector.map((value) => Math.round(value * 1000) / 1000)).toEqual([0.1, 0.2, 0.3]);
    }));

    it("gives nothing for another spec, and a new spec's vector replaces the old one", () => withVectors(async (vectors, ensure) => {
      await ensure(COMPANY, "web", "les_1");
      await vectors.put(COMPANY, "web", "spec-a", "les_1", { hash: "h1", vector: [1, 0] });
      expect((await vectors.get(COMPANY, "web", "spec-b", ["les_1"])).size).toBe(0);
      await vectors.put(COMPANY, "web", "spec-b", "les_1", { hash: "h2", vector: [0, 1] });
      expect((await vectors.get(COMPANY, "web", "spec-a", ["les_1"])).size).toBe(0);
      expect((await vectors.get(COMPANY, "web", "spec-b", ["les_1"])).get("les_1")?.hash).toBe("h2");
    }));

    it("removes a lesson's vector whatever its spec, and removing again is not an error", () => withVectors(async (vectors, ensure) => {
      await ensure(COMPANY, "web", "les_1");
      await vectors.put(COMPANY, "web", "spec-a", "les_1", { hash: "h1", vector: [1, 0] });
      await vectors.remove(COMPANY, "web", "les_1");
      await vectors.remove(COMPANY, "web", "les_1");
      expect((await vectors.get(COMPANY, "web", "spec-a", ["les_1"])).size).toBe(0);
    }));

    it("keeps companies and projects apart", () => withVectors(async (vectors, ensure) => {
      await ensure(COMPANY, "web", "les_1");
      await ensure(OTHER, "web", "les_1");
      await ensure(COMPANY, "api", "les_1");
      await vectors.put(COMPANY, "web", "spec-a", "les_1", { hash: "mine", vector: [1, 0] });
      expect((await vectors.get(OTHER, "web", "spec-a", ["les_1"])).size).toBe(0);
      expect((await vectors.get(COMPANY, "api", "spec-a", ["les_1"])).size).toBe(0);
      await vectors.remove(OTHER, "web", "les_1");
      expect((await vectors.get(COMPANY, "web", "spec-a", ["les_1"])).get("les_1")?.hash).toBe("mine");
    }));

    it("reads many ids in one call, each id once", () => withVectors(async (vectors, ensure) => {
      const ids = Array.from({ length: 150 }, (_, i) => `les_${String(i)}`);
      for (const id of ids) await ensure(COMPANY, "web", id);
      for (const id of ids) await vectors.put(COMPANY, "web", "spec-a", id, { hash: id, vector: [1] });
      const found = await vectors.get(COMPANY, "web", "spec-a", [...ids, ...ids]);
      expect(found.size).toBe(150);
    }));
  });
}
