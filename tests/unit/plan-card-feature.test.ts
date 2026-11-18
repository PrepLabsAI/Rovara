// Lead 4 PCF: the plan card's feature line and its "Change" choices. The core module (line wording, the read, who may change it) and `GET /v1/app/tasks/{id}/feature-choices` on the deployed API: the same people as
// the filing route, two companies, two projects, open features only, names the company's own, fixed words that echo nothing.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  FeatureChoicesResponseSchema, PlanFeatureSchema, TASK_FEATURE_NOT_FOUND, orgProjectCatalogKey, projectRevisionKey,
  type JsonValue, type ProjectDefinition,
} from "@agentx/contracts";
import { DocumentAuditSink } from "@agentx/local-adapters";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { isReportPath } from "../../packages/broker/src/core-host/report-routes.js";
import { createFeatureStore } from "../../packages/broker/src/core/report/feature-store.js";
import { mayReplaceTaskFeature, planFeatureChoices, planFeatureLine, readPlanFeature } from "../../packages/broker/src/core/report/plan-feature.js";
import type { SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const OTHER = "org_corehost00000000000b";
const project = (name: string): ProjectDefinition => ({
  name, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });

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


const world0 = () => createFakeWorld();
const feat = (w: FakeWorld, companyId: string = FAKE_COMPANY) => createFeatureStore({ store: w.store, companyId, audit: new DocumentAuditSink({ store: () => w.store }), now: () => w.clock.now });
const SYSTEM = { type: "system", id: "test" } as const;

describe("the plan card's feature line", () => {
  it("the card's source words are the report's: one list, in the same order", async () => {
    const { FEATURE_SOURCES, PLAN_FEATURE_SOURCES } = await import("@agentx/contracts");
    expect([...PLAN_FEATURE_SOURCES]).toEqual([...FEATURE_SOURCES]);
  });

  it("words each source in one line, and a person's name stays one line", () => {
    expect(planFeatureLine(null)).toBe("Feature: No feature");
    expect(planFeatureLine({ name: "Checkout v2", source: "tracker", tracker: "linear" })).toBe("Feature: Checkout v2 (from the Linear parent)");
    expect(planFeatureLine({ name: "Checkout v2", source: "tracker", tracker: "jira" })).toBe("Feature: Checkout v2 (from the Jira epic)");
    expect(planFeatureLine({ name: "Checkout v2", source: "tracker" })).toBe("Feature: Checkout v2 (from the tracker)");
    expect(planFeatureLine({ name: "Checkout v2", source: "tracker", tracker: "github" })).toBe("Feature: Checkout v2 (from the tracker)");
    expect(planFeatureLine({ name: "A", source: "inherited" })).toBe("Feature: A (from the task it follows)");
    expect(planFeatureLine({ name: "A", source: "confirmed_at_plan" })).toBe("Feature: A (confirmed at plan approval)");
    expect(planFeatureLine({ name: "A", source: "chosen" })).toBe("Feature: A (chosen)");
    expect(planFeatureLine({ name: "A", source: "moved" })).toBe("Feature: A (chosen)");
    const messy = planFeatureLine({ name: "Line one\nline\u0000 two\u202e" + "x".repeat(200), source: "chosen" });
    expect([...messy].every((character) => character.codePointAt(0)! > 31 && character !== "\u202e")).toBe(true);
    expect(messy.length).toBeLessThanOrEqual(200);
    expect(PlanFeatureSchema.safeParse({ line: messy, feature: null, canChange: false, canCreate: false }).success).toBe(true);
  });

  it("mayReplaceTaskFeature: a manager always, the starter a first filing or a suggestion only", () => {
    expect(mayReplaceTaskFeature(true, "moved")).toBe(true);
    for (const source of [undefined, "tracker", "confirmed_at_plan"] as const) expect(mayReplaceTaskFeature(false, source), String(source)).toBe(true);
    for (const source of ["chosen", "moved", "inherited"] as const) expect(mayReplaceTaskFeature(false, source), source).toBe(false);
  });
});

describe("reading the plan card's feature", () => {
  const task = (taskId: string) => ({ taskId, project: "payments" });
  const id = () => randomUUID();
  const who = (over: Partial<{ mayFile: boolean; manager: boolean; admin: boolean }> = {}) => ({ mayFile: true, manager: false, admin: false, ...over });

  it("a task with no filing reads as No feature, and the starter may change it", async () => {
    const w = world0();
    const read = await readPlanFeature({ store: w.store, companyId: FAKE_COMPANY, now: () => w.clock.now }, task(id()), who());
    expect(read).toEqual({ line: "Feature: No feature", feature: null, canChange: true, canCreate: false });
  });

  it("names the tracker's suggestion with its words, and follows a merge to the target", async () => {
    const w = world0();
    const features = feat(w);
    const parent = await features.create({ name: "Checkout v2", trackerLink: { tracker: "linear", id: "PRJ-1", url: "https://linear.app/x/project/1" } }, SYSTEM);
    const target = await features.create({ name: "Payments" }, SYSTEM);
    const taskId = id();
    await features.setTaskFeature({ taskId, project: "payments", featureId: parent.id, source: "tracker" }, SYSTEM);
    const deps = { store: w.store, companyId: FAKE_COMPANY, now: () => w.clock.now };
    expect((await readPlanFeature(deps, task(taskId), who()))!.line).toBe("Feature: Checkout v2 (from the Linear parent)");
    await features.merge(parent.id, target.id, SYSTEM);
    const merged = await readPlanFeature(deps, task(taskId), who());
    expect(merged!.feature).toEqual({ id: target.id, name: "Payments", source: "tracker" });
  });

  it("canChange needs mayFile AND the filing rule; canCreate needs canChange AND an owner or admin", async () => {
    const w = world0();
    const features = feat(w);
    const one = await features.create({ name: "One" }, SYSTEM);
    const deps = { store: w.store, companyId: FAKE_COMPANY, now: () => w.clock.now };
    const suggested = id(), chosen = id();
    await features.setTaskFeature({ taskId: suggested, project: "payments", featureId: one.id, source: "tracker" }, SYSTEM);
    await features.setTaskFeature({ taskId: chosen, project: "payments", featureId: one.id, source: "chosen" }, SYSTEM);
    const cases: Array<[string, string, Parameters<typeof who>[0], { canChange: boolean; canCreate: boolean }]> = [
      ["suggestion, starter", suggested, {}, { canChange: true, canCreate: false }],
      ["suggestion, starter who is admin", suggested, { admin: true }, { canChange: true, canCreate: true }],
      ["suggestion, may not file", suggested, { mayFile: false, admin: true, manager: true }, { canChange: false, canCreate: false }],
      ["chosen, starter", chosen, {}, { canChange: false, canCreate: false }],
      ["chosen, starter who is admin but not manager", chosen, { admin: true }, { canChange: false, canCreate: false }],
      ["chosen, manager", chosen, { manager: true, admin: true }, { canChange: true, canCreate: true }],
    ];
    for (const [name, taskId, over, expected] of cases) {
      const read = await readPlanFeature(deps, task(taskId), who(over));
      expect({ canChange: read!.canChange, canCreate: read!.canCreate }, name).toEqual(expected);
      expect(read!.line).toContain("One");
    }
  });

  it("two companies: another company's filing and features never show, and an assignment for another project is ignored", async () => {
    const w = world0();
    const theirs = await feat(w, OTHER).create({ name: "Their secret feature" }, SYSTEM);
    const taskId = id();
    await feat(w, OTHER).setTaskFeature({ taskId, project: "payments", featureId: theirs.id, source: "chosen" }, SYSTEM);
    const deps = { store: w.store, companyId: FAKE_COMPANY, now: () => w.clock.now };
    const read = await readPlanFeature(deps, task(taskId), who());
    expect(read!.feature).toBeNull();
    expect(JSON.stringify(read)).not.toContain("secret");
    expect(await planFeatureChoices(deps)).toEqual([]);
    // the same company, but the row names another project than the task's: the task view ignores it, and so does the card
    const mine = await feat(w).create({ name: "Mine" }, SYSTEM);
    const other = id();
    await feat(w).setTaskFeature({ taskId: other, project: "ledger", featureId: mine.id, source: "chosen" }, SYSTEM);
    expect((await readPlanFeature(deps, task(other), who()))!.feature).toBeNull();
  });

  it("a store fault gives no line and never throws; a read never writes", async () => {
    const w = world0();
    const deps = { store: w.store, companyId: FAKE_COMPANY, now: () => w.clock.now };
    vi.spyOn(w.store, "get").mockRejectedValue(new Error("canary-down"));
    expect(await readPlanFeature(deps, task(id()), who())).toBeUndefined();
    vi.restoreAllMocks();
    const transact = vi.spyOn(w.store, "transact");
    const put = vi.spyOn(w.store, "put");
    await readPlanFeature(deps, task(id()), who());
    await planFeatureChoices(deps);
    expect(transact).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("the picker lists open features only (not done, not merged away), by name, at most 50", async () => {
    const w = world0();
    const features = feat(w);
    const deps = { store: w.store, companyId: FAKE_COMPANY, now: () => w.clock.now };
    const done = await features.create({ name: "Done one" }, SYSTEM);
    await features.setState(done.id, "done", SYSTEM);
    const gone = await features.create({ name: "Merged away" }, SYSTEM);
    const keep = await features.create({ name: "Beta" }, SYSTEM);
    await features.merge(gone.id, keep.id, SYSTEM);
    await features.create({ name: "Alpha" }, SYSTEM);
    expect((await planFeatureChoices(deps)).map((item) => item.name)).toEqual(["Alpha", "Beta"]);
    for (let n = 0; n < 60; n += 1) await features.create({ name: `Bulk ${String(n).padStart(2, "0")}` }, SYSTEM);
    expect(await planFeatureChoices(deps)).toHaveLength(50);
  });
});

describe("GET /v1/app/tasks/{id}/feature-choices on the deployed API", () => {
  const choices = (id: string) => get(`/v1/app/tasks/${id}/feature-choices`);
  async function started() {
    const w = await setup({ [`${FAKE_COMPANY}|payments|maint-pay`]: "manage", [`${FAKE_COMPANY}|ledger|maint-led`]: "manage", [`${OTHER}|payments|maint-b`]: "manage", [`${FAKE_COMPANY}|payments|viewer`]: "view" });
    const admin = w.as(FAKE_COMPANY, "admin", "admin-1");
    const make = async (name: string) => ((body(await w.routes.route(post("/v1/app/org/report/features", { name }), admin)) as { feature: { id: string } }).feature.id);
    const one = await make("Zulu"), two = await make("Alpha");
    const done = await make("Old");
    await w.routes.route(post(`/v1/app/org/report/features/${done}/state`, { state: "done" }), admin);
    const taskId = await w.start(FAKE_COMPANY, "starter-1", "payments");
    return { ...w, admin, one, two, done, taskId };
  }

  it("is a report path for GET only", () => {
    expect(isReportPath(`/v1/app/tasks/${randomUUID()}/feature-choices`, "GET")).toBe(true);
    for (const method of ["POST", "PUT", "DELETE"]) expect(isReportPath(`/v1/app/tasks/${randomUUID()}/feature-choices`, method), method).toBe(false);
    expect(isReportPath("/v1/app/tasks/x/feature-choices/extra", "GET")).toBe(false);
  });

  it("the starter, a maintainer of the project, an owner and an admin read the open features by name; nobody else does", async () => {
    const t = await started();
    const read = async (caller: DeployedCaller) => t.routes.route(choices(t.taskId), caller);
    for (const [caller, canCreate] of [[t.as(FAKE_COMPANY, "member", "starter-1"), false], [t.as(FAKE_COMPANY, "member", "maint-pay"), false], [t.as(FAKE_COMPANY, "admin", "admin-2"), true], [t.as(FAKE_COMPANY, "owner", "owner-1"), true]] as const) {
      const answer = await read(caller);
      expect(answer?.statusCode, caller.principal.personId).toBe(200);
      const parsed = FeatureChoicesResponseSchema.parse(body(answer));
      expect(parsed.features.map((item) => item.name)).toEqual(["Alpha", "Zulu"]);
      expect(parsed.canCreate).toBe(canCreate);
    }
    // not the starter, not a maintainer of THIS project (a maintainer of another project, a viewer, a plain member): the same 404
    for (const caller of [t.as(FAKE_COMPANY, "member", "maint-led"), t.as(FAKE_COMPANY, "member", "viewer"), t.as(FAKE_COMPANY, "member", "stranger")]) {
      const answer = await read(caller);
      expect(answer?.statusCode, caller.principal.personId).toBe(404);
      expect(body(answer).error!.message).toBe(TASK_FEATURE_NOT_FOUND);
      expect(answer!.body).not.toContain("Zulu");
    }
  });

  it("two companies: another company's task, a missing task, and another company's caller all answer alike, and no feature crosses", async () => {
    const t = await started();
    const theirs = await t.start(OTHER, "someone", "payments");
    const theirAdmin = t.as(OTHER, "admin", "admin-b");
    await t.routes.route(post("/v1/app/org/report/features", { name: "Their canary feature" }), theirAdmin);
    for (const [caller, id] of [[t.as(FAKE_COMPANY, "admin", "admin-3"), theirs], [t.as(FAKE_COMPANY, "admin", "admin-4"), randomUUID()], [theirAdmin, t.taskId]] as const) {
      const answer = await t.routes.route(choices(id), caller);
      expect(answer?.statusCode).toBe(404);
      expect(body(answer).error!.message).toBe(TASK_FEATURE_NOT_FOUND);
    }
    const own = await t.routes.route(choices(theirs), theirAdmin);
    expect(own?.statusCode).toBe(200);
    expect(own!.body).toContain("Their canary feature");
    expect(own!.body).not.toContain("Zulu");
  });

  it("a malformed id is a missing task; a script token never reaches it", async () => {
    const t = await started();
    const admin = t.as(FAKE_COMPANY, "admin", "admin-5");
    expect((await t.routes.route(choices("not-a-task"), admin))?.statusCode).toBe(404);
    expect((await t.routes.route(choices(t.taskId), { ...admin, scriptToken: { tokenId: "sct_1" } }))?.statusCode).toBe(403);
  });

  it("a store fault is a fixed 503 that names nothing; an unwired deployment says so", async () => {
    const t = await started();
    const admin = t.as(FAKE_COMPANY, "admin", "admin-6");
    vi.spyOn(t.world.store, "query").mockRejectedValue(new Error("canary-down"));
    const down = await t.routes.route(choices(t.taskId), admin);
    expect(down?.statusCode).toBe(503);
    expect(down!.body).not.toContain("canary");
    vi.restoreAllMocks();
    const unwired = createCoreDevRoutes({ app: t.app, companyOf: async () => ({ companyId: FAKE_COMPANY, role: "owner" }), wiring: () => ({ origin: () => "x" }) });
    const answer = await unwired.route(choices(t.taskId), admin);
    expect(answer?.statusCode).toBe(404);
    expect(body(answer).error!.message).toBe(NOT_ON_THE_CORE_YET);
  });

  it("the filing route still refuses a second filing by the starter: the card's canChange and the route use the same rule", async () => {
    const t = await started();
    const starter = t.as(FAKE_COMPANY, "member", "starter-1");
    const first = await t.routes.route(post(`/v1/app/tasks/${t.taskId}/feature`, { feature: t.one }), starter);
    expect(first?.statusCode).toBe(200);
    const again = await t.routes.route(post(`/v1/app/tasks/${t.taskId}/feature`, { feature: t.two }), starter);
    expect(again?.statusCode).toBe(403);
    const read = await readPlanFeature({ store: t.world.store, companyId: FAKE_COMPANY, now: () => t.world.clock.now }, { taskId: t.taskId, project: "payments" }, { mayFile: true, manager: false, admin: false });
    expect(read!.canChange).toBe(false);
  });
});
