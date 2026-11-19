// Approvals, rejection, retire, rollback, promotion to a rule, and the weekly digest.
import { describe, expect, it } from "vitest";
import { approveLesson, listWaiting, rejectLesson, retireByPerson, rollbackLessonSet, type ApproveDeps } from "../../../packages/broker/src/lessons/approve.js";
import { buildWeeklyDigest } from "../../../packages/broker/src/lessons/digest.js";
import { promoteToRule, ruleParagraph, type PromoteDeps } from "../../../packages/broker/src/lessons/promote.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { withLessonAudiences } from "../../../packages/broker/src/lessons/task-audience.js";
import { Audit, Clock, KEY, Publisher, directory, lessonRecord, seed, settings, allSharedTasks, allowAllAccess, wideAudience } from "./lesson-helpers.js";

const base = (over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({ id: "les_pend0001", status: "pending", tier: 1, tierReasons: ["not_a_fact"], approvals: [], type: "convention", pendingExpiresAt: 9e15, provenance: { ...lessonRecord().provenance, authors: ["carl"] }, ...over });
const input = (approverId: string, id = "les_pend0001") => ({ ...KEY, lessonId: id, approverId });

function setup(over: { dir?: ReturnType<typeof directory>; settings?: ReturnType<typeof settings> } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  let n = 0;
  const dir = over.dir ?? directory();
  const deps: ApproveDeps = { access: allowAllAccess, store, directory: dir, settings: over.settings ?? settings(), audit, now: clock.now, newId: () => `ap-${++n}` };
  return { deps, store, audit, clock, dir };
}

describe("a person's decision follows the project's own mode, not the install's lessons switch", () => {
  it("with the switch off, a maintainer can still approve a waiting lesson (no model is involved); a project whose own mode is Collect still cannot", async () => {
    try {
      setLearnedLessonsGate(() => false);
      const on = setup({ settings: settings({ mode: "On" }) });
      await seed(on.store, base());
      expect(await approveLesson(on.deps, input("ann"))).toMatchObject({ ok: true, status: "active" });
      const collect = setup({ settings: settings({ mode: "Collect" }) });
      await seed(collect.store, base());
      expect(await approveLesson(collect.deps, input("ann"))).toEqual({ ok: false, code: "mode_off" });
    } finally { setLearnedLessonsGate(() => true); }
  });
});

describe("tier 1: one maintainer", () => {
  it("activates the lesson, sets its expiry, records the approval and audits it", async () => {
    const { deps, store, audit, clock } = setup();
    await seed(store, base());
    const result = await approveLesson(deps, input("ann"));
    expect(result).toMatchObject({ ok: true, status: "active" });
    const lesson = (await store.get(KEY, "les_pend0001"))!;
    expect(lesson).toMatchObject({ status: "active", version: 2 });
    expect(lesson.approvals).toEqual([{ approvalId: "ap-1", by: "ann", at: clock.now(), mode: "one" }]);
    // The end of the 14-day trial period plus 90 days without helping.
    expect(lesson.expiresAt).toBe(clock.now() + (14 + 90) * 86_400_000);
    expect(lesson.pendingExpiresAt).toBeUndefined();
    expect(audit.actions()).toEqual(expect.arrayContaining(["lesson.approved", "lesson.activated"]));
    expect(audit.events.every((e) => Object.values(e.facts).every((v) => typeof v !== "string" || v.length < 40))).toBe(true);
  });

  it("refuses someone who is not a maintainer or editor, and fails closed when eligibility is unknown", async () => {
    const { deps, store } = setup();
    await seed(store, base());
    expect(await approveLesson(deps, input("mallory"))).toEqual({ ok: false, code: "not_eligible" });
    const incomplete = setup({ dir: directory({ complete: false }) });
    await seed(incomplete.store, base());
    expect(await approveLesson(incomplete.deps, input("ann"))).toEqual({ ok: false, code: "eligibility_unavailable" });
    const broken = setup();
    broken.deps.directory = { eligibility: async () => { throw new Error("down"); }, identity: async () => ({ principals: [], groups: [] }) };
    await seed(broken.store, base());
    expect(await approveLesson(broken.deps, input("ann"))).toEqual({ ok: false, code: "eligibility_unavailable" });
    expect((await store.get(KEY, "les_pend0001"))!.status).toBe("pending");
  });

  it("the only author cannot approve alone when others can; as the only eligible person the sole-owner exception applies", async () => {
    const authored = base({ provenance: { ...lessonRecord().provenance, authors: ["ann"] } });
    const { deps, store } = setup();
    await seed(store, authored);
    expect(await approveLesson(deps, input("ann"))).toEqual({ ok: false, code: "author_cannot_approve_alone" });
    expect(await approveLesson(deps, input("bob"))).toMatchObject({ ok: true, status: "active" });

    const solo = setup({ dir: directory({ ownerIds: ["ann"], eligibleIds: ["ann"] }) });
    await seed(solo.store, authored);
    const result = await approveLesson(solo.deps, input("ann"));
    expect(result).toMatchObject({ ok: true, status: "active" });
    expect((await solo.store.get(KEY, "les_pend0001"))!.approvals[0]!.mode).toBe("sole_owner_exception");
    expect(solo.audit.actions()).toContain("lesson.sole_owner_exception");

    const cooling = setup({ dir: directory({ ownerIds: ["ann"], eligibleIds: ["ann"], lastEligibleLossAtMs: 1_800_000_000_000 - 3600_000 }) });
    await seed(cooling.store, authored);
    expect(await approveLesson(cooling.deps, input("ann"))).toEqual({ ok: false, code: "sole_owner_cool_off" });
  });

  it("is refused when the learning mode is Off or Collect", async () => {
    for (const mode of ["Off", "Collect"] as const) {
      const { deps, store } = setup({ settings: settings({ mode }) });
      await seed(store, base());
      expect(await approveLesson(deps, input("ann"))).toEqual({ ok: false, code: "mode_off" });
    }
  });

  it("only a pending lesson can be approved", async () => {
    const { deps, store } = setup();
    await seed(store, lessonRecord());
    expect(await approveLesson(deps, input("ann", "les_aaaa1111"))).toEqual({ ok: false, code: "not_pending" });
    expect(await approveLesson(deps, input("ann", "les_nope0000"))).toEqual({ ok: false, code: "not_found" });
  });
});

describe("tier 2: two people", () => {
  const tier2 = (over: Parameters<typeof lessonRecord>[0] = {}) => base({ tier: 2, tierReasons: ["reviewer_stage"], type: "review_check", stages: ["REVIEW"], ...over });

  it("the first approval keeps it pending; the same person cannot approve twice; a second maintainer or admin completes it", async () => {
    const { deps, store } = setup();
    await seed(store, tier2());
    expect(await approveLesson(deps, input("ann"))).toMatchObject({ ok: true, status: "pending", needs: "second_person" });
    expect(await approveLesson(deps, input("ann"))).toEqual({ ok: false, code: "already_approved" });
    expect(await approveLesson(deps, input("owner"))).toMatchObject({ ok: true, status: "active" });
    const lesson = (await store.get(KEY, "les_pend0001"))!;
    expect(lesson.approvals.map((a) => [a.by, a.mode])).toEqual([["ann", "one"], ["owner", "second_person"]]);
  });

  it("a first approver who is no longer eligible does not count: their approval is dropped (audited) and the next person gives the first, then a third finishes it", async () => {
    const { deps, store, dir, audit } = setup();
    await seed(store, tier2());
    await approveLesson(deps, input("ann"));
    dir.value.eligibleIds = ["owner", "bob", "carl"];
    const bob = await approveLesson(deps, input("bob"));
    expect(bob).toMatchObject({ ok: true, status: "pending", needs: "second_person" });
    const kept = (await store.get(KEY, "les_pend0001"))!;
    expect(kept.status).toBe("pending");
    expect(kept.approvals.map((a) => a.by)).toEqual(["bob"]);
    expect(audit.events.some((e) => e.action === "lesson.updated" && e.facts.reason === "approver_not_eligible" && e.facts.dropped === 1)).toBe(true);
    expect(await approveLesson(deps, input("carl"))).toMatchObject({ ok: true, status: "active" });
    expect((await store.get(KEY, "les_pend0001"))!.approvals.map((a) => a.by)).toEqual(["bob", "carl"]);
  });

  it("an erased first approver does not count either", async () => {
    const { deps, store } = setup();
    await seed(store, tier2({ approvals: [{ approvalId: "x", by: "erased", at: 1, mode: "one" }] }));
    expect(await approveLesson(deps, input("bob"))).toMatchObject({ ok: true, status: "pending", needs: "second_person" });
    expect((await store.get(KEY, "les_pend0001"))!.approvals.map((a) => a.by)).toEqual(["bob"]);
  });

  it("the sole eligible owner may finish alone through the audited exception", async () => {
    const solo = setup({ dir: directory({ ownerIds: ["ann"], eligibleIds: ["ann"] }) });
    await seed(solo.store, tier2());
    expect(await approveLesson(solo.deps, input("ann"))).toMatchObject({ ok: true, status: "active" });
    expect(solo.audit.actions()).toContain("lesson.sole_owner_exception");
  });

  it("two of the lesson's own authors cannot complete a tier-2 approval: a person who is not an author is needed", async () => {
    const authors = { ...lessonRecord().provenance, authors: ["ann", "bob"] };
    const { deps, store } = setup();
    await seed(store, tier2({ provenance: authors }));
    expect(await approveLesson(deps, input("ann"))).toMatchObject({ ok: true, status: "pending", needs: "second_person" });
    expect(await approveLesson(deps, input("bob"))).toEqual({ ok: false, code: "second_person_required" });
    let lesson = (await store.get(KEY, "les_pend0001"))!;
    expect(lesson.status).toBe("pending");
    expect(lesson.approvals.map((a) => a.by)).toEqual(["ann"]);
    // A person who did not write it finishes it.
    expect(await approveLesson(deps, input("owner"))).toMatchObject({ ok: true, status: "active" });
    lesson = (await store.get(KEY, "les_pend0001"))!;
    expect(lesson.approvals.map((a) => a.by)).toEqual(["ann", "owner"]);
  });

  it("one author and one other person is enough (an author may be one of the two)", async () => {
    const { deps, store } = setup();
    await seed(store, tier2({ provenance: { ...lessonRecord().provenance, authors: ["ann", "bob"] } }));
    await approveLesson(deps, input("owner"));
    expect(await approveLesson(deps, input("ann"))).toMatchObject({ ok: true, status: "active" });
  });

  it("the sole-owner exception is unchanged: the only eligible person, an author, finishes alone through it", async () => {
    const solo = setup({ dir: directory({ ownerIds: ["ann"], eligibleIds: ["ann"] }) });
    await seed(solo.store, tier2({ provenance: { ...lessonRecord().provenance, authors: ["ann"] } }));
    expect(await approveLesson(solo.deps, input("ann"))).toMatchObject({ ok: true, status: "active" });
    expect(solo.audit.actions()).toContain("lesson.sole_owner_exception");
  });

  it("a restored tier-2 lesson approved only by its own authors waits for a person", async () => {
    const { deps, store } = setup();
    const two = [{ approvalId: "a1", by: "ann", at: 1, mode: "second_person" as const }, { approvalId: "a2", by: "bob", at: 1, mode: "second_person" as const }];
    await seed(store, tier2({ status: "active", approvals: two, expiresAt: 9e15, provenance: { ...lessonRecord().provenance, authors: ["ann", "bob"] } }));
    const v1 = (await store.get(KEY, "les_pend0001"))!;
    await store.commit(KEY, await store.setVersion(KEY), [{ ...v1, version: 2, status: "stale" }], 2);
    await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, expectedSetVersion: 2, actorId: "owner" });
    expect((await store.get(KEY, "les_pend0001"))!.status).toBe("pending");
    // The control: with a non-author among the two approvers the same restore goes live.
    const ok = setup();
    await ok.store.commit(KEY, 0, [tier2({ status: "active", approvals: [two[0]!, { approvalId: "a3", by: "owner", at: 1, mode: "second_person" as const }], expiresAt: 9e15, provenance: { ...lessonRecord().provenance, authors: ["ann", "bob"] } })], 1);
    const w1 = (await ok.store.get(KEY, "les_pend0001"))!;
    await ok.store.commit(KEY, await ok.store.setVersion(KEY), [{ ...w1, version: 2, status: "stale" }], 2);
    await rollbackLessonSet(ok.deps, { ...KEY, targetSetVersion: 1, expectedSetVersion: 2, actorId: "owner" });
    expect((await ok.store.get(KEY, "les_pend0001"))!.status).toBe("active");
  });

  it("with one owner and others eligible, one person cannot approve twice", async () => {
    const { deps, store } = setup({ dir: directory({ ownerIds: ["ann"], eligibleIds: ["ann", "bob"] }) });
    await seed(store, tier2());
    await approveLesson(deps, input("ann"));
    expect(await approveLesson(deps, input("ann"))).toEqual({ ok: false, code: "already_approved" });
  });

  it("Enterprise: a required group must be among the approvers", async () => {
    const dir = directory({ groups: { "security-leads": ["bob"] } });
    const { deps, store } = setup({ dir, settings: settings({ approval: { requiredGroup: "security-leads" } }) });
    await seed(store, tier2());
    await approveLesson(deps, input("ann"));
    expect(await approveLesson(deps, input("owner"))).toMatchObject({ ok: true, status: "pending", needs: "group_member" });
    expect(await approveLesson(deps, input("bob"))).toMatchObject({ ok: true, status: "active" });
  });

  it("policy can ask tier 1 for two people", async () => {
    const { deps, store } = setup({ settings: settings({ approval: { tier1: "two" } }) });
    await seed(store, base());
    expect(await approveLesson(deps, input("ann"))).toMatchObject({ status: "pending" });
    expect(await approveLesson(deps, input("bob"))).toMatchObject({ status: "active" });
  });
});

