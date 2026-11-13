// Rollback honours the erasure fence and re-checks approvals, the single tier-0 approval switch on every path, late source
// events, an author cannot approve their own sent-back lesson, ids compared without case.
import { describe, expect, it } from "vitest";
import { approveLesson, listWaiting, rollbackLessonSet, type ApproveDeps } from "../../../packages/core/src/lessons/approve.js";
import { buildWeeklyDigest } from "../../../packages/core/src/lessons/digest.js";
import { lessonDeletionPort } from "../../../packages/core/src/lessons/deletion.js";
import { DEFAULT_APPROVAL_POLICY, TIER0_APPROVAL_DEFAULT, resolveLearning } from "../../../packages/core/src/lessons/policy.js";
import { processDraft, resumeAndResettle, type ProcessDeps } from "../../../packages/core/src/lessons/process.js";
import { isMeasured } from "../../../packages/core/src/lessons/reflect.js";
import { noteCandidateSources } from "../../../packages/core/src/lessons/sources.js";
import { InMemoryLessonStore, type LessonStore } from "../../../packages/core/src/lessons/store.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, directory, draft, embedder, facts, lessonRecord, seed, settings, verifier, allowAllAccess } from "./lesson-helpers.js";

describe("rollback honours the erasure fence", () => {
  async function erasureInFlight() {
    const store = new InMemoryLessonStore();
    const vectors = new MemoryVectors();
    const clock = new Clock();
    const port = lessonDeletionPort({ store, vectors, audit: new Audit(), now: clock.now });
    const prov = { ...draft().provenance, authors: ["ann", "bob"], sources: ["member:ann", "member:bob"], inputSources: ["member:ann", "member:bob"] };
    const v1 = lessonRecord({ id: "les_rbe00001", tier: 1, tierReasons: ["not_a_fact"], provenance: prov, approvals: [{ approvalId: "m", by: "mallory", at: 1, mode: "one" }] });
    await seed(store, v1);
    await seed(store, { ...v1, version: 2, citations: [{ ...v1.citations[0]!, startLine: 40, endLine: 50 } as never] });
    const original = store.scrub.bind(store);
    let calls = 0;
    store.scrub = async (...args: Parameters<LessonStore["scrub"]>) => { calls += 1; if (calls === 1) throw new Error("scrub down"); return original(...args); };
    await expect(port.erasePerson(WS, PROJECT, { developerId: "mallory" }, new Set())).rejects.toThrow();
    return { store, port, clock };
  }

  it("the reviewer's probe: during an open erasure a rollback never brings back a head approved by the erased person", async () => {
    const { store, clock } = await erasureInFlight();
    expect((await store.listIntents(KEY, { finished: false })).length).toBe(1);
    const deps: ApproveDeps = { access: allowAllAccess, store, directory: directory(), settings: settings(), audit: new Audit(), now: clock.now };
    const result = await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, actorId: "ann" });
    expect(result).toMatchObject({ ok: true, restored: [] });
    expect(JSON.stringify(await store.get(KEY, "les_rbe00001"))).not.toContain("mallory");
  });

  it("a rollback never restores content that names an erased person or a deleted row, even with no open intent", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, lessonRecord({ id: "les_a0000001", provenance: { ...draft().provenance, sourceEvents: ["A"] } }));
    const s1 = await store.setVersion(KEY);
    const head = (await store.get(KEY, "les_a0000001"))!;
    await store.commit(KEY, s1, [{ ...head, version: 2, provenance: { ...head.provenance, sourceEvents: ["B"] } }], 2);
    await store.fence(KEY, { ids: ["A"] });
    await store.rollback(KEY, s1, await store.setVersion(KEY), 3);
    expect((await store.get(KEY, "les_a0000001"))!.provenance.sourceEvents).toEqual(["B"]);
  });

  it("a fenced person: content approved by them is never restored (no open intent needed)", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, lessonRecord({ id: "les_a0000001", approvals: [{ approvalId: "m", by: "mallory", at: 1, mode: "one" }] }));
    const s1 = await store.setVersion(KEY);
    const head = (await store.get(KEY, "les_a0000001"))!;
    await store.commit(KEY, s1, [{ ...head, version: 2, approvals: [] }], 2);
    await store.fence(KEY, { people: ["mallory"] });
    const result = await store.rollback(KEY, s1, await store.setVersion(KEY), 3);
    expect(result).toMatchObject({ ok: true, restored: [] });
    expect(JSON.stringify(await store.get(KEY, "les_a0000001"))).not.toContain("mallory");
  });

  it("a lesson with a deletion still open is left alone by a rollback", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, lessonRecord({ id: "les_a0000001" }));
    const s1 = await store.setVersion(KEY);
    const head = (await store.get(KEY, "les_a0000001"))!;
    await store.commit(KEY, s1, [{ ...head, version: 2, title: "Newer" }], 2);
    await store.putIntent(KEY, { id: "i1", lessonId: "les_a0000001", kind: "forget", cause: "sources_deleted", deleted: ["Z"], outcome: "scrub", inSet: true, done: [], finished: false, at: 1 });
    expect(await store.rollback(KEY, s1, await store.setVersion(KEY), 3)).toMatchObject({ ok: true, restored: [] });
    expect((await store.get(KEY, "les_a0000001"))!.title).toBe("Newer");
  });

  it("ids in the fence are compared without case", async () => {
    const store = new InMemoryLessonStore();
    await store.fence(KEY, { people: ["Mallory"] });
    expect(await store.isErased(KEY, "mallory")).toBe(true);
    expect(await store.commit(KEY, 0, [lessonRecord({ id: "les_x0000001", provenance: { ...draft().provenance, authors: ["MALLORY"] } })], 1)).toEqual({ ok: false, reason: "erased" });
  });
});

