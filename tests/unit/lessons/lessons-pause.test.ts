// Learning is never silent. The reflector and the curator's judge record ONE current "lessons paused" reason (a fixed code and a time) when learning cannot run, and clear it
// when a call succeeds; the model's hold is sized by its own quote; a failed call counts toward the nightly budget; a CI failure from the subject source's CI path is a measured outcome.
import { describe, expect, it } from "vitest";
import { LESSONS_PAUSE_CODES, lessonsPauseText, teamRecordPk } from "../../../packages/contracts/src/index.js";
import { withLearningAttempt, noteLearningFault, type LearningAttempt } from "../../../packages/core/src/lessons/learning-deadline.js";
import { LearningRefusal, MODEL_FAILURES_BEFORE_PAUSE, documentPauseStore, noteModelFailure, pauseScopeOf, type CurrentPause, type LessonsPauseStore } from "../../../packages/core/src/lessons/pause.js";
import type { PipelineModel } from "../../../packages/core/src/lessons/ports.js";
import { curateDraft, type CurateDeps } from "../../../packages/core/src/lessons/curate.js";
import { InMemoryLessonStore } from "../../../packages/core/src/lessons/store.js";
import { reflectSubject, type ReflectDeps } from "../../../packages/core/src/lessons/reflect.js";
import { MemoryDocumentStore } from "../../../packages/core/src/ports/memory-document-store.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, candidateJson, draft, embedder, memberSpan, reply, settings, subject, verifier } from "./lesson-helpers.js";

class MemoryPause implements LessonsPauseStore {
  current = new Map<string, CurrentPause>();
  log: string[] = [];
  failures = new Map<string, number>();
  private key(ws: string, project: string | undefined): string { return `${ws}/${project ?? "*"}`; }
  async record(ws: string, project: string, code: CurrentPause["code"]): Promise<void> { this.log.push(`record:${code}`); this.current.set(this.key(ws, pauseScopeOf(code) === "company" ? undefined : project), { code, at: 1, scope: pauseScopeOf(code) }); }
  async clear(ws: string, project: string, only?: "project" | "company", ifCode?: CurrentPause["code"]): Promise<void> {
    this.log.push("clear");
    if (ifCode !== undefined && this.current.get(this.key(ws, only === "company" ? undefined : project))?.code !== ifCode) return;
    if (only !== "company") { this.current.delete(this.key(ws, project)); this.failures.delete(this.key(ws, project)); }
    if (only !== "project") this.current.delete(this.key(ws, undefined));
  }
  async failed(ws: string, project: string): Promise<number> { const next = (this.failures.get(this.key(ws, project)) ?? 0) + 1; this.failures.set(this.key(ws, project), next); return next; }
  async read(ws: string, project: string): Promise<CurrentPause | undefined> { return this.current.get(this.key(ws, project)) ?? this.current.get(this.key(ws, undefined)); }
}

/** A model that can quote: the hold it names is what `admit` is asked about and what `complete` is given as its ceiling. */
class QuotingModel extends ScriptedModel implements PipelineModel {
  quotes: Array<Record<string, unknown>> = [];
  constructor(replies: ConstructorParameters<typeof ScriptedModel>[0], public answer: Awaited<ReturnType<NonNullable<PipelineModel["quote"]>>>) { super(replies); }
  async quote(request: Parameters<NonNullable<PipelineModel["quote"]>>[0]) { this.quotes.push({ ...request }); return this.answer; }
}

function deps(model: PipelineModel, over: Partial<ReflectDeps> = {}) {
  const pause = new MemoryPause(), spend = new Spend(), clock = new Clock();
  const d: ReflectDeps = { model, spend, audit: new Audit(), settings: settings(), edition: "public", now: clock.now, newId: () => "run-1", pause, ...over };
  return { d, pause, spend };
}
const one = () => subject([memberSpan("Use withRetry for retries in api.")]);

describe("every code has its one line, and the scope it belongs to", () => {
  it("each code has fixed words that start with 'Lessons paused', and only the monthly limit is the company's", () => {
    for (const code of LESSONS_PAUSE_CODES) { expect(lessonsPauseText(code)).toMatch(/^Lessons paused: /u); expect(pauseScopeOf(code)).toBe(code === "monthly_limit" ? "company" : "project"); }
    expect(lessonsPauseText("monthly_limit")).toBe("Lessons paused: monthly learning limit reached");
    expect(lessonsPauseText("something_new")).toBe("Lessons paused");
  });
});

