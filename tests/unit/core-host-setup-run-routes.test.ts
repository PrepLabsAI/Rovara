// Guided onboarding L2-3 (DEC 254o c, DEC 254n 3): the hosted setup run on the deployed API. Who may start, re-run, stop, confirm and discard (a live company owner or admin, or the
// project's administrator), who may only read (a project user), and who sees nothing (anyone else, another company, a missing or malformed project: one uniform 404); one run per
// project; a re-run only proposes; an audit record naming the person for every act; a start refused before anything is written when the company or the install cannot run it.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type AuditEvent, type AuditSink, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { SETUP_AGENT_BUSY } from "../../packages/broker/src/core/setup-agent/agent.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
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
const RUN = "/v1/app/projects/payments/setup-agent";

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

const pointerOf = (world: FakeWorld, companyId: string, name = "payments") => world.store.get(setupAgentKey(companyId, name));
const setupEvents = (world: FakeWorld): AuditEvent[] => world.audit.filter((event) => event.action.startsWith("setup_run."));

describe("hosted setup run: who may do what", () => {
  it("lets a live company owner, a company admin and the project's administrator start a run; the run is a setup task of the caller's company and the audit names the person and why", async () => {
    for (const [role, grant, basis] of [["owner", undefined, "company-owner"], ["admin", undefined, "company-admin"], ["member", "administrator", "project-admin"]] as const) {
      const { world, person, call } = await setupWorld();
      const caller = person(`p-${role}`, FAKE_COMPANY, role, grant);
      const requestId = randomUUID();
      const started = await call(post(RUN, { requestId }), caller);
      expect(started.status, role).toBe(202);
      expect(started.body).toMatchObject({ status: "running", canManage: true });
      const pointer = await pointerOf(world, FAKE_COMPANY);
      expect(pointer).toMatchObject({ orgId: FAKE_COMPANY, project: "payments", requestId, taskId: started.body["taskId"] });
      const task = await world.store.get(taskKey(started.body["taskId"] as string));
      expect(task).toMatchObject({ companyId: FAKE_COMPANY, purpose: "setup_agent", developerId: `p-${role}`, project: "payments" });
      const events = setupEvents(world);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "setup_run.started", companyId: FAKE_COMPANY, actor: { type: "person", id: `p-${role}` }, subject: { type: "project", id: "payments" }, details: { project: "payments", basis, requestId, taskId: started.body["taskId"] } });
      // The other company's project of the same name is untouched.
      expect(await pointerOf(world, OTHER)).toBeUndefined();
    }
  });

  it("lets a project user read the run and its journal, and refuses every change in fixed words, writing nothing", async () => {
    const { world, person, call } = await setupWorld();
    const reader = person("p-dev", FAKE_COMPANY, "member", "developer");
    const read = await call(get(RUN), reader);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: "none", canManage: false });
    expect((await call(get(`${RUN}/journal`), reader)).body).toEqual({ status: "none", entries: [], hostAsks: [] });
    for (const [path, body] of [[RUN, { requestId: randomUUID() }], [`${RUN}/stop`, { requestId: randomUUID() }], [`${RUN}/confirm`, { requestId: randomUUID(), expectedRevision: 1 }], [`${RUN}/discard`, {}]] as const) {
      const refused = await call(post(path, body), reader);
      expect(refused.status, path).toBe(403);
      expect(refused.body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_RUN_NOT_ALLOWED } });
    }
    expect(await pointerOf(world, FAKE_COMPANY)).toBeUndefined();
    expect(setupEvents(world)).toEqual([]);
  });

  it("answers a member with no grant, another company's person, another company's project, a missing project and a malformed name with one identical 404", async () => {
    const { world, person, call } = await setupWorld();
    const member = person("p-member", FAKE_COMPANY, "member");
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const theirs = person("p-other", OTHER, "owner");
    const expected = { status: 404, body: { error: { code: "NOT_FOUND", message: SETUP_RUN_PROJECT_NOT_FOUND } } };
    const cases: Array<[DeployedCaller, string]> = [
      [member, RUN], [member, `${RUN}/journal`],
      // A project only the other company has: even a company admin here reads it as missing (and the other company's run is never reached).
      [admin, "/v1/app/projects/ledger/setup-agent"], [admin, "/v1/app/projects/missing/setup-agent"], [admin, "/v1/app/projects/-bad/setup-agent"], [admin, "/v1/app/projects/%E0%A4%A/setup-agent"],
    ];
    for (const [caller, path] of cases) {
      const answer = await call(get(path), caller);
      expect({ status: answer.status, body: answer.body }, path).toEqual(expected);
      if (path.endsWith("/journal")) continue;
      const started = await call(post(path, { requestId: randomUUID() }), caller);
      expect({ status: started.status, body: started.body }, path).toEqual(expected);
    }
    // The other company's owner sees its own project of the same name, never this company's run.
    await call(post(RUN, { requestId: randomUUID() }), admin);
    const own = await call(get(RUN), theirs);
    expect(own.body).toMatchObject({ status: "none" });
    expect(own.raw).not.toContain(FAKE_COMPANY);
    expect(await pointerOf(world, OTHER, "ledger")).toBeUndefined();
  });

  it("refuses in fixed words when the person's standing cannot be read, and reads an answer it does not know as no standing", async () => {
    const throwing = await setupWorld({ standing: async () => { throw new Error("table down secret-detail"); } });
    const caller = throwing.person("p-owner", FAKE_COMPANY, "owner");
    const answer = await throwing.call(post(RUN, { requestId: randomUUID() }), caller);
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: SETUP_RUN_UNREADABLE } });
    expect(answer.raw).not.toContain("secret-detail");
    for (const odd of [{ access: "manage" }, { access: "manage", basis: "superuser" }, { access: "admin" }, null, undefined] as unknown[]) {
      const weird = await setupWorld({ standing: async () => odd as SetupRunStanding });
      const who = weird.person("p-owner", FAKE_COMPANY, "owner");
      expect((await weird.call(post(RUN, { requestId: randomUUID() }), who)).status, JSON.stringify(odd)).toBe(404);
      expect(await pointerOf(weird.world, FAKE_COMPANY)).toBeUndefined();
    }
  });

  it("re-reads the standing inside the start: a person who lost it between the route and the start writes nothing", async () => {
    let calls = 0;
    const { world, person, call } = await setupWorld({ standing: async () => (calls++ === 0 ? { access: "manage", basis: "company-admin" } : { access: "view" }) });
    const caller = person("p-admin", FAKE_COMPANY, "admin");
    const answer = await call(post(RUN, { requestId: randomUUID() }), caller);
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_RUN_NOT_ALLOWED } });
    expect(await pointerOf(world, FAKE_COMPANY)).toBeUndefined();
    expect(setupEvents(world)).toEqual([]);
  });

  it("never serves a script token, and says 'not on the core yet' when the deployment has not wired the setup run", async () => {
    const { person, call, app } = await setupWorld();
    const caller = person("p-owner", FAKE_COMPANY, "owner");
    const token = await call(post(RUN, { requestId: randomUUID() }), { ...caller, scriptToken: { tokenId: "t1" } });
    expect(token.body).toEqual({ error: { code: "FORBIDDEN", message: NOT_FOR_SCRIPT_TOKENS } });
    const bare = createCoreDevRoutes({ app, companyOf: async () => ({ companyId: FAKE_COMPANY, role: "owner" }), wiring: () => ({ origin: () => "https://api.example" }) });
    const answer = await bare.route(get(RUN), caller);
    expect(answer?.statusCode).toBe(404);
    expect(JSON.parse(answer!.body)).toEqual({ error: { code: "NOT_FOUND", message: NOT_ON_THE_CORE_YET } });
  });
});