describe("rollback re-checks kept approvals against current membership and policy", () => {
  async function rolledBack(opts: { eligibleIds: string[]; policy?: Parameters<typeof settings>[0]; approvals?: Array<{ by: string }> }) {
    const store = new InMemoryLessonStore();
    const approvals = (opts.approvals ?? [{ by: "bob" }]).map((a, i) => ({ approvalId: `a${i}`, by: a.by, at: 1, mode: "one" as const }));
    const v1 = lessonRecord({ id: "les_rb000001", tier: 1, tierReasons: ["not_a_fact"], type: "convention", approvals, provenance: { ...draft().provenance, authors: ["carl"] } });
    await seed(store, v1);
    await seed(store, { ...v1, version: 2, citations: [{ ...v1.citations[0]!, startLine: 40, endLine: 50 } as never] });
    const deps: ApproveDeps = { access: allowAllAccess, store, directory: directory({ eligibleIds: opts.eligibleIds, ownerIds: ["owner"] }), settings: settings(opts.policy), audit: new Audit(), now: new Clock().now };
    const result = await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, actorId: "owner" });
    return { result, lesson: (await store.get(KEY, "les_rb000001"))! };
  }
  it("the reviewer's probe: an approver who has left means pending, and the stale approval is removed", async () => {
    const { lesson } = await rolledBack({ eligibleIds: ["owner", "ann"] });
    expect(lesson).toMatchObject({ status: "pending", reviewRequired: true, approvals: [] });
  });
  it("the reviewer's probe: a policy that now needs two approvers means pending", async () => {
    const { lesson } = await rolledBack({ eligibleIds: ["owner", "ann", "bob"], policy: { approval: { tier1: "two" } } });
    expect(lesson.status).toBe("pending");
    expect(lesson.approvals.map((a) => a.by)).toEqual(["bob"]);
  });
  it("a required group that is not represented means pending", async () => {
    const { lesson } = await rolledBack({ eligibleIds: ["owner", "bob"], policy: { approval: { requiredGroup: "sec" } } });
    expect(lesson.status).toBe("pending");
  });
  it("an approval that still stands (eligible approver, policy met) is honoured, flagged for review", async () => {
    const { lesson } = await rolledBack({ eligibleIds: ["owner", "ann", "bob"] });
    expect(lesson).toMatchObject({ status: "active", reviewRequired: true });
    expect(lesson.approvals.map((a) => a.by)).toEqual(["bob"]);
  });
  it("two approvers under a two-person policy still stand when both are eligible", async () => {
    const { lesson } = await rolledBack({ eligibleIds: ["owner", "ann", "bob", "dee"], policy: { approval: { tier1: "two" } }, approvals: [{ by: "bob" }, { by: "dee" }] });
    expect(lesson.status).toBe("active");
  });
  it("at the store, a restored lesson is always pending: nothing is live before the re-check", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, lessonRecord({ id: "les_rb000001", approvals: [{ approvalId: "a", by: "bob", at: 1, mode: "one" }] }));
    const s = await store.setVersion(KEY);
    await seed(store, lessonRecord({ id: "les_other001" }));
    await store.rollback(KEY, s, await store.setVersion(KEY), 5);
    expect((await store.get(KEY, "les_rb000001"))!.status).toBe("pending");
  });
});

