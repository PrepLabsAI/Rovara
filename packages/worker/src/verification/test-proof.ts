// TESTPROOF: does a test the change added or changed really fail without the change?
//
// At the end of a CHECKS run, the test files the candidate added or changed (versus the task's start commit) are kept while every other file
// shows the original code (original-code.ts, with an overlay), and the same project checks that just passed on the candidate run once more
// there. A new test that fails on the original code and passes now proves the change; one that passes on both proves nothing.
//
// Informational only: this never changes a check result, never blocks and never sends the work back. A timeout, a stop or a fault is only
// "not checked". The one thing that is not survivable is failing to put the agent's files back (AgentFilesRestoreError), which is rethrown.
//
// How an old-code failure is told apart (best effort, from the check's output; the output is a redacted tail):
//   load failure   a module, file or symbol is missing, or the code does not parse or compile (Cannot find module, does not provide an export
//                  named, ImportError, SyntaxError, TypeScript errors, "failed to run", collection errors, "is not a function", Rust, Go and
//                  Java compile errors). Checked first, so a mixed run never claims a proof it cannot back.
//   assertion      AssertionError, "expected X to be Y", pytest's `assert` lines, Go's `--- FAIL`, Expected/Actual pairs.
//   neither        a failure AgentX cannot tell is "could not run on the original code" (never "proves").
// A verdict is per check, unless the check's own command already writes a vitest/jest JSON or a JUnit XML report to a path its arguments name
// (--outputFile, --junitxml): then it is per test, for the tests in the changed files. AgentX never alters a customer's command.
import { lstat, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isTestCommandHead, redactText, type CheckEntry, type ProjectCommand, type TestProof, type TestProofItem, type TestProofReason, type TestProofVerdict } from "@agentx/contracts";
import { runChecks, type CheckPlan, type CheckRunners } from "./checks.js";
import { isTestPath } from "./test-paths.js";
import { AgentFilesRestoreError, git, gitOriginalCode, type OriginalCode, type OriginalCodeRepository } from "./original-code.js";

/** The whole run on the original code gets this long, inside what is left of the check round's budget. */
export const TEST_PROOF_CAP_MS = 10 * 60_000;
const ITEMS_MAX = 200;
/** Less budget than this left, and the run on the original code is not started: it could not finish a real check. */
export const MIN_TEST_PROOF_BUDGET_MS = 60_000;
/** test-proof.json stays well below the broker loader's 256 KiB read limit. */
const PROOF_MAX_BYTES = 200 * 1024;
const REPORT_MAX_BYTES = 8 * 1024 * 1024;
const START_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const GITLINK_MODE = "160000";

export interface TestProofRepository {
  repositoryId: string;
  directory: string;
  /** The commit the task started from. */
  startCommit: string;
  /** The candidate's tree (committed and uncommitted files), as readCandidateRepositories captured it. */
  candidateTreeSha: string;
}

export interface RunTestProofOptions {
  plan: CheckPlan;
  /** The entries of the check round on the candidate: only a check that passed there is run on the original code. */
  newEntries: readonly CheckEntry[];
  runners: CheckRunners;
  repositories: readonly TestProofRepository[];
  /** The candidate digest the broker will hold for this code. */
  candidateDigest: string;
  /** The workspace root, where a check's report file path is resolved from its cwd. */
  rootPath: string;
  signal: AbortSignal;
  /** What is left of the check round's budget. */
  budgetMs: number;
  capMs?: number;
  /** Tests supply a fake. Default: the real swap (gitOriginalCode). */
  originalCode?: (repositories: OriginalCodeRepository[]) => OriginalCode;
  now?: () => number;
}

interface ChangedTests {
  /** Every path to keep from the candidate: added, changed or deleted test files. */
  paths: string[];
  /** Paths the candidate has (added or changed), for matching a report's tests. */
  present: string[];
  added: number;
  changed: number;
  deleted: number;
}

