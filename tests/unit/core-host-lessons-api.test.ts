// Lane LM8 part 1: the Code lessons API for one project of the caller's own company (core-host/lessons-api.ts). Off by default and reads nothing; the company comes only from live membership; two
// companies with the same project name never see or change each other's lessons; only a project or company admin sets the learning mode; every write is audited; an erased person's words never come back.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentXError, LEARNED_CONTEXT_FEATURE, LessonViewSchema, companyScoped, learningModeLockKey, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type OrgRole, type ProjectDefinition, type ProjectRole } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { CORE_ENGINE_ON, buildCoreRegistry, createCoreRuntime } from "../../packages/broker/src/core-host/index.js";
import { createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, CORE_LESSONS_VARIABLE, type CoreLessons } from "../../packages/broker/src/core-host/lessons.js";
import { createLessonsApi, encodeLessonCursor, isLessonsApiPath, LESSONS_OFF, MEASURE_NEEDS_ADMIN, MODE_NEEDS_ADMIN, NO_SUCH_LESSON, NO_SUCH_PROJECT, SUMMARY_NEEDS_ADMIN, TUNING_NEEDS_ADMIN, type LessonsApiCaller, type LessonsApiCompany, type LessonsApiOptions } from "../../packages/broker/src/core-host/lessons-api.js";
import type { HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { documentMeasureSink } from "../../packages/broker/src/lessons/measure.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { DocumentPresetStore, DocumentTier0Settings, writeLearningMode } from "../../packages/broker/src/lessons/document-settings.js";
import type { CoreSwitch } from "../../packages/broker/src/core-host/flags.js";
import { DEV_ROUTES } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { LESSONS_API_ROUTES } from "../../packages/broker/src/aws/developer-routes.js";
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

interface World { world: FakeWorld; lessons: Map<OrgId, CoreLessons>; tasks: Map<OrgId, string>; spaces: Map<OrgId, string>; people: ReturnType<typeof peopleOf>; erased: Set<string> }

async function setUp(env: NodeJS.ProcessEnv = { [CORE_LESSONS_VARIABLE]: "on" }): Promise<World> {
  const world = createFakeWorld();
  setCoreLessonsGate(env);
  const registry = await buildCoreRegistry({ modules: world.modules, context: world.context(), areas: ["flow", "build", "merge"] });
  const lessonsSwitch = readCoreLessonsSwitch(env).value;
  const erased = new Set<string>();
  const people = peopleOf(erased);
  const lessons = new Map<OrgId, CoreLessons>();
  const tasks = new Map<OrgId, string>();
  const spaces = new Map<OrgId, string>();
  for (const companyId of [A, B]) {
    await registerProject(world, companyId);
    const runtime = createCoreRuntime({
      registry, companyId, flags: CORE_ENGINE_ON, callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
    });
    const built = createCoreLessons({ flow: runtime.flow, registry, companyId, lessonsSwitch, people, hostFor: async (id) => lessons.get(id)?.host, now: () => world.clock.now });
    built?.attach();
    if (built !== undefined) lessons.set(companyId, built);
    const principal = localOwnerPrincipal({ companyId });
    const { task } = await runtime.flow.start({ principal, client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint and wrap network calls in withRetry", workflow: true, workflowPath: "QUICK" });
    tasks.set(companyId, task.taskId);
    spaces.set(companyId, task.workspaceId);
  }
  return { world, lessons, tasks, spaces, people, erased };
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
async function call(target: ReturnType<typeof createLessonsApi>, personId: string, method: string, path: string, body?: unknown, query?: Record<string, string> | URLSearchParams, caller: Partial<LessonsApiCaller> = {}) {
  try {
    return { ok: true as const, body: await target.answer({ method, path, ...(query === undefined ? {} : { query: query instanceof URLSearchParams ? query : new URLSearchParams(query) }), ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }, { personId, ...caller }) as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    return { ok: false as const, code: error.code, status: error.statusCode, message: error.message.slice(error.code.length + 2) };
  }
}

const P = "/v1/dev/projects/payments";
describe("lessons weekly route", () => {
  const PATH = `${P}/lessons/weekly`;
  it("returns only the weekly lists, for a person who decides", async () => {
    const w = await setUp();
    const result = await call(api(w).api, "a-admin", "GET", PATH);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.body).sort()).toEqual(["project", "weekly"]);
    if (result.ok) expect(Object.keys(result.body.weekly as object).sort()).toEqual(["needLook", "picks"]);
  });
  it("refuses a member who cannot decide and hides another company's project", async () => {
    const w = await setUp();
    expect(await call(api(w).api, "a-contrib", "GET", PATH)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await call(api(w).api, "a-admin", "GET", "/v1/dev/projects/not-ours/lessons/weekly")).toMatchObject({ ok: false, code: "NOT_FOUND", message: NO_SUCH_PROJECT });
  });
  it("refuses a company admin who is not on the project's roster, before reading the digest", async () => {
    const w = await setUp();
    vi.spyOn(w.people, "onProjectRoster").mockImplementation(async (companyId, project, personId) => personId !== "a-admin" && project === "payments" && (companyId === A || companyId === B));
    expect(await call(api(w).api, "a-admin", "GET", PATH)).toMatchObject({ ok: false, status: 404, message: NO_SUCH_PROJECT });
  });
});
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

const ROUTES: Array<[string, string, unknown?]> = [
  ["GET", `${P}/lessons`], ["GET", `${P}/lessons/weekly`], ["GET", `${P}/lessons/retire-requests`], ["GET", `${P}/lessons/mode`], ["PUT", `${P}/lessons/mode`, { mode: "auto" }],
  ["POST", `${P}/lessons/les_aaaa1111/approve`, { version: 1 }], ["POST", `${P}/lessons/les_aaaa1111/reject`, { version: 1, reason: "wrong" }], ["POST", `${P}/lessons/les_aaaa1111/retire`, { reason: "outdated" }],
  ["POST", `${P}/lessons/les_aaaa1111/retire-request`, {}], ["POST", `${P}/lessons/les_aaaa1111/keep`, {}], ["GET", `${P}/tasks/${randomUUID()}/lessons`],
  ["POST", `${P}/lessons/decisions`, { decisions: [{ lessonId: "les_aaaa1111", version: 1, decision: "keep" }] }], ["POST", `${P}/tasks/${randomUUID()}/lessons/les_aaaa1111/not-helpful`, {}],
  ["POST", `${P}/lessons/mode/trial-offer`, { decision: "accept" }],
  ["GET", `${P}/lessons/weekly-summary`], ["PUT", `${P}/lessons/weekly-summary`, { on: true }], ["GET", `${P}/lessons/measure`], ["GET", `${P}/lessons/tuning`],
  ["GET", `${P}/skills`], ["POST", `${P}/lessons/les_aaaa1111/skill`, {}], ["PUT", `${P}/skills/add-a-queue`, { expectedVersion: 1, description: "d", when: "w", steps: ["one"] }],
  ["POST", `${P}/skills/add-a-queue/approve`, { version: 1 }], ["POST", `${P}/skills/add-a-queue/retire`, {}],
  ["GET", `${P}/lessons/replay`],
];

describe("the paths", () => {
  it("the dev router and the API recognise exactly the same paths, and each lessons row of the route table is one of them (full access only)", () => {
    // The repeats rows are their own API (core-host-lessons-repeats-api.test.ts), and so is the person's Slack switch (core-host-lessons-slack-switch-api.test.ts) and the two knowledge switches (core-host-knowledge-switch-api.test.ts); the POST row on the bare lessons path is the team knowledge read (core-host-knowledge-api.test.ts), answered before this API.
    // The phase 4 rows (graduation, Tidy, draft checks, both-places) are held by core-host-lessons-graduation.test.ts.
    const rows = DEV_ROUTES.filter((route) => route.path.includes("/lessons") && !route.path.endsWith("/repeats") && !route.path.endsWith("/lessons-slack") && !route.path.endsWith("/lessons/local-tools") && !(route.method === "POST" && route.path.endsWith("/lessons")) && !/\/lessons\/(?:graduation$|tidy\/|check-drafts\/|rules\/|\{lessonId\}\/(?:graduate|graduate-later|both-places)$)/u.test(route.path));
    expect(rows.map((route) => `${route.method} ${route.path}`).sort()).toEqual([...[
      "GET /v1/dev/projects/{project}/lessons", "GET /v1/dev/projects/{project}/lessons/weekly", "GET /v1/dev/projects/{project}/lessons/mode", "GET /v1/dev/projects/{project}/lessons/retire-requests", "GET /v1/dev/projects/{project}/tasks/{taskId}/lessons",
      "POST /v1/dev/projects/{project}/lessons/{lessonId}/approve", "POST /v1/dev/projects/{project}/lessons/{lessonId}/reject", "POST /v1/dev/projects/{project}/lessons/{lessonId}/retire", "POST /v1/dev/projects/{project}/lessons/{lessonId}/retire-request",
      "POST /v1/dev/projects/{project}/lessons/{lessonId}/skill", "POST /v1/dev/projects/{project}/lessons/{lessonId}/keep",
      "POST /v1/dev/projects/{project}/lessons/decisions", "POST /v1/dev/projects/{project}/tasks/{taskId}/lessons/{lessonId}/not-helpful",
      "PUT /v1/dev/projects/{project}/lessons/mode", "POST /v1/dev/projects/{project}/lessons/mode/trial-offer", "GET /v1/dev/projects/{project}/lessons/weekly-summary", "PUT /v1/dev/projects/{project}/lessons/weekly-summary", "GET /v1/dev/projects/{project}/lessons/measure", "GET /v1/dev/projects/{project}/lessons/tuning", "GET /v1/dev/projects/{project}/lessons/replay",
      // Lead 4 L4-LP3W: by code area, and where Rovara learns from (their own tests: lessons-by-area/lessons-areas-api.test.ts).
      "GET /v1/dev/projects/{project}/lessons/areas", "GET /v1/dev/projects/{project}/lessons/learning-sources", "PUT /v1/dev/projects/{project}/lessons/learning-sources/{source}",
    ]].sort());
    expect(rows.every((route) => route.requires === "full")).toBe(true);
    const samples = [...rows.map((route) => route.path.replace(/\{[A-Za-z]+\}/g, "x1")), "/v1/dev/projects/x1", "/v1/dev/projects/x1/lessons/", "/v1/dev/projects/x1/lessons/a/b", "/v1/dev/projects/x1/lessons/a/approve/b", "/v1/dev/projects/x1/tasks/t1", "/v1/dev/projects/x1/lessonsx"];
    for (const path of samples) expect(isLessonsApiPath(path), path).toBe(LESSONS_API_ROUTES.test(path));
    expect(rows.every((route) => isLessonsApiPath(route.path.replace(/\{[A-Za-z]+\}/g, "x1")))).toBe(true);
    // The skills rows (L4-AK3): the same paths in the router and the API, full access only.
    const skillRows = DEV_ROUTES.filter((route) => route.path.includes("/skills"));
    expect(skillRows.map((route) => `${route.method} ${route.path}`).sort()).toEqual(["GET /v1/dev/projects/{project}/skills", "POST /v1/dev/projects/{project}/skills/{skill}/approve", "POST /v1/dev/projects/{project}/skills/{skill}/retire", "PUT /v1/dev/projects/{project}/skills/{skill}"].sort());
    expect(skillRows.every((route) => route.requires === "full" && isLessonsApiPath(route.path.replace(/\{[A-Za-z]+\}/g, "x1")))).toBe(true);
    for (const path of [`${P}/skills`, `${P}/skills/a-b`, `${P}/skills/a-b/approve`, `${P}/skills/a-b/retire`, `${P}/skills/Bad`, `${P}/skills/a-b/x`, `${P}/skills/`, `${P}/skills/a-b/approve/c`, `${P}/lessons/x1/skill`, `${P}/lessons/x1/skill/y`]) expect(isLessonsApiPath(path), path).toBe(LESSONS_API_ROUTES.test(path));
  });
});

describe("lessons replay route", () => {
  const PATH = `${P}/lessons/replay`;

  it("uses the default and bounded task counts, and refuses malformed counts or scoped tokens", async () => {
    const w = await setUp();
    const replay = vi.spyOn(w.lessons.get(A)!, "replay").mockResolvedValue({ tasks: [], totals: { changedTasks: 0, lessonsGained: 0, lessonsLost: 0 } });
    const target = api(w).api;
    expect((await call(target, "a-admin", "GET", PATH)).ok).toBe(true);
    expect(replay).toHaveBeenLastCalledWith("payments", 30);
    expect((await call(target, "a-maint", "GET", PATH, undefined, { tasks: "50" })).ok).toBe(true);
    expect(replay).toHaveBeenLastCalledWith("payments", 50);
    for (const value of ["0", "51", "1.5", "x", "01"]) expect((await call(target, "a-admin", "GET", PATH, undefined, { tasks: value })).ok).toBe(false);
    expect((await call(target, "a-admin", "GET", PATH, undefined, undefined, { scriptToken: { tokenId: "sct_aaaaaaaaaaaaaaaaaaaa" } })).ok).toBe(false);
    expect(await call(target, "a-contrib", "GET", PATH)).toMatchObject({ ok: false, code: "FORBIDDEN", status: 403, message: MEASURE_NEEDS_ADMIN });
    expect((await call(target, "a-out", "GET", PATH)).ok).toBe(false);
  });

  it("replays a similarity-eligible task from stored data without embeddings, model calls, or writes", async () => {
    const w = await setUp();
    const taskId = w.tasks.get(A)!;
    const task = await w.world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
    await w.world.store.put({ item: { ...task!, closedAt: new Date(w.world.clock.now).toISOString() } });
    await w.lessons.get(A)!.runtime.store.putManifest({
      taskId, workspaceId: A, project: "payments", stage: "PLAN", round: 1, setVersion: 0, memory: "live", at: w.world.clock.now,
      lessons: [{ id: "les_aaaa1111", version: 1, score: 1, why: "similar", citation: "none" }], bytes: 0,
    });
    await put(w, A, lesson(A, "les_aaaa1111", { status: "active", approvals: [{ approvalId: "approved", by: "a-admin", at: w.world.clock.now, mode: "one" }], title: "Network retry helper", description: "Use withRetry for network calls", body: "Wrap network calls in withRetry from the retry helper." }));
    const writes = [vi.spyOn(w.world.store, "put"), vi.spyOn(w.world.store, "update"), vi.spyOn(w.world.store, "delete"), vi.spyOn(w.world.store, "transact")];
    const embed = vi.fn(async () => [1, 0]);
    const embedder = { embed };
    Object.assign(w.lessons.get(A)!.runtime.load, { embedder });
    const gateway = vi.fn(async () => { throw new Error("replay must not call a model gateway"); });
    Object.assign(w.lessons.get(A)!.runtime, { judgeModel: gateway });
    const result = await w.lessons.get(A)!.replay("payments", 1);
    expect(result.tasks).toEqual([expect.objectContaining({ taskId, stage: "PLAN", actual: ["les_aaaa1111"], replayed: ["les_aaaa1111"], gained: [], lost: [] })]);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(gateway).not.toHaveBeenCalled();
  });
});

describe("the switch", () => {

  it("on:<A>: a person of B gets 'Lessons are off.' and B's lessons are never asked for", async () => {
    const w = await setUp();
    const onlyA: CoreSwitch = { mode: "on-for", companies: [A] };
    const { api: target, lessonsOf } = api(w, { lessonsSwitch: onlyA });
    for (const [method, path, body] of ROUTES) expect(await call(target, "b-admin", method, path, body)).toMatchObject({ ok: false, code: "LESSONS_SWITCHED_OFF", message: LESSONS_OFF });
    expect(lessonsOf).not.toHaveBeenCalled();
    expect((await call(target, "a-admin", "GET", `${P}/lessons/mode`)).ok).toBe(true);
    expect(lessonsOf.mock.calls.map(([id]) => id)).toEqual([A]);
  });

  it("a company whose lessons are not built answers 'Lessons are off.'", async () => {
    const w = await setUp();
    const { api: target } = api(w, { lessonsOf: async () => undefined });
    expect(await call(target, "a-admin", "GET", `${P}/lessons`)).toMatchObject({ ok: false, code: "LESSONS_SWITCHED_OFF" });
  });

  it("a path or method that is not one of the API's is 'route not found'", async () => {
    const w = await setUp();
    const { api: target } = api(w);
    for (const [method, path] of [["DELETE", `${P}/lessons`], ["POST", `${P}/lessons`], ["GET", `${P}/lessons/les_aaaa1111/approve`], ["POST", `${P}/lessons/mode`], ["GET", "/v1/dev/projects"], ["GET", `${P}/lessons/x/y/z`]] as const) {
      expect(await call(target, "a-admin", method, path), `${method} ${path}`).toMatchObject({ ok: false, code: "NOT_FOUND", message: "route not found" });
    }
  });
});

describe("the company comes from live membership only", () => {
  it("a membership reader that throws, answers nothing or answers a malformed record is 'sign in again'", async () => {
    const w = await setUp();
    for (const companyOf of [async () => { throw new Error("down"); }, async () => undefined, async () => ({ companyId: "not-an-org", role: "admin" }), async () => ({ companyId: A, role: "root" })] as LessonsApiOptions["companyOf"][]) {
      const { api: target } = api(w, { companyOf });
      expect(await call(target, "a-admin", "GET", `${P}/lessons`)).toEqual({ ok: false, code: "AUTH_REQUIRED", status: 401, message: "Sign in again." });
    }
  });

  it("two companies, one project name: each person sees and changes only their own company's lessons", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_aaaa1111", { title: "A's lesson" }), lesson(A, "les_apend001", { status: "pending", title: "A pending" }));
    await put(w, B, lesson(B, "les_bbbb2222", { title: "B's lesson" }), lesson(B, "les_bpend001", { status: "pending", title: "B pending" }));
    const { api: target } = api(w);
    const listed = async (personId: string, list = "approved") => {
      const answer = await call(target, personId, "GET", `${P}/lessons`, undefined, { list });
      return answer.ok ? (answer.body["lessons"] as Array<{ id: string }>).map((one) => one.id) : answer;
    };
    expect(await listed("a-contrib")).toEqual(["les_aaaa1111"]);
    expect(await listed("b-contrib")).toEqual(["les_bbbb2222"]);
    expect(await listed("a-admin", "proposed")).toEqual(["les_apend001"]);
    expect(await listed("b-admin", "proposed")).toEqual(["les_bpend001"]);

    // A's admin acting on B's lesson ids finds nothing, and B's lessons are unchanged.
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_bpend001/approve`, { version: 1 })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_bpend001/reject`, { version: 1, reason: "wrong" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_bbbb2222/retire`, { reason: "outdated" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await call(target, "a-contrib", "POST", `${P}/lessons/les_bbbb2222/retire-request`, {})).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const bStore = w.lessons.get(B)!.runtime.store;
    expect((await bStore.get({ workspaceId: B, project: "payments" }, "les_bpend001"))?.status).toBe("pending");
    expect((await bStore.get({ workspaceId: B, project: "payments" }, "les_bbbb2222"))?.status).toBe("active");

    // A's admin sets A's mode: B's stays the default. A body naming another company is refused, not obeyed.
    expect(await call(target, "a-admin", "PUT", `${P}/lessons/mode`, { mode: "off" })).toMatchObject({ ok: true, body: { mode: "off" } });
    expect(await call(target, "a-admin", "PUT", `${P}/lessons/mode`, { mode: "auto", companyId: B })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "b-contrib", "GET", `${P}/lessons/mode`)).toMatchObject({ ok: true, body: { mode: "suggest" } });
    expect(await call(target, "a-contrib", "GET", `${P}/lessons/mode`)).toMatchObject({ ok: true, body: { mode: "off" } });

    // A task of B, read by A's admin, is "no such task".
    expect(await call(target, "a-admin", "GET", `${P}/tasks/${w.tasks.get(B)!}/lessons`)).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
    expect(await call(target, "b-admin", "GET", `${P}/tasks/${w.tasks.get(B)!}/lessons`)).toMatchObject({ ok: true });
    // A query naming another company is refused; it never chooses the company.
    expect(await call(target, "a-admin", "GET", `${P}/lessons`, undefined, { company: B })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    // The audit events are each company's own.
    expect(w.world.audit.filter((event) => event.action === "lesson.mode_changed").map((event) => event.companyId)).toEqual([A]);
    expect(w.people.asked.every((id) => id === A || id === B)).toBe(true);
  });

  it("lessons handed back for another company than the member's are refused before anything is read", async () => {
    const w = await setUp();
    await put(w, B, lesson(B, "les_bbbb2222"));
    const { api: target } = api(w, { lessonsOf: async () => w.lessons.get(B) });
    for (const [method, path, body] of ROUTES) expect(await call(target, "a-admin", method, path, body), `${method} ${path}`).toMatchObject({ ok: false, code: "RUNTIME_UNAVAILABLE" });
    expect(lessonEvents(w)).toEqual([]);
  });

  it("a person not on the project's roster, and a project the company does not have, get the same 'No such project.'", async () => {
    const w = await setUp();
    const { api: target } = api(w);
    expect(await call(target, "a-out", "GET", `${P}/lessons`)).toEqual({ ok: false, code: "NOT_FOUND", status: 404, message: NO_SUCH_PROJECT });
    expect(await call(target, "a-admin", "GET", "/v1/dev/projects/ledger/lessons")).toEqual({ ok: false, code: "NOT_FOUND", status: 404, message: NO_SUCH_PROJECT });
    expect(await call(target, "a-admin", "GET", "/v1/dev/projects/%3Cscript%3E/lessons")).toEqual({ ok: false, code: "NOT_FOUND", status: 404, message: NO_SUCH_PROJECT });
  });
});

describe("lists and paging", () => {

  it("pages through a list newest change first with an opaque cursor, and refuses a cursor of another list or a malformed one without echoing it", async () => {
    const w = await setUp();
    await put(w, A, ...[1, 2, 3, 4, 5].map((n) => lesson(A, `les_page000${n}`, { updatedAt: n * 10 })));
    const { api: target } = api(w);
    const first = await call(target, "a-contrib", "GET", `${P}/lessons`, undefined, { list: "approved", limit: "2" });
    expect(first.ok && (first.body["lessons"] as Array<{ id: string }>).map((one) => one.id)).toEqual(["les_page0005", "les_page0004"]);
    expect(first.ok && first.body["canDecide"]).toBe(false);
    const cursor = first.ok ? first.body["next"] as string : "";
    expect(cursor).toBe(encodeLessonCursor({ list: "approved", updatedAt: 40, id: "les_page0004" }));
    const second = await call(target, "a-contrib", "GET", `${P}/lessons`, undefined, { list: "approved", limit: "2", cursor });
    expect(second.ok && (second.body["lessons"] as Array<{ id: string }>).map((one) => one.id)).toEqual(["les_page0003", "les_page0002"]);
    const third = await call(target, "a-contrib", "GET", `${P}/lessons`, undefined, { list: "approved", limit: "2", cursor: second.ok ? second.body["next"] as string : "" });
    expect(third.ok && (third.body["lessons"] as Array<{ id: string }>).map((one) => one.id)).toEqual(["les_page0001"]);
    expect(third.ok && "next" in third.body).toBe(false);

    const wrong = await call(target, "a-admin", "GET", `${P}/lessons`, undefined, { list: "retired", cursor });
    expect(wrong).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    const canary = "CANARY<b>";
    for (const query of [{ cursor: canary }, { cursor: Buffer.from(`["approved",1,"${canary}"]`).toString("base64url") }, { limit: "0" }, { limit: "51" }, { limit: "101" }, { list: canary }, { other: canary }]) {
      const answer = await call(target, "a-contrib", "GET", `${P}/lessons`, undefined, query);
      expect(answer, JSON.stringify(query)).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
      expect(JSON.stringify(answer)).not.toContain("CANARY");
    }
  });

  it("the proposed and retired lists are for the people who decide; a reader sees approved only", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_apend001", { status: "pending" }), lesson(A, "les_aret0001", { status: "retired" }));
    const { api: target } = api(w);
    for (const list of ["proposed", "retired"]) {
      expect(await call(target, "a-contrib", "GET", `${P}/lessons`, undefined, { list })).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect((await call(target, "a-maint", "GET", `${P}/lessons`, undefined, { list })).ok).toBe(true);
    }
    const retired = await call(target, "a-admin", "GET", `${P}/lessons`, undefined, { list: "retired" });
    expect(retired.ok && (retired.body["lessons"] as Array<{ id: string }>).map((one) => one.id)).toEqual(["les_aret0001"]);
  });
});

describe("decisions on one lesson", () => {
  it("approve takes the version read, goes live, and is audited; a stale version is a conflict; a reader cannot approve", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_apend001", { status: "pending" }));
    const { api: target } = api(w);
    expect(await call(target, "a-contrib", "POST", `${P}/lessons/les_apend001/approve`, { version: 1 })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await call(target, "a-maint", "POST", `${P}/lessons/les_apend001/approve`, { version: 7 })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(await call(target, "a-maint", "POST", `${P}/lessons/les_apend001/approve`, {})).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    const approved = await call(target, "a-maint", "POST", `${P}/lessons/les_apend001/approve`, { version: 1 });
    expect(approved).toMatchObject({ ok: true, body: { project: "payments", lessonId: "les_apend001", status: "active" } });
    expect(w.world.audit.filter((event) => event.companyId === A).map((event) => event.action)).toEqual(expect.arrayContaining(["lesson.approved"]));
    expect(w.world.audit.every((event) => event.actor.id !== "a-contrib")).toBe(true);
  });

  it("Keep (single approve and the batch) on a held lesson clears its review flag in the approval itself; a reader's try and another company's same-named lesson change nothing", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_hold0001", { status: "pending", reviewRequired: true }), lesson(A, "les_hold0002", { status: "pending", reviewRequired: true }), lesson(A, "les_hold0003", { status: "pending", reviewRequired: true, contradictsWith: "les_aaaa1111" }));
    await put(w, B, lesson(B, "les_hold0001", { status: "pending", reviewRequired: true }));
    const { api: target } = api(w);
    const store = w.lessons.get(A)!.runtime.store;
    const key = { workspaceId: A, project: "payments" };
    expect(await call(target, "a-contrib", "POST", `${P}/lessons/les_hold0001/approve`, { version: 1 })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await store.get(key, "les_hold0001")).toMatchObject({ status: "pending", reviewRequired: true });
    expect(await call(target, "a-maint", "POST", `${P}/lessons/les_hold0001/approve`, { version: 1 })).toMatchObject({ ok: true, body: { status: "active" } });
    const batch = await call(target, "a-maint", "POST", `${P}/lessons/decisions`, { decisions: [{ lessonId: "les_hold0002", version: 1, decision: "keep" }, { lessonId: "les_hold0003", version: 1, decision: "keep" }] });
    expect(batch.ok && (batch.body["results"] as Array<Record<string, unknown>>).map((r) => r["status"])).toEqual(["active", "active"]);
    for (const id of ["les_hold0001", "les_hold0002", "les_hold0003"]) {
      const stored = (await store.get(key, id))!;
      expect(stored.status).toBe("active");
      expect(stored.reviewRequired).toBeUndefined();
    }
    // The lesson that still contradicts another keeps that flag (it stays out of the agent's pull set until settled).
    expect((await store.get(key, "les_hold0003"))!.contradictsWith).toBe("les_aaaa1111");
    expect(await w.lessons.get(B)!.runtime.store.get({ workspaceId: B, project: "payments" }, "les_hold0001")).toMatchObject({ status: "pending", reviewRequired: true, approvals: [] });
  });

  it("reject takes a fixed reason (never a person's text); retire answers the lesson's retire request", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_apend001", { status: "pending" }), lesson(A, "les_aaaa1111"));
    const { api: target } = api(w);
    const free = await call(target, "a-maint", "POST", `${P}/lessons/les_apend001/reject`, { version: 1, reason: "CANARY my own words" });
    expect(free).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(JSON.stringify(free)).not.toContain("CANARY");
    expect(await call(target, "a-maint", "POST", `${P}/lessons/les_apend001/reject`, { version: 1, reason: "duplicate" })).toMatchObject({ ok: true, body: { status: "rejected" } });
    const store = w.lessons.get(A)!.runtime.store;
    expect((await store.get({ workspaceId: A, project: "payments" }, "les_apend001"))?.rejectedReason).toBe("duplicate");

    expect(await call(target, "a-contrib", "POST", `${P}/lessons/les_aaaa1111/retire-request`, {})).toMatchObject({ ok: true, body: { requested: true } });
    expect(await call(target, "a-contrib", "POST", `${P}/lessons/les_aaaa1111/retire`, { reason: "outdated" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_aaaa1111/retire`, { reason: "outdated" })).toMatchObject({ ok: true, body: { status: "retired" } });
    expect((await store.get({ workspaceId: A, project: "payments" }, "les_aaaa1111"))?.status).toBe("retired");
    expect(await call(target, "a-admin", "GET", `${P}/lessons/retire-requests`)).toMatchObject({ ok: true, body: { requests: [] } });
  });
});

describe("retire requests", () => {
  it("anyone on the project asks; the people who decide see each open request with the asker named live; an erased asker's request never comes back", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_aaaa1111"), lesson(A, "les_aaaa2222"));
    const { api: target } = api(w);
    expect(await call(target, "a-contrib", "POST", `${P}/lessons/les_aaaa1111/retire-request`, {})).toMatchObject({ ok: true });
    expect(await call(target, "a-maint", "POST", `${P}/lessons/les_aaaa2222/retire-request`, {})).toMatchObject({ ok: true });
    expect(w.world.audit.filter((event) => event.action === "lesson.retire_requested").map((event) => event.actor.id).sort()).toEqual(["a-contrib", "a-maint"]);
    expect(await call(target, "a-contrib", "GET", `${P}/lessons/retire-requests`)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const listed = await call(target, "a-admin", "GET", `${P}/lessons/retire-requests`);
    expect(listed.ok && (listed.body["requests"] as Array<{ lessonId: string; by: string }>).map((r) => [r.lessonId, r.by]).sort()).toEqual([["les_aaaa1111", "Name a-contrib"], ["les_aaaa2222", "Name a-maint"]]);
    w.erased.add("a-contrib");
    const after = await call(target, "a-admin", "GET", `${P}/lessons/retire-requests`);
    expect(after.ok && (after.body["requests"] as Array<{ lessonId: string }>).map((r) => r.lessonId)).toEqual(["les_aaaa2222"]);
    expect(JSON.stringify(after)).not.toContain("a-contrib");
  });

  it("a request that cannot be audited is not saved", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_aaaa1111"));
    const real = w.lessons.get(A)!;
    const failing = { emit: async () => { throw new Error("ledger down"); } };
    const { api: target } = api(w, { lessonsOf: async (companyId) => (companyId === A ? { ...real, runtime: { ...real.runtime, audit: failing } } : undefined) });
    expect(await call(target, "a-contrib", "POST", `${P}/lessons/les_aaaa1111/retire-request`, {})).toMatchObject({ ok: false, code: "AUDIT_UNAVAILABLE" });
    expect(await call(target, "a-maint", "PUT", `${P}/lessons/mode`, { mode: "off" })).toMatchObject({ ok: false, code: "AUDIT_UNAVAILABLE" });
    const plain = api(w).api;
    expect(await call(plain, "a-admin", "GET", `${P}/lessons/retire-requests`)).toMatchObject({ ok: true, body: { requests: [] } });
    expect(await call(plain, "a-admin", "GET", `${P}/lessons/mode`)).toMatchObject({ ok: true, body: { mode: "suggest" } });
  });
});

