// Lead 4 L4-LP3Wc: Pause on "Where Rovara learns from" is a STOP (owner 2026-11-18). While a kind of evidence is paused Rovara does not read it at all: nothing is gathered, nothing is stored, no model is called for it. Resuming starts again
// from that moment: nothing from the paused time comes back and nothing is re-settled. These tests count model calls, judge calls, rows read and lessons stored on every capture path that gathers spans, with two companies and other sources unaffected.
import { describe, expect, it } from "vitest";
import { LEARNING_SOURCE_KEYS } from "../../../packages/contracts/src/index.js";
import type { CounterDeps } from "../../../packages/broker/src/lessons/counters.js";
import { curateDraft } from "../../../packages/broker/src/lessons/curate.js";
import { createHumanEditExtractor, type HumanEditExtractorDeps } from "../../../packages/broker/src/lessons/human-edit.js";
import type { HumanEditInput } from "../../../packages/broker/src/lessons/capture-types.js";
import { setLearningSourcePause, SOURCE_KINDS } from "../../../packages/broker/src/lessons/learning-sources.js";
import { ALL_PAUSABLE_KINDS, pausedKindsFor, pausedKindsOfFlags } from "../../../packages/broker/src/lessons/paused-kinds.js";
import { newTaskFailureTally } from "../../../packages/broker/src/lessons/pause.js";
import { processDraft, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import type { CorrectionJudge, CorrectionRating } from "../../../packages/broker/src/lessons/ports.js";
import { reflectSubject } from "../../../packages/broker/src/lessons/reflect.js";
import type { EvidenceSpan } from "../../../packages/broker/src/lessons/reflect-input.js";
import { reflectRepoOnly, type PlacedChangeRequest } from "../../../packages/broker/src/lessons/repo-reflect.js";
import { heldKeysOf } from "../../../packages/broker/src/lessons/sources.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { learnFromEndedTask, learnFromEndedTaskTyped, type TaskLearningDeps, type TaskSubjectBase } from "../../../packages/broker/src/lessons/task-end.js";
import type { OutcomeRowReader } from "../../../packages/broker/src/lessons/task-outcome-rows.js";
import type { SendBackFact } from "../../../packages/broker/src/lessons/task-subject.js";
import { Alerts, Audit, BASE, Clock, KEY, MERGED, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, autoSettings, candidateJson, embedder, facts, lessonRecord, memberSpan, reply, seed, settings, subject, uniqueDraft, verifier } from "../lessons/lesson-helpers.js";

const WS2 = "org_bbbbbbbbbbbbbbbbbbbb";
const KEY2 = { workspaceId: WS2, project: PROJECT };
const DAY = 86_400_000;
const LINK = "https://github.com/acme/api/pull/7";
const PLACE = "github:repo/1001";

class Rows implements OutcomeRowReader {
  asked: string[] = [];
  sendBacks = new Map<string, SendBackFact>();
  async sendBack(input: { requestId: string }): Promise<SendBackFact | undefined> { this.asked.push(`sendback:${input.requestId}`); return this.sendBacks.get(input.requestId); }
  async revertedBy(): Promise<{ actorDeveloperId?: string } | undefined> { this.asked.push("reverted_by"); return undefined; }
}
class RecordingJudge implements CorrectionJudge {
  asked: string[] = [];
  constructor(public answer: CorrectionRating = "unrelated") {}
  async usable(): Promise<boolean> { return true; }
  async rate(input: Parameters<CorrectionJudge["rate"]>[0]): Promise<CorrectionRating> { this.asked.push(input.correctionText); return this.answer; }
}
const span = (kind: EvidenceSpan["kind"], text: string, over: Partial<EvidenceSpan> = {}): EvidenceSpan => ({ kind, text, trust: "member", authorId: "rev", eventId: `ev-${kind}-${text.length}`, ...over });
const baseOf = (spans: EvidenceSpan[], ids: string[] = []): TaskSubjectBase => ({
  facts: {
    workspaceId: WS, project: PROJECT, taskId: "task-1", repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged", task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } },
    rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", links: [LINK], spans },
  },
  sendBackRequestIds: ids,
});

/** The task-end world: the source gives whatever `current.base` is and records what it was asked to skip. */
async function world(over: { judge?: CorrectionJudge; withLoadedLesson?: boolean } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const configured = settings({ mode: "On" });
  const model = Object.assign(new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]), { quote: async () => ({ ok: true as const, usd: 0.02 }) });
  if (over.withLoadedLesson === true) {
    await seed(store, lessonRecord({ id: "les_used0001" }));
    await store.putManifest({ taskId: "task-1", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_used0001", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 });
  }
  const rows = new Rows();
  const state: { base: TaskSubjectBase; reads: Array<{ skip: string[] }> } = { base: baseOf([]), reads: [] };
  const process: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now, verifier: verifier("valid"), facts: facts(), settings: configured,
    newId: (() => { let n = 0; return () => `les_${String(++n).padStart(4, "0")}`; })(),
  };
  const counters: CounterDeps | undefined = over.judge === undefined ? undefined : { store, judge: over.judge, settings: configured, audit, now: clock.now };
  const deps: TaskLearningDeps = {
    source: { projectOf: async () => PROJECT, read: async (input) => { state.reads.push({ skip: [...(input.skip ?? [])].sort() }); return state.base; } }, rows, settings: configured, ...(counters === undefined ? {} : { counters }),
    reflect: { model, spend: new Spend(), audit, settings: configured, edition: "public", now: clock.now }, process,
  };
  const pause = (key: (typeof LEARNING_SOURCE_KEYS)[number], paused: boolean, where = KEY) => setLearningSourcePause({ store, audit, now: clock.now }, where, "owner", key, paused);
  const queued = async () => (await store.duePending(KEY, clock.now() + 30 * DAY, 100)).map((entry) => entry.key);
  return { deps, store, rows, model, audit, state, pause, clock, queued };
}
const merged = { workspaceId: WS, taskId: "task-1", outcome: "merged" as const };
const stored = async (store: InMemoryLessonStore, key = KEY) => store.list(key);