/** The test files the candidate added, changed or deleted versus the start commit, in one repository. */
export async function changedTestFiles(repository: Pick<TestProofRepository, "directory" | "startCommit" | "candidateTreeSha">): Promise<ChangedTests> {
  const raw = await git(repository.directory, ["diff-tree", "-r", "-z", "--no-renames", "--raw", `${repository.startCommit}^{tree}`, repository.candidateTreeSha], {}, false);
  const result: ChangedTests = { paths: [], present: [], added: 0, changed: 0, deleted: 0 };
  const fields = raw.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [fromMode, toMode, , , status] = fields[index]!.replace(/^:/, "").split(" ");
    const path = fields[index + 1]!;
    if (path === "" || fromMode === GITLINK_MODE || toMode === GITLINK_MODE || !isTestPath(path)) continue;
    result.paths.push(path);
    if (status === "D") result.deleted += 1;
    else {
      result.present.push(path);
      if (status === "A") result.added += 1;
      else result.changed += 1;
    }
  }
  return result;
}

export async function runTestProof(options: RunTestProofOptions): Promise<TestProof> {
  const now = options.now ?? Date.now;
  const started = now();
  const empty = { added: 0, changed: 0, deleted: 0 };
  const result = (status: TestProof["status"], note: TestProof["note"], changedTests = empty, items: TestProofItem[] = []): TestProof => ({
    schemaVersion: 1, candidateDigest: options.candidateDigest, status, note, changedTests, items, durationMs: Math.max(0, Math.round(now() - started)),
  });

  // Showing the original code in only some repositories would mix two states: every repository needs a usable start commit (as defaultOriginalCode requires).
  if (options.repositories.some((repository) => !START_COMMIT.test(repository.startCommit) || repository.candidateTreeSha === "")) {
    return result("not_checked", "original_code_unavailable");
  }
  const perRepository: Array<{ repository: TestProofRepository; changed: ChangedTests }> = [];
  try {
    for (const repository of options.repositories) perRepository.push({ repository, changed: await changedTestFiles(repository) });
  } catch {
    return result("not_checked", "original_code_unavailable");
  }
  const changedTests = perRepository.reduce((total, { changed }) => ({
    added: total.added + changed.added, changed: total.changed + changed.changed, deleted: total.deleted + changed.deleted,
  }), empty);
  // No test was added or changed (a deleted test proves nothing): no extra run.
  if (perRepository.every(({ changed }) => changed.present.length === 0)) return result("no_changed_tests", "no_changed_tests", changedTests);

  const commands = options.plan.source === "project" ? options.plan.readiness ?? [] : [];
  if (commands.length === 0) return result("not_checked", "no_project_checks", changedTests);
  if (options.signal.aborted) return result("not_checked", "stopped", changedTests);

  const changedPresent = perRepository.flatMap(({ changed }) => changed.present);
  const entryOf = (index: number) => options.newEntries.find((candidate) => candidate.id === `readiness:${index}`);
  const items: TestProofItem[] = [];
  const runIndexes: number[] = [];
  commands.forEach((command, index) => {
    const entry = entryOf(index);
    const base = { checkId: `readiness:${index}`, label: labelOf(entry, command), granularity: "check" as const };
    if (entry?.after !== "passed") items.push({ ...base, verdict: "not_checked", reason: "not_passed_on_new" });
    else if (!looksLikeTestCheck(command, entry, changedPresent)) items.push({ ...base, verdict: "not_applicable", reason: "not_a_test_check" });
    else runIndexes.push(index);
  });
  if (runIndexes.length === 0) {
    return result("not_checked", items.some((item) => item.reason === "not_a_test_check") ? "no_test_checks" : "no_passing_checks", changedTests, items);
  }
  if (options.budgetMs < MIN_TEST_PROOF_BUDGET_MS) {
    for (const index of runIndexes) items.push({ checkId: `readiness:${index}`, label: labelOf(entryOf(index), commands[index]!), granularity: "check", verdict: "not_checked", reason: "budget" });
    return result("not_checked", "budget", changedTests, items);
  }

  // The reports the checks just wrote on the candidate, read before the original code is shown. A report the run on the original code would overwrite is
  // deleted before that run (so a stale one is never read as its result) and put back after it.
  const reports = new Map<number, ReportFile>();
  for (const index of runIndexes) {
    const spec = reportSpecOf(commands[index]!);
    const path = spec === undefined ? undefined : await safeReportPath(options.rootPath, commands[index]!, spec);
    if (spec === undefined || path === undefined) continue;
    const before = await readBytes(path);
    if (before.state !== "unreadable") reports.set(index, { spec, path, before });
  }

  const subPlan: CheckPlan = { source: "project", readiness: runIndexes.map((index) => commands[index]!), projectBefore: runIndexes.map(() => "unknown" as const) };
  const originalCode = (options.originalCode ?? gitOriginalCode)(perRepository
    .filter(({ changed }) => changed.paths.length > 0)
    .map(({ repository, changed }) => ({ directory: repository.directory, commit: repository.startCommit, overlay: changed.paths })));
  const budgetMs = Math.max(0, Math.min(options.capMs ?? TEST_PROOF_CAP_MS, options.budgetMs));
  let ran: { entries: CheckEntry[]; oldReports: Map<number, ReadResult> };
  try {
    ran = await originalCode.run(async () => {
      for (const report of reports.values()) await unlink(report.path).catch(() => undefined);
      const round = await runChecks(subPlan, options.runners, { budgetMs, signal: options.signal });
      // Read while the original code is shown, before the files are put back.
      const oldReports = new Map<number, ReadResult>();
      for (const [index, report] of reports) oldReports.set(index, await readBytes(report.path));
      return { entries: round.entries, oldReports };
    });
  } catch (error) {
    // The one fault that must stop the task: the agent's files are not back.
    if (error instanceof AgentFilesRestoreError) throw error;
    return result("not_checked", options.signal.aborted ? "stopped" : "original_code_unavailable", changedTests, items);
  } finally {
    for (const report of reports.values()) await restoreFile(report);
  }

  const perCheck: TestProofItem[] = [];
  const perTest = new Map<string, TestProofItem[]>();
  runIndexes.forEach((index, position) => {
    const entry = ran.entries[position];
    const base = { checkId: `readiness:${index}`, label: labelOf(entryOf(index), commands[index]!) };
    if (entry === undefined) {
      perCheck.push({ ...base, granularity: "check", verdict: "not_checked", reason: "infrastructure" });
      return;
    }
    perCheck.push({ ...base, granularity: "check", ...classifyEntry(entry, options.signal.aborted) });
    const tests = entry.after === "passed" || entry.after === "failed"
      ? perTestItems(base, reports.get(index), ran.oldReports.get(index), changedPresent, entry.after === "passed") : undefined;
    if (tests !== undefined) perTest.set(base.checkId, tests);
  });
  // Per test where a report allows it; past the item limit, one summary item per check instead (never dropped).
  const testCount = [...perTest.values()].reduce((total, tests) => total + tests.length, 0);
  const useTests = items.length + perCheck.length - perTest.size + testCount <= ITEMS_MAX;
  const final = [...items, ...perCheck.flatMap((item) => (useTests ? perTest.get(item.checkId) : undefined) ?? [item])];
  const stopped = options.signal.aborted;
  const note = stopped ? "stopped" as const
    : final.some((item) => item.reason === "timed_out" || item.reason === "budget") ? "timed_out" as const : "completed" as const;
  const verdicts = final.filter((item) => item.verdict !== "not_applicable");
  const status = stopped || verdicts.every((item) => item.verdict === "not_checked") ? "not_checked" as const : "checked" as const;
  return result(status, note, changedTests, final.slice(0, ITEMS_MAX));
}

