// R4-0 item 2: the hosted load record. On a deployed install the DISPATCHER chooses a step's lessons (`aws/worker-machines/dispatcher-lessons.ts`) and sends them straight to the worker; the broker only sees the worker's
// events afterwards. These tests run the dispatcher's reader and the broker's lessons host over ONE store, as the deployment does, and check what the owner sees: the pull request's "Lessons used" and the lessons' counts.
//   the dispatcher writes the load record (manifest, operation reference, use rows) because it alone knows what was chosen; the broker's existing `onEvents` applies the worker's load report to that manifest.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEARNED_CONTEXT_FEATURE, companyScoped, loadManifestKey, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { CORE_ENGINE_ON, buildCoreRegistry, createCoreRuntime } from "../../packages/broker/src/core-host/index.js";
import { createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, CORE_LESSONS_VARIABLE, type CoreLessons } from "../../packages/broker/src/core-host/lessons.js";
import type { HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { countLessonUses } from "../../packages/broker/src/lessons/use-count.js";
import { lessonsUsedLines } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { createDispatcherLearned } from "../../packages/broker/src/aws/worker-machines/dispatcher-lessons.js";
import { DocumentLessonStore } from "../../packages/broker/src/lessons/document-store.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { lessonRecord, draft } from "./lessons/lesson-helpers.js";

afterEach(() => { setLearnedLessonsGate(undefined); vi.restoreAllMocks(); });

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const PROJECT: ProjectDefinition = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
const FEATURES = [LEARNED_CONTEXT_FEATURE];

const people = (): HostedLessonPeople => ({
  approvers: async () => ({ complete: true, membershipVersion: 1, ownerIds: ["person-1"], eligibleIds: ["person-1"], lastEligibleLossAtMs: null }),
  onProjectRoster: async () => true, linkedAccounts: async () => [], displayName: async (_c, who) => `Person ${who}`, isErased: async () => false,
});

const lesson = (companyId: string, id: string, title: string) => lessonRecord({
  id, workspaceId: companyId, project: "payments", tier: 1, tierReasons: [], approvals: [{ approvalId: "a1", by: "person-1", at: 1, mode: "one" }], scope: {}, citations: [], citationChecks: [],
  stages: ["UNDERSTAND", "PLAN", "IMPLEMENT", "REVIEW"], provenance: { ...draft().provenance, supportTasks: [] }, title, description: "Retries go through withRetry.", body: `${title}: wrap network calls in withRetry instead of looping by hand.`,
});

async function setup() {
  const env = { [CORE_LESSONS_VARIABLE]: "on" };
  setCoreLessonsGate(env);
  const world: FakeWorld = createFakeWorld();
  // The pull request names lessons only for a repository known to be private.
  const identity = world.host.repositoryIdentity.bind(world.host);
  vi.spyOn(world.host, "repositoryIdentity").mockImplementation(async (repository, scope) => { const found = await identity(repository, scope); return found === undefined ? undefined : { ...found, private: true }; });
  const registry = await buildCoreRegistry({ modules: world.modules, context: world.context(), areas: ["flow", "build", "merge"] });
  const lessonsSwitch = readCoreLessonsSwitch(env).value;
  const companies = new Map<string, { lessons: CoreLessons; taskId: string; workspaceId: string; dispatcher: ReturnType<typeof createDispatcherLearned> }>();
  for (const companyId of [A, B]) {
    await world.store.put({ item: { ...projectRevisionKey(companyId, "payments", 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(companyId, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    const runtime = createCoreRuntime({ registry, companyId, flags: CORE_ENGINE_ON, callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined });
    const lessons = createCoreLessons({ flow: runtime.flow, registry, companyId, lessonsSwitch, people: people(), hostFor: async () => undefined, now: () => world.clock.now })!;
    lessons.attach();
    const principal = localOwnerPrincipal({ companyId });
    const { task } = await runtime.flow.start({ principal, client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint\nreturn 200 and wrap network calls in withRetry", workflow: true, workflowPath: "QUICK" });
    // The dispatcher's reader of THIS company: its own raw client over the same table.
    const send = async (command: { input: { Key: { pk: string; sk: string } } }) => ({ Item: await world.store.get(command.input.Key) });
    const dispatcher = createDispatcherLearned({ companyId, lessonsSwitch: { mode: "on" }, documentClient: { send } as never, tableName: "state", store: world.store, people: people(), now: () => world.clock.now });
    companies.set(companyId, { lessons, taskId: task.taskId, workspaceId: task.workspaceId, dispatcher });
  }
  const a = companies.get(A)!;
  const b = companies.get(B)!;
  for (const [company, ids] of [[A, [["les_aaaa1111", "Use the retry helper"], ["les_aaaa2222", "Name the timeout"]]], [B, [["les_bbbb1111", "B private advice"]]]] as const) {
    const store = (company === A ? a : b).lessons.runtime.store;
    const key = { workspaceId: company, project: "payments" };
    for (const [id, title] of ids) await store.commit(key, await store.setVersion(key), [lesson(company, id, title)], 1);
  }
  const prBody = async (c: typeof a) => lessonsUsedLines(await c.lessons.host.usedInPullRequest({ taskId: c.taskId, project: "payments", startingRevision: 1 }, "demo"), 10).join("\n");
  const loadedOf = async (c: typeof a, company: OrgId, id: string) => (await c.lessons.runtime.store.get({ workspaceId: company, project: "payments" }, id))?.counters.loaded;
  const usedIn = async (company: OrgId, ids: string[]) => [...(await countLessonUses(world.store, { companyId: company, project: "payments", lessonIds: ids, now: world.clock.now })).counts].map(([id, count]) => [id, count.tasks]);
  const report = (c: typeof a, operationId: string, lessons: Array<{ id: string; version: number }>) => c.lessons.host.onEvents({ workspaceId: c.workspaceId, id: operationId }, [{ type: "progress", payload: { learnedLoadReport: { v: 1, stage: "PLAN", lessons: lessons.map((l) => ({ ...l, citation: "none" })) } } }]);
  const dispatch = (c: typeof a, operationId: string) => c.dispatcher({ workspaceId: c.workspaceId, operationId, workflowMode: "PLAN", features: FEATURES });
  return { world, a, b, prBody, loadedOf, usedIn, report, dispatch };
}

describe("the hosted load record", () => {
  it("a hosted run that loads 2 lessons: the pull request's Lessons used names them and each lesson's used count rises by 1", async () => {
    const t = await setup();
    const op = randomUUID();
    const sent = await t.dispatch(t.a, op);
    expect(sent.learnedContext?.lessons.map((l) => l.id).sort()).toEqual(["les_aaaa1111", "les_aaaa2222"]);
    // At the dispatch: the manifest, the operation's reference and a use row per lesson (used in 1 task each). Nothing is "used" in the pull request until the worker says it reached its prompt.
    const lessons = new DocumentLessonStore(t.world.store, () => t.world.clock.now);
    const manifests = await lessons.manifests({ workspaceId: A, project: "payments" }, t.a.taskId);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({ stage: "PLAN", memory: "live", workspaceId: A, project: "payments", round: 1 });
    expect(manifests[0]!.lessons.map((e) => [e.id, e.citation]).sort()).toEqual([["les_aaaa1111", "unchecked"], ["les_aaaa2222", "unchecked"]]);
    expect(await t.world.store.get({ pk: companyScoped(A, "LESSON_LOAD"), sk: op })).toMatchObject({ taskId: t.a.taskId, project: "payments", stage: "PLAN", round: 1 });
    expect(await t.usedIn(A, ["les_aaaa1111", "les_aaaa2222"])).toEqual([["les_aaaa1111", 1], ["les_aaaa2222", 1]]);
    expect(await t.prBody(t.a)).toContain("None used yet");
    // The worker's report (through the broker's own event hook) is applied to that manifest.
    await t.report(t.a, op, sent.learnedContext!.lessons.map((l) => ({ id: l.id, version: manifests[0]!.lessons.find((e) => e.id === l.id)!.version })));
    expect(await t.loadedOf(t.a, A, "les_aaaa1111")).toBe(1);
    expect(await t.loadedOf(t.a, A, "les_aaaa2222")).toBe(1);
    const body = await t.prBody(t.a);
    expect(body).toContain("Rovara used 2 lessons");
    expect(body).toContain("Use the retry helper");
    expect(body).toContain("Name the timeout");
  });

  it("a retried dispatch counts once: the same operation, or a new operation for the same step, adds no manifest, no use row and no second count", async () => {
    const t = await setup();
    const op = randomUUID();
    const first = await t.dispatch(t.a, op);
    const versions = first.learnedContext!.lessons.map((l) => ({ id: l.id, version: 1 }));
    await t.dispatch(t.a, op);
    await t.dispatch(t.a, randomUUID());
    const lessons = new DocumentLessonStore(t.world.store, () => t.world.clock.now);
    expect(await lessons.manifests({ workspaceId: A, project: "payments" }, t.a.taskId)).toHaveLength(1);
    expect(await t.usedIn(A, ["les_aaaa1111", "les_aaaa2222"])).toEqual([["les_aaaa1111", 1], ["les_aaaa2222", 1]]);
    // The worker's report arrives twice (a redelivered event batch): still one.
    await t.report(t.a, op, versions);
    await t.report(t.a, op, versions);
    expect(await t.loadedOf(t.a, A, "les_aaaa1111")).toBe(1);
    expect(await t.loadedOf(t.a, A, "les_aaaa2222")).toBe(1);
    expect(await t.prBody(t.a)).toContain("Rovara used 2 lessons");
  });

  it("another company's lessons never appear: each company's records are under its own keys, a dispatcher refuses another company's workspace and records nothing for it", async () => {
    const t = await setup();
    const opA = randomUUID();
    const opB = randomUUID();
    const sentA = await t.dispatch(t.a, opA);
    const sentB = await t.dispatch(t.b, opB);
    expect(JSON.stringify(sentA)).not.toContain("B private advice");
    expect(sentB.learnedContext?.lessons.map((l) => l.id)).toEqual(["les_bbbb1111"]);
    await t.report(t.a, opA, sentA.learnedContext!.lessons.map((l) => ({ id: l.id, version: 1 })));
    await t.report(t.b, opB, [{ id: "les_bbbb1111", version: 1 }]);
    const bodyA = await t.prBody(t.a);
    expect(bodyA).toContain("Rovara used 2 lessons");
    expect(bodyA).not.toContain("B private advice");
    expect(await t.prBody(t.b)).toContain("B private advice");
    expect(await t.prBody(t.b)).toContain("Rovara used 1 lesson");
    // Every record the dispatchers wrote is in the partition of the company it is for.
    expect(await t.usedIn(A, ["les_bbbb1111"])).toEqual([["les_bbbb1111", 0]]);
    expect(await t.usedIn(B, ["les_aaaa1111", "les_aaaa2222"])).toEqual([["les_aaaa1111", 0], ["les_aaaa2222", 0]]);
    expect(await t.world.store.get({ pk: companyScoped(B, "LESSON_LOAD"), sk: opA })).toBeUndefined();
    expect(await t.world.store.get({ pk: companyScoped(A, "LESSON_LOAD"), sk: opB })).toBeUndefined();
    // A's reader asked about B's workspace refuses, and writes nothing.
    const put = vi.spyOn(t.world.store, "put");
    await expect(t.dispatch({ ...t.a, workspaceId: t.b.workspaceId }, randomUUID())).rejects.toThrow("RUNTIME_UNAVAILABLE");
    expect(put).not.toHaveBeenCalled();
  });

  it("a load that cannot be recorded is refused like a failed read (the step goes without lessons); a use row that cannot be written is only a missing count", async () => {
    const t = await setup();
    const real = t.world.store.put.bind(t.world.store);
    const spy = vi.spyOn(t.world.store, "put").mockImplementation(async (request) => { if (request.item["entityType"] === "LESSON_USE") throw new Error("down"); return real(request); });
    expect((await t.dispatch(t.a, randomUUID())).learnedContext?.lessons).toHaveLength(2);
    expect(await t.usedIn(A, ["les_aaaa1111"])).toEqual([["les_aaaa1111", 0]]);
    spy.mockImplementation(async (request) => { if (request.item["entityType"] === "LESSON_LOAD_REF") throw new Error("down"); return real(request); });
    await expect(t.dispatch(t.a, randomUUID())).rejects.toThrow("RUNTIME_UNAVAILABLE");
  });

  it("a stored manifest that is not shaped like one is skipped (read tolerantly), and the task's real load still counts", async () => {
    const t = await setup();
    const op = randomUUID();
    const sent = await t.dispatch(t.a, op);
    // A row of the manifest family with no lessons list (an older or damaged record), for the same task.
    await t.world.store.put({ item: { ...loadManifestKey(A, "payments", t.a.taskId, "IMPLEMENT", 1, false), entityType: "LESSON_LOAD", taskId: t.a.taskId, stage: "IMPLEMENT", round: 1, at: "yesterday" } });
    const lessons = new DocumentLessonStore(t.world.store, () => t.world.clock.now);
    const found = await lessons.manifests({ workspaceId: A, project: "payments" }, t.a.taskId);
    expect(found.map((m) => m.stage)).toEqual(["PLAN"]);
    await t.report(t.a, op, sent.learnedContext!.lessons.map((l) => ({ id: l.id, version: 1 })));
    expect(await t.prBody(t.a)).toContain("Rovara used 2 lessons");
  });
});
