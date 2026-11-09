// Proof and evidence P2: what a check's own test report says. A JUnit XML file (pytest --junitxml, Maven, Gradle, Go's gotestsum), a vitest/jest JSON file or a `go test -json` event file the check ALREADY writes is read into totals, test
// names, the tests the change added or changed, and the number of skips among the tests the change did not touch. AgentX never alters a customer's command (the same rule as TESTPROOF), so a check with no
// report keeps one verdict and this module is never asked about it.
//
// Known limit (review M6): a `<testcase` inside another tag's attribute value, or an unclosed test case that swallows the next one, can merge or inflate counts; the broker's cross-check against its own check
// outcome (evidence-pack.ts) is what catches a report that disagrees with the run.
//
// Fail closed and bounded:
//   - the counts are those of the test cases actually read, never the file's own summary attributes (a header can say anything);
//   - a file that is too large, empty, not a report, or holds no test case at all is `undefined` ("not measured"), never an all-passed report;
//   - a suite that failed to run (jest and vitest list it with no test results and a message) counts as one errored test, so a load failure never reads as zero failures;
//   - every name is redacted, one plain line, and cut; at most 500 names go to the evidence, the failing ones first.
// Pure: no file is read here. The caller reads the bytes (inside the workspace, never through a link) and passes the text.
import { EVIDENCE_NEW_TESTS_MAX, EVIDENCE_TEST_NAMES_MAX, TEST_ID_MAX, isValidTestId, redactText, testIdOf, type EvidenceTest, type TestProofVerdict } from "@agentx/contracts";

/** A report file larger than this is not read (the TESTPROOF reader's own limit). */
export const TEST_REPORT_MAX_BYTES = 8 * 1024 * 1024;
/** More test cases than this in one report is not read: the counts could not be trusted to be complete. */
export const TEST_REPORT_MAX_TESTS = 50_000;
const NAME_MAX = 300;

export type ReportedTestStatus = "passed" | "failed" | "skipped" | "errored";
export interface ReportedTest {
  /** The test file or module, as the report names it (a path, or a dotted module path). */
  file?: string;
  /** The test's own name, redacted, one line, cut. After `withTestIds` it is the class path and the test (`TestRules::test_discount`) for a pytest report, so `file::name` is the test's id. */
  name: string;
  /** JUnit: the case's `classname` as the report wrote it (pytest writes the module and classes dotted: `tests.test_cart_rules.TestRules`). Kept so `withTestIds` can find the test's file and classes. */
  classname?: string;
  /** JUnit: `file` came from the case's own `file` attribute (a path), not made from the classname. */
  fileGiven?: boolean;
  status: ReportedTestStatus;
  durationMs?: number;
}
export interface ParsedTestReport {
  format: "junit" | "json" | "gotest";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  tests: ReportedTest[];
}

const DURATION_MAX_MS = 86_400_000;

/** An id that cannot be matched, shown as one plain line of at most 500 characters (an ellipsis marks a cut). */
export function displayLine(text: string): string {
  const line = text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const points = Array.from(line === "" ? "test" : line);
  return points.length <= TEST_ID_MAX ? points.join("") : `${points.slice(0, TEST_ID_MAX - 1).join("")}…`;
}

/** Longest text kept for a test's file or name while a report is read (a bound on memory, far above the 500 characters a valid id may have). */
const TEST_TEXT_MAX = 2_000;
/**
 * A test's file or name as the report wrote it (NH-1 re-check F2/F5): redacted for secrets, and nothing else. It is NOT turned into one plain line and NOT cut at 300 characters, because the test's id is built from it and
 * an id must be the real one: an id with a newline, a hidden character or more than 500 characters is simply not valid (`isValidTestId`), and is shown as a plain line and never matched. Empty is "test".
 */
export function testText(text: string): string {
  const kept = Array.from(redactText(text)).slice(0, TEST_TEXT_MAX).join("");
  return kept === "" ? "test" : kept;
}

/** One plain line: control and format characters become spaces, runs of spaces collapse, secrets are redacted, and it is cut. Empty becomes "test". */
export function plainName(text: string): string {
  const line = redactText(text.replace(/[\p{Cc}\p{Cf}]+/gu, " ")).replace(/\s+/gu, " ").trim();
  return line === "" ? "test" : Array.from(line).slice(0, NAME_MAX).join("");
}

export function counted(format: ParsedTestReport["format"], tests: ReportedTest[]): ParsedTestReport {
  const count = (status: ReportedTestStatus) => tests.filter((test) => test.status === status).length;
  return { format, total: tests.length, passed: count("passed"), failed: count("failed"), skipped: count("skipped"), errored: count("errored"), tests };
}

