// The terminal-task hook. A finished task is reflected on only when the project's learning mode allows it, with a subject built from the real sources of who did
// what; the send-back action tells the record WHO sent the task back; and where learning is not wired nothing is registered at all.
import { describe, expect, it } from "vitest";
import type { ProcessDeps } from "../../../packages/lessons/src/process.js";
import { withLearningAttempt, noteLearningFault, type LearningAttempt } from "../../../packages/lessons/src/learning-deadline.js";
import { logRef } from "../../../packages/lessons/src/log-ref.js";
import { LearningRefusal, MODEL_FAILURES_BEFORE_PAUSE, noteModelFailure, failuresCountedOncePerTask, newTaskFailureTally, type CurrentPause, type LessonsPauseStore } from "../../../packages/lessons/src/pause.js";
import { type TaskEndEvent, inheritedTasksOf, learnFromEndedTask, learnFromEndedTaskTyped, learningTaskEndHandler, reflectOutcomeOf, subjectForTask, type TaskLearningDeps, type TaskSubjectBase } from "../../../packages/lessons/src/task-end.js";
import type { OutcomeRowReader } from "../../../packages/lessons/src/task-outcome-rows.js";
import { InMemoryLessonStore } from "../../../packages/lessons/src/store.js";
import type { SendBackFact, TaskSubjectFacts } from "../../../packages/lessons/src/task-subject.js";
import type { CounterDeps } from "../../../packages/lessons/src/counters.js";
import type { CorrectionJudge } from "../../../packages/lessons/src/ports.js";
import type { Lesson } from "../../../packages/lessons/src/types.js";
import { Alerts, Audit, BASE, Clock, MERGED, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, candidateJson, embedder, facts, lessonRecord, memberSpan, reply, seed, settings, verifier } from "./lesson-helpers.js";

/** A judge on an install whose model path answers nothing for a rating (usable, but every rating fails): a correction in scope stays unjudged. */
const REFUSING_JUDGE: CorrectionJudge = { rate: async () => { throw new Error("no rating"); } };

class Rows implements OutcomeRowReader {
  asked: string[] = [];
  sendBacks = new Map<string, SendBackFact>();
  reverter: { actorDeveloperId?: string } | undefined;
  failing = false;
  async sendBack(input: { requestId: string }): Promise<SendBackFact | undefined> { this.asked.push(`sendback:${input.requestId}`); if (this.failing) throw new Error("table down"); return this.sendBacks.get(input.requestId); }
  async revertedBy(): Promise<{ actorDeveloperId?: string } | undefined> { this.asked.push("reverted_by"); return this.reverter; }
}

const baseFacts = (over: Partial<TaskSubjectFacts> = {}): TaskSubjectBase["facts"] => ({
  workspaceId: WS, project: PROJECT, taskId: "task-1", repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged",
  task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } },
  rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", links: ["https://github.com/acme/api/pull/7"], spans: [memberSpan("Use withRetry for HTTP retries in api.", { eventId: "ev-p" })] },
  ...over,
});

function setup(over: { settings?: ReturnType<typeof settings>; base?: TaskSubjectBase | undefined; model?: ScriptedModel } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const model = over.model ?? new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]);
  const rows = new Rows();
  const reads: string[] = [];
  const base = "base" in over ? over.base : ({ facts: baseFacts(), sendBackRequestIds: ["req-1"] } satisfies TaskSubjectBase);
  const configured = over.settings ?? settings({ mode: "On" });
  const process: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now,
    verifier: verifier("valid"), facts: facts(), settings: configured, newId: (() => { let n = 0; return () => `les_${String(++n).padStart(4, "0")}`; })(),
  };
  const deps: TaskLearningDeps = {
    source: { read: async (input) => { reads.push(input.taskId); return base; } }, rows, settings: configured,
    reflect: { model, spend: new Spend(), audit, settings: configured, edition: "public", now: clock.now }, process,
  };
  return { deps, store, rows, model, audit, reads };
}

describe("reflectOutcomeOf", () => {
  it("merged, closed and abandoned ends teach something; an agent step that succeeded or a question answered does not", () => {
    expect(["merged", "closed", "failed", "cancelled", "creator_removed", "succeeded", "answered"].map((o) => reflectOutcomeOf(o as never))).toEqual(["merged", "closed", "abandoned", "abandoned", "abandoned", undefined, undefined]);
  });
});

describe("learnFromEndedTask: behind the learning switch", () => {
  it("mode Off and Collect reflect nothing and read no rows", async () => {
    for (const mode of ["Off", "Collect"] as const) {
      const w = setup({ settings: settings({ mode }) });
      expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).toBe("off");
      expect(w.model.calls).toEqual([]);
      expect(w.rows.asked).toEqual([]);
    }
  });
  it("a settings reader that fails is Off (fail closed)", async () => {
    const w = setup({ settings: { read: async () => { throw new Error("down"); } } });
    expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).toBe("off");
    expect(w.model.calls).toEqual([]);
  });
  it("mode Suggest and On reflect and hand each draft to the curator", async () => {
    for (const mode of ["Suggest", "On"] as const) {
      const w = setup({ settings: settings({ mode }) });
      expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).toBe("reflected");
      expect(w.model.calls).toHaveLength(1);
      expect((await w.store.list({ workspaceId: WS, project: PROJECT })).length).toBeGreaterThan(0);
    }
  });
});

