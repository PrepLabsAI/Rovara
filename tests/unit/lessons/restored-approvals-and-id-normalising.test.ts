// The sole-owner exception and the author rule on a restored approval, ONE id normaliser everywhere, the kill switch under a
// fence, the settle policy re-read at go-live, and an undefined settings row.
import { describe, expect, it } from "vitest";
import { approveLesson, rollbackLessonSet, retireByPerson, type ApproveDeps } from "../../../packages/broker/src/lessons/approve.js";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { resolveLearning, type LearningSettings, type LearningSettingsReader } from "../../../packages/broker/src/lessons/policy.js";
import { processDraft, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { scrubLesson } from "../../../packages/broker/src/lessons/scrub.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { distinctIds, idIn, normId, sameId } from "../../../packages/broker/src/lessons/types.js";
import { isCorroborated } from "../../../packages/broker/src/lessons/value.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, autoSettings, directory, draft, embedder, facts, lessonRecord, seed, settings, verifier, allowAllAccess } from "./lesson-helpers.js";

describe("a restored approval is re-checked against today's rules", () => {
  async function restore(approval: { by: string; mode: "one" | "second_person" | "sole_owner_exception" }, over: { tier: 0 | 1 | 2; eligibleIds: string[]; ownerIds?: string[]; authors?: string[]; approvals?: Array<{ by: string; mode: "one" | "second_person" | "sole_owner_exception" }> }) {
    const store = new InMemoryLessonStore();
    const approvals = (over.approvals ?? [approval]).map((a, i) => ({ approvalId: `a${i}`, by: a.by, at: 1, mode: a.mode }));
    const v1 = lessonRecord({ id: "les_rb000001", tier: over.tier, tierReasons: ["not_a_fact"], type: "convention", approvals, provenance: { ...draft().provenance, authors: over.authors ?? ["carl"] } });
    await seed(store, v1);
    await seed(store, { ...v1, version: 2, citations: [{ ...v1.citations[0]!, startLine: 40, endLine: 50 } as never] });
    const deps: ApproveDeps = { access: allowAllAccess, store, directory: directory({ eligibleIds: over.eligibleIds, ownerIds: over.ownerIds ?? [over.eligibleIds[0]!] }), settings: settings(), audit: new Audit(), now: new Clock().now };
    await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, actorId: over.eligibleIds[0]! });
    return (await store.get(KEY, "les_rb000001"))!;
  }

  it("the reviewer's probe: a tier-2 lesson with a sole-owner approval and 3 eligible people never comes back active on that one approval", async () => {
    const lesson = await restore({ by: "owner", mode: "sole_owner_exception" }, { tier: 2, eligibleIds: ["owner", "ann", "bob"] });
    expect(lesson.status).toBe("pending");
  });
  it("a sole-owner approval still stands while the team really is one person", async () => {
    const lesson = await restore({ by: "owner", mode: "sole_owner_exception" }, { tier: 2, eligibleIds: ["owner"], ownerIds: ["owner"] });
    expect(lesson.status).toBe("active");
  });
  it("the reviewer's probe: an author's own approval does not come back active while someone else could give it", async () => {
    const lesson = await restore({ by: "ann", mode: "one" }, { tier: 1, eligibleIds: ["owner", "ann", "bob"], authors: ["ann"] });
    expect(lesson.status).toBe("pending");
    expect(lesson.approvals).toEqual([]);
  });
  it("an author's approval, in another case, is still the author's", async () => {
    const lesson = await restore({ by: "Ann", mode: "one" }, { tier: 1, eligibleIds: ["owner", "Ann", "bob"], authors: ["ann"] });
    expect(lesson.status).toBe("pending");
  });
  it("a non-author's approval still comes back (control)", async () => {
    const lesson = await restore({ by: "bob", mode: "one" }, { tier: 1, eligibleIds: ["owner", "ann", "bob"] });
    expect(lesson.status).toBe("active");
  });
});

