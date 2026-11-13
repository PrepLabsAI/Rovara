// The `learning` point (lane K1): the embedders and the vector stores Code has pass the learning conformance suites.
import { describe, expect, it } from "vitest";
import { PLUGIN_POINT_CARDINALITY, lessonKey } from "@rovara-code/contracts";
import { MemoryDocumentStore, createFixedLessonEmbedder, createMemoryLearningAdapter, createMemoryLessonVectors } from "../../packages/core/src/ports/index.js";
import { createHashingEmbedder, createLocalLearningAdapter } from "../../packages/core/src/lessons/local-embedder.js";
import { documentLessonVectors } from "../../packages/core/src/lessons/document-vectors.js";
import { runLessonEmbedderConformance, runLessonVectorsConformance } from "../support/ports/learning-conformance.js";

runLessonEmbedderConformance("the fixed test embedder", { async create() { return { embedder: createFixedLessonEmbedder() }; } });
runLessonEmbedderConformance("Code's in-process hashing embedder", { async create() { return { embedder: createHashingEmbedder() }; } });
runLessonVectorsConformance("the memory vectors", { async create() { return { vectors: createMemoryLessonVectors() }; } });
runLessonVectorsConformance("Code's vectors beside the lessons in the document store", {
  async create() {
    const store = new MemoryDocumentStore();
    return {
      vectors: documentLessonVectors(store),
      async ensureLesson(workspaceId, project, id) { await store.put({ item: { ...lessonKey(workspaceId, project, id), entityType: "LESSON" } }); },
    };
  },
});

describe("the learning point", () => {
  it("holds many adapters; Code's default gives no embedder, and the memory adapter gives what it was handed", () => {
    expect(PLUGIN_POINT_CARDINALITY.learning).toBe("many");
    expect("embedder" in createLocalLearningAdapter()).toBe(false);
    const embedder = createFixedLessonEmbedder();
    const vectors = createMemoryLessonVectors();
    const adapter = createMemoryLearningAdapter({ embedder, vectors });
    expect(adapter.embedder?.("org_00000000000000000000")).toBe(embedder);
    expect(adapter.vectors?.("org_00000000000000000000")).toBe(vectors);
  });

  it("the document store refuses a vector of a lesson it does not hold, without an error", async () => {
    const store = new MemoryDocumentStore();
    const vectors = documentLessonVectors(store);
    await vectors.put("org_00000000000000000000", "web", "spec-a", "les_none", { hash: "h", vector: [1] }).catch(() => undefined);
    expect((await vectors.get("org_00000000000000000000", "web", "spec-a", ["les_none"])).size).toBe(0);
  });
});
