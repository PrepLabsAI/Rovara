// L4-PB (owner decision 254zzj): how we work (`GET /v1/app/projects/<p>/how-we-work` and `.../playbook`) on the deployed API. A live company owner or admin reads it for any project that exists in THEIR company
// without a project grant (the same shortcut as the test environment state read, L4-B3c); everyone else needs the grant; a missing, foreign or unreadable project answers the same words. Writes are unchanged:
// a PUT or POST is not the core's here (the old broker's editor), and a script token is refused.
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
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
    env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
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
const bodyOf = (answer: { body: string } | undefined) => JSON.parse(answer!.body) as Record<string, any>;
/** The words a person who may not read a project gets: exactly a project that is not there. */
const MISSING = (h: H) => h.routes.route(get(PB("nothere")), h.callerOf(FAKE_COMPANY, "member", "reader-of-nothing"));

describe("how we work read by company role (owner or admin without a project grant)", () => {
  it.each(["owner", "admin"] as const)("a live %s with no grant reads the playbook and how we work of a project in their company", async (role) => {
    const h = await setup();
    const caller = h.callerOf(FAKE_COMPANY, role, `${role}-no-grant`);
    const pb = await h.routes.route(get(PB("payments")), caller);
    expect(pb?.statusCode).toBe(200);
    expect(bodyOf(pb)["playbook"]).toMatchObject({ steps: [`${FAKE_COMPANY}:payments`] });
    const hww = await h.routes.route(get(HWW("payments")), caller);
    expect(hww?.statusCode).toBe(200);
    expect(bodyOf(hww)["process"]["agentId"]).toBe(`${FAKE_COMPANY}:payments`);
  });

  it("a member with no grant gets exactly the missing-project 404 and nothing of the project is read; the same member WITH the grant reads", async () => {
    const h = await setup();
    const caller = h.callerOf(FAKE_COMPANY, "member", "m1");
    const missing = await MISSING(h);
    h.stateCalls.length = 0;
    for (const path of [PB("payments"), HWW("payments")]) {
      const hidden = await h.routes.route(get(path), caller);
      expect(hidden?.statusCode, path).toBe(404);
      expect(hidden, path).toEqual(missing);
    }
    expect(h.stateCalls).toEqual([]);
    h.allowed.add("payments");
    expect((await h.routes.route(get(PB("payments")), caller))?.statusCode).toBe(200);
    expect((await h.routes.route(get(HWW("payments")), caller))?.statusCode).toBe(200);
  });

  it("an owner or admin asking about a project that does not exist in their company gets the same 404 as a person who may not read it, and nothing is read", async () => {
    const h = await setup();
    const missing = await MISSING(h);
    h.stateCalls.length = 0;
    for (const role of ["owner", "admin"] as const) {
      for (const path of [PB("nothere"), HWW("nothere")]) expect(await h.routes.route(get(path), h.callerOf(FAKE_COMPANY, role, `${role}-gone`)), `${role} ${path}`).toEqual(missing);
    }
    expect(h.stateCalls).toEqual([]);
  });

  it("two companies: an owner of another company gets 404 for a project only this company has, and reads their own company's project of the same name from their own company's records", async () => {
    const h = await setup();
    const theirs = h.callerOf(OTHER, "owner", "other-owner");
    const mine = h.callerOf(FAKE_COMPANY, "owner", "my-owner");
    const missing = await MISSING(h);
    expect(await h.routes.route(get(PB("ledger")), theirs)).toEqual(missing);
    expect(await h.routes.route(get(HWW("ledger")), theirs)).toEqual(missing);
    expect(await h.routes.route(get(PB("vault")), mine)).toEqual(missing);
    h.stateCalls.length = 0;
    expect(bodyOf(await h.routes.route(get(PB("payments")), mine))["playbook"]).toMatchObject({ steps: [`${FAKE_COMPANY}:payments`] });
    expect(bodyOf(await h.routes.route(get(PB("payments")), theirs))["playbook"]).toMatchObject({ steps: [`${OTHER}:payments`] });
    expect(h.stateCalls).toEqual([`${FAKE_COMPANY}/payments`, `${OTHER}/payments`]);
  });

  it("two projects: an owner reads each project's own view, and a member granted one project cannot read the other", async () => {
    const h = await setup();
    const owner = h.callerOf(FAKE_COMPANY, "owner", "o2");
    expect(bodyOf(await h.routes.route(get(PB("payments")), owner))["playbook"]).toMatchObject({ steps: [`${FAKE_COMPANY}:payments`] });
    expect(bodyOf(await h.routes.route(get(PB("ledger")), owner))["playbook"]).toMatchObject({ steps: [`${FAKE_COMPANY}:ledger`] });
    h.allowed.add("payments");
    const member = h.callerOf(FAKE_COMPANY, "member", "m3");
    expect((await h.routes.route(get(PB("payments")), member))?.statusCode).toBe(200);
    expect(await h.routes.route(get(PB("ledger")), member)).toEqual(await MISSING(h));
    expect(await h.routes.route(get(HWW("ledger")), member)).toEqual(await MISSING(h));
  });

  it("the role is read live on every request: an owner who becomes a member (or is removed) loses the shortcut at once", async () => {
    const h = await setup();
    const caller = h.callerOf(FAKE_COMPANY, "owner", "o3");
    expect((await h.routes.route(get(PB("payments")), caller))?.statusCode).toBe(200);
    h.members.set(caller.principal.personId + FAKE_COMPANY, { companyId: FAKE_COMPANY, role: "member" });
    expect((await h.routes.route(get(PB("payments")), caller))?.statusCode).toBe(404);
    h.members.set(caller.principal.personId + FAKE_COMPANY, { companyId: FAKE_COMPANY, role: "admin" });
    expect((await h.routes.route(get(PB("payments")), caller))?.statusCode).toBe(200);
    h.members.delete(caller.principal.personId + FAKE_COMPANY);
    expect((await h.routes.route(get(PB("payments")), caller))?.statusCode).toBe(401);
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

  it("an owner whose grant read fails still reads, and a member whose grant read fails gets the missing-project words", async () => {
    const h = await setup();
    const failing = createCoreDevRoutes({ app: h.app, companyOf: h.companyOf, wiring: (runtime) => ({ ...h.wiringOf(runtime), canReadProject: async () => { throw new Error("grant table down"); } }) });
    expect((await failing.route(get(PB("payments")), h.callerOf(FAKE_COMPANY, "owner", "o6")))?.statusCode).toBe(200);
    expect(await failing.route(get(PB("payments")), h.callerOf(FAKE_COMPANY, "member", "m6"))).toEqual(await MISSING(h));
  });

  it("an owner is not served where the access check is not wired (the shortcut adds no way around that), nor a playbook the deployment has not wired", async () => {
    const h = await setup();
    const noCheck = createCoreDevRoutes({ app: h.app, companyOf: h.companyOf, wiring: (runtime) => { const { canReadProject: _drop, ...rest } = h.wiringOf(runtime); return rest; } });
    const answer = await noCheck.route(get(PB("payments")), h.callerOf(FAKE_COMPANY, "owner", "o7"));
    expect(bodyOf(answer)["error"]["message"]).toBe(NOT_ON_THE_CORE_YET);
    const noPlaybook = createCoreDevRoutes({ app: h.app, companyOf: h.companyOf, wiring: (runtime) => { const { playbook: _drop, ...rest } = h.wiringOf(runtime); return rest; } });
    expect(bodyOf(await noPlaybook.route(get(PB("payments")), h.callerOf(FAKE_COMPANY, "owner", "o7")))["error"]["message"]).toBe(NOT_ON_THE_CORE_YET);
  });

  it("a script token is still refused for an owner (the shortcut is for a signed-in person only)", async () => {
    const h = await setup();
    const owner = h.callerOf(FAKE_COMPANY, "owner", "o4");
    for (const path of [PB("payments"), HWW("payments")]) {
      const token = await h.routes.route(get(path), { ...owner, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
      expect(token?.statusCode, path).toBe(403);
      expect(bodyOf(token)["error"]["message"]).toBe(NOT_FOR_SCRIPT_TOKENS);
    }
    expect(h.stateCalls).toEqual([]);
  });

  it("writes are unchanged: a PUT, POST, PATCH or DELETE on either path is not the core's for an owner, an admin or a member, and nothing is read for it", async () => {
    const h = await setup();
    h.allowed.add("payments");
    for (const [role, personId] of [["owner", "w-owner"], ["admin", "w-admin"], ["member", "w-member"]] as const) {
      const caller = h.callerOf(FAKE_COMPANY, role, personId);
      for (const method of ["PUT", "POST", "PATCH", "DELETE"]) {
        for (const path of [PB("payments"), HWW("payments"), PB("ledger")]) expect(await h.routes.route({ ...get(path), method }, caller), `${role} ${method} ${path}`).toBeUndefined();
      }
    }
    expect(h.stateCalls).toEqual([]);
    expect(h.grantCalls).toEqual([]);
  });

  it("the shortcut reaches only these two GET paths: other project routes of the core keep their own rule (the sibling path of a granted-only read stays 404 to an owner)", async () => {
    const h = await setup();
    const owner = h.callerOf(FAKE_COMPANY, "owner", "o8");
    // A path that only looks like the playbook is not the core's (undefined: the old broker's), and the project name pattern still applies.
    for (const path of [`${PB("payments")}/extra`, "/v1/app/projects/pay%20ments/playbook", "/v1/app/projects/../playbook", `/v1/app/projects/payments/playbooks`]) expect(await h.routes.route(get(path), owner), path).toBeUndefined();
    expect(h.stateCalls).toEqual([]);
  });
});
