import { CORE_CONTEXT_WORKER_ROUTES, coreContextWorkerRouteOf, appRouteOf as contextAppRouteOf, devRouteOf as contextDevRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
// Engine host (lane E2): the core's own handlers mounted on the deployed developer API behind the switch. Off is byte-identical (nothing read, nothing answered); the company comes from
// membership only and fails closed; another company's task reads exactly like a missing one; unwired parts say so in fixed words; a script token is never made through this API.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ON_THE_WEBSITE_MESSAGE, WorkflowSnapshotSchema, agentXError, orgProjectCatalogKey, projectRevisionKey, change, type CodeBuildCheckResult, type AuditSink, type JsonValue, type ProjectDefinition, type WorkflowSnapshot } from "@agentx/contracts";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { blockedReview, code, parserId, plain } from "../support/task-actions-world.js";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { codeBuildCheckRunner } from "../../packages/broker/src/plugins/check-runner/codebuild/index.js";
import { publicationGateCallback } from "../../packages/broker/src/core/build-step/publication-gates.js";
import { openPullRequest } from "../../packages/broker/src/core/build-step/publish.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createScriptToken, readScriptToken } from "../../packages/broker/src/core/script-tokens/index.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { createCoreHostApp, engineStampKey, stampOf, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { INVOLVED_UNAVAILABLE, NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, SESSION_CAP_UNREADABLE, SIGN_IN_AGAIN, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { involvedRowKey, writeInvolvedRow } from "../../packages/broker/src/core/task-flow/involved.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const OTHER = "org_corehost00000000000b";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });

function appOver(world: FakeWorld): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

const get = (path: string, headers: Record<string, string> = {}) => ({ method: "GET", path, headers, body: "" });
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
// Owner DEC 254zzz91: the Rovara website's own client by default (making a script token and allowing automatic runs are its acts alone); `cliOf` is the CLI's or an AI tool's token.
const callerOf = (companyId: string): DeployedCaller => ({ principal: localOwnerPrincipal({ companyId: companyId }), client: "web", webApp: true });
const cliOf = (caller: DeployedCaller): DeployedCaller => { const { webApp: _web, ...rest } = caller; void _web; return { ...rest, client: "cli" }; };
const WIRED: CoreDevWiring = { origin: () => "https://api.example", scriptTokens: { enabled: () => true } };

async function world2() {
  const world = createFakeWorld();
  await registerProject(world, FAKE_COMPANY);
  await registerProject(world, OTHER);
  const app = appOver(world);
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

  it("leaves every path it does not own to the old broker, and never serves the laptop's page routes", async () => {
    const { app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const caller = remember(FAKE_COMPANY);
    for (const path of ["/v1/dev/tasks", "/v1/dev/projects", "/v1/dev/projects/payments/lessons/replay", "/v1/dev/projects/payments/lessons/weekly", "/v1/local/pages/open", "/v1/local/playbook/payments", "/v1/admin/projects", "/healthz"]) expect(await routes.route(get(path), caller), path).toBeUndefined();
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

  it("lists and revokes script tokens; making one asks for no step-up and needs the project reader wired (DEC 254zzz73)", async () => {
    const { app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const caller = remember(FAKE_COMPANY);
    expect(JSON.parse((await routes.route(get("/v1/app/script-tokens"), caller))!.body)).toEqual({ tokens: [], canCreate: true });
    const made = await routes.route(post("/v1/app/script-tokens", { name: "ci", projects: ["payments"], permissions: ["read"], expiresInDays: 30 }), caller);
    expect(made?.statusCode).toBe(404);
    expect((JSON.parse(made!.body) as { error: { message: string } }).error.message).toBe(NOT_ON_THE_CORE_YET);
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

  it("reads the decision cards and hands every act to them with no step-up in front (DEC 254zzz73)", async () => {
    const { app, companyOf, remember } = await world2();
    const list = vi.fn(async () => []);
    const performer = { approve: vi.fn(), reject: vi.fn() };
    const decisions = { sources: { list, locks: async () => ({}) as never }, performer, store: {} as never, now: () => 0 } as unknown as NonNullable<CoreDevWiring["decisions"]>;
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, decisions }) });
    const caller = remember(FAKE_COMPANY);
    for (const action of ["approve", "reject", "request-changes", "evidence-opened"]) {
      const answer = await routes.route(post(`/v1/app/decisions/plan/${randomUUID()}/${action}`, { digest: "x" }), caller);
      // No step-up refusal in front: the cards' own rules answer (no such card waits for this person), and nothing is decided.
      expect(answer?.statusCode, action).toBe(404);
      expect((JSON.parse(answer!.body) as { error: { code: string } }).error.code, action).not.toBe("REAUTH_REQUIRED");
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
    // A member: the grant decides (a live company owner or admin reads without one: core-host-playbook-route.test.ts).
    const caller = remember(FAKE_COMPANY, "member");
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
    expect(JSON.parse(index!.body)).toEqual({ project: "payments", state: "empty", agentsEnabled: false, pages: [] });
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

// Lead 4 C1: the wiki's corrections through the dev routes: the member company's own store, the role read live inside, the generic guards first.
describe("the project wiki's corrections on the deployed API", () => {
  const WIKI = "/v1/app/projects/payments/wiki";
  const PAGE = `${WIKI}/pages/overview`;
  const paths = [["GET", `${PAGE}/corrections`], ["POST", `${PAGE}/notes`], ["POST", `${PAGE}/notes/note0001/approve`], ["POST", `${PAGE}/notes/note0001/delete`], ["POST", `${PAGE}/notes/note0001/suggest-lesson`], ["POST", `${PAGE}/notes/note0001/acknowledge`],
    ["POST", `${PAGE}/flags`], ["POST", `${PAGE}/flags/resolve`], ["GET", `${WIKI}/disputed`]] as const;
  const request = (method: string, path: string) => (method === "GET" ? get(path) : post(path, { text: "hello" }));

  it("asks the role for the member company and the project of the path, and answers with that company's own wiki", async () => {
    const { app, companyOf, remember } = await world2();
    const seen: string[] = [];
    const wikiCorrections = { projectRole: async (personId: string, companyId: string, project: string) => { seen.push(`${companyId}/${project}`); return "viewer" as const; }, projectRepositories: async () => ["web"] };
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, wikiCorrections }) });
    const answer = await routes.route(get(`${WIKI}/disputed`), remember(OTHER));
    expect(answer?.statusCode).toBe(403);
    expect(seen).toEqual([`${OTHER}/payments`]);
    expect((await routes.route(post(`${PAGE}/notes`, { text: "hello" }), remember(OTHER)))?.statusCode).toBe(403);
  });

  it("refuses a script token (403) and a caller with no member company (401) before any role is read; unwired is 'not on the core yet'", async () => {
    const { app, companyOf, remember } = await world2();
    const projectRole = vi.fn(async () => "maintainer" as const);
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, wikiCorrections: { projectRole, projectRepositories: async () => ["web"] } }) });
    for (const [method, path] of paths) {
      const token = await routes.route(request(method, path), { ...remember(FAKE_COMPANY), scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
      expect(token?.statusCode, `${method} ${path}`).toBe(403);
      expect((JSON.parse(token!.body) as { error: { message: string } }).error.message).toBe(NOT_FOR_SCRIPT_TOKENS);
      const stranger = callerOf(FAKE_COMPANY);
      expect((await routes.route(request(method, path), { ...stranger, principal: { ...stranger.principal, personId: "no-membership" } }))?.statusCode, `${method} ${path}`).toBe(401);
    }
    expect(projectRole).not.toHaveBeenCalled();
    const unwired = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    for (const [method, path] of paths) {
      const answer = await unwired.route(request(method, path), remember(FAKE_COMPANY));
      expect((JSON.parse(answer!.body) as { error: { message: string } }).error.message, `${method} ${path}`).toBe(NOT_ON_THE_CORE_YET);
    }
    expect(await routes.route({ method: "DELETE", path: `${PAGE}/notes/note0001`, headers: {}, body: "" }, remember(FAKE_COMPANY))).toBeUndefined();
  });
});

// DEC 254zzz73: no step-up. Making a script token needs a live owner or admin of the company; acting on a decision card needs the performer's live rule.
describe("making a script token and acting on a decision card need no step-up", () => {
  const BODY = { requestId: "", name: "ci", projects: ["payments"], permissions: ["read"] };
  const errorOf = (answer: { body: string } | undefined) => (JSON.parse(answer!.body) as { error: { code: string; message: string } }).error;

  async function setup(extra: Partial<CoreDevWiring> = {}) {
    const w = await world2();
    const list = vi.fn(async (...seen: unknown[]) => (seen.length >= 0 ? [] : []));
    const performer = { approve: vi.fn(), reject: vi.fn() };
    const decisions = { sources: { list, locks: async () => ({}) as never }, performer, store: { findDecision: async () => undefined } as never, now: () => 0 } as unknown as NonNullable<CoreDevWiring["decisions"]>;
    const routesFor = (more: Partial<CoreDevWiring>) => createCoreDevRoutes({ app: w.app, companyOf: w.companyOf, wiring: () => ({ ...WIRED, decisions, canReadProject: async (_person, project) => project === "payments", ...extra, ...more }) });
    return { ...w, routes: routesFor({}), routesFor, list, performer };
  }

  it("refuses a live member before reading the body, despite owner claims", async () => {
    const { routes, remember } = await setup();
    const member = remember(FAKE_COMPANY, "member");
    expect(member.principal.roles).toContain("owner");
    const request = { ...post("/v1/app/script-tokens"), headers: { "x-org-role": "owner" }, get body(): string { throw new Error("body must not be read"); } };
    const answer = await routes.route(request, member);
    expect(answer?.statusCode).toBe(403);
    expect(errorOf(answer)).toEqual({ code: "FORBIDDEN", message: "Only an owner or an admin of the company can create script tokens." });
  });

  it("reads creation authority live on every request and never takes an owner claim over a demotion", async () => {
    const { routes, remember } = await setup();
    const caller: DeployedCaller = remember(FAKE_COMPANY, "owner");
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
    const caller = callerOf(FAKE_COMPANY);
    const answer = await routes.route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), caller);
    expect(answer?.statusCode).toBe(401);
    expect(errorOf(answer)).toEqual({ code: "UNAUTHENTICATED", message: SIGN_IN_AGAIN });
    expect(world.created).toEqual([]);
  });

  it("makes a script token for a signed-in owner with no step-up, and lists it after", async () => {
    const { routes, remember } = await setup();
    const caller: DeployedCaller = remember(FAKE_COMPANY);
    const made = await routes.route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), caller);
    expect(made?.statusCode).toBe(201);
    const created = JSON.parse(made!.body) as { token: { tokenId: string }; secret: string };
    expect(created.secret.length).toBeGreaterThan(20);
    const listed = JSON.parse((await routes.route(get("/v1/app/script-tokens"), caller))!.body) as { tokens: Array<{ tokenId: string }> };
    expect(listed.tokens.map((token) => token.tokenId)).toEqual([created.token.tokenId]);
  });

  it("owner DEC 254zzz91: an owner's CLI or AI-tool token (not the Rovara website's own client) makes no script token: 403 with the website words, and nothing is listed after", async () => {
    const { routes, remember } = await setup();
    const web = remember(FAKE_COMPANY);
    const refused = await routes.route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), cliOf(web));
    expect(refused?.statusCode).toBe(403);
    expect(JSON.parse(refused!.body)).toEqual({ error: { code: "FORBIDDEN", message: ON_THE_WEBSITE_MESSAGE } });
    expect((JSON.parse((await routes.route(get("/v1/app/script-tokens"), web))!.body) as { tokens: unknown[] }).tokens).toEqual([]);
    // Listing and revoking stay open to the CLI's token.
    expect((await routes.route(get("/v1/app/script-tokens"), cliOf(web)))?.statusCode).toBe(200);
    // A member on the website's own client is refused for the role, not for the client.
    const member = await routes.route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), remember(FAKE_COMPANY, "member", "person-member-web"));
    expect(member?.statusCode).toBe(403);
    expect((JSON.parse(member!.body) as { error: { message: string } }).error.message).not.toBe(ON_THE_WEBSITE_MESSAGE);
  });

  it("writes the caller's verified sign-in method as the token's amr, and no sign-in time", async () => {
    const { app, routes, remember } = await setup();
    for (const amr of ["slack", "github"] as const) {
      const made = await routes.route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID(), name: `ci-${amr}` }), { ...remember(FAKE_COMPANY), amr });
      expect(made?.statusCode).toBe(201);
      const tokenId = (JSON.parse(made!.body) as { token: { tokenId: string } }).token.tokenId;
      const record = await readScriptToken({ store: (await app.runtimeFor(FAKE_COMPANY)).flow.deps.store }, FAKE_COMPANY, tokenId);
      expect(record).toMatchObject({ amr });
      expect(record).not.toHaveProperty("authTime");
    }
  });

  it("passes the install's session cap through: a token lives no longer than a session would, and an unreadable cap makes nothing", async () => {
    const { app, routesFor, remember } = await setup();
    const caller: DeployedCaller = remember(FAKE_COMPANY);
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
    const listed = JSON.parse((await routesFor({}).route(get("/v1/app/script-tokens"), caller))!.body) as { tokens: Array<{ name: string }> };
    expect(listed.tokens.map((token) => token.name).sort()).toEqual(["ci", "ci-open"]);
  });

  it("a step-up a body or a header names is ignored: an owner's token is made, a member's is refused, whatever they send", async () => {
    const { world, routes, remember } = await setup();
    const body = { ...BODY, requestId: randomUUID(), stepUp: { at: new Date(world.clock.now).toISOString(), method: "email_code" } };
    const request = (b: unknown) => ({ ...post("/v1/app/script-tokens", b), headers: { "x-step-up-at": new Date(world.clock.now).toISOString() } });
    // `stepUp` is not a body field the token schema reads: a strict body refuses it, so the plain body is the owner's.
    expect((await routes.route(request(body), remember(FAKE_COMPANY)))?.statusCode).toBeGreaterThanOrEqual(400);
    expect((await routes.route(request({ ...BODY, requestId: randomUUID() }), remember(FAKE_COMPANY)))?.statusCode).toBe(201);
    const member = await routes.route(request({ ...BODY, requestId: randomUUID() }), remember(FAKE_COMPANY, "member", "person-member-0001"));
    expect(errorOf(member)).toEqual({ code: "FORBIDDEN", message: "Only an owner or an admin of the company can create script tokens." });
  });


  it("makes a token only for projects the person may read now; one they may not read answers like a missing one", async () => {
    const { routes, remember } = await setup();
    const caller: DeployedCaller = remember(FAKE_COMPANY);
    const hidden = await routes.route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID(), projects: ["secret"] }), caller);
    expect(hidden?.statusCode).toBe(404);
    expect(errorOf(hidden).message).toBe("project not found");
    const { canReadProject: _dropped, ...withoutAccess } = { ...WIRED, canReadProject: undefined };
    void _dropped;
    const unwired = await createCoreDevRoutes({ app: (await world2()).app, companyOf: async () => ({ companyId: FAKE_COMPANY, role: "owner" }), wiring: () => withoutAccess }).route(post("/v1/app/script-tokens", { ...BODY, requestId: randomUUID() }), caller);
    expect(errorOf(unwired).message).toBe(NOT_ON_THE_CORE_YET);
  });

  it("lets an act on a card reach the cards with no step-up and no sign-in time on the principal (DEC 254zzz73)", async () => {
    const { routes, remember, list } = await setup();
    const caller = remember(FAKE_COMPANY);
    const acted = await routes.route(post(`/v1/app/decisions/approve_plan/${randomUUID()}/reject`, { requestId: randomUUID(), reason: "not_now" }), caller);
    // The card is simply not waiting for them (the sources list is empty): nothing in front of the cards refused the act.
    expect(acted?.statusCode).toBe(404);
    expect(list).toHaveBeenCalledTimes(1);
    const seen = list.mock.calls[0]![0] as { principal: { authTime?: string; methods?: string[] }; stepUp?: unknown };
    expect(seen.principal.authTime).toBeUndefined();
    expect(seen.principal.methods).toBeUndefined();
    expect(seen).not.toHaveProperty("stepUp");
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
      modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
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
    return { world, routes, own, remember, taskId: task.taskId, workspaceId: task.workspaceId, revision: task.workflow!.revision };
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

  it("ports retry actions and mounts only the owning publication and review handlers", async () => {
    const { world, routes, own, taskId, revision } = await started();
    const before = await world.store.get(taskKey(taskId));
    for (const action of ["workflow/retry"]) {
      const answer = await routes.route(post(`/v1/dev/tasks/${taskId}/${action}`, sendBackBody(revision)), own);
      expect(answer?.statusCode, action).toBe(400);
      expect(errorOf(answer)?.code).toBe("CONFIG_INVALID");
    }
    const publish = await routes.route(post(`/v1/dev/tasks/${taskId}/workflow/publish-retry`, { requestId: randomUUID(), expectedRevision: revision }), own);
    expect(publish?.statusCode).toBe(400);
    const manual = await routes.route(post(`/v1/dev/tasks/${taskId}/pull-requests`, { requestId: randomUUID(), title: "My change", draft: true }), own);
    expect(manual?.statusCode).toBe(400);
    expect(errorOf(manual)?.message).toBe("This task opens its own pull request after its checks and reviews pass.");
    const review = await routes.route(post(`/v1/dev/tasks/${taskId}/workflow/review`, sendBackBody(revision)), own);
    expect(review?.statusCode).toBe(400);
    expect(errorOf(review)?.message).toContain("exact candidate's checks passed");
    expect(await world.store.get(taskKey(taskId))).toEqual(before);
  });

  it.each(["workflow/review", "workflow/retry"])("uses the same review service for %s and replays through the other route", async (action) => {
    const { world, routes, own, taskId, workspaceId } = await started();
    const revision = await blockReview(world, taskId);
    const record = (await world.store.get(taskKey(taskId)))!;
    const workflow = record["workflow"] as unknown as WorkflowSnapshot;
    const location = await workspaceKeys({ store: world.store, companyId: FAKE_COMPANY }, workspaceId);
    await world.store.update({ key: location.workspaceKey, ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
    const request = { ...sendBackBody(revision), candidateDigest: workflow.candidate!.digest };
    const first = await routes.route(post(`/v1/dev/tasks/${taskId}/${action}`, request), own);
    expect(first?.statusCode, first?.body).toBe(200);
    const other = action === "workflow/review" ? "workflow/retry" : "workflow/review";
    expect((await routes.route(post(`/v1/dev/tasks/${taskId}/${other}`, request), own))?.statusCode).toBe(200);
    const operations = await workspaceOperations({ store: world.store, companyId: FAKE_COMPANY }, workspaceId);
    const reviews = operations.filter((operation) => operation.workflowMode === "REVIEW");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ requestId: request.requestId, dispatch: { payload: { workflowReviewNote: request.instructions } } });
  });

  it("ports plan reads with the old document/version refusals", async () => {
    const { routes, own, taskId } = await started();
    const answer = await routes.route(get(`/v1/dev/tasks/${taskId}/plan`), own);
    expect(answer?.statusCode).toBe(404);
    expect(errorOf(answer)?.message).toBe("this task has no plan document yet");
    const invalid = await routes.route(get(`/v1/dev/tasks/${taskId}/plan?version=1.5`), own);
    expect(invalid?.statusCode).toBe(400);
    expect(errorOf(invalid)?.message).toBe("version must be a whole number from 1 to 999");
    expect(await routes.route(post(`/v1/dev/tasks/${taskId}/plan`), own)).toBeUndefined();
  });

  it("does not expose ported task routes to script tokens or another company, even with malformed JSON", async () => {
    const { world, routes, own, remember, taskId } = await started();
    const before = await world.store.get(taskKey(taskId));
    for (const action of ["workflow/decision", "workflow/retry", "workflow/publish-retry", "close"]) {
      for (const caller of [remember(OTHER), { ...own, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } }]) {
        expect((await routes.route({ ...post(`/v1/dev/tasks/${taskId}/${action}`), body: "not json" }, caller))?.statusCode, action).toBe(404);
      }
    }
    expect(await world.store.get(taskKey(taskId))).toEqual(before);
  });

  it("closes through the core flow and returns the MCP close wire shape", async () => {
    const { routes, own, taskId } = await started();
    const body = { requestId: randomUUID() };
    const answer = await routes.route(post(`/v1/dev/tasks/${taskId}/close`, body), own);
    expect(answer?.statusCode).toBe(200);
    expect(JSON.parse(answer!.body)).toMatchObject({ closed: true, task: { taskId, status: "CLOSED" } });
    expect(JSON.parse((await routes.route(post(`/v1/dev/tasks/${taskId}/close`, body), own))!.body)).toMatchObject({ closed: true, task: { taskId } });
  });

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
    expect(errorOf(findings)).toMatchObject({ code: "CHANGE_STALE" });
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

  it.each(["workflow/review-findings", "page-findings"])("still accepts the documented findings input on %s and replays it without another write", async (action) => {
    const { world, routes, own, taskId } = await started();
    const revision = await blockReview(world, taskId);
    const body = {
      requestId: randomUUID(), expectedRevision: revision, candidateDigest: code.digest,
      resolutions: [{ findingId: parserId, action: "FIX", note: "Keep the footer line." }],
    };
    const path = action === "page-findings" ? `/v1/app/tasks/${taskId}/review-findings` : `/v1/dev/tasks/${taskId}/${action}`;
    const response = await routes.route(post(path, body), own);
    expect(response?.statusCode).toBe(200);
    expect(JSON.parse(response!.body)).toMatchObject({ task: { taskId, workflow: { stage: "IMPLEMENT" } } });
    const committed = await world.store.get(taskKey(taskId));
    expect(committed).toMatchObject({ workflow: { decisions: [expect.objectContaining({ requestId: body.requestId })] } });
    const transact = vi.spyOn(world.store, "transact");
    try {
      const replay = await routes.route(post(path, body), own);
      expect(replay?.statusCode).toBe(200);
      expect(JSON.parse(replay!.body)).toEqual(JSON.parse(response!.body));
      expect(await world.store.get(taskKey(taskId))).toEqual(committed);
      expect(transact).not.toHaveBeenCalled();
    } finally {
      transact.mockRestore();
    }
  });

  it.each(["workflow/send-back", "workflow/review-findings", "page-findings"])("returns an applied refresh answer after %s commits and the owned-task reload fails, also on replay", async (action) => {
    let reads = 0;
    let failReload = true;
    const access = ownerRule();
    const world = await started({ ...access, canAct: async (principal, task) => {
      reads += 1;
      if (failReload && reads === 3) throw agentXError("IDEMPOTENCY_CONFLICT", "People changed; refresh the task and try again");
      return access.canAct(principal, task);
    } });
    const { routes, own, taskId } = world;
    const revision = await blockReview(world.world, taskId);
    const body = action === "workflow/send-back" ? sendBackBody(revision) : {
      requestId: randomUUID(), expectedRevision: revision, candidateDigest: code.digest,
      resolutions: [{ findingId: parserId, action: "FIX", note: "Keep the footer line." }],
    };
    const path = action === "page-findings" ? `/v1/app/tasks/${taskId}/review-findings` : `/v1/dev/tasks/${taskId}/${action}`;
    const applied = await routes.route(post(path, body), own);
    expect(applied?.statusCode).toBe(409);
    expect(JSON.parse(applied!.body)).toEqual({ error: { code: "COMMITTED_REFRESH_NEEDED", message: "The change was applied. Refresh to read the current task before acting again." } });
    const committed = await world.world.store.get(taskKey(taskId));
    const workspaceId = committed?.["workspaceId"];
    if (typeof workspaceId !== "string") throw new Error("committed task has no workspace");
    const workspace = workspaceKey(FAKE_COMPANY, workspaceId);
    const operations = await world.world.store.query({ pk: workspace.pk });
    expect(committed).toMatchObject({ workflow: { decisions: [expect.objectContaining({ requestId: body.requestId })] } });
    reads = 0;
    const replay = await routes.route(post(path, body), own);
    expect(replay?.statusCode).toBe(409);
    expect(JSON.parse(replay!.body)).toEqual(JSON.parse(applied!.body));
    expect(await world.world.store.get(taskKey(taskId))).toEqual(committed);
    expect(await world.world.store.query({ pk: workspace.pk })).toEqual(operations);
    failReload = false;
    expect((await routes.route(get(`/v1/dev/tasks/${taskId}`), own))?.statusCode).toBe(200);
  });

  it.each([
    ["workflow/send-back", 1], ["workflow/send-back", 2],
    ["workflow/review-findings", 1], ["workflow/review-findings", 2],
    ["page-findings", 1], ["page-findings", 2],
  ] as const)("keeps a People conflict on %s at owner read %s as a refusal with no applied claim or write", async (action, failAt) => {
    let fail = false;
    let reads = 0;
    const access = ownerRule();
    const { world, routes, own, taskId } = await started({ ...access, canAct: async (principal, task) => {
      if (fail && ++reads === failAt) throw agentXError("IDEMPOTENCY_CONFLICT", "People changed; refresh the task and try again");
      return access.canAct(principal, task);
    } });
    const revision = await blockReview(world, taskId);
    const before = await world.store.get(taskKey(taskId));
    const transact = vi.spyOn(world.store, "transact");
    const body = action === "workflow/send-back" ? sendBackBody(revision) : {
      requestId: randomUUID(), expectedRevision: revision, candidateDigest: code.digest,
      resolutions: [{ findingId: parserId, action: "FIX", note: "Keep the footer line." }],
    };
    const path = action === "page-findings" ? `/v1/app/tasks/${taskId}/review-findings` : `/v1/dev/tasks/${taskId}/${action}`;
    fail = true;
    const refused = await routes.route(post(path, body), own);
    expect(reads).toBe(failAt);
    expect(refused?.statusCode).toBe(409);
    expect(errorOf(refused)?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await world.store.get(taskKey(taskId))).toEqual(before);
    expect(transact).not.toHaveBeenCalled();
  });

  it.each(["workflow/review-findings", "page-findings"])("keeps a stale revision on %s as CHANGE_STALE with no applied claim or write", async (action) => {
    const { world, routes, own, taskId } = await started();
    const revision = await blockReview(world, taskId);
    const before = await world.store.get(taskKey(taskId));
    const transact = vi.spyOn(world.store, "transact");
    const path = action === "page-findings" ? `/v1/app/tasks/${taskId}/review-findings` : `/v1/dev/tasks/${taskId}/${action}`;
    const refused = await routes.route(post(path, {
      requestId: randomUUID(), expectedRevision: revision - 1, candidateDigest: code.digest,
      resolutions: [{ findingId: parserId, action: "FIX", note: "Keep the footer line." }],
    }), own);
    expect(refused?.statusCode).toBe(409);
    expect(errorOf(refused)?.code).toBe("CHANGE_STALE");
    expect(await world.store.get(taskKey(taskId))).toEqual(before);
    expect(transact).not.toHaveBeenCalled();
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

  it("leaves the start to the old broker for a person with no member company", async () => {
    const { app, companyOf } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    expect(await routes.route(post("/v1/dev/tasks", startBody()), callerOf(FAKE_COMPANY))).toBeUndefined();
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

// L4-P3 (owner 2026-11-17), DEC 254zzz73: allowing and withdrawing the company's automatic runs need only the live owner or admin role (no step-up), through both the setup PUT and the company's
// own route. Mutants are listed in the PR body with the test that kills each.
describe("the company's automatic runs: the live owner or admin role to allow and to withdraw, no step-up", () => {
  const SYSTEM_RUNS = "/v1/app/company/system-runs";
  const UPKEEP = "/v1/app/projects/payments/upkeep";
  const errorOf = (answer: { body: string } | undefined) => (JSON.parse(answer!.body) as { error: { code: string; message: string } }).error;
  const put = (path: string, body: unknown) => ({ method: "PUT", path, headers: {}, body: JSON.stringify(body) });
  const allow = (): { requestId: string; allowed: boolean } => ({ requestId: randomUUID(), allowed: true });
  const setupAllow = () => ({ requestId: randomUUID(), on: true, allowSystemRuns: true });

  async function setup(extra: Partial<CoreDevWiring> = {}, ceiling: boolean = true) {
    const w = await world2();
    const upkeep = { standing: async (personId: string) => (personId === "person-member" ? { access: "view" as const } : { access: "manage" as const, basis: personId === "pm" ? ("project-admin" as const) : ("company-owner" as const) }), ...(ceiling ? { available: () => true } : {}) };
    const routes = createCoreDevRoutes({ app: w.app, companyOf: w.companyOf, wiring: () => ({ ...WIRED, upkeep, ...extra }) });
    const consentOf = async (companyId: string) => (await w.world.store.get({ pk: `ORG#${companyId}#SYSTEM_RUNS`, sk: "CONSENT" }))?.["enabled"] === true;
    return { ...w, routes, consentOf };
  }


  it("owner DEC 254zzz91: an owner's CLI or AI-tool token cannot ALLOW on either route (403, the website words, nothing written) but can WITHDRAW", async () => {
    const a = await setup();
    const owner = a.remember(FAKE_COMPANY);
    for (const [path, body] of [[SYSTEM_RUNS, allow()], [UPKEEP, setupAllow()]] as const) {
      const refused = await a.routes.route(put(path, body), cliOf(owner));
      expect(refused?.statusCode, path).toBe(403);
      expect(errorOf(refused)).toEqual({ code: "FORBIDDEN", message: ON_THE_WEBSITE_MESSAGE });
      expect(await a.consentOf(FAKE_COMPANY)).toBe(false);
    }
    expect((await a.routes.route(put(SYSTEM_RUNS, allow()), owner))?.statusCode).toBe(200);
    expect(await a.consentOf(FAKE_COMPANY)).toBe(true);
    expect((await a.routes.route(put(SYSTEM_RUNS, { requestId: randomUUID(), allowed: false }), cliOf(owner)))?.statusCode).toBe(200);
    expect(await a.consentOf(FAKE_COMPANY)).toBe(false);
  });

  it("a signed-in owner with no step-up allows it, through both routes", async () => {
    const a = await setup();
    const answer = await a.routes.route(put(SYSTEM_RUNS, allow()), a.remember(FAKE_COMPANY));
    expect(answer?.statusCode).toBe(200);
    expect(JSON.parse(answer!.body)).toEqual({ available: true, allowed: true, systemRunsOn: true });
    expect(await a.consentOf(FAKE_COMPANY)).toBe(true);
    const b = await setup();
    const setupAnswer = await b.routes.route(put(UPKEEP, setupAllow()), b.remember(FAKE_COMPANY));
    expect(setupAnswer?.statusCode).toBe(200);
    expect(JSON.parse(setupAnswer!.body)).toMatchObject({ enabled: true, systemRunsOn: true });
    expect(await b.consentOf(FAKE_COMPANY)).toBe(true);
  });

  it("an owner withdraws on either route; the consent is gone and the gate says off at once", async () => {
    const { routes, remember, consentOf } = await setup();
    const fresh: DeployedCaller = remember(FAKE_COMPANY);
    expect((await routes.route(put(SYSTEM_RUNS, allow()), fresh))?.statusCode).toBe(200);
    expect(await consentOf(FAKE_COMPANY)).toBe(true);
    const bare = remember(FAKE_COMPANY);
    const withdrawn = await routes.route(put(SYSTEM_RUNS, { requestId: randomUUID(), allowed: false }), bare);
    expect(withdrawn?.statusCode).toBe(200);
    expect(JSON.parse(withdrawn!.body)).toEqual({ available: true, allowed: false, systemRunsOn: false });
    expect(await consentOf(FAKE_COMPANY)).toBe(false);
    // And the setup route's withdrawal (allowSystemRuns false) the same way.
    await routes.route(put(SYSTEM_RUNS, allow()), fresh);
    const setupOff = await routes.route(put(UPKEEP, { requestId: randomUUID(), on: false, allowSystemRuns: false }), bare);
    expect(setupOff?.statusCode).toBe(200);
    expect(JSON.parse(setupOff!.body)).toMatchObject({ enabled: false, systemRunsOn: false });
    expect(await consentOf(FAKE_COMPANY)).toBe(false);
  });

  // MUTANT E3: the role is not membership's (a maintainer or member reaches the company route).
  it("the role is membership's: a member (and a project maintainer, who is a member of the company) is refused for reading, allowing and withdrawing; an admin is not", async () => {
    const { routes, remember, consentOf } = await setup();
    // "pm" is the person the setup wiring knows as a project administrator: a maintainer of the project, a plain member of the company.
    for (const personId of ["person-member", "pm"]) {
      const caller: DeployedCaller = remember(FAKE_COMPANY, "member", personId);
      for (const request of [get(SYSTEM_RUNS), put(SYSTEM_RUNS, allow()), put(SYSTEM_RUNS, { requestId: randomUUID(), allowed: false })]) {
        const answer = await routes.route(request, caller);
        expect(answer?.statusCode, `${personId} ${request.method}`).toBe(403);
        expect(errorOf(answer).code).toBe("FORBIDDEN");
      }
      // The setup route: the maintainer may switch the project, but neither allow nor withdraw the company's consent.
      for (const body of [setupAllow(), { requestId: randomUUID(), on: false, allowSystemRuns: false }]) {
        const answer = await routes.route(put(UPKEEP, body), caller);
        expect(answer?.statusCode, personId).toBe(403);
        expect(errorOf(answer).code).toBe("FORBIDDEN");
      }
    }
    expect(await consentOf(FAKE_COMPANY)).toBe(false);
    const admin: DeployedCaller = remember(FAKE_COMPANY, "admin", "person-admin");
    expect((await routes.route(put(SYSTEM_RUNS, allow()), admin))?.statusCode).toBe(200);
    expect((await routes.route(get(SYSTEM_RUNS), admin))?.statusCode).toBe(200);
  });

  // MUTANT E4: the script-token refusal does not cover the new path.
  it("a script token reaches neither route's company control: refused before anything is read", async () => {
    const { routes, remember } = await setup();
    const token: DeployedCaller = { ...remember(FAKE_COMPANY), scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } };
    for (const request of [get(SYSTEM_RUNS), put(SYSTEM_RUNS, allow()), put(UPKEEP, setupAllow())]) {
      const answer = await routes.route(request, token);
      expect(answer?.statusCode, request.path).toBe(403);
      expect(errorOf(answer)).toEqual({ code: "FORBIDDEN", message: NOT_FOR_SCRIPT_TOKENS });
    }
  });


  it("the ceiling off: allowing is 'unavailable'; withdrawing still works. Unwired: 'not on the core yet'", async () => {
    const off = await setup({}, false);
    const caller: DeployedCaller = off.remember(FAKE_COMPANY);
    expect(errorOf(await off.routes.route(put(SYSTEM_RUNS, allow()), caller)).code).toBe("NOT_AVAILABLE_HERE");
    expect((await off.routes.route(put(SYSTEM_RUNS, { requestId: randomUUID(), allowed: false }), caller))?.statusCode).toBe(200);
    const w = await world2();
    const unwired = createCoreDevRoutes({ app: w.app, companyOf: w.companyOf, wiring: () => WIRED });
    const answer = await unwired.route(get(SYSTEM_RUNS), w.remember(FAKE_COMPANY));
    expect(answer?.statusCode).toBe(404);
    expect(errorOf(answer).message).toBe(NOT_ON_THE_CORE_YET);
  });

  it("two companies: one's owner allows and withdraws only their own company's setting", async () => {
    const { routes, remember, consentOf } = await setup();
    const a: DeployedCaller = remember(FAKE_COMPANY);
    const b: DeployedCaller = remember(OTHER);
    expect((await routes.route(put(SYSTEM_RUNS, allow()), a))?.statusCode).toBe(200);
    expect(await consentOf(FAKE_COMPANY)).toBe(true);
    expect(await consentOf(OTHER)).toBe(false);
    expect(JSON.parse((await routes.route(get(SYSTEM_RUNS), b))!.body)).toMatchObject({ allowed: false });
    expect((await routes.route(put(SYSTEM_RUNS, allow()), b))?.statusCode).toBe(200);
    expect((await routes.route(put(SYSTEM_RUNS, { requestId: randomUUID(), allowed: false }), a))?.statusCode).toBe(200);
    expect(await consentOf(FAKE_COMPANY)).toBe(false);
    expect(await consentOf(OTHER)).toBe(true);
  });
});

// L4-EVCI2: the setup card's "Eval check from your CI" on the deployed API. The company's own runtime and store, the caller's live standing (read inside), the request's audit sink; a script token is refused before the
// standing is read; unwired is "not on the core yet". Mutants are listed in the PR body with the test that kills each.
describe("the eval check card on the deployed API (L4-EVCI2)", () => {
  const CARD = "/v1/app/projects/payments/ci-eval-check";
  const put = (path: string, body: unknown) => ({ method: "PUT", path, headers: {}, body: JSON.stringify(body) });
  const workflow = ["name: ci", "on: pull_request", "jobs:", "  evals:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npx promptfoo eval"].join("\n");
  const reader = { list: async (path: string) => (path === ".github/workflows" ? { entries: [{ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file" }], truncated: false } : undefined), read: async () => ({ text: workflow }) };
  const answerOf = (answer: { body: string } | undefined) => JSON.parse(answer!.body) as { error?: { code: string; message: string }; confirmed?: { name: string } | null; proposals?: { verdict: string } | null };

  it("unwired is 'not on the core yet'; a script token is refused 403 before the standing is read; a caller with no company is 401", async () => {
    const { app, companyOf, remember } = await world2();
    const standing = vi.fn(async () => ({ access: "manage" as const, basis: "company-owner" as const }));
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, evalCheck: { standing, readerFor: async () => reader } }) });
    for (const request of [get(CARD), put(CARD, { requestId: randomUUID(), check: null })]) {
      const token = await routes.route(request, { ...remember(FAKE_COMPANY), scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
      expect(token?.statusCode, request.method).toBe(403);
      expect(answerOf(token).error?.message).toBe(NOT_FOR_SCRIPT_TOKENS);
      const stranger = callerOf(FAKE_COMPANY);
      expect((await routes.route(request, { ...stranger, principal: { ...stranger.principal, personId: "no-membership" } }))?.statusCode, request.method).toBe(401);
    }
    expect(standing).not.toHaveBeenCalled();
    const unwired = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    for (const request of [get(CARD), put(CARD, { requestId: randomUUID(), check: null })]) {
      const answer = await unwired.route(request, remember(FAKE_COMPANY));
      expect(answer?.statusCode, request.method).toBe(404);
      expect(answerOf(answer).error?.message).toBe(NOT_ON_THE_CORE_YET);
    }
  });

  it("propose, confirm, stored, in the company's own store: the proposals come from the workflow reader, the confirm is audited with the person, and another company's caller reads nothing of it", async () => {
    const { app, companyOf, remember } = await world2();
    const readFor: string[] = [];
    const read = async (companyId: string) => { readFor.push(companyId); return reader; };
    const standing = async () => ({ access: "manage" as const, basis: "company-owner" as const });
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, evalCheck: { standing, readerFor: read } }) });
    const owner = remember(FAKE_COMPANY);
    const proposed = await routes.route(get(CARD), owner);
    expect(proposed?.statusCode).toBe(200);
    expect(answerOf(proposed)).toMatchObject({ confirmed: null, proposals: { verdict: "proposals" } });
    expect(readFor).toContain(FAKE_COMPANY);
    const done = await routes.route(put(CARD, { requestId: randomUUID(), check: { name: "evals", source: "15368" } }), owner);
    expect(done?.statusCode).toBe(200);
    expect(answerOf(done).confirmed).toMatchObject({ name: "evals" });
    const store = (await app.runtimeFor(FAKE_COMPANY)).flow.deps.store;
    expect(await store.get({ pk: `ORG#${FAKE_COMPANY}#CIEVAL#payments`, sk: "CHECK" })).toMatchObject({ orgId: FAKE_COMPANY, project: "payments", check: { name: "evals", source: "15368" } });
    // The other company reads its own project of the same name: nothing is confirmed there.
    expect(answerOf(await routes.route(get(CARD), remember(OTHER))).confirmed).toBeNull();
    expect(await (await app.runtimeFor(OTHER)).flow.deps.store.get({ pk: `ORG#${OTHER}#CIEVAL#payments`, sk: "CHECK" })).toBeUndefined();
  });
});


describe("read-only start-estimates", () => {
 it("registers only the approved read scope on the dev boundary", async () => {
  const { devRouteOf } = await import("../../packages/broker/src/aws/dev-route-scopes.js");
  expect(devRouteOf("POST", "/v1/dev/projects/payments/start-estimates")?.requires).toBe("tasks:read");
  for (const method of ["GET", "PUT", "DELETE"]) expect(devRouteOf(method, "/v1/dev/projects/payments/start-estimates")).toBeUndefined();
 });
 it("serves the negotiated comparison with live company/project checks and never creates a hold or task", async () => {
  const { world, app, companyOf, remember } = await world2();
  const caller = remember(FAKE_COMPANY);
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, canReadProject: async () => false }) });
  const writes = vi.spyOn(world.store, "transact");
  const put = vi.spyOn(world.store, "put");
  const result = await routes.route(post("/v1/dev/projects/payments/start-estimates", { quoteVersion: 2 }), caller);
  expect(result?.statusCode).toBe(200);
  expect(JSON.parse(result!.body)).toMatchObject({ quoteVersion: 2, orgId: FAKE_COMPANY, options: [{ path: "QUICK" }, { path: "FULL" }] });
  expect(writes).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();
  const denied = remember(OTHER, "member");
  expect((await routes.route(post("/v1/dev/projects/payments/start-estimates", { quoteVersion: 2 }), denied))?.statusCode).toBe(404);
  expect((await routes.route(post("/v1/dev/projects/payments/start-estimates", { quoteVersion: 2, companyId: OTHER }), caller))?.statusCode).toBe(400);
 });
});


