// tests/contract/agent-checks.test.ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENTX_PREAMBLE, AGENTX_PREAMBLE_VERSION, AGENTX_WORKER_PROMPT, agentxPreambleSha256, CheckReportSchema, isPipedTestCommand,
  classifyCheck, matchTestCommand, parseAgentClaim, reportStatus, scanTestCommands, taskResultChecks, withoutOutputTail,
} from "@agentx/contracts";

describe("the AgentX preamble (spec 051 FR-001)", () => {
  it("is versioned and hashed together with the worker prompt", () => {
    expect(AGENTX_PREAMBLE_VERSION).toBe("4");
    expect(agentxPreambleSha256()).toBe(createHash("sha256").update(`${AGENTX_WORKER_PROMPT}\n\n${AGENTX_PREAMBLE}`).digest("hex"));
  });
  it("tells the agent each rule, and the final line (P-5)", () => {
    for (const phrase of ["Reproduce the problem", "before and after", "your own regression", "old behaviour the task asks you to change", "Never edit or delete a test to make it pass", "Fix your change, not the test", "never claim", "AgentX result: done", "AgentX result: not done"]) {
      expect(AGENTX_PREAMBLE).toContain(phrase);
    }
  });
});

/** Today's simple test commands (P-6, D-14, D-15) and their replays. */
const SIMPLE_REPLAYS: [string, string][] = [
  ["npm test", "npm test"],
  ["npm run test -- -t foo", "npm run test -- -t foo"],
  ["pnpm test", "pnpm test"], ["yarn test", "yarn test"],
  ["pytest tests/test_a.py -k x", "pytest tests/test_a.py -k x"],
  ["python -m pytest -q", "python -m pytest -q"],
  ["go test ./...", "go test ./..."], ["cargo test", "cargo test"], ["make test", "make test"],
  ["mvn test", "mvn test"], ["gradle test", "gradle test"], ["./gradlew test", "./gradlew test"],
  ["bundle exec rspec spec/a_spec.rb", "bundle exec rspec spec/a_spec.rb"],
  ["phpunit", "phpunit"], ["tox -e py311", "tox -e py311"],
  ["cd pkg && npm test", "cd pkg && npm test"],
  ["FOO=1 BAR=2 pytest -k x", "FOO=1 BAR=2 pytest -k x"],
  ["timeout 600 pytest", "timeout 600 pytest"],
  ["  pytest  ", "pytest"],
  ["pytest --junitxml=out/report.xml", "pytest --junitxml=out/report.xml"],
  // An output tail is allowed and left out of the replay.
  ["python -m pytest a/test_x.py -x -q 2>&1 | tail -30", "python -m pytest a/test_x.py -x -q"],
  ["pytest -q 2>&1 | tail -n 20", "pytest -q"],
  ["cd pkg && npm test 2>&1 | tail -n50", "cd pkg && npm test"],
  ["go test ./... | tail -5", "go test ./..."],
  ["pytest|tail -5", "pytest"],
  ["cargo test 2>&1", "cargo test"],
  // D-15 (#290): runners agents use directly, and literal quoted arguments.
  ["python3 -m pytest openlibrary/tests/catalog/test_utils.py -k format_lang -v", "python3 -m pytest openlibrary/tests/catalog/test_utils.py -k format_lang -v"],
  ['yarn jest --testPathPattern="RoomViewStore|RoomView" --no-coverage 2>&1 | tail -30', 'yarn jest --testPathPattern="RoomViewStore|RoomView" --no-coverage'],
  ["npx jest src/a.test.ts", "npx jest src/a.test.ts"], ["jest --runInBand", "jest --runInBand"], ["pnpm jest", "pnpm jest"],
  ["npx vitest run src", "npx vitest run src"], ["vitest run", "vitest run"], ["yarn vitest run", "yarn vitest run"],
  ['python -m pytest tests -k "not slow and (config or qtargs)"', 'python -m pytest tests -k "not slow and (config or qtargs)"'],
  ["pytest -k 'test_a or test_b'", "pytest -k 'test_a or test_b'"],
  ['pytest "-k x"', 'pytest "-k x"'], ["pytest 'x'", "pytest 'x'"],
  // #292: mocha, as the agent ran it on NodeBB.
  ["npx mocha test/template-helpers.js --timeout 10000 2>&1 | tail -20", "npx mocha test/template-helpers.js --timeout 10000"],
  ["mocha test", "mocha test"], ["yarn mocha", "yarn mocha"], ["pnpm mocha test/a.js", "pnpm mocha test/a.js"],
];
/** Commands matchTestCommand refuses. */
const NOT_SIMPLE: string[] = [
  "pytest | tail", "pytest | tail -f", "pytest | head -5", "pytest | grep x", "pytest | tail -5 | grep x",
  "pytest 2>&1 | tail -5 > out.txt", "pytest > out.txt 2>&1", "pytest 2>/dev/null | tail -5", "pytest | tail -5 &",
  "npm test; echo x | tail -5", "npm install 2>&1 | tail -5", "echo $(pytest) | tail -5", "npm test; echo done", "npm test || true", "npm test > out.txt", "npm test &",
  "echo $(pytest)", "`pytest`", "git stash && pytest", "npm install", "npm run build", "python setup.py test",
  "cd a && cd b && pytest", "pytest-xdist", "", "   ",
  "pytest\nrm -rf .", "pytest\r\nrm x", "pytest\tfoo", "pytest\u0000", "cd a\n&& pytest", "pytest\n",
  "FOO=$X pytest", "pytest ${X}", "cd $HOME && pytest", "pytest *", "cd .. && pytest", "cd /etc && pytest",
  "cd ~ && pytest", "cd -- && pytest", "cd a/../.. && pytest", 'cd "a b" && pytest',
  "pytest ~/x", "pytest !x", "pytest a\\b", "pytest {a,b}", "pytest [a]", "pytest ?",
  // D-15: quotes that a shell would still expand, unclosed or escaping, a quoted runner or path, and replays that
  // write files or never end (snapshot updates, watch modes).
  'pytest -k "$X"', "pytest -k \"`id`\"", 'pytest -k "a\\b"', 'pytest -k "a', '"pytest" -k x',
  'pytest --rootdir="/etc"', "pytest -k '../x'", "jest -u", "yarn jest --updateSnapshot", "npx vitest run -u",
  "npx vitest --update", "jest --watch", "jest --watchAll", "npx mocha --watch", "pytest --snapshot-update", "python3 -m pip install x",
  "pytest --junitxml=/etc/x", "FOO=/etc/x pytest", "make test -C /", "pytest --basetemp=../x", "npm test --prefix=/tmp",
];

