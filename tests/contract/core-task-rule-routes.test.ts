// Core task web routes (Cloud #188 item 3): the old task routes a core task had no answer for, served for it through the AWS developer API with the old routes' EXACT access rules: People and take-over
// (`/people`, `/people/candidates`, `/people/add`, `/people/role`, `/people/take-ownership`, `/people/requests/{id}`), sharing (`/readers`), the events timeline (`/events`, made from the core's own log and
// decisions) and plan comments (`GET /comments`). Each test drives the real developer routes, the engine boundary and the core host's dev routes over one table, and checks:
//   - the owner's answer is the old route's own (for People: byte for byte the answer the same person gets on a workflow task in the same state);
//   - a member of the task's company the rule refuses gets the old rule's refusal, and another company's caller gets exactly the answer for a task id that does not exist (nothing written);
//   - without the deployment's wiring the owner is told, in fixed words, that it is not on the core here yet.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition, type StoredDocument } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { appendTaskLog } from "../../packages/broker/src/core/task-log/store.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, coreTaskMarkKey, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { coreTaskEntryFrom, type CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { createCoreTaskRuleRoutes } from "../../packages/broker/src/aws/core-task-rule-routes.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { MAYA, OMAR, bearerFor, createDeveloperTaskBroker, grantProject, type Developer } from "../support/developer-task-broker.js";
import { readsAsRow } from "../support/code-api-row-read.js";
import { pagePlan, pageTask } from "../support/page-tasks.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
/** A member of MAYA's company the owner shares the task with. */
const TESS: Developer = { developerId: "c".repeat(64), name: "Tess Team", provider: "oidc", sessionId: "s-tess" };
/** A member of MAYA's company with no part in the task. */
const SAM: Developer = { developerId: "b".repeat(64), name: "Sam Stranger", provider: "oidc", sessionId: "s-sam" };

/** A key-shaped string the redaction must hide, built at run time (never a literal in the source). */
const FAKE_KEY = ["sk", "live", "0123456789abcdef0123"].join("-");

beforeAll(async () => { await loadSlackBroker(); });

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

function appOver(world: FakeWorld): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    // The company's rule as a deployment wires it: only the person the task runs for acts on it or reads it through the core's own rule (People are the old rules' here).
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: { ...createOwnerTaskAccess(), canAct: async (principal, task) => principal.personId === task.developerId, canRead: async (principal, task) => principal.personId === task.developerId }, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
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