it("redacts every company figure in the member JSON while owners and admins keep the numeric quote", async () => {
 const { app, companyOf, remember } = await world2();
 const av = <T>(value: T) => ({ state: "available" as const, value });
 const un = { state: "unavailable" as const, reason: "not_measured" as const };
 const companyNumbers = [9100011, 8100013, 7100017, 5100023, 4100029];
 const context = { policyRevision: "p1", stages: {}, initialHoldCeilingMicros: 5100023, limits: [
  { scope: "engine_day" as const, maximumMicros: av(9100011), availableMicros: av(8100013), heldMicros: av(7100017), resetAt: un },
  { scope: "engine_task" as const, maximumMicros: av(6100019), availableMicros: av(5100023), heldMicros: av(4100029), resetAt: un },
 ] };
 const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, canReadProject: async () => true, startEstimates: async () => context }) });
 const read = async (role: CompanyMembership["role"]) => {
  const result = await routes.route(post("/v1/dev/projects/payments/start-estimates", { quoteVersion: 2 }), remember(FAKE_COMPANY, role));
  expect(result?.statusCode).toBe(200);
  return JSON.parse(result!.body) as unknown;
 };
 // Walk the entire serialized response: leaks in a hold, binding or future nested field must also fail.
 const numbers = (value: unknown): number[] => typeof value === "number" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(numbers) : [];
 const member = await read("member");
 const options = (member as { options: Array<{ firstBindingLimit: unknown }> }).options;
 for (const q of options) expect(numbers(q.firstBindingLimit)).toEqual([]);
 expect(member).toMatchObject({ options: [{ firstBindingLimit: { value: { bindingScope: "engine_task" } } }, { firstBindingLimit: { value: { bindingScope: "engine_task" } } }] });
 expect(numbers(member).filter(n => companyNumbers.includes(n))).toEqual([]);
 expect(options.map(q => Object.keys(q).sort())).toEqual([0, 1].map(() => ["path", "scope", "range", "taskMaximumMicros", "limitCoverage", "firstBindingLimit", "notices"].sort()));
 expect(member).toMatchObject({ options: [{ range: av({ lowMicros: 1_000_000, highMicros: 3_000_000 }), taskMaximumMicros: av(6100019) }, { range: av({ lowMicros: 4_000_000, highMicros: 10_000_000 }), taskMaximumMicros: av(6100019) }] });
 expect(numbers(member)).toEqual([2, 1_000_000, 3_000_000, 6100019, 4_000_000, 10_000_000, 6100019]);
 for (const role of ["owner", "admin"] as const) {
  const quote = await read(role);
  expect(numbers(quote)).toEqual(expect.arrayContaining(companyNumbers));
 }
});

