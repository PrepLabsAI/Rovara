// READ tolerance for span kinds (lane L4-LM1a, step 1): a stored lesson whose provenance names a span kind this build does not know (a row a NEWER build wrote during a rolling deploy) is kept and valid:
// the kind is read as `other`; the row is listed, fetched, walked by the erase and erased like any other; and `other` carries no weight (the row's credit fields are read as written). This ships BEFORE any producer of a new kind.
import { lessonSetKey, queryAll } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { erasePersonLessons } from "../../../packages/broker/src/core-host/lessons.js";
import { DocumentLessonStore } from "../../../packages/broker/src/lessons/document-store.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { LessonProvenanceSchema, LessonSchema, SPAN_KINDS, type Lesson } from "../../../packages/broker/src/lessons/types.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { draft, lessonRecord } from "./lesson-helpers.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const KEY = { workspaceId: ORG, project: "web" };
const mk = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, workspaceId: ORG, project: "web", ...over });
/** A kind a still-newer build writes and this build has never heard of (not any kind in `SPAN_KINDS`, now or later: a made-up one). */
const NEW_KIND = "tracker_thread_reply";
const withKinds = (id: string, kinds: string[], prov: Record<string, unknown> = {}): Lesson => mk(id, { provenance: { ...draft().provenance, sourceKinds: kinds as never, ...prov } });

describe("the provenance schema reads an unknown span kind as other", () => {
  it("keeps every known kind as it is and reads any other string as `other`, never failing", () => {
    for (const kind of SPAN_KINDS) expect(LessonProvenanceSchema.parse({ ...draft().provenance, sourceKinds: [kind] }).sourceKinds).toEqual([kind]);
    const parsed = LessonProvenanceSchema.parse({ ...draft().provenance, sourceKinds: [NEW_KIND, "human_edit", "voice_note", "OTHER", ""] });
    expect(parsed.sourceKinds).toEqual(["other", "human_edit", "other", "other", "other"]);
    expect(LessonSchema.safeParse(withKinds("les_new00001", [NEW_KIND])).success).toBe(true);
  });
  it("still refuses what is not a string, a name over the bound, or a list over the bound (the row is corrupt, not newer)", () => {
    expect(LessonProvenanceSchema.safeParse({ ...draft().provenance, sourceKinds: [7] }).success).toBe(false);
    expect(LessonProvenanceSchema.safeParse({ ...draft().provenance, sourceKinds: ["x".repeat(101)] }).success).toBe(false);
    expect(LessonProvenanceSchema.safeParse({ ...draft().provenance, sourceKinds: Array.from({ length: 21 }, () => "human_edit") }).success).toBe(false);
  });
  it("gives the unknown kind no weight: the row's own credit fields are read exactly as written, whatever the kind says", () => {
    const strong = LessonSchema.parse(withKinds("les_new00001", [NEW_KIND]));
    expect(strong.provenance).toMatchObject({ sourceKinds: ["other"], memberSignal: true, measured: false, authors: ["ann"] });
    const bare = LessonSchema.parse(withKinds("les_new00002", [NEW_KIND], { memberSignal: false, authors: [] }));
    expect(bare.provenance).toMatchObject({ sourceKinds: ["other"], memberSignal: false, measured: false, authors: [] });
  });
});

describe("the in-memory store keeps a row with an unknown kind", () => {
  it("commits it and reads it back, fetched and listed, as `other`", async () => {
    const store = new InMemoryLessonStore();
    await store.commit(KEY, await store.setVersion(KEY), [withKinds("les_new00001", [NEW_KIND, "human_edit"])], 10);
    expect((await store.get(KEY, "les_new00001"))?.provenance.sourceKinds).toEqual(["other", "human_edit"]);
    expect((await store.list(KEY)).map((l) => l.id)).toEqual(["les_new00001"]);
  });
});

