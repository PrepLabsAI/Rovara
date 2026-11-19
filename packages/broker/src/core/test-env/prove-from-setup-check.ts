// Test environment: the Prove report of a proposed environment, built from the proposal's CANDIDATE CHECK.
//
// A candidate check runs on a fresh workspace prepared from the commands the settings WOULD hold once the proposal's are added (`test-env/candidate-commands.ts`), before any of them is applied: its setup commands,
// then its readiness commands (the build, smoke and test checks a task needs to pass). It proves "these commands work on a clean checkout of the default branch" with no new thing to run. The caller passes the
// check's own result (its status and the command lists it ran) here, and the Prove report is DERIVED by the broker from that, never from the project's applied settings or its own setup check:
//   - the check must have passed (`ready`) at the project's latest settings revision, and be recent (a week, the life of a proposal);
//   - every setup command and every build, smoke and test check of the proposal must be among the commands that check ran, compared by program, arguments and directory. A command the check did not run is not
//     proved;
//   - the report claims only what ran: each step it names passed, the rest are skipped. It does not claim the boot of a service, a timed full run, a coverage map or a mock (those need the full Prove run, which
//     needs a worker run with no task: not built yet), and a proposal with v1 services is never proved here.
//   - test services : a proposal with DEPENDENCIES is proved only with the usage record the candidate check reported (the worker started them and ran the test checks sealed). The two steps `dependencies`
//     ("start dependencies") and `dependency_usage` ("dependency usage check") are derived from that record by the broker; a check with no record proves nothing about them.
// A report is never read from a worker for this: the worker's word is not asked, so it cannot be forged.
import { TestEnvProveReportSchema, testServicesAwsUsageVerdict, testServicesFakeUsageVerdict, testServicesUnknownCallCount, type AppProjectSummary, type ProjectCommand, type TestEnvProveReport, type TestEnvRefusal, type TestEnvironmentBody, type TestServicesUsageRecord, testEnvDigest } from "@agentx/contracts";

/** How old a passing setup check may be and still prove a proposal: the proposal's own life. */
export const SETUP_CHECK_MAX_AGE_MS = 7 * 86_400_000;

/**
 * The fields that decide WHICH tests a check runs once a coverage map exists: a check's `selectArgs` is exactly the approved placeholder `["{tests}"]` (any other argument, `--co` or `--passWithNoTests`, would make a
 * "selected" run pass without testing), the selection method is `full` or `coverage_map`, and there is no `declared` mapping (a few globs that send every source file to one trivial test). Shared by the draft
 * sanitizer and the Prove derivation, so what is stored and what is proved cannot differ.
 */
export const SAFE_SELECT_ARGS: readonly string[] = ["{tests}"];
export const SAFE_SELECTION_METHODS: readonly string[] = ["full", "coverage_map"];
export const selectArgsAreSafe = (selectArgs: readonly string[] | undefined): boolean => selectArgs === undefined || (selectArgs.length === SAFE_SELECT_ARGS.length && selectArgs.every((arg, index) => arg === SAFE_SELECT_ARGS[index]));

/**
 * The test runners that take the ids of the tests to run as plain arguments (the detectors propose the placeholder for pytest; jest, vitest and mocha take file paths the same way). A `{tests}` template on any other
 * command (`make test`, `npm test`, `go test`, a script) would put test ids where that command does not take them: it might ignore them (the whole suite runs, which is safe but not what the card says) or read them as
 * something else. So the placeholder is kept only where the check's command is one of these runners, run directly, as `python -m pytest`, or through `npx`, `bunx`, `pnpm exec|dlx` or `yarn exec|dlx`. The
 * package managers' `run` and bare `pnpm jest` / `yarn jest` forms run the package.json script of that name, which can be any command, so they are not accepted.
 */
const SELECTING_RUNNERS: readonly string[] = ["pytest", "jest", "vitest", "mocha"];
const baseName = (executable: string): string => executable.slice(executable.lastIndexOf("/") + 1);
const firstProgram = (args: readonly string[]): string | undefined => args.find((arg) => !arg.startsWith("-"));
export function commandTakesTestIds(command: ProjectCommand): boolean {
  const name = baseName(command.executable);
  if (SELECTING_RUNNERS.includes(name)) return true;
  if (/^python(?:3(?:\.\d{1,2})?)?$/u.test(name)) return command.args[0] === "-m" && command.args[1] === "pytest";
  // The first argument that is not an option is the program the package runner starts.
  const started = name === "npx" || name === "bunx" ? firstProgram(command.args)
    : (name === "pnpm" || name === "yarn") && (command.args[0] === "exec" || command.args[0] === "dlx") ? firstProgram(command.args.slice(1)) : undefined;
  return started !== undefined && SELECTING_RUNNERS.includes(baseName(started));
}
/**
 * A flag that makes a run with no test pass (jest and vitest `--passWithNoTests`, pytest's `--suppress-no-test-exit-code`, and the like). With a selection a run can match no test at all (a path with regex
 * characters, a deleted file), and with such a flag it would pass: "the selected tests passed" would then claim nothing. Compared by name, ignoring case, dashes, underscores and any `=value`.
 */
