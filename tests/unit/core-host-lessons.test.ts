// Lessons on the core engine of a deployed install (lanes LM1, LM2, LM3, LM5; DEC 225/226). Off by default and fail closed; for a company the switch covers: a step is given that company's lessons and
// never another company's, a merged task is queued for reflection under its own company, the shared reflection queue hands each message to its own company, people come from the deployment's port for
// that company only, an erased or outside person's words never teach, and learning model calls go only through the injected port and only while the switch covers the company.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_CONTEXT_FEATURE, LEARNED_CONTEXT_FEATURE, companyScoped, projectPk, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { digestWeekOf, writeDigestSetting } from "../../packages/broker/src/lessons/digest-notice.js";
import { buildCoreRegistry, createCoreRuntime, CORE_ENGINE_OFF, readCoreEngineFlags, type CoreRuntime } from "../../packages/broker/src/core-host/index.js";
import { createCoreLessons, erasePersonLessons, readCoreLessonsSwitch, setCoreLessonsGate, CORE_LESSONS_VARIABLE, type CoreLessons } from "../../packages/broker/src/core-host/lessons.js";
import { createHostedLessonParts, OtherCompanyError, type HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { learnedLessonsSwitchOn, setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { pumpReflectQueue, reflectMessageCompany } from "../../packages/broker/src/lessons/host-glue.js";
import { reflectQueueOf } from "../../packages/broker/src/lessons/reflect-queue.js";
import { createLocalLessonSources } from "../../packages/broker/src/local/app/lessons-sources.js";
import { createLessonRepositories, type LessonRepositories } from "../../packages/broker/src/local/app/lessons-repos.js";
import type { PipelineModel } from "../../packages/broker/src/lessons/ports.js";
import type { KnowledgeSources } from "../../packages/broker/src/lessons/knowledge-brief.js";
import { flakyFactsPort } from "../../packages/broker/src/lessons/knowledge-facts.js";
import { baseFlakyTests } from "../../packages/broker/src/core/test-env/base-flaky.js";
import { readKnowledgeDelivery } from "../../packages/broker/src/lessons/knowledge-use.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { ownerNoteItem } from "../../packages/broker/src/core/task-flow/owner-note.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { lessonRecord, draft } from "./lessons/lesson-helpers.js";
import { answersBriefingOf } from "../../packages/broker/src/aws/core-engine-root.js";
import { routeHostedAnswers, type HostedAnswersWiring } from "../../packages/broker/src/core-host/answer-routes.js";
import { HEAD, REFUND_TS, answer, goodSentence, scriptedModel } from "../support/answer-world.js";

afterEach(() => setLearnedLessonsGate(undefined));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

/** The deployment's people port over fixed lists: `members[company]` are on every project's roster; `erased` are gone. Records every company it was asked about. */
function peopleOf(members: Record<string, string[]>, erased: string[] = []): HostedLessonPeople & { asked: string[] } {
  const asked: string[] = [];
  const note = (companyId: string): void => { asked.push(companyId); };
  return {
    asked,
    async approvers(companyId) { note(companyId); const list = members[companyId] ?? []; return { complete: true, membershipVersion: 1, ownerIds: list.slice(0, 1), eligibleIds: list, lastEligibleLossAtMs: null }; },
    async onProjectRoster(companyId, _project, personId) { note(companyId); return (members[companyId] ?? []).includes(personId); },
    async linkedAccounts(companyId) { note(companyId); return []; },
    async displayName(companyId, personId) { note(companyId); return (members[companyId] ?? []).includes(personId) ? `Person ${personId}` : undefined; },
    async isErased(companyId, personId) { note(companyId); return erased.includes(personId); },
  };
}

/** A learning model that records every call (the gateway's stand-in). */
function recordingModel(): PipelineModel & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async complete(request) { calls.push(`${request.purpose}:${request.workspaceId}`); return { text: JSON.stringify({ candidates: [] }), costUsd: 0.001, model: "fake" }; } };
}

interface Company { runtime: CoreRuntime; lessons: CoreLessons | undefined; personId: string; taskId: string; workspaceId: string }

