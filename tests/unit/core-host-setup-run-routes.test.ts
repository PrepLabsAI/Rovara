// Guided onboarding L2-3 (DEC 254o c, DEC 254n 3): the hosted setup run on the deployed API. Who may start, re-run and stop (a live company owner or admin, or the
// project's administrator), who may only read (a project user), and who sees nothing (anyone else, another company, a missing or malformed project: one uniform 404); one run per
// project; a re-run only proposes; an audit record naming the person for every act; a start refused before anything is written when the company or the install cannot run it.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { agentXError, orgProjectCatalogKey, projectRevisionKey, type AuditEvent, type AuditSink, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { appendSetupJournal } from "../../packages/broker/src/core/setup-agent/journal.js";
import { SETUP_AGENT_BUSY } from "../../packages/broker/src/core/setup-agent/agent.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import {
  SETUP_APPROVAL_UNAVAILABLE, SETUP_RUN_AUDIT_UNAVAILABLE, SETUP_RUN_NOT_ALLOWED, SETUP_RUN_PROJECT_NOT_FOUND, SETUP_RUN_UNAVAILABLE, SETUP_RUN_UNREADABLE, type HostedSetupRunWiring, type SetupRunStanding,
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

function appOver(world: FakeWorld, startModelCheck?: () => Promise<undefined>): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ ...(startModelCheck === undefined ? {} : { flowOptions: { startModelCheck } }), callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
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