const PASS_WITH_NO_TESTS_FLAGS: readonly string[] = ["passwithnotests", "suppressnotestexitcode", "allowempty", "allownotests", "exitzero"];
export const passesWithNoTests = (command: ProjectCommand): boolean => command.args.some((arg) => arg.startsWith("--") && PASS_WITH_NO_TESTS_FLAGS.includes(arg.slice(2).split("=")[0]!.replace(/[-_]/gu, "").toLowerCase()));
/** Whether a check's narrowing template is one the broker carries: exactly the placeholder, on a test runner that takes test ids, in a command that does not pass with no tests. */
export const checkSelectionIsSafe = (check: { selectArgs?: readonly string[] | undefined; command: ProjectCommand }): boolean =>
  check.selectArgs === undefined || (selectArgsAreSafe(check.selectArgs) && commandTakesTestIds(check.command) && !passesWithNoTests(check.command));
export function selectionFieldsAreSafe(body: TestEnvironmentBody): boolean {
  return SAFE_SELECTION_METHODS.includes(body.selection.method) && body.selection.declared === undefined && body.repos.every((repo) => repo.checks.every(checkSelectionIsSafe));
}

export interface ProjectCommandsAt { revision: number; setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[] }

const sameCommand = (left: ProjectCommand, right: ProjectCommand): boolean => left.cwd === right.cwd && left.executable === right.executable && JSON.stringify(left.args) === JSON.stringify(right.args);
const covered = (command: ProjectCommand, among: readonly ProjectCommand[]): boolean => among.some((candidate) => sameCommand(candidate, command));

/** The kinds of check the setup check proves: its readiness commands are the project's build, smoke and test commands. */
export const PROVED_CHECK_KINDS: readonly string[] = ["build", "smoke", "test"];

/**
 * How many of a proposal's commands the setup check has NOT run: setup commands that are in neither the project's setup nor its readiness commands, and build, smoke and test checks that are not exactly one of
 * its readiness commands. Zero means the commands are all among the ones the check ran (the rest of the Prove rules still apply).
 */
export function commandsNotRun(environment: TestEnvironmentBody, definition: Pick<ProjectCommandsAt, "setup" | "readiness">): number {
  const setupMissing = environment.repos.flatMap((repo) => repo.setupCommands).filter((command) => !covered(command, definition.setup) && !covered(command, definition.readiness)).length;
  const checksMissing = environment.repos.flatMap((repo) => repo.checks).filter((check) => PROVED_CHECK_KINDS.includes(check.kind) && !covered(check.command, definition.readiness)).length;
  return setupMissing + checksMissing;
}

export type ProveFromSetupCheck = { ok: true; report: TestEnvProveReport } | { ok: false; refusal: TestEnvRefusal };

export function proveReportFromSetupCheck(input: {
  environment: TestEnvironmentBody;
  definition: ProjectCommandsAt;
  setup: AppProjectSummary["setup"];
  nowMs: number;
  /** Test services: the usage record the candidate check reported (the worker's facts; the broker decides what they mean). Only read when the environment has dependencies. */
  usage?: TestServicesUsageRecord | undefined;
}): ProveFromSetupCheck {
  const { environment, definition, setup } = input;
  if (setup.status === "unchecked") return { ok: false, refusal: "no_setup_check" };
  if (setup.status === "checking") return { ok: false, refusal: "checking" };
  if (setup.status === "failed") return { ok: false, refusal: "failed" };
  if (setup.status === "outdated") return { ok: false, refusal: "outdated" };
  // Ready, for exactly the settings these commands come from, and recent.
  const checkedAt = setup.checkedAt === undefined ? Number.NaN : Date.parse(setup.checkedAt);
  if (setup.checkedRevision !== definition.revision) return { ok: false, refusal: "outdated" };
  if (!Number.isFinite(checkedAt) || checkedAt > input.nowMs + 5 * 60_000 || input.nowMs - checkedAt > SETUP_CHECK_MAX_AGE_MS) return { ok: false, refusal: "setup_check_old" };
  // A service needs its boot and its mock or probe proved: that is the full Prove run, not this.
  if (environment.services.length > 0) return { ok: false, refusal: "services_need_prove" };

  // The selection fields are proved too: a check that narrows its tests some other way than the approved placeholder is not provable.
  if (!selectionFieldsAreSafe(environment)) return { ok: false, refusal: "not_provable" };
  const setupCommands = environment.repos.flatMap((repo) => repo.setupCommands);
  const checksOf = (kind: string) => environment.repos.flatMap((repo) => repo.checks).filter((check) => check.kind === kind);
  const build = checksOf("build"), smoke = checksOf("smoke"), tests = checksOf("test");
  if (smoke.length + tests.length === 0) return { ok: false, refusal: "nothing_to_prove" };
  // A setup command is proved by a setup or readiness command that matches it. A build, smoke or test check is proved ONLY by the readiness command that is exactly it: a command that merely matches a setup
  // command (a proposal that lists `npm ci` as a test) did not run as a test, and the report must not say the suite passed.
  const checkCommands = [...build, ...smoke, ...tests].map((check) => check.command);
  if (!setupCommands.every((command) => covered(command, definition.setup) || covered(command, definition.readiness)) || !checkCommands.every((command) => covered(command, definition.readiness))) return { ok: false, refusal: "commands_differ" };

  const step = (name: TestEnvProveReport["steps"][number]["step"], did: boolean) => ({ step: name, status: did ? "passed" as const : "skipped" as const, durationMs: 0 });
  // Test services: the two dependency steps, from the usage record (a check that carries no record has not shown the dependencies work).
  const dependencySteps = dependencyStepsOf(environment, input.usage);
  if (dependencySteps === "not_checked") return { ok: false, refusal: "dependencies_not_checked" };
  const report = TestEnvProveReportSchema.safeParse({
    schemaVersion: 1,
    proposalDigest: testEnvDigest(environment),
    steps: [step("setup", setupCommands.length > 0), step("build", build.length > 0), step("smoke", smoke.length > 0), step("full_suite", tests.length > 0), ...dependencySteps],
    services: [],
    finishedAt: new Date(input.nowMs).toISOString(),
  });
  return report.success ? { ok: true, report: report.data } : { ok: false, refusal: "not_provable" };
}

