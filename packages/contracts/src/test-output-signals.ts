// TEST-RESULT-HONESTY: two facts a check's own output can state, read from it and nothing else: how many tests the runner SKIPPED, and which test service (Postgres, MySQL, Redis, MongoDB) a test could not reach.
// Pure and browser-safe. Only the runner's final summary lines are read (the last SUMMARY_LINES lines; go test's per-test lines and its -json events are counted over the output we hold), with no runner plugin and no report file:
// a runner we do not know prints no summary we understand and says nothing, which is "no claim", never a pass. A word a test prints in its own output ("step 3 skipped") is not a summary line.

export const TEST_SERVICES = ["Postgres", "MySQL", "Redis", "MongoDB"] as const;
export type TestService = (typeof TEST_SERVICES)[number];

/** `skipped` tests were not run; `all` is true when nothing else ran (no test passed or failed), so the check tested nothing. */
export interface SkippedTests { skipped: number; all: boolean }

const SUMMARY_LINES = 40;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

const tailLines = (output: string): string[] => output.replace(ANSI, "").split(/\r?\n/u).slice(-SUMMARY_LINES);
const countOf = (text: string, word: RegExp): number => Number(new RegExp(`(\\d+) ${word.source}`, "u").exec(text)?.[1] ?? 0);

/** pytest: `==== 3 passed, 4 skipped in 0.42s ====` (or without the bars under -q). */
const PYTEST = /^=*\s*((?:\d+ [a-z]+(?:, )?)+)\s+in [\d.]+s(?: \(\d+:\d+:\d+\))?\s*=*$/u;
/** jest `Tests:       4 skipped, 6 passed, 10 total` and vitest `Tests  5 passed | 2 skipped (7)`. */
const JEST_VITEST = /^\s*Tests:?\s+((?:\d+ [a-z]+(?:\s*[,|]\s*)?)+)(?:\s*\(\d+\))?\s*$/u;
/** maven's total line has no "Time elapsed"; the per-class lines do. */
const MAVEN = /Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/u;

function pytestOf(lines: string[]): SkippedTests | undefined {
  const parts = lines.map((line) => PYTEST.exec(line.trim())?.[1]).filter((part): part is string => part !== undefined).at(-1);
  if (parts === undefined) return undefined;
  const skipped = countOf(parts, /skipped/u);
  return { skipped, all: skipped > 0 && countOf(parts, /passed/u) + countOf(parts, /failed/u) + countOf(parts, /errors?/u) + countOf(parts, /xpassed/u) + countOf(parts, /xfailed/u) === 0 };
}

function jestVitestOf(lines: string[]): SkippedTests | undefined {
  const parts = lines.map((line) => JEST_VITEST.exec(line)?.[1]).filter((part): part is string => part !== undefined).at(-1);
  if (parts === undefined) return undefined;
  const skipped = countOf(parts, /skipped/u);
  return { skipped, all: skipped > 0 && countOf(parts, /passed/u) + countOf(parts, /failed/u) === 0 };
}

