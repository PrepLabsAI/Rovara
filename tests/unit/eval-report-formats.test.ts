// L4-EVS (D2): the customer's normal eval output becomes Rovara's measures file inside the worker's sandbox seam. Per-case pass or fail rows feed the comparison; nothing is guessed.
import { describe, expect, it } from "vitest";
import { readMeasuresFile } from "@agentx/contracts";
import { caseRowsOf, measuresFromCaseReports } from "../../packages/worker/src/verification/eval-report-formats.js";

const junit = (cases: Array<{ classname?: string; name: string; status?: "pass" | "fail" | "error" | "skip" }>): string => {
  const body = cases.map(({ classname, name, status }) => {
    const attrs = `${classname === undefined ? "" : ` classname="${classname}"`} name="${name}" time="0.01"`;
    return status === "fail" ? `<testcase${attrs}><failure message="assert 0">trace</failure></testcase>` : status === "error" ? `<testcase${attrs}><error message="boom"/></testcase>` : status === "skip" ? `<testcase${attrs}><skipped/></testcase>` : `<testcase${attrs}/>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" tests="${String(cases.length)}">${body}</testsuite></testsuites>`;
};
const run = (text: string) => caseRowsOf(text)!;
const parse = (json: string | undefined) => { const read = readMeasuresFile(JSON.parse(json!)); if (read.status !== "ok") throw new Error("not a measures file"); return read.file; };

describe("caseRowsOf: which files are per-case reports", () => {
  it("reads JUnit (pytest style), a test runner's JSON and promptfoo; and refuses Rovara's own measures file, garbage and an empty report", () => {
    expect(run(junit([{ name: "a" }, { name: "b", status: "fail" }]))).toHaveLength(2);
    const promptfoo = JSON.stringify({ results: { results: [{ success: true, testCase: { description: "a" } }, { success: false, description: "b" }] } });
    expect(run(promptfoo).map(row => row.status)).toEqual(["passed", "failed"]);
    const measures = JSON.stringify({ schemaVersion: 1, measures: [{ name: "m", unit: "u", direction: "up_good", value: 1 }], questions: [{ id: "a", samples: [{ pass: true, answer: "x" }] }] });
    expect(caseRowsOf(measures)).toBeUndefined();
    expect(caseRowsOf(JSON.stringify({ schemaVersion: 2, measures: [] }))).toBeUndefined();
    for (const text of ["", "not a report", "{}", "[]", "<html></html>", JSON.stringify({ results: [] }), JSON.stringify({ results: [{ success: "yes" }] })]) expect(caseRowsOf(text)).toBeUndefined();
  });
});

describe("measuresFromCaseReports: one test case is one question, one report is one run", () => {
  it("maps JUnit cases to the plan's question ids by exact name, parameter text, classname.name and classname::name", () => {
    const report = junit([
      { classname: "evals.test_cases", name: "test_case[order-status]" },
      { classname: "evals.test_cases", name: "privacy-email", status: "fail" },
      { classname: "evals.test_cases.TestRefund", name: "test_refund" },
      { classname: "evals.test_shipping", name: "test_shipping_time", status: "error" },
      { name: "unrelated" },
    ]);
    const file = parse(measuresFromCaseReports([run(report)], ["order-status", "privacy-email", "evals.test_cases.TestRefund.test_refund", "evals.test_shipping::test_shipping_time", "absent"]));
    expect(file.questions!.map(question => [question.id, question.samples.map(sample => sample.pass)])).toEqual([
      ["order-status", [true]], ["privacy-email", [false]], ["evals.test_cases.TestRefund.test_refund", [true]], ["evals.test_shipping::test_shipping_time", [false]],
    ]);
    // The overall pass rate is the one measure; no answer text is taken from a report.
    expect(file.measures[0]).toMatchObject({ name: "eval_pass_rate", value: 0.5 });
    for (const question of file.questions!) for (const sample of question.samples) expect(sample.answer).toBe("");
  });

  it("never turns a skipped, absent or ambiguous case into a pass: it is simply not in the result", () => {
    const skipped = run(junit([{ name: "a", status: "skip" }]));
    expect(measuresFromCaseReports([skipped], ["a"])).toBeUndefined();
    // Two different cases carry the same name (one in each class): the question cannot be told apart, so it is left out (the other one is kept).
    const ambiguous = run(junit([{ classname: "x.A", name: "dup" }, { classname: "x.B", name: "dup", status: "fail" }, { name: "ok" }]));
    expect(parse(measuresFromCaseReports([ambiguous], ["dup", "ok"])).questions!.map(question => question.id)).toEqual(["ok"]);
    expect(measuresFromCaseReports([], ["a"])).toBeUndefined();
    expect(measuresFromCaseReports([run(junit([{ name: "a" }])), run(junit([{ name: "a" }])), run(junit([{ name: "a" }])), run(junit([{ name: "a" }]))], ["a"])).toBeUndefined();
    expect(measuresFromCaseReports([run(junit([{ name: "zzz" }]))], ["a"])).toBeUndefined();
  });

  it("promptfoo: the id comes from the description or a variable named id, case_id or question_id", () => {
    const promptfoo = JSON.stringify({ results: [
      { success: true, description: "q-desc" },
      { success: false, testCase: { vars: { id: "q-id" } } },
      { success: true, vars: { case_id: "q-case" } },
    ] });
    const file = parse(measuresFromCaseReports([run(promptfoo)], ["q-desc", "q-id", "q-case"]));
    expect(file.questions!.map(question => [question.id, question.samples[0]!.pass])).toEqual([["q-desc", true], ["q-id", false], ["q-case", true]]);
  });
});
