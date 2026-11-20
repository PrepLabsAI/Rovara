import { describe, expect, it, vi } from "vitest";
import type { EvalSpendGrant, EvalMeterCall, EvalMeterReservation, MonthlyMeter } from "@agentx/contracts";
import { RealModelCheckSchema, RealModelCheckWriteSchema, realModelCheckLine, realModelPassed } from "../../packages/contracts/src/real-model-check.js";
import { expectLinearScaling, expectLinearScalingAsync } from "../support/scaling.js";
import { runRealModelTests, selectChangedAiTests, type RealModelTestsInput, type ScriptedAiTest } from "../../packages/worker/src/verification/real-model-tests.js";

const test = (name = "one", calls: number | "unknown" = 1): ScriptedAiTest => ({ checkId: "unit", test: `tests/ai.test.ts::${name}`, modelCalls: calls, modelFiles: ["src/model.ts"] });
function world() {
  const grant: EvalSpendGrant = { company: "company-a", project: "project-a", selection: "real-model-tests", inputsDigest: "b".repeat(64), role: "owner", provider: "customer", connected: true, maxCalls: 200, maxCostMicros: 2_000_000 };
  const call = vi.fn<EvalMeterReservation["call"]>(async () => ({ class: "ok", calls: 1, costMicros: 100 }));
  const close = vi.fn(async () => undefined);
  const read = vi.fn(async () => grant);
  const reserve = vi.fn<MonthlyMeter["reserve"]>(async () => ({ call, close }));
  const run = vi.fn<RealModelTestsInput["run"]>(async ({ ids, call: dispatch }) => {
    for (let index = 0; index < ids.length; index += 1) await dispatch({} as Parameters<typeof dispatch>[0]);
    return { model: "gemini-2.5-flash", items: ids.map(id => ({ ...id, result: "passed" as const })) };
  });
  const input: RealModelTestsInput = { candidateDigest: "a".repeat(64), company: "company-a", project: "project-a", trigger: { needed: true, reason: "changes" }, roundKind: "check_unsealed", selection: { changes: [{ path: "tests/ai.test.ts", status: "modified" }], tests: [test()], attribution: "test" }, maxCostMicrosPerCall: 1000, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0, approval: { read }, meter: { reserve }, run };
  return { input, grant, call, close, read, reserve, run };
}
describe("changed AI selection", () => {
  it("selects changed model tests and attributed unchanged tests, never no-model or deleted tests", () => {
    expect(selectChangedAiTests({ changes: [{ path: "src/model.ts", status: "modified" }], tests: [test(), test("none", 0)], attribution: "test" })).toMatchObject({ status: "selected", tests: [test()] });
    expect(selectChangedAiTests({ changes: [{ path: "tests/ai.test.ts", status: "deleted" }], tests: [test()], attribution: "test" })).toMatchObject({ status: "not_run", reason: "attribution_unknown" });
    expect(selectChangedAiTests({ changes: [{ path: "src/model.ts", status: "modified" }], tests: [test()], attribution: "check" })).toMatchObject({ status: "not_run", reason: "attribution_unknown" });
  });
  it("supports check attribution only for changed test files with known calls", () => {
    expect(selectChangedAiTests({ ...world().input.selection, attribution: "check" })).toMatchObject({ status: "selected" });
    expect(selectChangedAiTests({ ...world().input.selection, tests: [test("unknown", "unknown")] })).toMatchObject({ status: "not_run", reason: "call_count_unknown" });
  });
  it("supports 50 selected tests and refuses 51 as a whole", () => {
    const input = world().input.selection;
    expect(selectChangedAiTests({ ...input, tests: Array.from({ length: 50 }, (_, i) => test(String(i))) })).toMatchObject({ status: "selected" });
    expect(selectChangedAiTests({ ...input, tests: Array.from({ length: 51 }, (_, i) => test(String(i))) })).toEqual({ status: "not_run", reason: "too_many_tests", count: 51 });
  });
  it.each([null, { attribution: undefined }, { tests: [test(), test()] }])("refuses invalid selection as a whole %j", patch => {
    const raw = patch === null ? null : { ...world().input.selection, ...patch };
    expect(selectChangedAiTests(raw)).toMatchObject({ status: "not_run", reason: "invalid_input" });
  });
  it("bounds the total inventory and bytes without quadratic matching", () => {
    // Refusing too many rows costs nothing per row: 10,001 rows, then eight times as many (the rows are built before the timing). The refusal is on the row count alone, before any row is read, so the timed arrays are sparse (no row is built: nothing that grows with n sits in memory, unitBytes 0); the real rows, 10,001 and 80,008 of them, are refused once, un-timed, below.
    const refusals = new Map<number, ReturnType<typeof selectChangedAiTests>>();
    expectLinearScaling((count) => {
      const raw = { ...world().input.selection, tests: new Array<ScriptedAiTest>(count) };
      return () => { refusals.set(count, selectChangedAiTests(raw)); };
    }, { n: 10_001, unitBytes: 0, label: "real model tests: too many rows" });
    expect(refusals.get(10_001)).toMatchObject({ status: "not_run", reason: "input_limit" });
    expect(refusals.get(80_008)).toMatchObject({ status: "not_run", reason: "input_limit" });
    for (const count of [10_001, 80_008]) expect(selectChangedAiTests({ ...world().input.selection, tests: Array.from({ length: count }, (_, i) => test(String(i))) })).toMatchObject({ status: "not_run", reason: "input_limit" });
  });
});
describe("real model spend and runs", () => {
  it("skips with zero calls, no approval read and no line; eval_hint triggers", async () => {
    const w = world(); w.input.trigger = { needed: false, reason: "none_found" };
    expect(realModelCheckLine(await runRealModelTests(w.input))).toBeUndefined(); expect(w.read).not.toHaveBeenCalled(); expect(w.run).not.toHaveBeenCalled();
    w.input.tier = { reasons: [{ code: "eval_hint" }] };
    expect((await runRealModelTests(w.input)).status).toBe("completed");
  });
  it.each([
    ["ports_missing", { approval: undefined }], ["round_kind", { roundKind: "working" }],
  ])("refuses %s before dispatch (%j)", async (reason, patch) => {
    const w = world(); const r = await runRealModelTests({ ...w.input, ...patch } as RealModelTestsInput);
    expect(r).toMatchObject({ status: "not_run", reason, calls: 0 }); expect(w.call).not.toHaveBeenCalled(); expect(w.reserve).not.toHaveBeenCalled(); expect(w.run).not.toHaveBeenCalled();
    expect(realModelCheckLine(r)).not.toContain("unknown");
  });
  it.each([
    ["company", { company: "company-b" }, "approval_invalid", "product key approval does not cover these tests"],
    ["connected", { connected: false }, "no_product_key", "no product AI key is connected"],
    ["calls", { maxCalls: 1 }, "grant_cap", "the approved call or cost ceiling cannot fit these tests"],
  ])("refuses invalid grant %s with zero calls", async (_name, patch, reason, words) => {
    const w = world(); Object.assign(w.grant, patch);
    const r = await runRealModelTests(w.input);
    expect(r).toMatchObject({ status: "not_run", reason });
    expect(realModelCheckLine(r)).toBe(`Real model check: not run: ${words}.`);
    expect(w.call).not.toHaveBeenCalled(); expect(w.reserve).not.toHaveBeenCalled(); expect(w.run).not.toHaveBeenCalled();
    expect(realModelCheckLine(r)).not.toMatch(/company-b|project-b|rovara|member|NaN/);
  });
  it("refuses absent or throwing approval and denied monthly reservation", async () => {
    const w = world(); w.input.approval = { read: async () => undefined };
    expect((await runRealModelTests(w.input)).reason).toBe("approval_missing");
    w.input.approval = { read: async () => { throw new Error("private-cause"); } };
    expect(realModelCheckLine(await runRealModelTests(w.input))).not.toContain("private-cause");
    w.input.approval = { read: w.read }; w.input.meter = { reserve: async () => undefined };
    expect((await runRealModelTests(w.input)).reason).toBe("monthly_cap"); expect(w.call).not.toHaveBeenCalled();
  });
  it.each(["passed", "failed"] as const)("reruns only failures once: %s", async second => {
    const w = world(); w.input.selection.tests = [test("one"), test("two")];
    w.run.mockImplementation(async ({ ids, attempt, call }) => {
      for (let index = 0; index < ids.length; index += 1) await call({} as Parameters<typeof call>[0]);
      return { model: "gemini-2.5-flash", items: ids.map(id => ({ ...id, result: attempt === 1 && id.test.endsWith("one") ? "passed" : attempt === 1 ? "failed" : second })) };
    });
    const r = await runRealModelTests(w.input);
    expect(w.run).toHaveBeenCalledTimes(2); expect(w.run.mock.calls[1]![0].ids).toEqual([{ checkId: "unit", test: test("two").test }]);
    expect(r.items.map(i => i.result)).toEqual(["passed", second === "passed" ? "passed_on_rerun" : "failed"]); expect(w.close).toHaveBeenCalledTimes(2);
    expect(w.reserve.mock.calls.map(c => c[0].calls)).toEqual([4, 2]);
  });
  it("keeps a first failure when rerun will not fit", async () => {
    const w = world(); w.input.callsAlreadyUsed = 198;
    w.run.mockImplementation(async ({ ids, call }) => { await call({} as Parameters<typeof call>[0]); return { model: "model", items: ids.map(id => ({ ...id, result: "failed" as const })) }; });
    const r = await runRealModelTests(w.input); expect(r.items[0]).toMatchObject({ result: "failed", reason: "task_cap" });
    expect(w.run).toHaveBeenCalledTimes(1); expect(realModelCheckLine(r)).toContain("re-run not run"); expect(realModelCheckLine(r)).not.toContain("twice");
  });
  it("keeps completed results after 429 and stops further dispatch", async () => {
    const w = world(); w.input.selection.tests = [test("one"), test("two"), test("three")];
    w.call.mockResolvedValueOnce({ class: "ok", calls: 1, costMicros: 100 }).mockResolvedValue({ class: "rate_limit", calls: 1, costMicros: 0 });
    w.run.mockImplementation(async ({ ids, call }) => {
      const items = [];
      for (const id of ids) { try { await call({} as Parameters<typeof call>[0]); items.push({ ...id, result: "passed" as const }); } catch { items.push({ ...id, result: "not_run" as const, reason: "rate_limit" as const }); } }
      return { model: "model", items };
    });
    const r = await runRealModelTests(w.input); expect(r.items.map(i => i.result)).toEqual(["passed", "not_run", "not_run"]); expect(r.status).toBe("partly_run"); expect(r.calls).toBe(2); expect(w.call).toHaveBeenCalledTimes(2); expect(realModelCheckLine(r)).toContain("partly run");
  });
  it.each([{ class: "ok", calls: 2, costMicros: 1 }, { class: "unknown", calls: 1, costMicros: 1 }, { class: "ok", calls: 1, costMicros: 0.5 }])("stops invalid/non-ok usage %j and closes", async raw => {
    const w = world(); w.call.mockResolvedValue(raw as EvalMeterCall);
    w.run.mockImplementation(async ({ ids, call }) => { await call({} as Parameters<typeof call>[0]).catch(() => undefined); await call({} as Parameters<typeof call>[0]).catch(() => undefined); return { model: "model", items: ids.map(id => ({ ...id, result: "failed" as const })) }; });
    const r = await runRealModelTests(w.input); expect(r.status).toBe("not_run"); expect(w.call).toHaveBeenCalledTimes(1); expect(w.close).toHaveBeenCalledTimes(1);
  });
  it("closes on thrown run and never leaks causes", async () => {
    const w = world(); w.run.mockRejectedValue(new Error("private-cause"));
    const r = await runRealModelTests(w.input); expect(r.status).toBe("not_run"); expect(w.close).toHaveBeenCalledOnce(); expect(JSON.stringify(r)).not.toContain("private-cause");
  });
  it("does not accept malformed, missing or duplicated runner items as partial evidence", async () => {
    const w = world(); w.run.mockResolvedValue({ model: "model", items: [] });
    expect((await runRealModelTests(w.input)).reason).toBe("invalid_results"); expect(w.close).toHaveBeenCalledOnce();
  });
});

