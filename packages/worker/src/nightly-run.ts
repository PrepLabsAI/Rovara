// The nightly run, worker side (NH-1; design proof-test-env 4.5 and setup-test-health 6): the project's whole suite on the default branch's commit the broker resolved, in a workspace the broker prepared, with the
// APPROVED test environment. It is the Prove sequence (prove.ts `proveEnvironment`: setup, build, pre-prod probe, boot, smoke, the full suite, mocks) and nothing else decides a step; this module adds what a night
// needs on top of it, all from ONE tally:
//   - the per-test report of each test check, read right after the check ran (the next check, or a rerun, may overwrite the file);
//   - ONE rerun of the tests that failed, for a test check that has an approved `{tests}` template (`commandWithSelection`): a test that passes on the rerun is flaky, one that fails again is failing. A check
//     without a template cannot be rerun for a test: its failures stand, and nothing is called flaky;
//   - the coverage map, built right after the suite (before any rerun overwrites the coverage data), when the environment selects by coverage map;
//   - the result and its `health` block from `nightlyCountsAndHealth`: the counts of the result and the counts of the health block are the same numbers, because they come from the same tally. A flaky test counts as
//     passed (it passed on the rerun), so `failed` is exactly the failing set.
// The broker decides what the night MEANS (`classifyNightlyHealth`); nothing here is a verdict, and no log, message or test output goes in the result: ids, words and counts only.
//
// Things that are NOT a result: a run stopped by a person or by the wall clock (nothing is sent, so the project's health does not move for a night that never finished), and a workspace that is not at the commit the
// run was started for (the branch moved between the broker's read and the clone; the invocation module refuses that before this runs).
import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  CoverageMapSchema, NightlyResultSchema, agentXError, canonicalJson, isRerunnableTestId, isValidTestId, testEnvDigest, testIdOf,
  type CoverageMapData, type NightlyResult, type NightlyRunWire, type NightlyStepWord, type TestEnvCheck, type TestEnvironmentBody, type TEST_ENV_PROVE_STEPS,
} from "@agentx/contracts";
import { nightlyCountsAndHealth, type NightlyRunFacts, type NightlyStepStatus } from "./nightly-health-report.js";
import { proveEnvironment, type ProveCommandResult, type ProvePorts } from "./prove.js";
import { commandWithSelection } from "./verification/selection.js";
import { rerunCommandsOf } from "./verification/test-ids.js";
import type { ParsedTestReport } from "./verification/test-report.js";

/** The most failing and flaky ids a result lists (the contract's own bounds). More failing than this: the count stands, the list is cut, and the broker then excuses no failure. */
const LISTED_MAX = 500;
const SLOWEST_MAX = 20;

/** The message of the error a night ends with when it ran out of its wall clock (`nightly-invocation.ts` reports it as `wall_clock`). */
export const NIGHTLY_WALL_CLOCK_MESSAGE = "the nightly run ran out of its time";
/** The error a night ends with when it ran out of its wall clock (as opposed to a stop). */
export class NightlyWallClockError extends Error {
  constructor() { super(NIGHTLY_WALL_CLOCK_MESSAGE); this.name = "NightlyWallClockError"; }
}

export interface NightlyPorts extends Omit<ProvePorts, "buildCoverageMap" | "suiteTestCount"> {
  /** The test report the check wrote (at its approved `reportPath`), parsed; undefined when none was written, it was refused or it cannot be read. Called right after the check's command ended. */
  readReport(check: TestEnvCheck, command: TestEnvCheck["command"]): Promise<ParsedTestReport | undefined>;
  /** The coverage map of the suite that just ran (from its coverage contexts), or undefined when it cannot be built. Called once, right after the suite. */
  buildCoverageMap(signal: AbortSignal): Promise<CoverageMapData | undefined>;
}

export interface NightlyRunInput {
  environment: TestEnvironmentBody;
  run: NightlyRunWire;
  ports: NightlyPorts;
  signal: AbortSignal;
  /** The most the whole night may take, in milliseconds (setup to the last rerun). */
  deadlineMs: number;
  startedAtMs?: number | undefined;
}

export interface NightlyRunOutput { result: NightlyResult; coverageMap?: CoverageMapData }

/** The digest the result names its coverage map by: the sha256 of the map's canonical JSON, as the broker computes it. */
export const coverageMapDigestOf = (map: CoverageMapData): string => createHash("sha256").update(canonicalJson(CoverageMapSchema.parse(map))).digest("hex");