describe("learnFromEndedTask: the facts", () => {
  it("a send-back by a third person is a measured outcome, by the starter it is not", async () => {
    const measuredFor = async (actor: string): Promise<boolean | undefined> => {
      const w = setup();
      w.rows.sendBacks.set("req-1", { id: "task:task-1:sendback:req-1", origin: "human", actorDeveloperId: actor, actorTrust: "member", reasonText: "use the shared helper" });
      await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" });
      return (await w.store.list({ workspaceId: WS, project: PROJECT }))[0]?.provenance.measured;
    };
    expect(await measuredFor("sam")).toBe(true);
    expect(await measuredFor("starter")).toBe(false);
  });
  it("a reverted task reads the reverter from the person-link row; a merged one never asks for it", async () => {
    const w = setup();
    w.rows.reverter = { actorDeveloperId: "rita" };
    const subject = await subjectForTask(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "reverted" });
    expect(subject).toMatchObject({ outcome: "reverted", revertedBy: "rita", initiatorId: "starter" });
    const merged = await subjectForTask(w.deps, { workspaceId: WS, taskId: "task-1" });
    expect(merged?.revertedBy).toBeUndefined();
    expect(w.rows.asked.filter((q) => q === "reverted_by")).toHaveLength(1);
  });
  it("no facts, a source that claims another workspace, and a source or rows that throw never throw out of the hook", async () => {
    expect(await learnFromEndedTask(setup({ base: undefined }).deps, { workspaceId: WS, taskId: "task-1" })).toBe("no_facts");
    const foreign = setup({ base: { facts: baseFacts({ workspaceId: "org_zzzzzzzzzzzzzzzzzzzz" }), sendBackRequestIds: [] } });
    expect(await learnFromEndedTask(foreign.deps, { workspaceId: WS, taskId: "task-1" })).toBe("no_facts");
    expect(foreign.model.calls).toEqual([]);
    const broken = setup();
    broken.rows.failing = true;
    expect(await learnFromEndedTask(broken.deps, { workspaceId: WS, taskId: "task-1" })).toBe("not_reflected");
    const noSource = setup();
    noSource.deps.source = { read: async () => { throw new Error("down"); } };
    expect(await learnFromEndedTask(noSource.deps, { workspaceId: WS, taskId: "task-1" })).toBe("not_reflected");
  });
});

const endEvent = (over: Partial<TaskEndEvent> = {}): TaskEndEvent => ({ orgId: WS, taskId: "task-1", outcome: "merged", ...over });

describe("the task-end handler and its installation (a task's end sends ids to a queue and never calls the model)", () => {
  const queueOf = () => { const sent: unknown[] = []; return { sent, queue: { send: async (m: unknown) => { sent.push(m); } } as never }; };
  it("sends one message of ids only for an end that teaches something, and nothing for one that does not or where there is no queue", async () => {
    await learningTaskEndHandler(() => undefined)(endEvent());
    const q = queueOf();
    const handler = learningTaskEndHandler(() => ({ queue: q.queue, newRequestId: () => "req-1" }));
    await handler(endEvent({ outcome: "succeeded" }));
    await handler(endEvent({ outcome: "answered" }));
    expect(q.sent).toEqual([]);
    await handler(endEvent({ outcome: "merged" }));
    await handler(endEvent({ outcome: "cancelled" }));
    expect(q.sent).toEqual([{ orgId: WS, taskId: "task-1", outcome: "merged", requestId: "req-1" }, { orgId: WS, taskId: "task-1", outcome: "abandoned", requestId: "req-1" }]);
    expect(JSON.stringify(q.sent)).not.toMatch(/person|feat\/x/u);
  });
  it("never runs the reflector, reads the task or touches the model: the handler's whole dependency is the queue", async () => {
    const w = setup();
    const q = queueOf();
    await learningTaskEndHandler(() => ({ queue: q.queue }))(endEvent());
    expect(w.reads).toEqual([]);
    expect(w.model.calls).toEqual([]);
    expect(q.sent).toHaveLength(1);
  });
  it("a queue that fails is one fixed log line: the task end is never held up and no error text is logged", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const handler = learningTaskEndHandler(() => ({ queue: { send: async () => { throw new Error("secret queue failure text"); } }, log: (event, fields) => logs.push([event, fields]) }));
    await expect(handler(endEvent())).resolves.toBeUndefined();
    expect(logs).toEqual([["learning.enqueue_failed", { task: logRef(WS, "task-1") }]]);
    expect(JSON.stringify(logs)).not.toContain("task-1");
    expect(JSON.stringify(logs)).not.toContain("secret");
  });
});

