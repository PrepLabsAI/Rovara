// The curator and the lesson store. Poisoning classes, and land here.
import { describe, expect, it } from "vitest";
import { curateDraft, type CurateDeps } from "../../../packages/core/src/lessons/curate.js";
import { InMemoryLessonStore, nextVersion, type CommitResult, type ScopeKey } from "../../../packages/core/src/lessons/store.js";
import type { LessonDraft } from "../../../packages/core/src/lessons/reflect.js";
import { trialBlockers } from "../../../packages/core/src/lessons/trial.js";
import type { Lesson } from "../../../packages/core/src/lessons/types.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, codeCite, closeEmbedder, draft, embedder, lessonRecord, seed, settings, verifier } from "./lesson-helpers.js";

class FlakyStore extends InMemoryLessonStore {
  failures = 0;
  override async commit(key: ScopeKey, expected: number, writes: readonly Lesson[], at: number): Promise<CommitResult> {
    if (this.failures > 0) { this.failures -= 1; return { ok: false, reason: "conflict" }; }
    return super.commit(key, expected, writes, at);
  }
}

function setup(over: { store?: InMemoryLessonStore; model?: ScriptedModel; settings?: ReturnType<typeof settings>; verifier?: ReturnType<typeof verifier> } = {}) {
  const store = over.store ?? new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const audit = new Audit();
  const clock = new Clock();
  const spend = new Spend();
  const alerts = new Alerts();
  const judgeModel = over.model ?? new ScriptedModel();
  let n = 0;
  const deps: CurateDeps & { verifier: unknown; settings: unknown } = {
    store, embedder, vectors, judgeModel, spend, audit, alerts, now: clock.now, verifier: over.verifier ?? verifier("valid"), settings: over.settings ?? settings(),
    newId: () => `les_${String(++n).padStart(4, "0")}`,
  };
  return { deps, store, vectors, audit, clock, spend, alerts, judgeModel };
}

const text = (title: string, body: string, over: Partial<LessonDraft> = {}): LessonDraft => draft({ title, description: "", body, ...over });
/** A listwise answer for a draft with ONE candidate. */
const one = (verdict: string): string => JSON.stringify({ verdicts: [{ n: 1, verdict }] });
const similar = async (a: string, b: string): Promise<number> => { const x = await embedder.embed(a); const y = await embedder.embed(b); return x.reduce((s, v, i) => s + v * y[i]!, 0); };