async function companyWorld(world: FakeWorld, env: NodeJS.ProcessEnv, people: HostedLessonPeople, hosts: Map<string, CoreLessons>, model?: PipelineModel, knowledge?: (companyId: OrgId, world: FakeWorld) => KnowledgeSources): Promise<Map<string, Company>> {
  setCoreLessonsGate(env);
  const registry = await buildCoreRegistry({ modules: world.modules, context: world.context(), areas: ["flow", "build", "merge"] });
  const lessonsSwitch = readCoreLessonsSwitch(env).value;
  const out = new Map<string, Company>();
  for (const companyId of [A, B]) {
    await registerProject(world, companyId);
    const runtime = createCoreRuntime({
      registry, companyId, flags: readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on" }), callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
    });
    const lessons = createCoreLessons({
      flow: runtime.flow, registry, companyId, lessonsSwitch, people, hostFor: async (id) => hosts.get(id)?.host, now: () => world.clock.now,
      ...(model === undefined ? {} : { learning: { model, spend: { admit: async () => true } } }),
      ...(knowledge === undefined ? {} : { knowledge: knowledge(companyId, world) }),
    });
    lessons?.attach();
    if (lessons !== undefined) hosts.set(companyId, lessons);
    const principal = localOwnerPrincipal({ companyId });
    const { task } = await runtime.flow.start({ principal, client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint\nreturn 200", workflow: true, workflowPath: "QUICK" });
    out.set(companyId, { runtime, lessons, personId: principal.personId, taskId: task.taskId, workspaceId: task.workspaceId });
  }
  return out;
}

/** An active lesson of `companyId`'s payments project, approved by a person. */
const activeLesson = (companyId: string, id: string, title: string) => lessonRecord({
  id, workspaceId: companyId, project: "payments", tier: 1, tierReasons: [], approvals: [{ approvalId: "a1", by: "person-1", at: 1, mode: "one" }], scope: {}, citations: [], citationChecks: [],
  stages: ["UNDERSTAND", "PLAN", "IMPLEMENT", "REVIEW"], provenance: { ...draft().provenance, supportTasks: [] }, title, description: "Retries go through withRetry.", body: "Wrap network calls in withRetry instead of looping by hand.",
});

async function putLesson(lessons: CoreLessons, lesson: ReturnType<typeof lessonRecord>): Promise<void> {
  const key = { workspaceId: lesson.workspaceId, project: lesson.project };
  await lessons.runtime.store.commit(key, await lessons.runtime.store.setVersion(key), [lesson], 1);
}

describe("the switch", () => {
  it("is off by default and fails closed: anything but off, on or on:<company ids> is off, with a problem that never echoes the value", () => {
    expect(readCoreLessonsSwitch({})).toEqual({ value: { mode: "off" } });
    expect(readCoreLessonsSwitch({ [CORE_LESSONS_VARIABLE]: `on:${A}` })).toEqual({ value: { mode: "on-for", companies: [A] } });
    for (const bad of ["1", "true", "ON", "drain", `on:${A},${B}`]) {
      const read = readCoreLessonsSwitch({ [CORE_LESSONS_VARIABLE]: bad });
      expect(read.value, bad).toEqual({ mode: "off" });
      expect(read.problem, bad).toBeDefined();
      expect(read.problem, bad).not.toContain(bad);
    }
  });

  it("with it off nothing is built, the task flow's lessons slots stay empty, and the install gate refuses every learning call", async () => {
    const world = createFakeWorld();
    const model = recordingModel();
    const companies = await companyWorld(world, {}, peopleOf({ [A]: [], [B]: [] }), new Map(), model);
    for (const company of companies.values()) {
      expect(company.lessons).toBeUndefined();
      expect(company.runtime.flow.deps.learned).toBeUndefined();
      expect(company.runtime.flow.deps.lessonsUsed).toBeUndefined();
      expect(company.runtime.flow.deps.milestones).toBeUndefined();
    }
    expect(learnedLessonsSwitchOn()).toBe(false);
    expect(model.calls).toEqual([]);
    // The core engine's own switch being off changes nothing here either.
    expect(CORE_ENGINE_OFF.combined.mode).toBe("off");
  });

  it("on:<company> builds lessons for that company only", async () => {
    const world = createFakeWorld();
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: `on:${A}` }, peopleOf({ [A]: [], [B]: [] }), new Map());
    expect(companies.get(A)!.lessons).toBeDefined();
    expect(companies.get(A)!.runtime.flow.deps.learned).toBeTypeOf("function");
    expect(companies.get(B)!.lessons).toBeUndefined();
    expect(companies.get(B)!.runtime.flow.deps.learned).toBeUndefined();
    expect(learnedLessonsSwitchOn()).toBe(true);
  });
});

describe("delivery: a step gets its own company's lessons, never another's", () => {
  it("a lesson of company A loads into A's step, and B's step (same project name) gets none of A's", async () => {
    const world = createFakeWorld();
    const people = peopleOf({ [A]: [], [B]: [] });
    const hosts = new Map<string, CoreLessons>();
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: "on" }, people, hosts);
    const a = companies.get(A)!;
    const b = companies.get(B)!;
    await putLesson(a.lessons!, activeLesson(A, "les_aaaa1111", "Use the retry helper"));
    for (const company of [a, b]) {
      const record = await world.store.get(taskKey(company.taskId));
      expect(record?.["companyId"]).toBe(company === a ? A : B);
    }
    const loadedA = await a.runtime.flow.deps.learned!({ workspaceId: a.workspaceId, operationId: "op-a", workflowMode: "PLAN", features: [LEARNED_CONTEXT_FEATURE] });
    expect(loadedA.learnedContext?.lessons.map((lesson) => lesson.id)).toEqual(["les_aaaa1111"]);
    const loadedB = await b.runtime.flow.deps.learned!({ workspaceId: b.workspaceId, operationId: "op-b", workflowMode: "PLAN", features: [LEARNED_CONTEXT_FEATURE] });
    expect(loadedB).toEqual({});
    // A's lessons asked about B's task (a wrong routing, an attack) answer nothing.
    expect(await a.runtime.flow.deps.learned!({ workspaceId: b.workspaceId, operationId: "op-x", workflowMode: "PLAN", features: [LEARNED_CONTEXT_FEATURE] })).toEqual({});
    // A worker that does not take lessons, or a mode that carries none, gets none.
    expect(await a.runtime.flow.deps.learned!({ workspaceId: a.workspaceId, operationId: "op-c", workflowMode: "PLAN", features: [] })).toEqual({});
    expect(await a.runtime.flow.deps.learned!({ workspaceId: a.workspaceId, operationId: "op-d", workflowMode: "CHECKS", features: [LEARNED_CONTEXT_FEATURE] })).toEqual({});
    // The people port was never asked about another company than the one each lessons runtime serves.
    expect(people.asked.every((id) => id === A || id === B)).toBe(true);
  });

  it("the pull request names the section: none used, or switched off for a company the switch stopped covering", async () => {
    const world = createFakeWorld();
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: "on" }, peopleOf({ [A]: [], [B]: [] }), new Map());
    const a = companies.get(A)!;
    expect(await a.runtime.flow.deps.lessonsUsed!({ taskId: a.taskId, project: "payments", startingRevision: 1 }, "demo")).toMatchObject({ count: 0, none: true });
  });
});

