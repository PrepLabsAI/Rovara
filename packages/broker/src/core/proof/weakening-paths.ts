// TE-B3 (O39): which changed paths a reviewer should look at first because a change to them can make tests pass without fixing anything: Rovara instruction files, files CI runs, snapshot files, fixture files and test
// configuration. They are FLAGS and words only (until TE-B5 makes them gating): nothing here decides a verdict. Every pattern is matched on the whole path, lower-cased and written with `/`, and every pattern is linear
// (a path is at most a few hundred characters, but a hostile name must not cost more than its length).

/**
 * Rovara instruction files: what Rovara reads to know how this repository works. `AGENTS.md` and `CLAUDE.md` at any depth, the project's rules (`.rovara/rules/`), and the project and playbook files (`.rovara/project.*`,
 * `.rovara/playbook.*`). A task that changes them changes what every later task is told, so a person should read the change.
 */
const INSTRUCTION_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(agents|claude)\.md$/,
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

/** Snapshot files (jest, vitest, syrupy, Verify, approval tests, Go golden files): the expected output a test compares with, so a change to one can make a failing test pass. */
const SNAPSHOT_PATH_PATTERNS: readonly RegExp[] = [
  /\.snap$/,
  /\.ambr$/,
  /(^|\/)__snapshots__(\/|$)/,
  /(^|\/)snapshots?\/[^/]+$/,
  /\.(approved|received|verified)\.[\w.-]+$/,
  /\.golden(\.[\w-]+)?$/,
  /(^|\/)golden\/[^/]+$/,
];

/** Fixture and recorded-answer files that tests read: test data folders, mocks and recorded HTTP cassettes. */
const FIXTURE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(__fixtures__|fixtures?|testdata|test-data|test_data|__mocks__|cassettes)(\/|$)/,
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
export const isSnapshotPath = (path: string): boolean => matches(SNAPSHOT_PATH_PATTERNS, path);
/** A fixture, mock or recorded-answer file. */
export const isFixturePath = (path: string): boolean => matches(FIXTURE_PATH_PATTERNS, path);