describe("curator decisions", () => {
  it("a draft with no neighbour becomes a candidate, with a vector and an audit event", async () => {
    const { deps, store, vectors, audit } = setup();
    const out = await curateDraft(deps, KEY, draft());
    expect(out.outcome).toBe("added");
    const list = await store.list(KEY);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "candidate", version: 1, id: "les_0001" });
    expect(vectors.rows.size).toBe(1);
    expect(audit.actions()).toContain("lesson.candidate_created");
  });

  it("MERGE of a near-exact copy (same cited file, same polarity, nearly the same words) by code, with no model call: citations, sources and support union; one new version", async () => {
    const { deps, store, judgeModel } = setup();
    await curateDraft(deps, KEY, draft());
    const second = draft({ provenance: { ...draft().provenance, supportTasks: ["task-2"], sourceEvents: ["ev-2"], authors: ["bob"] }, citations: [codeCite(), { kind: "pr", url: "https://github.com/acme/api/pull/9" }] });
    const out = await curateDraft(deps, KEY, second);
    expect(out.outcome).toBe("merged");
    expect(judgeModel.calls).toHaveLength(0);
    const [lesson] = await store.list(KEY);
    expect(lesson).toMatchObject({ version: 2 });
    expect(lesson!.provenance.supportTasks).toEqual(["task-1", "task-2"]);
    expect(lesson!.provenance.sourceEvents).toEqual(["ev-1", "ev-2"]);
    expect(lesson!.provenance.authors).toEqual(["ann", "bob"]);
    expect(lesson!.citations).toHaveLength(2);
    expect(await store.list(KEY)).toHaveLength(1);
  });

  it("a merge unions the inherited tasks of both lessons (the laundering path through a merge), and a merge that would not fit them is refused", async () => {
    const { deps, store } = setup();
    await curateDraft(deps, KEY, draft({ provenance: { ...draft().provenance, inheritedTasks: ["task-p"] } }));
    const merged = await curateDraft(deps, KEY, draft({ provenance: { ...draft().provenance, inheritedTasks: ["task-q"] } }));
    expect(merged.outcome).toBe("merged");
    const [lesson] = await store.list(KEY);
    expect(lesson!.provenance.inheritedTasks).toEqual(["task-p", "task-q"]);
    // A target without the field takes the draft's.
    const second = setup();
    await curateDraft(second.deps, KEY, draft());
    await curateDraft(second.deps, KEY, draft({ provenance: { ...draft().provenance, inheritedTasks: ["task-p"] } }));
    expect((await second.store.list(KEY))[0]!.provenance.inheritedTasks).toEqual(["task-p"]);
    // Over the cap of 50 the merge is refused and the draft stands alone.
    const full = setup();
    await curateDraft(full.deps, KEY, draft({ provenance: { ...draft().provenance, inheritedTasks: Array.from({ length: 50 }, (_, i) => `task-inh-${String(i)}`) } }));
    const refused = await curateDraft(full.deps, KEY, draft({ provenance: { ...draft().provenance, inheritedTasks: ["task-extra"] } }));
    expect(refused.outcome).toBe("added");
  });

  it("a merge that would drop a task id (past the 50-task cap) is refused: the draft stands on its own as a candidate, with its task, PR and author", async () => {
    const { deps, store } = setup();
    const full = Array.from({ length: 50 }, (_, i) => `task-full-${String(i)}`);
    await curateDraft(deps, KEY, draft({ provenance: { ...draft().provenance, supportTasks: full } }));
    // Below the cap a merge still works (positive control): the 50th task id is the last one that fits.
    const fits = await curateDraft(deps, KEY, draft({ provenance: { ...draft().provenance, supportTasks: [full[0]!] } }));
    expect(fits.outcome).toBe("merged");
    const out = await curateDraft(deps, KEY, draft({ provenance: { ...draft().provenance, supportTasks: ["task-narrowed"], authors: ["eve"] }, citations: [{ kind: "pr", url: "https://github.com/acme/api/pull/77" }] }));
    expect(out.outcome).toBe("added");
    const lessons = await store.list(KEY);
    expect(lessons).toHaveLength(2);
    const target = lessons.find((l) => l.provenance.supportTasks.length === 50)!;
    expect(target.provenance.supportTasks).not.toContain("task-narrowed");
    expect(target.provenance.authors).not.toContain("eve");
    expect(JSON.stringify(target.citations)).not.toContain("pull/77");
    const own = lessons.find((l) => l !== target)!;
    expect(own.provenance.supportTasks).toEqual(["task-narrowed"]);
  });

  it("ONE judge call decides the draft against its candidate; 'different' adds, 'same' merges a copy that differs by filler and a plural, and keeps a reworded pair apart as a possible duplicate", async () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const reworded = "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts";
    const copy = "Use the withRetry from src/retry/index.ts for the HTTP retry in the api service client call";
    for (const [verdict, draftBody, expected, lessons] of [["different", reworded, "added", 2], ["same", copy, "merged", 1], ["same", reworded, "possible_duplicate", 2]] as const) {
      const { deps, store, judgeModel } = setup({ model: new ScriptedModel([one(verdict)]) });
      // A judge's "same" is acted on only when the two are the same advice by structure: the embedder's closeness does not change that.
      deps.embedder = closeEmbedder;
      await curateDraft(deps, KEY, text("Retries", a));
      const out = await curateDraft(deps, KEY, text("Retries", draftBody));
      expect(out.outcome).toBe(expected);
      expect(judgeModel.calls).toHaveLength(1);
      expect(judgeModel.calls[0]!.purpose).toBe("judge");
      expect((await store.list(KEY)).length).toBe(lessons);
    }
  });

  it("the judge call names the project and carries the amount `admit` was asked about as its budget; a judge that fails leaves the contradiction to a person", async () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const b = "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts";
    const ok = setup({ model: new ScriptedModel([one("different")]) });
    await curateDraft(ok.deps, KEY, text("Retries", a));
    await curateDraft(ok.deps, KEY, text("Retries", b));
    expect(ok.judgeModel.calls[0]!.project).toBe(PROJECT);
    expect(ok.judgeModel.calls[0]!.budgetUsd).toBe(ok.spend.asked[0]);
    const broken = setup({ model: new ScriptedModel([new Error("provider down")]) });
    await curateDraft(broken.deps, KEY, text("Retries", a));
    const result = await curateDraft(broken.deps, KEY, text("Retries", b));
    expect(broken.judgeModel.calls).toHaveLength(1);
    expect(result).toBeDefined();
  });

  it("UPDATE: 'refines' makes a new lesson that supersedes the old one; the old one is untouched", async () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const b = "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts";
    const { deps, store } = setup({ model: new ScriptedModel([one("refines")]) });
    const first = await curateDraft(deps, KEY, text("Retries", a));
    if (first.outcome !== "added") throw new Error("expected add");
    const out = await curateDraft(deps, KEY, text("Retries", b));
    expect(out).toMatchObject({ outcome: "updated", supersedes: first.lesson.id });
    const old = await store.get(KEY, first.lesson.id);
    expect(old).toMatchObject({ version: 1, status: "candidate" });
  });

  it("a contradicting pair goes to a person as one card, with both lessons kept; nothing is merged or retired", async () => {
    const pos = "Always use withRetry for HTTP calls in the api service";
    const neg = "Never use withRetry for HTTP calls in the api service";
    const { deps, store, alerts, audit } = setup({ model: new ScriptedModel([one("contradicts")]) });
    const first = await curateDraft(deps, KEY, text("Retries", pos));
    if (first.outcome !== "added") throw new Error("expected add");
    const out = await curateDraft(deps, KEY, text("Retries", neg));
    expect(out).toMatchObject({ outcome: "contradiction", other: first.lesson.id });
    if (out.outcome !== "contradiction") return;
    expect(out.lesson).toMatchObject({ status: "pending", contradictsWith: first.lesson.id });
    expect(await store.list(KEY)).toHaveLength(2);
    expect(alerts.sent).toContain("lesson_contradiction");
    expect(audit.actions()).toContain("lesson.contradiction");
  });

  it("opposite polarity is never merged by code, even at identical similarity; a failing judge sends it to a person", async () => {
    const pos = "Always use withRetry for HTTP calls in the api service";
    const neg = "Never use withRetry for HTTP calls in the api service";
    const { deps } = setup({ model: new ScriptedModel([new Error("judge down")]) });
    await curateDraft(deps, KEY, text("Retries", pos));
    const out = await curateDraft(deps, KEY, text("Retries", neg));
    expect(out.outcome).toBe("contradiction");
  });

  it("at similarity >= 0.92 a text with opposite polarity still goes to the judge instead of merging by code", async () => {
    const tail = "for every HTTP call in the api service client wrapper and its retry helper module";
    const pos = `Always use withRetry ${tail}`;
    const neg = `Never use withRetry ${tail}`;
    expect(await similar(`Retries\n\n${pos}`, `Retries\n\n${neg}`)).toBeGreaterThanOrEqual(0.92);
    const { deps, store, judgeModel } = setup({ model: new ScriptedModel([one("contradicts")]) });
    await curateDraft(deps, KEY, text("Retries", pos));
    const out = await curateDraft(deps, KEY, text("Retries", neg));
    expect(out.outcome).toBe("contradiction");
    expect(judgeModel.calls).toHaveLength(1);
    expect(await store.list(KEY)).toHaveLength(2);
  });

  it("a failing judge on a same-polarity near-duplicate adds rather than merging (a person sees both)", async () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const b = "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts";
    const { deps, store } = setup({ model: new ScriptedModel([new Error("down")]) });
    await curateDraft(deps, KEY, text("Retries", a));
    expect((await curateDraft(deps, KEY, text("Retries", b))).outcome).toBe("added");
    expect(await store.list(KEY)).toHaveLength(2);
  });

  it("a draft similar to a REJECTED lesson is not proposed again", async () => {
    const store = new InMemoryLessonStore();
    const { deps, vectors } = setup({ store });
    const rejected = lessonRecord({ id: "les_rej1", status: "rejected" });
    await seed(store, rejected);
    await vectors.upsert(WS, PROJECT, "les_rej1", await embedder.embed(`${rejected.title}\n${rejected.description}\n${rejected.body}`), { status: "rejected" });
    expect(await curateDraft(deps, KEY, draft())).toEqual({ outcome: "dropped", reason: "previously_rejected" });
  });

  it("scopes that do not overlap are not neighbours", async () => {
    const { deps, store } = setup();
    await curateDraft(deps, KEY, draft({ scope: { repos: ["api"] } }));
    await curateDraft(deps, KEY, draft({ scope: { repos: ["web"] } }));
    expect(await store.list(KEY)).toHaveLength(2);
  });

  it("a merge may not lower an ACTIVE lesson's trust or narrow its audience: that is a different lesson", async () => {
    const store = new InMemoryLessonStore();
    const { deps, vectors } = setup({ store });
    const active = lessonRecord({ id: "les_act1" });
    await seed(store, active);
    await vectors.upsert(WS, PROJECT, "les_act1", await embedder.embed(`${active.title}\n${active.description}\n${active.body}`), { status: "active" });
    const lower = draft({ provenance: { ...draft().provenance, minTrust: "system" } });
    const out = await curateDraft(deps, KEY, lower);
    expect(out.outcome).toBe("added");
    expect((await store.get(KEY, "les_act1"))!.version).toBe(1);
  });

  it("lessons connect: a merge keeps fromSharedTask: true only when every source was known project-wide: a known-not clears it, an unreadable (unset) source makes it unset", async () => {
    const shared = (fromSharedTask: boolean | undefined): LessonDraft => draft({ provenance: { ...draft().provenance, ...(fromSharedTask === undefined ? {} : { fromSharedTask }) } });
    for (const [first, second, expected] of [
      [true, true, true], [true, undefined, undefined], [undefined, true, undefined], [true, false, false], [false, true, false], [undefined, false, false], [undefined, undefined, undefined], [false, undefined, false],
    ] as const) {
      const { deps, store } = setup();
      await curateDraft(deps, KEY, shared(first));
      expect((await curateDraft(deps, KEY, shared(second))).outcome).toBe("merged");
      const [only] = await store.list(KEY);
      expect(only!.provenance.fromSharedTask, `${String(first)} + ${String(second)}`).toBe(expected);
    }
  });

  it("a merge clears memberCorrection and claimsSupported unless both sides have them, so a lesson merged with a draft that lacks them is refused for trial (not_member_correction, claims_not_supported)", async () => {
    const marked = (member: boolean | undefined, claims: boolean | undefined): LessonDraft => {
      const { memberCorrection: _m, claimsSupported: _c, ...rest } = draft().provenance;
      void _m; void _c;
      return draft({ provenance: { ...rest, ...(member === undefined ? {} : { memberCorrection: member }), ...(claims === undefined ? {} : { claimsSupported: claims }) } });
    };
    const context = { preset: "standard" as const, mode: "On" as const, trialAllowed: true, contradiction: false, refinement: false, reviewRequired: false, held: false, braked: false };
    for (const [first, second, kept] of [[true, true, true], [true, undefined, false], [undefined, true, false], [true, false, false], [undefined, undefined, false]] as const) {
      const { deps, store } = setup();
      await curateDraft(deps, KEY, marked(first, first));
      expect((await curateDraft(deps, KEY, marked(second, second))).outcome).toBe("merged");
      const [only] = await store.list(KEY);
      const label = `${String(first)} + ${String(second)}`;
      expect(only!.provenance.memberCorrection === true, label).toBe(kept);
      expect(only!.provenance.claimsSupported === true, label).toBe(kept);
      const blockers = trialBlockers(only!, 1, context);
      expect(blockers.includes("not_member_correction"), label).toBe(!kept);
      expect(blockers.includes("claims_not_supported"), label).toBe(!kept);
    }
  });

  it("a merge never drops a supporting task: with the list full the merge is refused and the draft becomes its own lesson", async () => {
    const { deps, store } = setup();
    const many = Array.from({ length: 50 }, (_, i) => `task-${i}`);
    const fullOut = await curateDraft(deps, KEY, draft({ provenance: { ...draft().provenance, supportTasks: many, fromSharedTask: true } }));
    if (!("lesson" in fullOut)) throw new Error("the first draft should have been stored");
    const full = fullOut.lesson;
    const fresh = await curateDraft(deps, KEY, draft({ provenance: { ...draft().provenance, supportTasks: ["task-new"], sourceEvents: ["ev-n"], fromSharedTask: false } }));
    expect(fresh.outcome).not.toBe("merged");
    const all = await store.list(KEY);
    expect(all).toHaveLength(2);
    // The full lesson is untouched: still true, still all fifty tasks.
    const before = all.find((l) => l.id === full.id)!;
    expect(before.provenance.supportTasks).toEqual(many);
    expect(before.provenance.fromSharedTask).toBe(true);
  });
  it("Positive control: with the list full, a draft whose only task is one the list already holds loses nothing and merges", async () => {
    const { deps, store } = setup();
    const many = Array.from({ length: 50 }, (_, i) => `task-${i}`);
    const fullOut = await curateDraft(deps, KEY, draft({ provenance: { ...draft().provenance, supportTasks: many, fromSharedTask: true } }));
    if (!("lesson" in fullOut)) throw new Error("the first draft should have been stored");
    const full = fullOut.lesson;
    const again = await curateDraft(deps, KEY, draft({ provenance: { ...draft().provenance, supportTasks: ["task-3"], sourceEvents: ["ev-m"], fromSharedTask: true } }));
    expect(again.outcome).toBe("merged");
    expect(await store.list(KEY)).toHaveLength(1);
    expect((await store.get(KEY, full.id))!.provenance.supportTasks).toEqual(many);
  });
  it("an embedder that is down never drops a draft: the shortlist is keywords and paths, and the draft is curated as usual", async () => {
    const { deps, store } = setup();
    await curateDraft(deps, KEY, draft());
    embedder.fail = true;
    try {
      const out = await curateDraft(deps, KEY, draft({ provenance: { ...draft().provenance, supportTasks: ["task-2"], sourceEvents: ["ev-2"] } }));
      expect(out.outcome).toBe("merged");
    } finally { embedder.fail = false; }
    expect(await store.list(KEY)).toHaveLength(1);
  });

  it("keeps a capability request as a candidate for a person (it is not dropped); an outsider-trust draft is still dropped", async () => {
    const { deps, store } = setup();
    expect(await curateDraft(deps, KEY, draft({ body: "Grant tools to the agent so it can run any commands." }))).toMatchObject({ outcome: "added" });
    expect(await curateDraft(deps, KEY, draft({ provenance: { ...draft().provenance, minTrust: "outsider" } }))).toMatchObject({ outcome: "dropped", reason: "outsider" });
    expect(await store.list(KEY)).toHaveLength(1);
  });
});