function duration(seconds: number | undefined, unit: "s" | "ms"): number | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(DURATION_MAX_MS, Math.round(unit === "s" ? seconds * 1000 : seconds));
}

// ---- JUnit XML

const ENTITY = /&(?:lt|gt|quot|apos|amp|#(\d{1,7})|#x([0-9a-fA-F]{1,6}));/g;
export function unescapeXml(text: string): string {
  return text.replace(ENTITY, (match, decimal: string | undefined, hex: string | undefined) => {
    if (decimal !== undefined || hex !== undefined) {
      const code = decimal !== undefined ? Number(decimal) : parseInt(hex!, 16);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
    }
    return { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&amp;": "&" }[match] ?? match;
  });
}

/**
 * Removes comments and CDATA sections in one pass, so text inside them can never look like a test case. A comment or CDATA section that is never closed makes the file unreadable (`undefined`):
 * the rest could be anything.
 */
export function withoutCommentsAndCdata(text: string): string | undefined {
  const pieces: string[] = [];
  let position = 0;
  for (;;) {
    const comment = text.indexOf("<!--", position);
    const cdata = text.indexOf("<![CDATA[", position);
    const start = comment === -1 ? cdata : cdata === -1 ? comment : Math.min(comment, cdata);
    if (start === -1) break;
    const closing = start === comment ? "-->" : "]]>";
    const end = text.indexOf(closing, start + 4);
    if (end === -1) return undefined;
    pieces.push(text.slice(position, start));
    position = end + closing.length;
  }
  pieces.push(text.slice(position));
  return pieces.join("");
}

/** The end of the tag that starts at `from` (the index of its `>`), reading quotes so a `>` inside an attribute value does not end it. -1 when it never ends. */
export function tagEnd(text: string, from: number): number {
  let quote = "";
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== "") {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return -1;
}

/** A tag's attribute text longer than this makes the file unreadable: no real test case has attributes this long. */
export const ATTRIBUTE_TEXT_MAX = 16_384;
const NAME_CHAR = /[\w:.-]/;
const SPACE = /\s/;

/** `name="value"` and `name='value'` pairs in one forward pass (no regular expression, no backtracking): each character is looked at once. A malformed pair is skipped, never retried. */
export function parseAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let index = 0;
  while (index < text.length) {
    while (index < text.length && SPACE.test(text[index]!)) index += 1;
    const nameStart = index;
    while (index < text.length && NAME_CHAR.test(text[index]!)) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const name = text.slice(nameStart, index);
    while (index < text.length && SPACE.test(text[index]!)) index += 1;
    if (text[index] !== "=") continue;
    index += 1;
    while (index < text.length && SPACE.test(text[index]!)) index += 1;
    const quote = text[index];
    if (quote !== '"' && quote !== "'") continue;
    const close = text.indexOf(quote, index + 1);
    if (close === -1) break;
    if (!attributes.has(name)) attributes.set(name, unescapeXml(text.slice(index + 1, close)));
    index = close + 1;
  }
  return attributes;
}

/**
 * JUnit XML: `<testcase classname name file? time?>` with a `<failure>`, `<error>` or `<skipped>` child when it did not pass. Comments and CDATA are removed first. A case with both a failure and an
 * error is errored. Nested `<testsuites>` and `<testsuite>` are read through; their own count attributes are ignored. The scan is one forward pass (no backtracking), because the file is written by a
 * command the agent can influence: a file built to be slow to read is refused when it is malformed (an unclosed tag, comment or CDATA section), and costs a single pass when it is not.
 */
export function parseJunit(text: string): ParsedTestReport | undefined {
  const bare = withoutCommentsAndCdata(text);
  if (bare === undefined || !/<(?:testsuites?|testcase)[\s/>]/.test(bare)) return undefined;
  const tests: ReportedTest[] = [];
  let position = 0;
  for (;;) {
    const start = bare.indexOf("<testcase", position);
    if (start === -1) break;
    const after = bare[start + "<testcase".length];
    if (after === undefined || !/[\s/>]/.test(after)) {
      position = start + 1;
      continue;
    }
    if (tests.length >= TEST_REPORT_MAX_TESTS) return undefined;
    const end = tagEnd(bare, start + "<testcase".length);
    if (end === -1) return undefined;
    const selfClosing = bare[end - 1] === "/";
    const attributeText = bare.slice(start + "<testcase".length, selfClosing ? end - 1 : end);
    if (attributeText.length > ATTRIBUTE_TEXT_MAX) return undefined;
    let body = "";
    position = end + 1;
    if (!selfClosing) {
      const close = bare.indexOf("</testcase", position);
      if (close === -1) return undefined;
      body = bare.slice(position, close);
      position = close + 1;
    }
    const attributes = parseAttributes(attributeText);
    const status: ReportedTestStatus = /<error[\s/>]/.test(body) ? "errored" : /<failure[\s/>]/.test(body) ? "failed" : /<skipped[\s/>]/.test(body) ? "skipped" : "passed";
    const classname = attributes.get("classname");
    const rawFile = attributes.get("file") ?? (classname === undefined || classname === "" ? undefined : /[/\\]/.test(classname) ? classname : classname.replaceAll(".", "/"));
    // The file is text from a file the agent can write, kept and shown like the name: one plain line, secrets redacted, cut.
    const file = rawFile === undefined || rawFile === "" ? undefined : testText(rawFile);
    const time = attributes.get("time") === undefined ? undefined : Number(attributes.get("time"));
    const ms = duration(time, "s");
    tests.push({ ...(file === undefined ? {} : { file }), name: testText(attributes.get("name") ?? ""), status, ...(classname === undefined || classname === "" ? {} : { classname: testText(classname) }), ...(attributes.get("file") === undefined ? {} : { fileGiven: true }), ...(ms === undefined ? {} : { durationMs: ms }) });
  }
  return tests.length === 0 ? undefined : counted("junit", tests);
}

// ---- vitest / jest JSON

interface JsonAssertion { fullName?: unknown; title?: unknown; status?: unknown; duration?: unknown }
interface JsonSuite { name?: unknown; status?: unknown; message?: unknown; assertionResults?: unknown }

/**
 * vitest `--reporter=json` and jest `--json`: `{ testResults: [{ name, status, message, assertionResults: [{ fullName, status, duration }] }] }`. `failed` is failed; `passed` is passed; `pending`, `todo`,
 * `skipped` and `disabled` are skipped; any other status is errored. A suite that failed with no failing test of its own (no results, or a hook failure after passing tests) adds one errored test named for the file.
 */
export function parseJsonReport(text: string): ParsedTestReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const suites = typeof parsed === "object" && parsed !== null ? (parsed as { testResults?: unknown }).testResults : undefined;
  if (!Array.isArray(suites)) return undefined;
  const tests: ReportedTest[] = [];
  const SKIPPED_STATUSES = new Set(["pending", "todo", "skipped", "disabled"]);
  for (const suite of suites as JsonSuite[]) {
    if (typeof suite !== "object" || suite === null) continue;
    const file = typeof suite.name === "string" && suite.name !== "" ? suite.name : undefined;
    const results = Array.isArray(suite.assertionResults) ? (suite.assertionResults as JsonAssertion[]) : [];
    const objects = results.filter((result): result is JsonAssertion => typeof result === "object" && result !== null);
    for (const result of objects) {
      if (tests.length >= TEST_REPORT_MAX_TESTS) return undefined;
      // Fail closed: only a status that means "did not run on purpose" is skipped; any other word (a new one, garbage) is an error, never a quiet skip.
      const status: ReportedTestStatus = result.status === "passed" ? "passed" : result.status === "failed" ? "failed" : typeof result.status === "string" && SKIPPED_STATUSES.has(result.status) ? "skipped" : "errored";
      const name = typeof result.fullName === "string" ? result.fullName : typeof result.title === "string" ? result.title : "";
      const ms = duration(typeof result.duration === "number" ? result.duration : undefined, "ms");
      tests.push({ ...(file === undefined ? {} : { file }), name: testText(name), status, ...(ms === undefined ? {} : { durationMs: ms }) });
    }
    // A suite that failed with no failing test of its own (it failed to load, or a hook such as afterAll failed) keeps its failure as one errored entry named for the file.
    if (suite.status === "failed" && !objects.some((result) => result.status === "failed")) {
      if (tests.length >= TEST_REPORT_MAX_TESTS) return undefined;
      tests.push({ ...(file === undefined ? {} : { file }), name: testText(file ?? "test suite"), status: "errored" });
    }
  }
  return tests.length === 0 ? undefined : counted("json", tests);
}

