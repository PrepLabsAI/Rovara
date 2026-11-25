// DEC 254zzz495 / N0: the one-line summary a setup run leaves in the log when it ends (`setup_run_ended`), so "what happened in that run?" can be answered from the log alone. Part A of the beta setup report
// could not tell: the worker's log group was empty and the broker had only a start event.
//
// What the line holds, all of it counts and fixed words: the project's name, the stop word, how the run ended, the number of commands and how they ended (exit 0, nothing found, failed, timed out), the setup and test
// commands the proposal holds and the other items, the websites the run was blocked on, the run's spend, and WHERE IT LOOKED FOR TESTS as words from a fixed list (`TEST_PLACES`).
// What it never holds: a command, a command's output, a path, a repository's address, a website's name, a model's words or a citation. A command's text is read only to pick words from the fixed list; nothing of it is kept.
import { SETUP_TEST_PLACES, setupItemsOf, setupResultOf, type SetupJournalEntry, type SetupProposal, type SetupRunEndWord, type SetupRunSummary, type SetupTestPlace } from "@agentx/contracts";

/** The places a run may say it looked for tests, in the order they are listed (the contract's fixed words: nothing from a repository can be added). */
export const TEST_PLACES = SETUP_TEST_PLACES;
export type TestPlace = SetupTestPlace;

/** What a command's own words say about where it looked. Each is matched against the redacted command and only its name is kept. */
const PLACE_PATTERNS: ReadonlyArray<readonly [TestPlace, RegExp]> = [
  ["pytest_config", /(?:pytest\.ini|tox\.ini|setup\.cfg|pyproject(?:\.toml)?|\[tool\.pytest|pytest\.ini_options)/iu],
  ["tests_folder", /(?:^|[\s/'"=])(?:tests?|__tests__|spec)(?=[\s/'"*]|$)/iu],
  ["test_py_files", /test_\S*\.py|\*_test\.py|test_\*/iu],
  ["conftest", /conftest/iu],
  ["package_scripts", /package\.json|scripts\.test|npm\s+(?:run\s+)?test/iu],
  ["js_test_files", /\*\.(?:test|spec)\.|\.(?:test|spec)\.[jt]sx?/iu],
  ["go_test_files", /_test\.go|go\s+test/iu],
  ["java_src_test", /src\/test|\bmvn\b|\bgradlew?\b/iu],
  ["makefile", /\bmakefile\b|\bmake\s+-?\S*\s*test/iu],
  ["ci_workflows", /\.github\/workflows|\.gitlab-ci|\.circleci|azure-pipelines|jenkinsfile/iu],
  ["readme", /\breadme/iu],
];

/** The places the commands' words name, as the fixed words, in the list's order. Pure. */
export function testPlacesLooked(commands: readonly string[]): TestPlace[] {
  const found = new Set<TestPlace>();
  for (const command of commands) for (const [place, pattern] of PLACE_PATTERNS) if (pattern.test(command)) found.add(place);
  return TEST_PLACES.filter((place) => found.has(place));
}

/** The commands a proposal's items carry, counted (an item may hold several). */
const commandCount = (items: ReadonlyArray<{ value: { commands: readonly string[] } }>): number => items.reduce((total, item) => total + item.value.commands.length, 0);

export interface SetupRunEndedLine {
  event: "setup_run_ended";
  project: string;
  /** The stop word the run's result carries. */
  stop: SetupRunEndWord;
  /** How the run ended: it gave a proposal, or it did not. */
  status: "ready" | "failed";
  commandsRun: number;
  /** Exit 0. */
  passed: number;
  /** A pure search that matched nothing (N1): an answer, not a failure. */
  nothingFound: number;
  failed: number;
  timedOut: number;
  /** Setup and test COMMANDS the proposal holds (not items). */
  setupFound: number;
  testsFound: number;
  /** Items of every other kind in the proposal (repositories, checks, knowledge, websites, secrets ...). */
  otherItems: number;
  /** Where the run looked for tests, as words from `TEST_PLACES`. */
  testsLookedIn: TestPlace[];
  /** The websites a command was blocked on (distinct), and the host asks the run made. */
  blockedHosts: number;
  hostAsks: number;
  spendCents: number;
  elapsedSeconds: number;
  partial: boolean;
}

export interface SetupRunEndInput {
  project: string;
  result: { status: "ready" | "failed"; stop: SetupRunEndWord; proposal?: SetupProposal | undefined; summary?: SetupRunSummary | undefined };
  journal: readonly SetupJournalEntry[];
}

/** The `setup_run_ended` line for a run that ended. Pure; the same input gives the same line; it holds only the keys of `SetupRunEndedLine`. */
export function setupRunEndedLine(input: SetupRunEndInput): SetupRunEndedLine {
  const { result, journal } = input;
  const results = journal.map((entry) => setupResultOf(entry));
  const count = (word: ReturnType<typeof setupResultOf>): number => results.filter((one) => one === word).length;
  const proposal = result.proposal;
  const setupFound = proposal === undefined ? 0 : commandCount(proposal.setup);
  const testsFound = proposal === undefined ? 0 : commandCount(proposal.tests);
  const itemCount = proposal === undefined ? 0 : setupItemsOf(proposal).length;
  const settingItems = proposal === undefined ? 0 : proposal.setup.length + proposal.tests.length;
  return {
    event: "setup_run_ended",
    project: input.project,
    stop: result.stop,
    status: result.status,
    commandsRun: journal.length,
    passed: count("worked"),
    nothingFound: count("nothing_found"),
    failed: count("failed"),
    timedOut: count("timed_out"),
    setupFound,
    testsFound,
    otherItems: Math.max(0, itemCount - settingItems),
    testsLookedIn: testPlacesLooked(journal.map((entry) => entry.command)),
    blockedHosts: new Set(journal.flatMap((entry) => entry.blockedHosts)).size,
    hostAsks: result.summary?.hostAsks ?? 0,
    spendCents: result.summary?.spendCents ?? 0,
    elapsedSeconds: Math.round((result.summary?.elapsedMs ?? 0) / 1_000),
    partial: result.summary?.partial ?? result.status === "failed",
  };
}