describe("the Keep answer to a quiet lesson (L4-LP12b)", () => {
  const key = (companyId: OrgId) => ({ workspaceId: companyId, project: "payments" });
  /** A lesson that was due to fade soon and has a question standing on it (the nightly sweep's `askedAt`). */
  async function asked(w: World, companyId: OrgId, id: string, over: Parameters<typeof lesson>[2] = {}): Promise<void> {
    await put(w, companyId, lesson(companyId, id, { expiresAt: w.world.clock.now + 86_400_000, ...over }));
    expect(await w.lessons.get(companyId)!.runtime.evidence.writeFade(key(companyId), id, { renewals: 1, askedAt: w.world.clock.now - 86_400_000 }, w.world.clock.now)).toBe(true);
  }
  const expiryOf = async (w: World, companyId: OrgId, id: string) => (await w.lessons.get(companyId)!.runtime.store.get(key(companyId), id))!.expiresAt;

  it("the people who decide (a project maintainer, a company admin) renew it for a window, audited by who pressed; the card's question is gone afterwards", async () => {
    const w = await setUp();
    await asked(w, A, "les_quiet001");
    await asked(w, A, "les_quiet002");
    const { api: target } = api(w);
    const now = () => w.world.clock.now;
    expect(await call(target, "a-maint", "POST", `${P}/lessons/les_quiet001/keep`, {})).toEqual({ ok: true, body: { project: "payments", lessonId: "les_quiet001", kept: true } });
    expect(await expiryOf(w, A, "les_quiet001")).toBe(now() + 90 * 86_400_000);
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_quiet002/keep`, {})).toMatchObject({ ok: true, body: { kept: true } });
    expect(w.world.audit.filter((event) => event.action === "lesson.kept").map((event) => [event.actor.id, event.subject?.id])).toEqual([["a-maint", "les_quiet001"], ["a-admin", "les_quiet002"]]);
    expect(await w.lessons.get(A)!.runtime.evidence.readFade(key(A), "les_quiet001")).toMatchObject({ renewals: 0 });
    // The question is answered: pressing it again is a clear refusal, and the lesson is as the first answer left it.
    expect(await call(target, "a-maint", "POST", `${P}/lessons/les_quiet001/keep`, {})).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(await expiryOf(w, A, "les_quiet001")).toBe(now() + 90 * 86_400_000);
  });

  it("a contributor, an outsider and a script token cannot: refused with fixed words, and nothing changes or is recorded", async () => {
    const w = await setUp();
    await asked(w, A, "les_quiet001");
    const { api: target } = api(w);
    const before = await expiryOf(w, A, "les_quiet001");
    expect(await call(target, "a-contrib", "POST", `${P}/lessons/les_quiet001/keep`, {})).toMatchObject({ ok: false, code: "FORBIDDEN", message: "Only a maintainer of this project, or an admin, can decide lessons." });
    expect(await call(target, "a-out", "POST", `${P}/lessons/les_quiet001/keep`, {})).toMatchObject({ ok: false, code: "NOT_FOUND", message: NO_SUCH_PROJECT });
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_quiet001/keep`, {}, undefined, { scriptToken: { tokenId: "t1" } })).toMatchObject({ ok: false, code: "FORBIDDEN", message: "A script token cannot do that." });
    expect(await call(target, "nobody", "POST", `${P}/lessons/les_quiet001/keep`, {})).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
    expect(await expiryOf(w, A, "les_quiet001")).toBe(before);
    expect(w.world.audit.filter((event) => event.action === "lesson.kept")).toEqual([]);
  });

  it("no question, no Keep: a lesson nobody asked about, and one that is gone, are refused the same clear way", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_aaaa1111", { expiresAt: w.world.clock.now + 86_400_000 }));
    const { api: target } = api(w);
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_aaaa1111/keep`, {})).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_gone0001/keep`, {})).toMatchObject({ ok: false, code: "NOT_FOUND", message: NO_SUCH_LESSON });
    expect(await expiryOf(w, A, "les_aaaa1111")).toBe(w.world.clock.now + 86_400_000);
  });

  it("a ledger that cannot be written changes nothing", async () => {
    const w = await setUp();
    await asked(w, A, "les_quiet001");
    const real = w.lessons.get(A)!;
    const failing = { emit: async () => { throw new Error("ledger down"); } };
    const { api: target } = api(w, { lessonsOf: async (companyId) => (companyId === A ? { ...real, runtime: { ...real.runtime, routes: { ...real.runtime.routes, audit: failing }, audit: failing } } : undefined) });
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_quiet001/keep`, {})).toMatchObject({ ok: false, code: "AUDIT_UNAVAILABLE" });
    expect(await expiryOf(w, A, "les_quiet001")).toBe(w.world.clock.now + 86_400_000);
    expect(await real.runtime.evidence.readFade(key(A), "les_quiet001")).toMatchObject({ renewals: 1, askedAt: expect.any(Number) as number });
  });
});

describe("the learning mode", () => {
  it("defaults to suggest; only a project admin or a company owner or admin sets it; each change is audited", async () => {
    const w = await setUp();
    const { api: target } = api(w);
    expect(await call(target, "a-contrib", "GET", `${P}/lessons/mode`)).toEqual({ ok: true, body: { project: "payments", mode: "suggest", effective: "suggest", lockedByCompany: false, canChange: false } });
    expect(await call(target, "a-maint", "GET", `${P}/lessons/mode`)).toMatchObject({ ok: true, body: { canChange: true } });
    expect(await call(target, "a-contrib", "PUT", `${P}/lessons/mode`, { mode: "auto" })).toEqual({ ok: false, code: "FORBIDDEN", status: 403, message: MODE_NEEDS_ADMIN });
    expect(await call(target, "a-contrib", "GET", `${P}/lessons/mode`)).toMatchObject({ ok: true, body: { mode: "suggest" } });
    expect(lessonEvents(w)).toEqual([]);
    expect(await call(target, "a-maint", "PUT", `${P}/lessons/mode`, { mode: "auto" })).toMatchObject({ ok: true, body: { mode: "auto", canChange: true } });
    expect(await call(target, "a-admin", "PUT", `${P}/lessons/mode`, { mode: "off" })).toMatchObject({ ok: true, body: { mode: "off" } });
    expect(await call(target, "a-contrib", "GET", `${P}/lessons/mode`)).toMatchObject({ ok: true, body: { mode: "off", effective: "off" } });
    const changes = w.world.audit.filter((event) => event.action === "lesson.mode_changed");
    expect(changes.map((event) => [event.actor.id, event.details])).toEqual([
      ["a-maint", expect.objectContaining({ fromMode: "suggest", toMode: "auto" })],
      ["a-admin", expect.objectContaining({ fromMode: "auto", toMode: "off" })],
    ]);
    expect(JSON.stringify(changes)).not.toContain("payments");
    for (const mode of ["collect", "On", "", 1]) expect(await call(target, "a-admin", "PUT", `${P}/lessons/mode`, { mode })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-admin", "PUT", `${P}/lessons/mode`, "not json")).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
  });

  it("a project role that cannot be read is not admin", async () => {
    const w = await setUp();
    const { api: target } = api(w, { projectRole: async () => { throw new Error("down"); } });
    expect(await call(target, "a-maint", "PUT", `${P}/lessons/mode`, { mode: "off" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await call(target, "a-admin", "PUT", `${P}/lessons/mode`, { mode: "off" })).toMatchObject({ ok: true });
  });
});

describe("lessons used by a task", () => {
  it("adds only the task's own company and project wiki-use row to the existing read", async () => {
    const w = await setUp();
    const seen: Array<[OrgId, string, string]> = [];
    const { api: target } = api(w, { wikiTaskUse: async (companyId, project, taskId) => { seen.push([companyId, project, taskId]); return { given: ["overview"], read: ["overview"] }; } });
    const taskId = w.tasks.get(A)!;
    expect(await call(target, "a-contrib", "GET", `${P}/tasks/${taskId}/lessons`)).toMatchObject({ ok: true, body: { wikiUse: { given: ["overview"], read: ["overview"] } } });
    expect(seen).toEqual([[A, "payments", taskId]]);
    expect(await call(target, "a-contrib", "GET", `${P.replace("payments", "ledger")}/tasks/${taskId}/lessons`)).toMatchObject({ ok: false, code: "NOT_FOUND", message: NO_SUCH_PROJECT });
    expect(seen).toHaveLength(1);
  });

  it("answers for a task of the project, to the roster; another project or a malformed id is 'no such task'", async () => {
    const w = await setUp();
    const { api: target } = api(w);
    const taskId = w.tasks.get(A)!;
    expect(await call(target, "a-contrib", "GET", `${P}/tasks/${taskId}/lessons`)).toEqual({ ok: true, body: { project: "payments", taskId, lessons: [] } });
    expect(await call(target, "a-contrib", "GET", `${P}/tasks/not-a-task/lessons`)).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
    expect(await call(target, "a-out", "GET", `${P}/tasks/${taskId}/lessons`)).toEqual({ ok: false, code: "NOT_FOUND", status: 404, message: NO_SUCH_PROJECT });
  });

  it("does not expose wiki-use page ids to an off-roster task owner", async () => {
    const w = await setUp();
    const real = w.lessons.get(A)!;
    const taskId = w.tasks.get(A)!;
    const wikiTaskUse = vi.fn(async () => ({ given: ["overview"], read: ["overview"] }));
    const { api: target } = api(w, {
      lessonsOf: async (companyId) => companyId === A ? { ...real, readTask: async () => ({ companyId: A, project: "payments", developerId: "a-out" }) } : undefined,
      wikiTaskUse,
    });
    expect(await call(target, "a-out", "GET", `${P}/tasks/${taskId}/lessons`)).toMatchObject({ ok: true, body: { lessons: [] } });
    expect(wikiTaskUse).not.toHaveBeenCalled();
  });
});

describe("the inbox batch (DEC 231: Suggest, a person approves every lesson, a weekly Keep / Edit / Drop row)", () => {
  it("lists the proposed lessons created since a time, with each lesson's expiry and use counts", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_old00001", { status: "pending", createdAt: 100, updatedAt: 100 }), lesson(A, "les_new00001", { status: "pending", createdAt: 500, updatedAt: 500, expiresAt: 9_000, counters: { loaded: 14, helpful: 3, harmful: 1, citationStale: 0 } }));
    const { api: target } = api(w);
    const batch = await call(target, "a-maint", "GET", `${P}/lessons`, undefined, { list: "proposed", since: "300" });
    expect(batch.ok && (batch.body["lessons"] as Array<{ id: string }>).map((one) => one.id)).toEqual(["les_new00001"]);
    expect(batch.ok && (batch.body["lessons"] as Array<Record<string, unknown>>)[0]).toMatchObject({ expiresAt: 9_000, createdAt: 500, version: 1, counters: { loaded: 14, helpful: 3, harmful: 1 }, canApprove: true, canReject: true });
    expect(await call(target, "a-maint", "GET", `${P}/lessons`, undefined, { list: "proposed", since: "-1" })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
  });

  it("decides a batch in one call (Keep, Keep with an edit, Drop), each answering for itself, each audited; another company's lesson in the batch is not found and changes nothing", async () => {
    const w = await setUp();
    await put(w, A, ...["les_keep0001", "les_edit0001", "les_drop0001"].map((id) => lesson(A, id, { status: "pending" })));
    await put(w, B, lesson(B, "les_bpend001", { status: "pending" }));
    const { api: target } = api(w);
    const answer = await call(target, "a-maint", "POST", `${P}/lessons/decisions`, { decisions: [
      { lessonId: "les_keep0001", version: 1, decision: "keep" },
      { lessonId: "les_edit0001", version: 1, decision: "keep", edit: { title: "Use withRetry", description: "", body: "Wrap network calls in withRetry from src/retry." } },
      { lessonId: "les_drop0001", version: 1, decision: "drop", reason: "not_useful" },
      { lessonId: "les_bpend001", version: 1, decision: "keep" },
    ] });
    expect(answer.ok).toBe(true);
    const results = answer.ok ? answer.body["results"] as Array<Record<string, unknown>> : [];
    expect(results.map((r) => [r["lessonId"], r["ok"], r["status"] ?? r["code"]])).toEqual([
      ["les_keep0001", true, "active"], ["les_edit0001", true, "pending"], ["les_drop0001", true, "rejected"], ["les_bpend001", false, "NOT_FOUND"],
    ]);
    const store = w.lessons.get(A)!.runtime.store;
    const edited = await store.get({ workspaceId: A, project: "payments" }, "les_edit0001");
    // An edit is new text: the library keeps it waiting for the approval its tier needs on that text (the library's rule, unchanged here).
    expect(edited?.title).toBe("Use withRetry");
    expect(edited?.provenance.editors).toEqual(["a-maint"]);
    expect((await w.lessons.get(B)!.runtime.store.get({ workspaceId: B, project: "payments" }, "les_bpend001"))?.status).toBe("pending");
    expect(lessonEvents(w).filter((event) => event.companyId === A && event.action === "lesson.approved").length).toBeGreaterThanOrEqual(2);
    expect(lessonEvents(w).every((event) => event.companyId === A)).toBe(true);
    // A reader's batch decides nothing; a malformed batch (free-text reason, a repeated lesson, too many) is refused whole.
    const reader = await call(target, "a-contrib", "POST", `${P}/lessons/decisions`, { decisions: [{ lessonId: "les_keep0001", version: 2, decision: "drop", reason: "wrong" }] });
    expect(reader.ok && (reader.body["results"] as Array<Record<string, unknown>>)[0]).toMatchObject({ ok: false, code: "FORBIDDEN" });
    for (const decisions of [[{ lessonId: "les_keep0001", version: 1, decision: "drop", reason: "CANARY words" }], [{ lessonId: "les_keep0001", version: 1, decision: "keep" }, { lessonId: "les_keep0001", version: 1, decision: "keep" }], Array.from({ length: 21 }, (_, i) => ({ lessonId: `les_many${String(i).padStart(4, "0")}`, version: 1, decision: "keep" })), []]) {
      const refused = await call(target, "a-maint", "POST", `${P}/lessons/decisions`, { decisions });
      expect(refused).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
      expect(JSON.stringify(refused)).not.toContain("CANARY");
    }
  });

  it("approve on its own also takes an edit", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_apend001", { status: "pending" }));
    const { api: target } = api(w);
    expect(await call(target, "a-maint", "POST", `${P}/lessons/les_apend001/approve`, { version: 1, edit: { title: "", description: "", body: "x" } })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-maint", "POST", `${P}/lessons/les_apend001/approve`, { version: 1, edit: { title: "Edited", description: "", body: "Edited body text." } })).toMatchObject({ ok: true, body: { lessonId: "les_apend001" } });
    expect((await w.lessons.get(A)!.runtime.store.get({ workspaceId: A, project: "payments" }, "les_apend001"))?.title).toBe("Edited");
  });
});

describe("not helpful", () => {
  it("a person on the project marks a lesson the task was given; once per person; a lesson the task was not given, another company's task or an off-roster person is not found", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_aaaa1111"), lesson(A, "les_aaaa2222"));
    const taskId = w.tasks.get(A)!;
    const store = w.lessons.get(A)!.runtime.store;
    await store.putManifest({ taskId, workspaceId: A, project: "payments", stage: "PLAN", round: 1, setVersion: await store.setVersion({ workspaceId: A, project: "payments" }), memory: "live", at: 1, lessons: [{ id: "les_aaaa1111", version: 1, score: 1, why: "scope", citation: "none" }], bytes: 10 });
    const { api: target } = api(w);
    const path = (id: string, task = taskId) => `${P}/tasks/${task}/lessons/${id}/not-helpful`;
    expect(await call(target, "a-out", "POST", path("les_aaaa1111"), {})).toMatchObject({ ok: false, code: "NOT_FOUND", message: NO_SUCH_PROJECT });
    expect(await call(target, "a-contrib", "POST", path("les_aaaa2222"), {})).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await call(target, "b-contrib", "POST", path("les_aaaa1111"), {})).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
    expect(await call(target, "a-contrib", "POST", path("les_aaaa1111"), { extra: 1 })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-contrib", "POST", path("les_aaaa1111"), {})).toEqual({ ok: true, body: { project: "payments", taskId, lessonId: "les_aaaa1111", marked: "not_helpful" } });
    expect((await store.get({ workspaceId: A, project: "payments" }, "les_aaaa1111"))?.counters.harmful).toBe(1);
    expect(await call(target, "a-contrib", "POST", path("les_aaaa1111"), {})).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("used in N tasks", () => {
  it("each listed lesson says how many distinct tasks it was given to, from this company's use rows only", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_aaaa1111"), lesson(A, "les_aaaa2222"));
    await put(w, B, lesson(B, "les_aaaa1111"));
    const at = w.world.clock.now;
    const row = (companyId: OrgId, lessonId: string, taskId: string) => ({ item: { pk: companyScoped(companyId, `LESSON_USE#payments#${lessonId}`), sk: taskId, entityType: "LESSON_USE", taskId, title: "t", at } });
    for (const taskId of ["t-1", "t-2", "t-2"]) await w.world.store.put(row(A, "les_aaaa1111", taskId));
    for (const taskId of ["b-1", "b-2", "b-3", "b-4"]) await w.world.store.put(row(B, "les_aaaa1111", taskId));
    const { api: target } = api(w);
    const usedOf = async (personId: string) => {
      const answer = await call(target, personId, "GET", `${P}/lessons`);
      if (!answer.ok) return answer;
      expect(answer.body["usedInIncomplete"]).toBeUndefined();
      return Object.fromEntries((answer.body["lessons"] as Array<{ id: string; usedInTasks?: unknown; usedInTasksMore?: unknown }>).map((one) => [one.id, one.usedInTasksMore === undefined ? one.usedInTasks : [one.usedInTasks, one.usedInTasksMore]]));
    };
    expect(await usedOf("a-contrib")).toEqual({ les_aaaa1111: 2, les_aaaa2222: 0 });
    expect(await usedOf("b-contrib")).toEqual({ les_aaaa1111: 4 });
    // Past the cap the number is the cap and the answer says there were more.
    for (let i = 0; i < 501; i += 1) await w.world.store.put(row(A, "les_aaaa2222", `m-${String(i)}`));
    expect(await usedOf("a-contrib")).toEqual({ les_aaaa1111: 2, les_aaaa2222: [500, true] });
    // The answer still matches the contract (strict) with the count in it.
    const answer = await call(target, "a-contrib", "GET", `${P}/lessons`);
    for (const one of (answer.ok ? answer.body["lessons"] : []) as unknown[]) expect(LessonViewSchema.safeParse(one).success).toBe(true);
  });

  it("a count that cannot be read is left out and the page says so; the list itself still answers", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_aaaa1111"));
    const documents = w.lessons.get(A)!.runtime.documents;
    const query = documents.query.bind(documents);
    const spy = vi.spyOn(documents, "query").mockImplementation(async (request) => {
      if (request.pk.includes("LESSON_USE#")) throw new Error("down");
      return await query(request);
    });
    const { api: target } = api(w);
    const answer = await call(target, "a-contrib", "GET", `${P}/lessons`);
    spy.mockRestore();
    expect(answer).toMatchObject({ ok: true, body: { usedInIncomplete: true } });
    expect((answer.ok ? (answer.body["lessons"] as Array<Record<string, unknown>>) : [])[0]).not.toHaveProperty("usedInTasks");
  });
});

