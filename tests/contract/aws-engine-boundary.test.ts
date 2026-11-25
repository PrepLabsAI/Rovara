import { legacyWorkspaceKey } from "../../packages/broker/src/core/task-flow/legacy-keys.js";
// Lane E2 (plan v3.2), step 6 part: the AWS entry points go by a task's stored engine. A workflow task (no stamp) keeps today's AWS readers; a core task is answered by the core's
// own handlers (the core host's dev routes, company-aware) or refused exactly like a missing task, and no AWS reader returns its record, workspace or operations. A mixed stamp has one
// owner per operation (the flow's engine). A stamp that cannot be read is an error, never the workflow.
import { taskKey as coreTaskKey, workspacePartition } from "../../packages/broker/src/core/task-flow/keys.js";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DeveloperTaskDetailedListResponseSchema, endStuckUnderstand, orgProjectCatalogKey, projectRevisionKey, recordIntentAssessment, sharedTaskKey, startWorkflowUnderstand, type JsonValue, type ProjectDefinition, type StoredDocument } from "@agentx/contracts";
import { readTask as readCoreTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { commitWorkflow } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { writeInvolvedRow } from "../../packages/broker/src/core/task-flow/involved.js";
import { createCoreHostApp, coreTaskMarkKey, coreTaskMarkOf, type CoreHostApp, type CoreTaskMark } from "../../packages/broker/src/core-host/index.js";
import { NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { TASK_ENTRY_OPERATIONS, coreAnswerValue, coreTaskEntryFrom, isCoreTask, isCoreWorkspace, taskEntryOperation, type CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { workspaceOwner } from "../../packages/broker/src/aws/admin-reads.js";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SLACK_CHANNEL, SLACK_TEAM, loadSlackBroker } from "../support/slack-broker.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
// Switch blocker honest-ci (#680): a deployment hands in the project's own CI mode reader.
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const STAMP = (areas: CoreTaskMark["areas"]): CoreTaskMark => ({ engine: areas.flow, areas, flags: "cc=on", stampedAt: "2026-11-15T00:00:00.000Z" });
const CORE = STAMP({ merge: "core", build: "core", flow: "core" });

beforeAll(async () => { await loadSlackBroker(); });

// Every suffix routeDeveloperTaskRequest serves after `/v1/dev/tasks/<id>`, written out by hand.
const ROUTE_SUFFIXES = ["", "/events", "/plan", "/messages", "/diff", "/comments", "/people", "/people/role", "/people/take-ownership", "/people/candidates", "/people/add", "/people/requests/abc", "/readers", "/readers/abc",
  "/continue", "/cancel", "/close", "/pull-requests", "/share", "/workflow/decision", "/workflow/retry", "/workflow/review", "/workflow/publish-retry", "/workflow/keep-pull-requests",
  "/workflow/send-back", "/workflow/review-findings", "/workflow/feedback", "/workflow/feedback-decision", "/workflow/feedback-retry", "/canvas-closeout/retry", "/e2e-publication-context", "/answers", "/evidence"];

describe("the owner of each operation, for every stamp", () => {
  it("names an operation for every developer task route, and none for anything else", () => {
    const named = ROUTE_SUFFIXES.map((suffix) => taskEntryOperation(suffix));
    expect(named.every((operation) => operation !== undefined)).toBe(true);
    expect(new Set(named)).toEqual(new Set(TASK_ENTRY_OPERATIONS));
    for (const other of ["/read", "/people/requests", "/nope", "events", "/workflow", "/readers/a/b", "/people/requests/a/b", "/__proto__", "/constructor"]) expect(taskEntryOperation(other), other).toBeUndefined();
  });

  it("is the core's when the task's mark is there, whatever its areas say, and no core task's with no mark (the old workflow is retired, D1-2c)", async () => {
    const db = new FakeDynamoDb();
    const table = { documentClient: db, tableName: "state" };
    const [none, core, areasWorkflow] = [randomUUID(), randomUUID(), randomUUID()];
    db.set({ ...coreTaskMarkKey(core), coreEngine: CORE });
    // No start writes any mark but the core's; a mark of another shape that reads as one is still the mark, so it is the core's.
    db.set({ ...coreTaskMarkKey(areasWorkflow), coreEngine: STAMP({ merge: "workflow", build: "workflow", flow: "workflow" }) });
    expect(await isCoreTask(table, none)).toBe(false);
    expect(await isCoreTask(table, core)).toBe(true);
    expect(await isCoreTask(table, areasWorkflow)).toBe(true);
    // A malformed id is no core task's, and is not read.
    expect(await isCoreTask(table, "not-an-id")).toBe(false);
  });
});

describe("reading the stamp", () => {
  const table = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state" });
  it("a stamp item that is there but cannot be read as one is an error (only the core writes it), and so is a read that fails; neither is ever not the core's", async () => {
    const db = new FakeDynamoDb();
    const taskId = randomUUID();
    db.set({ ...coreTaskMarkKey(taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core" }, flags: "x", stampedAt: "y" } });
    await expect(isCoreTask(table(db), taskId)).rejects.toThrow("a task's engine stamp could not be read");
    const failing = new FakeDynamoDb();
    failing.injectFault({ command: "GetCommand", error: { name: "ProvisionedThroughputExceededException" } });
    await expect(isCoreTask(table(failing), randomUUID())).rejects.toThrow();
  });

  it("never uses a discovery pointer alone or a cached engine verdict to bypass scoped ownership", async () => {
    const db = new FakeDynamoDb();
    const workspaceId = randomUUID(), taskId = randomUUID();
    const integrity = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId, companyId: FAKE_COMPANY });
    // A legacy task pointer must never be a fallback for a company discovery pointer.
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK", taskId });
    db.set({ ...coreTaskMarkKey(taskId), coreEngine: CORE });
    await expect(isCoreWorkspace(table(db), workspaceId)).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: workspace unavailable" });
    expect(integrity.mock.calls).toEqual([[{ component: "broker", event: "workspace.pointer_integrity" }]]);
    integrity.mockClear();
    const scoped = { pk: workspacePartition(FAKE_COMPANY, workspaceId), sk: "META", entityType: "WORKSPACE", companyId: FAKE_COMPANY };
    db.set(scoped);
    db.set({ pk: scoped.pk, sk: "DEVELOPER_TASK", taskId });
    expect(await isCoreWorkspace(table(db), workspaceId)).toBe(true);
    db.set({ ...scoped, companyId: OTHER });
    await expect(isCoreWorkspace(table(db), workspaceId)).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: workspace unavailable" });
    expect(integrity.mock.calls).toEqual([[{ component: "broker", event: "workspace.pointer_integrity" }]]);
    integrity.mockRestore();
  });

  // D1 pre-review MUST-3: a workspace with no company discovery pointer is the core's only when the task its pointer names is stamped.
  it("a legacy workspace is the core's only when its task pointer names a stamped task: no pointer, an unstamped task or a malformed task id is not", async () => {
    const pointerTo = (db: FakeDynamoDb, workspaceId: string, taskId: unknown) => db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK", taskId });
    const none = new FakeDynamoDb();
    expect(await isCoreWorkspace(table(none), randomUUID())).toBe(false);
    const unstamped = new FakeDynamoDb(), unstampedWorkspace = randomUUID();
    pointerTo(unstamped, unstampedWorkspace, randomUUID());
    expect(await isCoreWorkspace(table(unstamped), unstampedWorkspace)).toBe(false);
    const malformed = new FakeDynamoDb(), malformedWorkspace = randomUUID();
    pointerTo(malformed, malformedWorkspace, "not-a-task-id");
    const stampReads: string[] = [];
    const watched = { send: async (command: unknown) => { const key = (command as { input?: { Key?: { pk?: string } } }).input?.Key?.pk ?? ""; if (key.startsWith("TASK_ENGINE#")) stampReads.push(key); return malformed.send(command as never); } };
    expect(await isCoreWorkspace({ documentClient: watched, tableName: "state" }, malformedWorkspace)).toBe(false);
    // a malformed id is answered without asking for any stamp
    expect(stampReads).toEqual([]);
    const stamped = new FakeDynamoDb(), stampedWorkspace = randomUUID(), stampedTask = randomUUID();
    pointerTo(stamped, stampedWorkspace, stampedTask);
    stamped.set({ ...engineStampKey(stampedTask), coreEngine: CORE });
    expect(await isCoreWorkspace(table(stamped), stampedWorkspace)).toBe(true);
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

function appOver(world: FakeWorld, access: TaskFlowDeps["access"] = createOwnerTaskAccess(), understandFirst = false): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI, ...(understandFirst ? { flowOptions: { understandFirst: true } } : {}) }),
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
/** The company's owner rule as a deployment wires it (DECISIONS 198): only the person the task runs for acts as its owner. */
const ownerRule = (): TaskFlowDeps["access"] => ({
  ...createOwnerTaskAccess(),
  ownerActing: async (principal, task) => (principal.personId === task.developerId || developerIdOf(principal) === task.developerId ? { actorId: task.ownerKey } : undefined),
});

async function coreWorld(options: { access?: TaskFlowDeps["access"]; withoutReadable?: true; wired?: boolean; unknown?: "principal" | "membership"; actions?: boolean; newTasksOnWorkflow?: true; understand?: true; roundCap?: () => Promise<{ limitUsd: number; spentUsd: number | undefined } | undefined> } = {}) {
  const world = createFakeWorld();
  await registerProject(world, FAKE_COMPANY);
  await registerProject(world, OTHER);
  const app = appOver(world, options.access ?? (options.actions === true ? ownerRule() : createOwnerTaskAccess()), options.understand === true);
  const owner = localOwnerPrincipal({ companyId: FAKE_COMPANY });
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const { task } = await runtime.flow.start({ principal: owner, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, ...(options.understand === true ? {} : { workflowPath: "QUICK" as const }) });
  const principals = new Map<string, DeployedCaller>([[MAYA.developerId, { principal: owner, client: "cli" }], [OMAR.developerId, { principal: localOwnerPrincipal({ companyId: OTHER }), client: "cli" }]]);
  const members = new Map<string, CompanyMembership>([[`${owner.personId}${FAKE_COMPANY}`, { companyId: FAKE_COMPANY, role: "owner" }], [`${owner.personId}${OTHER}`, { companyId: OTHER, role: "owner" }]]);
  // OMAR signed in to the broker but unknown to the core: no principal for him, or a principal with no membership.
  if (options.unknown === "principal") principals.delete(OMAR.developerId);
  if (options.unknown === "membership") members.delete(`${owner.personId}${OTHER}`);
  const routes = createCoreDevRoutes({ app, companyOf: async (caller) => members.get(caller.principal.personId + caller.principal.companyId), wiring: () => ({ origin: () => "https://api.example", ...(options.actions === true ? { taskActions: { roundCap: options.roundCap ?? (async () => undefined) } } : {}) }) });
  const wholeEntry: CoreTaskEntry = coreTaskEntryFrom(routes, async (caller) => principals.get(caller.developerId));
  // `withoutReadable`: a deployment that wires the money read but not the readable check (the list must then give no round).
  const entry: CoreTaskEntry = options.withoutReadable === true ? { route: (request, caller) => wholeEntry.route(request, caller), taskMoney: (caller, taskId) => wholeEntry.taskMoney!(caller, taskId) } : wholeEntry;
  // Step 6: a start goes to the core where the switch sends the company's NEW tasks. `newTasksOnWorkflow`: the core still holds its task, but new ones start on the workflow (a narrowed switch).
  const coreTasks: CoreTaskEntry = options.newTasksOnWorkflow !== true ? entry : { route: async (request, caller) => (request.method === "POST" && request.path.split("?")[0] === "/v1/dev/tasks" ? undefined : await entry.route(request, caller)) };
  const harness = await createDeveloperTaskBroker(options.wired === false ? {} : { developerExtra: { coreTasks } });
  const rows = [
    ...await partition(world, `DEVTASK#${task.taskId}`), ...await partition(world, coreTaskMarkKey(task.taskId).pk),
    ...await partition(world, workspacePartition(FAKE_COMPANY, task.workspaceId)), ...await partition(world, `DEVELOPER#${developerIdOf(owner)}`),
    ...await partition(world, `WORKSPACE#${task.workspaceId}`),
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
  return { ...harness, dev, world, app, routes, coreTasks, task, owner, coreRead, sent, workspaceReads, principals };
}

describe("a core task on the AWS developer routes", () => {

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

  it("with the owner's moves wired (DECISIONS 198), the owner reaches the core move in the old route's words and status, and another company's caller still reads a missing task", async () => {
    const { dev, task, db, workspaceReads } = await coreWorld({ actions: true });
    const before = JSON.stringify(db.find(() => true));
    const revision = (task.workflow as { revision: number }).revision;
    const sendBack = await dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/workflow/send-back`, { requestId: randomUUID(), instructions: "Fix the review findings.", expectedRevision: revision });
    expect(sendBack.status).toBe(400);
    expect(sendBack.body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    expect(JSON.stringify(sendBack.body)).toContain("no current failed check or review finding");
    const more = await dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/continue`, { requestId: randomUUID(), instructions: "Also add a test." });
    expect(JSON.stringify(more.body)).toContain("approval steps");
    for (const suffix of ["/workflow/send-back", "/workflow/review-findings", "/continue"]) {
      const body = { requestId: randomUUID(), instructions: "x", expectedRevision: revision };
      const missingId = randomUUID();
      const theirs = await dev(OMAR, "POST", `/v1/dev/tasks/${task.taskId}${suffix}`, body);
      const missing = await dev(OMAR, "POST", `/v1/dev/tasks/${missingId}${suffix}`, body);
      expect(theirs.status, suffix).toBe(missing.status);
      expect(JSON.stringify(theirs.body).replaceAll(task.taskId, "<id>"), suffix).toBe(JSON.stringify(missing.body).replaceAll(missingId, "<id>"));
    }
    // A body that is not an object reads the same too (the core reads the task before the body).
    for (const suffix of ["/workflow/send-back", "/workflow/review-findings", "/continue"]) for (const body of [[1], null]) {
      const missingId = randomUUID();
      const theirs = await dev(OMAR, "POST", `/v1/dev/tasks/${task.taskId}${suffix}`, body);
      const missing = await dev(OMAR, "POST", `/v1/dev/tasks/${missingId}${suffix}`, body);
      expect(theirs.status, `${suffix} ${JSON.stringify(body)}`).toBe(missing.status);
      expect(JSON.stringify(theirs.body).replaceAll(task.taskId, "<id>"), `${suffix} ${JSON.stringify(body)}`).toBe(JSON.stringify(missing.body).replaceAll(missingId, "<id>"));
    }
    // Every answer above was a refusal: the AWS rows are as they were, and no AWS reader touched the core task's workspace.
    expect(JSON.stringify(db.find(() => true))).toBe(before);
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

});

describe("the proof index on the AWS developer route `GET /v1/dev/tasks/{id}/evidence` (Cloud's Proof tab)", () => {
  it("a core task's index comes from the core's own handler: the same answer the core gives, and no AWS reader touches its workspace", async () => {
    const { dev, task, routes, owner, workspaceReads } = await coreWorld();
    const own = await routes.route({ method: "GET", path: `/v1/dev/tasks/${task.taskId}/evidence`, headers: {} }, { principal: owner, client: "cli" });
    expect(own?.statusCode).toBe(200);
    const read = await dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}/evidence`);
    expect(read).toEqual({ status: 200, body: JSON.parse(own!.body) as unknown });
    expect(read.body).toMatchObject({ taskId: task.taskId, items: [] });
    expect(workspaceReads()).toEqual([]);
  });

});

describe("the owner's answers on the AWS developer route `POST /v1/dev/tasks/{id}/answers` (S3)", () => {
  const ANSWERS = [{ questionId: "q1", optionId: "a" }];
  /** Understand asked one question on the core task (as its callback would record it). */
  async function asked(world: FakeWorld, app: CoreHostApp, taskId: string): Promise<void> {
    const deps = (await app.runtimeFor(FAKE_COMPANY)).flow.deps;
    const now = new Date(world.clock.now).toISOString();
    let record = (await readCoreTask(deps, taskId))!;
    if (record.workflow?.state === "READY") { expect(await commitWorkflow(deps, record, startWorkflowUnderstand(record.workflow, now))).toBe(true); record = (await readCoreTask(deps, taskId))!; }
    const next = recordIntentAssessment(record.workflow, { expectedRevision: record.workflow!.revision, now, assessment: { kind: "questions", restatement: "Add a health endpoint.", questions: [{ id: "q1", text: "Which path?", options: [{ id: "a", label: "/health" }, { id: "b", label: "/healthz" }] }] } });
    expect(await commitWorkflow(deps, record, next)).toBe(true);
  }

  it("with the company's owner rule wired, the owner answers a core task through the core: 200 and { task } in the developer task view; a repeat answers the same; no AWS reader touches its workspace", async () => {
    const { dev, task, world, app, workspaceReads, coreRead } = await coreWorld({ actions: true, understand: true });
    await asked(world, app, task.taskId);
    const requestId = randomUUID();
    const answer = await dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/answers`, { requestId, round: 1, answers: ANSWERS });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ task: { taskId: task.taskId } });
    const deps = (await app.runtimeFor(FAKE_COMPANY)).flow.deps;
    expect((await readCoreTask(deps, task.taskId))!.workflow!.intent!.answers).toHaveLength(1);
    const again = await dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/answers`, { requestId, round: 1, answers: ANSWERS });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(JSON.parse((await coreRead())!.body));
    expect((await readCoreTask(deps, task.taskId))!.workflow!.intent!.answers).toHaveLength(1);
    expect(workspaceReads()).toEqual([]);
  });

  it("another company's caller is answered exactly like a task id that does not exist, for every body; nothing is answered", async () => {
    const { dev, task, world, app } = await coreWorld({ actions: true, understand: true });
    await asked(world, app, task.taskId);
    for (const body of [{ requestId: randomUUID(), round: 1, answers: ANSWERS }, {}, [1], null, undefined, { requestId: "x", round: 0, answers: [] }]) {
      const missingId = randomUUID();
      const theirs = await dev(OMAR, "POST", `/v1/dev/tasks/${task.taskId}/answers`, body);
      const missing = await dev(OMAR, "POST", `/v1/dev/tasks/${missingId}/answers`, body);
      expect(theirs.status, JSON.stringify(body)).toBe(missing.status);
      expect(JSON.stringify(theirs.body).replaceAll(task.taskId, "<id>"), JSON.stringify(body)).toBe(JSON.stringify(missing.body).replaceAll(missingId, "<id>"));
      expect(JSON.stringify(theirs.body)).not.toContain(FAKE_COMPANY);
    }
    expect((await readCoreTask((await app.runtimeFor(FAKE_COMPANY)).flow.deps, task.taskId))!.workflow!.intent!.answers).toHaveLength(0);
  });

  // ---- GET /v1/dev/tasks?detail=1: the Understand round and the workflow's outcome on each row (the website's Work list answers Understand's questions inline)
  it("?detail=1 gives a core task's waiting Understand round (ids, texts, options, answered false) as its owner's task read shows it, and answered true once the answers are in; nothing is written", async () => {
    const { dev, task, world, app, db } = await coreWorld({ actions: true, understand: true });
    await asked(world, app, task.taskId);
    await publish(world, db, task.taskId);
    const writes: unknown[] = [];
    db.onWrite((change) => writes.push(change));
    const waiting = await detailRow(dev, MAYA, task.taskId);
    expect(waiting?.round).toEqual(WAITING_ROUND);
    expect(waiting?.outcome).toBeUndefined();
    expect(waiting?.workflow).toMatchObject({ stage: "UNDERSTAND", state: "WAITING" });
    // The same words as the task read's own `workflow.intent` (the list invents nothing), and the revision the answers route needs is the row's.
    const read = (await dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`)).body.task as { workflow: { revision: number; intent: { rounds: number; assessment: { questions: Array<Record<string, unknown>> } } } };
    expect(read.workflow.intent.rounds).toBe(waiting?.round?.round);
    expect(read.workflow.intent.assessment.questions).toEqual(waiting?.round?.questions.map((question) => Object.fromEntries(Object.entries(question).filter(([key]) => key !== "answered"))));
    expect(read.workflow.revision).toBe(waiting?.workflow?.revision);
    // The ordinary list never has it.
    expect(JSON.stringify((await dev(MAYA, "GET", "/v1/dev/tasks")).body)).not.toContain("Which path?");
    expect(writes).toEqual([]);
    // Answered through the core (the row's own revision and round), the next list says so.
    const answer = await dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/answers`, { requestId: randomUUID(), round: waiting!.round!.round, answers: ANSWERS });
    expect(answer.status).toBe(200);
    await publish(world, db, task.taskId);
    const answered = await detailRow(dev, MAYA, task.taskId);
    expect(answered?.round).toEqual({ round: 1, questions: [{ ...WAITING_ROUND.questions[0]!, answered: true }] });
  });

  // DEC 254zzz502 (D1-2b): a task with no core mark is the retired old workflow's: it is no longer listed, ended or not. Its records are kept.
  it("lists only tasks that carry the core's mark: an old task's index row, ended or not, is no longer listed, and nothing is written or deleted", async () => {
    const { dev, task, world, db } = await coreWorld();
    await publish(world, db, task.taskId);
    const oldIds = [randomUUID(), randomUUID()];
    const rows = oldIds.map((taskId, position) => {
      const meta = { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, developerId: MAYA.developerId, title: `Old task ${position}`, project: "payments", createdAt: `2026-10-0${position + 1}T00:00:00.000Z`, updatedAt: `2026-10-0${position + 1}T00:00:00.000Z` };
      const index = { ...meta, pk: `DEVELOPER#${MAYA.developerId}`, sk: `TASK#2026-10-0${position + 1}T00:00:00.000Z#${taskId}`, entityType: "DEVELOPER_TASK_INDEX", status: position === 0 ? "CLOSED" : "RUNNING" };
      return { meta, index };
    });
    for (const { meta, index } of rows) { db.set(meta); db.set(index); }
    const writes: unknown[] = [];
    db.onWrite((change) => writes.push(change));
    const listed = (await dev(MAYA, "GET", "/v1/dev/tasks")).body.tasks as Array<{ taskId: string }>;
    expect(listed.map((row) => row.taskId)).toContain(task.taskId);
    for (const taskId of oldIds) expect(listed.map((row) => row.taskId), taskId).not.toContain(taskId);
    // With detail and a status filter too, and nothing is written (no index sync of the old rows) ...
    const detailed = (await dev(MAYA, "GET", "/v1/dev/tasks?detail=1&status=RUNNING")).body.tasks as Array<{ taskId: string }>;
    for (const taskId of oldIds) expect(detailed.map((row) => row.taskId), taskId).not.toContain(taskId);
    expect(writes).toEqual([]);
    // ... and the old records are still there.
    for (const { meta, index } of rows) { expect(db.get(String(meta.pk), "META")).toBeDefined(); expect(db.get(String(index.pk), String(index.sk))).toBeDefined(); }
  });

  it("?detail=1 gives no round once the task is past Understand, and gives the workflow's outcome", async () => {
    const { dev, task, world, app, db } = await coreWorld({ actions: true, understand: true });
    await asked(world, app, task.taskId);
    const deps = (await app.runtimeFor(FAKE_COMPANY)).flow.deps;
    // Understand never came back: the task ends CLOSED (stage CLOSED, outcome CLOSED), whatever it had asked.
    const record = (await readCoreTask(deps, task.taskId))!;
    const waitingAgain = { ...record.workflow!, state: "RUNNING" as const };
    expect(await commitWorkflow(deps, record, endStuckUnderstand(waitingAgain, new Date(world.clock.now).toISOString()))).toBe(true);
    await publish(world, db, task.taskId);
    const row = await detailRow(dev, MAYA, task.taskId);
    expect(row?.workflow).toMatchObject({ stage: "CLOSED", state: "COMPLETE" });
    expect(row?.outcome).toBe("CLOSED");
    expect(row?.round).toBeUndefined();
  });

  it("?detail=1 is the task's company only: another company's caller lists no round or question, even with an index row of their own that names the task", async () => {
    const { dev, task, world, app, db, coreTasks } = await coreWorld({ actions: true, understand: true });
    await asked(world, app, task.taskId);
    await publish(world, db, task.taskId);
    expect(await detailRow(dev, MAYA, task.taskId)).toMatchObject({ round: WAITING_ROUND });
    const own = await dev(OMAR, "GET", "/v1/dev/tasks?detail=1");
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toMatch(/Which path|"round"|"outcome"/u);
    // A row planted in OMAR's own partition that names MAYA's task: the task record is not his (its owner and company are checked on it before any detail is read), so his row has its own words only and no detail.
    db.set(indexRowOf(task.taskId, OMAR, "Planted"));
    const planted = await dev(OMAR, "GET", "/v1/dev/tasks?detail=1");
    expect(planted.status).toBe(200);
    expect(planted.body).toEqual({ tasks: [{ taskId: task.taskId, title: "Planted", project: "payments", status: "RUNNING", shared: false, createdAt: INDEX_AT, updatedAt: INDEX_AT }] });
    expect(JSON.stringify(planted.body)).not.toContain("Which path");
    // The core's own check says the same for him, and for a caller it does not know.
    expect(await coreTasks.taskReadable!({ developerId: MAYA.developerId, sessionId: "s", name: "Maya" }, task.taskId)).toBe(true);
    expect(await coreTasks.taskReadable!({ developerId: OMAR.developerId, sessionId: "s", name: "Omar" }, task.taskId)).toBe(false);
    expect(await coreTasks.taskReadable!({ developerId: "nobody", sessionId: "s", name: "x" }, task.taskId)).toBe(false);
  });

  it("?detail=1 shows a round only as the task read would: a caller the core refuses has none (the read says no such task), a reader the core lets read has it; a deployment with no readable check gives none", async () => {
    const refused = await coreWorld({ understand: true, access: { ...createOwnerTaskAccess(), canAct: async () => false } });
    await asked(refused.world, refused.app, refused.task.taskId);
    await publish(refused.world, refused.db, refused.task.taskId);
    const refusedRow = await detailRow(refused.dev, MAYA, refused.task.taskId);
    // The list's own rule (her task, her company) still lists the row and its other detail; the round is the task read's to show, and it refuses.
    expect(refusedRow?.workflow).toMatchObject({ stage: "UNDERSTAND", state: "WAITING" });
    expect(refusedRow?.round).toBeUndefined();
    expect((await refused.dev(MAYA, "GET", `/v1/dev/tasks/${refused.task.taskId}`)).status).toBe(404);

    const reader = await coreWorld({ understand: true, access: { ...createOwnerTaskAccess(), canAct: async () => false, canRead: async () => true } });
    await asked(reader.world, reader.app, reader.task.taskId);
    await publish(reader.world, reader.db, reader.task.taskId);
    expect((await detailRow(reader.dev, MAYA, reader.task.taskId))?.round).toEqual(WAITING_ROUND);
    expect((await reader.dev(MAYA, "GET", `/v1/dev/tasks/${reader.task.taskId}`)).status).toBe(200);

    const unwired = await coreWorld({ understand: true, withoutReadable: true });
    await asked(unwired.world, unwired.app, unwired.task.taskId);
    await publish(unwired.world, unwired.db, unwired.task.taskId);
    expect((await detailRow(unwired.dev, MAYA, unwired.task.taskId))?.workflow).toMatchObject({ stage: "UNDERSTAND" });
    expect((await detailRow(unwired.dev, MAYA, unwired.task.taskId))?.round).toBeUndefined();
  });

});