describe("one switch: the tier-0 approval default", () => {
  function pipeline(tier0Approval?: "auto" | "one") {
    const store = new InMemoryLessonStore();
    let n = 0;
    const clock = new Clock();
    const deps: ProcessDeps = { store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: clock.now, verifier: verifier("valid"), coldStartLessons: 0, facts: facts(), settings: settings(tier0Approval === undefined ? {} : { tier0Approval }), newId: () => `les_sw${++n}` };
    const approve: ApproveDeps = { access: allowAllAccess, store, directory: directory(), settings: deps.settings, audit: deps.audit, now: clock.now };
    return { deps, store, approve };
  }
  const strong = { measured: true, authors: ["mallory"], sources: ["member:mallory"], inputSources: ["member:mallory"], supportTasks: ["t1"] };

  it("is a single named setting, \"one\" by default; the setting wins over the default; a company floor can only make it stricter", async () => {
    expect(TIER0_APPROVAL_DEFAULT).toBe("one");
    expect(DEFAULT_APPROVAL_POLICY.tier0).toBe(TIER0_APPROVAL_DEFAULT);
    expect((await resolveLearning(settings(), "w", "p")).approval.tier0).toBe("one");
    expect((await resolveLearning(settings({ tier0Approval: "auto" }), "w", "p")).approval.tier0).toBe("auto");
    expect((await resolveLearning(settings({ tier0Approval: "auto", companyApproval: { tier0: "one" } }), "w", "p")).approval.tier0).toBe("one");
    expect((await resolveLearning(settings({ tier0Approval: "one", approval: { tier0: "auto" } }), "w", "p")).approval.tier0).toBe("auto");
  });

  it("a project with NO setting never auto-applies: a corroborated, measured, rendered fact waits for a person", async () => {
    const { deps, store } = pipeline();
    const out = await processDraft(deps, KEY, draft({ provenance: { ...draft().provenance, ...strong } }));
    expect(out.lesson).toMatchObject({ status: "pending", tier: 0, approvals: [] });
    for (let i = 0; i < 3; i += 1) await processDraft(deps, KEY, draft({ title: `Retry helper ${i}`, provenance: { ...draft().provenance, ...strong, supportTasks: [`t${i}`], authors: ["mallory", "ann"] } }));
    expect(await store.list(KEY, { statuses: ["active"] })).toEqual([]);
  });

  it("the weekly digest and the one-tap approval work with \"one\": the waiting lesson is listed, one maintainer approves it, and it then leads the digest as live", async () => {
    const { deps, store, approve } = pipeline();
    const out = await processDraft(deps, KEY, draft({ provenance: { ...draft().provenance, ...strong } }));
    const viewer = { principals: [], groups: [] };
    const before = await buildWeeklyDigest(store, KEY, deps.now(), viewer, allowAllAccess);
    expect(before.waiting.map((i) => i.id)).toEqual([out.lesson!.id]);
    expect(before.top.map((i) => i.id)).toEqual([out.lesson!.id]);
    expect(before.autoApplied).toEqual([]);
    expect((await listWaiting(store, KEY, viewer, allowAllAccess)).map((l) => l.id)).toEqual([out.lesson!.id]);
    expect(await approveLesson(approve, { ...KEY, lessonId: out.lesson!.id, approverId: "bob" })).toMatchObject({ ok: true, status: "active" });
    const after = await buildWeeklyDigest(store, KEY, deps.now(), viewer, allowAllAccess);
    expect(after.waiting).toEqual([]);
    expect(after.top.map((i) => i.id)).toEqual([out.lesson!.id]);
    expect(after.autoApplied).toEqual([]);
  });

  it("auto: a corroborated cited fact still goes live by itself, when the setting says so", async () => {
    const { deps } = pipeline("auto");
    expect((await processDraft(deps, KEY, draft({ provenance: { ...draft().provenance, ...strong } }))).lesson!.status).toBe("active");
  });

  it("one, ingest: the same lesson waits for a person, and one person's approval makes it live", async () => {
    const { deps, store, approve } = pipeline("one");
    const out = await processDraft(deps, KEY, draft({ provenance: { ...draft().provenance, ...strong } }));
    expect(out.lesson).toMatchObject({ status: "pending", tier: 0, approvals: [] });
    expect((await store.list(KEY, { statuses: ["active"] }))).toEqual([]);
    expect(await approveLesson(approve, { ...KEY, lessonId: out.lesson!.id, approverId: "ann" })).toMatchObject({ ok: true, status: "active" });
  });

  it("one, rollback: a lesson that was live by itself (automatic approval) comes back pending and stays pending without a person", async () => {
    const auto = pipeline("auto");
    const live = (await processDraft(auto.deps, KEY, draft({ provenance: { ...draft().provenance, ...strong } }))).lesson!;
    expect(live.status).toBe("active");
    const s = await auto.store.setVersion(KEY);
    await seed(auto.store, lessonRecord({ id: "les_later001" }));
    // The project now runs with "one".
    const deps: ApproveDeps = { ...auto.approve, settings: settings({ tier0Approval: "one" }) };
    await rollbackLessonSet(deps, { ...KEY, targetSetVersion: s, actorId: "ann" });
    expect(await auto.store.get(KEY, live.id)).toMatchObject({ status: "pending", approvals: [] });
  });

  it("one, rollback: a person's approval that still stands is the only way back to live", async () => {
    const { deps, store, approve } = pipeline("one");
    const out = await processDraft(deps, KEY, draft({ provenance: { ...draft().provenance, ...strong } }));
    await approveLesson(approve, { ...KEY, lessonId: out.lesson!.id, approverId: "ann" });
    const s = await store.setVersion(KEY);
    await seed(store, lessonRecord({ id: "les_later001" }));
    await rollbackLessonSet(approve, { ...KEY, targetSetVersion: s, actorId: "bob" });
    const back = (await store.get(KEY, out.lesson!.id))!;
    expect(back.status).toBe("active");
    expect(back.approvals.every((a) => a.mode !== "auto")).toBe(true);
  });

  it("one, resume: a lesson held while its source was paused is never live because the pause lifted", async () => {
    const { deps, store } = pipeline("one");
    await store.setFlags(KEY, { pausedSources: { "member:mallory": { at: 1, reason: "spike" } } });
    const held = await processDraft(deps, KEY, draft({ provenance: { ...draft().provenance, ...strong } }));
    expect(held.lesson!.status).toBe("candidate");
    await resumeAndResettle(deps, KEY, "member:mallory", "owner");
    expect((await store.get(KEY, held.lesson!.id))).toMatchObject({ status: "pending", approvals: [] });
    expect(await store.list(KEY, { statuses: ["active"] })).toEqual([]);
  });

  it("one: no path leaves an automatic approval on a live lesson", async () => {
    const { deps, store } = pipeline("one");
    for (let i = 0; i < 3; i += 1) await processDraft(deps, KEY, draft({ title: `Retry helper ${i}`, provenance: { ...draft().provenance, ...strong, supportTasks: [`t${i}`] } }));
    for (const lesson of await store.list(KEY)) expect(lesson.status === "active" && lesson.approvals.some((a) => a.mode === "auto")).toBe(false);
  });
});

