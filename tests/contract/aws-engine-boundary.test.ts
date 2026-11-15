// Lane E2 (plan v3.2), step 6 part: the AWS entry points go by a task's stored engine. A workflow task (no stamp) keeps today's AWS readers; a core task is answered by the core's
// own handlers (the core host's dev routes, company-aware) or refused exactly like a missing task, and no AWS reader returns its record, workspace or operations. A mixed stamp has one
// owner per operation (the flow's engine). A stamp that cannot be read is an error, never the workflow.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, sharedTaskKey, type JsonValue, type ProjectDefinition, type StoredDocument } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, engineStampKey, stampOf, type CoreHostApp, type EngineStamp } from "../../packages/broker/src/core-host/index.js";
import { NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import {
  TASK_ENTRY_AREAS, coreAnswerValue, coreTaskEntryFrom, entryOwner, ownerOfExistingTask, ownerOfTaskId, ownerOfWorkspace, taskEntryOperation, type CoreTaskEntry,
} from "../../packages/broker/src/aws/engine-boundary.js";
import { workspaceOwner } from "../../packages/broker/src/aws/admin-reads.js";
import { requireOperation } from "../../packages/broker/src/aws/cancellation.js";
import { getTaskPageState, getWorkflowFeedbackReview, listPageComments, loadOwnedTask } from "../../packages/broker/src/aws/developer-tasks.js";
import { resolveTaskAccess } from "../../packages/broker/src/developer/task-access.js";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SLACK_CHANNEL, SLACK_TEAM, loadSlackBroker } from "../support/slack-broker.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const STAMP = (areas: EngineStamp["areas"]): EngineStamp => ({ engine: areas.flow, areas, flags: "cc=on", stampedAt: "2026-11-15T00:00:00.000Z" });
const CORE = STAMP({ merge: "core", build: "core", flow: "core" });
const MIXED = STAMP({ merge: "workflow", build: "workflow", flow: "core" });
const INVERTED = STAMP({ merge: "core", build: "core", flow: "workflow" });
const WORKFLOW = STAMP({ merge: "workflow", build: "workflow", flow: "workflow" });

beforeAll(async () => { await loadSlackBroker(); });

// Every suffix routeDeveloperTaskRequest serves after `/v1/dev/tasks/<id>`, written out by hand.
const ROUTE_SUFFIXES = ["", "/events", "/plan", "/messages", "/diff", "/comments", "/people", "/people/role", "/people/take-ownership", "/people/requests/abc", "/readers", "/readers/abc",
  "/continue", "/cancel", "/close", "/pull-requests", "/share", "/workflow/decision", "/workflow/retry", "/workflow/review", "/workflow/publish-retry", "/workflow/keep-pull-requests",
  "/workflow/send-back", "/workflow/review-findings", "/workflow/feedback", "/workflow/feedback-decision", "/workflow/feedback-retry", "/canvas-closeout/retry", "/e2e-publication-context"];

describe("the owner of each operation, for every stamp", () => {
  it("names an operation for every developer task route, and none for anything else", () => {
    const named = ROUTE_SUFFIXES.map((suffix) => taskEntryOperation(suffix));
    expect(named.every((operation) => operation !== undefined)).toBe(true);
    expect(new Set(named)).toEqual(new Set(Object.keys(TASK_ENTRY_AREAS)));
    for (const other of ["/read", "/people/requests", "/nope", "events", "/workflow", "/readers/a/b", "/people/requests/a/b", "/__proto__", "/constructor"]) expect(taskEntryOperation(other), other).toBeUndefined();
  });

  it("is the workflow with no stamp or an unreadable one, and otherwise the flow's engine for every operation (a narrowed area never hands a task's rows to the other engine)", () => {
    for (const [operation, area] of Object.entries(TASK_ENTRY_AREAS)) {
      expect(entryOwner(undefined, area), operation).toBe("workflow");
      expect(entryOwner(WORKFLOW, area), operation).toBe("workflow");
      expect(entryOwner(CORE, area), operation).toBe("core");
      // flow = core with build and merge narrowed to the workflow: the core's, for its build and merge operations too.
      expect(entryOwner(MIXED, area), operation).toBe("core");
      // flow = workflow with core areas (no start writes this): the workflow's, whole.
      expect(entryOwner(INVERTED, area), operation).toBe("workflow");
    }
  });
});