describe("start-estimates history and refresh boundary", () => {
 it("labels five historical runs, preserves unknown optional increments, refreshes changed options and discloses blocking held room", async () => {
  const { world, app, companyOf, remember } = await world2();
  const { recordRunCost } = await import("../../packages/broker/src/core/cost/estimate.js");
  const { parsePreviewV2 } = await import("../../packages/contracts/src/start-estimates.js");
  for (let i = 0; i < 5; i++) {
   const taskId = `history-${i}`;
   await world.store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", companyId: FAKE_COMPANY } });
   await recordRunCost({ store: world.store }, { orgId: FAKE_COMPANY, project: "payments", taskId, path: "QUICK", endedAt: "2026-11-17T00:00:00.000Z", costUsd: 0.5 + i / 2 });
  }
  const av = <T>(value: T) => ({ state: "available" as const, value });
  const un = { state: "unavailable" as const, reason: "not_measured" as const };
  const context = { policyRevision: "p1", stages: {}, initialHoldCeilingMicros: 5_000_000, limits: [{ scope: "engine_day" as const, maximumMicros: av(5_000_000), availableMicros: av(1_000_000), heldMicros: av(4_000_000), resetAt: un }] };
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, canReadProject: async () => false, startEstimates: async () => context }) });
  const caller = remember(FAKE_COMPANY);
  const read = async (body: unknown) => parsePreviewV2(JSON.parse((await routes.route(post("/v1/dev/projects/payments/start-estimates", body), caller))!.body))!;
  const q = await read({ quoteVersion: 2 });
  // This caller reads the full (non-restricted) quote: narrow before reading its admin-only fields.
  const [quickQuote, fullQuote] = q.options;
  if (!("basis" in quickQuote) || !("planningAllowanceMicros" in fullQuote)) throw new Error("expected the full (unrestricted) quote");
  expect(quickQuote.basis).toMatchObject({ kind: "history", modelPriced: false, samples: 5 });
  expect(q.options[0].range).toEqual(av({ lowMicros: 1_500_000, highMicros: 2_000_000 }));
  expect(q.options[1].range).toEqual(av({ lowMicros: 4_000_000, highMicros: 10_000_000 }));
  expect(fullQuote.planningAllowanceMicros).toEqual(av(6_000_000));
  expect(fullQuote.initialHoldMicros).toEqual(av(5_000_000));
  expect(q.options[0].firstBindingLimit).toMatchObject({ state: "available", value: { scope: "engine_day", appliesAt: "start", blocked: true, reason: "held" } });
  const refreshed = await read({ quoteVersion: 2, options: { eval: true } });
  expect(refreshed.inputsDigest).not.toBe(q.inputsDigest);
  expect(refreshed.quoteId).not.toBe(q.quoteId);
  expect(refreshed.options[0].range).toEqual(un);
  if (!("stages" in refreshed.options[0])) throw new Error("admin comparison must retain stage details");
  expect(refreshed.options[0].stages.find(s => s.stage === "legacy_aggregate")?.range).toEqual(q.options[0].range);
  expect(refreshed.options[0].limitCoverage).toBe("partial");
 });
});

