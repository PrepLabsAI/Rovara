// TE-F3 part A: pacing and the 429 rule. Every model call here goes through the model-egress port's FAKE adapter (no real call, no socket: the network tripwire is installed for the whole file).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOT_RUN_SENTENCES } from "../../packages/contracts/src/model-egress/classify.js";
import { MODEL_EGRESS_OVERRUN_SENTENCE } from "../../packages/contracts/src/model-egress/cost.js";
import {
  EVAL_NOT_RUN_FRACTION_MAX, EVAL_PACING_DEFAULTS, evalCaseCallVia, evalFactsAllRun, evalFactsFromClasses, runEvalCasesPaced, type EvalCallSettle, type EvalClock,
} from "../../packages/contracts/src/eval-pacing.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { collect, validFrame } from "../../packages/testing/src/ports/model-egress-conformance.js";
import { COMPANY_A, fakeModelEgressWorld } from "../../packages/testing/src/ports/model-egress-world.js";

let tripwire: NetworkTripwire;
beforeAll(() => { tripwire = installNetworkTripwire(); });
afterAll(() => { tripwire.restore(); expect(tripwire.attempts).toEqual([]); });

const ok = (costMicros = 10): EvalCallSettle => ({ class: "ok", costMicros });
const tick = async (times = 6): Promise<void> => { for (let index = 0; index < times; index += 1) await Promise.resolve(); };
/** A virtual clock: a sleep moves time forward at once, and every start is stamped. */
function fakeClock(): EvalClock & { time: number; sleeps: number[] } {
  const clock = { time: 0, sleeps: [] as number[], now: () => clock.time, sleep: (ms: number) => { clock.sleeps.push(ms); clock.time += ms; return Promise.resolve(); } };
  return clock;
}

describe("defaults", () => {
  it("are four at once, 200 calls and $2 per task (D5, DECISIONS 157), with 20% as the not-run fraction", () => {
    expect(EVAL_PACING_DEFAULTS.maxInFlight).toBe(4);
    expect(EVAL_PACING_DEFAULTS.maxCalls).toBe(200);
    expect(EVAL_PACING_DEFAULTS.maxCostMicros).toBe(2_000_000);
    expect(EVAL_NOT_RUN_FRACTION_MAX).toBe(0.2);
  });
});

describe("at most four calls at once", () => {
  it("never has more than four in flight, and starts the next one as soon as one settles", async () => {
    const gates: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const clock = fakeClock();
    const running = runEvalCasesPaced({
      cases: 10, clock, limits: { spacingMs: 0 },
      call: async () => { active += 1; peak = Math.max(peak, active); await new Promise<void>((resolve) => gates.push(resolve)); active -= 1; return ok(); },
    });
    await tick();
    expect(gates).toHaveLength(4);
    gates.shift()!();
    await tick();
    expect(gates).toHaveLength(4);
    while (gates.length > 0) { gates.shift()!(); await tick(); }
    const result = await running;
    expect(peak).toBe(4);
    expect(result.peakInFlight).toBe(4);
    expect(result.facts).toMatchObject({ total: 10, run: 10, notRun: 0 });
  });
  it("clamps a larger setting to four: the limit is a ceiling, not a default", async () => {
    let active = 0;
    let peak = 0;
    const result = await runEvalCasesPaced({
      cases: 20, clock: fakeClock(), limits: { maxInFlight: 50, spacingMs: 0 },
      call: async () => { active += 1; peak = Math.max(peak, active); await tick(3); active -= 1; return ok(); },
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.peakInFlight).toBeLessThanOrEqual(4);
    const serial = await runEvalCasesPaced({ cases: 5, clock: fakeClock(), limits: { maxInFlight: 1, spacingMs: 0 }, call: async () => { await tick(); return ok(); } });
    expect(serial.peakInFlight).toBe(1);
  });
  it("leaves spacing between starts on the injected clock, and never sleeps before the first call", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    await runEvalCasesPaced({ cases: 5, clock, limits: { spacingMs: 100 }, call: () => { starts.push(clock.time); return Promise.resolve(ok()); } });
    expect(starts[0]).toBe(0);
    for (let index = 1; index < starts.length; index += 1) expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(100);
  });
});

