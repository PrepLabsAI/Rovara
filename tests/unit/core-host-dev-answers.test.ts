// S3 (web task channel): the owner's answers to Understand's questions on a core task through the core host's dev routes, `POST /v1/dev/tasks/{id}/answers` (`{ requestId, round, answers }`
// in, `{ task }` out). D5: only the task's owners answer (the company's owner rule; a People owner counts). A People commenter or viewer, a company owner or admin who is not the task's
// owner, another company, a revoked member and a script token may not: anyone who may not read the task gets the missing task's answer, a reader who may not answer gets fixed words.
// One request id is one answer; the round asked is checked; the body is checked at runtime with fixed words.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, recordIntentAssessment, startWorkflowUnderstand, when, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { commitWorkflow } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { ANSWERS_BODY_INVALID, ANSWER_NOT_YOURS, ANSWER_REQUEST_REUSED, answerTaskOnRequest } from "../../packages/broker/src/core/task-flow/answer-request.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { createSessionStartExtras } from "../../packages/broker/src/local/app/session-start.js";
import { developerIdOf, taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import type { SessionMembers, SessionProjectRole } from "../../packages/broker/src/core/sessions/access.js";

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
const QUESTIONS = [
  { id: "q1", text: "Which endpoint path?", options: [{ id: "a", label: "/health" }, { id: "b", label: "/healthz" }], recommended: "a" },
  { id: "q2", text: "Anything else to check?" },
];
const ANSWERS = [{ questionId: "q1", optionId: "a" }, { questionId: "q2", text: "Return the version too" }];

/**
 * The company's rule as a deployment wires it (hostedTaskAccess's shape): the person the task runs for, and the People owners named in `coOwners`, act as its owner (a People owner's act
 * carries a revision fence); `readers` may read it (a People commenter or viewer) but are no owner. Every role is ignored.
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
      return { actorId: task.ownerKey, items: [{ kind: "check", key: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" }, condition: when.eq("revision", revision as number) }] };
    },
  };
}

function appWith(world: FakeWorld, access: TaskFlowDeps["access"]): CoreHostApp {
  return createCoreHostApp({
    env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI, flowOptions: { understandFirst: true } }),
  });
}

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

async function waiting(options: { access?: "hosted" | "laptop"; questions?: boolean } = {}) {
  const world = createFakeWorld();
  await registerProject(world, FAKE_COMPANY);
  await registerProject(world, OTHER);
  const people = { coOwners: new Set<string>(), readers: new Set<string>() };
  const app = appWith(world, options.access === "laptop" ? createOwnerTaskAccess() : hostedRule(world, people));
  const members = new Map<string, CompanyMembership>();
  const companyOf = vi.fn(async (caller: DeployedCaller) => members.get(`${caller.principal.personId}|${caller.principal.companyId}`));
  /** A caller whose principal carries the `owner` role whatever membership says (the route must never take that role for an owner of the task). */
  const person = (personId: string, companyId: string, role: CompanyMembership["role"] | null): DeployedCaller => {
    if (role !== null) members.set(`${personId}|${companyId}`, { companyId, role });
    return { principal: localOwnerPrincipal({ companyId, personId }), client: "cli" };
  };
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
  const owner = person(OWNER_ID, FAKE_COMPANY, "member");
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const deps = runtime.flow.deps;
  const { task } = await runtime.flow.start({ principal: owner.principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true });
  if (options.questions !== false) {
    // Understand asked its first round of questions (the worker's answer, recorded as the callback would).
    let record = (await readTask(deps, task.taskId))!;
    if (record.workflow?.state === "READY") {
      expect(await commitWorkflow(deps, record, startWorkflowUnderstand(record.workflow, new Date(world.clock.now).toISOString()))).toBe(true);
      record = (await readTask(deps, task.taskId))!;
    }
    const asked = recordIntentAssessment(record.workflow, { expectedRevision: record.workflow!.revision, assessment: { kind: "questions", restatement: "Add a health endpoint.", questions: QUESTIONS }, now: new Date(world.clock.now).toISOString() });
    expect(await commitWorkflow(deps, record, asked)).toBe(true);
  }
  const workflow = async () => (await readTask(deps, task.taskId))!.workflow!;
  const answer = (caller: DeployedCaller, body: unknown = { requestId: randomUUID(), round: 1, answers: ANSWERS }, id: string = task.taskId) => routes.route(post(`/v1/dev/tasks/${id}/answers`, body), caller);
  const rows = async () => JSON.stringify((await (world.store as unknown as { scanPage(request: { limit: number }): Promise<{ items: unknown[] }> }).scanPage({ limit: 1000 })).items);
  return { world, app, routes, people, person, owner, task, workflow, answer, companyOf, rows, members, runtime, deps };
}