describe("matchTestCommand (FR-003, P-6)", () => {
  it.each(SIMPLE_REPLAYS)("replays %j", (command, replay) => {
    expect(matchTestCommand(command)).toBe(replay);
  });
  it.each(NOT_SIMPLE)("does not treat %j as a check", (command) => {
    expect(matchTestCommand(command)).toBeUndefined();
  });
});

describe("withoutOutputTail and isPipedTestCommand (pipefail for a piped test command)", () => {
  it.each([
    ["pytest -q 2>&1 | tail -20", { command: "pytest -q", piped: true }],
    ["pytest -q | tail -n 5", { command: "pytest -q", piped: true }],
    ["pytest -q 2>&1", { command: "pytest -q", piped: false }],
    ["pytest -q", { command: "pytest -q", piped: false }],
    ["pytest | head -5", { command: "pytest | head -5", piped: false }],
  ])("splits %j", (command, expected) => {
    expect(withoutOutputTail(command)).toEqual(expected);
  });
  it.each([
    "pytest | tail -5", "python -m pytest a/test_x.py -q 2>&1 | tail -30",
    // The cd target is not checked: an eval's container path is still a test command for pipefail.
    "cd /testbed && python -m pytest a/test_x.py -q 2>&1 | tail -20",
    // #299: `cd <dir>; <test>` is the same command, and its run counts as a before, so it needs pipefail too.
    "cd /testbed; python -m pytest a/test_x.py -q 2>&1 | tail -20", "cd a;pytest|tail -n 5",
  ])("runs %j with pipefail", (command) => {
    expect(isPipedTestCommand(command)).toBe(true);
  });
  it.each([
    "pytest", "pytest 2>&1", "pytest | head -5", "echo hi | tail -5", "npm install | tail -5",
    "pytest; rm x | tail -5", "grep -r x . | tail -5", "cd a && cd b && pytest | tail -5",
    // #299: chains and other filters are recognised, but their run never counts as a before.
    "cd a; cd b; pytest | tail -5", "go build && pytest | tail -5", "pytest | grep x | tail -5", "pytest | tail -5;",
  ])("leaves %j as it is", (command) => {
    expect(isPipedTestCommand(command)).toBe(false);
  });
});

