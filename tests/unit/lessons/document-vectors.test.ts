// The lesson vectors kept WITH the lessons in the document store (lessons/document-vectors.ts), and every way a lesson leaves: erasure, purge, withdrawal, retirement. A vector is derived from lesson
// text, so it must never outlive its lesson.
import { lessonKey, queryAll, teamRecordPk, type DocumentStore } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { retireLesson } from "../../../packages/core/src/lessons/curate.js";
import { lessonDeletionPort } from "../../../packages/core/src/lessons/deletion.js";
import { documentLessonVectors, lessonVectorKey } from "../../../packages/core/src/lessons/document-vectors.js";
import { DocumentLessonStore } from "../../../packages/core/src/lessons/document-store.js";
import { docOf, keepVector, rankLessons } from "../../../packages/core/src/lessons/similarity.js";
import { MemoryDocumentStore } from "../../../packages/core/src/ports/memory-document-store.js";
import { Audit, Clock, embedder, lessonRecord } from "./lesson-helpers.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const PROJECT = "web";
const KEY = { workspaceId: ORG_A, project: PROJECT };
const vec = (...v: number[]): number[] => v;
const mk = (id: string) => lessonRecord({ id, workspaceId: ORG_A, project: PROJECT });
const vecItems = async (db: MemoryDocumentStore) => (await queryAll(db, { pk: teamRecordPk(ORG_A, PROJECT) })).filter((item) => item.sk.endsWith("#VEC"));
/** A vector is only written beside a lesson head (the write is fenced on it): tests that exercise the vector item alone put a bare head first. */
const seedHeads = async (db: MemoryDocumentStore, ids: readonly string[]): Promise<void> => { for (const id of ids) await db.put({ item: { ...lessonKey(ORG_A, PROJECT, id), entityType: "LESSON", id } }); };