// Internal worker routes are inventoried in the scope table, with no person scope.
it("inventories exactly four worker-only saved image callbacks without exposing app or developer aliases", async () => {
  const { APP_ROUTES, DEV_ROUTES, SAVED_ENV_WORKER_ROUTES, savedEnvWorkerRouteOf, appRouteOf, devRouteOf } = await import("../../packages/broker/src/aws/dev-route-scopes.js");
  expect(SAVED_ENV_WORKER_ROUTES.map(row => [row.method, row.path, row.requires])).toEqual(["push-login", "result", "fallback", "login"].map(action => ["POST", `/v1/internal/workspaces/{workspace}/operations/{operation}/saved-env-${action}`, "worker"]));
  for (const row of SAVED_ENV_WORKER_ROUTES) {
    const path = row.path.replace("{workspace}", "w").replace("{operation}", "o");
    expect(savedEnvWorkerRouteOf("POST", path)).toEqual(row);
    expect(savedEnvWorkerRouteOf("GET", path)).toBeUndefined();
    expect(appRouteOf("POST", path)).toBeUndefined();
    expect(devRouteOf("POST", path)).toBeUndefined();
  }
  expect([...APP_ROUTES, ...DEV_ROUTES].some(row => row.path.includes("/v1/internal/"))).toBe(false);
});