// ---- go test -json

const GO_ACTIONS: ReadonlySet<string> = new Set(["start", "run", "pause", "cont", "pass", "bench", "fail", "output", "skip", "build-output", "build-fail"]);
const GO_LINE_MAX_CHARS = 1_048_576;

interface GoEvent { action: string; pkg: string; test: string | undefined; elapsed: number | undefined }

/** One line of a `go test -json` stream as an event, or undefined when it is not one (any other text, a line that is too long, a wrong type or an Action Go does not define). */
function goEvent(line: string): GoEvent | undefined {
  if (line.length > GO_LINE_MAX_CHARS || !line.startsWith("{")) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const event = parsed as { Action?: unknown; Package?: unknown; Test?: unknown; Elapsed?: unknown };
  if (typeof event.Action !== "string" || !GO_ACTIONS.has(event.Action) || typeof event.Package !== "string" || event.Package === "") return undefined;
  return { action: event.Action, pkg: event.Package, test: typeof event.Test === "string" && event.Test !== "" ? event.Test : undefined, elapsed: typeof event.Elapsed === "number" ? event.Elapsed : undefined };
}

/** Whether the first non-empty line is a `go test -json` event: how `auto` tells it from vitest/jest JSON, which is one object with no `Action`. */
export function looksLikeGoTestJson(text: string): boolean {
  const start = text.search(/\S/u);
  if (start === -1) return false;
  const end = text.indexOf("\n", start);
  return goEvent((end === -1 ? text.slice(start) : text.slice(start, end)).trim()) !== undefined;
}