describe("real model boundary controls", () => {
  it("refuses aggregate bytes and files, even though every row fits", () => {
    const input = world().input.selection;
    expect(selectChangedAiTests({ ...input, tests: Array.from({ length: 5000 }, (_, i) => ({ ...test(`${i}${"x".repeat(460)}`), modelFiles: [] })) })).toMatchObject({ status: "not_run", reason: "input_limit" });
    expect(selectChangedAiTests({ ...input, tests: [ { ...test(), modelFiles: Array.from({ length: 10_001 }, () => "src/model.ts") } ] })).toMatchObject({ status: "not_run", reason: "input_limit" });
  });
  it.each(["maintainer", "admin", "owner"] as const)("accepts approved role %s", async role => {
    const w = world(); Object.assign(w.grant, { role }); expect((await runRealModelTests(w.input)).totals.passed).toBe(1);
  });
  it("serializes concurrent submissions and permits at most one call over the task cost cap", async () => {
    const w = world(); Object.assign(w.grant, { maxCostMicros: 10_000_000 }); w.call.mockResolvedValue({ class: "ok", calls: 1, costMicros: 2_000_001 });
    w.run.mockImplementation(async ({ ids, call }) => {
      await Promise.allSettled(Array.from({ length: 3 }, () => call({} as Parameters<typeof call>[0])));
      return { model: "model", items: ids.map(id => ({ ...id, result: "passed" as const })) };
    });
    const r = await runRealModelTests(w.input); expect(w.call).toHaveBeenCalledTimes(1); expect(r.costMicros).toBe(2_000_001); expect(r.totals.passed).toBe(1);
  });
  it.each(["rate_limit", "quota", "overloaded", "key_refused", "cap", "provider_error", "refused"] as const)("a %s is not a failed test and cannot dispatch again", async word => {
    const w = world(); w.call.mockResolvedValue({ class: word, calls: 1, costMicros: 1 });
    w.run.mockImplementation(async ({ ids, call }) => { await call({} as Parameters<typeof call>[0]).catch(() => undefined); await call({} as Parameters<typeof call>[0]).catch(() => undefined); return { model: "model", items: ids.map(id => ({ ...id, result: "not_run" as const, reason: word })) }; });
    const r = await runRealModelTests(w.input); expect(r.items[0]).toMatchObject({ result: "not_run", reason: word }); expect(w.call).toHaveBeenCalledTimes(1); expect(w.run).toHaveBeenCalledTimes(1);
  });
  it("applies one total timeout, aborts the run and closes after its calls join", async () => {
    vi.useFakeTimers();
    try {
      const w = world(); let joined = false;
      w.run.mockImplementation(async ({ signal, call }) => {
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        await expect(call({} as Parameters<typeof call>[0])).rejects.toThrow("real model call unavailable");
        joined = true; throw new Error("private-timeout-cause");
      });
      let settled = false;
      const running = runRealModelTests(w.input); void running.then(() => { settled = true; }); await vi.advanceTimersByTimeAsync(300_001);
      expect(settled).toBe(true);
      const r = await running; expect(r.reason).toBe("timed_out"); expect(joined).toBe(true); expect(w.close).toHaveBeenCalledOnce(); expect(w.call).not.toHaveBeenCalled(); expect(JSON.stringify(r)).not.toContain("private-timeout-cause");
    } finally { await vi.runAllTimersAsync(); vi.useRealTimers(); }
  });
  it.each([{ model: "model", items: [{ ...test(), result: "wrong" }] }])("refuses malformed runtime output as a whole %j", async output => {
    const w = world(); w.run.mockResolvedValue(output as never);
    expect((await runRealModelTests(w.input)).reason).toBe("invalid_results"); expect(w.close).toHaveBeenCalledOnce();
  });
  it("a zero-call runner cannot claim the test passed", async () => {
    const w = world(); w.run.mockImplementation(async ({ ids }) => ({ model: "model", items: ids.map(id => ({ ...id, result: "passed" as const })) }));
    expect((await runRealModelTests(w.input)).reason).toBe("invalid_results");
  });
});

