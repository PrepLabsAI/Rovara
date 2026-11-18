// Lead 4 L4-LP3W: the lessons API's two new reads and one new write, for one project of the caller's own company (core-host/lessons-api.ts):
//   GET /lessons/areas[?repo=&folder=|?whole=1]   the approved lessons by code area (a tree) and the lessons at one node
//   GET /lessons/learning-sources                  "Where Rovara learns from": seen / suggested / kept, one example, paused or not
//   PUT /lessons/learning-sources/{key}            pause or resume one row (who may set the mode may; audited first; holds, deletes nothing)
// Two companies and two projects never meet; a lesson the reader may not see is neither counted nor the example; a paused source holds new lessons until resumed.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentXError, LessonViewSchema, companyScoped, learningModeLockKey, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type OrgRole, type ProjectDefinition, type ProjectRole } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";
import { buildCoreRegistry, createCoreRuntime, readCoreEngineFlags } from "../../../packages/broker/src/core-host/index.js";
import { createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, CORE_LESSONS_VARIABLE, type CoreLessons } from "../../../packages/broker/src/core-host/lessons.js";
import { createLessonsApi, encodeLessonCursor, isLessonsApiPath, LESSONS_OFF, MODE_NEEDS_ADMIN, NO_SUCH_PROJECT, SOURCE_NEEDS_ADMIN, SUMMARY_NEEDS_ADMIN, type LessonsApiCaller, type LessonsApiCompany, type LessonsApiOptions } from "../../../packages/broker/src/core-host/lessons-api.js";
import type { HostedLessonPeople } from "../../../packages/broker/src/lessons/hosted-people.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { DocumentPresetStore, DocumentTier0Settings, writeLearningMode } from "../../../packages/broker/src/lessons/document-settings.js";
import type { CoreSwitch } from "../../../packages/broker/src/core-host/flags.js";
import { DEV_ROUTES } from "../../../packages/broker/src/aws/dev-route-scopes.js";
import { LESSONS_API_ROUTES } from "../../../packages/broker/src/aws/developer-routes.js";
import { createFakeWorld, FAKE_COMPANY, type FakeWorld } from "../../support/core-host-fakes.js";
import { lessonRecord, draft } from "../lessons/lesson-helpers.js";

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