describe("the learning mode is checked before the task's subject is read", () => {
  it("a project whose learning is Off or Collect never has its subject read (no plan text, standing or erasure state), when the source can name the project alone", async () => {
    for (const mode of ["Off", "Collect"] as const) {
      const w = setup({ settings: settings({ mode }) });
      const projectReads: string[] = [];
      w.deps.source = { ...w.deps.source, projectOf: async (input) => { projectReads.push(input.taskId); return PROJECT; } };
      expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).toBe("off");
      expect(projectReads).toEqual(["task-1"]);
      expect(w.reads).toEqual([]);
      expect(w.rows.asked).toEqual([]);
      expect(w.model.calls).toEqual([]);
    }
  });
  it("a mode that allows reflection reads the subject after it; a task with no project (not this workspace's, or one that teaches nothing) reads nothing", async () => {
    const w = setup();
    const order: string[] = [];
    w.deps.source = { read: async () => { order.push("read"); return { facts: baseFacts(), sendBackRequestIds: [] }; }, projectOf: async () => { order.push("projectOf"); return PROJECT; } };
    expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).toBe("reflected");
    expect(order).toEqual(["projectOf", "read"]);
    const none = setup();
    none.deps.source = { ...none.deps.source, projectOf: async () => undefined };
    expect(await learnFromEndedTask(none.deps, { workspaceId: WS, taskId: "task-1" })).toBe("no_facts");
    expect(none.reads).toEqual([]);
  });
  it("a settings reader that fails on the first look is Off before anything is read", async () => {
    const w = setup({ settings: { read: async () => { throw new Error("down"); } } });
    w.deps.source = { ...w.deps.source, projectOf: async () => PROJECT };
    expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).toBe("off");
    expect(w.reads).toEqual([]);
  });
});

describe("learnFromEndedTaskTyped: which failures are worth another try", () => {
  const input = { workspaceId: WS, taskId: "task-1" };
  const attempt = (): LearningAttempt => ({ deadlineAt: Date.now() + 60_000, signal: new AbortController().signal, attemptId: "att-1" });
  it("a read of the task, the rows or the settings that fails is retryable inside a worker attempt, and never outside one", async () => {
    const readFails = setup();
    readFails.deps.source = { read: async () => { throw new Error("table down"); } };
    expect(await learnFromEndedTaskTyped(readFails.deps, input)).toEqual({ status: "not_reflected", retry: false });
    expect(await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(readFails.deps, input))).toEqual({ status: "not_reflected", retry: true });
    const projectFails = setup();
    projectFails.deps.source = { read: async () => undefined, projectOf: async () => { throw new Error("throttled"); } };
    expect(await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(projectFails.deps, input))).toMatchObject({ retry: true });
    const rowsFail = setup();
    rowsFail.rows.failing = true;
    expect(await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(rowsFail.deps, input))).toMatchObject({ status: "not_reflected", retry: true });
  });
  it("the model path's own word decides a dropped reflection: retryable is retried, final (or nothing said) is not", async () => {
    for (const [fault, retry] of [["retryable", true], ["final", false], [undefined, false]] as const) {
      const w = setup({ model: new ScriptedModel([]) });
      w.deps.reflect.model = { complete: async () => { if (fault !== undefined) noteLearningFault(fault); throw new Error("model down"); } };
      expect(await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(w.deps, input)), String(fault)).toEqual({ status: "not_reflected", retry });
    }
  });
  it("1b: 'learning_paused' (a refusal, the pause is already recorded) is final even when an earlier step left a retryable fault; 'spend_refused' stays retryable only when the model path said so", async () => {
    const paused = setup();
    paused.deps.reflect.model = { complete: async () => { throw new LearningRefusal("no_provider", "learning has no usable AI provider for this project"); } };
    expect(await withLearningAttempt({ ...attempt(), fault: "retryable" }, () => learnFromEndedTaskTyped(paused.deps, input))).toEqual({ status: "not_reflected", retry: false });
    const quoteRefuses = setup();
    quoteRefuses.deps.reflect.model = { quote: async () => ({ ok: false, code: "no_budget" }), complete: async () => { throw new Error("not reached"); } };
    const stale = attempt();
    expect(await withLearningAttempt(stale, async () => { noteLearningFault("retryable"); return learnFromEndedTaskTyped(quoteRefuses.deps, input); })).toEqual({ status: "not_reflected", retry: false });
    const unreadable = setup();
    unreadable.deps.reflect.spend = { admit: async () => false, look: async () => { noteLearningFault("retryable"); return "unreadable"; } };
    expect(await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(unreadable.deps, input))).toEqual({ status: "not_reflected", retry: true });
  });
  it("a made reflection, a switched-off project and a task that teaches nothing are final; a parse failure is final too (it was paid for)", async () => {
    const ok = setup();
    expect(await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(ok.deps, input))).toEqual({ status: "reflected", retry: false });
    const off = setup({ settings: settings({ mode: "Off" }) });
    expect(await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(off.deps, input))).toEqual({ status: "off", retry: false });
    const none = setup({ base: undefined });
    expect(await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(none.deps, input))).toEqual({ status: "no_facts", retry: false });
    const garbled = setup();
    garbled.deps.reflect.model = { complete: async () => ({ text: "not json", costUsd: 0.01, model: "m" }) };
    expect(await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(garbled.deps, input))).toEqual({ status: "not_reflected", retry: false });
  });
  it("every learning log line about a task names it only as logRef(company, task): the cut at the deadline, a failed draft and a failed end", async () => {
    const lines = (w: ReturnType<typeof setup>): Array<[string, Record<string, string | number>]> => { const out: Array<[string, Record<string, string | number>]> = []; w.deps.log = (event, fields) => { out.push([event, fields]); }; return out; };
    const ref = logRef(WS, "task-1");
    const cut = setup();
    const cutLines = lines(cut);
    const controller = new AbortController();
    controller.abort();
    await withLearningAttempt({ deadlineAt: Date.now() + 60_000, signal: controller.signal, attemptId: "a" }, () => learnFromEndedTaskTyped(cut.deps, input));
    expect(cutLines).toEqual([["learning.drafts_cut_at_deadline", { task: ref }]]);
    const failing = setup();
    const failingLines = lines(failing);
    failing.store.commit = async () => { throw new Error("table text"); };
    await learnFromEndedTaskTyped(failing.deps, input);
    expect(failingLines).toEqual([["learning.draft_failed", { task: ref }]]);
    const broken = setup();
    const brokenLines = lines(broken);
    broken.deps.source = { read: async () => { throw new Error("read failed"); } };
    await learnFromEndedTaskTyped(broken.deps, input);
    expect(brokenLines).toEqual([["learning.task_end_failed", { task: ref }]]);
    expect(JSON.stringify([...cutLines, ...failingLines, ...brokenLines])).not.toContain("task-1");
  });
  it("A draft whose store write fails once with a passing fault is tried again (the reflection's model is called once, never again), and the retry's log line names the task only as logRef", async () => {
    const w = setup();
    const out: Array<[string, Record<string, string | number>]> = [];
    w.deps.log = (event, fields) => { out.push([event, fields]); };
    const real = w.store.commit.bind(w.store);
    let failed = 0;
    w.store.commit = (async (...args: Parameters<typeof real>) => { if (failed === 0) { failed += 1; throw Object.assign(new Error("table text"), { name: "ProvisionedThroughputExceededException" }); } return real(...args); });
    expect(await learnFromEndedTaskTyped(w.deps, input)).toEqual({ status: "reflected", retry: false });
    expect(w.model.calls).toHaveLength(1);
    expect(await w.store.list({ workspaceId: WS, project: PROJECT })).toHaveLength(1);
    expect(out).toEqual([["learning.draft_retried", { task: logRef(WS, "task-1") }]]);
  });
  it("once the deadline's signal is aborted no further draft is processed", async () => {
    const w = setup();
    const controller = new AbortController();
    let processed = 0;
    const real = w.store.commit.bind(w.store);
    w.store.commit = async (...args: Parameters<typeof real>) => { processed += 1; return real(...args); };
    controller.abort();
    const result = await withLearningAttempt({ deadlineAt: Date.now() + 60_000, signal: controller.signal, attemptId: "a" }, () => learnFromEndedTaskTyped(w.deps, input));
    expect(result).toEqual({ status: "reflected", retry: false });
    expect(processed).toBe(0);
    expect(await w.store.list({ workspaceId: WS, project: PROJECT })).toEqual([]);
  });
});


