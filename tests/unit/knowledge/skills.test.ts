// L4-AK3: Rovara skills. A proven procedure lesson graduates to a skill (a draft made by code, no model), two different people approve a version before it is used, every edit is a new version, the text has a size
// rule (32 KB, a gentle note above 8 KB), the lessons it came from are not loaded again, and the live skills go to a plan or build step through the skills path, company and project scoped.
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { LEARNED_CONTEXT_FEATURE, ROVARA_SKILL_LONG_NOTE, ROVARA_SKILL_LONG_NOTE_BYTES, ROVARA_SKILL_TEXT_MAX_BYTES, ROVARA_SKILLS_PAYLOAD_BYTES_MAX, ROVARA_SKILLS_PER_STEP_MAX, ROVARA_SKILLS_FEATURE, companyScoped } from "@agentx/contracts";
import { createAdapterRegistry } from "../../../packages/broker/src/ports/adapter-registry.js";
import { createLocalOwnerApprovers, createLocalOwnerIdentity, createPriceTableMetering, localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";
import { createMemoryModelKeyStore } from "../../../packages/broker/src/ports/model-key-stores.js";
import { builtinModelProviderBook } from "../../../packages/broker/src/local/model-proxy/index.js";
import { createLocalLessons, type LocalLessons } from "../../../packages/broker/src/local/app/lessons.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { writeLearningMode } from "../../../packages/broker/src/lessons/document-settings.js";
import { buildLessonsView } from "../../../packages/broker/src/lessons/view.js";
import { documentEvidenceSink } from "../../../packages/broker/src/lessons/evidence.js";
import { freshSignalsReader } from "../../../packages/broker/src/lessons/signals.js";
import { lessonUsePk } from "../../../packages/broker/src/lessons/use-count.js";
import type { ApproverDirectory } from "../../../packages/broker/src/lessons/ports.js";
import {
  approveSkill, checkSkillText, draftSkillFromLesson, editSkill, listSkills, liveSkillsForStep, provenProcedure, renderSkill, retireSkill, skillOffers, slugOf, stepsOfBody, type SkillDeps,
} from "../../../packages/broker/src/lessons/skills.js";
import type { TaskVisibilityPort } from "../../../packages/broker/src/lessons/access-port.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { COMPANY, createHarness, definition, type Harness } from "../../support/task-flow-harness.js";
import { draft, lessonRecord, wideAudience } from "../lessons/lesson-helpers.js";
import { withLessonAudiences } from "../../../packages/broker/src/lessons/task-audience.js";

afterEach(() => setLearnedLessonsGate(undefined));

const REPO_PAY = "https://github.com/example/demo.git";
const OTHER_COMPANY = "org_zzzzzzzzzzzzzzzzzzzz";
const KEY = { workspaceId: COMPANY, project: "payments" };
const DAY = 86_400_000;
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface World { h: Harness; lessons: LocalLessons; deps: SkillDeps; workspaceId: string; taskId: string; eligible: { ids: string[]; complete: boolean }; setEnabled(value: boolean): void }

async function world(): Promise<World> {
  let enabled = true;
  const h = createHarness({ audit: "recording" });
  await h.registerProject({ ...definition, repositories: [{ ...definition.repositories[0]!, url: REPO_PAY }] });
  const owner = localOwnerPrincipal({ companyId: COMPANY });
  const registry = createAdapterRegistry();
  registry.register("storage", "memory", h.store, { isDefault: true });
  registry.register("queue", "memory", h.queues, { isDefault: true });
  registry.register("code-host", "github", { kind: "github", repositoryIdentity: async () => ({ id: "77", fullName: "example/demo", private: true }) } as never, { isDefault: true });
  const lessons = createLocalLessons({
    flow: h.deps, registry, companyId: COMPANY, owner, blobs: { get: async () => undefined } as never, milestones: { register: () => () => undefined },
    audit: h.deps.audit, admission: h.deps.admission, metering: createPriceTableMetering({ currency: "USD", models: {} }),
    approvers: createLocalOwnerApprovers({ owner, verifySession: () => false }), identity: createLocalOwnerIdentity({ companyId: COMPANY, linkedAccounts: [{ provider: "github", tenant: "", accountId: "owner-gh" }] }),
    model: { choice: async () => ({ provider: "anthropic", model: "claude-test" }), keys: createMemoryModelKeyStore({ anthropic: ["sk", "ant", "test", "never", "real"].join("-") }), providers: builtinModelProviderBook(), fetch: (async () => new Response("{}", { status: 500 })) },
    enabled: () => enabled, now: () => h.clock.now, log: () => undefined,
  });
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint\nreturn 200", workflow: true, workflowPath: "QUICK" });
  const eligible = { ids: ["ann", "bob", "cy"], complete: true };
  const directory = { eligibility: async () => ({ complete: eligible.complete, membershipVersion: 1, ownerIds: ["ann"], eligibleIds: [...eligible.ids], lastEligibleLossAtMs: null }), identity: async () => ({ principals: [], groups: [] }) } as unknown as ApproverDirectory;
  const deps: SkillDeps = { documents: h.store, lessons: lessons.runtime.store, directory, audit: lessons.runtime.audit, access: lessons.runtime.access, now: () => h.clock.now, vectors: lessons.runtime.vectors };
  return { h, lessons, deps, workspaceId: task.workspaceId, taskId: task.taskId, eligible, setEnabled: (value) => { enabled = value; } };
}

const BODY = "When adding a new queue: 1. Create the queue and its dead-letter queue. 2. Register the handler in the worker. 3. Add an alarm on the dead-letter depth.";
const procedure = (w: World, over: Partial<Lesson> = {}): Lesson => lessonRecord({
  id: "les_proc0001", workspaceId: COMPANY, project: "payments", type: "procedure", tier: 1, tierReasons: [], citations: [], citationChecks: [], stages: ["PLAN", "IMPLEMENT"], scope: {},
  title: "Add a queue handler", description: "A new queue needs a dead-letter queue.", body: BODY, approvals: [{ approvalId: "a1", by: "ann", at: 1, mode: "one" }],
  provenance: { ...draft().provenance, authors: ["ann", "bob"], supportTasks: [], measured: false, audience: { kind: "project" } },
  createdAt: w.h.clock.now - 40 * DAY, updatedAt: w.h.clock.now - 40 * DAY, expiresAt: w.h.clock.now + 90 * DAY, ...over,
});
async function put(w: World, ...list: Lesson[]): Promise<void> {
  for (const lesson of list) {
    const key = { workspaceId: lesson.workspaceId, project: lesson.project };
    await w.lessons.runtime.store.commit(key, await w.lessons.runtime.store.setVersion(key), [lesson], 1);
  }
}
async function used(w: World, lessonId: string, tasks: number, company = COMPANY): Promise<void> {
  for (let n = 0; n < tasks; n += 1) await w.h.store.put({ item: { pk: lessonUsePk(company, "payments", lessonId), sk: `task-${String(n)}`, entityType: "LESSON_USE", taskId: `task-${String(n)}`, at: w.h.clock.now } });
}
async function proven(w: World): Promise<Lesson> { const lesson = procedure(w); await put(w, lesson); await used(w, lesson.id, 10); return lesson; }
async function goLive(w: World, name: string, version: number): Promise<void> {
  expect(await approveSkill(w.deps, KEY, { name, version, by: "ann" })).toMatchObject({ ok: true, live: false });
  expect(await approveSkill(w.deps, KEY, { name, version, by: "bob" })).toMatchObject({ ok: true, live: true });
}

describe("what a proven procedure lesson is", () => {
  const w0 = { h: { clock: { now: 1_800_000_000_000 } } } as unknown as World;
  const now = 1_800_000_000_000;
  const base = (over: Partial<Lesson> = {}): Lesson => procedure(w0, { createdAt: now - 40 * DAY, ...over });
  it("is a live, person-approved procedure used in 10 tasks over 30 days, never marked wrong, project-wide, with two people behind it", () => {
    expect(provenProcedure({ lesson: base(), tasks: 10, now })).toBe(true);
  });
  it.each([
    ["too few tasks", { tasks: 9 }, {}],
    ["uncounted", { tasks: undefined }, {}],
    ["too young", { tasks: 10 }, { createdAt: now - 29 * DAY }],
    ["not a procedure", { tasks: 10 }, { type: "convention" as const }],
    ["not live", { tasks: 10 }, { status: "pending" as const }],
    ["on trial", { tasks: 10 }, { trial: { state: "stable" as const, startedAt: 1, stableAt: 2 } }],
    ["nobody approved it", { tasks: 10 }, { approvals: [] }],
    ["marked wrong", { tasks: 10 }, { counters: { loaded: 12, helpful: 5, harmful: 1, citationStale: 0 } }],
    ["a stale anchor", { tasks: 10 }, { counters: { loaded: 12, helpful: 5, harmful: 0, citationStale: 1 } }],
    ["a retire is asked for", { tasks: 10 }, { retireProposedAt: 5 }],
    ["a possible duplicate", { tasks: 10 }, { possibleDuplicateOf: "les_other001" }],
    ["sent back to a person", { tasks: 10 }, { reviewRequired: true as const }],
    ["one person only", { tasks: 10 }, { provenance: { ...draft().provenance, authors: ["ann"], supportTasks: [], audience: { kind: "project" as const } } }],
    ["a restricted audience", { tasks: 10 }, { provenance: { ...draft().provenance, authors: ["ann", "bob"], supportTasks: [], audience: { kind: "restricted" as const, acl: { source: "slack" as const, scope: "C1", capturedAt: "2026-11-01T00:00:00.000Z", liveCheck: "on_read" as const } } } }],
  ])("is not proven: %s", (_name, input, over) => {
    expect(provenProcedure({ lesson: base(over as Partial<Lesson>), tasks: input.tasks, now })).toBe(false);
  });
  it("one person and a measured result is enough", () => {
    expect(provenProcedure({ lesson: base({ provenance: { ...draft().provenance, authors: ["ann"], supportTasks: [], measured: true, audience: { kind: "project" } } }), tasks: 10, now })).toBe(true);
  });
});

describe("the draft is made by code from the lesson's own words", () => {
  it("splits the numbered steps, keeps the lesson's words, grants nothing, and is not live", async () => {
    const w = await world();
    const lesson = await proven(w);
    const made = await draftSkillFromLesson(w.deps, KEY, { lessonId: lesson.id, by: "ann" });
    expect(made).toEqual({ ok: true, name: "add-a-queue-handler", version: 1 });
    const [summary] = await listSkills(w.deps, KEY);
    expect(summary).toMatchObject({ name: "add-a-queue-handler", currentVersion: 1, approvals: 0, retired: false });
    expect(summary!.activeVersion).toBeUndefined();
    const row = await w.h.store.get({ pk: companyScoped(COMPANY, "SKILL#payments"), sk: "v#add-a-queue-handler#000001" });
    const content = row!["content"] as string;
    expect(content).toContain("name: add-a-queue-handler");
    expect(content).toContain("1. Create the queue and its dead-letter queue.");
    expect(content).toContain("2. Register the handler in the worker.");
    expect(content).toContain("3. Add an alarm on the dead-letter depth.");
    expect(content).toContain("## When to use\nadding a new queue");
    expect(content).not.toMatch(/allowed-tools|!`/u);
    expect(row!["digest"]).toBe(sha(content));
    // Draft, not live: no step is sent it, and the lesson is still loaded.
    expect(await liveSkillsForStep(w.h.store, KEY)).toEqual({ skills: [], left: 0 });
    expect((await w.lessons.runtime.store.get(KEY, lesson.id))!.status).toBe("active");
    // Audited before it was written, with the name and the version only.
    const event = w.h.audit.find((entry) => entry.action === "lesson.skill_drafted");
    expect(event).toMatchObject({ actor: { id: "ann" }, details: { skill: "add-a-queue-handler", version: 1 } });
    expect(JSON.stringify(event)).not.toContain("dead-letter");
  });

  it("a lesson with no numbered steps becomes one step; nothing is invented", () => {
    expect(stepsOfBody("When changing prices: always round half up.")).toEqual({ when: "changing prices", steps: ["always round half up."] });
    expect(stepsOfBody("1. one\n2) two\n3. three")).toEqual({ when: "", steps: ["one", "two", "three"] });
    expect(stepsOfBody("When adding a queue: 1. Create it. 2. Wire it, then 5. test it. 3. Alarm on depth.")).toEqual({ when: "adding a queue", steps: ["Create it.", "Wire it, then 5. test it.", "Alarm on depth."] });
    expect(stepsOfBody("Use 2. as the base then 3. go")).toEqual({ when: "", steps: ["Use 2. as the base then 3. go"] });
    expect(slugOf("  Add a Queue -- Handler!! ")).toBe("add-a-queue-handler");
    expect(slugOf("!!!")).toBe("skill");
  });

  it("is refused for a lesson that is not proven, one that was already made a skill, an unknown lesson, and a person who may not decide", async () => {
    const w = await world();
    const lesson = procedure(w);
    await put(w, lesson);
    await used(w, lesson.id, 9);
    expect(await draftSkillFromLesson(w.deps, KEY, { lessonId: lesson.id, by: "ann" })).toEqual({ ok: false, code: "not_proven" });
    await used(w, lesson.id, 10);
    expect(await draftSkillFromLesson(w.deps, KEY, { lessonId: lesson.id, by: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
    expect(await draftSkillFromLesson(w.deps, KEY, { lessonId: "les_nope0001", by: "ann" })).toEqual({ ok: false, code: "not_found" });
    expect(await draftSkillFromLesson(w.deps, KEY, { lessonId: lesson.id, by: "ann", name: "Not A Slug" })).toEqual({ ok: false, code: "bad_name" });
    w.eligible.complete = false;
    expect(await draftSkillFromLesson(w.deps, KEY, { lessonId: lesson.id, by: "ann" })).toEqual({ ok: false, code: "eligibility_unavailable" });
    w.eligible.complete = true;
    expect(await draftSkillFromLesson(w.deps, KEY, { lessonId: lesson.id, by: "ann" })).toMatchObject({ ok: true });
    expect(await draftSkillFromLesson(w.deps, KEY, { lessonId: lesson.id, by: "bob" })).toEqual({ ok: false, code: "already_a_skill" });
    expect(await listSkills(w.deps, KEY)).toHaveLength(1);
  });

  it("a procedure learned from a task a person on the project may not open is not made a project's skill", async () => {
    const w = await world();
    const lesson = procedure(w, { provenance: { ...draft().provenance, authors: ["ann", "bob"], supportTasks: ["task-hidden"], measured: false, audience: { kind: "project" } } });
    await put(w, lesson);
    await used(w, lesson.id, 10);
    const hidden = withLessonAudiences({ read: async (_org, ids) => new Map(ids.map((id) => [id, { kind: "shared" as const }])) } satisfies TaskVisibilityPort, { read: async (_org, ids) => new Map(ids.map((id) => [id, wideAudience({ project: "payments", denied: new Set(["bob"]) })])) });
    const deps: SkillDeps = { ...w.deps, access: { mayRead: async (_org, _viewer, places) => places.map(() => true), taskVisibility: hidden } };
    expect(await draftSkillFromLesson(deps, KEY, { lessonId: lesson.id, by: "ann" })).toEqual({ ok: false, code: "not_project_wide" });
    expect(await listSkills(w.deps, KEY)).toHaveLength(0);
  });

  it('the "Make this a skill?" card never names a lesson the whole project may not read: its title is not shown, as the draft is refused (L4-INT)', async () => {
    const w = await world();
    const lesson = procedure(w, { provenance: { ...draft().provenance, authors: ["ann", "bob"], supportTasks: ["task-hidden"], measured: false, audience: { kind: "project" } } });
    await put(w, lesson);
    await used(w, lesson.id, 10);
    const through = (denied: Set<string>): SkillDeps => {
      const hidden = withLessonAudiences({ read: async (_org, ids) => new Map(ids.map((id) => [id, { kind: "shared" as const }])) } satisfies TaskVisibilityPort, { read: async (_org, ids) => new Map(ids.map((id) => [id, wideAudience({ project: "payments", denied })])) });
      return { ...w.deps, access: { mayRead: async (_org, _viewer, places) => places.map(() => true), taskVisibility: hidden } };
    };
    expect((await skillOffers(through(new Set()), KEY)).map((offer) => offer.lessonId)).toEqual([lesson.id]);
    expect(await skillOffers(through(new Set(["bob"])), KEY)).toEqual([]);
  });

  it("a name that is taken by another skill gets a short suffix from the lesson's id; a chosen name that is taken is refused", async () => {
    const w = await world();
    const first = await proven(w);
    expect(await draftSkillFromLesson(w.deps, KEY, { lessonId: first.id, by: "ann" })).toMatchObject({ ok: true, name: "add-a-queue-handler" });
    const second = procedure(w, { id: "les_proc0002", body: "When adding a topic: 1. Create it. 2. Subscribe." });
    await put(w, second);
    await used(w, second.id, 10);
    const made = await draftSkillFromLesson(w.deps, KEY, { lessonId: second.id, by: "ann" });
    expect(made).toMatchObject({ ok: true, name: "add-a-queue-handler-lesp" });
    const third = procedure(w, { id: "les_proc0003" });
    await put(w, third);
    await used(w, third.id, 10);
    expect(await draftSkillFromLesson(w.deps, KEY, { lessonId: third.id, by: "ann", name: "add-a-queue-handler" })).toEqual({ ok: false, code: "bad_name" });
  });
});

describe("two different people approve a version before it is used", () => {
  it("one approval is not live; the same person twice is still one; the second person takes it live; the lessons it came from are retired", async () => {
    const w = await world();
    const lesson = await proven(w);
    await draftSkillFromLesson(w.deps, KEY, { lessonId: lesson.id, by: "ann" });
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "ann" })).toEqual({ ok: true, approvals: 1, live: false });
    expect(await liveSkillsForStep(w.h.store, KEY)).toEqual({ skills: [], left: 0 });
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "ann" })).toEqual({ ok: false, code: "already_approved" });
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "ANN" })).toEqual({ ok: false, code: "already_approved" });
    expect(await liveSkillsForStep(w.h.store, KEY)).toEqual({ skills: [], left: 0 });
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "bob" })).toEqual({ ok: true, approvals: 2, live: true });
    const live = await liveSkillsForStep(w.h.store, KEY);
    expect(live.left).toBe(0);
    expect(live.skills).toHaveLength(1);
    expect(live.skills[0]).toMatchObject({ name: "add-a-queue-handler", version: 1, description: expect.stringContaining("Add a queue handler") as string });
    expect(live.skills[0]!.digest).toBe(sha(live.skills[0]!.content));
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "cy" })).toEqual({ ok: false, code: "already_live" });
    // "A graduated lesson is not loaded again": the lesson became the skill.
    expect((await w.lessons.runtime.store.get(KEY, lesson.id))!.status).toBe("retired");
    expect(w.h.audit.filter((e) => e.action === "lesson.skill_approved")).toHaveLength(2);
    expect(w.h.audit.filter((e) => e.action === "lesson.skill_activated")).toHaveLength(1);
  });

  it("a person who may not decide cannot approve, and a roster that cannot be read refuses", async () => {
    const w = await world();
    await draftSkillFromLesson(w.deps, KEY, { lessonId: (await proven(w)).id, by: "ann" });
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
    w.eligible.complete = false;
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "bob" })).toEqual({ ok: false, code: "eligibility_unavailable" });
    expect((await listSkills(w.deps, KEY))[0]!.approvals).toBe(0);
  });

  it("an approval is for one version: after an edit the old version cannot be approved, and the live version stays live until the new one has two", async () => {
    const w = await world();
    await draftSkillFromLesson(w.deps, KEY, { lessonId: (await proven(w)).id, by: "ann" });
    await goLive(w, "add-a-queue-handler", 1);
    const sentToATask = (await liveSkillsForStep(w.h.store, KEY)).skills[0]!;
    expect(await editSkill(w.deps, KEY, { name: "add-a-queue-handler", by: "bob", expectedVersion: 1, form: { description: "Add a queue handler", when: "adding a queue", steps: ["Create the queue", "Register the handler"] } })).toEqual({ ok: true, version: 2 });
    // The live version is still version 1 (a running task keeps the version it was sent: same text, same digest).
    const during = (await liveSkillsForStep(w.h.store, KEY)).skills[0]!;
    expect(during).toEqual(sentToATask);
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "cy" })).toEqual({ ok: false, code: "not_newest" });
    // An edit of an older version is a conflict, never a silent overwrite.
    expect(await editSkill(w.deps, KEY, { name: "add-a-queue-handler", by: "bob", expectedVersion: 1, form: { description: "x y z", when: "now", steps: ["one"] } })).toEqual({ ok: false, code: "conflict" });
    // The first approval of version 2 does not replace version 1; the second does.
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 2, by: "ann" })).toEqual({ ok: true, approvals: 1, live: false });
    expect((await liveSkillsForStep(w.h.store, KEY)).skills[0]!.version).toBe(1);
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 2, by: "bob" })).toEqual({ ok: true, approvals: 2, live: true });
    const after = (await liveSkillsForStep(w.h.store, KEY)).skills[0]!;
    expect(after.version).toBe(2);
    expect(after.digest).not.toBe(sentToATask.digest);
    expect(after.content).toContain("2. Register the handler");
    // Both versions are still there (append-only).
    expect(await w.h.store.get({ pk: companyScoped(COMPANY as never, "SKILL#payments"), sk: "v#add-a-queue-handler#000001" })).toBeDefined();
  });

  it("no record, no change: when the audit cannot be written, nothing is drafted, approved or edited", async () => {
    const w = await world();
    const lesson = await proven(w);
    const real = w.h.deps.audit.record.bind(w.h.deps.audit);
    const down = (action: string): void => { w.h.deps.audit.record = async (event) => { if (event.action === action) throw new Error("ledger down"); return real(event); }; };
    down("lesson.skill_drafted");
    expect(await draftSkillFromLesson(w.deps, KEY, { lessonId: lesson.id, by: "ann" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect(await listSkills(w.deps, KEY)).toHaveLength(0);
    w.h.deps.audit.record = real;
    await draftSkillFromLesson(w.deps, KEY, { lessonId: lesson.id, by: "ann" });
    down("lesson.skill_approved");
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "ann" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect((await listSkills(w.deps, KEY))[0]!.approvals).toBe(0);
    w.h.deps.audit.record = real;
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "ann" })).toMatchObject({ ok: true });
    down("lesson.skill_activated");
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "bob" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect((await listSkills(w.deps, KEY))[0]!.approvals).toBe(1);
    expect(await liveSkillsForStep(w.h.store, KEY)).toEqual({ skills: [], left: 0 });
    w.h.deps.audit.record = real;
    down("lesson.skill_edited");
    expect(await editSkill(w.deps, KEY, { name: "add-a-queue-handler", by: "ann", expectedVersion: 1, form: { description: "Add a queue handler", when: "adding", steps: ["one"] } })).toEqual({ ok: false, code: "audit_unavailable" });
  });

  it("an approval counts only while its giver is still eligible: one who left is not one of the two", async () => {
    const w = await world();
    await draftSkillFromLesson(w.deps, KEY, { lessonId: (await proven(w)).id, by: "ann" });
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "ann" })).toMatchObject({ ok: true, approvals: 1 });
    w.eligible.ids = ["bob", "cy"];
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "bob" })).toEqual({ ok: true, approvals: 1, live: false });
    expect(await liveSkillsForStep(w.h.store, KEY)).toEqual({ skills: [], left: 0 });
    expect((await listSkills(w.deps, KEY))[0]!.approvers).toEqual(["bob"]);
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "cy" })).toEqual({ ok: true, approvals: 2, live: true });
  });

  it("retire wins a race with the second approval: a retired skill is never left in the live set, and the head is checked when a step is sent", async () => {
    const w = await world();
    await draftSkillFromLesson(w.deps, KEY, { lessonId: (await proven(w)).id, by: "ann" });
    await goLive(w, "add-a-queue-handler", 1);
    const pk = companyScoped(COMPANY, "SKILL#payments");
    // A retire that read the skill before it went live: the head it saw has no live version. The member is removed anyway.
    const realGet = w.h.store.get.bind(w.h.store);
    w.h.store.get = async (key) => { const row = await realGet(key); return row !== undefined && key.sk === "head#add-a-queue-handler" ? Object.fromEntries(Object.entries(row).filter(([k]) => k !== "activeVersion")) as typeof row : row; };
    expect(await retireSkill(w.deps, KEY, { name: "add-a-queue-handler", by: "cy" })).toEqual({ ok: true });
    w.h.store.get = realGet;
    expect(((await w.h.store.get({ pk, sk: "set" }))!["members"] as Record<string, number>)["add-a-queue-handler"]).toBeUndefined();
    expect(await liveSkillsForStep(w.h.store, KEY)).toEqual({ skills: [], left: 0 });
    // A set row left behind: a retired head or a head that does not say this version is live keeps the skill out.
    await w.h.store.put({ item: { pk, sk: "set", entityType: "SKILL_SET", members: { "add-a-queue-handler": 1 }, updatedAt: 1 } });
    expect((await liveSkillsForStep(w.h.store, KEY)).skills).toEqual([]);
    expect((await liveSkillsForStep(w.h.store, KEY)).left).toBe(1);
  });

  it("a retired skill leaves the live set at once, and cannot be edited or approved; its versions stay", async () => {
    const w = await world();
    await draftSkillFromLesson(w.deps, KEY, { lessonId: (await proven(w)).id, by: "ann" });
    await goLive(w, "add-a-queue-handler", 1);
    expect(await retireSkill(w.deps, KEY, { name: "add-a-queue-handler", by: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
    expect(await retireSkill(w.deps, KEY, { name: "add-a-queue-handler", by: "cy" })).toEqual({ ok: true });
    expect(await liveSkillsForStep(w.h.store, KEY)).toEqual({ skills: [], left: 0 });
    expect(await editSkill(w.deps, KEY, { name: "add-a-queue-handler", by: "ann", expectedVersion: 1, form: { description: "x y z", when: "now", steps: ["one"] } })).toEqual({ ok: false, code: "retired" });
    expect(await approveSkill(w.deps, KEY, { name: "add-a-queue-handler", version: 1, by: "cy" })).toEqual({ ok: false, code: "retired" });
    expect((await listSkills(w.deps, KEY))[0]).toMatchObject({ retired: true });
    expect(await w.h.store.get({ pk: companyScoped(COMPANY as never, "SKILL#payments"), sk: "v#add-a-queue-handler#000001" })).toBeDefined();
    expect(await retireSkill(w.deps, KEY, { name: "no-such", by: "ann" })).toEqual({ ok: false, code: "not_found" });
  });
});

describe("size: at most 32 KB, a gentle note above 8 KB", () => {
  const form = (steps: string[]) => ({ description: "A long procedure", when: "doing the long thing", steps });
  it("refuses a text over the limit, notes one over 8 KB, and says nothing to a short one", async () => {
    const w = await world();
    await draftSkillFromLesson(w.deps, KEY, { lessonId: (await proven(w)).id, by: "ann" });
    const step = (n: number): string => `${"word ".repeat(790)}${String(n)}`;
    // 12 steps of about 4 KB are 48 KB: refused.
    const big = await editSkill(w.deps, KEY, { name: "add-a-queue-handler", by: "ann", expectedVersion: 1, form: form(Array.from({ length: 12 }, (_, n) => step(n))) });
    expect(big).toEqual({ ok: false, code: "too_large" });
    // Three steps of about 3.9 KB are about 12 KB: kept, with the note.
    const medium = await editSkill(w.deps, KEY, { name: "add-a-queue-handler", by: "ann", expectedVersion: 1, form: form([step(1), step(2), step(3)]) });
    expect(medium).toEqual({ ok: true, version: 2, note: ROVARA_SKILL_LONG_NOTE });
    const row = await w.h.store.get({ pk: companyScoped(COMPANY, "SKILL#payments"), sk: "v#add-a-queue-handler#000002" });
    expect(Number(row!["bytes"])).toBeGreaterThan(ROVARA_SKILL_LONG_NOTE_BYTES);
    expect(Number(row!["bytes"])).toBeLessThanOrEqual(ROVARA_SKILL_TEXT_MAX_BYTES);
    expect((await listSkills(w.deps, KEY))[0]!.note).toBe(ROVARA_SKILL_LONG_NOTE);
    const short = await editSkill(w.deps, KEY, { name: "add-a-queue-handler", by: "ann", expectedVersion: 2, form: form(["Do one thing", "Do another"]) });
    expect(short).toEqual({ ok: true, version: 3 });
    expect((await listSkills(w.deps, KEY))[0]!.note).toBeUndefined();
    expect(ROVARA_SKILL_LONG_NOTE).toBe("This skill is long. Consider splitting it into smaller skills.");
  });
  it("the byte rule is exact at the edges", () => {
    expect(checkSkillText("a".repeat(ROVARA_SKILL_TEXT_MAX_BYTES))).toMatchObject({ ok: true, note: ROVARA_SKILL_LONG_NOTE });
    expect(checkSkillText("a".repeat(ROVARA_SKILL_TEXT_MAX_BYTES + 1))).toEqual({ ok: false, code: "too_large" });
    expect(checkSkillText("a".repeat(ROVARA_SKILL_LONG_NOTE_BYTES))).toEqual({ ok: true, bytes: ROVARA_SKILL_LONG_NOTE_BYTES });
    expect(checkSkillText("a".repeat(ROVARA_SKILL_LONG_NOTE_BYTES + 1))).toMatchObject({ ok: true, note: ROVARA_SKILL_LONG_NOTE });
    // Bytes, not characters: a multi-byte text is counted as stored.
    expect(checkSkillText("é".repeat(ROVARA_SKILL_TEXT_MAX_BYTES / 2 + 1))).toEqual({ ok: false, code: "too_large" });
    expect(checkSkillText("   ")).toEqual({ ok: false, code: "empty" });
  });
  it("refuses more than 12 steps, no steps, a pre-run line and a tool grant", async () => {
    const w = await world();
    await draftSkillFromLesson(w.deps, KEY, { lessonId: (await proven(w)).id, by: "ann" });
    const edit = (steps: string[], over: Record<string, string> = {}) => editSkill(w.deps, KEY, { name: "add-a-queue-handler", by: "ann", expectedVersion: 1, form: { description: "Add a queue handler", when: "adding a queue", steps, ...over } });
    expect(await edit(Array.from({ length: 13 }, (_, n) => `step ${String(n)}`))).toEqual({ ok: false, code: "too_many_steps" });
    expect(await edit([])).toEqual({ ok: false, code: "empty" });
    expect(await edit(["Run !`rm -rf /` first"])).toEqual({ ok: false, code: "execution_line" });
    expect(await edit(["fine"], { when: "allowed-tools: Bash" })).toEqual({ ok: false, code: "execution_line" });
    expect(await edit(["fine"], { why: "ALLOWED-TOOLS : Bash" })).toEqual({ ok: false, code: "execution_line" });
    expect((await listSkills(w.deps, KEY))[0]!.currentVersion).toBe(1);
    expect(renderSkill({ name: "x", description: "d", when: "w", steps: ["a"] })).not.toMatch(/allowed-tools/iu);
  });
});

describe("company and project scope", () => {
  it("one company's or project's skills are never listed, served, offered or approved in another's", async () => {
    const w = await world();
    await draftSkillFromLesson(w.deps, KEY, { lessonId: (await proven(w)).id, by: "ann" });
    await goLive(w, "add-a-queue-handler", 1);
    const otherCompany = { workspaceId: OTHER_COMPANY, project: "payments" };
    const otherProject = { workspaceId: COMPANY, project: "billing" };
    for (const key of [otherCompany, otherProject]) {
      expect(await listSkills(w.deps, key)).toEqual([]);
      expect(await liveSkillsForStep(w.h.store, key)).toEqual({ skills: [], left: 0 });
      expect(await approveSkill(w.deps, key, { name: "add-a-queue-handler", version: 1, by: "cy" })).toEqual({ ok: false, code: "not_found" });
      expect(await retireSkill(w.deps, key, { name: "add-a-queue-handler", by: "cy" })).toEqual({ ok: false, code: "not_found" });
      expect(await editSkill(w.deps, key, { name: "add-a-queue-handler", by: "cy", expectedVersion: 1, form: { description: "x y z", when: "now", steps: ["one"] } })).toEqual({ ok: false, code: "not_found" });
    }
    // The same name in another company is its own skill: nothing of the first one's is in its rows.
    const lessonB = procedure(w, { workspaceId: OTHER_COMPANY, id: "les_procB001" });
    await put(w, lessonB);
    await used(w, lessonB.id, 10, OTHER_COMPANY);
    expect(await draftSkillFromLesson(w.deps, otherCompany, { lessonId: lessonB.id, by: "ann" })).toMatchObject({ ok: true, name: "add-a-queue-handler" });
    expect((await listSkills(w.deps, otherCompany))[0]).toMatchObject({ approvals: 0 });
    expect((await liveSkillsForStep(w.h.store, KEY)).skills).toHaveLength(1);
    expect(await liveSkillsForStep(w.h.store, otherCompany)).toEqual({ skills: [], left: 0 });
    // A lesson of the other company cannot be drafted into this company's skills.
    expect(await draftSkillFromLesson(w.deps, KEY, { lessonId: lessonB.id, by: "ann" })).toEqual({ ok: false, code: "not_found" });
  });
});

describe("what a step is sent", () => {
  const liveRow = async (w: World, name: string, bytes: number, over: { digest?: string; approvals?: number } = {}): Promise<void> => {
    const content = `---\nname: ${name}\ndescription: skill ${name}\n---\n\n## Steps\n1. ${"x".repeat(Math.max(1, bytes - 80))}\n`;
    const pk = companyScoped(COMPANY, "SKILL#payments");
    await w.h.store.put({ item: { pk, sk: `v#${name}#000001`, entityType: "SKILL_VERSION", name, version: 1, description: `skill ${name}`, content, digest: over.digest ?? sha(content), bytes: Buffer.byteLength(content, "utf8"), approvals: Array.from({ length: over.approvals ?? 2 }, (_, n) => ({ by: `p${String(n)}`, at: 1 })), createdBy: "ann", createdAt: 1, activatedAt: 2 } });
    await w.h.store.put({ item: { pk, sk: `head#${name}`, entityType: "SKILL_HEAD", name, currentVersion: 1, activeVersion: 1, fromLessons: [], createdBy: "ann", createdAt: 1, updatedAt: 2 } });
    const set = await w.h.store.get({ pk, sk: "set" });
    await w.h.store.put({ item: { pk, sk: "set", entityType: "SKILL_SET", members: { ...((set?.["members"] as Record<string, number> | undefined) ?? {}), [name]: 1 }, updatedAt: 1 } });
  };
  it("at most 8 skills and 96 KB; a skill past either limit is not sent at all, never half of it", async () => {
    const w = await world();
    for (let n = 0; n < 9; n += 1) await liveRow(w, `skill-${String(n)}`, 1_000);
    const nine = await liveSkillsForStep(w.h.store, KEY);
    expect(nine.skills).toHaveLength(ROVARA_SKILLS_PER_STEP_MAX);
    expect(nine.left).toBe(1);
    expect(nine.skills.map((s) => s.name)).toEqual(Array.from({ length: 8 }, (_, n) => `skill-${String(n)}`));
    const big = await world();
    for (let n = 0; n < 4; n += 1) await liveRow(big, `big-${String(n)}`, 30_000);
    const budget = await liveSkillsForStep(big.h.store, KEY);
    expect(budget.skills).toHaveLength(3);
    expect(budget.left).toBe(1);
    expect(budget.skills.reduce((sum, skill) => sum + Buffer.byteLength(skill.content, "utf8"), 0)).toBeLessThanOrEqual(ROVARA_SKILLS_PAYLOAD_BYTES_MAX);
    for (const skill of budget.skills) expect(skill.digest).toBe(sha(skill.content));
  });
  it("a text that does not match its digest, or one with too few approvals, is left out and counted, and the others are still sent", async () => {
    const w = await world();
    await liveRow(w, "good-one", 500);
    await liveRow(w, "tampered", 500, { digest: "0".repeat(64) });
    await liveRow(w, "one-approval", 500, { approvals: 1 });
    const served = await liveSkillsForStep(w.h.store, KEY);
    expect(served.skills.map((s) => s.name)).toEqual(["good-one"]);
    expect(served.left).toBe(2);
  });
  it("a store that cannot be read gives an error to the caller (which sends no skill), never a partial list", async () => {
    const w = await world();
    await liveRow(w, "good-one", 500);
    const store = { get: async () => { throw new Error("down"); } };
    await expect(liveSkillsForStep(store, KEY)).rejects.toThrow("down");
  });
});

describe("delivery to a plan or build step", () => {
  const ask = (w: World, over: { workflowMode?: string; features?: string[] } = {}) => w.lessons.learnedFor({ workspaceId: w.workspaceId, operationId: randomUUID(), workflowMode: over.workflowMode ?? "PLAN", features: over.features ?? [LEARNED_CONTEXT_FEATURE, ROVARA_SKILLS_FEATURE] });
  async function live(w: World): Promise<void> { await draftSkillFromLesson(w.deps, KEY, { lessonId: (await proven(w)).id, by: "ann" }); await goLive(w, "add-a-queue-handler", 1); }

  it("sends the live skills to plan and build steps of a worker that lists the feature, and to no other step or worker", async () => {
    const w = await world();
    await live(w);
    for (const mode of ["PLAN", "IMPLEMENT"]) {
      const answer = await ask(w, { workflowMode: mode });
      expect(answer.rovaraSkills, mode).toHaveLength(1);
      expect(answer.rovaraSkills![0]).toMatchObject({ name: "add-a-queue-handler", version: 1 });
    }
    for (const mode of ["REVIEW", "UNDERSTAND", "PLAN_CRITIQUE", "CHECKS", "SETUP_AGENT"]) expect((await ask(w, { workflowMode: mode })).rovaraSkills, mode).toBeUndefined();
    expect((await ask(w, { features: [LEARNED_CONTEXT_FEATURE] })).rovaraSkills).toBeUndefined();
    expect((await ask(w, { features: [ROVARA_SKILLS_FEATURE] })).rovaraSkills).toHaveLength(1);
  });

  it("sends none when lessons are switched off or the project's learning is Off, and for a workspace that is not this company's", async () => {
    const w = await world();
    await live(w);
    await writeLearningMode(w.h.store, KEY, "Off", 1);
    expect((await ask(w)).rovaraSkills).toBeUndefined();
    await writeLearningMode(w.h.store, KEY, "Suggest", 2);
    expect((await ask(w)).rovaraSkills).toHaveLength(1);
    expect((await w.lessons.learnedFor({ workspaceId: "no-such-workspace", operationId: randomUUID(), workflowMode: "PLAN", features: [ROVARA_SKILLS_FEATURE] })).rovaraSkills).toBeUndefined();
    // The install's lessons switch: off means none of the team's memory is sent, skills included.
    w.setEnabled(false);
    expect((await ask(w)).rovaraSkills).toBeUndefined();
    w.setEnabled(true);
    expect((await ask(w)).rovaraSkills).toHaveLength(1);
  });

  it("a retired skill is not sent to the next step", async () => {
    const w = await world();
    await live(w);
    expect((await ask(w)).rovaraSkills).toHaveLength(1);
    await retireSkill(w.deps, KEY, { name: "add-a-queue-handler", by: "cy" });
    expect((await ask(w)).rovaraSkills).toBeUndefined();
  });
});

describe('the "Make this a skill?" card', () => {
  it("is offered for a proven procedure lesson to the people who decide, once, and not after a skill was made from it", async () => {
    const w = await world();
    const lesson = await proven(w);
    await put(w, procedure(w, { id: "les_proc0009", title: "Another procedure", body: "When x: 1. a 2. b" }));
    await used(w, "les_proc0009", 3);
    const offers = await skillOffers(w.deps, KEY);
    expect(offers).toEqual([{ lessonId: lesson.id, title: "Add a queue handler", tasks: 10, days: 40 }]);
    const view = await buildLessonsView(w.lessons.runtime.routes, { orgId: COMPANY, developerId: w.lessons.owner.id }, "payments");
    expect(view.skillOffers).toEqual(offers);
    await draftSkillFromLesson(w.deps, KEY, { lessonId: lesson.id, by: "ann" });
    expect(await skillOffers(w.deps, KEY)).toEqual([]);
    const after = await buildLessonsView(w.lessons.runtime.routes, { orgId: COMPANY, developerId: w.lessons.owner.id }, "payments");
    expect(after.skillOffers).toBeUndefined();
  });
  it("is not offered while phase 2 has weight against the lesson or has it under question: the card and the button read the one proven band (L4-INT)", async () => {
    const w = await world();
    const lesson = await proven(w);
    const signals = freshSignalsReader(w.h.store, COMPANY, () => w.h.clock.now);
    expect((await skillOffers({ ...w.deps, signals }, KEY)).map((offer) => offer.lessonId)).toEqual([lesson.id]);
    await documentEvidenceSink(w.h.store, COMPANY).note({ workspaceId: COMPANY, project: "payments", lessonId: lesson.id, kind: "against", weight: 1, at: w.h.clock.now - DAY, id: "mark-1" });
    expect(await skillOffers({ ...w.deps, signals }, KEY)).toEqual([]);
    // The lessons page shows the same: its own signals reader sees the mark too.
    const view = await buildLessonsView(w.lessons.runtime.routes, { orgId: COMPANY, developerId: w.lessons.owner.id }, "payments");
    expect(view.skillOffers).toBeUndefined();
    // The button re-reads it fresh and refuses.
    expect(await draftSkillFromLesson({ ...w.deps, signals }, KEY, { lessonId: lesson.id, by: "ann" })).toEqual({ ok: false, code: "not_proven" });
    // A reader that cannot answer is no proof: nothing is offered and nothing is drafted.
    const blind = { read: async () => undefined };
    expect(await skillOffers({ ...w.deps, signals: blind }, KEY)).toEqual([]);
  });
  it("is not offered for another company's lesson", async () => {
    const w = await world();
    const mine = procedure(w);
    await put(w, mine);
    await used(w, mine.id, 10, OTHER_COMPANY);
    expect(await skillOffers(w.deps, KEY)).toEqual([]);
  });
});
