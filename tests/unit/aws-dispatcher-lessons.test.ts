import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_CONTEXT_FEATURE, LEARNED_CONTEXT_FEATURE, orgProjectCatalogKey, projectRevisionKey, lessonKey, lessonSetKey, type JsonValue, type ProjectDefinition, type StoredDocument } from "@agentx/contracts";
import { createDispatcherLearned, DISPATCHER_LESSONS_UNAVAILABLE, DISPATCHER_LESSONS_LIMITS } from "../../packages/broker/src/aws/worker-machines/dispatcher-lessons.js";
import { hostedDispatcherFlow } from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { DocumentLessonStore } from "../../packages/broker/src/lessons/document-store.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import type { HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { lessonRecord } from "./lessons/lesson-helpers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const WS = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const now = 1_800_000_000_000;
const request = { workspaceId: WS, operationId: TASK, workflowMode: "PLAN", features: [LEARNED_CONTEXT_FEATURE] };
const definition: ProjectDefinition = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://example.test/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
afterEach(() => { vi.useRealTimers(); setLearnedLessonsGate(undefined); });

async function world(companyId = A) {
  setLearnedLessonsGate(() => true);
  const store = new MemoryDocumentStore();
  for (const company of [A, B]) {
    await store.put({ item: { ...projectRevisionKey(company, "payments", 1), definition: definition as unknown as JsonValue } });
    await store.put({ item: { ...orgProjectCatalogKey(company, "payments"), latestRevision: 1 } });
    const lessons = new DocumentLessonStore(store, () => now);
    const lesson = lessonRecord({ id: company === A ? "les_aaaa1111" : "les_bbbb1111", workspaceId: company, project: "payments", title: company === A ? "Retry network calls" : "B private advice", body: company === A ? "Retry network calls with withRetry." : "B private advice for retry network calls with withRetry.", tier: 1, approvals: [{ approvalId: "approved", by: "person-1", at: 1, mode: "one" }], citations: [], citationChecks: [], scope: {}, stages: ["PLAN"], provenance: { ...lessonRecord().provenance, supportTasks: [] } });
    expect((await lessons.commit({ workspaceId: company, project: "payments" }, 0, [lesson], now)).ok).toBe(true);
  }
  await store.put({ item: { ...workspaceKey(companyId, WS), entityType: "WORKSPACE", companyId } });
  await store.put({ item: { pk: `WORKSPACE#${WS}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", companyId, workspaceId: WS } });
  await store.put({ item: { ...taskPointerKey(companyId, WS), taskId: TASK } });
  await store.put({ item: { ...taskKey(TASK), taskId: TASK, workspaceId: WS, companyId, project: "payments", title: "Retry network calls", developerId: "person-1", startingRevision: 1, workflow: { revision: 1 } } });
  const people: HostedLessonPeople = {
    approvers: async () => ({ complete: true, membershipVersion: 1, ownerIds: ["person-1"], eligibleIds: ["person-1"], lastEligibleLossAtMs: null }),
    onProjectRoster: async (company) => company === companyId, linkedAccounts: async () => [], displayName: async () => "Person", isErased: async () => false,
  };
  const send = vi.fn(async (command: { input: { Key: { pk: string; sk: string } } }) => ({ Item: await store.get(command.input.Key) }));
  const writes = [vi.spyOn(store, "put"), vi.spyOn(store, "update"), vi.spyOn(store, "delete"), vi.spyOn(store, "transact")];
  const options = { companyId, lessonsSwitch: { mode: "on" as const }, documentClient: { send } as never, tableName: "state", store, people, now: () => now };
  return { store, send, writes, options, learned: createDispatcherLearned(options) };
}

describe("read-only dispatcher lessons", () => {
  it("composes the hosted reader only for a covered company and passes its lessons through readVisible", async () => {
    const w = await world();
    const original = (await w.store.get(lessonKey(A, "payments", "les_aaaa1111")))!;
    await w.store.put({ item: { ...original, ...lessonKey(A, "payments", "les_hidden11"), id: "les_hidden11",
      provenance: { ...(original["provenance"] as Record<string, JsonValue>), audience: { kind: "restricted", acl: { source: "slack", scope: "slack:channel/private", principals: ["someone-else"], groups: [], capturedAt: "2026-11-01T00:00:00.000Z", liveCheck: "on_read" } } } } });
    await w.store.put({ item: { ...lessonSetKey(A, "payments"), setVersion: 1, members: { les_aaaa1111: 1, les_hidden11: 1 } } });
    for (const write of w.writes) write.mockClear();
    const env = { ROVARA_CORE_LESSONS: `on:${A}` };
    const covered = hostedDispatcherFlow(env, w.options);
    expect(typeof covered?.learned).toBe("function");
    const answer = await covered!.learned!({ ...request, companyId: B } as typeof request);
    expect(answer.learnedContext?.lessons.map((lesson) => lesson.id)).toEqual(["les_aaaa1111"]);
    expect(JSON.stringify(answer)).not.toContain("les_hidden11");
    expect(JSON.stringify(answer)).not.toContain("B private advice");
    w.send.mockClear();
    // Even though the supplied options say on, only the deployment's switch decides.
    const uncovered = hostedDispatcherFlow(env, { ...w.options, companyId: B });
    expect(uncovered).toEqual({ standingInstructions: null, modelAccess: null, learned: null });
    for (const raw of [undefined, "off"]) {
      expect(hostedDispatcherFlow(raw === undefined ? {} : { ROVARA_CORE_LESSONS: raw }, w.options)).toEqual({ standingInstructions: null, modelAccess: null, learned: null });
    }
    expect(w.send).not.toHaveBeenCalled();
    for (const write of w.writes) expect(write).not.toHaveBeenCalled();
  });

  it("uses the workspace company with identical raw ids, never a payload company, and writes nothing", async () => {
    for (const company of [A, B]) {
      const w = await world(company);
      setLearnedLessonsGate(() => false);
      const answer = await w.learned({ ...request, companyId: company === A ? B : A } as typeof request);
      expect(answer.learnedContext?.lessons.map((lesson) => lesson.id)).toEqual([company === A ? "les_aaaa1111" : "les_bbbb1111"]);
      expect(JSON.stringify(answer)).not.toContain(company === A ? "B private advice" : "A advice");
      for (const write of w.writes) expect(write).not.toHaveBeenCalled();
      expect(w.send).toHaveBeenCalledTimes(2);
      expect(w.send.mock.calls[0]![0].input).toMatchObject({ ConsistentRead: true, Key: { pk: `WORKSPACE#${WS}`, sk: "META" } });
    }
  });
  it.each([undefined, "invalid-private-value", B, 42])("refuses missing, invalid or foreign workspace company (%s) with fixed words", async (companyId) => {
    const w = await world();
    await w.store.put({ item: { ...workspaceKey(A, WS), ...(companyId === undefined ? {} : { companyId }) } });
    await expect(w.learned(request)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${DISPATCHER_LESSONS_UNAVAILABLE}` });
  });
  it("refuses conflicting workspace ownership and foreign task records", async () => {
    const w = await world();
    await w.store.put({ item: { ...workspaceKey(A, WS), companyId: A, orgId: B } });
    await expect(w.learned(request)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${DISPATCHER_LESSONS_UNAVAILABLE}` });
    await w.store.put({ item: { ...workspaceKey(A, WS), companyId: A } });
    await w.store.update({ key: taskKey(TASK), ops: [{ op: "set", path: ["companyId"], value: B }] });
    await expect(w.learned(request)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${DISPATCHER_LESSONS_UNAVAILABLE}` });
  });
  it("refuses a foreign workspace with an internally consistent foreign task", async () => {
    const w = await world(B);
    const learned = createDispatcherLearned({ ...w.options, companyId: A });
    await expect(learned(request)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${DISPATCHER_LESSONS_UNAVAILABLE}` });
    for (const write of w.writes) expect(write).not.toHaveBeenCalled();
  });
  it("loads lessons from an own older source task without a workflow, and withholds a foreign source", async () => {
    const w = await world();
    const sourceId = "33333333-3333-4333-8333-333333333333";
    const source: StoredDocument = { ...(await w.store.get(taskKey(TASK)))!, ...taskKey(sourceId), taskId: sourceId };
    delete source["workflow"];
    await w.store.put({ item: source });
    const key = lessonKey(A, "payments", "les_aaaa1111");
    const head = (await w.store.get(key))!;
    await w.store.put({ item: { ...head, provenance: { ...(head["provenance"] as Record<string, JsonValue>), supportTasks: [sourceId] } } });
    expect((await w.learned(request)).learnedContext?.lessons.map((lesson) => lesson.id)).toEqual(["les_aaaa1111"]);
    await w.store.put({ item: { ...source, companyId: B } });
    for (const write of w.writes) write.mockClear();
    expect(await w.learned(request)).toEqual({});
    for (const write of w.writes) expect(write).not.toHaveBeenCalled();
  });
  it("offers only approved, live lessons in the task's company and project", async () => {
    const w = await world();
    const original = await w.store.get(lessonKey(A, "payments", "les_aaaa1111"));
    const members = { "les_aaaa1111": 1, les_unapproved: 1, les_retired: 1 };
    await w.store.put({ item: { ...original!, ...lessonKey(A, "payments", "les_unapproved"), id: "les_unapproved", approvals: [] } });
    await w.store.put({ item: { ...original!, ...lessonKey(A, "payments", "les_retired"), id: "les_retired", status: "retired" } });
    await w.store.put({ item: { ...lessonSetKey(A, "payments"), setVersion: 1, members } });
    const otherProject = { ...original!, ...lessonKey(A, "other-project", "les_otherproj"), id: "les_otherproj" };
    await w.store.put({ item: otherProject });
    await w.store.put({ item: { ...lessonSetKey(A, "other-project"), setVersion: 1, members: { les_otherproj: 1 } } });
    const answer = await w.learned(request);
    expect(answer.learnedContext?.lessons.map((lesson) => lesson.id)).toEqual(["les_aaaa1111"]);
    expect(JSON.stringify(answer)).not.toContain("les_unapproved");
    expect(JSON.stringify(answer)).not.toContain("les_retired");
    expect(JSON.stringify(answer)).not.toContain("les_otherproj");
  });
  it("off is byte-identical and reads nothing; on declares only a supplied reader", async () => {
    const w = await world();
    for (const raw of [undefined, "off", "", "malformed"]) {
      const env = raw === undefined ? {} : { ROVARA_CORE_LESSONS: raw };
      expect(JSON.stringify(hostedDispatcherFlow(env, w.learned))).toBe('{"standingInstructions":null,"modelAccess":null,"learned":null}');
    }
    expect(hostedDispatcherFlow({ ROVARA_CORE_LESSONS: "on" }, w.learned)?.learned).toBe(w.learned);
    expect(hostedDispatcherFlow({ ROVARA_CORE_LESSONS: "on" })).toBeUndefined();
    for (const invalid of [null, false, 1, "private-invalid-reader", {}]) {
      expect(hostedDispatcherFlow({ ROVARA_CORE_LESSONS: "on" }, invalid as never)).toBeUndefined();
    }
    const off = createDispatcherLearned({ ...w.options, lessonsSwitch: { mode: "off" } });
    expect(JSON.stringify(await off(request))).toBe("{}");
    expect(w.send).not.toHaveBeenCalled();
    const excluded = createDispatcherLearned({ ...w.options, lessonsSwitch: { mode: "on-for", companies: [B] } });
    expect(await excluded(request)).toEqual({});
    expect(w.send).not.toHaveBeenCalled();
  });
  async function many(w: Awaited<ReturnType<typeof world>>, count: number, distinct = false) {
    const original = await w.store.get(lessonKey(A, "payments", "les_aaaa1111"));
    const members: Record<string, number> = {};
    for (let i = 0; i < count; i++) {
      const id = `les_many${String(i).padStart(4, "0")}`;
      members[id] = 1;
      await w.store.put({ item: { ...original!, ...lessonKey(A, "payments", id), id, approvals: [{ approvalId: "approved", by: distinct ? `person-${i}` : "person-1", at: 1, mode: "one" }] } });
    }
    await w.store.put({ item: { ...lessonSetKey(A, "payments"), setVersion: 1, members } });
    for (const write of w.writes) write.mockClear();
  }
  it("accepts the stated maximum of 100 candidates, bounded in time, and reads shared records once", async () => {
    const w = await world();
    await many(w, DISPATCHER_LESSONS_LIMITS.lessons);
    const get = vi.spyOn(w.store, "get");
    const started = performance.now();
    expect((await w.learned(request)).learnedContext?.lessons.length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2_500);
    const ids = get.mock.calls.map(([key]) => JSON.stringify(key));
    expect(new Set(ids).size).toBe(ids.length);
    for (const write of w.writes) expect(write).not.toHaveBeenCalled();
  });
  it("refuses ONE total read cap across individually valid heads and member reads, without a partial result", async () => {
    const w = await world();
    await many(w, DISPATCHER_LESSONS_LIMITS.lessons, true);
    const resolve = vi.fn(async (_company: string, who: string) => who);
    const learned = createDispatcherLearned({ ...w.options, people: { ...w.options.people, resolveMember: resolve } });
    await expect(learned(request)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${DISPATCHER_LESSONS_UNAVAILABLE}` });
    expect(resolve.mock.calls.length).toBeLessThan(100);
    for (const write of w.writes) expect(write).not.toHaveBeenCalled();
  });
  it("refuses a total byte cap across individually smaller documents", async () => {
    const w = await world();
    const padding = "x".repeat(Math.floor(DISPATCHER_LESSONS_LIMITS.bytes * 0.3));
    for (const key of [workspaceKey(A, WS), taskPointerKey(A, WS), taskKey(TASK), projectRevisionKey(A, "payments", 1)]) {
      await w.store.put({ item: { ...(await w.store.get(key))!, padding } });
    }
    await expect(w.learned(request)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${DISPATCHER_LESSONS_UNAVAILABLE}` });
  });
  it("refuses an oversized set and a malformed head rather than silently dropping it", async () => {
    const w = await world();
    await many(w, DISPATCHER_LESSONS_LIMITS.lessons + 1);
    await expect(w.learned(request)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${DISPATCHER_LESSONS_UNAVAILABLE}` });
    await many(w, 2);
    await w.store.put({ item: { ...lessonKey(A, "payments", "les_many0001"), entityType: "LESSON", title: "private invalid head" } });
    await expect(w.learned(request)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${DISPATCHER_LESSONS_UNAVAILABLE}` });
  });
  it.each([{ ...request, workflowMode: "unknown-private-mode" }, { ...request, features: 1 }, { ...request, workspaceId: "private-invalid-id" }])("validates runtime input and never echoes it", async (input) => {
    const w = await world();
    await expect(w.learned(input as typeof request)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${DISPATCHER_LESSONS_UNAVAILABLE}` });
    expect(w.send).not.toHaveBeenCalled();
  });
  it("wraps backend errors in fixed words", async () => {
    const w = await world();
    w.send.mockRejectedValueOnce(new Error("private backend cause"));
    await expect(w.learned(request)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${DISPATCHER_LESSONS_UNAVAILABLE}` });
  });
  it("times out the entire call, and late readers cannot start more reads or write", async () => {
    vi.useFakeTimers();
    const w = await world();
    let release!: () => void;
    w.send.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ Item: { pk: `WORKSPACE#${WS}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", companyId: A } }); }));
    const pending = expect(w.learned(request)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${DISPATCHER_LESSONS_UNAVAILABLE}` });
    await vi.advanceTimersByTimeAsync(2_500);
    await pending;
    const get = vi.spyOn(w.store, "get");
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(get).not.toHaveBeenCalled();
    for (const write of w.writes) expect(write).not.toHaveBeenCalled();
  });
});