describe("A lesson learned from a task also names the tasks behind the lessons loaded into it", () => {
  const loadedInto = async (w: ReturnType<typeof setup>) => {
    // L (from task P) was loaded into task-1 at its PLAN stage; the agent may have restated it in its plan.
    const loaded = lessonRecord({ id: "les_loaded001", provenance: { ...lessonRecord().provenance, supportTasks: ["task-p"] } });
    await w.store.commit({ workspaceId: WS, project: PROJECT }, await w.store.setVersion({ workspaceId: WS, project: PROJECT }), [loaded], 1);
    await w.store.putManifest({ taskId: "task-1", workspaceId: WS, project: PROJECT, stage: "PLAN", round: 0, setVersion: 1, memory: "live", at: 5, lessons: [{ id: "les_loaded001", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 });
  };
  it("the new draft carries the loaded lesson's source tasks as inheritedTasks (not as support), and not the task itself", async () => {
    const w = setup();
    await loadedInto(w);
    expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).toBe("reflected");
    const created = (await w.store.list({ workspaceId: WS, project: PROJECT })).find((l) => l.id !== "les_loaded001")!;
    expect(created.provenance.supportTasks).toEqual(["task-1"]);
    expect(created.provenance.inheritedTasks).toEqual(["task-p"]);
  });
  it("a task that had nothing loaded adds no field", async () => {
    const w = setup();
    await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" });
    expect((await w.store.list({ workspaceId: WS, project: PROJECT }))[0]!.provenance.inheritedTasks).toBeUndefined();
  });
  it("fails closed: load records that can't be read, or more inherited tasks than a lesson can name, reflect nothing and call no model", async () => {
    const down = setup();
    down.store.manifests = async () => { throw new Error("table down"); };
    expect(await learnFromEndedTask(down.deps, { workspaceId: WS, taskId: "task-1" })).toBe("not_reflected");
    expect(down.model.calls).toEqual([]);
    const many = setup();
    const key = { workspaceId: WS, project: PROJECT };
    const lessons = Array.from({ length: 3 }, (_, n) => lessonRecord({ id: `les_many0000${String(n)}`, provenance: { ...lessonRecord().provenance, supportTasks: Array.from({ length: 20 }, (_x, i) => `tp-${String(n)}-${String(i)}`) } }));
    await many.store.commit(key, await many.store.setVersion(key), lessons, 1);
    await many.store.putManifest({ taskId: "task-1", workspaceId: WS, project: PROJECT, stage: "PLAN", round: 0, setVersion: 1, memory: "live", at: 5, lessons: lessons.map((l) => ({ id: l.id, version: 1, score: 0.5, why: "scope" as const, citation: "valid" as const })), bytes: 10 });
    expect(await learnFromEndedTask(many.deps, { workspaceId: WS, taskId: "task-1" })).toBe("not_reflected");
    expect(many.model.calls).toEqual([]);
  });
  it("the load record keeps the lesson's tasks as they were at load time, so a lesson edited, scrubbed of its task refs or purged afterwards still passes them on", async () => {
    const store = new InMemoryLessonStore();
    const key = { workspaceId: WS, project: PROJECT };
    const scrubbed = lessonRecord({ id: "les_scrubbed01", provenance: { ...lessonRecord().provenance, supportTasks: [], sourceEvents: [] } });
    await store.commit(key, await store.setVersion(key), [scrubbed], 1);
    const manifest = { taskId: "task-1", workspaceId: WS, project: PROJECT, stage: "PLAN" as const, round: 0, setVersion: 1, memory: "live" as const, at: 1, bytes: 1 };
    await store.putManifest({ ...manifest, lessons: [{ id: "les_scrubbed01", version: 1, score: 0.5, why: "scope" as const, citation: "valid" as const, taskIds: ["task-p", "task-q"] }, { id: "les_purged0001", version: 1, score: 0.5, why: "scope" as const, citation: "valid" as const, taskIds: ["task-r", "task-1"] }] });
    expect((await inheritedTasksOf(store, key, "task-1")).sort()).toEqual(["task-p", "task-q", "task-r"]);
    // An older record without the field falls back to the lesson's current tasks (the behaviour).
    const old = new InMemoryLessonStore();
    await old.commit(key, await old.setVersion(key), [lessonRecord({ id: "les_loaded001", provenance: { ...lessonRecord().provenance, supportTasks: ["task-p"] } })], 1);
    await old.putManifest({ ...manifest, lessons: [{ id: "les_loaded001", version: 1, score: 0.5, why: "scope", citation: "valid" }] });
    expect(await inheritedTasksOf(old, key, "task-1")).toEqual(["task-p"]);
  });
  it("the nightly re-reflection of a reverted task goes through the same subject path, so its draft carries inheritedTasks too", async () => {
    const w = setup({ base: { facts: baseFacts({ outcome: "reverted" }), sendBackRequestIds: [] } });
    await loadedInto(w);
    w.rows.reverter = { actorDeveloperId: "reverter" };
    expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "reverted" })).toBe("reflected");
    const created = (await w.store.list({ workspaceId: WS, project: PROJECT })).find((l) => l.id !== "les_loaded001")!;
    expect(created.provenance.inheritedTasks).toEqual(["task-p"]);
    // The subject itself (what the nightly worker builds) names them.
    expect((await subjectForTask(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "reverted" }))?.inheritedTasks).toEqual(["task-p"]);
  });
  it("inheritedTasksOf follows each loaded lesson once, skips one that is gone, and throws on a lesson that names an unreadable task", async () => {
    const store = new InMemoryLessonStore();
    const key = { workspaceId: WS, project: PROJECT };
    const bad = lessonRecord({ id: "les_badtaskid1", provenance: { ...lessonRecord().provenance, supportTasks: ["bad id!"] } });
    await store.commit(key, await store.setVersion(key), [lessonRecord({ id: "les_loaded001", provenance: { ...lessonRecord().provenance, supportTasks: ["task-p", "task-1"] } }), bad], 1);
    const entry = (id: string) => ({ id, version: 1, score: 0.5, why: "scope" as const, citation: "valid" as const });
    const manifest = (stage: "PLAN" | "IMPLEMENT", ids: string[]) => ({ taskId: "task-1", workspaceId: WS, project: PROJECT, stage, round: 0, setVersion: 1, memory: "live" as const, at: stage === "PLAN" ? 1 : 2, lessons: ids.map(entry), bytes: 1 });
    await store.putManifest(manifest("PLAN", ["les_loaded001", "les_gone00001"]));
    await store.putManifest(manifest("IMPLEMENT", ["les_loaded001"]));
    expect(await inheritedTasksOf(store, key, "task-1")).toEqual(["task-p"]);
    await store.putManifest({ ...manifest("PLAN", ["les_badtaskid1"]), stage: "UNDERSTAND" });
    await expect(inheritedTasksOf(store, key, "task-1")).rejects.toThrow();
  });
});

