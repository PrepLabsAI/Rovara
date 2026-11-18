// Engine host (lane E2): the core's own handlers mounted on the deployed developer API behind the switch. Off is byte-identical (nothing read, nothing answered); the company comes from
// membership only and fails closed; another company's task reads exactly like a missing one; unwired parts say so in fixed words; a script token is never made through this API.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WorkflowSnapshotSchema, agentXError, orgProjectCatalogKey, projectRevisionKey, type AuditSink, type JsonValue, type ProjectDefinition, type WorkflowSnapshot } from "@agentx/contracts";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { blockedReview, plain } from "../support/task-actions-world.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createScriptToken, readScriptToken } from "../../packages/broker/src/core/script-tokens/index.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { createCoreHostApp, engineStampKey, stampOf, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { INVOLVED_UNAVAILABLE, COMPANY_RULES_NO_ANSWER, DECIDE_ON_A_PAGE, MAKE_SCRIPT_TOKEN_ON_A_PAGE, NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, SESSION_CAP_UNREADABLE, SIGN_IN_AGAIN, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { involvedRowKey, writeInvolvedRow } from "../../packages/broker/src/core/task-flow/involved.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const OTHER = "org_corehost00000000000b";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });

function appOver(world: FakeWorld, env: NodeJS.ProcessEnv): CoreHostApp {
  return createCoreHostApp({
    env, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
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
    for (const request of [get("/v1/app/sessions"), get(`/v1/dev/tasks/${randomUUID()}`), get("/v1/app/decisions"), get("/v1/app/projects/payments/how-we-work"), get("/v1/app/script-tokens"), post("/v1/app/script-tokens"), post("/v1/dev/tasks", { requestId: randomUUID() }), get("/v1/app/projects/payments/setup-agent"), post("/v1/app/projects/payments/setup-agent", { requestId: randomUUID() }), post("/v1/app/projects/payments/setup-agent/stop", { requestId: randomUUID() })]) {
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
    const { task } = await runtime.flow.start({ principal: own.principal, origin: "app", client: "test" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
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
    expect(JSON.parse((await routes.route(get("/v1/app/script-tokens"), caller))!.body)).toEqual({ tokens: [], canCreate: true });
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
    expect(JSON.parse((await routes.route(get("/v1/app/script-tokens"), member))!.body)).toEqual({ tokens: [], canCreate: false });
    expect((await routes.route(post(`/v1/app/script-tokens/${tokenId}/revoke`), member))?.statusCode).toBe(404);
    const listed = JSON.parse((await routes.route(get("/v1/app/script-tokens"), owner))!.body) as { tokens: Array<{ tokenId: string }> };
    expect(listed.tokens.map((token) => token.tokenId)).toEqual([tokenId]);
    // Another company's administrator cannot see or revoke it.
    const other = remember(OTHER, "owner");
    expect(JSON.parse((await routes.route(get("/v1/app/script-tokens"), other))!.body)).toEqual({ tokens: [], canCreate: true });
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

// Lead 4 W2: the project wiki's reads through the dev routes: the member company's own store, the generic guards first.
describe("the project wiki's reads on the deployed API", () => {
  const WIKI = "/v1/app/projects/payments/wiki";
  it("serves the member company's own wiki, asking the standing for that company only", async () => {
    const { world, app, companyOf, remember } = await world2();
    const seen: string[] = [];
    const wiki = { standing: async (personId: string, companyId: string, project: string) => { seen.push(`${companyId}/${project}`); return { access: "view" as const }; }, projectRepositories: async () => ["web"] };
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, wiki }) });
    const index = await routes.route(get(WIKI), remember(OTHER));
    expect(index?.statusCode).toBe(200);
    expect(JSON.parse(index!.body)).toEqual({ project: "payments", state: "empty", pages: [] });
    expect(seen).toEqual([`${OTHER}/payments`]);
    void world;
  });

  it("refuses a script token (403) and a caller with no member company (401) before anything is read; unwired is 'not on the core yet'", async () => {
    const { app, companyOf, remember } = await world2();
    const standing = vi.fn(async () => ({ access: "view" as const }));
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, wiki: { standing, projectRepositories: async () => ["web"] } }) });
    for (const path of [WIKI, `${WIKI}/pages/overview`, `${WIKI}/pages/overview/sources`]) {
      const token = await routes.route(get(path), { ...remember(FAKE_COMPANY), scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
      expect(token?.statusCode, path).toBe(403);
      expect((JSON.parse(token!.body) as { error: { message: string } }).error.message).toBe(NOT_FOR_SCRIPT_TOKENS);
      const stranger = callerOf(FAKE_COMPANY);
      expect((await routes.route(get(path), { ...stranger, principal: { ...stranger.principal, personId: "no-membership" } }))?.statusCode, path).toBe(401);
    }
    expect(standing).not.toHaveBeenCalled();
    const unwired = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const answer = await unwired.route(get(WIKI), remember(FAKE_COMPANY));
    expect((JSON.parse(answer!.body) as { error: { message: string } }).error.message).toBe(NOT_ON_THE_CORE_YET);
    expect(await routes.route(post(WIKI), remember(FAKE_COMPANY))).toBeUndefined();
  });
});

