// tests/contract/agent-checks.test.ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENTX_PREAMBLE, AGENTX_PREAMBLE_VERSION, agentxPreambleSha256, CheckReportSchema,
  classifyCheck, matchTestCommand, parseAgentClaim, reportStatus,
} from "@agentx/contracts";

describe("the AgentX preamble (spec 051 FR-001)", () => {
  it("is versioned and hashed", () => {
    expect(AGENTX_PREAMBLE_VERSION).toBe("1");
    expect(agentxPreambleSha256()).toBe(createHash("sha256").update(AGENTX_PREAMBLE).digest("hex"));
  });
  it("tells the agent each rule, and the final line (P-5)", () => {
    for (const phrase of ["Reproduce the problem", "before and after", "your own regression", "never claim", "AgentX result: done", "AgentX result: not done"]) {
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
  ])("replays %j", (command, replay) => {
    expect(matchTestCommand(command)).toBe(replay);
  });
  it.each([
    "pytest | tail -5", "npm test; echo done", "npm test || true", "npm test > out.txt", "npm test &",
    "echo $(pytest)", "`pytest`", "git stash && pytest", "npm install", "npm run build", "python setup.py test",
    "cd a && cd b && pytest", "pytest-xdist", "", "   ",
    "pytest\nrm -rf .", "pytest\r\nrm x", "pytest\tfoo", "pytest\u0000", "cd a\n&& pytest", "pytest\n",
    "FOO=$X pytest", "pytest ${X}", "cd $HOME && pytest", "pytest *", "cd .. && pytest", "cd /etc && pytest",
    "cd ~ && pytest", "cd -- && pytest", "cd a/../.. && pytest", 'cd "a b" && pytest', 'pytest "-k x"',
    "pytest 'x'", "pytest ~/x", "pytest !x", "pytest a\\b", "pytest {a,b}", "pytest [a]", "pytest ?",
  ])("does not treat %j as a check", (command) => {
    expect(matchTestCommand(command)).toBeUndefined();
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
