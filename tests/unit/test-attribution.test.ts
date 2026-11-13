// Per-test attribution (TE-A6 Part A): the pure join that says which answers each test used, per test only when Rovara can prove it, otherwise per check. Never invents a per-test number.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_CALLS_MAX, ATTRIBUTION_GUARD_MIN_MS, PER_CHECK_REASONS, PER_CHECK_REASON_WORDS, TEST_ANSWER_RECORDS_MAX, TEST_ANSWER_USES_MAX, TestAnswerRecordsSchema, attributeTests, testResultState,
  type AttributionCall, type AttributionInput, type AttributionTest,
} from "../../packages/contracts/src/index.js";

const GUARD = 50;
const test = (id: string, startMs: number, endMs: number, status: AttributionTest["status"] = "passed"): AttributionTest => ({ id, status, startMs, endMs });
const faked = (atMs: number, dependency = "bucket-a"): AttributionCall => ({ atMs, dependency, source: "faked" });
const recorded = (atMs: number, dependency = "model-a", recordedOn = "2026-11-12"): AttributionCall => ({ atMs, dependency, source: "recorded", recordedOn });
const input = (tests: AttributionTest[], calls: AttributionCall[], extra: Partial<AttributionInput> = {}): AttributionInput => ({ tests, calls, ledgerComplete: true, guardMs: GUARD, untimedFakeDependencies: [], ...extra });
const reasonOf = (value: AttributionInput): string => {
  const result = attributeTests(value);
  expect(result.mode).toBe("per_check");
  return result.mode === "per_check" ? result.reason : "";
};
// Three serial tests: a 0..1000, b 2000..3000, c 4000..5000.
const serial = (): AttributionTest[] => [test("a", 0, 1000), test("b", 2000, 3000), test("c", 4000, 5000)];

describe("a check whose tests ran one after another, with every call well inside one window", () => {
  it("gives each test the answers called during its own window, and nothing from another test's window", () => {
    const result = attributeTests(input(serial(), [faked(500), recorded(2500), recorded(2600, "model-b", "2026-10-01")]));
    expect(result).toEqual({
      mode: "per_test",
      records: [
        { testId: "a", status: "passed", uses: [{ source: "faked", dependency: "bucket-a" }] },
        { testId: "b", status: "passed", uses: [{ source: "recorded", dependency: "model-a", recordedOn: "2026-11-12" }, { source: "recorded", dependency: "model-b", recordedOn: "2026-10-01" }] },
      ],
      leftPerCheck: ["c"],
    });
  });

  it("never turns a passing test that no faked or recorded call was tied to into a record that reads as a real pass: it stays with its per-check label", () => {
    const result = attributeTests(input(serial(), [faked(500)]));
    expect(result.mode).toBe("per_test");
    if (result.mode !== "per_test") return;
    expect(result.records.map((record) => record.testId)).toEqual(["a"]);
    expect(result.leftPerCheck).toEqual(["b", "c"]);
    for (const record of result.records) expect(record.status === "passed" && record.uses.length === 0).toBe(false);
  });

  it("with no calls at all, every passing test is left per check and nothing is claimed", () => {
    expect(attributeTests(input(serial(), []))).toEqual({ mode: "per_test", records: [], leftPerCheck: ["a", "b", "c"] });
  });

  it("keeps a failed test as a failed record (with what answered it) and carries a test that was not run through, with the reason it was given, needing no times", () => {
    const notRun: AttributionTest = { id: "n", status: "not_run", notRun: { dependency: "model-a", reason: "no_recording" } };
    const result = attributeTests(input([test("a", 0, 1000, "failed"), test("b", 2000, 3000), notRun], [faked(500)]));
    expect(result).toEqual({
      mode: "per_test",
      records: [{ testId: "a", status: "failed", uses: [{ source: "faked", dependency: "bucket-a" }] }, { testId: "n", status: "not_run", uses: [], notRun: { dependency: "model-a", reason: "no_recording" } }],
      leftPerCheck: ["b"],
    });
  });

  it("lets the least trusted answer name the state when one test used both, and lists each answer once whatever the order of the calls", () => {
    const calls = [recorded(100), faked(200), faked(300), recorded(400), recorded(500, "model-a", "2026-10-01")];
    const forward = attributeTests(input([test("a", 0, 1000)], calls));
    const backward = attributeTests(input([test("a", 0, 1000)], [...calls].reverse()));
    expect(forward).toEqual(backward);
    if (forward.mode !== "per_test") throw new Error("expected per test");
    expect(forward.records[0]!.uses).toEqual([
      { source: "faked", dependency: "bucket-a" },
      { source: "recorded", dependency: "model-a", recordedOn: "2026-10-01" },
      { source: "recorded", dependency: "model-a", recordedOn: "2026-11-12" },
    ]);
    expect(testResultState(forward.records[0]!)).toBe("passed_faked");
  });

  it("accepts calls given out of order and a test list given out of order, and does not change what it was given", () => {
    const tests = [test("c", 4000, 5000), test("a", 0, 1000), test("b", 2000, 3000)];
    const calls = [recorded(4500), faked(500), faked(2500)];
    const before = JSON.stringify([tests, calls]);
    const result = attributeTests(input(tests, calls));
    expect(JSON.stringify([tests, calls])).toBe(before);
    if (result.mode !== "per_test") throw new Error("expected per test");
    expect(result.records.map((record) => [record.testId, record.uses[0]!.source])).toEqual([["c", "recorded"], ["a", "faked"], ["b", "faked"]]);
  });

  it("only ever returns records the shared record schema accepts", () => {
    const result = attributeTests(input(serial(), [faked(500), recorded(2500), recorded(4500)]));
    if (result.mode !== "per_test") throw new Error("expected per test");
    expect(TestAnswerRecordsSchema.safeParse(result.records).success).toBe(true);
  });
});

