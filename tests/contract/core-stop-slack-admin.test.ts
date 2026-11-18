// S2 (core switch-on gate, stacked on S1): Slack's thread stop, the Slack Stop button and the administrator's workspace cancel reach a core task's stop through the core's own authorized
// stop. Slack callers get the S1 rule (the task's owner, or a live owner/admin of the task's company), never weaker; the administrator cancel keeps its own checks (the claim, then an
// administrator grant on the task's project) and stops only a task of the workspace's own company. Unstamped (workflow) tasks are untouched.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, sharedTaskKey, type JsonValue, type ProjectDefinition, type StoredDocument } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { taskKey, taskPointerKey, workspaceKey, workspacePartition } from "../../packages/broker/src/core/task-flow/keys.js";
import { ADMIN_GRANT_MISSING, WORKSPACE_NOT_FOUND, stopWorkspaceAsAdministrator } from "../../packages/broker/src/core/task-flow/stop-request.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, engineStampKey, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { coreTaskEntryFrom, stopCoreTaskAs, type CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { coreAdminStop } from "../../packages/broker/src/aws/core-stop-entry.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, issuer, loadSlackBroker } from "../support/slack-broker.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const ADMIN = { subject: "admin-subject", admin: true };
/** Slack people: the task's owner, a colleague (a plain member), an admin of the task's company, and an admin of another company. */
const SLACK = { owner: "U0OWNER0001", colleague: "U0COLLEAG01", admin: "U0ADMIN0001", foreign: "U0FOREIGN01" } as const;
const THREAD = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000777" };

beforeAll(async () => { await loadSlackBroker(); });

const ownerRule = (): TaskFlowDeps["access"] => ({
  ...createOwnerTaskAccess(),
  async canAct(principal, task) { return principal.personId === task.developerId || developerIdOf(principal) === task.developerId; },
  ownerActing: async (principal, task) => (principal.personId === task.developerId || developerIdOf(principal) === task.developerId ? { actorId: task.ownerKey } : undefined),
});

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

async function partition(world: FakeWorld, pk: string): Promise<StoredDocument[]> {
  const items: StoredDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.store.query({ pk, ...(cursor === undefined ? {} : { cursor }) });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
}