describe("measured facts on the deployed engine (lead 4 L4-AK2b)", () => {
  const BOTH = [LEARNED_CONTEXT_FEATURE, KNOWLEDGE_CONTEXT_FEATURE];
  const putBaseline = async (world: FakeWorld, company: string, project: string, flaky: string[]) => {
    const finished = new Date(world.clock.now - 3_600_000).toISOString();
    const baseline = { recordedAt: finished, envRevision: 1, branch: "main", headSha: "a".repeat(40), finishedAt: finished, tests: { total: 10, passed: 10, failed: 0, skipped: 0 }, failed: [], flaky };
    await world.store.put({ item: { pk: projectPk(company, project), sk: "TESTENV#BASELINE#LATEST", entityType: "TEST_ENV_BASELINE_LATEST", orgId: company, project, baseline } });
  };
  // The deployment's wiring (aws/core-engine-root.ts): the base's flaky list of THIS company's own store rows.
  const wired = (companyId: OrgId, world: FakeWorld): KnowledgeSources => ({ facts: flakyFactsPort((task) => baseFlakyTests({ store: world.store, now: () => world.clock.now }, task)) });

  it("a Build step of a company carries the base's known-flaky tests of ITS project, counted from its nightly baseline, and never another company's or project's; the record names them", async () => {
    const world = createFakeWorld();
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: "on" }, peopleOf({ [A]: [], [B]: [] }), new Map(), undefined, wired);
    const a = companies.get(A)!;
    const b = companies.get(B)!;
    await putBaseline(world, A, "payments", ["tests/a-only.test.ts"]);
    await putBaseline(world, B, "payments", ["tests/b-only.test.ts"]);
    await putBaseline(world, A, "other-project", ["tests/other-project.test.ts"]);
    const loadedA = await a.runtime.flow.deps.learned!({ workspaceId: a.workspaceId, operationId: "op-fa", workflowMode: "IMPLEMENT", features: BOTH });
    expect(loadedA.knowledgeContext?.facts?.map((fact) => fact.statement).join("\n")).toContain("tests/a-only.test.ts");
    expect(JSON.stringify(loadedA)).not.toMatch(/b-only|other-project/u);
    const loadedB = await b.runtime.flow.deps.learned!({ workspaceId: b.workspaceId, operationId: "op-fb", workflowMode: "IMPLEMENT", features: BOTH });
    expect(JSON.stringify(loadedB)).toContain("tests/b-only.test.ts");
    expect(JSON.stringify(loadedB)).not.toMatch(/a-only|other-project/u);
    const record = await readKnowledgeDelivery(world.store, A, "op-fa");
    expect(record?.pushed).toEqual(loadedA.knowledgeContext!.facts!.map((fact) => `F-${fact.id}`));
    expect(await readKnowledgeDelivery(world.store, B, "op-fa")).toBeUndefined();
    // Not asked of an older worker, and without the wiring a deployment has no facts (the lessons-only briefing as before).
    expect(await a.runtime.flow.deps.learned!({ workspaceId: a.workspaceId, operationId: "op-fo", workflowMode: "IMPLEMENT", features: [LEARNED_CONTEXT_FEATURE] })).toEqual({});
    const bare = await companyWorld(createFakeWorld(), { [CORE_LESSONS_VARIABLE]: "on" }, peopleOf({ [A]: [], [B]: [] }), new Map());
    const bareA = bare.get(A)!;
    expect(await bareA.runtime.flow.deps.learned!({ workspaceId: bareA.workspaceId, operationId: "op-fx", workflowMode: "IMPLEMENT", features: BOTH })).toEqual({});
  });
});

describe("the team knowledge briefing of an answer on the deployed engine (lead 4 L4-AK2b)", () => {
  const ask = { project: "payments", question: "How do we retry network calls?", repos: ["demo"] };
  const scopedLesson = (company: string, id: string, title: string) => ({ ...activeLesson(company, id, title), type: "convention" as const, scope: { repos: ["demo"], paths: ["src/net/**"] } });

  it("a company's answer is briefed with ITS lessons and facts of the asked project alone: never another company's (same project name) or another project's", async () => {
    const world = createFakeWorld();
    const knowledge = (companyId: OrgId, w: FakeWorld): KnowledgeSources => ({ facts: flakyFactsPort((task) => baseFlakyTests({ store: w.store, now: () => w.clock.now }, task)) });
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: "on" }, peopleOf({ [A]: ["person-1"], [B]: ["person-1"] }), new Map(), undefined, knowledge);
    const a = companies.get(A)!;
    const b = companies.get(B)!;
    await putLesson(a.lessons!, scopedLesson(A, "les_aaaa1111", "Retry network calls with the A helper"));
    await putLesson(b.lessons!, scopedLesson(B, "les_bbbb1111", "Retry network calls with the B helper"));
    const finished = new Date(world.clock.now - 3_600_000).toISOString();
    for (const [company, name] of [[A, "tests/a-flaky.test.ts"], [B, "tests/b-flaky.test.ts"]] as const) {
      const baseline = { recordedAt: finished, envRevision: 1, branch: "main", headSha: "a".repeat(40), finishedAt: finished, tests: { total: 5, passed: 5, failed: 0, skipped: 0 }, failed: [], flaky: [name] };
      await world.store.put({ item: { pk: projectPk(company, "payments"), sk: "TESTENV#BASELINE#LATEST", entityType: "TEST_ENV_BASELINE_LATEST", orgId: company, project: "payments", baseline } });
    }
    const forA = (await a.lessons!.host.answerBriefing(ask))!;
    const forB = (await b.lessons!.host.answerBriefing(ask))!;
    expect(forA).toContain("A helper");
    expect(forA).toContain("a-flaky.test.ts");
    expect(forA).not.toMatch(/B helper|b-flaky|bbbb1111/u);
    expect(forB).toContain("B helper");
    expect(forB).toContain("b-flaky.test.ts");
    expect(forB).not.toMatch(/A helper|a-flaky|aaaa1111/u);
    // Another project of the same company has none of them.
    expect(await a.lessons!.host.answerBriefing({ ...ask, project: "other-project" })).toBeUndefined();
    // Nothing is written by asking.
    const rows = (await world.store.query({ pk: companyScoped(A, "LESSON_LOAD") })).items.length + (await world.store.query({ pk: companyScoped(A, "KNOWLEDGE_GIVEN") })).items.length;
    expect(rows).toBe(0);
  });

  it("a company the switch does not cover has no briefing (nothing is built for it)", async () => {
    const world = createFakeWorld();
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: `on:${A}` }, peopleOf({ [A]: [], [B]: [] }), new Map());
    expect(companies.get(B)!.lessons).toBeUndefined();
    await putLesson(companies.get(A)!.lessons!, scopedLesson(A, "les_aaaa1111", "Retry network calls with the A helper"));
    expect(await companies.get(A)!.lessons!.host.answerBriefing(ask)).toContain("A helper");
  });
});

