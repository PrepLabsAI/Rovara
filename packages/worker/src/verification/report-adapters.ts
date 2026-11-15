// Closed, in-process adapter table (TE-A4/TE-IF4). A row recognises a format and returns only the parts it measured.
// The legacy functions stay in test-report.ts so existing callers and their byte-for-byte outputs remain unchanged.
// Table callbacks are lazy: neither side of this module's test-report import cycle reads the other's constants at initialisation.
import { readMeasuresFile, type MeasuresFile } from "@agentx/contracts";
import { ATTRIBUTE_TEXT_MAX, TEST_REPORT_MAX_BYTES, TEST_REPORT_MAX_TESTS, counted, looksLikeGoTestJson, parseAttributes, parseGoTestJson, parseJsonReport, parseJunit, tagEnd, testText, type ParsedTestReport, type ReportedTest } from "./test-report.js";

export type ReportFormat = ParsedTestReport["format"] | "measures";
export type ReportFormatHint = ReportFormat | "auto";
export interface ReportTiming { testIndex: number; startTimeMs?: number; endTimeMs?: number }
export interface ReportParts {
  format: ReportFormat;
  tests?: ParsedTestReport;
  measures?: MeasuresFile;
  /** Per-test clocks for legacy formats, kept outside their unchanged test objects. */
  timings?: ReportTiming[];
  /** A future measures version was ignored; no measured part is present. */
  newer?: true;
}
export interface ReportAdapter {
  format: ReportFormat;
  family: "xml" | "json";
  parts: readonly ("tests" | "measures")[];
  sniff(text: string): boolean;
  parse(text: string): ReportParts | undefined;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const unbom = (text: string): string => text.replace(/^\uFEFF/u, "");

/** Single forward scan before JSON.parse; strings and escapes do not contribute to the nesting depth. */
function jsonObject(text: string): JsonObject | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") { depth += 1; if (depth > 64) return undefined; }
    else if (char === "}" || char === "]") depth -= 1;
  }
  try { const value: unknown = JSON.parse(unbom(text)); return object(value) ? value : undefined; } catch { return undefined; }
}

function testsPart(tests: ParsedTestReport | undefined): ReportParts | undefined {
  return tests === undefined ? undefined : { format: tests.format, tests };
}
const validTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
const duration = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400_000 ? Math.round(value) : undefined;
function times(start: unknown, end: unknown): Pick<ReportedTest, "startTimeMs" | "endTimeMs"> {
  if (validTime(start) && validTime(end) && end < start) return {};
  return { ...(validTime(start) ? { startTimeMs: start } : {}), ...(validTime(end) ? { endTimeMs: end } : {}) };
}

function parseCtrf(text: string): ReportParts | undefined {
  const root = jsonObject(text);
  const rows = root !== undefined && object(root.results) ? root.results.tests : undefined;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > TEST_REPORT_MAX_TESTS) return undefined;
  const tests: ReportedTest[] = [];
  for (const row of rows as unknown[]) {
    if (!object(row) || typeof row.name !== "string" || row.name === "") return undefined;
    const status = row.status === "passed" ? "passed" : row.status === "failed" ? "failed" : row.status === "skipped" || row.status === "pending" ? "skipped" : "errored";
    const ms = duration(row.duration);
    tests.push({ name: testText(row.name), status, ...(typeof row.filepath === "string" && row.filepath !== "" ? { file: testText(row.filepath) } : {}), ...(ms === undefined ? {} : { durationMs: ms }), ...times(row.start, row.stop) });
  }
  return testsPart(counted("ctrf", tests));
}

function timestamp(text: string | undefined): number | undefined {
  if (text === undefined || text.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) return undefined;
  const value = Date.parse(text);
  return validTime(value) ? value : undefined;
}
function trxDuration(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const match = /^(?:(\d{1,7})\.)?(\d{2}):([0-5]\d):([0-5]\d)(?:\.(\d{1,7}))?$/u.exec(text);
  return match === null ? undefined : duration((Number(match[1] ?? 0) * 86400 + Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]) + Number(`0.${match[5] ?? "0"}`)) * 1000);
}

