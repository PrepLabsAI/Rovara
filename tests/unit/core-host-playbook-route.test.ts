// L4-PB (owner decision 254zzj): how we work (`GET /v1/app/projects/<p>/how-we-work` and `.../playbook`) on the deployed API. A live company owner or admin reads it for any project that exists in THEIR company
// without a project grant (the same shortcut as the test environment state read, L4-B3c); everyone else needs the grant; a missing, foreign or unreadable project answers the same words. Writes are unchanged:
// a PUT or POST is not the core's here (the old broker's editor), and a script token is refused.
import { describe, expect, it, vi } from "vitest";
import { agentXError, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const PB = (project: string) => `/v1/app/projects/${project}/playbook`;
const HWW = (project: string) => `/v1/app/projects/${project}/how-we-work`;

function appOver(world: FakeWorld): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}

async function register(world: FakeWorld, companyId: string, name: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify({ ...PROJECT, name })) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
}

/** The fake playbook is per company (wiring(runtime) is called with the company's own runtime) and answers a different view per company AND project, so a read of the wrong one shows. */
async function setup() {
  const world = createFakeWorld();
  await register(world, FAKE_COMPANY, "payments");
  await register(world, FAKE_COMPANY, "ledger");
  await register(world, OTHER, "payments");
  await register(world, OTHER, "vault");
  const app = appOver(world);
  const members = new Map<string, CompanyMembership>();
  const companyOf = vi.fn(async (caller: DeployedCaller) => members.get(caller.principal.personId + caller.principal.companyId));
  const callerOf = (companyId: string, role: CompanyMembership["role"], personId: string): DeployedCaller => {
    const caller: DeployedCaller = { principal: localOwnerPrincipal({ companyId, personId }), client: "cli" };
    members.set(personId + companyId, { companyId, role });
    return caller;
  };
  const allowed = new Set<string>();
  const stateCalls: string[] = [];
  const grantCalls: string[] = [];
  const wiringOf = (runtime: { companyId: string }): CoreDevWiring => ({
    origin: () => "https://api.example",
    canReadProject: async (_person, project) => { grantCalls.push(project); return allowed.has(project); },
    playbook: {
      state: async (project: string) => {
        stateCalls.push(`${runtime.companyId}/${project}`);
        if (project === "ghost") throw agentXError("NOT_FOUND", "There is no project named that here.");
        // A valid view (the route re-reads it through the strict schema); the company and project ride in the process agent id and the playbook's revision-free default process.
        return { view: { project, playbookRevision: 0, process: { kind: "builtin", agentId: `${runtime.companyId}:${project}` }, stages: [], rules: [], modelsEditable: false }, playbook: { revision: 0, defaultProcess: { kind: "builtin" }, steps: [`${runtime.companyId}:${project}`] } } as never;
      },
      preview: vi.fn(),
    } as never,
  });
  const routes = createCoreDevRoutes({ app, companyOf, wiring: wiringOf });
  return { world, app, routes, callerOf, allowed, stateCalls, grantCalls, members, companyOf, wiringOf };
}
type H = Awaited<ReturnType<typeof setup>>;
interface Body { playbook?: unknown; process?: { agentId?: string }; error?: { message?: string } }
const bodyOf = (answer: { body: string } | undefined): Body => JSON.parse(answer!.body) as Body;
/** The words a person who may not read a project gets: exactly a project that is not there. */
const MISSING = (h: H) => h.routes.route(get(PB("nothere")), h.callerOf(FAKE_COMPANY, "member", "reader-of-nothing"));

describe("how we work read by company role (owner or admin without a project grant)", () => {
  it.each(["owner", "admin"] as const)("a live %s with no grant reads the playbook and how we work of a project in their company", async (role) => {
    const h = await setup();
    const caller = h.callerOf(FAKE_COMPANY, role, `${role}-no-grant`);
    const pb = await h.routes.route(get(PB("payments")), caller);
    expect(pb?.statusCode).toBe(200);
    expect(bodyOf(pb).playbook).toMatchObject({ steps: [`${FAKE_COMPANY}:payments`] });
    const hww = await h.routes.route(get(HWW("payments")), caller);
    expect(hww?.statusCode).toBe(200);
    expect(bodyOf(hww).process?.agentId).toBe(`${FAKE_COMPANY}:payments`);
  });

  it("only a real catalog row counts: a row of another kind, or a catalog read that fails, is no project for an owner; a granted owner still reads a project with no catalog row", async () => {
    const h = await setup();
    const owner = h.callerOf(FAKE_COMPANY, "owner", "o5");
    const missing = await MISSING(h);
    await h.world.store.put({ item: { ...orgProjectCatalogKey(FAKE_COMPANY, "wrongkind"), entityType: "SOMETHING_ELSE", latestRevision: 1 } });
    expect(await h.routes.route(get(PB("wrongkind")), owner)).toEqual(missing);
    const realGet = h.world.store.get.bind(h.world.store);
    vi.spyOn(h.world.store, "get").mockImplementation(async (key) => { if (JSON.stringify(key) === JSON.stringify(orgProjectCatalogKey(FAKE_COMPANY, "payments"))) throw new Error("store down"); return realGet(key); });
    expect(await h.routes.route(get(PB("payments")), owner)).toEqual(missing);
    vi.restoreAllMocks();
    h.allowed.add("unlisted");
    expect((await h.routes.route(get(PB("unlisted")), owner))?.statusCode).toBe(200);
  });
});
