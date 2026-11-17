// DEC 254z-amend3: a project's test environment on the deployed API (`GET /v1/app/projects/<p>/test-environment`, an APP_ROUTES row of its own, full access only). The core serves the laptop's own state answer
// (`testEnvironmentView`) from the company's records: the company is the membership's, a project the person may not read answers exactly like a missing one, another company's records are never read, a script
// token is refused, and the answer says whether test services are on, why they are not available here (hosted Code: "workers"), and which catalog they would use (the owner starter list).
import { describe, expect, it, vi } from "vitest";
import { OWNER_STARTER_IMAGES, TestEnvironmentBodySchema, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { proposeTestEnvironment } from "../../packages/broker/src/core/test-env/environment.js";
import { TEST_SERVICES_UNAVAILABLE_WORDS } from "../../packages/broker/src/core/test-env/test-services-switch.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { appRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { hostedServiceCatalog, markHostedTestServices } from "../../packages/broker/src/aws/hosted-test-services.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const PATH = "/v1/app/projects/payments/test-environment";
const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const BODY = TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "demo", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: { cwd: "demo", executable: "pytest", args: ["-q"], timeoutSeconds: 600 }, kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});

function appOver(world: FakeWorld, env: NodeJS.ProcessEnv): CoreHostApp {
  return createCoreHostApp({
    env, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}

async function setup(switches: NodeJS.ProcessEnv) {
  const world = createFakeWorld();
  for (const companyId of [FAKE_COMPANY, OTHER]) {
    await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
  }
  const app = appOver(world, { ROVARA_CORE_ENGINE: "on" });
  const members = new Map<string, CompanyMembership>();
  const companyOf = vi.fn(async (caller: DeployedCaller) => members.get(caller.principal.personId + caller.principal.companyId));
  const callerOf = (companyId: string): DeployedCaller => {
    const caller: DeployedCaller = { principal: localOwnerPrincipal({ companyId }), client: "cli" };
    members.set(caller.principal.personId + companyId, { companyId, role: "owner" });
    return caller;
  };
  const allowed = new Set<string>(["payments"]);
  const env = { ...switches };
  markHostedTestServices(env);
  const wiring: CoreDevWiring = {
    origin: () => "https://api.example", canReadProject: async (_person, project) => allowed.has(project),
    testEnvironment: { env, serviceCatalog: hostedServiceCatalog(env), catalogName: "owner-starter-list" },
  };
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => wiring });
  return { world, app, routes, callerOf, allowed, companyOf, env };
}
const bodyOf = (answer: { body: string } | undefined) => JSON.parse(answer!.body) as Record<string, unknown> & { error?: { message: string } };

describe("the route table", () => {
  it("has one row for the state read, full access only, and none for proposing, approving or the laptop's image routes", () => {
    expect(appRouteOf("GET", PATH)).toEqual({ method: "GET", path: "/v1/app/projects/{project}/test-environment", requires: "full" });
    for (const [method, path] of [["POST", PATH], ["PUT", PATH], ["DELETE", PATH], ["POST", `${PATH}/propose`], ["POST", `${PATH}/open`], ["GET", `${PATH}/service-images`], ["POST", `${PATH}/service-images/approve`], ["POST", `${PATH}/machine`]] as const) {
      expect(appRouteOf(method, path), `${method} ${path}`).toBeUndefined();
    }
  });
});

