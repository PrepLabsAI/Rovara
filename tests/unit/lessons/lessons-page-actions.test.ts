// Erasure of an editor, Helpful / Wrong here marks that name nobody after erasure and count once per person per lesson, a stale first approval
//the version a reject and a rollback were asked for.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approveLesson, rejectLesson, rollbackLessonSet, type ApproveDeps } from "../../../packages/broker/src/lessons/approve.js";
import { recordFeedback } from "../../../packages/broker/src/lessons/counters.js";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { LessonSchema } from "../../../packages/broker/src/lessons/types.js";
import { Alerts, Audit, Clock, Judge, KEY, MemoryVectors, WS, allowAllAccess, directory, lessonRecord, seed, settings } from "./lesson-helpers.js";

const pending = (over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({
  id: "les_pend0001", status: "pending", tier: 1, tierReasons: ["not_a_fact"], type: "convention", approvals: [], pendingExpiresAt: 9e15,
  provenance: { ...lessonRecord().provenance, authors: ["carl"] }, ...over,
});
function setup(eligible = ["owner", "ann", "bob", "dee"]) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const dir = directory({ eligibleIds: eligible });
  let n = 0;
  const deps: ApproveDeps = { access: allowAllAccess, store, directory: dir, settings: settings(), audit, now: clock.now, newId: () => `ap-${++n}` };
  const vectors = new MemoryVectors();
  const port = lessonDeletionPort({ store, vectors, audit, now: clock.now });
  return { store, deps, audit, dir, port, clock };
}
const input = (approverId: string, extra: object = {}) => ({ ...KEY, lessonId: "les_pend0001", approverId, ...extra });
const edit = { title: "Use the shared retry helper", description: "", body: "Call withRetry for every HTTP call in api." };

describe("an editor is a writer of the text", () => {
  it("records the editor as an editor, not an author, so a one-tap edit keeps working; the lesson is hard-deleted with all its versions when the editor is erased", async () => {
    const s = setup();
    await seed(s.store, pending());
    expect(await approveLesson(s.deps, input("ann", { edit }))).toMatchObject({ ok: true, status: "active" });
    const live = (await s.store.get(KEY, "les_pend0001"))!;
    expect(live.provenance.editors).toEqual(["ann"]);
    expect(live.provenance.authors).toEqual(["carl"]);
    expect(await s.port.erasePerson(WS, KEY.project, { developerId: "ann" }, new Set())).toEqual({ purged: ["les_pend0001"], scrubbed: [] });
    expect(await s.store.get(KEY, "les_pend0001")).toBeUndefined();
    expect(await s.store.getHead(KEY, "les_pend0001")).toBeUndefined();
    expect(await s.store.versions(KEY, "les_pend0001")).toEqual([]);
  });
  it("erasing someone who only approved (did not edit) still scrubs rather than deletes", async () => {
    const s = setup();
    await seed(s.store, pending());
    await approveLesson(s.deps, input("ann", { edit }));
    expect(await s.port.erasePerson(WS, KEY.project, { developerId: "owner" }, new Set())).toEqual({ purged: [], scrubbed: [] });
    await approveLesson(setup().deps, input("bob")).catch(() => undefined);
    const s2 = setup();
    await seed(s2.store, pending());
    await approveLesson(s2.deps, input("bob"));
    expect((await s2.port.erasePerson(WS, KEY.project, { developerId: "bob" }, new Set())).scrubbed).toEqual(["les_pend0001"]);
    expect((await s2.store.get(KEY, "les_pend0001"))!.approvals[0]!.by).toBe("erased");
  });
  it("an editor who is no longer an approver (a later edit reset the approvals) is still found and the lesson deleted", async () => {
    const s = setup();
    await seed(s.store, pending({ tier: 2, tierReasons: ["escalation_words"] }));
    await approveLesson(s.deps, input("ann", { edit }));
    await approveLesson(s.deps, input("bob", { edit: { ...edit, body: "Call withRetry for every outgoing HTTP call." } }));
    const head = (await s.store.getHead(KEY, "les_pend0001"))!;
    expect(head.approvals.map((a) => a.by)).toEqual(["bob"]);
    expect(head.provenance.editors).toEqual(["ann", "bob"]);
    expect((await s.port.erasePerson(WS, KEY.project, { developerId: "ann" }, new Set())).purged).toEqual(["les_pend0001"]);
  });
  it("after the erasure fence a stale writer cannot put an erased editor back", async () => {
    const s = setup();
    await seed(s.store, pending());
    await s.store.fence(KEY, { people: ["ann"] });
    const stale = pending({ id: "les_late0001", provenance: { ...pending().provenance, sources: [], inputSources: [], authors: ["carl"], editors: ["Ann"] } });
    expect(await s.store.commit(KEY, await s.store.setVersion(KEY), [stale], 5)).toEqual({ ok: false, reason: "erased" });
    expect(await s.store.get(KEY, "les_late0001")).toBeUndefined();
  });
  it("an edit's intermediate save carries no approval given to the old text, even if the go-live then fails", async () => {
    const s = setup();
    await seed(s.store, pending({ approvals: [{ approvalId: "old", by: "owner", at: 1, mode: "one" }] }));
    const emit = s.audit.emit.bind(s.audit);
    s.audit.emit = async (event) => { if (event.action === "lesson.activated") throw new Error("audit down"); await emit(event); };
    expect(await approveLesson(s.deps, input("ann", { edit }))).toEqual({ ok: false, code: "audit_unavailable" });
    const kept = (await s.store.getHead(KEY, "les_pend0001"))!;
    expect(kept).toMatchObject({ status: "pending", body: edit.body });
    expect(kept.approvals).toEqual([]);
  });
  it("a lesson stored before the field existed reads as having no editors", () => {
    const old = JSON.parse(JSON.stringify(lessonRecord())) as Record<string, unknown>;
    expect((old.provenance as Record<string, unknown>).editors).toBeUndefined();
    expect(LessonSchema.parse(old).provenance.editors).toBeUndefined();
  });
  it("a writer cannot be hidden by editing again: every edit adds the editor once", async () => {
    const s = setup();
    await seed(s.store, pending({ tier: 2, tierReasons: ["escalation_words"] }));
    await approveLesson(s.deps, input("ann", { edit }));
    await approveLesson(s.deps, input("ann", { edit: { ...edit, body: "Call withRetry for every outgoing HTTP call." } }));
    await approveLesson(s.deps, input("bob", { edit: { ...edit, body: "Call withRetry for every outgoing HTTP request." } }));
    expect((await s.store.getHead(KEY, "les_pend0001"))!.provenance.editors).toEqual(["ann", "bob"]);
  });
  it("an edit by the first approver of a tier-2 lesson resets the approvals: they become first again and a second person is still needed", async () => {
    const s = setup();
    await seed(s.store, pending({ tier: 2, tierReasons: ["reviewer_stage"], type: "review_check", stages: ["REVIEW"] }));
    await approveLesson(s.deps, input("ann"));
    const out = await approveLesson(s.deps, input("ann", { edit: { ...edit, body: "Reviewers check the retry helper is used." } }));
    expect(out).toMatchObject({ ok: true, status: "pending", needs: "second_person" });
    expect((await s.store.get(KEY, "les_pend0001"))!.approvals.map((a) => a.by)).toEqual(["ann"]);
  });
});