/** As the recorder maps an eval's `/app` (the workspace root) and `/app/<sub>`. */
const appRoot = { cdTarget: (target: string) => (target === "/app" ? "" : target.startsWith("/app/") ? target.slice(5) : undefined) };
const before = (replay: string) => ({ replay, ownRunIsBefore: true });
const rerun = (replay: string) => ({ replay, ownRunIsBefore: false });

describe("scanTestCommands: tests inside chains and filters (#299)", () => {
  it.each<[string, { replay: string; ownRunIsBefore: boolean }[]]>([
    // The commands quoted in #299, from batch 744df9ec, with /app mapped to the workspace root.
    ["cd /app; QUTE_QT_WRAPPER=PyQt6 python -m pytest tests/unit/misc/test_guiprocess.py -q 2>&1|tail -8",
      [before("QUTE_QT_WRAPPER=PyQt6 python -m pytest tests/unit/misc/test_guiprocess.py -q")]],
    ["cd /app; QT_QPA_PLATFORM=offscreen python -m pytest tests/unit/browser/webengine -q 2>&1 | tail -4",
      [before("QT_QPA_PLATFORM=offscreen python -m pytest tests/unit/browser/webengine -q")]],
    ["cd /app && python -m pytest openlibrary/tests/solr -q 2>&1 | tail -5", [before("python -m pytest openlibrary/tests/solr -q")]],
    ['python -m pytest openlibrary/tests/solr -q -x 2>&1 | grep -E "^E" | head', [rerun("python -m pytest openlibrary/tests/solr -q -x")]],
    ["go build ./... && go test ./scanner ./models 2>&1 | tail -20", [rerun("go test ./scanner ./models")]],
    ["go test ./internal/ext/... 2>&1 | tail -20; go vet ./internal/...", [rerun("go test ./internal/ext/...")]],
    // Requirement 1: `cd <dir>; <test>` is `cd <dir> && <test>`.
    ["cd pkg; npm test", [before("cd pkg && npm test")]],
    ["cd pkg;npm test 2>&1", [before("cd pkg && npm test")]],
    ["cd a&&pytest", [before("cd a && pytest")]],
    ["cd /app/sub; pytest -q", [before("cd sub && pytest -q")]],
    // Requirement 2: chains, cd composition, several tests, dedupe.
    ["pytest a && pytest b && pytest a", [rerun("pytest a"), rerun("pytest b")]],
    ["cd a && cd b && pytest", [rerun("cd a/b && pytest")]],
    ["cd a/ && cd b; pytest", [rerun("cd a/b && pytest")]],
    ["cd /app/x; cd y && pytest", [rerun("cd x/y && pytest")]],
    ["cd x && cd /app && pytest", [rerun("pytest")]],
    ["cd pkg && npm install && npm test -- -t foo", [rerun("cd pkg && npm test -- -t foo")]],
    ["make build; pytest", [rerun("pytest")]],
    ["pytest; export X=1", [rerun("pytest")]],
    ["pytest;", [rerun("pytest")]],
    ["npm test || true", [rerun("npm test")]],
    // Requirement 3: filters.
    ["pytest | sed -n 1,5p", [rerun("pytest")]],
    ["pytest 2>&1 | sort | uniq -c | wc -l", [rerun("pytest")]],
    ["pytest | cut -c1-80 | cat", [rerun("pytest")]],
    ["pytest -q | egrep 'FAIL|ERROR'", [rerun("pytest -q")]],
    ["pytest | tail -n 5 | head -2", [rerun("pytest")]],
    // A quoted operator stays inside its word (abuse case 2).
    ['pytest -k "a;b"', [before('pytest -k "a;b"')]],
    ["pytest -k 'x && y' | tail -5", [before("pytest -k 'x && y'")]],
    // Abuse case 1: only the test's own text is replayed.
    ["pytest; rm -rf build", [rerun("pytest")]],
    // Abuse case 5: an exit code that is not the test's never serves as a before.
    ["pytest; true", [rerun("pytest")]],
    // A test that is not first in its pipeline is not recorded (Requirement 3.5).
    ["cat x | pytest", []],
    ["npm install", []],
  ])("finds the tests in %j", (command, tests) => {
    expect(scanTestCommands(command, appRoot).tests).toEqual(tests);
  });

  it.each([
    // Abuse case 3: an unquoted backslash.
    "pytest a\\;b", "pytest \\| tail -5",
    // Abuse case 4: a cd that leaves the workspace, alone or composed.
    "cd a && cd ../.. && pytest", "cd a; cd /etc; pytest", "cd /etc; pytest", "cd ..; pytest",
    // Requirement 2.5 and 2.6: cd joined by ||, with no target, - or ~.
    "cd a || exit; pytest", "false || cd a; pytest", "cd; pytest", "cd -; pytest", "cd ~; pytest", 'cd "a b"; pytest',
    "cd a b; pytest", "cd a | cat; pytest", "cd a 2>&1; pytest",
    // Abuse case 6 and Requirement 4.2: git stash anywhere.
    "git stash && pytest; git stash pop", "git -C a stash; pytest", "pytest; git stash", "git stash list | cat; pytest",
    // Abuse case 8 and Requirement 3.4: a filter outside the allowlist, or sed in place.
    "pytest | tee out.txt", "pytest | xargs rm", "pytest | sed -i s/x/y/ a.py", "pytest | sed -ni 1p a.py",
    "pytest | sed --in-place s/x/y/ a.py", "pytest | sed --in-place=.bak s/x/y/ a.py", "pytest | sh",
    // Abuse case 9 and Requirement 4.3: an environment changer before the test.
    "export PYTHONPATH=x; pytest", "PYTHONPATH=x; pytest", "source venv/bin/activate && pytest", ". venv/bin/activate && pytest",
    "set -e; pytest", "unset X; pytest", "alias pytest=true; pytest", "pushd a && pytest", "popd; pytest", "shopt -s x; pytest",
    "ulimit -n 10; pytest", "umask 0; pytest", "eval x; pytest", "exec 3>x; pytest", "declare -x X=1; pytest",
    "typeset X=1; pytest", "readonly X=1; pytest",
    // Requirement 4.1: groups, substitutions, background, heredocs, redirections, control characters.
    "(pytest)", "{ pytest; }", "pytest &", "pytest & pytest", "pytest |& tail -5", "pytest <<EOF", "pytest < in.txt",
    "pytest > out", "pytest 2>/dev/null", "pytest 2>&1 > out", "pytest 1>&2", "pytest x2>&1", "pytest 2>&12",
    "pytest\nrm x", "pytest\r\n", "pytest\tfoo", "echo $(pytest)", "`pytest`", "pytest $X", "pytest; echo # x",
    // Requirement 4.4: empty parts and unclosed quotes.
    "", "   ", ";", "; pytest", "pytest;;", "pytest && ; x", "pytest &&", "pytest |", "| pytest", 'pytest "a',
  ])("refuses %j", (command) => {
    expect(scanTestCommands(command, appRoot)).toEqual({ tests: [], othersMayChange: true });
  });

  it("marks a command whose parts are only tests, cd and allowed filters as one that changes nothing else", () => {
    expect(scanTestCommands("cd a && pytest 2>&1 | grep x | head -3; pytest b").othersMayChange).toBe(false);
    expect(scanTestCommands("pytest").othersMayChange).toBe(false);
    expect(scanTestCommands("sed -i s/x/y/ a.py && pytest").othersMayChange).toBe(true);
    expect(scanTestCommands("pytest; export X=1").othersMayChange).toBe(true);
  });

  it("maps every cd target, and leaves an unmapped one as written", () => {
    expect(scanTestCommands("cd /app/a; cd b && pytest", appRoot).tests).toEqual([rerun("cd a/b && pytest")]);
    expect(scanTestCommands("cd /app/a; pytest").tests).toEqual([]);
  });

  it("finds each simple command today's matcher replays, with the same replay and its run as a before (Requirement 7.3)", () => {
    for (const [command, replay] of SIMPLE_REPLAYS) expect(scanTestCommands(command), command).toEqual({ tests: [before(replay)], othersMayChange: false });
  });

  /** Requirement 7.4: refused today, recognised now, never with the agent's run as the before. */
  const NOW_RECOGNISED: Record<string, string> = {
    "pytest | tail": "pytest", "pytest | tail -f": "pytest", "pytest | head -5": "pytest", "pytest | grep x": "pytest",
    "pytest | tail -5 | grep x": "pytest", "npm test; echo x | tail -5": "npm test", "npm test; echo done": "npm test",
    "npm test || true": "npm test", "cd a && cd b && pytest": "cd a/b && pytest",
  };

  it("keeps every other command today's matcher refuses refused (Requirement 7.4)", () => {
    for (const command of NOT_SIMPLE) {
      const expected = NOW_RECOGNISED[command];
      expect(scanTestCommands(command).tests, command).toEqual(expected === undefined ? [] : [rerun(expected)]);
    }
    expect(Object.keys(NOW_RECOGNISED).every((command) => NOT_SIMPLE.includes(command))).toBe(true);
  });

  it("only ever yields a replay that matchTestCommand maps to itself (Requirement 7.1)", () => {
    const commands = [...SIMPLE_REPLAYS.map(([command]) => command), ...NOT_SIMPLE,
      "go build ./... && go test ./scanner ./models 2>&1 | tail -20", "cd a && cd b && pytest", "cd /app/x; cd y && pytest",
      "cd /app; QUTE_QT_WRAPPER=PyQt6 python -m pytest tests/unit/misc/test_guiprocess.py -q 2>&1|tail -8",
      'python -m pytest openlibrary/tests/solr -q -x 2>&1 | grep -E "^E" | head', "pytest -k 'x && y' | tail -5"];
    for (const command of commands) {
      for (const { replay } of scanTestCommands(command, appRoot).tests) expect(matchTestCommand(replay), command).toBe(replay);
    }
  });
});

