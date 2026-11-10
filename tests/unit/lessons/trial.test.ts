// A low-risk lesson from a project member's own correction goes live on trial with no approval; a thumbs-down or a contradicting
// correction retires it; it becomes stable after 14 days and 3 loads; Regulated turns all of it off; a capability ask goes to people with a fixed reason instead of being dropped.
import { describe, expect, it } from "vitest";
import { approveLesson, type ApproveDeps } from "../../../packages/broker/src/lessons/approve.js";
import { applyLoadReport, recordFeedback, type CounterDeps } from "../../../packages/broker/src/lessons/counters.js";
import { curateDraft } from "../../../packages/broker/src/lessons/curate.js";
import { approvedForUse } from "../../../packages/broker/src/lessons/load.js";
import { DEFAULT_APPROVAL_POLICY, resolveLearning } from "../../../packages/broker/src/lessons/policy.js";
import { setLearningPreset, type PresetChange, type PresetDeps } from "../../../packages/broker/src/lessons/preset-setting.js";
import { processDraft, settleLesson, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { memberCorrectionOf, reflectSubject, type LessonDraft, type ReflectDeps } from "../../../packages/broker/src/lessons/reflect.js";
import { InMemoryLessonStore, type LoadManifest } from "../../../packages/broker/src/lessons/store.js";
import { TRIAL_APPROVER, TRIAL_STABLE_AFTER_DAYS, isPublishable, isTrialLesson, namesAPerson, promoteStableTrials, touchesAuthorityOrSpend } from "../../../packages/broker/src/lessons/trial.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import {
  Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, allowAllAccess, candidateJson, directory, draft, embedder, facts, lessonRecord, memberSpan, reply, seed, settings, subject, verifier,
} from "./lesson-helpers.js";

const DAY = 86_400_000;
const STANDARD = settings({ preset: "standard" });

function setup(over: { settings?: ReturnType<typeof settings>; verifier?: ReturnType<typeof verifier>; model?: ScriptedModel } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  let n = 0;
  const deps: ProcessDeps & CounterDeps & ApproveDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: over.model ?? new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now,
    verifier: over.verifier ?? verifier("valid"), facts: facts(), settings: over.settings ?? STANDARD, newId: () => `les_${String(++n).padStart(4, "0")}`,
    judge: { rate: async () => "unrelated" }, directory: directory({ eligibleIds: ["owner", "ann", "bob"] }), access: allowAllAccess,
  };
  return { deps, store, audit, clock };
}

