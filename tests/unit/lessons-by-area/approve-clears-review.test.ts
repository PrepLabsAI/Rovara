// Lead 4 L4-LP3Wb: a person's approval of a held or sent-back lesson clears `reviewRequired` in the same conditional commit, so the lesson reaches the agent's pull set and the wiki's "Team lessons for this area";
// a lesson whose other flag is still open stays out; only a person who may approve can clear it; two companies never meet.
import { describe, expect, it } from "vitest";
import { activateLesson, approveLesson, rejectLesson, type ApproveDeps } from "../../../packages/broker/src/lessons/approve.js";
import { pullable } from "../../../packages/broker/src/lessons/knowledge-brief.js";
import { loadPullForStage, type LoadDeps } from "../../../packages/broker/src/lessons/load.js";
import { teamLessonsForArea } from "../../../packages/broker/src/lessons/team-lessons.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Audit, Clock, KEY, PROJECT, WS, MemoryVectors, directory, embedder, lessonRecord, seed, settings, allowAllAccess } from "../lessons/lesson-helpers.js";

const OTHER_WS = "org_bbbbbbbbbbbbbbbbbbbb";
const authored = { ...lessonRecord().provenance, authors: ["carl"], supportTasks: [] as string[], sourceEvents: [] as string[] };
/** A lesson a person has not yet approved: waiting (pending) and sent back to a person (held source, brake, erasure). */
const held = (id: string, over: Partial<Lesson> = {}, ws = WS): Lesson => lessonRecord({
  id, workspaceId: ws, type: "convention", tier: 1, tierReasons: ["not_a_fact"], status: "pending", approvals: [], reviewRequired: true, pendingExpiresAt: 9e15,
  scope: { repos: ["api"], paths: ["src/billing/**"] }, title: `Title ${id}`, provenance: authored, ...over,
});

function setup(over: { dir?: ReturnType<typeof directory> } = {}) {
  const store = new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const audit = new Audit();
  const clock = new Clock();
  let n = 0;
  const approve: ApproveDeps = { access: allowAllAccess, store, directory: over.dir ?? directory(), settings: settings(), audit, now: clock.now, newId: () => `ap-${++n}` };
  const load: LoadDeps = { access: allowAllAccess, store, embedder, vectors, settings: settings(), audit: new Audit(), now: clock.now };
  const add = async (...lessons: Lesson[]) => {
    await seed(store, ...lessons);
    for (const l of lessons) await vectors.upsert(l.workspaceId, l.project, l.id, await embedder.embed(`${l.title}\n${l.description}\n${l.body}`), { status: l.status });
  };
  const pull = async (workspaceId = WS) => ((await loadPullForStage(load, { workspaceId, project: PROJECT, taskId: "task-1", stage: "IMPLEMENT", intent: "Work on billing", repos: ["api"], files: [], languages: [] }))?.picked ?? []).map((l) => l.id).sort();
  const page = async (workspaceId = WS) => (await teamLessonsForArea(load, { key: { workspaceId, project: PROJECT }, target: { area: { repo: "api", folder: "src/billing" } } }))?.lessons.map((l) => l.id).sort() ?? [];
  const input = (approverId: string, lessonId: string, workspaceId = WS) => ({ workspaceId, project: PROJECT, lessonId, approverId });
  return { approve, load, store, audit, clock, add, pull, page, input };
}