describe("the kinds a pause stops", () => {
  it("a person's pause names exactly the kinds of its row, and a flood-guard hold on a `kind:` source is not a stop", () => {
    for (const key of LEARNING_SOURCE_KEYS) expect([...pausedKindsOfFlags({ pausedSources: Object.fromEntries(SOURCE_KINDS[key].map((kind) => [`kind:${kind}`, { at: 1, reason: "person" }])) })].sort()).toEqual([...SOURCE_KINDS[key]].sort());
    expect(pausedKindsOfFlags({ pausedSources: { "kind:send_back": { at: 1, reason: "spike" }, "member:ann": { at: 1, reason: "person" }, "kind:nonsense": { at: 1, reason: "person" } } }).size).toBe(0);
  });
  it("an unreadable store means every kind is paused (fail closed)", async () => {
    expect(await pausedKindsFor({ flags: async () => { throw new Error("down"); } }, KEY)).toBe(ALL_PAUSABLE_KINDS);
  });
  it("a `kind:` pause is no longer a hold: a lesson is held only under its sources", () => {
    expect(heldKeysOf({ sources: ["member:ann"], inputSources: ["member:ann", "slack:C1"] }).sort()).toEqual(["member:ann", "slack:C1"]);
  });
});

describe("task end: a paused source is not read, stored or paid for", () => {
  it("paused decisions in tasks: no send-back row read, the source told to skip them, no model call, no lesson", async () => {
    const w = await world();
    w.state.base = baseOf([span("send_back", "PAUSED-WORDS use the helper", { eventId: "ev-sb" }), span("close_reason", "PAUSED-WORDS closing")], ["req-1"]);
    w.rows.sendBacks.set("req-1", { id: "task:task-1:sendback:req-1", origin: "human", actorDeveloperId: "sam", actorTrust: "member", reasonText: "PAUSED-WORDS use the helper" });
    await w.pause("task_decisions", true);
    expect(await learnFromEndedTask(w.deps, merged)).toBe("not_reflected");
    expect(w.model.calls).toHaveLength(0);
    expect(w.rows.asked).toEqual([]);
    expect(await stored(w.store)).toEqual([]);
    expect(w.state.reads.at(-1)!.skip).toEqual(["close_reason", "send_back"]);
  });

  it("resume: only new spans are read; the paused window never comes back and nothing is re-settled", async () => {
    const w = await world();
    w.state.base = baseOf([span("send_back", "PAUSED-WORDS use the helper")]);
    await w.pause("task_decisions", true);
    await learnFromEndedTask(w.deps, merged);
    const auditBefore = w.audit.events.length;
    expect(await w.pause("task_decisions", false)).toEqual({ ok: true, paused: false, changed: true });
    // Resuming wrote the person's action and nothing else: no settle, no lesson event.
    expect(w.audit.events.slice(auditBefore).map((e) => e.action)).toEqual(["lesson.learning_source_switched"]);
    expect(await stored(w.store)).toEqual([]);
    w.state.base = baseOf([span("send_back", "NEW-WORDS call withRetry", { eventId: "ev-new" })]);
    expect(await learnFromEndedTask(w.deps, merged)).toBe("reflected");
    expect(w.model.calls).toHaveLength(1);
    expect(String(w.model.calls[0]!.user)).toContain("NEW-WORDS");
    expect(JSON.stringify(w.model.calls)).not.toContain("PAUSED-WORDS");
    expect(JSON.stringify(await stored(w.store))).not.toContain("PAUSED-WORDS");
    expect(w.state.reads.at(-1)!.skip).toEqual([]);
  });

  it("other sources are unaffected: pausing edits leaves a send-back reflected as before", async () => {
    const w = await world();
    w.state.base = baseOf([span("send_back", "use withRetry for retries")]);
    await w.pause("pr_edits", true);
    expect(await learnFromEndedTask(w.deps, merged)).toBe("reflected");
    expect(w.model.calls).toHaveLength(1);
    expect(await stored(w.store)).toHaveLength(1);
  });

  it("a paused kind left in what the source gave (an old or careless source) is removed before the model: the reflection reads only the rest", async () => {
    const w = await world();
    w.state.base = baseOf([span("send_back", "use withRetry for retries", { eventId: "ev-sb" }), span("pr_comment", "PAUSED-COMMENT words", { eventId: "ev-pc" })]);
    await w.pause("review_comments", true);
    await learnFromEndedTask(w.deps, merged);
    expect(String(w.model.calls[0]!.user)).not.toContain("PAUSED-COMMENT");
    expect(String(w.model.calls[0]!.user)).toContain("kind=send_back");
  });

  it("two companies: a pause in one company's project stops nothing in the other's, and a pause in the other's stops nothing here", async () => {
    const w = await world();
    w.state.base = baseOf([span("send_back", "use withRetry for retries")]);
    await w.pause("task_decisions", true, KEY2);
    expect([...(await pausedKindsFor(w.store, KEY))]).toEqual([]);
    expect(await learnFromEndedTask(w.deps, merged)).toBe("reflected");
    expect(await stored(w.store, KEY2)).toEqual([]);
    expect([...(await pausedKindsFor(w.store, KEY2))].sort()).toEqual(["close_reason", "send_back"]);
  });

  it("a flags store that cannot be read stops the reading (fail closed): no model call", async () => {
    const w = await world();
    w.state.base = baseOf([span("send_back", "use withRetry for retries")]);
    w.store.flags = async () => { throw new Error("down"); };
    expect(await learnFromEndedTask(w.deps, merged)).toBe("not_reflected");
    expect(w.model.calls).toHaveLength(0);
  });
});