describe("reading the stamp", () => {
  const table = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state" });
  it("a stamp item that is there but cannot be read as one is an error (only the core writes it), and so is a read that fails; neither is ever the workflow", async () => {
    const db = new FakeDynamoDb();
    const taskId = randomUUID();
    db.set({ ...engineStampKey(taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core" }, flags: "x", stampedAt: "y" } });
    await expect(ownerOfTaskId(table(db), taskId)).rejects.toThrow("a task's engine stamp could not be read");
    const failing = new FakeDynamoDb();
    failing.injectFault({ command: "GetCommand", error: { name: "ProvisionedThroughputExceededException" } });
    await expect(ownerOfTaskId(table(failing), randomUUID())).rejects.toThrow();
  });

  it("asks nothing for a malformed id; keeps a verdict only for a task that exists or a stamp that is there", async () => {
    const db = new FakeDynamoDb();
    const sent = vi.spyOn(db, "send");
    expect(await ownerOfTaskId(table(db), "not-a-task")).toBe("workflow");
    expect(sent).not.toHaveBeenCalled();
    // No task and no stamp yet: not kept, so a stamp written later is seen.
    const later = randomUUID();
    expect(await ownerOfTaskId(table(db), later)).toBe("workflow");
    db.set({ ...engineStampKey(later), coreEngine: CORE });
    expect(await ownerOfTaskId(table(db), later)).toBe("core");
    const another = randomUUID();
    expect(await ownerOfTaskId(table(db), another)).toBe("workflow");
    db.set({ ...engineStampKey(another), coreEngine: CORE });
    expect(await ownerOfExistingTask(table(db), another)).toBe("core");
    // An existing task's verdict is fixed: asked once.
    const existing = randomUUID();
    expect(await ownerOfExistingTask(table(db), existing)).toBe("workflow");
    const before = sent.mock.calls.length;
    expect(await ownerOfExistingTask(table(db), existing)).toBe("workflow");
    expect(sent.mock.calls.length).toBe(before);
  });

  it("a workspace with no task pointer is the workflow's; one whose task the core owns is the core's", async () => {
    const db = new FakeDynamoDb();
    const coreTask = randomUUID();
    db.set({ pk: "WORKSPACE#w-core", sk: "DEVELOPER_TASK", taskId: coreTask });
    db.set({ ...engineStampKey(coreTask), coreEngine: MIXED });
    db.set({ pk: "WORKSPACE#w-flow", sk: "DEVELOPER_TASK", taskId: randomUUID() });
    expect(await ownerOfWorkspace(table(db), "w-none")).toBe("workflow");
    expect(await ownerOfWorkspace(table(db), "w-flow")).toBe("workflow");
    expect(await ownerOfWorkspace(table(db), "w-core")).toBe("core");
  });

  it("reads the core's answer: a value for 200, the closed-list error otherwise, and fixed words for anything it cannot read (never echoed)", () => {
    expect(coreAnswerValue({ statusCode: 200, headers: {}, body: "{\"task\":{\"taskId\":\"t\"}}" })).toEqual({ task: { taskId: "t" } });
    expect(() => coreAnswerValue({ statusCode: 404, headers: {}, body: JSON.stringify({ error: { code: "TASK_NOT_FOUND", message: "task not found" } }) })).toThrow(expect.objectContaining({ code: "TASK_NOT_FOUND" }));
    expect(() => coreAnswerValue({ statusCode: 401, headers: {}, body: JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Sign in again." } }) })).toThrow(expect.objectContaining({ code: "AUTH_REQUIRED" }));
    for (const body of ["<html>secret-1</html>", JSON.stringify({ error: { code: "MADE_UP secret-2", message: "m" } }), JSON.stringify({ error: { code: "NOT_FOUND", message: 7 } }), "null"]) {
      let thrown: unknown;
      try { coreAnswerValue({ statusCode: 500, headers: {}, body }); } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect(String((thrown as Error).message)).not.toMatch(/secret|MADE_UP/u);
    }
  });
});

// ---- a core task, started by the core host over the fake world, with its rows in the AWS broker's table (one State table)

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

function appOver(world: FakeWorld): CoreHostApp {
  return createCoreHostApp({
    env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
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

/** A core task and the AWS broker sharing its table. MAYA is the core task's owner (the deployment's caller mapping); OMAR belongs to another company. */
async function coreWorld(options: { wired?: boolean; unknown?: "principal" | "membership"; newTasksOnWorkflow?: true } = {}) {
  const world = createFakeWorld();
  await registerProject(world, FAKE_COMPANY);
  await registerProject(world, OTHER);
  const app = appOver(world);
  const owner = localOwnerPrincipal({ companyId: FAKE_COMPANY });
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const { task } = await runtime.flow.start({ principal: owner, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  const principals = new Map<string, DeployedCaller>([[MAYA.developerId, { principal: owner, client: "cli" }], [OMAR.developerId, { principal: localOwnerPrincipal({ companyId: OTHER }), client: "cli" }]]);
  const members = new Map<string, CompanyMembership>([[`${owner.personId}${FAKE_COMPANY}`, { companyId: FAKE_COMPANY, role: "owner" }], [`${owner.personId}${OTHER}`, { companyId: OTHER, role: "owner" }]]);
  // OMAR signed in to the broker but unknown to the core: no principal for him, or a principal with no membership.
  if (options.unknown === "principal") principals.delete(OMAR.developerId);
  if (options.unknown === "membership") members.delete(`${owner.personId}${OTHER}`);
  const routes = createCoreDevRoutes({ app, companyOf: async (caller) => members.get(caller.principal.personId + caller.principal.companyId), wiring: () => ({ origin: () => "https://api.example" }) });
  const entry: CoreTaskEntry = coreTaskEntryFrom(routes, async (caller) => principals.get(caller.developerId));
  // Step 6: a start goes to the core where the switch sends the company's NEW tasks. `newTasksOnWorkflow`: the core still holds its task, but new ones start on the workflow (a narrowed switch).
  const coreTasks: CoreTaskEntry = options.newTasksOnWorkflow !== true ? entry : { route: async (request, caller) => (request.method === "POST" && request.path.split("?")[0] === "/v1/dev/tasks" ? undefined : await entry.route(request, caller)) };
  const harness = await createDeveloperTaskBroker(options.wired === false ? {} : { developerExtra: { coreTasks } });
  const rows = [
    ...await partition(world, `DEVTASK#${task.taskId}`), ...await partition(world, engineStampKey(task.taskId).pk),
    ...await partition(world, `WORKSPACE#${task.workspaceId}`), ...await partition(world, `DEVELOPER#${developerIdOf(owner)}`),
  ];
  expect(rows.some((row) => typeof row.sk === "string" && row.sk.startsWith("OPERATION#"))).toBe(true);
  for (const row of rows) harness.db.set(JSON.parse(JSON.stringify(row)) as Record<string, unknown> & { pk: string; sk: string });
  const coreRead = async () => await routes.route({ method: "GET", path: `/v1/dev/tasks/${task.taskId}`, headers: {} }, principals.get(MAYA.developerId)!);
  // Every state table request that names the core task's workspace: none may come from an AWS reader.
  const sent = vi.spyOn(harness.db, "send");
  const workspaceReads = () => sent.mock.calls.filter(([command]) => JSON.stringify((command as { input?: unknown }).input ?? {}).includes(task.workspaceId));
  // The broker stamps each answer with its own request id; the rest of the body is what is compared.
  const dev = async (...args: Parameters<typeof harness.dev>) => {
    const answer = await harness.dev(...args);
    const body = { ...answer.body };
    delete body.requestId;
    return { status: answer.status, body };
  };
  return { ...harness, dev, world, app, routes, coreTasks, task, owner, coreRead, sent, workspaceReads };
}

describe("a core task on the AWS developer routes", () => {
  it("is read through the core's own handlers: the same answer the core gives, and no AWS reader touches its workspace", async () => {
    const { dev, task, coreRead, workspaceReads } = await coreWorld();
    const own = await coreRead();
    expect(own?.statusCode).toBe(200);
    const read = await dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(JSON.parse(own!.body));
    expect(read.body).toMatchObject({ task: { taskId: task.taskId } });
    expect(workspaceReads()).toEqual([]);
  });

  it("answers another company's caller exactly like a task id that does not exist (the core decides; the words are the developer routes' own)", async () => {
    const { dev, task, workspaceReads, db } = await coreWorld();
    const coreRows = JSON.stringify(db.find((item) => String(item.pk).includes(task.taskId) || String(item.pk).includes(task.workspaceId)));
    // Every route and method, with and without input the route can parse: a missing id's answer includes the route's own input checks and wrong-method answer.
    for (const suffix of ROUTE_SUFFIXES) for (const method of ["GET", "POST"]) for (const body of [undefined, { requestId: randomUUID(), instructions: "Also log it" }]) {
      const missingId = randomUUID();
      const withId = (id: string) => (body === undefined ? undefined : { ...body, taskRef: id });
      const theirs = await dev(OMAR, method, `/v1/dev/tasks/${task.taskId}${suffix}`, withId(task.taskId));
      const missing = await dev(OMAR, method, `/v1/dev/tasks/${missingId}${suffix}`, withId(missingId));
      const label = `${method} ${suffix}`;
      expect(theirs.status, label).toBe(missing.status);
      expect(JSON.stringify(theirs.body).replaceAll(task.taskId, "<id>").replace(/"checkedAt":"[^"]+"/gu, ""), label).toBe(JSON.stringify(missing.body).replaceAll(missingId, "<id>").replace(/"checkedAt":"[^"]+"/gu, ""));
      expect(JSON.stringify(theirs.body), label).not.toContain(FAKE_COMPANY);
    }
    // The core task's rows are as they were.
    expect(JSON.stringify(db.find((item) => String(item.pk).includes(task.taskId) || String(item.pk).includes(task.workspaceId)))).toBe(coreRows);
    expect(workspaceReads()).toEqual([]);
  });

  it("tells the owner, in fixed words, that an operation the core has no handler for is not on the core here yet; never runs the workflow's handler", async () => {
    const { dev, task, workspaceReads, db } = await coreWorld();
    const before = JSON.stringify(db.find(() => true));
    for (const suffix of ["/continue", "/close", "/cancel", "/pull-requests", "/workflow/retry", "/workflow/decision", "/share"]) {
      const answer = await dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}${suffix}`, { requestId: randomUUID(), instructions: "more", decision: "APPROVE" });
      expect(answer.status, suffix).toBe(404);
      expect(answer.body, suffix).toEqual({ error: { code: "NOT_FOUND", message: NOT_ON_THE_CORE_YET } });
    }
    expect(JSON.stringify(db.find(() => true))).toBe(before);
    expect(workspaceReads()).toEqual([]);
  });

  it("with a mixed stamp (flow on the core, build and merge narrowed to the workflow) every operation stays the core's, build and merge ones included", async () => {
    const { dev, task, db, workspaceReads, coreRead } = await coreWorld();
    db.set({ ...(db.get(engineStampKey(task.taskId).pk, "STAMP") as Record<string, unknown> & { pk: string; sk: string }), coreEngine: MIXED });
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`)).body).toEqual(JSON.parse((await coreRead())!.body));
    for (const suffix of ["/continue", "/workflow/send-back", "/pull-requests", "/workflow/keep-pull-requests"]) {
      expect((await dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}${suffix}`, { requestId: randomUUID() })).body, suffix).toEqual({ error: { code: "NOT_FOUND", message: NOT_ON_THE_CORE_YET } });
    }
    expect(workspaceReads()).toEqual([]);
  });

  it("a percent-encoded core task id answers exactly like an encoded id with no task, at once (never loops, with or without the core's handlers)", async () => {
    for (const wired of [true, false]) {
      const { dev, task, workspaceReads } = await coreWorld({ wired });
      const encode = (id: string) => `%${id.charCodeAt(0).toString(16)}${id.slice(1)}`;
      const missingId = randomUUID();
      for (const [who, suffix] of [[OMAR, ""], [OMAR, "/events"], [MAYA, "/continue"]] as const) {
        const method = suffix === "/continue" ? "POST" : "GET";
        const body = method === "POST" ? { requestId: randomUUID(), instructions: "x" } : undefined;
        const theirs = await dev(who, method, `/v1/dev/tasks/${encode(task.taskId)}${suffix}`, body);
        const missing = await dev(who, method, `/v1/dev/tasks/${encode(missingId)}${suffix}`, body);
        if (who === OMAR || !wired) expect(JSON.stringify(theirs.body).replaceAll(task.taskId, "<id>"), `${String(wired)} ${suffix}`).toBe(JSON.stringify(missing.body).replaceAll(missingId, "<id>"));
        else expect(theirs.body).toEqual({ error: { code: "NOT_FOUND", message: NOT_ON_THE_CORE_YET } });
      }
      expect(workspaceReads()).toEqual([]);
    }
  }, 30_000);

  it("a signed-in caller the core does not know (no principal mapping, or no membership) gets a missing task's answer, not a sign-in refusal", async () => {
    for (const unknown of ["principal", "membership"] as const) {
      const { dev, task, workspaceReads } = await coreWorld({ unknown });
      for (const suffix of ["", "/continue"]) {
        const method = suffix === "" ? "GET" : "POST";
        const body = method === "POST" ? { requestId: randomUUID(), instructions: "x" } : undefined;
        const missingId = randomUUID();
        const theirs = await dev(OMAR, method, `/v1/dev/tasks/${task.taskId}${suffix}`, body);
        const missing = await dev(OMAR, method, `/v1/dev/tasks/${missingId}${suffix}`, body);
        expect(theirs.status, `${unknown} ${suffix}`).toBe(missing.status);
        expect(JSON.stringify(theirs.body).replaceAll(task.taskId, "<id>"), `${unknown} ${suffix}`).toBe(JSON.stringify(missing.body).replaceAll(missingId, "<id>"));
      }
      expect(workspaceReads()).toEqual([]);
    }
  });

  it("without the core's handlers on this install, reads exactly like a task that does not exist, for its owner too", async () => {
    const { dev, task, workspaceReads } = await coreWorld({ wired: false });
    const theirs = await dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`);
    const missingId = randomUUID();
    const missing = await dev(MAYA, "GET", `/v1/dev/tasks/${missingId}`);
    expect(theirs.status).toBe(404);
    expect(JSON.stringify(theirs.body).replaceAll(task.taskId, "<id>")).toBe(JSON.stringify(missing.body).replaceAll(missingId, "<id>"));
    expect(workspaceReads()).toEqual([]);
  });

  it("a stamp read that fails fails the request; the workflow's readers never answer in its place", async () => {
    const { dev, task, db, workspaceReads } = await coreWorld();
    db.injectFault({ command: "GetCommand", match: (input) => JSON.stringify(input).includes("TASK_ENGINE#"), error: { name: "ProvisionedThroughputExceededException" } });
    const answer = await dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`);
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(answer.body)).not.toContain("Add a /health endpoint");
    expect(workspaceReads()).toEqual([]);
  });
});

describe("the AWS readers see only workflow rows", () => {
  it("the task actions (READERS.md: workspace, operations, artifacts, pull requests, failed publications) answer nothing for a core task's workspace", async () => {
    const { actions, task } = await coreWorld();
    await expect(actions.workspace(task.workspaceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await actions.operations(task.workspaceId)).toEqual([]);
    expect(await actions.artifacts(task.workspaceId, "any")).toEqual([]);
    expect(await actions.pullRequests(task.workspaceId)).toEqual([]);
    expect(await actions.failedPublications(task.workspaceId, { repositoryId: "demo", candidateDigest: "d", treeSha: "t" })).toBe(0);
  });

  it("a workflow task's workspace still reads as before through the same actions", async () => {
    const { actions, dev, db } = await coreWorld({ newTasksOnWorkflow: true });
    const started = await dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const { workspaceId } = db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    expect((await actions.workspace(workspaceId)).id).toBe(workspaceId);
    expect((await actions.operations(workspaceId)).map((operation) => operation.kind)).toEqual(["prepare"]);
  });

  it("the workflow's task access and owned-task load refuse a core task exactly as a missing one", async () => {
    const { db, task, actions, brokerInput } = await coreWorld();
    // Even with the record made to look like the caller's own, the core's task is not read here.
    db.set({ ...(db.get(`DEVTASK#${task.taskId}`, "META") as Record<string, unknown> & { pk: string; sk: string }), developerId: MAYA.developerId });
    const deps = { documentClient: db, tableName: brokerInput.tableName, actions, checkAccess: async () => { throw new Error("never asked"); } } as never;
    const caller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name };
    await expect(resolveTaskAccess(deps, caller, task.taskId, "read")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(loadOwnedTask(deps, caller, task.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND", message: `TASK_NOT_FOUND: no task ${task.taskId} of yours` });
    // The task page's poll and comments and the PR feedback review page go through the same access.
    for (const page of [getTaskPageState, listPageComments, getWorkflowFeedbackReview]) await expect(page(deps, caller, task.taskId), page.name).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("the task list shows a core task's row as its index row says, and never works out or rewrites its status through the workflow", async () => {
    const { db, task, dev, workspaceReads } = await coreWorld();
    db.set({ ...(db.get(`DEVTASK#${task.taskId}`, "META") as Record<string, unknown> & { pk: string; sk: string }), developerId: MAYA.developerId });
    const row = { pk: `DEVELOPER#${MAYA.developerId}`, sk: `TASK#2026-11-15T00:00:00.000Z#${task.taskId}`, entityType: "DEVELOPER_TASK_INDEX", taskId: task.taskId, title: "Core work", project: "payments", status: "RUNNING", shared: false, createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z" };
    db.set(row);
    const writes: unknown[] = [];
    db.onWrite((change) => writes.push(change));
    const listed = await dev(MAYA, "GET", "/v1/dev/tasks");
    expect(listed.body).toEqual({ tasks: [{ taskId: task.taskId, title: "Core work", project: "payments", status: "RUNNING", shared: false, createdAt: row.createdAt, updatedAt: row.updatedAt }] });
    expect(writes).toEqual([]);
    expect(workspaceReads()).toEqual([]);
  });

  it("a Slack thread note on a core task's thread is refused, even where the workflow would take it from a legacy commenter, and nothing is written", async () => {
    const { db, task, handler } = await coreWorld();
    const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000100" };
    const record = db.get(`DEVTASK#${task.taskId}`, "META") as Record<string, unknown> & { pk: string; sk: string };
    db.set({ ...record, share: { teamId: thread.teamId, channelId: thread.channelId, threadTs: thread.threadTs, mode: "continue", sharedReason: "requested", sharedAt: "2026-11-15T00:00:00.000Z" } });
    db.set({ ...sharedTaskKey(thread), taskId: task.taskId, workflowThread: true, workspaceId: task.workspaceId, project: "payments" });
    const writes: unknown[] = [];
    db.onWrite((change) => writes.push(change));
    const answer = await handler({ source: "agentx.slack-ingress", action: "thread-note", taskId: task.taskId, userId: "U0TEAMMATE", thread, messageTs: "1695500002.000001", eventId: "Ev1", text: "Please also log it" });
    expect(answer).toMatchObject({ statusCode: 200, body: JSON.stringify({ outcome: "refused" }) });
    expect(writes).toEqual([]);
  });

  it("the admin console names a core task's workspace by its task only; it never reads the core's task record", async () => {
    const { db, task, brokerInput } = await coreWorld();
    const owner = await workspaceOwner({ documentClient: db, tableName: brokerInput.tableName } as never, { id: task.workspaceId, ownerKey: "k" } as never);
    expect(owner).toEqual({ origin: "ai_tool", owner: { taskId: task.taskId } });
  });

});

describe("the operation readers behind requireOperation see only workflow rows (T1 follow-up)", () => {
  const operationOf = async (db: FakeDynamoDb, workspaceId: string) => db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && String(item.sk).startsWith("OPERATION#"))[0] as { id: string; sk: string };
  const notHere = { code: "NOT_FOUND", message: `NOT_FOUND: ${NOT_ON_THE_CORE_YET}` };

  for (const entry of ["workflowBinding", "workflowCandidateSourceExportDigest", "requireOperation"] as const) {
    it(`${entry} answers a core task's operation with the fixed words and never reads the operation row`, async () => {
      const { db, task, actions, brokerInput } = await coreWorld();
      const operation = await operationOf(db, task.workspaceId);
      expect(operation).toBeDefined();
      const sent = vi.spyOn(db, "send");
      sent.mockClear();
      const read = entry === "requireOperation"
        ? requireOperation({ documentClient: db, tableName: brokerInput.tableName }, task.workspaceId, operation.id)
        : actions[entry](task.workspaceId, operation.id);
      await expect(read).rejects.toMatchObject(notHere);
      expect(sent.mock.calls.some(([command]) => JSON.stringify((command as { input?: unknown }).input ?? {}).includes(operation.sk))).toBe(false);
    });
  }

  it("a failed engine read fails the operation read; it is never taken for the workflow", async () => {
    const { db, task, actions } = await coreWorld();
    const operation = await operationOf(db, task.workspaceId);
    db.injectFault({ command: "GetCommand", match: (input) => JSON.stringify(input).includes("DEVELOPER_TASK"), error: { name: "ProvisionedThroughputExceededException" } });
    await expect(actions.workflowBinding(task.workspaceId, operation.id)).rejects.toMatchObject({ name: "ProvisionedThroughputExceededException" });
  });

  it("a workflow task's operation still reads through all three", async () => {
    const { actions, dev, db, brokerInput } = await coreWorld({ newTasksOnWorkflow: true });
    const started = await dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const { workspaceId } = db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    const operation = await operationOf(db, workspaceId);
    expect((await requireOperation({ documentClient: db, tableName: brokerInput.tableName }, workspaceId, operation.id)).id).toBe(operation.id);
    expect(await actions.workflowBinding(workspaceId, operation.id)).toBeUndefined();
    expect(await actions.workflowCandidateSourceExportDigest(workspaceId, operation.id)).toBeUndefined();
    await expect(actions.workflowBinding(workspaceId, "missing-operation")).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: operation not found" });
  });
});

describe("a task's start on the AWS developer route (lane E2 step 6)", () => {
  it("goes to the core for a member of a company the switch sends there: the core's task view, its rows on the core, none of the workflow's", async () => {
    const { dev, world, db } = await coreWorld();
    const started = await dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Add a /ready endpoint", workflow: true, workflowPath: "QUICK" });
    expect(started.status).toBe(200);
    const taskId = (started.body.task as { taskId: string }).taskId;
    expect(stampOf(await world.store.get(engineStampKey(taskId)))).toMatchObject({ engine: "core" });
    expect(db.get(`DEVTASK#${taskId}`, "META")).toBeUndefined();
  });

  it("stays the workflow's start for a caller the core's mapping names no company for, and without the core's handlers", async () => {
    const unknown = await coreWorld({ unknown: "principal" });
    const coreWrites = vi.spyOn(unknown.world.store, "transact");
    const theirs = await unknown.dev(OMAR, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
    expect(coreWrites).not.toHaveBeenCalled();
    const unwired = await coreWorld({ wired: false });
    const mine = await unwired.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
    expect(mine.status).toBe(200);
    expect(unwired.db.get(`DEVTASK#${(mine.body.task as { taskId: string }).taskId}`, "META")).toBeDefined();
    // The workflow's own start answered OMAR (his task rows are the workflow's when it let him start).
    if (theirs.status === 200) expect(unknown.db.get(`DEVTASK#${(theirs.body.task as { taskId: string }).taskId}`, "META")).toBeDefined();
    else expect(theirs.status).toBeLessThan(500);
  });
});