describe("completion and report honesty", () => {
  it("does not let a close failure erase measured passes", async () => {
    const w = world(); w.close.mockRejectedValue(new Error("private-close-cause"));
    const r = await runRealModelTests(w.input); expect(r.totals.passed).toBe(1); expect(r.reason).toBe("close_unavailable"); expect(JSON.stringify(r)).not.toContain("private-close-cause");
  });
  it("a later model outage preserves the first assertion failure", async () => {
    const w = world(); w.call.mockResolvedValueOnce({ class: "ok", calls: 1, costMicros: 100 }).mockResolvedValue({ class: "overloaded", calls: 1, costMicros: 0 });
    w.run.mockImplementation(async ({ ids, call }) => {
      try { await call({} as Parameters<typeof call>[0]); return { model: "model", items: ids.map(id => ({ ...id, result: "failed" as const })) }; }
      catch { return { model: "model", items: ids.map(id => ({ ...id, result: "not_run" as const, reason: "overloaded" as const })) }; }
    });
    const r = await runRealModelTests(w.input); expect(r.items[0]).toMatchObject({ result: "failed", reason: "overloaded" }); expect(realModelCheckLine(r)).toContain("re-run not run: provider overloaded");
  });
  it("refuses non-whole estimates and wrong field types before reserving", async () => {
    const w = world(); w.input.selection.tests = [test("large", Number.MAX_SAFE_INTEGER)];
    expect((await runRealModelTests(w.input)).reason).toBe("invalid_input"); expect(w.reserve).not.toHaveBeenCalled();
    expect((await runRealModelTests({ ...w.input, costAlreadyUsedMicros: "0" } as never)).reason).toBe("invalid_input");
  });
});