/**
 * `go test -json` (test2json): one event per line. Only the Action, Package, Test and Elapsed fields are read; the Output text, where a test can print anything, never is. A `pass`, `fail` or `skip` event with a
 * Test is one test (a subtest and its parent are both tests, and a repeated run with -count counts again). A test that started and never finished is errored, so a file cut short never reads as passing. A package
 * that failed with no failing test of its own (a build failure, a panic outside a test) is one errored entry named for the package. Lines that are not events are skipped; a file with no test result is `undefined`.
 * `file` is the package's import path: it is not a test file, so no test is ever taken for one the change touched.
 */
export function parseGoTestJson(text: string): ParsedTestReport | undefined {
  const tests: ReportedTest[] = [];
  const running = new Map<string, number>();
  const failedTestsIn = new Set<string>();
  const failedPackages: string[] = [];
  const key = (pkg: string, test: string): string => `${pkg}\u0000${test}`;
  for (const raw of text.split("\n")) {
    const event = goEvent(raw.trim());
    if (event === undefined) continue;
    if (event.test === undefined) {
      if (event.action === "fail" && !failedPackages.includes(event.pkg)) failedPackages.push(event.pkg);
      continue;
    }
    if (event.action === "run") { running.set(key(event.pkg, event.test), (running.get(key(event.pkg, event.test)) ?? 0) + 1); continue; }
    const status: ReportedTestStatus | undefined = event.action === "pass" ? "passed" : event.action === "fail" ? "failed" : event.action === "skip" ? "skipped" : undefined;
    if (status === undefined) continue;
    if (tests.length >= TEST_REPORT_MAX_TESTS) return undefined;
    const pending = running.get(key(event.pkg, event.test)) ?? 0;
    if (pending > 0) running.set(key(event.pkg, event.test), pending - 1);
    if (status === "failed") failedTestsIn.add(event.pkg);
    const ms = duration(event.elapsed, "s");
    tests.push({ file: event.pkg, name: testText(event.test), status, ...(ms === undefined ? {} : { durationMs: ms }) });
  }
  for (const [entry, pending] of running) {
    for (let count = 0; count < pending; count += 1) {
      if (tests.length >= TEST_REPORT_MAX_TESTS) return undefined;
      const [pkg, test] = entry.split("\u0000") as [string, string];
      tests.push({ file: pkg, name: testText(test), status: "errored" });
    }
  }
  for (const pkg of failedPackages) {
    if (failedTestsIn.has(pkg)) continue;
    if (tests.length >= TEST_REPORT_MAX_TESTS) return undefined;
    tests.push({ file: pkg, name: testText(pkg), status: "errored" });
  }
  return tests.length === 0 ? undefined : counted("gotest", tests);
}

/**
 * Reads a report's text in the format its check names (`junit`, `json`) or, for `auto`, the one it looks like (JSON starts with `{`). A `go test -json` event stream is recognised by its content under `auto` and
 * `json`. Anything else, or a text over the size cap, is `undefined`: not measured.
 */
export function parseTestReport(text: string, format: "junit" | "json" | "auto" = "auto"): ParsedTestReport | undefined {
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > TEST_REPORT_MAX_BYTES) return undefined;
  if (format !== "junit" && looksLikeGoTestJson(text)) return parseGoTestJson(text);
  const kind = format === "auto" ? (text.trimStart().startsWith("{") ? "json" : "junit") : format;
  return kind === "json" ? parseJsonReport(text) : parseJunit(text);
}

// ---- tests the change touched

