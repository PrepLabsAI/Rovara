// Lane L4-LM1b: "under question" after a revert. A revert is evidence about a task, never blame against a lesson: the lesson is not changed or scored, and it is flagged only when a file of the revert is in the
// lesson's own code area. Ids and numbers only; one company's evidence is never another's.
import { describe, expect, it } from "vitest";
import { companyScoped, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { InMemoryLessonStore, type LoadManifest } from "../../../packages/broker/src/lessons/store.js";
import { QUESTION_FILES_MAX, QUESTION_KEEP_MS, markLessonsUnderQuestion, questionPk, readUnderQuestion } from "../../../packages/broker/src/lessons/revert-question.js";
import { lessonRecord, seed, Clock, WS, PROJECT, KEY } from "./lesson-helpers.js";

const ORG = WS as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const VIA = "a".repeat(40);
const TASK = "task-0001";

const manifest = (taskId: string, ids: string[], over: Partial<LoadManifest> = {}): LoadManifest => ({
  taskId, workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1,
  lessons: ids.map((id) => ({ id, version: 1, score: 0.5, why: "scope" as const, citation: "valid" as const })), bytes: 100, ...over,
});

async function world() {
  const clock = new Clock();
  const lessons = new InMemoryLessonStore();
  const docs = new MemoryDocumentStore();
  const deps = { lessons, docs, companyId: ORG, now: clock.now };
  return { clock, lessons, docs, deps };
}
const rowsOf = async (docs: MemoryDocumentStore, company: string = WS) => (await docs.query({ pk: questionPk(company, PROJECT) })).items;

describe("a revert puts the loaded lessons under question only where its files are in the lesson's own code area", () => {
  it("flags a loaded, active lesson whose path pattern matches a reverted file, and only that one", async () => {
    const { lessons, docs, deps, clock } = await world();
    await seed(lessons,
      lessonRecord({ id: "les_aaaa1111", scope: { paths: ["src/billing/**"] } }),
      lessonRecord({ id: "les_bbbb2222", scope: { paths: ["src/search/**"] } }),
      lessonRecord({ id: "les_cccc3333", scope: { paths: ["docs/**"] } }));
    await lessons.putManifest(manifest(TASK, ["les_aaaa1111", "les_bbbb2222", "les_cccc3333"]));
    const result = await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: VIA, files: ["src/billing/money.ts", "README.md"] });
    expect(result.marked).toEqual(["les_aaaa1111"]);
    const rows = await rowsOf(docs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "LESSON_QUESTION", kind: "revert_overlap", lessonId: "les_aaaa1111", taskId: TASK, via: VIA, project: PROJECT, at: clock.now(), keepUntil: clock.now() + QUESTION_KEEP_MS });
    expect(await readUnderQuestion(docs, ORG, PROJECT, clock.now())).toEqual([{ lessonId: "les_aaaa1111", tasks: 1, lastAt: clock.now() }]);
  });

  it("flags nothing when no reverted file is in any lesson's area (a revert for an unrelated reason blames no lesson)", async () => {
    const { lessons, docs, deps } = await world();
    await seed(lessons, lessonRecord({ id: "les_aaaa1111", scope: { paths: ["src/billing/**"] } }));
    await lessons.putManifest(manifest(TASK, ["les_aaaa1111"]));
    expect((await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: VIA, files: ["src/search/index.ts", "package.json"] })).marked).toEqual([]);
    expect(await rowsOf(docs)).toEqual([]);
  });

  it("a lesson with no code area (repository-wide) is not flagged by any revert", async () => {
    const { lessons, docs, deps } = await world();
    await seed(lessons, lessonRecord({ id: "les_aaaa1111", scope: { repos: ["api"] } }), lessonRecord({ id: "les_bbbb2222", scope: { paths: [] } }));
    await lessons.putManifest(manifest(TASK, ["les_aaaa1111", "les_bbbb2222"]));
    expect((await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: VIA, files: ["src/billing/money.ts"] })).marked).toEqual([]);
    expect(await rowsOf(docs)).toEqual([]);
  });

  it("files that could not be read whole (undefined), none, or too many flag nothing", async () => {
    const { lessons, docs, deps } = await world();
    await seed(lessons, lessonRecord({ id: "les_aaaa1111", scope: { paths: ["src/**"] } }));
    await lessons.putManifest(manifest(TASK, ["les_aaaa1111"]));
    for (const files of [undefined, [], Array.from({ length: QUESTION_FILES_MAX + 1 }, (_, i) => `src/f${String(i)}.ts`)]) {
      expect((await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: VIA, files })).marked).toEqual([]);
    }
    expect(await rowsOf(docs)).toEqual([]);
  });

  it("only a lesson the task loaded, that reached the prompt in a live step, and is active", async () => {
    const { lessons, docs, deps } = await world();
    await seed(lessons,
      lessonRecord({ id: "les_aaaa1111", scope: { paths: ["src/**"] } }),
      lessonRecord({ id: "les_bbbb2222", scope: { paths: ["src/**"] } }),
      lessonRecord({ id: "les_cccc3333", scope: { paths: ["src/**"] }, status: "retired" }),
      lessonRecord({ id: "les_dddd4444", scope: { paths: ["src/**"] } }),
      lessonRecord({ id: "les_eeee5555", scope: { paths: ["src/**"] } }));
    // loaded and valid; not loaded by this task; loaded but retired; dropped before the prompt; loaded only by an eval snapshot
    await lessons.putManifest(manifest(TASK, ["les_aaaa1111", "les_cccc3333"]));
    await lessons.putManifest({ ...manifest(TASK, ["les_dddd4444"]), stage: "PLAN", lessons: [{ id: "les_dddd4444", version: 1, score: 0.5, why: "scope", citation: "stale_dropped" }] });
    await lessons.putManifest({ ...manifest(TASK, ["les_eeee5555"]), stage: "REVIEW", memory: "snapshot", snapshotId: "snap-1" });
    expect((await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: VIA, files: ["src/a.ts"] })).marked).toEqual(["les_aaaa1111"]);
    expect((await rowsOf(docs)).map((row) => row["lessonId"])).toEqual(["les_aaaa1111"]);
  });

  it("is deduplicated per lesson, task and reverting commit; another commit or another task is another piece of evidence, and one revert never reaches the 'two reverts' of the review", async () => {
    const { lessons, docs, deps, clock } = await world();
    await seed(lessons, lessonRecord({ id: "les_aaaa1111", scope: { paths: ["src/**"] } }));
    await lessons.putManifest(manifest(TASK, ["les_aaaa1111"]));
    await lessons.putManifest(manifest("task-0002", ["les_aaaa1111"]));
    const once = await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: VIA, files: ["src/a.ts"] });
    const again = await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: VIA, files: ["src/a.ts"] });
    expect([once.marked, again.marked]).toEqual([["les_aaaa1111"], []]);
    expect(await rowsOf(docs)).toHaveLength(1);
    expect(await readUnderQuestion(docs, ORG, PROJECT, clock.now())).toEqual([{ lessonId: "les_aaaa1111", tasks: 1, lastAt: clock.now() }]);
    // the same task reverted by another commit adds a row but still one task; another task makes two
    await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: "b".repeat(40), files: ["src/a.ts"] });
    expect((await readUnderQuestion(docs, ORG, PROJECT, clock.now()))[0]!.tasks).toBe(1);
    await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: "task-0002", via: VIA, files: ["src/a.ts"] });
    expect((await readUnderQuestion(docs, ORG, PROJECT, clock.now()))[0]!.tasks).toBe(2);
  });

  it("changes nothing on the lesson: no counter, no status, no version, no expiry, no queued or settled mark", async () => {
    const { lessons, docs, deps } = await world();
    const original = lessonRecord({ id: "les_aaaa1111", scope: { paths: ["src/**"] } });
    await seed(lessons, original);
    await lessons.putManifest(manifest(TASK, ["les_aaaa1111"]));
    const before = JSON.stringify(await lessons.get(KEY, "les_aaaa1111"));
    expect((await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: VIA, files: ["src/a.ts"] })).marked).toEqual(["les_aaaa1111"]);
    expect(JSON.stringify(await lessons.get(KEY, "les_aaaa1111"))).toBe(before);
    const after = await lessons.get(KEY, "les_aaaa1111");
    expect(after).toMatchObject({ status: "active", version: 1, counters: { harmful: 0, helpful: 0 } });
    expect(await lessons.hasPending(KEY, "les_aaaa1111")).toBe(false);
    expect(await lessons.seenOnce(KEY, `harmful:${TASK}:les_aaaa1111`)).toBe(false);
    // only the evidence row was written to the document store
    expect(await rowsOf(docs)).toHaveLength(1);
  });

  it("holds ids and numbers only: no path, file name, words or person", async () => {
    const { lessons, docs, deps } = await world();
    await seed(lessons, lessonRecord({ id: "les_aaaa1111", scope: { paths: ["src/secret-project/**"] } }));
    await lessons.putManifest(manifest(TASK, ["les_aaaa1111"]));
    await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: VIA, files: ["src/secret-project/credentials.ts"] });
    const text = JSON.stringify(await rowsOf(docs));
    expect(text).not.toMatch(/secret-project|credentials|\.ts/u);
    expect(Object.keys((await rowsOf(docs))[0]!).sort()).toEqual(["at", "entityType", "keepUntil", "kind", "lessonId", "pk", "project", "sk", "taskId", "via"]);
  });

  it("a reverting commit that is not a commit id is stored as a digest, never as text", async () => {
    const { lessons, docs, deps } = await world();
    await seed(lessons, lessonRecord({ id: "les_aaaa1111", scope: { paths: ["src/**"] } }));
    await lessons.putManifest(manifest(TASK, ["les_aaaa1111"]));
    await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: "https://github.com/acme/x/pull/9 canary words", files: ["src/a.ts"] });
    const row = (await rowsOf(docs))[0]!;
    expect(String(row["via"])).toMatch(/^x[a-f0-9]{39}$/u);
    expect(JSON.stringify(row)).not.toContain("canary");
  });
});

