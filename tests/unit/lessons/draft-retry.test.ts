// A draft whose curate-and-settle step failed on a passing store fault (before any model call) is tried once more inside the worker's deadline; it is NEVER tried again once the step started a model call
// (the customer pays for each call, so a retry must not double-charge), after a fault that is not a passing one, or when the deadline is near or past.
import { describe, expect, it } from "vitest";
import { DRAFT_RETRY_MIN_LEFT_MS, processDraftRetrying } from "../../../packages/lessons/src/draft-retry.js";
import { logRef } from "../../../packages/lessons/src/log-ref.js";
import { withLearningAttempt } from "../../../packages/lessons/src/learning-deadline.js";
import { InMemoryLessonStore } from "../../../packages/lessons/src/store.js";
import type { ProcessDeps } from "../../../packages/lessons/src/process.js";
import type { LessonDraft } from "../../../packages/lessons/src/reflect.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, allowAllAccess, closeEmbedder, directory, draft, embedder, facts, lessonRecord, settings, verifier } from "./lesson-helpers.js";

const throttled = (): Error => Object.assign(new Error("secret table text"), { name: "ThrottlingException" });
const text = (title: string, body: string): LessonDraft => draft({ title, description: "", body });
const A = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
const REWORDED = "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts";
const one = (verdict: string): string => JSON.stringify({ verdicts: [{ n: 1, verdict }] });