describe("earned trust (DEC 231): the offer to let low-risk lessons go live on trial", () => {
  const DAY = 86_400_000;
  const OFFER = `${P}/lessons/mode/trial-offer`;
  /** `approved` lessons a person of the company approved now, and `dropped` lessons a person rejected now. */
  async function decide(w: World, companyId: OrgId, approved: number, dropped: number, over: { by?: string; mode?: "one" | "auto" | "trial"; at?: number } = {}): Promise<void> {
    const at = over.at ?? w.world.clock.now;
    const by = over.by ?? (companyId === A ? "a-maint" : "b-maint");
    const kept = Array.from({ length: approved }, (_, i) => lesson(companyId, `les_kept${String(i).padStart(4, "0")}`, { status: "active", approvals: [{ approvalId: `ap${String(i)}`, by, at, mode: over.mode ?? "one" }], updatedAt: at }));
    const gone = Array.from({ length: dropped }, (_, i) => lesson(companyId, `les_drop${String(i).padStart(4, "0")}`, { status: "rejected", approvals: [], pendingExpiresAt: at, updatedAt: at }));
    await put(w, companyId, ...kept, ...gone);
  }
  const offerOf = async (target: ReturnType<typeof createLessonsApi>, personId: string) => {
    const answer = await call(target, personId, "GET", `${P}/lessons/mode`);
    return answer.ok ? answer.body["trialOffer"] : answer;
  };

  it("offered after 10 approvals with few drops, to people who may change the mode only; 9 approvals, or too many drops, is no offer", async () => {
    const w = await setUp();
    await decide(w, A, 10, 2);
    const { api: target } = api(w);
    expect(await offerOf(target, "a-admin")).toEqual({ approvals: 10, drops: 2, since: w.world.clock.now - 90 * DAY });
    expect(await offerOf(target, "a-maint")).toMatchObject({ approvals: 10, drops: 2 });
    expect(await offerOf(target, "a-contrib")).toBeUndefined();
    await decide(w, A, 0, 3);
    expect(await offerOf(target, "a-admin")).toBeUndefined();
    const nine = await setUp();
    await decide(nine, A, 9, 0);
    expect(await offerOf(api(nine).api, "a-admin")).toBeUndefined();
  });

  it("no offer unless the project is in Suggest by its own choice, under no company lock and on the Standard preset", async () => {
    const w = await setUp();
    await decide(w, A, 10, 0);
    const { api: target } = api(w);
    expect(await call(target, "a-admin", "PUT", `${P}/lessons/mode`, { mode: "off" })).toMatchObject({ ok: true });
    expect(await offerOf(target, "a-admin")).toBeUndefined();
    const locked = await setUp();
    await decide(locked, A, 10, 0);
    await locked.world.store.put({ item: { ...learningModeLockKey(A), entityType: "LESSON_MODE", mode: "collect", updatedAt: 1 } });
    expect(await offerOf(api(locked).api, "a-admin")).toBeUndefined();
    // The project chose auto but a company lock holds it at Suggest: the project's own choice is not Suggest, so there is nothing to offer.
    const heldBack = await setUp();
    await decide(heldBack, A, 10, 0);
    expect(await call(api(heldBack).api, "a-admin", "PUT", `${P}/lessons/mode`, { mode: "auto" })).toMatchObject({ ok: true });
    await heldBack.world.store.put({ item: { ...learningModeLockKey(A), entityType: "LESSON_MODE", mode: "suggest", updatedAt: 1 } });
    expect(await call(api(heldBack).api, "a-admin", "GET", `${P}/lessons/mode`)).toMatchObject({ ok: true, body: { mode: "auto", effective: "suggest" } });
    expect(await offerOf(api(heldBack).api, "a-admin")).toBeUndefined();
    const regulated = await setUp();
    await decide(regulated, A, 10, 0);
    await new DocumentPresetStore(regulated.world.store).write({ kind: "company", workspaceId: A }, "regulated", { by: "a-admin", at: 1 }, "standard");
    expect(await offerOf(api(regulated).api, "a-admin")).toBeUndefined();
  });

  it("accept: only who may change the mode, never a script token; audited before the change; the mode becomes auto and the offer is gone", async () => {
    const w = await setUp();
    await decide(w, A, 10, 0);
    const { api: target } = api(w);
    expect(await call(target, "a-contrib", "POST", OFFER, { decision: "accept" })).toEqual({ ok: false, code: "FORBIDDEN", status: 403, message: MODE_NEEDS_ADMIN });
    expect(await call(target, "a-admin", "POST", OFFER, { decision: "accept" }, undefined, { scriptToken: { tokenId: "t1" } })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    for (const body of [{}, { decision: "yes" }, { decision: "accept", extra: 1 }]) expect(await call(target, "a-admin", "POST", OFFER, body)).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-admin", "GET", OFFER)).toMatchObject({ ok: false, code: "NOT_FOUND", message: "route not found" });
    expect(lessonEvents(w).filter((e) => e.action === "lesson.trial_offer_answered" || e.action === "lesson.mode_changed")).toEqual([]);
    expect(await call(target, "a-maint", "POST", OFFER, { decision: "accept" })).toEqual({ ok: true, body: { project: "payments", decision: "accept", mode: "auto", effective: "auto" } });
    // One record: the mode change, marked as the offer's answer, with the tally.
    const records = w.world.audit.filter((e) => e.action === "lesson.trial_offer_answered" || e.action === "lesson.mode_changed");
    expect(records.map((e) => [e.action, e.actor.id, e.companyId])).toEqual([["lesson.mode_changed", "a-maint", A]]);
    expect(records[0]!.details).toMatchObject({ fromMode: "suggest", toMode: "auto", via: "trial_offer", approvals: 10, drops: 0 });
    expect(await call(target, "a-admin", "GET", `${P}/lessons/mode`)).toEqual({ ok: true, body: { project: "payments", mode: "auto", effective: "auto", lockedByCompany: false, canChange: true } });
    expect(await call(target, "a-admin", "POST", OFFER, { decision: "accept" })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT", message: "There is no offer to answer now." });
    // Going back to Suggest by hand does not bring the offer straight back.
    expect(await call(target, "a-admin", "PUT", `${P}/lessons/mode`, { mode: "suggest" })).toMatchObject({ ok: true });
    expect(await offerOf(target, "a-admin")).toBeUndefined();
  });

  it("not now: audited, the mode stays suggest, and the offer is hidden for 30 days", async () => {
    const w = await setUp();
    await decide(w, A, 10, 0);
    const { api: target } = api(w);
    expect(await call(target, "a-admin", "POST", OFFER, { decision: "not_now" })).toEqual({ ok: true, body: { project: "payments", decision: "not_now", mode: "suggest" } });
    expect(w.world.audit.filter((e) => e.action === "lesson.trial_offer_answered").map((e) => e.details)).toEqual([expect.objectContaining({ answer: "not_now" })]);
    expect(w.world.audit.filter((e) => e.action === "lesson.mode_changed")).toEqual([]);
    expect(await offerOf(target, "a-admin")).toBeUndefined();
    expect(await call(target, "a-admin", "POST", OFFER, { decision: "accept" })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    // B's same-named project was never snoozed by A's answer.
    await decide(w, B, 10, 0);
    expect(await offerOf(target, "b-admin")).toMatchObject({ approvals: 10 });
    w.world.clock.now += 31 * DAY;
    await decide(w, A, 10, 0);
    expect(await offerOf(target, "a-admin")).toMatchObject({ approvals: 10 });
  });

  it("an accept never writes over a mode someone changed after the offer was read", async () => {
    const w = await setUp();
    await decide(w, A, 10, 0);
    const documents = w.lessons.get(A)!.runtime.documents;
    const put = documents.put.bind(documents);
    let raced = false;
    const spy = vi.spyOn(documents, "put").mockImplementation(async (request) => {
      if (!raced && request.item["entityType"] === "LESSON_MODE") { raced = true; await writeLearningMode(documents, { workspaceId: A, project: "payments" }, "Off", 1); }
      return await put(request);
    });
    const { api: target } = api(w);
    expect(await call(target, "a-admin", "POST", OFFER, { decision: "accept" })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    spy.mockRestore();
    expect(await call(target, "a-admin", "GET", `${P}/lessons/mode`)).toMatchObject({ ok: true, body: { mode: "off" } });
  });

  it("no offer where accepting would not start trials, or would let tier 0 go live by itself", async () => {
    const floor = await setUp();
    await decide(floor, A, 10, 0);
    await new DocumentTier0Settings(floor.world.store).write({ kind: "company", workspaceId: A }, "one", { by: "a-admin", at: 1 }, "auto");
    expect(await offerOf(api(floor).api, "a-admin")).toBeUndefined();
    const autoTier0 = await setUp();
    await decide(autoTier0, A, 10, 0);
    await new DocumentTier0Settings(autoTier0.world.store).write({ kind: "project", workspaceId: A, project: "payments" }, "auto", { by: "a-admin", at: 1 }, "one");
    expect(await offerOf(api(autoTier0).api, "a-admin")).toBeUndefined();
    const twoPeople = await setUp();
    await decide(twoPeople, A, 10, 0);
    await new DocumentTier0Settings(twoPeople.world.store).write({ kind: "project", workspaceId: A, project: "payments" }, "two", { by: "a-admin", at: 1 }, "one");
    expect(await offerOf(api(twoPeople).api, "a-admin")).toBeUndefined();
  });

  it("an answer that cannot be audited changes nothing", async () => {
    const w = await setUp();
    await decide(w, A, 10, 0);
    const real = w.lessons.get(A)!;
    const failing = { emit: async () => { throw new Error("ledger down"); } };
    const { api: target } = api(w, { lessonsOf: async (companyId) => (companyId === A ? { ...real, runtime: { ...real.runtime, audit: failing } } : undefined) });
    expect(await call(target, "a-admin", "POST", OFFER, { decision: "accept" })).toMatchObject({ ok: false, code: "AUDIT_UNAVAILABLE" });
    expect(await call(target, "a-admin", "POST", OFFER, { decision: "not_now" })).toMatchObject({ ok: false, code: "AUDIT_UNAVAILABLE" });
    expect(await offerOf(api(w).api, "a-admin")).toMatchObject({ approvals: 10 });
    expect(await call(api(w).api, "a-admin", "GET", `${P}/lessons/mode`)).toMatchObject({ ok: true, body: { mode: "suggest" } });
  });

  it("a tally that cannot be read is no offer, and the mode still reads", async () => {
    const w = await setUp();
    await decide(w, A, 10, 0);
    const real = w.lessons.get(A)!;
    const broken = { ...real.runtime.store, listPage: async () => { throw new Error("down"); } };
    const { api: target } = api(w, { lessonsOf: async (companyId) => (companyId === A ? { ...real, runtime: { ...real.runtime, store: broken } } : undefined) });
    expect(await call(target, "a-admin", "GET", `${P}/lessons/mode`)).toMatchObject({ ok: true, body: { mode: "suggest" } });
    expect(await offerOf(target, "a-admin")).toBeUndefined();
    expect(await call(target, "a-admin", "POST", OFFER, { decision: "accept" })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("the weekly summary setting", () => {
  const PATH = `${P}/lessons/weekly-summary`;
  it("off by default; only a project admin or a company owner or admin turns it on, never a script token; audited before the write; two companies with one project name are apart", async () => {
    const w = await setUp();
    const { api: target } = api(w);
    expect(await call(target, "a-contrib", "GET", PATH)).toEqual({ ok: true, body: { project: "payments", on: false, source: "default", canChange: false } });
    expect(await call(target, "a-contrib", "PUT", PATH, { on: true })).toEqual({ ok: false, code: "FORBIDDEN", status: 403, message: SUMMARY_NEEDS_ADMIN });
    expect(await call(target, "a-admin", "PUT", PATH, { on: true }, undefined, { scriptToken: { tokenId: "t1" } })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    for (const body of [{}, { on: "yes" }, { on: true, extra: 1 }]) expect(await call(target, "a-admin", "PUT", PATH, body)).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(w.world.audit.filter((e) => e.action === "lesson.digest_switched")).toEqual([]);
    expect(await call(target, "a-maint", "PUT", PATH, { on: true })).toEqual({ ok: true, body: { project: "payments", on: true, source: "chosen", canChange: true } });
    expect(await call(target, "a-contrib", "GET", PATH)).toMatchObject({ ok: true, body: { on: true } });
    expect(await call(target, "b-admin", "GET", PATH)).toMatchObject({ ok: true, body: { on: false } });
    expect(await w.world.store.get({ pk: companyScoped(B, "LESSON_DIGEST#payments"), sk: "SETTING" })).toBeUndefined();
    const records = w.world.audit.filter((e) => e.action === "lesson.digest_switched");
    expect(records.map((e) => [e.actor.id, e.companyId, e.details])).toEqual([["a-maint", A, expect.objectContaining({ enabled: true })]]);
    expect(JSON.stringify(records)).not.toContain("payments");
    expect(await call(target, "a-admin", "PUT", PATH, { on: false })).toMatchObject({ ok: true, body: { on: false } });
  });

  it("a setting that cannot be read is answered as unavailable, not as off", async () => {
    const w = await setUp();
    const real = w.lessons.get(A)!;
    const documents = real.runtime.documents;
    const get = documents.get.bind(documents);
    const spy = vi.spyOn(documents, "get").mockImplementation(async (key) => { if (key.sk === "SETTING" && key.pk.includes("LESSON_DIGEST#")) throw new Error("down"); return await get(key); });
    const answer = await call(api(w).api, "a-admin", "GET", PATH);
    spy.mockRestore();
    expect(answer).toMatchObject({ ok: false, code: "RUNTIME_UNAVAILABLE" });
  });

  it("a change that cannot be audited is not saved", async () => {
    const w = await setUp();
    const real = w.lessons.get(A)!;
    const failing = { emit: async () => { throw new Error("ledger down"); } };
    const { api: target } = api(w, { lessonsOf: async (companyId) => (companyId === A ? { ...real, runtime: { ...real.runtime, audit: failing } } : undefined) });
    expect(await call(target, "a-admin", "PUT", PATH, { on: true })).toMatchObject({ ok: false, code: "AUDIT_UNAVAILABLE" });
    expect(await call(api(w).api, "a-admin", "GET", PATH)).toMatchObject({ ok: true, body: { on: false } });
  });
});

describe("lessons phase 0: the measurement read (GET lessons/measure)", () => {
  const PATH = `${P}/lessons/measure`;
  const approved = (companyId: string, id: string) => lesson(companyId, id, { approvals: [{ approvalId: "a1", by: "person-1", at: 1, mode: "one" }], title: "Retry helper", body: "Wrap network calls in withRetry instead of looping by hand." });
  /** One live load of the company's task through the real dispatch glue, and the merged and reverted milestones of its task. */
  async function drive(w: World, companyId: OrgId): Promise<void> {
    await put(w, companyId, approved(companyId, `les_${companyId === A ? "aaaa" : "bbbb"}1111`));
    const lessons = w.lessons.get(companyId)!;
    await lessons.host.learnedFor({ workspaceId: w.spaces.get(companyId)!, operationId: `op-${companyId}`, workflowMode: "PLAN", features: [LEARNED_CONTEXT_FEATURE] });
    // The measurement is not waited for by the load: let it settle.
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  it("a project admin and a company admin read the numbers; a contributor is refused, an outsider is told nothing, a script token never reads", async () => {
    const w = await setUp();
    await drive(w, A);
    const { api: target } = api(w);
    for (const person of ["a-admin", "a-maint"]) {
      const answer = await call(target, person, "GET", PATH);
      expect(answer, person).toMatchObject({ ok: true, body: { project: "payments", windowDays: 30, floor: 0.35, cleanMerge: { merged: 0, reverted: 0, clean: 0, rate: null }, truncated: false, unreadable: 0 } });
    }
    expect(await call(target, "a-contrib", "GET", PATH)).toEqual({ ok: false, code: "FORBIDDEN", status: 403, message: MEASURE_NEEDS_ADMIN });
    expect(await call(target, "a-out", "GET", PATH)).toEqual({ ok: false, code: "NOT_FOUND", status: 404, message: NO_SUCH_PROJECT });
    expect(await call(target, "a-admin", "GET", PATH, undefined, undefined, { scriptToken: { tokenId: "t1" } })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    for (const method of ["POST", "PUT", "DELETE"]) expect(await call(target, "a-admin", method, PATH, {})).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("the numbers come from the live dispatch: a load writes a row and the merge and the revert of the task make the clean-merge count", async () => {
    const w = await setUp();
    await drive(w, A);
    const { api: target } = api(w);
    const before = await call(target, "a-admin", "GET", PATH);
    expect(before).toMatchObject({ ok: true, body: { loads: 1, lessonsInUse: 1, loadedLessons: 1 } });
    const host = w.lessons.get(A)!.host;
    const at = new Date(w.world.clock.now).toISOString();
    await host.milestone.on({ kind: "merged", orgId: A, taskId: w.tasks.get(A)!, at, text: "merged" });
    expect(await call(target, "a-admin", "GET", PATH)).toMatchObject({ ok: true, body: { cleanMerge: { merged: 1, reverted: 0, clean: 1, rate: 1 } } });
    await host.noteReverted(w.tasks.get(A)!);
    expect(await call(target, "a-admin", "GET", PATH)).toMatchObject({ ok: true, body: { cleanMerge: { merged: 1, reverted: 1, clean: 0, rate: 0 } } });
  });
});

describe("the tuning report (GET lessons/tuning, lane L4-WK)", () => {
  const PATH = `${P}/lessons/tuning`;
  async function loads(w: World, companyId: OrgId, count: number): Promise<void> {
    const sink = documentMeasureSink(w.lessons.get(companyId)!.runtime.documents, companyId, () => w.world.clock.now);
    for (let i = 0; i < count; i += 1) {
      await sink.load({
        workspaceId: companyId, project: "payments", taskId: `task-${String(i)}`, stage: "IMPLEMENT", round: 1, at: w.world.clock.now - i * 60_000, budgetLessons: 5, activeCount: 6, eligibleCount: 6,
        loaded: Array.from({ length: 5 }, (_unused, j) => ({ id: `les_${String(j).padStart(4, "0")}`, fit: 0.5, score: 0.5, words: 0.1 + 0.01 * ((i * 5 + j) % 50), cos: null })), leftOut: [],
      });
    }
  }

  it("a project admin and a company admin read it; a contributor is refused, an outsider is told nothing, a script token never reads, nothing else is a route", async () => {
    const w = await setUp();
    const { api: target } = api(w);
    for (const person of ["a-admin", "a-maint"]) {
      expect(await call(target, person, "GET", PATH), person).toMatchObject({ ok: true, body: { project: "payments", ready: false, message: "not enough data yet (0 of 20 loads)", windowDays: 30 } });
    }
    expect(await call(target, "a-contrib", "GET", PATH)).toEqual({ ok: false, code: "FORBIDDEN", status: 403, message: TUNING_NEEDS_ADMIN });
    expect(await call(target, "a-out", "GET", PATH)).toEqual({ ok: false, code: "NOT_FOUND", status: 404, message: NO_SUCH_PROJECT });
    expect(await call(target, "a-admin", "GET", PATH, undefined, undefined, { scriptToken: { tokenId: "t1" } })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    for (const method of ["POST", "PUT", "DELETE"]) expect(await call(target, "a-admin", method, PATH, {})).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("it suggests from the company's own rows, writes nothing, and a second company with the same project name sees only its own", async () => {
    const w = await setUp();
    await loads(w, A, 25);
    const { api: target } = api(w);
    const before = (await w.world.store.query({ pk: companyScoped(A, "LESSON_FIT#payments") })).items.length;
    const answer = await call(target, "a-admin", "GET", PATH);
    expect(answer).toMatchObject({ ok: true, body: { ready: true, evidence: { loads: 25, loadedLessons: 125, lessonsLoaded: 5 } } });
    const body = (answer as { body: { suggestions: Array<{ setting: string; status: string }> } }).body;
    expect(body.suggestions.map((one) => [one.setting, one.status])).toEqual([["fitFloorWords", "suggested"], ["fitFloorCosine", "not_enough_data"], ["priorWeightUses", "not_enough_data"], ["stepLessonCap", "keep"], ["weeklyPicks", "no_data_source"]]);
    expect((await w.world.store.query({ pk: companyScoped(A, "LESSON_FIT#payments") })).items.length).toBe(before);
    expect(await call(target, "b-admin", "GET", PATH)).toMatchObject({ ok: true, body: { ready: false, evidence: { loads: 0 } } });
    await loads(w, B, 21);
    expect(await call(target, "b-admin", "GET", PATH)).toMatchObject({ ok: true, body: { ready: true, evidence: { loads: 21 } } });
    expect(await call(target, "a-admin", "GET", PATH)).toMatchObject({ ok: true, body: { evidence: { loads: 25 } } });
  });
});

describe("revert detection (lane L4-LM1b): the host puts the lessons a reverted task loaded under question only where the revert's files are in the lesson's own code area", () => {
  const VIA = "e".repeat(40);
  const questionRows = async (w: World, company: OrgId) => (await w.world.store.query({ pk: companyScoped(company, "LESSON_QUESTION#payments") })).items;
  /** One approved lesson with a code area, loaded (reached the prompt) by the company's task. */
  async function loaded(w: World, company: OrgId, id: string, paths: string[] | undefined): Promise<void> {
    await put(w, company, lesson(company, id, { approvals: [{ approvalId: "a1", by: "person-1", at: 1, mode: "one" }], scope: paths === undefined ? {} : { paths } }));
    const store = w.lessons.get(company)!.runtime.store;
    await store.putManifest({
      taskId: w.tasks.get(company)!, workspaceId: company, project: "payments", stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, bytes: 10,
      lessons: [{ id, version: 1, score: 0.5, why: "scope", citation: "valid" }],
    });
  }

  it("a revert in files outside every lesson's area, one with unreadable files, and a lesson with no area flag nothing; the revert is still counted", async () => {
    const w = await setUp();
    await loaded(w, A, "les_aaaa1111", ["src/billing/**"]);
    const host = w.lessons.get(A)!.host;
    await host.noteReverted(w.tasks.get(A)!, { via: VIA, files: ["src/search/index.ts"] });
    await host.noteReverted(w.tasks.get(A)!, { via: VIA, files: undefined });
    expect(await questionRows(w, A)).toEqual([]);
    const wide = await setUp();
    await loaded(wide, A, "les_aaaa1111", undefined);
    await wide.lessons.get(A)!.host.noteReverted(wide.tasks.get(A)!, { via: VIA, files: ["src/billing/money.ts"] });
    expect(await questionRows(wide, A)).toEqual([]);
  });

  it("company B's host told of company A's task flags nothing in either company", async () => {
    const w = await setUp();
    await loaded(w, A, "les_aaaa1111", ["src/**"]);
    await loaded(w, B, "les_bbbb1111", ["src/**"]);
    await w.lessons.get(B)!.host.noteReverted(w.tasks.get(A)!, { via: VIA, files: ["src/a.ts"] });
    expect(await questionRows(w, A)).toEqual([]);
    expect(await questionRows(w, B)).toEqual([]);
    await w.lessons.get(A)!.host.noteReverted(w.tasks.get(A)!, { via: VIA, files: ["src/a.ts"] });
    expect(await questionRows(w, A)).toHaveLength(1);
    expect(await questionRows(w, B)).toEqual([]);
    expect(JSON.stringify(await questionRows(w, A))).not.toContain(B);
  });
});

describe("Rovara skills (L4-AK3)", () => {
  const DAY = 86_400_000;
  const BODY = "When adding a new queue: 1. Create the queue and its dead-letter queue. 2. Register the handler. 3. Add an alarm on the dead-letter depth.";
  async function proven(w: World, companyId: OrgId = A): Promise<void> {
    const now = w.world.clock.now;
    await put(w, companyId, lesson(companyId, "les_proc0001", {
      type: "procedure", title: "Add a queue handler", description: "A new queue needs a dead-letter queue.", body: BODY, approvals: [{ approvalId: "a1", by: "a-admin", at: 1, mode: "one" }],
      provenance: { ...draft().provenance, authors: ["ann", "bob"], supportTasks: [], measured: false, audience: { kind: "project" } }, createdAt: now - 40 * DAY, updatedAt: now - 40 * DAY, expiresAt: now + 90 * DAY,
    }));
    const documents = w.lessons.get(companyId)!.runtime.documents;
    for (let n = 0; n < 10; n += 1) await documents.put({ item: { pk: companyScoped(companyId, "LESSON_USE#payments#les_proc0001"), sk: `task-${String(n)}`, entityType: "LESSON_USE", taskId: `task-${String(n)}`, at: now } });
  }
  it("the full path: a person who decides drafts, two different people approve, the skill is in use; everyone else is refused with fixed words", async () => {
    const w = await setUp();
    await proven(w);
    const { api: target } = api(w);
    // Who may and who may not.
    expect(await call(target, "a-contrib", "POST", `${P}/lessons/les_proc0001/skill`, {})).toMatchObject({ ok: false, code: "FORBIDDEN", message: "Only a maintainer of this project, or an admin, can decide skills." });
    expect(await call(target, "a-out", "POST", `${P}/lessons/les_proc0001/skill`, {})).toMatchObject({ ok: false, status: 404, message: NO_SUCH_PROJECT });
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_proc0001/skill`, {}, undefined, { scriptToken: { tokenId: "stk_x" } })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_proc0001/skill`, { name: "Bad Name" })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_proc0001/skill`, { tools: ["bash"] })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_nope0001/skill`, {})).toMatchObject({ ok: false, status: 404 });
    // Draft.
    expect(await call(target, "a-admin", "POST", `${P}/lessons/les_proc0001/skill`, {})).toEqual({ ok: true, body: { project: "payments", name: "add-a-queue-handler", version: 1 } });
    expect(await call(target, "a-maint", "POST", `${P}/lessons/les_proc0001/skill`, {})).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    // Two approvals by two different people.
    expect(await call(target, "a-admin", "POST", `${P}/skills/add-a-queue-handler/approve`, { version: 1 })).toEqual({ ok: true, body: { project: "payments", name: "add-a-queue-handler", version: 1, approvals: 1, live: false } });
    expect(await call(target, "a-admin", "POST", `${P}/skills/add-a-queue-handler/approve`, { version: 1 })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT", message: "You already approved this version." });
    expect(await call(target, "a-contrib", "POST", `${P}/skills/add-a-queue-handler/approve`, { version: 1 })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const listed = await call(target, "a-contrib", "GET", `${P}/skills`);
    expect(listed).toMatchObject({ ok: true, body: { project: "payments", skills: [{ name: "add-a-queue-handler", approvals: 1, approvedByYou: false }] } });
    expect(JSON.stringify(listed)).not.toContain("a-admin");
    expect(await call(target, "a-maint", "POST", `${P}/skills/add-a-queue-handler/approve`, { version: 1 })).toEqual({ ok: true, body: { project: "payments", name: "add-a-queue-handler", version: 1, approvals: 2, live: true } });
    expect(await call(target, "a-admin", "GET", `${P}/skills`)).toMatchObject({ ok: true, body: { skills: [{ activeVersion: 1, approvals: 2, approvedByYou: true }] } });
    // An edit is a new version; a stale one is a conflict; the audit has each step with the name and version only.
    expect(await call(target, "a-maint", "PUT", `${P}/skills/add-a-queue-handler`, { expectedVersion: 1, description: "Add a queue handler", when: "adding a queue", steps: ["Create the queue", "Wire the handler"] })).toEqual({ ok: true, body: { project: "payments", name: "add-a-queue-handler", version: 2 } });
    expect(await call(target, "a-maint", "PUT", `${P}/skills/add-a-queue-handler`, { expectedVersion: 1, description: "Add a queue handler", when: "adding a queue", steps: ["Create the queue"] })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(await call(target, "a-maint", "PUT", `${P}/skills/add-a-queue-handler`, { expectedVersion: 2, description: "d", when: "w", steps: Array.from({ length: 13 }, (_, n) => `s${String(n)}`) })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-maint", "PUT", `${P}/skills/add-a-queue-handler`, { expectedVersion: 2, description: "d", when: "w", steps: ["Run !`rm -rf /`"] })).toMatchObject({ ok: false, code: "CONFIG_INVALID", message: "A skill is text only: it cannot hold a command line to run or a list of tools." });
    const audited = lessonEvents(w).filter((event) => event.action.startsWith("lesson.skill_"));
    expect(audited.map((event) => event.action)).toEqual(["lesson.skill_drafted", "lesson.skill_approved", "lesson.skill_approved", "lesson.skill_activated", "lesson.skill_edited"]);
    expect(JSON.stringify(audited)).not.toContain("dead-letter");
    // Retire.
    expect(await call(target, "a-contrib", "POST", `${P}/skills/add-a-queue-handler/retire`, {})).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await call(target, "a-admin", "POST", `${P}/skills/add-a-queue-handler/retire`, {})).toEqual({ ok: true, body: { project: "payments", name: "add-a-queue-handler", retired: true } });
    expect(await call(target, "a-admin", "GET", `${P}/skills`)).toMatchObject({ ok: true, body: { skills: [{ retired: true }] } });
  });

  it("L4-JA: the list says whether you may decide; one skill is read with the text of its newest version and its form, and the form makes the same text again", async () => {
    const w = await setUp();
    await proven(w);
    const { api: target } = api(w);
    await call(target, "a-admin", "POST", `${P}/lessons/les_proc0001/skill`, {});
    // Who may decide (the directory's answer, not a guess): an admin and a maintainer yes, a contributor and a person off the project no.
    for (const [person, can] of [["a-admin", true], ["a-maint", true], ["a-contrib", false]] as const) expect(await call(target, person, "GET", `${P}/skills`), person).toMatchObject({ ok: true, body: { canDecide: can, skills: [{ name: "add-a-queue-handler" }] } });
    expect(await call(target, "a-out", "GET", `${P}/skills`)).toMatchObject({ ok: false, status: 404 });
    // The list carries no text; the one-skill read does, for anyone on the project (a contributor reads what the agents are sent).
    const list = await call(target, "a-contrib", "GET", `${P}/skills`);
    expect(JSON.stringify(list)).not.toContain("Register the handler");
    const one = await call(target, "a-contrib", "GET", `${P}/skills`, undefined, { name: "add-a-queue-handler" }) as { ok: true; body: { project: string; canDecide: boolean; skills: Array<Record<string, unknown>> } };
    expect(one).toMatchObject({ ok: true, body: { project: "payments", canDecide: false, skills: [{ name: "add-a-queue-handler", currentVersion: 1, approvals: 0, approvedByYou: false }] } });
    expect(one.body.skills).toHaveLength(1);
    const detail = one.body.skills[0]!;
    expect(detail["content"]).toContain("## Steps");
    expect(detail["content"]).toContain("Create the queue and its dead-letter queue.");
    expect(detail["approvers"]).toBeUndefined();
    expect(detail["form"]).toMatchObject({ when: "adding a new queue", steps: ["Create the queue and its dead-letter queue.", "Register the handler.", "Add an alarm on the dead-letter depth."] });
    // Saving the form as it was read gives a new version with the very same text, so nothing is lost by an edit that changes one step.
    const form = detail["form"] as { description: string; when: string; steps: string[]; doneWhen?: string; why?: string };
    expect(await call(target, "a-maint", "PUT", `${P}/skills/add-a-queue-handler`, { expectedVersion: 1, ...form })).toEqual({ ok: true, body: { project: "payments", name: "add-a-queue-handler", version: 2 } });
    const second = (await call(target, "a-maint", "GET", `${P}/skills`, undefined, { name: "add-a-queue-handler" }) as { body: { skills: Array<Record<string, unknown>> } }).body.skills[0]!;
    expect(second["currentVersion"]).toBe(2);
    expect(second["content"]).toBe(detail["content"]);
    // Bad asks: another query, a name twice, a name that is not one, a skill that is not there, a skill of the other company.
    for (const query of [{ x: "1" }, { name: "Bad" }, { name: "" }, { name: "a-b", x: "1" }]) expect(await call(target, "a-admin", "GET", `${P}/skills`, undefined, query), JSON.stringify(query)).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    // A name given twice is refused too (a record cannot say it, so the request is made by hand).
    expect(await call(target, "a-admin", "GET", `${P}/skills`, undefined, new URLSearchParams("name=a-b&name=c-d"))).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await call(target, "a-admin", "GET", `${P}/skills`, undefined, { name: "no-such-skill" })).toMatchObject({ ok: false, status: 404, message: "That skill is no longer there." });
    expect(await call(target, "b-admin", "GET", `${P}/skills`, undefined, { name: "add-a-queue-handler" })).toMatchObject({ ok: false, status: 404 });
  });

  it("L4-JA review: nobody is told they may decide when the approver directory cannot answer, and the one-skill read says which approvals are yours", async () => {
    const w = await setUp();
    await proven(w);
    const { api: target } = api(w);
    await call(target, "a-admin", "POST", `${P}/lessons/les_proc0001/skill`, {});
    const working = w.people.approvers.bind(w.people);
    for (const broken of [async () => ({ complete: false, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }), async () => { throw new Error("down"); }]) {
      w.people.approvers = broken;
      expect(await call(target, "a-admin", "GET", `${P}/skills`)).toMatchObject({ ok: true, body: { canDecide: false } });
      expect(await call(target, "a-admin", "GET", `${P}/skills`, undefined, { name: "add-a-queue-handler" })).toMatchObject({ ok: true, body: { canDecide: false } });
    }
    w.people.approvers = working;
    expect(await call(target, "a-admin", "POST", `${P}/skills/add-a-queue-handler/approve`, { version: 1 })).toMatchObject({ ok: true });
    const read = async (person: string) => ((await call(target, person, "GET", `${P}/skills`, undefined, { name: "add-a-queue-handler" })) as { body: { skills: Array<Record<string, unknown>> } }).body.skills[0]!;
    expect(await read("a-admin")).toMatchObject({ approvals: 1, approvedByYou: true });
    expect(await read("a-maint")).toMatchObject({ approvals: 1, approvedByYou: false });
  });

  it("L4-JA: a skill text this build cannot read back exactly has no form (never a guess), and the text is still shown; a long skill carries the splitting note", async () => {
    const w = await setUp();
    await proven(w);
    const { api: target } = api(w);
    await call(target, "a-admin", "POST", `${P}/lessons/les_proc0001/skill`, {});
    const documents = w.lessons.get(A)!.runtime.documents;
    const key = { pk: companyScoped(A, "SKILL#payments"), sk: "v#add-a-queue-handler#000001" };
    const row = (await documents.get(key))!;
    const originalContent = row["content"];
    if (typeof originalContent !== "string") throw new Error("Expected the skill document content to be text");
    await documents.put({ item: { ...row, content: `${originalContent}\nA line added by hand.\n`, bytes: 9_000 } });
    const got = await call(target, "a-admin", "GET", `${P}/skills`, undefined, { name: "add-a-queue-handler" });
    const read = (got as { body: { skills: Array<Record<string, unknown>> } }).body.skills[0]!;
    expect(read["form"]).toBeUndefined();
    expect(read["content"]).toContain("A line added by hand.");
    expect(read["note"]).toBe("This skill is long. Consider splitting it into smaller skills.");
  });

  it("two companies with the same project name never see or change each other's skills", async () => {
    const w = await setUp();
    await proven(w);
    const { api: target } = api(w);
    await call(target, "a-admin", "POST", `${P}/lessons/les_proc0001/skill`, {});
    expect(await call(target, "b-admin", "GET", `${P}/skills`)).toEqual({ ok: true, body: { project: "payments", canDecide: true, skills: [] } });
    for (const [method, path, body] of [["POST", `${P}/skills/add-a-queue-handler/approve`, { version: 1 }], ["POST", `${P}/skills/add-a-queue-handler/retire`, {}], ["PUT", `${P}/skills/add-a-queue-handler`, { expectedVersion: 1, description: "d", when: "w", steps: ["x"] }]] as const) {
      expect(await call(target, "b-admin", method, path, body), `${method} ${path}`).toMatchObject({ ok: false, status: 404 });
    }
    expect(await call(target, "b-admin", "POST", `${P}/lessons/les_proc0001/skill`, {})).toMatchObject({ ok: false, status: 404 });
    expect(await call(target, "a-admin", "GET", `${P}/skills`)).toMatchObject({ body: { skills: [{ name: "add-a-queue-handler", approvals: 0 }] } });
  });
});