it("keeps invite resend on the broker's full-access developer boundary only", async () => {
  const { APP_ROUTES, appRouteOf, devRouteOf } = await import("../../packages/broker/src/aws/dev-route-scopes.js");
  const path = "/v1/dev/company/preapprovals/" + "b".repeat(64) + "/resend";
  expect(devRouteOf("POST", path)).toMatchObject({ path: "/v1/dev/company/preapprovals/{inviteId}/resend", requires: "full" });
  expect(devRouteOf("GET", path)).toBeUndefined();
  expect(devRouteOf("POST", path + "/extra")).toBeUndefined();
  expect(appRouteOf("POST", path)).toBeUndefined();
  expect(APP_ROUTES.some((row) => row.path.includes("/company/preapprovals"))).toBe(false);
});


describe("known-failing hosted route ownership", () => {
  it("owns only GET and Undo POST, refuses writes while verification is off", async () => {
    const { app, companyOf, remember } = await world2();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    const caller = remember(FAKE_COMPANY);
    const path = "/v1/app/projects/payments/known-failing";
    expect((await routes.route(get(path), caller))?.statusCode).toBe(404);
    expect((await routes.route(post(path, { action: "mark", tests: ["invented"] }), caller))?.statusCode).toBe(404);
    expect(await routes.route({ ...get(path), method: "PUT" }, caller)).toBeUndefined();
    expect(await routes.route(get(`${path}/extra`), caller)).toBeUndefined();
  });
});