describe("the reflector records why learning cannot run, and clears it when a call succeeds", () => {
  it("a quote that refuses (no provider, every model forbidden, over budget) records its code, makes no call and says learning_paused", async () => {
    for (const code of ["no_provider", "all_models_forbidden", "no_suitable_model", "no_budget", "cost_too_high"] as const) {
      const model = new QuotingModel([], { ok: false, code });
      const { d, pause, spend } = deps(model);
      expect(await reflectSubject(d, one())).toMatchObject({ status: "skipped", reason: "learning_paused" });
      expect(model.calls).toHaveLength(0);
      expect(spend.asked).toEqual([]);
      expect(await pause.read(WS, PROJECT)).toMatchObject({ code, scope: "project" });
    }
  });

  it("the monthly learning limit (the cheap look refuses) is recorded for the company", async () => {
    const model = new QuotingModel([], { ok: true, usd: 0.03 });
    const { d, pause, spend } = deps(model);
    spend.admitted = false;
    expect(await reflectSubject(d, one())).toMatchObject({ status: "skipped", reason: "spend_refused" });
    expect(await pause.read(WS, "another-project")).toMatchObject({ code: "monthly_limit", scope: "company" });
  });

  it("a refusal thrown by the model's own call (the month filled up meanwhile) is recorded and nothing is spent", async () => {
    const model = new QuotingModel([new LearningRefusal("monthly_limit", "learning's monthly limit is used up")], { ok: true, usd: 0.03 });
    const { d, pause } = deps(model);
    const budget = { spentUsd: 0, capUsd: 2 };
    expect(await reflectSubject(d, one(), budget)).toMatchObject({ status: "skipped", reason: "learning_paused" });
    expect(budget.spentUsd).toBe(0);
    expect((await pause.read(WS, PROJECT))?.code).toBe("monthly_limit");
  });

  it("the hold is sized by the model's quote: the look and the call are given that figure, not a fixed one", async () => {
    const model = new QuotingModel([reply(candidateJson())], { ok: true, usd: 0.0123 });
    const { d, spend } = deps(model);
    await reflectSubject(d, one());
    expect(model.quotes).toHaveLength(1);
    expect(spend.asked).toEqual([0.0123]);
    expect(model.calls[0]).toMatchObject({ budgetUsd: 0.0123, purpose: "reflect", project: PROJECT });
  });

  it("a call that succeeds clears the project's reason and the company's", async () => {
    const model = new QuotingModel([reply(candidateJson())], { ok: true, usd: 0.03 });
    const { d, pause } = deps(model);
    await pause.record(WS, PROJECT, "no_provider");
    await pause.record(WS, PROJECT, "monthly_limit");
    expect(pause.current.size).toBe(2);
    expect((await reflectSubject(d, one())).status).toBe("ok");
    expect(pause.current.size).toBe(0);
  });

  it("a pause store that throws never breaks learning", async () => {
    const model = new QuotingModel([reply(candidateJson())], { ok: true, usd: 0.03 });
    const broken: LessonsPauseStore = { record: async () => { throw new Error("down"); }, clear: async () => { throw new Error("down"); }, read: async () => { throw new Error("down"); } };
    const { d } = deps(model, { pause: broken });
    expect((await reflectSubject(d, one())).status).toBe("ok");
    const refused = new QuotingModel([], { ok: false, code: "no_provider" });
    expect((await reflectSubject(deps(refused, { pause: broken }).d, one())).reason).toBe("learning_paused");
  });

  it("a model that cannot quote keeps the edition's fixed estimate (the old behaviour)", async () => {
    const model = new ScriptedModel([reply(candidateJson())]);
    const { d, spend } = deps(model);
    await reflectSubject(d, one());
    expect(spend.asked).toEqual([0.15]);
  });

  it("a per-task cap somebody set on purpose still binds a sized call", async () => {
    const model = new QuotingModel([], { ok: true, usd: 0.5 });
    const { d, pause } = deps(model, { capsOverride: { perTaskUsd: 0.2 } });
    expect(await reflectSubject(d, one())).toMatchObject({ reason: "learning_paused" });
    expect((await pause.read(WS, PROJECT))?.code).toBe("cost_too_high");
  });
});

describe("the attempt keeps the most severe fault", () => {
  it("a final fault is never overwritten by a later retryable one (the reflector's started call, then the judge's quote failing); a retryable one is raised to final", async () => {
    const attempt: LearningAttempt = { deadlineAt: Date.now() + 60_000 };
    await withLearningAttempt(attempt, async () => { noteLearningFault("final"); noteLearningFault("retryable"); });
    expect(attempt.fault).toBe("final");
    const other: LearningAttempt = { deadlineAt: Date.now() + 60_000 };
    await withLearningAttempt(other, async () => { noteLearningFault("retryable"); expect(other.fault).toBe("retryable"); noteLearningFault("final"); });
    expect(other.fault).toBe("final");
  });
});