/**
 * test-proof.json as the worker saves it: always under PROOF_MAX_BYTES, so the broker's loader (256 KiB) reads all of it. Labels and test names are cut
 * (nothing else is lost) when the full text is too long, and items are dropped from the end only as a last resort.
 */
export function serializeTestProof(proof: TestProof): string {
  let current = proof;
  const fits = () => Buffer.byteLength(JSON.stringify(current)) <= PROOF_MAX_BYTES;
  if (fits()) return JSON.stringify(current);
  current = { ...proof, items: proof.items.map((item) => ({ ...item, label: item.label.slice(0, 120) || "check", ...(item.test === undefined ? {} : { test: item.test.slice(0, 80) }) })) };
  while (!fits() && current.items.length > 0) current = { ...current, items: current.items.slice(0, Math.floor(current.items.length / 2)) };
  return JSON.stringify(current);
}

/** Whether a check looks like a test runner: a known runner command, an npm-style `test:*` script, or output that names one of the changed test files. */
function looksLikeTestCheck(command: ProjectCommand, entry: CheckEntry, changedTestPaths: readonly string[]): boolean {
  const words = [command.executable, ...command.args];
  if (isTestCommandHead(words)) return true;
  if (/^(?:npm|pnpm|yarn|bun)$/.test(command.executable) && /^test(?::[\w:.-]*)?$/.test(words[1] === "run" ? words[2] ?? "" : words[1] ?? "")) return true;
  return changedTestPaths.some((path) => entry.output.includes(path) || entry.output.includes(basename(path)));
}