describe("an OLD reader over a row a newer build wrote (document store fixture)", () => {
  /** The stored items of one lesson (head and version) with the kinds a newer build wrote: the raw rows hold a kind this build has never listed. */
  async function seedNewerRow(): Promise<{ raw: MemoryDocumentStore; store: DocumentLessonStore }> {
    const raw = new MemoryDocumentStore();
    const store = new DocumentLessonStore(raw, () => 5, (id) => id, () => undefined);
    await store.commit(KEY, await store.setVersion(KEY), [mk("les_new00001", { provenance: { ...draft().provenance, authors: ["ann"], readFrom: ["ann"] } })], 10);
    let rewritten = 0;
    for (const row of await queryAll(raw, { pk: lessonSetKey(ORG, "web").pk })) {
      const provenance = (row as { provenance?: Record<string, unknown> }).provenance;
      if (provenance?.["sourceKinds"] === undefined) continue;
      await raw.put({ item: { ...row, provenance: { ...provenance, sourceKinds: [NEW_KIND, "pr_comment"] } } });
      rewritten += 1;
    }
    expect(rewritten).toBe(2);
    return { raw, store };
  }

  it("fetches, lists, pages and walks the row as `other` (before the change the head did not parse: invisible to every read, and the erase walk threw)", async () => {
    const { store } = await seedNewerRow();
    expect((await store.get(KEY, "les_new00001"))?.provenance.sourceKinds).toEqual(["other", "pr_comment"]);
    expect((await store.getHead(KEY, "les_new00001"))?.provenance.sourceKinds).toEqual(["other", "pr_comment"]);
    expect((await store.list(KEY)).map((l) => l.id)).toEqual(["les_new00001"]);
    expect((await store.listPage(KEY, { limit: 10 })).lessons.map((l) => l.id)).toEqual(["les_new00001"]);
    expect((await store.listAllHeads(KEY)).map((l) => l.id)).toEqual(["les_new00001"]);
    expect((await store.versions(KEY, "les_new00001")).map((v) => v.provenance.sourceKinds)).toEqual([["other", "pr_comment"]]);
  });

  it("an update by the old reader keeps the row (its kinds are written back as `other`; its credit fields and people are untouched)", async () => {
    const { store } = await seedNewerRow();
    const head = (await store.get(KEY, "les_new00001"))!;
    const result = await store.commit(KEY, await store.setVersion(KEY), [{ ...head, version: head.version + 1, title: "Edited title" }], 20);
    expect(result.ok).toBe(true);
    const after = (await store.get(KEY, "les_new00001"))!;
    expect(after.title).toBe("Edited title");
    expect(after.provenance).toMatchObject({ sourceKinds: ["other", "pr_comment"], authors: ["ann"], readFrom: ["ann"], memberSignal: true });
  });

  it("person erase still finds and deletes the row (it names the person in readFrom), and another company's same-id row is untouched", async () => {
    const { raw } = await seedNewerRow();
    const OTHER = "org_bbbbbbbbbbbbbbbbbbbb";
    const otherStore = new DocumentLessonStore(raw, () => 5, (id) => id, () => undefined);
    const otherKey = { workspaceId: OTHER, project: "web" };
    await otherStore.commit(otherKey, await otherStore.setVersion(otherKey), [mk("les_new00001", { workspaceId: OTHER, provenance: { ...draft().provenance, authors: ["ann"], readFrom: ["ann"] } })], 10);
    // The project catalog the erase walks.
    for (const company of [ORG, OTHER]) {
      const { orgProjectCatalogKey } = await import("@agentx/contracts");
      await raw.put({ item: { ...orgProjectCatalogKey(company, "web"), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    }
    const report = await erasePersonLessons({ store: raw, audit: { stage: () => [], record: async () => undefined }, companyId: ORG, personId: "ann", now: () => 9 });
    expect(report.purged).toBe(1);
    const reader = new DocumentLessonStore(raw, () => 9, (id) => id, () => undefined);
    expect(await reader.get(KEY, "les_new00001")).toBeUndefined();
    expect((await reader.get(otherKey, "les_new00001"))?.workspaceId).toBe(OTHER);
  });
});