describe("low items", () => {
  it("a late source event of an erased person is not recorded and cannot start a pause", async () => {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    const port = lessonDeletionPort({ store, vectors: new MemoryVectors(), audit: new Audit(), now: clock.now });
    await port.erasePerson(WS, PROJECT, { developerId: "mallory" }, new Set());
    for (let i = 0; i < 15; i += 1) await noteCandidateSources({ now: clock.now, audit: new Audit() }, store, KEY, ["member:Mallory", "slack:C1"]);
    expect(await store.sourceDays(KEY, "member:Mallory", 2, clock.now())).toEqual([0, 0]);
    expect(await store.sourceDays(KEY, "slack:C1", 2, clock.now())).toEqual([15, 0]);
    expect((await store.flags(KEY)).pausedSources?.["member:Mallory"]).toBeUndefined();
  });

  it("an author cannot approve their own lesson that was sent back to a person; someone else can", async () => {
    const store = new InMemoryLessonStore();
    const approve: ApproveDeps = { access: allowAllAccess, store, directory: directory(), settings: settings(), audit: new Audit(), now: new Clock().now };
    await seed(store, lessonRecord({ id: "les_sent0001", status: "pending", tier: 0, approvals: [], reviewRequired: true, provenance: { ...draft().provenance, authors: ["Ann"] } }));
    expect(await approveLesson(approve, { ...KEY, lessonId: "les_sent0001", approverId: "ann" })).toEqual({ ok: false, code: "author_cannot_approve_alone" });
    expect(await approveLesson(approve, { ...KEY, lessonId: "les_sent0001", approverId: "bob" })).toMatchObject({ ok: true, status: "active" });
  });

  it("a sent-back tier-0 lesson needs a person even when the policy would apply tier 0 by itself", async () => {
    const store = new InMemoryLessonStore();
    const approve: ApproveDeps = { access: allowAllAccess, store, directory: directory({ ownerIds: ["ann"], eligibleIds: ["ann"] }), settings: settings(), audit: new Audit(), now: new Clock().now };
    await seed(store, lessonRecord({ id: "les_sent0002", status: "pending", tier: 0, approvals: [], reviewRequired: true, provenance: { ...draft().provenance, authors: ["carl"] } }));
    expect(await approveLesson(approve, { ...KEY, lessonId: "les_sent0002", approverId: "ann" })).toMatchObject({ ok: true, status: "active" });
  });

  it("measured outcomes compare ids without case: 'Ann' reverting Ann's lesson is not independent", () => {
    expect(isMeasured({ authors: ["ann"], initiatorId: "carl", events: [{ kind: "revert", actor: "Ann" }] })).toBe(false);
    expect(isMeasured({ authors: ["ann"], initiatorId: "Carl", events: [{ kind: "send_back", actor: "carl" }] })).toBe(false);
    expect(isMeasured({ authors: ["ann"], initiatorId: "carl", events: [{ kind: "revert", actor: "Bob" }] })).toBe(true);
  });
});
