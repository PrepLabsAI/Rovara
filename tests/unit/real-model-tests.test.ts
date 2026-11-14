import { describe, expect, it, vi } from "vitest";
import type { EvalSpendGrant, EvalMeterCall, EvalMeterReservation, MonthlyMeter } from "@agentx/contracts";
import { realModelCheckLine, realModelPassed } from "../../packages/contracts/src/real-model-check.js";
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
  it.each([null, { attribution: undefined }, { attribution: "other" }, { tests: [test(), test()] }, { tests: [{ ...test(), modelCalls: -1 }] }, { changes: [{ path: "src/model.ts", status: "wrong" }] }])("refuses invalid selection as a whole %j", patch => {
    const raw = patch === null ? null : { ...world().input.selection, ...patch };
    expect(selectChangedAiTests(raw)).toMatchObject({ status: "not_run", reason: "invalid_input" });
  });
  it("bounds the total inventory and bytes without quadratic matching", () => {
    const start = performance.now();
    expect(selectChangedAiTests({ ...world().input.selection, tests: Array.from({ length: 10_001 }, (_, i) => test(String(i))) })).toMatchObject({ status: "not_run", reason: "input_limit" });
    expect(selectChangedAiTests({ ...world().input.selection, tests: [test("x".repeat(1_000_000))] })).toMatchObject({ status: "not_run" });
    expect(performance.now() - start).toBeLessThan(1000);
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
    ["ports_missing", { approval: undefined }], ["ports_missing", { meter: undefined }], ["round_kind", { roundKind: "working" }],
    ["round_kind", { roundKind: "unknown" }], ["task_cap", { callsAlreadyUsed: 199 }], ["task_cap", { costAlreadyUsedMicros: 1_999_000 }],
    ["invalid_input", { callsAlreadyUsed: -1 }], ["invalid_input", { maxCostMicrosPerCall: NaN }], ["invalid_input", { trigger: { needed: "true" } }],
  ])("refuses %s before dispatch (%j)", async (reason, patch) => {
    const w = world(); const r = await runRealModelTests({ ...w.input, ...patch } as RealModelTestsInput);
    expect(r).toMatchObject({ status: "not_run", reason, calls: 0 }); expect(w.call).not.toHaveBeenCalled(); expect(w.reserve).not.toHaveBeenCalled(); expect(w.run).not.toHaveBeenCalled();
    expect(realModelCheckLine(r)).not.toContain("unknown");
  });
  it.each([
    ["company", { company: "company-b" }], ["project", { project: "project-b" }], ["selection", { selection: "eval" }],
    ["provider", { provider: "rovara" }], ["role", { role: "member" }], ["connected", { connected: false }],
    ["calls", { maxCalls: 1 }], ["cost", { maxCostMicros: 1 }], ["numeric", { maxCalls: NaN }], ["digest", { inputsDigest: "bad" }],
  ])("refuses invalid grant %s with zero calls", async (_name, patch) => {
    const w = world(); Object.assign(w.grant, patch);
    const r = await runRealModelTests(w.input);
    expect(r.status).toBe("not_run"); expect(w.call).not.toHaveBeenCalled(); expect(w.reserve).not.toHaveBeenCalled();
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
  it("reserves twice the scripted calls, records actual usage and closes", async () => {
    const w = world(); const r = await runRealModelTests(w.input);
    expect(w.reserve).toHaveBeenCalledWith({ approval: w.grant, calls: 2, costMicros: 2000 });
    expect(r).toMatchObject({ status: "completed", calls: 1, costMicros: 100, totals: { passed: 1 } }); expect(w.close).toHaveBeenCalledTimes(1);
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
  it.each([{ class: "ok", calls: 2, costMicros: 1 }, { class: "unknown", calls: 1, costMicros: 1 }, { class: "ok", calls: 1, costMicros: 0.5 }, { class: "provider_error", calls: 1, costMicros: 0 }])("stops invalid/non-ok usage %j and closes", async raw => {
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
  it("executes the stated 50-test maximum with one total estimate", async () => {
    const w = world(); w.input.selection.tests = Array.from({ length: 50 }, (_, i) => test(String(i)));
    const r = await runRealModelTests(w.input); expect(r.totals.passed).toBe(50); expect(w.call).toHaveBeenCalledTimes(50);
    expect(w.reserve.mock.calls[0]![0]).toMatchObject({ calls: 100, costMicros: 100_000 });
  });
  it("resolves 10,000 combined rows and files within a bounded time", () => {
    const changes = Array.from({ length: 5000 }, (_, i) => ({ path: `src/m${i}.ts`, status: "modified" as const }));
    const tests = Array.from({ length: 5000 }, (_, i) => ({ ...test(String(i), 0), modelFiles: [changes[i]!.path] }));
    tests[4999]!.modelCalls = 1;
    const start = performance.now();
    expect(selectChangedAiTests({ changes, tests, attribution: "test" })).toMatchObject({ status: "selected", tests: [tests[4999]] });
    expect(performance.now() - start).toBeLessThan(1500);
  });
  it("refuses aggregate bytes and files, even though every row fits", () => {
    const input = world().input.selection;
    expect(selectChangedAiTests({ ...input, tests: Array.from({ length: 5000 }, (_, i) => ({ ...test(`${i}${"x".repeat(460)}`), modelFiles: [] })) })).toMatchObject({ status: "not_run", reason: "input_limit" });
    expect(selectChangedAiTests({ ...input, tests: [ { ...test(), modelFiles: Array.from({ length: 10_001 }, () => "src/model.ts") } ] })).toMatchObject({ status: "not_run", reason: "input_limit" });
  });
  it.each(["maintainer", "admin", "owner"] as const)("accepts approved role %s", async role => {
    const w = world(); Object.assign(w.grant, { role }); expect((await runRealModelTests(w.input)).totals.passed).toBe(1);
  });
  it("does not mix two companies on concurrent independent invocations", async () => {
    const a = world(); const b = world(); b.input.company = "company-b";
    const [one, two] = await Promise.all([runRealModelTests(a.input), runRealModelTests(b.input)]);
    expect(one.totals.passed).toBe(1); expect(two.reason).toBe("approval_invalid"); expect(b.call).not.toHaveBeenCalled();
    expect(a.reserve.mock.calls[0]![0].approval.company).toBe("company-a");
  });
  it("re-reads approval before a re-run and preserves the failure if revoked", async () => {
    const w = world(); w.run.mockImplementation(async ({ ids, call }) => {
      await call({} as Parameters<typeof call>[0]); Object.assign(w.grant, { connected: false });
      return { model: "model", items: ids.map(id => ({ ...id, result: "failed" as const })) };
    });
    const r = await runRealModelTests(w.input); expect(w.read).toHaveBeenCalledTimes(2); expect(w.call).toHaveBeenCalledTimes(1);
    expect(r.items[0]).toMatchObject({ result: "failed", reason: "no_product_key" });
  });
  it("enforces reserved dispatch count even when run catches rejection", async () => {
    const w = world(); w.run.mockImplementation(async ({ ids, call }) => {
      for (let n = 0; n < 4; n += 1) await call({} as Parameters<typeof call>[0]).catch(() => undefined);
      return { model: "model", items: ids.map(id => ({ ...id, result: "passed" as const })) };
    });
    const r = await runRealModelTests(w.input); expect(w.call).toHaveBeenCalledTimes(2); expect(r.calls).toBe(2);
  });
  it("serializes concurrent submissions and permits at most one call over the task cost cap", async () => {
    const w = world(); Object.assign(w.grant, { maxCostMicros: 10_000_000 }); w.call.mockResolvedValue({ class: "ok", calls: 1, costMicros: 2_000_001 });
    w.run.mockImplementation(async ({ ids, call }) => {
      await Promise.allSettled(Array.from({ length: 3 }, () => call({} as Parameters<typeof call>[0])));
      return { model: "model", items: ids.map(id => ({ ...id, result: "passed" as const })) };
    });
    const r = await runRealModelTests(w.input); expect(w.call).toHaveBeenCalledTimes(1); expect(r.costMicros).toBe(2_000_001); expect(r.totals.passed).toBe(1);
  });
  it("a call above its estimate but below the task cap does not stop another call", async () => {
    const w = world(); w.call.mockResolvedValue({ class: "ok", calls: 1, costMicros: 3000 });
    w.run.mockImplementation(async ({ ids, call }) => { await call({} as Parameters<typeof call>[0]); await call({} as Parameters<typeof call>[0]); return { model: "model", items: ids.map(id => ({ ...id, result: "passed" as const })) }; });
    expect((await runRealModelTests(w.input)).totals.passed).toBe(1); expect(w.call).toHaveBeenCalledTimes(2);
  });
  it.each(["rate_limit", "quota", "overloaded", "key_refused", "cap", "provider_error", "refused"] as const)("a %s is not a failed test and cannot dispatch again", async word => {
    const w = world(); w.call.mockResolvedValue({ class: word, calls: 1, costMicros: 1 });
    w.run.mockImplementation(async ({ ids, call }) => { await call({} as Parameters<typeof call>[0]).catch(() => undefined); await call({} as Parameters<typeof call>[0]).catch(() => undefined); return { model: "model", items: ids.map(id => ({ ...id, result: "not_run" as const, reason: word })) }; });
    const r = await runRealModelTests(w.input); expect(r.items[0]).toMatchObject({ result: "not_run", reason: word }); expect(w.call).toHaveBeenCalledTimes(1); expect(w.run).toHaveBeenCalledTimes(1);
  });
  it("joins in-flight calls before close and fences late calls", async () => {
    const w = world(); let release!: () => void; let late!: EvalMeterReservation["call"];
    const pending = new Promise<void>(resolve => { release = resolve; });
    w.call.mockImplementation(async () => { await pending; return { class: "ok", calls: 1, costMicros: 100 }; });
    w.run.mockImplementation(async ({ ids, call }) => { late = call; void call({} as Parameters<typeof call>[0]); return { model: "model", items: ids.map(id => ({ ...id, result: "passed" as const })) }; });
    const running = runRealModelTests(w.input);
    await vi.waitFor(() => expect(w.call).toHaveBeenCalledOnce()); expect(w.close).not.toHaveBeenCalled();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const rejected = late({} as Parameters<typeof late>[0]).then(() => "accepted", () => "refused");
      expect(await Promise.race([rejected, new Promise<string>(resolve => { timer = setTimeout(() => resolve("still running"), 50); })])).toBe("refused");
    } finally { clearTimeout(timer); release(); await running; }
    expect(w.close).toHaveBeenCalledOnce();
    await expect(late({} as Parameters<typeof late>[0])).rejects.toThrow("real model call unavailable"); expect(w.call).toHaveBeenCalledOnce();
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
  it.each([null, { model: "model", items: [{ ...test(), result: "wrong" }] }, { model: "model", items: [{ ...test(), result: "passed", reason: "private-cause" }] }])("refuses malformed runtime output as a whole %j", async output => {
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
  it("unknown usage classes cannot masquerade as other fixed refusal codes", async () => {
    const w = world(); w.call.mockResolvedValue({ class: "approval_missing", calls: 1, costMicros: 0 } as never);
    expect((await runRealModelTests(w.input)).reason).toBe("invalid_usage");
  });
  it("a later model outage preserves the first assertion failure", async () => {
    const w = world(); w.call.mockResolvedValueOnce({ class: "ok", calls: 1, costMicros: 100 }).mockResolvedValue({ class: "overloaded", calls: 1, costMicros: 0 });
    w.run.mockImplementation(async ({ ids, call }) => {
      try { await call({} as Parameters<typeof call>[0]); return { model: "model", items: ids.map(id => ({ ...id, result: "failed" as const })) }; }
      catch { return { model: "model", items: ids.map(id => ({ ...id, result: "not_run" as const, reason: "overloaded" as const })) }; }
    });
    const r = await runRealModelTests(w.input); expect(r.items[0]).toMatchObject({ result: "failed", reason: "overloaded" }); expect(realModelCheckLine(r)).toContain("re-run not run: provider overloaded");
  });
  it("a duplicate or foreign runner id invalidates the entire stage", async () => {
    const w = world(); w.input.selection.tests = [test("one"), test("two")];
    w.run.mockImplementation(async ({ call }) => { await call({} as Parameters<typeof call>[0]); await call({} as Parameters<typeof call>[0]); return { model: "model", items: [test("one"), test("one")].map(id => ({ ...id, result: "passed" as const })) }; });
    expect((await runRealModelTests(w.input)).reason).toBe("invalid_results");
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
  it("the re-run shares the first stage's deadline", async () => {
    vi.useFakeTimers();
    try {
      const w = world(); w.run.mockImplementation(async ({ ids, call, signal }) => {
        await new Promise<void>((resolve, reject) => {
          const finish = (): void => { signal.removeEventListener("abort", abort); resolve(); };
          const timer = setTimeout(finish, 200_000);
          const abort = (): void => { clearTimeout(timer); reject(new Error("private-timeout-cause")); };
          signal.addEventListener("abort", abort, { once: true });
        });
        await call({} as Parameters<typeof call>[0]); return { model: "model", items: ids.map(id => ({ ...id, result: "failed" as const })) };
      });
      let settled = false;
      const running = runRealModelTests(w.input); void running.then(() => { settled = true; }); await vi.advanceTimersByTimeAsync(300_001);
      expect(settled).toBe(true);
      const r = await running; expect(r.items[0]).toMatchObject({ result: "failed", reason: "timed_out" }); expect(w.close).toHaveBeenCalledTimes(2); expect(w.call).toHaveBeenCalledOnce();
    } finally { await vi.runAllTimersAsync(); vi.useRealTimers(); }
  });
});

describe("untrusted boundary budgets", () => {
  it("bounds tier reasons before parsing and refuses a missing runner", async () => {
    const w = world(); const start = performance.now();
    expect((await runRealModelTests({ ...w.input, tier: { reasons: Array.from({ length: 100_000 }, () => ({ code: "eval_hint" })) } })).reason).toBe("invalid_input");
    expect(performance.now() - start).toBeLessThan(1000); expect(w.reserve).not.toHaveBeenCalled();
    expect((await runRealModelTests({ ...w.input, run: undefined } as never)).reason).toBe("invalid_input");
  });
  it.each(["../source.ts", "/source.ts", "src\\source.ts", "src/\nsource.ts"])("refuses malformed paths as a whole: %s", path => {
    expect(selectChangedAiTests({ ...world().input.selection, changes: [{ path, status: "modified" }] })).toMatchObject({ status: "not_run", reason: "invalid_input" });
  });
  it("records a reason for every selected test when an entire stage is refused", async () => {
    const w = world(); w.input.selection.tests = [test("one"), test("two")]; w.input.meter = { reserve: async () => undefined };
    const r = await runRealModelTests(w.input); expect(r.items.map(i => [i.test, i.result, i.reason])).toEqual([test("one"), test("two")].map(i => [i.test, "not_run", "monthly_cap"]));
  });
});

it("rejects an over-limit tier without visiting its rows", async () => {
  const reasons = Array.from({ length: 101 }, () => ({ code: "eval_hint" }));
  Object.defineProperty(reasons, "0", { get: () => { throw new Error("row must not be read"); } });
  const w = world(); expect((await runRealModelTests({ ...w.input, tier: { reasons } })).reason).toBe("invalid_input"); expect(w.call).not.toHaveBeenCalled();
});

it("refuses a foreign id or a model change on rerun as a whole", async () => {
  const foreign = world(); foreign.run.mockImplementation(async ({ call }) => {
    await call({} as Parameters<typeof call>[0]); return { model: "model", items: [{ checkId: "other", test: "foreign", result: "passed" }] };
  });
  expect((await runRealModelTests(foreign.input)).reason).toBe("invalid_results");
  const changed = world(); changed.run.mockImplementation(async ({ ids, attempt, call }) => {
    await call({} as Parameters<typeof call>[0]); return { model: `model${attempt}`, items: ids.map(id => ({ ...id, result: attempt === 1 ? "failed" as const : "passed" as const })) };
  });
  const r = await runRealModelTests(changed.input); expect(r.items[0]).toMatchObject({ result: "failed", reason: "invalid_results" });
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

it("enforces the total row limit independently of file and byte limits", () => {
  const tests = Array.from({ length: 10_001 }, (_, i) => ({ ...test(String(i), 0), modelFiles: [] }));
  expect(selectChangedAiTests({ ...world().input.selection, tests })).toMatchObject({ status: "not_run", reason: "input_limit" });
});

it("clears the existing timeout guard even for synchronous adapter throws", async () => {
  vi.useFakeTimers();
  try {
    const w = world(); w.input.approval = { read: () => { throw new Error("private-sync-cause"); } };
    const r = await runRealModelTests(w.input); expect(r.reason).toBe("approval_missing"); expect(vi.getTimerCount()).toBe(0); expect(JSON.stringify(r)).not.toContain("private-sync-cause");
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

describe("project grant is also a per-task ceiling", () => {
  it("subtracts previous product-key use from both grant dimensions", async () => {
    const calls = world(); Object.assign(calls.grant, { maxCalls: 2 }); calls.input.callsAlreadyUsed = 1;
    expect((await runRealModelTests(calls.input)).reason).toBe("grant_cap"); expect(calls.reserve).not.toHaveBeenCalled();
    const cost = world(); Object.assign(cost.grant, { maxCostMicros: 2000 }); cost.input.costAlreadyUsedMicros = 1;
    expect((await runRealModelTests(cost.input)).reason).toBe("grant_cap"); expect(cost.reserve).not.toHaveBeenCalled();
  });
  it("subtracts first-stage actual usage before admitting the re-run", async () => {
    for (const limits of [{ maxCalls: 2 }, { maxCostMicros: 2000 }]) {
      const w = world(); Object.assign(w.grant, limits);
      w.run.mockImplementation(async ({ ids, call }) => { await call({} as Parameters<typeof call>[0]); return { model: "model", items: ids.map(id => ({ ...id, result: "failed" as const })) }; });
      const r = await runRealModelTests(w.input); expect(w.run).toHaveBeenCalledOnce(); expect(r.items[0]).toMatchObject({ result: "failed", reason: "grant_cap" });
    }
  });
});

it("emits test-level evidence without attesting the whole check", async () => {
  const w = world();
  const r = await runRealModelTests(w.input);
  expect(realModelPassed(r, "unit", test().test)).toBe(true);
  expect(realModelPassed(r, "unit")).toBe(false);
  expect(realModelPassed(r, "other", test().test)).toBe(false);
});
