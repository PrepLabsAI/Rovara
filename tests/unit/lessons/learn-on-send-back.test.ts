// Learn on send-back: a person's send-back of a task that is still open queues one reflection of ids (`sent_back` and its round), so the correction can help the next task before this one ends. It holds the
// install's lessons switch, the project's learning mode, the company (the task's own, read live), a person's own words (an automatic send-back, or one with no reason, queues nothing), a bound on rounds, and
// the existing learning spend path (the worker's reflection, nothing new). Each round is its own lease, and a send-back already learned from is left out of the task's later reflections (no second draft).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WORKFLOW_AGENTX_ACTOR_ID, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../../packages/broker/src/core/task-flow/access.js";
import { taskKey } from "../../../packages/broker/src/core/task-flow/keys.js";
import { ownerNoteItem } from "../../../packages/broker/src/core/task-flow/owner-note.js";
import { localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";
import { buildCoreRegistry, createCoreRuntime, type CoreRuntime } from "../../../packages/broker/src/core-host/index.js";
import { createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, CORE_LESSONS_VARIABLE, type CoreLessons } from "../../../packages/broker/src/core-host/lessons.js";
import type { HostedLessonPeople } from "../../../packages/broker/src/lessons/hosted-people.js";
import { setLearningSourcePause } from "../../../packages/broker/src/lessons/learning-sources.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { writeLearningMode } from "../../../packages/broker/src/lessons/document-settings.js";
import { ReflectMessageSchema, SEND_BACK_REFLECTIONS_MAX, parseReflectMessage, reflectLeaseOutcome, reflectQueueOf, sendBackRequestId } from "../../../packages/broker/src/lessons/reflect-queue.js";
import { runReflectMessage, type ReflectWorkerDeps } from "../../../packages/broker/src/lessons/reflect-worker.js";
import { documentReflectClaims, reflectClaimKey } from "../../../packages/broker/src/lessons/reflect-claims.js";
import { NO_REASON_TEXT, type SendBackFact } from "../../../packages/broker/src/lessons/task-subject.js";
import { learnFromEndedTaskTyped, sendBackReflectedKey, type TaskLearningDeps, type TaskSubjectBase } from "../../../packages/broker/src/lessons/task-end.js";
import type { OutcomeRowReader } from "../../../packages/broker/src/lessons/task-outcome-rows.js";
import type { ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../../support/core-host-fakes.js";
import { Alerts, Audit, BASE, Clock, MERGED, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, candidateJson, embedder, facts, memberSpan, reply, settings, verifier } from "./lesson-helpers.js";

// The core-host tests set the install gate from their switch; the reflection tests run with it on (as `lesson-helpers` sets it).
afterEach(() => setLearnedLessonsGate(() => true));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const DEFINITION: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const nobody = (): HostedLessonPeople => ({
  async approvers() { return { complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }; },
  async onProjectRoster() { return false; }, async linkedAccounts() { return []; }, async displayName() { return undefined; }, async isErased() { return false; },
});

interface Company { runtime: CoreRuntime; lessons: CoreLessons | undefined; taskId: string }

async function world(env: NodeJS.ProcessEnv): Promise<{ world: FakeWorld; companies: Map<OrgId, Company>; lessonsSwitch: { mode: string }; logs: string[] }> {
  const fake = createFakeWorld();
  setCoreLessonsGate(env);
  const registry = await buildCoreRegistry({ modules: fake.modules, context: fake.context(), areas: ["flow", "build", "merge"] });
  const lessonsSwitch = readCoreLessonsSwitch(env).value;
  const hosts = new Map<string, CoreLessons>();
  const companies = new Map<OrgId, Company>();
  const logs: string[] = [];
  for (const companyId of [A, B]) {
    await fake.store.put({ item: { ...projectRevisionKey(companyId, DEFINITION.name, DEFINITION.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(DEFINITION)) as JsonValue } });
    await fake.store.put({ item: { ...orgProjectCatalogKey(companyId, DEFINITION.name), entityType: "PROJECT_CATALOG", latestRevision: DEFINITION.revision } });
    const runtime = createCoreRuntime({
      registry, companyId, callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined,
    });
    const lessons = createCoreLessons({ flow: runtime.flow, registry, companyId, lessonsSwitch, people: nobody(), hostFor: async (id) => hosts.get(id)?.host, now: () => fake.clock.now, log: (entry) => { logs.push(String(entry["event"])); } });
    lessons?.attach();
    if (lessons !== undefined) hosts.set(companyId, lessons);
    const principal = localOwnerPrincipal({ companyId });
    const { task } = await runtime.flow.start({ principal, client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    companies.set(companyId, { runtime, lessons, taskId: task.taskId });
  }
  return { world: fake, companies, lessonsSwitch, logs };
}

type Decision = { source: "SEND_BACK" | "FINDINGS" | "AUTO_FIX" | "GATE"; decision?: "REQUEST_CHANGES" | "APPROVE"; reason: string; agent?: true };

/** Writes decisions onto the task's stored workflow, as a send-back would have committed them. */
async function decide(fake: FakeWorld, taskId: string, decisions: Decision[], over: Record<string, unknown> = {}): Promise<string[]> {
  const record = (await fake.store.get(taskKey(taskId)))! as unknown as Record<string, unknown> & { workflow: { decisions: unknown[]; revision: number } };
  const at = new Date(fake.clock.now).toISOString();
  const added = decisions.map((d) => ({
    requestId: randomUUID(), workflowRevision: record.workflow.revision, decision: d.decision ?? "REQUEST_CHANGES", reason: d.reason, source: d.source, at,
    ...(d.agent === true ? { actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX", auto: { stage: "IMPLEMENT" } } : { actorId: "person-1", actorRole: "TASK_OWNER" }),
  }));
  const workflow = { ...record.workflow, decisions: [...record.workflow.decisions, ...added] };
  await fake.store.put({ item: { ...record, workflow, ...over } as never });
  return added.map((entry) => entry.requestId);
}

/** The person's per-finding notes of a findings answer, kept beside the workflow the way the answer keeps them (`owner-note.ts`). */
async function keepFindingNotes(fake: FakeWorld, taskId: string, requestId: string, findingNotes?: string[]): Promise<void> {
  await fake.store.transact([ownerNoteItem({ taskId, requestId, text: "Fix only the problems listed. The owner gave no further instructions for them.", now: new Date(fake.clock.now), ...(findingNotes === undefined ? {} : { findingNotes }) })]);
}

async function queued(fake: FakeWorld): Promise<Array<Record<string, unknown>>> {
  const queue = await reflectQueueOf(fake.queues);
  return (await queue.receive({ maxMessages: 10 })).map((message) => message.body as Record<string, unknown>);
}

describe("the message of a send-back", () => {
  it("is ids and the fixed word with its round; a round is required for a send-back and refused on any other outcome; the round is bounded", () => {
    const sent = { orgId: A, taskId: "task-1", outcome: "sent_back", round: 2, requestId: sendBackRequestId("task-1", 2) };
    expect(parseReflectMessage(JSON.stringify(sent))).toEqual(sent);
    expect(ReflectMessageSchema.safeParse({ ...sent, round: undefined }).success).toBe(false);
    expect(ReflectMessageSchema.safeParse({ ...sent, round: SEND_BACK_REFLECTIONS_MAX + 1 }).success).toBe(false);
    expect(ReflectMessageSchema.safeParse({ ...sent, outcome: "merged" }).success).toBe(false);
    expect(ReflectMessageSchema.safeParse({ orgId: A, taskId: "task-1", outcome: "merged", requestId: "r-1" }).success).toBe(true);
    expect(ReflectMessageSchema.safeParse({ ...sent, text: "a person's words" }).success).toBe(false);
  });
  it("keeps its request id within the message's 200 characters: a task id too long for it is hashed, the same task giving the same id", () => {
    const long = "t".repeat(200);
    const id = sendBackRequestId(long, 3);
    expect(id.length).toBeLessThanOrEqual(200);
    expect(id).toBe(sendBackRequestId(long, 3));
    expect(id).not.toBe(sendBackRequestId(long, 2));
    expect(ReflectMessageSchema.safeParse({ orgId: A, taskId: "task-1", outcome: "sent_back", round: 3, requestId: id }).success).toBe(true);
    expect(sendBackRequestId("task-1", 1)).toBe("task-1:sent_back:1");
  });

  it("takes its lease per round: the same round is one reflection, the next round is another, and other outcomes keep their old lease word", () => {
    expect(reflectLeaseOutcome({ outcome: "sent_back", round: 1 })).toBe("sent_back-1");
    expect(reflectLeaseOutcome({ outcome: "sent_back", round: 2 })).toBe("sent_back-2");
    expect(reflectLeaseOutcome({ outcome: "merged" })).toBe("merged");
  });
  it("the worker leases each round apart: a redelivery of round 1 is already done, round 2 runs", async () => {
    const store = new MemoryDocumentStore({ ttlAttribute: "indexExpiresAt" });
    const learned: string[] = [];
    const deps: ReflectWorkerDeps = {
      claims: documentReflectClaims({ store, keysOutcome: async () => "clear" }), now: () => 1_000_000, deadlineMs: 60_000, log: () => undefined,
      learn: async (input) => { learned.push(input.outcome); return { status: "reflected", retry: false }; },
    };
    const body = (round: number) => JSON.stringify({ orgId: A, taskId: "task-1", outcome: "sent_back", round, requestId: sendBackRequestId("task-1", round) });
    expect((await runReflectMessage(deps, body(1))).result).toBe("reflected");
    expect((await runReflectMessage(deps, body(1))).result).toBe("already");
    expect((await runReflectMessage(deps, body(2))).result).toBe("reflected");
    expect(learned).toEqual(["sent_back", "sent_back"]);
    expect(await store.get(reflectClaimKey(A, "task-1", "sent_back-1"))).toBeDefined();
    expect(await store.get(reflectClaimKey(A, "task-1", "sent_back-2"))).toBeDefined();
  });
});

describe("queueing: a person's send-back, behind the switch and the mode, for the task's own company", () => {
  it("a person's send-back with words queues one sent_back message of ids under the task's company", async () => {
    const { world: fake, companies } = await world({ [CORE_LESSONS_VARIABLE]: "on" });
    const a = companies.get(A)!;
    await decide(fake, a.taskId, [{ source: "SEND_BACK", reason: "Use the shared retry helper, not a loop." }]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect(await queued(fake)).toEqual([{ orgId: A, taskId: a.taskId, outcome: "sent_back", round: 1, requestId: sendBackRequestId(a.taskId, 1) }]);
  });

  it("the second send-back is round 2; a findings request-changes counts as a send-back; past the round bound nothing is queued", async () => {
    const { world: fake, companies, logs } = await world({ [CORE_LESSONS_VARIABLE]: "on" });
    const a = companies.get(A)!;
    // A findings answer's reason is code's own summary, never the person's words: with no per-finding notes it counts as round 2 but queues nothing itself.
    await decide(fake, a.taskId, [{ source: "SEND_BACK", reason: "first" }, { source: "FINDINGS", reason: "0 accepted, 1 to fix" }]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect(await queued(fake)).toEqual([]);
    await decide(fake, a.taskId, [{ source: "SEND_BACK", reason: "third, in a person's words" }]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect((await queued(fake)).map((m) => m["round"])).toEqual([3]);
    await decide(fake, a.taskId, Array.from({ length: SEND_BACK_REFLECTIONS_MAX - 1 }, (_, i) => ({ source: "SEND_BACK" as const, reason: `again ${String(i)}` })));
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect(await queued(fake)).toEqual([]);
    // Refused by the round bound itself, not by a failed send.
    expect(logs).not.toContain("send_back_not_queued");
  });

  it("Decisions in tasks paused (L4-LP3Wc): a send-back queues no reflection and nothing about it is read; resumed, the next one queues; another company's pause stops nothing here", async () => {
    const { world: fake, companies, logs } = await world({ [CORE_LESSONS_VARIABLE]: "on" });
    const a = companies.get(A)!;
    const pause = (workspaceId: OrgId, paused: boolean) => setLearningSourcePause({ store: a.lessons!.runtime.store, audit: a.lessons!.runtime.audit, now: () => fake.clock.now }, { workspaceId, project: "payments" }, "owner", "task_decisions", paused);
    expect(await pause(B, true)).toMatchObject({ ok: true, changed: true });
    expect(await pause(A, true)).toMatchObject({ ok: true, changed: true });
    await decide(fake, a.taskId, [{ source: "SEND_BACK", reason: "first, in a person's words" }]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect(await queued(fake)).toEqual([]);
    expect(await pause(A, false)).toMatchObject({ ok: true, changed: true });
    await decide(fake, a.taskId, [{ source: "SEND_BACK", reason: "second, in a person's words" }]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect((await queued(fake)).map((m) => m["round"])).toEqual([2]);
    // Only the send-back kind decides this: a stop on another kind (a close reason) does not hold a send-back back.
    const store = a.lessons!.runtime.store;
    await store.setFlags({ workspaceId: A, project: "payments" }, { stoppedKinds: { close_reason: { at: fake.clock.now } } });
    await decide(fake, a.taskId, [{ source: "SEND_BACK", reason: "third, in a person's words" }]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect((await queued(fake)).map((m) => m["round"])).toEqual([3]);
    expect(logs).not.toContain("send_back_not_queued");
  });

  it("a findings fix teaches only through the person's per-finding notes: with notes it queues its round, with none (or an unreadable row) it queues nothing, and it is never read from the summary", async () => {
    const { world: fake, companies, logs } = await world({ [CORE_LESSONS_VARIABLE]: "on" });
    const a = companies.get(A)!;
    // No owner note row at all (an answer from before notes were kept), then a note row with no per-finding notes: counted rounds, nothing queued.
    const [bare] = await decide(fake, a.taskId, [{ source: "FINDINGS", reason: "0 accepted, 1 to fix" }]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect(await queued(fake)).toEqual([]);
    const [silent] = await decide(fake, a.taskId, [{ source: "FINDINGS", reason: "0 accepted, 1 to fix" }]);
    await keepFindingNotes(fake, a.taskId, silent!);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect(await queued(fake)).toEqual([]);
    expect(bare).toBeDefined();
    // A round the person wrote notes for is queued as that round (round 3 here: both earlier findings answers were rounds).
    const [noted] = await decide(fake, a.taskId, [{ source: "FINDINGS", reason: "0 accepted, 2 to fix" }]);
    await keepFindingNotes(fake, a.taskId, noted!, ["Return 404, not 500.", "Keep the footer line."]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect(await queued(fake)).toEqual([{ orgId: A, taskId: a.taskId, outcome: "sent_back", round: 3, requestId: sendBackRequestId(a.taskId, 3) }]);
    expect(logs).not.toContain("send_back_not_queued");
  });

  it("a findings fix of another company's task, one past the round bound, or in a project whose mode does not reflect queues nothing even with notes", async () => {
    const { world: fake, companies } = await world({ [CORE_LESSONS_VARIABLE]: `on:${A}` });
    const a = companies.get(A)!;
    const b = companies.get(B)!;
    const [other] = await decide(fake, b.taskId, [{ source: "FINDINGS", reason: "0 accepted, 1 to fix" }]);
    await keepFindingNotes(fake, b.taskId, other!, ["B's correction."]);
    await a.lessons!.host.noteSentBack(b.taskId);
    expect(await queued(fake)).toEqual([]);

    await writeLearningMode(a.lessons!.runtime.documents, { workspaceId: A, project: "payments" }, "Collect", fake.clock.now);
    const [collect] = await decide(fake, a.taskId, [{ source: "FINDINGS", reason: "0 accepted, 1 to fix" }]);
    await keepFindingNotes(fake, a.taskId, collect!, ["Use the helper."]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect(await queued(fake)).toEqual([]);

    await writeLearningMode(a.lessons!.runtime.documents, { workspaceId: A, project: "payments" }, "Suggest", fake.clock.now);
    const many = await decide(fake, a.taskId, Array.from({ length: SEND_BACK_REFLECTIONS_MAX }, () => ({ source: "FINDINGS" as const, reason: "0 accepted, 1 to fix" })));
    await keepFindingNotes(fake, a.taskId, many.at(-1)!, ["Late notes."]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect(await queued(fake)).toEqual([]);
  });

  it("an automatic send-back, a findings approval, a send-back in code's fixed words, and a closed task queue nothing", async () => {
    const { world: fake, companies } = await world({ [CORE_LESSONS_VARIABLE]: "on" });
    const a = companies.get(A)!;
    await decide(fake, a.taskId, [{ source: "AUTO_FIX", reason: "checks failed", agent: true }]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    await decide(fake, a.taskId, [{ source: "FINDINGS", decision: "APPROVE", reason: "all good" }]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    await decide(fake, a.taskId, [{ source: "SEND_BACK", reason: NO_REASON_TEXT }]);
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect(await queued(fake)).toEqual([]);
    await decide(fake, a.taskId, [{ source: "SEND_BACK", reason: "Use the shared helper." }], { closedAt: new Date(fake.clock.now).toISOString() });
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect(await queued(fake)).toEqual([]);
  });

  it("a project whose mode does not reflect (Off, Collect) queues nothing", async () => {
    for (const mode of ["Off", "Collect"] as const) {
      const { world: fake, companies } = await world({ [CORE_LESSONS_VARIABLE]: "on" });
      const a = companies.get(A)!;
      await writeLearningMode(a.lessons!.runtime.documents, { workspaceId: A, project: "payments" }, mode, fake.clock.now);
      await decide(fake, a.taskId, [{ source: "SEND_BACK", reason: "Use the shared retry helper." }]);
      await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
      expect(await queued(fake), mode).toEqual([]);
    }
  });

  it("two companies: A's host never queues B's task, and a company the switch does not cover has no hook at all", async () => {
    const { world: fake, companies } = await world({ [CORE_LESSONS_VARIABLE]: `on:${A}` });
    const a = companies.get(A)!;
    const b = companies.get(B)!;
    expect(b.lessons).toBeUndefined();
    expect(b.runtime.flow.deps.lessonsSentBack).toBeUndefined();
    await decide(fake, b.taskId, [{ source: "SEND_BACK", reason: "B's correction." }]);
    await a.runtime.flow.deps.lessonsSentBack!(b.taskId);
    await a.lessons!.host.noteSentBack(b.taskId);
    expect(await queued(fake)).toEqual([]);
  });

  it("a switch that stops covering the company after the hook was built queues nothing (read at every send-back)", async () => {
    const { world: fake, companies, lessonsSwitch } = await world({ [CORE_LESSONS_VARIABLE]: "on" });
    const a = companies.get(A)!;
    await decide(fake, a.taskId, [{ source: "SEND_BACK", reason: "Use the shared helper." }]);
    lessonsSwitch.mode = "off";
    await a.runtime.flow.deps.lessonsSentBack!(a.taskId);
    expect(await queued(fake)).toEqual([]);
  });

  it("a switch that cannot be read is no fault in the send-back: nothing is queued and nothing is thrown", async () => {
    const { world: fake, companies, lessonsSwitch } = await world({ [CORE_LESSONS_VARIABLE]: "on" });
    const a = companies.get(A)!;
    await decide(fake, a.taskId, [{ source: "SEND_BACK", reason: "Use the shared helper." }]);
    Object.defineProperty(lessonsSwitch, "mode", { get() { throw new Error("unreadable"); } });
    await expect(a.runtime.flow.deps.lessonsSentBack!(a.taskId)).resolves.toBeUndefined();
    expect(await queued(fake)).toEqual([]);
  });

  it("with the switch off nothing is built: no hook, nothing queued", async () => {
    const { world: fake, companies } = await world({});
    for (const company of companies.values()) expect(company.runtime.flow.deps.lessonsSentBack).toBeUndefined();
    expect(await queued(fake)).toEqual([]);
  });

  it("never throws into the send-back: a queue that refuses is one log line", async () => {
    const { world: fake, companies } = await world({ [CORE_LESSONS_VARIABLE]: "on" });
    const a = companies.get(A)!;
    await decide(fake, a.taskId, [{ source: "SEND_BACK", reason: "Use the shared helper." }]);
    const queue = await reflectQueueOf(fake.queues);
    queue.enqueue = async () => { throw new Error("queue down"); };
    await expect(a.runtime.flow.deps.lessonsSentBack!(a.taskId)).resolves.toBeUndefined();
    await expect(a.lessons!.host.noteSentBack("not-a-task")).resolves.toBeUndefined();
  });
});

// ---- the reflection

class Rows implements OutcomeRowReader {
  sendBacks = new Map<string, SendBackFact>();
  async sendBack(input: { requestId: string }): Promise<SendBackFact | undefined> { return this.sendBacks.get(input.requestId); }
  async revertedBy(): Promise<undefined> { return undefined; }
}

function reflection(model: ScriptedModel, sendBackIds: string[], outcome: "merged" | undefined = undefined) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const rows = new Rows();
  const configured = settings({ mode: "Suggest" });
  const base: TaskSubjectBase = {
    facts: {
      workspaceId: WS, project: PROJECT, taskId: "task-1", repositories: ["api"], baseCommit: BASE, ...(outcome === "merged" ? { mergedCommit: MERGED, outcome } : {}),
      task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } },
      rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", spans: [memberSpan("Add a /health endpoint.", { kind: "intent", eventId: "ev-intent" })] },
    },
    sendBackRequestIds: sendBackIds,
  };
  const process: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now,
    verifier: verifier("valid"), facts: facts(), settings: configured, newId: (() => { let n = 0; return () => `les_${String(++n).padStart(4, "0")}`; })(),
  };
  const deps: TaskLearningDeps = { source: { read: async () => base }, rows, settings: configured, reflect: { model, spend: new Spend(), audit, settings: configured, edition: "public", now: clock.now }, process };
  return { deps, store, rows, base };
}
const prompt = (model: ScriptedModel, index: number): string => JSON.stringify(model.calls[index]);
const human = (requestId: string, reasonText: string): SendBackFact => ({ id: `task:task-1:sendback:${requestId}`, origin: "human", actorDeveloperId: "sam", actorTrust: "member", reasonText });

describe("the reflection of a send-back", () => {
  it("the task's chat thread is read once, when the task has really ended: a send-back's reflection and a revert's re-reflection never ask for it", async () => {
    const asked: Array<{ withoutSlack?: true | undefined }> = [];
    const w = reflection(new ScriptedModel([reply(), reply(), reply()]), ["req-1"]);
    w.rows.sendBacks.set("req-1", human("req-1", "Use withRetry for HTTP retries, never a hand loop."));
    const read = w.deps.source.read.bind(w.deps.source);
    w.deps.source.read = async (input) => { asked.push({ withoutSlack: input.withoutSlack }); return read(input); };
    await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "sent_back" });
    await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "reverted" });
    await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1" });
    await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "merged" });
    expect(asked.map((one) => one.withoutSlack)).toEqual([true, true, undefined, undefined]);
  });

  it("reflects the open task on the person's words, marks that send-back learned, and the task's merge reflection leaves it out", async () => {
    const model = new ScriptedModel([reply(candidateJson({ evidenceSpanIds: ["S1"] })), reply()]);
    const w = reflection(model, ["req-1"]);
    w.rows.sendBacks.set("req-1", human("req-1", "Use withRetry for HTTP retries, never a hand loop."));
    expect(await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "sent_back" })).toMatchObject({ status: "reflected" });
    expect(model.calls).toHaveLength(1);
    expect(prompt(model, 0)).toContain("never a hand loop");
    expect(prompt(model, 0)).toContain("open task a person sent back");
    expect(await w.store.seenOnce({ workspaceId: WS, project: PROJECT }, sendBackReflectedKey("task:task-1:sendback:req-1"))).toBe(true);
    // Later the task merges: the same send-back is not read again (no second draft of the same correction), the rest of the task is.
    w.base.facts = { ...w.base.facts, mergedCommit: MERGED, outcome: "merged" };
    await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1" });
    expect(model.calls).toHaveLength(2);
    expect(prompt(model, 1)).not.toContain("never a hand loop");
    expect(prompt(model, 1)).toContain("health endpoint");
  });

  it("a second send-back's reflection reads only the new send-back", async () => {
    const model = new ScriptedModel([reply(), reply()]);
    const w = reflection(model, ["req-1"]);
    w.rows.sendBacks.set("req-1", human("req-1", "First: use withRetry."));
    await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "sent_back" });
    w.base.sendBackRequestIds = ["req-1", "req-2"];
    w.rows.sendBacks.set("req-2", human("req-2", "Second: log through the audit sink."));
    await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "sent_back" });
    expect(prompt(model, 1)).toContain("Second: log through");
    expect(prompt(model, 1)).not.toContain("First: use withRetry");
  });

  it("makes no model call when nothing new is a person's own words: no reason given, an outsider, or a send-back already learned", async () => {
    const noReason = reflection(new ScriptedModel([reply()]), ["req-1"]);
    noReason.rows.sendBacks.set("req-1", human("req-1", ""));
    expect((await learnFromEndedTaskTyped(noReason.deps, { workspaceId: WS, taskId: "task-1", outcome: "sent_back" })).status).toBe("not_reflected");
    expect((noReason.deps.reflect.model as ScriptedModel).calls).toEqual([]);

    const outsider = reflection(new ScriptedModel([reply()]), ["req-1"]);
    outsider.rows.sendBacks.set("req-1", { ...human("req-1", "Do it my way."), actorTrust: "outsider" });
    await learnFromEndedTaskTyped(outsider.deps, { workspaceId: WS, taskId: "task-1", outcome: "sent_back" });
    expect((outsider.deps.reflect.model as ScriptedModel).calls).toEqual([]);

    const again = reflection(new ScriptedModel([reply()]), ["req-1"]);
    again.rows.sendBacks.set("req-1", human("req-1", "Use withRetry."));
    await again.store.markOnce({ workspaceId: WS, project: PROJECT }, sendBackReflectedKey("task:task-1:sendback:req-1"));
    await learnFromEndedTaskTyped(again.deps, { workspaceId: WS, taskId: "task-1", outcome: "sent_back" });
    expect((again.deps.reflect.model as ScriptedModel).calls).toEqual([]);
  });

  it("a reflection the cap or a refusal stopped marks nothing: the send-back is still learned at the task's end", async () => {
    const w = reflection(new ScriptedModel([reply()]), ["req-1"]);
    w.rows.sendBacks.set("req-1", human("req-1", "Use withRetry."));
    (w.deps.reflect.spend as Spend).admitted = false;
    expect((await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "sent_back" })).status).toBe("not_reflected");
    expect((w.deps.reflect.model as ScriptedModel).calls).toEqual([]);
    expect(await w.store.seenOnce({ workspaceId: WS, project: PROJECT }, sendBackReflectedKey("task:task-1:sendback:req-1"))).toBe(false);
  });

  it("a reflection whose drafts did not all reach the curator (one failed, or the deadline cut them) marks nothing: the task's end can still learn the send-back", async () => {
    const w = reflection(new ScriptedModel([reply(candidateJson({ evidenceSpanIds: ["S1"] }), candidateJson({ title: "Log through the sink", evidenceSpanIds: ["S1"] }))]), ["req-1"]);
    w.rows.sendBacks.set("req-1", human("req-1", "Use withRetry for HTTP retries."));
    w.store.commit = async () => { throw new Error("store down"); };
    expect((await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "sent_back" })).status).toBe("reflected");
    expect((w.deps.reflect.model as ScriptedModel).calls).toHaveLength(1);
    expect(await w.store.seenOnce({ workspaceId: WS, project: PROJECT }, sendBackReflectedKey("task:task-1:sendback:req-1"))).toBe(false);
  });

  it("the project's mode is read first: Off reflects nothing for a send-back either", async () => {
    const w = reflection(new ScriptedModel([reply()]), ["req-1"]);
    w.rows.sendBacks.set("req-1", human("req-1", "Use withRetry."));
    w.deps.settings = settings({ mode: "Off" });
    expect((await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "sent_back" })).status).toBe("off");
    expect((w.deps.reflect.model as ScriptedModel).calls).toEqual([]);
  });

  it("a task with no send-back reflection reads exactly what it read before (no key, nothing left out)", async () => {
    const model = new ScriptedModel([reply()]);
    const w = reflection(model, ["req-1"], "merged");
    w.rows.sendBacks.set("req-1", human("req-1", "Use withRetry for retries."));
    await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1" });
    expect(prompt(model, 0)).toContain("Use withRetry for retries.");
    expect(await w.store.seenOnce({ workspaceId: WS, project: PROJECT }, sendBackReflectedKey("task:task-1:sendback:req-1"))).toBe(false);
  });
});