describe("the failure count is per REFLECTION, not per retry attempt", () => {
  const attemptOf = (n: number): LearningAttempt => ({ deadlineAt: Date.now() + 60_000, attemptId: `att-${n}`, lastAttempt: n >= 3 });
  const run = async (world: ReturnType<typeof deps>, n: number) => {
    const attempt = attemptOf(n);
    await withLearningAttempt(attempt, () => reflectSubject(world.d, one()));
    return attempt;
  };
  it("one task whose call fails before it starts on all three attempts counts ONCE (the last attempt's), so it cannot trip the 3-in-a-row pause; two more such tasks do", async () => {
    const throwing = (): PipelineModel => ({ complete: async () => { noteLearningFault("retryable"); throw new Error("table down"); } });
    const world = deps(throwing());
    for (const n of [1, 2, 3]) await run(world, n);
    expect(world.pause.failures.get(`${WS}/${PROJECT}`)).toBe(1);
    expect(await world.pause.read(WS, PROJECT)).toBeUndefined();
    for (const n of [1, 2, 3]) await run(world, n);
    for (const n of [1, 2, 3]) await run(world, n);
    expect(world.pause.failures.get(`${WS}/${PROJECT}`)).toBe(MODEL_FAILURES_BEFORE_PAUSE);
    expect(await world.pause.read(WS, PROJECT)).toMatchObject({ code: "model_failed" });
  });
  it("a quote that fails before the call is the same: not counted while another attempt is left", async () => {
    const model: PipelineModel = { complete: async () => { throw new Error("unreachable"); }, quote: async () => { noteLearningFault("retryable"); throw new Error("table down"); } };
    const world = deps(model);
    await run(world, 1);
    await run(world, 2);
    expect(world.pause.failures.size).toBe(0);
    await run(world, 3);
    expect(world.pause.failures.get(`${WS}/${PROJECT}`)).toBe(1);
  });
  it("a FINAL failure (the call had started) counts at once, on any attempt; outside the worker every failure counts (nothing is retried there)", async () => {
    const world = deps({ complete: async () => { noteLearningFault("final"); throw new Error("timeout"); } });
    await run(world, 1);
    expect(world.pause.failures.get(`${WS}/${PROJECT}`)).toBe(1);
    const outside = deps({ complete: async () => { throw new Error("provider down"); } });
    await reflectSubject(outside.d, one());
    expect(outside.pause.failures.get(`${WS}/${PROJECT}`)).toBe(1);
  });
});

