// L4-P1: the hosted "Re-check setup" route (the Thursday fallback): `GET` and `POST /v1/app/projects/{project}/setup-check`. A PERSON starts the project's plain setup check (a company owner or admin, or the project's
// administrator, read live); a reader reads where it stands and may not start one; anyone else, another company and a malformed project read one uniform 404. The audit record comes first, a repeat of the request
// id answers the first check, nothing else than { requestId } is taken, and no model, no key and no flag is involved. Each guard has a test that fails if it is removed (mutants in the PR body).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type AuditEvent, type AuditSink, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { projectMetaKey } from "@agentx/contracts";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import {
  SETUP_RUN_NOT_ALLOWED, SETUP_RUN_PROJECT_NOT_FOUND, type HostedSetupRunWiring, type SetupRunStanding,
} from "../../packages/broker/src/core-host/setup-run-routes.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { inertSetupStep, recheckRowKey, repairNoticeKey, setupRepairCardOf } from "../../packages/broker/src/core/setup-agent/recheck-rows.js";

const OTHER = "org_corehost00000000000b";
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const project = (name: string): ProjectDefinition => ({
  name, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});

function appOver(world: FakeWorld): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
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
  const app = appOver(world);
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

  it("needs no model gateway to start a check (the check uses no model)", async () => {
    const noGateway = await setupWorld({ gateway: false });
    const owner = noGateway.person("p-owner", FAKE_COMPANY, "owner");
    expect((await noGateway.call(post(CHECK, { requestId: randomUUID() }), owner)).status).toBe(202);
  });
});

// SETUP-CHECK-WATCH (C): `POST /v1/app/projects/{project}/setup-check/stop`, the same people as start. It ends the project's running check (its preparation, its workspace, its machine) and answers 200 either way.
describe("hosted Stop check: POST /v1/app/projects/{project}/setup-check/stop", () => {
  const STOP = `${CHECK}/stop`;
  const stopEvents = (world: FakeWorld): AuditEvent[] => world.audit.filter((event) => event.action === "setup_check.stop_requested");
  const workspaceStatus = async (world: FakeWorld, workspaceId: string) => (await world.store.get({ pk: `ORG#${FAKE_COMPANY}#WORKSPACE#${workspaceId}`, sk: "META" }))?.["status"];

  it("lets a company owner, admin and the project's administrator stop a running check: audited first, the workspace closed, and a repeat answers nothing running", async () => {
    for (const [role, grant, basis] of [["owner", undefined, "company-owner"], ["admin", undefined, "company-admin"], ["member", "administrator", "project-admin"]] as const) {
      const { world, person, call } = await setupWorld();
      const caller = person(`p-${role}`, FAKE_COMPANY, role, grant);
      const started = await call(post(CHECK, { requestId: randomUUID() }), caller);
      const workspaceId = started.body["workspaceId"] as string;
      expect(await workspaceStatus(world, workspaceId), role).toBe("PREPARING");
      const requestId = randomUUID();
      const stopped = await call(post(STOP, { requestId }), caller);
      expect({ status: stopped.status, body: stopped.body }, role).toEqual({ status: 200, body: { stopped: 1, nothingRunning: false } });
      expect(await workspaceStatus(world, workspaceId), role).toBe("CLOSED");
      expect(stopEvents(world).map((event) => [event.actor, event.details?.["basis"], event.subject])).toEqual([[{ type: "person", id: `p-${role}` }, basis, { type: "project", id: "payments" }]]);
      const again = await call(post(STOP, { requestId }), caller);
      expect({ status: again.status, body: again.body }).toEqual({ status: 200, body: { stopped: 0, nothingRunning: true } });
      // The page then reads the check as failed, and a new check may start.
      expect((await call(get(CHECK), caller)).body).toMatchObject({ status: "failed" });
      expect((await call(post(CHECK, { requestId: randomUUID() }), caller)).status).toBe(202);
    }
  });

  it("refuses a reader in fixed words and stops nothing; anyone else, another company and a malformed project read the uniform 404", async () => {
    const { world, person, call } = await setupWorld();
    const owner = person("p-owner", FAKE_COMPANY, "owner");
    const started = await call(post(CHECK, { requestId: randomUUID() }), owner);
    const workspaceId = started.body["workspaceId"] as string;
    const reader = person("p-dev", FAKE_COMPANY, "member", "developer");
    const refused = await call(post(STOP, { requestId: randomUUID() }), reader);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_RUN_NOT_ALLOWED } });
    for (const caller of [person("p-none", FAKE_COMPANY, "member"), person("p-foreign", OTHER, "member")]) {
      const answer = await call(post(STOP, { requestId: randomUUID() }), caller);
      expect({ status: answer.status, body: answer.body }).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: SETUP_RUN_PROJECT_NOT_FOUND } } });
    }
    expect((await call(post("/v1/app/projects/-bad/setup-check/stop", { requestId: randomUUID() }), owner)).status).toBe(404);
    expect(await workspaceStatus(world, workspaceId)).toBe("PREPARING");
    expect(stopEvents(world)).toEqual([]);
  });

  it("takes only { requestId }, writes nothing when the audit record cannot be written, and is a POST only", async () => {
    const owner = await setupWorld();
    const caller = owner.person("p-owner", FAKE_COMPANY, "owner");
    const started = await owner.call(post(CHECK, { requestId: randomUUID() }), caller);
    for (const body of [{}, { requestId: "nope" }, { requestId: randomUUID(), workspaceId: started.body["workspaceId"] }]) expect((await owner.call(post(STOP, body), caller)).status).toBe(400);
    expect(await workspaceStatus(owner.world, started.body["workspaceId"] as string)).toBe("PREPARING");
    await expect(owner.call(get(STOP), caller)).rejects.toThrow("not served");

    const failing = await setupWorld({ audit: (sink) => ({ ...sink, record: async (event) => { if (event.action === "setup_check.stop_requested") throw new Error("audit down"); return sink.record(event); } }) });
    const person = failing.person("p-owner", FAKE_COMPANY, "owner");
    const check = await failing.call(post(CHECK, { requestId: randomUUID() }), person);
    const refused = await failing.call(post(STOP, { requestId: randomUUID() }), person);
    expect(refused.status).toBe(503);
    expect(await workspaceStatus(failing.world, check.body["workspaceId"] as string)).toBe("PREPARING");
  });
});