// Lane ID part 2: a fresh step-up (a factor Code owns, checked on the route against the company's window) opens the two acts this API refused.
describe("a fresh step-up opens making a script token and acting on a decision card", () => {
  const BODY = { requestId: "", name: "ci", projects: ["payments"], permissions: ["read"] };
  const minutesAgo = (world: FakeWorld, minutes: number) => new Date(world.clock.now - minutes * 60_000).toISOString();
  const errorOf = (answer: { body: string } | undefined) => (JSON.parse(answer!.body) as { error: { code: string; message: string } }).error;

  async function setup(extra: Partial<CoreDevWiring> = {}) {
    const w = await world2();
    const list = vi.fn(async (...seen: unknown[]) => (seen.length >= 0 ? [] : []));
    const performer = { approve: vi.fn(), reject: vi.fn() };
    const decisions = { sources: { list, locks: async () => ({}) as never }, performer, store: { findDecision: async () => undefined } as never, now: () => 0 } as unknown as NonNullable<CoreDevWiring["decisions"]>;
    const routesFor = (more: Partial<CoreDevWiring>) => createCoreDevRoutes({ app: w.app, companyOf: w.companyOf, wiring: () => ({ ...WIRED, decisions, canReadProject: async (_person, project) => project === "payments", ...extra, ...more }) });
    return { ...w, routes: routesFor({}), routesFor, list, performer };
  }

  it("refuses a live member before reading the body or asking for step-up, despite owner claims", async () => {
    const window = vi.fn(async () => 600);
    const { routes, remember } = await setup({ stepUpWindowSeconds: window });
    const member = remember(FAKE_COMPANY, "member");
    expect(member.principal.roles).toContain("owner");
    const request = { ...post("/v1/app/script-tokens"), headers: { "x-org-role": "owner" }, get body(): string { throw new Error("body must not be read"); } };
    const answer = await routes.route(request, member);
    expect(answer?.statusCode).toBe(403);
    expect(errorOf(answer)).toEqual({ code: "FORBIDDEN", message: "Only an owner or an admin of the company can create script tokens." });
    expect(window).not.toHaveBeenCalled();
  });

  it("reads creation authority live on every request and never takes an owner claim over a demotion", async () => {
    const { world, routes, remember } = await setup();
    const caller: DeployedCaller = { ...remember(FAKE_COMPANY, "owner"), stepUp: { at: minutesAgo(world, 1), method: "passkey" } };
    for (const role of ["owner", "admin"] as const) {
      remember(FAKE_COMPANY, role);
      expect((await routes.route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), caller))?.statusCode).toBe(201);
      expect(JSON.parse((await routes.route(get("/v1/app/script-tokens"), caller))!.body)).toMatchObject({ canCreate: true });
    }
    remember(FAKE_COMPANY, "member");
    const refused = await routes.route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), caller);
    expect(errorOf(refused)).toEqual({ code: "FORBIDDEN", message: "Only an owner or an admin of the company can create script tokens." });
    expect(JSON.parse((await routes.route(get("/v1/app/script-tokens"), caller))!.body)).toMatchObject({ canCreate: false, tokens: [expect.any(Object), expect.any(Object)] });
  });

  it("refuses creation when an admin membership belongs to a different company", async () => {
    const { world, app } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf: async () => ({ companyId: OTHER, role: "admin" }), wiring: () => WIRED });
    const caller = { ...callerOf(FAKE_COMPANY), stepUp: { at: minutesAgo(world, 1), method: "passkey" } };
    const answer = await routes.route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), caller);
    expect(answer?.statusCode).toBe(401);
    expect(errorOf(answer)).toEqual({ code: "UNAUTHENTICATED", message: SIGN_IN_AGAIN });
    expect(world.created).toEqual([]);
  });

  it("makes a script token for a caller whose step-up is inside the window, and lists it after", async () => {
    const { world, routes, remember } = await setup();
    const caller: DeployedCaller = { ...remember(FAKE_COMPANY), stepUp: { at: minutesAgo(world, 2), method: "email_code" } };
    const made = await routes.route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), caller);
    expect(made?.statusCode).toBe(201);
    const created = JSON.parse(made!.body) as { token: { tokenId: string }; secret: string };
    expect(created.secret.length).toBeGreaterThan(20);
    const listed = JSON.parse((await routes.route(get("/v1/app/script-tokens"), caller))!.body) as { tokens: Array<{ tokenId: string }> };
    expect(listed.tokens.map((token) => token.tokenId)).toEqual([created.token.tokenId]);
  });

  it("writes the step-up's method as the token's amr and its time as the token's sign-in time (ID-STEPUP-FOLLOWUPS d)", async () => {
    const { world, app, routes, remember } = await setup();
    for (const method of ["email_code", "passkey", "company_reauth"] as const) {
      const at = minutesAgo(world, 3);
      const made = await routes.route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID(), name: `ci-${method}` }), { ...remember(FAKE_COMPANY), stepUp: { at, method } });
      expect(made?.statusCode).toBe(201);
      const tokenId = (JSON.parse(made!.body) as { token: { tokenId: string } }).token.tokenId;
      const record = await readScriptToken({ store: (await app.runtimeFor(FAKE_COMPANY)).flow.deps.store }, FAKE_COMPANY, tokenId);
      expect(record).toMatchObject({ amr: method, authTime: at });
    }
  });

  it("passes the install's session cap through: a token lives no longer than a session would, and an unreadable cap makes nothing", async () => {
    const { world, app, routesFor, remember } = await setup();
    const caller: DeployedCaller = { ...remember(FAKE_COMPANY), stepUp: { at: minutesAgo(world, 1), method: "passkey" } };
    const store = (await app.runtimeFor(FAKE_COMPANY)).flow.deps.store;
    const capped = await routesFor({ sessionCapSeconds: 3_600 }).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID(), days: 30 }), caller);
    expect(capped?.statusCode).toBe(201);
    const record = await readScriptToken({ store }, FAKE_COMPANY, (JSON.parse(capped!.body) as { token: { tokenId: string } }).token.tokenId);
    expect(Date.parse(record!.expiresAt) - Date.parse(record!.createdAt)).toBe(3_600_000);
    // No cap: the days asked for, as before.
    const open = await routesFor({}).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID(), name: "ci-open", days: 30 }), caller);
    const openRecord = await readScriptToken({ store }, FAKE_COMPANY, (JSON.parse(open!.body) as { token: { tokenId: string } }).token.tokenId);
    expect(Date.parse(openRecord!.expiresAt) - Date.parse(openRecord!.createdAt)).toBe(30 * 86_400_000);
    for (const cap of [0, -5, 1.5, Number.NaN, "3600"]) {
      const refused = await routesFor({ sessionCapSeconds: cap as number }).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID(), name: "ci-bad" }), caller);
      expect(refused?.statusCode, String(cap)).toBe(503);
      expect(errorOf(refused)).toEqual({ code: "RUNTIME_UNAVAILABLE", message: SESSION_CAP_UNREADABLE });
    }
    // The step-up comes first: a stale one is refused for that, whatever the cap.
    const stale = await routesFor({ sessionCapSeconds: 0 }).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID(), name: "ci-stale" }), { ...caller, stepUp: { at: minutesAgo(world, 11), method: "passkey" } });
    expect(errorOf(stale)).toEqual({ code: "REAUTH_REQUIRED", message: MAKE_SCRIPT_TOKEN_ON_A_PAGE });
    const listed = JSON.parse((await routesFor({}).route(get("/v1/app/script-tokens"), caller))!.body) as { tokens: Array<{ name: string }> };
    expect(listed.tokens.map((token) => token.name).sort()).toEqual(["ci", "ci-open"]);
  });

  it("refuses a step-up older than the window, in the future, or unreadable, whatever the body or a header claims", async () => {
    const { world, routes, remember, list } = await setup();
    const base = remember(FAKE_COMPANY);
    const stale = [
      { at: minutesAgo(world, 11), method: "email_code" }, { at: minutesAgo(world, -5), method: "passkey" }, { at: "yesterday", method: "email_code" },
      { at: minutesAgo(world, 1), method: "" }, { at: 12345 as never, method: "email_code" }, null as never,
      // A federated round trip is not a factor Code owns, and a looser time form is not read.
      { at: minutesAgo(world, 1), method: "slack" }, { at: minutesAgo(world, 1), method: "oidc" }, { at: "2026-11-15", method: "email_code" }, { at: new Date(world.clock.now - 60_000).toUTCString(), method: "email_code" },
    ];
    for (const stepUp of stale) {
      const caller: DeployedCaller = { ...base, stepUp };
      const body = { ...BODY, requestId: randomUUID(), stepUp: { at: new Date(world.clock.now).toISOString(), method: "email_code" } };
      const request = { ...post("/v1/app/script-tokens", body), headers: { "x-step-up-at": new Date(world.clock.now).toISOString() } };
      const made = await routes.route(request, caller);
      expect(made?.statusCode, JSON.stringify(stepUp)).toBe(403);
      expect(errorOf(made)).toEqual({ code: "REAUTH_REQUIRED", message: MAKE_SCRIPT_TOKEN_ON_A_PAGE });
      const acted = await routes.route(post(`/v1/app/decisions/plan/${randomUUID()}/approve`, body), caller);
      expect(errorOf(acted)).toEqual({ code: "REAUTH_REQUIRED", message: DECIDE_ON_A_PAGE });
    }
    expect(list).not.toHaveBeenCalled();
    expect(JSON.parse((await routes.route(get("/v1/app/script-tokens"), base))!.body)).toEqual({ tokens: [], canCreate: true });
  });

  it("takes the company's shorter window from the hook, never a longer one, and refuses when the hook gives no readable answer", async () => {
    const { world, routesFor, remember } = await setup();
    const caller: DeployedCaller = { ...remember(FAKE_COMPANY), stepUp: { at: minutesAgo(world, 5), method: "email_code" } };
    const routesWith = async (answer: () => Promise<unknown>) => routesFor({ stepUpWindowSeconds: answer });
    // A 2-minute company window refuses a 5-minute-old step-up; a 30-minute answer is capped at the 10-minute default.
    expect(errorOf(await (await routesWith(async () => 120)).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), caller)).code).toBe("REAUTH_REQUIRED");
    // A zero window refuses even a step-up made this very moment.
    expect(errorOf(await (await routesWith(async () => 0)).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), { ...caller, stepUp: { at: minutesAgo(world, 0), method: "email_code" } })).code).toBe("REAUTH_REQUIRED");
    expect(errorOf(await (await routesWith(async () => 30)).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), { ...caller, stepUp: { at: minutesAgo(world, 0.75), method: "email_code" } })).code).toBe("REAUTH_REQUIRED");
    const old: DeployedCaller = { ...caller, stepUp: { at: minutesAgo(world, 11), method: "email_code" } };
    expect(errorOf(await (await routesWith(async () => 1800)).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), old)).code).toBe("REAUTH_REQUIRED");
    expect((await (await routesWith(async () => 1800)).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), caller))?.statusCode).toBe(201);
    // Positive short windows: a 30 s window takes a 20 s-old step-up, a 120 s window a 60 s-old one; and the future-skew allowance never exceeds the window.
    expect((await (await routesWith(async () => 30)).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), { ...caller, stepUp: { at: minutesAgo(world, 20 / 60), method: "email_code" } }))?.statusCode).toBe(201);
    expect((await (await routesWith(async () => 120)).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID(), name: "ci2" }), { ...caller, stepUp: { at: minutesAgo(world, 1), method: "passkey" } }))?.statusCode).toBe(201);
    expect(errorOf(await (await routesWith(async () => 30)).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), { ...caller, stepUp: { at: minutesAgo(world, -1), method: "email_code" } })).code).toBe("REAUTH_REQUIRED");
    // No step-up: refused without asking the hook.
    const asked = vi.fn(async () => 600);
    expect(errorOf(await (await routesWith(asked)).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), remember(FAKE_COMPANY))).code).toBe("REAUTH_REQUIRED");
    expect(asked).not.toHaveBeenCalled();
    for (const answer of [async () => { throw new Error("hook down"); }, async () => "600", async () => -1, async () => 1.5, async () => undefined, async () => 90_000]) {
      const refused = await (await routesWith(answer)).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), caller);
      expect(refused?.statusCode).toBe(503);
      expect(errorOf(refused)).toEqual({ code: "RUNTIME_UNAVAILABLE", message: COMPANY_RULES_NO_ANSWER });
    }
  });

  it("makes a token only for projects the person may read now; one they may not read answers like a missing one", async () => {
    const { world, routes, remember } = await setup();
    const caller: DeployedCaller = { ...remember(FAKE_COMPANY), stepUp: { at: minutesAgo(world, 1), method: "passkey" } };
    const hidden = await routes.route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID(), projects: ["secret"] }), caller);
    expect(hidden?.statusCode).toBe(404);
    expect(errorOf(hidden).message).toBe("project not found");
    const { canReadProject: _dropped, ...withoutAccess } = { ...WIRED, canReadProject: undefined };
    void _dropped;
    const unwired = await createCoreDevRoutes({ app: (await world2()).app, companyOf: async () => ({ companyId: FAKE_COMPANY, role: "owner" }), wiring: () => withoutAccess }).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), caller);
    expect(errorOf(unwired).message).toBe(NOT_ON_THE_CORE_YET);
  });

  it("lets an act on a card reach the cards with the step-up as the person's sign-in time (and a read carries none)", async () => {
    const { world, routes, remember, list } = await setup();
    const at = minutesAgo(world, 3);
    const base = remember(FAKE_COMPANY);
    const caller: DeployedCaller = { ...base, principal: { ...base.principal, authTime: minutesAgo(world, 0) }, stepUp: { at, method: "email_code" } };
    const acted = await routes.route(post(`/v1/app/decisions/approve_plan/${randomUUID()}/reject`, { requestId: randomUUID(), reason: "not_now" }), caller);
    // Past the step-up gate: the card is simply not waiting for them (the sources list is empty).
    expect(acted?.statusCode).toBe(404);
    expect(list).toHaveBeenCalledTimes(1);
    const seen = list.mock.calls[0]![0] as { principal: { authTime?: string; methods?: string[] }; stepUp?: unknown };
    expect(seen.principal.authTime).toBe(at);
    expect(seen.principal.methods).toEqual(["email_code"]);
    expect(seen.stepUp).toEqual({ at, method: "email_code" });
    await routes.route(get("/v1/app/decisions"), caller);
    const read = list.mock.calls[1]![0] as { principal: { authTime?: string }; stepUp?: unknown };
    expect(read.principal.authTime).toBeUndefined();
    expect(read.stepUp).toBeUndefined();
    // A malformed body is a fixed refusal, never an echo.
    const bad = await routes.route({ ...post(`/v1/app/decisions/plan/${randomUUID()}/approve`), body: "{not json <script>" }, caller);
    expect(errorOf(bad)).toEqual({ code: "CONFIG_INVALID", message: "the request body is not JSON" });
    // An unknown key in the body is refused in fixed words, never named back.
    const unknown = await routes.route(post(`/v1/app/decisions/approve_plan/${randomUUID()}/reject`, { requestId: randomUUID(), reason: "not_now", "<img src=x>": 1 }), caller);
    expect(errorOf(unknown).message).not.toContain("<img");
    expect(errorOf(unknown).code).toBe("CONFIG_INVALID");
  });
});

