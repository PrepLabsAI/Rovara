// TE-B3 (O39): no test is weakened silently. Flags for a reviewer, words only: Rovara instruction files and files CI runs at the top of the description, tests that ran before and not now, more skips, changed snapshots,
// fixtures and test configuration. Each flag has a fixture, the path through the real reader / risk / pull request body, and the untrusted-text cases (names come from a repository).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EvidencePackSchema, type EvidencePack, type VerificationReport } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { parseChangedFiles } from "../../packages/broker/src/core/proof/changed-files.js";
import { assessRisk, isCiExecutedPath, type RiskFile } from "../../packages/broker/src/core/proof/risk.js";
import { WEAKENING_HEADING, notComparedReason, weakeningBlock } from "../../packages/broker/src/core/proof/weakening-flags.js";
import { isFixturePath, isInstructionFilePath, isSnapshotPath, isTestConfigPath } from "../../packages/broker/src/core/proof/weakening-paths.js";
import { rovaraStatusLines } from "../../packages/broker/src/core/proof/pull-request-body.js";
import type { ChangedFileEntry } from "../../packages/broker/src/core/proof/verification-report.js";
import { expectLinearScaling } from "../support/scaling.js";
const section = (diff: string[]) => ["## app", "", "### status", "### diff", ...diff].join("\n");
const hunk = (path: string, plus: string[] = ["new"], minus: string[] = ["old"]): string[] => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...minus.map((line) => `-${line}`), ...plus.map((line) => `+${line}`)];
const read = (...diff: string[][]) => parseChangedFiles(section(diff.flat())).files;
const flagsOf = (path: string, plus: string[] = ["new"], minus: string[] = ["old"]): ChangedFileEntry => read(hunk(path, plus, minus))[0]!;

describe("the path classes", () => {
  it.each([
    ["AGENTS.md", true], ["CLAUDE.md", true], ["docs/AGENTS.md", true], ["claude.md", true], [".rovara/rules/style.md", true], [".rovara/rules/nested/a.md", true], [".rovara/playbook.yaml", true], [".rovara/project.json", true],
    ["README.md", false], ["docs/agents-guide.md", false], [".rovara/cache/x.json", false], ["src/rovara/rules.ts", false], ["AGENTS.md.bak", false],
  ])("instruction file %s -> %s", (path, expected) => expect(isInstructionFilePath(path)).toBe(expected));
  it.each([
    ["pytest.ini", true], ["conftest.py", true], ["tests/conftest.py", true], ["jest.config.ts", true], ["packages/a/jest.config.js", true], ["vitest.config.mts", true], ["Makefile", true], ["sub/Makefile", false], [".coveragerc", true], [".nycrc.json", true],
    ["tox.ini", true], ["codecov.yml", true], ["src/config.ts", false], ["src/makefile-helper.ts", false],
  ])("test configuration %s -> %s", (path, expected) => expect(isTestConfigPath(path)).toBe(expected));
  it.each([
    ["src/__snapshots__/a.test.ts.snap", true], ["a.snap", true], ["tests/test_x.ambr", true], ["tests/snapshots/x.txt", true], ["testdata/out.golden", true], ["Foo.verified.txt", true], ["src/snapshot.ts", false],
  ])("snapshot %s -> %s", (path, expected) => expect(isSnapshotPath(path)).toBe(expected));
  it.each([
    ["tests/fixtures/a.json", true], ["src/__fixtures__/b.ts", true], ["testdata/in.txt", true], ["cassettes/x.yaml", true], ["src/fixture-loader.ts", false],
  ])("fixture %s -> %s", (path, expected) => expect(isFixturePath(path)).toBe(expected));
});