it("shows task money only to its stored owner or a live company admin, never a reader, co-owner or second company", async () => {
 const { world, app, companyOf, remember } = await world2();
 const owner = remember(FAKE_COMPANY, "member", "task-owner");
 const reader = remember(FAKE_COMPANY, "member", "reader");
 const coOwner = remember(FAKE_COMPANY, "member", "co-owner");
 const admin = remember(FAKE_COMPANY, "admin", "admin");
 const foreign = remember(OTHER, "member", "task-owner");
 const runtime = await app.runtimeFor(FAKE_COMPANY);
 const { task } = await runtime.flow.start({ principal: owner.principal, origin: "app", client: "test" }, { requestId: randomUUID(), project: "payments", instructions: "Owned task", workflow: true, workflowPath: "FULL" });
 const runEstimate = { lowUsd: 4.37, highUsd: 10.19, runLimitUsd: 12.71, stopAtUsd: 12.71, basis: "default" as const, samples: 0 };
 const stored = await world.store.get(taskKey(task.taskId));
 await world.store.put({ item: { ...stored, runEstimate, spentUsd: 1.23, spentRuns: 1, workflow: { ...stored?.["workflow"] as Record<string, unknown>, designReview: fullMoneyReview() } } as never });
 runtime.flow.deps.access.canRead = async () => true;
 runtime.flow.deps.access.canAct = async principal => principal.personId !== "reader";
 // Use the ledger's real partition and an engine aggregate, just as worker accounting does.
 const { costPartition } = await import("../../packages/broker/src/core/cost/ledger.js");
 const costPk = costPartition(FAKE_COMPANY, task.taskId);
 await world.store.put({ item: { pk: costPk, sk: "ENTRY#one", companyId: FAKE_COMPANY, taskId: task.taskId, currency: "USD", micros: 1_230_000 } });
 const cap = vi.fn(async () => ({ limitUsd: 12, spentUsd: 1.23 }));
 const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, taskActions: { roundCap: cap } }) });
 const read = async (caller: DeployedCaller) => routes.route(get(`/v1/dev/tasks/${task.taskId}`), caller);
 for (const caller of [owner, admin]) {
  const answer = await read(caller);
  expect(answer?.statusCode).toBe(200);
  expect(JSON.parse(answer!.body)).toMatchObject({ task: { owner: { developerId: "task-owner" }, runEstimate, money: { spentMicros: { value: 1_230_000 }, estimatedMicros: { value: 1_230_000 }, stop: { taskMaximumMicros: { value: 12_000_000 } } } } });
 }
 for (const caller of [reader, coOwner]) {
  cap.mockClear();
  const query = vi.spyOn(world.store, "query");
  const answer = await read(caller);
  expect(answer?.statusCode).toBe(200);
  const body = JSON.parse(answer!.body) as { task: { money?: unknown } };
  expect(body.task.money).toBeUndefined();
  const walk = (value: unknown): number[] => typeof value === "number" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(walk) : [];
  for (const figure of [4.37, 10.19, 12.71, 1.23, 1_230_000, 12_000_000, ...REVIEW_MONEY]) expect(walk(body)).not.toContain(figure);
  expect(body.task).not.toHaveProperty("runEstimate");
  expect(body.task).not.toHaveProperty("spent");
  expect(query.mock.calls.filter(([input]) => input.pk === costPk)).toEqual([]);
  expect(cap).not.toHaveBeenCalled();
  query.mockRestore();
  expect(await routes.taskMoney(caller, task.taskId)).toBeUndefined();
 }
 expect((await read(foreign))?.statusCode).toBe(404);
 expect(await routes.taskMoney(foreign, task.taskId)).toBeUndefined();
});