function labelOf(entry: CheckEntry | undefined, command: ProjectCommand): string {
  const text = entry?.label ?? [command.executable, ...command.args].join(" ");
  return redactText(text).slice(0, 300) || "check";
}

/** One check's verdict from its run on the original code. */
function classifyEntry(entry: CheckEntry, stopped: boolean): { verdict: TestProofVerdict; reason: TestProofReason } {
  if (stopped) return { verdict: "not_checked", reason: "stopped" };
  if (entry.after === "passed") return { verdict: "does_not_prove", reason: "passed_on_old" };
  if (entry.after === "timed_out") return { verdict: "not_checked", reason: "timed_out" };
  if (entry.after === "not_run" || entry.after === "unknown") {
    return { verdict: "not_checked", reason: /time budget/.test(entry.output) ? "budget" : "infrastructure" };
  }
  // A failure with no exit code is a command that never ran to an end (it could not be started): nothing is known about the code.
  if (entry.exitCode === undefined || entry.exitCode === null) return { verdict: "not_checked", reason: "infrastructure" };
  return failureVerdict(entry.output);
}

const LOAD_FAILURE = [
  /Cannot find (?:module|package)\b/i, /Failed to (?:resolve|load) (?:import|url|module|entry)/i, /does not provide an export named/i,
  /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/, /ModuleNotFoundError|ImportError/, /\bSyntaxError\b/, /error TS\d{3,5}:/, /Test suite failed to run/i,
  /ERROR collecting|errors? during collection/i, /is not exported by|has no exported member|Module '[^']*' has no exported/i,
  /TypeError: [^\n]{0,200} is not a (?:function|constructor)/, /ReferenceError: [^\n]{0,200} is not defined/,
  /cannot find symbol|cannot find name|undefined reference to|no required module provides package|error\[E\d{4}\]|could not compile|compilation (?:failed|error)|build failed|\[build failed\]/i,
  /\n# [\w./-]+\n[^\n]*\.go:\d+:\d+:/, /undefined: \w+/, /no such file or directory/i,
];
const ASSERTION_FAILURE = [
  /AssertionError/, /\bexpected\b[\s\S]{0,160}?\b(?:to be|to equal|to deeply equal|to strictly equal|to match|to contain|to have|to throw|to include|received|but got|but was|actual)\b/i,
  /^E\s+assert\b/m, /^\s*assert\b.+\n.*(?:where|AssertionError)/m, /--- FAIL: /, /\bExpected:?[\s\S]{0,200}\b(?:Actual|Received|Got):?/i,
  /\bFAILED [^\n]*::[^\n]* - (?:assert|AssertionError)/i, /Assertion (?:failed|error)/i,
];