/** A bounded XML token scan, not a general entity-capable XML parser. No DTD, resolver, substitution or external I/O exists. */
function parseTrx(text: string): ReportParts | undefined {
  const stack: string[] = [];
  const tests: ReportedTest[] = [];
  let position = 0;
  let rootSeen = false;
  for (;;) {
    const start = text.indexOf("<", position);
    if (start === -1) {
      if (text.slice(position).trim() !== "") return undefined;
      break;
    }
    if (stack.length === 0 && text.slice(position, start).trim() !== "") return undefined;
    if (text.startsWith("<!--", start) || text.startsWith("<![CDATA[", start) || text.startsWith("<?", start)) {
      const close = text.startsWith("<!--", start) ? "-->" : text.startsWith("<?", start) ? "?>" : "]]>";
      const end = text.indexOf(close, start + 2);
      if (end === -1) return undefined;
      position = end + close.length;
      continue;
    }
    const end = tagEnd(text, start + 1);
    if (end === -1 || end - start > ATTRIBUTE_TEXT_MAX) return undefined;
    const token = text.slice(start + 1, end);
    const match = /^(\/?)([\w:.-]+)(?=[\s/]|$)/u.exec(token);
    if (match === null) return undefined;
    const closing = match[1] === "/";
    const qualifiedName = match[2]!;
    const name = qualifiedName.split(":").at(-1)!;
    const selfClosing = token.endsWith("/");
    if (closing) {
      if (token.slice(match[0].length).trim() !== "" || stack.pop() !== qualifiedName) return undefined;
    } else {
      if (stack.length === 0) {
        if (rootSeen || name !== "TestRun") return undefined;
        rootSeen = true;
      }
      if (stack.length >= 64) return undefined;
      if (name === "UnitTestResult" && stack.length === 2 && stack[1]!.split(":").at(-1) === "Results") {
        if (tests.length >= TEST_REPORT_MAX_TESTS) return undefined;
        const attrs = parseAttributes(token.slice(match[0].length, selfClosing ? -1 : undefined));
        const outcome = attrs.get("outcome");
        const status = outcome === "Passed" ? "passed" : outcome === "Failed" ? "failed" : outcome === "NotExecuted" ? "skipped" : "errored";
        const ms = trxDuration(attrs.get("duration"));
        tests.push({ name: testText(attrs.get("testName") ?? "test"), status, ...(ms === undefined ? {} : { durationMs: ms }), ...times(timestamp(attrs.get("startTime")), timestamp(attrs.get("endTime"))) });
      }
      if (!selfClosing) stack.push(qualifiedName);
    }
    position = end + 1;
  }
  return stack.length !== 0 || tests.length === 0 ? undefined : testsPart(counted("trx", tests));
}

/** Go's run/terminal event clocks, in the same result order as the legacy parser (including retries). */
function parseGoParts(text: string): ReportParts | undefined {
  const part = testsPart(parseGoTestJson(text));
  if (part === undefined) return undefined;
  const pending = new Map<string, { starts: (number | undefined)[]; next: number }>();
  const timings: ReportTiming[] = [];
  let testIndex = 0;
  const keep = (start: unknown, end: unknown) => {
    const clock = times(start, end);
    if (clock.startTimeMs !== undefined || clock.endTimeMs !== undefined) timings.push({ testIndex, ...clock });
    testIndex += 1;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length > 1_048_576) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!object(event) || typeof event.Package !== "string" || event.Package === "" || typeof event.Test !== "string" || event.Test === "") continue;
    const key = JSON.stringify([event.Package, event.Test]);
    const clock = timestamp(typeof event.Time === "string" ? event.Time : undefined);
    if (event.Action === "run") {
      const runs = pending.get(key) ?? { starts: [], next: 0 };
      runs.starts.push(clock); pending.set(key, runs);
    } else if (event.Action === "pass" || event.Action === "fail" || event.Action === "skip") {
      const runs = pending.get(key);
      keep(runs === undefined || runs.next >= runs.starts.length ? undefined : runs.starts[runs.next++], clock);
    }
  }
  for (const runs of pending.values()) for (let index = runs.next; index < runs.starts.length; index += 1) keep(runs.starts[index], undefined);
  return timings.length === 0 ? part : { ...part, timings };
}

