// Per-test attribution (TE-A6 Part A): the pure join that says which faked or recorded answers each test of one check used, per test only where Rovara can prove it, otherwise per check.
// Why: "Recorded 38 · Simulated 251" is a per-check fact today. A per-test label is only honest when the time of each call can be tied to exactly one test, so every doubt falls back to per check, with one fixed
// reason word, and no per-test number is ever made up.
//
// What it does, and does not:
//   - It joins timed calls (when each faked or recorded answer was given, which dependency, which source) to timed tests (each test's start and end). It reads nothing but numbers, a dependency id, a source and a
//     recording day: a ledger entry's operation, path or any other field is never copied (and so can never reach a log, a line or the agent).
//   - It says nothing about "Real" or "No outside calls". A passing test that no faked or recorded call was tied to is NOT given a record (a record with no uses reads as a real pass, which Rovara cannot prove):
//     it is listed in `leftPerCheck` and keeps its per-check label.
//   - It never decides a trust class. Classes come from the pinned plan's dependency backing in the engine (a later part); this only says which dependencies answered which test, in `TestAnswerRecord`'s own terms
//     (faked beats recorded beats real is `testResultState`'s rule, not repeated here).
//
// Per test only when ALL hold; else per check with the first reason that applies (this order):
//   too_many           more tests than `TEST_ANSWER_RECORDS_MAX`, more calls than `ATTRIBUTION_CALLS_MAX`, or one test with more distinct answers than a record carries (`TEST_ANSWER_USES_MAX`): nothing is cut short
//   bad_input          a guard that is not a positive number, ids or dependency names the record contract refuses, an unknown source, a recording without a day, two tests with one id, anything not a list or object
//   ledger_incomplete  the caller could not show that the call ledger slice is whole (a gap in its sequence, or its ring dropped entries): only exactly `true` passes
//   no_call_times      a faked or recorded answer with no call time (every in-process fake today)
//   no_times           no test, or a test that ran without a finite start and end (end before start included)
//   parallel           two windows overlap (touching is fine): the tests did not run one after another
//   ambiguous_timing   a call is outside every window, or closer than `guardMs` to its window's edge
// Tests that were not run (`not_run`) call nothing: they need no window and are carried through with the reason the caller gave.
// Bounded: at most 5,000 tests and 10,000 calls; sorts once and sweeps. Nothing here imports a Node module.
import { TEST_ANSWER_RECORDS_MAX, TEST_ANSWER_USES_MAX, TestAnswerRecordSchema, TestAnswerUseSchema, type TestAnswerRecord, type TestAnswerUse, type TestNotRun } from "./test-answer-labels.js";

export const ATTRIBUTION_CALLS_MAX = 10_000;

export const PER_CHECK_REASONS = ["too_many", "bad_input", "ledger_incomplete", "no_call_times", "no_times", "parallel", "ambiguous_timing"] as const;
export type PerCheckReason = (typeof PER_CHECK_REASONS)[number];
/** The words after "per check:" in a line such as "Recorded 38 · Simulated 251 (per check: tests ran in parallel)". */
export const PER_CHECK_REASON_WORDS: Record<PerCheckReason, string> = {
  too_many: "too many tests or answers to tell apart",
  bad_input: "the test report could not be used",
  ledger_incomplete: "the call log was not whole",
  no_call_times: "some answers carry no call time",
  no_times: "the tests carry no run times",
  parallel: "tests ran in parallel",
  ambiguous_timing: "a call could not be tied to one test",
};

export interface AttributionTest {
  /** The test runner's id for the test. */
  id: string;
  status: "passed" | "failed" | "not_run";
  /** Epoch milliseconds, from the test report. Needed for a test that was run (passed or failed). */
  startMs?: number;
  endMs?: number;
  /** For a test that was not run: the dependency that had no answer. Given by the caller, from the ledger's own marker; never set for a test that ran. */
  notRun?: TestNotRun;
}
export interface AttributionCall {
  /** Epoch milliseconds the answer was given. Missing for a fake that keeps no per-call times: the whole check is then per check. */
  atMs?: number;
  /** The dependency id from the round's pinned plan, never the ledger's own words. */
  dependency: string;
  source: "faked" | "recorded";
  /** The day a recording was made (`YYYY-MM-DD`); required for `recorded`. */
  recordedOn?: string;
}
export interface AttributionInput {
  tests: readonly AttributionTest[];
  calls: readonly AttributionCall[];
  /** True only when the ledger slice for this check is whole: no gap in its sequence and no dropped entries. */
  ledgerComplete: boolean;
  /** How far, in milliseconds, a call must be from a window's edge to count for that test. Data, not a constant. */
  guardMs: number;
}
export type TestAttribution =
  | {
      mode: "per_test";
      /** Failed tests, tests not run, and passing tests with at least one faked or recorded answer tied to them, in the order the tests were given. */
      records: TestAnswerRecord[];
      /** Passing tests no faked or recorded call was tied to: they keep the per-check label (a record with no uses would read as a real pass). */
      leftPerCheck: string[];
    }
  | { mode: "per_check"; reason: PerCheckReason };