describe("the changed-files reader flags weakening", () => {
  it.each([
    ["pytest.skip in a test", "tests/test_a.py", "    pytest.skip('flaky')"], ["xfail", "tests/test_a.py", "@pytest.mark.xfail"], ["skipif", "tests/test_a.py", "@pytest.mark.skipif(True, reason='x')"],
    ["unittest.expectedFailure", "tests/test_a.py", "@unittest.expectedFailure"], ["t.Skipf", "tests/a_test.go", "t.Skipf(\"no\")"], ["it.skip", "src/a.test.ts", "it.skip('x', () => {})"],
    ["JUnit enabled=false", "src/test/java/ATest.java", "@Test(enabled = false)"], ["C# Ignore", "tests/ATests.cs", "[Ignore]"],
  ])("a test that is switched off: %s", (_name, path, line) => {
    expect(flagsOf(path, [line]).testsSkipped).toBe(true);
  });
  it("flags a coverage exclusion anywhere, and an ignore option only in a test or coverage configuration", () => {
    expect(flagsOf("src/a.py", ["x = 1  # pragma: no cover"]).testsExcluded).toBe(true);
    expect(flagsOf("src/a.ts", ["/* istanbul ignore next */"]).testsExcluded).toBe(true);
    expect(flagsOf("src/a.ts", ["// c8 ignore start"]).testsExcluded).toBe(true);
    expect(flagsOf("jest.config.js", ["  testPathIgnorePatterns: ['/legacy/'],"]).testsExcluded).toBe(true);
    expect(flagsOf("pytest.ini", ["addopts = --deselect tests/test_a.py::test_x"]).testsExcluded).toBe(true);
    expect(flagsOf("Makefile", ["\tpytest --ignore=tests/slow"]).testsExcluded).toBe(true);
    expect(flagsOf("package.json", ['    "test": "vitest --exclude src/a.test.ts"']).testsExcluded).toBe(true);
    expect(flagsOf("src/cli.ts", ["parser.add('--ignore')"]).testsExcluded).toBeUndefined();
    expect(flagsOf(".coveragerc", ["[report]"], ["omit = a.py"]).testsExcluded).toBeUndefined();
  });
  it("flags a change to the scripts CI runs in package.json, and only there", () => {
    for (const script of ['"test": "vitest"', '"test:unit": "x"']) expect(flagsOf("package.json", [`    ${script},`]).testCommandChanged, script).toBe(true);
    // Every other script CI runs is a flag of its own, never the `test` rule (the fix-mode high rule reads only that one).
    for (const script of ['"pretest": "x"', '"posttest": "x"', '"ci": "x"', '"coverage": "x"', '"verify": "x"', '"check": "x"', '"check:types": "x"']) {
      const entry = flagsOf("package.json", [`    ${script},`]);
      expect(entry.ciScriptChanged, script).toBe(true);
      expect(entry.testCommandChanged, script).toBeUndefined();
    }
    expect(flagsOf("package.json", ['    "build": "tsc",']).testCommandChanged).toBeUndefined();
    expect(flagsOf("src/a.json", ['    "test": "x",']).testCommandChanged).toBeUndefined();
  });
});

describe("worst-case input to the new readers (8 MiB, linear time)", () => {
  const MIB8 = 8 * 1_048_576;
  it.each([
    ["one line of @Test( openers", "@Test(", "tests/ATest.java"],
    ["one line of 'pytest.' prefixes", "pytest.mark.", "tests/test_a.py"],
    ["one line of coverage-pragma prefixes", "# pragma: no ", "src/a.py"],
    ["one line of ignore-option prefixes", "--ignor --deselec omi ", "pytest.ini"],
    ["one line of script-key prefixes", '"test" ', "package.json"],
  ])("%s", (_name, unit, path) => {
    // A scaling check, not a wall-clock bound: the line is timed at 32 KiB and at 256 KiB (so the 8N input stays in CPU cache); the full 8 MiB line is read once, un-timed, below.
    const lineOf = (bytes: number) => unit.repeat(Math.ceil(bytes / unit.length));
    expectLinearScaling((bytes) => { const line = lineOf(bytes); return () => read(hunk(path, [line])); }, { n: 32_768, label: _name });
    const files = read(hunk(path, [lineOf(MIB8)]));
    expect(files).toHaveLength(1);
  });
});

