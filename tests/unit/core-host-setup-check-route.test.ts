// L4-P1: the hosted "Re-check setup" route (the Thursday fallback): `GET` and `POST /v1/app/projects/{project}/setup-check`. A PERSON starts the project's plain setup check (a company owner or admin, or the project's
// administrator, read live); a reader reads where it stands and may not start one; anyone else, another company and a malformed project read one uniform 404. The audit record comes first, a repeat of the request
// id answers the first check, nothing else than { requestId } is taken, and no model, no key and no flag is involved. Each guard has a test that fails if it is removed (mutants in the PR body).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type AuditEvent, type AuditSink, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { setupStateOf } from "../../packages/broker/src/core/setup-agent/check.js";
import { projectMetaKey } from "@agentx/contracts";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import {
  SETUP_RUN_AUDIT_UNAVAILABLE, SETUP_RUN_NOT_ALLOWED, SETUP_RUN_PROJECT_NOT_FOUND, SETUP_RUN_UNAVAILABLE, SETUP_RUN_UNREADABLE, type HostedSetupRunWiring, type SetupRunStanding,
} from "../../packages/broker/src/core-host/setup-run-routes.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const project = (name: string): ProjectDefinition => ({
  name, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});

function appOver(world: FakeWorld, env: NodeJS.ProcessEnv): CoreHostApp {
  return createCoreHostApp({
    env, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}

async function register(world: FakeWorld, companyId: string, name: string): Promise<void> {
  const definition = project(name);
  await world.store.put({ item: { ...projectRevisionKey(companyId, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
}

const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });

interface Person { caller: DeployedCaller; membership: CompanyMembership; grant?: "developer" | "administrator" }

async function setupWorld(options: { env?: NodeJS.ProcessEnv; gateway?: boolean; standing?: HostedSetupRunWiring["standing"]; audit?: (sink: AuditSink) => AuditSink } = {}) {
  const world = createFakeWorld();
  await register(world, FAKE_COMPANY, "payments");
  await register(world, OTHER, "payments");
  await register(world, OTHER, "ledger");
  const app = appOver(world, options.env ?? { ROVARA_CORE_ENGINE: "on" });
  const people = new Map<string, Person>();
  const person = (personId: string, companyId: string, role: CompanyMembership["role"], grant?: Person["grant"]): DeployedCaller => {
    const caller: DeployedCaller = { principal: { companyId, personId, displayName: `Name ${personId}`, roles: [role], provider: HOSTED_IDENTITY_PROVIDER }, client: "cloud" };
    people.set(personId, { caller, membership: { companyId, role }, ...(grant === undefined ? {} : { grant }) });
    return caller;
  };
  // The rule as the deployment wires it (PR 16's lifecycleAccess over live membership and the grant), over this test's people; the root's own wiring is tested in core-engine-root.test.ts.
  const standing = vi.fn(options.standing ?? (async (personId: string, companyId: string): Promise<SetupRunStanding> => {
    const found = people.get(personId);
    if (found === undefined || found.membership.companyId !== companyId) return { access: "none" };
    if (found.membership.role === "owner") return { access: "manage", basis: "company-owner" };
    if (found.membership.role === "admin") return { access: "manage", basis: "company-admin" };
    if (found.grant === "administrator") return { access: "manage", basis: "project-admin" };
    return found.grant === "developer" ? { access: "view" } : { access: "none" };
  }));
  const setupRun: HostedSetupRunWiring = { standing, modelAccessConfigured: () => options.gateway ?? true, displayName: async (id) => people.get(id)?.caller.principal.displayName };
  const wiring: CoreDevWiring = { origin: () => "https://api.example", setupRun, ...(options.audit === undefined ? {} : { auditFor: (_caller, sink) => options.audit!(sink) }) };
  const routes = createCoreDevRoutes({ app, companyOf: async (caller) => people.get(caller.principal.personId)?.membership, wiring: () => wiring });
  const call = async (request: { method: string; path: string; headers: Record<string, string>; body: string }, caller: DeployedCaller) => {
    const answer = await routes.route(request, caller);
    if (answer === undefined) throw new Error("not served");
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, unknown>, raw: answer.body };
  };
  return { world, app, person, standing, call, routes, wiring };
}



const CHECK = "/v1/app/projects/payments/setup-check";
const checkEvents = (world: FakeWorld): AuditEvent[] => world.audit.filter((event) => event.action === "setup_check.requested");
const markOf = async (world: FakeWorld, companyId: string, name = "payments") => (await world.store.get(projectMetaKey(companyId, name)))?.["setupCheck"] as { workspaceId: string; startedBy: string } | undefined;

describe("hosted Re-check setup: who may do what", () => {
  it("lets a live company owner, a company admin and the project's administrator start the check; the audit names the person and why, and the person is the starter", async () => {
    for (const [role, grant, basis] of [["owner", undefined, "company-owner"], ["admin", undefined, "company-admin"], ["member", "administrator", "project-admin"]] as const) {
      const { world, person, call } = await setupWorld();
      const caller = person(`p-${role}`, FAKE_COMPANY, role, grant);
      const requestId = randomUUID();
      const started = await call(post(CHECK, { requestId }), caller);
      expect(started.status, role).toBe(202);
      expect(Object.keys(started.body)).toEqual(["workspaceId"]);
      expect(await markOf(world, FAKE_COMPANY)).toMatchObject({ workspaceId: started.body["workspaceId"], startedBy: `p-${role}` });
      expect(checkEvents(world).map((event) => [event.actor, event.details?.["basis"], event.subject])).toEqual([[{ type: "person", id: `p-${role}` }, basis, { type: "project", id: "payments" }]]);
      const state = await call(get(CHECK), caller);
      expect(state.status).toBe(200);
      expect(state.body).toMatchObject({ status: "checking" });
    }
  });

  it("answers a repeat of the request id with the first check (200), and starts no second one", async () => {
    const { world, person, call } = await setupWorld();
    const caller = person("p-owner", FAKE_COMPANY, "owner");
    const requestId = randomUUID();
    const first = await call(post(CHECK, { requestId }), caller);
    const again = await call(post(CHECK, { requestId }), caller);
    expect([first.status, again.status]).toEqual([202, 200]);
    expect(again.body["workspaceId"]).toBe(first.body["workspaceId"]);
    expect(new Set(checkEvents(world).map((event) => event.eventId)).size).toBe(1);
    // A second request while the first runs is refused as busy.
    const busy = await call(post(CHECK, { requestId: randomUUID() }), caller);
    expect(busy.status).toBe(409);
  });

  it("lets a project user read where the check stands but not start one (403 in fixed words, nothing written)", async () => {
    const { world, person, call } = await setupWorld();
    const reader = person("p-dev", FAKE_COMPANY, "member", "developer");
    const refused = await call(post(CHECK, { requestId: randomUUID() }), reader);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_RUN_NOT_ALLOWED } });
    expect(await markOf(world, FAKE_COMPANY)).toBeUndefined();
    expect(checkEvents(world)).toEqual([]);
    expect((await call(get(CHECK), reader)).status).toBe(200);
  });

  it("is one uniform 404 for a person with no role on the project, another company's person, and a malformed project, on read and on start", async () => {
    const { world, person, call } = await setupWorld();
    const none = person("p-none", FAKE_COMPANY, "member");
    const foreign = person("p-foreign", OTHER, "member");
    for (const caller of [none, foreign]) {
      for (const request of [get("/v1/app/projects/ledger/setup-check"), post("/v1/app/projects/ledger/setup-check", { requestId: randomUUID() })]) {
        const answer = await call(request, caller);
        expect({ status: answer.status, body: answer.body }).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: SETUP_RUN_PROJECT_NOT_FOUND } } });
      }
    }
    expect((await call(post(CHECK, { requestId: randomUUID() }), none)).status).toBe(404);
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    for (const raw of ["-bad", "a%23b", "x".repeat(101), "%E0%A4%A"]) expect((await call(get(`/v1/app/projects/${raw}/setup-check`), admin)).status, raw).toBe(404);
    // A project that exists only in another company is not found, and nothing of FAKE_COMPANY's changed.
    expect((await call(post("/v1/app/projects/ledger/setup-check", { requestId: randomUUID() }), admin)).status).toBe(404);
    expect(await markOf(world, FAKE_COMPANY)).toBeUndefined();
    expect(checkEvents(world)).toEqual([]);
  });

  it("two companies with one project name: each person's check is their own company's", async () => {
    const { world, person, call } = await setupWorld();
    const a = person("p-a", FAKE_COMPANY, "owner");
    const b = person("p-b", OTHER, "owner");
    const first = await call(post(CHECK, { requestId: randomUUID() }), a);
    expect(first.status).toBe(202);
    expect(await markOf(world, OTHER)).toBeUndefined();
    const second = await call(post(CHECK, { requestId: randomUUID() }), b);
    expect(second.status).toBe(202);
    expect((await markOf(world, OTHER))?.startedBy).toBe("p-b");
    expect((await markOf(world, FAKE_COMPANY))?.startedBy).toBe("p-a");
    expect((await markOf(world, OTHER))?.workspaceId).not.toBe((await markOf(world, FAKE_COMPANY))?.workspaceId);
    // Each company reads only its own state.
    expect((await call(get(CHECK), a)).body).toMatchObject({ status: "checking" });
  });

  it("takes a request id and nothing else", async () => {
    const { world, person, call } = await setupWorld();
    const caller = person("p-owner", FAKE_COMPANY, "owner");
    for (const body of [{}, { requestId: "nope" }, { requestId: randomUUID(), limits: { wallClockMin: 999 } }, { requestId: randomUUID(), payer: "x" }, { requestId: randomUUID(), kind: "repair_draft" }]) {
      expect((await call(post(CHECK, body), caller)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call({ method: "POST", path: CHECK, headers: {}, body: "{not json" }, caller)).status).toBe(400);
    expect(await markOf(world, FAKE_COMPANY)).toBeUndefined();
    expect(checkEvents(world)).toEqual([]);
  });

  it("writes the audit record FIRST: with the ledger down nothing is started", async () => {
    const failing = await setupWorld({ audit: (sink) => ({ stage: (event) => sink.stage(event), record: async () => { throw new Error("audit down"); } }) });
    const caller = failing.person("p-owner", FAKE_COMPANY, "owner");
    const refused = await failing.call(post(CHECK, { requestId: randomUUID() }), caller);
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ error: { code: "AUDIT_UNAVAILABLE", message: SETUP_RUN_AUDIT_UNAVAILABLE } });
    expect(await markOf(failing.world, FAKE_COMPANY)).toBeUndefined();
  });

  it("refuses a start in fixed words, writing nothing, when the company's new tasks are not on the core, but needs no model gateway (the check uses no model)", async () => {
    const off = await setupWorld();
    vi.spyOn(off.app, "engineForNewTask").mockReturnValue("workflow");
    const caller = off.person("p-owner", FAKE_COMPANY, "owner");
    const refused = await off.call(post(CHECK, { requestId: randomUUID() }), caller);
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: SETUP_RUN_UNAVAILABLE } });
    expect(await markOf(off.world, FAKE_COMPANY)).toBeUndefined();
    const noGateway = await setupWorld({ gateway: false });
    const owner = noGateway.person("p-owner", FAKE_COMPANY, "owner");
    expect((await noGateway.call(post(CHECK, { requestId: randomUUID() }), owner)).status).toBe(202);
  });

  it("reads the standing live and again as nothing when it cannot be read", async () => {
    const throwing = await setupWorld({ standing: async () => { throw new Error("table down secret-detail"); } });
    const caller = throwing.person("p-owner", FAKE_COMPANY, "owner");
    const answer = await throwing.call(post(CHECK, { requestId: randomUUID() }), caller);
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: SETUP_RUN_UNREADABLE } });
    expect(answer.raw).not.toContain("secret-detail");
    for (const odd of [{ access: "manage" }, { access: "manage", basis: "superuser" }, null, undefined] as unknown[]) {
      const weird = await setupWorld({ standing: async () => odd as SetupRunStanding });
      const who = weird.person("p-owner", FAKE_COMPANY, "owner");
      expect((await weird.call(post(CHECK, { requestId: randomUUID() }), who)).status, JSON.stringify(odd)).toBe(404);
    }
  });

  it("other methods and paths are not this route's, and the state read matches the core's own", async () => {
    const { world, person, call, app } = await setupWorld();
    const caller = person("p-owner", FAKE_COMPANY, "owner");
    expect(await call(post(CHECK, { requestId: randomUUID() }), caller)).toMatchObject({ status: 202 });
    const runtime = await app.runtimeFor(FAKE_COMPANY);
    const latest = (await runtime.flow.deps.projects.latest("payments"))!;
    expect((await call(get(CHECK), caller)).body).toEqual(JSON.parse(JSON.stringify(await setupStateOf(runtime.flow.deps, "payments", latest.definition))));
    void world;
  });
});
