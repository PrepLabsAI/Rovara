// tests/contract/agent-checks.test.ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENTX_PREAMBLE, AGENTX_PREAMBLE_VERSION, AGENTX_WORKER_PROMPT, agentxPreambleSha256, CheckReportSchema, isPipedTestCommand,
  classifyCheck, matchTestCommand, parseAgentClaim, reportStatus, taskResultChecks, withoutOutputTail,
} from "@agentx/contracts";

describe("the AgentX preamble (spec 051 FR-001)", () => {
  it("is versioned and hashed together with the worker prompt", () => {
    expect(AGENTX_PREAMBLE_VERSION).toBe("3");
    expect(agentxPreambleSha256()).toBe(createHash("sha256").update(`${AGENTX_WORKER_PROMPT}\n\n${AGENTX_PREAMBLE}`).digest("hex"));
  });
  it("tells the agent each rule, and the final line (P-5)", () => {
    for (const phrase of ["Reproduce the problem", "before and after", "your own regression", "old behaviour the task asks you to change", "never claim", "AgentX result: done", "AgentX result: not done"]) {
      expect(AGENTX_PREAMBLE).toContain(phrase);
    }
  });
});

describe("matchTestCommand (FR-003, P-6)", () => {
  it.each([
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
  ])("replays %j", (command, replay) => {
    expect(matchTestCommand(command)).toBe(replay);
  });
  it.each([
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
    "npx vitest --update", "jest --watch", "jest --watchAll", "pytest --snapshot-update", "python3 -m pip install x",
    "pytest --junitxml=/etc/x", "FOO=/etc/x pytest", "make test -C /", "pytest --basetemp=../x", "npm test --prefix=/tmp",
  ])("does not treat %j as a check", (command) => {
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
  ])("runs %j with pipefail", (command) => {
    expect(isPipedTestCommand(command)).toBe(true);
  });
  it.each([
    "pytest", "pytest 2>&1", "pytest | head -5", "echo hi | tail -5", "npm install | tail -5",
    "pytest; rm x | tail -5", "grep -r x . | tail -5", "cd a && cd b && pytest | tail -5",
  ])("leaves %j as it is", (command) => {
    expect(isPipedTestCommand(command)).toBe(false);
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
