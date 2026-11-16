// The Home number "Corrections you had to repeat: X of Y this month" (core-host/lessons-repeats-api.ts): off by default and reads nothing; the company comes only from live membership; two companies
// with the same project name never see each other's numbers; a project's number for its roster, the company's for owners and admins; counts only.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentXError, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type OrgRole, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { buildCoreRegistry, createCoreRuntime, readCoreEngineFlags } from "../../packages/broker/src/core-host/index.js";
import { companyProjects, createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, CORE_LESSONS_VARIABLE, type CoreLessons } from "../../packages/broker/src/core-host/lessons.js";
import {
  COMPANY_NUMBER_NEEDS_ADMIN, COMPANY_PROJECTS_MAX, createLessonsRepeatsApi, isLessonsRepeatsPath, type LessonsRepeatsCaller, type LessonsRepeatsCompany, type LessonsRepeatsOptions,
} from "../../packages/broker/src/core-host/lessons-repeats-api.js";
import { LESSONS_OFF, NO_SUCH_PROJECT } from "../../packages/broker/src/core-host/lessons-api.js";
import { logTaskCorrections } from "../../packages/broker/src/lessons/correction-log.js";
import type { HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { DEV_ROUTES } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { LESSONS_REPEATS_ROUTES } from "../../packages/broker/src/aws/developer-routes.js";
import { createFakeWorld, FAKE_COMPANY, type FakeWorld } from "../support/core-host-fakes.js";

afterEach(() => setLearnedLessonsGate(undefined));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const DAY = 86_400_000;
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const ROLE: Record<string, { companyId: OrgId; role: OrgRole }> = {
  "a-admin": { companyId: A, role: "admin" }, "a-owner": { companyId: A, role: "owner" }, "a-member": { companyId: A, role: "member" }, "a-out": { companyId: A, role: "member" },
  "b-admin": { companyId: B, role: "admin" }, "b-member": { companyId: B, role: "member" },
};
const ROSTER = new Set(["a-admin", "a-owner", "a-member", "b-admin", "b-member"]);

async function registerProject(world: FakeWorld, companyId: string, name = PROJECT.name): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify({ ...PROJECT, name })) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

function peopleOf(): Pick<HostedLessonPeople, "onProjectRoster"> & HostedLessonPeople & { asked: string[] } {
  const asked: string[] = [];
  const known = (companyId: string): void => { if (companyId !== A && companyId !== B) throw new Error("asked about another company"); };
  return {
    asked,
    async approvers(companyId) { asked.push(companyId); known(companyId); return { complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }; },
    async onProjectRoster(companyId, project, personId) { asked.push(companyId); known(companyId); return project === "payments" && ROSTER.has(personId) && ROLE[personId]?.companyId === companyId; },
    async linkedAccounts(companyId) { asked.push(companyId); return []; },
    async displayName() { return undefined; },
    async isErased() { return false; },
  };
}

interface World { world: FakeWorld; lessons: Map<OrgId, CoreLessons>; people: ReturnType<typeof peopleOf> }