describe("the hosted answer route with the engine's briefing join (lead 4 L4-AK2g)", () => {
  const ANSWER_PATH = "/v1/app/projects/payments/answers";
  const scopedLesson = (company: string, id: string, title: string) => ({ ...activeLesson(company, id, title), type: "convention" as const, scope: { repos: ["demo"], paths: ["src/net/**"] } });
  async function hostedWorld(roles: Record<string, "view" | "manage">) {
    const world = createFakeWorld();
    const hosts = new Map<string, CoreLessons>();
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: "on" }, peopleOf({ [A]: ["person-1"], [B]: ["person-1"] }), hosts);
    await putLesson(companies.get(A)!.lessons!, scopedLesson(A, "les_aaaa1111", "Retry network calls with the A helper"));
    await putLesson(companies.get(B)!.lessons!, scopedLesson(B, "les_bbbb1111", "Retry network calls with the B helper"));
    const asked: string[] = [];
    // The engine's own join, over the real lessons hosts; every ask of a company's host is recorded.
    const hostOf = (companyId: OrgId) => {
      const host = hosts.get(companyId)?.host;
      return host === undefined ? undefined : { answerBriefing: async (input: Parameters<typeof host.answerBriefing>[0]) => { asked.push(companyId); return await host.answerBriefing(input); } };
    };
    const model = scriptedModel([answer([goodSentence])]);
    const wiringOf = (runtimeCompany: OrgId): HostedAnswersWiring => ({
      standing: async (personId, companyId, project) => { const access = roles[`${companyId}/${project}/${personId}`]; return access === "manage" ? { access, basis: "company-admin" } : { access: access ?? "none" }; },
      repositories: async () => ({ names: ["demo"], handles: [{ name: "demo", defaultBranch: "main", repository: { url: "https://github.com/example/demo.git" }, scope: { orgId: runtimeCompany }, host: { baseBranchHead: async () => HEAD, fileAtRevision: async () => REFUND_TS } }] }),
      model: () => model,
      briefing: answersBriefingOf(runtimeCompany, hostOf),
    });
    const post = async (runtimeCompany: OrgId, companyId: OrgId, personId: string) => {
      const body = JSON.stringify({ requestId: randomUUID(), question: "How do we retry network calls?" });
      const response = await routeHostedAnswers({ request: { method: "POST", path: ANSWER_PATH, headers: {}, body }, path: ANSWER_PATH, personId, companyId, store: world.store, wiring: wiringOf(runtimeCompany), now: () => world.clock.now });
      return { status: response.statusCode, raw: response.body ?? "" };
    };
    return { post, asked, model };
  }

  it("a company's answer is briefed with ITS lessons alone (same project name in both), and only the company's own host is asked", async () => {
    const w = await hostedWorld({ [`${A}/payments/ada`]: "view", [`${B}/payments/bob`]: "view" });
    expect((await w.post(A, A, "ada")).status).toBe(200);
    expect(w.asked).toEqual([A]);
    const forA = w.model.turns.map((turn) => turn.transcript).join("\n");
    expect(forA).toContain("A helper");
    expect(forA).not.toMatch(/B helper|bbbb1111/u);
    const before = w.model.turns.length;
    expect((await w.post(B, B, "bob")).status).toBe(200);
    expect(w.asked).toEqual([A, B]);
    const forB = w.model.turns.slice(before).map((turn) => turn.transcript).join("\n");
    expect(forB).toContain("B helper");
    expect(forB).not.toMatch(/A helper|aaaa1111/u);
  });

  it("another company's runtime never reads a company's lessons: a request for B on A's wiring is not briefed, and no host is asked", async () => {
    const w = await hostedWorld({ [`${B}/payments/bob`]: "view" });
    expect((await w.post(A, B, "bob")).status).toBe(200);
    expect(w.asked).toEqual([]);
    expect(w.model.turns.map((turn) => turn.transcript).join("\n")).not.toContain("team-knowledge");
  });

  it("the role is checked BEFORE the briefing: a person with no role gets the one 404, the briefing is never called, and the model is never opened", async () => {
    const w = await hostedWorld({ [`${A}/payments/ada`]: "view" });
    for (const [company, person] of [[A, "stranger"], [B, "ada"], [A, "bob"]] as const) {
      const result = await w.post(company, company, person);
      expect(result.status, `${company} ${person}`).toBe(404);
    }
    expect(w.asked).toEqual([]);
    expect(w.model.opened).toHaveLength(0);
  });
});