/** The verdict for a failure on the original code, from the check's output. See the heuristic at the top of this file. */
export function failureVerdict(output: string): { verdict: TestProofVerdict; reason: TestProofReason } {
  if (LOAD_FAILURE.some((pattern) => pattern.test(output))) return { verdict: "could_not_run_on_old", reason: "load_failure_on_old" };
  if (ASSERTION_FAILURE.some((pattern) => pattern.test(output))) return { verdict: "proves_change", reason: "assertion_failed_on_old" };
  return { verdict: "could_not_run_on_old", reason: "unrecognized_failure_on_old" };
}

// ---- Per-test verdicts, only from a report the check's own command already writes ----

interface ReportSpec { kind: "json" | "junit"; argument: string }
interface TestRecord { file: string | undefined; name: string; status: "passed" | "failed" | "skipped"; message: string }

/** A report path and format the command's arguments name (vitest and jest --outputFile, pytest --junitxml). The command is never altered. */
export function reportSpecOf(command: ProjectCommand): ReportSpec | undefined {
  const args = command.args;
  let path: string | undefined;
  let kind: ReportSpec["kind"] | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const inline = /^--(outputFile|junitxml)(?:\.(json|junit))?(?:=(.*))?$/.exec(arg);
    if (inline !== null) {
      const value = inline[3] ?? args[index + 1];
      if (value !== undefined && value !== "" && !value.startsWith("-") && path === undefined) {
        path = value;
        kind = inline[1] === "junitxml" ? "junit" : inline[2] === "json" ? "json" : inline[2] === "junit" ? "junit" : undefined;
      }
    }
    const reporter = /^--reporter(?:=(.*))?$/.exec(arg);
    if (reporter !== null && kind === undefined) {
      const name = reporter[1] ?? args[index + 1];
      if (name === "junit" || name === "json") kind = name;
    }
    if (arg === "--json" && kind === undefined) kind = "json";
  }
  if (path === undefined) return undefined;
  kind ??= path.endsWith(".xml") ? "junit" : path.endsWith(".json") ? "json" : undefined;
  return kind === undefined ? undefined : { kind, argument: path };
}

type ReadResult = { state: "ok"; bytes: Buffer } | { state: "missing" } | { state: "unreadable" };
interface ReportFile { spec: ReportSpec; path: string; before: ReadResult }

/**
 * The report file's real path, only when it lies inside the workspace root and is not a symlink: AgentX never reads or writes through a link that could
 * lead outside. The file need not exist (its directory must).
 */
async function safeReportPath(root: string, command: ProjectCommand, spec: ReportSpec): Promise<string | undefined> {
  try {
    const realRoot = await realpath(root);
    const target = resolve(root, command.cwd, spec.argument);
    const path = join(await realpath(dirname(target)), basename(target));
    const fromRoot = relative(realRoot, path);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || resolve(realRoot, fromRoot) !== path) return undefined;
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? undefined : null));
    if (existing === null || existing?.isSymbolicLink() === true || (existing !== undefined && !existing.isFile())) return undefined;
    return path;
  } catch {
    return undefined;
  }
}

/** The file's bytes (within a size cap); `missing` only for a file that is not there. Any other fault is `unreadable`, and such a file is never touched. */
async function readBytes(path: string): Promise<ReadResult> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > REPORT_MAX_BYTES) return { state: "unreadable" };
    return { state: "ok", bytes: await readFile(path) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unreadable" };
  }
}

/** Puts a report file back as the candidate's run left it: its bytes, or gone when it was not there. A link the run left in its place is replaced, never followed. */
async function restoreFile(report: ReportFile): Promise<void> {
  try {
    const now = await lstat(report.path).catch(() => undefined);
    if (report.before.state === "missing") {
      if (now !== undefined) await unlink(report.path);
      return;
    }
    if (report.before.state !== "ok") return;
    if (now?.isSymbolicLink() === true) await unlink(report.path);
    await writeFile(report.path, report.before.bytes);
  } catch { /* A report file that cannot be put back is only a stale report. */ }
}