describe("a held lesson a person approves", () => {
  it("is out of the pull set and the page while held, and in both once a person approves it; the approval and the cleared flag are one commit", async () => {
    const w = setup();
    await w.add(held("les_held0001"), { ...held("les_okay0001"), status: "active", reviewRequired: undefined, approvals: [{ approvalId: "ap-ann", by: "ann", at: 1, mode: "one" }] } as Lesson);
    expect(await w.pull()).toEqual(["les_okay0001"]);
    expect(await w.page()).toEqual(["les_okay0001"]);
    const commits: Lesson[][] = [];
    const real = w.store.commit.bind(w.store);
    w.store.commit = async (...args: Parameters<typeof real>) => { commits.push([...args[2]]); return real(...args); };
    let mutated = 0;
    const realMutate = w.store.mutate.bind(w.store);
    w.store.mutate = ((...args: Parameters<typeof realMutate>) => { mutated += 1; return realMutate(...args); }) as typeof w.store.mutate;
    expect(await approveLesson(w.approve, w.input("ann", "les_held0001"))).toMatchObject({ ok: true, status: "active" });
    const stored = (await w.store.get(KEY, "les_held0001"))!;
    expect(stored).toMatchObject({ status: "active", approvals: [{ by: "ann", mode: "one" }] });
    expect(stored.reviewRequired).toBeUndefined();
    // One commit made it live, with the flag already gone; no commit ever wrote it live while still flagged, and no second write cleared it afterwards.
    const live = commits.flat().filter((l) => l.id === "les_held0001" && l.status === "active");
    expect(live).toHaveLength(1);
    expect(live[0]!.reviewRequired).toBeUndefined();
    expect(mutated).toBe(0);
    expect(pullable(stored)).toBe(true);
    expect(await w.pull()).toEqual(["les_held0001", "les_okay0001"]);
    expect(await w.page()).toEqual(["les_held0001", "les_okay0001"]);
    // Audited as today: the approval and the go-live, nothing new.
    expect(w.audit.actions().filter((a) => a.startsWith("lesson."))).toEqual(["lesson.approved", "lesson.activated"]);
  });

  it("an edited approval (Keep with an edit) clears the flag the same way", async () => {
    const w = setup();
    await w.add(held("les_edit0001"));
    expect(await approveLesson(w.approve, { ...w.input("ann", "les_edit0001"), edit: { title: "Use withRetry", description: "", body: "Prefer small pull requests." } })).toMatchObject({ ok: true, status: "active" });
    const stored = (await w.store.get(KEY, "les_edit0001"))!;
    expect(stored).toMatchObject({ status: "active", title: "Use withRetry" });
    expect(stored.reviewRequired).toBeUndefined();
  });

  it("a held tier-2 lesson keeps its flag after the first of two approvals, and loses it only when the second makes it live", async () => {
    const w = setup({ dir: directory({ eligibleIds: ["ann", "bob", "carl"], ownerIds: ["ann", "bob", "carl"] }) });
    await w.add(held("les_tier2001", { tier: 2, tierReasons: ["security"] }));
    expect(await approveLesson(w.approve, w.input("ann", "les_tier2001"))).toMatchObject({ ok: true, status: "pending", needs: "second_person" });
    expect((await w.store.get(KEY, "les_tier2001"))).toMatchObject({ status: "pending", reviewRequired: true });
    expect(await approveLesson(w.approve, w.input("bob", "les_tier2001"))).toMatchObject({ ok: true, status: "active" });
    expect((await w.store.get(KEY, "les_tier2001"))!.reviewRequired).toBeUndefined();
  });
});

describe("a lesson with another flag still open stays out", () => {
  it("an approved lesson that still contradicts another, may duplicate another or has a retire proposal is not pulled and not on the page, though its review flag is gone", async () => {
    const w = setup();
    await w.add(
      { ...held("les_base0001"), status: "active", reviewRequired: undefined, approvals: [{ approvalId: "ap-ann", by: "ann", at: 1, mode: "one" }] } as Lesson,
      held("les_contra01", { contradictsWith: "les_base0001" }), held("les_dup00001", { possibleDuplicateOf: "les_base0001" }),
    );
    expect(await approveLesson(w.approve, w.input("ann", "les_contra01"))).toMatchObject({ ok: true, status: "active" });
    expect(await approveLesson(w.approve, w.input("ann", "les_dup00001"))).toMatchObject({ ok: true, status: "active" });
    for (const id of ["les_contra01", "les_dup00001"]) {
      const stored = (await w.store.get(KEY, id))!;
      expect(stored.reviewRequired).toBeUndefined();
      expect(pullable(stored)).toBe(false);
    }
    expect(await w.pull()).toEqual(["les_base0001"]);
    expect(await w.page()).toEqual(["les_base0001"]);
    // The retire proposal stays on a lesson the approval step never touches (it is not pending), and keeps it out.
    expect(pullable({ ...(await w.store.get(KEY, "les_base0001"))!, retireProposedAt: 5 })).toBe(false);
  });
});

