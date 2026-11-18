// Lessons phase 4: graduation ("Make this permanent?"), team rules, the Tidy card, the third conflict answer. In-memory stores only; no network, no model.
import { describe, expect, it } from "vitest";
import { companyScoped, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../../packages/broker/src/lessons/load.js";
import { approveLesson } from "../../../packages/broker/src/lessons/approve.js";
import { allowedTargets, graduateLesson, graduationCandidates, graduationLater, weeklyCard, type GraduateDeps, type GraduationTarget, type SkillGraduation } from "../../../packages/broker/src/lessons/graduate.js";
import { GraduationUnreadable, DAY_MS, WEEK_MS, draftIdFor, getCheckDraft, listCheckDrafts, readCard, weekOf } from "../../../packages/broker/src/lessons/graduation-store.js";
import { PROVEN, provenLesson } from "../../../packages/broker/src/lessons/proven.js";
import { settleBothPlaces } from "../../../packages/broker/src/lessons/settle-both.js";
import { TIDY_MAX, TIDY_MIN_ACTIVE, retireTidy, tidyCard, tidyLater, type TidyDeps } from "../../../packages/broker/src/lessons/tidy.js";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { graduatedCleanup } from "../../../packages/broker/src/lessons/graduated-cleanup.js";
import { putCheckDraft, moveCheckDraft } from "../../../packages/broker/src/lessons/graduation-store.js";
import { claimGraduation } from "../../../packages/broker/src/lessons/graduation-store.js";
import { pathWithin, pathsWithin, ruleWeight, TEAM_RULES_BYTES_MAX, TEAM_RULES_MAX, TEAM_RULES_RETIRED_KEPT, addTeamRule, createTeamRulePublisher, createTeamRulesSource, readTeamRules, retireTeamRule, ruleMatchesFiles, teamRuleLayers, validGlob, TeamRulesUnreadable } from "../../../packages/broker/src/lessons/team-rules.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { lessonUsePk } from "../../../packages/broker/src/lessons/use-count.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { withLessonAudiences } from "../../../packages/broker/src/lessons/task-audience.js";
import { Audit, Clock, KEY, MemoryVectors, PROJECT, WS, allSharedTasks, allowAllAccess, directory, draft, embedder, lessonRecord, seed, settings, wideAudience } from "./lesson-helpers.js";

const A = WS as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const IDENTITY = (id: string) => ({ principals: [], groups: [], developerId: id });

/** A lesson that has proved itself: person-approved, 40 days old, two authors, valid citation, nothing against it (`provenLesson`). Uses are written by `uses`. */
const provenLessonRecord = (clock: Clock, id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({
  id, type: "convention", tier: 1, tierReasons: [], title: `Rule ${id}`, description: "Money is in cents.", body: "Store amounts as integer cents.", scope: { repos: ["api"], paths: ["src/billing/**"] },
  approvals: [{ approvalId: `ap-${id}`, by: "ann", at: 1, mode: "one" }], createdAt: clock.now() - 40 * DAY_MS, expiresAt: clock.now() + 60 * DAY_MS,
  provenance: { ...draft().provenance, authors: ["ann", "bob"], supportTasks: ["t1", "t2"], measured: false, audience: { kind: "project" } }, ...over,
});

function world(over: { dir?: ReturnType<typeof directory>; companyId?: OrgId } = {}) {
  const clock = new Clock();
  const store = new InMemoryLessonStore();
  const documents = new MemoryDocumentStore();
  const audit = new Audit();
  const vectors = new MemoryVectors();
  const dir = over.dir ?? directory({ ownerIds: ["owner"], eligibleIds: ["owner", "ann", "bob", "cat"] });
  const companyId = over.companyId ?? A;
  const published: Array<Record<string, unknown>> = [];
  const deps: GraduateDeps = {
    now: clock.now, audit, store, directory: dir, settings: settings(), vectors, publisher: createTeamRulePublisher({ store: documents, companyId, now: clock.now }),
    taskVisibility: allSharedTasks, documents, access: allowAllAccess,
  };
  /** The tasks a lesson was given to: one use row per task. */
  const uses = async (lessonId: string, count: number, project = PROJECT, company: OrgId = companyId): Promise<void> => {
    for (let i = 0; i < count; i += 1) await documents.put({ item: { pk: lessonUsePk(company, project, lessonId), sk: `task-${String(i)}`, entityType: "LESSON_USE", taskId: `task-${String(i)}`, at: clock.now() - DAY_MS } });
  };
  return { clock, store, documents, audit, vectors, dir, deps, uses, published, companyId };
}
type World = ReturnType<typeof world>;
const ask = (w: World, lessonId: string, who: string, target: GraduationTarget = "rule", extra: Record<string, unknown> = {}) => graduateLesson(w.deps, { ...KEY, lessonId, approverId: who, target, ...extra });
async function prove(w: World, ...lessons: Lesson[]): Promise<void> { await seed(w.store, ...lessons); for (const l of lessons) await w.uses(l.id, 12); }

describe("proven (the band graduation asks for)", () => {
  const clock = new Clock();
  const base = provenLessonRecord(clock, "les_prov0001");
  const input = (over: Partial<Lesson> = {}, tasks: number | null = 10) => ({ lesson: { ...base, ...over }, tasks: tasks === null ? undefined : tasks, now: clock.now() });
  it("a lesson with ten tasks, thirty days, two people and nothing against it is proven", () => { expect(provenLesson(input())).toBe(true); });
  it("each part is needed: tasks, days, harmful marks, trial, a single unmeasured person, a stale citation, an open contradiction, a retire asked for, a possible duplicate, restricted, graduated already", () => {
    expect(provenLesson(input({}, PROVEN.tasks - 1))).toBe(false);
    expect(provenLesson(input({}, null))).toBe(false);
    expect(provenLesson(input({ createdAt: clock.now() - (PROVEN.days - 1) * DAY_MS }))).toBe(false);
    expect(provenLesson(input({ counters: { loaded: 20, helpful: 0, harmful: 1, citationStale: 0 } }))).toBe(false);
    expect(provenLesson(input({ trial: { state: "stable", startedAt: 1 } }))).toBe(false);
    expect(provenLesson(input({ provenance: { ...base.provenance, authors: ["ann"] } }))).toBe(false);
    expect(provenLesson(input({ provenance: { ...base.provenance, authors: ["ann"], measured: true } }))).toBe(true);
    expect(provenLesson(input({ citationChecks: [{ index: 0, result: "stale", at: 1 }] }))).toBe(false);
    expect(provenLesson(input({ contradictsWith: "les_other001" }))).toBe(false);
    expect(provenLesson(input({ retireProposedAt: 5 }))).toBe(false);
    expect(provenLesson(input({ possibleDuplicateOf: "les_other001" }))).toBe(false);
    expect(provenLesson(input({ provenance: { ...base.provenance, audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T/C", principals: ["U1"], capturedAt: "x", liveCheck: "none" } } } }))).toBe(false);
    expect(provenLesson(input({ became: { kind: "rule", ref: "rule_x", at: 1 } }))).toBe(false);
    expect(provenLesson(input({ status: "pending" }))).toBe(false);
  });
});

describe("the weekly card: one 'Make this permanent?' a week per project", () => {
  it("names the best proven lesson, the same one to everyone, and no second card the same week even after it is answered", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_best0001", { provenance: { ...provenLessonRecord(w.clock, "x").provenance, measured: true, supportTasks: ["a", "b", "c", "d", "e"] } }), provenLessonRecord(w.clock, "les_next0001"), provenLessonRecord(w.clock, "les_third001"));
    const first = await weeklyCard(w.deps, KEY, IDENTITY("ann"));
    expect(first).toMatchObject({ lessonId: "les_best0001", target: "rule", targets: ["rule", "check"], tasks: 12, needs: { required: 1, have: 0, you: false } });
    // The same card for another maintainer, and again for the first.
    expect((await weeklyCard(w.deps, KEY, IDENTITY("bob")))?.lessonId).toBe("les_best0001");
    expect((await weeklyCard(w.deps, KEY, IDENTITY("ann")))?.lessonId).toBe("les_best0001");
    // Answered: the rule is made and no other card appears this week, though two more lessons are proven.
    expect(await ask(w, "les_best0001", "ann")).toMatchObject({ ok: true, state: "done" });
    expect((await readCard(w.documents, A, PROJECT, weekOf(w.clock.now())))?.state).toBe("done");
    expect(await weeklyCard(w.deps, KEY, IDENTITY("ann"))).toBeUndefined();
    expect((await graduationCandidates(w.deps, KEY, IDENTITY("ann"))).map((o) => o.lessonId).sort()).toEqual(["les_next0001", "les_third001"]);
    // Next week: the next one, once.
    w.clock.advance(WEEK_MS);
    expect((await weeklyCard(w.deps, KEY, IDENTITY("ann")))?.lessonId).toMatch(/^les_(next0001|third001)$/u);
    // One row per week names the card (the structure that holds "one a week").
    expect((await readCard(w.documents, A, PROJECT, weekOf(w.clock.now())))?.state).toBe("open");
  });

  it("Not now keeps the lesson off for 60 days and uses the week's card", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_best0001"), provenLessonRecord(w.clock, "les_next0001"));
    const card = await weeklyCard(w.deps, KEY, IDENTITY("ann"));
    expect(await graduationLater(w.deps, { ...KEY, lessonId: card!.lessonId, approverId: "ann" })).toEqual({ ok: true });
    expect(await weeklyCard(w.deps, KEY, IDENTITY("ann"))).toBeUndefined();
    w.clock.advance(WEEK_MS);
    const next = await weeklyCard(w.deps, KEY, IDENTITY("ann"));
    expect(next).toBeDefined();
    expect(next!.lessonId).not.toBe(card!.lessonId);
    w.clock.advance(60 * DAY_MS);
    expect((await graduationCandidates(w.deps, KEY, IDENTITY("ann"))).map((o) => o.lessonId)).toContain(card!.lessonId);
  });

  it("is for people who decide, only for a project whose learning is on, and a card whose lesson stopped being a candidate is not replaced that week", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_best0001"), provenLessonRecord(w.clock, "les_next0001"));
    expect(await weeklyCard(w.deps, KEY, IDENTITY("mallory"))).toBeUndefined();
    expect(await weeklyCard(w.deps, KEY, { principals: [], groups: [] })).toBeUndefined();
    expect(await weeklyCard({ ...w.deps, settings: settings({ mode: "Collect" }) }, KEY, IDENTITY("ann"))).toBeUndefined();
    expect((await weeklyCard(w.deps, KEY, IDENTITY("ann")))?.lessonId).toBe("les_best0001");
    // The named lesson gets a harmful mark mid-week: no card (not "the next lesson").
    await w.store.mutate(KEY, "les_best0001", (lesson) => ({ counters: { ...lesson.counters, harmful: 1 } }));
    expect(await weeklyCard(w.deps, KEY, IDENTITY("ann"))).toBeUndefined();
  });

  it("an unreadable card row is a thrown refusal, never 'no card'", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_best0001"));
    await w.documents.put({ item: { pk: companyScoped(A, `LESSON_GRAD#${PROJECT}`), sk: `card#${String(weekOf(w.clock.now()))}`, entityType: "LESSON_GRAD_CARD", week: "not a number" } });
    await expect(weeklyCard(w.deps, KEY, IDENTITY("ann"))).rejects.toBeInstanceOf(GraduationUnreadable);
  });

  it("offers only what can be proven: not a preference, not under ten tasks, not a lesson learned from a task narrower than the project", async () => {
    const w = world();
    await seed(w.store,
      provenLessonRecord(w.clock, "les_ok000001"), provenLessonRecord(w.clock, "les_pref0001", { type: "preference" }), provenLessonRecord(w.clock, "les_few00001"),
      provenLessonRecord(w.clock, "les_narrow01", { provenance: { ...provenLessonRecord(w.clock, "x").provenance, supportTasks: ["t-narrow"] } }));
    for (const id of ["les_ok000001", "les_pref0001", "les_narrow01"]) await w.uses(id, 12);
    await w.uses("les_few00001", 9);
    const tasks = withLessonAudiences({ read: async () => new Map() }, { read: async (_o: unknown, ids: readonly string[]) => new Map(ids.map((id) => [id, id === "t-narrow" ? wideAudience({ denied: new Set(["bob"]) }) : wideAudience()])) });
    const offers = await graduationCandidates({ ...w.deps, taskVisibility: tasks }, KEY, IDENTITY("ann"));
    expect(offers.map((o) => o.lessonId)).toEqual(["les_ok000001"]);
  });
});

describe("graduating to a rule (the default)", () => {
  it("publishes a team rule scoped to the lesson's code area, retires the lesson with a became link and keeps its history; the lesson is not loaded again", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_conv0001"));
    await w.vectors.upsert(WS, PROJECT, "les_conv0001", await embedder.embed("x"), { status: "active" });
    const loadDeps: LoadDeps = { access: allowAllAccess, store: w.store, embedder, vectors: w.vectors, settings: settings(), audit: w.audit, now: w.clock.now };
    const request: LoadRequest = { workspaceId: WS, project: PROJECT, taskId: "task-1", stage: "IMPLEMENT", round: 1, intent: "Store amounts as integer cents", repos: ["api"], files: ["src/billing/money.ts"], languages: [], taskAudience: { kind: "shared" } };
    expect((await loadLessonsForStage(loadDeps, request)).context?.lessons.map((l) => l.id)).toEqual(["les_conv0001"]);

    const made = await ask(w, "les_conv0001", "ann");
    expect(made).toMatchObject({ ok: true, target: "rule", state: "done", already: false });
    const ruleId = (made as { ref: string }).ref;
    const rules = await readTeamRules(w.documents, A, PROJECT);
    expect(rules.rules).toEqual([expect.objectContaining({ id: ruleId, text: "Rule les_conv0001. Store amounts as integer cents.", paths: ["src/billing/**"], repos: ["api"], fromLesson: "les_conv0001" })]);
    // The lesson is retired and linked, with its history (the earlier version) still there.
    const after = (await w.store.getHead(KEY, "les_conv0001"))!;
    expect(after).toMatchObject({ status: "retired", became: { kind: "rule", ref: ruleId }, promotedRuleId: ruleId });
    expect((await w.store.versions(KEY, "les_conv0001")).map((v) => v.status)).toEqual(expect.arrayContaining(["active", "retired"]));
    // It is not handed out as a lesson again.
    expect((await loadLessonsForStage(loadDeps, request)).context?.lessons ?? []).toEqual([]);
    expect(w.audit.actions()).toContain("lesson.graduated");
    // Doing it again answers the same (nothing is made twice).
    expect(await ask(w, "les_conv0001", "ann")).toMatchObject({ ok: true, state: "done", ref: ruleId, already: true });
    expect((await readTeamRules(w.documents, A, PROJECT)).rules).toHaveLength(1);
  });

  it("the person may set where the rule applies; bad paths are refused", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_conv0001"), provenLessonRecord(w.clock, "les_conv0002"));
    expect(await ask(w, "les_conv0001", "ann", "rule", { paths: ["../etc/**"] })).toEqual({ ok: false, code: "bad_paths" });
    expect(await ask(w, "les_conv0001", "ann", "rule", { paths: ["/abs/**"] })).toEqual({ ok: false, code: "bad_paths" });
    expect(await ask(w, "les_conv0001", "ann", "rule", { paths: Array.from({ length: 21 }, (_, i) => `p${String(i)}/**`) })).toEqual({ ok: false, code: "bad_paths" });
    // Narrower only: another area, the whole project and a protected path are not inside the lesson's own.
    for (const outside of [["**"], ["tests/**"], [".github/workflows/**"], ["src/**"], ["src/billingX/**"]]) expect(await ask(w, "les_conv0001", "ann", "rule", { paths: outside }), outside.join()).toEqual({ ok: false, code: "paths_outside" });
    expect((await readTeamRules(w.documents, A, PROJECT)).rules).toHaveLength(0);
    expect(await ask(w, "les_conv0002", "ann", "rule", { paths: ["src/billing/invoices/**"] })).toMatchObject({ ok: true });
    expect((await readTeamRules(w.documents, A, PROJECT)).rules[0]!.paths).toEqual(["src/billing/invoices/**"]);
  });

  it("is refused for a lesson that is not proven, not active, the wrong kind, restricted, from a narrower task, or for a person who may not decide", async () => {
    const w = world();
    await seed(w.store, provenLessonRecord(w.clock, "les_few00001"), provenLessonRecord(w.clock, "les_pref0001", { type: "preference" }), provenLessonRecord(w.clock, "les_pend0001", { status: "pending" }),
      provenLessonRecord(w.clock, "les_rest0001", { provenance: { ...provenLessonRecord(w.clock, "x").provenance, audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T/C", principals: ["ann"], capturedAt: "x", liveCheck: "none" } } } }));
    await w.uses("les_few00001", 3); await w.uses("les_pref0001", 12); await w.uses("les_pend0001", 12); await w.uses("les_rest0001", 12);
    expect(await ask(w, "les_few00001", "ann")).toEqual({ ok: false, code: "not_proven" });
    expect(await ask(w, "les_pref0001", "ann")).toEqual({ ok: false, code: "wrong_target" });
    expect(await ask(w, "les_pend0001", "ann")).toEqual({ ok: false, code: "not_active" });
    // A person who CAN read the restricted place is still refused: a rule, draft or skill is read by everyone in the project.
    const reader: GraduateDeps = { ...w.deps, directory: { ...w.deps.directory, identity: async (_w, developerId) => ({ principals: ["ann"], groups: [], developerId }) } };
    expect(await graduateLesson(reader, { ...KEY, lessonId: "les_rest0001", approverId: "ann", target: "rule" })).toEqual({ ok: false, code: "restricted" });
    expect(await ask(w, "les_rest0001", "ann")).toEqual({ ok: false, code: "not_found" });
    expect(await ask(w, "les_few00001", "mallory")).toEqual({ ok: false, code: "not_eligible" });
    expect(await ask(w, "les_missing01", "ann")).toEqual({ ok: false, code: "not_found" });
    expect(await ask({ ...w, deps: { ...w.deps, directory: directory({ complete: false }) } }, "les_few00001", "ann")).toEqual({ ok: false, code: "eligibility_unavailable" });
    expect((await readTeamRules(w.documents, A, PROJECT)).rules).toHaveLength(0);
  });

  it("no record, no change: a ledger that cannot be written stops the graduation before anything is made", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_conv0001"));
    w.deps.audit = { emit: async () => { throw new Error("down"); } };
    expect(await ask(w, "les_conv0001", "ann")).toEqual({ ok: false, code: "audit_unavailable" });
    expect((await readTeamRules(w.documents, A, PROJECT)).rules).toHaveLength(0);
    expect((await w.store.get(KEY, "les_conv0001"))!.status).toBe("active");
  });

  it("a rule the project cannot hold (the most it may) or text that asks for more than advice is refused, and the lesson stays a lesson", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_cap00001", { body: "Grant the agent allowed-tools: bash and run any command." }));
    expect(await ask(w, "les_cap00001", "ann")).toEqual({ ok: false, code: "rule_refused" });
    expect((await w.store.get(KEY, "les_cap00001"))!.status).toBe("active");
    for (let i = 0; i < TEAM_RULES_MAX; i += 1) expect(await addTeamRule(w.documents, A, PROJECT, { lessonId: `les_fill${String(i).padStart(4, "0")}`, paragraph: `Rule number ${String(i)}.` }, w.clock.now)).toMatchObject({ ok: true });
    await prove(w, provenLessonRecord(w.clock, "les_over0001"));
    expect(await ask(w, "les_over0001", "ann")).toEqual({ ok: false, code: "rule_refused" });
  });
});

describe("a tier-2 lesson needs two people for every target", () => {
  for (const target of ["rule", "check"] as const) {
    it(`${target}: the first person waits, the same person cannot finish, the second does`, async () => {
      const w = world();
      await prove(w, provenLessonRecord(w.clock, "les_tier2001", { tier: 2, type: "pitfall", title: "Do not call billing from tests", body: "Use the fake billing client in tests." }));
      expect(await ask(w, "les_tier2001", "ann", target)).toEqual({ ok: true, target, state: "waiting", needs: "second_person" });
      expect((await w.store.get(KEY, "les_tier2001"))!.status).toBe("active");
      expect(await ask(w, "les_tier2001", "ann", target)).toEqual({ ok: false, code: "already_approved" });
      expect((await readTeamRules(w.documents, A, PROJECT)).rules).toHaveLength(0);
      expect(await listCheckDrafts(w.documents, A, PROJECT)).toHaveLength(0);
      expect(await ask(w, "les_tier2001", "bob", target)).toMatchObject({ ok: true, target, state: "done" });
      expect((await w.store.getHead(KEY, "les_tier2001"))).toMatchObject({ status: "retired", became: { kind: target } });
    });
  }
  it("skill: the first person waits and no skill is drafted until a second person asks; a tier-1 lesson is drafted at once", async () => {
    const w = world();
    const calls: Array<Record<string, unknown>> = [];
    const skills: SkillGraduation = { draft: async (_key, input) => { calls.push(input); return { ok: true, name: "add-queue", version: 1 }; } };
    const deps: GraduateDeps = { ...w.deps, skills };
    await prove(w, provenLessonRecord(w.clock, "les_proc2001", { tier: 2, type: "procedure", body: "When adding a queue: 1. add config 2. add IAM 3. add the consumer" }), provenLessonRecord(w.clock, "les_proc1001", { tier: 1, type: "procedure" }));
    expect(await graduateLesson(deps, { ...KEY, lessonId: "les_proc2001", approverId: "ann", target: "skill" })).toEqual({ ok: true, target: "skill", state: "waiting", needs: "second_person" });
    expect(calls).toHaveLength(0);
    expect(await graduateLesson(deps, { ...KEY, lessonId: "les_proc2001", approverId: "bob", target: "skill", skillName: "add-queue" })).toEqual({ ok: true, target: "skill", state: "drafted", ref: "add-queue", version: 1 });
    expect(calls).toEqual([{ lessonId: "les_proc2001", by: "bob", name: "add-queue" }]);
    expect(await graduateLesson(deps, { ...KEY, lessonId: "les_proc1001", approverId: "ann", target: "skill" })).toMatchObject({ state: "drafted" });
    // The lesson becomes the skill only when the skill goes live (L4-AK3 calls `recordBecame`): nothing is retired by the draft.
    expect((await w.store.get(KEY, "les_proc2001"))!.status).toBe("active");
  });
});

describe("graduating to a check: a draft task a person starts", () => {
  it("makes a draft in Rovara's store, links the lesson to it, and starts nothing", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_pit00001", { type: "pitfall", title: "Do not call the billing API from tests", body: "Use the fake billing client in tests." }));
    const writes = new Set<string>();
    const original = w.documents.put.bind(w.documents);
    w.documents.put = async (request) => { writes.add(/#(LESSON_GRAD|TEAMRULES)#/u.exec(String(request.item["pk"]))?.[1] ?? String(request.item["pk"])); return original(request); };
    expect(allowedTargets("pitfall")).toEqual(["check", "rule"]);
    const made = await ask(w, "les_pit00001", "ann", "check");
    expect(made).toMatchObject({ ok: true, target: "check", state: "done", already: false });
    const drafts = await listCheckDrafts(w.documents, A, PROJECT);
    expect(drafts).toEqual([expect.objectContaining({ lessonId: "les_pit00001", status: "draft", title: "Add a check for: Do not call the billing API from tests", paths: ["src/billing/**"] })]);
    expect(drafts[0]!.request).toContain("Add a check (a test or a lint rule)");
    expect(drafts[0]!.startedTaskId).toBeUndefined();
    expect((await w.store.getHead(KEY, "les_pit00001"))).toMatchObject({ status: "retired", became: { kind: "check", ref: drafts[0]!.id } });
    // Only the lessons and graduation rows were written: no task, workspace or dispatch row, and there is no task port to start one with.
    expect([...writes].filter((name) => !["LESSON_GRAD", "TEAMRULES"].includes(name))).toEqual([]);
    expect(Object.keys(w.deps).filter((name) => /task|start|flow|dispatch/iu.test(name)).sort()).toEqual(["taskVisibility"]);
    expect(await getCheckDraft(w.documents, A, PROJECT, drafts[0]!.id)).toMatchObject({ status: "draft" });
  });

  it("a kind of lesson that cannot become that is refused", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_proc0001", { type: "procedure" }));
    expect(await ask(w, "les_proc0001", "ann", "check")).toEqual({ ok: false, code: "wrong_target" });
    expect(await ask(w, "les_proc0001", "ann", "skill")).toEqual({ ok: false, code: "no_skills" });
  });
});

describe("two companies and two projects never share a card, a draft or a rule", () => {
  it("company B's maintainer sees nothing of A's card, drafts or rules, and B's publisher refuses A's project", async () => {
    const a = world();
    const b = world({ companyId: B });
    await prove(a, provenLessonRecord(a.clock, "les_conv0001"), provenLessonRecord(a.clock, "les_pit00001", { type: "pitfall" }));
    await ask(a, "les_pit00001", "ann", "check");
    await ask(a, "les_conv0001", "ann", "rule");
    // The same project name in another company's store: empty.
    expect(await readTeamRules(b.documents, B, PROJECT)).toEqual({ revision: 0, rules: [] });
    expect(await listCheckDrafts(b.documents, B, PROJECT)).toEqual([]);
    expect(await weeklyCard(b.deps, KEY, IDENTITY("ann"))).toBeUndefined();
    // One store holding both companies: company B's keys never read company A's rows.
    expect((await readTeamRules(a.documents, B, PROJECT)).rules).toHaveLength(0);
    expect(await listCheckDrafts(a.documents, B, PROJECT)).toEqual([]);
    expect((await readTeamRules(a.documents, A, "other-project")).rules).toHaveLength(0);
    expect(await listCheckDrafts(a.documents, A, "other-project")).toEqual([]);
    // The publisher publishes only into its own company: a workspace id that is not its company is refused, and writes nothing.
    await expect(createTeamRulePublisher({ store: b.documents, companyId: B, now: b.clock.now }).publish({ workspaceId: A, project: PROJECT, paragraph: "Hello.", lessonId: "les_x0000001", approverId: "ann" })).rejects.toThrow();
    expect((await readTeamRules(b.documents, B, PROJECT)).rules).toHaveLength(0);
    // Use rows of another project do not make a lesson proven here.
    const c = world();
    await seed(c.store, provenLessonRecord(c.clock, "les_conv0001"));
    await c.uses("les_conv0001", 12, "other-project");
    await c.uses("les_conv0001", 12, PROJECT, B);
    expect(await ask(c, "les_conv0001", "ann")).toEqual({ ok: false, code: "not_proven" });
    // A card row of a week is per project.
    await prove(c, provenLessonRecord(c.clock, "les_conv0002"));
    expect((await weeklyCard(c.deps, KEY, IDENTITY("ann")))?.lessonId).toBe("les_conv0002");
    expect(await readCard(c.documents, A, "other-project", weekOf(c.clock.now()))).toBeUndefined();
    expect(await readCard(c.documents, B, PROJECT, weekOf(c.clock.now()))).toBeUndefined();
  });
});

describe("team rules: scoped, bounded, read only for the step they apply to", () => {
  it("the rules of a project share one text budget, not only a count", async () => {
    const w = world();
    const long = "日".repeat(699);
    let made = 0;
    for (let i = 0; i < TEAM_RULES_MAX; i += 1) { const added = await addTeamRule(w.documents, A, PROJECT, { lessonId: `les_big${String(i).padStart(5, "0")}`, paragraph: long }, w.clock.now); if (added.ok) made += 1; else expect(added).toEqual({ ok: false, code: "too_many_rules" }); }
    expect(made).toBeGreaterThan(10);
    expect(made).toBeLessThan(TEAM_RULES_MAX);
    const bytes = (await readTeamRules(w.documents, A, PROJECT)).rules.reduce((sum, rule) => sum + ruleWeight(rule), 0);
    expect(bytes).toBeLessThanOrEqual(TEAM_RULES_BYTES_MAX);
  });

  it("layers carry the scope in words, only for the step's stage, and leave out rules for other files when the step names its files", async () => {
    const w = world();
    await addTeamRule(w.documents, A, PROJECT, { lessonId: "les_bill0001", paragraph: "Money is stored in cents.", paths: ["src/billing/**"], stages: ["IMPLEMENT", "REVIEW"] }, w.clock.now);
    await addTeamRule(w.documents, A, PROJECT, { lessonId: "les_all00001", paragraph: "Name tests after behaviour.", stages: ["PLAN", "IMPLEMENT"] }, w.clock.now);
    const set = await readTeamRules(w.documents, A, PROJECT);
    expect(teamRuleLayers(set, { mode: "IMPLEMENT" }).map((l) => l.text)).toEqual(["Applies to src/billing/**. Money is stored in cents.", "Applies to the whole project. Name tests after behaviour."]);
    expect(teamRuleLayers(set, { mode: "REVIEW" }).map((l) => l.text)).toEqual(["Applies to src/billing/**. Money is stored in cents."]);
    expect(teamRuleLayers(set, { mode: "PLAN" }).map((l) => l.text)).toEqual(["Applies to the whole project. Name tests after behaviour."]);
    expect(teamRuleLayers(set, { mode: "CHECKS" })).toEqual([]);
    expect(teamRuleLayers(set, { mode: "IMPLEMENT", files: ["web/app.tsx"] }).map((l) => l.text)).toEqual(["Applies to the whole project. Name tests after behaviour."]);
    expect(teamRuleLayers(set, { mode: "IMPLEMENT", files: ["src/billing/money.ts"] })).toHaveLength(2);
    expect(ruleMatchesFiles({ paths: ["src/**/*.ts"] }, ["src/a/b.ts"])).toBe(true);
    expect(ruleMatchesFiles({ paths: ["src/*.ts"] }, ["src/a/b.ts"])).toBe(false);
  });

  it("a retired rule is not delivered; a rule row that is not shaped like one is unreadable, never 'no rules'", async () => {
    const w = world();
    const added = await addTeamRule(w.documents, A, PROJECT, { lessonId: "les_bill0001", paragraph: "Money is stored in cents." }, w.clock.now);
    expect(added.ok && await retireTeamRule(w.documents, A, PROJECT, added.ruleId, w.clock.now)).toEqual({ ok: true });
    expect(teamRuleLayers(await readTeamRules(w.documents, A, PROJECT), { mode: "IMPLEMENT" })).toEqual([]);
    const row = (await w.documents.query({ pk: companyScoped(A, `TEAMRULES#${PROJECT}`) })).items[0]!;
    await w.documents.put({ item: { ...row, rules: [{ id: "x" }] } });
    await expect(readTeamRules(w.documents, A, PROJECT)).rejects.toBeInstanceOf(TeamRulesUnreadable);
    await expect(createTeamRulesSource({ store: w.documents, companyId: A }).layersFor({ project: PROJECT, mode: "IMPLEMENT" })).rejects.toBeInstanceOf(TeamRulesUnreadable);
  });

  it("globs: plain relative only", () => {
    for (const ok of ["src/**", "src/billing/*.ts", "a/b?.ts"]) expect(validGlob(ok), ok).toBe(true);
    for (const bad of ["", "/etc/**", "../x", "a/../b", "a\\b", "a\u0000b", "a‮b", "x".repeat(201), 5]) expect(validGlob(bad), String(bad)).toBe(false);
  });

  it("a second writer of the same revision loses (a conflict), and one lesson makes one rule", async () => {
    const w = world();
    const first = await addTeamRule(w.documents, A, PROJECT, { lessonId: "les_one00001", paragraph: "One." }, w.clock.now);
    const again = await addTeamRule(w.documents, A, PROJECT, { lessonId: "les_one00001", paragraph: "One." }, w.clock.now);
    expect(first).toMatchObject({ ok: true, already: false });
    expect(again).toMatchObject({ ok: true, already: true });
    expect((await readTeamRules(w.documents, A, PROJECT)).rules).toHaveLength(1);
  });
});

describe("containment of paths (narrower only)", () => {
  it("a path is inside another only when the other is a literal directory with /** (or the same, or **)", () => {
    expect(pathWithin("src/billing/**", "src/**")).toBe(true);
    expect(pathWithin("src/billing/a.ts", "src/**")).toBe(true);
    expect(pathWithin("src/**", "src/**")).toBe(true);
    expect(pathWithin("x/y.ts", "**")).toBe(true);
    for (const [path, existing] of [["src/**", "src/billing/**"], ["src/auth/**", "src/{billing,ledger}/**"], ["src/bank/**", "src/b?/**"], ["src/a/**", "src/a*b/**"], ["srcX/**", "src/**"], ["**", "src/**"], ["src/a/b.ts", "src/a.ts"], ["src/x/**", "src/*/**"], ["src/**/*.ts", "src/**/*.js"]]) expect(pathWithin(path!, existing!), `${path} in ${existing}`).toBe(false);
    expect(pathsWithin(["anything/**"], undefined)).toBe(true);
    expect(pathsWithin(["anything/**"], [])).toBe(true);
    expect(pathsWithin(["a/**", "b/**"], ["a/**"])).toBe(false);
  });
});

describe("what two people ask for must match, and a protected place needs two people", () => {
  it("the second person must ask for the same target and the same paths as the first", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_tier2001", { tier: 2, type: "pitfall" }));
    expect(await ask(w, "les_tier2001", "ann", "rule")).toMatchObject({ state: "waiting" });
    expect(await ask(w, "les_tier2001", "bob", "check")).toEqual({ ok: false, code: "request_differs" });
    expect(await ask(w, "les_tier2001", "bob", "rule", { paths: ["src/billing/invoices/**"] })).toEqual({ ok: false, code: "request_differs" });
    expect(await ask(w, "les_tier2001", "bob", "rule")).toMatchObject({ ok: true, state: "done" });
  });
  it("a tier-1 lesson whose rule would apply to tests or CI paths needs two people", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_risky001", { tier: 1, scope: { paths: [".github/workflows/**"] } }));
    expect(await ask(w, "les_risky001", "ann", "rule")).toEqual({ ok: true, target: "rule", state: "waiting", needs: "second_person" });
    expect((await readTeamRules(w.documents, A, PROJECT)).rules).toHaveLength(0);
    expect(await ask(w, "les_risky001", "bob", "rule")).toMatchObject({ ok: true, state: "done" });
  });
  it("one target per lesson: a lesson claimed for another target is refused and nothing is made", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_pit00001", { type: "pitfall" }));
    expect(await claimGraduation(w.documents, A, PROJECT, "les_pit00001", "check", w.clock.now())).toBe("claimed");
    expect(await ask(w, "les_pit00001", "ann", "rule")).toEqual({ ok: false, code: "already_approved" });
    expect((await readTeamRules(w.documents, A, PROJECT)).rules).toHaveLength(0);
    expect(await ask(w, "les_pit00001", "ann", "check")).toMatchObject({ ok: true, state: "done" });
  });
  it("a failed publish releases the claim and records a failure, so another try or target can go on", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_pit00001", { type: "pitfall" }));
    const real = w.deps.publisher;
    w.deps.publisher = { publish: async () => { throw new Error("no"); } };
    expect(await ask(w, "les_pit00001", "ann", "rule")).toEqual({ ok: false, code: "rule_refused" });
    expect(w.audit.actions()).toContain("lesson.promote_failed");
    w.deps.publisher = real;
    expect(await ask(w, "les_pit00001", "ann", "check")).toMatchObject({ ok: true, state: "done" });
  });
});

describe("a lesson that is gone takes its rule and draft with it", () => {
  it("withdrawing a graduated lesson retires its rule, dismisses its draft and releases the claim", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_conv0001"), provenLessonRecord(w.clock, "les_pit00001", { type: "pitfall" }));
    await ask(w, "les_conv0001", "ann", "rule");
    await ask(w, "les_pit00001", "ann", "check");
    const deletion = lessonDeletionPort({ store: w.store, vectors: w.vectors, audit: w.audit, now: w.clock.now, onGone: graduatedCleanup(w.documents, w.clock.now) });
    await deletion.withdraw(WS, PROJECT, "les_conv0001", "sources_deleted");
    expect(teamRuleLayers(await readTeamRules(w.documents, A, PROJECT), { mode: "IMPLEMENT" })).toEqual([]);
    expect((await listCheckDrafts(w.documents, A, PROJECT)).map((d) => d.status)).toEqual(["draft"]);
    await deletion.withdraw(WS, PROJECT, "les_pit00001", "sources_deleted");
    expect((await listCheckDrafts(w.documents, A, PROJECT)).map((d) => d.status)).toEqual(["dismissed"]);
  });
});

describe("review follow-ups: restart, bounds, cleanup and what the first person chose", () => {
  it("the first person may change their own request while nobody else asked; the card then shows what they chose", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_tier2001", { tier: 2, type: "pitfall" }));
    expect(await ask(w, "les_tier2001", "ann", "rule")).toMatchObject({ state: "waiting" });
    expect((await graduationCandidates(w.deps, KEY, IDENTITY("bob")))[0]!).toMatchObject({ target: "rule", needs: { required: 2, have: 1, you: false, first: { target: "rule", paths: ["src/billing/**"] } } });
    expect(await ask(w, "les_tier2001", "ann", "rule")).toEqual({ ok: false, code: "already_approved" });
    expect(await ask(w, "les_tier2001", "ann", "check")).toMatchObject({ state: "waiting" });
    const offer = (await graduationCandidates(w.deps, KEY, IDENTITY("bob")))[0]!;
    expect(offer).toMatchObject({ target: "check", needs: { have: 1, first: { target: "check" } } });
    expect(await ask(w, "les_tier2001", "bob", "rule")).toEqual({ ok: false, code: "request_differs" });
    expect(await ask(w, "les_tier2001", "bob", "check")).toMatchObject({ ok: true, state: "done" });
  });

  it("retired rules are kept only in part (the row never outgrows a read), and a failing step leaves no claim behind", async () => {
    const w = world();
    for (let i = 0; i < 100; i += 1) {
      const added = await addTeamRule(w.documents, A, PROJECT, { lessonId: `les_cyc${String(i).padStart(5, "0")}`, paragraph: `Rule ${String(i)}.` }, w.clock.now);
      expect(added.ok).toBe(true);
      if (added.ok) await retireTeamRule(w.documents, A, PROJECT, added.ruleId, w.clock.now);
    }
    const set = await readTeamRules(w.documents, A, PROJECT);
    expect(set.rules.length).toBeLessThanOrEqual(TEAM_RULES_RETIRED_KEPT + 1);
    await prove(w, provenLessonRecord(w.clock, "les_pit00001", { type: "pitfall" }));
    w.deps.publisher = { publish: async () => { throw new Error("no"); } };
    await ask(w, "les_pit00001", "ann", "rule");
    const documents = w.documents;
    const original = documents.put.bind(documents);
    documents.put = async (request) => { if (request.item["entityType"] === "LESSON_CHECK_DRAFT") throw new Error("down"); return original(request); };
    expect(await ask(w, "les_pit00001", "ann", "check")).toEqual({ ok: false, code: "check_unavailable" });
    documents.put = original;
    expect(await ask(w, "les_pit00001", "ann", "check")).toMatchObject({ ok: true, state: "done" });
  });

  it("finished drafts are swept so the list stays readable; too many open drafts refuse a new one", async () => {
    const w = world();
    for (let i = 0; i < 60; i += 1) {
      const id = draftIdFor(WS, PROJECT, `les_d${String(i).padStart(7, "0")}`);
      await putCheckDraft(w.documents, A, PROJECT, { id, lessonId: `les_d${String(i).padStart(7, "0")}`, title: "t", request: "r", paths: [], createdAt: i });
      await moveCheckDraft(w.documents, A, PROJECT, id, { status: "dismissed" });
    }
    expect((await listCheckDrafts(w.documents, A, PROJECT)).length).toBeLessThan(50);
    const open = world();
    let refused = 0;
    for (let i = 0; i < 60; i += 1) {
      try { await putCheckDraft(open.documents, A, PROJECT, { id: draftIdFor(WS, PROJECT, `les_o${String(i).padStart(7, "0")}`), lessonId: `les_o${String(i).padStart(7, "0")}`, title: "t", request: "r", paths: [], createdAt: i }); } catch (error) { expect(error).toBeInstanceOf(GraduationUnreadable); refused += 1; }
    }
    expect(refused).toBeGreaterThan(0);
    expect((await listCheckDrafts(open.documents, A, PROJECT)).length).toBeLessThan(50);
  });

  it("a graduated lesson whose sources are all deleted takes its rule and draft with it, and the words are blanked", async () => {
    const w = world();
    await prove(w, provenLessonRecord(w.clock, "les_conv0001"), provenLessonRecord(w.clock, "les_pit00001", { type: "pitfall" }));
    await ask(w, "les_conv0001", "ann", "rule");
    await ask(w, "les_pit00001", "ann", "check");
    const deletion = lessonDeletionPort({ store: w.store, vectors: w.vectors, audit: w.audit, now: w.clock.now, onGone: graduatedCleanup(w.documents, w.clock.now) });
    await deletion.forgetSources(WS, PROJECT, "les_conv0001", new Set(["ev-1"]));
    await deletion.forgetSources(WS, PROJECT, "les_pit00001", new Set(["ev-1"]));
    const set = await readTeamRules(w.documents, A, PROJECT);
    expect(set.rules).toEqual([expect.objectContaining({ retired: true, text: "Removed.", paths: [], repos: [] })]);
    const [draft] = await listCheckDrafts(w.documents, A, PROJECT);
    expect(draft).toMatchObject({ status: "dismissed", title: "Removed.", request: "Removed.", paths: [] });
    expect(JSON.stringify(await w.documents.query({ pk: companyScoped(A, `TEAMRULES#${PROJECT}`) }))).not.toContain("integer cents");
  });
});

// ---- the third conflict answer

describe("conflict: both are right, in different places", () => {
  async function conflict(w: World, over: { otherScope?: Lesson["scope"]; cardTier?: 1 | 2 } = {}) {
    const old = lessonRecord({ id: "les_old00001", type: "convention", tier: 1, tierReasons: [], title: "Use cents", description: "Money is cents.", body: "Store money as integer cents.", scope: over.otherScope ?? {}, approvals: [{ approvalId: "a1", by: "ann", at: 1, mode: "one" }], provenance: { ...draft().provenance, authors: ["cat"] } });
    const card = lessonRecord({ id: "les_card0001", type: "convention", tier: over.cardTier ?? 1, tierReasons: [], title: "Use decimals", description: "Money is decimal.", body: "Store money as decimals.", scope: {}, status: "pending", approvals: [], contradictsWith: "les_old00001", provenance: { ...draft().provenance, authors: ["cat"] } });
    await seed(w.store, old, card);
  }
  const settleApprove = (w: World) => approveLesson({ ...w.deps, access: allowAllAccess }, { ...KEY, lessonId: "les_card0001", approverId: "bob", expectedVersion: 2 });
  const settle = (w: World, over: Partial<Parameters<typeof settleBothPlaces>[1]> = {}) => settleBothPlaces({ ...w.deps, access: allowAllAccess }, { ...KEY, lessonId: "les_card0001", approverId: "ann", expectedVersion: 1, cardPaths: ["services/ledger/**"], otherPaths: ["services/payments/**"], ...over });

  it("gives each lesson its own place, clears the contradiction and keeps both; the card is then approved as usual", async () => {
    const w = world();
    await conflict(w);
    const done = await settle(w);
    expect(done).toMatchObject({ ok: true, otherId: "les_old00001", cardVersion: 2 });
    const card = (await w.store.get(KEY, "les_card0001"))!;
    const old = (await w.store.get(KEY, "les_old00001"))!;
    expect(card).toMatchObject({ status: "pending", version: 2, scope: { paths: ["services/ledger/**"] }, approvals: [] });
    expect(card.contradictsWith).toBeUndefined();
    expect(old).toMatchObject({ status: "active", scope: { paths: ["services/payments/**"] }, approvals: [expect.objectContaining({ by: "ann" })] });
    expect(w.audit.actions().filter((a) => a === "lesson.updated")).toHaveLength(2);
    expect(await approveLesson({ ...w.deps, access: allowAllAccess }, { ...KEY, lessonId: "les_card0001", approverId: "bob", expectedVersion: 2 })).toMatchObject({ ok: true, status: "active" });
    expect((await w.store.get(KEY, "les_old00001"))!.status).toBe("active");
  });

  it("a first approval given to the old place is dropped: the person approves the place they read", async () => {
    const w = world();
    await conflict(w, { cardTier: 2 });
    const card = (await w.store.get(KEY, "les_card0001"))!;
    await w.store.commit(KEY, await w.store.setVersion(KEY), [{ ...card, version: 2, approvals: [{ approvalId: "ap-x", by: "bob", at: 1, mode: "second_person" }] }], 1);
    expect(await settle(w, { expectedVersion: 2 })).toMatchObject({ ok: true });
    expect((await w.store.get(KEY, "les_card0001"))!.approvals).toEqual([]);
  });

  it("refuses: no places, the same place for both, a bad glob, a stale version, a card that is not a conflict, another lesson that is not live, a person who does not decide", async () => {
    const w = world();
    await conflict(w);
    expect(await settle(w, { cardPaths: [] })).toEqual({ ok: false, code: "bad_paths" });
    expect(await settle(w, { cardPaths: ["../x"] })).toEqual({ ok: false, code: "bad_paths" });
    expect(await settle(w, { cardPaths: ["a/**"], otherPaths: ["a/**"] })).toEqual({ ok: false, code: "same_place" });
    expect(await settle(w, { expectedVersion: 7 })).toEqual({ ok: false, code: "conflict" });
    expect(await settle(w, { approverId: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
    expect(await settle(w, { lessonId: "les_old00001" })).toEqual({ ok: false, code: "not_pending" });
    expect(await settle(w, { lessonId: "les_missing01" })).toEqual({ ok: false, code: "not_found" });
    expect((await w.store.get(KEY, "les_card0001"))!).toMatchObject({ version: 1, contradictsWith: "les_old00001" });
    expect((await w.store.get(KEY, "les_old00001"))!.scope).toEqual({});
    const gone = world();
    await conflict(gone);
    const old = (await gone.store.get(KEY, "les_old00001"))!;
    await gone.store.commit(KEY, await gone.store.setVersion(KEY), [{ ...old, version: 2, status: "retired" }], 1);
    expect(await settle(gone)).toEqual({ ok: false, code: "other_not_live" });
  });

  it("the older lesson may only get narrower: paths outside the ones it has are refused, paths inside are fine", async () => {
    const w = world();
    await conflict(w, { otherScope: { paths: ["services/**"] } });
    expect(await settle(w, { otherPaths: ["**"] })).toEqual({ ok: false, code: "wider_than_before" });
    expect(await settle(w, { otherPaths: ["apps/web/**"] })).toEqual({ ok: false, code: "wider_than_before" });
    expect(await settle(w, { otherPaths: ["servicesX/**"] })).toEqual({ ok: false, code: "wider_than_before" });
    expect((await w.store.get(KEY, "les_old00001"))!.scope).toEqual({ paths: ["services/**"] });
    expect(await settle(w)).toMatchObject({ ok: true });
  });

  it("a place that touches CI or tests makes the waiting card a tier-2 matter: one person cannot approve it alone", async () => {
    const w = world();
    await conflict(w);
    expect(await settle(w, { cardPaths: [".github/workflows/**"], otherPaths: ["services/**"] })).toMatchObject({ ok: true });
    expect(await settleApprove(w)).toMatchObject({ ok: true, status: "pending", needs: "second_person" });
    expect((await w.store.get(KEY, "les_card0001"))).toMatchObject({ tier: 2, status: "pending" });
  });

  it("no record, no change; a person who cannot read one of the two lessons cannot settle them", async () => {
    const w = world();
    await conflict(w);
    expect(await settleBothPlaces({ ...w.deps, access: allowAllAccess, audit: { emit: async () => { throw new Error("down"); } } }, { ...KEY, lessonId: "les_card0001", approverId: "ann", expectedVersion: 1, cardPaths: ["a/**"], otherPaths: ["b/**"] })).toEqual({ ok: false, code: "audit_unavailable" });
    expect((await w.store.get(KEY, "les_card0001"))!.version).toBe(1);
    const hidden = lessonRecord({ id: "les_hid00001", type: "convention", tier: 1, tierReasons: [], status: "pending", approvals: [], contradictsWith: "les_priv0001", provenance: { ...draft().provenance, audience: { kind: "project" } } });
    const priv = lessonRecord({ id: "les_priv0001", type: "convention", tier: 1, tierReasons: [], provenance: { ...draft().provenance, audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T/C", principals: ["someone-else"], capturedAt: "x", liveCheck: "none" } } } });
    await seed(w.store, hidden, priv);
    const deny = { ...allowAllAccess, mayRead: async (_o: unknown, _v: unknown, places: readonly unknown[]) => places.map(() => false) };
    expect(await settleBothPlaces({ ...w.deps, access: deny }, { ...KEY, lessonId: "les_hid00001", approverId: "ann", expectedVersion: 1, cardPaths: ["a/**"], otherPaths: ["b/**"] })).toEqual({ ok: false, code: "not_permitted" });
  });
});

// ---- the Tidy card

describe("the Tidy card: the ten least used, retire?", () => {
  const tidyDeps = (w: World): TidyDeps => ({ ...w.deps, access: allowAllAccess, documents: w.documents });
  async function many(w: World, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = `les_t${String(i).padStart(7, "0")}`;
      ids.push(id);
      await seed(w.store, provenLessonRecord(w.clock, id, { createdAt: w.clock.now() - (40 + i) * DAY_MS, title: `Lesson ${String(i)}` }));
      await w.uses(id, i);
    }
    return ids;
  }

  it("names the ten least used (old enough, counted), once a project holds more than twenty, the same ten to everyone; nothing retires by itself", async () => {
    const w = world();
    const ids = await many(w, TIDY_MIN_ACTIVE + 6);
    const card = await tidyCard(tidyDeps(w), KEY, IDENTITY("ann"));
    expect(card!.lessons.map((l) => l.lessonId)).toEqual(ids.slice(0, TIDY_MAX));
    expect(card!.lessons.map((l) => l.tasks)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect((await tidyCard(tidyDeps(w), KEY, IDENTITY("bob")))!.lessons).toHaveLength(TIDY_MAX);
    expect((await w.store.list(KEY, { statuses: ["active"] })).length).toBe(TIDY_MIN_ACTIVE + 6);
    // A new lesson (under 30 days) and a trial lesson are not "unused"; and later uses do not change the ten the period named.
    await w.uses(ids[0]!, 50);
    expect((await tidyCard(tidyDeps(w), KEY, IDENTITY("ann")))!.lessons.map((l) => l.lessonId)).toEqual(ids.slice(0, TIDY_MAX));
  });

  it("is not shown to a project of twenty or fewer, to someone who does not decide, or when learning is off", async () => {
    const w = world();
    await many(w, TIDY_MIN_ACTIVE);
    expect(await tidyCard(tidyDeps(w), KEY, IDENTITY("ann"))).toBeUndefined();
    const big = world();
    await many(big, TIDY_MIN_ACTIVE + 3);
    expect(await tidyCard(tidyDeps(big), KEY, IDENTITY("mallory"))).toBeUndefined();
    expect(await tidyCard({ ...tidyDeps(big), settings: settings({ mode: "Off" }) }, KEY, IDENTITY("ann"))).toBeUndefined();
  });

  it("a person retires the ones they choose, only from the card; the card is then closed and comes back after thirty days", async () => {
    const w = world();
    const ids = await many(w, TIDY_MIN_ACTIVE + 5);
    await tidyCard(tidyDeps(w), KEY, IDENTITY("ann"));
    expect(await retireTidy(tidyDeps(w), { ...KEY, actorId: "ann", ids: [ids[20]!] })).toEqual({ ok: false, code: "not_on_card" });
    expect(await retireTidy(tidyDeps(w), { ...KEY, actorId: "mallory", ids: [ids[0]!] })).toEqual({ ok: false, code: "not_eligible" });
    expect(await retireTidy(tidyDeps(w), { ...KEY, actorId: "ann", ids: [] })).toEqual({ ok: false, code: "not_on_card" });
    expect(await retireTidy(tidyDeps(w), { ...KEY, actorId: "ann", ids: [ids[0]!, ids[1]!] })).toEqual({ ok: true, retired: [ids[0], ids[1]], skipped: 0 });
    expect((await w.store.get(KEY, ids[0]!))!.status).toBe("retired");
    expect((await w.store.get(KEY, ids[2]!))!.status).toBe("active");
    expect(w.audit.events.filter((e) => e.action === "lesson.retired").map((e) => e.lessonId)).toEqual([ids[0], ids[1]]);
    expect(await tidyCard(tidyDeps(w), KEY, IDENTITY("ann"))).toBeUndefined();
    expect(await retireTidy(tidyDeps(w), { ...KEY, actorId: "ann", ids: [ids[2]!] })).toEqual({ ok: false, code: "no_card" });
    w.clock.advance(31 * DAY_MS);
    expect((await tidyCard(tidyDeps(w), KEY, IDENTITY("ann")))!.lessons.length).toBeGreaterThan(0);
  });

  it("a lesson younger than thirty days is never on the card", async () => {
    const w = world();
    const ids = await many(w, TIDY_MIN_ACTIVE + 6);
    const young = "les_young0001";
    await seed(w.store, provenLessonRecord(w.clock, young, { createdAt: w.clock.now() - 5 * DAY_MS }));
    const card = await tidyCard(tidyDeps(w), KEY, IDENTITY("ann"));
    expect(card!.lessons.map((l) => l.lessonId)).not.toContain(young);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("Not now closes the card for the period", async () => {
    const w = world();
    await many(w, TIDY_MIN_ACTIVE + 5);
    await tidyCard(tidyDeps(w), KEY, IDENTITY("ann"));
    expect(await tidyLater(tidyDeps(w), { ...KEY, actorId: "ann" })).toEqual({ ok: true });
    expect(await tidyCard(tidyDeps(w), KEY, IDENTITY("ann"))).toBeUndefined();
    expect(await tidyLater(tidyDeps(w), { ...KEY, actorId: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
  });

  it("two companies: B's card never names A's lessons", async () => {
    const a = world();
    await many(a, TIDY_MIN_ACTIVE + 5);
    await tidyCard(tidyDeps(a), KEY, IDENTITY("ann"));
    const b = world({ companyId: B });
    expect(await tidyCard(tidyDeps(b), { workspaceId: B, project: PROJECT }, IDENTITY("ann"))).toBeUndefined();
  });
});