describe("one id normaliser everywhere", () => {
  it("the normaliser trims and ignores case; distinct ids keeps the first spelling", () => {
    expect(normId("  Mallory ")).toBe("mallory");
    expect(sameId("ann", "Ann ")).toBe(true);
    expect(idIn(["Bob", "Ann"], "ann")).toBe(true);
    expect(distinctIds(["ann", "Ann", "bob", " BOB"])).toEqual(["ann", "bob"]);
  });

  function setup() {
    const store = new InMemoryLessonStore();
    const vectors = new MemoryVectors();
    const clock = new Clock();
    const port = lessonDeletionPort({ store, vectors, audit: new Audit(), now: clock.now });
    return { store, vectors, port, clock };
  }
  const stored = (id: string, who: string, over: Partial<ReturnType<typeof lessonRecord>> = {}) => lessonRecord({
    id, approvals: [{ approvalId: "z", by: who, at: 1, mode: "one" }],
    provenance: { ...draft().provenance, authors: [who], sources: [`member:${who}`], inputSources: [`member:${who}`], sourceEvents: [] }, ...over,
  });

  it("the reviewer's probe: erasing 'mallory' purges the lesson stored as 'Mallory', and the reverse", async () => {
    for (const [storedAs, erasedAs] of [["Mallory", "mallory"], ["mallory", "Mallory"], [" MALLORY", "mallory"]] as const) {
      const { store, port } = setup();
      await seed(store, stored("les_a0000001", storedAs));
      expect(await port.erasePerson(WS, PROJECT, { developerId: erasedAs }, new Set())).toEqual({ purged: ["les_a0000001"], scrubbed: [] });
      expect(await store.getHead(KEY, "les_a0000001")).toBeUndefined();
    }
  });
  it("each rule on its own: written by 'Mallory' with another person approving (wrote), and only approved by 'Mallory' with no author (the only person)", async () => {
    const { store, port } = setup();
    await seed(store, lessonRecord({ id: "les_w0000001", approvals: [{ approvalId: "z", by: "ann", at: 1, mode: "one" }], provenance: { ...draft().provenance, authors: ["Mallory"], sources: [], inputSources: [], sourceEvents: [] } }));
    await seed(store, lessonRecord({ id: "les_o0000001", approvals: [{ approvalId: "z", by: "Mallory", at: 1, mode: "one" }], provenance: { ...draft().provenance, authors: [], sources: [], inputSources: [], sourceEvents: [] } }));
    expect((await port.erasePerson(WS, PROJECT, { developerId: "mallory" }, new Set())).purged.sort()).toEqual(["les_o0000001", "les_w0000001"]);
  });
  it("scrubbing: another lesson by 'Ann' with an approval by 'Mallory' loses every spelling of the erased id", async () => {
    const { store, port } = setup();
    await seed(store, lessonRecord({ id: "les_b0000001", approvals: [{ approvalId: "z", by: "Mallory", at: 1, mode: "one" }], provenance: { ...draft().provenance, authors: ["ann"], sources: ["member:ann", "member:MALLORY"], inputSources: ["member:Mallory"], sourceEvents: [] } }));
    expect((await port.erasePerson(WS, PROJECT, { developerId: "mallory" }, new Set())).scrubbed).toEqual(["les_b0000001"]);
    expect(JSON.stringify(await store.getHead(KEY, "les_b0000001")).toLowerCase()).not.toContain("mallory");
    expect(scrubLesson(stored("les_c0000001", "Mallory"), new Set(), new Set(["mallory"])).provenance.authors).toEqual([]);
  });
  it("forgetSources with an erased person works the same way", async () => {
    const { store, port } = setup();
    await seed(store, stored("les_d0000001", "Mallory"));
    await port.forgetSources(WS, PROJECT, "les_d0000001", new Set(), "person_erased", { developerId: "mallory" });
    expect(await store.getHead(KEY, "les_d0000001")).toBeUndefined();
  });
  it("corroboration: 'ann' and 'Ann' over two tasks are one author", () => {
    expect(isCorroborated({ measured: false, supportTasks: ["t1", "t2"], authors: ["ann", "Ann"] })).toBe(false);
    expect(isCorroborated({ measured: false, supportTasks: ["t1", "t2"], authors: ["ann", "bob"] })).toBe(true);
  });
  it("eligibility uses the same normaliser: 'Bob' may approve when the list holds 'bob'", async () => {
    const store = new InMemoryLessonStore();
    const approve: ApproveDeps = { access: allowAllAccess, store, directory: directory({ eligibleIds: ["owner", "ann", "bob"] }), settings: settings(), audit: new Audit(), now: new Clock().now };
    await seed(store, lessonRecord({ id: "les_e0000001", status: "pending", tier: 1, tierReasons: ["not_a_fact"], type: "convention", approvals: [], provenance: { ...draft().provenance, authors: ["carl"] } }));
    expect(await approveLesson(approve, { ...KEY, lessonId: "les_e0000001", approverId: " Bob" })).toMatchObject({ ok: true, status: "active" });
  });
  it("the kill switch: retire works while a fence is up, and what it writes is scrubbed against the fence (never a conflict)", async () => {
    const { store, port } = setup();
    const lesson = lessonRecord({ id: "les_f0000001", approvals: [{ approvalId: "z", by: "Mallory", at: 1, mode: "one" }], provenance: { ...draft().provenance, authors: ["ann"], sources: ["member:ann", "member:Mallory"], inputSources: [], sourceEvents: ["A"] }, citations: [{ kind: "record", eventId: "A" }], citationChecks: undefined });
    await seed(store, lesson);
    // A stale reader holds the lesson with the erased person; the fence goes up; the retire is still accepted.
    await store.fence(KEY, { people: ["mallory"], ids: ["A"] });
    const approve: ApproveDeps = { access: allowAllAccess, store, directory: directory(), settings: settings(), audit: new Audit(), now: new Clock().now };
    expect(await retireByPerson(approve, { ...KEY, lessonId: "les_f0000001", actorId: "ann", reason: "kill" })).toEqual({ ok: true });
    const head = (await store.getHead(KEY, "les_f0000001"))!;
    expect(head.status).toBe("retired");
    expect(JSON.stringify(head).toLowerCase()).not.toContain("mallory");
    expect(JSON.stringify(head)).not.toContain('"A"');
    void port;
  });
  it("a write that is not a narrowing is still refused by the fence", async () => {
    const store = new InMemoryLessonStore();
    await store.fence(KEY, { people: ["Mallory"] });
    expect(await store.commit(KEY, 0, [lessonRecord({ id: "les_g0000001", provenance: { ...draft().provenance, authors: ["mallory"] } })], 1)).toEqual({ ok: false, reason: "erased" });
    expect(await store.commit(KEY, 0, [lessonRecord({ id: "les_g0000002", status: "pending", provenance: { ...draft().provenance, authors: ["MALLORY"] } })], 1)).toEqual({ ok: false, reason: "erased" });
  });
});

