// TE-E0 option B: the worker's report adapters (#529) as the broker's `PipelineReportParser` port. The host wires this function into merge tracking; the broker has no dependency on the worker.
// Three answers, never a guess: a report (read whole by `parseReportParts`), `not_report` (a file that does not claim to be a test report: a coverage file, a config), or `unreadable` (a file that claims
// to be one, by its XML root or its JSON keys, but the adapters could not read it whole: truncated, malformed, over the cap, or a suite with no cases). Failure messages (JUnit only) are found with the
// same linear walk the adapter uses, over the same text with comments and CDATA taken out, and paired with their case only when the counts agree. No regular expression runs over the whole document.
import { CI_EVIDENCE_LIMITS, PIPELINE_FAILURE_TEXTS_MAX, PIPELINE_FAILURE_TEXT_TOTAL_MAX, PipelineReportSchema, redactText, type PipelineReportReading, type PipelineReportTest } from "@agentx/contracts";
import { parseReportParts } from "./report-adapters.js";
import { ATTRIBUTE_TEXT_MAX, parseAttributes, tagEnd, withoutCommentsAndCdata } from "./test-report.js";

/** How far into a file its root element is looked for. */
const ROOT_SCAN_CHARS = 4_096;
const REPORT_ROOTS: ReadonlySet<string> = new Set(["testsuites", "testsuite", "testcase", "testrun"]);

/** The name of an XML document's root element, read from its start only (a declaration and comments may come first), lower-cased; undefined when none is found near the start. */
function xmlRoot(text: string): string | undefined {
  let position = 0;
  const limit = Math.min(text.length, ROOT_SCAN_CHARS);
  while (position < limit) {
    const open = text.indexOf("<", position);
    if (open === -1 || open >= limit) return undefined;
    if (text.startsWith("<?", open)) { const end = text.indexOf("?>", open); if (end === -1) return undefined; position = end + 2; continue; }
    if (text.startsWith("<!--", open)) { const end = text.indexOf("-->", open + 4); if (end === -1) return undefined; position = end + 3; continue; }
    if (text.startsWith("<!", open)) return undefined;
    let end = open + 1;
    while (end < limit && /[A-Za-z0-9_:.-]/u.test(text[end]!)) end += 1;
    const name = text.slice(open + 1, end);
    const local = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
    return local === "" ? undefined : local.toLowerCase();
  }
  return undefined;
}

/** Whether JSON text claims to be a test report the adapters know (Jest/Vitest, CTRF, Go test events). Parsed once, linearly; a JSON value that is not an object is not a report. */
function jsonClaimsReport(text: string): boolean {
  const first = text.split("\n", 1)[0] ?? "";
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = value as Record<string, unknown>;
    return "testResults" in keys || "numTotalTests" in keys || ("results" in keys && typeof keys["results"] === "object" && keys["results"] !== null && "tests" in (keys["results"]));
  } catch {
    // Go's test2json writes one event per line; such a stream that did not parse whole still claims to be a report.
    try {
      const event = JSON.parse(first) as Record<string, unknown> | null;
      return event !== null && typeof event === "object" && "Action" in event && "Test" in event;
    } catch {
      return false;
    }
  }
}

/**
 * Each `<testcase>`'s failure message, in document order, from the text with comments and CDATA taken out, with the adapter's own walk (`indexOf` and `tagEnd`, each step forward): linear in the text.
 * Undefined when the walk does not find exactly `cases` cases, so a message is never put on another test.
 */
function junitFailureMessages(bare: string, cases: number): Array<string | undefined> | undefined {
  const found: Array<string | undefined> = [];
  let position = 0;
  for (;;) {
    const start = bare.indexOf("<testcase", position);
    if (start === -1) break;
    const after = bare[start + "<testcase".length];
    if (after !== undefined && !/[\s/>]/u.test(after)) { position = start + 1; continue; }
    const end = tagEnd(bare, start + "<testcase".length);
    if (end === -1) return undefined;
    const selfClosing = bare[end - 1] === "/";
    position = end + 1;
    let message: string | undefined;
    if (!selfClosing) {
      const close = bare.indexOf("</testcase", position);
      if (close === -1) return undefined;
      const body = bare.slice(position, close);
      position = close + 1;
      for (const tag of ["<failure", "<error"]) {
        const at = body.indexOf(tag);
        if (at === -1) continue;
        const tagClose = tagEnd(body, at + tag.length);
        const attributes = tagClose === -1 ? "" : body.slice(at + tag.length, tagClose);
        if (attributes.length <= ATTRIBUTE_TEXT_MAX) message = parseAttributes(attributes.endsWith("/") ? attributes.slice(0, -1) : attributes).get("message");
        break;
      }
    }
    found.push(message);
    if (found.length > cases) return undefined;
  }
  return found.length === cases ? found : undefined;
}

/** One line of untrusted text: cut first (a hostile message costs a bounded amount), then control characters out, redacted, cut again to the budget. */
const oneLine = (text: string, max: number): string => Array.from(redactText(Array.from(text).slice(0, max + 256).join("").replace(/[\p{Cc}\p{Cf}]/gu, " ")).replace(/\s+/gu, " ").trim()).slice(0, max).join("");

/** A file's reading for the port. */
export function parsePipelineReport(text: string): PipelineReportReading {
  const parts = parseReportParts(text);
  const tests = parts?.tests;
  if (tests === undefined) {
    const trimmed = text.trimStart();
    const claims = trimmed.startsWith("{") || trimmed.startsWith("[") ? jsonClaimsReport(trimmed) : REPORT_ROOTS.has(xmlRoot(trimmed) ?? "");
    return { kind: claims ? "unreadable" : "not_report" };
  }
  const bare = tests.format === "junit" ? withoutCommentsAndCdata(text) : undefined;
  const messages = bare === undefined ? undefined : junitFailureMessages(bare, tests.tests.length);
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
  return parsed.success ? { kind: "report", report: parsed.data } : { kind: "unreadable" };
}