describe("capture: a merged task is queued under its own company", () => {
  it("A's milestone handler queues A's merged task, and ignores B's task", async () => {
    const world = createFakeWorld();
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: "on" }, peopleOf({ [A]: [], [B]: [] }), new Map());
    const a = companies.get(A)!;
    const b = companies.get(B)!;
    const at = new Date(world.clock.now).toISOString();
    await a.lessons!.host.milestone.on({ kind: "merged", orgId: A, taskId: b.taskId, at, text: "merged" });
    const queue = await reflectQueueOf(world.queues);
    expect(await queue.receive()).toEqual([]);
    await a.lessons!.host.milestone.on({ kind: "merged", orgId: A, taskId: a.taskId, at, text: "merged" });
    const received = await queue.receive();
    expect(received.map((message) => reflectMessageCompany(message.body))).toEqual([A]);
    expect(received[0]!.body).toMatchObject({ taskId: a.taskId, outcome: "merged" });
  });
});

describe("the shared reflection queue", () => {
  it("hands each message to its own company, removes a message for a company with lessons off, and keeps one whose company cannot be reached for a retry", async () => {
    const world = createFakeWorld();
    const queue = await reflectQueueOf(world.queues);
    for (const orgId of [A, B, "org_corehost00000000000c"]) await queue.enqueue({ body: { orgId, taskId: randomUUID(), outcome: "merged", requestId: randomUUID() }, dedupeId: randomUUID() });
    const seen: string[] = [];
    const host = (id: string) => ({ reflectOne: async (body: string) => { seen.push(`${id}:${String((JSON.parse(body) as { orgId: string }).orgId)}`); return { result: "done" as const, retry: false } as never; } });
    const report = await pumpReflectQueue({
      queues: world.queues, perPass: 10, now: () => world.clock.now, log: () => undefined,
      hostFor: async (id) => { if (id === A) return host(A); if (id === B) throw new Error("not now"); return undefined; },
    });
    expect(seen).toEqual([`${A}:${A}`]);
    expect(report).toMatchObject({ received: 3, reflected: 1, dropped: 1, retried: 1 });
  });
});

describe("people come from the deployment's port, for this company only", () => {
  const readTask = async (taskId: string) => (taskId === "task-a" ? { companyId: A, project: "payments", developerId: "ann" } : taskId === "task-b" ? { companyId: B, project: "payments", developerId: "bob" } : undefined);

  it("refuses any question about another company", async () => {
    const parts = createHostedLessonParts({ companyId: A, people: peopleOf({ [A]: ["ann"], [B]: ["bob"] }), readTask });
    await expect(parts.directory.eligibility(B, "payments")).rejects.toBeInstanceOf(OtherCompanyError);
    await expect(parts.directory.identity(B, "bob")).rejects.toBeInstanceOf(OtherCompanyError);
    await expect(parts.names.memberName(B, "bob")).rejects.toBeInstanceOf(OtherCompanyError);
    await expect(parts.access.mayRead(B, undefined, [])).rejects.toBeInstanceOf(OtherCompanyError);
    await expect(parts.tier0Authority.eligibility({ kind: "company", workspaceId: B }, { proposerId: "bob", approverId: "bob" })).rejects.toBeInstanceOf(OtherCompanyError);
    expect(await parts.audiences.read(B, ["task-b"])).toEqual(new Map());
    expect([...(await parts.access.taskVisibility.read(B, ["task-b"])).values()]).toEqual([undefined]);
  });

  it("a task's audience is its project's roster plus its person; another company's task is unknown; a restricted place is denied to everyone", async () => {
    const people = peopleOf({ [A]: ["ann", "amy"] });
    const parts = createHostedLessonParts({ companyId: A, people, readTask });
    const audiences = await parts.audiences.read(A, ["task-a", "task-b", "task-x"]);
    expect(audiences.get("task-b")).toBeUndefined();
    expect(audiences.get("task-x")).toBeUndefined();
    const audience = audiences.get("task-a")!;
    expect(audience.project).toBe("payments");
    expect([...audience.extras]).toEqual(["ann"]);
    expect(await audience.onRoster("amy")).toBe(true);
    expect(await audience.onRoster("bob")).toBe(false);
    expect(await parts.access.mayRead(A, { principals: ["gh-ann"], groups: [] }, [{ scopes: ["slack:C1"], restrictedScopes: ["slack:C1"] }, { scopes: ["project"], restrictedScopes: [] }])).toEqual([false, true]);
    expect((await parts.directory.eligibility(A, "payments")).eligibleIds).toEqual(["ann", "amy"]);
  });
});