describe("outcome counting: a paused source is not judged or counted", () => {
  it("paused review comments: the comment is never sent to the judge; a remembered note (another source) still is", async () => {
    const judge = new RecordingJudge();
    const w = await world({ judge, withLoadedLesson: true });
    w.state.base = baseOf([span("pr_comment", "You should use the shared helper", { paths: ["src/a.ts"] }), span("remembered", "always use the shared helper")]);
    await w.pause("review_comments", true);
    await learnFromEndedTask(w.deps, merged);
    expect(judge.asked).toEqual(["always use the shared helper"]);
  });
  it("paused decisions: no send-back is counted or judged", async () => {
    const judge = new RecordingJudge();
    const w = await world({ judge, withLoadedLesson: true });
    w.state.base = baseOf([span("send_back", "Use the shared helper please")], ["req-1"]);
    w.rows.sendBacks.set("req-1", { id: "task:task-1:sendback:req-1", origin: "human", actorDeveloperId: "sam", actorTrust: "member", reasonText: "Use the shared helper please" });
    await w.pause("task_decisions", true);
    await learnFromEndedTask(w.deps, merged);
    expect(judge.asked).toEqual([]);
    expect(w.rows.asked).toEqual([]);
  });
  it("paused after-merge: no helpful mark is queued and no revert row is read; resumed, the next merge queues its mark as before", async () => {
    const judge = new RecordingJudge();
    const w = await world({ judge, withLoadedLesson: true });
    // A merge with nothing to rate: its mark is the only count (a rated correction is counted once per task, whatever the pause).
    w.state.base = baseOf([span("intent", "Make retries use the helper", { authorId: "creator" })]);
    await w.pause("after_merge", true);
    await learnFromEndedTask(w.deps, merged);
    expect(await w.queued()).toEqual([]);
    expect(await learnFromEndedTaskTyped(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "reverted" })).toMatchObject({ status: expect.any(String) });
    expect(w.rows.asked).not.toContain("reverted_by");
    await w.pause("after_merge", false);
    await learnFromEndedTask(w.deps, merged);
    expect(await w.queued()).toEqual(["helpful:task-1:les_used0001"]);
  });
});