const perCheck = (reason: PerCheckReason): TestAttribution => ({ mode: "per_check", reason });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

interface Window { index: number; start: number; end: number }

/** Joins one check's timed calls to its timed tests. See the header for the rules and the fixed reasons. Never throws. */
export function attributeTests(input: AttributionInput): TestAttribution {
  if (!isRecord(input) || !Array.isArray(input.tests) || !Array.isArray(input.calls)) return perCheck("bad_input");
  const tests: readonly AttributionTest[] = input.tests as readonly AttributionTest[];
  const calls: readonly AttributionCall[] = input.calls as readonly AttributionCall[];
  if (tests.length > TEST_ANSWER_RECORDS_MAX || calls.length > ATTRIBUTION_CALLS_MAX) return perCheck("too_many");
  if (!finite(input.guardMs) || input.guardMs <= 0) return perCheck("bad_input");

  // Shape: every test and every call is read once, through the record contract's own rules, before anything is joined.
  const seenIds = new Set<string>();
  for (const entry of tests as readonly unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== "string" || seenIds.has(entry.id)) return perCheck("bad_input");
    seenIds.add(entry.id);
    const shape = TestAnswerRecordSchema.safeParse({ testId: entry.id, status: entry.status, uses: [], ...(entry.notRun === undefined ? {} : { notRun: entry.notRun }) });
    if (!shape.success) return perCheck("bad_input");
  }
  const uses: (TestAnswerUse | undefined)[] = [];
  for (const entry of calls as readonly unknown[]) {
    if (!isRecord(entry)) return perCheck("bad_input");
    const use = TestAnswerUseSchema.safeParse(entry.source === "recorded" ? { source: "recorded", dependency: entry.dependency, recordedOn: entry.recordedOn } : { source: entry.source, dependency: entry.dependency });
    if (!use.success) return perCheck("bad_input");
    uses.push(use.data);
  }

  if (input.ledgerComplete !== true) return perCheck("ledger_incomplete");
  if (calls.some((call) => !finite(call.atMs))) return perCheck("no_call_times");
  if (tests.length === 0) return perCheck("no_times");

  const windows: Window[] = [];
  for (const [index, test] of tests.entries()) {
    if (test.status === "not_run") continue;
    if (!finite(test.startMs) || !finite(test.endMs) || test.endMs < test.startMs) return perCheck("no_times");
    windows.push({ index, start: test.startMs, end: test.endMs });
  }
  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  let latestEnd = Number.NEGATIVE_INFINITY;
  for (const window of windows) {
    if (window.start < latestEnd) return perCheck("parallel");
    latestEnd = window.end; // a window that did not start before the last one ended also ends no earlier (end >= start was checked), so the last end is the latest
  }

  // Sweep: calls in time order against windows in time order. A call belongs to a test only when it lies at least `guardMs` inside that test's window.
  const order = Array.from(calls.keys()).sort((a, b) => (calls[a]!.atMs as number) - (calls[b]!.atMs as number));
  const byTest = new Map<number, Map<string, TestAnswerUse>>();
  let current = 0;
  for (const callIndex of order) {
    const at = calls[callIndex]!.atMs as number;
    while (current + 1 < windows.length && windows[current + 1]!.start <= at) current += 1;
    const window = windows[current];
    if (window === undefined || at < window.start + input.guardMs || at > window.end - input.guardMs) return perCheck("ambiguous_timing");
    const use = uses[callIndex]!;
    const key = `${use.source}\u0000${use.dependency}\u0000${use.source === "recorded" ? use.recordedOn : ""}`;
    const own = byTest.get(window.index) ?? new Map<string, TestAnswerUse>();
    own.set(key, use);
    byTest.set(window.index, own);
  }

  const records: TestAnswerRecord[] = [];
  const leftPerCheck: string[] = [];
  for (const [index, test] of tests.entries()) {
    const own = [...(byTest.get(index)?.values() ?? [])].sort(compareUses);
    if (own.length > TEST_ANSWER_USES_MAX) return perCheck("too_many");
    if (test.status === "not_run") records.push({ testId: test.id, status: "not_run", uses: [], notRun: test.notRun! });
    else if (test.status === "failed") records.push({ testId: test.id, status: "failed", uses: own });
    else if (own.length === 0) leftPerCheck.push(test.id);
    else records.push({ testId: test.id, status: "passed", uses: own });
  }
  return { mode: "per_test", records, leftPerCheck };
}

/** Faked before recorded, then by dependency, then by recording day: the same answers always come out in the same order. */
function compareUses(a: TestAnswerUse, b: TestAnswerUse): number {
  if (a.source !== b.source) return a.source === "faked" ? -1 : 1;
  if (a.dependency !== b.dependency) return a.dependency < b.dependency ? -1 : 1;
  const left = a.source === "recorded" ? a.recordedOn : "";
  const right = b.source === "recorded" ? b.recordedOn : "";
  return left < right ? -1 : left > right ? 1 : 0;
}
