// DEC 254z-amend3: a project's test environment on the deployed API (`GET /v1/app/projects/<p>/test-environment`, an APP_ROUTES row of its own, full access only). The core serves the laptop's own state answer
// (`testEnvironmentView`) from the company's records: the company is the membership's, a project the person may not read answers exactly like a missing one, another company's records are never read, a script
// token is refused, and the answer says whether test services are on, why they are not available here (hosted Code: "workers"), and which catalog they would use (the owner starter list).
import { describe, expect, it, vi } from "vitest";
import { TestEnvironmentBodySchema, testEnvDigest, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { proposeTestEnvironment } from "../../packages/broker/src/core/test-env/environment.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
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
  const callerOf = (companyId: string, role: CompanyMembership["role"] = "owner", personId?: string): DeployedCaller => {
    const caller: DeployedCaller = { principal: localOwnerPrincipal({ companyId, ...(personId === undefined ? {} : { personId }) }), client: "cli" };
    members.set(caller.principal.personId + companyId, { companyId, role });
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
  return { world, app, routes, callerOf, allowed, companyOf, env, members };
}
const bodyOf = (answer: { body: string } | undefined) => JSON.parse(answer!.body) as Record<string, unknown> & { error?: { message: string } };

describe("the state answer on the deployed API", () => {

  it("the owner's opt-out (td=0): off, no 'not available' words and no catalog", async () => {
    const h = await setup({ ROVARA_TEST_SERVICES: "0" });
    const body = bodyOf(await h.routes.route(get(PATH), h.callerOf(FAKE_COMPANY)));
    expect(body["testServices"]).toBe(false);
    expect("testServicesUnavailable" in body).toBe(false);
    expect("serviceCatalog" in body).toBe(false);
  });

  it("Cloud #188 item 4: the proposal that waits carries its whole proposed body, exactly the stored one for the digest it names, with the revision approving it makes; the other company's read carries none", async () => {
    const h = await setup({});
    const deps = () => ({ store: h.world.store, now: () => h.world.clock.now, env: { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "0" } });
    await proposeTestEnvironment(deps(), { orgId: FAKE_COMPANY, project: "payments", proposedBy: "owner", body: BODY });
    const proposal = bodyOf(await h.routes.route(get(PATH), h.callerOf(FAKE_COMPANY)))["proposal"] as { digest: string; nextRevision: number; environment?: unknown };
    expect(proposal.digest).toBe(testEnvDigest(BODY));
    expect(proposal.nextRevision).toBe(1);
    expect(TestEnvironmentBodySchema.parse(proposal.environment)).toEqual(BODY);
    expect(testEnvDigest(TestEnvironmentBodySchema.parse(proposal.environment))).toBe(proposal.digest);
    // A member with the grant reads the same; a member without it reads nothing; the other company's same-named project carries no proposal or body.
    expect((bodyOf(await h.routes.route(get(PATH), h.callerOf(FAKE_COMPANY, "member", "reader")))["proposal"] as { environment?: unknown }).environment).toEqual(proposal.environment);
    const theirs = await h.routes.route(get(PATH), h.callerOf(OTHER));
    expect(bodyOf(theirs)["proposal"]).toBeUndefined();
    expect(theirs!.body).not.toContain("pytest");
    h.allowed.delete("payments");
    const hidden = await h.routes.route(get(PATH), h.callerOf(FAKE_COMPANY, "member", "reader"));
    expect(hidden?.statusCode).toBe(404);
    expect(hidden!.body).not.toContain("pytest");
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
});

// L4-B3c: the state read admits a live company owner or admin without a project grant (the same reach the approve route has), for projects of THEIR company only; every other person needs the grant.
// `allowed` is the hosted grant check (`projectGrant`): it knows nothing of company roles, exactly as in core-engine-root.ts.
describe("the state read by company role (owner or admin without a project grant)", () => {
  const deps = (h: Awaited<ReturnType<typeof setup>>) => ({ store: h.world.store, now: () => h.world.clock.now, env: { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "0" } });
  const digestOf = (answer: { body: string } | undefined) => (bodyOf(answer)["proposal"] as { digest?: string } | undefined)?.digest;
  const NOT_FOUND = (h: Awaited<ReturnType<typeof setup>>) => h.routes.route(get("/v1/app/projects/nothere/test-environment"), h.callerOf(FAKE_COMPANY, "member", "reader-of-nothing"));

  it.each(["owner", "admin"] as const)("a live %s with no grant on the project reads its proposal", async (role) => {
    const h = await setup({});
    h.allowed.delete("payments");
    await proposeTestEnvironment(deps(h), { orgId: FAKE_COMPANY, project: "payments", proposedBy: "dev", body: BODY });
    const answer = await h.routes.route(get(PATH), h.callerOf(FAKE_COMPANY, role, `${role}-no-grant`));
    expect(answer?.statusCode).toBe(200);
    expect(digestOf(answer)).toMatch(/^[a-f0-9]{64}$/u);
    expect(bodyOf(answer)["project"]).toBe("payments");
  });

  it("an owner whose grant read fails still reads (the shortcut does not depend on the grant), and a member whose grant read fails gets the missing-project words", async () => {
    const h = await setup({});
    await proposeTestEnvironment(deps(h), { orgId: FAKE_COMPANY, project: "payments", proposedBy: "dev", body: BODY });
    const failing = createCoreDevRoutes({ app: h.app, companyOf: h.companyOf, wiring: () => ({ origin: () => "x", canReadProject: async () => { throw new Error("grant table down"); }, testEnvironment: { env: h.env, catalogName: "owner-starter-list" as const } }) });
    expect((await failing.route(get(PATH), h.callerOf(FAKE_COMPANY, "owner", "o1")))?.statusCode).toBe(200);
    const member = await failing.route(get(PATH), h.callerOf(FAKE_COMPANY, "member", "m1"));
    expect(member).toEqual(await NOT_FOUND(h));
  });
});

describe("the hosted functions' start", () => {
  it("broker-environment-init marks test services unavailable for 'workers' after unpacking the settings, and an opt-out in the settings means no marker", async () => {
    const saved = { ...process.env };
    try {
      for (const key of ["AGENTX_NAMES", "AGENTX_SETTINGS", "ROVARA_TEST_SERVICES", "ROVARA_TEST_SERVICES_HOSTED_IMAGES", "ROVARA_TEST_SERVICES_UNAVAILABLE"]) delete process.env[key];
      vi.resetModules();
      await import("../../packages/broker/src/aws/broker-environment-init.js");
      expect(process.env["ROVARA_TEST_SERVICES_UNAVAILABLE"]).toBe("workers");
      delete process.env["ROVARA_TEST_SERVICES_UNAVAILABLE"];
      Object.assign(process.env, { AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging", AGENTX_SETTINGS: "td=0" });
      vi.resetModules();
      await import("../../packages/broker/src/aws/broker-environment-init.js");
      expect(process.env["ROVARA_TEST_SERVICES"]).toBe("0");
      expect(process.env["ROVARA_TEST_SERVICES_UNAVAILABLE"]).toBeUndefined();
      // DEC 254zm: the packed `ti=mirrored` lets the workers run them: no marker.
      for (const key of ["AGENTX_SETTINGS", "ROVARA_TEST_SERVICES", "ROVARA_TEST_SERVICES_HOSTED_IMAGES", "ROVARA_TEST_SERVICES_UNAVAILABLE"]) delete process.env[key];
      Object.assign(process.env, { AGENTX_SETTINGS: "td=1,ti=mirrored" });
      vi.resetModules();
      await import("../../packages/broker/src/aws/broker-environment-init.js");
      expect(process.env["ROVARA_TEST_SERVICES_HOSTED_IMAGES"]).toBe("mirrored");
      expect(process.env["ROVARA_TEST_SERVICES_UNAVAILABLE"]).toBeUndefined();
      for (const key of ["AGENTX_SETTINGS", "ROVARA_TEST_SERVICES", "ROVARA_TEST_SERVICES_HOSTED_IMAGES", "ROVARA_TEST_SERVICES_UNAVAILABLE"]) delete process.env[key];
      Object.assign(process.env, { AGENTX_SETTINGS: "td=1,ti=none" });
      vi.resetModules();
      await import("../../packages/broker/src/aws/broker-environment-init.js");
      expect(process.env["ROVARA_TEST_SERVICES_UNAVAILABLE"]).toBe("workers");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      vi.resetModules();
    }
  });
});