describe("the risk reads the flags (medium at most, words only)", () => {
  const digest = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]).digest;
  const clean: VerificationReport = { reviewOnly: false, passed: [{ label: "Unit tests" }], failed: [], notChecked: [], testsAdded: [] };
  const riskOf = (files: RiskFile[], fix = false) => assessRisk({ changedFiles: files, changedFilesComplete: true, report: clean, acceptedFindings: [], securityFindings: 0, candidateDigest: digest, ...(fix ? { fix: true } : {}) });
  const f = (path: string, extra: Partial<RiskFile> = {}): RiskFile => ({ repository: "app", path, added: 2, removed: 1, ...extra });
  it("names instruction files, snapshots, fixtures, exclusions and CI scripts as medium, in a fix as well", () => {
    for (const fix of [false, true]) {
      const instruction = riskOf([f("AGENTS.md"), f(".rovara/rules/a.md")], fix);
      expect(instruction.level).toBe("medium");
      expect(instruction.reasons.join("\n")).toMatch(/Changes Rovara instruction files \(AGENTS\.md, \.rovara\/rules\/a\.md\)/u);
      expect(riskOf([f("src/__snapshots__/a.snap", { snapshotChanged: true })], fix).reasons.join("\n")).toMatch(/Changes snapshot files/u);
      expect(riskOf([f("tests/fixtures/a.json", { fixtureChanged: true })], fix).reasons.join("\n")).toMatch(/Changes test fixtures/u);
      expect(riskOf([f("src/a.py", { testsExcluded: true })], fix).reasons.join("\n")).toMatch(/Takes tests or code out of a test or coverage run/u);
    }
    expect(riskOf([f("package.json", { testCommandChanged: true })]).reasons.join("\n")).toMatch(/Changes the scripts that CI runs/u);
    // A fix has its own stronger words for the script, and the flag does not repeat them.
    expect(riskOf([f("package.json", { testCommandChanged: true })], true).reasons.join("\n")).not.toMatch(/Changes the scripts that CI runs/u);
  });
});

const DIGEST = "c".repeat(64);
const checkWith = (tests: Record<string, unknown>) => ({
  checkId: "readiness:0", kind: "test", label: "pytest", before: "passed", after: "passed", class: "passing", durationMs: 5,
  tests: { total: 4, passed: 3, failed: 0, skipped: 1, errored: 0, names: [], newTests: [], ...tests },
});
/** A pack as the broker keeps it (names already cut and checked by the builder). */
const packWith = (tests: Record<string, unknown>): EvidencePack => EvidencePackSchema.parse(rawPack(tests));
const rawPack = (tests: Record<string, unknown>) => ({
  schemaVersion: 1, candidateDigest: DIGEST, environment: { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] },
  checks: [checkWith(tests)], selection: { method: "full", selected: 4, total: 4 }, api: [], browser: [], notTested: [],
});