describe("the human-edit extractor", () => {
  const input = (): HumanEditInput => ({
    workspaceId: WS, project: PROJECT, repo: "acme/api", taskId: "task-1", pullRequest: { number: 7, url: LINK }, trust: "member", authorCount: 1, authors: ["rae"],
    files: [{ path: "src/fetch.ts", additions: 1, deletions: 1, symbols: [], hunks: ["@@ -1 +1 @@", "-a", "+await withRetry(() => fetch())"] }], link: LINK, audience: { kind: "project" }, scope: PLACE,
  });
  function editWorld() {
    const store = new InMemoryLessonStore();
    const audit = new Audit();
    const clock = new Clock();
    const configured = settings({ mode: "On" });
    const model = new ScriptedModel([reply(candidateJson({ type: "convention", evidenceSpanIds: ["S1"], citations: [{ kind: "pr", url: LINK }] }))]);
    const process: ProcessDeps = { store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now, verifier: verifier("valid"), facts: facts(), settings: configured, newId: () => "les_0001" };
    const calls = { read: 0, erased: 0, standing: 0 };
    const deps: HumanEditExtractorDeps = {
      source: { read: async () => { calls.read += 1; return baseOf([span("intent", "Make retries use the helper", { authorId: "creator" })]); } }, settings: configured,
      reflect: { model, spend: new Spend(), audit, settings: configured, edition: "public", now: clock.now, newId: () => "run-1" }, process,
      standing: async () => { calls.standing += 1; return "member"; }, isErased: async () => { calls.erased += 1; return false; },
    };
    return { extractor: createHumanEditExtractor(deps), store, model, calls, pause: (paused: boolean) => setLearningSourcePause({ store, audit, now: clock.now }, KEY, "owner", "pr_edits", paused) };
  }
  it("paused edits: the lines are not read, no author is looked up, no model is called, nothing is stored; resumed, the next edit is learned", async () => {
    const w = editWorld();
    await w.pause(true);
    expect(await w.extractor.extract(input())).toEqual({ candidates: 0 });
    expect(w.calls).toEqual({ read: 0, erased: 0, standing: 0 });
    expect(w.model.calls).toHaveLength(0);
    expect(await stored(w.store)).toEqual([]);
    await w.pause(false);
    expect(await w.extractor.extract(input())).toEqual({ candidates: 1 });
    expect(w.model.calls).toHaveLength(1);
  });
});

describe("the repository-only reflection of a merged pull request", () => {
  const comment = (text: string) => memberSpan(text, { kind: "pr_comment", eventId: "acme/api#pr7:review_comment11", authorId: "rae", scopes: [PLACE], audience: { kind: "project" }, paths: ["src/a.ts"] });
  const change = (): PlacedChangeRequest => ({ place: PLACE, repository: "api", repositoryUrl: "https://github.com/acme/api", link: LINK, linkPrefix: "https://github.com/acme/api/pull/", revision: "9".repeat(40), mergeRevision: MERGED, merged: true, audience: { kind: "project" }, comments: [comment("Use withRetry for HTTP retries in api, not a hand-rolled loop.")], edits: [] }) as PlacedChangeRequest;
  async function run(pausedRow?: (typeof LEARNING_SOURCE_KEYS)[number]) {
    const store = new InMemoryLessonStore();
    const audit = new Audit();
    const clock = new Clock();
    const configured = settings({ mode: "On" });
    const model = Object.assign(new ScriptedModel([reply(candidateJson({ type: "convention", evidenceSpanIds: ["S1"], citations: [{ kind: "pr", url: LINK }] }))]), { quote: async () => ({ ok: true as const, usd: 0.01 }) });
    const process: ProcessDeps = { store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now, verifier: verifier("valid"), facts: facts(), settings: configured, newId: () => "les_0001" };
    if (pausedRow !== undefined) await setLearningSourcePause({ store, audit, now: clock.now }, KEY, "owner", pausedRow, true);
    const result = await reflectRepoOnly({ reflect: { model, spend: new Spend(), audit, settings: configured, edition: "enterprise", now: clock.now }, process, settings: configured }, subject([]), [change()], newTaskFailureTally());
    return { result, model, store };
  }
  it("paused review comments: no call, nothing stored; unpaused or another row paused: one call as before", async () => {
    const stopped = await run("review_comments");
    expect(stopped.result).toMatchObject({ calls: 0 });
    expect(stopped.model.calls).toHaveLength(0);
    expect(await stored(stopped.store)).toEqual([]);
    expect((await run()).result).toMatchObject({ calls: 1 });
    expect((await run("pr_edits")).result).toMatchObject({ calls: 1 });
  });
});