describe("the call and cost budget", () => {
  it("stops starting calls at the task's call budget: the rest are not run (class cap), never failed", async () => {
    let calls = 0;
    const result = await runEvalCasesPaced({ cases: 12, clock: fakeClock(), limits: { maxCalls: 5, spacingMs: 0 }, call: () => { calls += 1; return Promise.resolve(ok()); } });
    expect(calls).toBe(5);
    expect(result.facts).toEqual({ total: 12, run: 5, notRun: 7, byClass: { cap: 7 }, overrunStop: false });
  });
  it("stops starting calls once the spend reaches the cost budget", async () => {
    let calls = 0;
    const result = await runEvalCasesPaced({ cases: 10, clock: fakeClock(), limits: { maxCostMicros: 250, spacingMs: 0, maxInFlight: 1 }, call: () => { calls += 1; return Promise.resolve(ok(100)); } });
    expect(calls).toBe(3);
    expect(result.spentMicros).toBe(300);
    expect(result.facts.byClass).toEqual({ cap: 7 });
  });
  it("fails closed on a cost it cannot read: the budget is treated as used", async () => {
    let calls = 0;
    const result = await runEvalCasesPaced({ cases: 6, clock: fakeClock(), limits: { spacingMs: 0, maxInFlight: 1 }, call: () => { calls += 1; return Promise.resolve({ class: "ok", costMicros: Number.NaN }); } });
    expect(calls).toBe(1);
    expect(result.facts.byClass).toEqual({ cap: 5 });
  });
  it("a call that throws is one answered with a provider error: not run, and the round goes on", async () => {
    const result = await runEvalCasesPaced({ cases: 3, clock: fakeClock(), limits: { spacingMs: 0 }, call: () => Promise.reject(new Error("boom")) });
    expect(result.facts).toMatchObject({ total: 3, run: 0, notRun: 3, byClass: { provider_error: 3 } });
  });
  it("holds no case identity: a case is its position, and nothing else is kept", async () => {
    const result = await runEvalCasesPaced({ cases: 3, clock: fakeClock(), limits: { spacingMs: 0 }, call: () => Promise.resolve(ok()) });
    expect(result.cases.map((entry) => Object.keys(entry))).toEqual([["index", "state", "class"], ["index", "state", "class"], ["index", "state", "class"]]);
  });
});

describe("a provider limit is 'not run', per class, through the fake adapter", () => {
  const rowOf = (world: ReturnType<typeof fakeModelEgressWorld>) => world.rows.gemini!;
  const run = async (script: Array<Record<string, unknown>>, cases = script.length) => {
    const world = fakeModelEgressWorld();
    const row = rowOf(world);
    world.provider.script(...(script as never[]));
    const call = evalCaseCallVia(world.adapter as never, world.scope(COMPANY_A, row.id) as never, (index) => validFrame(row, world.connection, `case ${String(index)}`) as never);
    const result = await runEvalCasesPaced({ cases, clock: fakeClock(), limits: { spacingMs: 0, maxInFlight: 1 }, call });
    return { world, result };
  };
  it.each([
    ["rate_limit", { status: 429, body: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "too many requests per minute" } }) }],
    ["quota", { status: 429, body: JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }) }],
    ["overloaded", { status: 503, body: "{}" }],
    ["key_refused", { status: 401, body: "{}" }],
  ])("%s: the case is not run with the provider sentence, and the score is over the run cases", async (klass, behaviour) => {
    const { result } = await run([ok_body(), behaviour, ok_body()]);
    expect(result.facts).toMatchObject({ total: 3, run: 2, notRun: 1, byClass: { [klass]: 1 } });
    expect(result.cases[1]).toEqual({ index: 1, state: "not_run", class: klass });
    expect(NOT_RUN_SENTENCES[klass as keyof typeof NOT_RUN_SENTENCES]).toMatch(/^not run: /u);
  });
  it("cap: a call refused by the task's budget is not run (class cap)", async () => {
    const world = fakeModelEgressWorld();
    const row = rowOf(world);
    await world.setCap(COMPANY_A, 1);
    const call = evalCaseCallVia(world.adapter as never, world.scope(COMPANY_A, row.id) as never, () => validFrame(row, world.connection) as never);
    const result = await runEvalCasesPaced({ cases: 2, clock: fakeClock(), limits: { spacingMs: 0, maxInFlight: 1 }, call });
    expect(result.facts.byClass).toEqual({ cap: 2 });
    expect(world.provider.calls).toHaveLength(0);
  });
  it("a provider error (500, an outage) is not run too: there is no answer to score", async () => {
    const { result } = await run([{ status: 500, body: "{}" }, ok_body()]);
    expect(result.facts).toMatchObject({ total: 2, run: 1, notRun: 1, byClass: { provider_error: 1 } });
  });
  it("makes exactly one attempt per case: no retry after a 429", async () => {
    const { world } = await run([{ status: 429, body: "{}" }, { status: 429, body: "{}" }]);
    expect(world.provider.calls).toHaveLength(2);
  });
  it("an unknown class word is read as a run case, so a score is never hidden by a word nobody knows", () => {
    expect(evalFactsFromClasses(["ok", "something_new", "refused"])).toMatchObject({ run: 3, notRun: 0 });
    expect(evalFactsFromClasses(["ok", "provider_error"])).toMatchObject({ run: 1, notRun: 1 });
  });
});