describe("two companies: the evidence is the company's own", () => {
  it("rows are in the company's partition only, and another company's partition shows none", async () => {
    const { lessons, docs, deps, clock } = await world();
    await seed(lessons, lessonRecord({ id: "les_aaaa1111", scope: { paths: ["src/**"] } }));
    await lessons.putManifest(manifest(TASK, ["les_aaaa1111"]));
    await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: VIA, files: ["src/a.ts"] });
    expect(questionPk(ORG, PROJECT)).toBe(companyScoped(ORG, `LESSON_QUESTION#${PROJECT}`));
    expect(await rowsOf(docs, WS)).toHaveLength(1);
    expect(await rowsOf(docs, OTHER)).toEqual([]);
    expect(await readUnderQuestion(docs, OTHER, PROJECT, clock.now())).toEqual([]);
    expect(await readUnderQuestion(docs, ORG, "other-project", clock.now())).toEqual([]);
  });

  it("a deps object for another company reads the manifests of ITS partition, so a task of this company marks nothing there", async () => {
    const { lessons, docs, clock } = await world();
    await seed(lessons, lessonRecord({ id: "les_aaaa1111", scope: { paths: ["src/**"] } }));
    await lessons.putManifest(manifest(TASK, ["les_aaaa1111"]));
    const result = await markLessonsUnderQuestion({ lessons, docs, companyId: OTHER, now: clock.now }, { project: PROJECT, taskId: TASK, via: VIA, files: ["src/a.ts"] });
    expect(result.marked).toEqual([]);
    expect(await rowsOf(docs, WS)).toEqual([]);
    expect(await rowsOf(docs, OTHER)).toEqual([]);
  });

  it("the reader ignores a row that does not say what its key says, and rows past their keepUntil", async () => {
    const { lessons, docs, deps, clock } = await world();
    await seed(lessons, lessonRecord({ id: "les_aaaa1111", scope: { paths: ["src/**"] } }));
    await lessons.putManifest(manifest(TASK, ["les_aaaa1111"]));
    await markLessonsUnderQuestion(deps, { project: PROJECT, taskId: TASK, via: VIA, files: ["src/a.ts"] });
    await docs.put({ item: { pk: questionPk(WS, PROJECT), sk: "Q#les_zzzz9999#t#v", entityType: "SOMETHING", project: PROJECT, lessonId: "les_zzzz9999", taskId: "t", at: 1, keepUntil: clock.now() + 1000 } });
    await docs.put({ item: { pk: questionPk(WS, PROJECT), sk: "Q#les_yyyy8888#t#v", entityType: "LESSON_QUESTION", project: "elsewhere", lessonId: "les_yyyy8888", taskId: "t", at: 1, keepUntil: clock.now() + 1000 } });
    expect((await readUnderQuestion(docs, ORG, PROJECT, clock.now())).map((entry) => entry.lessonId)).toEqual(["les_aaaa1111"]);
    expect(await readUnderQuestion(docs, ORG, PROJECT, clock.now() + QUESTION_KEEP_MS + 1)).toEqual([]);
  });
});
