// "Used in N tasks" (lessons holistic review fix 3): distinct tasks per lesson from the LESSON_USE rows, company and project scoped, expired rows left out, one total limit per call, and never a guess.
import { companyScoped, DocumentStoreError, type OrgId } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { countLessonUses, lessonUsePk, LESSON_USE_KEEP_SECONDS, USED_IN_MAX } from "../../../packages/broker/src/lessons/use-count.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";

const A = "org_usecount000000000000a" as OrgId;
const B = "org_usecount000000000000b" as OrgId;
const NOW = 1_800_000_000_000;
const TTL = "expiresAt";

const store = () => new MemoryDocumentStore({ ttlAttribute: TTL, nowSeconds: () => Math.floor(NOW / 1000) });
/** The row the loader writes (host-glue.ts), for one task. */
async function use(db: MemoryDocumentStore, companyId: OrgId, project: string, lessonId: string, taskId: string, over: Record<string, unknown> = {}): Promise<void> {
  await db.put({ item: { pk: companyScoped(companyId, `LESSON_USE#${project}#${lessonId}`), sk: taskId, entityType: "LESSON_USE", taskId, title: "t", at: NOW - 1000, [TTL]: Math.floor(NOW / 1000) + LESSON_USE_KEEP_SECONDS, ...over } });
}
const count = (db: MemoryDocumentStore, lessonIds: string[], over: Partial<Parameters<typeof countLessonUses>[1]> = {}) => countLessonUses(db, { companyId: A, project: "payments", lessonIds, now: NOW, ...over });