function ok_body(): Record<string, unknown> {
  return { status: 200 };
}

describe("the cap overrun (DECISIONS 165/165a): no call is started after the one that went over", () => {
  it("stops after the call that took the spend past the cap, and says 'budget exceeded by one call'", async () => {
    const world = fakeModelEgressWorld();
    const row = world.rows.gemini!;
    await world.setCap(COMPANY_A, 2_000_000);
    // The first call's answer reports far more usage than any cap: that is the one call the cap may be overrun by.
    world.provider.script({ body: JSON.stringify({ usageMetadata: { promptTokenCount: 50_000_000, candidatesTokenCount: 1 } }) });
    const call = evalCaseCallVia(world.adapter as never, world.scope(COMPANY_A, row.id) as never, (index) => validFrame(row, world.connection, `c${String(index)}`) as never);
    const result = await runEvalCasesPaced({ cases: 8, clock: fakeClock(), limits: { spacingMs: 0, maxInFlight: 1 }, call });
    expect(world.provider.calls).toHaveLength(1);
    expect(result.facts).toEqual({ total: 8, run: 1, notRun: 7, byClass: { cap: 7 }, overrunStop: true });
    expect(result.overrunSentence).toBe(MODEL_EGRESS_OVERRUN_SENTENCE);
    expect(result.overrunSentence).toBe("budget exceeded by one call");
  });
  it("with calls in flight, nothing NEW starts after an overrun settles; the calls already reserved finish", async () => {
    let started = 0;
    const gates: Array<(settle: EvalCallSettle) => void> = [];
    const running = runEvalCasesPaced({ cases: 20, clock: fakeClock(), limits: { spacingMs: 0 }, call: () => { started += 1; return new Promise<EvalCallSettle>((resolve) => gates.push(resolve)); } });
    await tick();
    expect(started).toBe(4);
    gates[0]!({ class: "ok", costMicros: 5, overrun: true });
    await tick();
    expect(started).toBe(4);
    for (const gate of gates.slice(1)) gate({ class: "cap", costMicros: 0, overrun: true });
    const result = await running;
    expect(started).toBe(4);
    expect(result.facts.overrunStop).toBe(true);
    expect(result.facts.run).toBe(1);
  });
  it("with one call at a time, at most one call in the whole round settles over the cap", async () => {
    const world = fakeModelEgressWorld();
    const row = world.rows.gemini!;
    await world.setCap(COMPANY_A, 2_000_000);
    world.provider.script({ body: JSON.stringify({ usageMetadata: { promptTokenCount: 50_000_000, candidatesTokenCount: 1 } }) });
    const overruns: boolean[] = [];
    const inner = evalCaseCallVia(world.adapter as never, world.scope(COMPANY_A, row.id) as never, () => validFrame(row, world.connection) as never);
    await runEvalCasesPaced({ cases: 6, clock: fakeClock(), limits: { spacingMs: 0, maxInFlight: 1 }, call: async (index) => { const settle = await inner(index); overruns.push(settle.overrun === true); return settle; } });
    expect(overruns.filter(Boolean)).toHaveLength(1);
  });
  it("the adapter itself refuses the call after an overrun (the second line of defence): a direct call is a cap refusal that never reaches the provider", async () => {
    const world = fakeModelEgressWorld();
    const row = world.rows.gemini!;
    await world.setCap(COMPANY_A, 2_000_000);
    world.provider.script({ body: JSON.stringify({ usageMetadata: { promptTokenCount: 50_000_000, candidatesTokenCount: 1 } }) });
    await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
    const call = evalCaseCallVia(world.adapter as never, world.scope(COMPANY_A, row.id) as never, () => validFrame(row, world.connection) as never);
    expect(await call(0)).toMatchObject({ class: "cap" });
    expect(world.provider.calls).toHaveLength(1);
  });
});

describe("the facts", () => {
  it("count every case once, and an all-run round has no not-run", () => {
    expect(evalFactsAllRun(7)).toEqual({ total: 7, run: 7, notRun: 0, byClass: {}, overrunStop: false });
    expect(evalFactsFromClasses(["ok", "cap", "quota", "ok"])).toEqual({ total: 4, run: 2, notRun: 2, byClass: { cap: 1, quota: 1 }, overrunStop: false });
  });
});
