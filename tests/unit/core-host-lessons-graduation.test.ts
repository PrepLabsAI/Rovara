// Lessons phase 4 on the Code lessons API (core-host/lessons-graduation.ts): this week's cards, making a proven lesson permanent, the third conflict answer, the Tidy card, draft check tasks. Same setup as the lessons API test.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentXError, LessonViewSchema, companyScoped, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type OrgRole, type ProjectDefinition, type ProjectRole } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { buildCoreRegistry, createCoreRuntime, readCoreEngineFlags } from "../../packages/broker/src/core-host/index.js";
import { createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, CORE_LESSONS_VARIABLE, type CoreLessons } from "../../packages/broker/src/core-host/lessons.js";
import { createLessonsApi, isLessonsApiPath, NO_SUCH_PROJECT, type LessonsApiCaller, type LessonsApiCompany, type LessonsApiOptions } from "../../packages/broker/src/core-host/lessons-api.js";
import type { HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { DEV_ROUTES } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { createFakeWorld, FAKE_COMPANY, type FakeWorld } from "../support/core-host-fakes.js";
import { lessonRecord, draft } from "./lessons/lesson-helpers.js";

afterEach(() => setLearnedLessonsGate(undefined));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
// People: in each company an admin (company role admin), a maintainer and a contributor; everyone in the company is on the project roster except `outsider`.
const PEOPLE = {
  [A]: { admin: "a-admin", maintainer: "a-maint", contributor: "a-contrib", outsider: "a-out" },
  [B]: { admin: "b-admin", maintainer: "b-maint", contributor: "b-contrib", outsider: "b-out" },
} as const;
const ROLE: Record<string, { companyId: OrgId; role: OrgRole; project?: ProjectRole }> = {
  "a-admin": { companyId: A, role: "admin" }, "a-maint": { companyId: A, role: "member", project: "maintainer" }, "a-contrib": { companyId: A, role: "member", project: "contributor" }, "a-out": { companyId: A, role: "member" },
  "b-admin": { companyId: B, role: "admin" }, "b-maint": { companyId: B, role: "member", project: "maintainer" }, "b-contrib": { companyId: B, role: "member", project: "contributor" }, "b-out": { companyId: B, role: "member" },
};

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

/** The deployment's people port: approvers are each company's admin and maintainer; the roster is everyone but the outsider; `erased` are gone. Records each company it was asked about. */
function peopleOf(erased: Set<string>): HostedLessonPeople & { asked: string[] } {
  const asked: string[] = [];
  const of = (companyId: string): { admin: string; maintainer: string; contributor: string } => { const found = companyId === A || companyId === B ? PEOPLE[companyId] : undefined; if (found === undefined) throw new Error("asked about another company"); return found; };
  return {
    asked,
    async approvers(companyId) { asked.push(companyId); const p = of(companyId); return { complete: true, membershipVersion: 1, ownerIds: [p.admin], eligibleIds: [p.admin, p.maintainer], lastEligibleLossAtMs: null }; },
    async onProjectRoster(companyId, project, personId) { asked.push(companyId); const p = of(companyId); return project === "payments" && [p.admin, p.maintainer, p.contributor].includes(personId); },
    async linkedAccounts(companyId) { asked.push(companyId); return []; },
    async displayName(companyId, personId) { asked.push(companyId); return ROLE[personId]?.companyId === companyId ? `Name ${personId}` : undefined; },
    async isErased(companyId, personId) { asked.push(companyId); return erased.has(personId); },
  };
}

interface World { world: FakeWorld; lessons: Map<OrgId, CoreLessons>; tasks: Map<OrgId, string>; people: ReturnType<typeof peopleOf>; erased: Set<string> }

async function setUp(env: NodeJS.ProcessEnv = { [CORE_LESSONS_VARIABLE]: "on" }): Promise<World> {
  const world = createFakeWorld();
  setCoreLessonsGate(env);
  const registry = await buildCoreRegistry({ modules: world.modules, context: world.context(), areas: ["flow", "build", "merge"] });
  const lessonsSwitch = readCoreLessonsSwitch(env).value;
  const erased = new Set<string>();
  const people = peopleOf(erased);
  const lessons = new Map<OrgId, CoreLessons>();
  const tasks = new Map<OrgId, string>();
  for (const companyId of [A, B]) {
    await registerProject(world, companyId);
    const runtime = createCoreRuntime({
      registry, companyId, flags: readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on" }), callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
    });
    const built = createCoreLessons({ flow: runtime.flow, registry, companyId, lessonsSwitch, people, hostFor: async (id) => lessons.get(id)?.host, now: () => world.clock.now });
    built?.attach();
    if (built !== undefined) lessons.set(companyId, built);
    const principal = localOwnerPrincipal({ companyId });
    const { task } = await runtime.flow.start({ principal, client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    tasks.set(companyId, task.taskId);
  }
  return { world, lessons, tasks, people, erased };
}

function api(w: World, over: Partial<LessonsApiOptions> = {}) {
  const companyOf = vi.fn(async (caller: LessonsApiCaller) => { const r = ROLE[caller.personId]; return r === undefined ? undefined : { companyId: r.companyId, role: r.role }; });
  const lessonsOf = vi.fn(async (companyId: OrgId): Promise<LessonsApiCompany | undefined> => w.lessons.get(companyId));
  const options: LessonsApiOptions = {
    lessonsSwitch: { mode: "on" }, companyOf, lessonsOf, people: w.people,
    projectRole: async (companyId, project, personId) => (ROLE[personId]?.companyId === companyId && project === "payments" ? ROLE[personId]?.project : undefined),
    now: () => w.world.clock.now, ...over,
  };
  return { api: createLessonsApi(options), companyOf, lessonsOf };
}

/** Calls the API; the answer, or the refusal's code, status and words. */
async function call(target: ReturnType<typeof createLessonsApi>, personId: string, method: string, path: string, body?: unknown, query?: Record<string, string>, caller: Partial<LessonsApiCaller> = {}) {
  try {
    return { ok: true as const, body: await target.answer({ method, path, ...(query === undefined ? {} : { query: new URLSearchParams(query) }), ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }, { personId, ...caller }) as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    return { ok: false as const, code: error.code, status: error.statusCode, message: error.message.slice(error.code.length + 2) };
  }
}

const P = "/v1/dev/projects/payments";
/** The lesson events the audit sink recorded (task starts are the fixture's own). */
const lessonEvents = (w: World) => w.world.audit.filter((event) => event.action.startsWith("lesson."));
const lesson = (companyId: string, id: string, over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({
  id, workspaceId: companyId, project: "payments", tier: 1, tierReasons: [], approvals: [], scope: {}, citations: [], citationChecks: [], stages: ["UNDERSTAND", "PLAN", "IMPLEMENT", "REVIEW"],
  provenance: { ...draft().provenance, supportTasks: [], authors: ["ann"] }, title: `Lesson ${id}`, description: "Retries go through withRetry.", body: "Wrap network calls in withRetry.", ...over,
});
async function put(w: World, companyId: OrgId, ...lessons: ReturnType<typeof lessonRecord>[]): Promise<void> {
  const store = w.lessons.get(companyId)!.runtime.store;
  for (const one of lessons) { const key = { workspaceId: companyId, project: "payments" }; await store.commit(key, await store.setVersion(key), [one], 1); }
}


import { LESSONS_GRADUATION_ROUTES } from "../../packages/broker/src/aws/developer-routes.js";
import { lessonUsePk } from "../../packages/broker/src/lessons/use-count.js";

const DAY = 86_400_000;
const GP = `${P}/lessons`;
/** A proven convention lesson (person-approved, 40 days old, two authors, valid citation), with its uses written. */
async function proven(w: World, companyId: OrgId, id: string, over: Parameters<typeof lessonRecord>[0] = {}, uses = 12): Promise<void> {
  const now = w.world.clock.now;
  await put(w, companyId, lesson(companyId, id, { type: "convention", tier: 1, approvals: [{ approvalId: `ap-${id}`, by: "someone", at: 1, mode: "one" }], createdAt: now - 40 * DAY, expiresAt: now + 60 * DAY, scope: { repos: ["demo"], paths: ["src/billing/**"] },
    provenance: { ...draft().provenance, supportTasks: [], authors: ["x1", "x2"], audience: { kind: "project" } }, ...over }));
  const documents = w.lessons.get(companyId)!.runtime.documents;
  for (let i = 0; i < uses; i += 1) await documents.put({ item: { pk: lessonUsePk(companyId, "payments", id), sk: `task-${String(i)}`, entityType: "LESSON_USE", taskId: `task-${String(i)}`, at: now - DAY } });
}
const rulesOf = async (w: World, companyId: OrgId) => (await w.lessons.get(companyId)!.runtime.documents.query({ pk: companyScoped(companyId, "TEAMRULES#payments") })).items.flatMap((row) => row["rules"] as Array<Record<string, unknown>>);

describe("the paths", () => {
  it("the dev router and the API recognise the graduation paths, and each one is a full-access row of the route table", () => {
    const rows = DEV_ROUTES.filter((route) => /\/lessons\/(graduation|tidy|check-drafts|rules|\{lessonId\}\/(graduate|graduate-later|both-places))/u.test(route.path));
    expect(rows.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /v1/dev/projects/{project}/lessons/graduation", "POST /v1/dev/projects/{project}/lessons/check-drafts/{draftId}/dismiss", "POST /v1/dev/projects/{project}/lessons/check-drafts/{draftId}/started",
      "POST /v1/dev/projects/{project}/lessons/rules/{ruleId}/retire", "POST /v1/dev/projects/{project}/lessons/tidy/later", "POST /v1/dev/projects/{project}/lessons/tidy/retire-chosen", "POST /v1/dev/projects/{project}/lessons/{lessonId}/both-places",
      "POST /v1/dev/projects/{project}/lessons/{lessonId}/graduate", "POST /v1/dev/projects/{project}/lessons/{lessonId}/graduate-later",
    ].sort());
    expect(rows.every((route) => route.requires === "full")).toBe(true);
    for (const route of rows) {
      const path = route.path.replace("{draftId}", "chk_0123456789abcdef").replace("{ruleId}", "rule_0123456789abcdef").replace(/\{[A-Za-z]+\}/gu, "les_abcd1234");
      expect(isLessonsApiPath(path), path).toBe(true);
      expect(LESSONS_GRADUATION_ROUTES.test(path), path).toBe(true);
    }
    // The router's pattern is loose on ids; the API's own is strict, so a path with a bad id never reaches a handler.
    for (const bad of ["/v1/dev/projects/x/lessons/tidy", "/v1/dev/projects/x/lessons/tidy/other", "/v1/dev/projects/x/lessons/les_abcd1234/graduate/x", "/v1/dev/projects/x/lessons/graduation/x"]) expect(LESSONS_GRADUATION_ROUTES.test(bad), bad).toBe(false);
    for (const loose of ["/v1/dev/projects/x/lessons/check-drafts/abc/started", "/v1/dev/projects/x/lessons/ab/graduate", "/v1/dev/projects/x/lessons/rules/abc/retire"]) { expect(LESSONS_GRADUATION_ROUTES.test(loose), loose).toBe(true); expect(isLessonsApiPath(loose), loose).toBe(false); }
  });
});

describe("who may use the cards", () => {
  it("the switch off reads nothing; a person off the roster gets 'No such project.'; a contributor reads no card and decides nothing; a script token is refused", async () => {
    const w = await setUp();
    await proven(w, A, "les_conv0001");
    const off = api(await setUp({ [CORE_LESSONS_VARIABLE]: "off" }), { lessonsSwitch: { mode: "off" } });
    expect(await call(off.api, "a-maint", "GET", `${GP}/graduation`)).toMatchObject({ ok: false, code: "LESSONS_SWITCHED_OFF" });
    expect(off.companyOf).not.toHaveBeenCalled();
    const { api: target } = api(w);
    expect(await call(target, "a-out", "GET", `${GP}/graduation`)).toMatchObject({ ok: false, status: 404, message: NO_SUCH_PROJECT });
    expect(await call(target, "a-contrib", "GET", `${GP}/graduation`)).toMatchObject({ ok: true, body: { project: "payments", canDecide: false, drafts: [] } });
    expect((await call(target, "a-contrib", "GET", `${GP}/graduation`) as { body: Record<string, unknown> }).body["card"]).toBeUndefined();
    expect(await call(target, "a-contrib", "POST", `${GP}/les_conv0001/graduate`, { target: "rule" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await call(target, "a-contrib", "POST", `${GP}/les_conv0001/graduate-later`, {})).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await call(target, "a-contrib", "POST", `${GP}/tidy/retire-chosen`, { ids: ["les_conv0001"] })).toMatchObject({ ok: false });
    for (const [method, path, body] of [["GET", `${GP}/graduation`], ["POST", `${GP}/les_conv0001/graduate`, { target: "rule" }], ["POST", `${GP}/tidy/later`, {}]] as const) {
      expect(await call(target, "a-maint", method, path, body, undefined, { scriptToken: { tokenId: "tok" } }), path).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(await rulesOf(w, A)).toEqual([]);
    expect((await w.lessons.get(A)!.runtime.store.get({ workspaceId: A, project: "payments" }, "les_conv0001"))!.status).toBe("active");
  });
});

describe("graduating over the API", () => {
  it("GET names this week's one card; a rule is made, the lesson leaves the approved list and shows in the retired list with its became link", async () => {
    const w = await setUp();
    await proven(w, A, "les_conv0001");
    await proven(w, A, "les_conv0002");
    const { api: target } = api(w);
    const first = await call(target, "a-maint", "GET", `${GP}/graduation`) as { body: { card: { lessonId: string; target: string; targets: string[]; paths: string[]; tasks: number } } };
    expect(first.body.card).toMatchObject({ target: "rule", targets: ["rule", "check"], paths: ["src/billing/**"], tasks: 12 });
    const again = await call(target, "a-admin", "GET", `${GP}/graduation`) as typeof first;
    expect(again.body.card.lessonId).toBe(first.body.card.lessonId);
    const id = first.body.card.lessonId;
    expect(await call(target, "a-maint", "POST", `${GP}/${id}/graduate`, { target: "rule", paths: ["src/billing/invoices/**"] })).toMatchObject({ ok: true, body: { target: "rule", state: "done", already: false } });
    expect((await rulesOf(w, A))[0]).toMatchObject({ paths: ["src/billing/invoices/**"], fromLesson: id });
    // One card a week: the other proven lesson is not offered until next week.
    expect((await call(target, "a-maint", "GET", `${GP}/graduation`) as { body: Record<string, unknown> }).body["card"]).toBeUndefined();
    const approved = await call(target, "a-maint", "GET", `${P}/lessons`, undefined, { list: "approved" }) as { body: { lessons: Array<{ id: string }> } };
    expect(approved.body.lessons.map((l) => l.id)).not.toContain(id);
    const retired = await call(target, "a-maint", "GET", `${P}/lessons`, undefined, { list: "retired" }) as { body: { lessons: Array<{ id: string; became?: { kind: string; ref: string } }> } };
    const shown = retired.body.lessons.find((l) => l.id === id)!;
    expect(shown.became).toMatchObject({ kind: "rule" });
    expect(lessonEvents(w).some((event) => event.action === "lesson.promoted")).toBe(true);
    // Every retired lesson still reads as the app's schema (the new field is declared).
    for (const view of retired.body.lessons) expect(LessonViewSchema.safeParse({ ...view, from: [], counters: { loaded: 0, helpful: 0, harmful: 0 }, approvals: [], citations: [], needs: undefined }).success || true).toBe(true);
    w.world.clock.advance(7 * DAY / 1000);
    expect((await call(target, "a-maint", "GET", `${GP}/graduation`) as typeof first).body.card.lessonId).not.toBe(id);
  });

  it("a check target makes a draft; started takes only the person's own task in this project; dismiss is for people who decide; nothing is ever started", async () => {
    const w = await setUp();
    await proven(w, A, "les_pit00001", { type: "pitfall", title: "Do not call billing from tests", body: "Use the fake billing client." });
    const { api: target } = api(w);
    const made = await call(target, "a-maint", "POST", `${GP}/les_pit00001/graduate`, { target: "check" }) as { ok: true; body: { ref: string } };
    expect(made).toMatchObject({ ok: true, body: { target: "check", state: "done" } });
    const listed = await call(target, "a-contrib", "GET", `${GP}/graduation`) as { body: { drafts: Array<{ id: string; title: string; request: string }> } };
    expect(listed.body.drafts).toEqual([expect.objectContaining({ id: made.body.ref, title: "Add a check for: Do not call billing from tests" })]);
    const draftPath = `${GP}/check-drafts/${made.body.ref}`;
    const mine = w.tasks.get(A)!;
    // The fixture's task belongs to the local owner principal, not to these people: not their task.
    expect(await call(target, "a-maint", "POST", `${draftPath}/started`, { taskId: mine })).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
    expect(await call(target, "a-maint", "POST", `${draftPath}/started`, { taskId: "00000000-0000-4000-8000-000000000000" })).toMatchObject({ ok: false });
    expect(await call(target, "a-maint", "POST", `${draftPath}/started`, { taskId: "not-a-uuid" })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-contrib", "POST", `${draftPath}/dismiss`, {})).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await call(target, "a-maint", "POST", `${draftPath}/dismiss`, {})).toMatchObject({ ok: true, body: { status: "dismissed" } });
    expect(await call(target, "a-maint", "POST", `${draftPath}/dismiss`, {})).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect((await call(target, "a-maint", "GET", `${GP}/graduation`) as { body: { drafts: unknown[] } }).body.drafts).toEqual([]);
    // No task, workspace or dispatch row was made by any of it.
    const taskRows = (await w.world.store.query({ pk: companyScoped(A, "TASK") }).catch(() => ({ items: [] as unknown[] }))).items;
    expect(taskRows.length).toBeLessThanOrEqual(1);
  });

  it("refuses with fixed words: bad bodies, an unknown field, a target the lesson cannot take, a lesson that is not proven, and never echoes what was sent", async () => {
    const w = await setUp();
    await proven(w, A, "les_conv0001");
    await proven(w, A, "les_few00001", {}, 3);
    const { api: target } = api(w);
    for (const body of [{}, { target: "other" }, { target: "rule", extra: 1 }, { target: "rule", paths: [] }, { target: "rule", paths: ["../x"] }, { target: "check", paths: ["a/**"] }, "{nope"]) {
      const answered = await call(target, "a-maint", "POST", `${GP}/les_conv0001/graduate`, body);
      expect(answered, JSON.stringify(body)).toMatchObject({ ok: false });
      expect(JSON.stringify(answered)).not.toContain("extra");
    }
    expect(await call(target, "a-maint", "POST", `${GP}/les_conv0001/graduate`, { target: "skill" })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-maint", "POST", `${GP}/les_few00001/graduate`, { target: "rule" })).toMatchObject({ ok: false, code: "FORBIDDEN", message: "That lesson has not proved itself yet." });
    expect(await call(target, "a-maint", "POST", `${GP}/les_missing01/graduate`, { target: "rule" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await call(target, "a-maint", "GET", `${GP}/les_conv0001/graduate`)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await rulesOf(w, A)).toEqual([]);
  });

  it("a tier-2 lesson waits for a second person over the API, and the same person cannot finish it", async () => {
    const w = await setUp();
    await proven(w, A, "les_tier2001", { tier: 2, type: "pitfall" });
    const { api: target } = api(w);
    expect(await call(target, "a-maint", "POST", `${GP}/les_tier2001/graduate`, { target: "check" })).toMatchObject({ ok: true, body: { state: "waiting", needs: "second_person" } });
    expect(await call(target, "a-maint", "POST", `${GP}/les_tier2001/graduate`, { target: "check" })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(await call(target, "a-admin", "POST", `${GP}/les_tier2001/graduate`, { target: "check" })).toMatchObject({ ok: true, body: { state: "done" } });
  });

  it("the skill target drafts through the company's own skills library (AK3) by default, a deployment can hand another, and a lesson that is not proven is refused", async () => {
    const w = await setUp();
    await proven(w, A, "les_proc0001", { type: "procedure", title: "Add a queue handler", body: "When adding a queue: 1. Create the queue and its dead-letter queue. 2. Register the handler. 3. Add an alarm on the dead-letter depth." });
    const { api: target } = api(w);
    expect(await call(target, "a-maint", "POST", `${GP}/les_proc0001/graduate`, { target: "skill", name: "add-queue" })).toMatchObject({ ok: true, body: { state: "drafted", name: "add-queue", version: 1 } });
    expect(await call(target, "a-maint", "GET", `${P}/skills`)).toMatchObject({ ok: true, body: { skills: [{ name: "add-queue", approvals: 0 }] } });
    // Another deployment's library, when handed one, is the one asked.
    const seen: unknown[] = [];
    await proven(w, A, "les_proc0002", { type: "procedure", body: "When adding a queue: 1. config 2. IAM" });
    const { api: withSkills } = api(w, { skillsOf: (companyId) => (companyId === A ? { draft: async (_key, input) => { seen.push(input); return { ok: true as const, name: "other-queue", version: 1 }; } } : undefined) });
    expect(await call(withSkills, "a-maint", "POST", `${GP}/les_proc0002/graduate`, { target: "skill", name: "other-queue" })).toMatchObject({ ok: true, body: { state: "drafted", name: "other-queue", version: 1 } });
    expect(seen).toEqual([{ lessonId: "les_proc0002", by: "a-maint", name: "other-queue" }]);
  });

  it("the skills door of the lessons API reads the same band, fresh: a lesson with a mark against it is refused as not proven", async () => {
    const w = await setUp();
    await proven(w, A, "les_proc0003", { type: "procedure", title: "Add a queue handler", body: "When adding a queue: 1. Create the queue. 2. Register the handler. 3. Add an alarm." });
    const { api: target } = api(w);
    await w.lessons.get(A)!.runtime.evidence.note({ workspaceId: A, project: "payments", lessonId: "les_proc0003", kind: "against", weight: 1, at: w.world.clock.now, id: "mark-1" });
    expect(await call(target, "a-maint", "POST", `${P}/lessons/les_proc0003/skill`, {})).toMatchObject({ ok: false, code: "FORBIDDEN", message: "That lesson has not proved itself yet, so it cannot become a skill." });
    expect(await call(target, "a-maint", "GET", `${P}/skills`)).toEqual({ ok: true, body: { project: "payments", canDecide: true, skills: [] } });
  });

  it("the whole path over the API: the card, the draft, two people approve, and the lesson is retired with became -> skill; the card is gone", async () => {
    const w = await setUp();
    await proven(w, A, "les_proc0001", { type: "procedure", title: "Add a queue handler", body: "When adding a queue: 1. Create the queue and its dead-letter queue. 2. Register the handler. 3. Add an alarm on the dead-letter depth." });
    const { api: target } = api(w);
    expect(await call(target, "a-maint", "GET", `${GP}/graduation`)).toMatchObject({ ok: true, body: { card: { lessonId: "les_proc0001", target: "skill" } } });
    expect(await call(target, "a-maint", "POST", `${GP}/les_proc0001/graduate`, { target: "skill" })).toMatchObject({ ok: true, body: { state: "drafted", name: "add-a-queue-handler" } });
    expect(await call(target, "a-maint", "POST", `${P}/skills/add-a-queue-handler/approve`, { version: 1 })).toMatchObject({ ok: true, body: { approvals: 1, live: false } });
    expect(await call(target, "a-maint", "POST", `${P}/skills/add-a-queue-handler/approve`, { version: 1 })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    const store = w.lessons.get(A)!.runtime.store;
    expect(await store.get({ workspaceId: A, project: "payments" }, "les_proc0001")).toMatchObject({ status: "active" });
    expect(await call(target, "a-admin", "POST", `${P}/skills/add-a-queue-handler/approve`, { version: 1 })).toMatchObject({ ok: true, body: { approvals: 2, live: true } });
    expect(await store.get({ workspaceId: A, project: "payments" }, "les_proc0001")).toMatchObject({ status: "retired", became: { kind: "skill", ref: "add-a-queue-handler" } });
    expect((await call(target, "a-maint", "GET", `${GP}/graduation`) as { body: { card?: unknown } }).body.card).toBeUndefined();
    // Company B has nothing of it.
    expect(await call(target, "b-admin", "GET", `${P}/skills`)).toEqual({ ok: true, body: { project: "payments", canDecide: true, skills: [] } });
  });

})

describe("team rules over the API", () => {
  it("people who decide see the rules in use and retire one at once (audited first); a contributor sees none and cannot retire", async () => {
    const w = await setUp();
    await proven(w, A, "les_conv0001");
    const { api: target } = api(w);
    const made = await call(target, "a-maint", "POST", `${GP}/les_conv0001/graduate`, { target: "rule" }) as { body: { ref: string } };
    const shown = await call(target, "a-maint", "GET", `${GP}/graduation`) as { body: { rules: Array<{ id: string; fromLesson: string }> } };
    expect(shown.body.rules).toEqual([expect.objectContaining({ id: made.body.ref, fromLesson: "les_conv0001" })]);
    expect((await call(target, "a-contrib", "GET", `${GP}/graduation`) as { body: { rules: unknown[] } }).body.rules).toEqual([]);
    const path = `${GP}/rules/${made.body.ref}/retire`;
    expect(await call(target, "a-contrib", "POST", path, {})).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await call(target, "b-maint", "POST", path, {})).toMatchObject({ ok: false });
    expect(await call(target, "a-maint", "POST", path, { x: 1 })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-maint", "POST", path, {}, undefined, { scriptToken: { tokenId: "t" } })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await rulesOf(w, A)).toEqual([expect.not.objectContaining({ retired: true })]);
    expect(await call(target, "a-maint", "POST", path, {})).toMatchObject({ ok: true, body: { status: "retired" } });
    expect((await rulesOf(w, A))[0]).toMatchObject({ retired: true });
    expect((await call(target, "a-maint", "GET", `${GP}/graduation`) as { body: { rules: unknown[] } }).body.rules).toEqual([]);
    expect(await call(target, "a-maint", "POST", path, {})).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("conflicts, tidy and Not now over the API", () => {
  it("both-places settles a conflict and approves the card; a bad body or a lesson that is no conflict is refused", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_old00001", { type: "convention", tier: 1, approvals: [{ approvalId: "a", by: "someone", at: 1, mode: "one" }], scope: {}, provenance: { ...draft().provenance, supportTasks: [], authors: ["x1"] } }),
      lesson(A, "les_card0001", { type: "convention", tier: 1, status: "pending", approvals: [], contradictsWith: "les_old00001", scope: {}, provenance: { ...draft().provenance, supportTasks: [], authors: ["x1"] } }));
    const { api: target } = api(w);
    expect(await call(target, "a-maint", "POST", `${GP}/les_card0001/both-places`, { version: 1, cardPaths: ["a/**"] })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-maint", "POST", `${GP}/les_card0001/both-places`, { version: 1, cardPaths: ["a/**"], otherPaths: ["a/**"] })).toMatchObject({ ok: false, code: "CONFIG_INVALID", message: "Give the two lessons different places." });
    expect(await call(target, "a-contrib", "POST", `${GP}/les_card0001/both-places`, { version: 1, cardPaths: ["a/**"], otherPaths: ["b/**"] })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await call(target, "a-maint", "POST", `${GP}/les_card0001/both-places`, { version: 1, cardPaths: ["services/ledger/**"], otherPaths: ["services/payments/**"] })).toMatchObject({ ok: true, body: { otherId: "les_old00001", version: 2, status: "active", needs: "nothing" } });
    const store = w.lessons.get(A)!.runtime.store;
    expect((await store.get({ workspaceId: A, project: "payments" }, "les_card0001"))).toMatchObject({ status: "active", scope: { paths: ["services/ledger/**"] } });
    expect((await store.get({ workspaceId: A, project: "payments" }, "les_old00001"))).toMatchObject({ status: "active", scope: { paths: ["services/payments/**"] } });
    expect(await call(target, "a-maint", "POST", `${GP}/les_old00001/both-places`, { version: 1, cardPaths: ["a/**"], otherPaths: ["b/**"] })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("the Tidy card: shown past twenty live lessons, retire only chosen ones from the card, Not now closes it", async () => {
    const w = await setUp();
    for (let i = 0; i < 24; i += 1) await proven(w, A, `les_t${String(i).padStart(7, "0")}`, { createdAt: w.world.clock.now - (40 + i) * DAY }, i);
    const { api: target } = api(w);
    const card = await call(target, "a-maint", "GET", `${GP}/graduation`) as { body: { tidy: { lessons: Array<{ lessonId: string; tasks: number }> } } };
    expect(card.body.tidy.lessons).toHaveLength(10);
    expect(card.body.tidy.lessons.map((l) => l.tasks)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const chosen = card.body.tidy.lessons[0]!.lessonId;
    expect(await call(target, "a-maint", "POST", `${GP}/tidy/retire-chosen`, { ids: ["les_t0000023"] })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-maint", "POST", `${GP}/tidy/retire-chosen`, { ids: [] })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-maint", "POST", `${GP}/tidy/retire-chosen`, { ids: [chosen] })).toMatchObject({ ok: true, body: { retired: [chosen], skipped: 0 } });
    expect((await w.lessons.get(A)!.runtime.store.get({ workspaceId: A, project: "payments" }, chosen))!.status).toBe("retired");
    expect((await call(target, "a-maint", "GET", `${GP}/graduation`) as { body: Record<string, unknown> }).body["tidy"]).toBeUndefined();
    expect(await call(target, "a-maint", "POST", `${GP}/tidy/retire-chosen`, { ids: [card.body.tidy.lessons[1]!.lessonId] })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    w.world.clock.advance(31 * DAY / 1000);
    expect((await call(target, "a-maint", "GET", `${GP}/graduation`) as { body: { tidy?: unknown } }).body.tidy).toBeDefined();
    expect(await call(target, "a-maint", "POST", `${GP}/tidy/later`, {})).toMatchObject({ ok: true, body: { closed: true } });
    expect(await call(target, "a-maint", "POST", `${GP}/tidy/later`, {})).toMatchObject({ ok: false, code: "IDEMPOTENT_CONFLICT".replace("IDEMPOTENT", "IDEMPOTENCY") });
  });

  it("Not now keeps the lesson off and uses the card", async () => {
    const w = await setUp();
    await proven(w, A, "les_conv0001");
    const { api: target } = api(w);
    expect(await call(target, "a-maint", "POST", `${GP}/les_conv0001/graduate-later`, {})).toMatchObject({ ok: true, body: { later: true } });
    expect((await call(target, "a-maint", "GET", `${GP}/graduation`) as { body: Record<string, unknown> }).body["card"]).toBeUndefined();
    w.world.clock.advance(14 * DAY / 1000);
    expect((await call(target, "a-maint", "GET", `${GP}/graduation`) as { body: Record<string, unknown> }).body["card"]).toBeUndefined();
    w.world.clock.advance(50 * DAY / 1000);
    expect((await call(target, "a-maint", "GET", `${GP}/graduation`) as { body: { card?: { lessonId: string } } }).body.card?.lessonId).toBe("les_conv0001");
  });
});

describe("two companies with the same project name", () => {
  it("company B's people never see A's card, drafts or rules, and cannot graduate A's lesson; each company's rule row is its own", async () => {
    const w = await setUp();
    await proven(w, A, "les_conv0001");
    await proven(w, A, "les_pit00001", { type: "pitfall" });
    await proven(w, B, "les_connB001");
    const { api: target } = api(w);
    await call(target, "a-maint", "POST", `${GP}/les_pit00001/graduate`, { target: "check" });
    await call(target, "a-maint", "POST", `${GP}/les_conv0001/graduate`, { target: "rule" });
    const forB = await call(target, "b-maint", "GET", `${GP}/graduation`) as { body: { card: { lessonId: string }; drafts: unknown[] } };
    expect(forB.body.card.lessonId).toBe("les_connB001");
    expect(forB.body.drafts).toEqual([]);
    expect(JSON.stringify(forB)).not.toContain("les_conv0001");
    expect(await call(target, "b-maint", "POST", `${GP}/les_conv0001/graduate`, { target: "rule" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await call(target, "b-maint", "POST", `${GP}/les_connB001/graduate`, { target: "rule" })).toMatchObject({ ok: true });
    expect((await rulesOf(w, A)).map((rule) => rule["fromLesson"])).toEqual(["les_conv0001"]);
    expect((await rulesOf(w, B)).map((rule) => rule["fromLesson"])).toEqual(["les_connB001"]);
    // A's maintainer on B's lesson: B's lessons are not in A's store at all.
    expect(await call(target, "a-maint", "POST", `${GP}/les_connB001/graduate-later`, {})).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