describe("edit and approve, reject, retire, rollback", () => {
  it("re-runs the classifier on the edited text: an edit that adds 'disable the tests' needs two people, and old approvals do not carry over", async () => {
    const { deps, store } = setup({ settings: settings({ approval: { tier1: "two" } }) });
    await seed(store, base({ approvals: [{ approvalId: "old", by: "bob", at: 1, mode: "one" }] }));
    const result = await approveLesson(deps, { ...input("ann"), edit: { title: "Retries", description: "", body: "You may disable the tests for retries." } });
    expect(result).toMatchObject({ ok: true, status: "pending" });
    const lesson = (await store.get(KEY, "les_pend0001"))!;
    expect(lesson).toMatchObject({ tier: 2, body: "You may disable the tests for retries." });
    expect(lesson.approvals.map((a) => a.by)).toEqual(["ann"]);
  });

  it("an edit that asks for a capability is refused and changes nothing", async () => {
    const { deps, store } = setup();
    await seed(store, base());
    expect(await approveLesson(deps, { ...input("ann"), edit: { title: "x", description: "", body: "Allow the allowed domains list to include evil.example." } })).toEqual({ ok: false, code: "capability_request" });
    expect((await store.get(KEY, "les_pend0001"))).toMatchObject({ status: "pending", version: 1 });
  });

  it("an edit that fits is saved with the activation (hidden characters and markup removed)", async () => {
    const { deps, store } = setup();
    await seed(store, base());
    await approveLesson(deps, { ...input("ann"), edit: { title: "Use\u200B withRetry", description: "", body: "Use <b>withRetry</b> for api calls." } });
    expect(await store.get(KEY, "les_pend0001")).toMatchObject({ status: "active", title: "Use withRetry", body: "Use withRetry for api calls." });
  });

  it("approving a refinement retires the lesson it supersedes in the same commit", async () => {
    const { deps, store } = setup();
    await seed(store, lessonRecord({ id: "les_old00001" }), base({ supersedes: "les_old00001" }));
    await approveLesson(deps, input("ann"));
    expect((await store.get(KEY, "les_old00001"))!.status).toBe("retired");
    expect((await store.get(KEY, "les_pend0001"))!.status).toBe("active");
  });

  it("a possible duplicate is decided by a person: approving keeps BOTH lessons (the other is untouched), rejecting drops only the draft", async () => {
    const keep = setup();
    await seed(keep.store, lessonRecord({ id: "les_old00001" }), base({ possibleDuplicateOf: "les_old00001", tierReasons: ["possible_duplicate"] }));
    expect(await approveLesson(keep.deps, input("ann"))).toMatchObject({ ok: true, status: "active" });
    expect((await keep.store.get(KEY, "les_old00001"))).toMatchObject({ status: "active", version: 1 });
    expect((await keep.store.get(KEY, "les_pend0001"))!.status).toBe("active");
    const drop = setup();
    await seed(drop.store, lessonRecord({ id: "les_old00001" }), base({ possibleDuplicateOf: "les_old00001", tierReasons: ["possible_duplicate"] }));
    expect(await rejectLesson(drop.deps, { ...KEY, lessonId: "les_pend0001", approverId: "ann", reason: "a copy" })).toEqual({ ok: true });
    expect((await drop.store.get(KEY, "les_old00001"))).toMatchObject({ status: "active", version: 1 });
    expect((await drop.store.get(KEY, "les_pend0001"))!.status).toBe("rejected");
  });

  it("reject keeps a cleaned reason; retire works on an active lesson; both need an eligible person", async () => {
    const { deps, store, audit } = setup();
    await seed(store, base(), lessonRecord({ id: "les_live0001" }));
    expect(await rejectLesson(deps, { ...KEY, lessonId: "les_pend0001", approverId: "mallory", reason: "x" })).toEqual({ ok: false, code: "not_eligible" });
    expect(await rejectLesson(deps, { ...KEY, lessonId: "les_pend0001", approverId: "ann", reason: "too broad\u200B <b>" })).toEqual({ ok: true });
    expect(await store.get(KEY, "les_pend0001")).toMatchObject({ status: "rejected", rejectedReason: "too broad" });
    expect(await retireByPerson(deps, { ...KEY, lessonId: "les_live0001", actorId: "ann", reason: "manual" })).toEqual({ ok: true });
    expect((await store.get(KEY, "les_live0001"))!.status).toBe("retired");
    expect(audit.actions()).toEqual(expect.arrayContaining(["lesson.rejected", "lesson.retired"]));
  });

  it("rolls back to an earlier lesson set, audited, by an eligible person only", async () => {
    const { deps, store, audit } = setup();
    await seed(store, lessonRecord({ id: "les_live0001" }));
    await seed(store, lessonRecord({ id: "les_live0002" }));
    expect(await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, actorId: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
    expect(await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, actorId: "ann" })).toMatchObject({ ok: true });
    expect((await store.list(KEY)).map((l) => l.id)).toEqual(["les_live0001"]);
    expect(audit.actions()).toContain("lesson.rolled_back");
  });

  it("lists the lessons waiting for people, newest first", async () => {
    const { store } = setup();
    await seed(store, base({ id: "les_pend0001", createdAt: 5 }), base({ id: "les_pend0002", createdAt: 9 }), lessonRecord());
    expect((await listWaiting(store, KEY, { principals: [], groups: [] }, allowAllAccess)).map((l) => l.id)).toEqual(["les_pend0002", "les_pend0001"]);
  });
});