/** A core task MAYA owns (company A), the AWS broker over the same table, and the core's routes wired with the old task routes' dependencies (`rules`), as the deployment wires them. */
async function ruleWorld(options: { rules?: boolean } = {}) {
  const world = createFakeWorld();
  await registerProject(world, FAKE_COMPANY);
  await registerProject(world, OTHER);
  const app = appOver(world);
  const principalOf = (who: Developer, companyId: string) => localOwnerPrincipal({ companyId, personId: who.developerId });
  const owner = principalOf(MAYA, FAKE_COMPANY);
  const { task } = await (await app.runtimeFor(FAKE_COMPANY)).flow.start({ principal: owner, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  const principals = new Map<string, DeployedCaller>([
    [MAYA.developerId, { principal: owner, client: "cli" }], [TESS.developerId, { principal: principalOf(TESS, FAKE_COMPANY), client: "cli" }],
    [SAM.developerId, { principal: principalOf(SAM, FAKE_COMPANY), client: "cli" }], [OMAR.developerId, { principal: principalOf(OMAR, OTHER), client: "cli" }],
  ]);
  const members = new Map<string, CompanyMembership>([...principals.values()].map((caller) => [caller.principal.personId + caller.principal.companyId, { companyId: caller.principal.companyId, role: "member" }]));
  const late: { harness?: Awaited<ReturnType<typeof createDeveloperTaskBroker>> } = {};
  const rules = createCoreTaskRuleRoutes((person, companyId) => ({
    ...developerTaskRouteDependencies({ tasks: late.harness!.actions, documentClient: late.harness!.db, tableName: late.harness!.brokerInput.tableName, developer: (late.harness!.brokerInput as unknown as { developer: never }).developer, now: Date.now },
      { developerId: person.developerId, sessionId: "core", name: person.name, amr: "oidc" }, undefined, null),
    companyId,
  }));
  const routes = createCoreDevRoutes({ app, companyOf: async (caller) => members.get(caller.principal.personId + caller.principal.companyId), wiring: () => ({ origin: () => "https://api.example", ...(options.rules === false ? {} : { taskRules: rules }) }) });
  const entry: CoreTaskEntry = coreTaskEntryFrom(routes, async (caller) => principals.get(caller.developerId));
  // New tasks start on the workflow here, so a workflow task in the same state can be compared with the core's (the core still holds its own task).
  const coreTasks: CoreTaskEntry = { route: async (request, caller) => (request.method === "POST" && request.path.split("?")[0] === "/v1/dev/tasks" ? undefined : await entry.route(request, caller)) };
  const harness = await createDeveloperTaskBroker({ developerExtra: { coreTasks } });
  late.harness = harness;
  const db = harness.db;
  for (const row of [...await partition(world, `DEVTASK#${task.taskId}`), ...await partition(world, coreTaskMarkKey(task.taskId).pk)]) db.set(JSON.parse(JSON.stringify(row)) as Record<string, unknown> & { pk: string; sk: string });
  for (const who of [TESS, SAM]) {
    db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  }
  for (const who of [MAYA, TESS, SAM]) grantProject(db, who);
  const handler = harness.handler;
  const dev = async (who: Developer, method: string, path: string, body?: unknown) => {
    const response = await handler({
      version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "", headers: { authorization: await bearerFor(who) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: randomUUID(), http: { method } },
    });
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    delete parsed["requestId"];
    return { status: response.statusCode, body: parsed };
  };
  /** The answer this caller gets for a task id that does not exist, on the same route (the real id put back), to compare a refused core task with. */
  const missing = async (who: Developer, method: string, suffix: string, body?: unknown) => {
    const id = randomUUID();
    const answer = await dev(who, method, `/v1/dev/tasks/${id}${suffix}`, body);
    return JSON.parse(JSON.stringify(answer).replaceAll(id, task.taskId)) as typeof answer;
  };
  const rows = () => JSON.stringify(db.find((item) => String(item.pk).includes(task.taskId)));
  return { world, app, db, dev, missing, rows, task, owner, objects: harness.s3.objects, rules };
}

describe("readers on a core task (spec 067's rule)", () => {
  it("the task's own person lists, shares and unshares; the reader is told only the owner may; a member with no part and another company's caller read no such task", async () => {
    const h = await ruleWorld();
    const base = `/v1/dev/tasks/${h.task.taskId}/readers`;
    expect(await h.dev(MAYA, "GET", base)).toEqual({ status: 200, body: { readers: [] } });
    const shared = await h.dev(MAYA, "PUT", `${base}/${TESS.developerId}`, { requestId: randomUUID(), role: "viewer" });
    expect(shared).toMatchObject({ status: 200, body: { reader: { developerId: TESS.developerId }, already: false } });
    expect((await h.dev(MAYA, "GET", base)).body).toMatchObject({ readers: [{ developerId: TESS.developerId }] });
    // The reader: told only the owner may share, in the old words.
    const reader = await h.dev(TESS, "GET", base);
    expect(reader).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: "only the task's owner can share it" } } });
    expect((await h.dev(TESS, "PUT", `${base}/${SAM.developerId}`, { requestId: randomUUID(), role: "viewer" })).status).toBe(403);
    // Someone the task is not shared with, and another company's caller: exactly a missing task.
    const before = h.rows();
    for (const [who, method, suffix, body] of [[SAM, "GET", "/readers", undefined], [SAM, "PUT", `/readers/${SAM.developerId}`, { requestId: randomUUID(), role: "viewer" }], [OMAR, "GET", "/readers", undefined], [OMAR, "DELETE", `/readers/${TESS.developerId}`, undefined]] as const) {
      expect(await h.dev(who, method, `/v1/dev/tasks/${h.task.taskId}${suffix}`, body), `${who.name} ${method} ${suffix}`).toEqual(await h.missing(who, method, suffix, body));
    }
    expect(h.rows()).toBe(before);
    // The old rule's own refusals reach the owner: a bad body, a person who is not a project member, sharing with themselves.
    expect((await h.dev(MAYA, "PUT", `${base}/${TESS.developerId}`, { role: "viewer" })).body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    expect((await h.dev(MAYA, "PUT", `${base}/${OMAR.developerId}`, { requestId: randomUUID(), role: "viewer" })).body).toMatchObject({ error: { code: "CONFIG_INVALID", message: expect.stringContaining("isn't a member of payments") as unknown } });
    expect((await h.dev(MAYA, "PUT", `${base}/${MAYA.developerId}`, { requestId: randomUUID(), role: "viewer" })).body).toMatchObject({ error: { code: "CONFIG_INVALID", message: expect.stringContaining("you own this task") as unknown } });
    expect(await h.dev(MAYA, "DELETE", `${base}/${TESS.developerId}`)).toEqual({ status: 200, body: { developerId: TESS.developerId, removed: true } });
    expect((await h.dev(MAYA, "GET", base)).body).toEqual({ readers: [] });
  });
});