// DECISIONS 198 on the deployed API: the owner's moves on a task already running, on the old workflow routes' paths and shapes, so Cloud's Send back and Accept findings work for a core task.
describe("the owner's moves on a core task (send back, review findings, continue)", () => {
  /** The company's owner rule as a deployment wires it: only the person the task runs for acts as its owner here. */
  const ownerRule = (): TaskFlowDeps["access"] => ({
    ...createOwnerTaskAccess(),
    ownerActing: async (principal, task) => (principal.personId === task.developerId || developerIdOf(principal) === task.developerId ? { actorId: task.ownerKey } : undefined),
  });
  function appWith(world: FakeWorld, access: TaskFlowDeps["access"]): CoreHostApp {
    return createCoreHostApp({
      env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
    });
  }
  async function started(access: TaskFlowDeps["access"] = ownerRule(), taskActions: CoreDevWiring["taskActions"] | null = { roundCap: async () => undefined }) {
    const { world, companyOf, remember } = await world2();
    const app = appWith(world, access);
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, ...(taskActions === null || taskActions === undefined ? {} : { taskActions }) }) });
    const own = remember(FAKE_COMPANY);
    const runtime = await app.runtimeFor(FAKE_COMPANY);
    const { task } = await runtime.flow.start({ principal: own.principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    return { world, routes, own, remember, taskId: task.taskId, revision: task.workflow!.revision };
  }
  /** Puts the core task's workflow in a review the critic blocked, at the task's own id and owner. */
  async function blockReview(world: FakeWorld, taskId: string): Promise<number> {
    const record = (await world.store.get(taskKey(taskId))) as unknown as Record<string, unknown> & { workflow: WorkflowSnapshot };
    const workflow = WorkflowSnapshotSchema.parse({ ...blockedReview(), taskId, ownerId: record.workflow.ownerId });
    await world.store.put({ item: { ...record, workflow: plain(workflow) as unknown as JsonValue } as never });
    return workflow.revision;
  }
  const errorOf = (answer: { body: string } | undefined) => (JSON.parse(answer!.body) as { error?: { code: string; message: string } }).error;
  const sendBackBody = (expectedRevision?: number) => ({ requestId: randomUUID(), instructions: "Fix the review findings.", ...(expectedRevision === undefined ? {} : { expectedRevision }) });

  it("serves them only when the deployment wires the money cap AND the company's owner rule; otherwise they are not the core's here (the engine boundary then says so)", async () => {
    const unwired = await started(ownerRule(), null);
    for (const action of ["workflow/send-back", "workflow/review-findings", "continue"]) {
      expect(await unwired.routes.route(post(`/v1/dev/tasks/${unwired.taskId}/${action}`, sendBackBody(unwired.revision)), unwired.own), action).toBeUndefined();
    }
    // Code's laptop rule (the install's owner role) is never used on a hosted company: without `ownerActing` the moves are not served.
    const laptopRule = await started(createOwnerTaskAccess());
    expect(await laptopRule.routes.route(post(`/v1/dev/tasks/${laptopRule.taskId}/workflow/send-back`, sendBackBody(laptopRule.revision)), laptopRule.own)).toBeUndefined();
    // Only POST is the core's on these paths.
    const wired = await started();
    expect(await wired.routes.route(get(`/v1/dev/tasks/${wired.taskId}/workflow/send-back`), wired.own)).toBeUndefined();
  });

  it("reaches each core move with the old routes' request: a task that is not blocked, a missing revision, a stale findings answer and a workflow task's continue each get the move's own refusal", async () => {
    const { routes, own, taskId, revision } = await started();
    const early = await routes.route(post(`/v1/dev/tasks/${taskId}/workflow/send-back`, sendBackBody(revision)), own);
    expect(early?.statusCode).toBe(400);
    expect(errorOf(early)?.code).toBe("CONFIG_INVALID");
    expect(errorOf(early)?.message).toContain("no current failed check or review finding");
    expect(errorOf(await routes.route(post(`/v1/dev/tasks/${taskId}/workflow/send-back`, sendBackBody()), own))?.message).toContain("current revision");
    const digest = "a".repeat(64);
    const findings = await routes.route(post(`/v1/dev/tasks/${taskId}/workflow/review-findings`, { requestId: randomUUID(), expectedRevision: revision, candidateDigest: digest, resolutions: [{ findingId: digest, action: "ACCEPT", note: "Fine." }] }), own);
    expect(findings?.statusCode).toBe(409);
    expect(errorOf(findings)).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const more = await routes.route(post(`/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "Also add a test." }), own);
    expect(errorOf(more)?.message).toContain("approval steps");
    // A body that is not one JSON object is refused before anything is read.
    expect(errorOf(await routes.route({ ...post(`/v1/dev/tasks/${taskId}/workflow/send-back`), body: "[1]" }, own))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("sends a blocked core task back to coding and answers the task view as the old route does; a repeat answers the first", async () => {
    const { world, routes, own, taskId } = await started();
    const revision = await blockReview(world, taskId);
    const body = sendBackBody(revision);
    const sent = await routes.route(post(`/v1/dev/tasks/${taskId}/workflow/send-back`, body), own);
    expect(sent?.statusCode).toBe(200);
    expect(JSON.parse(sent!.body)).toMatchObject({ task: { taskId, workflow: { stage: "IMPLEMENT" } } });
    const again = await routes.route(post(`/v1/dev/tasks/${taskId}/workflow/send-back`, body), own);
    expect(again?.statusCode).toBe(200);
    expect(JSON.parse(again!.body)).toMatchObject({ task: { taskId, workflow: { stage: "IMPLEMENT" } } });
  });

  it("holds the round to the deployment's money cap: a task over its cap, or whose spend cannot be told, starts no coding and writes nothing", async () => {
    for (const roundCap of [async () => ({ limitUsd: 5, spentUsd: 6 }), async () => ({ limitUsd: 5, spentUsd: undefined }), async () => { throw new Error("ledger down"); }]) {
      const { world, routes, own, taskId } = await started(ownerRule(), { roundCap });
      const revision = await blockReview(world, taskId);
      const before = JSON.stringify(await world.store.get(taskKey(taskId)));
      const refused = await routes.route(post(`/v1/dev/tasks/${taskId}/workflow/send-back`, sendBackBody(revision)), own);
      expect(errorOf(refused)).toMatchObject({ code: "BUDGET_EXCEEDED" });
      expect(JSON.stringify(await world.store.get(taskKey(taskId)))).toBe(before);
    }
  });

  it("refuses anyone the company's owner rule does not name, another company's caller and a script token as no such task, whatever body they send; nothing is written", async () => {
    const { world, routes, remember, taskId } = await started();
    const revision = await blockReview(world, taskId);
    const before = JSON.stringify(await world.store.get(taskKey(taskId)));
    // A member of the same company who may read the task but is not its owner.
    const colleague = remember(FAKE_COMPANY, "member", "person-member-0000000002");
    const notOwner = await routes.route(post(`/v1/dev/tasks/${taskId}/workflow/send-back`, sendBackBody(revision)), colleague);
    expect(notOwner?.statusCode).toBe(404);
    const otherCompany = await routes.route(post(`/v1/dev/tasks/${taskId}/workflow/send-back`, sendBackBody(revision)), remember(OTHER));
    expect(otherCompany?.statusCode).toBe(404);
    const token = await routes.route(post(`/v1/dev/tasks/${taskId}/workflow/send-back`, sendBackBody(revision)), { ...remember(FAKE_COMPANY), scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
    // A script token reads it like a missing task (the boundary then answers exactly as for an id with no task).
    expect(token?.statusCode).toBe(404);
    // A body the move would refuse tells someone who may not see the task nothing either: the task is read first.
    const stranger = remember(OTHER);
    for (const raw of ["[1]", "null", "not json"]) expect((await routes.route({ ...post(`/v1/dev/tasks/${taskId}/workflow/send-back`), body: raw }, stranger))?.statusCode, raw).toBe(404);
    const tokenCaller = { ...remember(FAKE_COMPANY), scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } };
    for (const raw of ["[1]", "null", "not json"]) expect((await routes.route({ ...post(`/v1/dev/tasks/${taskId}/workflow/send-back`), body: raw }, tokenCaller))?.statusCode, `token ${raw}`).toBe(404);
    // A same-company person who may READ the task (and so knows it exists) but is not its owner gets the move's own field words for a bad body, and "no such task" for a good one.
    expect((await routes.route({ ...post(`/v1/dev/tasks/${taskId}/workflow/send-back`), body: "[1]" }, colleague))?.statusCode).toBe(400);
    expect(JSON.stringify(await world.store.get(taskKey(taskId)))).toBe(before);
  });
});

describe("a task's start on the deployed API (lane E2 step 6)", () => {
  const startBody = () => ({ requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });

  it("starts the task on the core for a member of a company the switch sends there, stamped core, answered as the developer task view", async () => {
    const { world, app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const own = remember(FAKE_COMPANY);
    const body = startBody();
    const answer = await routes.route(post("/v1/dev/tasks", body), own);
    expect(answer?.statusCode).toBe(200);
    const task = (JSON.parse(answer!.body) as { task: { taskId: string } }).task;
    expect(stampOf(await world.store.get(engineStampKey(task.taskId)))).toMatchObject({ engine: "core" });
    // The same request id answers the first task.
    const again = await routes.route(post("/v1/dev/tasks", body), own);
    expect((JSON.parse(again!.body) as { task: { taskId: string } }).task.taskId).toBe(task.taskId);
    // Only POST on the exact path is a start.
    expect(await routes.route(get("/v1/dev/tasks"), own)).toBeUndefined();
  });

  it("leaves the start to the old broker, reading nothing of the core, for a company the switch does not cover, in drain, and for a person with no member company", async () => {
    for (const env of [{ ROVARA_CORE_ENGINE: `on:${OTHER}` }, { ROVARA_CORE_ENGINE: "drain" }]) {
      const { world, app, companyOf, remember } = await world2(env);
      const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
      const spy = vi.spyOn(world.store, "get");
      expect(await routes.route(post("/v1/dev/tasks", startBody()), remember(FAKE_COMPANY)), env.ROVARA_CORE_ENGINE).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    }
    const { app, companyOf } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    expect(await routes.route(post("/v1/dev/tasks", startBody()), callerOf(FAKE_COMPANY))).toBeUndefined();
  });

  it("leaves the start to the old broker for a drained company that still holds core tasks (its runtime is served, its new tasks are not)", async () => {
    const { world, app, companyOf, remember } = await world2();
    const own = remember(FAKE_COMPANY);
    expect((await createCoreDevRoutes({ app, companyOf, wiring: () => WIRED }).route(post("/v1/dev/tasks", startBody()), own))?.statusCode).toBe(200);
    const drained = appOver(world, { ROVARA_CORE_ENGINE: "drain" });
    // The drained root still serves the company (it holds a core task)...
    await expect(drained.runtimeFor(FAKE_COMPANY)).resolves.toBeDefined();
    // ...but a new start is the old broker's.
    expect(await createCoreDevRoutes({ app: drained, companyOf, wiring: () => WIRED }).route(post("/v1/dev/tasks", startBody()), own)).toBeUndefined();
  });

  it("refuses with the sign-in words, never falling back, when membership cannot be read or names another company than the principal's", async () => {
    const { app, remember } = await world2();
    const failing = createCoreDevRoutes({ app, companyOf: async () => { throw new Error("membership store down"); }, wiring: () => WIRED });
    const refused = await failing.route(post("/v1/dev/tasks", startBody()), remember(FAKE_COMPANY));
    expect(refused?.statusCode).toBe(401);
    expect(refused!.body).not.toContain("down");
    const elsewhere = createCoreDevRoutes({ app, companyOf: async () => ({ companyId: OTHER, role: "owner" }), wiring: () => WIRED });
    expect((await elsewhere.route(post("/v1/dev/tasks", startBody()), callerOf(FAKE_COMPANY)))?.statusCode).toBe(401);
  });

  it("refuses a script token's start, and answers a body that is not an object in fixed words", async () => {
    const { app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const own = remember(FAKE_COMPANY);
    expect((await routes.route(post("/v1/dev/tasks", startBody()), { ...own, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } }))?.statusCode).toBe(403);
    const bad = await routes.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: "[1,2]" }, own);
    expect(bad?.statusCode).toBe(400);
    expect(bad!.body).not.toContain("[1,2]");
  });

  it("names the caller in a script token's audit events through the deployment's audit wrapper", async () => {
    const { world, app, companyOf, remember } = await world2();
    const auditFor = vi.fn((_caller: DeployedCaller, sink: AuditSink) => sink);
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, auditFor }) });
    const own = remember(FAKE_COMPANY);
    expect((await routes.route(get("/v1/app/script-tokens"), own))?.statusCode).toBe(200);
    expect(auditFor).toHaveBeenCalledWith(own, expect.anything());
    void world;
  });
});

describe("the tasks I was added to on the deployed API (web task channel C5)", () => {
  const LIST = "/v1/dev/tasks?involved=1";
  const involvedRow = (task: { taskId: string; createdAt: string }, companyId: string, personId: string) => ({ companyId, personId, taskId: task.taskId, createdAt: task.createdAt });
  async function started(app: CoreHostApp, companyId: string, owner: DeployedCaller) {
    const runtime = await app.runtimeFor(companyId);
    const { task } = await runtime.flow.start({ principal: owner.principal, origin: "app", client: "test" }, { requestId: randomUUID(), project: "payments", instructions: `Task of ${companyId}`, workflow: true, workflowPath: "QUICK" });
    return { runtime, task: { taskId: task.taskId, createdAt: task.createdAt } };
  }

  it("lists, for a member, the tasks they were added to in the company their MEMBERSHIP names, each re-checked; the plain list stays the old broker's and reads nothing here", async () => {
    const { world, app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const owner = remember(FAKE_COMPANY);
    const { task } = await started(app, FAKE_COMPANY, owner);
    const alice = remember(FAKE_COMPANY, "member", "alice");
    await writeInvolvedRow({ store: world.store }, involvedRow(task, FAKE_COMPANY, "alice"));
    // The deployment's owner rule lets a company owner see every task of the install; a member with no role does not.
    const seen = await routes.route(get(LIST), alice);
    expect(seen?.statusCode).toBe(200);
    expect(JSON.parse(seen!.body)).toMatchObject({ involved: true, tasks: [{ taskId: task.taskId, title: `Task of ${FAKE_COMPANY}`, project: "payments" }] });
    const bare: DeployedCaller = { ...alice, principal: { ...alice.principal, roles: [] } };
    expect(JSON.parse((await routes.route(get(LIST), bare))!.body)).toEqual({ involved: true, tasks: [] });
    // Only exactly involved=1 is the core's; the ordinary list is the old broker's, and nothing is read for it.
    companyOf.mockClear();
    for (const path of ["/v1/dev/tasks", "/v1/dev/tasks?involved=0", "/v1/dev/tasks?involved=true", "/v1/dev/tasks?involved=11", "/v1/dev/tasks?involved="]) expect(await routes.route(get(path), alice), path).toBeUndefined();
    expect(companyOf).not.toHaveBeenCalled();
    // Other methods on the list path are not served here either.
    expect(await routes.route({ method: "DELETE", path: LIST, headers: {}, body: "" }, alice)).toBeUndefined();
  });

  it("never names the company from a header, a query or a body, and lists nothing of another company's task, even for a row that names it", async () => {
    const { world, app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const ownerA = remember(FAKE_COMPANY);
    const ownerB = remember(OTHER);
    const a = await started(app, FAKE_COMPANY, ownerA);
    const b = await started(app, OTHER, ownerB);
    const aliceA = remember(FAKE_COMPANY, "member", "alice");
    const aliceB = remember(OTHER, "member", "alice");
    await writeInvolvedRow({ store: world.store }, involvedRow(a.task, FAKE_COMPANY, "alice"));
    await writeInvolvedRow({ store: world.store }, involvedRow(b.task, OTHER, "alice"));
    // A forged row in company A's partition naming company B's task.
    await world.store.put({ item: { ...involvedRowKey(involvedRow(b.task, FAKE_COMPANY, "alice")), entityType: "TASK_INVOLVED", ...involvedRow(b.task, FAKE_COMPANY, "alice"), addedAt: "2026-11-10T00:00:00.000Z" } });
    const titles = async (caller: DeployedCaller, path = LIST, headers: Record<string, string> = {}) => (JSON.parse((await routes.route(get(path, headers), caller))!.body) as { tasks: Array<{ title: string }> }).tasks.map((task) => task.title);
    expect(await titles(aliceA)).toEqual([`Task of ${FAKE_COMPANY}`]);
    expect(await titles(aliceB)).toEqual([`Task of ${OTHER}`]);
    // Naming the other company changes nothing.
    expect(await titles(aliceA, `${LIST}&org=${OTHER}&companyId=${OTHER}`, { "x-company": OTHER })).toEqual([`Task of ${FAKE_COMPANY}`]);
  });

  it("answers an outage, not an empty list, when membership cannot be read for the involved list", async () => {
    const { app, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf: async () => { throw new Error("membership store down"); }, wiring: () => WIRED });
    const answer = await routes.route(get(LIST), remember(FAKE_COMPANY, "member", "alice"));
    expect(answer?.statusCode).toBe(503);
    expect(JSON.parse(answer!.body)).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE", message: INVOLVED_UNAVAILABLE } });
    expect(answer!.body).not.toContain("down");
  });

  it("refuses a company id that is not a company id even when the principal carries the same one (the format is checked, not only the match)", async () => {
    const { app, remember } = await world2();
    const base = remember(FAKE_COMPANY, "member", "alice");
    for (const bad of ["not-an-org", "org_SHORT", "org_" + "A".repeat(20), "org_" + "a".repeat(21), "org_aaaa#aaaaaaaaaaaaaaaa"]) {
      const caller: DeployedCaller = { ...base, principal: { ...base.principal, companyId: bad } };
      const routes = createCoreDevRoutes({ app, companyOf: async () => ({ companyId: bad, role: "owner" }), wiring: () => WIRED });
      const answer = await routes.route(get(LIST), caller);
      expect(answer?.statusCode, bad).toBe(401);
      expect(JSON.parse(answer!.body), bad).toEqual({ error: { code: "UNAUTHENTICATED", message: SIGN_IN_AGAIN } });
    }
  });

  it("refuses a caller who is no member (the sign-in words), a script token (it reaches a task's read only), and a bad limit or cursor (fixed words)", async () => {
    const { app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const alice = remember(FAKE_COMPANY, "member", "alice");
    const stranger = callerOf(FAKE_COMPANY);
    stranger.principal = { ...stranger.principal, personId: "stranger" };
    const refused = await routes.route(get(LIST), stranger);
    expect(refused?.statusCode).toBe(401);
    expect(JSON.parse(refused!.body)).toEqual({ error: { code: "UNAUTHENTICATED", message: SIGN_IN_AGAIN } });
    expect((await routes.route(get(LIST), { ...alice, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } }))?.statusCode).toBe(403);
    for (const query of ["limit=0", "limit=99", "cursor=!!"]) {
      const bad = await routes.route(get(`${LIST}&${query}`), alice);
      expect(bad?.statusCode, query).toBe(400);
      expect(bad!.body, query).not.toContain(query);
    }
  });
});