describe("what a finished task teaches, per person", () => {
  async function sourcesFor(world: FakeWorld, members: string[], erased: string[] = []) {
    const registry = await buildCoreRegistry({ modules: world.modules, context: world.context(), areas: ["flow", "build", "merge"] });
    await registerProject(world, A);
    const runtime = createCoreRuntime({
      registry, companyId: A, flags: readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on" }), callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
    });
    const principal = localOwnerPrincipal({ companyId: A });
    const { task } = await runtime.flow.start({ principal, client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    const repos = createLessonRepositories({ flow: runtime.flow.deps, registry, companyId: A, now: () => world.clock.now });
    const sources = createLocalLessonSources({ flow: runtime.flow.deps, companyId: A, ownerId: "rovara-system", repos, now: () => world.clock.now, hosted: { people: peopleOf({ [A]: members }, erased) } });
    return { sources, task, personId: principal.personId };
  }

  it("the request is its person's: a member's words are a member's, a person off the roster is an outsider, and an erased person's task teaches nothing", async () => {
    const memberWorld = createFakeWorld();
    const member = await sourcesFor(memberWorld, []);
    // The person is not on the roster: their words are an outsider's (removed before any model call).
    const outsider = await member.sources.source.read({ workspaceId: A, taskId: member.task.taskId });
    expect(outsider?.facts.rest.initiatorTrust).toBe("outsider");
    expect(outsider?.facts.task.developerId).toBe(member.personId);

    const onRoster = createFakeWorld();
    const listed = await sourcesFor(onRoster, [localOwnerPrincipal({ companyId: A }).personId]);
    const read = await listed.sources.source.read({ workspaceId: A, taskId: listed.task.taskId });
    expect(read?.facts.rest.initiatorTrust).toBe("member");
    expect(read?.facts.rest.spans?.find((span) => span.kind === "intent")).toMatchObject({ trust: "member", authorId: listed.personId });

    const erasedWorld = createFakeWorld();
    const gone = await sourcesFor(erasedWorld, [localOwnerPrincipal({ companyId: A }).personId], [localOwnerPrincipal({ companyId: A }).personId]);
    expect(await gone.sources.source.read({ workspaceId: A, taskId: gone.task.taskId })).toBeUndefined();
    // Another company's workspace never reads A's task.
    expect(await listed.sources.source.read({ workspaceId: B, taskId: listed.task.taskId })).toBeUndefined();
  });
});

describe("a findings answer's send-back, per person", () => {
  const SUMMARY = "0 accepted, 2 to fix";
  async function withFindingsAnswer(members: string[], erased: string[], notes: string[] | undefined) {
    const world = createFakeWorld();
    const registry = await buildCoreRegistry({ modules: world.modules, context: world.context(), areas: ["flow", "build", "merge"] });
    await registerProject(world, A);
    const runtime = createCoreRuntime({
      registry, companyId: A, flags: readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on" }), callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
    });
    const { task } = await runtime.flow.start({ principal: localOwnerPrincipal({ companyId: A }), client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    const requestId = randomUUID();
    const record = (await world.store.get(taskKey(task.taskId)))! as unknown as Record<string, unknown> & { workflow: { decisions: unknown[]; revision: number } };
    const decision = { requestId, workflowRevision: record.workflow.revision, decision: "REQUEST_CHANGES", actorId: "ann", actorRole: "TASK_OWNER", reason: SUMMARY, source: "FINDINGS", at: new Date(world.clock.now).toISOString() };
    await world.store.put({ item: { ...record, workflow: { ...record.workflow, decisions: [...record.workflow.decisions, decision] } } as never });
    await world.store.transact([ownerNoteItem({ taskId: task.taskId, requestId, text: "Fix only the problems listed. The owner gave no further instructions for them.", now: new Date(world.clock.now), ...(notes === undefined ? {} : { findingNotes: notes }) })]);
    const repos = createLessonRepositories({ flow: runtime.flow.deps, registry, companyId: A, now: () => world.clock.now });
    const sources = createLocalLessonSources({ flow: runtime.flow.deps, companyId: A, ownerId: "rovara-system", repos, now: () => world.clock.now, hosted: { people: peopleOf({ [A]: members }, erased) } });
    return { sources, taskId: task.taskId, requestId };
  }
  const ask = (w: Awaited<ReturnType<typeof withFindingsAnswer>>, workspaceId: string = A) => w.sources.rows.sendBack({ workspaceId, project: "payments", taskId: w.taskId, requestId: w.requestId });

  it("a member's per-finding notes are their words (their standing now); a person off the roster keeps the outsider standing, so the words are removed later; an erased person's send-back is not read", async () => {
    const notes = ["Return 404, not 500.", "Keep the footer line."];
    const member = await withFindingsAnswer(["ann"], [], notes);
    const fact = await ask(member);
    expect(fact).toMatchObject({ origin: "human", actorDeveloperId: "ann", actorTrust: "member", reasonText: notes.join("\n") });
    expect(JSON.stringify(fact)).not.toContain(SUMMARY);

    const outsider = await withFindingsAnswer([], [], notes);
    expect(await ask(outsider)).toMatchObject({ origin: "human", actorDeveloperId: "ann", actorTrust: "outsider" });

    const gone = await withFindingsAnswer(["ann"], ["ann"], notes);
    expect(await ask(gone)).toBeUndefined();
  });

  it("with no per-finding notes the summary is fixed text, counted and never read as the person's words", async () => {
    const w = await withFindingsAnswer(["ann"], [], undefined);
    const fact = await ask(w);
    expect(fact).toMatchObject({ origin: "human", actorTrust: "member", fixedText: true });
    expect(JSON.stringify(fact)).not.toContain(SUMMARY);
  });

  it("another company's workspace reads nothing of this company's task or its notes", async () => {
    const w = await withFindingsAnswer(["ann"], [], ["Return 404, not 500."]);
    expect(await ask(w, B)).toBeUndefined();
  });
});

describe("the daily upkeep", () => {
  it("runs once a day per company, however many passes run", async () => {
    const world = createFakeWorld();
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: "on" }, peopleOf({ [A]: [], [B]: [] }), new Map());
    const service = companies.get(A)!.lessons!.service;
    expect(await service.pass({ budgetMs: 50_000 })).toMatchObject({ nightly: true });
    expect(await service.pass({ budgetMs: 50_000 })).toMatchObject({ nightly: false });
    world.clock.advance(86_400);
    expect(await service.pass({ budgetMs: 50_000 })).toMatchObject({ nightly: true });
    // B's day is its own.
    expect(await companies.get(B)!.lessons!.service.pass({ budgetMs: 50_000 })).toMatchObject({ nightly: true });
  });

  it("each pass runs the weekly lessons summary for the company's projects that turned it on, and only those (the summary's own tests: lessons/digest-notice.test.ts)", async () => {
    const world = createFakeWorld();
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: "on" }, peopleOf({ [A]: [], [B]: [] }), new Map());
    const weekRow = (companyId: OrgId) => world.store.get({ pk: companyScoped(companyId, "LESSON_DIGEST#payments"), sk: "WEEK" });
    expect(await companies.get(A)!.lessons!.service.pass({ budgetMs: 50_000 })).toMatchObject({ digests: 0 });
    expect(await weekRow(A)).toBeUndefined();
    await writeDigestSetting(world.store, A, "payments", true, world.clock.now);
    expect(await companies.get(A)!.lessons!.service.pass({ budgetMs: 50_000 })).toMatchObject({ digests: 0 });
    expect(await weekRow(A)).toMatchObject({ week: digestWeekOf(world.clock.now) });
    await companies.get(B)!.lessons!.service.pass({ budgetMs: 50_000 });
    expect(await weekRow(B)).toBeUndefined();
  });
});