describe("the events timeline of a core task (the core's log and decisions)", () => {
  async function withHistory(h: Awaited<ReturnType<typeof ruleWorld>>) {
    const deps = (await h.app.runtimeFor(FAKE_COMPANY)).flow.deps;
    await appendTaskLog(deps.store, { orgId: FAKE_COMPANY, taskId: h.task.taskId, entries: [
      { key: "status:started", at: "2026-11-15T10:00:00.000Z", kind: "status", moment: "started" },
      { key: "question:q1", at: "2026-11-15T10:01:00.000Z", kind: "question", questionId: "q1", round: 1, text: `Which path? token=${FAKE_KEY}` },
      { key: "answer:q1", at: "2026-11-15T10:02:00.000Z", kind: "answer", questionId: "q1", round: 1, text: "/health", by: "Maya Chen", surface: "web" },
      { key: "approval:plan", at: "2026-11-15T10:03:00.000Z", kind: "approval", what: "plan", outcome: "approved", by: "Maya Chen", surface: "web" },
    ] });
    const record = (await deps.store.get(taskKey(h.task.taskId)))!;
    const workflow = record["workflow"] as Record<string, unknown> & { decisions: unknown[] };
    await deps.store.put({ item: { ...record, workflow: { ...workflow, decisions: [{ requestId: randomUUID(), workflowRevision: 2, decision: "APPROVE", actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "Looks right.", at: "2026-11-15T10:04:00.000Z" }] } } });
  }

  it("the owner reads the newest events oldest first, in fixed words with the text redacted; one approval is said once (the workflow's decision)", async () => {
    const h = await ruleWorld();
    await withHistory(h);
    const answer = await h.dev(MAYA, "GET", `/v1/dev/tasks/${h.task.taskId}/events`);
    expect(answer.status).toBe(200);
    const events = (answer.body as { events: Array<{ at: string; kind: string; text: string }> }).events;
    expect(events.map((event) => event.at)).toEqual(["2026-11-15T10:00:00.000Z", "2026-11-15T10:01:00.000Z", "2026-11-15T10:02:00.000Z", "2026-11-15T10:04:00.000Z"]);
    expect(events.map((event) => event.kind)).toEqual(["status", "message", "message", "status"]);
    readsAsRow("tasks.events", answer.body);
    expect(events[0]!.text).toBe("Task started");
    expect(events[2]!.text).toBe("Answer from Maya Chen: /health");
    expect(events[3]!.text).toBe("Approved: Looks right.");
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY);
    // The newest `limit`, still oldest first; the old route's words for a limit out of range.
    expect((await h.dev(MAYA, "GET", `/v1/dev/tasks/${h.task.taskId}/events?limit=2`)).body).toEqual({ events: events.slice(-2) });
    for (const limit of ["0", "51", "x"]) expect((await h.dev(MAYA, "GET", `/v1/dev/tasks/${h.task.taskId}/events?limit=${limit}`)).body, limit).toEqual({ error: { code: "CONFIG_INVALID", message: "limit must be a whole number from 1 to 50" } });
  });

  it("a reader the task is shared with reads them while still a project member; a member with no part and another company's caller read no such task", async () => {
    const h = await ruleWorld();
    await withHistory(h);
    const path = `/v1/dev/tasks/${h.task.taskId}/events`;
    for (const who of [TESS, SAM, OMAR]) expect(await h.dev(who, "GET", path), who.name).toEqual(await h.missing(who, "GET", "/events"));
    await h.dev(MAYA, "PUT", `/v1/dev/tasks/${h.task.taskId}/readers/${TESS.developerId}`, { requestId: randomUUID(), role: "viewer" });
    const read = await h.dev(TESS, "GET", path);
    expect(read.status).toBe(200);
    expect(read.body).toEqual((await h.dev(MAYA, "GET", path)).body);
    // Off the project: no longer a reader.
    h.db.delete(`MEMBER#${TESS.developerId}`, "PROJECT#payments");
    expect(await h.dev(TESS, "GET", path)).toEqual(await h.missing(TESS, "GET", "/events"));
    expect(await h.dev(OMAR, "GET", path)).toEqual(await h.missing(OMAR, "GET", "/events"));
  });
});