describe("a model that keeps failing is never silent", () => {
  const failing = (n: number, error: Error = new Error("provider down")) => Array.from({ length: n }, () => error);
  const reflectTimes = async (model: PipelineModel, times: number, over: Partial<ReflectDeps> = {}) => {
    const world = deps(model, over);
    for (let index = 0; index < times; index += 1) await reflectSubject(world.d, one());
    return world;
  };

  it("pauses the project as model_failed after the third failure in a row, and not before", async () => {
    expect(MODEL_FAILURES_BEFORE_PAUSE).toBe(3);
    const model = new QuotingModel(failing(5), { ok: true, usd: 0.03 });
    const world = deps(model);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expect((await reflectSubject(world.d, one())).reason).toBe("model_error");
      expect(await world.pause.read(WS, PROJECT)).toBeUndefined();
    }
    expect((await reflectSubject(world.d, one())).reason).toBe("model_error");
    expect(await world.pause.read(WS, PROJECT)).toMatchObject({ code: "model_failed", scope: "project" });
    expect(lessonsPauseText("model_failed")).toBe("Lessons paused: the AI provider is not answering");
  });

  it("covers every failure after the mint: a revoked key or a proxy fault (a plain error), an empty answer, learning off on the install, a guardrails read fault in the quote", async () => {
    const errors = [new Error("MODEL_PROXY_UNAVAILABLE the learning model call failed"), new Error("MODEL_PROXY_UNAVAILABLE the learning model answered with no text"), Object.assign(new Error("CONFIG_INVALID learning calls are not set up on this install"), { code: "CONFIG_INVALID" })];
    for (const error of errors) {
      const { pause } = await reflectTimes(new QuotingModel(failing(3, error), { ok: true, usd: 0.03 }), 3);
      expect((await pause.read(WS, PROJECT))?.code).toBe("model_failed");
    }
    // The quote itself throws (a guardrails read fault, a mint-side fault): the same count.
    class ThrowingQuote extends QuotingModel { override async quote(): Promise<never> { throw new Error("guardrails unreadable"); } }
    const { pause, } = await reflectTimes(new ThrowingQuote([], { ok: true, usd: 0.03 }), 3);
    expect((await pause.read(WS, PROJECT))?.code).toBe("model_failed");
  });

  it("a success in between starts the count again, and clears an existing model_failed pause", async () => {
    const model = new QuotingModel([new Error("down"), new Error("down"), reply(candidateJson()), new Error("down"), new Error("down")], { ok: true, usd: 0.03 });
    const world = deps(model);
    for (let index = 0; index < 5; index += 1) await reflectSubject(world.d, one());
    // down, down, ok (resets), down, down: never three in a row.
    expect(await world.pause.read(WS, PROJECT)).toBeUndefined();
    const paused = new QuotingModel([new Error("down"), new Error("down"), new Error("down"), reply(candidateJson())], { ok: true, usd: 0.03 });
    const again = deps(paused);
    for (let index = 0; index < 3; index += 1) await reflectSubject(again.d, one());
    expect((await again.pause.read(WS, PROJECT))?.code).toBe("model_failed");
    expect((await reflectSubject(again.d, one())).status).toBe("ok");
    expect(await again.pause.read(WS, PROJECT)).toBeUndefined();
  });

  it("a refusal before the key (no provider) is not counted as a failed call, and another project's failures are its own", async () => {
    const refused = new QuotingModel([], { ok: false, code: "no_provider" });
    const world = deps(refused);
    for (let index = 0; index < 4; index += 1) await reflectSubject(world.d, one());
    expect((await world.pause.read(WS, PROJECT))?.code).toBe("no_provider");
    expect(world.pause.failures.size).toBe(0);
    const model = new QuotingModel(failing(3), { ok: true, usd: 0.03 });
    const other = deps(model);
    for (let index = 0; index < 3; index += 1) await reflectSubject(other.d, { ...one(), project: "api" });
    expect((await other.pause.read(WS, "api"))?.code).toBe("model_failed");
    expect(await other.pause.read(WS, PROJECT)).toBeUndefined();
  });

  it("the curator's judge counts too: a judge call that keeps failing pauses the project", async () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const b = "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper";
    const model = new QuotingModel([new Error("down"), new Error("down"), new Error("down")], { ok: true, usd: 0.004 });
    const pause = new MemoryPause();
    // Three separate curations, each judging one pair (a fresh lesson set each time), against one pause store: three judge failures in a row for the project.
    for (let round = 0; round < 3; round += 1) {
      let n = 0;
      const d: CurateDeps & { verifier: unknown; settings: unknown } = {
        store: new InMemoryLessonStore(), embedder, vectors: new MemoryVectors(), judgeModel: model, spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now,
        verifier: verifier("valid"), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}`, pause,
      };
      await curateDraft(d, KEY, draft({ title: "Retries", description: "", body: a }));
      await curateDraft(d, KEY, draft({ title: "Retries", description: "", body: b }));
    }
    expect(model.calls).toHaveLength(3);
    expect((await pause.read(WS, PROJECT))?.code).toBe("model_failed");
  });
});

describe("a reply that cannot be used is a failure, not a success", () => {
  const junk = "I think the lesson is to retry, but here is no JSON";
  it("three replies in a row that do not parse pause the project as model_failed; a good reply after two bad ones starts the count again", async () => {
    const model = new QuotingModel([junk, junk, junk], { ok: true, usd: 0.03 });
    const world = deps(model);
    for (let index = 0; index < 2; index += 1) {
      expect((await reflectSubject(world.d, one())).reason).toBe("parse_error");
      expect(await world.pause.read(WS, PROJECT)).toBeUndefined();
    }
    expect((await reflectSubject(world.d, one())).reason).toBe("parse_error");
    expect(await world.pause.read(WS, PROJECT)).toMatchObject({ code: "model_failed", scope: "project" });
    const mixed = new QuotingModel([junk, junk, reply(candidateJson()), junk, junk], { ok: true, usd: 0.03 });
    const again = deps(mixed);
    for (let index = 0; index < 5; index += 1) await reflectSubject(again.d, one());
    expect(await again.pause.read(WS, PROJECT)).toBeUndefined();
  });

  it("a reply that does not parse does not clear a pause already in force, or the failure count (no noteRecovered before the parse)", async () => {
    const model = new QuotingModel([junk], { ok: true, usd: 0.03 });
    const world = deps(model);
    await world.pause.record(WS, PROJECT, "model_failed");
    world.pause.failures.set(`${WS}/${PROJECT}`, 2);
    await reflectSubject(world.d, one());
    expect(world.pause.log).not.toContain("clear");
    expect((await world.pause.read(WS, PROJECT))?.code).toBe("model_failed");
  });

  it("the curator's judge counts a reply that does not parse the same way", async () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const b = "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper";
    const model = new QuotingModel([junk, junk, junk], { ok: true, usd: 0.004 });
    const pause = new MemoryPause();
    for (let round = 0; round < 3; round += 1) {
      let n = 0;
      const d: CurateDeps & { verifier: unknown; settings: unknown } = {
        store: new InMemoryLessonStore(), embedder, vectors: new MemoryVectors(), judgeModel: model, spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now,
        verifier: verifier("valid"), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}`, pause,
      };
      await curateDraft(d, KEY, draft({ title: "Retries", description: "", body: a }));
      await curateDraft(d, KEY, draft({ title: "Retries", description: "", body: b }));
    }
    expect(model.calls).toHaveLength(3);
    expect(pause.log).not.toContain("clear");
    expect((await pause.read(WS, PROJECT))?.code).toBe("model_failed");
  });
});