describe("erasing a person's lessons", () => {
  it("hard-deletes the lessons the person wrote in their company, whatever the switch says, and leaves another company's lessons alone", async () => {
    const world = createFakeWorld();
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: "on" }, peopleOf({ [A]: ["ann"], [B]: ["ann"] }), new Map());
    const a = companies.get(A)!.lessons!;
    const b = companies.get(B)!.lessons!;
    // Both lessons were written by "ann" (the helper's author); the same id exists in both companies (ids are only unique per company).
    await putLesson(a, activeLesson(A, "les_aaaa1111", "Use the retry helper"));
    await putLesson(b, activeLesson(B, "les_aaaa1111", "Use the retry helper"));
    // The switch is off now: erasing must still work.
    setLearnedLessonsGate(() => false);
    const report = await erasePersonLessons({ store: world.store, audit: { stage: () => [], record: async () => undefined }, companyId: A, personId: "ann", now: () => world.clock.now });
    expect(report).toMatchObject({ projects: 1, purged: 1 });
    expect(await a.runtime.store.get({ workspaceId: A, project: "payments" }, "les_aaaa1111")).toBeUndefined();
    expect(await b.runtime.store.get({ workspaceId: B, project: "payments" }, "les_aaaa1111")).toBeDefined();
    // Idempotent: a second call finds nothing more to do.
    expect(await erasePersonLessons({ store: world.store, audit: { stage: () => [], record: async () => undefined }, companyId: A, personId: "ann", now: () => world.clock.now })).toMatchObject({ purged: 0 });
  });
});

