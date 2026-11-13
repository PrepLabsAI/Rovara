// What a stage is told. By default at most 5 lessons and 2 KB; a project may ask for more or less within the existing caps (12 lessons, 6 KB); a value outside them is ignored.
// Path scopes filter once the task's files are known, and a stage with no plan yet does not drop path-scoped lessons for want of files.
import { describe, expect, it } from "vitest";
import { LOAD_MAX_BYTES, LOAD_MAX_LESSONS, loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../../packages/core/src/lessons/load.js";
import { LOAD_DEFAULT_BYTES, LOAD_DEFAULT_LESSONS, resolveLearning, resolveLoadBudget } from "../../../packages/core/src/lessons/policy.js";
import { InMemoryLessonStore } from "../../../packages/core/src/lessons/store.js";
import type { Lesson } from "../../../packages/core/src/lessons/types.js";
import { Audit, Clock, MemoryVectors, PROJECT, WS, allowAllAccess, embedder, lessonRecord, seed, settings } from "./lesson-helpers.js";

function setup(s = settings()) {
  const store = new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const deps: LoadDeps = { access: allowAllAccess, store, embedder, vectors, settings: s, audit: new Audit(), now: new Clock().now };
  const add = async (...input: Lesson[]) => {
    const lessons = input.map((l) => ({ ...l, approvals: [...l.approvals, { approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const }] }));
    await seed(store, ...lessons);
    for (const l of lessons) await vectors.upsert(l.workspaceId, l.project, l.id, await embedder.embed(`${l.title}\n${l.body}`), { status: l.status });
  };
  return { deps, add };
}
const request = (over: Partial<LoadRequest> = {}): LoadRequest => ({
  workspaceId: WS, project: PROJECT, taskId: "task-1", stage: "IMPLEMENT", round: 1, intent: "Retry failed HTTP calls", repos: ["api"], files: [], languages: [], taskAudience: { kind: "shared" }, ...over,
});
const conv = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, type: "convention", tier: 1, ...over });
const many = (n: number, over: (i: number) => Partial<Lesson> = () => ({})) => Array.from({ length: n }, (_, i) => conv(`les_b${String(i).padStart(7, "0")}`, { title: `Lesson ${i}`, body: `Advice ${i}`, ...over(i) }));

describe("the load budget", () => {
  it("defaults to 5 lessons and 2 KB per stage", async () => {
    expect([LOAD_DEFAULT_LESSONS, LOAD_DEFAULT_BYTES]).toEqual([5, 2048]);
    const { deps, add } = setup();
    await add(...many(20));
    const result = await loadLessonsForStage(deps, request());
    expect(result.context!.lessons).toHaveLength(5);
    const heavy = setup();
    await heavy.add(...many(8, () => ({ body: `retry ${"x".repeat(560)}`, description: "d".repeat(150) })));
    const bytes = await loadLessonsForStage(heavy.deps, request());
    expect(bytes.manifest.bytes).toBeLessThanOrEqual(2048);
    expect(bytes.context!.lessons.length).toBeGreaterThan(0);
    expect(bytes.context!.lessons.length).toBeLessThan(5);
  });

  it("a project may ask for more or fewer, within the caps", async () => {
    const more = setup(settings({ loadBudget: { lessons: 9, bytes: 6 * 1024 } }));
    await more.add(...many(20));
    expect((await loadLessonsForStage(more.deps, request())).context!.lessons).toHaveLength(9);
    const fewer = setup(settings({ loadBudget: { lessons: 2 } }));
    await fewer.add(...many(20));
    expect((await loadLessonsForStage(fewer.deps, request())).context!.lessons).toHaveLength(2);
  });

  it("a value above the caps, below the floor or not a whole number is ignored and the default stands", () => {
    const caps = { lessons: LOAD_MAX_LESSONS, bytes: LOAD_MAX_BYTES };
    expect(resolveLoadBudget({ lessons: 13, bytes: 7000 }, caps)).toEqual({ lessons: 5, bytes: 2048 });
    expect(resolveLoadBudget({ lessons: 0, bytes: 10 }, caps)).toEqual({ lessons: 5, bytes: 2048 });
    expect(resolveLoadBudget({ lessons: 2.5, bytes: Number.NaN }, caps)).toEqual({ lessons: 5, bytes: 2048 });
    expect(resolveLoadBudget({ lessons: 12, bytes: 6144 }, caps)).toEqual({ lessons: 12, bytes: 6144 });
    expect(resolveLoadBudget(undefined, caps)).toEqual({ lessons: 5, bytes: 2048 });
  });

  it("the resolved settings carry the project's budget, and a settings reader that fails still reads as Off", async () => {
    expect((await resolveLearning(settings({ loadBudget: { lessons: 3 } }), WS, PROJECT)).loadBudget).toEqual({ lessons: 3 });
    expect((await resolveLearning(settings(), WS, PROJECT)).loadBudget).toBeUndefined();
    expect((await resolveLearning({ read: async () => { throw new Error("down"); } }, WS, PROJECT)).mode).toBe("Off");
  });
});

describe("path scopes filter", () => {
  it("once the files are known only lessons for those paths load; with no files known (before the plan) none is dropped for want of them", async () => {
    const { deps, add } = setup();
    await add(conv("les_api000001", { scope: { repos: ["api"], paths: ["src/api/**"] } }), conv("les_bill00001", { scope: { repos: ["api"], paths: ["src/billing/**"] } }), conv("les_open00001", { scope: { repos: ["api"] } }));
    const known = await loadLessonsForStage(deps, request({ files: ["src/billing/charge.ts"] }));
    expect(known.context!.lessons.map((l) => l.id).sort()).toEqual(["les_bill00001", "les_open00001"]);
    expect(known.manifest.lessons.find((e) => e.id === "les_bill00001")!.why).toBe("path");
    const unknown = await loadLessonsForStage(deps, request({ taskId: "task-2" }));
    expect(unknown.context!.lessons).toHaveLength(3);
  });
});

describe("the project's stored budget", () => {
  it("is written within the caps and read back through the settings reader, for that project only", async () => {
    const { documentLearningSettings, DocumentTier0Settings, writeLoadBudget } = await import("../../../packages/core/src/lessons/document-settings.js");
    const { MemoryDocumentStore } = await import("../../../packages/core/src/ports/memory-document-store.js");
    const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa";
    const store = new MemoryDocumentStore();
    const reader = documentLearningSettings(store, new DocumentTier0Settings(store));
    expect((await reader.read(ORG_A, "web")).loadBudget).toBeUndefined();
    expect(await writeLoadBudget(store, { workspaceId: ORG_A, project: "web" }, { lessons: 13 }, 1)).toBe(false);
    expect(await writeLoadBudget(store, { workspaceId: ORG_A, project: "web" }, { bytes: 100 }, 1)).toBe(false);
    expect(await writeLoadBudget(store, { workspaceId: ORG_A, project: "web" }, { lessons: 8, bytes: 4096 }, 1)).toBe(true);
    expect((await reader.read(ORG_A, "web")).loadBudget).toEqual({ lessons: 8, bytes: 4096 });
    expect((await reader.read(ORG_A, "api")).loadBudget).toBeUndefined();
  });
});
