// ForgetSources prunes provenance and record citations; a lesson with nothing left to rest on is withdrawn.
import { describe, expect, it } from "vitest";
import { lessonDeletionPort } from "../../../packages/core/src/lessons/deletion.js";
import { InMemoryLessonStore } from "../../../packages/core/src/lessons/store.js";
import type { Lesson } from "../../../packages/core/src/lessons/types.js";
import { Audit, Clock, KEY, MemoryVectors, PROJECT, WS, codeCite, embedder, lessonRecord, seed } from "./lesson-helpers.js";

function setup() {
  const store = new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const audit = new Audit();
  const clock = new Clock();
  const port = lessonDeletionPort({ store, vectors, audit, now: clock.now });
  const add = async (lesson: Lesson) => { await seed(store, lesson); await vectors.upsert(lesson.workspaceId, lesson.project, lesson.id, await embedder.embed(lesson.body), { status: lesson.status }); };
  return { store, vectors, audit, port, add };
}
const resting = (id: string, events: string[], over: Partial<Lesson> = {}): Lesson => lessonRecord({
  id, citations: [{ kind: "record", eventId: events[0]! }], citationChecks: undefined, lastValidatedAt: undefined,
  provenance: { ...lessonRecord().provenance, sourceEvents: events }, ...over,
});
const gone = (...ids: string[]) => new Set(ids);