describe("the flags block", () => {
  const files = (...entries: Array<Partial<ChangedFileEntry> & { path: string }>): ChangedFileEntry[] => entries.map((entry) => ({ repository: "app", added: 1, removed: 1, ...entry }));
  it("says nothing when nothing is flagged, so a description without flags reads as it did", () => {
    expect(weakeningBlock(files({ path: "src/a.ts" }), packWith({}))).toEqual([]);
    expect(weakeningBlock([], undefined)).toEqual([]);
  });
  it("puts the instruction-file and CI-file flags first, then the weakened tests, one bullet each, as flags and not approvals", () => {
    const block = weakeningBlock(
      files({ path: "AGENTS.md" }, { path: "Makefile", testConfigChanged: true }, { path: "src/__snapshots__/a.snap", snapshotChanged: true }, { path: "tests/fixtures/a.json", fixtureChanged: true }),
      packWith({ skippedBefore: 1, skippedAfter: 4, skipped: 4, passed: 0, total: 4, absentOnNew: ["t.py::a", "t.py::b"], absentOnNewCount: 2 }),
    );
    expect(block).toEqual([
      WEAKENING_HEADING,
      "- Rovara instruction files changed (a flag, not an approval): AGENTS.md",
      "- Files that CI runs changed (a flag, not an approval): Makefile",
      "- 2 tests ran before and not now: t.py::a, t.py::b",
      "- 3 more tests skipped than before",
      "- Test config files changed: Makefile",
      "- Snapshot files changed: src/__snapshots__/a.snap",
      "- Fixture files changed: tests/fixtures/a.json",
      "",
    ]);
  });
});

// ---- Opus review of TE-B3 (2026-11-13)
describe("H1: only the old CI patterns make a change high; the rest is a flag", () => {
  const digest = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]).digest;
  const clean: VerificationReport = { reviewOnly: false, passed: [{ label: "Unit tests" }], failed: [], notChecked: [], testsAdded: [] };
  const riskOf = (files: RiskFile[], fix = false) => assessRisk({ changedFiles: files, changedFilesComplete: true, report: clean, acceptedFindings: [], securityFindings: 0, candidateDigest: digest, ...(fix ? { fix: true } : {}) });
  const f = (path: string, extra: Partial<RiskFile> = {}): RiskFile => ({ repository: "app", path, added: 2, removed: 1, ...extra });
  it.each(["src/setupTests.ts", "jest.setup.ts", ".coveragerc", "codecov.yml", "noxfile.py", ".rspec", "phpunit.xml", "vitest.config.e2e.ts"])("%s is not high, in an ordinary change or in a fix, and is still a file CI runs", (path) => {
    for (const fix of [false, true]) expect(riskOf([f(path)], fix).level, `${path} fix=${String(fix)}`).not.toBe("high");
    expect(isCiExecutedPath(path), path).toBe(true);
  });
  it.each(["Makefile", "pytest.ini", "tests/conftest.py", "vitest.config.ts", "jest.config.js", ".github/workflows/ci.yml"])("%s stays high, as before", (path) => {
    expect(riskOf([f(path)]).level, path).toBe("high");
    expect(isCiExecutedPath(path), path).toBe(true);
  });
  it("in a fix only the `test` script is a high test-command change; check, ci, coverage, verify and pretest are flags at medium at most", () => {
    expect(riskOf([f("package.json", { testCommandChanged: true })], true).level).toBe("high");
    for (const key of ["check", "ci", "coverage", "verify", "pretest"]) {
      const result = riskOf([f("package.json", { ciScriptChanged: true })], true);
      expect(result.level, key).not.toBe("high");
      expect(result.reasons.join("\n")).toMatch(/Changes the scripts that CI runs/u);
    }
    // End to end: the line in package.json decides which flag is set.
    const entry = (line: string) => parseChangedFiles(section(hunk("package.json", [line]))).files[0]!;
    expect(riskOf([entry('    "check": "tsc",')], true).level).not.toBe("high");
    expect(riskOf([entry('    "test": "echo",')], true).level).toBe("high");
  });
});

