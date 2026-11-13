// Owner decision 2026-10-27 (approval merges): the risk Rovara shows next to Merge. Every kind of change the owner named has its tier and a reason in words, whether or not the change is a fix.
import { describe, expect, it } from "vitest";
import { createCandidateManifest, type VerificationReport } from "@rovara-code/contracts";
import { assessRisk, type RiskFile, type RiskInput } from "../../packages/core/src/core/proof/risk.js";

const digest = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]).digest;
const clean: VerificationReport = { reviewOnly: false, passed: [{ label: "Unit tests" }], failed: [], notChecked: [], testsAdded: [] };
const risk = (files: RiskFile[], overrides: Partial<RiskInput> = {}) => assessRisk({ changedFiles: files, changedFilesComplete: true, report: clean, acceptedFindings: [], securityFindings: 0, candidateDigest: digest, ...overrides });
const file = (path: string, extra: Partial<RiskFile> = {}): RiskFile => ({ repository: "payments", path, added: 3, removed: 1, ...extra });

describe("the risk tiers", () => {
  const table: Array<{ name: string; files: RiskFile[]; level: "low" | "medium" | "high"; reason?: RegExp }> = [
    { name: "ordinary code with a test", files: [file("src/retry.ts"), file("tests/retry.test.ts", { added: 9, removed: 0 })], level: "low" },
    { name: "a GitHub workflow", files: [file(".github/workflows/ci.yml")], level: "high", reason: /CI|sensitive/u },
    { name: "a CircleCI config", files: [file(".circleci/config.yml")], level: "high", reason: /^Changes CI configuration/u },
    { name: "a GitLab pipeline", files: [file(".gitlab-ci.yml")], level: "high", reason: /^Changes CI configuration/u },
    { name: "a Jenkinsfile", files: [file("Jenkinsfile")], level: "high", reason: /^Changes CI configuration/u },
    { name: "the test runner's config", files: [file("vitest.config.ts")], level: "high", reason: /^Changes CI configuration/u },
    { name: "package.json", files: [file("package.json")], level: "medium", reason: /dependencies or build files/u },
    { name: "a lock file", files: [file("package-lock.json")], level: "medium", reason: /dependencies or build files/u },
    { name: "a python manifest", files: [file("requirements-dev.txt")], level: "medium", reason: /dependencies or build files/u },
    { name: "an auth folder", files: [file("src/auth/session.ts")], level: "high", reason: /sensitive paths/u },
    { name: "a security folder", files: [file("src/security/policy.ts")], level: "high", reason: /sensitive paths/u },
    { name: "an oauth folder", files: [file("src/oauth/callback.ts")], level: "high", reason: /sensitive paths/u },
    { name: "a permissions folder", files: [file("api/permissions/roles.ts")], level: "high", reason: /sensitive paths/u },
    { name: "a name that only contains auth", files: [file("src/author.ts"), file("src/security-notes.md"), file("docs/auth.md"), file("src/secretsanta.ts")], level: "low" },
    { name: "a file named after a security topic", files: [file("src/jwt.ts")], level: "high", reason: /sensitive paths/u },
    { name: "permissions.ts", files: [file("src/permissions.ts")], level: "high", reason: /sensitive paths/u },
    { name: "auth.ts", files: [file("src/auth.ts")], level: "high", reason: /sensitive paths/u },
    { name: "oauth.py", files: [file("lib/oauth.py")], level: "high", reason: /sensitive paths/u },
    { name: "security.rb", files: [file("app/security.rb")], level: "high", reason: /sensitive paths/u },
    { name: "crypto.go in any case", files: [file("pkg/Crypto.GO")], level: "high", reason: /sensitive paths/u },
    { name: "a name that joins a topic to another word", files: [file("src/user-auth.ts"), file("src/jwt_helper.py")], level: "high", reason: /sensitive paths/u },
    { name: "CODEOWNERS", files: [file(".github/CODEOWNERS")], level: "high", reason: /sensitive paths/u },
    { name: "CODEOWNERS at the root, in any case", files: [file("codeowners")], level: "high", reason: /sensitive paths/u },
    { name: "CODEOWNERS in docs", files: [file("docs/CODEOWNERS")], level: "high", reason: /sensitive paths/u },
    { name: "branch protection as code", files: [file(".github/settings.yml")], level: "high", reason: /sensitive paths/u },
    { name: "dependabot config", files: [file(".github/dependabot.yml")], level: "high", reason: /^Changes CI configuration/u },
    { name: "a jest json config", files: [file("jest.config.json")], level: "high", reason: /^Changes CI configuration/u },
    { name: "a vitest workspace", files: [file("vitest.workspace.ts")], level: "high", reason: /^Changes CI configuration/u },
    { name: "a top-level Makefile", files: [file("Makefile")], level: "high", reason: /^Changes CI configuration/u },
    { name: "turbo.json", files: [file("turbo.json")], level: "high", reason: /^Changes CI configuration/u },
    { name: "a Makefile deeper in the tree", files: [file("examples/demo/Makefile")], level: "low" },
    { name: "a public route", files: [file("src/routes.ts", { apiShapeChanged: true })], level: "medium", reason: /public API route or response shape/u },
    { name: "a schema file", files: [file("api/openapi.yaml", { apiShapeChanged: true })], level: "medium", reason: /public API route or response shape/u },
    { name: "a deleted test", files: [file("tests/a.test.ts", { added: 0, removed: 20, testsRemoved: true })], level: "medium", reason: /^Removes or skips tests/u },
    { name: "a skipped test", files: [file("tests/a.test.ts", { added: 1, removed: 0, testsSkipped: true })], level: "medium", reason: /^Removes or skips tests/u },
    { name: "a migration", files: [file("db/migrations/001.sql")], level: "high", reason: /sensitive paths/u },
  ];
  for (const row of table) {
    it(`${row.name} is ${row.level}`, () => {
      const result = risk(row.files);
      expect(result.level).toBe(row.level);
      if (row.reason !== undefined) expect(result.reasons.some((reason) => row.reason!.test(reason)), result.reasons.join(" | ")).toBe(true);
    });
  }

  it("the highest tier wins and every matching reason is kept", () => {
    const result = risk([file(".circleci/config.yml"), file("package.json"), file("tests/a.test.ts", { added: 0, removed: 5, testsRemoved: true })]);
    expect(result.level).toBe("high");
    expect(result.reasons.some((reason) => reason.startsWith("Changes CI configuration"))).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("dependencies or build files"))).toBe(true);
    expect(result.reasons.some((reason) => reason.startsWith("Removes or skips tests"))).toBe(true);
  });

  it("a fix keeps its own, stronger words (a fix that hides a failure is high)", () => {
    const result = risk([file("tests/a.test.ts", { added: 0, removed: 5, testsRemoved: true })], { fix: true });
    expect(result.level).toBe("high");
    expect(result.reasons.some((reason) => reason.startsWith("A fix removes or skips tests"))).toBe(true);
    expect(result.reasons.some((reason) => reason.startsWith("Removes or skips tests"))).toBe(false);
  });

  it("a file renamed out of a security name counts under its old name", () => {
    expect(risk([file("src/token.ts", { renamedFrom: "src/jwt.ts" })]).level).toBe("high");
  });

  it("a renamed file counts under both names", () => {
    expect(risk([file("ci/new.yml", { renamedFrom: ".gitlab-ci.yml" })]).level).toBe("high");
  });
});