describe("stage ceilings", () => {
  it("the grant cost ceiling bounds total settled stage spend", async () => {
    const w = world(); w.input.selection.tests = [test("one", 2)]; Object.assign(w.grant, { maxCostMicros: 4000 });
    w.call.mockResolvedValue({ class: "ok", calls: 1, costMicros: 3000 });
    w.run.mockImplementation(async ({ ids, call }) => {
      for (let n = 0; n < 4; n += 1) await call({} as Parameters<typeof call>[0]).catch(() => undefined);
      return { model: "model", items: ids.map(id => ({ ...id, result: "passed" as const })) };
    });
    const r = await runRealModelTests(w.input); expect(w.call).toHaveBeenCalledTimes(2); expect(r.costMicros).toBe(6000); expect(r.totals.passed).toBe(1);
  });
});

describe("untrusted boundary budgets", () => {
  it("bounds tier reasons before parsing and refuses a missing runner", async () => {
    const w = world();
    // A 100,000-reason tier is refused on its length, before its reasons are parsed: the cost does not grow with the list (500, then 4,000 reasons of about 60 bytes: the 8N input stays at or under 256 KiB so it stays in CPU cache; both are over the 100-reason limit; the full 100,000 runs once, un-timed).
    const reasons = new Map<number, string | undefined>();
    const refuseTier = (count: number) => {
      const tier = { reasons: Array.from({ length: count }, () => ({ code: "eval_hint" })) };
      return async () => { reasons.set(count, (await runRealModelTests({ ...w.input, tier })).reason); };
    };
    await expectLinearScalingAsync(refuseTier, { n: 500, unitBytes: 60, label: "real model tests: a huge tier list" });
    await refuseTier(100_000)();
    expect([reasons.get(500), reasons.get(4_000), reasons.get(100_000)]).toEqual(["invalid_input", "invalid_input", "invalid_input"]); expect(w.reserve).not.toHaveBeenCalled();
    expect((await runRealModelTests({ ...w.input, run: undefined } as never)).reason).toBe("invalid_input");
  });
});