/**
 * The Prove steps "start dependencies" and "dependency usage check" for an environment with dependencies, from the candidate check's usage record. None for an environment without dependencies (its report is what it was);
 * `"not_checked"` when it has dependencies and the check reported no record. A dependency the record does not show started, healthy and without a failure fails the first step; a call to a name no dependency answers fails the second.
 */
export function dependencyStepsOf(environment: Pick<TestEnvironmentBody, "dependencies">, usage: TestServicesUsageRecord | undefined): Array<TestEnvProveReport["steps"][number]> | "not_checked" {
  const planned = environment.dependencies ?? [];
  if (planned.length === 0) return [];
  if (usage === undefined) return "not_checked";
  const started = planned.every((dependency) => { const seen = usage.dependencies.find((entry) => entry.id === dependency.id); return seen !== undefined && seen.started && seen.healthy && seen.failure === undefined; });
  const startMs = Math.min(usage.dependencies.reduce((sum, entry) => sum + entry.startMs, 0), 86_400_000);
  const unknown = testServicesUnknownCallCount(usage);
  // with Rovara local AWS in the plan the AWS usage must be clean too. A record with no ledger facts, an unreadable or flooded ledger, a call to a service outside the plan or an operation the emulator does not offer
  // FAILS the usage step: "could not be checked" is never a pass.
  const emulated = planned.filter((dependency) => dependency.backing.kind === "emulated");
  const awsClean = emulated.length === 0 || testServicesAwsUsageVerdict(usage, emulated.flatMap((dependency) => (dependency.backing.kind === "emulated" ? dependency.backing.awsServices : []))).ok;
  // with a fake in the plan its ledger must have been read and clean too: a request the fake had no recording for (the tests asked for something the set does not hold), a call from anything but the check sandbox, or a
  // ledger that could not be read FAILS the usage step.
  const fakeIds = planned.filter((dependency) => dependency.backing.kind === "fake").map((dependency) => dependency.id);
  const fakesClean = fakeIds.length === 0 || testServicesFakeUsageVerdict(usage, fakeIds).ok;
  return [
    started ? { step: "dependencies", status: "passed", durationMs: startMs } : { step: "dependencies", status: "failed", durationMs: startMs, failure: "dependency_start_failed" },
    unknown === 0 && awsClean && fakesClean ? { step: "dependency_usage", status: "passed", durationMs: 0 } : { step: "dependency_usage", status: "failed", durationMs: 0, failure: "dependency_unexpected_call" },
  ];
}

/** What a refusal says to a person (fixed words, never a value). */
export const TEST_ENV_REFUSAL_WORDS: Record<TestEnvRefusal, string> = {
  no_draft: "Ask Rovara to draft the project's setup first; the test environment is proposed from that look at the default branch.",
  stale_draft: "The setup draft is older than the project's settings. Ask Rovara to draft the setup again.",
  no_proposal: "Propose the environment first.",
  not_provable: "This environment could not be checked from the setup check.",
  outdated: "The project's settings changed since the check ran. Run the check of this test environment again.",
  checking: "The check of this test environment is still running.",
  failed: "The check of this test environment failed. Fix the commands, then run it again.",
  no_setup_check: "Run the check of this test environment first: it runs the proposed commands on a fresh workspace, before any of them is added to the project's settings.",
  commands_differ: "Some of the proposed commands are not among the commands the check ran. Run the check of this test environment again.",
  nothing_to_prove: "The proposal has no smoke or test command, so there is nothing to prove.",
  services_need_prove: "This environment calls services, which need the full Prove run. It is not available yet.",
  setup_check_old: "The last check of this test environment is more than a week old. Run it again.",
  setup_run_moved: "The setup run read the code at a different commit than this check ran on. Ask Rovara to run setup again, then check and prove the new proposal.",
  dependencies_not_checked: "The check of this test environment did not start its dependencies. Run it again.",
};