describe("the vector item", () => {
  it("is one item beside the lesson head, in the project's partition, as 32-bit floats; a spec mismatch is a miss; a new spec replaces the old item", async () => {
    const db = new MemoryDocumentStore();
    const vectors = documentLessonVectors(db);
    await seedHeads(db, ["les_aaaa1111"]);
    await vectors.put(ORG_A, PROJECT, "spec-a", "les_aaaa1111", { hash: "h1", vector: vec(0.5, -0.25, 1) });
    const [item] = await vecItems(db);
    expect(item).toMatchObject({ ...lessonVectorKey(ORG_A, PROJECT, "les_aaaa1111"), entityType: "LESSON_VECTOR", id: "les_aaaa1111", spec: "spec-a", hash: "h1" });
    expect(item!.sk).toBe("LESSON#les_aaaa1111#VEC");
    expect(item!["vector"]).toEqual([0.5, -0.25, 1]);
    const got = await vectors.get(ORG_A, PROJECT, "spec-a", ["les_aaaa1111", "les_missing1"]);
    expect([...got.keys()]).toEqual(["les_aaaa1111"]);
    expect(got.get("les_aaaa1111")).toEqual({ hash: "h1", vector: [0.5, -0.25, 1] });
    expect((await vectors.get(ORG_A, PROJECT, "spec-b", ["les_aaaa1111"])).size).toBe(0);
    await vectors.put(ORG_A, PROJECT, "spec-b", "les_aaaa1111", { hash: "h1", vector: vec(1, 0, 0) });
    expect(await vecItems(db)).toHaveLength(1);
    expect((await vectors.get(ORG_A, PROJECT, "spec-a", ["les_aaaa1111"])).size).toBe(0);
    expect((await vectors.get(ORG_A, PROJECT, "spec-b", ["les_aaaa1111"])).size).toBe(1);
  });

  it("rounds to 32-bit floats, as a binary of floats would", async () => {
    const db = new MemoryDocumentStore();
    const vectors = documentLessonVectors(db);
    await seedHeads(db, ["les_aaaa1111"]);
    await vectors.put(ORG_A, PROJECT, "s", "les_aaaa1111", { hash: "h", vector: vec(0.1) });
    expect((await vectors.get(ORG_A, PROJECT, "s", ["les_aaaa1111"])).get("les_aaaa1111")!.vector).toEqual([Math.fround(0.1)]);
  });

  it("reads a vector kept as base64 text of its floats too", async () => {
    const db = new MemoryDocumentStore();
    const vectors = documentLessonVectors(db);
    const bytes = Buffer.from(new Float32Array([1, 0.5]).buffer).toString("base64");
    await db.put({ item: { ...lessonVectorKey(ORG_A, PROJECT, "les_b6400001"), entityType: "LESSON_VECTOR", id: "les_b6400001", spec: "s", hash: "h", vector: bytes } });
    expect((await vectors.get(ORG_A, PROJECT, "s", ["les_b6400001"])).get("les_b6400001")).toEqual({ hash: "h", vector: [1, 0.5] });
  });

  it("another company or project never sees it; more than one batch of ids is read in full", async () => {
    const db = new MemoryDocumentStore();
    const vectors = documentLessonVectors(db);
    const ids = Array.from({ length: 230 }, (_, i) => `les_${String(i).padStart(8, "0")}`);
    await seedHeads(db, ids);
    for (const id of ids) await vectors.put(ORG_A, PROJECT, "s", id, { hash: "h", vector: vec(1, 2) });
    expect((await vectors.get(ORG_A, PROJECT, "s", ids)).size).toBe(230);
    expect((await vectors.get(ORG_B, PROJECT, "s", ids)).size).toBe(0);
    expect((await vectors.get(ORG_A, "api", "s", ids)).size).toBe(0);
  });

  it("an item that is not a vector of this spec, or does not parse, is a miss, never a vector", async () => {
    const db = new MemoryDocumentStore();
    const vectors = documentLessonVectors(db);
    await db.put({ item: { ...lessonVectorKey(ORG_A, PROJECT, "les_bad00001"), entityType: "LESSON_VECTOR", id: "les_bad00001", spec: "s", hash: "h", vector: [] } });
    await db.put({ item: { ...lessonVectorKey(ORG_A, PROJECT, "les_bad00002"), entityType: "LESSON_VECTOR", id: "les_bad00002", spec: "s", hash: "h", vector: "AAA" } });
    await db.put({ item: { ...lessonVectorKey(ORG_A, PROJECT, "les_oth00001"), entityType: "SOMETHING", id: "les_oth00001", spec: "s", hash: "h", vector: [1] } });
    expect((await vectors.get(ORG_A, PROJECT, "s", ["les_bad00001", "les_bad00002", "les_oth00001"])).size).toBe(0);
  });

  it("does not disturb the lesson store: the head, versions and the set read as before, and listAllHeads ignores the vector items", async () => {
    const db = new MemoryDocumentStore();
    const store = new DocumentLessonStore(db);
    await store.commit(KEY, await store.setVersion(KEY), [mk("les_aaaa1111"), mk("les_bbbb2222")], 10);
    await keepVector({ embedder, vectors: documentLessonVectors(db) }, KEY, mk("les_aaaa1111"), new Array<number>(256).fill(0.1));
    expect(await vecItems(db)).toHaveLength(1);
    expect((await store.listAllHeads(KEY)).map((l) => l.id)).toEqual(["les_aaaa1111", "les_bbbb2222"]);
    expect((await store.versions(KEY, "les_aaaa1111")).map((v) => v.version)).toEqual([1]);
  });
});

describe("a vector never outlives its lesson", () => {
  const setup = async () => {
    const db = new MemoryDocumentStore();
    const store = new DocumentLessonStore(db);
    const vectors = documentLessonVectors(db);
    await store.commit(KEY, await store.setVersion(KEY), [mk("les_aaaa1111"), mk("les_bbbb2222")], 10);
    for (const id of ["les_aaaa1111", "les_bbbb2222"]) await vectors.put(ORG_A, PROJECT, "s", id, { hash: "h", vector: vec(1, 0) });
    return { db, store, vectors };
  };

  it("the store's own purge removes it", async () => {
    const { db, store } = await setup();
    await store.purge(KEY, "les_aaaa1111");
    expect((await vecItems(db)).map((i) => i["id"])).toEqual(["les_bbbb2222"]);
  });

  it("the deletion port: a withdrawal and an erased person's lessons remove it (the vector step comes before the rows)", async () => {
    const { db, store, vectors } = await setup();
    const port = lessonDeletionPort({ store, vectors, audit: new Audit(), now: new Clock().now });
    await port.withdraw(ORG_A, PROJECT, "les_aaaa1111", "sources_deleted");
    expect((await vecItems(db)).map((i) => i["id"])).toEqual(["les_bbbb2222"]);
    await port.withdraw(ORG_A, PROJECT, "les_bbbb2222", "person_erased");
    expect(await vecItems(db)).toEqual([]);
    expect(await store.getHead(KEY, "les_bbbb2222")).toBeUndefined();
  });

  it("a vector that cannot be removed keeps the purge unfinished, and the retry removes it", async () => {
    const { db, store, vectors } = await setup();
    let failing = true;
    const flaky = { ...vectors, remove: async (w: string, p: string, id: string) => { if (failing) throw new Error("down"); return vectors.remove(w, p, id); } };
    const port = lessonDeletionPort({ store, vectors: flaky, audit: new Audit(), now: new Clock().now });
    await expect(port.withdraw(ORG_A, PROJECT, "les_aaaa1111", "person_erased")).rejects.toThrow();
    expect(await vecItems(db)).toHaveLength(2);
    expect(await store.getHead(KEY, "les_aaaa1111")).toBeDefined();
    failing = false;
    await port.resumePending(ORG_A, PROJECT);
    expect((await vecItems(db)).map((i) => i["id"])).toEqual(["les_bbbb2222"]);
    expect(await store.getHead(KEY, "les_aaaa1111")).toBeUndefined();
  });

  it("retiring a lesson removes it", async () => {
    const { db, store, vectors } = await setup();
    expect(await retireLesson({ store, vectors, audit: new Audit(), now: new Clock().now }, KEY, "les_aaaa1111", "test", "ann")).toBe(true);
    expect((await vecItems(db)).map((i) => i["id"])).toEqual(["les_bbbb2222"]);
  });
});