function perTestItems(
  base: { checkId: string; label: string },
  report: ReportFile | undefined,
  old: ReadResult | undefined,
  changedPaths: readonly string[],
  checkPassed: boolean,
): TestProofItem[] | undefined {
  if (report === undefined || report.before.state !== "ok" || old === undefined || old.state !== "ok") return undefined;
  // The very bytes the new run wrote: the old run did not write a report of its own, so this says nothing about the old code.
  if (old.bytes.equals(report.before.bytes)) return undefined;
  const inChanged = (record: TestRecord): string | undefined =>
    record.file === undefined ? undefined : changedPaths.find((path) => sameFile(record.file!, path));
  const parse = report.spec.kind === "json" ? parseJsonReport : parseJunitReport;
  const newTests = parse(report.before.bytes.toString("utf8")).filter((record) => record.status === "passed" && inChanged(record) !== undefined);
  if (newTests.length === 0) return undefined;
  const oldTests = parse(old.bytes.toString("utf8"));
  // The report must agree with the check's own exit code: a failed check with no failing test (or a passed one with a failing test) is not a report to trust.
  if (oldTests.length === 0 || oldTests.some((record) => record.status === "failed") === checkPassed) return undefined;
  const keyOf = (record: TestRecord): string => `${inChanged(record) ?? record.file ?? ""}::${record.name}`;
  const oldByKey = new Map(oldTests.map((record) => [keyOf(record), record]));
  return newTests.map((record): TestProofItem => {
    const found = oldByKey.get(keyOf(record));
    const item = { ...base, granularity: "test" as const, test: redactText(record.name).slice(0, 200) || "test" };
    if (found === undefined || found.status === "skipped") return { ...item, verdict: "could_not_run_on_old", reason: "test_missing_on_old" };
    if (found.status === "passed") return { ...item, verdict: "does_not_prove", reason: "passed_on_old" };
    return { ...item, ...failureVerdict(found.message) };
  });
}

/** A report's file (absolute, relative, or a dotted module path with no extension) against a changed path relative to the repository. */
function sameFile(file: string, path: string): boolean {
  const bare = path.replace(/\.[^./]+$/, "");
  return file === path || file.endsWith(`/${path}`) || file === bare || file.endsWith(`/${bare}`);
}

/** vitest --reporter=json and jest --json: { testResults: [{ name, assertionResults: [{ fullName, status, failureMessages }] }] }. */
function parseJsonReport(text: string): TestRecord[] {
  try {
    const parsed = JSON.parse(text) as { testResults?: Array<{ name?: string; assertionResults?: Array<{ fullName?: string; title?: string; status?: string; failureMessages?: string[] }> }> };
    const records: TestRecord[] = [];
    for (const file of parsed.testResults ?? []) {
      for (const test of file.assertionResults ?? []) {
        const status = test.status === "passed" ? "passed" : test.status === "failed" ? "failed" : "skipped";
        records.push({ file: file.name, name: test.fullName ?? test.title ?? "", status, message: (test.failureMessages ?? []).join("\n") });
      }
    }
    return records;
  } catch {
    return [];
  }
}

/** JUnit XML: <testcase classname name file?> with a <failure>, <error> or <skipped> child when it did not pass. */
function parseJunitReport(text: string): TestRecord[] {
  const records: TestRecord[] = [];
  for (const match of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = new Map([...match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map((attribute) => [attribute[1]!, unescapeXml(attribute[2]!)] as const));
    const body = match[2] ?? "";
    const status = /<(?:failure|error)\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed";
    const classname = attributes.get("classname");
    records.push({
      file: attributes.get("file") ?? (classname !== undefined && /[/\\]/.test(classname) ? classname : classname?.replaceAll(".", "/")),
      name: attributes.get("name") ?? "", status, message: unescapeXml(body),
    });
  }
  return records;
}

function unescapeXml(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}