describe("Helpful / Wrong here marks", () => {
  const manifest = { taskId: "task-1", workspaceId: WS, project: KEY.project, stage: "IMPLEMENT" as const, round: 1, setVersion: 1, memory: "live" as const, at: 1, bytes: 1, lessons: [{ id: "les_aaaa1111", version: 1, score: 1, why: "scope" as const, citation: "valid" as const }] };
  const feedbackDeps = (s: ReturnType<typeof setup>) => ({ ...s.deps, judge: new Judge(), alerts: new Alerts() });
  const mark = (s: ReturnType<typeof setup>, userId: string, kind: "helpful" | "wrong_here", taskId = "task-1") =>
    recordFeedback(feedbackDeps(s), { ...KEY, taskId, lessonId: "les_aaaa1111", userId, viewer: { principals: [], groups: [] }, kind });

  // The user id has letters that are not hex ("zed-person"): the reference is 24 random hex characters, and a short hex-like id ("dee") appears in one by chance about once in 260 runs.
  it("the stored key holds no value derived from the person, and erasing the person deletes the link to the reference it was made with", async () => {
    const s = setup();
    await seed(s.store, lessonRecord());
    await s.store.putManifest(manifest);
    expect(await mark(s, "zed-person", "helpful")).toEqual({ ok: true });
    const derived = createHash("sha256").update(`${WS}\u0001zed-person`).digest("hex").slice(0, 24);
    const names = s.store.onceNames(KEY).filter((name) => name.startsWith("feedback:"));
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain(derived);
    expect(names[0]).not.toContain("zed-person");
    const before = await s.store.markRef(KEY, "zed-person");
    await s.port.erasePerson(WS, KEY.project, { developerId: "zed-person" }, new Set());
    // The link is gone and the person is fenced: no new mark, and nothing can recompute the reference.
    expect(await s.store.markRef(KEY, "zed-person")).toBeUndefined();
    expect(await mark(s, "zed-person", "wrong_here")).toEqual({ ok: false, code: "not_permitted" });
    expect(before).toBeDefined();
    expect(names[0]).toContain(before!);
    // The count the mark made stays (a number, not a person).
    expect((await s.store.get(KEY, "les_aaaa1111"))!.counters.helpful).toBe(1);
  });
  it("erasing a person asks the store to delete their reference link", async () => {
    const s = setup();
    const seen: string[] = [];
    const real = s.store.forgetMarkRef.bind(s.store);
    s.store.forgetMarkRef = async (key, person) => { seen.push(person);await real(key, person); };
    await s.port.erasePerson(WS, KEY.project, { developerId: "dee" }, new Set());
    expect(seen).toEqual(["dee"]);
  });
  it("the link itself is deleted: forgetting it gives the person a different reference", async () => {
    const s = setup();
    const first = await s.store.markRef(KEY, "bob");
    expect(await s.store.markRef(KEY, "Bob")).toBe(first);
    await s.store.forgetMarkRef(KEY, "bob");
    expect(await s.store.markRef(KEY, "bob")).not.toBe(first);
  });
  it("one person marks a lesson once, whatever the task and the kind: two Wrong here marks from one person can't retire a tier-0 lesson, and Helpful can't outweigh others", async () => {
    const s = setup();
    await seed(s.store, lessonRecord({ tier: 0 }));
    await s.store.putManifest(manifest);
    await s.store.putManifest({ ...manifest, taskId: "task-2" });
    expect(await mark(s, "mallory", "wrong_here", "task-1")).toEqual({ ok: true });
    expect(await mark(s, "mallory", "wrong_here", "task-2")).toEqual({ ok: false, code: "repeat" });
    expect(await mark(s, "mallory", "helpful", "task-2")).toEqual({ ok: false, code: "repeat" });
    const lesson = (await s.store.get(KEY, "les_aaaa1111"))!;
    expect(lesson.counters).toMatchObject({ harmful: 1, helpful: 0 });
    expect(lesson.status).toBe("active");
    expect(await mark(s, "nora", "wrong_here", "task-2")).toEqual({ ok: true });
    expect((await s.store.getHead(KEY, "les_aaaa1111"))!.counters.harmful).toBe(2);
  });
});

