// L4-EVS (DEC 254zzz20 D2): the customer's normal eval output, not only Rovara's measures file. The fresh eval sandbox reads the file the eval command wrote; when it is a per-case test report it is
// turned HERE, inside the worker's own sandbox seam, into the measures file the rest of the eval round already reads (`{schemaVersion: 1, measures: [...], questions: [{id, samples: [{pass, answer}]}]}`),
// so nothing downstream changes and nothing in the repository can add a format.
//
//   JUnit XML first (pytest `--junitxml`, DeepEval through pytest, Jest and Vitest reporters, TRX, Go test JSON and CTRF go through the SAME reader the tests use: `parseReportParts`, bounded and strict),
//   then promptfoo's JSON results file (a per-test `success`). One test case is one question; one report is one run, so the sandbox runs the command once per run and gives every report here.
//
// A case maps to a question only by an EXACT match of one of its names (the test name, the name without its parameter brackets, the text in the brackets, `classname.name`, `classname::name`, `file::name`)
// with the plan's question id. A question that matches no case, or more than one in a run, or is skipped or absent in any run, is simply not in the result (it counts as "not run" downstream, never as a pass).
// No answer text is taken from a report (JUnit has none; a failure message is the repository's free text): every sample's answer is empty.
import { readMeasuresFile, readMeasuresFileText } from "@agentx/contracts";
import { parseReportParts } from "./report-adapters.js";
import type { ReportedTest } from "./test-report.js";

type CaseStatus = "passed" | "failed" | "skipped";
export interface CaseRow { readonly keys: readonly string[]; readonly status: CaseStatus }

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** The most cases one report may hold (the reader's own bound is far higher; a question set is at most this many). */
const CASES_MAX = 20_000;

function keysOfTest(test: ReportedTest): string[] {
  const keys = new Set<string>();
  const add = (value: string | undefined): void => { if (value !== undefined && value !== "" && value.length <= 400) keys.add(value); };
  const name = test.name;
  add(name);
  const bracket = /^(.*)\[(.+)\]$/u.exec(name);
  if (bracket !== null) { add(bracket[1]); add(bracket[2]); }
  if (test.classname !== undefined) { add(`${test.classname}.${name}`); add(`${test.classname}::${name}`); }
  if (test.file !== undefined) add(`${test.file}::${name}`);
  return [...keys];
}

function promptfooRows(text: string): CaseRow[] | undefined {
  let root: unknown;
  try { root = JSON.parse(text.replace(/^\uFEFF/u, "")); } catch { return undefined; }
  if (!object(root)) return undefined;
  const nested = object(root["results"]) ? root["results"] : undefined;
  const rows = Array.isArray(root["results"]) ? root["results"] : Array.isArray(nested?.["results"]) ? nested["results"] : undefined;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > CASES_MAX) return undefined;
  const out: CaseRow[] = [];
  for (const row of rows as unknown[]) {
    if (!object(row) || typeof row["success"] !== "boolean") return undefined;
    const testCase = object(row["testCase"]) ? row["testCase"] : undefined;
    const vars = [row["vars"], testCase?.["vars"]].filter(object);
    const keys = new Set<string>();
    for (const value of [row["description"], testCase?.["description"], ...vars.flatMap(v => [v["id"], v["case_id"], v["question_id"]])]) if (typeof value === "string" && value !== "" && value.length <= 400) keys.add(value);
    out.push({ keys: [...keys], status: row["success"] ? "passed" : "failed" });
  }
  return out;
}

/** The per-case rows of one report, or undefined when it is not a per-case report (a measures file, an unreadable or unknown file). Never throws. */
export function caseRowsOf(text: string): CaseRow[] | undefined {
  try {
    // A measures file (or a newer version of one) is Rovara's own format: not a case report.
    if (readMeasuresFileText(text).status !== "unreadable") return undefined;
    const promptfoo = promptfooRows(text);
    if (promptfoo !== undefined) return promptfoo;
    const parts = parseReportParts(text);
    if (parts?.tests === undefined) return undefined;
    return parts.tests.tests.map(test => ({ keys: keysOfTest(test), status: test.status === "passed" ? "passed" as const : test.status === "skipped" ? "skipped" as const : "failed" as const }));
  } catch { return undefined; }
}

/** `id -> pass` for one run's rows: only questions with exactly one passed-or-failed case. */
function passByQuestion(rows: readonly CaseRow[], ids: ReadonlySet<string>): Map<string, boolean> {
  const found = new Map<string, CaseRow[]>();
  for (const row of rows) for (const key of row.keys) if (ids.has(key)) found.set(key, [...(found.get(key) ?? []), row]);
  const out = new Map<string, boolean>();
  for (const [id, matched] of found) {
    const distinct = new Set(matched);
    if (distinct.size !== 1) continue;
    const only = [...distinct][0]!;
    if (only.status !== "skipped") out.set(id, only.status === "passed");
  }
  return out;
}

/**
 * The measures file (JSON text) for these per-case reports, one per run (1 to 3), over the plan's question ids; undefined when nothing maps. Only a question present, with a result, in EVERY report is in it. The one measure is the
 * overall pass rate (the file needs one; the question rule reads the samples).
 */
export function measuresFromCaseReports(reports: readonly (readonly CaseRow[])[], ids: readonly string[]): string | undefined {
  try {
    if (reports.length < 1 || reports.length > 3) return undefined;
    const wanted = new Set(ids);
    const perRun = reports.map(rows => passByQuestion(rows, wanted));
    const questions = ids.filter(id => perRun.every(run => run.has(id))).map(id => ({ id, samples: perRun.map(run => ({ pass: run.get(id)!, answer: "" })) }));
    if (questions.length === 0) return undefined;
    const total = questions.length * reports.length;
    const passed = questions.reduce((sum, question) => sum + question.samples.filter(sample => sample.pass).length, 0);
    const file = { schemaVersion: 1, source: "project_runner", measures: [{ name: "eval_pass_rate", unit: "ratio", direction: "up_good", value: passed / total }], questions };
    return readMeasuresFile(file).status === "ok" ? JSON.stringify(file) : undefined;
  } catch { return undefined; }
}