describe("M2: snapshots and fixtures are flagged when changed, not when added, and only where a test folder is above them", () => {
  const entry = (header: string[]) => parseChangedFiles(section(header)).files[0]!;
  const withMode = (path: string, mode: string): string[] => [`diff --git a/${path} b/${path}`, mode, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", "-a", "+b"];
  it("a new snapshot or fixture is not flagged; a modified, deleted or renamed one is", () => {
    expect(entry(withMode("tests/__snapshots__/a.snap", "new file mode 100644")).snapshotChanged).toBeUndefined();
    expect(entry(withMode("tests/fixtures/a.json", "new file mode 100644")).fixtureChanged).toBeUndefined();
    expect(entry(hunk("tests/__snapshots__/a.snap")).snapshotChanged).toBe(true);
    expect(entry(withMode("tests/fixtures/a.json", "deleted file mode 100644")).fixtureChanged).toBe(true);
    const renamed = entry(["diff --git a/tests/fixtures/a.json b/tests/data/a.json", "similarity index 90%", "rename from tests/fixtures/a.json", "rename to tests/data/a.json", "--- a/tests/fixtures/a.json", "+++ b/tests/data/a.json", "@@ -1 +1 @@", "-a", "+b"]);
    expect(renamed.fixtureChanged).toBe(true);
  });
  it.each([["app/fixtures/seed.json", false], ["docs/snapshots/release.md", false], ["assets/golden/logo.png", false], ["tests/fixtures/seed.json", true], ["tests/unit/fixtures/a/b.json", true], ["tests/snapshots/home.txt", true],
    ["src/test/resources/golden/out.txt", true], ["spec/golden/a.json", true], ["testdata/x.golden", true]])("%s -> flagged %s", (path, flagged) => {
    expect(isFixturePath(path) || isSnapshotPath(path), path).toBe(flagged);
  });
  it("the host's list marks an added file as added (a new snapshot from the host is not flagged either)", async () => {
    const { hostChangedFiles } = await import("../../packages/broker/src/core/build-step/changed-files.js");
    const file = (path: string, status: string) => ({ path, status, additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+x" });
    const host = { changedFiles: async () => ({ files: [file("tests/__snapshots__/new.snap", "added"), file("tests/__snapshots__/old.snap", "modified")] }) };
    const read = await hostChangedFiles(host as never, { repositoryId: "app", repositoryUrl: "https://github.com/o/r", number: 1, scope: { orgId: "o" } });
    expect(read.files.map((entry) => [entry.path, entry.snapshotChanged])).toEqual([["tests/__snapshots__/new.snap", undefined], ["tests/__snapshots__/old.snap", true]]);
  });
});

describe("L1: more instruction files", () => {
  it.each(["AGENTS.override.md", "sub/AGENTS.override.md", ".github/copilot-instructions.md"])("%s", (path) => expect(isInstructionFilePath(path)).toBe(true));
  it.each(["docs/copilot-instructions.md", ".github/copilot-instructions.txt", "AGENTS.override.md.bak"])("%s is not", (path) => expect(isInstructionFilePath(path)).toBe(false));
});

describe("M3: a proof that could not compare says so", () => {
  const proofOf = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, candidateDigest: DIGEST, status: "checked" as const, note: "completed" as const, changedTests: { added: 1, changed: 0, deleted: 0 }, items: [], durationMs: 1, ...over }) as never;
  const compared = { checkId: "readiness:0", skippedBefore: 0, skippedAfter: 0, absentOnNew: [], absentOnNewCount: 0 };
  it.each([
    [undefined, "the test proof did not run for this code"],
    [proofOf({ candidateDigest: "e".repeat(64) }), "the test proof did not run for this code"],
    [proofOf({ status: "no_changed_tests", note: "no_changed_tests" }), "no test was added or changed, so the original code was not run"],
    [proofOf({ status: "not_checked", note: "budget" }), "there was no time left to run the original code"],
    [proofOf({ status: "not_checked", note: "original_code_unavailable" }), "the original code could not be shown"],
    [proofOf({ status: "not_checked", note: "timed_out" }), "the run on the original code timed out"],
    [proofOf({ weakeningNotCompared: [{ checkId: "readiness:0", reason: "original_run_truncated" }] }), "the run on the original code looks cut short"],
    [proofOf({ weakeningNotCompared: [{ checkId: "readiness:0", reason: "no_report" }] }), "a test report was not available from both runs"],
    [proofOf(), "no test report to compare"],
  ])("says why: %#", (proof, words) => {
    expect(notComparedReason(proof, DIGEST)).toBe(words);
    expect(weakeningBlock([], undefined, { testProof: proof, candidateDigest: DIGEST })).toEqual([WEAKENING_HEADING, `- Test weakening: could not compare (${words})`, ""]);
  });
  it("the description shows the line when a proof or a plan with claims is in play, and nothing when neither is", () => {
    const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const wf = WorkflowSnapshotSchema.parse({
      ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-13T12:00:00.000Z", definitionVersion: "1.1.0" }), stage: "PULL_REQUEST", state: "READY", candidate,
      checkPolicy: { required: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/app", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
      verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-11-13T12:00:00.000Z", results: [{ checkId: "unit", status: "PASS" }] },
      reviews: (["CRITIC", "SECURITY"] as const).map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: "2026-11-13T12:00:00.000Z" })),
    });
    const lines = (proof: Record<string, unknown> | undefined) => rovaraStatusLines(wf, { changedFiles: { files: [], complete: true }, ...(proof === undefined ? {} : { proof }) }, () => []).join("\n");
    expect(lines(undefined)).not.toContain("Test weakening");
    expect(lines({ plan: undefined })).not.toContain("Test weakening");
    expect(lines({ testProof: { ...(proofOf({ weakening: [compared] }) as Record<string, unknown>), candidateDigest: candidate.digest } })).not.toContain("Test weakening");
    expect(lines({ testProof: { ...(proofOf({ status: "not_checked", note: "stopped" }) as Record<string, unknown>), candidateDigest: candidate.digest } })).toContain("- Test weakening: could not compare (the run was stopped)");
  });
});