describe("read-only dispatcher lessons: the knowledge briefing (lead 4 L4-AK2)", () => {
  const BOTH = { ...request, features: [LEARNED_CONTEXT_FEATURE, KNOWLEDGE_CONTEXT_FEATURE] };
  async function scopedWorld(companyId = A) {
    const w = await world(companyId);
    for (const company of [A, B]) {
      const key = lessonKey(company, "payments", company === A ? "les_aaaa1111" : "les_bbbb1111");
      const head = (await w.store.get(key))!;
      await w.store.put({ item: { ...head, title: company === A ? "Retry network calls" : "B private advice", body: company === A ? "Retry network calls with withRetry." : "Only B knows this.", scope: { repos: ["demo"], paths: ["src/**"] } } });
      await w.store.put({ item: { ...lessonSetKey(company, "payments"), setVersion: 1, members: { [company === A ? "les_aaaa1111" : "les_bbbb1111"]: 1 } } });
    }
    for (const write of w.writes) write.mockClear();
    return w;
  }

  it("gives a worker that lists the feature the look-up of THIS company's project, writes nothing, and never another company's lesson", async () => {
    for (const company of [A, B]) {
      const w = await scopedWorld(company);
      const answer = await w.learned(BOTH);
      expect(answer.knowledgeContext?.stage).toBe("PLAN");
      expect(answer.knowledgeContext?.pull?.units.map((u) => u.id)).toEqual([company === A ? "les_aaaa1111" : "les_bbbb1111"]);
      expect(JSON.stringify(answer)).not.toContain(company === A ? "B private advice" : "Retry network calls");
      for (const write of w.writes) expect(write).not.toHaveBeenCalled();
    }
  });

  it("a lesson with no scope is pushed when it fits but is not in the look-up", async () => {
    const w = await scopedWorld();
    const key = lessonKey(A, "payments", "les_aaaa1111");
    await w.store.put({ item: { ...(await w.store.get(key))!, scope: {} } });
    const answer = await w.learned(BOTH);
    expect(answer.learnedContext?.lessons.map((l) => l.id)).toEqual(["les_aaaa1111"]);
    expect(answer.knowledgeContext?.pull).toBeUndefined();
  });

  it("a worker without the feature is sent exactly the lessons it always was", async () => {
    const w = await scopedWorld();
    const answer = await w.learned(request);
    expect(answer.knowledgeContext).toBeUndefined();
    expect(answer.learnedContext?.lessons.map((l) => l.id)).toEqual(["les_aaaa1111"]);
  });

  it("a look-up that has no time left is left out and the lessons still go (it has a clock of its own and leaves the dispatch deadline its margin)", async () => {
    const w = await scopedWorld();
    vi.useFakeTimers({ toFake: ["Date"] });
    // The lessons' own reads take 2.3 s of the 2.5 s: past the look-up's start limit (the deadline less its margin).
    const send = w.send.getMockImplementation()!;
    w.send.mockImplementationOnce(async (command) => { vi.setSystemTime(Date.now() + 2_300); return send(command); });
    const answer = await w.learned(BOTH);
    expect(answer.learnedContext?.lessons.map((l) => l.id)).toEqual(["les_aaaa1111"]);
    expect(answer.knowledgeContext).toBeUndefined();
  });

  it("the plan check mode is a lesson mode (a fixed set, no look-up)", async () => {
    const w = await scopedWorld();
    const answer = await w.learned({ ...BOTH, workflowMode: "PLAN_CRITIQUE" });
    expect(answer.knowledgeContext).toBeUndefined();
    // An older worker (no knowledge feature) is not sent the plan check's lessons: it gets exactly what it always did.
    expect(await w.learned({ ...request, workflowMode: "PLAN_CRITIQUE" })).toEqual({});
  });
});
