// Engine host (lane E2): the core's own handlers mounted on the deployed developer API behind the switch. Off is byte-identical (nothing read, nothing answered); the company comes from
// membership only and fails closed; another company's task reads exactly like a missing one; unwired parts say so in fixed words; a script token is never made through this API.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { agentXError, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createScriptToken } from "../../packages/broker/src/core/script-tokens/index.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { DECIDE_ON_A_PAGE, MAKE_SCRIPT_TOKEN_ON_A_PAGE, NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, SIGN_IN_AGAIN, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });

function appOver(world: FakeWorld, env: NodeJS.ProcessEnv): CoreHostApp {
  return createCoreHostApp({
    env, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES }),
  });
}

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

const get = (path: string, headers: Record<string, string> = {}) => ({ method: "GET", path, headers, body: "" });
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
const callerOf = (companyId: string): DeployedCaller => ({ principal: localOwnerPrincipal({ companyId: companyId }), client: "cli" });
const WIRED: CoreDevWiring = { origin: () => "https://api.example", scriptTokens: { enabled: () => true } };

async function world2(env: NodeJS.ProcessEnv = { ROVARA_CORE_ENGINE: "on" }) {
  const world = createFakeWorld();
  await registerProject(world, FAKE_COMPANY);
  await registerProject(world, OTHER);
  const app = appOver(world, env);
  const member = new Map<string, CompanyMembership>();
  const companyOf = vi.fn(async (caller: DeployedCaller) => member.get(caller.principal.personId + caller.principal.companyId));
  const remember = (companyId: string, role: CompanyMembership["role"] = "owner", personId?: string) => {
    const base = callerOf(companyId);
    const caller = personId === undefined ? base : { ...base, principal: { ...base.principal, personId } };
    member.set(caller.principal.personId + companyId, { companyId, role });
    return caller;
  };
  return { world, app, companyOf, remember };
}

