// The cost report's routes on the deployed API (lead 4, A1 + A2): who may read the report and change features (a live company owner or admin, from membership, not the principal's claim), who may
// file or move a task (its starter, a project maintainer, an owner or admin), two companies, two projects, fixed words that echo nothing, the audit record, and the start row the core runtime writes.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  FEATURE_ADMIN_ONLY, FEATURE_IS_DONE, FEATURE_NOT_FOUND, REPORT_ADMIN_ONLY, TASK_FEATURE_NEEDS_MAINTAINER, TASK_FEATURE_NOT_FOUND, orgProjectCatalogKey, projectRevisionKey, reportTaskKey,
  type JsonValue, type ProjectDefinition, type ReportTasksResponse,
} from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { isReportPath } from "../../packages/broker/src/core-host/report-routes.js";
import type { SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const OTHER = "org_corehost00000000000b";
const project = (name: string): ProjectDefinition => ({
  name, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const ADMIN_PATHS = [["GET", "/v1/app/org/report/tasks?from=2026-01-01T00:00:00.000Z"], ["GET", "/v1/app/org/report/features"], ["POST", "/v1/app/org/report/features"], ["POST", "/v1/app/org/report/features/ft_00000000000000000001/rename"], ["POST", "/v1/app/org/report/features/ft_00000000000000000001/merge"], ["POST", "/v1/app/org/report/features/ft_00000000000000000001/state"]] as const;
const SINCE = "2000-01-01T00:00:00.000Z";

function appOver(world: FakeWorld): CoreHostApp {
  return createCoreHostApp({
    env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}
async function registerProject(world: FakeWorld, companyId: string, name: string): Promise<void> {
  const definition = project(name);
  await world.store.put({ item: { ...projectRevisionKey(companyId, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
}
const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) });
const body = (answer: { body: string } | undefined): Record<string, unknown> & { error?: { code: string; message: string } } => JSON.parse(answer!.body) as never;

/** Who stands where on a project: `company|project|person` -> manage (a maintainer) or view. */
async function setup(standings: Record<string, SetupRunStanding["access"]> = {}) {
  const world = createFakeWorld();
  for (const company of [FAKE_COMPANY, OTHER]) for (const name of ["payments", "ledger"]) await registerProject(world, company, name);
  const app = appOver(world);
  const members = new Map<string, CompanyMembership>();
  const standing = vi.fn(async (personId: string, companyId: string, name: string): Promise<SetupRunStanding> => {
    const access = standings[`${companyId}|${name}|${personId}`] ?? "none";
    return access === "manage" ? { access, basis: "project-admin" } : { access };
  });
  const wiring: CoreDevWiring = { origin: () => "https://api.example", report: { standing } };
  const routes = createCoreDevRoutes({ app, companyOf: async (caller: DeployedCaller) => members.get(caller.principal.personId + caller.principal.companyId), wiring: () => wiring });
  const as = (companyId: string, role: CompanyMembership["role"], personId: string): DeployedCaller => {
    const base: DeployedCaller = { principal: { ...localOwnerPrincipal({ companyId, personId }), roles: [] }, client: "app" };
    members.set(personId + companyId, { companyId, role });
    return base;
  };
  /** Starts a task as `personId` (an owner of the install, as the laptop rule needs) and answers its id. */
  const start = async (companyId: string, personId: string, name = "payments", title = "Add a health endpoint"): Promise<string> => {
    const runtime = await app.runtimeFor(companyId);
    const { task } = await runtime.flow.start({ principal: localOwnerPrincipal({ companyId, personId }), origin: "app", client: "test" }, { requestId: randomUUID(), project: name, instructions: title, title, workflow: true, workflowPath: "QUICK" });
    return task.taskId;
  };
  return { world, app, routes, as, start, standing };
}

describe("which paths are the report's", () => {
  it("serves the seven and no other method on them", () => {
    for (const [method, path] of [["GET", "/v1/app/org/report/tasks"], ["GET", "/v1/app/org/report/features"], ["POST", "/v1/app/org/report/features"], ["POST", "/v1/app/org/report/features/ft_1/rename"], ["POST", "/v1/app/org/report/features/ft_1/merge"], ["POST", "/v1/app/org/report/features/ft_1/state"], ["POST", `/v1/app/tasks/${randomUUID()}/feature`]] as const) expect(isReportPath(path, method), `${method} ${path}`).toBe(true);
    for (const [method, path] of [["POST", "/v1/app/org/report/tasks"], ["PUT", "/v1/app/org/report/features"], ["DELETE", "/v1/app/org/report/features"], ["GET", "/v1/app/org/report/features/ft_1/rename"], ["POST", "/v1/app/org/report/features/ft_1/delete"], ["POST", "/v1/app/org/report/people"], ["GET", "/v1/app/org/report/people"], ["GET", `/v1/app/tasks/${randomUUID()}/feature`], ["POST", "/v1/app/tasks/x/feature/extra"], ["POST", "/v1/app/org/report/tasks/x"]] as const) expect(isReportPath(path, method), `${method} ${path}`).toBe(false);
  });
});

describe("the report on the deployed API: who may read and change", () => {
  it.each(ADMIN_PATHS)("%s %s: a member is refused with fixed words (the principal's own roles do not count), an admin and an owner are not", async (method, path) => {
    const { routes, as } = await setup();
    // the member's principal CLAIMS owner; membership says member
    const claimed = as(FAKE_COMPANY, "member", "member-1");
    claimed.principal.roles = ["owner"];
    const refused = await routes.route({ method, path, headers: {}, body: "{}" }, claimed);
    expect(refused?.statusCode).toBe(403);
    expect(body(refused).error!.message).toBe(method === "GET" && path.includes("/tasks") ? REPORT_ADMIN_ONLY : method === "GET" ? REPORT_ADMIN_ONLY : FEATURE_ADMIN_ONLY);
    expect(refused!.body).not.toContain(FAKE_COMPANY);
    for (const role of ["admin", "owner"] as const) {
      const answer = await routes.route({ method, path, headers: {}, body: "{}" }, as(FAKE_COMPANY, role, `${role}-1`));
      expect(answer?.statusCode, `${role} ${method} ${path}`).not.toBe(403);
      expect(answer?.statusCode, `${role} ${method} ${path}`).not.toBe(401);
    }
  });

  it("a script token never reaches the report; a missing membership is the sign-in refusal; an unwired deployment says so", async () => {
    const { routes, as, app } = await setup();
    const caller = as(FAKE_COMPANY, "admin", "admin-1");
    const token = await routes.route(get("/v1/app/org/report/features"), { ...caller, scriptToken: { tokenId: "sct_1" } });
    expect(token?.statusCode).toBe(403);
    expect(body(token).error!.message).toBe(NOT_FOR_SCRIPT_TOKENS);
    expect((await routes.route(get("/v1/app/org/report/features"), { principal: { ...caller.principal, personId: "stranger" }, client: "app" }))?.statusCode).toBe(401);
    const unwired = createCoreDevRoutes({ app, companyOf: async () => ({ companyId: FAKE_COMPANY, role: "owner" }), wiring: () => ({ origin: () => "x" }) });
    const answer = await unwired.route(get("/v1/app/org/report/features"), caller);
    expect(answer?.statusCode).toBe(404);
    expect(body(answer).error!.message).toBe(NOT_ON_THE_CORE_YET);
  });

  it("the company is membership's: a body, query or header that names another company changes nothing", async () => {
    const { routes, as, start } = await setup();
    const theirs = await start(OTHER, "someone");
    const caller = as(FAKE_COMPANY, "admin", "admin-1");
    const answer = await routes.route({ ...get(`/v1/app/org/report/tasks?from=${SINCE}`), headers: { "x-company": OTHER } }, caller);
    expect(answer?.statusCode).toBe(200);
    expect((body(answer) as unknown as ReportTasksResponse).tasks).toEqual([]);
    expect(answer!.body).not.toContain(theirs);
    expect((await routes.route(get(`/v1/app/org/report/tasks?from=${SINCE}&company=${OTHER}`), caller))?.statusCode).toBe(400);
  });
});

describe("the report tasks route", () => {
  it("a task started through the core runtime has its row from its first moment, and the admin reads it", async () => {
    const { world, routes, as, start } = await setup();
    const taskId = await start(FAKE_COMPANY, "starter-1", "payments", "Add a health endpoint");
    const stored = (await world.store.query({ pk: `ORG#${FAKE_COMPANY}#REPORT`, sk: { op: "beginsWith", prefix: "TASK#" } })).items;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ taskId, project: "payments", title: "Add a health endpoint", origin: "web", state: "open", companyId: FAKE_COMPANY });
    expect(stored[0]!.sk).toBe(reportTaskKey(FAKE_COMPANY, stored[0]!["startedAt"] as string, taskId).sk);
    const page = body(await routes.route(get(`/v1/app/org/report/tasks?from=${SINCE}`), as(FAKE_COMPANY, "admin", "admin-1"))) as unknown as ReportTasksResponse;
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]).toMatchObject({ taskId, project: "payments", title: "Add a health endpoint", origin: "web", state: "open", costMicros: 0, unpricedCalls: 0, prsOpened: 0 });
    expect(page.tasks[0]).not.toHaveProperty("feature");
    expect(page).toMatchObject({ hasMore: false, skipped: 0, unreadable: 0 });
    expect(JSON.stringify(page)).not.toContain("starter-1");
  });

  it("two companies and two projects: each admin reads their company's tasks only; the project filter splits one company's", async () => {
    const { routes, as, start } = await setup();
    const [a1, a2] = [await start(FAKE_COMPANY, "p1", "payments"), await start(FAKE_COMPANY, "p1", "ledger")];
    const b1 = await start(OTHER, "p2", "payments");
    const adminA = as(FAKE_COMPANY, "admin", "admin-a");
    const adminB = as(OTHER, "owner", "owner-b");
    const read = async (caller: DeployedCaller, query = "") => ((body(await routes.route(get(`/v1/app/org/report/tasks?from=${SINCE}${query}`), caller))) as unknown as ReportTasksResponse).tasks.map((row) => row.taskId);
    expect((await read(adminA)).sort()).toEqual([a1, a2].sort());
    expect(await read(adminB)).toEqual([b1]);
    expect(await read(adminA, "&project=ledger")).toEqual([a2]);
    expect(await read(adminA, "&project=payments")).toEqual([a1]);
    expect(await read(adminB, "&project=ledger")).toEqual([]);
  });

  it("refuses a query it does not know, twice-given parameters, empty values and a limit that is not a number, with fixed words", async () => {
    const { routes, as } = await setup();
    const caller = as(FAKE_COMPANY, "admin", "admin-1");
    for (const query of ["&person=ada", "&project=a&project=b", "&project=", "&limit=abc", "&limit=0", "&limit=5000", "&state=weird"]) {
      const answer = await routes.route(get(`/v1/app/org/report/tasks?from=${SINCE}${query}`), caller);
      expect(answer?.statusCode, query).toBe(400);
      expect(answer!.body, query).not.toMatch(/ada|weird|abc/u);
    }
    expect((await routes.route(get("/v1/app/org/report/tasks"), caller))?.statusCode).toBe(400);
  });

  it("a store fault is a fixed 503 that echoes nothing", async () => {
    const { world, routes, as, start } = await setup();
    await start(FAKE_COMPANY, "p1");
    const caller = as(FAKE_COMPANY, "admin", "admin-1");
    vi.spyOn(world.store, "query").mockRejectedValue(new Error("secret-canary down"));
    const answer = await routes.route(get(`/v1/app/org/report/tasks?from=${SINCE}`), caller);
    expect(answer?.statusCode).toBe(503);
    expect(answer!.body).not.toContain("secret-canary");
    vi.restoreAllMocks();
  });
});

describe("features: the routes", () => {
  it("makes, lists, renames, marks done, merges: each by an admin, each audited, each in its own company", async () => {
    const { world, routes, as } = await setup();
    const admin = as(FAKE_COMPANY, "admin", "admin-1");
    const created = await routes.route(post("/v1/app/org/report/features", { name: "Checkout v2", trackerLink: { tracker: "linear", id: "PRJ-9", url: "https://linear.app/x/project/prj-9" } }), admin);
    expect(created?.statusCode).toBe(201);
    const first = (body(created) as { feature: { id: string; name: string; state: string } }).feature;
    expect(first).toMatchObject({ name: "Checkout v2", state: "open" });
    const second = (body(await routes.route(post("/v1/app/org/report/features", { name: "Billing" }), admin)) as { feature: { id: string } }).feature;
    expect((await routes.route(post("/v1/app/org/report/features", { name: "checkout V2" }), admin))?.statusCode).toBe(400);
    const renamed = await routes.route(post(`/v1/app/org/report/features/${first.id}/rename`, { name: "Checkout v3" }), admin);
    expect((body(renamed) as { feature: { name: string } }).feature.name).toBe("Checkout v3");
    expect((body(await routes.route(post(`/v1/app/org/report/features/${second.id}/state`, { state: "done" }), admin)) as { feature: { state: string } }).feature.state).toBe("done");
    const listed = (body(await routes.route(get("/v1/app/org/report/features"), admin)) as { features: Array<{ id: string; state: string }> }).features;
    expect(listed.map((f) => [f.id, f.state])).toEqual([[second.id, "done"], [first.id, "open"]]);
    const third = (body(await routes.route(post("/v1/app/org/report/features", { name: "Zeta" }), admin)) as { feature: { id: string } }).feature;
    const merged = await routes.route(post(`/v1/app/org/report/features/${third.id}/merge`, { into: first.id }), admin);
    expect(merged?.statusCode).toBe(200);
    expect((body(merged) as { feature: { id: string } }).feature.id).toBe(first.id);
    expect(((body(await routes.route(get("/v1/app/org/report/features"), admin)) as { features: unknown[] }).features)).toHaveLength(2);
    // the audit records, with the person who did each
    // (the refused duplicate make staged an event too, but its transaction failed: only the committed ones are in the store)
    const committed = (await world.store.query({ pk: `ORG#${FAKE_COMPANY}#AUDIT_OUTBOX`, limit: 100 })).items.filter((row) => typeof row["action"] === "string" && row["action"].startsWith("report.")).map((row) => row["action"]).sort();
    expect(committed).toEqual(["report.feature_created", "report.feature_created", "report.feature_created", "report.feature_merged", "report.feature_renamed", "report.feature_state_changed"]);
    expect(world.audit.filter((event) => event.action.startsWith("report.")).every((event) => event.actor.id === "admin-1" && event.actor.type === "person")).toBe(true);
    // another company sees none of it and its admin cannot touch it
    const other = as(OTHER, "owner", "owner-b");
    expect((body(await routes.route(get("/v1/app/org/report/features"), other)) as { features: unknown[] }).features).toEqual([]);
    for (const request of [post(`/v1/app/org/report/features/${first.id}/rename`, { name: "x" }), post(`/v1/app/org/report/features/${first.id}/state`, { state: "done" }), post(`/v1/app/org/report/features/${first.id}/merge`, { into: "ft_ffffffffffffffffffff" })]) {
      const answer = await routes.route(request, other);
      expect(answer?.statusCode).toBe(404);
      expect(body(answer).error!.message).toBe(FEATURE_NOT_FOUND);
    }
  });

  it("refuses a body it does not know, a name that is too long, a feature id that is not one, with fixed words that echo nothing", async () => {
    const { routes, as } = await setup();
    const admin = as(FAKE_COMPANY, "admin", "admin-1");
    for (const [path, payload] of [
      ["/v1/app/org/report/features", { name: "x", extra: "canary-extra" }], ["/v1/app/org/report/features", { name: "y".repeat(81) }], ["/v1/app/org/report/features", { name: "" }], ["/v1/app/org/report/features", "{not json canary-json"],
      ["/v1/app/org/report/features", { name: "x", trackerLink: { tracker: "linear", id: "1", url: "http://insecure.example/canary" } }],
      ["/v1/app/org/report/features/ft_00000000000000000001/state", { state: "canary-state" }], ["/v1/app/org/report/features/ft_00000000000000000001/merge", { into: "canary-id" }],
    ] as const) {
      const answer = await routes.route(post(path, payload), admin);
      expect(answer?.statusCode, JSON.stringify(payload)).toBe(400);
      expect(answer!.body).not.toMatch(/canary/u);
    }
    // a path id that is not a feature id is a missing feature
    expect((await routes.route(post("/v1/app/org/report/features/not-a-feature/rename", { name: "x" }), admin))?.statusCode).toBe(404);
  });
});

describe("store faults on the feature routes", () => {
  it("a store that fails on a write is a fixed 503 that echoes nothing (never a raw 500)", async () => {
    const { world, routes, as } = await setup();
    const admin = as(FAKE_COMPANY, "admin", "admin-1");
    vi.spyOn(world.store, "transact").mockRejectedValue(new Error("secret-canary down"));
    const answer = await routes.route(post("/v1/app/org/report/features", { name: "Anything" }), admin);
    expect(answer?.statusCode).toBe(503);
    expect(answer!.body).not.toContain("secret-canary");
    vi.restoreAllMocks();
  });
});

describe("filing and moving a task", () => {
  async function filed() {
    const w = await setup({ [`${FAKE_COMPANY}|payments|maint-pay`]: "manage", [`${FAKE_COMPANY}|ledger|maint-led`]: "manage", [`${OTHER}|payments|maint-b`]: "manage", [`${FAKE_COMPANY}|payments|viewer`]: "view" });
    const admin = w.as(FAKE_COMPANY, "admin", "admin-1");
    const feature = async (name: string) => ((body(await w.routes.route(post("/v1/app/org/report/features", { name }), admin)) as { feature: { id: string } }).feature.id);
    const [one, two, three] = [await feature("One"), await feature("Two"), await feature("Three")];
    const taskId = await w.start(FAKE_COMPANY, "starter-1", "payments");
    const move = (caller: DeployedCaller, id: string, featureId: string | null, extra: Record<string, unknown> = {}) => w.routes.route(post(`/v1/app/tasks/${id}/feature`, { feature: featureId, ...extra }), caller);
    const read = async () => ((body(await w.routes.route(get(`/v1/app/org/report/tasks?from=${SINCE}`), admin)) as unknown as ReportTasksResponse).tasks.find((row) => row.taskId === taskId));
    return { ...w, admin, one, two, three, taskId, move, read };
  }

  it("the task's starter files it once; a maintainer then moves it; the starter cannot file or move it again", async () => {
    const w = await filed();
    const starter = w.as(FAKE_COMPANY, "member", "starter-1");
    const first = await w.move(starter, w.taskId, w.one);
    expect(first?.statusCode).toBe(200);
    expect(body(first)).toEqual({ task: { taskId: w.taskId, feature: { id: w.one, source: "chosen" } } });
    expect((await w.read())!.feature).toEqual({ id: w.one, source: "chosen" });
    // a second filing by the starter is a move, which is a maintainer's
    const again = await w.move(starter, w.taskId, w.two);
    expect(again?.statusCode).toBe(403);
    expect(body(again).error!.message).toBe(TASK_FEATURE_NEEDS_MAINTAINER);
    const moved = await w.move(w.as(FAKE_COMPANY, "member", "maint-pay"), w.taskId, w.three);
    expect(body(moved)).toEqual({ task: { taskId: w.taskId, feature: { id: w.three, source: "moved" } } });
    const back = await w.move(starter, w.taskId, w.one);
    expect(back?.statusCode).toBe(403);
    expect(body(back).error!.message).toBe(TASK_FEATURE_NEEDS_MAINTAINER);
    expect((await w.read())!.feature).toEqual({ id: w.three, source: "moved" });
  });

  it.each(["tracker", "confirmed_at_plan"] as const)("the starter replaces a %s suggestion with Change or No feature", async (source) => {
    for (const empty of [false, true]) {
      const w = await filed();
      const { createFeatureStore } = await import("../../packages/broker/src/core/report/feature-store.js");
      const store = createFeatureStore({ store: w.world.store, companyId: FAKE_COMPANY, audit: { stage: () => [] }, now: () => Date.now() });
      await store.setTaskFeature({ taskId: w.taskId, project: "payments", featureId: w.one, source }, { type: "system", id: "tracker" });
      const starter = w.as(FAKE_COMPANY, "member", "starter-1");
      const answer = await w.move(starter, w.taskId, empty ? null : w.two);
      expect(answer?.statusCode).toBe(200);
      expect(await store.taskFeature(w.taskId)).toMatchObject({ featureId: empty ? null : w.two, source: "chosen" });
    }
  });

  it("the starter cannot replace an inheritance or a maintainer's deliberate No feature", async () => {
    const w = await filed();
    const { createFeatureStore } = await import("../../packages/broker/src/core/report/feature-store.js");
    const store = createFeatureStore({ store: w.world.store, companyId: FAKE_COMPANY, audit: { stage: () => [] }, now: () => Date.now() });
    await store.setTaskFeature({ taskId: w.taskId, project: "payments", featureId: w.one, source: "inherited" }, { type: "system", id: "tracker" });
    const starter = w.as(FAKE_COMPANY, "member", "starter-1");
    expect((await w.move(starter, w.taskId, w.two))?.statusCode).toBe(403);
    await w.move(w.as(FAKE_COMPANY, "member", "maint-pay"), w.taskId, null);
    expect((await w.move(starter, w.taskId, w.two))?.statusCode).toBe(403);
  });

  it("an owner, an admin, and the project's maintainer move it; 'No feature' is a move too, and shows as no feature", async () => {
    const w = await filed();
    await w.move(w.as(FAKE_COMPANY, "member", "starter-1"), w.taskId, w.one);
    expect(body(await w.move(w.admin, w.taskId, w.two)).task).toMatchObject({ feature: { id: w.two, source: "moved" } });
    expect(body(await w.move(w.as(FAKE_COMPANY, "owner", "owner-1"), w.taskId, w.three)).task).toMatchObject({ feature: { id: w.three, source: "moved" } });
    const none = await w.move(w.as(FAKE_COMPANY, "member", "maint-pay"), w.taskId, null);
    expect(body(none)).toEqual({ task: { taskId: w.taskId, feature: null } });
    expect(await w.read()).not.toHaveProperty("feature");
  });

  it("every filing by a maintainer, an owner or an admin is a move (the highest rule), the first one too", async () => {
    const w = await filed();
    const maintainer = w.as(FAKE_COMPANY, "member", "maint-pay");
    expect(body(await w.move(maintainer, w.taskId, w.one)).task).toMatchObject({ feature: { source: "moved" } });
    expect(body(await w.move(maintainer, w.taskId, w.two)).task).toMatchObject({ feature: { source: "moved" } });
  });

  it("a setup run and a replay cannot be filed: they read as missing tasks", async () => {
    const w = await filed();
    for (const patch of [{ purpose: "setup_agent" }, { origin: "test_run" }]) {
      const id = await w.start(FAKE_COMPANY, "starter-1", "payments");
      await w.world.store.update({ key: { pk: `DEVTASK#${id}`, sk: "META" }, ops: Object.entries(patch).map(([name, value]) => ({ op: "set" as const, path: [name] as [string], value })) });
      expect((await w.move(w.admin, id, w.one))?.statusCode).toBe(404);
    }
  });

  it("a person who neither started the task nor maintains its project gets exactly the missing task's answer (a viewer, another project's maintainer, a stranger, another company's maintainer)", async () => {
    const w = await filed();
    const missing = await w.move(w.admin, randomUUID(), w.one).then((answer) => answer);
    expect(missing?.statusCode).toBe(404);
    for (const caller of [w.as(FAKE_COMPANY, "member", "viewer"), w.as(FAKE_COMPANY, "member", "maint-led"), w.as(FAKE_COMPANY, "member", "stranger"), w.as(OTHER, "admin", "maint-b")]) {
      const answer = await w.move(caller, w.taskId, w.one);
      expect(answer?.statusCode, caller.principal.personId).toBe(404);
      expect(answer).toEqual(missing);
      expect(body(answer).error!.message).toBe(TASK_FEATURE_NOT_FOUND);
    }
    expect(await w.read()).not.toHaveProperty("feature");
  });

  it("another company's task id is the missing task's answer even for a maintainer there; the other company's feature id is not found", async () => {
    const w = await filed();
    const theirTask = await w.start(OTHER, "starter-b", "payments");
    const maintainerHere = w.as(FAKE_COMPANY, "member", "maint-pay");
    expect((await w.move(maintainerHere, theirTask, w.one))?.statusCode).toBe(404);
    // a maintainer in OTHER cannot file their task under this company's feature
    const adminB = w.as(OTHER, "owner", "owner-b");
    const answer = await w.move(adminB, theirTask, w.one);
    expect(answer?.statusCode).toBe(404);
    expect(body(answer).error!.message).toBe(FEATURE_NOT_FOUND);
  });

  it("a feature that is done takes no task; one that is merged away takes none; one that does not exist is not found", async () => {
    const w = await filed();
    await w.routes.route(post(`/v1/app/org/report/features/${w.two}/state`, { state: "done" }), w.admin);
    const maintainer = w.as(FAKE_COMPANY, "member", "maint-pay");
    const done = await w.move(maintainer, w.taskId, w.two);
    expect(done?.statusCode).toBe(400);
    expect(body(done).error!.message).toBe(FEATURE_IS_DONE);
    await w.routes.route(post(`/v1/app/org/report/features/${w.three}/merge`, { into: w.one }), w.admin);
    expect((await w.move(maintainer, w.taskId, w.three))?.statusCode).toBe(404);
    expect((await w.move(maintainer, w.taskId, "ft_ffffffffffffffffffff"))?.statusCode).toBe(404);
  });

  it("a merge moves the task's reading without touching what a person chose: the row follows the merge", async () => {
    const w = await filed();
    await w.move(w.as(FAKE_COMPANY, "member", "starter-1"), w.taskId, w.three);
    await w.routes.route(post(`/v1/app/org/report/features/${w.three}/merge`, { into: w.one }), w.admin);
    expect((await w.read())!.feature).toEqual({ id: w.one, source: "chosen" });
  });

  it("refuses a body with another field, a feature that is not an id, or an empty body; echoes nothing; and never decides on the body what the task's standing says", async () => {
    const w = await filed();
    const starter = w.as(FAKE_COMPANY, "member", "starter-1");
    for (const payload of [{ feature: w.one, requester: "canary-person" }, { feature: "canary-feature" }, {}, { feature: 5 }, "[canary-array]"]) {
      const answer = await w.routes.route(post(`/v1/app/tasks/${w.taskId}/feature`, payload), starter);
      expect(answer?.statusCode, JSON.stringify(payload)).toBe(400);
      expect(answer!.body).not.toMatch(/canary/u);
    }
    // the same refusal for a stranger: an invalid body tells nobody that the task exists
    const stranger = await w.routes.route(post(`/v1/app/tasks/${w.taskId}/feature`, { feature: "canary-feature" }), w.as(FAKE_COMPANY, "member", "stranger"));
    expect(stranger?.statusCode).toBe(400);
  });

  it("a standing that cannot be read is a fixed 503, never a move", async () => {
    const w = await filed();
    w.standing.mockRejectedValueOnce(new Error("secret-canary"));
    const answer = await w.move(w.as(FAKE_COMPANY, "member", "starter-1"), w.taskId, w.one);
    expect(answer?.statusCode).toBe(503);
    expect(answer!.body).not.toContain("secret-canary");
    expect(await w.read()).not.toHaveProperty("feature");
  });

  it("each filing and move writes its audit record naming the person, the task, the feature, the source and the project", async () => {
    const w = await filed();
    await w.move(w.as(FAKE_COMPANY, "member", "starter-1"), w.taskId, w.one);
    await w.move(w.as(FAKE_COMPANY, "member", "maint-pay"), w.taskId, w.two);
    const events = w.world.audit.filter((event) => event.action === "report.task_feature_set");
    expect(events.map((event) => [event.actor.id, event.subject, event.details])).toEqual([
      ["starter-1", { type: "task", id: w.taskId }, { featureId: w.one, source: "chosen", project: "payments" }],
      ["maint-pay", { type: "task", id: w.taskId }, { featureId: w.two, source: "moved", project: "payments" }],
    ]);
    // the stored rows hold no person
    const rows = (await w.world.store.query({ pk: `ORG#${FAKE_COMPANY}#REPORT`, limit: 100 })).items;
    expect(JSON.stringify(rows)).not.toMatch(/starter-1|maint-pay|admin-1/u);
  });
});