// ---- helpers for the list's detail (`?detail=1`)
const INDEX_AT = "2026-11-15T00:00:00.000Z";
const indexRowOf = (taskId: string, developer: { developerId: string }, title = "Core work") => ({ pk: `DEVELOPER#${developer.developerId}`, sk: `TASK#${INDEX_AT}#${taskId}`, entityType: "DEVELOPER_TASK_INDEX", taskId, title, project: "payments", status: "RUNNING", shared: false, createdAt: INDEX_AT, updatedAt: INDEX_AT });
/** The harness lists from its own copy of the table: copy in the task's record as the core now holds it (MAYA's own) and her index row. */
async function publish(world: FakeWorld, db: FakeDynamoDb, taskId: string): Promise<void> {
  db.set({ ...JSON.parse(JSON.stringify(await world.store.get(coreTaskKey(taskId)))) as Record<string, unknown> & { pk: string; sk: string }, developerId: MAYA.developerId });
  db.set(indexRowOf(taskId, MAYA));
}
const WAITING_ROUND = { round: 1, questions: [{ id: "q1", text: "Which path?", options: [{ id: "a", label: "/health" }, { id: "b", label: "/healthz" }], answered: false }] };
const detailRow = async (dev: Awaited<ReturnType<typeof coreWorld>>["dev"], who: typeof MAYA, taskId: string) => {
  const answer = await dev(who, "GET", "/v1/dev/tasks?detail=1");
  expect(answer.status).toBe(200);
  return DeveloperTaskDetailedListResponseSchema.parse(answer.body).tasks.find((row) => row.taskId === taskId);
};