describe("the task's end counts the loaded lessons' outcome, in the worker path", () => {
  const DAY = 86_400_000;
  const KEY = { workspaceId: WS, project: PROJECT };
  async function withCounters(over: Parameters<typeof setup>[0] = {}, lesson: Partial<Lesson> = {}) {
    const w = setup(over);
    const clock = new Clock();
    await seed(w.store, lessonRecord({ id: "les_used0001", ...lesson }));
    await w.store.putManifest({ taskId: "task-1", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_used0001", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 });
    const counters: CounterDeps = { store: w.store, judge: REFUSING_JUDGE, settings: w.deps.settings, audit: w.audit, now: clock.now };
    w.deps.counters = counters;
    const queued = async () => (await w.store.duePending(KEY, clock.now() + 30 * DAY, 100)).map((entry) => entry.key);
    return { ...w, counters, clock, queued };
  }
  it("a merged task with no send-back queues a helpful mark for every lesson that reached its prompt, with the current refusing judge", async () => {
    const w = await withCounters({ base: { facts: baseFacts(), sendBackRequestIds: [] } });
    expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "merged" })).toBe("reflected");
    expect(await w.queued()).toEqual(["helpful:task-1:les_used0001"]);
    // The mark is due after the 14-day revert window, not now.
    expect(await w.store.duePending(KEY, w.clock.now(), 100)).toEqual([]);
  });
  it("a human send-back is a correction in the lesson's scope that the refusing judge leaves unjudged: no helpful credit (a repository-wide lesson; a send-back names no file, so it is in scope for every lesson)", async () => {
    const w = await withCounters({}, { scope: { repos: ["api"] } });
    w.rows.sendBacks.set("req-1", { id: "task:task-1:sendback:req-1", origin: "human", actorDeveloperId: "sam", actorTrust: "member", reasonText: "use the shared helper" });
    expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "merged" })).toBe("reflected");
    expect(await w.queued()).toEqual([]);
    expect((await w.store.get(KEY, "les_used0001"))!.counters.harmful).toBe(0);
  });
  it("a closed task queues nothing; a reverted task takes back the mark an earlier merge queued", async () => {
    const closed = await withCounters({ base: { facts: baseFacts({ outcome: "closed" }), sendBackRequestIds: [] } });
    await learnFromEndedTask(closed.deps, { workspaceId: WS, taskId: "task-1", outcome: "closed" });
    expect(await closed.queued()).toEqual([]);
    const w = await withCounters({ base: { facts: baseFacts(), sendBackRequestIds: [] } });
    await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "merged" });
    expect(await w.queued()).toHaveLength(1);
    w.deps.reflect.model = new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]);
    // A revert counts only when a verified member reverted it (the person-link row names them).
    w.rows.reverter = { actorDeveloperId: "rev" };
    await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "reverted" });
    expect(await w.queued()).toEqual([]);
  });
  it("a project whose learning does not load lessons counts nothing; a counting fault is a fixed log line and the reflection still counts as made", async () => {
    const suggestOnly = await withCounters({ settings: settings({ mode: "Collect" }) });
    expect(await learnFromEndedTask(suggestOnly.deps, { workspaceId: WS, taskId: "task-1", outcome: "merged" })).toBe("off");
    expect(await suggestOnly.queued()).toEqual([]);
    const w = await withCounters({ base: { facts: baseFacts(), sendBackRequestIds: [] } });
    const logs: string[] = [];
    const fields: Array<Record<string, string | number>> = [];
    w.deps.log = (event, f) => { logs.push(event); fields.push(f); };
    w.deps.counters = { ...w.counters, store: Object.assign(Object.create(w.store) as InMemoryLessonStore, { manifests: async () => { throw new Error("secret table text"); } }) };
    expect(await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "merged" })).toEqual({ status: "reflected", retry: false });
    expect(logs).toContain("learning.outcome_failed");
    expect(JSON.stringify(logs)).not.toContain("secret");
    // The task only as a 12-hex hash, never the raw id.
    expect(Object.keys(fields[logs.indexOf("learning.outcome_failed")]!)).toEqual(["task"]);
    expect(String(fields[logs.indexOf("learning.outcome_failed")]!.task)).toMatch(/^[0-9a-f]{12}$/u);
    expect(JSON.stringify(fields)).not.toContain("task-1");
  });
  it("without counters nothing is counted (an install that has no lessons runtime)", async () => {
    const w = await withCounters({ base: { facts: baseFacts(), sendBackRequestIds: [] } });
    delete w.deps.counters;
    expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "merged" })).toBe("reflected");
    expect(await w.queued()).toEqual([]);
  });
});