// ---- re-check of TE-B3 (N1, N5, N6)
describe("N1: exclude options are read only where they mean a test or coverage run", () => {
  it.each([
    ["package.json", '    "install:prod": "npm ci --omit=dev",'], ["package.json", '    "prune": "npm prune --omit=dev",'], ["package.json", '    "pack": "tar --exclude=node_modules -czf a.tgz .",'],
    ["package.json", '    "docs": "typedoc --exclude **/*.test.ts",'], ["Makefile", "\trsync -a --exclude .git . out/"], ["setup.cfg", "pip install --omit x"],
    ["package.json", '    "lint": "eslint --ignore-pattern dist ."'], ["package.json", '    "format": "prettier --write . --ignore-path .gitignore"'], ["package.json", '    "lint": "eslint --ignore dist ."'],
    ["package.json", '    "audit": "npm audit --omit=dev"'], ["package.json", '    "build": "tsc",'],
  ])("%s: %s is not a flag", (path, line) => expect(flagsOf(path, [line]).testsExcluded).toBeUndefined());
  it.each([
    ["pyproject.toml", 'omit = ["a.py"]'], ["package.json", '    "test": "vitest --exclude src/a.test.ts"'], ["Makefile", "\tpytest --ignore tests/slow"], ["Makefile", "\tcoverage run --omit=a.py -m pytest"],
    ["package.json", '    "cov": "nyc --exclude src/a.js mocha"'], ["package.json", '    "test": "jest --ignore-glob=*.x"'], ["pytest.ini", "addopts = --deselect a::b"], ["jest.config.js", "  testPathIgnorePatterns: ['/x/'],"],
    ["package.json", '    "testPathIgnorePatterns": ["/legacy/"]'], [".coveragerc", "omit = a.py"],
  ])("%s: %s is a flag", (path, line) => expect(flagsOf(path, [line]).testsExcluded).toBe(true));
});