describe("falls back to per check, with one fixed reason, and never guesses", () => {
  it("no_times: a run test with a missing, non-finite or backwards window", () => {
    expect(reasonOf(input([{ id: "a", status: "passed" }, test("b", 2000, 3000)], [faked(2500)]))).toBe("no_times");
    expect(reasonOf(input([{ id: "a", status: "passed", startMs: 0 }], []))).toBe("no_times");
    expect(reasonOf(input([test("a", Number.NaN, 1000)], []))).toBe("no_times");
    expect(reasonOf(input([test("a", 0, Number.POSITIVE_INFINITY)], []))).toBe("no_times");
    expect(reasonOf(input([test("a", 1000, 0)], []))).toBe("no_times");
    expect(reasonOf(input([{ id: "a", status: "passed", startMs: "0" as unknown as number, endMs: 10 }], []))).toBe("no_times");
    expect(reasonOf(input([test("a", 0, 1000, "failed"), { id: "b", status: "failed" }], []))).toBe("no_times");
  });
  it("no_times: no test at all, so there is nothing to tie a call to", () => {
    expect(reasonOf(input([], []))).toBe("no_times");
    expect(reasonOf(input([], [faked(10)]))).toBe("no_times");
  });

  it("parallel: windows that overlap, one inside another, or the same", () => {
    expect(reasonOf(input([test("a", 0, 1000), test("b", 999, 3000)], [faked(500)]))).toBe("parallel");
    expect(reasonOf(input([test("a", 0, 5000), test("b", 1000, 2000), test("c", 6000, 7000)], [faked(6500)]))).toBe("parallel");
    expect(reasonOf(input([test("a", 0, 1000), test("b", 0, 1000)], []))).toBe("parallel");
    expect(reasonOf(input([test("b", 500, 1500), test("a", 0, 1000)], []))).toBe("parallel");
  });
  it("parallel: a later window that overlaps the second window but not the first is found (the latest end, not the first, is what counts)", () => {
    expect(reasonOf(input([test("a", 0, 100), test("b", 100, 5000), test("c", 2000, 3000)], []))).toBe("parallel");
    expect(reasonOf(input([test("c", 2000, 3000), test("a", 0, 100), test("b", 100, 5000)], []))).toBe("parallel");
  });
  it("two zero-length windows at the same instant leave a later call to the one test that really contains it (reviewer probe 7)", () => {
    const result = attributeTests(input([test("z1", 100, 100), test("z2", 100, 100), test("b", 100, 1000)], [faked(500)]));
    if (result.mode !== "per_test") throw new Error("expected per test");
    expect(result.records.map((record) => record.testId)).toEqual(["b"]);
  });
  it("windows that only touch are serial (the guard band decides about calls at the shared edge)", () => {
    const result = attributeTests(input([test("a", 0, 1000), test("b", 1000, 2000)], [faked(500), recorded(1500)]));
    expect(result.mode).toBe("per_test");
  });
  it("a test that was not run but carries a window still counts for overlap: it may have run alongside a passing test, and calls cannot be told apart (reviewer probe 1)", () => {
    const notRun: AttributionTest = { id: "n", status: "not_run", startMs: 0, endMs: 5000, notRun: { dependency: "model-a", reason: "no_recording" } };
    expect(reasonOf(input([notRun, test("a", 100, 1000)], [recorded(500, "bucket", "2026-11-01")]))).toBe("parallel");
    expect(reasonOf(input([test("a", 100, 1000), { ...notRun, startMs: 500, endMs: 1500 }], []))).toBe("parallel");
  });
  it("a call inside a not-run test's window is ambiguous: that test called nothing, so the call belongs to something Rovara cannot name", () => {
    const notRun: AttributionTest = { id: "n", status: "not_run", startMs: 2000, endMs: 3000, notRun: { dependency: "model-a", reason: "no_recording" } };
    expect(reasonOf(input([test("a", 0, 1000), notRun], [faked(2500)]))).toBe("ambiguous_timing");
    const ok = attributeTests(input([test("a", 0, 1000), notRun], [faked(500)]));
    expect(ok.mode).toBe("per_test");
  });
  it("a test that was not run with no usable window (none, one end, not finite, backwards) takes no part in the join", () => {
    const base = { id: "n", status: "not_run" as const, notRun: { dependency: "model-a", reason: "no_recording" as const } };
    for (const times of [{}, { startMs: 0 }, { startMs: Number.NaN, endMs: 5000 }, { startMs: 5000, endMs: 0 }]) expect(attributeTests(input([{ ...base, ...times }, test("a", 100, 1000)], [faked(500)])).mode).toBe("per_test");
  });

  it("ambiguous_timing: a call within the guard band of a window edge, either edge, and exactly at the band is attributed", () => {
    expect(reasonOf(input([test("a", 1000, 2000)], [faked(1000 + GUARD - 1)]))).toBe("ambiguous_timing");
    expect(reasonOf(input([test("a", 1000, 2000)], [faked(2000 - GUARD + 1)]))).toBe("ambiguous_timing");
    expect(reasonOf(input([test("a", 1000, 2000)], [faked(1000)]))).toBe("ambiguous_timing");
    expect(reasonOf(input([test("a", 1000, 2000)], [faked(2000)]))).toBe("ambiguous_timing");
    expect(attributeTests(input([test("a", 1000, 2000)], [faked(1000 + GUARD)])).mode).toBe("per_test");
    expect(attributeTests(input([test("a", 1000, 2000)], [faked(2000 - GUARD)])).mode).toBe("per_test");
  });
  it("ambiguous_timing: a window shorter than two guard bands has no call far enough inside it, even at its midpoint (the guard is never shrunk to fit)", () => {
    expect(reasonOf(input([test("a", 0, 60)], [faked(30)]))).toBe("ambiguous_timing");
    expect(reasonOf(input([test("a", 0, 99)], [faked(49)]))).toBe("ambiguous_timing");
    expect(attributeTests(input([test("a", 0, 100)], [faked(50)])).mode).toBe("per_test");
  });
  it("ambiguous_timing: the guard band is data, not a constant", () => {
    expect(attributeTests(input([test("a", 1000, 2000)], [faked(1100)], { guardMs: 100 })).mode).toBe("per_test");
    expect(reasonOf(input([test("a", 1000, 2000)], [faked(1100)], { guardMs: 101 }))).toBe("ambiguous_timing");
  });
  it("ambiguous_timing: a call at the edge shared by two touching windows belongs to neither", () => {
    expect(reasonOf(input([test("a", 0, 1000), test("b", 1000, 2000)], [faked(1000)]))).toBe("ambiguous_timing");
    expect(reasonOf(input([test("a", 0, 1000), test("b", 1000, 2000)], [faked(1020)]))).toBe("ambiguous_timing");
  });
  it("ambiguous_timing: a call outside every window is not given to the nearest test; it makes the whole check per check", () => {
    expect(reasonOf(input(serial(), [faked(1500)]))).toBe("ambiguous_timing");
    expect(reasonOf(input(serial(), [faked(-5000)]))).toBe("ambiguous_timing");
    expect(reasonOf(input(serial(), [faked(99_000)]))).toBe("ambiguous_timing");
    expect(reasonOf(input(serial(), [faked(500), faked(1990)]))).toBe("ambiguous_timing");
    expect(reasonOf(input([{ ...test("n", 0, 10_000, "not_run"), notRun: { dependency: "model-a", reason: "no_recording" } }], [faked(500)]))).toBe("ambiguous_timing");
  });

  it("ledger_incomplete: a gap in the ledger or a dropped ring (the caller says so), even when everything else is clean", () => {
    expect(reasonOf(input(serial(), [faked(500)], { ledgerComplete: false }))).toBe("ledger_incomplete");
    expect(reasonOf(input(serial(), [], { ledgerComplete: false }))).toBe("ledger_incomplete");
    expect(reasonOf(input(serial(), [faked(500)], { ledgerComplete: undefined as unknown as boolean }))).toBe("ledger_incomplete");
    expect(reasonOf(input(serial(), [faked(500)], { ledgerComplete: "true" as unknown as boolean }))).toBe("ledger_incomplete");
  });

  it("no_call_times: a faked or recorded answer that carries no call time (every in-process fake today) makes the whole check per check", () => {
    expect(reasonOf(input(serial(), [faked(500), { dependency: "bucket-b", source: "faked" }]))).toBe("no_call_times");
    expect(reasonOf(input(serial(), [{ dependency: "bucket-b", source: "recorded", recordedOn: "2026-11-12" }]))).toBe("no_call_times");
    expect(reasonOf(input(serial(), [faked(Number.NaN)]))).toBe("no_call_times");
    expect(reasonOf(input(serial(), [faked(Number.POSITIVE_INFINITY)]))).toBe("no_call_times");
    expect(reasonOf(input(serial(), [{ ...faked(500), atMs: "500" as unknown as number }]))).toBe("no_call_times");
  });

  it("no_call_times: an in-process fake or a fake's usage count has no per-call times, so a check that used any is per check (the caller must say)", () => {
    expect(reasonOf(input(serial(), [faked(500)], { untimedFakeDependencies: ["queue-a"] }))).toBe("no_call_times");
    expect(reasonOf(input(serial(), [], { untimedFakeDependencies: ["queue-a", "queue-b"] }))).toBe("no_call_times");
    expect(attributeTests(input(serial(), [faked(500)], { untimedFakeDependencies: [] })).mode).toBe("per_test");
  });
  it("bad_input: the list of untimed fakes is required, and must be a list of names (a missing value fails closed, never reads as none)", () => {
    for (const untimedFakeDependencies of [undefined, null, "queue-a", { length: 0 }, [42], [""], ["bad\nname"]]) expect(reasonOf(input(serial(), [faked(500)], { untimedFakeDependencies: untimedFakeDependencies as unknown as string[] }))).toBe("bad_input");
    const missing: Partial<AttributionInput> = { tests: serial(), calls: [faked(500)], ledgerComplete: true, guardMs: GUARD };
    expect(reasonOf(missing as AttributionInput)).toBe("bad_input");
  });

  it("uses the same reason word for the same cause every time, from the fixed list, with plain words for each", () => {
    expect([...PER_CHECK_REASONS].sort()).toEqual(["ambiguous_timing", "bad_input", "duplicate_ids", "ledger_incomplete", "no_call_times", "no_times", "parallel", "too_many"]);
    expect(PER_CHECK_REASON_WORDS.parallel).toBe("tests ran in parallel");
    expect(PER_CHECK_REASON_WORDS.duplicate_ids).toBe("two tests share one id");
    for (const reason of PER_CHECK_REASONS) expect(PER_CHECK_REASON_WORDS[reason]).toMatch(/^[a-z][a-z ,'-]{5,60}$/u);
  });
});

describe("input it cannot trust fails to per check, never to a guess and never with a throw", () => {
  it("bad_input: a guard that is not a finite number, or is below the floor (a tiny guard would pass any clock skew as a clean attribution; reviewer probe 3)", () => {
    expect(ATTRIBUTION_GUARD_MIN_MS).toBe(50);
    for (const guardMs of [0, -1, 1e-9, 1, ATTRIBUTION_GUARD_MIN_MS - 1, Number.NaN, Number.POSITIVE_INFINITY, "50" as unknown as number, undefined as unknown as number]) expect(reasonOf(input(serial(), [faked(500)], { guardMs }))).toBe("bad_input");
    expect(attributeTests(input(serial(), [faked(500)], { guardMs: ATTRIBUTION_GUARD_MIN_MS })).mode).toBe("per_test");
  });
  it("bad_input: a test id or dependency the record contract refuses (hidden characters, empty, too long), a source that is not faked or recorded, a recording with no date", () => {
    expect(reasonOf(input([test("bad\nid", 0, 1000)], [faked(500)]))).toBe("bad_input");
    expect(reasonOf(input([test("evil‮id", 0, 1000)], [faked(500)]))).toBe("bad_input");
    expect(reasonOf(input([test("", 0, 1000)], []))).toBe("bad_input");
    expect(reasonOf(input([test("x".repeat(201), 0, 1000)], []))).toBe("bad_input");
    expect(reasonOf(input(serial(), [faked(500, "bad\ndependency")]))).toBe("bad_input");
    expect(reasonOf(input(serial(), [faked(500, "d".repeat(81))]))).toBe("bad_input");
    expect(reasonOf(input(serial(), [{ atMs: 500, dependency: "x", source: "real" as unknown as "faked" }]))).toBe("bad_input");
    expect(reasonOf(input(serial(), [{ atMs: 500, dependency: "x", source: "recorded" }]))).toBe("bad_input");
    expect(reasonOf(input(serial(), [recorded(500, "x", "yesterday")]))).toBe("bad_input");
  });
  it("duplicate_ids: two tests with the same id (a record could not say which one it is) have their own reason, not bad_input", () => {
    expect(reasonOf(input([test("a", 0, 1000), test("a", 2000, 3000)], [faked(500)]))).toBe("duplicate_ids");
    expect(reasonOf(input([test("a", 0, 1000), { id: "a", status: "not_run", notRun: { dependency: "m", reason: "no_recording" } }], []))).toBe("duplicate_ids");
  });
  it("bad_input: a status that is not one of the three, a not-run test with no reason", () => {
    expect(reasonOf(input([{ ...test("a", 0, 1000), status: "skipped" as unknown as "passed" }], []))).toBe("bad_input");
    expect(reasonOf(input([{ id: "a", status: "not_run" }], []))).toBe("bad_input");
    expect(reasonOf(input([{ ...test("a", 0, 1000), notRun: { dependency: "x", reason: "no_recording" } }], []))).toBe("bad_input");
  });
  it("bad_input: lists that are not lists, entries that are not objects", () => {
    expect(reasonOf({ tests: "abc" as unknown as AttributionTest[], calls: [], ledgerComplete: true, guardMs: GUARD, untimedFakeDependencies: [] })).toBe("bad_input");
    expect(reasonOf({ tests: serial(), calls: null as unknown as AttributionCall[], ledgerComplete: true, guardMs: GUARD, untimedFakeDependencies: [] })).toBe("bad_input");
    expect(reasonOf(input([null as unknown as AttributionTest], []))).toBe("bad_input");
    expect(reasonOf(input(serial(), [42 as unknown as AttributionCall]))).toBe("bad_input");
  });
  it("never throws: a getter that throws anywhere in the input is bad_input (reviewer probe 4)", () => {
    const boom = (target: object, key: string): object => Object.defineProperty(target, key, { get() { throw new Error("boom"); }, enumerable: true });
    expect(reasonOf(input([boom({ status: "passed", startMs: 0, endMs: 10 }, "id") as AttributionTest], []))).toBe("bad_input");
    expect(reasonOf(input([test("a", 0, 1000)], [boom({ dependency: "d", source: "faked" }, "atMs") as AttributionCall]))).toBe("bad_input");
    expect(reasonOf(boom({ tests: serial(), calls: [], untimedFakeDependencies: [], guardMs: GUARD }, "ledgerComplete") as AttributionInput)).toBe("bad_input");
    expect(reasonOf(boom({ tests: [], calls: [], untimedFakeDependencies: [], ledgerComplete: true }, "guardMs") as AttributionInput)).toBe("bad_input");
    expect(reasonOf(input([test("a", 0, 1000)], [], { untimedFakeDependencies: new Proxy([], { get() { throw new Error("boom"); } }) }))).toBe("bad_input");
  });
  it("reads only the object's own keys: a __proto__ key in parsed JSON does not supply a missing ledger flag or change a status (reviewer probe 5)", () => {
    const parsed = JSON.parse('{"tests":[{"id":"a","status":"passed","startMs":0,"endMs":1000,"__proto__":{"status":"failed"}}],"calls":[{"atMs":500,"dependency":"d","source":"faked","__proto__":{"atMs":1}}],"untimedFakeDependencies":[],"guardMs":50,"__proto__":{"ledgerComplete":true}}') as AttributionInput;
    expect(reasonOf(parsed)).toBe("ledger_incomplete");
    const withFlag = JSON.parse('{"tests":[{"id":"a","status":"passed","startMs":0,"endMs":1000,"__proto__":{"status":"failed"}}],"calls":[{"atMs":500,"dependency":"d","source":"faked","__proto__":{"atMs":1}}],"untimedFakeDependencies":[],"guardMs":50,"ledgerComplete":true}') as AttributionInput;
    expect(attributeTests(withFlag)).toEqual({ mode: "per_test", records: [{ testId: "a", status: "passed", uses: [{ source: "faked", dependency: "d" }] }], leftPerCheck: [] });
  });
  it("is safe with ids like __proto__ and constructor, which are only ever plain strings here", () => {
    const result = attributeTests(input([test("__proto__", 0, 1000), test("constructor", 2000, 3000)], [faked(500, "__proto__"), faked(2500, "constructor")]));
    if (result.mode !== "per_test") throw new Error("expected per test");
    expect(result.records.map((record) => [record.testId, record.uses[0]!.dependency])).toEqual([["__proto__", "__proto__"], ["constructor", "constructor"]]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("too_many: a test with more distinct answers than a record can carry is per check, not cut short (16 are fine)", () => {
    const calls = (count: number) => Array.from({ length: count }, (_, index) => faked(100 + index, `dep-${String(index)}`));
    const ok = attributeTests(input([test("a", 0, 5000)], calls(TEST_ANSWER_USES_MAX)));
    expect(ok.mode).toBe("per_test");
    expect(reasonOf(input([test("a", 0, 5000)], calls(TEST_ANSWER_USES_MAX + 1)))).toBe("too_many");
  });
  it("too_many: more than the contract's tests or 10,000 calls (the stated maximums themselves work)", () => {
    expect(ATTRIBUTION_CALLS_MAX).toBe(10_000);
    const tests = (count: number) => Array.from({ length: count }, (_, index) => test(`t${String(index)}`, index * 1000, index * 1000 + 900));
    expect(attributeTests(input(tests(TEST_ANSWER_RECORDS_MAX), [])).mode).toBe("per_test");
    expect(reasonOf(input(tests(TEST_ANSWER_RECORDS_MAX + 1), []))).toBe("too_many");
    const sameTest = (count: number) => Array.from({ length: count }, () => faked(500));
    expect(attributeTests(input([test("a", 0, 1000)], sameTest(ATTRIBUTION_CALLS_MAX))).mode).toBe("per_test");
    expect(reasonOf(input([test("a", 0, 1000)], sameTest(ATTRIBUTION_CALLS_MAX + 1)))).toBe("too_many");
  });

  it("joins 5,000 tests and 10,000 calls in well under a second or two (sort once, sweep)", () => {
    const tests = Array.from({ length: TEST_ANSWER_RECORDS_MAX }, (_, index) => test(`t${String(index)}`, index * 1000, index * 1000 + 900));
    const calls = Array.from({ length: ATTRIBUTION_CALLS_MAX }, (_, index) => faked(((index * 2_654_435_761) % TEST_ANSWER_RECORDS_MAX) * 1000 + 450, `dep-${String(index % 7)}`));
    const started = performance.now();
    const result = attributeTests(input(tests, calls));
    expect(performance.now() - started).toBeLessThan(2000);
    if (result.mode !== "per_test") throw new Error("expected per test");
    expect(result.records.length + result.leftPerCheck.length).toBe(TEST_ANSWER_RECORDS_MAX);
    expect(TestAnswerRecordsSchema.safeParse(result.records).success).toBe(true);
  });
});

describe("what a ledger entry says beyond a dependency id never reaches the result", () => {
  it("copies only the dependency id, the source and the recording day: a canary in any other field is nowhere in the output", () => {
    const canary = `op-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    const noisy = { ...faked(500), operation: canary, path: `/${canary}`, detail: canary, marker: canary } as AttributionCall;
    const noisyTest = { ...test("a", 0, 1000), log: canary } as AttributionTest;
    const result = attributeTests(input([noisyTest, test("b", 2000, 3000)], [noisy, recorded(2500)]));
    expect(result.mode).toBe("per_test");
    expect(JSON.stringify(result)).not.toContain(canary);
    const refused = attributeTests(input([noisyTest], [{ ...noisy, atMs: 99_999 }]));
    expect(JSON.stringify(refused)).not.toContain(canary);
  });
});

describe("no callers yet (Part A is the pure join only)", () => {
  it("nothing outside packages/contracts uses the module's exports", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const text = readFileSync(`${root}/packages/contracts/src/test-attribution.ts`, "utf8");
    const names = [...text.matchAll(/^export (?:declare )?(?:const|function|type|interface|class) ([A-Za-z0-9_]+)/gmu)].map((match) => match[1]!);
    expect(names).toEqual(expect.arrayContaining(["attributeTests", "PER_CHECK_REASONS", "ATTRIBUTION_CALLS_MAX", "AttributionInput"]));
    const found = spawnSync("git", ["grep", "--untracked", "-lw", ...names.flatMap((name) => ["-e", name]), "--", "packages", "scripts", "infra"], { encoding: "utf8", cwd: root });
    expect([0, 1]).toContain(found.status);
    expect(found.stdout.split("\n").filter((entry) => entry !== "" && !entry.startsWith("packages/contracts/"))).toEqual([]);
  });
});