describe("the AWS readers see only workflow rows", () => {
  it.each(["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CLOSED", "STARTING"] as const)("only adds startupReason when the listed index status is STARTING (index: %s)", async (status) => {
    const { world, db, task, dev, workspaceReads } = await coreWorld();
    await publish(world, db, task.taskId);
    db.set({ ...indexRowOf(task.taskId, MAYA), status });
    const writes: unknown[] = [];
    db.onWrite((change) => writes.push(change));

    // The live core view is still starting, even when the index lists another status.
    const single = await dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`);
    expect(single.status).toBe(200);
    expect(single.body).toMatchObject({ task: { status: "STARTING", startupReason: "own-machine-starting" } });
    const row = await detailRow(dev, MAYA, task.taskId);
    expect(row?.status).toBe(status);
    if (status === "STARTING") expect(row).toHaveProperty("startupReason", "own-machine-starting");
    else expect(row).not.toHaveProperty("startupReason");

    const ordinary = await dev(MAYA, "GET", "/v1/dev/tasks");
    expect(ordinary.status).toBe(200);
    expect(DeveloperTaskDetailedListResponseSchema.parse(ordinary.body).tasks[0]).not.toHaveProperty("startupReason");
    expect(writes).toEqual([]);
    expect(workspaceReads()).toEqual([]);
  });

  it("?detail=1 adds each row's detail (Cloud #188 item 5): a core task's workflow stage and state, its cost and run limit from the core's own money read, as its owner; nothing is written", async () => {
    const { db, task, dev, coreTasks, workspaceReads } = await coreWorld({ actions: true, roundCap: async () => ({ limitUsd: 7.5, spentUsd: 1.25 }) });
    db.set({ ...(db.get(`DEVTASK#${task.taskId}`, "META") as Record<string, unknown> & { pk: string; sk: string }), developerId: MAYA.developerId });
    const row = { pk: `DEVELOPER#${MAYA.developerId}`, sk: `TASK#2026-11-15T00:00:00.000Z#${task.taskId}`, entityType: "DEVELOPER_TASK_INDEX", taskId: task.taskId, title: "Core work", project: "payments", status: "RUNNING", shared: false, createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z" };
    db.set(row);
    const writes: unknown[] = [];
    db.onWrite((change) => writes.push(change));
    const listed = await dev(MAYA, "GET", "/v1/dev/tasks?detail=1");
    expect(listed.status).toBe(200);
    const projected = await coreTasks.taskMoney!({ developerId: MAYA.developerId, sessionId: "s", name: "Maya" }, task.taskId);
    expect(DeveloperTaskDetailedListResponseSchema.parse(listed.body)).toEqual({ tasks: [{
      taskId: task.taskId, title: "Core work", project: "payments", status: "RUNNING", shared: false, createdAt: row.createdAt, updatedAt: row.updatedAt,
      workflow: { stage: task.workflow!.stage, state: task.workflow!.state, revision: task.workflow!.revision, path: "QUICK" }, costUsd: 1.25, runLimitUsd: 7.5, money: projected?.money,
    }] });
    expect(writes).toEqual([]);
    expect(workspaceReads()).toEqual([]);
    // A spend the core cannot tell: the limit only (never a made-up cost); a money read that fails or is not wired: neither.
    for (const [roundCap, money] of [[async () => ({ limitUsd: 5, spentUsd: undefined }), { runLimitUsd: 5 }], [async () => { throw new Error("ledger down"); }, {}], [async () => undefined, {}], [async () => ({ limitUsd: Number.NaN, spentUsd: 1 }), {}]] as const) {
      const other = await coreWorld({ actions: true, roundCap });
      other.db.set({ ...(other.db.get(`DEVTASK#${other.task.taskId}`, "META") as Record<string, unknown> & { pk: string; sk: string }), developerId: MAYA.developerId });
      other.db.set({ ...row, taskId: other.task.taskId, sk: `TASK#2026-11-15T00:00:00.000Z#${other.task.taskId}` });
      const answer = await other.dev(MAYA, "GET", "/v1/dev/tasks?detail=1");
      const [listedRow] = (answer.body as { tasks: Array<Record<string, unknown>> }).tasks;
      expect({ costUsd: listedRow!["costUsd"], runLimitUsd: listedRow!["runLimitUsd"] }).toEqual({ costUsd: undefined, runLimitUsd: undefined, ...money });
    }
  });


  it("?detail=1 shows a core task's block reason stored raw redacted (the row's workflow detail is built from the stored workflow, there being no hosted task view for a core task)", async () => {
    const { db, task, dev } = await coreWorld({ actions: true, roundCap: async () => ({ limitUsd: 7.5, spentUsd: 1.25 }) });
    // Built at run time: no key-shaped literal is in this file.
    const secret = ["ghp_", "Ab12".repeat(9)].join("");
    const stored = db.get(`DEVTASK#${task.taskId}`, "META") as Record<string, unknown> & { pk: string; sk: string; workflow: Record<string, unknown> };
    db.set({ ...stored, developerId: MAYA.developerId, workflow: { ...stored.workflow, state: "BLOCKED", blockReason: `Rovara stopped while planning: clone failed https://x-access-token:${secret}@github.com/org/repo` } });
    db.set({ pk: `DEVELOPER#${MAYA.developerId}`, sk: `TASK#2026-11-15T00:00:00.000Z#${task.taskId}`, entityType: "DEVELOPER_TASK_INDEX", taskId: task.taskId, title: "Core work", project: "payments", status: "RUNNING", shared: false, createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z" });
    const listed = await dev(MAYA, "GET", "/v1/dev/tasks?detail=1");
    expect(listed.status).toBe(200);
    const [listedRow] = DeveloperTaskDetailedListResponseSchema.parse(listed.body).tasks;
    expect(listedRow?.workflow?.blockReason).toMatch(/^Rovara stopped while planning: clone failed https:\/\/\[REDACTED\]@github\.com/u);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
  });

  it("the core's money read for a list row answers only the task's owner in their own company; anyone else gets nothing", async () => {
    const { task, coreTasks, routes, owner } = await coreWorld({ actions: true, roundCap: async () => ({ limitUsd: 9, spentUsd: 2 }) });
    expect(await coreTasks.taskMoney!({ developerId: MAYA.developerId, sessionId: "s", name: "Maya" }, task.taskId)).toMatchObject({ costUsd: 2, runLimitUsd: 9, money: { taskId: task.taskId, state: "unavailable" } });
    // Another company's owner, a caller the core does not know, a malformed id and a missing task: nothing.
    expect(await coreTasks.taskMoney!({ developerId: OMAR.developerId, sessionId: "s", name: "Omar" }, task.taskId)).toBeUndefined();
    expect(await coreTasks.taskMoney!({ developerId: "nobody", sessionId: "s", name: "x" }, task.taskId)).toBeUndefined();
    expect(await coreTasks.taskMoney!({ developerId: MAYA.developerId, sessionId: "s", name: "Maya" }, "not-a-task")).toBeUndefined();
    expect(await coreTasks.taskMoney!({ developerId: MAYA.developerId, sessionId: "s", name: "Maya" }, randomUUID())).toBeUndefined();
    // A script token never reads money.
    expect(await routes.taskMoney({ principal: owner, client: "cli", scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } }, task.taskId)).toBeUndefined();
  });

  it("?involved=1 is the core's list: empty with nothing added (never the ordinary list), empty with no core handlers on this install, and another company's task is never listed even for a row that names it", async () => {
    for (const wired of [true, false]) {
      const { dev, task, world, app } = await coreWorld({ wired });
      const empty = { status: 200, body: { involved: true, tasks: [] } };
      expect(await dev(MAYA, "GET", "/v1/dev/tasks?involved=1"), String(wired)).toEqual(empty);
      // OMAR (company OTHER) holds a row naming MAYA's task (company FAKE_COMPANY): his list shows none of it.
      await writeInvolvedRow({ store: world.store }, { companyId: OTHER, personId: "local-owner", taskId: task.taskId, createdAt: task.createdAt });
      expect(await dev(OMAR, "GET", "/v1/dev/tasks?involved=1"), String(wired)).toEqual(empty);
      // A task of OMAR's own company, started by someone else, is listed for him when the core's access lets him see it (and only then).
      const other = await (await app.runtimeFor(OTHER)).flow.start({ principal: localOwnerPrincipal({ companyId: OTHER, personId: "someone" }), client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "A task OMAR was added to", workflow: true, workflowPath: "QUICK" });
      await writeInvolvedRow({ store: world.store }, { companyId: OTHER, personId: "local-owner", taskId: other.task.taskId, createdAt: other.task.createdAt });
      const listed = await dev(OMAR, "GET", "/v1/dev/tasks?involved=1");
      if (wired) expect(listed).toMatchObject({ status: 200, body: { involved: true, tasks: [{ taskId: other.task.taskId, title: "A task OMAR was added to" }] } });
      else expect(listed).toEqual(empty);
      expect(JSON.stringify(listed.body)).not.toContain("Add a /health endpoint");
    }
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

  it("the admin console names a legacy core workspace by its task only; it never reads the core's task record", async () => {
    const { db, task, brokerInput } = await coreWorld();
    db.set({ ...legacyWorkspaceKey(task.workspaceId), sk: "DEVELOPER_TASK", taskId: task.taskId });
    const owner = await workspaceOwner({ documentClient: db, tableName: brokerInput.tableName } as never, { id: task.workspaceId, ownerKey: "k" } as never);
    expect(owner).toEqual({ origin: "ai_tool", owner: { taskId: task.taskId } });
  });
  it("known gap: admin workspace owner cannot resolve a scoped core pointer", async () => {
    const { db, task, brokerInput, sent } = await coreWorld();
    const deps = { documentClient: db, tableName: brokerInput.tableName } as never;
    const observed = await workspaceOwner(deps, { id: task.workspaceId, ownerKey: "k" } as never);
    expect(observed).toEqual(await workspaceOwner(deps, { id: "missing-workspace", ownerKey: "k" } as never));
    expect(observed).toEqual({ origin: "slack", owner: {} });
    expect(JSON.stringify(sent.mock.calls)).not.toContain(`DEVTASK#${task.taskId}`);
  });

});

describe("a task's start on the AWS developer route (lane E2 step 6)", () => {
  it("goes to the core for a member of a company the switch sends there: the core's task view, its rows on the core, none of the workflow's", async () => {
    const { dev, world, db } = await coreWorld();
    const started = await dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Add a /ready endpoint", workflow: true, workflowPath: "QUICK" });
    expect(started.status).toBe(200);
    const taskId = (started.body.task as { taskId: string }).taskId;
    expect(coreTaskMarkOf(await world.store.get(coreTaskMarkKey(taskId)))).toMatchObject({ engine: "core" });
    expect(db.get(`DEVTASK#${taskId}`, "META")).toBeUndefined();
  });

});