describe("review fixes", () => {
  it("the erase walks the whole project catalog (every page), not only its first page", async () => {
    const world = createFakeWorld();
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: "on" }, peopleOf({ [A]: ["ann"], [B]: [] }), new Map());
    const a = companies.get(A)!.lessons!;
    // 1,050 more projects: more than one store page; the person's lesson is in the last one by name.
    for (let i = 0; i < 1_050; i += 1) await world.store.put({ item: { ...orgProjectCatalogKey(A, `p${String(i).padStart(4, "0")}`), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    const last = { ...activeLesson(A, "les_bbbb2222", "Late project lesson"), project: "zz-last" };
    await world.store.put({ item: { ...orgProjectCatalogKey(A, "zz-last"), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    await putLesson(a, last);
    const report = await erasePersonLessons({ store: world.store, audit: { stage: () => [], record: async () => undefined }, companyId: A, personId: "ann", now: () => world.clock.now });
    expect(report.projects).toBe(1_052);
    expect(await a.runtime.store.get({ workspaceId: A, project: "zz-last" }, "les_bbbb2222")).toBeUndefined();
  });

  it("a reflection pass stops taking messages when too little of its budget is left", async () => {
    const world = createFakeWorld();
    const queue = await reflectQueueOf(world.queues);
    for (let i = 0; i < 3; i += 1) await queue.enqueue({ body: { orgId: A, taskId: randomUUID(), outcome: "merged", requestId: randomUUID() }, dedupeId: randomUUID() });
    const deadlines: number[] = [];
    const host = { reflectOne: async (_body: string, _v: unknown, deadlineMs?: number) => { deadlines.push(deadlineMs ?? -1); world.clock.advance(20); return { result: "done", retry: false } as never; } };
    const report = await pumpReflectQueue({ queues: world.queues, perPass: 10, now: () => world.clock.now, log: () => undefined, hostFor: async () => host, deadlineAt: world.clock.now + 50_000 });
    // 50 s budget: the first message gets the time left (less a margin); after 20 s, 30 s are left (still enough); after 40 s only 10 s are left, so the third waits for the next pass.
    expect(report).toMatchObject({ received: 2, reflected: 2 });
    expect(deadlines[0]).toBe(45_000);
  });

  it("a switched-on company whose lessons are missing is a retry, never dropped as lessons off", async () => {
    const world = createFakeWorld();
    const hosts = new Map<string, CoreLessons>();
    const companies = await companyWorld(world, { [CORE_LESSONS_VARIABLE]: `on:${A}:${B}` }, peopleOf({ [A]: [], [B]: [] }), hosts);
    hosts.delete(B);
    const queue = await reflectQueueOf(world.queues);
    await queue.enqueue({ body: { orgId: B, taskId: randomUUID(), outcome: "merged", requestId: randomUUID() }, dedupeId: randomUUID() });
    const report = await companies.get(A)!.lessons!.service.pass({ budgetMs: 50_000 });
    expect(report).toMatchObject({ received: 1, dropped: 0, retried: 1 });
  });

  it("on a hosted install a pull request comment is a member's only when its account is linked to a person on the roster; an unlinked account is an outsider and an erased person's comment is not read", async () => {
    const world = createFakeWorld();
    const registry = await buildCoreRegistry({ modules: world.modules, context: world.context(), areas: ["flow", "build", "merge"] });
    await registerProject(world, A);
    const task = { taskId: "task-pr", companyId: A, project: "payments", developerId: "ann", startingRevision: 1, title: "Add health", requestText: "Add a /health endpoint",
      workflow: { revision: 3, artifacts: [], reviews: [], decisions: [], outcome: "MERGED", pullRequests: [{ repositoryId: "demo", number: 7, url: "https://github.com/example/demo/pull/7", state: "MERGED", headSha: "a".repeat(40) }] } };
    await world.store.put({ item: { ...taskKey("task-pr"), entityType: "DEVTASK", ...task } });
    const comments = [
      { id: "1", kind: "review_comment", author: "ann-gh", body: "Name it healthz like the others" },
      { id: "2", kind: "review_comment", author: "stranger-gh", body: "Unlinked account words" },
      { id: "3", kind: "review_comment", author: "gone-gh", body: "Erased person words" },
      { id: "4", kind: "review_comment", author: "viewer-gh", body: "Linked but off the roster" },
    ];
    const codeHost = { kind: "github", feedback: async () => ({ comments, changeRequest: { headTreeRevision: "t" } }), standing: async () => ({ permission: "write", accountType: "person" }) };
    const repo = { name: "demo", url: "https://github.com/example/demo.git", place: "github:repo/1", fullName: "example/demo", private: true, codeHost, repository: { url: "https://github.com/example/demo.git" }, scope: {} };
    const repos = { ...createLessonRepositories({ flow: { store: world.store, projects: undefined as never }, registry, companyId: A, now: () => world.clock.now }), ofProject: async () => [repo], ofTask: async () => repo } as unknown as LessonRepositories;
    const linked: Record<string, string> = { "ann-gh": "ann", "gone-gh": "gone", "viewer-gh": "vic" };
    const sources = createLocalLessonSources({
      flow: { store: world.store, projects: undefined as never }, companyId: A, ownerId: "rovara-system", repos, now: () => world.clock.now,
      hosted: { people: peopleOf({ [A]: ["ann", "gone"] }, ["gone"]), personOfAccount: async (_c, _p, login) => linked[login] },
    });
    const read = await sources.source.read({ workspaceId: A, taskId: "task-pr" });
    const prSpans = (read?.facts.rest.spans ?? []).filter((span) => span.kind === "pr_comment");
    expect(prSpans.map((span) => [span.authorId, span.trust])).toEqual([["ann", "member"], ["github_stranger-gh", "outsider"], ["vic", "outsider"]]);
    expect(JSON.stringify(prSpans)).not.toContain("Erased person words");
  });

  it("a send-back is its decider's: an erased decider's is not an outcome, one off the roster is an outsider's, and a close reason follows the same rule", async () => {
    const world = createFakeWorld();
    const registry = await buildCoreRegistry({ modules: world.modules, context: world.context(), areas: ["flow", "build", "merge"] });
    await registerProject(world, A);
    const decision = (requestId: string, actorId: string, extra: Record<string, unknown> = {}) => ({ requestId, workflowRevision: 1, decision: "REQUEST_CHANGES", actorId, actorRole: "TASK_OWNER", reason: `reason of ${actorId}`, source: "SEND_BACK", at: "2026-11-15T10:00:00.000Z", ...extra });
    const task = { taskId: "task-sb", companyId: A, project: "payments", developerId: "ann", startingRevision: 1, title: "t", requestText: "r",
      workflow: { revision: 3, artifacts: [], reviews: [], pullRequests: [], outcome: "CLOSED", decisions: [decision("r-gone", "gone"), decision("r-out", "otto"), decision("r-ann", "ann"), { ...decision("r-close", "gone"), decision: "REJECT", source: "CLOSE" }] } };
    await world.store.put({ item: { ...taskKey("task-sb"), entityType: "DEVTASK", ...task } });
    const repos = { ofProject: async () => [], ofTask: async () => undefined } as unknown as LessonRepositories;
    const sources = createLocalLessonSources({ flow: { store: world.store, projects: undefined as never }, companyId: A, ownerId: "rovara-system", repos, now: () => world.clock.now, hosted: { people: peopleOf({ [A]: ["ann", "gone"] }, ["gone"]) } });
    void registry;
    const ask = (requestId: string) => sources.rows.sendBack({ workspaceId: A, project: "payments", taskId: "task-sb", requestId });
    expect(await ask("r-gone")).toBeUndefined();
    expect(await ask("r-out")).toMatchObject({ origin: "human", actorDeveloperId: "otto", actorTrust: "outsider" });
    expect(await ask("r-ann")).toMatchObject({ origin: "human", actorDeveloperId: "ann", actorTrust: "member" });
    const read = await sources.source.read({ workspaceId: A, taskId: "task-sb" });
    expect((read?.facts.rest.spans ?? []).filter((span) => span.kind === "close_reason")).toEqual([]);
  });
});