describe("the last lines: the reflector and the store", () => {
  it("reflectSubject leaves out a paused kind even for a path that forgot to (the nightly work source): no usable evidence, no model call", async () => {
    const model = new ScriptedModel([reply(candidateJson({ evidenceSpanIds: ["S1"] }))]);
    const configured = settings({ mode: "On" });
    const deps = { model, spend: new Spend(), audit: new Audit(), settings: configured, edition: "public" as const, now: new Clock().now, pausedKinds: async () => new Set(["pr_comment" as const]) };
    const result = await reflectSubject(deps, subject([memberSpan("a reviewer said use withRetry", { kind: "pr_comment" })]));
    expect(result).toMatchObject({ status: "ineligible", reason: "no_usable_evidence" });
    expect(model.calls).toHaveLength(0);
    const open = await reflectSubject({ ...deps, pausedKinds: async () => new Set() }, subject([memberSpan("a reviewer said use withRetry", { kind: "pr_comment" })]));
    expect(open.status).toBe("ok");
  });

  function curateWorld() {
    const store = new InMemoryLessonStore();
    const judge = new ScriptedModel();
    const audit = new Audit();
    const clock = new Clock();
    const deps: ProcessDeps = { store, embedder, vectors: new MemoryVectors(), judgeModel: judge, spend: new Spend(), audit, alerts: new Alerts(), now: clock.now, verifier: verifier("valid"), coldStartLessons: 0, facts: facts(), settings: autoSettings(), newId: (() => { let n = 0; return () => `les_${String(++n).padStart(4, "0")}`; })() };
    return { deps, store, judge, audit, pause: (key: (typeof LEARNING_SOURCE_KEYS)[number], paused: boolean, where = KEY) => setLearningSourcePause({ store, audit, now: clock.now }, where, "owner", key, paused) };
  }
  const kinded = (i: number, kinds: Array<"send_back" | "human_edit">) => uniqueDraft(i, { sources: ["member:ann"], inputSources: ["member:ann"], authors: [], memberSignal: false, sourceKinds: kinds, measured: true });

  it("a draft that rests on a paused kind (a reflection in flight when Pause was pressed) is dropped: not stored, not counted against any source, no judge call", async () => {
    const w = curateWorld();
    await w.pause("task_decisions", true);
    expect(await curateDraft(w.deps, KEY, kinded(1, ["send_back"]))).toEqual({ outcome: "dropped", reason: "source_paused" });
    expect(await processDraft(w.deps, KEY, kinded(2, ["send_back", "human_edit"]))).toEqual({ outcome: { outcome: "dropped", reason: "source_paused" } });
    expect(await stored(w.store)).toEqual([]);
    expect(w.judge.calls).toHaveLength(0);
    expect(await w.store.sourceDays(KEY, "member:ann", 3, w.deps.now())).toEqual([0, 0, 0]);
    // Another kind goes on as before, and so does the same draft in the other company.
    expect((await processDraft(w.deps, KEY, kinded(3, ["human_edit"]))).lesson!.status).toBe("active");
    expect((await processDraft(w.deps, KEY2, kinded(4, ["send_back"]))).lesson!.status).toBe("active");
  });

  it("resuming brings nothing back and settles nothing: a candidate an old hold left is not touched (left un-queued), and a spike hold on a member is not lifted", async () => {
    const w = curateWorld();
    // What the old Pause (a hold) could have left in a store: a candidate resting on a paused kind, held and reviewRequired, with the pause key in the flags.
    const old = lessonRecord({ id: "les_old00001", status: "candidate", reviewRequired: true });
    await seed(w.store, old);
    await w.store.setFlags(KEY, { pausedSources: { "kind:send_back": { at: 1, reason: "person" }, "kind:close_reason": { at: 1, reason: "person" }, "member:ann": { at: 1, reason: "spike" } } });
    expect(await w.pause("task_decisions", false)).toEqual({ ok: true, paused: false, changed: true });
    expect(Object.keys((await w.store.flags(KEY)).pausedSources ?? {})).toEqual(["member:ann"]);
    const after = await w.store.get(KEY, "les_old00001");
    expect(after).toMatchObject({ status: "candidate", reviewRequired: true, version: old.version });
    expect(w.judge.calls).toHaveLength(0);
    expect(w.audit.events.map((e) => e.action)).toEqual(["lesson.learning_source_switched"]);
  });
});