const REVIEW_MONEY = [2.83, 17.43, 3.91, 0.87, 5.67, 9.73, 18.61, 1.81];
function fullMoneyReview() {
 const reviewer = { role: "critic", promptId: "design-review-critic", promptVersion: 1, promptDigest: "a".repeat(64), model: { provider: "anthropic", modelId: "claude-opus-5-5" }, sourceId: "src", sessionId: "review-1", modelKeyId: "key", packetDigest: "b".repeat(64), packet: [], filesRead: [], verified: true, inputProof: "digest_only", tokensIn: 100, tokensOut: 20, costUsd: 0.87, startedAt: "2026-11-19T00:00:00.000Z", endedAt: "2026-11-19T00:00:01.000Z" };
 return { decidedBy: "auto", reasons: [], status: "done", tier: "light", spentUsd: 2.83, capUsd: 17.43, estimateUsd: 3.91,
  rounds: [{ round: 1, designDigest: "c".repeat(64), reviewers: [reviewer], findings: [], resolutions: [] }],
  approvals: [{ kind: "spend", by: { actorId: "owner" }, at: "2026-11-19T00:00:00.000Z", approvedUsd: 5.67 }, { kind: "raise_cap", by: { actorId: "owner" }, at: "2026-11-19T00:00:00.000Z", fromUsd: 9.73, capUsd: 18.61 }],
  earlierReviews: [{ sentBackBy: { actorId: "owner" }, sentBackAt: "2026-11-19T00:00:00.000Z", spentUsd: 1.81, rounds: [{ round: 1, designDigest: "c".repeat(64), reviewers: [{ role: reviewer.role, model: reviewer.model, sessionId: reviewer.sessionId, modelKeyId: reviewer.modelKeyId, packetDigest: reviewer.packetDigest, verified: true, tokensIn: 100, tokensOut: 20, costUsd: 0.87 }], findings: [] }] }] };
}

it("hosted session read and list keep FULL task figures private even when a reader or co-owner owns the session", async () => {
 const { world, app, companyOf, remember } = await world2();
 const owner = remember(FAKE_COMPANY, "member", "stored-owner");
 const reader = remember(FAKE_COMPANY, "member", "reader");
 const coOwner = remember(FAKE_COMPANY, "member", "co-owner");
 const admin = remember(FAKE_COMPANY, "admin", "admin");
 const foreign = remember(OTHER, "admin", "foreign");
 const runtime = await app.runtimeFor(FAKE_COMPANY);
 const { task } = await runtime.flow.start({ principal: owner.principal, origin: "app", client: "test" }, { requestId: randomUUID(), project: "payments", instructions: "Full task", workflow: true, workflowPath: "FULL" });
 const { agentSessionKey, mySessionsKey } = await import("@agentx/contracts");
 const { taskSessionHeader, taskSessionId } = await import("../../packages/broker/src/core/sessions/create.js");
 const sessionId = taskSessionId(task.taskId);
 const { record: session } = taskSessionHeader({ orgId: FAKE_COMPANY, sessionId, taskId: task.taskId, project: task.project, title: task.title, owner: owner.principal, agent: { agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "Planner", version: 1 }, origin: "app", payer: { kind: "project", project: "payments" }, now: task.createdAt });
 expect(session).toBeDefined();
 const runEstimate = { lowUsd: 4.37, highUsd: 10.19, runLimitUsd: 12.71, stopAtUsd: 12.71, basis: "default", samples: 0 };
 const stored = await world.store.get(taskKey(task.taskId));
 await world.store.put({ item: { ...stored, runEstimate, workflow: { ...stored?.["workflow"] as Record<string, unknown>, designReview: fullMoneyReview() } } as never });
 await world.store.put({ item: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, people: [{ developerId: developerIdOf(coOwner.principal), role: "owner" }, { developerId: developerIdOf(reader.principal), role: "viewer" }] } });
 const members = { companyRole: async (person: { principal?: DeployedCaller["principal"] | undefined }) => person.principal === undefined ? undefined : (await companyOf({ principal: person.principal }))?.role, projectGrant: (person: { principal?: DeployedCaller["principal"] | undefined }) => person.principal?.personId === "reader" ? "viewer" as const : "contributor" as const };
 const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, members }) });
 const walk = (value: unknown): number[] => typeof value === "number" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(walk) : [];
 for (const caller of [owner, admin, reader, coOwner]) {
  // Deliberately differ session owner from stored task owner. A session owner is not a financial owner.
  const changed = { ...session, owner: { developerId: developerIdOf(caller.principal), name: caller.principal.displayName }, summary: { ...session.summary, costUsd: 1.23, runLimitUsd: 12.71, stopAtUsd: 12.71 } };
  // A stored copy, as the table would hold it (no undefined fields).
  await world.store.put({ item: JSON.parse(JSON.stringify({ ...changed, ...agentSessionKey(FAKE_COMPANY, sessionId, "META") })) as Parameters<typeof world.store.put>[0]["item"] });
  await world.store.put({ item: { ...mySessionsKey(FAKE_COMPANY, developerIdOf(caller.principal), changed.createdAt, changed.sessionId), sessionId: changed.sessionId } });
  for (const path of [`/v1/app/sessions/${sessionId}`, "/v1/app/sessions"]) {
   const answer = await routes.route(get(path), caller);
   expect(answer?.statusCode).toBe(200);
   const body: unknown = JSON.parse(answer!.body);
   const { SessionResponseReaderSchema, SessionListReaderSchema } = await import("@agentx/contracts");
   const parsed = path.endsWith(sessionId) ? SessionResponseReaderSchema.safeParse(body) : SessionListReaderSchema.safeParse(body);
   expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
   if (caller === owner || caller === admin) { expect(walk(body)).toContain(1.23); if (path.endsWith(sessionId)) expect(walk(body)).toContain(2.83); }
   else { for (const figure of [1.23, 12.71, 4.37, 10.19, ...REVIEW_MONEY]) expect(walk(body), path).not.toContain(figure); }
  }
 }
 expect((await routes.route(get(`/v1/app/sessions/${sessionId}`), foreign))?.statusCode).toBe(404);
});

it("inventories the four exact context worker routes without person authority", () => {
  expect(CORE_CONTEXT_WORKER_ROUTES.map(row => `${row.method} ${row.path}`)).toEqual([
    "GET /v1/internal/context-tools", "GET /v1/internal/design-review/packet", "POST /v1/internal/context-tools/call", "POST /v1/internal/mcp",
  ]);
  for (const row of CORE_CONTEXT_WORKER_ROUTES) {
    expect(coreContextWorkerRouteOf(row.method, row.path)).toEqual({ ...row, requires: "worker" });
    expect(coreContextWorkerRouteOf(row.method === "GET" ? "POST" : "GET", row.path)).toBeUndefined();
    expect(coreContextWorkerRouteOf(row.method, `${row.path}/extra`)).toBeUndefined();
    expect(contextAppRouteOf(row.method, row.path)).toBeUndefined();
    expect(contextDevRouteOf(row.method, row.path)).toBeUndefined();
  }
});


it("registers close preview reads at both deployed boundaries", () => {
  expect(contextDevRouteOf("GET", "/v1/dev/tasks/t1/close")?.requires).toBe("tasks:read");
  expect(contextAppRouteOf("GET", "/v1/app/sessions/s1/close")?.requires).toBe("tasks:read");
});