describe("the core's handlers on the deployed API", () => {
  it("off (the default) answers nothing and reads nothing, for every path it would own", async () => {
    const { world, companyOf } = await world2();
    const off = createCoreDevRoutes({ app: appOver(world, {}), companyOf, wiring: () => WIRED });
    const spy = vi.spyOn(world.store, "get");
    for (const request of [get("/v1/app/sessions"), get(`/v1/dev/tasks/${randomUUID()}`), get("/v1/app/decisions"), get("/v1/app/projects/payments/how-we-work"), get("/v1/app/script-tokens"), post("/v1/app/script-tokens")]) {
      expect(await off.route(request, callerOf(FAKE_COMPANY)), request.path).toBeUndefined();
    }
    expect(companyOf).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(world.created).toEqual([]);
  });

  it("leaves every path it does not own to the old broker, and never serves the laptop's page routes", async () => {
    const { app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const caller = remember(FAKE_COMPANY);
    for (const path of ["/v1/dev/tasks", "/v1/dev/projects", "/v1/local/pages/open", "/v1/local/playbook/payments", "/v1/admin/projects", "/healthz"]) expect(await routes.route(get(path), caller), path).toBeUndefined();
    expect(companyOf).not.toHaveBeenCalled();
  });

  it("takes the company from membership only: a reader that throws, answers nothing or answers a malformed id refuses with the sign-in words; a header, query or body naming a company changes nothing", async () => {
    const { app, remember } = await world2();
    const caller = remember(FAKE_COMPANY);
    const readers: Array<() => Promise<CompanyMembership | undefined>> = [
      async () => { throw new Error("down"); }, async () => undefined, async () => ({ companyId: "not-an-org", role: "owner" }), async () => ({ companyId: "", role: "owner" }),
      async () => ({ companyId: FAKE_COMPANY, role: "superuser" as never }), async () => ({ companyId: FAKE_COMPANY }) as never, async () => null as never,
    ];
    for (const companyOf of readers) {
      const answer = await createCoreDevRoutes({ app, companyOf, wiring: () => WIRED }).route({ ...get(`/v1/app/script-tokens?org=${FAKE_COMPANY}`, { "x-company": FAKE_COMPANY }), body: JSON.stringify({ companyId: FAKE_COMPANY }) }, caller);
      expect(answer?.statusCode).toBe(401);
      expect(JSON.parse(answer!.body)).toEqual({ error: { code: "UNAUTHENTICATED", message: SIGN_IN_AGAIN } });
      expect(answer!.body).not.toContain("org_");
    }
    // A principal of one company with membership in another is refused too.
    const built = vi.spyOn(app, "runtimeFor");
    const crossed = await createCoreDevRoutes({ app, companyOf: async () => ({ companyId: OTHER, role: "owner" }), wiring: () => WIRED }).route(get("/v1/app/script-tokens"), caller);
    expect(crossed?.statusCode).toBe(401);
    expect(built).not.toHaveBeenCalled();
  });

  it("leaves a company the switch does not send to the core, and that holds no core task, on the old broker", async () => {
    const { app, companyOf, remember } = await world2({ ROVARA_CORE_ENGINE: `on:${FAKE_COMPANY}` });
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    expect(await routes.route(get("/v1/app/script-tokens"), remember(OTHER))).toBeUndefined();
    expect((await routes.route(get("/v1/app/script-tokens"), remember(FAKE_COMPANY)))?.statusCode).toBe(200);
  });

  it("reads a task through the core; another company's task answers exactly like a missing one", async () => {
    const { app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const own = remember(FAKE_COMPANY);
    const runtime = await app.runtimeFor(FAKE_COMPANY);
    const { task } = await runtime.flow.start({ principal: own.principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    const read = await routes.route(get(`/v1/dev/tasks/${task.taskId}`), own);
    expect(read?.statusCode).toBe(200);
    expect(JSON.parse(read!.body)).toMatchObject({ task: { taskId: task.taskId } });
    const theirs = await routes.route(get(`/v1/dev/tasks/${task.taskId}`), remember(OTHER));
    const missing = await routes.route(get(`/v1/dev/tasks/${randomUUID()}`), remember(OTHER));
    expect(theirs?.statusCode).toBe(404);
    expect(theirs).toEqual(missing);
    expect(theirs!.body).not.toContain(FAKE_COMPANY);
    expect(theirs!.body).not.toContain(task.taskId);
  });

  it("answers a fixed 'not on the core yet' for a part the deployment has not wired (never the laptop's sole-owner default)", async () => {
    const { app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ origin: () => "https://api.example" }) });
    const caller = remember(FAKE_COMPANY);
    for (const request of [get("/v1/app/sessions"), get("/v1/app/decisions"), get("/v1/app/projects/payments/how-we-work")]) {
      const answer = await routes.route(request, caller);
      expect(answer?.statusCode, request.path).toBe(404);
      expect((JSON.parse(answer!.body) as { error: { message: string } }).error.message, request.path).toBe(NOT_ON_THE_CORE_YET);
    }
    expect((await routes.route(get("/v1/app/script-tokens"), caller))?.statusCode).toBe(404);
  });

  it("lists and revokes script tokens, and refuses to make one for every caller (the recently-signed-in page rule has no credential on this API yet)", async () => {
    const { app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const caller = remember(FAKE_COMPANY);
    expect(JSON.parse((await routes.route(get("/v1/app/script-tokens"), caller))!.body)).toEqual({ tokens: [] });
    const made = await routes.route(post("/v1/app/script-tokens", { name: "ci", projects: ["payments"], permissions: ["read"], expiresInDays: 30 }), caller);
    expect(made?.statusCode).toBe(403);
    expect((JSON.parse(made!.body) as { error: { message: string } }).error.message).toBe(MAKE_SCRIPT_TOKEN_ON_A_PAGE);
    expect((await routes.route(post("/v1/app/script-tokens/sct_nothing/revoke"), caller))?.statusCode).toBe(404);
    // Switched off by its own setting: not there.
    const disabled = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, scriptTokens: { enabled: () => false } }) });
    expect((await disabled.route(post("/v1/app/script-tokens"), caller))?.statusCode).toBe(404);
  });

  it("takes the role for the token list and revoke from membership, not the principal's roles: a member reaches only their own tokens, an administrator every token of the company", async () => {
    const { world, app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const owner = remember(FAKE_COMPANY, "owner");
    // The member's principal claims owner; membership says member.
    const member = remember(FAKE_COMPANY, "member", "person-member-0000000001");
    const runtime = await app.runtimeFor(FAKE_COMPANY);
    const deps = { store: runtime.flow.deps.store, audit: runtime.flow.deps.audit, now: () => world.clock.now };
    const made = await createScriptToken(deps, { developerId: developerIdOf(owner.principal), personId: owner.principal.personId, orgId: FAKE_COMPANY, orgRole: "owner" }, { requestId: randomUUID(), name: "ci", projects: ["payments"], permissions: ["read"] }, async () => undefined);
    const tokenId = (made as { token: { tokenId: string } }).token.tokenId;
    expect(JSON.parse((await routes.route(get("/v1/app/script-tokens"), member))!.body)).toEqual({ tokens: [] });
    expect((await routes.route(post(`/v1/app/script-tokens/${tokenId}/revoke`), member))?.statusCode).toBe(404);
    const listed = JSON.parse((await routes.route(get("/v1/app/script-tokens"), owner))!.body) as { tokens: Array<{ tokenId: string }> };
    expect(listed.tokens.map((token) => token.tokenId)).toEqual([tokenId]);
    // Another company's administrator cannot see or revoke it.
    const other = remember(OTHER, "owner");
    expect(JSON.parse((await routes.route(get("/v1/app/script-tokens"), other))!.body)).toEqual({ tokens: [] });
    expect((await routes.route(post(`/v1/app/script-tokens/${tokenId}/revoke`), other))?.statusCode).toBe(404);
    expect((await routes.route(post(`/v1/app/script-tokens/${tokenId}/revoke`), owner))?.statusCode).toBe(200);
    // A malformed escape is a token that does not exist, never a fault.
    expect((await routes.route(post("/v1/app/script-tokens/%E0/revoke"), owner))?.statusCode).toBe(404);
  });

  it("reads the decision cards but refuses every act on them (no recently-signed-in proof on this API yet)", async () => {
    const { app, companyOf, remember } = await world2();
    const list = vi.fn(async () => []);
    const performer = { approve: vi.fn(), reject: vi.fn() };
    const decisions = { sources: { list, locks: async () => ({}) as never }, performer, store: {} as never, now: () => 0 } as unknown as NonNullable<CoreDevWiring["decisions"]>;
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, decisions }) });
    const caller = remember(FAKE_COMPANY);
    for (const action of ["approve", "reject", "request-changes", "evidence-opened"]) {
      const answer = await routes.route(post(`/v1/app/decisions/plan/${randomUUID()}/${action}`, { digest: "x" }), caller);
      expect(answer?.statusCode, action).toBe(403);
      expect((JSON.parse(answer!.body) as { error: { message: string } }).error.message).toBe(DECIDE_ON_A_PAGE);
    }
    expect(performer.approve).not.toHaveBeenCalled();
    expect(performer.reject).not.toHaveBeenCalled();
  });

  it("serves how we work only with the person's project access; a project they may not read answers exactly like a missing one; a PUT stays the old broker's", async () => {
    const { app, companyOf, remember } = await world2();
    const state = vi.fn(async (project: string) => {
      if (project !== "payments") throw agentXError("NOT_FOUND", "There is no project named that here.");
      return { view: {}, playbook: { steps: [] } } as never;
    });
    const playbook = { state, preview: vi.fn() } as never;
    const allowed = new Set(["payments"]);
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, playbook, canReadProject: async (_person, project) => allowed.has(project) }) });
    const caller = remember(FAKE_COMPANY);
    expect((await routes.route(get("/v1/app/projects/payments/playbook"), caller))?.statusCode).toBe(200);
    allowed.delete("payments");
    const hidden = await routes.route(get("/v1/app/projects/payments/playbook"), caller);
    allowed.add("ghost");
    const missing = await routes.route(get("/v1/app/projects/ghost/playbook"), caller);
    expect(hidden?.statusCode).toBe(404);
    expect(hidden).toEqual(missing);
    expect(state).toHaveBeenCalledTimes(2);
    expect(await routes.route({ ...get("/v1/app/projects/payments/playbook"), method: "PUT" }, caller)).toBeUndefined();
    // Without the access check wired, the playbook is not served at all.
    const unchecked = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, playbook }) });
    expect((JSON.parse((await unchecked.route(get("/v1/app/projects/payments/playbook"), caller))!.body) as { error: { message: string } }).error.message).toBe(NOT_ON_THE_CORE_YET);
  });

  it("lets a script token's request reach only a task's read", async () => {
    const { app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const caller = { ...remember(FAKE_COMPANY), scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } };
    for (const request of [get("/v1/app/script-tokens"), post("/v1/app/script-tokens/stk_aaaaaaaaaaaaaaaaaaaa/revoke"), get("/v1/app/sessions"), get("/v1/app/decisions"), get("/v1/app/projects/payments/playbook")]) {
      const answer = await routes.route(request, caller);
      expect(answer?.statusCode, request.path).toBe(403);
      expect((JSON.parse(answer!.body) as { error: { message: string } }).error.message).toBe(NOT_FOR_SCRIPT_TOKENS);
    }
    expect((await routes.route(get(`/v1/dev/tasks/${randomUUID()}`), caller))?.statusCode).toBe(404);
  });
});