describe("promote to a How we work rule (exactly one paragraph)", () => {
  function promoteSetup(over: { dir?: ReturnType<typeof directory> } = {}) {
    const s = setup(over);
    const publisher = new Publisher();
    const deps: PromoteDeps = { ...s.deps, publisher, taskVisibility: allSharedTasks };
    return { ...s, deps, publisher };
  }

  it("publishes one single-line paragraph, once, and records the rule id", async () => {
    const { deps, store, publisher, audit } = promoteSetup();
    await seed(store, lessonRecord({ title: "Use withRetry.", body: "## Heading\n\n- use withRetry\n\nfor retries" }));
    const result = await promoteToRule(deps, { ...KEY, lessonId: "les_aaaa1111", approverId: "ann" });
    expect(result).toEqual({ ok: true, ruleId: "rule-1", already: false });
    expect(publisher.published).toHaveLength(1);
    const paragraph = publisher.published[0]!.paragraph;
    expect(paragraph).not.toMatch(/\n/u);
    expect(paragraph).toBe("Use withRetry. Heading - use withRetry for retries");
    expect((await store.get(KEY, "les_aaaa1111"))!.promotedRuleId).toBe("rule-1");
    expect(audit.actions()).toContain("lesson.promoted");
    expect(await promoteToRule(deps, { ...KEY, lessonId: "les_aaaa1111", approverId: "ann" })).toEqual({ ok: true, ruleId: "rule-1", already: true });
    expect(publisher.published).toHaveLength(1);
  });

  it("is refused for a restricted lesson, an inactive one, a non-maintainer, and a lesson from a system-trust source", async () => {
    const { deps, store, publisher } = promoteSetup();
    const restricted = { ...lessonRecord().provenance, audience: { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T/C", principals: ["U1"], capturedAt: "x", liveCheck: "none" as const } } };
    await seed(store, lessonRecord({ id: "les_rest0001", provenance: restricted }), lessonRecord({ id: "les_pend0001", status: "pending" }), lessonRecord({ id: "les_sys00001", provenance: { ...lessonRecord().provenance, minTrust: "system" } }), lessonRecord({ id: "les_ok000001" }));
    expect(await promoteToRule(deps, { ...KEY, lessonId: "les_rest0001", approverId: "ann" })).toEqual({ ok: false, code: "restricted" });
    expect(await promoteToRule(deps, { ...KEY, lessonId: "les_pend0001", approverId: "ann" })).toEqual({ ok: false, code: "not_active" });
    expect(await promoteToRule(deps, { ...KEY, lessonId: "les_sys00001", approverId: "ann" })).toEqual({ ok: false, code: "not_trusted" });
    expect(await promoteToRule(deps, { ...KEY, lessonId: "les_ok000001", approverId: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
    expect(publisher.published).toHaveLength(0);
  });

  it("a lesson learned from a task with a People denial is refused (a rule is a copy of the text); with no task reader it is refused too", async () => {
    const { deps, store, publisher } = promoteSetup();
    const from = (id: string, task: string) => lessonRecord({ id, provenance: { ...lessonRecord().provenance, supportTasks: [task] } });
    await seed(store, from("les_wide0001", "t-wide"), from("les_narrow01", "t-narrow"), from("les_list0001", "t-list"), from("les_inherit1", "t-wide"));
    const audiences = { read: async (_o: unknown, ids: readonly string[]) => new Map(ids.map((id) => [id, id === "t-narrow" ? wideAudience({ denied: new Set(["bob"]) }) : id === "t-list" ? wideAudience({ denied: new Set(["bob", "carl"]) }) : wideAudience()])) };
    const tasks = withLessonAudiences({ read: async () => new Map() }, audiences as never);
    const withTasks = { ...deps, taskVisibility: tasks } as PromoteDeps;
    expect(await promoteToRule(withTasks, { ...KEY, lessonId: "les_narrow01", approverId: "ann" })).toEqual({ ok: false, code: "task_not_shared" });
    expect(await promoteToRule(withTasks, { ...KEY, lessonId: "les_list0001", approverId: "ann" })).toEqual({ ok: false, code: "task_not_shared" });
    expect(await promoteToRule({ ...deps, taskVisibility: undefined }, { ...KEY, lessonId: "les_wide0001", approverId: "ann" })).toEqual({ ok: false, code: "task_not_shared" });
    expect(publisher.published).toHaveLength(0);
    // Positive control: the same flow publishes a lesson whose task is project-wide.
    expect(await promoteToRule(withTasks, { ...KEY, lessonId: "les_wide0001", approverId: "ann" })).toMatchObject({ ok: true, already: false });
    expect(publisher.published).toHaveLength(1);
  });

  it("a failed publish records nothing, so a retry can publish", async () => {
    const { deps, store } = promoteSetup();
    await seed(store, lessonRecord());
    deps.publisher = { publish: async () => { throw new Error("less-safe check failed"); } };
    expect(await promoteToRule(deps, { ...KEY, lessonId: "les_aaaa1111", approverId: "ann" })).toEqual({ ok: false, code: "publish_failed" });
    expect((await store.get(KEY, "les_aaaa1111"))!.promotedRuleId).toBeUndefined();
  });

  it("ruleParagraph is a single paragraph", () => {
    expect(ruleParagraph({ title: "A title!", body: "Line one\n\nLine two\n- item" })).toBe("A title. Line one Line two - item");
  });
});

describe("weekly digest", () => {
  it("lists what applied itself, what waits, what was retired, and counts restricted lessons without showing them", async () => {
    const { store, clock } = setup();
    const restricted = { ...lessonRecord().provenance, audience: { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T/C", principals: ["U1"], capturedAt: "x", liveCheck: "none" as const } } };
    const now = clock.now();
    await seed(store,
      lessonRecord({ id: "les_auto0001", updatedAt: now - 1000 }), lessonRecord({ id: "les_wait0001", status: "pending", approvals: [] }),
      lessonRecord({ id: "les_gone0001", status: "retired", updatedAt: now - 1000 }), lessonRecord({ id: "les_old00001", status: "retired", updatedAt: now - 30 * 86_400_000 }),
      lessonRecord({ id: "les_rest0001", provenance: restricted, updatedAt: now - 1000 }), lessonRecord({ id: "les_stal0001", status: "stale" }));
    const digest = await buildWeeklyDigest(store, KEY, now, { principals: [], groups: [] }, allowAllAccess);
    expect(digest.autoApplied.map((i) => i.id)).toEqual(["les_auto0001"]);
    expect(digest.waiting.map((i) => i.id)).toEqual(["les_wait0001"]);
    expect(digest.retired.map((i) => i.id)).toEqual(["les_gone0001"]);
    expect(digest.staleOrRetireProposed.map((i) => i.id)).toEqual(["les_stal0001"]);
    expect(digest.restrictedHidden).toBe(1);
    expect(JSON.stringify(digest)).not.toContain("les_rest0001");
  });
});
