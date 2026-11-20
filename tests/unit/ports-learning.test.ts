// The `learning` point (lane K1): the embedders and the vector stores Code has pass the learning conformance suites.
import { describe, expect, it } from "vitest";
import { PLUGIN_POINT_CARDINALITY, lessonKey } from "@agentx/contracts";
import { MemoryDocumentStore, createFixedLessonEmbedder, createMemoryLearningAdapter, createMemoryLessonVectors } from "../../packages/broker/src/ports/index.js";
import { createHashingEmbedder, createLocalLearningAdapter } from "../../packages/broker/src/lessons/local-embedder.js";
import { documentLessonVectors } from "../../packages/broker/src/lessons/document-vectors.js";
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

});