/** A report's file (absolute, relative, or a dotted module path with no extension) against a changed path relative to the repository. */
function sameFile(file: string, path: string): boolean {
  const bare = path.replace(/\.[^./]+$/, "");
  return file === path || file.endsWith(`/${path}`) || file === bare || file.endsWith(`/${bare}`);
}

/** The changed test path a reported test belongs to, if any. */
export function changedPathOf(test: ReportedTest, changedTestPaths: readonly string[]): string | undefined {
  return test.file === undefined ? undefined : changedTestPaths.find((path) => sameFile(test.file!, path));
}

/** How many tests were skipped that the change did NOT touch (their file is not among the added or changed test files): the number a rise in skips is judged on. */
export function skippedOutsideChanged(report: ParsedTestReport, changedTestPaths: readonly string[]): number {
  return report.tests.filter((test) => test.status === "skipped" && changedPathOf(test, changedTestPaths) === undefined).length;
}

/**
 * A rise in skipped tests the change did not touch: a way to make a check pass without fixing anything. `before` is the report of the run on the original code (or the baseline); `after` the run on the
 * candidate. Without both reports there is nothing to compare and no claim is made.
 */
export function skipRise(before: ParsedTestReport | undefined, after: ParsedTestReport | undefined, changedTestPaths: readonly string[]): { rose: boolean; before: number; after: number } | undefined {
  if (before === undefined || after === undefined) return undefined;
  const was = skippedOutsideChanged(before, changedTestPaths);
  const now = skippedOutsideChanged(after, changedTestPaths);
  return { rose: now > was, before: was, after: now };
}

/** The `tests` part of a check in the evidence pack (`EvidencePack.checks[].tests`). */
export interface EvidenceTests {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  skippedBefore?: number;
  skippedAfter?: number;
  names: EvidenceTest[];
  newTests: string[];
}

export interface EvidenceTestsOptions {
  /** Test files the change added or changed, relative to the repository. */
  changedTestPaths?: readonly string[];
  /** TESTPROOF's verdict per test, by the reported name (only per-test items). */
  proofByTest?: ReadonlyMap<string, TestProofVerdict>;
  /** The skips among untouched tests on the run before and on this run (`skipRise`'s numbers): both go in the evidence, so the broker can judge a rise itself. */
  skippedOutside?: { before: number; after: number };
}

/**
 * The evidence's view of a report: the totals, at most 500 names (failing and errored tests first, then the tests the change touched, then the rest in report order) and at most 100 new tests (a passing
 * or failing test in an added or changed test file). A name the evidence keeps is never a different test's: a duplicate name in one file keeps its first.
 */
export function evidenceTests(report: ParsedTestReport, options: EvidenceTestsOptions = {}): EvidenceTests {
  const changed = options.changedTestPaths ?? [];
  const touched = (test: ReportedTest) => changedPathOf(test, changed) !== undefined;
  const rank = (test: ReportedTest) => (test.status === "failed" || test.status === "errored" ? 0 : touched(test) ? 1 : 2);
  const ordered = report.tests.map((test, index) => ({ test, index })).sort((a, b) => rank(a.test) - rank(b.test) || a.index - b.index);
  const names: EvidenceTest[] = [];
  const seen = new Set<string>();
  for (const { test } of ordered) {
    if (names.length >= EVIDENCE_TEST_NAMES_MAX) break;
    // The name the pack keeps is the test's ID (contracts `testIdOf`), the string the nightly run and the known-failing marks use for the same test.
    const id = testIdOf(test);
    if (seen.has(id)) continue;
    seen.add(id);
    const proof = touched(test) ? (options.proofByTest?.get(id) ?? options.proofByTest?.get(test.name)) : undefined;
    // An id that is not valid (hidden characters, too long, a space at an end) is shown as a plain line, cut with an ellipsis, and marked `unlisted`: it is counted, never matched against the nightly's failing set or the marks.
    names.push({ name: isValidTestId(id) ? id : displayLine(id), ...(isValidTestId(id) ? {} : { unlisted: true as const }), status: test.status, ...(proof === undefined ? {} : { proof }), ...(test.durationMs === undefined ? {} : { durationMs: test.durationMs }) });
  }
  const newTests = [...new Set(report.tests.filter((test) => test.status !== "skipped" && touched(test)).map((test) => { const id = testIdOf(test); return isValidTestId(id) ? id : displayLine(id); }))].slice(0, EVIDENCE_NEW_TESTS_MAX);
  return {
    total: report.total, passed: report.passed, failed: report.failed, skipped: report.skipped, errored: report.errored,
    ...(options.skippedOutside === undefined ? {} : { skippedBefore: options.skippedOutside.before, skippedAfter: options.skippedOutside.after }),
    names, newTests,
  };
}