describe("The curator's judge call carries Public's per-task cap", () => {
  const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
  const b = "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper";
  const judged = async (edition?: "public" | "enterprise") => {
    const model = new QuotingModel([junk0], { ok: true, usd: 0.004 });
    const d: CurateDeps & { verifier: unknown; settings: unknown } = {
      store: new InMemoryLessonStore(), embedder, vectors: new MemoryVectors(), judgeModel: model, spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now,
      verifier: verifier("valid"), settings: settings(), newId: (() => { let n = 0; return () => `les_${String(++n).padStart(4, "0")}`; })(), ...(edition === undefined ? {} : { edition }),
    };
    await curateDraft(d, KEY, draft({ title: "Retries", description: "", body: a }));
    await curateDraft(d, KEY, draft({ title: "Retries", description: "", body: b }));
    return model;
  };
  const junk0 = "no json";
  it("a judge that answers clears the judge's own count of failures in a row (a failed one counted first)", async () => {
    const model = new QuotingModel(["no json", JSON.stringify({ verdicts: [{ n: 1, verdict: "different" }, { n: 2, verdict: "different" }] })], { ok: true, usd: 0.004 });
    const pause = Object.assign(new MemoryPause(), { judgeFailures: 0, judgeCleared: 0 });
    const inner = pause.failed.bind(pause);
    Object.assign(pause, {
      failed: async (ws: string, project: string, kind?: string) => { if (kind === "judge") { pause.judgeFailures += 1; return pause.judgeFailures; } return inner(ws, project); },
      clearJudgeFailures: async () => { pause.judgeFailures = 0; pause.judgeCleared += 1; },
    });
    let n = 0;
    const d: CurateDeps & { verifier: unknown; settings: unknown } = {
      store: new InMemoryLessonStore(), embedder, vectors: new MemoryVectors(), judgeModel: model, spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now,
      verifier: verifier("valid"), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}`, pause,
    };
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    await curateDraft(d, KEY, draft({ title: "Retries", description: "", body: a }));
    await curateDraft(d, KEY, draft({ title: "Retries", description: "", body: "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper" }));
    expect(pause.judgeFailures).toBe(1);
    await curateDraft(d, KEY, draft({ title: "Retries", description: "", body: "Use withRetry from src/retry/index.ts for HTTP retries in the api service gateway calls" }));
    expect(pause.judgeCleared).toBe(1);
    expect(pause.judgeFailures).toBe(0);
  });

  it("Public (and an install that does not say: the safe side) sends the cap with the quote and the call; Enterprise sends none", async () => {
    for (const edition of [undefined, "public"] as const) {
      const model = await judged(edition);
      // Positive control: the judge was reached.
      expect(model.calls).toHaveLength(1);
      expect(model.quotes[0]).toMatchObject({ purpose: "judge", maxHoldUsd: 0.15 });
      expect(model.calls[0]).toMatchObject({ purpose: "judge", maxHoldUsd: 0.15 });
    }
    const enterprise = await judged("enterprise");
    expect(enterprise.calls).toHaveLength(1);
    expect(enterprise.quotes[0]).not.toHaveProperty("maxHoldUsd");
  });
});

describe("the cheap look says why it refused", () => {
  const withLook = (answer: "ok" | "month_full" | "too_large" | "unreadable"): Spend => Object.assign(new Spend(), { look: async () => answer });
  it("a full month is the company's monthly limit; a call too large for the whole cap is a cost problem; an unreadable counter records nothing", async () => {
    const expected = { month_full: "monthly_limit", too_large: "cost_too_high", unreadable: undefined } as const;
    for (const look of ["month_full", "too_large", "unreadable"] as const) {
      const model = new QuotingModel([], { ok: true, usd: 0.03 });
      const { d, pause } = deps(model, { spend: withLook(look) });
      expect(await reflectSubject(d, one())).toMatchObject({ status: "skipped", reason: "spend_refused" });
      expect((await pause.read(WS, PROJECT))?.code).toBe(expected[look]);
      expect(model.calls).toHaveLength(0);
    }
  });
});

describe("Public keeps a per-task learning cap whatever the quote; Enterprise has none of its own", () => {
  it("Public: a sized hold above $0.15 is refused as cost_too_high, and one at or under it runs", async () => {
    const dear = new QuotingModel([reply(candidateJson())], { ok: true, usd: 0.16 });
    const refused = deps(dear);
    expect(await reflectSubject(refused.d, one())).toMatchObject({ status: "skipped", reason: "learning_paused" });
    expect(dear.calls).toHaveLength(0);
    expect((await refused.pause.read(WS, PROJECT))?.code).toBe("cost_too_high");
    const fair = new QuotingModel([reply(candidateJson())], { ok: true, usd: 0.15 });
    expect((await reflectSubject(deps(fair).d, one())).status).toBe("ok");
  });

  it("Public passes its per-task cap to the model with the quote and the call, so the model can choose one that fits; Enterprise passes none", async () => {
    const pub = new QuotingModel([reply(candidateJson())], { ok: true, usd: 0.03 });
    expect((await reflectSubject(deps(pub).d, one())).status).toBe("ok");
    expect(pub.quotes[0]).toMatchObject({ maxHoldUsd: 0.15 });
    expect(pub.calls[0]).toMatchObject({ maxHoldUsd: 0.15, budgetUsd: 0.03 });
    const ent = new QuotingModel([reply(candidateJson())], { ok: true, usd: 0.03 });
    expect((await reflectSubject(deps(ent, { edition: "enterprise" }).d, one())).status).toBe("ok");
    expect(ent.quotes[0]).not.toHaveProperty("maxHoldUsd");
  });

  it("Enterprise: the same $1 quote runs (no per-task cap of its own; the company's budgets bind in the model's own admission)", async () => {
    const dear = new QuotingModel([reply(candidateJson())], { ok: true, usd: 1 });
    const world = deps(dear, { edition: "enterprise" });
    expect((await reflectSubject(world.d, one())).status).toBe("ok");
    expect(dear.calls[0]).toMatchObject({ budgetUsd: 1 });
    expect(await world.pause.read(WS, PROJECT)).toBeUndefined();
  });
});

describe("a failed call counts toward the nightly budget; a call refused before it started does not", () => {
  it("adds the hold of a failed call to what the night has spent, so a provider that keeps failing stops the night", async () => {
    const model = new QuotingModel([new Error("provider down"), new Error("provider down"), new Error("provider down")], { ok: true, usd: 0.6 });
    // Enterprise has no per-task cap of its own, so the 0.6 hold is not refused for its size here.
    const { d } = deps(model, { edition: "enterprise" });
    const budget = { spentUsd: 0, capUsd: 1 };
    expect((await reflectSubject(d, one(), budget)).reason).toBe("model_error");
    expect(budget.spentUsd).toBeCloseTo(0.6, 6);
    // The second would pass the night's cap (0.6 + 0.6 > 1), so it is not made.
    expect((await reflectSubject(d, one(), budget)).reason).toBe("night_cap");
    expect(model.calls).toHaveLength(1);
  });
});

describe("the pause store", () => {
  const table = () => { const db = new MemoryDocumentStore(); return { db, store: documentPauseStore(db, () => 1234) }; };

  it("the judge's failures in a row are counted apart from the reflector's: a reflection that succeeds clears the reflector's count and the reason, never the judge's", async () => {
    const { db, store } = table();
    const count = async (sk: string) => ((await db.get({ pk: teamRecordPk(WS, PROJECT), sk })) as { count?: number } | undefined)?.count;
    expect(await store.failed!(WS, PROJECT, "judge")).toBe(1);
    expect(await store.failed!(WS, PROJECT, "judge")).toBe(2);
    expect(await store.failed!(WS, PROJECT, "reflect")).toBe(1);
    await store.clear(WS, PROJECT);
    expect(await count("LESSONSET#FAILS")).toBeUndefined();
    expect(await count("LESSONSET#FAILS_JUDGE")).toBe(2);
    expect(await store.failed!(WS, PROJECT, "judge")).toBe(3);
    await store.clearJudgeFailures!(WS, PROJECT);
    expect(await count("LESSONSET#FAILS_JUDGE")).toBeUndefined();
    // Both start with LESSONSET, which the erase already wipes.
    expect(await store.failed!(WS, PROJECT)).toBe(1);
  });

  it("a Lessons-tab clear starts the judge's count again too, so one judge failure after it does not pause the project, and three do; a reflection's success does not clear it", async () => {
    const { store } = table();
    for (let call = 0; call < MODEL_FAILURES_BEFORE_PAUSE; call += 1) await noteModelFailure(store, WS, PROJECT, "judge");
    expect((await store.read(WS, PROJECT))?.code).toBe("model_failed");
    // A reflection that succeeds clears the reason, not the judge's count: the next judge failure pauses again at once.
    await store.clear(WS, PROJECT);
    await noteModelFailure(store, WS, PROJECT, "judge");
    expect((await store.read(WS, PROJECT))?.code).toBe("model_failed");
    // The person's clear from the tab (conditional on the reason they saw) starts every count again.
    await store.clear(WS, PROJECT, "project", "model_failed");
    expect(await store.read(WS, PROJECT)).toBeUndefined();
    await noteModelFailure(store, WS, PROJECT, "judge");
    expect(await store.read(WS, PROJECT)).toBeUndefined();
    await noteModelFailure(store, WS, PROJECT, "judge");
    await noteModelFailure(store, WS, PROJECT, "judge");
    expect((await store.read(WS, PROJECT))?.code).toBe("model_failed");
  });

  it("keeps one reason per project and one for the company; reads the project's own first, then the company's", async () => {
    const { store } = table();
    await store.record(WS, "web", "no_provider");
    await store.record(WS, "web", "monthly_limit");
    await store.record(WS, "api", "all_models_forbidden");
    expect(await store.read(WS, "web")).toEqual({ code: "no_provider", at: 1234, scope: "project" });
    expect(await store.read(WS, "api")).toMatchObject({ code: "all_models_forbidden" });
    expect(await store.read(WS, "docs")).toEqual({ code: "monthly_limit", at: 1234, scope: "company" });
    // Another company sees nothing.
    expect(await store.read("org_bbbbbbbbbbbbbbbbbbbb", "web")).toBeUndefined();
  });

  it("a later reason replaces the earlier one, and a success clears the project's and the company's", async () => {
    const { store } = table();
    await store.record(WS, "web", "no_provider");
    await store.record(WS, "web", "no_budget");
    expect((await store.read(WS, "web"))?.code).toBe("no_budget");
    await store.record(WS, "web", "monthly_limit");
    await store.clear(WS, "web");
    expect(await store.read(WS, "web")).toBeUndefined();
  });

  it("holds only a fixed code and a time, and an item with another code reads as nothing", async () => {
    const { db, store } = table();
    await store.record(WS, "web", "no_provider");
    const stored = (await db.get({ pk: teamRecordPk(WS, "web"), sk: "LESSONSET#PAUSED" })) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["at", "code", "entityType", "pk", "sk"]);
    expect(stored).toMatchObject({ code: "no_provider", at: 1234 });
    await db.put({ item: { pk: `WS#${WS}#P#web`, sk: "LESSONSET#PAUSED", code: "something with a model name claude-opus", at: 5 } });
    expect(await store.read(WS, "web")).toBeUndefined();
  });

  it("a reason already in force keeps the time it started; a different reason, or one after a success, starts a new time", async () => {
    let clock = 100;
    const store = documentPauseStore(new MemoryDocumentStore(), () => clock);
    await store.record(WS, "web", "no_provider");
    clock = 500;
    await store.record(WS, "web", "no_provider");
    expect(await store.read(WS, "web")).toMatchObject({ code: "no_provider", at: 100 });
    await store.record(WS, "web", "no_budget");
    expect(await store.read(WS, "web")).toMatchObject({ code: "no_budget", at: 500 });
    await store.clear(WS, "web");
    clock = 900;
    await store.record(WS, "web", "no_budget");
    expect(await store.read(WS, "web")).toMatchObject({ at: 900 });
  });

  it("counts failures in a row per project (a count and a time, nothing else), and a success clears them", async () => {
    const { db, store } = table();
    expect([await store.failed!(WS, "web"), await store.failed!(WS, "web"), await store.failed!(WS, "api")]).toEqual([1, 2, 1]);
    const stored = (await db.get({ pk: teamRecordPk(WS, "web"), sk: "LESSONSET#FAILS" })) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["at", "count", "entityType", "pk", "sk"]);
    await store.clear(WS, "web");
    expect(await store.failed!(WS, "web")).toBe(1);
    expect(await store.failed!(WS, "api")).toBe(2);
  });

  it("clearing only the project's reason leaves the company's, and the other way round", async () => {
    const { store } = table();
    await store.record(WS, "web", "no_provider");
    await store.record(WS, "web", "monthly_limit");
    await store.clear(WS, "web", "project");
    expect(await store.read(WS, "web")).toMatchObject({ code: "monthly_limit", scope: "company" });
    await store.record(WS, "web", "no_provider");
    await store.clear(WS, "web", "company");
    expect(await store.read(WS, "web")).toMatchObject({ code: "no_provider", scope: "project" });
  });

  it("a clear that names the reason it saw deletes that reason only; a different reason recorded in between stays, with the failure count", async () => {
    const { db, store } = table();
    await store.record(WS, "web", "no_provider");
    await store.failed!(WS, "web");
    // A learning call records another reason after the view read "no_provider".
    await store.record(WS, "web", "no_budget");
    await store.clear(WS, "web", "project", "no_provider");
    expect(await store.read(WS, "web")).toMatchObject({ code: "no_budget" });
    expect(await db.get({ pk: teamRecordPk(WS, "web"), sk: "LESSONSET#FAILS" })).toBeDefined();
    await store.clear(WS, "web", "project", "no_budget");
    expect(await store.read(WS, "web")).toBeUndefined();
    expect(await db.get({ pk: teamRecordPk(WS, "web"), sk: "LESSONSET#FAILS" })).toBeUndefined();
  });

  it("a table that fails is never an error for learning", async () => {
    const down = async () => { throw new Error("down"); };
    const failing = documentPauseStore({ get: down, put: down, update: down, delete: down } as never, () => 1);
    await expect(failing.record(WS, "web", "no_provider")).resolves.toBeUndefined();
    await expect(failing.clear(WS, "web")).resolves.toBeUndefined();
    await expect(failing.read(WS, "web")).resolves.toBeUndefined();
  });
});