describe("used in N tasks", () => {
  it("control: counts each task once per lesson; a lesson nobody used is 0", async () => {
    const db = store();
    await use(db, A, "payments", "les_one", "t1");
    await use(db, A, "payments", "les_one", "t2");
    await use(db, A, "payments", "les_one", "t2");
    await use(db, A, "payments", "les_two", "t1");
    const answer = await count(db, ["les_one", "les_two", "les_none"]);
    expect(Object.fromEntries(answer.counts)).toEqual({ les_one: { tasks: 2 }, les_two: { tasks: 1 }, les_none: { tasks: 0 } });
    expect(answer.incomplete).toBe(false);
  });

  it("the key is the company's own partition, the same one the loader writes", () => {
    expect(lessonUsePk(A, "payments", "les_one")).toBe(companyScoped(A, "LESSON_USE#payments#les_one"));
    expect(lessonUsePk(A, "payments", "les_one")).not.toBe(lessonUsePk(B, "payments", "les_one"));
  });

  it("two companies, one project and lesson id: another company's rows are never counted, nor another project's", async () => {
    const db = store();
    await use(db, A, "payments", "les_one", "t1");
    for (const t of ["b1", "b2", "b3"]) await use(db, B, "payments", "les_one", t);
    await use(db, A, "billing", "les_one", "x1");
    expect((await count(db, ["les_one"])).counts.get("les_one")).toEqual({ tasks: 1 });
    expect((await countLessonUses(db, { companyId: B, project: "payments", lessonIds: ["les_one"], now: NOW })).counts.get("les_one")).toEqual({ tasks: 3 });
    expect((await countLessonUses(db, { companyId: A, project: "billing", lessonIds: ["les_one"], now: NOW })).counts.get("les_one")).toEqual({ tasks: 1 });
  });

  it("a row past its keep time (not yet swept), older than 180 days, or not shaped like a use row is not counted", async () => {
    const db = store();
    await use(db, A, "payments", "les_one", "ok");
    await use(db, A, "payments", "les_one", "ttl-gone", { [TTL]: Math.floor(NOW / 1000) - 1 });
    await use(db, A, "payments", "les_one", "too-old", { at: NOW - LESSON_USE_KEEP_SECONDS * 1000 - 1 });
    await use(db, A, "payments", "les_one", "no-time", { at: "yesterday" });
    await use(db, A, "payments", "les_one", "other-kind", { entityType: "LESSON_LOAD_REF" });
    await use(db, A, "payments", "les_one", "mismatch", { taskId: "someone-else" });
    expect((await count(db, ["les_one"])).counts.get("les_one")).toEqual({ tasks: 1 });
  });

  it("past the per-lesson cap the count says the cap and more", async () => {
    const db = store();
    for (let i = 0; i < 6; i += 1) await use(db, A, "payments", "les_one", `t${String(i)}`);
    expect((await count(db, ["les_one"], { limits: { perLesson: 5 } })).counts.get("les_one")).toEqual({ tasks: 5, more: true });
    expect((await count(db, ["les_one"], { limits: { perLesson: 6 } })).counts.get("les_one")).toEqual({ tasks: 6 });
    expect(USED_IN_MAX).toBe(500);
  });

  it("never a guess: a store fault, the total row limit or the deadline leaves the lesson uncounted and says incomplete", async () => {
    const db = store();
    for (let i = 0; i < 3; i += 1) await use(db, A, "payments", "les_one", `t${String(i)}`);
    await use(db, A, "payments", "les_two", "t1");
    db.injectFault(new DocumentStoreError("unavailable", "down"));
    const faulted = await count(db, ["les_one"]);
    expect(faulted.counts.has("les_one")).toBe(false);
    expect(faulted.incomplete).toBe(true);
    let queries = 0;
    let rows = 0;
    const watched = { ttlAttribute: TTL, query: async (request: Parameters<MemoryDocumentStore["query"]>[0]) => { queries += 1; const page = await db.query(request); rows += page.items.length; return page; } };
    const capped = await countLessonUses(watched, { companyId: A, project: "payments", lessonIds: ["les_one", "les_two"], now: NOW, limits: { rowsTotal: 2 } });
    expect(capped.counts.has("les_one")).toBe(false);
    expect(capped.incomplete).toBe(true);
    // Lessons counted at the same time never read past the total between them, and once it is used no further page is asked for.
    expect(rows).toBeLessThanOrEqual(2);
    expect(queries).toBeLessThanOrEqual(2);
    const late = await count(db, ["les_one"], { limits: { deadlineMs: 0 } });
    expect(late.counts.size).toBe(0);
    expect(late.incomplete).toBe(true);
  });

  it("bounded on a large input: 100 lessons with 600 uses each stop at the total row limit", async () => {
    const db = store();
    for (let l = 0; l < 100; l += 1) for (let t = 0; t < 600; t += 1) await use(db, A, "payments", `les_${String(l)}`, `t${String(t)}`);
    let queries = 0;
    let rows = 0;
    const watched = { ttlAttribute: TTL, query: async (request: Parameters<MemoryDocumentStore["query"]>[0]) => { queries += 1; const page = await db.query(request); rows += page.items.length; return page; } };
    const started = Date.now();
    const answer = await countLessonUses(watched, { companyId: A, project: "payments", lessonIds: Array.from({ length: 100 }, (_, l) => `les_${String(l)}`), now: NOW });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(queries).toBeLessThanOrEqual(20_000 / 200 + 100);
    expect(rows).toBeLessThanOrEqual(20_000);
    expect(answer.incomplete).toBe(true);
    for (const value of answer.counts.values()) expect(value).toEqual({ tasks: 500, more: true });
  }, 60_000);
  it("a store query that hangs is cut at the deadline: the lesson is uncounted, the answer is prompt and says incomplete", async () => {
    const hung = { ttlAttribute: TTL, query: async () => await new Promise<never>(() => undefined) };
    const started = Date.now();
    const answer = await countLessonUses(hung, { companyId: A, project: "payments", lessonIds: ["les_one", "les_two"], now: NOW, limits: { deadlineMs: 50 } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(answer.counts.size).toBe(0);
    expect(answer.incomplete).toBe(true);
  });

  it("a store that keeps answering empty pages with a cursor is stopped by the page cap, not only the deadline", async () => {
    let queries = 0;
    const spinning = { ttlAttribute: TTL, query: async () => { queries += 1; return { items: [], cursor: "again" }; } };
    const answer = await countLessonUses(spinning, { companyId: A, project: "payments", lessonIds: ["les_one"], now: NOW, limits: { rowsTotal: 400, deadlineMs: 60_000 } });
    expect(answer).toEqual({ counts: new Map(), incomplete: true });
    expect(queries).toBe(3);
  });
});
