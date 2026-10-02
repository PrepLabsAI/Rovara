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
  });
});

describe("the check report", () => {
  it("is a regression when any entry is", () => {
    const entry = { id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "failed", class: "regression", output: "1 failed", durationMs: 10 } as const;
    expect(reportStatus([entry])).toBe("regression");
    expect(reportStatus([{ ...entry, after: "passed", class: "passing" }])).toBe("verified");
    expect(CheckReportSchema.parse({
      status: "regression", source: "project", preambleVersion: "1", preambleSha256: "a".repeat(64),
      checks: [entry], extraTry: "given", agentClaim: "success",
    }).checks).toHaveLength(1);
  });
});