function setup(model: ScriptedModel = new ScriptedModel()) {
  const store = new InMemoryLessonStore();
  const clock = new Clock();
  let n = 0;
  const deps: ProcessDeps = {
    store, embedder: closeEmbedder, vectors: new MemoryVectors(), judgeModel: model, spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: clock.now,
    verifier: verifier("valid"), facts: facts(), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}`,
  };
  /** Makes the next `times` commits fail with `error` before anything is written. */
  const failCommits = (error: Error, times: number): { attempts: () => number } => {
    const real = store.commit.bind(store);
    let failures = 0, attempts = 0;
    store.commit = async (...args: Parameters<typeof real>) => { attempts += 1; if (failures < times) { failures += 1; throw error; } return real(...args); };
    return { attempts: () => attempts };
  };
  return { deps, store, failCommits };
}
const noWait = { sleep: async () => undefined };
const logsOf = () => { const lines: Array<[string, Record<string, string | number>]> = []; return { lines, log: (event: string, fields: Record<string, string | number>) => { lines.push([event, fields]); } }; };

describe("processDraftRetrying", () => {
  it("tries once more after a passing store fault before any model call: the draft lands once, no model call is made, and one fixed line says it was retried", async () => {
    const w = setup();
    const commits = w.failCommits(throttled(), 1);
    const logs = logsOf();
    const result = await processDraftRetrying(w.deps, KEY, text("Retries", A), { ...noWait, log: logs.log });
    expect(result.outcome.outcome).toBe("added");
    // the failed try, then the add and the settle's own commit
    expect(commits.attempts()).toBe(3);
    expect(await w.store.list(KEY)).toHaveLength(1);
    expect((w.deps.judgeModel as ScriptedModel).calls).toHaveLength(0);
    expect(logs.lines).toEqual([["learning.draft_retried", {}]]);
    expect(JSON.stringify(logs.lines)).not.toContain("secret");
  });

  it("only once: a second passing fault is the caller's (the draft is lost as before), after exactly two tries", async () => {
    const w = setup();
    const commits = w.failCommits(throttled(), 5);
    await expect(processDraftRetrying(w.deps, KEY, text("Retries", A), noWait)).rejects.toMatchObject({ name: "ThrottlingException" });
    expect(commits.attempts()).toBe(2);
  });

  it("NEVER after a model call started: a passing fault after the judge was called is not retried, so the judge is not called (and paid for) twice", async () => {
    const model = new ScriptedModel([one("different"), one("different")]);
    const w = setup(model);
    await processDraftRetrying(w.deps, KEY, text("Retries", A), noWait);
    const commits = w.failCommits(throttled(), 1);
    await expect(processDraftRetrying(w.deps, KEY, text("Wrapped", REWORDED), noWait)).rejects.toMatchObject({ name: "ThrottlingException" });
    expect(model.calls).toHaveLength(1);
    expect(commits.attempts()).toBe(1);
  });

  it("a call that failed on its own counts as started too: the judge refusing or throwing is a call that may have been made", async () => {
    const model = new ScriptedModel([new Error("provider down")]);
    const w = setup(model);
    await processDraftRetrying(w.deps, KEY, text("Retries", A), noWait);
    const commits = w.failCommits(throttled(), 1);
    await expect(processDraftRetrying(w.deps, KEY, text("Wrapped", REWORDED), noWait)).rejects.toMatchObject({ name: "ThrottlingException" });
    expect(model.calls).toHaveLength(1);
    expect(commits.attempts()).toBe(1);
  });

  it("a fault that is not a passing one is final, with no second try (a validation fault, a refused write, a bug)", async () => {
    for (const error of [new Error("table text"), Object.assign(new Error("x"), { name: "ValidationException" }), Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" })]) {
      const w = setup();
      const commits = w.failCommits(error, 1);
      await expect(processDraftRetrying(w.deps, KEY, text("Retries", A), noWait)).rejects.toBe(error);
      expect(commits.attempts()).toBe(1);
    }
  });

  it("a server-side status (5xx) counts as a passing fault", async () => {
    const w = setup();
    const commits = w.failCommits(Object.assign(new Error("x"), { name: "SomethingElse", $metadata: { httpStatusCode: 503 } }), 1);
    expect((await processDraftRetrying(w.deps, KEY, text("Retries", A), noWait)).outcome.outcome).toBe("added");
    expect(commits.attempts()).toBe(3);
  });

  it("inside a worker attempt: not at the deadline (the signal is aborted) and not when less than the minimum is left; with enough time it is retried", async () => {
    const aborted = new AbortController();
    aborted.abort();
    for (const attempt of [{ deadlineAt: Date.now() + 60_000, signal: aborted.signal }, { deadlineAt: Date.now() + DRAFT_RETRY_MIN_LEFT_MS - 1_000 }]) {
      const w = setup();
      const commits = w.failCommits(throttled(), 1);
      await withLearningAttempt(attempt, async () => { await expect(processDraftRetrying(w.deps, KEY, text("Retries", A), noWait)).rejects.toMatchObject({ name: "ThrottlingException" }); });
      expect(commits.attempts()).toBe(1);
    }
    const w = setup();
    const commits = w.failCommits(throttled(), 1);
    await withLearningAttempt({ deadlineAt: Date.now() + 60_000, signal: new AbortController().signal }, async () => { expect((await processDraftRetrying(w.deps, KEY, text("Retries", A), noWait)).outcome.outcome).toBe("added"); });
    expect(commits.attempts()).toBe(3);
  });

  it("the wrapper hands the real judge model through untouched (the retry guard counts calls, it does not change them)", async () => {
    const model = new ScriptedModel([one("different")]);
    const w = setup(model);
    await processDraftRetrying(w.deps, KEY, text("Retries", A), noWait);
    const second = await processDraftRetrying(w.deps, KEY, text("Wrapped", REWORDED), noWait);
    expect(second.outcome.outcome).toBe("added");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]).toMatchObject({ purpose: "judge" });
  });
});

describe("Side effects: a retry does not repeat what the failed try already did", () => {
  const STANDARD = settings({ preset: "standard" });
  /** A member's own correction, which goes live on trial with no approval (trial.test.ts). */
  const memberDraft = (): LessonDraft => draft({ provenance: { ...draft().provenance, sourceKinds: ["send_back"], memberCorrection: true, claimsSupported: true, fromSharedTask: true } });
  function trialSetup() {
    const store = new InMemoryLessonStore();
    const audit = new Audit();
    const clock = new Clock();
    let n = 0;
    const sourceEvents: string[] = [];
    const realRecord = store.recordSourceEvent.bind(store);
    store.recordSourceEvent = async (...args: Parameters<typeof realRecord>) => { sourceEvents.push(String(args[1].source)); return realRecord(...args); };
    const deps = {
      store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now,
      verifier: verifier("valid"), facts: facts(), settings: STANDARD, newId: () => `les_${String(++n).padStart(4, "0")}`,
      judge: { rate: async () => "unrelated" }, directory: directory({ eligibleIds: ["owner", "ann", "bob"] }), access: allowAllAccess,
    } as unknown as ProcessDeps;
    /** The Nth commit (1 = the add, 2 = the go-live) fails once with a passing fault, before anything is written. */
    const failCommit = (nth: number): void => {
      const real = store.commit.bind(store);
      let calls = 0;
      store.commit = async (...args: Parameters<typeof real>) => { calls += 1; if (calls === nth) throw throttled(); return real(...args); };
    };
    return { deps, store, audit, sourceEvents, failCommit };
  }
  const clean = async () => { const w = trialSetup(); const out = await processDraftRetrying(w.deps, KEY, memberDraft(), noWait); return { ...w, out }; };

  it("positive control: without a fault the draft goes live on trial, with one go-live audit line and its source notes", async () => {
    const w = await clean();
    expect(w.out.lesson).toMatchObject({ status: "active", trial: { state: "trial" } });
    expect(w.audit.actions().filter((action) => action === "lesson.trial_started")).toHaveLength(1);
    expect(w.sourceEvents.length).toBeGreaterThan(0);
  });

  it("a fault at the go-live (the add already committed): the retry only settles, so the lesson is not merged into itself and no lesson.merged / second lesson.candidate_created line appears", async () => {
    const control = await clean();
    const w = trialSetup();
    w.failCommit(2);
    const out = await processDraftRetrying(w.deps, KEY, memberDraft(), noWait);
    expect(out.lesson).toMatchObject({ status: "active", trial: { state: "trial" }, version: control.out.lesson!.version });
    expect(await w.store.list(KEY)).toHaveLength(1);
    expect(w.audit.actions()).not.toContain("lesson.merged");
    expect(w.audit.actions().filter((action) => action === "lesson.candidate_created")).toHaveLength(1);
  });

  it("the go-live audit line (lesson.trial_started) is written once even when its commit had to be tried again after the line was written", async () => {
    const w = trialSetup();
    // commit 1 is the add, 2 the move to pending, 3 the go-live (written AFTER its audit line, which the settle step writes first)
    w.failCommit(3);
    await processDraftRetrying(w.deps, KEY, memberDraft(), noWait);
    expect(w.audit.actions().filter((action) => action === "lesson.trial_started")).toHaveLength(1);
    expect((await w.store.list(KEY))[0]).toMatchObject({ status: "active", trial: { state: "trial" } });
  });

  it("the project's volume counter and the sources' counts are noted once for one draft: a fault at the go-live does not note them again", async () => {
    const control = await clean();
    const w = trialSetup();
    w.failCommit(2);
    await processDraftRetrying(w.deps, KEY, memberDraft(), noWait);
    expect(w.sourceEvents).toEqual(control.sourceEvents);
  });

  it("a fault in the curate step before anything was committed (the add itself failed): the retry curates again but does not note the sources again", async () => {
    const control = await clean();
    const w = trialSetup();
    w.failCommit(1);
    const out = await processDraftRetrying(w.deps, KEY, memberDraft(), noWait);
    expect(out.lesson).toMatchObject({ status: "active" });
    expect(w.sourceEvents).toEqual(control.sourceEvents);
    expect(w.audit.actions().filter((action) => action === "lesson.candidate_created")).toHaveLength(1);
  });

  it("a fault in the very first count (the project's volume) leaves it to the retry: the volume is counted once, not zero times", async () => {
    const control = await clean();
    const w = trialSetup();
    const counted = w.store.recordSourceEvent.bind(w.store);
    let first = true;
    w.store.recordSourceEvent = async (...args: Parameters<typeof counted>) => { if (first) { first = false; throw throttled(); } return counted(...args); };
    await processDraftRetrying(w.deps, KEY, memberDraft(), noWait);
    expect(w.sourceEvents).toEqual(control.sourceEvents);
  });

  it("a fault in a later count keeps what the failed try already counted and counts only the rest, once each", async () => {
    const control = await clean();
    expect(control.sourceEvents.length).toBeGreaterThan(1);
    const w = trialSetup();
    const counted = w.store.recordSourceEvent.bind(w.store);
    let calls = 0;
    w.store.recordSourceEvent = async (...args: Parameters<typeof counted>) => { calls += 1; if (calls === 2) throw throttled(); return counted(...args); };
    await processDraftRetrying(w.deps, KEY, memberDraft(), noWait);
    expect(w.sourceEvents).toEqual(control.sourceEvents);
  });
});

describe("the trial lesson a card contradicts", () => {
  it("a fault in retiring it (after the card was committed) is not the draft's: no retry, one card, the trial lesson stays live and one fixed line says it was left", async () => {
    const store = new InMemoryLessonStore();
    const audit = new Audit();
    const clock = new Clock();
    const spend = new Spend();
    spend.admitted = false;
    let n = 0;
    const logs: string[] = [];
    const fields: Array<Record<string, unknown>> = [];
    const deps = {
      store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend, audit, alerts: new Alerts(), now: clock.now, verifier: verifier("valid"), facts: facts(), settings: settings({ preset: "standard" }),
      newId: () => `les_${String(++n).padStart(4, "0")}`, judge: { rate: async () => "unrelated" }, directory: directory({ eligibleIds: ["owner", "ann", "bob"] }), access: allowAllAccess, log: (event: string, logged: Record<string, unknown>) => { logs.push(event); if (event === "lessons.trial_retire_deferred") fields.push(logged); },
    } as unknown as ProcessDeps;
    const member = (title: string, body: string): LessonDraft => draft({ title, description: "", body, provenance: { ...draft().provenance, sourceKinds: ["send_back"], memberCorrection: true, claimsSupported: true, fromSharedTask: true } });
    const first = (await processDraftRetrying(deps, KEY, member("Use withRetry", "Always use withRetry for HTTP retries in the api service client calls"), noWait)).lesson!;
    expect(first.status).toBe("active");
    // the next commit is the card's, the one after it is the retire's: that one fails with a passing fault
    const real = store.commit.bind(store);
    let commits = 0;
    store.commit = async (...args: Parameters<typeof real>) => { commits += 1; if (commits === 2) throw throttled(); return real(...args); };
    const retried: string[] = [];
    const out = await processDraftRetrying(deps, KEY, member("Do not use withRetry", "Never use withRetry for HTTP retries in the api service client calls"), { ...noWait, log: (event) => retried.push(event) });
    expect(out.outcome.outcome).toBe("contradiction");
    expect(retried).toEqual([]);
    expect(logs).toContain("lessons.trial_retire_deferred");
    // the lesson is named only by a hash (like every learning log line), so the left-over can be found without an id in the log
    expect(fields).toEqual([{ lesson: logRef(KEY.workspaceId, first.id) }]);
    expect(JSON.stringify(fields)).not.toContain(first.id);
    expect((await store.list(KEY)).filter((lesson) => lesson.status === "pending" && lesson.contradictsWith !== undefined)).toHaveLength(1);
    expect((await store.get(KEY, first.id))!.status).toBe("active");
    expect(audit.actions().filter((action) => action === "lesson.contradiction")).toHaveLength(1);
  });
});

describe("a curate step that wrote something and then failed is never run again", () => {
  it("the step's own commit answered ok, then it failed: it is not run again (the answer of the store is the fact)", async () => {
    const w = setup();
    let runs = 0;
    const curate = async (deps: ProcessDeps) => { runs += 1; const lesson = lessonRecord({ id: "les_x1", workspaceId: KEY.workspaceId, project: KEY.project }); await deps.store.commit(KEY, await deps.store.setVersion(KEY), [lesson], 10); throw throttled(); };
    await expect(processDraftRetrying(w.deps, KEY, text("Retries", A), { ...noWait, curate })).rejects.toMatchObject({ name: "ThrottlingException" });
    expect(runs).toBe(1);
  });
  it("the step made a lesson and the store has it, but the answer of the commit was lost (the call threw): it is not run again", async () => {
    const w = setup();
    let runs = 0;
    const curate = async (deps: ProcessDeps) => {
      runs += 1;
      const id = deps.newId!();
      // written behind the retry's back: the lesson is in the store, no answer reached the step
      await w.store.commit(KEY, await w.store.setVersion(KEY), [lessonRecord({ id, workspaceId: KEY.workspaceId, project: KEY.project })], 10);
      throw throttled();
    };
    await expect(processDraftRetrying(w.deps, KEY, text("Retries", A), { ...noWait, curate })).rejects.toMatchObject({ name: "ThrottlingException" });
    expect(runs).toBe(1);
  });
  it("the store cannot say whether the lesson it made is there: not run again (never on doubt)", async () => {
    const w = setup();
    let runs = 0;
    const curate = async (deps: ProcessDeps) => { runs += 1; deps.newId!(); w.store.get = async () => { throw throttled(); }; throw throttled(); };
    await expect(processDraftRetrying(w.deps, KEY, text("Retries", A), { ...noWait, curate })).rejects.toMatchObject({ name: "ThrottlingException" });
    expect(runs).toBe(1);
  });
  it("a commit that threw but landed on an existing lesson (a merge makes no new id) is seen from the store: its new version is there, so the step is not run again", async () => {
    const w = setup();
    const existing = lessonRecord({ id: "les_merge1", workspaceId: KEY.workspaceId, project: KEY.project });
    await w.store.commit(KEY, await w.store.setVersion(KEY), [existing], 10);
    let runs = 0;
    const curate = async (deps: ProcessDeps) => {
      runs += 1;
      const real = w.store.commit.bind(w.store);
      // the write lands, the answer is lost
      w.store.commit = async (...args: Parameters<typeof real>) => { await real(...args); throw throttled(); };
      await deps.store.commit(KEY, await deps.store.setVersion(KEY), [{ ...existing, version: existing.version + 1 }], 20);
      throw new Error("not reached");
    };
    await expect(processDraftRetrying(w.deps, KEY, text("Retries", A), { ...noWait, curate })).rejects.toMatchObject({ name: "ThrottlingException" });
    expect(runs).toBe(1);
    expect((await w.store.get(KEY, "les_merge1"))!.version).toBe(existing.version + 1);
  });
  it("a commit that threw and did NOT land (the stored version is the old one) is run again", async () => {
    const w = setup();
    const existing = lessonRecord({ id: "les_merge2", workspaceId: KEY.workspaceId, project: KEY.project });
    await w.store.commit(KEY, await w.store.setVersion(KEY), [existing], 10);
    let runs = 0;
    const curate = async (deps: ProcessDeps) => {
      runs += 1;
      if (runs === 1) {
        const real = w.store.commit.bind(w.store);
        w.store.commit = async () => { w.store.commit = real; throw throttled(); };
        await deps.store.commit(KEY, await deps.store.setVersion(KEY), [{ ...existing, version: existing.version + 1 }], 20);
      }
      return { outcome: "dropped" as const, reason: "invalid" as const };
    };
    expect((await processDraftRetrying(w.deps, KEY, text("Retries", A), { ...noWait, curate })).outcome.outcome).toBe("dropped");
    expect(runs).toBe(2);
  });
  it("a step that wrote nothing is run again (positive control)", async () => {
    const w = setup();
    let runs = 0;
    const curate = async (deps: ProcessDeps) => { runs += 1; deps.newId!(); if (runs === 1) throw throttled(); return { outcome: "dropped" as const, reason: "invalid" as const }; };
    expect((await processDraftRetrying(w.deps, KEY, text("Retries", A), { ...noWait, curate })).outcome.outcome).toBe("dropped");
    expect(runs).toBe(2);
  });
});