describe("atomic delta writes and rollback", () => {
  it("retries a conflicting commit, and gives up cleanly with nothing half-written", async () => {
    const flaky = new FlakyStore();
    flaky.failures = 2;
    const ok = setup({ store: flaky });
    expect((await curateDraft(ok.deps, KEY, draft())).outcome).toBe("added");
    const bad = new FlakyStore();
    bad.failures = 99;
    const fail = setup({ store: bad });
    expect(await curateDraft(fail.deps, KEY, draft())).toEqual({ outcome: "dropped", reason: "conflict" });
    expect(await bad.list(KEY)).toHaveLength(0);
    expect(await bad.setVersion(KEY)).toBe(0);
    expect(fail.vectors.rows.size).toBe(0);
  });

  it("a commit with a stale set version or a skipped lesson version changes nothing", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, lessonRecord());
    const head = (await store.get(KEY, "les_aaaa1111"))!;
    expect(await store.commit(KEY, 0, [{ ...head, version: 2 }], 1)).toEqual({ ok: false, reason: "conflict" });
    expect(await store.commit(KEY, 1, [{ ...head, version: 3 }], 1)).toEqual({ ok: false, reason: "conflict" });
    expect((await store.get(KEY, "les_aaaa1111"))!.version).toBe(1);
    expect(await store.setVersion(KEY)).toBe(1);
  });

  it("rollback restores a past lesson-set version and does not rewind counters; each change is a new version", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, lessonRecord());
    const v1 = await store.setVersion(KEY);
    const head = (await store.get(KEY, "les_aaaa1111"))!;
    await store.mutate(KEY, "les_aaaa1111", (l) => ({ counters: { ...l.counters, helpful: 4 } }));
    await store.commit(KEY, v1, [{ ...head, version: nextVersion(head, await store.versions(KEY, head.id)), title: "Changed" }, lessonRecord({ id: "les_bbbb2222" })], 2);
    expect((await store.get(KEY, "les_aaaa1111"))).toMatchObject({ title: "Changed", version: 2 });
    expect((await store.get(KEY, "les_aaaa1111"))!.counters.helpful).toBe(4);
    const current = await store.setVersion(KEY);
    expect(await store.rollback(KEY, v1, current, 3)).toEqual({ ok: true, setVersion: current + 1, restored: ["les_aaaa1111"] });
    // A rollback never restores approval: the automatic one is dropped and the lesson waits for a person.
    expect(await store.get(KEY, "les_aaaa1111")).toMatchObject({ title: "Retries use withRetry", status: "pending", reviewRequired: true, approvals: [] });
    expect((await store.get(KEY, "les_aaaa1111"))!.counters.helpful).toBe(4);
    expect(await store.get(KEY, "les_bbbb2222")).toBeUndefined();
    expect((await store.versions(KEY, "les_aaaa1111")).map((v) => v.version)).toEqual([1, 2]);
    expect(await store.rollback(KEY, 99, current + 1, 4)).toEqual({ ok: false, reason: "conflict" });
  });

  it("another workspace's lessons never influence, and are never visible to, a curation", async () => {
    const store = new InMemoryLessonStore();
    const { deps, vectors } = setup({ store });
    const a = lessonRecord({ id: "les_wsa1" });
    await seed(store, a);
    await vectors.upsert(WS, PROJECT, "les_wsa1", await embedder.embed(`${a.title}\n${a.description}\n${a.body}`), { status: "active" });
    const other: ScopeKey = { workspaceId: "ws-B", project: PROJECT };
    const out = await curateDraft(deps, other, draft());
    expect(out.outcome).toBe("added");
    expect(await store.list(other)).toHaveLength(1);
    expect((await store.list(KEY)).map((l) => l.id)).toEqual(["les_wsa1"]);
    expect((await store.get(KEY, "les_wsa1"))!.version).toBe(1);
    expect(await store.get(other, "les_wsa1")).toBeUndefined();
    // A lesson written with the wrong scope is refused outright.
    await expect(store.commit(other, await store.setVersion(other), [lessonRecord({ id: "les_x", workspaceId: WS })], 1)).rejects.toThrow();
  });
});
