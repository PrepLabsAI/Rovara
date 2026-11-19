// Core task web routes (Cloud #188's Code gaps): the routes the web app needs for a task the core engine owns, each with the old task routes' access rules.
//   - DEC 254zzz39 (6): `POST /v1/app/tasks/{id}/review-findings`, the task owner's Accept findings on the web page, the one route that accepts a SECURITY finding on a core task: only the web app's own client, only
//     after a fresh step-up checked against the company's window, only for the task's owner; anyone else is refused and nothing is written.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WorkflowSnapshotSchema, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition, type WorkflowSnapshot } from "@agentx/contracts";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { SECURITY_ACCEPT_ON_THE_PAGE } from "../../packages/broker/src/core/task-flow/security-accept.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { blockedReview, code, plain, report, TOKEN, tokenId } from "../support/task-actions-world.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const OTHER = "org_corehost00000000000b";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
const errorOf = (answer: { body: string } | undefined) => (JSON.parse(answer!.body) as { error: { code: string; message: string } }).error;
const minutesAgo = (world: FakeWorld, minutes: number) => new Date(world.clock.now - minutes * 60_000).toISOString();

/** The company's owner rule as a deployment wires it: only the person the task runs for acts on it (and so reads its money) as its owner here. */
const isOwner = (principal: { personId: string; provider: string }, task: { developerId: string }) => principal.personId === task.developerId || developerIdOf(principal) === task.developerId;
const ownerRule = (): TaskFlowDeps["access"] => ({
  ...createOwnerTaskAccess(),
  canAct: async (principal, task) => isOwner(principal, task),
  ownerActing: async (principal, task) => (principal.personId === task.developerId || developerIdOf(principal) === task.developerId ? { actorId: task.ownerKey } : undefined),
});

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

interface Setup { wiring?: { [K in Exclude<keyof CoreDevWiring, "origin">]?: CoreDevWiring[K] | undefined }; access?: TaskFlowDeps["access"] }