/** A draft from a member's own send-back: what the reflector produces for a lesson that cites one member correction. */
function memberDraft(over: Partial<LessonDraft> = {}, prov: Partial<LessonDraft["provenance"]> = {}): LessonDraft {
  return draft({ ...over, provenance: { ...draft().provenance, sourceKinds: ["send_back"], memberCorrection: true, claimsSupported: true, fromSharedTask: true, ...prov } });
}
const loadedManifest = (taskId: string, id: string): LoadManifest => ({
  taskId, workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1,
  lessons: [{ id, version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10,
});

describe("goes live on trial with no approval", () => {
  it("a member's correction, verified citations, no escalation: active on trial, a system trial approval, audited, no person", async () => {
    const { deps, audit, clock } = setup();
    const out = await processDraft(deps, KEY, memberDraft());
    expect(out.lesson).toMatchObject({ status: "active", trial: { state: "trial", startedAt: clock.now() }, approvals: [{ by: TRIAL_APPROVER, mode: "trial" }] });
    expect(out.lesson!.tier).toBeLessThan(2);
    expect(isTrialLesson(out.lesson!)).toBe(true);
    expect(audit.actions()).toContain("lesson.trial_started");
    expect(audit.actions()).not.toContain("lesson.pending");
  });

  it("replaces the corroboration and cold-start rules for this path: one source, one task, no earlier approved lessons", async () => {
    const { deps } = setup();
    const out = await processDraft(deps, KEY, memberDraft({}, { supportTasks: ["task-1"], measured: false, memberSignal: false }));
    expect(out.lesson!.status).toBe("active");
  });

  it("the loader accepts it under Standard and stops it under Regulated (fail closed when the preset is unknown)", async () => {
    const { deps } = setup();
    const lesson = (await processDraft(deps, KEY, memberDraft())).lesson!;
    expect(approvedForUse(lesson, DEFAULT_APPROVAL_POLICY, undefined, true)).toBe(true);
    expect(approvedForUse(lesson, DEFAULT_APPROVAL_POLICY, undefined, false)).toBe(false);
    expect(approvedForUse(lesson, DEFAULT_APPROVAL_POLICY)).toBe(false);
    // A trial record without its system approval is not enough (an old row, a hand edit).
    expect(approvedForUse({ ...lesson, approvals: [] }, DEFAULT_APPROVAL_POLICY, undefined, true)).toBe(false);
  });

  it.each([
    ["not drafted from a member's correction", () => memberDraft({}, { memberCorrection: false })],
    ["a restricted source", () => memberDraft({}, { audience: { kind: "restricted", acl: { source: "slack", scope: "slack:C1", principals: ["U1"], capturedAt: "x", liveCheck: "none" } } })],
    ["no code citation", () => memberDraft({ citations: [] })],
    ["a scope that names no repository", () => memberDraft({ scope: { paths: ["src/**"] } })],
    ["spend", () => memberDraft({ title: "Billing client", description: "", body: "The budget for the billing client is read from src/retry/index.ts." })],
    ["authority", () => memberDraft({ title: "Owner role", description: "", body: "The owner of the retry module is the platform team." })],
    ["checks (tests)", () => memberDraft({ title: "Flaky tests", description: "", body: "Skip the flaky integration tests when you change withRetry." })],
    ["security", () => memberDraft({ title: "Token", description: "", body: "Rotate the auth token in the retry helper." })],
    ["a risky path", () => memberDraft({ scope: { repos: ["api"], paths: [".github/workflows/**"] } })],
  ])("not on trial: %s (a person decides under the old rules)", async (_name, build) => {
    const { deps } = setup();
    const out = await processDraft(deps, KEY, build());
    expect(out.lesson!.status).not.toBe("active");
    expect(out.lesson!.trial).toBeUndefined();
    expect(out.lesson!.approvals).toEqual([]);
  });

  it("not on trial when a citation does not verify (stale or unreadable)", async () => {
    for (const result of ["stale", "unknown"] as const) {
      const { deps } = setup({ verifier: verifier(result) });
      const out = await processDraft(deps, KEY, memberDraft());
      expect(out.lesson!.status, result).not.toBe("active");
    }
  });

  it("the Regulated preset (project's or company's) switches it off: every lesson needs a person", async () => {
    for (const regulated of [{ preset: "regulated" as const }, { companyPreset: "regulated" as const }, { preset: "standard" as const, companyPreset: "regulated" as const }]) {
      const { deps } = setup({ settings: settings(regulated) });
      const out = await processDraft(deps, KEY, memberDraft());
      expect(out.lesson!.status, JSON.stringify(regulated)).not.toBe("active");
      expect(out.lesson!.trial).toBeUndefined();
    }
  });

  it("mode Suggest never auto-applies, and a held source (spike) never trials", async () => {
    const suggest = setup({ settings: settings({ preset: "standard", mode: "Suggest" }) });
    expect((await processDraft(suggest.deps, KEY, memberDraft())).lesson!.status).not.toBe("active");
    const held = setup();
    await held.store.setFlags(KEY, { pausedSources: { "member:ann": { at: 1, reason: "spike" } } });
    const out = await processDraft(held.deps, KEY, memberDraft());
    expect(out.lesson!.status).toBe("candidate");
  });

  it("the project brake keeps it with a person", async () => {
    const { deps, store, clock } = setup();
    await store.setFlags(KEY, { volumeAlertedAt: clock.now() - 1000 });
    expect((await processDraft(deps, KEY, memberDraft())).lesson!.status).not.toBe("active");
  });

  it("a go-live that cannot be audited does not happen: the lesson waits for a person", async () => {
    const { deps } = setup();
    deps.audit = { emit: async (_event, options) => { if (options?.required === true) throw new Error("ledger down"); } };
    const out = await processDraft(deps, KEY, memberDraft());
    expect(out.lesson!.status).toBe("pending");
    expect(out.lesson!.approvals).toEqual([]);
  });

  it("a refinement of a live lesson is never put live without a person", async () => {
    const { deps, store } = setup();
    const first = (await processDraft(deps, KEY, memberDraft())).lesson!;
    const created = await curateDraft(deps, KEY, memberDraft({ title: "Other", body: "Other words entirely about the transport layer in api." }));
    if (created.outcome !== "added") throw new Error("expected add");
    await store.commit(KEY, await store.setVersion(KEY), [{ ...created.lesson, version: 2, supersedes: first.id }], 1);
    const settled = await settleLesson(deps, KEY, created.lesson.id);
    expect(settled!.status).not.toBe("active");
  });
});

describe("the capability guard no longer drops: it sends the lesson to people with a fixed reason", () => {
  it("is pending at once, tier 2, with reason capability_request, and needs two people", async () => {
    const { deps, audit } = setup();
    const out = await processDraft(deps, KEY, memberDraft({ body: "Grant tools to the agent so it can run any commands." }));
    expect(out.lesson).toMatchObject({ status: "pending", tier: 2, approvals: [] });
    expect(out.lesson!.tierReasons).toContain("capability_request");
    expect(out.lesson!.trial).toBeUndefined();
    expect(audit.actions()).not.toContain("lesson.refused");
    const first = await approveLesson(deps, { workspaceId: WS, project: PROJECT, lessonId: out.lesson!.id, approverId: "ann", expectedVersion: out.lesson!.version });
    expect(first).toMatchObject({ ok: true, status: "pending", needs: "second_person" });
  });
});

describe("trial eligibility is worked out from what the lesson CITES (a mixed-span task)", () => {
  const TASK = (cites: string[], spans = [
    memberSpan("Do not hand-roll retries in api: use withRetry from src/retry/index.ts.", { kind: "send_back", eventId: "ev-sb", authorId: "ann" }),
    memberSpan("The plan: add retries to the HTTP client.", { kind: "plan", trust: "system", eventId: "ev-plan" }),
    memberSpan("Review finding by the agent reviewer.", { kind: "review_finding", trust: "system", eventId: "ev-rf" }),
    memberSpan("Add retries to the client.", { kind: "intent", eventId: "ev-intent", authorId: "ann" }),
  ]) => ({ spans, candidate: candidateJson({ evidenceSpanIds: cites, type: "convention" }) });

  async function reflected(cites: (spans: string[]) => string[], spansOver?: Parameters<typeof TASK>[1]) {
    const { spans } = TASK([], spansOver);
    const input = (await import("../../../packages/broker/src/lessons/reflect-input.js")).buildReflectorInput(subject(spans));
    if (!input.eligible) throw new Error("ineligible");
    const ids = [...input.spans.values()].map((s) => `${s.id}:${s.kind}`);
    const find = (kind: string): string => ids.find((x) => x.endsWith(`:${kind}`))!.split(":")[0]!;
    const { d } = reflectDeps(new ScriptedModel([reply(candidateJson({ type: "convention", evidenceSpanIds: cites([find("send_back"), find("plan"), find("review_finding"), find("intent")]) }))]));
    return (await reflectSubject(d, subject(spans))).drafts[0]!;
  }
  function reflectDeps(model: ScriptedModel) {
    const clock = new Clock();
    const d: ReflectDeps = { model, spend: new Spend(), audit: new Audit(), settings: STANDARD, edition: "public", now: clock.now, newId: () => "run-1" };
    return { d };
  }

  it("a lesson that cites a member's send-back qualifies even though the task had a plan span (lowest trust of the whole task is below member)", async () => {
    const out = await reflected(([sendBack]) => [sendBack!]);
    expect(out.provenance.minTrust).toBe("system");
    expect(out.provenance.memberCorrection).toBe(true);
    // Through the whole pipeline: it goes live on trial.
    const { deps } = setup();
    const processed = await processDraft(deps, KEY, out);
    expect(processed.lesson).toMatchObject({ status: "active", trial: { state: "trial" } });
  });

  it("EVERY cited span must be a member's correction (allow-list): the send-back together with a plan span goes to a person; worker-written spans or the task wording alone never qualify", async () => {
    expect((await reflected(([sb]) => [sb!])).provenance.memberCorrection).toBe(true);
    expect((await reflected(([sb, plan]) => [sb!, plan!])).provenance.memberCorrection).toBe(false);
    expect((await reflected(([sb, , finding]) => [sb!, finding!])).provenance.memberCorrection).toBe(false);
    expect((await reflected(([sb, , , intent]) => [sb!, intent!])).provenance.memberCorrection).toBe(false);
    expect((await reflected(([, plan]) => [plan!])).provenance.memberCorrection).toBe(false);
    expect((await reflected(([, plan, finding]) => [plan!, finding!])).provenance.memberCorrection).toBe(false);
    expect((await reflected(([, , , intent]) => [intent!])).provenance.memberCorrection).toBe(false);
  });

  it("memberCorrectionOf: Slack, tracker and code-comment sources, restricted spans and outsiders never qualify", () => {
    const span = (over: Record<string, unknown>) => ({ id: "S1", kind: "send_back" as const, trust: "member" as const, authorId: "ann", ...over });
    expect(memberCorrectionOf([span({})], "member")).toBe(true);
    expect(memberCorrectionOf([span({ kind: "human_edit" })], "system")).toBe(true);
    expect(memberCorrectionOf([span({ kind: "remembered" })], "system")).toBe(true);
    expect(memberCorrectionOf([span({ kind: "close_reason" })], "system")).toBe(true);
    expect(memberCorrectionOf([span({ kind: "review_finding" })], "system")).toBe(true);
    expect(memberCorrectionOf([span({ kind: "review_finding", trust: "system", authorId: undefined })], "system")).toBe(false);
    for (const sourceKey of ["slack:C1", "linear:ENG", "jira:PRJ", "mcp:docs", "code:src/a.ts"]) expect(memberCorrectionOf([span({ sourceKey })], "system"), sourceKey).toBe(false);
    expect(memberCorrectionOf([span({}), span({ id: "S2", sourceKey: "slack:C1" })], "system")).toBe(false);
    expect(memberCorrectionOf([span({ audience: { kind: "restricted", acl: { source: "slack", scope: "s", capturedAt: "x", liveCheck: "none" } } })], "system")).toBe(false);
    expect(memberCorrectionOf([span({ authorId: undefined })], "system")).toBe(false);
    expect(memberCorrectionOf([span({})], "outsider")).toBe(false);
  });
});

describe("a project member's thumbs-down retires a trial lesson", () => {
  async function live() {
    const w = setup();
    const lesson = (await processDraft(w.deps, KEY, memberDraft())).lesson!;
    await w.store.putManifest(loadedManifest("task-1", lesson.id));
    return { ...w, lesson };
  }
  const input = (lessonId: string, over: Record<string, unknown> = {}) => ({ ...KEY, taskId: "task-1", lessonId, userId: "bob", viewer: { principals: [], groups: [] }, kind: "thumbs_down" as const, projectMember: true, ...over });

  it("retires it at once, audited with the person, and it stops loading", async () => {
    const { deps, store, audit, lesson } = await live();
    expect(await recordFeedback(deps, input(lesson.id))).toEqual({ ok: true });
    expect((await store.get(KEY, lesson.id))!.status).toBe("retired");
    expect(audit.events.find((e) => e.action === "lesson.trial_retired")).toMatchObject({ lessonId: lesson.id, actor: "bob", facts: { reason: "thumbs_down" } });
  });

  it("only a project member: anyone else is refused and the lesson stays; once per person; only for a lesson the task loaded", async () => {
    const { deps, store, lesson } = await live();
    expect(await recordFeedback(deps, input(lesson.id, { projectMember: false }))).toEqual({ ok: false, code: "not_permitted" });
    expect(await recordFeedback(deps, input(lesson.id, { projectMember: undefined }))).toEqual({ ok: false, code: "not_permitted" });
    expect((await store.get(KEY, lesson.id))!.status).toBe("active");
    expect(await recordFeedback(deps, input(lesson.id, { taskId: "task-other" }))).toEqual({ ok: false, code: "not_loaded" });
    expect(await recordFeedback(deps, input(lesson.id))).toEqual({ ok: true });
    expect(await recordFeedback(deps, input(lesson.id))).toEqual({ ok: false, code: "repeat" });
  });

  it("works for a person who already marked the lesson Helpful", async () => {
    const { deps, store, lesson } = await live();
    expect(await recordFeedback(deps, input(lesson.id, { kind: "helpful" }))).toEqual({ ok: true });
    expect(await recordFeedback(deps, input(lesson.id))).toEqual({ ok: true });
    expect((await store.get(KEY, lesson.id))!.status).toBe("retired");
  });

  it("on a STABLE lesson (still no person behind it) a thumbs-down retires it at once too; on a person-approved lesson it is a 'wrong here' mark that asks a person to decide", async () => {
    const { deps, store, lesson, clock, audit } = await live();
    await store.mutate(KEY, lesson.id, (l) => ({ counters: { ...l.counters, loaded: 3 } }));
    clock.advance((TRIAL_STABLE_AFTER_DAYS + 1) * DAY);
    expect(await promoteStableTrials(deps, KEY)).toEqual([lesson.id]);
    await store.putManifest(loadedManifest("task-1", lesson.id));
    expect(await recordFeedback(deps, input(lesson.id))).toEqual({ ok: true });
    expect((await store.get(KEY, lesson.id))!.status).toBe("retired");
    expect(audit.events.find((e) => e.action === "lesson.trial_retired")).toMatchObject({ lessonId: lesson.id, actor: "bob" });
    // A lesson a person approved: no trial record, so a mark asks a person.
    const approved = await store.get(KEY, lesson.id);
    const person = lessonRecord({ id: "les_person", status: "active", tier: 1, approvals: [{ approvalId: "a1", by: "ann", at: 1, mode: "one" }] });
    await store.commit(KEY, await store.setVersion(KEY), [person], 1);
    void approved;
    await store.putManifest({ ...loadedManifest("task-1", "les_person"), round: 2 });
    expect(await recordFeedback(deps, input("les_person"))).toEqual({ ok: true });
    const after = (await store.get(KEY, "les_person"))!;
    expect(after.status).toBe("active");
    expect(after.retireProposedAt).toBeDefined();
  });

  it("one person cannot retire a person-approved lesson alone by marking Wrong here and then thumbs-down (one mark of any kind per person per lesson)", async () => {
    const { deps, store, audit } = await live();
    const person = lessonRecord({ id: "les_person", status: "active", tier: 0, approvals: [{ approvalId: "a1", by: "ann", at: 1, mode: "one" }] });
    await store.commit(KEY, await store.setVersion(KEY), [person], 1);
    await store.putManifest({ ...loadedManifest("task-1", "les_person"), round: 2 });
    expect(await recordFeedback(deps, input("les_person", { kind: "wrong_here" }))).toEqual({ ok: true });
    expect(await recordFeedback(deps, input("les_person"))).toEqual({ ok: false, code: "repeat" });
    const after = (await store.get(KEY, "les_person"))!;
    expect(after.counters.harmful).toBe(1);
    expect(after.status).toBe("active");
    expect(audit.actions()).not.toContain("lesson.auto_retired");
    // The other order too.
    expect(await recordFeedback(deps, input("les_person", { userId: "cy" }))).toEqual({ ok: true });
    expect(await recordFeedback(deps, input("les_person", { userId: "cy", kind: "wrong_here" }))).toEqual({ ok: false, code: "repeat" });
  });
});

describe("a later contradicting correction retires a trial lesson", () => {
  it("the judge's contradiction verdict on a member's correction retires the lesson on trial (audited) and the new one waits for a person", async () => {
    const model = new ScriptedModel(['{"verdict":"contradicts"}']);
    const { deps, store, audit } = setup({ model });
    const first = (await processDraft(deps, KEY, memberDraft({ title: "Use withRetry", body: "Always use withRetry for HTTP retries in api." }))).lesson!;
    expect(first.status).toBe("active");
    const second = await processDraft(deps, KEY, memberDraft({ title: "Do not use withRetry", body: "Never use withRetry for HTTP retries in api." }, { supportTasks: ["task-2"] }));
    expect(second.outcome.outcome).toBe("contradiction");
    expect((await store.get(KEY, first.id))!.status).toBe("retired");
    expect(audit.events.find((e) => e.action === "lesson.trial_retired")).toMatchObject({ lessonId: first.id, facts: { reason: "contradicted" } });
    expect(second.lesson!.status).toBe("pending");
    expect(second.lesson!.approvals).toEqual([]);
  });

  it("a contradicting draft that is not a member's correction does not retire it", async () => {
    const model = new ScriptedModel(['{"verdict":"contradicts"}']);
    const { deps, store } = setup({ model });
    const first = (await processDraft(deps, KEY, memberDraft({ title: "Use withRetry", body: "Always use withRetry for HTTP retries in api." }))).lesson!;
    await processDraft(deps, KEY, memberDraft({ title: "Do not use withRetry", body: "Never use withRetry for HTTP retries in api." }, { memberCorrection: false, supportTasks: ["task-2"] }));
    expect((await store.get(KEY, first.id))!.status).toBe("active");
  });
});

describe("trial becomes stable after 14 days and at least 3 loads with no thumbs-down", () => {
  async function live() {
    const w = setup();
    const lesson = (await processDraft(w.deps, KEY, memberDraft())).lesson!;
    return { ...w, lesson };
  }
  it("not before 14 days, not before 3 loads, not with a wrong-here mark; then stable, audited, idempotent", async () => {
    const { deps, store, clock, lesson, audit } = await live();
    clock.advance(20 * DAY);
    expect(await promoteStableTrials(deps, KEY)).toEqual([]);
    await store.mutate(KEY, lesson.id, (l) => ({ counters: { ...l.counters, loaded: 3, harmful: 1 } }));
    expect(await promoteStableTrials(deps, KEY)).toEqual([]);
    await store.mutate(KEY, lesson.id, (l) => ({ counters: { ...l.counters, harmful: 0 } }));
    const early = setup();
    const young = (await processDraft(early.deps, KEY, memberDraft())).lesson!;
    await early.store.mutate(KEY, young.id, (l) => ({ counters: { ...l.counters, loaded: 5 } }));
    early.clock.advance(13 * DAY);
    expect(await promoteStableTrials(early.deps, KEY)).toEqual([]);
    expect(await promoteStableTrials(deps, KEY)).toEqual([lesson.id]);
    expect((await store.get(KEY, lesson.id))!.trial).toMatchObject({ state: "stable", stableAt: clock.now() });
    expect(audit.actions()).toContain("lesson.trial_stable");
    expect(await promoteStableTrials(deps, KEY)).toEqual([]);
    // A stable lesson still loads under Standard.
    expect(approvedForUse((await store.get(KEY, lesson.id))!, DEFAULT_APPROVAL_POLICY, undefined, true)).toBe(true);
  });

  it("the third load report moves it to stable when the time is up", async () => {
    const { deps, store, clock, lesson } = await live();
    clock.advance(15 * DAY);
    await store.mutate(KEY, lesson.id, (l) => ({ counters: { ...l.counters, loaded: 2 } }));
    await store.putManifest(loadedManifest("task-9", lesson.id));
    await applyLoadReport(deps, { ...KEY, taskId: "task-9", stage: "IMPLEMENT", round: 1, report: { v: 1, stage: "IMPLEMENT", lessons: [{ id: lesson.id, version: 1, citation: "valid" }] } as never });
    expect((await store.get(KEY, lesson.id))!.trial?.state).toBe("stable");
  });

  it("a pending-card read that fails at load time holds back that lesson's promotion only (fail closed); the rest of the load report is still applied", async () => {
    const { deps, store, clock, lesson } = await live();
    const other = lessonRecord({ id: "les_other9", workspaceId: WS, project: PROJECT, status: "active", approvals: [{ approvalId: "p1", by: "ann", at: 1, mode: "one" }] });
    await seed(store, other);
    clock.advance(15 * DAY);
    await store.mutate(KEY, lesson.id, (l) => ({ counters: { ...l.counters, loaded: 2 } }));
    await store.putManifest({ ...loadedManifest("task-9", lesson.id), lessons: [...loadedManifest("task-9", lesson.id).lessons, { id: other.id, version: 1, score: 0.5, why: "scope", citation: "valid" }] });
    const realList = store.list.bind(store);
    store.list = async (...args: Parameters<typeof realList>) => { if (args[1]?.statuses?.includes("pending") === true) throw new Error("table down"); return realList(...args); };
    await applyLoadReport(deps, { ...KEY, taskId: "task-9", stage: "IMPLEMENT", round: 1, report: { v: 1, stage: "IMPLEMENT", lessons: [{ id: lesson.id, version: 1, citation: "valid" }, { id: other.id, version: 1, citation: "valid" }] } as never });
    // not made stable (it could not be checked), but counted as loaded; and the second lesson of the report was applied too
    expect((await store.get(KEY, lesson.id))!.trial?.state).toBe("trial");
    expect((await store.get(KEY, lesson.id))!.counters.loaded).toBe(3);
    expect((await store.get(KEY, other.id))!.counters.loaded).toBe(1);
    // the next load, with the read back, promotes it
    store.list = realList;
    await store.putManifest({ ...loadedManifest("task-10", lesson.id) });
    await applyLoadReport(deps, { ...KEY, taskId: "task-10", stage: "IMPLEMENT", round: 1, report: { v: 1, stage: "IMPLEMENT", lessons: [{ id: lesson.id, version: 1, citation: "valid" }] } as never });
    expect((await store.get(KEY, lesson.id))!.trial?.state).toBe("stable");
  });
  it("at load time too, a lesson a pending member-correction card contradicts stays on trial (one eligibility check for the load and the nightly pass); a card that is not a member's, or none, does not hold it back", async () => {
    const card = (member: boolean, over: Partial<Lesson> = {}): Lesson => lessonRecord({
      id: "les_card9", workspaceId: WS, project: PROJECT, status: "pending", contradictsWith: "les_none", tierReasons: ["contradiction"], provenance: { ...draft().provenance, memberCorrection: member }, ...over,
    });
    const third = async (cardOf: ((lessonId: string) => Lesson) | undefined) => {
      const { deps, store, clock, lesson } = await live();
      clock.advance(15 * DAY);
      await store.mutate(KEY, lesson.id, (l) => ({ counters: { ...l.counters, loaded: 2 } }));
      if (cardOf !== undefined) await seed(store, cardOf(lesson.id));
      await store.putManifest(loadedManifest("task-9", lesson.id));
      await applyLoadReport(deps, { ...KEY, taskId: "task-9", stage: "IMPLEMENT", round: 1, report: { v: 1, stage: "IMPLEMENT", lessons: [{ id: lesson.id, version: 1, citation: "valid" }] } as never });
      return { state: (await store.get(KEY, lesson.id))!.trial?.state, deps, store, lesson, clock };
    };
    expect((await third((id) => card(true, { contradictsWith: id }))).state).toBe("trial");
    expect((await third((id) => card(false, { contradictsWith: id }))).state).toBe("stable");
    expect((await third((id) => card(true, { contradictsWith: id, status: "rejected" }))).state).toBe("stable");
    expect((await third(undefined)).state).toBe("stable");
    // the nightly pass holds it back by the same check, and promotes it once the card is decided
    const held = await third((id) => card(true, { contradictsWith: id }));
    expect(await promoteStableTrials(held.deps, KEY)).toEqual([]);
    const decided = await held.store.get(KEY, "les_card9");
    await held.store.commit(KEY, await held.store.setVersion(KEY), [{ ...decided!, version: decided!.version + 1, status: "rejected" }], held.clock.now());
    expect(await promoteStableTrials(held.deps, KEY)).toEqual([held.lesson.id]);
  });
});

describe("isPublishable (what repository publishing may publish)", () => {
  const stable = (over: Partial<Lesson> = {}): Lesson => lessonRecord({ trial: { state: "stable", startedAt: 1, stableAt: 2 }, provenance: { ...draft().provenance, fromSharedTask: true, memberCorrection: true }, ...over });
  it("stable, live, from a shared task, a project-wide source, and no personal name in the text", () => {
    expect(isPublishable(stable(), [])).toBe(true);
    expect(isPublishable(lessonRecord({ trial: { state: "trial", startedAt: 1 }, provenance: { ...draft().provenance, fromSharedTask: true } }), [])).toBe(false);
    expect(isPublishable(lessonRecord({ provenance: { ...draft().provenance, fromSharedTask: true } }), [])).toBe(false);
    expect(isPublishable(stable({ status: "retired" }), [])).toBe(false);
    expect(isPublishable(stable({ provenance: { ...draft().provenance, fromSharedTask: false } }), [])).toBe(false);
    expect(isPublishable(stable({ provenance: { ...draft().provenance } }), [])).toBe(false);
    expect(isPublishable(stable({ provenance: { ...draft().provenance, fromSharedTask: true, audience: { kind: "restricted", acl: { source: "slack", scope: "s", capturedAt: "x", liveCheck: "none" } } } }), [])).toBe(false);
  });
  it("a lesson that is tier 2, was sent back to a person, has a retire proposal or a wrong-here mark is not publishable", () => {
    expect(isPublishable(stable({ tier: 2 }), [])).toBe(false);
    expect(isPublishable(stable({ reviewRequired: true }), [])).toBe(false);
    expect(isPublishable(stable({ retireProposedAt: 5 }), [])).toBe(false);
    expect(isPublishable(stable({ counters: { ...lessonRecord().counters, harmful: 1 } }), [])).toBe(false);
  });
  it("a person's name, an @handle or an e-mail address in the text is a personal name; the names are required", () => {
    expect(isPublishable(stable({ body: "Ann Lee asked to use withRetry." }), ["Ann Lee"])).toBe(false);
    expect(isPublishable(stable({ body: "Use withRetry. Ask @ann." }), [])).toBe(false);
    expect(isPublishable(stable({ body: "Use withRetry. Mail ann@example.com." }), [])).toBe(false);
    expect(isPublishable(stable({ body: "Use withRetry." }), ["Ann Lee"])).toBe(true);
    expect(namesAPerson("the Annex module", ["Ann"])).toBe(false);
    expect(namesAPerson("thanks, ANN!", ["Ann"])).toBe(true);
  });
  it("authority and spend words are recognised", () => {
    expect(touchesAuthorityOrSpend("The billing budget")).toBe(true);
    expect(touchesAuthorityOrSpend("The retry helper is called withRetry")).toBe(false);
  });
});

describe("presets: Standard by default, Regulated stricter-only, company floor", () => {
  it("resolves to the stricter of the company's and the project's, and an unreadable value fails closed", async () => {
    const at = (value: Record<string, unknown>) => resolveLearning({ read: async () => value }, WS, PROJECT);
    expect((await at({})).preset).toBe("standard");
    expect((await at({ preset: "regulated" })).preset).toBe("regulated");
    expect((await at({ companyPreset: "regulated" })).preset).toBe("regulated");
    expect((await at({ preset: "standard", companyPreset: "standard" })).preset).toBe("standard");
    expect(await at({ preset: "loose" })).toMatchObject({ mode: "Off", preset: "regulated" });
    expect(await at({ companyPreset: "everything" })).toMatchObject({ mode: "Off" });
  });

  function presetDeps(eligible: string[] = ["ann"], complete = true) {
    const rows = new Map<string, "standard" | "regulated">();
    const changes = new Map<string, PresetChange>();
    const key = (s: { kind: string; project?: string }) => `${s.kind}:${s.project ?? ""}`;
    const audit = new Audit();
    const deps: PresetDeps = {
      settings: { read: async (s) => rows.get(key(s)), write: async (s, v, _meta, from) => { if ((rows.get(key(s)) ?? "standard") !== from) return false; rows.set(key(s), v); return true; } },
      changes: {
        create: async (c) => { if (changes.has(c.id)) return false; changes.set(c.id, { ...c }); return true; },
        get: async (_s, id) => changes.get(id), open: async () => [...changes.values()].find((c) => c.state === "pending"),
        transition: async (_s, id, from, to) => { const c = changes.get(id); if (c === undefined || c.state !== from) return false; c.state = to; return true; },
      },
      audit, now: () => 1, newId: () => "chg-1", soleOwnerLoosening: async () => true,
      authority: { eligibility: async () => ({ complete, membershipVersion: 1, ownerIds: eligible.slice(0, 1), eligibleIds: eligible, lastEligibleLossAtMs: null }) },
    };
    return { deps, rows, audit, changes };
  }
  const project = { kind: "project" as const, workspaceId: WS, project: PROJECT };
  it("an eligible maintainer makes it stricter at once, audited with who and between which presets", async () => {
    const { deps, rows, audit } = presetDeps();
    expect(await setLearningPreset(deps, { scope: project, value: "regulated", requestedBy: "ann" })).toEqual({ ok: true, status: "applied", changed: true, value: "regulated" });
    expect(rows.get("project:" + PROJECT)).toBe("regulated");
    expect(audit.events.at(-1)).toMatchObject({ action: "lesson.preset_changed", actor: "ann", facts: { scope: "project", from: "standard", to: "regulated", mode: "direct" } });
    expect(await setLearningPreset(deps, { scope: project, value: "regulated", requestedBy: "ann" })).toEqual({ ok: true, status: "applied", changed: false, value: "regulated" });
  });
  it("refuses a person who may not decide, an unreadable roster, and a value that is not a preset", async () => {
    expect(await setLearningPreset(presetDeps(["ann"]).deps, { scope: project, value: "regulated", requestedBy: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
    expect(await setLearningPreset(presetDeps(["ann"], false).deps, { scope: project, value: "regulated", requestedBy: "ann" })).toEqual({ ok: false, code: "eligibility_unavailable" });
    expect(await setLearningPreset(presetDeps().deps, { scope: project, value: "off", requestedBy: "ann" })).toEqual({ ok: false, code: "invalid_value" });
  });
});