/** A running core task of FAKE_COMPANY whose rows are in the broker's table, the core entry as the AWS root composes it (with the administrator stop), and the Slack people's memberships. */
/** The install administrators' live memberships, by grant owner key, as the AWS root reads them (Q2): ADMIN is a member of the task's company unless a test says otherwise. */
const ADMIN_KEY = ownerKeyForSubject(issuer, ADMIN.subject);
async function coreWorld(options: { adminStop?: boolean; adminCompanies?: Map<string, string | Error> } = {}) {
  const adminCompanies = options.adminCompanies ?? new Map<string, string | Error>([[ADMIN_KEY, FAKE_COMPANY]]);
  const world = createFakeWorld();
  await registerProject(world, FAKE_COMPANY);
  await registerProject(world, OTHER);
  const app: CoreHostApp = createCoreHostApp({
    env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: ownerRule(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
  const owner = localOwnerPrincipal({ companyId: FAKE_COMPANY });
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const { task } = await runtime.flow.start({ principal: owner, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  // The Slack person -> the principal the core knows (the deployment's caller mapping) and their live membership.
  const people = new Map<string, { principal: DeployedCaller["principal"]; membership: CompanyMembership }>([
    [developerIdForSlackUser(SLACK.owner), { principal: owner, membership: { companyId: FAKE_COMPANY, role: "member" } }],
    [developerIdForSlackUser(SLACK.colleague), { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: "person-colleague-01" }), membership: { companyId: FAKE_COMPANY, role: "member" } }],
    [developerIdForSlackUser(SLACK.admin), { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: "person-admin-000001" }), membership: { companyId: FAKE_COMPANY, role: "admin" } }],
    [developerIdForSlackUser(SLACK.foreign), { principal: localOwnerPrincipal({ companyId: OTHER, personId: "person-foreign-0001" }), membership: { companyId: OTHER, role: "owner" } }],
  ]);
  const byPerson = new Map([...people.values()].map((entry) => [`${entry.principal.personId}|${entry.principal.companyId}`, entry.membership]));
  const routes = createCoreDevRoutes({ app, companyOf: async (caller) => byPerson.get(`${caller.principal.personId}|${caller.principal.companyId}`), wiring: () => ({ origin: () => "https://api.example" }) });
  const entry = coreTaskEntryFrom(routes, async (caller) => { const found = people.get(caller.developerId); return found === undefined ? undefined : { principal: found.principal }; });
  // As the AWS root composes it: the workspace's company runtime (here, the one company that holds it).
  const coreTasks: CoreTaskEntry = options.adminStop === false ? entry : {
    route: (request, caller) => entry.route(request, caller),
    stopWorkspaceForAdmin: async (workspaceId, administrator, authorize) => stopWorkspaceAsAdministrator((await app.runtimeFor(FAKE_COMPANY)).flow.deps, workspaceId,
      { id: administrator.id, companyOf: async () => { const found = adminCompanies.get(administrator.id); if (found instanceof Error) throw found; return found; } }, authorize),
  };
  const harness = await createDeveloperTaskBroker({ developerExtra: { coreTasks } });
  const rows = [
    ...await partition(world, `DEVTASK#${task.taskId}`), ...await partition(world, engineStampKey(task.taskId).pk),
    ...await partition(world, workspacePartition(FAKE_COMPANY, task.workspaceId)), ...await partition(world, `WORKSPACE#${task.workspaceId}`),
  ];
  for (const row of rows) harness.db.set(JSON.parse(JSON.stringify(row)) as Record<string, unknown> & { pk: string; sk: string });
  const operationId = (await world.store.get({ pk: workspacePartition(FAKE_COMPANY, task.workspaceId), sk: "META" }))!["activeOperationId"] as string;
  const status = async () => (await world.store.get({ pk: workspacePartition(FAKE_COMPANY, task.workspaceId), sk: `OPERATION#${operationId}` }))?.["status"];
  /** The thread's shared record, naming the core task (as a share would). */
  const shareThread = (overrides: Record<string, unknown> = {}) => {
    const developerId = "e".repeat(64);
    harness.db.set({ ...sharedTaskKey(THREAD), taskId: task.taskId, workspaceId: task.workspaceId, ownerKey: taskOwnerKey(developerId, task.taskId), developerId, developerName: "Owner", project: "payments", mode: "continue", sharedAt: "2026-11-15T00:00:00.000Z", ...overrides });
  };
  const slackStop = async (userId: string) => {
    const response = await harness.handler({ source: "agentx.slack-ingress", action: "stop-task", thread: THREAD, userId });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  const stopButton = async (userId: string) => {
    const response = await harness.handler({ source: "agentx.slack-ingress", action: "workflow-close", taskId: task.taskId, userId, thread: THREAD, requestId: randomUUID(), stop: true });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  return { world, app, harness, task, status, shareThread, slackStop, stopButton, coreTasks };
}

describe("Slack's thread stop on a core task", () => {
  it("stops it for the task's owner through the core (the core step is cancelled)", async () => {
    const { shareThread, slackStop, status } = await coreWorld();
    shareThread();
    expect(await slackStop(SLACK.owner)).toMatchObject({ status: 200, body: { outcome: "CANCEL_REQUESTED" } });
    expect(await status()).toBe("CANCELLED");
  });

  it("stops it for a live admin of the task's company", async () => {
    const { shareThread, slackStop, status } = await coreWorld();
    shareThread();
    expect((await slackStop(SLACK.admin)).body).toMatchObject({ outcome: "CANCEL_REQUESTED" });
    expect(await status()).toBe("CANCELLED");
  });

  it("refuses a colleague who is no owner and no admin, an admin of another company and an unknown Slack person, as not the owner; nothing is stopped", async () => {
    const { shareThread, slackStop, status } = await coreWorld();
    shareThread();
    for (const who of [SLACK.colleague, SLACK.foreign, "U0NOBODY001"]) expect((await slackStop(who)).body, who).toEqual({ outcome: "NOT_OWNER", requestId: expect.any(String) as unknown });
    expect(await status()).not.toBe("CANCELLED");
  });

  it("stops nothing for a closed share or a channel now bound to another project", async () => {
    const { shareThread, slackStop, status } = await coreWorld();
    shareThread({ closedAt: "2026-11-15T01:00:00.000Z" });
    expect((await slackStop(SLACK.owner)).body).toMatchObject({ outcome: "NOTHING_RUNNING" });
    shareThread({ project: "another" });
    expect((await slackStop(SLACK.owner)).body).toMatchObject({ outcome: "NOTHING_RUNNING" });
    expect(await status()).not.toBe("CANCELLED");
  });

  it("never runs the workflow's cancel for a core task (no AWS cancel operation or outbox row is written)", async () => {
    const { shareThread, slackStop, harness } = await coreWorld();
    shareThread();
    await slackStop(SLACK.colleague);
    await slackStop(SLACK.owner);
    expect(harness.db.find((item) => item.entityType === "OUTBOX" || (item.entityType === "OPERATION" && item.kind === "cancel"))).toEqual([]);
  });
});

describe("the Slack Stop button on a core task", () => {
  it("stops the running step for its owner and for a live company admin (the core closes nothing here)", async () => {
    for (const who of [SLACK.owner, SLACK.admin]) {
      const { stopButton, status } = await coreWorld();
      expect(await stopButton(who), who).toMatchObject({ status: 200, body: { stopped: "cancelling" } });
      expect(await status(), who).toBe("CANCELLED");
    }
  });

  it("refuses a colleague, another company's admin and an unknown person with the broker's owner-only refusal; nothing is stopped", async () => {
    const { stopButton, status } = await coreWorld();
    for (const who of [SLACK.colleague, SLACK.foreign, "U0NOBODY001"]) {
      // The broker's own refusal for a workflow press that is not the owner's.
      expect(await stopButton(who), who).toMatchObject({ status: 200, body: { refused: true, message: "Only the task owner can do that." } });
    }
    expect(await status()).not.toBe("CANCELLED");
  });
});

describe("the administrator's workspace cancel on a core task's workspace", () => {
  it("stops it for an administrator with the grant on the task's project, through the core", async () => {
    const { harness, task, status } = await coreWorld();
    const answer = await call(harness.handler, { method: "POST", path: `/v1/admin/workspaces/${task.workspaceId}/cancel`, user: ADMIN });
    expect(answer).toMatchObject({ status: 202, body: { outcome: "CANCEL_REQUESTED", workspaceId: task.workspaceId, taskId: task.taskId } });
    expect(await status()).toBe("CANCELLED");
    const again = await call(harness.handler, { method: "POST", path: `/v1/admin/workspaces/${task.workspaceId}/cancel`, user: ADMIN });
    expect(again.body).toMatchObject({ outcome: "NOTHING_RUNNING" });
  });

  it("refuses a caller without the administrator claim, and one without the grant on the task's project; nothing is stopped", async () => {
    const { harness, task, status } = await coreWorld();
    expect((await call(harness.handler, { method: "POST", path: `/v1/admin/workspaces/${task.workspaceId}/cancel`, user: { subject: "not-an-admin" } })).status).toBe(403);
    // An administrator with no grant on the project: the route's own membership refusal.
    expect((await call(harness.handler, { method: "POST", path: `/v1/admin/workspaces/${task.workspaceId}/cancel`, user: { subject: "other-admin", admin: true } }))).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    expect(await status()).not.toBe("CANCELLED");
  });

  it("golden (Q2): an administrator of the task's own company with the grant gets exactly the answer it got before the company check", async () => {
    const { harness, task, status } = await coreWorld();
    const answer = await call(harness.handler, { method: "POST", path: `/v1/admin/workspaces/${task.workspaceId}/cancel`, user: ADMIN });
    expect(answer).toEqual({ status: 202, body: { outcome: "CANCEL_REQUESTED", workspaceId: task.workspaceId, taskId: task.taskId, requestId: expect.any(String) as unknown } });
    expect(await status()).toBe("CANCELLED");
  });

  it("two companies (Q2): an administrator whose grant names 'payments' but whose membership is another company's is refused on this company's 'payments' task with exactly the no-grant answer; nothing is stopped", async () => {
    const noGrant = { subject: "other-admin", admin: true };
    const { harness, task, status, world } = await coreWorld({ adminCompanies: new Map([[ADMIN_KEY, OTHER], [ownerKeyForSubject(issuer, noGrant.subject), FAKE_COMPANY]]) });
    const path = `/v1/admin/workspaces/${task.workspaceId}/cancel`;
    const foreign = await call(harness.handler, { method: "POST", path, user: ADMIN });
    // The same company's administrator without any grant: the route's own refusal (requireAdministrator), read the same way.
    const missing = await call(harness.handler, { method: "POST", path, user: noGrant });
    expect(missing).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: ADMIN_GRANT_MISSING } } });
    const withoutRequestId = (answer: { status: number; body: Record<string, unknown> }) => JSON.stringify({ ...answer, body: { ...answer.body, requestId: "<id>" } });
    expect(withoutRequestId(foreign)).toBe(withoutRequestId(missing));
    expect(await status()).not.toBe("CANCELLED");
    expect(world.audit.filter((event) => event.action === "task.stop_requested")).toEqual([]);
  });

  it("two companies (Q2): no membership, a membership that can't be read (its cause never shown) and the other company's membership all read as the missing grant; nothing is stopped", async () => {
    for (const held of [undefined, new Error("sign-in table timed out at shard 7"), OTHER] as const) {
      const { harness, task, status } = await coreWorld({ adminCompanies: new Map(held === undefined ? [] : [[ADMIN_KEY, held]]) });
      const answer = await call(harness.handler, { method: "POST", path: `/v1/admin/workspaces/${task.workspaceId}/cancel`, user: ADMIN });
      expect(answer).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: ADMIN_GRANT_MISSING } } });
      expect(JSON.stringify(answer)).not.toMatch(/shard|timed out|org_/u);
      expect(await status()).not.toBe("CANCELLED");
    }
  });

  it("without the core's administrator stop on the install, answers a core workspace as before (a missing workspace)", async () => {
    const { harness, task, status } = await coreWorld({ adminStop: false });
    const answer = await call(harness.handler, { method: "POST", path: `/v1/admin/workspaces/${task.workspaceId}/cancel`, user: ADMIN });
    expect(answer).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    expect(await status()).not.toBe("CANCELLED");
  });

  it("golden: a workflow (unstamped) workspace's cancel answers and writes as with no core entry", async () => {
    const run = async (harness: Awaited<ReturnType<typeof createDeveloperTaskBroker>>) => {
      const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: "22222222-2222-4222-8222-222222222222", project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
      const taskId = (started.body.task as { taskId: string }).taskId;
      const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
      const writes: string[] = [];
      const stop = harness.db.onWrite((change) => writes.push(Object.keys(change).join()));
      const answer = await call(harness.handler, { method: "POST", path: `/v1/admin/workspaces/${workspaceId}/cancel`, user: ADMIN });
      stop();
      return { answer: JSON.stringify(answer).replaceAll(workspaceId, "<w>").replace(/"[0-9a-f-]{36}"/gu, "\"<id>\""), writes };
    };
    const { coreTasks } = await coreWorld();
    const without = await run(await createDeveloperTaskBroker());
    const withCore = await run(await createDeveloperTaskBroker({ developerExtra: { coreTasks: { ...coreTasks, route: async () => undefined } } }));
    expect(withCore.answer).toBe(without.answer);
    expect(withCore.writes).toEqual(without.writes);
  });
});