/** go test prints a `--- PASS|FAIL|SKIP:` line per test under -v (subtests indented) and one JSON event per test under -json. */
function goOf(output: string): SkippedTests | undefined {
  const lines = output.replace(ANSI, "").split(/\r?\n/u);
  const tally = { SKIP: 0, PASS: 0, FAIL: 0 };
  for (const line of lines) {
    const verbose = /^\s*--- (SKIP|PASS|FAIL): /u.exec(line)?.[1];
    if (verbose !== undefined) { tally[verbose as keyof typeof tally] += 1; continue; }
    const event = /^\{.*"Action":"(skip|pass|fail)".*"Test":"/u.exec(line)?.[1] ?? /^\{.*"Test":"[^"]*".*"Action":"(skip|pass|fail)"/u.exec(line)?.[1];
    if (event !== undefined) tally[event.toUpperCase() as keyof typeof tally] += 1;
  }
  return tally.SKIP + tally.PASS + tally.FAIL === 0 ? undefined : { skipped: tally.SKIP, all: tally.SKIP > 0 && tally.PASS + tally.FAIL === 0 };
}

function mavenOf(lines: string[]): SkippedTests | undefined {
  const total = lines.filter((line) => !line.includes("Time elapsed")).map((line) => MAVEN.exec(line)).filter((match): match is RegExpExecArray => match !== null).at(-1);
  if (total === null || total === undefined) return undefined;
  const [run, failures, errors, skipped] = total.slice(1).map(Number) as [number, number, number, number];
  return { skipped, all: skipped > 0 && run - failures - errors - skipped <= 0 };
}

function unittestOf(lines: string[]): SkippedTests | undefined {
  const ran = lines.map((line) => /^Ran (\d+) tests? in /u.exec(line)?.[1]).filter((value): value is string => value !== undefined).at(-1);
  const skipped = Number(lines.map((line) => /^(?:OK|FAILED) \(.*\bskipped=(\d+)/u.exec(line)?.[1]).filter((value): value is string => value !== undefined).at(-1) ?? 0);
  return ran === undefined ? undefined : { skipped, all: skipped > 0 && skipped >= Number(ran) };
}

/** mocha and rspec call a skipped test `pending`: `2 passing (5ms)` then `1 pending`. */
function pendingOf(lines: string[]): SkippedTests | undefined {
  const pending = Number(lines.map((line) => /^\s*(\d+) pending\b/u.exec(line)?.[1]).filter((value): value is string => value !== undefined).at(-1) ?? 0);
  const passing = Number(lines.map((line) => /^\s*(\d+) passing\b/u.exec(line)?.[1]).filter((value): value is string => value !== undefined).at(-1) ?? NaN);
  const failing = Number(lines.map((line) => /^\s*(\d+) failing\b/u.exec(line)?.[1]).filter((value): value is string => value !== undefined).at(-1) ?? 0);
  return pending === 0 && Number.isNaN(passing) && failing === 0 ? undefined : { skipped: pending, all: pending > 0 && passing === 0 && failing === 0 };
}

/** Any other runner that prints a skipped count on a summary line (`8 tests, 3 skipped`, `Skipped: 2`). Whether anything else ran is unknown, so it is never claimed to be all skipped. */
function genericOf(lines: string[]): SkippedTests | undefined {
  const counts = lines.map((line) => /(?:^|[\s,(])(\d+) (?:tests? )?skipped\b|\bSkipped: (\d+)\b|\bskipped=(\d+)\b/iu.exec(line)).filter((match): match is RegExpExecArray => match !== null);
  const last = counts.at(-1);
  const skipped = Number(last?.[1] ?? last?.[2] ?? last?.[3] ?? 0);
  return skipped === 0 ? undefined : { skipped, all: false };
}

/**
 * The skipped tests the output's summary lines state, or undefined when it states none (or states zero). With several runners in one command the skips add up, and the check is "all" only when every runner that
 * printed a summary ran nothing but skips. A recognised runner summary that says zero skips ends the search: the generic reader (which would pick up jest's "Test Suites: 1 skipped" line) runs only when no runner was recognised.
 */
export function skippedTestsOf(output: string): SkippedTests | undefined {
  const lines = tailLines(output);
  const found = [pytestOf(lines), jestVitestOf(lines), goOf(output), mavenOf(lines), unittestOf(lines), pendingOf(lines)].filter((entry): entry is SkippedTests => entry !== undefined);
  const result = found.length === 0 ? genericOf(lines) : { skipped: found.reduce((sum, entry) => sum + entry.skipped, 0), all: found.every((entry) => entry.all) };
  return result === undefined || result.skipped === 0 ? undefined : result;
}

// ---- a service the test could not reach

/** The connection was refused, or the name did not resolve: what every driver prints when nothing listens where the test looked. */
const REFUSED = /connection refused|ECONNREFUSED|Errno 111|could not connect to server|Can't connect to (?:local )?MySQL|Could not connect to Redis|ServerSelectionTimeout|MongoServerSelectionError|MongoNetworkError|could not translate host name|Name or service not known/iu;
/** What names the service in the same message: its own port, or the driver's own error (libpq's "could not connect to server" is Postgres's). */
const MARKERS: Readonly<Record<TestService, RegExp>> = {
  Postgres: /:5432\b|\bport 5432\b|psycopg2?\.OperationalError|asyncpg|could not connect to server/iu,
  MySQL: /:3306\b|\bport 3306\b|Can't connect to (?:local )?MySQL|pymysql|mysqlclient/iu,
  Redis: /:6379\b|\bport 6379\b|Could not connect to Redis|redis\.exceptions\.ConnectionError/iu,
  MongoDB: /:27017\b|\bport 27017\b|MongoServerSelectionError|MongoNetworkError|ServerSelectionTimeoutError|pymongo/iu,
};

/**
 * The test services a failing check's output says it could not reach, in a fixed order. A refusal AND the service's own marker must sit within three lines of each other (libpq splits its message over three lines),
 * so a port number or a refusal elsewhere in the output proves nothing. A hint to show with "looks like", never a fact.
 */
export function missingServicesOf(output: string): TestService[] {
  const lines = output.replace(ANSI, "").split(/\r?\n/u);
  const found = new Set<TestService>();
  for (let index = 0; index < lines.length; index += 1) {
    const window = lines.slice(index, index + 3).join("\n");
    if (!REFUSED.test(window)) continue;
    for (const service of TEST_SERVICES) if (MARKERS[service].test(window)) found.add(service);
  }
  return TEST_SERVICES.filter((service) => found.has(service));
}