describe("the outcome is counted on every path, before the reflection", () => {
  const DAY = 86_400_000;
  const KEY = { workspaceId: WS, project: PROJECT };
  const merged = { workspaceId: WS, taskId: "task-1", outcome: "merged" as const };
  const attempt = (signal: AbortSignal = new AbortController().signal): LearningAttempt => ({ deadlineAt: Date.now() + 60_000, signal, attemptId: "att-1" });
  async function counted(over: Parameters<typeof setup>[0] = {}) {
    const w = setup({ base: { facts: baseFacts(), sendBackRequestIds: [] }, ...over });
    const clock = new Clock();
    await seed(w.store, lessonRecord({ id: "les_used0001" }));
    await w.store.putManifest({ taskId: "task-1", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_used0001", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 });
    w.deps.counters = { store: w.store, judge: REFUSING_JUDGE, settings: w.deps.settings, audit: w.audit, now: clock.now };
    const queued = async () => (await w.store.duePending(KEY, clock.now() + 30 * DAY, 100)).map((entry) => entry.key);
    return { ...w, clock, queued };
  }
  const MARK = "helpful:task-1:les_used0001";
  /** Each way a reflection can end without drafts, as the model it is given. */
  const endings: Array<[string, (w: Awaited<ReturnType<typeof counted>>) => void, { status: string; retry: boolean }]> = [
    ["a model that failed and may pass (retryable)", (w) => { w.deps.reflect.model = { complete: async () => { noteLearningFault("retryable"); throw new Error("model down"); } }; }, { status: "not_reflected", retry: true }],
    ["a model that failed for good", (w) => { w.deps.reflect.model = { complete: async () => { noteLearningFault("final"); throw new Error("model down"); } }; }, { status: "not_reflected", retry: false }],
    ["a refusal that pauses learning", (w) => { w.deps.reflect.model = { complete: async () => { throw new LearningRefusal("no_provider", "learning has no usable AI provider for this project"); } }; }, { status: "not_reflected", retry: false }],
    ["an answer that does not parse", (w) => { w.deps.reflect.model = { complete: async () => ({ text: "not json", costUsd: 0.01, model: "m" }) }; }, { status: "not_reflected", retry: false }],
  ];

  for (const [name, arrange, expected] of endings) {
    it(`a merged task queues its helpful mark when the reflection ends in ${name}`, async () => {
      const w = await counted();
      arrange(w);
      expect(await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(w.deps, merged))).toEqual(expected);
      expect(await w.queued()).toEqual([MARK]);
    });
    it(`a revert re-reflection takes the merge's queued mark back when the reflection ends in ${name}`, async () => {
      const w = await counted();
      await learnFromEndedTask(w.deps, merged);
      expect(await w.queued()).toEqual([MARK]);
      arrange(w);
      w.rows.reverter = { actorDeveloperId: "rev" };
      expect(await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(w.deps, { ...merged, outcome: "reverted" }))).toEqual(expected);
      expect(await w.queued()).toEqual([]);
    });
  }
  it("an ineligible task (one an outsider started) is counted too: the reflector refuses it, the outcome still counts (the not-reflected path)", async () => {
    const withRest = baseFacts();
    const w = await counted({ base: { facts: { ...withRest, rest: { ...withRest.rest, initiatorTrust: "outsider" } }, sendBackRequestIds: [] } });
    const result = await learnFromEndedTaskTyped(w.deps, merged);
    expect(result.status).toBe("not_reflected");
    expect(w.model.calls).toEqual([]);
    expect(await w.queued()).toEqual([MARK]);
  });
  it("a deadline that cuts the reflection (the signal is aborted during the model call) does not lose the count", async () => {
    const w = await counted();
    const controller = new AbortController();
    w.deps.reflect.model = { complete: async () => { controller.abort(); noteLearningFault("retryable"); throw new Error("aborted"); } };
    await withLearningAttempt(attempt(controller.signal), () => learnFromEndedTaskTyped(w.deps, merged));
    expect(await w.queued()).toEqual([MARK]);
  });
  it("a project whose learning is Off still counts nothing, and an attempt retried after a counted one counts once (idempotent)", async () => {
    const off = await counted({ settings: settings({ mode: "Off" }) });
    expect(await learnFromEndedTask(off.deps, merged)).toBe("off");
    expect(await off.queued()).toEqual([]);
    const w = await counted();
    w.deps.reflect.model = { complete: async () => { noteLearningFault("retryable"); throw new Error("model down"); } };
    await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(w.deps, merged));
    await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(w.deps, merged));
    w.deps.reflect.model = new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]);
    expect(await learnFromEndedTask(w.deps, merged)).toBe("reflected");
    expect(await w.queued()).toEqual([MARK]);
    expect((await w.store.get(KEY, "les_used0001"))!.counters.helpful).toBe(0);
  });
  it("send-backs whose sender was erased (no row text) still count as corrections, by the task's own request list: a repository-wide lesson gets no helpful credit; with the rows readable and the lesson untouched it does", async () => {
    // The row of an erased sender is gone (the reader gives nothing), but the task's decision list still names the request.
    const erased = await counted({ base: { facts: baseFacts(), sendBackRequestIds: ["req-1"] } });
    expect(await learnFromEndedTask(erased.deps, merged)).toBe("reflected");
    expect(erased.rows.asked).toContain("sendback:req-1");
    expect(await erased.queued()).toEqual([]);
    // Positive control: no send-back, same lesson, the mark is queued.
    const none = await counted();
    await learnFromEndedTask(none.deps, merged);
    expect(await none.queued()).toEqual([MARK]);
    // Two erased send-backs are two corrections (sendBacks counts the list, not the rows that could be read).
    const two = await counted({ base: { facts: baseFacts(), sendBackRequestIds: ["req-1", "req-2"] } });
    await learnFromEndedTask(two.deps, merged);
    expect(await two.queued()).toEqual([]);
  });
});

