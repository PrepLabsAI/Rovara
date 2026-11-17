// S1 (core switch-on gate): a person's Stop on a core task through the core host's dev routes, `POST /v1/dev/tasks/{id}/cancel` with the old cancel's request and answer.
// Who may stop: the task's owner by the company's owner rule (a People owner counts), or a live owner/admin of the TASK'S company (membership's role, never the principal's roles). Anyone
// who may not read the task (another company, its admin included, a revoked member, a script token) gets the missing task's answer; a reader who may not stop gets fixed words. One request
// id is one stop.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, when, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { STOP_NOT_YOURS, STOP_REQUEST_REUSED, stopTaskOnRequest } from "../../packages/broker/src/core/task-flow/stop-request.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const OTHER = "org_corehost00000000000b";
const OWNER_ID = "person-owner-00000000001";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const WIRED: CoreDevWiring = { origin: () => "https://api.example" };
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });

/**
 * The company's rule as a deployment wires it (hostedTaskAccess's shape): the person the task runs for, and the People owners named in `coOwners`, act as its owner (a People owner's act
 * carries a revision fence); `readers` may read it (a People commenter or viewer) but are no owner. Every role is ignored: only membership's role, passed by the route, makes an admin.
 */
function hostedRule(world: FakeWorld, people: { coOwners: Set<string>; readers: Set<string> }): TaskFlowDeps["access"] {
  const owns = (personId: string, task: { developerId: string }) => personId === task.developerId || people.coOwners.has(personId);
  return {
    ...createOwnerTaskAccess(),
    async checkStart() { return { allowed: true }; },
    async canAct(principal, task) { return owns(principal.personId, task) || people.readers.has(principal.personId); },
    async ownerActing(principal, task) {
      if (!owns(principal.personId, task)) return undefined;
      if (principal.personId === task.developerId) return { actorId: task.ownerKey };
      const revision = (await world.store.get({ pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" }))?.["revision"];
      return { actorId: `owner:${principal.personId}`, items: [{ kind: "check", key: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" }, condition: when.eq("revision", revision as number) }] };
    },
  };
}

function appWith(world: FakeWorld, access: TaskFlowDeps["access"]): CoreHostApp {
  return createCoreHostApp({
    env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

async function running(options: { access?: "hosted" | "laptop" } = {}) {
  const world = createFakeWorld();
  await registerProject(world, FAKE_COMPANY);
  await registerProject(world, OTHER);
  const people = { coOwners: new Set<string>(), readers: new Set<string>() };
  const app = appWith(world, options.access === "laptop" ? createOwnerTaskAccess() : hostedRule(world, people));
  const members = new Map<string, CompanyMembership>();
  const companyOf = vi.fn(async (caller: DeployedCaller) => members.get(`${caller.principal.personId}|${caller.principal.companyId}`));
  /** A caller whose principal carries the `owner` role whatever membership says (the route must read membership's role, never this). */
  const person = (personId: string, companyId: string, role: CompanyMembership["role"] | null): DeployedCaller => {
    if (role !== null) members.set(`${personId}|${companyId}`, { companyId, role });
    return { principal: localOwnerPrincipal({ companyId, personId }), client: "cli" };
  };
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
  const owner = person(OWNER_ID, FAKE_COMPANY, "member");
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const { task } = await runtime.flow.start({ principal: owner.principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  const location = await workspaceKeys({ store: world.store, companyId: FAKE_COMPANY }, task.workspaceId);
  const workspace = async () => (await world.store.get(location.workspaceKey)) as Record<string, unknown>;
  const activeOperation = (await workspace())["activeOperationId"] as string;
  const operationStatus = async () => (await world.store.get(location.operationKey(activeOperation)))?.["status"];
  const cancel = (caller: DeployedCaller, body: unknown = { requestId: randomUUID() }, raw?: string) => routes.route({ ...post(`/v1/dev/tasks/${task.taskId}/cancel`, body), ...(raw === undefined ? {} : { body: raw }) }, caller);
  const rows = async () => JSON.stringify((await (world.store as unknown as { scanPage(request: { limit: number }): Promise<{ items: unknown[] }> }).scanPage({ limit: 1000 })).items);
  return { world, app, routes, people, person, owner, task, activeOperation, operationStatus, cancel, companyOf, rows, members, runtime };
}

const parsed = (answer: { body: string } | undefined) => JSON.parse(answer!.body) as { task?: { taskId: string; status: string }; error?: { code: string; message: string } };

describe("POST /v1/dev/tasks/{id}/cancel on a core task", () => {
  it("has a step running to stop (the fixture's precondition)", async () => {
    const { activeOperation, operationStatus } = await running();
    expect(typeof activeOperation).toBe("string");
    expect(await operationStatus()).not.toBe("CANCELLED");
  });

  it("stops the task for its owner (a plain member) and answers { task } as the old cancel does; the machine is stopped and the step is cancelled", async () => {
    const { cancel, owner, task, operationStatus, world } = await running();
    const answer = await cancel(owner);
    expect(answer?.statusCode).toBe(200);
    expect(parsed(answer).task?.taskId).toBe(task.taskId);
    expect(await operationStatus()).toBe("CANCELLED");
    expect(world.audit.filter((event) => event.action === "task.stopped").map((event) => event.details)).toEqual([{ project: "payments", by: "owner" }]);
  });

  it("stops the task for a People owner (a co-owner by the company's owner rule), with the People revision fenced into the claim", async () => {
    const { cancel, person, people, operationStatus, world, task } = await running();
    await world.store.put({ item: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE", revision: 3 } });
    people.coOwners.add("person-coowner-000000001");
    const coOwner = person("person-coowner-000000001", FAKE_COMPANY, "member");
    expect((await cancel(coOwner))?.statusCode).toBe(200);
    expect(await operationStatus()).toBe("CANCELLED");
  });

  it("refuses a People owner whose People revision changed between the check and the claim (a missing task's answer; nothing stopped)", async () => {
    const { cancel, person, people, operationStatus, world, task } = await running();
    await world.store.put({ item: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE", revision: 3 } });
    people.coOwners.add("person-coowner-000000001");
    const coOwner = person("person-coowner-000000001", FAKE_COMPANY, "member");
    const transact = world.store.transact.bind(world.store);
    vi.spyOn(world.store, "transact").mockImplementationOnce(async (items) => {
      await world.store.put({ item: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE", revision: 4 } });
      return await transact(items);
    });
    const answer = await cancel(coOwner);
    expect(answer?.statusCode).toBe(404);
    expect(await operationStatus()).not.toBe("CANCELLED");
  });

  it.each(["owner", "admin"] as const)("stops the task for a live %s of the task's company who is not its owner", async (role) => {
    const { cancel, person, operationStatus, world } = await running();
    const admin = person("person-admin-0000000001", FAKE_COMPANY, role);
    expect((await cancel(admin))?.statusCode).toBe(200);
    expect(await operationStatus()).toBe("CANCELLED");
    expect(world.audit.filter((event) => event.action === "task.stopped").map((event) => event.details)).toEqual([{ project: "payments", by: "company-admin" }]);
  });

  it("two companies: an admin (and an owner) of company B cannot stop company A's core task, and is answered exactly like a task id that does not exist", async () => {
    const { cancel, person, operationStatus, routes, rows } = await running();
    for (const role of ["owner", "admin", "member"] as const) {
      const theirs = person(`person-b-${role}-000000001`, OTHER, role);
      const before = await rows();
      const answer = await cancel(theirs);
      const missing = await routes.route(post(`/v1/dev/tasks/${randomUUID()}/cancel`, { requestId: randomUUID() }), theirs);
      expect(answer?.statusCode, role).toBe(404);
      expect(answer?.body, role).toBe(missing?.body);
      expect(answer?.body, role).not.toContain(FAKE_COMPANY);
      expect(await rows(), role).toBe(before);
    }
    expect(await operationStatus()).not.toBe("CANCELLED");
  });

  it("a person whose principal says company A but whose membership is company B's admin reads a missing task (membership decides the company; never the principal)", async () => {
    const { cancel, members, operationStatus } = await running();
    const caller: DeployedCaller = { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: "person-mixed-0000000001" }), client: "cli" };
    members.set(`person-mixed-0000000001|${FAKE_COMPANY}`, { companyId: OTHER, role: "admin" });
    expect((await cancel(caller))?.statusCode).toBe(401);
    expect(await operationStatus()).not.toBe("CANCELLED");
  });

  it("a member of the task's company who is not its owner and not an admin, whose principal carries the 'owner' role, reads a missing task (membership's role, never the principal's)", async () => {
    const { cancel, person, operationStatus } = await running();
    const colleague = person("person-colleague-000001", FAKE_COMPANY, "member");
    const answer = await cancel(colleague);
    expect(answer?.statusCode).toBe(404);
    expect(parsed(answer).error).toEqual({ code: "TASK_NOT_FOUND", message: "no such task" });
    expect(await operationStatus()).not.toBe("CANCELLED");
  });

  it("a People commenter or viewer (may read the task, is no owner) gets the fixed refusal and nothing is stopped", async () => {
    const { cancel, person, people, operationStatus, rows } = await running();
    people.readers.add("person-commenter-000001");
    const commenter = person("person-commenter-000001", FAKE_COMPANY, "member");
    const before = await rows();
    const answer = await cancel(commenter);
    expect(answer?.statusCode).toBe(403);
    expect(parsed(answer).error).toEqual({ code: "FORBIDDEN", message: STOP_NOT_YOURS });
    expect(await rows()).toBe(before);
    expect(await operationStatus()).not.toBe("CANCELLED");
  });

  it("a revoked member (no live membership), the task's own person included, gets the sign-in refusal the boundary reads as a missing task; nothing is stopped", async () => {
    const { cancel, members, owner, operationStatus } = await running();
    members.delete(`${OWNER_ID}|${FAKE_COMPANY}`);
    expect((await cancel(owner))?.statusCode).toBe(401);
    expect(await operationStatus()).not.toBe("CANCELLED");
  });

  it("a script token, even the owner's, reads a missing task whatever body it sends", async () => {
    const { cancel, owner, operationStatus } = await running();
    const token = { ...owner, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } };
    for (const raw of [JSON.stringify({ requestId: randomUUID() }), "[1]", "not json"]) expect((await cancel(token, undefined, raw))?.statusCode, raw).toBe(404);
    expect(await operationStatus()).not.toBe("CANCELLED");
  });

  it("someone who may not read the task learns nothing from the body they send (the task is judged first)", async () => {
    const { cancel, person, routes } = await running();
    const stranger = person("person-b-0000000000001", OTHER, "admin");
    for (const raw of ["[1]", "null", "not json", "{}"]) {
      const theirs = await cancel(stranger, undefined, raw);
      const missing = await routes.route({ ...post(`/v1/dev/tasks/${randomUUID()}/cancel`), body: raw }, stranger);
      expect(theirs?.statusCode, raw).toBe(404);
      expect(theirs?.body, raw).toBe(missing?.body);
    }
  });

  it("the owner's bad body gets the old cancel's field words; a reused request id for another action is refused; a closed task is refused", async () => {
    const { cancel, owner, world, task } = await running();
    expect(parsed(await cancel(owner, {})).error?.code).toBe("CONFIG_INVALID");
    expect(parsed(await cancel(owner, { requestId: randomUUID(), extra: 1 })).error?.code).toBe("CONFIG_INVALID");
    const record = (await world.store.get(taskKey(task.taskId)))!;
    const location = await workspaceKeys({ store: world.store, companyId: FAKE_COMPANY }, task.workspaceId);
    const reused = randomUUID();
    await world.store.put({ item: { ...location.operationRequestKey(record["ownerKey"] as string, reused), entityType: "IDEMPOTENCY", payloadHash: "f".repeat(64) } });
    expect(parsed(await cancel(owner, { requestId: reused })).error).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: STOP_REQUEST_REUSED });
    await world.store.put({ item: { ...record, closedAt: "2026-11-15T10:00:00.000Z" } });
    expect(parsed(await cancel(owner)).error?.code).toBe("CONFIG_INVALID");
  });

  it("one request id is one stop: a repeat answers the task as it is now and stops nothing more (not even a step started after the first stop)", async () => {
    const { cancel, owner, world, activeOperation, task } = await running();
    const body = { requestId: randomUUID() };
    expect((await cancel(owner, body))?.statusCode).toBe(200);
    // A new step holds the workspace after the first stop; a repeat of the first request must not stop it.
    const location = await workspaceKeys({ store: world.store, companyId: FAKE_COMPANY }, task.workspaceId);
    const workspace = (await world.store.get(location.workspaceKey))!;
    const operation = (await world.store.get(location.operationKey(activeOperation)))!;
    const next = `${activeOperation.slice(0, -4)}beef`;
    await world.store.put({ item: { ...operation, sk: location.operationKey(next).sk, id: next, status: "RUNNING" } });
    await world.store.put({ item: { ...workspace, activeOperationId: next } });
    const stopped = vi.spyOn(world.machines, "stop");
    const again = await cancel(owner, body);
    expect(again?.statusCode).toBe(200);
    expect(parsed(again).task?.taskId).toBe(task.taskId);
    expect((await world.store.get(location.operationKey(next)))?.["status"]).toBe("RUNNING");
    expect(stopped).not.toHaveBeenCalled();
    expect(world.audit.filter((event) => event.action === "task.stopped")).toHaveLength(1);
  });

  it("is served only with the company's owner rule: on Code's laptop rule it is not the core's here (the engine boundary then says so), and only POST is the core's", async () => {
    const laptop = await running({ access: "laptop" });
    expect(await laptop.cancel(laptop.owner)).toBeUndefined();
    const wired = await running();
    expect(await wired.routes.route({ method: "GET", path: `/v1/dev/tasks/${wired.task.taskId}/cancel`, headers: {}, body: "" }, wired.owner)).toBeUndefined();
  });

  it("off (the default) answers nothing and reads nothing", async () => {
    const world = createFakeWorld();
    const app = createCoreHostApp({ env: {}, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now, runtime: () => { throw new Error("never built"); } });
    const companyOf = vi.fn();
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    expect(await routes.route(post(`/v1/dev/tasks/${randomUUID()}/cancel`, { requestId: randomUUID() }), { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY }) })).toBeUndefined();
    expect(companyOf).not.toHaveBeenCalled();
    expect(world.created).toEqual([]);
  });

  it("the core's own check (for every host, Slack and the admin cancel too): a script token, a principal of another company and an admin of another company each read a missing task, whatever role they carry", async () => {
    const { runtime, owner, task, operationStatus } = await running();
    const deps = runtime.flow.deps;
    const body = () => ({ requestId: randomUUID() });
    await expect(stopTaskOnRequest(deps, { principal: owner.principal, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa", name: "t", permissions: ["read", "start"], projects: ["payments"] }, companyRole: "owner" }, task.taskId, body)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(stopTaskOnRequest(deps, { principal: localOwnerPrincipal({ companyId: OTHER, personId: OWNER_ID }), companyRole: "owner" }, task.taskId, body)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    // A runtime of company B (its own deps) never stops company A's task, even for B's owner: the task's company is checked, not only the caller's.
    const other = await runtime.flow.deps.store.get(taskKey(task.taskId));
    expect(other?.["companyId"]).toBe(FAKE_COMPANY);
    const bDeps = { ...deps, companyId: OTHER };
    await expect(stopTaskOnRequest(bDeps, { principal: localOwnerPrincipal({ companyId: OTHER, personId: "person-b-owner-00000001" }), companyRole: "owner" }, task.taskId, body)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    // No role read (undefined) is no admin authority.
    await expect(stopTaskOnRequest(deps, { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: "person-colleague-000001" }) }, task.taskId, body)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await operationStatus()).not.toBe("CANCELLED");
  });
});
