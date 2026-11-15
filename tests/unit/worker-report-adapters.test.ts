import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EvidenceChecksTestsSchema, EvidenceChecksTestsReadSchema } from "../../packages/contracts/src/evidence.js";
import { absentOnNew, evidenceTests, parseTestReport } from "../../packages/worker/src/verification/test-report.js";
import { REPORT_ADAPTERS, parseReportParts } from "../../packages/worker/src/verification/report-adapters.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/report-adapters/${name}`, import.meta.url), "utf8");

describe("TE-IF4 adapter fixtures", () => {
  it.each([
    ["junit.xml", "junit"], ["jest.json", "json"], ["go.jsonl", "gotest"], ["trx.xml", "trx"], ["ctrf.json", "ctrf"],
  ])("reads %s and emits existing evidence counts", (file, format) => {
    const report = parseTestReport(fixture(file));
    expect(report).toMatchObject({ format, total: 4, passed: 1, failed: 1, skipped: 1, errored: 1 });
    const part = evidenceTests(report!);
    expect(EvidenceChecksTestsSchema.safeParse(part).success).toBe(true);
    expect(EvidenceChecksTestsReadSchema.parse(part)).toEqual(part);
  });

  it("keeps a JSON string containing XML out of the XML parser", () => {
    expect(parseTestReport(JSON.stringify({ results: { tests: [] }, message: '<testsuite><testcase name="fake"/></testsuite>' }))).toBeUndefined();
  });
});

// Golden output captured from the pinned TE-B3 writer before refactoring.
it.each(["junit.xml", "jest.json", "go.jsonl"])("preserves the old %s output byte for byte", (file) => {
  expect(JSON.stringify(parseTestReport(fixture(file)), null, 2) + "\n").toBe(fixture(`${file}.expected.json`));
});

describe("review routing regressions", () => {
  const junit = '<testsuite><testcase name="real"><failure/></testcase></testsuite>';
  const expectedJunit = { format: "junit", total: 1, passed: 0, failed: 1, skipped: 0, errored: 0, tests: [{ name: "real", status: "failed" }] };
  it.each([
    junit.replace("</testsuite>", '<system-out><![CDATA[<TestRun fake="yes"/>]]></system-out></testsuite>'),
    junit.replace("<testcase", '<!-- <TestRun/> --><testcase'),
    junit.replace("<testsuite>", '<testsuite note="<TestRun/>">'),
    '<?xml version="1.0"?><!-- <TestRun/> --><!DOCTYPE testsuite [<!ENTITY note "<TestRun/>">]>' + junit,
    '<!DOCTYPE testsuite [<?note ] > <TestRun/> ?><!ELEMENT testsuite ANY>]>' + junit,
  ])("routes only the XML root, preserving B3 JUnit output: %s", (text) => {
    expect(parseTestReport(text)).toEqual(expectedJunit);
    expect(parseTestReport(text, "junit")).toEqual(expectedJunit);
  });
  it("sniffs the root after XML preambles without interpreting their contents", () => {
    const adapter = REPORT_ADAPTERS.find((row) => row.format === "trx")!;
    const root = '<ns:TestRun xmlns:ns="urn:fixture"/>';
    for (const preamble of ["", '\uFEFF <?xml version="1.0"?>', '<!-- <testsuite/> -->', '<!DOCTYPE TestRun SYSTEM "file:///a>b">', '<!DOCTYPE TestRun [<!ENTITY x "] > <testsuite/>"><!-- ] > <testsuite/> -->]>', '<!DOCTYPE TestRun [<!ELEMENT TestRun ANY><!ENTITY x \'[>]\'>]>', '<!DOCTYPE TestRun [<?note ] > <testsuite/> ?>]>']) {
      expect(adapter.sniff(preamble + root)).toBe(true);
      expect(adapter.sniff(preamble + '<testsuite note="<TestRun/>"/>')).toBe(false);
    }
    for (const text of ['<!-- <TestRun/>', '<?xml <TestRun/>', '<!DOCTYPE TestRun [<TestRun/>', '<!DOCTYPE TestRun [<!-- <TestRun/>', '<![CDATA[<TestRun/>]]>', '<Other><TestRun/></Other>', '<TestRunner/>', '<TestRun!/>', '']) expect(adapter.sniff(text)).toBe(false);
  });
  const jest = { testResults: [{ assertionResults: [{ fullName: "real", status: "failed" }] }] };
  it.each([
    { results: { tests: [{ name: "fake", status: "passed" }] } },
    { results: { tests: [] } },
    { results: { tool: { name: "metadata" }, tests: [{ name: "fake", status: "passed" }] } },
    { reportFormat: "CTRF", results: { tests: [{ name: "fake", status: "passed" }] } },
    { schemaVersion: 1, measures: [{ name: "x", unit: "ms", value: 1, direction: "down_good" }] },
  ])("keeps Jest failures despite new-format metadata: %j", (metadata) => {
    for (const hint of ["auto", "json"] as const) expect(parseTestReport(JSON.stringify({ ...jest, ...metadata }), hint)).toEqual({ format: "json", total: 1, passed: 0, failed: 1, skipped: 0, errored: 0, tests: [{ name: "real", status: "failed" }] });
  });
  it("requires a CTRF marker and excludes measures under the legacy json hint", () => {
    const results = { tests: [{ name: "real", status: "passed" }] };
    for (const hint of ["auto", "json"] as const) {
      expect(parseReportParts(JSON.stringify({ results }), hint)).toBeUndefined();
      expect(parseReportParts(JSON.stringify({ reportFormat: "CTRF", results }), hint)?.tests?.passed).toBe(1);
      expect(parseReportParts(JSON.stringify({ results: { ...results, tool: { name: "runner" } } }), hint)?.tests?.passed).toBe(1);
    }
    expect(parseReportParts(fixture("measures.json"), "json")).toBeUndefined();
    expect(parseReportParts(fixture("measures.json"), "measures")?.measures).toMatchObject({ source: "project_runner" });
  });
  it.each(["ctrf", "trx"] as const)("makes absent %s ids inert without changing raw identity", (format) => {
    const names = ["[link](https://example.com)", "![a[b]c](https://example.com)", "[x][id]", "@owner #123 <b>raw</b>", "# title", "> quote", "---", "```code", "~~~code", "hidden\u202E\uFE0Fx", "x".repeat(1_000_000)];
    const before = { format, total: names.length, passed: names.length, failed: 0, skipped: 0, errored: 0, tests: names.map((name) => ({ name, status: "passed" as const })) };
    const after = { ...before, tests: [], total: 0, passed: 0 };
    const start = performance.now();
    const shown = absentOnNew(before, after)!;
    expect(performance.now() - start).toBeLessThan(2_000);
    expect(shown.count).toBe(names.length);
    expect(shown.ids.slice(0, 9)).toEqual(["link", "test", "(x)(id)", "@ owner # 123 raw", "· # title", "· > quote", "· ---", "· ```code", "· ~~~code"]);
    expect(shown.ids.join("\n")).not.toMatch(/@owner|#123|<b>|https:\/\/|!\[|\[id\]|\u202E|\uFE0F/u);
    expect(before.tests[0]!.name).toBe(names[0]);
    expect(absentOnNew(before, before)).toEqual({ ids: [], count: 0 });
  });
});