/** A pause store that remembers its reasons and how many failures it was asked to count. */
class CountingPause implements LessonsPauseStore {
  count = 0;
  reasons: string[] = [];
  cleared = 0;
  async record(_w: string, _p: string, code: CurrentPause["code"]): Promise<void> { this.reasons.push(code); }
  async clear(): Promise<void> { this.cleared += 1; this.count = 0; }
  async failed(): Promise<number> { this.count += 1; return this.count; }
  async read(): Promise<CurrentPause | undefined> { return undefined; }
}

describe("A task's failed model calls count toward model_failed once, not once per call", () => {
  const bodies = [
    "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls",
    "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper",
    "Use withRetry from src/retry/index.ts for HTTP retries in the api service gateway calls",
    "Use withRetry from src/retry/index.ts for HTTP retries in the api service batch calls",
  ];
  const fourDrafts = () => reply(...bodies.map((body) => candidateJson({ title: "Retries", description: "", body, type: "fact", evidenceSpanIds: ["S1"] })));
  const failingJudge = () => { const calls: string[] = []; return { calls, complete: async () => { calls.push("judge"); throw new Error("provider down"); } }; };
  // Review: the curator's judge calls hold from the task's one Public cap, so the reflection must hold a price (0.01) that leaves them room; a model that cannot quote holds the whole cap.
  const cheaply = (model: ScriptedModel): ScriptedModel => Object.assign(model, { quote: async () => ({ ok: true as const, usd: 0.01 }) });

  it("a task with four similar drafts makes several failing judge calls and counts ONE failure, so one short outage does not pause the project", async () => {
    const w = setup({ model: cheaply(new ScriptedModel([fourDrafts()])) });
    const pause = new CountingPause();
    const judge = failingJudge();
    w.deps.process = { ...w.deps.process, judgeModel: judge, pause };
    w.deps.reflect = { ...w.deps.reflect, pause };
    expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).toBe("reflected");
    // Positive control: the judge was called at least MODEL_FAILURES_BEFORE_PAUSE times in this one task, so per-call counting would have paused the project.
    expect(judge.calls.length).toBeGreaterThanOrEqual(MODEL_FAILURES_BEFORE_PAUSE);
    expect(pause.count).toBe(1);
    expect(pause.reasons).not.toContain("model_failed");
  });

  it("the handle counts the first failure only, and a success (clear) starts the count again", async () => {
    const inner = new CountingPause();
    const tally = newTaskFailureTally();
    const pause = failuresCountedOncePerTask(inner, tally)!;
    for (let call = 0; call < 5; call += 1) await noteModelFailure(pause, WS, PROJECT);
    expect(inner.count).toBe(1);
    await pause.clear(WS, PROJECT);
    await noteModelFailure(pause, WS, PROJECT);
    expect(inner.count).toBe(1);
    expect(inner.cleared).toBe(1);
    // A store with no counter is returned as it is.
    expect(failuresCountedOncePerTask(undefined, tally)).toBeUndefined();
  });
});

