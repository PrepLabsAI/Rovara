// TE-E0 option B: the worker's report adapters (#529) as the broker's `PipelineReportParser` port. The host wires this function into merge tracking; the broker has no dependency on the worker.
// A report is read whole or not at all: names and outcomes from `parseReportParts`, and, for JUnit only, each failed case's message, paired with its case by document order only when the counts agree
// (otherwise no failure text at all, never a text on the wrong test). Failure text is untrusted: one line, redacted, cut, and bounded in total.
import { CI_EVIDENCE_LIMITS, PIPELINE_FAILURE_TEXTS_MAX, PIPELINE_FAILURE_TEXT_TOTAL_MAX, PipelineReportSchema, redactText, type PipelineReport, type PipelineReportTest } from "@agentx/contracts";
import { parseReportParts } from "./report-adapters.js";

/** The `message` of each `<failure>` or `<error>` in document order, one per `<testcase>` that has one (undefined when the cases cannot be told apart). */
function junitFailureMessages(text: string, cases: number): Array<string | undefined> | undefined {
  const found: Array<string | undefined> = [];
  const testcase = /<testcase\b[^>]*?(\/>|>([\s\S]*?)<\/testcase\s*>)/gu;
  for (const match of text.matchAll(testcase)) {
    const body = match[2] ?? "";
    const failure = /<(?:failure|error)\b([^>]*)>/u.exec(body);
    const message = failure === null ? undefined : /\bmessage\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(failure[1] ?? "");
    found.push(message === null || message === undefined ? undefined : (message[1] ?? message[2]));
    if (found.length > cases) return undefined;
  }
  return found.length === cases ? found : undefined;
}

/** An XML declaration and comments at most, then a `testsuites` or `testsuite` root. */
const EMPTY_JUNIT = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<testsuites?[\s/>]/u;

const decode = (text: string): string => text.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"").replace(/&apos;/gu, "'").replace(/&amp;/gu, "&");
const oneLine = (text: string, max: number): string => Array.from(redactText(decode(text).replace(/[\p{Cc}\p{Cf}]/gu, " ")).replace(/\s+/gu, " ").trim()).slice(0, max).join("");

/** A report's tests as the port gives them, or undefined when the text is not a report the adapters read whole. */
export function parsePipelineReport(text: string): PipelineReport | undefined {
  const parts = parseReportParts(text);
  const tests = parts?.tests;
  // A JUnit document whose root is a test suite and that holds no test case at all is a report that says "no test ran" (the adapters read it as no report): the pipeline failed before its tests.
  if (tests === undefined) return EMPTY_JUNIT.test(text) && !/<testcase[\s/>]/u.test(text) ? { tests: [] } : undefined;
  const messages = tests.format === "junit" ? junitFailureMessages(text, tests.tests.length) : undefined;
  let textBudget = PIPELINE_FAILURE_TEXT_TOTAL_MAX;
  let texts = 0;
  const out: PipelineReportTest[] = tests.tests.map((test, index) => {
    const id = test.file === undefined || test.file === "" ? test.name : `${test.file}::${test.name}`;
    const outcome = test.status === "passed" ? "passed" as const : test.status === "skipped" ? "skipped" as const : "failed" as const;
    const raw = outcome === "failed" ? messages?.[index] : undefined;
    let failureText: string | undefined;
    if (raw !== undefined && texts < PIPELINE_FAILURE_TEXTS_MAX && textBudget > 0) {
      const line = oneLine(raw, Math.min(CI_EVIDENCE_LIMITS.failureTextMax, textBudget));
      if (line !== "") { failureText = line; textBudget -= line.length; texts += 1; }
    }
    return { id: Array.from(id).slice(0, 1_000).join(""), outcome, ...(failureText === undefined ? {} : { failureText }) };
  });
  const parsed = PipelineReportSchema.safeParse({ tests: out });
  return parsed.success ? parsed.data : undefined;
}
