// TEST-RESULT-HONESTY: what a check's own output says about skipped tests and about a service the test could not reach. Fixtures are the real shapes the runners print (final summary lines only are read).
import { describe, expect, it } from "vitest";
import { missingServicesOf, skippedTestsOf } from "../../packages/contracts/src/test-output-signals.js";

const PYTEST_MIXED = `============================= test session starts ==============================
platform linux -- Python 3.12.3, pytest-8.3.2, pluggy-1.5.0
collected 7 items

tests/test_api.py ..s.s                                                  [ 71%]
tests/test_db.py ss                                                      [100%]

=========================== short test summary info ============================
SKIPPED [2] tests/test_db.py:12: needs DATABASE_URL
========================= 3 passed, 4 skipped in 0.42s =========================
`;
const JEST_MIXED = `PASS src/a.test.ts
 PASS src/b.test.ts

Test Suites: 1 skipped, 2 passed, 2 of 3 total
Tests:       4 skipped, 6 passed, 10 total
Snapshots:   0 total
Time:        2.1 s
Ran all test suites.
`;
const VITEST_MIXED = `
 Test Files  1 passed | 1 skipped (2)
      Tests  5 passed | 2 skipped (7)
   Start at  10:00:01
   Duration  1.20s (transform 20ms, setup 0ms, collect 30ms, tests 5ms)
`;
const GO_MIXED = `=== RUN   TestUsers
--- PASS: TestUsers (0.00s)
=== RUN   TestDB
    db_test.go:14: DATABASE_URL not set
--- SKIP: TestDB (0.00s)
PASS
ok  	example.com/app	0.003s
`;

describe("skippedTestsOf: pytest", () => {
  it("counts skipped on the final summary line", () => {
    expect(skippedTestsOf(PYTEST_MIXED)).toEqual({ skipped: 4, all: false });
  });
  it("reads the quiet (-q) line and a line with warnings", () => {
    expect(skippedTestsOf("..s\n3 passed, 1 skipped, 2 warnings in 0.30s\n")).toEqual({ skipped: 1, all: false });
  });
  it("says all when nothing ran but skips", () => {
    expect(skippedTestsOf("============================== 5 skipped in 0.11s ==============================\n")).toEqual({ skipped: 5, all: true });
  });
  it("a failure with skips is not all skipped", () => {
    expect(skippedTestsOf("=================== 1 failed, 2 skipped in 0.5s ===================")).toEqual({ skipped: 2, all: false });
  });
  it("is nothing when none were skipped or the run collected nothing", () => {
    expect(skippedTestsOf("========================= 9 passed in 0.42s =========================")).toBeUndefined();
    expect(skippedTestsOf("============================ no tests ran in 0.01s =============================")).toBeUndefined();
  });
  it("the word skipped inside a test's own output is not a summary", () => {
    expect(skippedTestsOf("step 3 skipped because cache was warm\n9 passed in 0.42s")).toBeUndefined();
  });
});

describe("skippedTestsOf: jest and vitest", () => {
  it("jest: the Tests line, not the Test Suites line", () => {
    expect(skippedTestsOf(JEST_MIXED)).toEqual({ skipped: 4, all: false });
  });
  it("jest: every test skipped (todo does not count as run)", () => {
    expect(skippedTestsOf("Tests:       3 skipped, 3 total\n")).toEqual({ skipped: 3, all: true });
    expect(skippedTestsOf("Tests:       1 skipped, 2 todo, 3 total\n")).toEqual({ skipped: 1, all: true });
  });
  it("jest: none skipped is nothing", () => {
    expect(skippedTestsOf("Test Suites: 1 skipped, 2 passed, 2 of 3 total\nTests:       6 passed, 6 total\n")).toBeUndefined();
  });
  it("vitest: the Tests line, not the Test Files line", () => {
    expect(skippedTestsOf(VITEST_MIXED)).toEqual({ skipped: 2, all: false });
  });
  it("vitest: every test skipped", () => {
    expect(skippedTestsOf(" Test Files  1 skipped (1)\n      Tests  3 skipped (3)\n")).toEqual({ skipped: 3, all: true });
    expect(skippedTestsOf("      Tests  2 skipped | 1 todo (3)\n")).toEqual({ skipped: 2, all: true });
  });
  it("vitest: a failing run with skips is not all skipped", () => {
    expect(skippedTestsOf("      Tests  1 failed | 2 skipped (3)\n")).toEqual({ skipped: 2, all: false });
  });
});

describe("skippedTestsOf: go test", () => {
  it("counts --- SKIP lines when the run passed others", () => {
    expect(skippedTestsOf(GO_MIXED)).toEqual({ skipped: 1, all: false });
  });
  it("all when only skips", () => {
    expect(skippedTestsOf("=== RUN   TestDB\n--- SKIP: TestDB (0.00s)\n=== RUN   TestCache\n--- SKIP: TestCache (0.00s)\nPASS\nok  \texample.com/app\t0.002s\n")).toEqual({ skipped: 2, all: true });
  });
  it("counts a skipped subtest of a passing parent", () => {
    expect(skippedTestsOf("--- PASS: TestA (0.00s)\n    --- SKIP: TestA/db (0.00s)\n    --- PASS: TestA/mem (0.00s)\nPASS\n")).toEqual({ skipped: 1, all: false });
  });
  it("reads go test -json skips", () => {
    expect(skippedTestsOf('{"Action":"run","Test":"TestDB"}\n{"Action":"skip","Package":"p","Test":"TestDB","Elapsed":0}\n{"Action":"pass","Package":"p","Elapsed":0.01}\n')).toEqual({ skipped: 1, all: true });
  });
  it("a plain pass with no -v says nothing about skips", () => {
    expect(skippedTestsOf("ok  \texample.com/app\t0.003s\n")).toBeUndefined();
  });
});