describe("plan comments and People on a core task (the old routes' own functions and rules)", () => {
  it("the authenticated core POST creates a criterion thread and refuses foreign or viewer writes", async () => {
    const h = await ruleWorld();
    const page = pageTask();
    const source = page.addVersion("plan", pagePlan());
    const task = (await h.world.store.get(taskKey(h.task.taskId)))!;
    if (typeof task["ownerKey"] !== "string") throw new Error("task owner missing");
    const artifact = { ...source, objectKey: `private/${task["ownerKey"]}/${h.task.workspaceId}/plan-v1.json` };
    const row = { ...task, workflow: { ...page.workflow(), taskId: h.task.taskId, ownerId: task["ownerKey"], artifacts: [artifact] } };
    h.db.set(row);
    await h.world.store.put({ item: JSON.parse(JSON.stringify(row)) as StoredDocument });
    // The real dependency factory reads the broker's artifact store.
    const text = page.objects.get(source.objectKey)!;
    // The harness uses its S3 fake; the root/runtime reader has separate proof in core-task-web-routes-root.test.ts.
    h.objects.set(artifact.objectKey, text);
    const path = `/v1/dev/tasks/${h.task.taskId}/comments`;
    const first = await h.dev(MAYA, "POST", path, { requestId: "root", document: "plan", text: "Put the banner above", anchor: "claim:2.1" });
    expect(first).toMatchObject({ status: 200, body: { comment: { anchor: "claim:2.1" } } });
    const root = first.body["comment"] as { commentId: string };
    expect(await h.dev(MAYA, "POST", path, { requestId: "reply", document: "plan", text: "Keep the button visible", replyTo: root.commentId })).toMatchObject({ status: 200, body: { comment: { replyTo: root.commentId, anchor: "claim:2.1" } } });
    const fresh = await h.dev(MAYA, "GET", path);
    readsAsRow("tasks.comments", fresh.body);
    const comments = fresh.body["comments"] as Array<{ replyTo?: string; anchor?: string }>;
    expect(comments.find((comment) => comment.replyTo === root.commentId)).toMatchObject({ anchor: "claim:2.1" });
    await h.dev(MAYA, "PUT", `/v1/dev/tasks/${h.task.taskId}/readers/${TESS.developerId}`, { requestId: randomUUID(), role: "viewer" });
    const before = h.rows();
    for (const who of [OMAR, SAM]) {
      const body = { requestId: "refused", document: "plan", text: "Must refuse", replyTo: root.commentId };
      const response = await h.dev(who, "POST", path, body);
      expect(response.status).toBe(404);
      expect(response).toEqual(await h.missing(who, "POST", "/comments", body));
    }
    expect(h.rows()).toBe(before);
    // Owner decision 254zzz558 (a write permission): a person the task is shared with ("Can view", the stored share TESS holds) comments; before it, this was refused.
    expect(await h.dev(TESS, "POST", path, { requestId: "shared", document: "plan", text: "Looks right to me.", replyTo: root.commentId })).toMatchObject({ status: 200, body: { comment: { replyTo: root.commentId, text: "Looks right to me." } } });
    expect(h.rows()).not.toBe(before);
  });

  it("the owner lists the plan comments; a member with no part and another company's caller read no such task", async () => {
    const h = await ruleWorld();
    const path = `/v1/dev/tasks/${h.task.taskId}/comments`;
    expect(await h.dev(MAYA, "GET", path)).toEqual({ status: 200, body: { comments: [] } });
    for (const who of [SAM, OMAR]) expect(await h.dev(who, "GET", path), who.name).toEqual(await h.missing(who, "GET", "/comments"));
  });

  it("each People route answers the owner and a member from the People module, and refuses another company's caller as a missing task without reading the body or writing", async () => {
    const h = await ruleWorld();
    const asked: Array<[string, string, unknown]> = [
      ["GET", "/people", undefined], ["GET", "/people/candidates", undefined], ["GET", `/people/requests/${randomUUID()}`, undefined],
      ["POST", "/people/role", {}], ["POST", "/people/role", { requestId: randomUUID(), expectedPeopleRevision: 1, personId: randomUUID(), role: "viewer" }],
      ["POST", "/people/take-ownership", {}], ["POST", "/people/take-ownership", { requestId: randomUUID(), expectedPeopleRevision: 1 }],
      ["POST", "/people/add", {}], ["POST", "/people/add", { requestId: randomUUID(), expectedPeopleRevision: 1, developerId: TESS.developerId, role: "viewer" }],
    ];
    // The owner, and a member of the same company with no part in the task: the People module answers them, never the core's "not yet".
    for (const who of [MAYA, SAM]) for (const [method, suffix, body] of asked) {
      const onCore = await h.dev(who, method, `/v1/dev/tasks/${h.task.taskId}${suffix}`, body);
      expect(onCore.body, `${who.name} ${method} ${suffix}`).not.toEqual({ error: { code: "NOT_FOUND", message: NOT_ON_THE_CORE_YET } });
    }
    // These answers are the People module's own (this deployment has no People switch on), never the core's "not yet" or a missing task's.
    expect((await h.dev(MAYA, "GET", `/v1/dev/tasks/${h.task.taskId}/people`)).body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: "Task People is unavailable in this deployment" } });
    const before = h.rows();
    for (const [method, suffix, body] of [...asked, ["POST", "/people/role", "[1]"], ["POST", "/people/add", null]] as Array<[string, string, unknown]>) {
      expect(await h.dev(OMAR, method, `/v1/dev/tasks/${h.task.taskId}${suffix}`, body), `${method} ${suffix}`).toEqual(await h.missing(OMAR, method, suffix, body));
    }
    expect(h.rows()).toBe(before);
  });

});