it("keeps the total timeout active while joining calls after the runner returns", async () => {
  vi.useFakeTimers();
  let release: (() => void) | undefined;
  try {
    const w = world(); const pending = new Promise<void>(resolve => { release = resolve; }); let signal: AbortSignal | undefined;
    w.call.mockImplementation(async () => { await pending; return { class: "ok", calls: 1, costMicros: 100 }; });
    w.run.mockImplementation(async ({ ids, call, signal: stop }) => {
      signal = stop;
      void call({} as Parameters<typeof call>[0]); void call({} as Parameters<typeof call>[0]);
      return { model: "model", items: ids.map(id => ({ ...id, result: "passed" as const })) };
    });
    const running = runRealModelTests(w.input); await vi.advanceTimersByTimeAsync(300_001);
    try { expect(signal?.aborted).toBe(true); expect(w.close).not.toHaveBeenCalled(); }
    finally { release!(); await running; }
    expect(w.call).toHaveBeenCalledOnce(); expect(w.close).toHaveBeenCalledOnce();
  } finally { release?.(); await vi.runAllTimersAsync(); vi.useRealTimers(); }
});

// REVIEW-1's two-test probe: 192a preserves run totals when inspecting one item.
it("192a re-wrap confirms each readiness:0 test from a two-test worker artifact", async () => {
  const w = world();
  w.input.selection.tests = [test("one"), test("two")].map(row => ({ ...row, checkId: "readiness:0" }));
  const written = RealModelCheckWriteSchema.parse(await runRealModelTests(w.input));
  expect(written.candidateDigest).toBe(w.input.candidateDigest);
  expect(written.totals).toEqual({ selected: 2, passed: 2, passedOnRerun: 0, failed: 0, notRun: 0 });
  const run = RealModelCheckSchema.parse(written);
  for (const item of run.items) {
    expect(item.checkId).toBe("readiness:0");
    expect(realModelPassed(written, "readiness:0", item.test)).toBe(true);
    expect(realModelPassed({ ...run, items: [item] }, "readiness:0", item.test)).toBe(true);
    expect(realModelPassed({ ...run, items: [item] }, "readiness:0")).toBe(false);
  }
  expect(realModelPassed(written, "readiness:0")).toBe(false);
  // A whole-check pass needs its own explicit attestation; selected tests cannot supply it.
  const whole = RealModelCheckWriteSchema.parse({ ...written, items: [{ checkId: "readiness:0", result: "passed" }], totals: { selected: 1, passed: 1, passedOnRerun: 0, failed: 0, notRun: 0 } });
  expect(realModelPassed(whole, "readiness:0")).toBe(true);
  expect(realModelPassed(whole, "readiness:0", test("one").test)).toBe(false);
});

it("stops dispatch exactly at the $2 task cap even when the grant is larger", async () => {
  const w = world();
  Object.assign(w.grant, { maxCostMicros: 10_000_000 });
  w.input.costAlreadyUsedMicros = 1_999_000;
  w.input.maxCostMicrosPerCall = 500; // Both reserved calls fit before the first settles at $2.
  w.call.mockResolvedValue({ class: "ok", calls: 1, costMicros: 1000 });
  w.run.mockImplementation(async ({ ids, call }) => {
    await call({} as Parameters<typeof call>[0]);
    await expect(call({} as Parameters<typeof call>[0])).rejects.toThrow("real model call unavailable");
    return { model: "model", items: ids.map(id => ({ ...id, result: "passed" as const })) };
  });
  const r = await runRealModelTests(w.input);
  expect(w.reserve).toHaveBeenCalledWith({ approval: w.grant, calls: 2, costMicros: 1000 });
  expect(w.call).toHaveBeenCalledOnce(); expect(w.close).toHaveBeenCalledOnce();
  expect(r).toMatchObject({ reason: "task_cap", calls: 1, costMicros: 1000, totals: { passed: 1 } });
  expect(realModelCheckLine(r)).toContain("not run: test model budget reached ($2.00 per task).");
});