describe("skippedTestsOf: other runners that print a skipped count", () => {
  it("maven's total line", () => {
    const out = "[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 1, Time elapsed: 0.1 s - in com.a.AppTest\n[INFO] Results:\n[WARNING] Tests run: 5, Failures: 0, Errors: 0, Skipped: 2\n";
    expect(skippedTestsOf(out)).toEqual({ skipped: 2, all: false });
    expect(skippedTestsOf("Tests run: 5, Failures: 0, Errors: 0, Skipped: 5\n")).toEqual({ skipped: 5, all: true });
  });
  it("unittest", () => {
    expect(skippedTestsOf("Ran 5 tests in 0.002s\n\nOK (skipped=2)\n")).toEqual({ skipped: 2, all: false });
    expect(skippedTestsOf("Ran 5 tests in 0.002s\n\nOK (skipped=5)\n")).toEqual({ skipped: 5, all: true });
  });
  it("mocha: pending is skipped", () => {
    expect(skippedTestsOf("  2 passing (5ms)\n  1 pending\n")).toEqual({ skipped: 1, all: false });
    expect(skippedTestsOf("  0 passing (3ms)\n  4 pending\n")).toEqual({ skipped: 4, all: true });
  });
  it("generic: a skipped count on a summary line", () => {
    expect(skippedTestsOf("Summary: 8 tests, 3 skipped\n")).toEqual({ skipped: 3, all: false });
    expect(skippedTestsOf("Skipped: 2\n")).toEqual({ skipped: 2, all: false });
    expect(skippedTestsOf("0 skipped\n")).toBeUndefined();
  });
  it("strips colour codes and reads only the last lines", () => {
    expect(skippedTestsOf("\u001b[32m3 passed\u001b[0m, \u001b[33m2 skipped\u001b[0m in 0.5s")).toEqual({ skipped: 2, all: false });
    const long = `${"4 skipped in 0.1s\n"}${Array.from({ length: 200 }, () => "noise").join("\n")}\n9 passed in 1s\n`;
    expect(skippedTestsOf(long)).toBeUndefined();
  });
  it("empty output is nothing", () => {
    expect(skippedTestsOf("")).toBeUndefined();
  });
});

describe("missingServicesOf", () => {
  const cases: Array<[string, string, string[]]> = [
    ["psycopg2 (older libpq)", 'psycopg2.OperationalError: could not connect to server: Connection refused\n\tIs the server running on host "localhost" (127.0.0.1) and accepting\n\tTCP/IP connections on port 5432?\n', ["Postgres"]],
    ["psycopg2 (libpq 14)", 'psycopg2.OperationalError: connection to server at "localhost" (127.0.0.1), port 5432 failed: Connection refused\n', ["Postgres"]],
    ["node pg", "Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect", ["Postgres"]],
    ["go", 'failed to connect: dial tcp 127.0.0.1:5432: connect: connection refused\n', ["Postgres"]],
    ["MySQL (pymysql)", `pymysql.err.OperationalError: (2003, "Can't connect to MySQL server on 'localhost' ([Errno 111] Connection refused)")\n`, ["MySQL"]],
    ["MySQL (node)", "Error: connect ECONNREFUSED 127.0.0.1:3306\n", ["MySQL"]],
    ["Redis (redis-py)", "redis.exceptions.ConnectionError: Error 111 connecting to localhost:6379. Connection refused.\n", ["Redis"]],
    ["Redis (node)", "Error: connect ECONNREFUSED 127.0.0.1:6379\n", ["Redis"]],
    ["MongoDB (pymongo)", "pymongo.errors.ServerSelectionTimeoutError: localhost:27017: [Errno 111] Connection refused (configured timeouts: socketTimeoutMS: 20000.0ms)\n", ["MongoDB"]],
    ["MongoDB (mongoose)", "MongooseServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017\n", ["MongoDB"]],
    ["two services", "Error: connect ECONNREFUSED 127.0.0.1:5432\nError: connect ECONNREFUSED 127.0.0.1:6379\n", ["Postgres", "Redis"]],
  ];
  for (const [name, output, expected] of cases) it(`reads ${name}`, () => expect(missingServicesOf(output)).toEqual(expected));
  it("says nothing for a refused connection to another port or a plain failure", () => {
    expect(missingServicesOf("Error: connect ECONNREFUSED 127.0.0.1:8080\n")).toEqual([]);
    expect(missingServicesOf("AssertionError: expected 3 to equal 4\n")).toEqual([]);
    expect(missingServicesOf("listening on port 5432 for the fixture\nAssertionError: x\n")).toEqual([]);
    expect(missingServicesOf("")).toEqual([]);
  });
});
