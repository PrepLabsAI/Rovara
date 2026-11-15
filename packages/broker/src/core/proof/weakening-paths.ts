// TE-B3 (O39): which changed paths a reviewer should look at first because a change to them can make tests pass without fixing anything: Rovara instruction files, files CI runs, snapshot files, fixture files and test
// configuration. They are FLAGS and words only (until TE-B5 makes them gating): nothing here decides a verdict. Every pattern is matched on the whole path, lower-cased and written with `/`, and every pattern is linear
// (a path is at most a few hundred characters, but a hostile name must not cost more than its length).

/**
 * Rovara instruction files: what Rovara reads to know how this repository works. `AGENTS.md` and `CLAUDE.md` at any depth, the project's rules (`.rovara/rules/`), and the project and playbook files (`.rovara/project.*`,
 * `.rovara/playbook.*`). A task that changes them changes what every later task is told, so a person should read the change.
 */
const INSTRUCTION_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(agents(\.override)?|claude)\.md$/,
  /(^|\/)\.github\/copilot-instructions\.md$/,
  /(^|\/)\.rovara\/rules(\/|$)/,
  /(^|\/)\.rovara\/(playbook|project)(\.[\w-]+)?$/,
];

/**
 * Test configuration and the other files a CI run executes besides its workflow files: the test runners' configuration (vitest, jest, playwright, karma, cypress, mocha, pytest, tox, nox, coverage, nyc, rspec, phpunit),
 * `Makefile`, `conftest.py` and the files a test runner loads before the tests (`jest.setup.*`, `setupTests.*`). Package scripts are not paths: the changed-files reader flags a package.json whose scripts changed.
 */
export const TEST_CONFIG_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(vitest|jest|playwright|karma|cypress|mocha)\.(config|workspace|setup)(\.[\w-]+)?\.[cm]?[jt]sx?$/,
  /(^|\/)(vitest|jest|playwright|karma|cypress)\.(config|workspace)\.json$/,
  /(^|\/)(jest|vitest)\.setup\.[cm]?[jt]s$/,
  /(^|\/)setup-?tests\.[cm]?[jt]sx?$/,
  /(^|\/)(pytest\.ini|tox\.ini|conftest\.py|noxfile\.py|\.coveragerc|\.nycrc(\.[\w]+)?|\.rspec|phpunit(\.dist)?\.xml|\.mocharc(\.[\w]+)?|karma\.conf\.[cm]?js|codecov\.ya?ml|\.codecov\.ya?ml)$/,
  // Only the top-level Makefile and turbo.json: a Makefile deeper in the tree is not what CI runs (the owner's earlier tier table says low).
  /^(makefile|turbo\.json)$/,
];

/** A folder that holds tests: a test, tests, __tests__, spec, e2e or test-data folder, somewhere above the file. `snapshots/`, `golden/` and `fixtures/` mean snapshots and fixtures only under one (an app's `fixtures/seed.json`, a docs `snapshots/` page or an asset `golden/` image are not tests'). */
const TEST_FOLDERS: ReadonlySet<string> = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "testdata", "test-data", "test_data"]);
const SNAPSHOT_FOLDERS: ReadonlySet<string> = new Set(["snapshot", "snapshots", "golden"]);
const FIXTURE_FOLDERS: ReadonlySet<string> = new Set(["fixture", "fixtures"]);

/** Whether a folder of `folders` (a set of names) lies below a test folder, among the folders above the file: checked on the path's segments in one pass, so the cost is the length of the path whatever it holds. */
function underTestFolder(value: string, folders: ReadonlySet<string>): boolean {
  const segments = value.split("/");
  let inTests = false;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    if (inTests && folders.has(segment)) return true;
    if (TEST_FOLDERS.has(segment)) inTests = true;
  }
  return false;
}

/** A name with an `.approved`, `.received` or `.verified` part before its last extension (`Foo.verified.txt`). Checked on the file name's parts, not by a pattern that scans to the end from every dot. */
function approvalFile(value: string): boolean {
  const parts = (value.split("/").at(-1) ?? "").split(".");
  return parts.length >= 3 && parts.slice(1, -1).some((part) => part === "approved" || part === "received" || part === "verified");
}

/** Snapshot files (jest, vitest, syrupy, Verify, approval tests, Go golden files): the expected output a test compares with, so a change to one can make a failing test pass. */
const SNAPSHOT_PATH_PATTERNS: readonly RegExp[] = [
  /\.snap$/,
  /\.ambr$/,
  /(^|\/)__snapshots__(\/|$)/,
  /\.golden(\.[\w-]+)?$/,
];

/** Fixture and recorded-answer files that tests read: test data folders, mocks and recorded HTTP cassettes, and a `fixtures/` folder under a test folder. */
const FIXTURE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(__fixtures__|testdata|test-data|test_data|__mocks__|cassettes)(\/|$)/,
  /\.cassette\.[\w]+$/,
];

const normalized = (path: string): string => path.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "").toLowerCase();
const matches = (patterns: readonly RegExp[], path: string): boolean => {
  const value = normalized(path);
  return patterns.some((pattern) => pattern.test(value));
};

/** A Rovara instruction file (`AGENTS.md`, `CLAUDE.md`, `.rovara/rules/**`, `.rovara/project.*`, `.rovara/playbook.*`). */
export const isInstructionFilePath = (path: string): boolean => matches(INSTRUCTION_PATH_PATTERNS, path);
/** A test runner's or coverage tool's configuration, a Makefile or a `conftest.py`: files whose change can change which tests run. */
export const isTestConfigPath = (path: string): boolean => matches(TEST_CONFIG_PATH_PATTERNS, path);
/** A snapshot or golden file. */
export const isSnapshotPath = (path: string): boolean => matches(SNAPSHOT_PATH_PATTERNS, path) || approvalFile(normalized(path)) || underTestFolder(normalized(path), SNAPSHOT_FOLDERS);
/** A fixture, mock or recorded-answer file. */
export const isFixturePath = (path: string): boolean => matches(FIXTURE_PATH_PATTERNS, path) || underTestFolder(normalized(path), FIXTURE_FOLDERS);
