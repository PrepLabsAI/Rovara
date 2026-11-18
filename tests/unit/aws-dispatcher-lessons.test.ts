import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_CONTEXT_FEATURE, LEARNED_CONTEXT_FEATURE, companyScoped, orgProjectCatalogKey, projectRevisionKey, lessonKey, lessonSetKey, type JsonValue, type ProjectDefinition, type StoredDocument } from "@agentx/contracts";
import { createDispatcherLearned, DISPATCHER_LESSONS_UNAVAILABLE, DISPATCHER_LESSONS_LIMITS, DISPATCHER_SIGNALS_LIMITS } from "../../packages/broker/src/aws/worker-machines/dispatcher-lessons.js";
import { hostedDispatcherFlow } from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { DocumentLessonStore } from "../../packages/broker/src/lessons/document-store.js";
import { documentEvidenceSink } from "../../packages/broker/src/lessons/evidence.js";
import { SIGNALS_TTL_MS } from "../../packages/broker/src/lessons/scoring-settings.js";
import { documentMeasureSink } from "../../packages/broker/src/lessons/measure.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import type { HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { lessonRecord } from "./lessons/lesson-helpers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const WS = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const now = 1_800_000_000_000;
const DAY = 86_400_000;
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

describe("read-only dispatcher lessons: the project's signals rank lessons as the broker's loader does (L4-LP12b)", () => {
  const SECOND = "les_aaaa2222";
  const key = { workspaceId: A, project: "payments" };
  /** Two lessons that fit the task about as well as each other (so what separates them is the signals), neither a twin of the other. */
  async function pair(w: Awaited<ReturnType<typeof world>>, over: { second?: Partial<Parameters<typeof lessonRecord>[0]> } = {}) {
    const lessons = new DocumentLessonStore(w.store, () => now);
    const first = (await lessons.get(key, "les_aaaa1111"))!;
    const second = lessonRecord({ ...first, id: SECOND, title: "Retry network calls", body: "Wrap every network call in withRetry, and log each attempt.", approvals: first.approvals, ...over.second });
    expect((await lessons.commit(key, await lessons.setVersion(key), [second], now)).ok).toBe(true);
    for (const write of w.writes) write.mockClear();
  }
  const order = async (w: Awaited<ReturnType<typeof world>>): Promise<string[]> => ((await w.learned(request)).learnedContext?.lessons ?? []).map((lesson) => lesson.id);
  const questionRow = (company: string, lessonId: string, taskId: string) => ({ pk: companyScoped(company, "LESSON_QUESTION#payments"), sk: `Q#${lessonId}#${taskId}`, entityType: "LESSON_QUESTION", project: "payments", lessonId, taskId, at: now - DAY, keepUntil: now + 30 * DAY });

  it("both lessons load with no signals; the order is the loader's with no evidence (the baseline for the tests below)", async () => {
    const w = await world();
    await pair(w);
    expect((await order(w)).sort()).toEqual(["les_aaaa1111", SECOND]);
  });

  it("a lesson under question ranks below the one that is not, as on the broker path; another company's question changes nothing", async () => {
    const w = await world();
    await pair(w);
    const [first] = await order(w);
    const other = first === "les_aaaa1111" ? SECOND : "les_aaaa1111";
    // Another company's partition names the lesson: no effect.
    await w.store.put({ item: questionRow(B, first!, "t-1") });
    expect((await order(w))[0]).toBe(first);
    await w.store.put({ item: questionRow(A, first!, "t-1") });
    const after = await createDispatcherLearned(w.options)(request);
    expect(after.learnedContext?.lessons.map((lesson) => lesson.id)[0]).toBe(other);
  });

  it("the strength prior is centred on the project's clean-merge rate: the same evidence ranks a lesson differently where merges are clean and where they are mostly reverted", async () => {
    const rank = async (reverted: number) => {
      const w = await world();
      await pair(w);
      const measure = documentMeasureSink(w.store, A, () => now);
      for (let i = 0; i < 10; i += 1) {
        await measure.merged({ workspaceId: A, project: "payments", taskId: `task-m-${String(i)}`, at: now - 20 * DAY });
        if (i < reverted) await measure.reverted({ workspaceId: A, project: "payments", taskId: `task-m-${String(i)}`, at: now - 10 * DAY });
      }
      // One lesson has an even record (2 for, 2 against); the other has none, so it is worth the prior.
      const evidence = documentEvidenceSink(w.store, A);
      for (const [kind, n] of [["for", 2], ["against", 2]] as const) for (let i = 0; i < n; i += 1) await evidence.note({ workspaceId: A, project: "payments", lessonId: SECOND, kind, weight: 1, at: now - DAY, id: `${kind}-${String(i)}` });
      for (const write of w.writes) write.mockClear();
      const ids = await order(w);
      for (const write of w.writes) expect(write).not.toHaveBeenCalled();
      return ids;
    };
    // Clean merges (prior 0.9): the untried lesson is worth more than an even record. Mostly reverted (prior 0.1): the even record is worth more than nothing.
    expect((await rank(1))[0]).toBe("les_aaaa1111");
    expect((await rank(9))[0]).toBe(SECOND);
  });

  it("the signals have a share of their own and never fail the lessons: a store that cannot answer queries, one that never answers, and rows past the share all give the neutral ranking", async () => {
    const baseline = await world();
    await pair(baseline);
    const expected = await order(baseline);
    const failing = await world();
    await pair(failing);
    vi.spyOn(failing.store, "query").mockRejectedValue(new Error("private backend cause"));
    expect(await order(failing)).toEqual(expected);
    const hanging = await world();
    await pair(hanging);
    vi.spyOn(hanging.store, "query").mockImplementation(() => new Promise(() => undefined));
    expect(await order(hanging)).toEqual(expected);
    // A project with more rows than the share is ranked on the neutral prior, not on a part of its rows, and the lessons still load: rows past the item share, reads past the read share, bytes past the byte share.
    const evidenceFor = async (w: Awaited<ReturnType<typeof world>>, rows: number) => {
      const evidence = documentEvidenceSink(w.store, A);
      for (let i = 0; i < rows; i += 1) await evidence.note({ workspaceId: A, project: "payments", lessonId: expected[0]!, kind: "against", weight: 1, at: now - DAY, id: `row-${String(i)}` });
      for (const write of w.writes) write.mockClear();
    };
    const crowded = await world();
    await pair(crowded);
    await evidenceFor(crowded, DISPATCHER_SIGNALS_LIMITS.items + 100);
    expect(await order(crowded)).toEqual(expected);
    // The same rows within the share DO rank the lesson down (so the cut above is what kept the neutral order, not an absence of evidence).
    const within = await world();
    await pair(within);
    await evidenceFor(within, 40);
    expect((await order(within))[0]).not.toBe(expected[0]);
    const limits = DISPATCHER_SIGNALS_LIMITS as { -readonly [K in keyof typeof DISPATCHER_SIGNALS_LIMITS]: number };
    const saved = { ...limits };
    try {
      for (const cut of [{ reads: 3 }, { bytes: 200 }] as const) {
        Object.assign(limits, saved, cut);
        const cutWorld = await world();
        await pair(cutWorld);
        await evidenceFor(cutWorld, 40);
        expect(await order(cutWorld), JSON.stringify(cut)).toEqual(expected);
      }
    } finally { Object.assign(limits, saved); }
  });

  it("it reads only this company's partitions for this project, never writes, and reads nothing when nothing loads", async () => {
    const w = await world();
    await pair(w);
    const asked = vi.spyOn(w.store, "query");
    await order(w);
    expect(asked.mock.calls.length).toBeGreaterThan(0);
    for (const [request] of asked.mock.calls) expect(request.pk).toContain(A);
    for (const [request] of asked.mock.calls) expect(request.pk).toContain("payments");
    for (const write of w.writes) expect(write).not.toHaveBeenCalled();
    // A project whose mode does not load reads no signals.
    const off = await world();
    await pair(off);
    const none = vi.spyOn(off.store, "query");
    expect(await createDispatcherLearned({ ...off.options, lessonsSwitch: { mode: "off" } })(request)).toEqual({});
    expect(none).not.toHaveBeenCalled();
  });

  it("an answer is kept for a while per project (the next dispatch of the same project does not read the rows again) and each company has its own", async () => {
    const w = await world();
    await pair(w);
    const learned = createDispatcherLearned(w.options);
    const asked = vi.spyOn(w.store, "query");
    await learned(request);
    const first = asked.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await learned(request);
    expect(asked.mock.calls.length).toBe(first);
    // Past its time the answer is read again.
    let at = now;
    const timed = createDispatcherLearned({ ...w.options, now: () => at });
    await timed(request);
    expect(asked.mock.calls.length).toBe(first * 2);
    at += SIGNALS_TTL_MS - 1;
    await timed(request);
    expect(asked.mock.calls.length).toBe(first * 2);
    at += 2;
    await timed(request);
    expect(asked.mock.calls.length).toBe(first * 3);
    const another = createDispatcherLearned(w.options);
    await another(request);
    expect(asked.mock.calls.length).toBe(first * 4);
  });
});