async function started(options: Setup = {}) {
  const world = createFakeWorld();
  await registerProject(world, FAKE_COMPANY);
  await registerProject(world, OTHER);
  const app: CoreHostApp = createCoreHostApp({
    env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: options.access ?? ownerRule(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
  const member = new Map<string, CompanyMembership>();
  const companyOf = vi.fn(async (caller: DeployedCaller) => member.get(caller.principal.personId + caller.principal.companyId));
  const remember = (companyId: string, role: CompanyMembership["role"] = "owner", personId?: string): DeployedCaller => {
    const base: DeployedCaller = { principal: localOwnerPrincipal({ companyId }), client: "cloud-web" };
    const caller = personId === undefined ? base : { ...base, principal: { ...base.principal, personId } };
    member.set(caller.principal.personId + companyId, { companyId, role });
    return caller;
  };
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ taskActions: { roundCap: async () => undefined }, ...options.wiring, origin: () => "https://api.example" }) as CoreDevWiring });
  const own = remember(FAKE_COMPANY);
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const { task } = await runtime.flow.start({ principal: own.principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  return { world, app, routes, own, remember, companyOf, taskId: task.taskId };
}

/** Puts the core task's workflow in a review the SECURITY review blocked (the critic passed), at the task's own id and owner. */
async function blockOnSecurity(world: FakeWorld, taskId: string): Promise<number> {
  const record = (await world.store.get(taskKey(taskId))) as unknown as Record<string, unknown> & { workflow: WorkflowSnapshot };
  const workflow = WorkflowSnapshotSchema.parse({ ...blockedReview({}, [report("CRITIC", "PASS", []), report("SECURITY", "FINDINGS", [TOKEN])]), taskId, ownerId: record.workflow.ownerId, blockReason: "the security review did not pass" });
  await world.store.put({ item: { ...record, workflow: plain(workflow) as unknown as JsonValue } as never });
  return workflow.revision;
}

const acceptSecurity = (expectedRevision: number) => ({ requestId: randomUUID(), expectedRevision, candidateDigest: code.digest, resolutions: [{ findingId: tokenId, action: "ACCEPT", note: "Only a test token." }] });
const PAGE = (taskId: string) => `/v1/app/tasks/${taskId}/review-findings`;

describe("DEC 254zzz39 (6): the task owner accepts a SECURITY finding on the web page", () => {
  it("accepts it for the task owner on the web app's client with a fresh step-up, as the page; the same request through the API-token route is refused", async () => {
    const { world, routes, own, taskId } = await started();
    const revision = await blockOnSecurity(world, taskId);
    const page: DeployedCaller = { ...own, webApp: true, stepUp: { at: minutesAgo(world, 1), method: "passkey" } };
    // The old workflow route is an API token's: it never accepts a security finding, whoever calls it.
    const token = await routes.route(post(`/v1/dev/tasks/${taskId}/workflow/review-findings`, acceptSecurity(revision)), page);
    expect(token?.statusCode).toBe(403);
    expect(errorOf(token)).toEqual({ code: "FORBIDDEN", message: SECURITY_ACCEPT_ON_THE_PAGE });
    const accepted = await routes.route(post(PAGE(taskId), acceptSecurity(revision)), page);
    expect(accepted?.statusCode).toBe(200);
    const view = JSON.parse(accepted!.body) as { task: { taskId: string; workflow?: { revision: number; stage: string } } };
    expect(view.task.taskId).toBe(taskId);
    expect(view.task.workflow!.revision).toBeGreaterThan(revision);
    const stored = (await world.store.get(taskKey(taskId))) as unknown as { workflow: WorkflowSnapshot };
    expect(stored.workflow.revision).toBeGreaterThan(revision);
  });

  it("refuses a caller that is not the web app's client, with nothing read or written, whatever step-up it carries", async () => {
    const { world, routes, own, taskId } = await started();
    const revision = await blockOnSecurity(world, taskId);
    const before = JSON.stringify(await world.store.get(taskKey(taskId)));
    const read = vi.spyOn(world.store, "get");
    for (const caller of [{ ...own, stepUp: { at: minutesAgo(world, 1), method: "passkey" } }, { ...own, webApp: undefined }, { ...own, webApp: "true" as never, stepUp: { at: minutesAgo(world, 1), method: "passkey" } }] as DeployedCaller[]) {
      const answer = await routes.route(post(PAGE(taskId), acceptSecurity(revision)), caller);
      expect(answer?.statusCode).toBe(403);
      expect(errorOf(answer)).toEqual({ code: "FORBIDDEN", message: SECURITY_ACCEPT_ON_THE_PAGE });
    }
    // The same answer for a task id that does not exist: the refusal tells nothing about the task.
    expect(errorOf(await routes.route(post(PAGE(randomUUID()), acceptSecurity(revision)), own))).toEqual({ code: "FORBIDDEN", message: SECURITY_ACCEPT_ON_THE_PAGE });
    expect(read.mock.calls.filter(([key]) => JSON.stringify(key).includes(taskId))).toEqual([]);
    expect(JSON.stringify(await world.store.get(taskKey(taskId)))).toBe(before);
  });

  it("needs a FRESH step-up with Code's own factor, within the company's window: none, an old one, a Slack round trip, a future one or one past a shorter company window is refused, with nothing written", async () => {
    const { world, routes, own, taskId } = await started();
    const revision = await blockOnSecurity(world, taskId);
    const before = JSON.stringify(await world.store.get(taskKey(taskId)));
    for (const stepUp of [undefined, { at: minutesAgo(world, 11), method: "passkey" }, { at: minutesAgo(world, 1), method: "slack" }, { at: minutesAgo(world, 1), method: "oidc" }, { at: minutesAgo(world, -5), method: "passkey" }, { at: "yesterday", method: "passkey" }]) {
      const answer = await routes.route(post(PAGE(taskId), acceptSecurity(revision)), { ...own, webApp: true, ...(stepUp === undefined ? {} : { stepUp }) });
      expect(answer?.statusCode, JSON.stringify(stepUp)).toBe(403);
      expect(errorOf(answer), JSON.stringify(stepUp)).toEqual({ code: "REAUTH_REQUIRED", message: SECURITY_ACCEPT_ON_THE_PAGE });
    }
    expect(JSON.stringify(await world.store.get(taskKey(taskId)))).toBe(before);
    // The company's own (shorter) window: two minutes old is too old for a one-minute window; a window that cannot be read refuses.
    for (const [window, refusal] of [[async () => 60, "REAUTH_REQUIRED"], [async () => { throw new Error("rules down"); }, "RUNTIME_UNAVAILABLE"]] as const) {
      const shorter = await started({ wiring: { stepUpWindowSeconds: window } });
      const shorterRevision = await blockOnSecurity(shorter.world, shorter.taskId);
      const answer = await shorter.routes.route(post(PAGE(shorter.taskId), acceptSecurity(shorterRevision)), { ...shorter.own, webApp: true, stepUp: { at: minutesAgo(shorter.world, 2), method: "passkey" } });
      expect(errorOf(answer).code).toBe(refusal);
      expect(JSON.stringify(await shorter.world.store.get(taskKey(shorter.taskId)))).toContain(`"revision":${shorterRevision},`);
    }
  });

  it("refuses a company member who is not the task's owner, another company's caller and a script token as no such task; nothing is written", async () => {
    const { world, routes, remember, taskId } = await started();
    const revision = await blockOnSecurity(world, taskId);
    const before = JSON.stringify(await world.store.get(taskKey(taskId)));
    const fresh = { webApp: true as const, stepUp: { at: minutesAgo(world, 1), method: "passkey" } };
    // A member (even a company admin) of the same company who is not the task's owner.
    for (const role of ["member", "admin"] as const) {
      const colleague = await routes.route(post(PAGE(taskId), acceptSecurity(revision)), { ...remember(FAKE_COMPANY, role, `person-${role}-000000000002`), ...fresh });
      expect(colleague?.statusCode, role).toBe(404);
      expect(errorOf(colleague).code).toBe("TASK_NOT_FOUND");
    }
    // Another company's owner: exactly the answer for an id with no task.
    const theirs = await routes.route(post(PAGE(taskId), acceptSecurity(revision)), { ...remember(OTHER), ...fresh });
    const missing = await routes.route(post(PAGE(randomUUID()), acceptSecurity(revision)), { ...remember(OTHER), ...fresh });
    expect(theirs?.statusCode).toBe(404);
    expect(errorOf(theirs)).toEqual(errorOf(missing));
    expect(theirs!.body).not.toContain(FAKE_COMPANY);
    // A script token never reaches it.
    const token = await routes.route(post(PAGE(taskId), acceptSecurity(revision)), { ...remember(FAKE_COMPANY), ...fresh, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
    expect(token?.statusCode).toBe(404);
    expect(JSON.stringify(await world.store.get(taskKey(taskId)))).toBe(before);
  });

  it("is served only with the owner moves' wiring and the company's owner rule, for POST only", async () => {
    const unwired = await started({ wiring: { taskActions: undefined } });
    const fresh = { webApp: true as const, stepUp: { at: minutesAgo(unwired.world, 1), method: "passkey" } };
    const answer = await unwired.routes.route(post(PAGE(unwired.taskId), acceptSecurity(1)), { ...unwired.own, ...fresh });
    expect(answer?.statusCode).toBe(404);
    expect(errorOf(answer).message).toBe(NOT_ON_THE_CORE_YET);
    const laptopRule = await started({ access: createOwnerTaskAccess() });
    expect(errorOf(await laptopRule.routes.route(post(PAGE(laptopRule.taskId), acceptSecurity(1)), { ...laptopRule.own, webApp: true, stepUp: { at: minutesAgo(laptopRule.world, 1), method: "passkey" } })).message).toBe(NOT_ON_THE_CORE_YET);
    const wired = await started();
    expect(await wired.routes.route(get(PAGE(wired.taskId)), { ...wired.own, ...fresh })).toBeUndefined();
  });
});

describe("DEC 254zzz39 (6): a body the move would refuse tells someone who may not see the task nothing", () => {
  it("another company's caller and a non-owner get no such task for any body (the task is read before the body)", async () => {
    const { world, routes, remember, taskId } = await started();
    await blockOnSecurity(world, taskId);
    const fresh = { webApp: true as const, stepUp: { at: minutesAgo(world, 1), method: "passkey" } };
    for (const caller of [{ ...remember(OTHER), ...fresh }, { ...remember(FAKE_COMPANY, "member", "person-member-000000000003"), ...fresh }]) {
      for (const raw of ["not json", "[1]", "null"]) expect((await routes.route({ ...post(PAGE(taskId)), body: raw }, caller))?.statusCode, raw).toBe(404);
    }
  });
});

describe("Cloud #188 item 5: the task list's money read for a core task", () => {
  it("answers the task's owner with the owner round's own cap and spend, and nobody else; a cap that cannot be read gives nothing", async () => {
    const roundCap = vi.fn(async () => ({ limitUsd: 12, spentUsd: 3.5 }));
    const { routes, own, remember, taskId } = await started({ wiring: { taskActions: { roundCap } } });
    const read = await routes.taskMoney(own, taskId);
    expect(read).toMatchObject({ costUsd: 3.5, runLimitUsd: 12, money: { version: 1, taskId, state: "unavailable", stop: { taskMaximumMicros: { state: "available", value: 12_000_000 } } } });
    const detail = (JSON.parse((await routes.route(get(`/v1/dev/tasks/${taskId}`), own))!.body) as { task: { money?: unknown } }).task;
    expect(detail.money).toEqual(read?.money);
    expect(roundCap).toHaveBeenCalledTimes(2);
    roundCap.mockClear();
    // A member of the same company who is not the owner, another company's caller, a script token, a malformed or missing id: nothing, and the cap is never read.
    for (const caller of [remember(FAKE_COMPANY, "admin", "person-admin-000000000004"), remember(OTHER), { ...own, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } }]) expect(await routes.taskMoney(caller, taskId)).toBeUndefined();
    expect(await routes.taskMoney(own, "not-a-task")).toBeUndefined();
    expect(await routes.taskMoney(own, randomUUID())).toBeUndefined();
    expect(roundCap).not.toHaveBeenCalled();
    // An unknown spend: the limit alone; a throwing or unwired cap: nothing.
    const unknownSpend = await started({ wiring: { taskActions: { roundCap: async () => ({ limitUsd: 4, spentUsd: undefined }) } } });
    expect(await unknownSpend.routes.taskMoney(unknownSpend.own, unknownSpend.taskId)).toMatchObject({ runLimitUsd: 4, money: { state: "unavailable" } });
    const failing = await started({ wiring: { taskActions: { roundCap: async () => { throw new Error("ledger down"); } } } });
    expect(await failing.routes.taskMoney(failing.own, failing.taskId)).toBeUndefined();
    const noCap = (JSON.parse((await failing.routes.route(get(`/v1/dev/tasks/${failing.taskId}`), failing.own))!.body) as { task: { money: unknown } }).task;
    expect(noCap.money).toMatchObject({ stop: { taskMaximumMicros: { state: "unavailable" } } });
    const unwired = await started({ wiring: { taskActions: undefined } });
    expect(await unwired.routes.taskMoney(unwired.own, unwired.taskId)).toBeUndefined();
  });
});

describe("Cloud #188 item 3: the old task routes on a core task reach the deployment's rules only for the caller's own company's task", () => {
  const RULES: Array<[string, string]> = [["GET", "people"], ["GET", "people/candidates"], ["POST", "people/add"], ["POST", "people/role"], ["POST", "people/take-ownership"], ["GET", "people/requests/r1"],
    ["GET", "readers"], ["PUT", `readers/${"c".repeat(64)}`], ["DELETE", `readers/${"c".repeat(64)}`], ["GET", "events"], ["GET", "comments"]];

  it("hands the owner's request, the task as read from their company and their company's store to the rules; another company's caller, a script token and a missing task never reach them", async () => {
    const route = vi.fn(async () => ({ statusCode: 200, headers: { "content-type": "application/json" }, body: "{\"ok\":true}" }));
    const { routes, own, remember, taskId } = await started({ wiring: { taskRules: { route, readsAsReader: async () => false } } });
    for (const [method, rest] of RULES) {
      const answer = await routes.route({ method, path: `/v1/dev/tasks/${taskId}/${rest}`, headers: {}, body: "{}" }, own);
      expect(answer?.statusCode, `${method} ${rest}`).toBe(200);
    }
    expect(route).toHaveBeenCalledTimes(RULES.length);
    const first = (route.mock.calls[0] as unknown as [{ person: unknown; companyId: string; task: { taskId: string; companyId: string } }])[0];
    expect(first.person).toEqual({ developerId: own.principal.personId, name: own.principal.displayName });
    expect(first.companyId).toBe(FAKE_COMPANY);
    expect(first.task).toMatchObject({ taskId, companyId: FAKE_COMPANY });
    route.mockClear();
    for (const [method, rest] of RULES) {
      const theirs = await routes.route({ method, path: `/v1/dev/tasks/${taskId}/${rest}`, headers: {}, body: "{}" }, remember(OTHER));
      expect(theirs?.statusCode, `${method} ${rest}`).toBe(404);
      expect(errorOf(theirs).code).toBe("TASK_NOT_FOUND");
      expect((await routes.route({ method, path: `/v1/dev/tasks/${taskId}/${rest}`, headers: {}, body: "{}" }, { ...own, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } }))?.statusCode, `token ${method} ${rest}`).toBe(404);
      expect((await routes.route({ method, path: `/v1/dev/tasks/${randomUUID()}/${rest}`, headers: {}, body: "{}" }, own))?.statusCode, `missing ${method} ${rest}`).toBe(404);
    }
    expect(route).not.toHaveBeenCalled();
  });

  it("owns only the old route table's methods on these paths; unwired, they are not the core's (undefined)", async () => {
    const route = vi.fn(async () => ({ statusCode: 200, headers: {}, body: "{}" }));
    const { routes, own, taskId } = await started({ wiring: { taskRules: { route, readsAsReader: async () => false } } });
    for (const [method, rest] of [["POST", "people"], ["GET", "people/role"], ["POST", "events"], ["POST", "readers"], ["GET", `readers/${"c".repeat(64)}`], ["POST", "comments"], ["GET", "people/requests"], ["GET", "people/requests/a/b"]] as const) {
      expect(await routes.route({ method, path: `/v1/dev/tasks/${taskId}/${rest}`, headers: {}, body: "" }, own), `${method} ${rest}`).toBeUndefined();
    }
    expect(route).not.toHaveBeenCalled();
    const unwired = await started();
    for (const [method, rest] of RULES) expect(await unwired.routes.route({ method, path: `/v1/dev/tasks/${unwired.taskId}/${rest}`, headers: {}, body: "{}" }, unwired.own), `${method} ${rest}`).toBeUndefined();
  });
});

describe("DEC 254zzz44 (a): the core task read asks the old reader rule only after its own rule said no, for the caller's own company's task", () => {
  it("never asks for the owner, a script token, another company's caller or a missing task; a yes reads the task, a no or a throw keeps the missing task's answer", async () => {
    const readsAsReader = vi.fn(async () => true);
    const route = vi.fn(async () => ({ statusCode: 200, headers: {}, body: "{}" }));
    const { routes, own, remember, taskId } = await started({ wiring: { taskRules: { route, readsAsReader } } });
    expect((await routes.route(get(`/v1/dev/tasks/${taskId}`), own))?.statusCode).toBe(200);
    expect((await routes.route(get(`/v1/dev/tasks/${taskId}`), { ...own, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } }))?.statusCode).toBe(200);
    expect((await routes.route(get(`/v1/dev/tasks/${taskId}`), remember(OTHER)))?.statusCode).toBe(404);
    expect((await routes.route(get(`/v1/dev/tasks/${randomUUID()}`), remember(FAKE_COMPANY, "member", "person-reader-00000000005")))?.statusCode).toBe(404);
    expect(readsAsReader).not.toHaveBeenCalled();
    const reader = remember(FAKE_COMPANY, "member", "person-reader-00000000005");
    const read = await routes.route(get(`/v1/dev/tasks/${taskId}`), reader);
    expect(read?.statusCode).toBe(200);
    expect(JSON.parse(read!.body)).toMatchObject({ task: { taskId } });
    expect(readsAsReader).toHaveBeenCalledWith(expect.objectContaining({ person: { developerId: reader.principal.personId, name: reader.principal.displayName }, companyId: FAKE_COMPANY, task: expect.objectContaining({ taskId, companyId: FAKE_COMPANY }) as unknown }));
    for (const answer of [async () => false, async () => { throw new Error("grant table down"); }]) {
      readsAsReader.mockImplementation(answer);
      expect((await routes.route(get(`/v1/dev/tasks/${taskId}`), reader))?.statusCode).toBe(404);
    }
  });
});

describe("DEC 254zzz44 (a): only the core rule's 'no such task' falls back to the reader rule", () => {
  it("a core read that fails for another reason stays a failure (never turned into a reader's read)", async () => {
    const readsAsReader = vi.fn(async () => true);
    const access = { ...ownerRule(), canRead: async () => { throw new Error("people store down"); } };
    const { routes, remember, taskId } = await started({ access, wiring: { taskRules: { route: vi.fn(), readsAsReader } } });
    await expect(routes.route(get(`/v1/dev/tasks/${taskId}`), remember(FAKE_COMPANY, "member", "person-reader-00000000006"))).rejects.toThrow("people store down");
    expect(readsAsReader).not.toHaveBeenCalled();
  });
});