/** A pause store that keeps the reflector's and the judge's failures in a row apart, as the real one does. */
class KindPause implements LessonsPauseStore {
  counts = { reflect: 0, judge: 0 };
  current: CurrentPause["code"] | undefined;
  async record(_w: string, _p: string, code: CurrentPause["code"]): Promise<void> { this.current = code; }
  async clear(_w?: string, _p?: string, _only?: "project" | "company", ifCode?: CurrentPause["code"]): Promise<void> { if (ifCode !== undefined && this.current !== ifCode) return; this.current = undefined; this.counts.reflect = 0; }
  async clearJudgeFailures(): Promise<void> { this.counts.judge = 0; }
  async failed(_w: string, _p: string, kind: "reflect" | "judge" = "reflect"): Promise<number> { this.counts[kind] += 1; return this.counts[kind]; }
  async read(): Promise<CurrentPause | undefined> { return this.current === undefined ? undefined : { code: this.current, at: 1, scope: "project" }; }
}

describe("a judge that always fails still pauses the project, one task at a time", () => {
  const bodies = [
    "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls",
    "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper",
    "Use withRetry from src/retry/index.ts for HTTP retries in the api service gateway calls",
  ];
  const threeDrafts = () => reply(...bodies.map((body) => candidateJson({ title: "Retries", description: "", body, type: "fact", evidenceSpanIds: ["S1"] })));
  const runTask = async (pause: KindPause) => {
    const w = setup({ model: Object.assign(new ScriptedModel([threeDrafts()]), { quote: async () => ({ ok: true as const, usd: 0.01 }) }) });
    w.deps.process = { ...w.deps.process, judgeModel: { complete: async () => { throw new Error("provider down"); } }, pause };
    w.deps.reflect = { ...w.deps.reflect, pause };
    await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" });
  };

  it("each task counts the judge's failures once (the reflection that succeeded in between does not clear them), so three tasks in a row pause the project", async () => {
    const pause = new KindPause();
    await runTask(pause);
    expect(pause.counts.judge).toBe(1);
    await runTask(pause);
    expect(pause.counts.judge).toBe(2);
    expect(pause.current).toBeUndefined();
    await runTask(pause);
    expect(pause.counts.judge).toBe(MODEL_FAILURES_BEFORE_PAUSE);
    expect(pause.current).toBe("model_failed");
  });

  it("a judge that answers starts its count again", async () => {
    const pause = new KindPause();
    await runTask(pause);
    await runTask(pause);
    await pause.clearJudgeFailures();
    await runTask(pause);
    expect(pause.counts.judge).toBe(1);
    expect(pause.current).toBeUndefined();
  });

  it("a conditional clear that did nothing does not reopen the task's count", async () => {
    const inner = new KindPause();
    const handle = failuresCountedOncePerTask(inner, newTaskFailureTally())!;
    await noteModelFailure(handle, WS, PROJECT, "reflect");
    // No reason is in force, so the conditional clear changes nothing, and a second failure of the same task is still not counted.
    await handle.clear(WS, PROJECT, "project", "model_failed");
    await noteModelFailure(handle, WS, PROJECT, "reflect");
    expect(inner.counts.reflect).toBe(1);
    await noteModelFailure(handle, WS, PROJECT, "judge");
    await noteModelFailure(handle, WS, PROJECT, "judge");
    expect(inner.counts.judge).toBe(1);
  });
});