describe("hosted setup run: starting, re-running and stopping", () => {
  it("runs one at a time: a second start is refused while one runs, and a repeat of the same request id answers the first run", async () => {
    const { world, person, call } = await setupWorld();
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    const requestId = randomUUID();
    const first = await call(post(RUN, { requestId }), admin);
    expect(first.status).toBe(202);
    const busy = await call(post(RUN, { requestId: randomUUID() }), owner);
    expect(busy.status).toBe(409);
    expect(busy.body).toEqual({ error: { code: "WORKSPACE_BUSY", message: SETUP_AGENT_BUSY } });
    const again = await call(post(RUN, { requestId }), admin);
    expect(again.status).toBe(200);
    expect(again.body["taskId"]).toBe(first.body["taskId"]);
    expect((await pointerOf(world, FAKE_COMPANY))?.["taskId"]).toBe(first.body["taskId"]);
    expect(setupEvents(world).map((event) => event.action)).toEqual(["setup_run.started"]);
  });

  it("re-runs a project whose run ended: a new run, audited as a re-run, that changes none of the project's commands", async () => {
    const { world, person, call } = await setupWorld();
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const first = await call(post(RUN, { requestId: randomUUID() }), admin);
    const firstTask = first.body["taskId"] as string;
    await world.store.update({ key: taskKey(firstTask), ops: [{ op: "set", path: ["setupAgentResult"], value: { status: "failed", stop: "infrastructure", failure: "x" } }] } as never);
    expect((await call(get(RUN), admin)).body).toMatchObject({ status: "failed" });
    const before = await world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 1));
    const projectAdmin = person("p-padmin", FAKE_COMPANY, "member", "administrator");
    const rerun = await call(post(RUN, { requestId: randomUUID() }), projectAdmin);
    expect(rerun.status).toBe(202);
    expect(rerun.body["taskId"]).not.toBe(firstTask);
    expect((await pointerOf(world, FAKE_COMPANY))?.["taskId"]).toBe(rerun.body["taskId"]);
    expect(setupEvents(world).map((event) => [event.action, event.actor.id, event.details?.["basis"]])).toEqual([["setup_run.started", "p-admin", "company-admin"], ["setup_run.rerun_started", "p-padmin", "project-admin"]]);
    expect(await world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 1))).toEqual(before);
    expect(await world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2))).toBeUndefined();
  });

  it("refuses a start before writing anything when the company's new tasks are not on the core, or the install has no model gateway", async () => {
    for (const mode of ["no-gateway", "not-on-core"] as const) {
      const { world, person, call, app } = await setupWorld(mode === "no-gateway" ? { gateway: false } : {});
      if (mode === "not-on-core") vi.spyOn(app, "engineForNewTask").mockReturnValue("workflow" as never);
      const caller = person("p-owner", FAKE_COMPANY, "owner");
      const answer = await call(post(RUN, { requestId: randomUUID() }), caller);
      expect(answer.status, mode).toBe(503);
      expect(answer.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: SETUP_RUN_UNAVAILABLE } });
      expect(await pointerOf(world, FAKE_COMPANY)).toBeUndefined();
      expect(setupEvents(world)).toEqual([]);
      // Reading still works.
      expect((await call(get(RUN), caller)).status).toBe(200);
    }
  });

  it("takes a request id and nothing else: limits or a payer from the client are refused, writing nothing", async () => {
    const { world, person, call } = await setupWorld();
    const caller = person("p-owner", FAKE_COMPANY, "owner");
    for (const body of [{}, { requestId: "nope" }, { requestId: randomUUID(), limits: { wallClockMin: 999 } }, { requestId: randomUUID(), payer: "x" }]) {
      expect((await call(post(RUN, body), caller)).status, JSON.stringify(body)).toBe(400);
    }
    const bad = await call({ method: "POST", path: RUN, headers: {}, body: "{not json" }, caller);
    expect(bad.status).toBe(400);
    expect(await pointerOf(world, FAKE_COMPANY)).toBeUndefined();
  });

  it("stops a running run as the person who pressed Stop, audited first; with the audit unwritable nothing is stopped", async () => {
    const { world, person, call } = await setupWorld();
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const started = await call(post(RUN, { requestId: randomUUID() }), admin);
    const taskId = started.body["taskId"] as string;

    const failing = await setupWorld({ audit: (sink) => ({ stage: (event) => sink.stage(event), record: async () => { throw new Error("audit down"); } }) });
    const failingAdmin = failing.person("p-admin", FAKE_COMPANY, "admin");
    const theirRun = await failing.call(post(RUN, { requestId: randomUUID() }), failingAdmin);
    const refused = await failing.call(post(`${RUN}/stop`, { requestId: randomUUID() }), failingAdmin);
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ error: { code: "AUDIT_UNAVAILABLE", message: SETUP_RUN_AUDIT_UNAVAILABLE } });
    expect((await failing.world.store.get(taskKey(theirRun.body["taskId"] as string)))?.["setupAgentStop"]).toBeUndefined();

    expect((await call(get(RUN), admin)).body).toMatchObject({ status: "running" });
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    const stopId = randomUUID();
    const stopped = await call(post(`${RUN}/stop`, { requestId: stopId }), owner);
    expect(stopped.status).toBe(202);
    expect(stopped.body).toMatchObject({ status: "failed", canManage: true });
    expect((await world.store.get(taskKey(taskId)))?.["setupAgentStop"]).toMatchObject({ by: "p-owner" });
    expect(setupEvents(world).map((event) => [event.action, event.actor.id])).toEqual([["setup_run.started", "p-admin"], ["setup_run.stop_requested", "p-owner"]]);
    expect(setupEvents(world)[1]?.details).toMatchObject({ basis: "company-owner", requestId: stopId });
  });

  it("confirm with no finished run proposes nothing (fixed words) and discard with nothing waiting changes nothing; both are audited with the person", async () => {
    const { world, person, call } = await setupWorld();
    const admin = person("p-padmin", FAKE_COMPANY, "member", "administrator");
    const confirmed = await call(post(`${RUN}/confirm`, { requestId: randomUUID(), expectedRevision: 1 }), admin);
    expect(confirmed.status).toBe(400);
    expect(confirmed.body["error"]).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2))).toBeUndefined();
    const discarded = await call(post(`${RUN}/discard`, {}), admin);
    expect(discarded).toMatchObject({ status: 200, body: { discarded: false } });
    expect((await call(post(`${RUN}/discard`, { extra: 1 }), admin)).status).toBe(400);
    expect(setupEvents(world).map((event) => [event.action, event.actor.id, event.details?.["basis"]])).toEqual([["setup_run.confirm_requested", "p-padmin", "project-admin"], ["setup_run.discard_requested", "p-padmin", "project-admin"]]);
  });
});
