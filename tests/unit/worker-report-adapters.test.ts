import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EvidenceChecksTestsSchema, EvidenceChecksTestsReadSchema } from "../../packages/contracts/src/evidence.js";
import { absentOnNew, evidenceTests, parseTestReport } from "../../packages/worker/src/verification/test-report.js";
import { REPORT_ADAPTERS, parseReportParts } from "../../packages/worker/src/verification/report-adapters.js";
import { expectLinearScaling } from "../support/scaling.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/report-adapters/${name}`, import.meta.url), "utf8");

describe("TE-IF4 adapter fixtures", () => {
  it.each([
    ["junit.xml", "junit"],
  ])("reads %s and emits existing evidence counts", (file, format) => {
    const report = parseTestReport(fixture(file));
    expect(report).toMatchObject({ format, total: 4, passed: 1, failed: 1, skipped: 1, errored: 1 });
    const part = evidenceTests(report!);
    expect(EvidenceChecksTestsSchema.safeParse(part).success).toBe(true);
    expect(EvidenceChecksTestsReadSchema.parse(part)).toEqual(part);
  });

  it.each([
    ["trx.failure.xml", "trx", "src/cart.cs:8"],
  ])("reads failure details from %s including CDATA", (file, format, signal) => {
    const report = parseTestReport(fixture(file));
    expect(report?.format).toBe(format);
    expect(report?.tests.find((test) => test.status === "failed")?.failureText).toContain(signal);
  });

  it("refuses malformed and over-cap go, TRX, and JUnit reports as a whole", () => {
    expect(parseTestReport('{"Action":"pass","Package":"p","Test":"x"}\n{broken')).toMatchObject({ format: "gotest", passed: 1 });
    expect(parseTestReport('<TestRun><Results><UnitTestResult outcome="Failed"><Output><ErrorInfo><Message><![CDATA[unclosed</Message></ErrorInfo></Output></UnitTestResult></Results></TestRun>')).toBeUndefined();
    expect(parseTestReport('<testsuite><testcase name="x"><failure><![CDATA[unclosed</failure></testcase></testsuite>')).toBeUndefined();
    expect(parseTestReport('<!DOCTYPE testsuite [<!ENTITY x "src/x.ts">]><testsuite><testcase name="x"><failure>&x;</failure></testcase></testsuite>')).toMatchObject({ format: "junit", failed: 1 });
    expect(parseTestReport('<!DOCTYPE TestRun [<!ENTITY x "src/x.cs">]><TestRun><Results><UnitTestResult outcome="Failed"/></Results></TestRun>')).toBeUndefined();

    const many = 50_001;
    const go = Array.from({ length: many }, (_, i) => JSON.stringify({ Action: "pass", Package: "p", Test: `t${i}` })).join("\n");
    const trx = `<TestRun><Results>${'<UnitTestResult outcome="Passed" testName="x"/>'.repeat(many)}</Results></TestRun>`;
    const junit = `<testsuite>${'<testcase name="x"/>'.repeat(many)}</testsuite>`;
    expect(parseTestReport(go, "gotest")).toBeUndefined();
    expect(parseTestReport(trx, "trx")).toBeUndefined();
    expect(parseTestReport(junit, "junit")).toBeUndefined();
  });

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
    const shortNames = ["[link](https://example.com)", "![a[b]c](https://example.com)", "[x][id]", "@owner #123 <b>raw</b>", "# title", "> quote", "---", "```code", "~~~code", "hidden\u202E\uFE0Fx"];
    const reports = (longLength: number) => {
      const all = [...shortNames, "x".repeat(longLength)];
      const full = { format, total: all.length, passed: all.length, failed: 0, skipped: 0, errored: 0, tests: all.map((name) => ({ name, status: "passed" as const })) };
      return { names: all, before: full, after: { ...full, tests: [], total: 0, passed: 0 } };
    };
    // Scaling check: the cost must grow no faster than the long id. The timed 8N input is 256 KiB (about 32,000 characters; it appears in both reports), so it stays in CPU cache; the old 1,000,000 characters are checked once below.
    expectLinearScaling((longLength) => {
      const { before, after } = reports(longLength);
      return () => absentOnNew(before, after);
    }, { n: 16_384, unitBytes: 2, label: `absentOnNew with a long ${format} id` });
    const { names, before, after } = reports(1_000_000);
    const shown = absentOnNew(before, after)!;
    expect(shown.count).toBe(names.length);
    expect(shown.ids.slice(0, 9)).toEqual(["link", "test", "(x)(id)", "@ owner # 123 raw", "· # title", "· > quote", "· ---", "· ```code", "· ~~~code"]);
    expect(shown.ids.join("\n")).not.toMatch(/@owner|#123|<b>|https:\/\/|!\[|\[id\]|\u202E|\uFE0F/u);
    expect(before.tests[0]!.name).toBe(names[0]);
    expect(absentOnNew(before, before)).toEqual({ ids: [], count: 0 });
  });
});