const parsed = (answer: { body: string } | undefined) => JSON.parse(answer!.body) as { task?: { taskId: string; status: string }; error?: { code: string; message: string } };

describe("POST /v1/dev/tasks/{id}/answers on a core task", () => {
  it("is waiting for the first round of answers (the fixture's precondition)", async () => {
    const { workflow } = await waiting();
    const now = await workflow();
    expect([now.stage, now.state, now.intent?.rounds, now.intent?.assessment?.kind]).toEqual(["UNDERSTAND", "WAITING", 1, "questions"]);
  });

  it("takes the owner's answers and answers { task } in the developer task view; Understand runs again with them, recorded as the owner's", async () => {
    const { answer, owner, task, workflow, world, deps } = await waiting();
    const before = (await workflow()).revision;
    const ownerKey = (await readTask(deps, task.taskId))!.ownerKey;
    const reply = await answer(owner);
    expect(reply?.statusCode).toBe(200);
    expect(parsed(reply).task?.taskId).toBe(task.taskId);
    const after = await workflow();
    expect(after.revision).toBeGreaterThan(before);
    expect(after.intent?.answers).toHaveLength(1);
    expect(after.intent?.answers[0]).toMatchObject({ round: 1, source: "cli", answers: ANSWERS, by: { actorId: ownerKey } });
    expect(world.audit.filter((event) => event.action === "task.questions_answered").map((event) => event.details)).toEqual([{ project: "payments", round: 1 }]);
  });

  it("takes a People owner's answers (a co-owner by the company's owner rule), with the People revision fenced into the move", async () => {
    const { answer, person, people, world, task, workflow } = await waiting();
    await world.store.put({ item: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE", revision: 3 } });
    people.coOwners.add("person-coowner-000000001");
    expect((await answer(person("person-coowner-000000001", FAKE_COMPANY, "member")))?.statusCode).toBe(200);
    expect((await workflow()).intent?.answers).toHaveLength(1);
  });

  it("refuses a People owner whose People revision changed between the check and the move (a missing task's answer; nothing answered)", async () => {
    const { answer, person, people, world, task, workflow } = await waiting();
    await world.store.put({ item: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE", revision: 3 } });
    people.coOwners.add("person-coowner-000000001");
    const coOwner = person("person-coowner-000000001", FAKE_COMPANY, "member");
    const transact = world.store.transact.bind(world.store);
    vi.spyOn(world.store, "transact").mockImplementationOnce(async (items) => {
      await world.store.put({ item: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE", revision: 4 } });
      people.coOwners.delete("person-coowner-000000001");
      return await transact(items);
    });
    const reply = await answer(coOwner);
    expect(reply?.statusCode).toBe(404);
    expect((await workflow()).intent?.answers).toHaveLength(0);
  });

  it.each(["commenter", "viewer"])("refuses a People %s (may read the task, is no owner) with fixed words; nothing is written", async (kind) => {
    const { answer, person, people, rows, workflow } = await waiting();
    const reader = `person-${kind}-0000000001`;
    people.readers.add(reader);
    const before = await rows();
    const reply = await answer(person(reader, FAKE_COMPANY, "member"));
    expect(reply?.statusCode).toBe(403);
    expect(parsed(reply).error).toEqual({ code: "FORBIDDEN", message: ANSWER_NOT_YOURS });
    expect(await rows()).toBe(before);
    expect((await workflow()).intent?.answers).toHaveLength(0);
  });

  it.each(["owner", "admin"] as const)("refuses a live company %s who is not the task's owner (D5): a missing task's answer, nothing written", async (role) => {
    const { answer, person, rows, routes, workflow } = await waiting();
    const admin = person(`person-company-${role}-0000001`, FAKE_COMPANY, role);
    const before = await rows();
    const reply = await answer(admin);
    const missing = await routes.route(post(`/v1/dev/tasks/${randomUUID()}/answers`, { requestId: randomUUID(), round: 1, answers: ANSWERS }), admin);
    expect(reply?.statusCode).toBe(404);
    expect(reply?.body).toBe(missing?.body);
    expect(await rows()).toBe(before);
    expect((await workflow()).intent?.answers).toHaveLength(0);
  });

  it("two companies: an owner, admin or member of company B cannot answer company A's core task, and is answered exactly like a task id that does not exist, for every body", async () => {
    const { answer, person, routes, rows, workflow } = await waiting();
    for (const role of ["owner", "admin", "member"] as const) {
      const theirs = person(`person-b-${role}-000000001`, OTHER, role);
      for (const body of [{ requestId: randomUUID(), round: 1, answers: ANSWERS }, {}, [1], null, "nope"]) {
        const before = await rows();
        const reply = await answer(theirs, body);
        const missing = await routes.route(post(`/v1/dev/tasks/${randomUUID()}/answers`, body), theirs);
        expect(reply?.statusCode, role).toBe(404);
        expect(reply?.body, role).toBe(missing?.body);
        expect(reply?.body, role).not.toContain(FAKE_COMPANY);
        expect(await rows(), role).toBe(before);
      }
    }
    expect((await workflow()).intent?.answers).toHaveLength(0);
  });

  it("two companies: the owner's own person id signed in to company B (a rule that matched person ids alone would call them the owner) reads a missing task; nothing answered", async () => {
    const { answer, person, routes, rows, workflow } = await waiting();
    const twin = person(OWNER_ID, OTHER, "member");
    const before = await rows();
    const reply = await answer(twin);
    const missing = await routes.route(post(`/v1/dev/tasks/${randomUUID()}/answers`, { requestId: randomUUID(), round: 1, answers: ANSWERS }), twin);
    expect(reply?.statusCode).toBe(404);
    expect(reply?.body).toBe(missing?.body);
    expect(await rows()).toBe(before);
    expect((await workflow()).intent?.answers).toHaveLength(0);
  });

  it("a person of company A whose principal names company B (or a revoked member: no membership) is refused before anything is read", async () => {
    const { answer, person, workflow, rows, owner, members } = await waiting();
    const before = await rows();
    const revoked = person("person-revoked-000000001", FAKE_COMPANY, null);
    expect((await answer(revoked))?.statusCode).toBe(401);
    // A principal naming another company than membership's.
    const crossed: DeployedCaller = { ...owner, principal: { ...owner.principal, companyId: OTHER } };
    members.set(`${OWNER_ID}|${OTHER}`, { companyId: FAKE_COMPANY, role: "member" });
    expect((await answer(crossed))?.statusCode).toBe(401);
    // The task's own owner, once their membership is gone, is refused too.
    members.delete(`${OWNER_ID}|${FAKE_COMPANY}`);
    expect((await answer(owner))?.statusCode).toBe(401);
    expect(await rows()).toBe(before);
    expect((await workflow()).intent?.answers).toHaveLength(0);
  });

  it("a script token never answers: the missing task's words, nothing read for the task", async () => {
    const { answer, owner, workflow, routes, task } = await waiting();
    const token: DeployedCaller = { ...owner, scriptToken: { tokenId: "tok_1" } };
    const reply = await answer(token);
    const missing = await routes.route(post(`/v1/dev/tasks/${randomUUID()}/answers`, { requestId: randomUUID(), round: 1, answers: ANSWERS }), token);
    expect(reply?.statusCode).toBe(404);
    expect(reply?.body.replaceAll(task.taskId, "<id>")).toBe(missing?.body);
    expect((await workflow()).intent?.answers).toHaveLength(0);
  });

  it("is idempotent by request id: a repeat answers the same task and answers nothing twice; the same id with other answers is refused", async () => {
    const { answer, owner, workflow, world, task } = await waiting();
    const requestId = randomUUID();
    const first = await answer(owner, { requestId, round: 1, answers: ANSWERS });
    expect(first?.statusCode).toBe(200);
    const revision = (await workflow()).revision;
    const again = await answer(owner, { requestId, round: 1, answers: ANSWERS });
    expect(again?.statusCode).toBe(200);
    expect(parsed(again).task?.taskId).toBe(task.taskId);
    expect((await workflow()).revision).toBe(revision);
    expect((await workflow()).intent?.answers).toHaveLength(1);
    expect(world.audit.filter((event) => event.action === "task.questions_answered")).toHaveLength(1);
    const other = await answer(owner, { requestId, round: 1, answers: [{ questionId: "q1", optionId: "b" }, { questionId: "q2", text: "No" }] });
    expect(other?.statusCode).toBe(409);
    expect(parsed(other).error).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: ANSWER_REQUEST_REUSED });
    expect((await workflow()).revision).toBe(revision);
  });

  it("a race of two with one request id answers once: the loser of the commit answers the winner's task", async () => {
    const { owner, workflow, deps, task } = await waiting();
    const requestId = randomUUID();
    const body = { requestId, round: 1, answers: ANSWERS };
    const caller = { principal: owner.principal, client: "cli" };
    const [one, two] = await Promise.all([answerTaskOnRequest(deps, caller, task.taskId, () => body), answerTaskOnRequest(deps, caller, task.taskId, () => body)]);
    expect([one.repeated, two.repeated].sort()).toEqual([false, true]);
    expect((await workflow()).intent?.answers).toHaveLength(1);
  });

  it("keeps the stale-form guard: answers for another round are refused 'not waiting', a new request id included; nothing is written", async () => {
    const { answer, owner, rows } = await waiting();
    const before = await rows();
    for (const round of [2, 3]) {
      const reply = await answer(owner, { requestId: randomUUID(), round, answers: ANSWERS });
      expect(reply?.statusCode).toBe(409);
      expect(parsed(reply).error?.code).toBe("INTENT_NOT_WAITING");
    }
    expect(await rows()).toBe(before);
    // Once answered, a fresh request for the same round is a stale form.
    expect((await answer(owner))?.statusCode).toBe(200);
    expect(parsed(await answer(owner)).error?.code).toBe("INTENT_NOT_WAITING");
  });

  it("a core task not waiting for answers answers 'not waiting'", async () => {
    const { answer, owner } = await waiting({ questions: false });
    const reply = await answer(owner);
    expect(reply?.statusCode).toBe(409);
    expect(parsed(reply).error?.code).toBe("INTENT_NOT_WAITING");
  });

  it("a body that is not JSON is refused in fixed words (no echo), nothing written", async () => {
    const { routes, owner, rows, task } = await waiting();
    const before = await rows();
    const reply = await routes.route({ method: "POST", path: `/v1/dev/tasks/${task.taskId}/answers`, headers: {}, body: "{SECRET-ECHO-4f1a" }, owner);
    expect(reply?.statusCode).toBe(400);
    expect(parsed(reply).error).toEqual({ code: "CONFIG_INVALID", message: "the request body is not JSON" });
    expect(await rows()).toBe(before);
  });

  it("checks the body at runtime with Code's limits and fixed words (no echo), before anything is written", async () => {
    const { answer, owner, rows } = await waiting();
    const secret = "SECRET-ECHO-4f1a";
    const ok = { requestId: randomUUID(), round: 1, answers: ANSWERS };
    const bad: unknown[] = [
      {}, [], null, 7, secret,
      { ...ok, requestId: secret }, { ...ok, requestId: undefined }, { ...ok, round: 0 }, { ...ok, round: 1.5 }, { ...ok, round: "1" }, { ...ok, round: undefined },
      { ...ok, answers: [] }, { ...ok, answers: [...ANSWERS, { questionId: "q3", optionId: "a" }, { questionId: "q1", optionId: "b" }] }, { ...ok, answers: secret },
      { ...ok, answers: [{ questionId: "q4", optionId: "a" }] }, { ...ok, answers: [{ questionId: secret, optionId: "a" }] }, { ...ok, answers: [{ questionId: "q1", optionId: "e" }] },
      { ...ok, answers: [{ questionId: "q1", optionId: secret }] }, { ...ok, answers: [{ questionId: "q1", text: "" }] }, { ...ok, answers: [{ questionId: "q1", text: "x".repeat(2001) + secret }] },
      { ...ok, answers: [{ questionId: "q1" }] }, { ...ok, answers: [{ questionId: "q1", optionId: "a", extra: secret }] }, { ...ok, extra: secret }, { ...ok, revision: 3 },
    ];
    const before = await rows();
    for (const body of bad) {
      const reply = await answer(owner, body);
      expect(reply?.statusCode, JSON.stringify(body)).toBe(400);
      expect(parsed(reply).error, JSON.stringify(body)).toEqual({ code: "CONFIG_INVALID", message: ANSWERS_BODY_INVALID });
      expect(reply?.body).not.toContain(secret);
    }
    expect(await rows()).toBe(before);
  });

  it("text of exactly 2,000 characters and three answers are within the limits (the workflow then judges them against the questions)", async () => {
    const { answer, owner } = await waiting();
    const reply = await answer(owner, { requestId: randomUUID(), round: 1, answers: [{ questionId: "q1", optionId: "a", text: "y".repeat(2000) }, { questionId: "q2", text: "z" }] });
    expect(reply?.statusCode).toBe(200);
    const three = await answer(owner, { requestId: randomUUID(), round: 1, answers: [{ questionId: "q1", optionId: "a" }, { questionId: "q2", text: "z" }, { questionId: "q3", text: "w" }] });
    // Three answers pass the body check; the workflow refuses an answer for a question it did not ask (round 1 is answered already, so it is a stale form now).
    expect(parsed(three).error?.code).toBe("INTENT_NOT_WAITING");
  });

  it("is not served without the company's owner rule (Code's laptop rule never decides on a hosted company): the boundary decides what to say", async () => {
    const { answer, owner, workflow } = await waiting({ access: "laptop" });
    expect(await answer(owner)).toBeUndefined();
    expect((await workflow()).intent?.answers).toHaveLength(0);
  });
});

// Q1 (D5): the core's own session route, `POST /v1/app/sessions/{id}/answers` (the laptop's, and the hosted session routes where a deployment wires the session levels), needs the owner's
// level `edit`. A People commenter (`use`) comments and asks; it never answers the agent. A People viewer (`view`) only watches.
describe("POST /v1/app/sessions/{id}/answers needs the owner's level", () => {
  async function sessionWorld() {
    const world = createFakeWorld();
    await registerProject(world, FAKE_COMPANY);
    const app = createCoreHostApp({
      env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
      runtime: () => ({
        callbackSigningKey: Buffer.alloc(32, 7), access: hostedRule(world, { coOwners: new Set(), readers: new Set() }), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }),
        now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI, flowOptions: { understandFirst: true, startExtras: createSessionStartExtras(FAKE_COMPANY) },
      }),
    });
    const grants = new Map<string, SessionProjectRole>();
    const sessionMembers: SessionMembers = { companyRole: (person) => (person.companyId === FAKE_COMPANY ? "member" : undefined), projectGrant: (person) => grants.get(person.developerId) };
    const companyOf = async (caller: DeployedCaller) => (caller.principal.companyId === FAKE_COMPANY ? { companyId: FAKE_COMPANY, role: "member" as const } : undefined);
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, members: sessionMembers }) });
    const caller = (personId: string): DeployedCaller => ({ principal: { ...localOwnerPrincipal({ companyId: FAKE_COMPANY, personId }), roles: ["member"] }, client: "cli" });
    const owner = caller(OWNER_ID);
    const runtime = await app.runtimeFor(FAKE_COMPANY);
    const deps = runtime.flow.deps;
    const { task } = await runtime.flow.start({ principal: owner.principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true });
    let record = (await readTask(deps, task.taskId))!;
    if (record.workflow?.state === "READY") { expect(await commitWorkflow(deps, record, startWorkflowUnderstand(record.workflow, new Date(world.clock.now).toISOString()))).toBe(true); record = (await readTask(deps, task.taskId))!; }
    expect(await commitWorkflow(deps, record, recordIntentAssessment(record.workflow, { expectedRevision: record.workflow!.revision, assessment: { kind: "questions", restatement: "Add a health endpoint.", questions: QUESTIONS }, now: new Date(world.clock.now).toISOString() }))).toBe(true);
    const people = async (entries: Array<[DeployedCaller, string]>) => world.store.put({ item: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE", schemaVersion: 1, people: entries.map(([who, role]) => ({ developerId: developerIdOf(who.principal), role })) } });
    const answer = (who: DeployedCaller) => routes.route(post(`/v1/app/sessions/${taskSessionId(task.taskId)}/answers`, { requestId: randomUUID(), round: 1, answers: ANSWERS }), who);
    const answered = async () => (await readTask(deps, task.taskId))!.workflow!.intent!.answers.length;
    return { caller, owner, people, answer, answered, grants };
  }

  it.each(["commenter", "viewer"])("refuses a People %s (SESSION_LEVEL_REQUIRED), nothing answered", async (role) => {
    const { caller, people, answer, answered } = await sessionWorld();
    const them = caller(`person-${role}-0000000001`);
    await people([[them, role]]);
    const reply = await answer(them);
    expect(reply?.statusCode).toBe(403);
    expect(parsed(reply).error?.code).toBe("SESSION_LEVEL_REQUIRED");
    expect(await answered()).toBe(0);
  });

  it("takes the task owner's answers (level edit)", async () => {
    const { owner, answer, answered } = await sessionWorld();
    expect((await answer(owner))?.statusCode).toBe(200);
    expect(await answered()).toBe(1);
  });

  it("a stranger in the company reads a missing session", async () => {
    const { caller, answer, answered } = await sessionWorld();
    expect((await answer(caller("person-stranger-00000001")))?.statusCode).toBe(404);
    expect(await answered()).toBe(0);
  });
});