describe("DEC 254zzz44 (a): a reader the owner shared a core task with opens it (the old task read's reader rule)", () => {
  it("reads the task while shared and still a project member; never before sharing, after unsharing or after leaving the project; a member with no part reads no such task", async () => {
    const h = await ruleWorld();
    const path = `/v1/dev/tasks/${h.task.taskId}`;
    const own = await h.dev(MAYA, "GET", path);
    expect(own.status).toBe(200);
    for (const who of [TESS, SAM]) expect(await h.dev(who, "GET", path), who.name).toEqual(await h.missing(who, "GET", ""));
    await h.dev(MAYA, "PUT", `${path}/readers/${TESS.developerId}`, { requestId: randomUUID(), role: "viewer" });
    const shared = await h.dev(TESS, "GET", path);
    const { money, ...readableTask } = own.body.task as Record<string, unknown>;
    expect(money).toBeDefined();
    expect(shared).toEqual({ ...own, body: { ...own.body, task: readableTask } });
    expect(await h.dev(SAM, "GET", path)).toEqual(await h.missing(SAM, "GET", ""));
    // Off the project: no longer a reader; back on it: a reader again; unshared (revoked): no longer.
    h.db.delete(`MEMBER#${TESS.developerId}`, "PROJECT#payments");
    expect(await h.dev(TESS, "GET", path)).toEqual(await h.missing(TESS, "GET", ""));
    grantProject(h.db, TESS);
    expect((await h.dev(TESS, "GET", path)).status).toBe(200);
    await h.dev(MAYA, "DELETE", `${path}/readers/${TESS.developerId}`);
    expect(await h.dev(TESS, "GET", path)).toEqual(await h.missing(TESS, "GET", ""));
  });

  it("another company's person reads no such task even with a reader row naming them; without the deployment's wiring a reader row gives nothing", async () => {
    const h = await ruleWorld();
    const path = `/v1/dev/tasks/${h.task.taskId}`;
    for (const who of [OMAR, TESS]) h.db.set({ pk: `DEVTASK#${h.task.taskId}`, sk: `READER#${who.developerId}`, schemaVersion: 1, developerId: who.developerId, role: "viewer", grantedBy: MAYA.developerId, grantedAt: "2026-11-15T00:00:00.000Z" });
    grantProject(h.db, OMAR);
    expect(await h.dev(OMAR, "GET", path)).toEqual(await h.missing(OMAR, "GET", ""));
    expect((await h.dev(TESS, "GET", path)).status).toBe(200);
    const unwired = await ruleWorld({ rules: false });
    unwired.db.set({ pk: `DEVTASK#${unwired.task.taskId}`, sk: `READER#${TESS.developerId}`, schemaVersion: 1, developerId: TESS.developerId, role: "viewer", grantedBy: MAYA.developerId, grantedAt: "2026-11-15T00:00:00.000Z" });
    expect(await unwired.dev(TESS, "GET", `/v1/dev/tasks/${unwired.task.taskId}`)).toEqual(await unwired.missing(TESS, "GET", ""));
  });
});


// S1: the People moves of the task action registry, in process (the same People functions the routes call). Where People is not configured the move says so (the same refusal as the route), a task of another company is refused as missing
// before any People function runs, and nothing is written either way.
describe("the registry's People moves on a core task (S1)", () => {
  it("answers as the People routes do where People is not configured, and refuses another company's task as missing; nothing is written", async () => {
    const h = await ruleWorld();
    const record = (await h.world.store.get(taskKey(h.task.taskId)))!;
    const viewer = (who: Developer, task: Record<string, unknown> = record) => ({ person: { developerId: who.developerId, name: who.name }, companyId: FAKE_COMPANY, task });
    const before = h.rows();
    await expect(h.rules.people.view(viewer(MAYA))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(h.rules.people.takeOwnership({ ...viewer(MAYA), requestId: randomUUID(), expectedPeopleRevision: 1 })).rejects.toBeDefined();
    const foreign = { ...record, companyId: OTHER };
    await expect(h.rules.people.view(viewer(MAYA, foreign))).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(h.rules.people.takeOwnership({ ...viewer(MAYA, foreign), requestId: randomUUID(), expectedPeopleRevision: 1 })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(h.rows()).toBe(before);
  });
});