it("keeps guarded close unavailable without the hosted retention provider, with no effects", async () => {
  const { world, app, companyOf, remember } = await world2();
  const caller = remember(FAKE_COMPANY);
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const { task } = await runtime.flow.start({ principal: caller.principal, origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Close safely" });
  const { createTaskSessionItems, taskSessionId } = await import("../../packages/broker/src/core/sessions/create.js");
  const sessionId = taskSessionId(task.taskId);
  await world.store.transact(createTaskSessionItems({ orgId: FAKE_COMPANY, sessionId, taskId: task.taskId, project: task.project, agent: { agentId: "rovara-code", name: "Code", version: 1 }, title: task.title, owner: caller.principal, origin: "app", payer: { kind: "member", developerId: developerIdOf(caller.principal) }, now: task.createdAt }));
  const members = { companyRole: async () => "owner" as const, projectGrant: () => "contributor" as const };
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, members }) });
  const path = `/v1/app/sessions/${sessionId}`;
  expect(runtime.flow.deps.closeInspection).toBeUndefined();
  const snapshot = async () => (await (world.store as MemoryDocumentStore).scanPage({ limit: 1000 })).items;
  const before = await snapshot();
  const transact = vi.spyOn(world.store, "transact"), update = vi.spyOn(world.store, "update"), put = vi.spyOn(world.store, "put");
  const close = vi.spyOn(runtime.flow, "close"), relay = vi.spyOn(runtime.flow.deps.outbox, "relay"), terminate = vi.spyOn(runtime.flow.deps.machines, "terminate");
  try {
    const read = await routes.route(get(path), caller);
    expect(read?.statusCode).toBe(200);
    const offered = (JSON.parse(read!.body) as { session: { you: { actions: string[] } } }).session.you.actions;
    expect(offered).toContain("close");
    for (const action of ["discard", "discard_unpublished", "guarded_close"]) expect(offered).not.toContain(action);
    for (const action of ["close", "discard"]) {
      const preview = await routes.route(get(`${path}/close?action=${action}`), caller);
      expect(preview?.statusCode).toBe(200);
      expect(JSON.parse(preview!.body)).toEqual({ preview: null, unavailable: "inspection_required" });
    }
    for (const fields of [
      { expectedPreviewDigest: "a".repeat(64) }, { expectedPreviewDigest: null },
      { discard_unpublished: true }, { discard_unpublished: false }, { discardUnpublished: true },
      { expectedPreviewDigest: "a".repeat(64), discard_unpublished: true },
      { expectedPreviewDigest: "a".repeat(64), discardUnpublished: true },
    ]) {
      const refused = await routes.route(post(`${path}/close`, { requestId: randomUUID(), ...fields }), caller);
      expect(refused?.statusCode).toBe(503);
      const error = (JSON.parse(refused!.body) as { error: { code: string; message: string } }).error;
      expect(error.code).toBe("RUNTIME_UNAVAILABLE");
      expect(error.message).toContain("not available yet");
    }
    expect(await snapshot()).toEqual(before);
    for (const effect of [transact, update, put, close, relay, terminate]) expect(effect).not.toHaveBeenCalled();
    // The unchanged requestId-only close remains live on this same hosted route.
    expect((await routes.route(post(`${path}/close`, { requestId: randomUUID() }), caller))?.statusCode).toBe(200);
    expect(close).not.toHaveBeenCalled(); // Session control uses the core host directly.
    expect(await world.store.get(taskKey(task.taskId))).toHaveProperty("closedAt");
  } finally {
    for (const effect of [transact, update, put, close, relay, terminate]) effect.mockRestore();
  }
});
it("mounts share, manual open-PR and on-demand review with their existing developer wires", async () => {
  const { world, companyOf, remember } = await world2();
  const access = { ...createOwnerTaskAccess(), ownerActing: async (_principal: unknown, task: { ownerKey: string }) => ({ actorId: task.ownerKey }) };
  const app = createCoreHostApp({ modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }) });
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, taskActions: { roundCap: async () => undefined } }) });
  const owner = remember(FAKE_COMPANY);
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const { task } = await runtime.flow.start({ principal: owner.principal, origin: "app", client: "test" }, { requestId: randomUUID(), project: "payments", instructions: "Add retry", workflow: true, workflowPath: "QUICK" });
  for (const action of ["share", "pull-requests", "workflow/review"]) {
    expect(contextDevRouteOf("POST", `/v1/dev/tasks/${task.taskId}/${action}`)).toBeDefined();
    const response = await routes.route(post(`/v1/dev/tasks/${task.taskId}/${action}`, {}), owner);
    expect(response?.statusCode, action).toBe(400);
    expect(JSON.parse(response!.body)).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    const foreign = await routes.route(post(`/v1/dev/tasks/${task.taskId}/${action}`, {}), remember(OTHER));
    expect(foreign?.statusCode).toBe(404);
    const scripted = await routes.route(post(`/v1/dev/tasks/${task.taskId}/${action}`, {}), { ...owner, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
    expect(scripted?.statusCode).toBe(404);
  }
});


it("routes manual open-PR to its owner and opens nothing until exact SUCCEEDED build evidence", async () => {
  const { world, companyOf, remember } = await world2();
  const access = { ...createOwnerTaskAccess(), ownerActing: async (_principal: unknown, task: { ownerKey: string }) => ({ actorId: task.ownerKey }) };
  const app = createCoreHostApp({ modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }) });
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, taskActions: { roundCap: async () => undefined } }) });
  const owner = remember(FAKE_COMPANY);
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const deps = runtime.flow.deps;
  const projects = deps.projects;
  deps.projects = { ...projects, revision: async (name, revision) => {
    const found = await projects.revision(name, revision);
    return found === undefined ? undefined : { ...found, definition: { ...found.definition, repositories: found.definition.repositories.map(repo => ({ ...repo, host: { kind: "fake" }, codeBuildGates: [{ name: "unit", projectName: "unit-project", timeoutMinutes: 10 }] })) } };
  } };
  const { task } = await runtime.flow.start({ principal: owner.principal, origin: "app", client: "test" }, { requestId: randomUUID(), project: "payments", instructions: "Add retry" });
  const location = await workspaceKeys(deps, task.workspaceId);
  await world.store.update({ key: location.workspaceKey, ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
  const request = { requestId: randomUUID(), title: "Add retry", draft: true };
  const response = await routes.route(post(`/v1/dev/tasks/${task.taskId}/pull-requests`, request), owner);
  expect(response?.statusCode).toBe(200);
  const [operation] = (await workspaceOperations(deps, task.workspaceId)).filter(entry => entry.kind === "publish");
  expect(operation).toMatchObject({ requestId: request.requestId, dispatch: { extraActions: ["pull-request", "codebuild"] }, publication: { codeBuildGates: [{ name: "unit" }] } });
  expect(JSON.parse(response!.body)).toMatchObject({ operationId: operation!.id });
  const model = new FakeHostModel({ url: operation!.publication!.repositoryUrl, id: "42", fullName: "example/demo" });
  const commit = model.commit(operation!.publication!.headBranch, { "retry.ts": "retry" });
  const result: CodeBuildCheckResult = { gate: "unit", projectName: "unit-project", buildId: "unit-project:123", requestedSourceVersion: commit, resolvedSourceVersion: commit, status: "SUCCEEDED" };
  const registry = createAdapterRegistry();
  registry.register("code-host", "fake", new FakeCodeHost(model), { isDefault: true });
  registry.register("check-runner", "codebuild", { kind: "codebuild", create: context => codeBuildCheckRunner({ ...context, gateway: { start: async () => result, status: async () => result } }) });
  deps.codeHosts = registry;
  const callback = { repository: "demo", repositoryUrl: operation!.publication!.repositoryUrl, headBranch: operation!.publication!.headBranch, baseBranch: "main", title: request.title, body: "", commit };
  await expect(openPullRequest(deps, operation!, callback)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  expect(model.changeRequests).toHaveLength(0);
  await publicationGateCallback(deps, operation!, { action: "start", gate: "unit", projectName: "unit-project", repository: "demo", commit });
  const key = { pk: location.workspaceKey.pk, sk: `CODEBUILD#${operation!.id}#unit` };
  for (const status of ["FAILED", "IN_PROGRESS", "RUNNING", "UNKNOWN", "succeeded", ""]) {
    await world.store.update({ key, ops: [change.set("evidence.status", status)] });
    await expect(openPullRequest(deps, operation!, callback), status).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(model.changeRequests).toHaveLength(0);
  }
  await world.store.update({ key, ops: [change.set("evidence.status", "SUCCEEDED")] });
  expect(await openPullRequest(deps, operation!, callback)).toMatchObject({ number: 1, draft: true });
  expect(model.changeRequests).toHaveLength(1);
});

// The retained plan-comment POST must stay admitted by the production scope registry.
it("core plan comments use the existing developer tasks:act scope", async () => {
  const { devRouteOf } = await import("../../packages/broker/src/aws/dev-route-scopes.js");
  const path = "/v1/dev/tasks/11111111-1111-4111-8111-111111111111/comments";
  expect(devRouteOf("POST", path)).toMatchObject({ requires: "tasks:act" });
  expect(devRouteOf("GET", path)).toMatchObject({ requires: "tasks:read" });
  expect(devRouteOf("DELETE", path)).toBeUndefined();
});