describe("minors", () => {
  it("the settle policy is read again at go-live: a setting tightened while settling wins", async () => {
    let reads = 0;
    const flipping: LearningSettingsReader = { read: async (): Promise<LearningSettings> => { reads += 1; return reads <= 1 ? { mode: "On", tier0Approval: "auto" } : { mode: "On", tier0Approval: "one" }; } };
    let n = 0;
    const deps: ProcessDeps = { store: new InMemoryLessonStore(), embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), coldStartLessons: 0, facts: facts(), settings: flipping, newId: () => `les_fl${++n}` };
    const out = await processDraft(deps, KEY, draft({ provenance: { ...draft().provenance, measured: true, authors: ["mallory"], sources: ["member:mallory"], inputSources: ["member:mallory"] } }));
    expect(reads).toBeGreaterThan(1);
    expect(out.lesson).toMatchObject({ status: "pending", approvals: [] });
    // Control: a stable "auto" still goes live.
    const stable: ProcessDeps = { ...deps, store: new InMemoryLessonStore(), settings: autoSettings() };
    expect((await processDraft(stable, KEY, draft({ provenance: { ...draft().provenance, measured: true, authors: ["mallory"], sources: ["member:mallory"], inputSources: ["member:mallory"] } }))).lesson!.status).toBe("active");
  });

  it("an undefined settings row is the default (mode Suggest, tier 0 needs one person), not a throw; a reader that throws still fails closed", async () => {
    const none = { read: async () => undefined as unknown as LearningSettings };
    expect(await resolveLearning(none, "w", "p")).toMatchObject({ mode: "Suggest", approval: { tier0: "one", tier1: "one" } });
    expect((await resolveLearning({ read: async () => { throw new Error("down"); } }, "w", "p")).mode).toBe("Off");
  });
});