describe("a first approval that no longer stands", () => {
  it("never loops on try again: Bob gives the first approval, Dee the second", async () => {
    const s = setup();
    await seed(s.store, pending({ tier: 2, tierReasons: ["reviewer_stage"], type: "review_check", stages: ["REVIEW"] }));
    await approveLesson(s.deps, input("ann"));
    s.dir.value.eligibleIds = ["owner", "bob", "dee"];
    expect(await approveLesson(s.deps, input("bob"))).toMatchObject({ ok: true, status: "pending" });
    expect(await approveLesson(s.deps, input("dee"))).toMatchObject({ ok: true, status: "active" });
  });
});

describe("reject checks the version on every attempt", () => {
  it("a commit lost to an edit that bumps the version is not retried against the new text", async () => {
    const s = setup();
    await seed(s.store, pending());
    const real = s.store.commit.bind(s.store);
    let lost = false;
    s.store.commit = async (key, expected, writes, at) => {
      if (!lost) {
        lost = true;
        // Someone else's edit lands first (version 2), so this commit fails on the set version.
        const head = (await s.store.get(KEY, "les_pend0001"))!;
        await real(key, expected, [{ ...head, version: 2, body: "A different wording that Ann never saw." }], at);
        return { ok: false, reason: "conflict" };
      }
      return real(key, expected, writes, at);
    };
    const out = await rejectLesson(s.deps, { ...KEY, lessonId: "les_pend0001", approverId: "ann", reason: "No", expectedVersion: 1 });
    expect(out).toEqual({ ok: false, code: "conflict" });
    expect((await s.store.get(KEY, "les_pend0001"))!).toMatchObject({ status: "pending", version: 2 });
  });
});

describe("rollback uses the set version the person saw", () => {
  it("a set that moved since is not rolled back, and nothing is restored or audited as done", async () => {
    const s = setup();
    const a = lessonRecord({ id: "les_rb000001", tier: 1, tierReasons: ["not_a_fact"], type: "convention" });
    await seed(s.store, a);
    const target = await s.store.setVersion(KEY);
    await s.store.commit(KEY, target, [{ ...a, version: 2, body: "Newer wording." }], 2);
    const seen = await s.store.setVersion(KEY);
    // A write the person never saw lands after they looked.
    await s.store.commit(KEY, seen, [{ ...a, version: 3, body: "Newest wording." }], 3);
    const out = await rollbackLessonSet(s.deps, { ...KEY, targetSetVersion: target, actorId: "ann", expectedSetVersion: seen });
    expect(out).toEqual({ ok: false, code: "conflict" });
    expect((await s.store.get(KEY, "les_rb000001"))!.body).toBe("Newest wording.");
    const fresh = await rollbackLessonSet(s.deps, { ...KEY, targetSetVersion: target, actorId: "ann", expectedSetVersion: await s.store.setVersion(KEY) });
    expect(fresh).toMatchObject({ ok: true });
  });
});