describe("a vector write is fenced like the lesson's own commit", () => {
  const embedAll = (lesson: ReturnType<typeof mk>, vectors: ReturnType<typeof documentLessonVectors>) => rankLessons({ embedder, vectors }, KEY, [lesson], docOf(mk("les_query001")), { embedMissing: true, queryKind: "document" });
  const world = async () => {
    const db = new MemoryDocumentStore();
    const store = new DocumentLessonStore(db);
    await store.commit(KEY, await store.setVersion(KEY), [mk("les_aaaa1111")], 10);
    return { db, store, vectors: documentLessonVectors(db) };
  };

  it("positive control: a lesson that exists gets its vector from the lazy backfill", async () => {
    const { db, vectors } = await world();
    await embedAll(mk("les_aaaa1111"), vectors);
    expect((await vecItems(db)).map((i) => i["id"])).toEqual(["les_aaaa1111"]);
  });

  it("a purge between the curator's read of the pool and its backfill leaves NO vector (an erased person's lesson text is not kept as an embedding)", async () => {
    const { db, store, vectors } = await world();
    const racing = { ...vectors, get: async (...args: Parameters<typeof vectors.get>) => { const found = await vectors.get(...args); await store.purge(KEY, "les_aaaa1111"); return found; } };
    const result = await embedAll(mk("les_aaaa1111"), racing);
    expect(result.mode).toBe("fused");
    expect(await vecItems(db)).toEqual([]);
    expect(await store.getHead(KEY, "les_aaaa1111")).toBeUndefined();
  });

  it("the purge MARK alone (the head not yet removed) already refuses the write; a withdrawn mark does not", async () => {
    const { db, store, vectors } = await world();
    await store.markGone(KEY, "les_aaaa1111", "purged");
    await vectors.put(ORG_A, PROJECT, "s", "les_aaaa1111", { hash: "h", vector: vec(1, 0) });
    expect(await vecItems(db)).toEqual([]);
    const other = await world();
    await other.store.markGone(KEY, "les_aaaa1111", "withdrawn");
    await other.vectors.put(ORG_A, PROJECT, "s", "les_aaaa1111", { hash: "h", vector: vec(1, 0) });
    expect(await vecItems(other.db)).toHaveLength(1);
  });

  it("a lesson that was never written takes no vector, and the refusal is silent (a no-op, not an error)", async () => {
    const { db, vectors } = await world();
    await expect(vectors.put(ORG_A, PROJECT, "s", "les_nothere1", { hash: "h", vector: vec(1, 0) })).resolves.toBeUndefined();
    expect(await vecItems(db)).toEqual([]);
  });

  it("the write is ONE transaction with both checks and the put", async () => {
    const db = new MemoryDocumentStore();
    const seen: Array<readonly string[]> = [];
    const spy: DocumentStore = {
      indexes: db.indexes, get: (k) => db.get(k), getMany: (k) => db.getMany(k), put: (r) => db.put(r), update: (r) => db.update(r), delete: (r) => db.delete(r), query: (r) => db.query(r), queryIndex: (r) => db.queryIndex(r),
      transact: (items) => { seen.push(items.map((item) => item.kind)); return db.transact(items); },
    };
    await new DocumentLessonStore(db).commit(KEY, 0, [mk("les_aaaa1111")], 10);
    await documentLessonVectors(spy).put(ORG_A, PROJECT, "s", "les_aaaa1111", { hash: "h", vector: vec(1, 0) });
    expect(seen).toEqual([["check", "check", "put"]]);
  });
});
