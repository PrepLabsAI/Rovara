// The lesson vectors, kept WITH the lessons in the `document-store` point. One item beside each lesson head, `LESSON#<id>#VEC`, in the project's partition: the embedder spec it was made by, the hash of
// the text it was made from, and the vector. There is no vector index (a project holds at most about 2,000 lessons; the search is a brute-force cosine in memory over the vectors read for one call).
//
//   - The sort key starts with `LESSON#`, so the project erase and the company erase wipe it with the lesson, and a purge removes it (`remove`, and the store's own purge).
//   - One item per lesson: a new spec REPLACES the old item, so a model change leaves nothing behind, and `get` returns only a vector of the asked spec (anything else is a miss: the lesson is embedded again).
//   - The item holds no person, no text and no id but the lesson's own: a derived vector of the lesson text, which the lesson's own history already holds.
//   - A write is FENCED like the lesson's own commit: one transaction holds the vector put, a check that the lesson head exists and a check that its GONE mark is not "purged". A curate that read the pool before
//     a purge (a person's erasure, a withdrawal that became a purge) and writes its backfill after it is refused, so no vector of erased text is left behind. A refused write is a no-op, not an error.
//   - Reads are batched gets of the ids the caller names (never a scan of the partition).
//
// A document holds JSON, so the vector is stored as the list of its 32-bit float values (a hosted install may keep the same item as a binary of those floats; both read back as the same numbers).
import { lessonKey, when, type DocumentStore, type OrgId, type StoredDocument } from "@agentx/contracts";
import type { LessonVectors, StoredLessonVector } from "./ports.js";

const BATCH = 100;
export const VECTOR_ENTITY = "LESSON_VECTOR";

/** The sort key of a lesson's vector item. */
export const lessonVectorKey = (orgId: OrgId, project: string, id: string): { pk: string; sk: string } => {
  const head = lessonKey(orgId, project, id);
  return { pk: head.pk, sk: `${head.sk}#VEC` };
};

/** The values rounded to 32-bit floats, as the numbers a document holds. */
const toNumbers = (vector: readonly number[]): number[] => Array.from(new Float32Array(vector));
function fromStored(value: unknown): number[] | undefined {
  if (Array.isArray(value)) return value.length > 0 && value.every((x) => typeof x === "number" && Number.isFinite(x)) ? (value as number[]) : undefined;
  if (typeof value === "string") {
    // The same floats as base64 text of their bytes.
    const bytes = Buffer.from(value, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return undefined;
    const copy = new Uint8Array(bytes);
    return Array.from(new Float32Array(copy.buffer));
  }
  return undefined;
}

export function documentLessonVectors(store: DocumentStore, orgOf: (workspaceId: string) => OrgId = (id) => id): LessonVectors {
  const keyOf = (workspaceId: string, project: string, id: string) => lessonVectorKey(orgOf(workspaceId), project, id);
  return {
    async get(workspaceId, project, spec, ids) {
      const found = new Map<string, StoredLessonVector>();
      const unique = [...new Set(ids)];
      for (let i = 0; i < unique.length; i += BATCH) {
        const keys = unique.slice(i, i + BATCH).map((id) => keyOf(workspaceId, project, id));
        const items = await store.getMany(keys);
        for (const item of items) {
          if (item === undefined) continue;
          const vector = fromStored(item["vector"]);
          if (item["entityType"] !== VECTOR_ENTITY || item["spec"] !== spec || typeof item["id"] !== "string" || typeof item["hash"] !== "string" || vector === undefined) continue;
          found.set(item["id"], { hash: item["hash"], vector });
        }
      }
      return found;
    },
    async put(workspaceId, project, spec, id, stored) {
      const vectorKey = keyOf(workspaceId, project, id);
      const head = { pk: vectorKey.pk, sk: vectorKey.sk.slice(0, -"#VEC".length) };
      const item: StoredDocument = { ...vectorKey, entityType: VECTOR_ENTITY, id, spec, hash: stored.hash, vector: toNumbers(stored.vector) };
      // The lesson is gone (purged, erased) or never existed: there is nothing to attach a vector to, and the write is refused without an error.
      await store.transact([
        { kind: "check", key: head, condition: when.present() },
        { kind: "check", key: { pk: head.pk, sk: `${head.sk}#GONE` }, condition: when.or(when.absent(), when.not(when.eq("mode", "purged"))) },
        { kind: "put", item },
      ]);
    },
    async remove(workspaceId, project, id) {
      await store.delete({ key: keyOf(workspaceId, project, id) });
    },
  };
}