const AREAS = `${P}/lessons/areas`;
const SOURCES = `${P}/lessons/learning-sources`;
const person = { approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const };
const scoped = (companyId: string, id: string, paths: string[], over: Parameters<typeof lessonRecord>[0] = {}) => lesson(companyId, id, { scope: { repos: ["demo"], paths }, approvals: [person], status: "active", ...over });
const restrictedAudience = { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T/C9", principals: ["U-member"], capturedAt: "x", liveCheck: "none" as const } };

describe("the paths", () => {
  it("the dev router and the API recognise the three new paths, and each is a full-access row of the route table", () => {
    const rows = DEV_ROUTES.filter((route) => route.path.includes("/lessons/areas") || route.path.includes("/lessons/learning-sources"));
    expect(rows.map((route) => `${route.method} ${route.path}`).sort()).toEqual(["GET /v1/dev/projects/{project}/lessons/areas", "GET /v1/dev/projects/{project}/lessons/learning-sources", "PUT /v1/dev/projects/{project}/lessons/learning-sources/{source}"]);
    expect(rows.every((route) => route.requires === "full")).toBe(true);
    for (const path of [AREAS, SOURCES, `${SOURCES}/ci`, `${P}/lessons/areasx`, `${SOURCES}/`, `${SOURCES}/ci/x`, `${SOURCES}/CI`, `${P}/lessons/learning-sourcesx`]) expect(isLessonsApiPath(path), path).toBe(LESSONS_API_ROUTES.test(path));
    expect(isLessonsApiPath(AREAS) && isLessonsApiPath(SOURCES) && isLessonsApiPath(`${SOURCES}/ci`)).toBe(true);
    expect(isLessonsApiPath(`${SOURCES}/ci/x`) || isLessonsApiPath(`${SOURCES}/CI`)).toBe(false);
  });
  it("off: they answer 'Lessons are off.' and read nothing", async () => {
    const w = await setUp({});
    const { api: target, companyOf } = api(w, { lessonsSwitch: { mode: "off" } });
    for (const [method, path, body] of [["GET", AREAS], ["GET", SOURCES], ["PUT", `${SOURCES}/ci`, { paused: true }]] as const) expect(await call(target, "a-admin", method, path, body)).toEqual({ ok: false, code: "LESSONS_SWITCHED_OFF", status: 404, message: LESSONS_OFF });
    expect(companyOf).not.toHaveBeenCalled();
  });
  it("wrong methods and unknown keys are 'route not found'", async () => {
    const w = await setUp();
    const { api: target } = api(w);
    for (const [method, path] of [["POST", AREAS], ["PUT", AREAS], ["POST", SOURCES], ["PUT", SOURCES], ["GET", `${SOURCES}/ci`], ["DELETE", `${SOURCES}/ci`], ["PUT", `${SOURCES}/nope`]] as const) expect(await call(target, "a-admin", method, path, { paused: true }), `${method} ${path}`).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("by area", () => {
  it("counts the approved lessons as a tree and lists the lessons at one node, in the lessons tab's shape", async () => {
    const w = await setUp();
    await put(w, A, scoped(A, "les_ar000001", ["src/billing/**"]), scoped(A, "les_ar000002", ["src/billing/invoice/**"]), scoped(A, "les_ar000003", ["src/auth/**"]), lesson(A, "les_ar000004", { approvals: [person], status: "active" }), scoped(A, "les_ar0pend1", ["src/billing/**"], { status: "pending" }));
    const { api: target } = api(w);
    const all = await call(target, "a-contrib", "GET", AREAS);
    expect(all.ok).toBe(true);
    const body = all.ok ? all.body : {};
    expect(body["total"]).toBe(4);
    expect(body["wholeProject"]).toBe(1);
    expect(body["selection"]).toBeUndefined();
    const demo = (body["repos"] as Array<{ repo: string; lessons: number; children: Array<{ name: string; lessons: number; children: Array<{ name: string; lessons: number }> }> }>)[0]!;
    expect(demo).toMatchObject({ repo: "demo", lessons: 3 });
    expect(demo.children.map((c) => `${c.name}:${c.lessons}`)).toEqual(["src:3"]);
    expect(demo.children[0]!.children.map((c) => `${c.name}:${c.lessons}`).sort()).toEqual(["auth:1", "billing:2"]);
    const picked = await call(target, "a-contrib", "GET", AREAS, undefined, { repo: "demo", folder: "src/billing" });
    expect(picked.ok && (picked.body["selection"] as { lessons: Array<{ id: string; title: string }> }).lessons.map((l) => l.id).sort()).toEqual(["les_ar000001", "les_ar000002"]);
    const whole = await call(target, "a-contrib", "GET", AREAS, undefined, { whole: "1" });
    expect(whole.ok && (whole.body["selection"] as { lessons: Array<{ id: string }> }).lessons.map((l) => l.id)).toEqual(["les_ar000004"]);
  });

  it("is open to anyone on the project's roster and to nobody else (the same 'No such project.')", async () => {
    const w = await setUp();
    await put(w, A, scoped(A, "les_ar000001", ["src/billing/**"]));
    const { api: target } = api(w);
    expect((await call(target, "a-contrib", "GET", AREAS)).ok).toBe(true);
    expect(await call(target, "a-out", "GET", AREAS)).toMatchObject({ ok: false, code: "NOT_FOUND", message: NO_SUCH_PROJECT });
    expect(await call(target, "a-admin", "GET", `/v1/dev/projects/missing/lessons/areas`)).toMatchObject({ ok: false, code: "NOT_FOUND", message: NO_SUCH_PROJECT });
  });

  it("two companies, one project name: each sees only its own lessons in the tree and in a node", async () => {
    const w = await setUp();
    await put(w, A, scoped(A, "les_aaaa0001", ["src/billing/**"]));
    await put(w, B, scoped(B, "les_bbbb0001", ["src/billing/**"]), scoped(B, "les_bbbb0002", ["src/billing/**"]));
    const { api: target } = api(w);
    const a = await call(target, "a-admin", "GET", AREAS, undefined, { repo: "demo", folder: "src/billing" });
    const b = await call(target, "b-admin", "GET", AREAS, undefined, { repo: "demo", folder: "src/billing" });
    expect(a.ok && a.body["total"]).toBe(1);
    expect(b.ok && b.body["total"]).toBe(2);
    expect(a.ok && JSON.stringify(a.body)).not.toContain("les_bbbb");
    expect(b.ok && JSON.stringify(b.body)).not.toContain("les_aaaa");
  });

  it("a lesson the reader may not see is not counted and not listed", async () => {
    const w = await setUp();
    await put(w, A, scoped(A, "les_ok000001", ["src/billing/**"]), scoped(A, "les_restr001", ["src/billing/**"], { provenance: { ...lesson(A, "x").provenance, audience: restrictedAudience } }));
    const { api: target } = api(w);
    const answer = await call(target, "a-contrib", "GET", AREAS, undefined, { repo: "demo", folder: "src/billing" });
    expect(answer.ok && answer.body["total"]).toBe(1);
    expect(answer.ok && JSON.stringify(answer.body)).not.toContain("les_restr001");
  });

  it("refuses a malformed query with fixed words that echo nothing", async () => {
    const w = await setUp();
    const { api: target } = api(w);
    for (const query of [{ folder: "src" }, { repo: "demo", folder: "../x" }, { repo: "a b" }, { whole: "1", repo: "demo" }, { whole: "yes" }, { other: "1" }, { repo: "demo", folder: "a b" }]) {
      const answer = await call(target, "a-admin", "GET", AREAS, undefined, query);
      expect(answer, JSON.stringify(query)).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
      if (!answer.ok) expect(answer.message).not.toContain("a b");
    }
  });

  it("is bounded: only the first 400 lessons are counted and the answer says it was cut", async () => {
    const w = await setUp();
    await put(w, A, ...Array.from({ length: 410 }, (_, i) => scoped(A, `les_big${String(i).padStart(5, "0")}`, [`src/m${i % 10}/**`])));
    const { api: target } = api(w);
    const answer = await call(target, "a-admin", "GET", AREAS);
    expect(answer.ok && answer.body["total"]).toBe(400);
    expect(answer.ok && answer.body["partial"]).toBe(true);
  });
});

describe("where Rovara learns from", () => {
  const withKinds = (companyId: string, id: string, kinds: string[], over: Parameters<typeof lessonRecord>[0] = {}) => lesson(companyId, id, { approvals: [person], status: "active", createdAt: w0.now - 86_400_000, updatedAt: w0.now - 86_400_000, ...over, provenance: { ...lesson(companyId, "x").provenance, sourceKinds: kinds as never, ...(over.provenance ?? {}) } });
  const w0 = { now: 1_800_000_000_000 };
  const rowsOf = (answer: Awaited<ReturnType<typeof call>>) => (answer.ok ? (answer.body["sources"] as Array<{ key: string; seen: number; suggested: number; kept: number; paused: boolean; example?: { lessonId: string; title: string } }>) : []);

  it("counts seen, suggested and kept for the last 30 days per source, with one example, and nothing older", async () => {
    const w = await setUp();
    w.world.clock.now = w0.now;
    await put(w, A,
      withKinds(A, "les_sd000001", ["send_back"]), withKinds(A, "les_sd000002", ["close_reason"], { status: "pending", approvals: [] }), withKinds(A, "les_sd000003", ["send_back"], { status: "candidate", approvals: [] }),
      withKinds(A, "les_sd000004", ["send_back"], { status: "rejected", approvals: [] }), withKinds(A, "les_ed000001", ["human_edit"]),
      withKinds(A, "les_old00001", ["send_back"], { createdAt: w0.now - 40 * 86_400_000, updatedAt: w0.now - 40 * 86_400_000 }),
      withKinds(A, "les_wd000001", ["send_back"], { status: "withdrawn" }),
    );
    const { api: target } = api(w);
    const answer = await call(target, "a-contrib", "GET", SOURCES);
    expect(answer.ok && answer.body["windowDays"]).toBe(30);
    const rows = rowsOf(answer);
    expect(rows.map((r) => r.key)).toEqual(["task_decisions", "review_comments", "pr_edits", "remember", "after_merge", "ci"]);
    expect(rows.find((r) => r.key === "task_decisions")).toMatchObject({ seen: 4, suggested: 3, kept: 1, paused: false });
    expect(rows.find((r) => r.key === "pr_edits")).toMatchObject({ seen: 1, suggested: 1, kept: 1 });
    expect(rows.find((r) => r.key === "ci")).toMatchObject({ seen: 0, suggested: 0, kept: 0 });
    expect(rows.find((r) => r.key === "ci")!.example).toBeUndefined();
    expect(rows.find((r) => r.key === "pr_edits")!.example).toEqual({ lessonId: "les_ed000001", title: "Lesson les_ed000001" });
  });

  it("a lesson the reader may not see is not counted and is never the example", async () => {
    const w = await setUp();
    w.world.clock.now = w0.now;
    await put(w, A, withKinds(A, "les_ok000001", ["human_edit"]), withKinds(A, "les_restr001", ["human_edit"], { createdAt: w0.now - 1000, provenance: { ...lesson(A, "x").provenance, sourceKinds: ["human_edit"], audience: restrictedAudience } }));
    const { api: target } = api(w);
    const row = rowsOf(await call(target, "a-contrib", "GET", SOURCES)).find((r) => r.key === "pr_edits")!;
    expect(row).toMatchObject({ seen: 1, suggested: 1, kept: 1 });
    expect(row.example?.lessonId).toBe("les_ok000001");
  });

  it("two companies: each counts its own lessons only", async () => {
    const w = await setUp();
    w.world.clock.now = w0.now;
    await put(w, A, withKinds(A, "les_aaaa0001", ["remembered"]));
    await put(w, B, withKinds(B, "les_bbbb0001", ["remembered"]), withKinds(B, "les_bbbb0002", ["remembered"]));
    const { api: target } = api(w);
    expect(rowsOf(await call(target, "a-admin", "GET", SOURCES)).find((r) => r.key === "remember")).toMatchObject({ seen: 1, example: { lessonId: "les_aaaa0001" } });
    expect(rowsOf(await call(target, "b-admin", "GET", SOURCES)).find((r) => r.key === "remember")?.seen).toBe(2);
  });

  it("only who may set the mode may pause: a project admin and a company admin; a contributor and a script token may not", async () => {
    const w = await setUp();
    const { api: target } = api(w);
    expect((await call(target, "a-contrib", "GET", SOURCES)).ok && (await call(target, "a-contrib", "GET", SOURCES) as { body: Record<string, unknown> }).body["canPause"]).toBe(false);
    expect((await call(target, "a-maint", "GET", SOURCES) as { body: Record<string, unknown> }).body["canPause"]).toBe(true);
    expect(await call(target, "a-contrib", "PUT", `${SOURCES}/ci`, { paused: true })).toMatchObject({ ok: false, code: "FORBIDDEN", message: SOURCE_NEEDS_ADMIN });
    expect(await call(target, "a-maint", "PUT", `${SOURCES}/ci`, { paused: true }, undefined, { scriptToken: { tokenId: "t1" } })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(lessonEvents(w).filter((e) => e.action === "lesson.learning_source_switched")).toEqual([]);
    expect(await call(target, "a-maint", "PUT", `${SOURCES}/ci`, { paused: true })).toMatchObject({ ok: true, body: { key: "ci", paused: true } });
    expect(await call(target, "a-admin", "PUT", `${SOURCES}/ci`, { paused: false })).toMatchObject({ ok: true, body: { key: "ci", paused: false } });
  });

  it("pausing is audited BEFORE the change (no record, no change), is per project, per company and idempotent", async () => {
    const w = await setUp();
    w.world.clock.now = w0.now;
    const { api: target } = api(w);
    const store = w.lessons.get(A)!.runtime.store;
    const flagsOf = async () => Object.keys((await store.flags({ workspaceId: A, project: "payments" })).pausedSources ?? {}).sort();
    const failing = w.lessons.get(A)!.runtime.audit;
    const emit = failing.emit.bind(failing);
    (failing as { emit: typeof failing.emit }).emit = async () => { throw new Error("audit down"); };
    expect(await call(target, "a-maint", "PUT", `${SOURCES}/task_decisions`, { paused: true })).toMatchObject({ ok: false, code: "AUDIT_UNAVAILABLE" });
    expect(await flagsOf()).toEqual([]);
    (failing as { emit: typeof failing.emit }).emit = emit;
    expect(await call(target, "a-maint", "PUT", `${SOURCES}/task_decisions`, { paused: true })).toMatchObject({ ok: true, body: { paused: true } });
    expect(await flagsOf()).toEqual(["kind:close_reason", "kind:send_back"]);
    expect(lessonEvents(w).filter((e) => e.action === "lesson.learning_source_switched")).toHaveLength(1);
    // Again: nothing new is recorded or written.
    expect(await call(target, "a-maint", "PUT", `${SOURCES}/task_decisions`, { paused: true })).toMatchObject({ ok: true, body: { paused: true } });
    expect(lessonEvents(w).filter((e) => e.action === "lesson.learning_source_switched")).toHaveLength(1);
    expect(rowsOf(await call(target, "a-maint", "GET", SOURCES)).find((r) => r.key === "task_decisions")!.paused).toBe(true);
    expect(rowsOf(await call(target, "a-maint", "GET", SOURCES)).find((r) => r.key === "ci")!.paused).toBe(false);
    // Company B's same project name is untouched.
    expect(Object.keys((await w.lessons.get(B)!.runtime.store.flags({ workspaceId: B, project: "payments" })).pausedSources ?? {})).toEqual([]);
    expect(rowsOf(await call(target, "b-admin", "GET", SOURCES)).find((r) => r.key === "task_decisions")!.paused).toBe(false);
    expect(await call(target, "a-maint", "PUT", `${SOURCES}/task_decisions`, { paused: false })).toMatchObject({ ok: true, body: { paused: false } });
    expect(await flagsOf()).toEqual([]);
  });

  it("refuses a body that is not exactly { paused: boolean }", async () => {
    const w = await setUp();
    const { api: target } = api(w);
    for (const body of [{}, { paused: "yes" }, { paused: true, extra: 1 }, "not json"]) expect(await call(target, "a-maint", "PUT", `${SOURCES}/ci`, body), JSON.stringify(body)).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
  });
});
