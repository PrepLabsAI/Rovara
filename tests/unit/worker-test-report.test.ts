// Proof and evidence P2: reading a check's own JUnit or vitest/jest JSON report into totals, names, new tests and skip counts. Fail closed: a file that is not a report, is empty, too big or holds no test is "not measured".
import { describe, expect, it } from "vitest";
import { expectLinearScaling } from "../support/scaling.js";
import { isValidTestId } from "@agentx/contracts";
import { EvidencePackSchema } from "../../packages/contracts/src/evidence.js";
import { absentOnNew, evidenceTests, originalRunLooksCut, untouchedCount, parseGoTestJson, parseJsonReport, parseJunit, plainName, skipRise, counted, skippedOutsideChanged, TEST_REPORT_MAX_TESTS } from "../../packages/worker/src/verification/test-report.js";

// A pytest --junitxml file, as pytest 8 writes it.
const PYTEST = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="5" time="0.30">
<testcase classname="tests.test_match" name="test_no_region" time="0.012"></testcase>
<testcase classname="tests.test_match" name="test_scores_partner" time="0.020"><failure message="assert 1 == 2">assert 1 == 2</failure></testcase>
<testcase classname="tests.test_rank" name="test_timeout" time="0.100"><error message="collection error">ImportError</error></testcase>
<testcase classname="tests.test_rank" name="test_slow" time="0.001"><skipped type="pytest.skip" message="slow">skip</skipped></testcase>
<testcase classname="tests.test_rank" name="test_top5[a &amp; b]" time="0.002"/>
</testsuite></testsuites>`;
const VITEST = JSON.stringify({ numTotalTests: 99, testResults: [
  { name: "/work/repo/src/match.test.ts", status: "passed", assertionResults: [{ fullName: "match scores a partner", status: "passed", duration: 12.4 }, { fullName: "match skips no region", status: "failed", duration: 3 }, { fullName: "match todo", status: "todo" }] },
  { name: "/work/repo/src/broken.test.ts", status: "failed", message: "Cannot find module", assertionResults: [] },
] });

describe("JUnit", () => {
  it("is not fooled by test-case-looking text inside CDATA or comments", () => {
    const text = '<testsuite><testcase name="real"><failure><![CDATA[<testcase name="fake"/></testcase>]]></failure></testcase><!-- <testcase name="hidden"/> --></testsuite>';
    const read = parseJunit(text)!;
    expect(read.total).toBe(1);
    expect(read.tests[0]).toMatchObject({ name: "real", status: "failed" });
  });
  it("reads a bare testsuite and numeric entities", () => {
    expect(parseJunit('<testsuite><testcase name="caf&#233; &#x1F600;"/></testsuite>')?.tests[0]?.name).toBe("café \u{1F600}");
    // A name is kept as the report wrote it (NH-1: the test's id is built from it); a control character or a lone surrogate in it makes the ID not valid, which is how it is kept out of every list that is matched.
    const odd = parseJunit('<testsuite><testcase name="bad &#0; &#xD800;"/></testsuite>')?.tests[0]?.name ?? "";
    expect(odd.startsWith("bad")).toBe(true);
    expect(isValidTestId(odd)).toBe(false);
  });
});

describe("JUnit written by a command the agent can influence", () => {
  it("refuses an unclosed tag, comment, CDATA section or test case, and reads a `>` inside an attribute", () => {
    expect(parseJunit('<testsuite><testcase name="a"')).toBeUndefined();
    expect(parseJunit('<testsuite><testcase name="a">')).toBeUndefined();
    expect(parseJunit('<testsuite><testcase name="a"/><!-- never closed')).toBeUndefined();
    expect(parseJunit('<testsuite><testcase name="a"/><![CDATA[ never closed')).toBeUndefined();
    expect(parseJunit('<testsuite><testcase name="a > b"/></testsuite>')?.tests[0]?.name).toBe("a > b");
    expect(parseJunit('<testsuite><testcases name="a"/><testcase name="b"/></testsuite>')?.total).toBe(1);
  });
  it("reads a test case with one huge attribute without a quadratic scan: over 16 KiB of attributes is unreadable, under it is read in linear time", () => {
    // Scaling checks, not wall-clock bounds: the same parse at an eighth of the size and at the full timed size may take about eight times as long, never sixty-four.
    // The timed 8N input is 256 KiB, so it stays in CPU cache; the old 8 MB input is parsed once, untimed, and must still be unreadable.
    for (const filler of ["a", "a=", "a =", 'a="', "a='", "= "]) {
      const hostileOf = (size: number) => `<testsuite><testcase ${filler.repeat(Math.ceil(size / filler.length))}/></testsuite>`;
      let got: ReturnType<typeof parseJunit> | undefined = parseJunit('<testsuite><testcase name="seed"/></testsuite>');
      expectLinearScaling((size) => {
        const hostile = hostileOf(size);
        return () => { got = parseJunit(hostile); };
      }, { n: 32_768, label: `junit attribute filler ${JSON.stringify(filler)}` });
      expect(got, filler).toBeUndefined();
      expect(parseJunit(hostileOf(8_000_000)), `${filler} full size`).toBeUndefined();
    }
    let read: ReturnType<typeof parseJunit> | undefined;
    expectLinearScaling((length) => {
      const nearCap = `<testsuite><testcase name="ok" ${"a".repeat(length)}/></testsuite>`;
      return () => { read = parseJunit(nearCap); };
    }, { n: 2_000, label: "junit attributes near the cap" });
    expect(read?.tests[0]?.name).toBe("ok");
    expect(parseJunit(`<testsuite><testcase name="ok" ${"a".repeat(17_000)}/></testsuite>`)).toBeUndefined();
  });
  it("reads each attribute pair once: the first of a repeated name wins, both quote kinds work, a malformed pair is skipped", () => {
    const read = parseJunit(`<testsuite><testcase junk = name='first' name="second" =x classname="a.b" time=oops/></testsuite>`)!;
    expect(read.tests[0]).toMatchObject({ name: "first", file: "a/b" });
  });
});

describe("vitest and jest JSON", () => {
  const report = parseJsonReport(VITEST)!;
  it("counts passed, failed and skipped from the assertion results, ignoring the file's own total", () => {
    expect(report).toMatchObject({ format: "json", total: 4, passed: 1, failed: 1, skipped: 1, errored: 1 });
  });
  it("counts a suite that failed to run as one errored test named for its file, so a load failure is never zero failures", () => {
    expect(report.tests.at(-1)).toMatchObject({ status: "errored", file: "/work/repo/src/broken.test.ts" });
    expect(report.tests.at(-1)?.name).toBe("/work/repo/src/broken.test.ts");
  });
  it("keeps each test's file and rounds its duration", () => {
    expect(report.tests[0]).toEqual({ file: "/work/repo/src/match.test.ts", name: "match scores a partner", status: "passed", durationMs: 12 });
  });
  it("is not measured for text that is not JSON, has no testResults, or holds no test", () => {
    expect(parseJsonReport("not json")).toBeUndefined();
    expect(parseJsonReport('{"other": []}')).toBeUndefined();
    expect(parseJsonReport('{"testResults": []}')).toBeUndefined();
    expect(parseJsonReport('{"testResults": [null, 3, {"name": "a", "status": "passed", "assertionResults": []}]}')).toBeUndefined();
    expect(parseJsonReport("[]")).toBeUndefined();
  });
});

describe("vitest and jest JSON, fail closed", () => {
  const suite = (over: Record<string, unknown>) => JSON.stringify({ testResults: [{ name: "/w/a.test.ts", status: "passed", ...over }] });
  it("counts an unknown or garbage status as errored, not skipped, and only pending, todo, skipped and disabled as skipped", () => {
    const read = parseJsonReport(suite({ assertionResults: ["pending", "todo", "skipped", "disabled", "quarantined", 7, null, "passed"].map((status, index) => ({ fullName: `t${String(index)}`, status })) }))!;
    expect(read).toMatchObject({ skipped: 4, errored: 3, passed: 1 });
    expect(read.tests.filter((test) => test.status === "errored").map((test) => test.name)).toEqual(["t4", "t5", "t6"]);
  });
  it("stops at the test cap even for suite-level errors", () => {
    const suites = Array.from({ length: TEST_REPORT_MAX_TESTS + 1 }, (_, index) => ({ name: `f${String(index)}`, status: "failed", assertionResults: [] }));
    expect(parseJsonReport(JSON.stringify({ testResults: suites }))).toBeUndefined();
    expect(parseJsonReport(JSON.stringify({ testResults: suites.slice(0, TEST_REPORT_MAX_TESTS) }))?.total).toBe(TEST_REPORT_MAX_TESTS);
  });
});

describe("names", () => {
  it("are one plain line with secrets redacted, cut at 300 characters, and never empty", () => {
    expect(plainName("a\nb‮c\u0000d")).toBe("a b c d");
    expect(plainName("   ")).toBe("test");
    expect(plainName("x".repeat(400))).toHaveLength(300);
    const cut = plainName(`${"x".repeat(299)}\u{1F600}tail`);
    expect(cut).toBe(`${"x".repeat(299)}\u{1F600}`);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    const secret = `ghp_${"A1b2".repeat(9)}`;
    expect(plainName(`test with ${secret}`)).not.toContain(secret);
  });
});

describe("evidence tests", () => {
  const changed = ["tests/test_match.py"];
  const report = parseJunit(PYTEST)!;
  const view = evidenceTests(report, { changedTestPaths: changed, proofByTest: new Map([["test_no_region", "proves_change"], ["test_top5[a & b]", "does_not_prove"]]) });
  it("keeps the totals, lists failing and errored tests first, then touched tests, then the rest", () => {
    expect(view).toMatchObject({ total: 5, passed: 2, failed: 1, errored: 1, skipped: 1 });
    expect(view.names.map((entry) => entry.name)).toEqual(["tests/test_match::test_scores_partner", "tests/test_rank::test_timeout", "tests/test_match::test_no_region", "tests/test_rank::test_slow", "tests/test_rank::test_top5[a & b]"]);
  });
  it("names the tests the change added or changed (not skipped ones) as new", () => {
    expect(view.newTests).toEqual(["tests/test_match::test_no_region", "tests/test_match::test_scores_partner"]);
  });
  it("attaches TESTPROOF's verdict to a touched test only", () => {
    expect(view.names.find((entry) => entry.name === "tests/test_match::test_no_region")?.proof).toBe("proves_change");
    expect(view.names.find((entry) => entry.name === "tests/test_rank::test_top5[a & b]")?.proof).toBeUndefined();
  });
  it("caps names at 500 and new tests at 100, with the totals still true", () => {
    const tests = Array.from({ length: 700 }, (_, index) => ({ file: "tests/test_match.py", name: `t${String(index)}`, status: "passed" as const }));
    const big = evidenceTests({ format: "junit", total: 700, passed: 700, failed: 0, skipped: 0, errored: 0, tests }, { changedTestPaths: changed });
    expect(big.names).toHaveLength(500);
    expect(big.newTests).toHaveLength(100);
    expect(big.total).toBe(700);
  });
  it("carries the skips among untouched tests before and after, so the broker can judge a rise", () => {
    const withSkips = evidenceTests(report, { changedTestPaths: changed, skippedOutside: { before: 0, after: 1 } });
    expect(withSkips).toMatchObject({ skippedBefore: 0, skippedAfter: 1 });
    expect(view).not.toHaveProperty("skippedBefore");
  });
  it("is accepted by the evidence pack's own schema for a check", () => {
    const pack = {
      schemaVersion: 1, candidateDigest: "a".repeat(64),
      environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
      checks: [{ checkId: "readiness:0", kind: "test", label: "pytest", before: "failed", after: "failed", class: "failing_no_before", durationMs: 5, tests: view }],
      selection: { method: "full", selected: 5, total: 5 }, api: [], browser: [], notTested: [],
    };
    expect(EvidencePackSchema.safeParse(pack).success).toBe(true);
  });
});

describe("a rise in skips", () => {
  const changed = ["tests/test_match.py"];
  const before = parseJunit('<testsuite><testcase classname="tests.test_rank" name="a"/><testcase classname="tests.test_rank" name="b"><skipped/></testcase></testsuite>')!;
  it("makes no claim without both reports", () => {
    expect(skipRise(undefined, before, changed)).toBeUndefined();
    expect(skipRise(before, undefined, changed)).toBeUndefined();
  });
});

// `go test -json` (test2json events), as Go 1.22 writes them: one JSON object per line.
const ev = (event: Record<string, unknown>): string => JSON.stringify({ Time: "2026-11-01T10:00:00Z", ...event });
const GO_STREAM = [
  ev({ Action: "start", Package: "example.com/m/match" }),
  ev({ Action: "run", Package: "example.com/m/match", Test: "TestScores" }),
  ev({ Action: "output", Package: "example.com/m/match", Test: "TestScores", Output: "=== RUN   TestScores\n" }),
  ev({ Action: "pass", Package: "example.com/m/match", Test: "TestScores", Elapsed: 0.012 }),
  ev({ Action: "run", Package: "example.com/m/match", Test: "TestRegion" }),
  ev({ Action: "run", Package: "example.com/m/match", Test: "TestRegion/no_region" }),
  ev({ Action: "output", Package: "example.com/m/match", Test: "TestRegion/no_region", Output: "--- PASS: TestPretend (0.00s)\n" }),
  ev({ Action: "fail", Package: "example.com/m/match", Test: "TestRegion/no_region", Elapsed: 0.001 }),
  ev({ Action: "fail", Package: "example.com/m/match", Test: "TestRegion", Elapsed: 0.002 }),
  ev({ Action: "run", Package: "example.com/m/match", Test: "TestSlow" }),
  ev({ Action: "skip", Package: "example.com/m/match", Test: "TestSlow", Elapsed: 0 }),
  ev({ Action: "fail", Package: "example.com/m/match", Elapsed: 0.05 }),
  ev({ Action: "skip", Package: "example.com/m/empty" }),
  ev({ Action: "pass", Package: "example.com/m/rank", Elapsed: 0.01 }),
].join("\n");

describe("go test -json", () => {
  it("counts a package that failed with no failing test of its own as one errored test named for the package (a build failure)", () => {
    const report = parseGoTestJson([ev({ Action: "start", Package: "p/a" }), ev({ Action: "output", Package: "p/a", Output: "FAIL\tp/a [build failed]\n" }), ev({ Action: "fail", Package: "p/a", Elapsed: 0, FailedBuild: "p/a" })].join("\n"))!;
    expect(report).toMatchObject({ total: 1, errored: 1, failed: 0 });
    expect(report.tests[0]).toMatchObject({ file: "p/a", name: "p/a", status: "errored" });
  });
  it("skips lines that are not events, but reads nothing from a file with no test result in it", () => {
    const mixed = ["# p/a", "some compiler text", ev({ Action: "run", Package: "p", Test: "TestA" }), ev({ Action: "pass", Package: "p", Test: "TestA" }), "{not json"].join("\n");
    expect(parseGoTestJson(mixed)).toMatchObject({ total: 1, passed: 1 });
    expect(parseGoTestJson("")).toBeUndefined();
    expect(parseGoTestJson("just text\nmore text")).toBeUndefined();
    expect(parseGoTestJson([ev({ Action: "start", Package: "p" }), ev({ Action: "skip", Package: "p" }), ev({ Action: "pass", Package: "p" })].join("\n"))).toBeUndefined();
    expect(parseGoTestJson(JSON.stringify({ testResults: [] }))).toBeUndefined();
  });
  it("feeds the evidence summary like any other report, and a Go package is never taken for a changed test file", () => {
    const report = parseGoTestJson(GO_STREAM)!;
    const summary = evidenceTests(report, { changedTestPaths: ["match/match_test.go"] });
    expect(summary).toMatchObject({ total: 4, passed: 1, failed: 2, skipped: 1, newTests: [] });
    expect(summary.names.slice(0, 2).map((item) => item.status)).toEqual(["failed", "failed"]);
    expect(skippedOutsideChanged(report, ["match/match_test.go"])).toBe(1);
  });
});

// TE-B3: tests that ran on the original code and are not in this code's report.
describe("tests that ran before and not now (absentOnNew)", () => {
  const report = (...tests: Array<[string, "passed" | "failed" | "skipped" | "errored"]>) => counted("json", tests.map(([name, status]) => ({ file: "t.py", name, status })));
  it("shows an id that is not valid as one plain line and still compares by the real id", () => {
    const odd = counted("json", [{ file: "t.py", name: "bad\u0007name", status: "passed" }]);
    expect(absentOnNew(odd, report())?.ids[0]).toBe("t.py::bad name");
    expect(absentOnNew(odd, odd)).toEqual({ ids: [], count: 0 });
  });
  it("makes no claim without both reports", () => {
    expect(absentOnNew(undefined, report())).toBeUndefined();
    expect(absentOnNew(report(), undefined)).toBeUndefined();
  });
});

// TE-B3, review H2 and L2: what is NOT "ran before and not now".
describe("absentOnNew and originalRunLooksCut: the test-first case and cut runs", () => {
  const rep = (...tests: Array<[string, string, "passed" | "failed" | "skipped" | "errored"]>) => counted("json", tests.map(([file, name, status]) => ({ file, name, status })));
  const many = (n: number, file = "t.py") => rep(...Array.from({ length: n }, (_unused, i): [string, string, "passed"] => [file, `t${String(i)}`, "passed"]));
  it("looks cut when the command stops at the first failure, whatever the reports say", () => {
    for (const flag of ["-x", "--exitfirst", "--maxfail=2", "--maxfail", "--bail", "--bail=1", "-bail", "-xq"]) expect(originalRunLooksCut(many(10), many(10), [], ["run", flag]), flag).toBe(true);
    for (const flag of ["-q", "--exclude", "--verbose", "tests/x.py"]) expect(originalRunLooksCut(many(10), many(10), [], ["run", flag]), flag).toBe(false);
  });
  it("looks cut when the original run has an error outside the changed files that this code's run does not, or far fewer untouched tests", () => {
    expect(originalRunLooksCut(rep(["tests/test_old.py", "tests.test_old", "errored"], ["t.py", "a", "passed"]), many(1), ["tests/test_new.py"])).toBe(true);
    // An error in a changed test file does not cut the run by itself (jest keeps going): the count decides.
    expect(originalRunLooksCut(rep(["tests/test_new.py", "tests.test_new", "errored"], ["t.py", "a", "passed"]), many(1), ["tests/test_new.py"])).toBe(false);
    expect(originalRunLooksCut(rep(["tests/test_new.py", "tests.test_new", "errored"]), many(10), ["tests/test_new.py"])).toBe(true);
    expect(originalRunLooksCut(many(8), many(10), [])).toBe(true);
    // 9 of 10 is cut only when they are the first nine in order (a run that stopped); nine different names are not.
    expect(originalRunLooksCut(many(9), many(10), [])).toBe(true);
    expect(originalRunLooksCut(counted("json", many(10).tests.slice(1)), many(10), [])).toBe(false);
    expect(originalRunLooksCut(many(12), many(10), [])).toBe(false);
  });
  it("counts the untouched tests only", () => {
    expect(untouchedCount(rep(["tests/test_new.py", "a", "passed"], ["t.py", "b", "skipped"]), ["tests/test_new.py"])).toBe(1);
  });
});