describe("the state answer on the deployed API", () => {
  it("hosted Code, nothing set: on, but not available here for the reason 'workers', in fixed words; the catalog is the owner starter list", async () => {
    const h = await setup({});
    const answer = await h.routes.route(get(PATH), h.callerOf(FAKE_COMPANY));
    expect(answer?.statusCode).toBe(200);
    const body = bodyOf(answer);
    expect(body).toMatchObject({ project: "payments", enabled: true, testServices: false, testServicesUnavailable: TEST_SERVICES_UNAVAILABLE_WORDS.workers });
    expect(body["testServicesUnavailable"]).toBe("Test services not available here: this install's workers cannot start them yet");
    const catalog = body["serviceCatalog"] as { name: string; entries: Array<{ id: string }> };
    expect(catalog.name).toBe("owner-starter-list");
    expect(catalog.entries.map((entry) => entry.id).sort()).toEqual(["mongodb@7", "mysql@8", "postgres@16", "postgres@17", "redis@7"]);
  });

  it("the owner's opt-out (td=0): off, no 'not available' words and no catalog", async () => {
    const h = await setup({ ROVARA_TEST_SERVICES: "0" });
    const body = bodyOf(await h.routes.route(get(PATH), h.callerOf(FAKE_COMPANY)));
    expect(body["testServices"]).toBe(false);
    expect("testServicesUnavailable" in body).toBe(false);
    expect("serviceCatalog" in body).toBe(false);
  });

  it("two companies: each reads only its own records under the same project name", async () => {
    const h = await setup({});
    const deps = () => ({ store: h.world.store, now: () => h.world.clock.now, env: { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "0" } });
    await proposeTestEnvironment(deps(), { orgId: FAKE_COMPANY, project: "payments", proposedBy: "owner", body: BODY });
    const mine = bodyOf(await h.routes.route(get(PATH), h.callerOf(FAKE_COMPANY)));
    const theirs = bodyOf(await h.routes.route(get(PATH), h.callerOf(OTHER)));
    expect((mine["proposal"] as { digest?: string } | undefined)?.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(theirs["proposal"]).toBeUndefined();
    expect(theirs["project"]).toBe("payments");
  });

  it("a project the person may not read answers exactly like a missing one, and nothing of it is read", async () => {
    const h = await setup({});
    const caller = h.callerOf(FAKE_COMPANY);
    h.allowed.delete("payments");
    const spy = vi.spyOn(h.world.store, "query");
    const hidden = await h.routes.route(get(PATH), caller);
    h.allowed.add("ghost");
    const missingAnswer = await h.routes.route(get("/v1/app/projects/nothere/test-environment"), caller);
    expect(hidden?.statusCode).toBe(404);
    expect(hidden).toEqual(missingAnswer);
    // A grant read that fails is a refusal too, in the same words.
    const failing = createCoreDevRoutes({ app: h.app, companyOf: h.companyOf, wiring: () => ({ origin: () => "x", canReadProject: async () => { throw new Error("grant table down"); }, testEnvironment: { env: {}, catalogName: "owner-starter-list" as const } }) });
    expect(await failing.route(get(PATH), caller)).toEqual(missingAnswer);
    expect(spy).not.toHaveBeenCalled();
  });

  it("is not served without the access check or the wiring, refuses a script token, refuses a caller with no membership, and leaves every other method to the old broker", async () => {
    const h = await setup({});
    const caller = h.callerOf(FAKE_COMPANY);
    for (const wiring of [{ origin: () => "x", testEnvironment: { env: {}, catalogName: "owner-starter-list" as const } }, { origin: () => "x", canReadProject: async () => true }]) {
      const routes = createCoreDevRoutes({ app: h.app, companyOf: h.companyOf, wiring: () => wiring });
      expect(bodyOf(await routes.route(get(PATH), caller)).error?.message).toBe(NOT_ON_THE_CORE_YET);
    }
    const token = await h.routes.route(get(PATH), { ...caller, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
    expect(token?.statusCode).toBe(403);
    expect(bodyOf(token).error?.message).toBe(NOT_FOR_SCRIPT_TOKENS);
    const stranger: DeployedCaller = { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: "nobody" }), client: "cli" };
    expect((await h.routes.route(get(PATH), stranger))?.statusCode).toBe(401);
    for (const method of ["POST", "PUT", "DELETE"]) expect(await h.routes.route({ ...get(PATH), method }, caller), method).toBeUndefined();
  });

  it("with the core switch off: nothing answers and nothing is read", async () => {
    const h = await setup({});
    const off = createCoreDevRoutes({ app: appOver(h.world, {}), companyOf: h.companyOf, wiring: () => ({ origin: () => "x", canReadProject: async () => true, testEnvironment: { env: {}, catalogName: "owner-starter-list" } }) });
    expect(await off.route(get(PATH), h.callerOf(FAKE_COMPANY))).toBeUndefined();
    expect(h.companyOf).not.toHaveBeenCalled();
  });
});

describe("the hosted host's facts", () => {
  it("marks test services unavailable for 'workers' while they are switched on, keeps a marker already there, and marks nothing with the opt-out or once the workers run them", () => {
    const on: Record<string, string | undefined> = {};
    expect(markHostedTestServices(on)).toBe("workers");
    expect(on).toEqual({ ROVARA_TEST_SERVICES_UNAVAILABLE: "workers" });
    const kept: Record<string, string | undefined> = { ROVARA_TEST_SERVICES_UNAVAILABLE: "images" };
    expect(markHostedTestServices(kept)).toBe("images");
    const off: Record<string, string | undefined> = { ROVARA_TEST_SERVICES: "0" };
    expect(markHostedTestServices(off)).toBeUndefined();
    expect(off).toEqual({ ROVARA_TEST_SERVICES: "0" });
    const ready: Record<string, string | undefined> = { ROVARA_TEST_SERVICES: "1" };
    expect(markHostedTestServices(ready, true)).toBeUndefined();
    expect(ready).toEqual({ ROVARA_TEST_SERVICES: "1" });
  });

  it("the hosted catalog is the starter list exactly: the same families, versions and pinned digests as the laptop, nothing else; none with the opt-out", async () => {
    const catalog = await hostedServiceCatalog({})!();
    expect(catalog?.pinned).toBe(true);
    const pins = catalog!.entries.map((entry) => `${entry.family}@${entry.version}@${entry.image.digest ?? ""}`).sort();
    const starters = OWNER_STARTER_IMAGES.map((image) => `${image.family}@${image.version}@${image.reference.slice(image.reference.indexOf("@sha256:") + 8)}`).sort();
    expect(pins).toEqual(starters);
    expect(catalog!.entries.every((entry) => entry.backing === "local" && entry.ownerApproved === true)).toBe(true);
    expect(hostedServiceCatalog({ ROVARA_TEST_SERVICES: "0" })).toBeUndefined();
  });
});

describe("the hosted functions' start", () => {
  it("broker-environment-init marks test services unavailable for 'workers' after unpacking the settings, and an opt-out in the settings means no marker", async () => {
    const saved = { ...process.env };
    try {
      for (const key of ["AGENTX_NAMES", "AGENTX_SETTINGS", "ROVARA_TEST_SERVICES", "ROVARA_TEST_SERVICES_UNAVAILABLE"]) delete process.env[key];
      vi.resetModules();
      await import("../../packages/broker/src/aws/broker-environment-init.js");
      expect(process.env["ROVARA_TEST_SERVICES_UNAVAILABLE"]).toBe("workers");
      delete process.env["ROVARA_TEST_SERVICES_UNAVAILABLE"];
      Object.assign(process.env, { AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging", AGENTX_SETTINGS: "td=0" });
      vi.resetModules();
      await import("../../packages/broker/src/aws/broker-environment-init.js");
      expect(process.env["ROVARA_TEST_SERVICES"]).toBe("0");
      expect(process.env["ROVARA_TEST_SERVICES_UNAVAILABLE"]).toBeUndefined();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      vi.resetModules();
    }
  });
});