// L4-U5: the same read carries who may act and, while the setup is broken, the "Setup needs repair" card in the words every surface shares.
describe("hosted Re-check setup: the repair card on the read (L4-U5)", () => {
  const STEP = "setup: npm ci - setup step 0 (npm ci) failed: exit 1";
  const KEY = "a".repeat(48);
  /** The rows a settled "broken" re-check leaves: the re-check, the project's own mark of its failed check, and the one admin card. */
  async function broken(world: FakeWorld, companyId: string, project = "payments"): Promise<void> {
    const check = { workspaceId: "ws-1", revision: 1, startedAt: "2026-11-17T09:00:00.000Z", startedBy: "system" };
    await world.store.put({ item: { ...projectMetaKey(companyId, project), entityType: "PROJECT_META", setupCheck: check } });
    await world.store.put({ item: { ...recheckRowKey(companyId, project, KEY), entityType: "SETUP_RECHECK", orgId: companyId, project, key: KEY, setupRevision: 1, commits: { demo: "c1" }, classes: ["lockfile"], state: "broken", attempt: 2, check, startedAt: check.startedAt, failedStep: STEP } });
    await world.store.put({ item: { ...repairNoticeKey(companyId, project), entityType: "SETUP_REPAIR_NOTICE", orgId: companyId, project, key: KEY, failedStep: STEP, classes: ["lockfile"], at: "2026-11-17T09:05:00.000Z" } });
  }

  it("a manager reads the card with the one action that fits; a reader reads the same words and no action; nobody else reads anything", async () => {
    const { world, person, call } = await setupWorld();
    await broken(world, FAKE_COMPANY);
    const owner = await call(get(CHECK), person("p-owner", FAKE_COMPANY, "owner"));
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ canManage: true, repair: { title: "Setup needs repair", changed: "dependency files", fixReady: false, at: "2026-11-17T09:05:00.000Z", actions: [{ id: "fix_setup", label: "Fix setup" }] } });
    const card = (owner.body["repair"] as { body: string }).body;
    expect(card).toBe(setupRepairCardOf(inertSetupStep(STEP)).body);
    expect(card).not.toMatch(/\$|AI\b/u);
    const reader = await call(get(CHECK), person("p-dev", FAKE_COMPANY, "member", "developer"));
    expect(reader.body).toMatchObject({ canManage: false, repair: { title: "Setup needs repair", actions: [] } });
    expect((reader.body["repair"] as { body: string }).body).toBe(card);
    expect((await call(get(CHECK), person("p-nobody", FAKE_COMPANY, "member"))).status).toBe(404);
  });

  it("no card while the setup works, and none for a break that a newer setup ended; another company's project of the same name never shows this card", async () => {
    const works = await setupWorld();
    const answer = await works.call(get(CHECK), works.person("p-owner", FAKE_COMPANY, "owner"));
    expect(answer.body["canManage"]).toBe(true);
    expect(answer.body["repair"]).toBeUndefined();
    const mine = await setupWorld();
    await broken(mine.world, FAKE_COMPANY);
    // Company B has its own project "payments" and no break: it reads no card, whatever company A has.
    const other = mine.person("o-owner", OTHER, "owner");
    const theirs = await mine.call(get(CHECK), other);
    expect(theirs.status).toBe(200);
    expect(theirs.body["repair"]).toBeUndefined();
    // A newer setup revision ends the break.
    await mine.world.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, "payments", 2), entityType: "PROJECT", definition: JSON.parse(JSON.stringify({ ...project("payments"), revision: 2 })) as JsonValue } });
    await mine.world.store.put({ item: { ...orgProjectCatalogKey(FAKE_COMPANY, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 2 } });
    expect((await mine.call(get(CHECK), mine.person("p-owner", FAKE_COMPANY, "owner"))).body["repair"]).toBeUndefined();
  });
});