/** Failures once, then the rerun's: a test that failed again is failing, one that passed on the rerun is flaky (the same rule as the broker's `splitFailures`). */
export function splitFailures(firstRunFailures: readonly string[], rerunFailures: readonly string[]): { failed: string[]; flaky: string[] } {
  const again = new Set(rerunFailures);
  const first = [...new Set(firstRunFailures)];
  return { failed: first.filter((id) => again.has(id)).sort(), flaky: first.filter((id) => !again.has(id)).sort() };
}

type TestState = "passed" | "failed" | "errored" | "skipped";
const WORSE: Record<TestState, number> = { skipped: 0, passed: 1, errored: 2, failed: 3 };

interface CheckRun { check: TestEnvCheck; started: boolean; timedOut: boolean; exitCode: number | null; report: ParsedTestReport | undefined; states: Map<string, TestState>; durations: Map<string, number> }

/** One check's tests by id; a test that appears twice is the worse of its two. */
function statesOf(report: ParsedTestReport): { states: Map<string, TestState>; durations: Map<string, number> } {
  const states = new Map<string, TestState>();
  const durations = new Map<string, number>();
  for (const test of report.tests) {
    const id = testIdOf(test);
    const was = states.get(id);
    const state: TestState = test.status === "failed" ? "failed" : test.status === "errored" ? "errored" : test.status === "skipped" ? "skipped" : "passed";
    if (was === undefined || WORSE[state] > WORSE[was]) states.set(id, state);
    if (test.durationMs !== undefined) durations.set(id, Math.max(durations.get(id) ?? 0, test.durationMs));
  }
  return { states, durations };
}

const failing = (state: TestState | undefined): boolean => state === "failed" || state === "errored";

/** The check kinds the Prove sequence runs, in the environment's own order. */
const RUN_KINDS: readonly string[] = ["build", "smoke", "test"];

