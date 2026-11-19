// Per-test labels for faked and recorded answers: a test that passed against a faked or recorded answer is reported in its own state, apart from "passed", and a test that could not run for want of a recording is "not run", by
// name, with the reason. Generic on purpose: nothing here is SageMaker's.
import { describe, expect, it } from "vitest";
import {
  TEST_RESULT_STATES, TEST_RESULT_STATE_WORDS, TestAnswerRecordSchema, TestAnswerRecordsSchema, testAnswerSummaryLines, testRecordedOn, testResultState, type TestAnswerRecord,
} from "../../packages/contracts/src/index.js";

const passed = (testId: string, uses: TestAnswerRecord["uses"] = []): TestAnswerRecord => ({ testId, status: "passed", uses });
const faked = (dependency = "fraud-scorer") => ({ source: "faked" as const, dependency });
const recorded = (recordedOn: string, dependency = "fraud-scorer") => ({ source: "recorded" as const, dependency, recordedOn });
const notRun = (testId: string, dependency = "fraud-scorer"): TestAnswerRecord => ({ testId, status: "not_run", uses: [], notRun: { dependency, reason: "no_recording" } });

describe("a test's result state", () => {
  it("keeps `passed` for a test that no faked or recorded answer stood behind", () => {
    expect(testResultState(passed("a"))).toBe("passed");
  });
  it("gives a test that passed against a faked answer its own state, and one against a recording its own, apart from passed", () => {
    expect(testResultState(passed("a", [faked()]))).toBe("passed_faked");
    expect(testResultState(passed("a", [recorded("2026-11-20")]))).toBe("passed_recorded");
    expect(new Set(["passed", "passed_faked", "passed_recorded"]).size).toBe(3);
  });
  it("lets the least trusted answer name the state, and the oldest recording name the date", () => {
    expect(testResultState(passed("a", [recorded("2026-11-20"), faked("other")]))).toBe("passed_faked");
    expect(testRecordedOn(passed("a", [recorded("2026-11-20"), recorded("2026-10-02", "other")]))).toBe("2026-10-02");
    expect(testRecordedOn(passed("a", [faked()]))).toBeUndefined();
  });
  it("calls a test that failed failed, whatever answered it, and a test that was not run not run (no recording)", () => {
    expect(testResultState({ testId: "a", status: "failed", uses: [faked()] })).toBe("failed");
    expect(testResultState(notRun("a"))).toBe("not_run_no_recording");
    expect(TEST_RESULT_STATE_WORDS.not_run_no_recording).toBe("not run (no recording)");
    expect(TEST_RESULT_STATE_WORDS.passed_faked).toBe("passed against faked answers");
    expect(TEST_RESULT_STATE_WORDS.passed_recorded).toBe("passed against recorded answers");
    expect(TEST_RESULT_STATES.every((state) => TEST_RESULT_STATE_WORDS[state].length > 0)).toBe(true);
  });
});

describe("the record the worker fills", () => {
  it("accepts a record of each kind, and refuses the shapes that would say something untrue", () => {
    for (const record of [passed("a"), passed("a", [faked(), recorded("2026-11-20")]), notRun("a")]) expect(TestAnswerRecordSchema.safeParse(record).success).toBe(true);
    expect(TestAnswerRecordSchema.safeParse({ ...notRun("a"), notRun: undefined }).success).toBe(false);
    expect(TestAnswerRecordSchema.safeParse({ ...passed("a"), notRun: { dependency: "x", reason: "no_recording" } }).success).toBe(false);
    expect(TestAnswerRecordSchema.safeParse({ ...notRun("a"), uses: [faked()] }).success).toBe(false);
    expect(TestAnswerRecordSchema.safeParse(passed("a", [{ source: "recorded", dependency: "x" } as never])).success).toBe(false);
    expect(TestAnswerRecordSchema.safeParse(passed("a", [{ source: "real", dependency: "x" } as never])).success).toBe(false);
    expect(TestAnswerRecordSchema.safeParse({ ...passed("a"), body: "{}" }).success).toBe(false);
    expect(TestAnswerRecordSchema.safeParse(passed("bad\nid")).success).toBe(false);
    expect(TestAnswerRecordsSchema.safeParse(Array.from({ length: 5_001 }, (_, index) => passed(`t${String(index)}`))).success).toBe(false);
  });
});

describe("the pull request lines", () => {
  const options = { service: "SageMaker", realThing: "model output" };

  it("says how many tests passed against faked answers, naming them, in the fixed words", () => {
    const records = Array.from({ length: 12 }, (_, index) => passed(`test_${String(index + 1)}`, [faked()]));
    expect(testAnswerSummaryLines(records, options)).toEqual(["12 tests passed against faked SageMaker answers (not real model output): test_1, test_2, test_3, test_4, test_5, and 7 more"]);
    expect(testAnswerSummaryLines([passed("only", [faked()])], options)).toEqual(["1 test passed against faked SageMaker answers (not real model output): only"]);
  });
  it("gives each recording date its own line, and carries the date", () => {
    const lines = testAnswerSummaryLines([passed("b", [recorded("2026-11-20")]), passed("a", [recorded("2026-10-02")]), passed("c", [recorded("2026-11-20")])], options);
    expect(lines).toEqual([
      "1 test passed against recorded SageMaker answers (recorded 2026-10-02; not real model output): a",
      "2 tests passed against recorded SageMaker answers (recorded 2026-11-20; not real model output): b, c",
    ]);
  });
  it("lists tests that were not run, with the dependency that had no recording", () => {
    expect(testAnswerSummaryLines([notRun("x"), notRun("y"), notRun("z")], options)).toEqual(["3 tests not run: no recording for endpoint fraud-scorer (tests: x, y, z)"]);
    expect(testAnswerSummaryLines([notRun("x", "a-one"), notRun("y", "b-two")], options)).toEqual(["2 tests not run: no recording for endpoints a-one, b-two (tests: x, y)"]);
  });
  it("puts faked first, then recorded, then not run, and says nothing for tests that really passed or failed", () => {
    const lines = testAnswerSummaryLines([passed("real"), { testId: "bad", status: "failed", uses: [faked()] }, notRun("n"), passed("r", [recorded("2026-11-20")]), passed("f", [faked()])], options);
    expect(lines.map((line) => line.split(" ").slice(2, 5).join(" "))).toEqual(["passed against faked", "passed against recorded", "not run: no"]);
    expect(testAnswerSummaryLines([passed("real")], options)).toEqual([]);
    expect(testAnswerSummaryLines([], options)).toEqual([]);
  });
  it("is generic: another service, thing and noun fill the same words", () => {
    expect(testAnswerSummaryLines([passed("t", [faked("claude-sonnet")])], { service: "Bedrock" })).toEqual(["1 test passed against faked Bedrock answers (not real output): t"]);
    expect(testAnswerSummaryLines([notRun("t", "claude-sonnet")], { service: "Bedrock", dependencyNoun: "model" })).toEqual(["1 test not run: no recording for model claude-sonnet (tests: t)"]);
  });
  it("makes test ids and names plain, because they come from a repository", () => {
    const hostile = "evil‮\nid " + "x".repeat(200);
    const [line] = testAnswerSummaryLines([passed(hostile, [faked()])], { service: "S\nS" });
    expect(line).not.toMatch(/[\n‮]/u);
    expect(line!.length).toBeLessThan(260);
    expect(line).toContain("...");
  });
});