describe("the curator's judge is sized by the same quote and pauses the same way", () => {
  const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
  const b = "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper";
  const text = (title: string, body: string) => draft({ title, description: "", body });
  function curation(model: PipelineModel) {
    const pause = new MemoryPause(), spend = new Spend();
    let n = 0;
    const d: CurateDeps & { verifier: unknown; settings: unknown } = {
      store: new InMemoryLessonStore(), embedder, vectors: new MemoryVectors(), judgeModel: model, spend, audit: new Audit(), alerts: new Alerts(), now: new Clock().now,
      verifier: verifier("valid"), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}`, pause,
    };
    return { d, pause, spend };
  }

  it("asks the model for the hold of the judge call, looks at the month with it, and clears an old reason when the judge answers", async () => {
    const model = new QuotingModel([JSON.stringify({ verdicts: [{ n: 1, verdict: "different" }] })], { ok: true, usd: 0.004 });
    const { d, pause, spend } = curation(model);
    await pause.record(WS, PROJECT, "no_provider");
    await curateDraft(d, KEY, text("Retries", a));
    await curateDraft(d, KEY, text("Retries", b));
    expect(model.quotes[0]).toMatchObject({ purpose: "judge", project: PROJECT, maxOutputTokens: 90 });
    expect(spend.asked).toEqual([0.004]);
    expect(model.calls[0]).toMatchObject({ budgetUsd: 0.004 });
    expect(await pause.read(WS, PROJECT)).toBeUndefined();
  });

  it("a refused quote records its code and no judge call is made (the lesson goes to a person)", async () => {
    const model = new QuotingModel([], { ok: false, code: "all_models_forbidden" });
    const { d, pause } = curation(model);
    await curateDraft(d, KEY, text("Retries", a));
    const out = await curateDraft(d, KEY, text("Retries", b));
    expect(out).toBeDefined();
    expect(model.calls).toHaveLength(0);
    expect((await pause.read(WS, PROJECT))?.code).toBe("all_models_forbidden");
  });

  it("the month's limit refusing the look is recorded for the company", async () => {
    const model = new QuotingModel([], { ok: true, usd: 0.004 });
    const { d, pause, spend } = curation(model);
    await curateDraft(d, KEY, text("Retries", a));
    spend.admitted = false;
    await curateDraft(d, KEY, text("Retries", b));
    expect(model.calls).toHaveLength(0);
    expect(await pause.read(WS, "any")).toMatchObject({ code: "monthly_limit", scope: "company" });
  });
});
