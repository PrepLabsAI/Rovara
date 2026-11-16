import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReportParts } from "../../packages/worker/src/verification/report-adapters.js";
import { displayLine, evidenceTests, parseTestReport, testText, TEST_REPORT_MAX_BYTES } from "../../packages/worker/src/verification/test-report.js";
import { inertEvidenceText } from "../../packages/contracts/src/evidence-inert.js";
import { expectLinearScaling } from "../support/scaling.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/report-adapters/${name}`, import.meta.url), "utf8");
const ctrf = (tests: unknown[]) => JSON.stringify({ reportFormat: "CTRF", results: { tests } });
const trx = (content: string) => `<TestRun><Results>${content}</Results></TestRun>`;
const result = '<UnitTestResult testName="real" outcome="Passed"/>';

describe("adapter boundaries", () => {
  it("routes measures before generic JSON and never claims they are tests", () => {
    expect(parseReportParts(fixture("measures.json"))).toMatchObject({ format: "measures", measures: { schemaVersion: 1, measures: [{ value: 0.9, count: 10 }] } });
    expect(parseTestReport(fixture("measures.json"))).toBeUndefined();
    expect(parseReportParts('{"schemaVersion":2,"measures":[]}')).toEqual({ format: "measures", newer: true });
  });
  it("routes Go and CTRF before generic JSON; honours explicit formats without falling through malformed formats", () => {
    expect(parseReportParts(fixture("go.jsonl"), "json")?.format).toBe("gotest");
    expect(parseReportParts(fixture("ctrf.json"), "json")?.format).toBe("ctrf");
    expect(parseReportParts(fixture("trx.xml"), "trx")?.format).toBe("trx");
    expect(parseReportParts(fixture("trx.xml"), "junit")).toBeUndefined();
    expect(parseReportParts(fixture("jest.json"), "trx")).toBeUndefined();
    expect(parseReportParts('{"results":{"tests":[]},"testResults":[{"assertionResults":[{"status":"passed"}]}]}')?.tests).toMatchObject({ format: "json", passed: 1 });
    expect(parseReportParts('{"reportFormat":"CTRF","results":{"tests":[]}}')).toBeUndefined();
  });
  it.each(["junit.xml", "jest.json", "go.jsonl", "trx.xml", "ctrf.json", "measures.json"])("refuses oversized %s before parsing", (file) => {
    const text = fixture(file);
    expect(parseReportParts(text + " ".repeat(TEST_REPORT_MAX_BYTES - Buffer.byteLength(text)))).toBeDefined();
    expect(parseReportParts(text + " ".repeat(TEST_REPORT_MAX_BYTES - Buffer.byteLength(text) + 1))).toBeUndefined();
    expect(parseReportParts(text + "é".repeat(TEST_REPORT_MAX_BYTES / 2))).toBeUndefined();
  });
  it("reads only per-test clocks, preserves duplicates, and keeps a flaky CTRF test's final outcome", () => {
    const c = parseReportParts(fixture("ctrf.json"))!;
    expect(c.tests?.tests[0]).toMatchObject({ name: "same", status: "passed", durationMs: 12, startTimeMs: 1767225600000, endTimeMs: 1767225600012 });
    expect(c.tests?.total).toBe(4);
    expect(c.tests?.tests[1]).not.toHaveProperty("startTimeMs");
    expect(parseReportParts(fixture("trx.xml"))?.tests?.tests[0]).toMatchObject({ durationMs: 12, startTimeMs: 1767225600000, endTimeMs: 1767225600012 });
  });
  it("refuses deep JSON without recursive traversal; prototype metadata never changes test counts", () => {
    expect(parseReportParts(`{"reportFormat":"CTRF","extra":${"[".repeat(65)}0${"]".repeat(65)},"results":{"tests":[{"name":"x","status":"passed"}]}}`)).toBeUndefined();
    expect(parseReportParts('{"reportFormat":"CTRF","__proto__":{"polluted":true},"results":{"tests":[{"name":"x","status":"passed"}]}}')?.tests?.passed).toBe(1);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
  it("keeps unknown status errored and refuses malformed rows, empty reports and excessive test counts", () => {
    expect(parseReportParts(ctrf([{ name: "x", status: "future" }]))?.tests?.errored).toBe(1);
    expect(parseReportParts(trx('<UnitTestResult testName="x" outcome="Future"/>'))?.tests?.errored).toBe(1);
    for (const text of [ctrf([]), ctrf([null]), ctrf([1]), ctrf([{}]), ctrf([{ name: "", status: "passed" }]), trx(""), ctrf(Array.from({ length: 50_001 }, () => ({ name: "x", status: "passed" }))), trx(result.repeat(50_001))]) expect(parseReportParts(text)).toBeUndefined();
  });
  it("omits invalid durations and times, never prints Infinity or backwards windows", () => {
    const parsed = parseReportParts(ctrf([{ name: "x", status: "passed", duration: 1e99, start: 1e99, stop: -1 }, { name: "y", status: "passed", duration: -1, start: 20, stop: 10 }, { name: "z", status: "passed", start: 1e99 }, { name: "z2", status: "passed", stop: -1 }]))!;
    for (const test of parsed.tests!.tests) {
      expect(test).not.toHaveProperty("durationMs"); expect(test).not.toHaveProperty("startTimeMs"); expect(test).not.toHaveProperty("endTimeMs");
    }
    expect(parseReportParts(trx('<UnitTestResult testName="x" outcome="Passed" duration="00:99:00" startTime="2026"/>'))?.tests?.tests[0]).toEqual({ name: "x", status: "passed" });
  });
  it("keeps raw test identity and makes displayed adapter text inert, even huge names", () => {
    for (const name of ["![a[b]c](https://example.com) [text](https://example.com)", "[x][id] ![img][id]", "@owner #123 <b>raw</b>", "# title", "> quote", "---", "```code", "~~~code", "hidden\u202E\uFE0Fx"]) {
      const read = parseReportParts(ctrf([{ name, filepath: name, status: "passed" }]))!;
      expect(read.tests?.tests[0]).toMatchObject({ name: testText(name), file: testText(name) });
      const shown = evidenceTests(read.tests!).names[0]!;
      expect(shown.name).toBe(displayLine(inertEvidenceText(`${testText(name)}::${testText(name)}`, 500).replace(/^\u200D/u, "· ")));
      expect(shown.unlisted).toBe(true);
    }
  });
  it("keeps raw test identity and makes displayed adapter text inert for a huge name, in time that grows no faster than the name", () => {
    let name = "";
    let read = undefined as ReturnType<typeof parseReportParts>;
    let shown = undefined as ReturnType<typeof evidenceTests>["names"][number] | undefined;
    // 125,000 characters, then 1,000,000: linear work grows about 8x.
    expectLinearScaling((size) => {
      name = "x".repeat(size);
      const text = ctrf([{ name, filepath: name, status: "passed" }]);
      return () => { read = parseReportParts(text); shown = evidenceTests(read!.tests!).names[0]; };
    }, { n: 125_000, label: "a huge test name" });
    expect(name.length).toBe(1_000_000);
    expect(read!.tests?.tests[0]).toMatchObject({ name: testText(name), file: testText(name) });
    expect(shown!.name).toBe(displayLine(inertEvidenceText(`${testText(name)}::${testText(name)}`, 500).replace(/^\u200D/u, "· ")));
    expect(shown!.unlisted).toBe(true);
  });
  it("rejects XML declarations, external entities and bombs without expansion", () => {
    for (const declaration of ['<!DOCTYPE TestRun SYSTEM "file:///etc/passwd">', '<!DOCTYPE TestRun [<!ENTITY x "boom"><!ENTITY y "&x;&x;">]>', '<!ENTITY x SYSTEM "https://example.com">']) expect(parseReportParts(declaration + trx(result))).toBeUndefined();
  });
  it("does not count XML-shaped text in comments, CDATA, attributes, outputs or foreign roots", () => {
    expect(parseReportParts(trx(`<!--${result}--><![CDATA[${result}]]>${result}`))?.tests?.total).toBe(1);
    expect(parseReportParts(trx(`<Output fake='${result}'/>${result}`))?.tests?.total).toBe(1);
    expect(parseReportParts(trx(`<Output>${result}</Output>${result}`))?.tests?.total).toBe(1);
    expect(parseReportParts(`<Other>${trx(result)}</Other>`)).toBeUndefined();
    expect(parseReportParts(`<Other><Results>${result}</Results><TestRun/></Other>`)).toBeUndefined();
  });
  it("refuses malformed, unclosed, deeply nested or overlong XML tags", () => {
    for (const text of [trx(result).slice(0,-10), trx(result) + "junk", trx(result).replace("</Results>", "</Other>"), trx(result) + trx(result), '<TestRun><Results></Other></TestRun>', trx('<!--unclosed'), trx('<![CDATA[unclosed'), trx('<UnitTestResult testName="never closes'), trx(`<UnitTestResult testName="${"a".repeat(17_000)}"/>`), `<TestRun><Results>${result}</Results>${"<x>".repeat(65)}${"</x>".repeat(65)}</TestRun>`]) expect(parseReportParts(text)).toBeUndefined();
  });
  it.each(["junit.xml", "jest.json", "go.jsonl", "trx.xml", "ctrf.json", "measures.json"])("reads an 8 MiB %s input in time that grows no faster than its size", (file) => {
    const sample = fixture(file);
    let read: ReturnType<typeof parseReportParts>;
    // 1 MiB, then 8 MiB (the largest input read): linear work grows about 8x.
    expectLinearScaling((bytes) => {
      const text = sample + " ".repeat(bytes - Buffer.byteLength(sample));
      return () => { read = parseReportParts(text); };
    }, { n: TEST_REPORT_MAX_BYTES / 8, label: `a ${file} report padded to its size limit` });
    expect(read).toBeDefined();
  });
});

it("collects Go and Jest clocks separately so legacy report objects stay byte-identical", () => {
  expect(parseReportParts(fixture("go.jsonl"))?.timings).toEqual([{ testIndex: 0, startTimeMs: 1767225600000, endTimeMs: 1767225600012 }]);
  const nano = fixture("go.jsonl").replace("00Z", "00.000000001Z").replace("00.012Z", "00.012000001Z");
  expect(parseReportParts(nano)?.timings).toEqual([{ testIndex: 0, startTimeMs: 1767225600000, endTimeMs: 1767225600012 }]);
  const jest = JSON.stringify({ testResults: [{ assertionResults: [{ fullName: "x", status: "passed", startAt: 100, duration: 12 }] }] });
  expect(parseReportParts(jest)?.timings).toEqual([{ testIndex: 0, startTimeMs: 100, endTimeMs: 112 }]);
  expect(parseTestReport(jest)?.tests[0]).toEqual({ name: "x", status: "passed", durationMs: 12 });
});

it.each(["junit", "gotest"])("handles an adversarial 8 MiB %s scan in linear time", (format) => {
  // A separate process bounds a regressed synchronous parser: a vitest timeout cannot interrupt its own event loop. The child times the parse at 1 MiB and at 8 MiB (the size limit)
  // and reports whether the work grew faster than linear; the parent's timeout is only the generous hang limit that kills a parser that never returns.
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { parseReportParts } from './packages/worker/src/verification/report-adapters.ts';
    import { expectLinearScaling } from './tests/support/scaling.ts';
    let total = null;
    let scaling = null;
    // One unit is an eighth of the 8 MiB input: 15,000 comment blocks or 10,000 Go events, padded to 1 MiB.
    const build = (units) => {
      const body = ${JSON.stringify(format)} === 'junit'
        ? '<testsuite>' + '<!-- some output -->'.repeat(15_000 * units) + '<testcase name="x"/></testsuite>'
        : Array.from({ length: 10_000 * units }, (_, i) => JSON.stringify({ Action: 'fail', Package: 'package' + i })).join('\\n');
      const text = body + ' '.repeat(1024 * 1024 * units - Buffer.byteLength(body));
      return () => { total = parseReportParts(text)?.tests?.total ?? null; };
    };
    try { scaling = { ok: true, result: expectLinearScaling(build, { n: 1, label: 'adversarial ${format} scan' }) }; } catch (error) { scaling = { ok: false, message: String(error && error.message) }; }
    console.log(JSON.stringify({ scaling, total }));
  `], { cwd: new URL("../../", import.meta.url), timeout: 120_000, encoding: "utf8" });
  const read = JSON.parse(output) as { scaling: { ok: boolean; message?: string }; total: number | null };
  expect(read.scaling.message ?? "").toBe("");
  expect(read.scaling.ok).toBe(true);
  expect(read.total).toBe(format === "junit" ? 1 : null);
});

it.each([
  ["json", '{"testResults":[{"assertionResults":[{"fullName":"', '","status":"passed"}]}]}', true],
  ["ctrf", '{"reportFormat":"CTRF","results":{"tests":[{"name":"', '","status":"passed"}]}}', true],
  ["trx", '<TestRun><Results><UnitTestResult testName="', '" outcome="Passed"/></Results></TestRun>', false],
  ["measures", '{"schemaVersion":1,"measures":[{"name":"', '","unit":"B","value":1,"direction":"down_good"}]}', false],
] as const)("bounds an 8 MiB single-line %s field", (_format, prefix, suffix, readable) => {
  let parsed: unknown;
  // The field grows 8x (1 MiB to 8 MiB): linear work grows about 8x.
  expectLinearScaling((bytes) => {
    const text = prefix + "x".repeat(bytes - prefix.length - suffix.length) + suffix;
    return () => { parsed = parseReportParts(text); };
  }, { n: TEST_REPORT_MAX_BYTES / 8, label: "a single-line field up to the size limit" });
  expect(parsed !== undefined).toBe(readable);
});

it("does not match a display-normalised test to a different real test", () => {
  const read = parseTestReport(ctrf([{ name: "[name](https://example.com)", status: "passed", filepath: "a.test.ts" }]))!;
  expect(read.tests[0]?.name).toBe("[name](https://example.com)");
  expect(evidenceTests(read, { changedTestPaths: ["a.test.ts"], proofByTest: new Map([["a.test.ts::[name](https://example.com)", "proves_change"]]) }).names[0]).toEqual({ name: "a.test.ts::name", status: "passed", unlisted: true });
});

it("does not misdetect unrelated JSON metadata as a new report format", () => {
  const text = '{"results":{"message":"metadata"},"measures":[],"testResults":[{"assertionResults":[{"fullName":"real","status":"passed"}]}]}';
  expect(parseReportParts(text)?.tests).toMatchObject({ format: "json", total: 1, passed: 1 });
});