describe("classifyCheck (FR-004)", () => {
  it.each([
    ["passed", "passed", "passing"],
    ["passed", "failed", "regression"],
    ["passed", "timed_out", "regression"],
    ["failed", "failed", "already_failing"],
    ["failed", "passed", "fixed"],
    ["unknown", "failed", "failing_no_before"],
    ["unknown", "passed", "passing"],
    ["passed", "not_run", "not_rerun"],
    ["timed_out", "passed", "fixed"],
    ["timed_out", "failed", "already_failing"],
    ["failed", "timed_out", "already_failing"],
    ["unknown", "timed_out", "failing_no_before"],
    ["passed", "unknown", "not_rerun"],
    ["not_run", "failed", "failing_no_before"],
  ] as const)("before %s, after %s → %s", (before, after, expected) => {
    expect(classifyCheck(before, after)).toBe(expected);
  });
});

describe("parseAgentClaim (P-5)", () => {
  it("reads the final line", () => {
    expect(parseAgentClaim("Fixed it.\nAgentX result: done")).toBe("success");
    expect(parseAgentClaim("Could not.\nAgentX result: not done\n")).toBe("failure");
    expect(parseAgentClaim("All tests pass")).toBe("none");
    expect(parseAgentClaim(undefined)).toBe("none");
    expect(parseAgentClaim("AgentX result: done\nmore text after")).toBe("none");
    expect(parseAgentClaim("x\r\nAgentX result: done\r\n")).toBe("success");
    expect(parseAgentClaim("AgentX result: done\n\n\n")).toBe("success");
    expect(parseAgentClaim("AgentX result: done.")).toBe("none");
  });
});