/** Jest supplies assertion startAt and duration; suite-level clocks never become per-test clocks. */
function parseJestParts(text: string): ReportParts | undefined {
  const part = testsPart(parseJsonReport(text));
  if (part === undefined) return undefined;
  const suites = jsonObject(text)?.testResults;
  if (!Array.isArray(suites)) return part;
  const timings: ReportTiming[] = [];
  let testIndex = 0;
  for (const raw of suites as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const suite = raw as JsonObject;
    const rows: unknown[] = Array.isArray(suite.assertionResults) ? suite.assertionResults as unknown[] : [];
    let failed = false;
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const result = row as JsonObject;
      const ms = duration(result.duration);
      const clock = times(result.startAt, validTime(result.startAt) && ms !== undefined ? result.startAt + ms : undefined);
      if (clock.startTimeMs !== undefined) timings.push({ testIndex, ...clock });
      failed ||= result.status === "failed";
      testIndex += 1;
    }
    if (suite.status === "failed" && !failed) testIndex += 1;
  }
  return timings.length === 0 ? part : { ...part, timings };
}

function parseMeasures(text: string): ReportParts | undefined {
  const root = jsonObject(text);
  const read = readMeasuresFile(root);
  return read.status === "unreadable" ? undefined : read.status === "newer" ? { format: "measures", newer: true } : { format: "measures", measures: read.file };
}

/** Skip only the XML preamble in a forward scan. DTD contents are never resolved or expanded. */
function xmlRootName(text: string): string | undefined {
  let position = 0;
  for (;;) {
    const start = text.indexOf("<", position);
    if (start === -1) return undefined;
    if (text.startsWith("<!--", start) || text.startsWith("<?", start)) {
      const close = text.startsWith("<!--", start) ? "-->" : "?>";
      const end = text.indexOf(close, start + 2);
      if (end === -1) return undefined;
      position = end + close.length;
      continue;
    }
    if (text.startsWith("<!DOCTYPE", start)) {
      let quote = "";
      let subset = 0;
      let end = start + 9;
      for (; end < text.length; end += 1) {
        const char = text[end]!;
        if (quote !== "") { if (char === quote) quote = ""; }
        else if (text.startsWith("<!--", end) || text.startsWith("<?", end)) {
          const close = text.startsWith("<!--", end) ? "-->" : "?>";
          const markupEnd = text.indexOf(close, end + 2);
          if (markupEnd === -1) return undefined;
          end = markupEnd + close.length - 1;
        } else if (char === '"' || char === "'") quote = char;
        else if (char === "[") subset += 1;
        else if (char === "]") subset -= 1;
        else if (char === ">" && subset === 0) break;
      }
      if (end === text.length) return undefined;
      position = end + 1;
      continue;
    }
    return /^<([\w:.-]+)(?=[\s/>])/u.exec(text.slice(start))?.[1]?.split(":").at(-1);
  }
}

/** Specific JSON formats precede the generic Jest/Vitest row. A recognised but unreadable format never falls through. */
export const REPORT_ADAPTERS: readonly ReportAdapter[] = [
  { format: "gotest", family: "json", parts: ["tests"], sniff: (text) => looksLikeGoTestJson(text), parse: parseGoParts },
  { format: "measures", family: "json", parts: ["measures"], sniff: (text) => { const root = jsonObject(text); return root !== undefined && !Object.hasOwn(root, "testResults") && Object.hasOwn(root, "schemaVersion") && Object.hasOwn(root, "measures"); }, parse: parseMeasures },
  { format: "ctrf", family: "json", parts: ["tests"], sniff: (text) => { const root = jsonObject(text); return root !== undefined && !Object.hasOwn(root, "testResults") && (root.reportFormat === "CTRF" || (object(root.results) && object(root.results.tool) && Object.hasOwn(root.results, "tests"))); }, parse: parseCtrf },
  { format: "json", family: "json", parts: ["tests"], sniff: () => true, parse: parseJestParts },
  { format: "trx", family: "xml", parts: ["tests"], sniff: (text) => xmlRootName(text) === "TestRun", parse: parseTrx },
  { format: "junit", family: "xml", parts: ["tests"], sniff: () => true, parse: (text) => testsPart(parseJunit(text)) },
];

/** The only table entry point. Size is checked before sniffing, and JSON never reaches an XML parser. */
export function parseReportParts(text: string, hint: ReportFormatHint = "auto"): ReportParts | undefined {
  if (text.length === 0 || text.length > TEST_REPORT_MAX_BYTES || Buffer.byteLength(text, "utf8") > TEST_REPORT_MAX_BYTES) return undefined;
  const family = text.trimStart().startsWith("{") || text.trimStart().startsWith("[") ? "json" : "xml";
  const adapter = REPORT_ADAPTERS.find((row) => row.family === family && (hint === "auto" || hint === row.format || (hint === "json" && (row.format === "gotest" || row.format === "ctrf"))) && row.sniff(text));
  return adapter?.parse(text);
}