export async function runNightly(input: NightlyRunInput): Promise<NightlyRunOutput> {
  const { environment, ports } = input;
  const now = ports.now;
  const startedAt = input.startedAtMs ?? now();
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  if (input.signal.aborted) stop(); else input.signal.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  const wallClock = setTimeout(() => { timedOut = true; stop(); }, Math.max(0, input.deadlineMs));
  // The wall clock and a stop are different ends: the first is reported as a night that ran out of time, the second sends nothing.
  const abortedRun = (): never => { throw timedOut ? new NightlyWallClockError() : agentXError("RUNTIME_UNAVAILABLE", "the nightly run was stopped before it finished"); };
  try {
    const checks = environment.repos.flatMap((repo) => repo.checks).filter((check) => RUN_KINDS.includes(check.kind));
    const runs = new Map<string, CheckRun>(checks.map((check) => [check.id, { check, started: false, timedOut: false, exitCode: null, report: undefined, states: new Map(), durations: new Map() }]));
    const checkOfCommand = new Map<unknown, CheckRun>(checks.map((check) => [check.command, runs.get(check.id)!]));

    // Every command goes through here: what it did is written down, and a test check's report is read before anything can overwrite it.
    const runCommand = async (command: TestEnvCheck["command"], signal: AbortSignal): Promise<ProveCommandResult> => {
      const observed = checkOfCommand.get(command);
      if (observed !== undefined) observed.started = true;
      const result = await ports.runCommand(command, signal);
      if (observed !== undefined) {
        observed.timedOut = result.timedOut;
        observed.exitCode = result.exitCode;
        if (observed.check.kind === "test" && !result.timedOut && !signal.aborted) {
          observed.report = observed.check.reportPath === undefined ? undefined : await ports.readReport(observed.check, command).catch(() => undefined);
          if (observed.report !== undefined) Object.assign(observed, statesOf(observed.report));
        }
      }
      return result;
    };

    // The map is built once; it lives in a box so the closure's assignment is seen below.
    const built: { done: boolean; map?: CoverageMapData } = { done: false };
    const buildMapOnce = async (signal: AbortSignal): Promise<CoverageMapData | undefined> => {
      if (!built.done) {
        built.done = true;
        const made = await ports.buildCoverageMap(signal).catch(() => undefined);
        if (made !== undefined && CoverageMapSchema.safeParse(made).success) built.map = made;
      }
      return built.map;
    };

    const prove = await proveEnvironment({
      runCommand, startMock: ports.startMock, probePreprod: ports.probePreprod, mockUnmatched: ports.mockUnmatched,
      buildCoverageMap: async (signal) => { const built = await buildMapOnce(signal); return built === undefined ? undefined : coverageMapDigestOf(built); },
      suiteTestCount: async () => [...runs.values()].filter((run) => run.check.kind === "test").reduce((sum, run) => sum + run.states.size, 0),
      now: ports.now,
    }, { proposalDigest: testEnvDigest(environment), environment, signal: controller.signal, deadlineMs: input.deadlineMs });
    if (controller.signal.aborted) abortedRun();

    // The suite ran (it passed, or it failed on tests): its coverage data is on disk now and a rerun may rewrite it, so the map is built before any rerun. A suite that did not run leaves nothing to map.
    const statusOf = (step: (typeof TEST_ENV_PROVE_STEPS)[number]): NightlyStepStatus => prove.steps.find((entry) => entry.step === step)?.status ?? "skipped";
    const suiteRan = statusOf("full_suite") !== "skipped";
    if (suiteRan && environment.selection.method === "coverage_map") await buildMapOnce(controller.signal);
    if (controller.signal.aborted) abortedRun();

    // The one rerun: per test check, only the failing tests whose id is VALID and RERUNNABLE, only where the check has an approved `{tests}` template and the runner is one whose syntax is known (pytest takes node ids; vitest and
    // jest take a file and `-t`; see `rerunCommandsOf`). Any other failing test is counted and listed and simply not rerun: it is never called flaky. A test whose id is not valid is counted, never listed, never rerun.
    const flakyOf = new Map<string, Set<string>>();
    for (const run of runs.values()) {
      if (run.check.kind !== "test") continue;
      const flakyHere = new Set<string>();
      flakyOf.set(run.check.id, flakyHere);
      const attempt = [...run.states].filter(([id, state]) => failing(state) && isRerunnableTestId(id)).map(([id]) => id).sort();
      if (attempt.length === 0 || run.check.selectArgs === undefined || run.check.reportPath === undefined) continue;
      // A rerun passes names as separate arguments with no shell, so a space in a name is only text: the rerun accepts every rerunnable id (a selection for a task keeps refusing spaces).
      const commands = rerunCommandsOf(run.check, attempt, (command, selectArgs, ids) => commandWithSelection(command, selectArgs, ids, isRerunnableTestId));
      if (commands === undefined) continue;
      const again = new Map<string, TestState>();
      for (const command of commands) {
        const result = await ports.runCommand(command, controller.signal);
        if (controller.signal.aborted) abortedRun();
        // A rerun that timed out, or wrote nothing readable, shows nothing as fixed: its tests stay failing.
        const second = result.timedOut ? undefined : await ports.readReport(run.check, command).catch(() => undefined);
        if (second === undefined) continue;
        for (const [id, state] of statesOf(second).states) again.set(id, state);
      }
      // A test the rerun does not report is still failing; one that passed (or was skipped) on the rerun is flaky.
      const stillFailing = attempt.filter((id) => failing(again.get(id)) || !again.has(id));
      for (const id of splitFailures(attempt, stillFailing).flaky) flakyHere.add(id);
    }

    // One tally: unique tests by id across the test checks (a test check with no report is one unit, its own verdict).
    let passed = 0, failures = 0, errors = 0, skipped = 0, failedUnlisted = 0;
    const failedIds: string[] = [];
    const flakyIds: string[] = [];
    const slowest: Array<{ id: string; durationMs: number }> = [];
    for (const run of runs.values()) {
      if (run.check.kind !== "test" || !run.started || run.timedOut) continue;
      if (run.report === undefined) {
        // No approved report (or none readable): the check is one verdict. An unreadable approved report is an environment fault the health block carries (`reportWritten: false`), and its tests are not counted.
        if (run.check.reportPath === undefined) {
          if (run.exitCode === 0) passed += 1;
          else { failures += 1; failedIds.push(`check:${run.check.id}`); }
        }
        continue;
      }
      const flaky = flakyOf.get(run.check.id) ?? new Set<string>();
      for (const [id, state] of run.states) {
        if (flaky.has(id) || state === "passed") passed += 1;
        else if (state === "skipped") skipped += 1;
        else {
          if (state === "failed") failures += 1; else errors += 1;
          // Failing, and either listed or, when its id is not valid, counted as left out of the list.
          if (isValidTestId(id)) failedIds.push(id); else failedUnlisted += 1;
        }
        const duration = run.durations.get(id);
        if (duration !== undefined && isValidTestId(id)) slowest.push({ id, durationMs: duration });
      }
      flakyIds.push(...flaky);
    }

    const stepStatus = (step: NightlyStepWord): NightlyStepStatus => (step === "pull" ? "passed" : step === "update" ? "skipped" : statusOf(step));
    // The steps are reported as they were: a step the environment has nothing to run for is "skipped" (smoke, boot, mocks, the pre-prod probe). Whether a skipped smoke step is fine is the BROKER's to say, from its own
    // approved environment (`classifyNightlyHealth` with `noSmokeCheck`); the worker's word about it is never used.
    const steps = (["pull", "update", "setup", "build", "boot", "mocks", "preprod_probe", "smoke", "full_suite"] as const).map((step) => ({ step, status: stepStatus(step) }));
    const healthChecks = checks.map((check) => {
      const run = runs.get(check.id)!;
      const isTest = check.kind === "test";
      const approved = check.reportPath !== undefined;
      return {
        runsTests: isTest, started: run.started, timedOut: run.timedOut, reportApproved: approved,
        reportWritten: !approved || !run.started || run.timedOut || run.report !== undefined,
        testsCollected: !isTest ? 0 : run.report !== undefined ? run.states.size : approved || !run.started ? 0 : 1,
      };
    });
    const facts: NightlyRunFacts = { steps, checks: healthChecks, tally: { passed, failures, errors, skipped }, ranFrom: "fresh" };
    const counted = nightlyCountsAndHealth(facts);

    const finishedAtMs = Math.max(now(), startedAt);
    const sortedFailed = [...failedIds].sort();
    const sortedFlaky = [...flakyIds].sort();
    const coverageMap = built.map;
    const result = NightlyResultSchema.parse({
      schemaVersion: 1, slotId: input.run.slotId, envRevision: input.run.envRevision, branch: input.run.branch, headSha: input.run.headSha,
      startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(finishedAtMs).toISOString(), durationMs: Math.max(0, Math.round(finishedAtMs - startedAt)),
      tests: counted.tests, failed: sortedFailed.slice(0, LISTED_MAX), ...(failedUnlisted === 0 ? {} : { failedUnlisted }), flaky: sortedFlaky.slice(0, LISTED_MAX),
      ...(coverageMap === undefined || !suiteRan ? {} : { coverageMapRef: coverageMapDigestOf(coverageMap) }),
      slowest: slowest.sort((a, b) => b.durationMs - a.durationMs || a.id.localeCompare(b.id)).slice(0, SLOWEST_MAX),
      health: counted.health,
    });
    return { result, ...(coverageMap === undefined || !suiteRan ? {} : { coverageMap }) };
  } finally {
    clearTimeout(wallClock);
    input.signal.removeEventListener("abort", stop);
  }
}