describe("the core's administrator stop (stopWorkspaceAsAdministrator)", () => {
  it("asks the route's project check with the task's own project, and stops nothing when it refuses", async () => {
    const { app, world, task, status } = await coreWorld();
    const deps = (await app.runtimeFor(FAKE_COMPANY)).flow.deps;
    // The project comes from the stored task, whatever it is named.
    const record = (await world.store.get(taskKey(task.taskId)))!;
    await world.store.put({ item: { ...record, project: "ledger" } });
    const asked: string[] = [];
    await expect(stopWorkspaceAsAdministrator(deps, task.workspaceId, { id: "admin", companyOf: async () => FAKE_COMPANY }, async (project) => { asked.push(project); throw new Error("no grant"); })).rejects.toThrow("no grant");
    expect(asked).toEqual(["ledger"]);
    expect(await status()).not.toBe("CANCELLED");
  });

  it("a closed task: the project check still comes first (no grant reads its refusal); with the grant, nothing runs and nothing is stopped", async () => {
    const { app, world, task, status } = await coreWorld();
    const deps = (await app.runtimeFor(FAKE_COMPANY)).flow.deps;
    const record = (await world.store.get(taskKey(task.taskId)))!;
    await world.store.put({ item: { ...record, closedAt: "2026-11-15T10:00:00.000Z" } });
    await expect(stopWorkspaceAsAdministrator(deps, task.workspaceId, { id: "admin", companyOf: async () => FAKE_COMPANY }, async () => { throw new Error("no grant"); })).rejects.toThrow("no grant");
    expect(await stopWorkspaceAsAdministrator(deps, task.workspaceId, { id: "admin", companyOf: async () => FAKE_COMPANY }, async () => undefined)).toEqual({ taskId: task.taskId, nothingRunning: true });
    expect(await status()).not.toBe("CANCELLED");
    expect(world.audit.filter((event) => event.action === "task.stop_requested")).toEqual([]);
  });

  it("an administrator's stop leaves a task.stop_requested audit line naming the administrator", async () => {
    const { app, world, task } = await coreWorld();
    const deps = (await app.runtimeFor(FAKE_COMPANY)).flow.deps;
    await stopWorkspaceAsAdministrator(deps, task.workspaceId, { id: "admin-owner-key", companyOf: async () => FAKE_COMPANY }, async () => undefined);
    expect(world.audit.filter((event) => event.action === "task.stop_requested").map((event) => ({ actor: event.actor, details: event.details }))).toEqual([{ actor: { type: "person", id: "admin-owner-key" }, details: { project: "payments", by: "install-admin" } }]);
  });

  it("two companies: another company's runtime never stops this company's workspace (a missing workspace's words), and an unknown workspace reads the same", async () => {
    const { app, task, status } = await coreWorld();
    const other = (await app.runtimeFor(FAKE_COMPANY)).flow.deps;
    const authorize = vi.fn(async () => undefined);
    await expect(stopWorkspaceAsAdministrator({ ...other, companyId: OTHER }, task.workspaceId, { id: "admin", companyOf: async () => FAKE_COMPANY }, authorize)).rejects.toMatchObject({ code: "NOT_FOUND", message: `NOT_FOUND: ${WORKSPACE_NOT_FOUND}` });
    await expect(stopWorkspaceAsAdministrator(other, randomUUID(), { id: "admin", companyOf: async () => FAKE_COMPANY }, authorize)).rejects.toMatchObject({ code: "NOT_FOUND", message: `NOT_FOUND: ${WORKSPACE_NOT_FOUND}` });
    expect(authorize).not.toHaveBeenCalled();
    expect(await status()).not.toBe("CANCELLED");
  });
});