async function setUp(env: NodeJS.ProcessEnv = { [CORE_LESSONS_VARIABLE]: "on" }): Promise<World> {
  const world = createFakeWorld();
  setCoreLessonsGate(env);
  const registry = await buildCoreRegistry({ modules: world.modules, context: world.context(), areas: ["flow", "build", "merge"] });
  const lessonsSwitch = readCoreLessonsSwitch(env).value;
  const people = peopleOf();
  const lessons = new Map<OrgId, CoreLessons>();
  for (const companyId of [A, B]) {
    await registerProject(world, companyId);
    const runtime = createCoreRuntime({
      registry, companyId, flags: readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on" }), callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
    });
    const built = createCoreLessons({ flow: runtime.flow, registry, companyId, lessonsSwitch, people, hostFor: async (id) => lessons.get(id)?.host, now: () => world.clock.now });
    if (built !== undefined) lessons.set(companyId, built);
    await runtime.flow.start({ principal: localOwnerPrincipal({ companyId }), client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  }
  return { world, lessons, people };
}

function api(w: World, over: Partial<LessonsRepeatsOptions> = {}) {
  const companyOf = vi.fn(async (caller: LessonsRepeatsCaller) => { const r = ROLE[caller.personId]; return r === undefined ? undefined : { companyId: r.companyId, role: r.role }; });
  const lessonsOf = vi.fn(async (companyId: OrgId): Promise<LessonsRepeatsCompany | undefined> => w.lessons.get(companyId));
  const projectsOf = vi.fn(async (companyId: OrgId) => companyProjects(w.world.store, companyId));
  const options: LessonsRepeatsOptions = { lessonsSwitch: { mode: "on" }, companyOf, lessonsOf, people: w.people, projectsOf, now: () => w.world.clock.now, ...over };
  return { api: createLessonsRepeatsApi(options), companyOf, lessonsOf, projectsOf };
}

async function call(target: ReturnType<typeof createLessonsRepeatsApi>, personId: string, path: string, query?: Record<string, string> | URLSearchParams, method = "GET") {
  try {
    return { ok: true as const, body: await target.answer({ method, path, ...(query === undefined ? {} : { query: query instanceof URLSearchParams ? query : new URLSearchParams(query) }) }, { personId }) as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    return { ok: false as const, code: error.code, status: error.statusCode, message: error.message.slice(error.code.length + 2) };
  }
}

const PROJECT_PATH = "/v1/dev/projects/payments/lessons/repeats";
const COMPANY_PATH = "/v1/dev/lessons/repeats";
/** This month in the fake world's clock, as YYYY-MM, and its first instant. */
const monthOf = (w: World): { month: string; start: number } => {
  const d = new Date(w.world.clock.now);
  return { month: `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) };
};

/** Logs one correction per text on its own task, each a day apart, from the month's start; `repeat` texts say the first one again. */
async function logged(w: World, companyId: OrgId, texts: string[], project = "payments"): Promise<void> {
  const { start } = monthOf(w);
  const documents = w.lessons.get(companyId)!.runtime.documents;
  for (const [index, text] of texts.entries()) {
    const at = Math.min(w.world.clock.now - 1, start + index * 60_000);
    await logTaskCorrections(documents, { companyId, project, taskId: `${companyId}-t${String(index)}`, corrections: [{ kind: "review_comment", paths: [], text, at, authorId: "a-member" }], now: at });
  }
}
const SAME = "Wrap every payments client network call in withRetry with backoff";
const TEN = [
  "Document the deployment variables in the readme", "Rename fetchUser to loadAccount everywhere", "Add a migration for the invoices table", "Log failures through the shared logger",
  "Keep secrets out of config files committed", "Pin the docker base image digest", "Split the billing controller into services", "Cover the webhook parser with fixtures",
  "Return 404 for unknown invoice ids", "Batch the reporting queries by customer",
];
const tenDifferent = (prefix: string) => TEN.map((text) => `${prefix}: ${text}`);

describe("the paths", () => {
  it("the route table has both rows (full access only) and the API recognises exactly them", () => {
    const rows = DEV_ROUTES.filter((route) => route.path.endsWith("/repeats"));
    expect(rows.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["GET /v1/dev/lessons/repeats", "GET /v1/dev/projects/{project}/lessons/repeats"]);
    expect(rows.every((r) => r.requires === "full")).toBe(true);
    for (const path of [PROJECT_PATH, COMPANY_PATH]) expect(isLessonsRepeatsPath(path)).toBe(true);
    const others = ["/v1/dev/projects/payments/lessons", "/v1/dev/projects/payments/lessons/repeats/x", "/v1/dev/lessons/repeatsx", "/v1/dev/projects/a/b/lessons/repeats", "/v1/dev/projects//lessons/repeats", "/v1/dev/lessons"];
    for (const path of others) expect(isLessonsRepeatsPath(path), path).toBe(false);
    // The dev router recognises exactly the same paths.
    for (const path of [PROJECT_PATH, COMPANY_PATH, ...others]) expect(LESSONS_REPEATS_ROUTES.test(path), path).toBe(isLessonsRepeatsPath(path));
  });
});

describe("the switch and the company", () => {
  it("off: both routes answer 'Lessons are off.' and read nothing, not even membership", async () => {
    const w = await setUp({});
    const { api: target, companyOf, lessonsOf, projectsOf } = api(w, { lessonsSwitch: { mode: "off" } });
    for (const path of [PROJECT_PATH, COMPANY_PATH]) expect(await call(target, "a-admin", path)).toEqual({ ok: false, code: "LESSONS_SWITCHED_OFF", status: 404, message: LESSONS_OFF });
    expect(companyOf).not.toHaveBeenCalled();
    expect(lessonsOf).not.toHaveBeenCalled();
    expect(projectsOf).not.toHaveBeenCalled();
  });

  it("on for one company only: the other company's people get 'Lessons are off.'", async () => {
    const w = await setUp({ [CORE_LESSONS_VARIABLE]: `on:${A}` });
    const { api: target, lessonsOf } = api(w, { lessonsSwitch: { mode: "on-for", companies: [A] } });
    expect(await call(target, "b-admin", COMPANY_PATH)).toMatchObject({ ok: false, code: "LESSONS_SWITCHED_OFF", message: LESSONS_OFF });
    expect(lessonsOf).not.toHaveBeenCalledWith(B);
  });

  it("no membership, a malformed one or a throw is 'Sign in again.'; lessons handed back for another company are refused before any read", async () => {
    const w = await setUp();
    for (const companyOf of [async () => undefined, async () => ({ companyId: "nope", role: "admin" as const }), async () => ({ companyId: A, role: "superuser" as unknown as OrgRole }), async () => { throw new Error("x"); }]) {
      expect(await call(api(w, { companyOf }).api, "a-admin", PROJECT_PATH)).toMatchObject({ ok: false, code: "AUTH_REQUIRED", message: "Sign in again." });
    }
    const wrong = api(w, { lessonsOf: async () => w.lessons.get(B) });
    expect(await call(wrong.api, "a-admin", PROJECT_PATH)).toMatchObject({ ok: false, code: "RUNTIME_UNAVAILABLE" });
    expect(await call(wrong.api, "a-admin", COMPANY_PATH)).toMatchObject({ ok: false, code: "RUNTIME_UNAVAILABLE" });
  });

  it("two companies with the same project name: each sees only its own corrections, on both routes", async () => {
    const w = await setUp();
    await logged(w, A, [SAME, `Please ${SAME.toLowerCase()}`, ...tenDifferent("A")]);
    await logged(w, B, ["Document the release checklist steps"]);
    const { api: target } = api(w);
    const a = await call(target, "a-member", PROJECT_PATH);
    const b = await call(target, "b-member", PROJECT_PATH);
    expect(a).toMatchObject({ ok: true, body: { project: "payments", repeated: 1, corrections: 12, enoughData: true } });
    expect(b).toMatchObject({ ok: true, body: { project: "payments", repeated: 0, corrections: 1, enoughData: false } });
    expect(await call(target, "a-admin", COMPANY_PATH)).toMatchObject({ ok: true, body: { scope: "company", projects: 1, repeated: 1, corrections: 12 } });
    expect(await call(target, "b-admin", COMPANY_PATH)).toMatchObject({ ok: true, body: { scope: "company", projects: 1, repeated: 0, corrections: 1 } });
    // Never asked the people port about a company other than the caller's.
    expect(w.people.asked.every((id) => id === A || id === B)).toBe(true);
  });
});

describe("who sees which number", () => {
  it("the project's number is for its roster: off the roster, an unknown project and a bad name are the same 'No such project.'", async () => {
    const w = await setUp();
    const { api: target } = api(w);
    for (const [person, path] of [["a-out", PROJECT_PATH], ["a-member", "/v1/dev/projects/nothere/lessons/repeats"], ["a-member", "/v1/dev/projects/%E0%A4%A/lessons/repeats"], ["a-member", "/v1/dev/projects/..%2Fx/lessons/repeats"]] as const) {
      expect(await call(target, person, path), `${person} ${path}`).toEqual({ ok: false, code: "NOT_FOUND", status: 404, message: NO_SUCH_PROJECT });
    }
    expect(await call(target, "a-member", PROJECT_PATH)).toMatchObject({ ok: true });
  });

  it("the company's number is for owners and admins (read live); a member is refused with fixed words", async () => {
    const w = await setUp();
    const { api: target } = api(w);
    expect(await call(target, "a-member", COMPANY_PATH)).toEqual({ ok: false, code: "FORBIDDEN", status: 403, message: COMPANY_NUMBER_NEEDS_ADMIN });
    expect(await call(target, "a-owner", COMPANY_PATH)).toMatchObject({ ok: true, body: { scope: "company" } });
    expect(await call(target, "a-admin", COMPANY_PATH)).toMatchObject({ ok: true, body: { scope: "company" } });
  });
});

describe("the answer", () => {
  it("counts only: no correction text, no task id, no person, and the split adds up", async () => {
    const w = await setUp();
    await logged(w, A, [SAME, `Please ${SAME.toLowerCase()}`, ...tenDifferent("A")]);
    const answer = await call(api(w).api, "a-member", PROJECT_PATH);
    expect(answer.ok).toBe(true);
    const body = (answer as { body: Record<string, unknown> }).body;
    expect(Object.keys(body).sort()).toEqual(["corrections", "enoughData", "month", "project", "repeated", "split", "truncated", "unjudged"]);
    const text = JSON.stringify(body);
    for (const word of ["withRetry", "a-member", `${A}-t`, "alpha"]) expect(text.includes(word), word).toBe(false);
    const split = body["split"] as { lessonLoaded: number; lessonNotLoaded: number; noLesson: number };
    expect(split.lessonLoaded + split.lessonNotLoaded + split.noLesson).toBe(body["repeated"]);
  });

  it("month: default the current one; an earlier month counts only its own corrections; a later month, a bad value, an unknown or repeated field is refused without echoing it", async () => {
    const w = await setUp();
    await logged(w, A, [SAME, `Please ${SAME.toLowerCase()}`]);
    const { api: target } = api(w);
    const { month, start } = monthOf(w);
    expect(await call(target, "a-member", PROJECT_PATH)).toMatchObject({ ok: true, body: { month, corrections: 2, repeated: 1 } });
    const before = new Date(start - DAY);
    const earlier = `${String(before.getUTCFullYear())}-${String(before.getUTCMonth() + 1).padStart(2, "0")}`;
    expect(await call(target, "a-member", PROJECT_PATH, { month: earlier })).toMatchObject({ ok: true, body: { month: earlier, corrections: 0, repeated: 0, enoughData: false } });
    const later = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 1));
    const next = `${String(later.getUTCFullYear())}-${String(later.getUTCMonth() + 1).padStart(2, "0")}`;
    for (const query of [{ month: next }, { month: "2026-13" }, { month: "<script>" }, { other: "1" }, new URLSearchParams([["month", month], ["month", month]])]) {
      const refused = await call(target, "a-member", PROJECT_PATH, query);
      expect(refused).toMatchObject({ ok: false, code: "CONFIG_INVALID", status: 400 });
      expect(JSON.stringify(refused).includes("script")).toBe(false);
    }
  });

  it("only GET", async () => {
    const w = await setUp();
    expect(await call(api(w).api, "a-admin", PROJECT_PATH, undefined, "POST")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("the company sum is bounded: at most COMPANY_PROJECTS_MAX projects, and a spent deadline stops starting new ones; both say truncated", async () => {
    const w = await setUp();
    const many = Array.from({ length: COMPANY_PROJECTS_MAX + 5 }, (_, i) => `p${String(i).padStart(3, "0")}`);
    const { api: wide } = api(w, { projectsOf: async () => many });
    expect(await call(wide, "a-admin", COMPANY_PATH)).toMatchObject({ ok: true, body: { projects: COMPANY_PROJECTS_MAX, truncated: true } });
    const { api: late } = api(w, { deadlineMs: -1 });
    expect(await call(late, "a-admin", COMPANY_PATH)).toMatchObject({ ok: true, body: { projects: 0, truncated: true } });
  });

  it("a project list that cannot be read is 'try again', not an empty number", async () => {
    const w = await setUp();
    const { api: target } = api(w, { projectsOf: async () => { throw new Error("down"); } });
    expect(await call(target, "a-admin", COMPANY_PATH)).toMatchObject({ ok: false, code: "RUNTIME_UNAVAILABLE" });
  });
});