// ---- the coverage map from coverage.py's contexts

/** The report path of a check as a path in the workspace: relative to the command's own directory. */
export const reportLocation = (command: { cwd: string }, reportPath: string): string => posix.normalize(posix.join(command.cwd, reportPath));

/**
 * The coverage map from `coverage json --show-contexts` (coverage.py with `--cov-context=test`): for each source file, the tests whose context executed any of its lines. A context is the test's id followed by the
 * phase (`|run`, `|setup`, `|teardown`); the empty context (module-level code) is no test. A file with more tests than the contract holds is LEFT OUT (a cut list would hide tests from the selection; a file that is
 * not in the map makes the selection fall back to the full suite). Undefined when the text is not that report, or names no test at all.
 */
export function coverageMapFromContexts(text: string, builtAt: string, options: { sourceRoot?: string } = {}): CoverageMapData | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) return undefined;
  const out: Record<string, string[]> = {};
  let sawContext = false;
  for (const [file, entry] of Object.entries(files as Record<string, unknown>)) {
    const contexts = (entry as { contexts?: unknown } | null)?.contexts;
    if (contexts === null || typeof contexts !== "object" || Array.isArray(contexts)) continue;
    const tests = new Set<string>();
    for (const names of Object.values(contexts as Record<string, unknown>)) {
      if (!Array.isArray(names)) continue;
      for (const name of names) {
        if (typeof name !== "string" || name === "") continue;
        sawContext = true;
        const id = name.replace(/\|(?:run|setup|teardown)$/u, "");
        // A context that is not a safe id (whitespace, hidden characters) is left out, never rewritten into another test's id.
        if (isValidTestId(id)) tests.add(id);
      }
    }
    if (tests.size === 0 || tests.size > 5_000) continue;
    const path = posix.normalize(options.sourceRoot === undefined ? file : posix.join(options.sourceRoot, file));
    if (path.startsWith("/") || path.startsWith("..") || path.length > 500) continue;
    out[path] = [...tests].sort();
  }
  if (!sawContext || Object.keys(out).length === 0) return undefined;
  const map = { builtAt, files: out };
  return CoverageMapSchema.safeParse(map).success ? map : undefined;
}