describe("lesson deletion port (learning side)", () => {
  it("affected: lessons naming a deleted id in sources or record citations (also finished ones: their versions must be scrubbed), in this workspace and project only", async () => {
    const { port, add } = setup();
    await add(resting("les_a0000001", ["A"]));
    await add(resting("les_b0000001", ["B"]));
    await add(lessonRecord({ id: "les_c0000001", citations: [{ kind: "record", eventId: "A" }], provenance: { ...lessonRecord().provenance, sourceEvents: [] } }));
    await add(resting("les_d0000001", ["A"], { status: "retired" }));
    await add(resting("les_e0000001", ["A"], { workspaceId: "ws-B" }));
    await add(resting("les_f0000001", ["A"], { project: "proj-2" }));
    const found = await port.affected(WS, PROJECT, gone("A"));
    expect(found.map((l) => l.id).sort()).toEqual(["les_a0000001", "les_c0000001", "les_d0000001"]);
  });

  it("forgetSources prunes the deleted ids from provenance.sourceEvents AND record citations (a new version); counters survive", async () => {
    const { port, add, store } = setup();
    await add(resting("les_a0000001", ["A", "B"], { citations: [{ kind: "record", eventId: "A" }, { kind: "record", eventId: "B" }, { kind: "pr", url: "https://github.com/a/b/pull/1" }], counters: { loaded: 4, helpful: 2, harmful: 0, citationStale: 0 } }));
    await port.forgetSources(WS, PROJECT, "les_a0000001", gone("A"));
    const lesson = (await store.get(KEY, "les_a0000001"))!;
    expect(lesson.provenance.sourceEvents).toEqual(["B"]);
    expect(lesson.citations).toEqual([{ kind: "record", eventId: "B" }, { kind: "pr", url: "https://github.com/a/b/pull/1" }]);
    expect(lesson).toMatchObject({ version: 2, status: "active", counters: { loaded: 4, helpful: 2 } });
    expect((await store.versions(KEY, "les_a0000001")).map((v) => v.version)).toEqual([1, 2]);
  });

  it("sources shrink across runs: kept when A goes, WITHDRAWN when B goes later, and its vector is gone", async () => {
    const { port, add, store, vectors, audit } = setup();
    await add(resting("les_a0000001", ["A", "B"]));
    await port.forgetSources(WS, PROJECT, "les_a0000001", gone("A"));
    expect((await store.get(KEY, "les_a0000001"))!.status).toBe("active");
    expect(vectors.rows.size).toBe(1);
    await port.forgetSources(WS, PROJECT, "les_a0000001", gone("B"));
    const lesson = (await store.get(KEY, "les_a0000001"))!;
    expect(lesson.status).toBe("withdrawn");
    expect(lesson.provenance.sourceEvents).toEqual([]);
    expect(vectors.rows.size).toBe(0);
    expect(audit.events.filter((e) => e.action === "lesson.withdrawn")).toEqual([expect.objectContaining({ lessonId: "les_a0000001", facts: { cause: "sources_deleted" } })]);
  });

  it("a candidate or pending lesson with an empty provenance is withdrawn too", async () => {
    const { port, add, store } = setup();
    await add(resting("les_c0000001", ["A"], { status: "candidate", approvals: [] }));
    await add(resting("les_p0000001", ["A"], { status: "pending", approvals: [] }));
    await port.forgetSources(WS, PROJECT, "les_c0000001", gone("A"));
    await port.forgetSources(WS, PROJECT, "les_p0000001", gone("A"));
    expect((await store.get(KEY, "les_c0000001"))!.status).toBe("withdrawn");
    expect((await store.get(KEY, "les_p0000001"))!.status).toBe("withdrawn");
  });

  it("a lesson that a valid code citation alone supports stays, with no record sources left", async () => {
    const { port, add, store } = setup();
    await add(lessonRecord({ id: "les_code0001", lastValidatedAt: 5, citations: [codeCite(), { kind: "record", eventId: "A" }], citationChecks: [{ index: 0, result: "valid", at: 1 }], provenance: { ...lessonRecord().provenance, sourceEvents: ["A"] } }));
    await port.forgetSources(WS, PROJECT, "les_code0001", gone("A"));
    const lesson = (await store.get(KEY, "les_code0001"))!;
    // Only ever auto-applied, so it goes back to a person; it is kept, on code alone.
    expect(lesson).toMatchObject({ status: "pending", reviewRequired: true, approvals: [] });
    expect(lesson.provenance.sourceEvents).toEqual([]);
    expect(lesson.citations.map((c) => c.kind)).toEqual(["code"]);
    expect(lesson.citationChecks).toEqual([{ index: 0, result: "valid", at: 1 }]);
  });

  it("citation checks follow their citations when an earlier record citation is removed", async () => {
    const { port, add, store } = setup();
    await add(lessonRecord({ id: "les_chk00001", lastValidatedAt: 5, citations: [{ kind: "record", eventId: "A" }, codeCite()], citationChecks: [{ index: 1, result: "valid", at: 1 }], provenance: { ...lessonRecord().provenance, sourceEvents: ["A", "B"] } }));
    await port.forgetSources(WS, PROJECT, "les_chk00001", gone("A"));
    expect((await store.get(KEY, "les_chk00001"))!.citationChecks).toEqual([{ index: 0, result: "valid", at: 1 }]);
  });

  it("a lesson that names none of the ids, or belongs to another workspace, is untouched", async () => {
    const { port, add, store } = setup();
    await add(resting("les_a0000001", ["B"]));
    await add(resting("les_w0000001", ["A"], { workspaceId: "ws-B" }));
    await port.forgetSources(WS, PROJECT, "les_a0000001", gone("A"));
    await port.forgetSources(WS, PROJECT, "les_w0000001", gone("A"));
    expect((await store.get(KEY, "les_a0000001"))).toMatchObject({ version: 1, status: "active" });
    expect((await store.get({ workspaceId: "ws-B", project: PROJECT }, "les_w0000001"))).toMatchObject({ version: 1, status: "active" });
  });

  it("withdraw: sets the status, removes the vector, audits once, and is idempotent", async () => {
    const { port, add, store, vectors, audit } = setup();
    await add(resting("les_a0000001", ["A"]));
    await port.withdraw(WS, PROJECT, "les_a0000001", "sources_deleted");
    await port.withdraw(WS, PROJECT, "les_a0000001", "sources_deleted");
    expect((await store.get(KEY, "les_a0000001"))!.status).toBe("withdrawn");
    expect(vectors.rows.size).toBe(0);
    expect(audit.actions().filter((a) => a === "lesson.withdrawn")).toHaveLength(1);
  });
});