describe("N6: every path pattern is linear in the path", () => {
  it.each(["tests/", "a/", "tests/tests/", "test/a/", ".approved.", ".golden.", ".cassette.", "snapshots/", "fixtures/", "a.", "__snapshots__/"])("a hostile path of %s repeated stays fast", (unit) => {
    // Scaling checks, not wall-clock bounds: the path is timed at 2,000 and at 16,000 repeats (8N is at most 14 bytes a repeat, under 256 KiB).
    for (const tail of ["x", "snapshotz/x", "fixturez/x", ".snapz"]) {
      expectLinearScaling((times) => {
        const path = unit.repeat(times) + tail;
        return () => { isSnapshotPath(path); isFixturePath(path); isTestConfigPath(path); isInstructionFilePath(path); isCiExecutedPath(path); };
      }, { n: 2_000, unitBytes: unit.length, label: `${unit} repeated, then ${tail}` });
    }
  });
});

describe("N5: every check that was not compared is named, even when another was", () => {
  const proofOf = (over: Record<string, unknown>) => ({ schemaVersion: 1 as const, candidateDigest: DIGEST, status: "checked" as const, note: "completed" as const, changedTests: { added: 1, changed: 0, deleted: 0 }, durationMs: 1, ...over }) as never;
  const compared = { checkId: "readiness:0", skippedBefore: 0, skippedAfter: 0, absentOnNew: [], absentOnNewCount: 0 };
  it("names each such check, bounded, with the rest counted", () => {
    const many = Array.from({ length: 8 }, (_unused, n) => ({ checkId: `readiness:${String(n + 1)}`, reason: "no_report" }));
    const lines = weakeningBlock([], undefined, { testProof: proofOf({ weakening: [compared], weakeningNotCompared: many }), candidateDigest: DIGEST });
    expect(lines.filter((line) => line.startsWith("- Test weakening: could not compare"))).toHaveLength(6);
    expect(lines.at(-2)).toBe("- Test weakening: could not compare 3 more checks");
  });
});

describe("Round 2 M5: folded N4 and N8 classes", () => {
  it.each(["nyc.config.js", ".c8rc", ".c8rc.json", ".c8rc.yaml", "ava.config.js", "ava.config.cjs", "ava.config.mjs", "ava.config.ts", "jasmine.json"])("flags configuration %s through the reader", (path) => {
    expect(isTestConfigPath(path)).toBe(true);
    expect(flagsOf(path).testConfigChanged).toBe(true);
  });
  it.each([".cursorrules", "GEMINI.md", ".claude/settings.json", ".claude/commands/test.md", ".cursor/rules/check.mdc"])("flags instructions %s through risk", (path) => {
    expect(isInstructionFilePath(path)).toBe(true);
    expect(isInstructionFilePath(`packages/app/${path}`)).toBe(true);
    const risk = assessRisk({ changedFiles: read(hunk(path)), changedFilesComplete: true, report: { reviewOnly: false, passed: [], failed: [], notChecked: [], testsAdded: [] }, acceptedFindings: [], securityFindings: 0, candidateDigest: "d".repeat(64) });
    expect(risk.reasons.join("\n")).toContain("instruction files");
  });
  it.each(["cypress/fixtures/data.json", "testing/fixtures/data.json", "tests_data/fixtures/data.json", "src/test/resources/data.json"])("flags fixture %s through the reader", (path) => {
    expect(isFixturePath(path)).toBe(true);
    expect(flagsOf(path).fixtureChanged).toBe(true);
  });
  it.each(["cypress/snapshots/page.png", "tests/__golden__/answer.txt"])("flags snapshot %s through the reader", (path) => {
    expect(isSnapshotPath(path)).toBe(true);
    expect(flagsOf(path).snapshotChanged).toBe(true);
  });
  it.each(["src/resources/data.json", "docs/__golden__/a.txt", "assets/fixtures/a.json", ".cursor/cache/file", ".claude-cache/a", "nyc.config.js.bak", "ava.configuration.js"])("keeps ordinary path %s unflagged", (path) => {
    expect(isFixturePath(path) || isSnapshotPath(path) || isInstructionFilePath(path) || isTestConfigPath(path)).toBe(false);
  });
});