async function setupWorld(options: { startModelCheck?: () => Promise<undefined>; env?: NodeJS.ProcessEnv; gateway?: boolean; standing?: HostedSetupRunWiring["standing"]; audit?: (sink: AuditSink) => AuditSink } = {}) {
  const world = createFakeWorld();
  await register(world, FAKE_COMPANY, "payments");
  await register(world, OTHER, "payments");
  await register(world, OTHER, "ledger");
  const app = appOver(world, options.startModelCheck);
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

  it("a re-run after an ended run starts from what that run found (DEC 254zzz431): its partial proposal and a journal summary on the new task, the first run and another project's run carry nothing", async () => {
    const { world, person, call } = await setupWorld();
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const first = await call(post(RUN, { requestId: randomUUID() }), admin);
    const firstTask = first.body["taskId"] as string;
    expect((await world.store.get(taskKey(firstTask)))?.["setupAgentCarryOver"]).toBeUndefined();
    const proposal = { version: 2, basedOnRevision: 1, setup: [{ id: "setup-demo", value: { repo: "demo", commands: ["npm ci"] }, from: [{ kind: "inferred", repo: "demo", note: "worked when run" }], confidence: "high", risk: "low" }], notes: "" };
    const now = new Date(world.clock.now).toISOString();
    await world.store.update({ key: taskKey(firstTask), ops: [
      { op: "set", path: ["setupAgentResult"], value: { status: "failed", stop: "time_used", failure: "x", proposal } },
      { op: "set", path: ["agentRunEnd"], value: { state: "FAILED", at: now } },
    ] } as never);
    await appendSetupJournal({ store: world.store, now: () => world.clock.now }, { orgId: FAKE_COMPANY, project: "payments", taskId: firstTask }, [
      { n: 1, source: "agent", command: "npm ci", exitCode: 0, durationMs: 900, timedOut: false, flagged: false, blockedHosts: [], tail: "", startedAt: now },
      { n: 2, source: "agent", command: "npm test", exitCode: 1, durationMs: 900, timedOut: false, flagged: false, blockedHosts: [], tail: "boom\nmissing module x\n", startedAt: now },
    ]);
    // The other company's own "payments" run, ended with its own journal, is never read for this company's re-run.
    const theirs = person("p-other", OTHER, "owner");
    const theirStart = await call(post(RUN, { requestId: randomUUID() }), theirs);
    const theirTask = theirStart.body["taskId"] as string;
    await world.store.update({ key: taskKey(theirTask), ops: [{ op: "set", path: ["setupAgentResult"], value: { status: "failed", stop: "time_used", failure: "x" } }, { op: "set", path: ["agentRunEnd"], value: { state: "FAILED", at: now } }] } as never);
    await appendSetupJournal({ store: world.store, now: () => world.clock.now }, { orgId: OTHER, project: "payments", taskId: theirTask }, [{ n: 1, source: "agent", command: "THEIR PRIVATE COMMAND", exitCode: 0, durationMs: 9, timedOut: false, flagged: false, blockedHosts: [], tail: "", startedAt: now }]);
    const rerun = await call(post(RUN, { requestId: randomUUID() }), admin);
    expect(rerun.status).toBe(202);
    const carried = (await world.store.get(taskKey(rerun.body["taskId"] as string)))?.["setupAgentCarryOver"] as { fromRun: string; endedAs: string; proposal: string; journal: { total: number; lines: string[] } };
    expect(carried).toMatchObject({ version: 1, fromRun: firstTask, endedAs: "time_used", journal: { total: 2, lines: ["#1 worked: npm ci", "#2 failed (exit 1): npm test | output ended: missing module x"] } });
    expect(JSON.parse(carried.proposal)).toEqual(proposal);
    expect(JSON.stringify(carried)).not.toContain("THEIR PRIVATE COMMAND");
    // The body of the request names nothing: a client cannot supply or change what is carried.
    const forged = await call(post(RUN, { requestId: randomUUID(), carryOver: { version: 1 } }), admin);
    expect(forged.status).toBe(400);
  });

  it("refuses a start before writing anything when the install has no model gateway", async () => {
    const { world, person, call } = await setupWorld({ gateway: false });
    const caller = person("p-owner", FAKE_COMPANY, "owner");
    const answer = await call(post(RUN, { requestId: randomUUID() }), caller);
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: SETUP_RUN_UNAVAILABLE } });
    expect(await pointerOf(world, FAKE_COMPANY)).toBeUndefined();
    expect(setupEvents(world)).toEqual([]);
    // Reading still works.
    expect((await call(get(RUN), caller)).status).toBe(200);
  });

  it("refuses an authorized setup run before any write when signed-price readiness fails", async () => {
    const { world, app, person, call } = await setupWorld({ startModelCheck: async () => { throw agentXError("RUNTIME_UNAVAILABLE", "signed-price gateway is not ready"); } });
    const caller = person("p-admin", FAKE_COMPANY, "admin");
    const flow = (await app.runtimeFor(FAKE_COMPANY)).flow;
    const writes = [vi.spyOn(world.store, "put"), vi.spyOn(world.store, "update"), vi.spyOn(world.store, "delete"), vi.spyOn(world.store, "transact"), vi.spyOn(flow.deps.audit, "record"), vi.spyOn(flow.deps.audit, "stage")];
    const answer = await call(post(RUN, { requestId: randomUUID() }), caller);
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: "signed-price gateway is not ready" } });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(await pointerOf(world, FAKE_COMPANY)).toBeUndefined();
    expect(world.spend).toEqual([]);
    expect(await (await world.queues.queue("task-dispatch")).receive()).toEqual([]);
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

  it("serves confirm and discard only with the hosted approval wired (L4-D; nothing could approve the candidate otherwise), and never the laptop page's command or eval confirm, writing nothing", async () => {
    const { world, person, routes, call } = await setupWorld();
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    for (const path of [`${RUN}/command`, `${RUN}/eval-confirm`]) {
      expect(await routes.route(post(path, { requestId: randomUUID(), expectedRevision: 1 }), admin), path).toBeUndefined();
    }
    for (const path of [`${RUN}/confirm`, `${RUN}/discard`]) {
      expect((await call(post(path, { requestId: randomUUID(), expectedRevision: 1 }), admin)).body, path).toEqual({ error: { code: "NOT_FOUND", message: SETUP_APPROVAL_UNAVAILABLE } });
    }
    expect(await world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2))).toBeUndefined();
    expect(setupEvents(world)).toEqual([]);
  });

  it("refuses the start in fixed words, writing nothing, when the standing cannot be read again inside the start", async () => {
    let calls = 0;
    const { world, person, call } = await setupWorld({ standing: async () => { if (calls++ === 0) return { access: "manage", basis: "company-owner" }; throw new Error("down detail"); } });
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    const answer = await call(post(RUN, { requestId: randomUUID() }), owner);
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: SETUP_RUN_UNREADABLE } });
    expect(answer.raw).not.toContain("down detail");
    expect(await pointerOf(world, FAKE_COMPANY)).toBeUndefined();
    expect(setupEvents(world)).toEqual([]);
  });
});