describe("the check report", () => {
  const entry = { id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "failed", class: "regression", output: "1 failed", durationMs: 10 } as const;
  const report = {
    status: "regression", source: "project", preambleVersion: "1", preambleSha256: "a".repeat(64),
    checks: [entry], extraTry: "given", agentClaim: "success",
  };
  it("is a regression when any entry is, not_verified when nothing was rerun, else verified", () => {
    expect(reportStatus([entry])).toBe("regression");
    expect(reportStatus([{ ...entry, class: "passing", after: "passed" }, entry])).toBe("regression");
    expect(reportStatus([{ ...entry, after: "passed", class: "passing" }])).toBe("verified");
    expect(reportStatus([{ ...entry, after: "passed", class: "fixed" }, { ...entry, after: "not_run", class: "not_rerun" }])).toBe("verified");
    expect(reportStatus([])).toBe("not_verified");
    expect(reportStatus([{ ...entry, after: "not_run", class: "not_rerun" }])).toBe("not_verified");
  });
  it("parses a valid report", () => {
    expect(CheckReportSchema.parse(report).checks).toHaveLength(1);
  });
  it.each([
    ["a bad status", { ...report, status: "fine" }],
    ["a bad hash", { ...report, preambleSha256: "xyz" }],
    ["an unknown field", { ...report, extra: 1 }],
    ["an unknown entry field", { ...report, checks: [{ ...entry, extra: 1 }] }],
    ["a negative duration", { ...report, checks: [{ ...entry, durationMs: -1 }] }],
    ["an empty label", { ...report, checks: [{ ...entry, label: "" }] }],
    ["too many checks", { ...report, checks: Array.from({ length: 65 }, () => entry) }],
  ])("rejects %s", (_name, value) => {
    expect(CheckReportSchema.safeParse(value).success).toBe(false);
  });
});

describe("taskResultChecks: a task result's report (FR-007, Review Focus 5)", () => {
  const report = {
    status: "verified", source: "none", preambleVersion: "1", preambleSha256: "a".repeat(64),
    checks: [], extraTry: "not_needed", agentClaim: "none",
  };
  it("reads the report from a new worker's result", () => {
    expect(taskResultChecks({ conversationId: "c", reopened: false, checks: report })).toEqual(report);
  });
  it("is undefined for an old worker's result, or one whose report does not parse", () => {
    expect(taskResultChecks({ conversationId: "c", reopened: false })).toBeUndefined();
    expect(taskResultChecks({ conversationId: "c", reopened: false, checks: { ...report, status: "fine" } })).toBeUndefined();
    expect(taskResultChecks(undefined)).toBeUndefined();
    expect(taskResultChecks("result")).toBeUndefined();
  });
});