describe("only a person who may approve clears the flag", () => {
  it("someone who is not a maintainer, a stale version, a rejection, a missing eligibility answer and a lesson the approver cannot read all leave it set", async () => {
    const w = setup();
    await w.add(held("les_held0001"));
    expect(await approveLesson(w.approve, w.input("mallory", "les_held0001"))).toEqual({ ok: false, code: "not_eligible" });
    expect(await approveLesson(w.approve, { ...w.input("ann", "les_held0001"), expectedVersion: 9 })).toEqual({ ok: false, code: "conflict" });
    const incomplete = { ...w.approve, directory: directory({ complete: false }) };
    expect(await approveLesson(incomplete, w.input("ann", "les_held0001"))).toEqual({ ok: false, code: "eligibility_unavailable" });
    const blind = { ...w.approve, access: { ...allowAllAccess, mayRead: async (_o: string, _v: unknown, places: readonly unknown[]) => places.map(() => false) } as never };
    await w.add(held("les_secret001", { provenance: { ...authored, audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T/C9", principals: ["U-x"], capturedAt: "x", liveCheck: "none" } } } }));
    expect(await approveLesson(blind, w.input("ann", "les_secret001"))).toEqual({ ok: false, code: "not_permitted" });
    expect(await w.store.get(KEY, "les_held0001")).toMatchObject({ status: "pending", reviewRequired: true, approvals: [], version: 1 });
    expect(await w.store.get(KEY, "les_secret001")).toMatchObject({ status: "pending", reviewRequired: true });
    expect(await rejectLesson(w.approve, { ...KEY, lessonId: "les_held0001", approverId: "ann", reason: "wrong" })).toEqual({ ok: true });
    expect((await w.store.get(KEY, "les_held0001"))).toMatchObject({ status: "rejected", reviewRequired: true });
    expect(await w.pull()).toEqual([]);
  });

  it("the author who may not approve alone cannot clear it", async () => {
    const w = setup();
    await w.add(held("les_own00001", { provenance: { ...authored, authors: ["ann"] } }));
    expect(await approveLesson(w.approve, w.input("ann", "les_own00001"))).toEqual({ ok: false, code: "author_cannot_approve_alone" });
    expect(await w.store.get(KEY, "les_own00001")).toMatchObject({ status: "pending", reviewRequired: true });
    expect(await w.pull()).toEqual([]);
  });

  it("a go-live that is not a person's decision just now (a restore re-counting old approvals, the automatic path, a trial) never clears the flag; only the person's own pin does", async () => {
    const w = setup();
    const pinOf = async (extra: object = {}) => ({ version: 1, setVersion: await w.store.setVersion(KEY), ...extra });
    const people = [{ approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const }];
    for (const [id, action] of [["les_rest0001", "lesson.activated"], ["les_auto0001", "lesson.auto_applied"], ["les_tri00001", "lesson.trial_started"]] as const) {
      await w.add(held(id));
      const live = await activateLesson(w.approve, KEY, (await w.store.get(KEY, id))!, people, 90, action, await pinOf());
      expect(live, id).toMatchObject({ status: "active", reviewRequired: true });
    }
    // The same call with the person's pin (what `approveLesson` builds after its checks) clears it, and only on `lesson.activated`.
    await w.add(held("les_pers0001"), held("les_pers0002"));
    expect(await activateLesson(w.approve, KEY, (await w.store.get(KEY, "les_pers0001"))!, people, 90, "lesson.activated", await pinOf({ decidedByPerson: true }))).toMatchObject({ status: "active" });
    expect((await w.store.get(KEY, "les_pers0001"))!.reviewRequired).toBeUndefined();
    const trialled = await activateLesson(w.approve, KEY, (await w.store.get(KEY, "les_pers0002"))!, people, 90, "lesson.trial_started", await pinOf({ decidedByPerson: true }));
    expect(trialled).toMatchObject({ reviewRequired: true });
  });
});

describe("two companies", () => {
  it("the same lesson id and project in another company is untouched by an approval, and never shows in this company's pull set or page", async () => {
    const a = setup();
    const store = a.store;
    await a.add(held("les_same0001"), held("les_same0001", {}, OTHER_WS));
    expect(await approveLesson(a.approve, a.input("ann", "les_same0001"))).toMatchObject({ ok: true, status: "active" });
    expect((await store.get(KEY, "les_same0001"))!.reviewRequired).toBeUndefined();
    const other = (await store.get({ workspaceId: OTHER_WS, project: PROJECT }, "les_same0001"))!;
    expect(other).toMatchObject({ status: "pending", reviewRequired: true, approvals: [] });
    expect(await a.pull()).toEqual(["les_same0001"]);
    expect(await a.page()).toEqual(["les_same0001"]);
    expect(await a.pull(OTHER_WS)).toEqual([]);
    expect(await a.page(OTHER_WS)).toEqual([]);
    // A person who is eligible in one company cannot approve the other company's lesson through this one.
    const dir = directory();
    const scoped = { ...a.approve, directory: { ...dir, eligibility: async (ws: string, ...rest: [string, ...unknown[]]) => (ws === WS ? (dir.eligibility as (...x: unknown[]) => Promise<unknown>)(ws, ...rest) : { ...dir.value, eligibleIds: [], ownerIds: [] }) } as never };
    expect(await approveLesson(scoped, a.input("ann", "les_same0001", OTHER_WS))).toEqual({ ok: false, code: "not_eligible" });
    expect((await store.get({ workspaceId: OTHER_WS, project: PROJECT }, "les_same0001"))).toMatchObject({ reviewRequired: true, status: "pending" });
  });
});