describe("the administrator's company (Q2: a grant names a project by name only)", () => {
  it("binds the grant to the stored task's company: another company's administrator, no company and an unreadable one are refused before the project check, in the missing grant's words", async () => {
    const { app, task, status, world } = await coreWorld();
    const deps = (await app.runtimeFor(FAKE_COMPANY)).flow.deps;
    const authorize = vi.fn(async () => undefined);
    const companies: Array<() => Promise<string | undefined>> = [async () => OTHER, async () => undefined, async () => { throw new Error("membership read failed: secret-cause"); }];
    for (const companyOf of companies) {
      const refused = stopWorkspaceAsAdministrator(deps, task.workspaceId, { id: "admin", companyOf }, authorize);
      await expect(refused).rejects.toMatchObject({ code: "NOT_FOUND", message: `NOT_FOUND: ${ADMIN_GRANT_MISSING}` });
      await expect(refused).rejects.not.toThrow(/secret-cause/u);
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(await status()).not.toBe("CANCELLED");
    expect(world.audit.filter((event) => event.action === "task.stop_requested")).toEqual([]);
    // The task's own company: the project check is asked and the stop runs.
    expect(await stopWorkspaceAsAdministrator(deps, task.workspaceId, { id: "admin", companyOf: async () => FAKE_COMPANY }, authorize)).toEqual({ taskId: task.taskId, nothingRunning: false });
    expect(authorize).toHaveBeenCalledWith("payments");
    expect(await status()).toBe("CANCELLED");
  });

  it("the task's company decides, not the runtime's: a task row naming another company is a missing workspace before any company check", async () => {
    const { app, world, task } = await coreWorld();
    const deps = (await app.runtimeFor(FAKE_COMPANY)).flow.deps;
    const record = (await world.store.get(taskKey(task.taskId)))!;
    await world.store.put({ item: { ...record, companyId: OTHER } });
    const companyOf = vi.fn(async () => OTHER);
    await expect(stopWorkspaceAsAdministrator(deps, task.workspaceId, { id: "admin", companyOf }, async () => undefined)).rejects.toMatchObject({ code: "NOT_FOUND", message: `NOT_FOUND: ${WORKSPACE_NOT_FOUND}` });
    expect(companyOf).not.toHaveBeenCalled();
  });

  it("a closed task of this company is refused to another company's administrator too (the company check comes before the closed answer)", async () => {
    const { app, world, task } = await coreWorld();
    const deps = (await app.runtimeFor(FAKE_COMPANY)).flow.deps;
    const record = (await world.store.get(taskKey(task.taskId)))!;
    await world.store.put({ item: { ...record, closedAt: "2026-11-15T10:00:00.000Z" } });
    await expect(stopWorkspaceAsAdministrator(deps, task.workspaceId, { id: "admin", companyOf: async () => OTHER }, async () => undefined)).rejects.toMatchObject({ code: "NOT_FOUND", message: `NOT_FOUND: ${ADMIN_GRANT_MISSING}` });
  });
});

describe("pointers that name a task they do not hold", () => {
  it("a workspace of company B whose pointer names company A's task, and a workspace of company A whose pointer names a task of another workspace, both read as missing; nothing is stopped", async () => {
    const { app, world, task, status } = await coreWorld();
    const deps = (await app.runtimeFor(FAKE_COMPANY)).flow.deps;
    const authorize = vi.fn(async () => undefined);
    // Company B's copy of the same workspace id, naming company A's task: only the task's company tells them apart.
    const foreign = task.workspaceId;
    await world.store.put({ item: { ...workspaceKey(OTHER, foreign), entityType: "WORKSPACE", id: foreign, companyId: OTHER, ownerKey: "k", status: "READY", activeOperationId: null } });
    await world.store.put({ item: { ...taskPointerKey(OTHER, foreign), taskId: task.taskId } });
    await expect(stopWorkspaceAsAdministrator({ ...deps, companyId: OTHER }, foreign, { id: "admin", companyOf: async () => FAKE_COMPANY }, authorize)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const stray = randomUUID();
    await world.store.put({ item: { ...workspaceKey(FAKE_COMPANY, stray), entityType: "WORKSPACE", id: stray, companyId: FAKE_COMPANY, ownerKey: "k", status: "READY", activeOperationId: null } });
    await world.store.put({ item: { ...taskPointerKey(FAKE_COMPANY, stray), taskId: task.taskId } });
    await expect(stopWorkspaceAsAdministrator(deps, stray, { id: "admin", companyOf: async () => FAKE_COMPANY }, authorize)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(authorize).not.toHaveBeenCalled();
    expect(await status()).not.toBe("CANCELLED");
  });
});

describe("coreAdminStop", () => {
  it("refuses a caller without the administrator claim before the core is asked, even when the project check would pass", async () => {
    const { harness, coreTasks, task, status } = await coreWorld();
    const stop = vi.spyOn(coreTasks, "stopWorkspaceForAdmin");
    await expect(coreAdminStop({ documentClient: harness.db, tableName: harness.brokerInput.tableName }, coreTasks, { isAdministrator: false, ownerKey: "k" }, task.workspaceId, async () => undefined)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(stop).not.toHaveBeenCalled();
    expect(await status()).not.toBe("CANCELLED");
  });
});

describe("a plain close (no Stop) on a core task", () => {
  it("is not the core's stop: it falls to the workflow's close, which refuses a core task; nothing is stopped", async () => {
    const { harness, task, status, coreTasks } = await coreWorld();
    const route = vi.spyOn(coreTasks, "route");
    const response = await harness.handler({ source: "agentx.slack-ingress", action: "workflow-close", taskId: task.taskId, userId: SLACK.owner, thread: THREAD, requestId: randomUUID() });
    expect(JSON.parse(response.body)).toMatchObject({ refused: true });
    expect(route).not.toHaveBeenCalledWith(expect.objectContaining({ path: `/v1/dev/tasks/${task.taskId}/cancel` }), expect.anything());
    expect(await status()).not.toBe("CANCELLED");
  });
});

describe("the Stop button on a workflow (unstamped) task", () => {
  it("never asks the core (the workflow's own Stop runs as before)", async () => {
    const { harness, coreTasks } = await coreWorld();
    const route = vi.spyOn(coreTasks, "route");
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    route.mockClear();
    await harness.handler({ source: "agentx.slack-ingress", action: "workflow-close", taskId, userId: SLACK.owner, thread: THREAD, requestId: randomUUID(), stop: true });
    await harness.handler({ source: "agentx.slack-ingress", action: "stop-task", thread: THREAD, userId: SLACK.owner });
    expect(route).not.toHaveBeenCalled();
  });
});

describe("stopCoreTaskAs", () => {
  it("is 'stopped' only for the core's 200; no entry, a malformed id, a refusal or no answer are 'refused'", async () => {
    const caller = { developerId: "x", sessionId: "s", name: "n" };
    const id = randomUUID();
    expect(await stopCoreTaskAs(undefined, caller, id)).toBe("refused");
    expect(await stopCoreTaskAs({ route: async () => ({ statusCode: 200, headers: {}, body: "{}" }) }, caller, "not-a-task")).toBe("refused");
    for (const statusCode of [401, 403, 404, 409, 500]) expect(await stopCoreTaskAs({ route: async () => ({ statusCode, headers: {}, body: "{}" }) }, caller, id), String(statusCode)).toBe("refused");
    expect(await stopCoreTaskAs({ route: async () => undefined }, caller, id)).toBe("refused");
    const route = vi.fn(async () => ({ statusCode: 200, headers: {}, body: "{}" }));
    expect(await stopCoreTaskAs({ route }, caller, id)).toBe("stopped");
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", path: `/v1/dev/tasks/${id}/cancel` }), caller);
  });
});
