// TE-B3 (O39): no test is weakened silently. Flags for a reviewer, words only: Rovara instruction files and files CI runs at the top of the description, tests that ran before and not now, more skips, changed snapshots,
// fixtures and test configuration. Each flag has a fixture, the path through the real reader / risk / pull request body, and the untrusted-text cases (names come from a repository).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EvidencePackSchema, type EvidencePack, type VerificationReport } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { parseChangedFiles } from "../../packages/broker/src/core/proof/changed-files.js";
import { assessRisk, isCiExecutedPath, type RiskFile } from "../../packages/broker/src/core/proof/risk.js";
import { WEAKENING_HEADING, notComparedReason, weakeningBlock, weakeningFactsOf } from "../../packages/broker/src/core/proof/weakening-flags.js";
import { isFixturePath, isInstructionFilePath, isSnapshotPath, isTestConfigPath } from "../../packages/broker/src/core/proof/weakening-paths.js";
import { rovaraStatusLines } from "../../packages/broker/src/core/proof/pull-request-body.js";
import type { ChangedFileEntry } from "../../packages/broker/src/core/proof/verification-report.js";

const ZWJ = "\u200d";
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
  it("is case-insensitive and reads a Windows path and a leading ./", () => {
    expect(isInstructionFilePath(".\\.Rovara\\Rules\\A.md")).toBe(true);
    expect(isSnapshotPath("./SRC/__Snapshots__/A.snap")).toBe(true);
  });
});

describe("the changed-files reader flags weakening", () => {
  it("flags a snapshot, a fixture, a test config and a renamed file under either name", () => {
    const files = read(hunk("src/__snapshots__/a.snap"), hunk("tests/fixtures/data.json"), hunk("pytest.ini", ["addopts = -q"]), ["diff --git a/old/__snapshots__/x.snap b/new/x.txt", "--- a/old/__snapshots__/x.snap", "+++ b/new/x.txt", "@@ -1 +1 @@", "-a", "+b"]);
    expect(files.map((file) => [file.path, file.snapshotChanged, file.fixtureChanged, file.testConfigChanged])).toEqual([
      ["src/__snapshots__/a.snap", true, undefined, undefined],
      ["tests/fixtures/data.json", undefined, true, undefined],
      ["pytest.ini", undefined, undefined, true],
      ["new/x.txt", true, undefined, undefined],
    ]);
  });
  it("flags a file Git does not track yet, from its path alone", () => {
    const text = ["## app", "", "### status", "?? AGENTS.md", "?? tests/__snapshots__/new.snap", "### diff"].join("\n");
    // A new snapshot adds an expectation, it does not change one: not flagged. (A new conftest.py is, below.)
    expect(parseChangedFiles(text).files.map((file) => [file.path, file.snapshotChanged])).toEqual([["AGENTS.md", undefined], ["tests/__snapshots__/new.snap", undefined]]);
    expect(parseChangedFiles(["## app", "", "### status", "?? tests/conftest.py", "### diff"].join("\n")).files[0]?.testConfigChanged).toBe(true);
  });
  it.each([
    ["pytest.skip in a test", "tests/test_a.py", "    pytest.skip('flaky')"], ["xfail", "tests/test_a.py", "@pytest.mark.xfail"], ["skipif", "tests/test_a.py", "@pytest.mark.skipif(True, reason='x')"],
    ["unittest.expectedFailure", "tests/test_a.py", "@unittest.expectedFailure"], ["t.Skipf", "tests/a_test.go", "t.Skipf(\"no\")"], ["it.skip", "src/a.test.ts", "it.skip('x', () => {})"],
    ["JUnit enabled=false", "src/test/java/ATest.java", "@Test(enabled = false)"], ["C# Ignore", "tests/ATests.cs", "[Ignore]"],
  ])("a test that is switched off: %s", (_name, path, line) => {
    expect(flagsOf(path, [line]).testsSkipped).toBe(true);
  });
  it("does not call a removed skip, or an ordinary test line, a skip", () => {
    expect(flagsOf("tests/test_a.py", ["def test_x(): pass"], ["@pytest.mark.skip"]).testsSkipped).toBeUndefined();
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
  it("reads a 1 MB line and a diff of 20,000 lines in linear time", () => {
    const started = Date.now();
    const long = `${"a ".repeat(500_000)}pragma: no cover`;
    expect(flagsOf("src/a.py", [long]).testsExcluded).toBe(true);
    const many = Array.from({ length: 20_000 }, (_unused, n) => `value_${String(n)} = "pending (it.skip"`);
    expect(flagsOf("tests/test_big.py", many).testsSkipped).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
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
    const line = unit.repeat(Math.ceil(MIB8 / unit.length));
    const started = Date.now();
    const files = read(hunk(path, [line]));
    expect(files).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it("many short lines and many files", () => {
    const started = Date.now();
    const diff = Array.from({ length: 20_000 }, (_unused, n) => hunk(`tests/__snapshots__/s${String(n)}.snap`)).flat();
    const files = parseChangedFiles(section(diff)).files;
    expect(files.length).toBe(200);
    expect(files.every((file) => file.snapshotChanged === true)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
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
  it("names the other files CI runs as CI configuration, as it always named the workflows", () => {
    for (const path of ["Makefile", "tests/conftest.py", "pytest.ini", "jest.config.ts"]) expect(riskOf([f(path)]).reasons.join("\n"), path).toMatch(/^Changes CI configuration/mu);
  });
  it("does not raise a plain change, and keeps a sensitive instruction path high without repeating it as a flag", () => {
    expect(riskOf([f("src/a.ts")]).level).toBe("low");
    const playbook = riskOf([f(".rovara/playbook.yaml")]);
    expect(playbook.level).toBe("high");
    expect(playbook.reasons.join("\n")).not.toMatch(/Changes Rovara instruction files/u);
  });
});

const DIGEST = "c".repeat(64);
const checkWith = (tests: Record<string, unknown>) => ({
  checkId: "readiness:0", kind: "test", label: "pytest", before: "passed", after: "passed", class: "passing", durationMs: 5,
  tests: { total: 4, passed: 3, failed: 0, skipped: 1, errored: 0, names: [], newTests: [], ...tests },
});
/** A pack as the broker keeps it (names already cut and checked by the builder). */
const packWith = (tests: Record<string, unknown>): EvidencePack => EvidencePackSchema.parse(rawPack(tests));
/** A pack that skipped the schema: what a reader would hold if it ever met a name the schema refuses. The words must hold on their own. */
const looseWith = (tests: Record<string, unknown>): EvidencePack => rawPack(tests) as unknown as EvidencePack;
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
  it("counts tests whose names were cut, and says 'and N more' past three", () => {
    const names = Array.from({ length: 5 }, (_unused, n) => `t.py::t${String(n)}`);
    expect(weakeningBlock([], packWith({ absentOnNew: names, absentOnNewCount: 120 }))[1]).toBe("- 120 tests ran before and not now: t.py::t0, t.py::t1, t.py::t2 and 117 more");
  });
  it("a package.json whose CI scripts changed is a flag for the files CI runs", () => {
    expect(weakeningBlock(files({ path: "package.json", testCommandChanged: true }), undefined)[1]).toBe("- Files that CI runs changed (a flag, not an approval): package.json");
  });
  it("sums the skip rise over the checks that gave both counts and never nets one check against another", () => {
    const facts = weakeningFactsOf([], EvidencePackSchema.parse({
      ...packWith({}), checks: [checkWith({ skippedBefore: 0, skippedAfter: 2, skipped: 2, passed: 2, total: 4 }), { ...checkWith({ skippedBefore: 5, skippedAfter: 1, skipped: 1, passed: 3, total: 4 }), checkId: "readiness:1" }],
    }));
    expect(facts.skipRise).toEqual({ before: 0, after: 2 });
  });
  it("makes a hostile name inert: no link, image, mention, issue reference, heading, quote, fence or hidden character", () => {
    const hostile = [
      "[click](https://evil.example)", "![pic](https://evil.example/x.png)", "![a[b]c](https://evil.example)", "[ref][1]\n\n[1]: https://evil.example", "@everyone ping", "Fixes #123", "owner/repo#45", "Fixes ENG-42", "<img src=x onerror=1>",
      "<!-- hidden", "# heading", "> quote", "---", "```js", "~~~", "a\u202eb\u200bc", `x\ufe0fy${String.fromCodePoint(0xe0100)}z`, "www.evil.example", "http://evil.example",
    ];
    const text = weakeningBlock(files(...hostile.map((path) => ({ path: `AGENTS.md/${path}` }))), looseWith({ absentOnNew: hostile, absentOnNewCount: hostile.length })).join("\n");
    expect(text).not.toMatch(/\]\(/u);
    expect(text).not.toMatch(/!\[/u);
    expect(text).not.toMatch(/<(?!&)/u);
    expect(text).not.toMatch(/(^|[^\u200d])@\w/u);
    expect(text).not.toMatch(/#\d/u);
    for (const hidden of ["\u202e", "\u200b", "\ufe0f", String.fromCodePoint(0xe0100)]) expect(text.includes(hidden), hidden).toBe(false);
    expect(text).not.toMatch(/(^|\n)(```|~~~|# |> |---)/u);
    expect(text).not.toMatch(/Fixes ENG-\d/u);
    // The bullets, the heading and the one blank line are the only structure.
    expect(text.split("\n").filter((line) => line !== "" && !line.startsWith("- ") && line !== WEAKENING_HEADING)).toEqual([]);
  });
  it("reads a 1 MB name quickly and prints a bounded line", () => {
    const started = Date.now();
    const huge = "AGENTS.md/" + "x".repeat(1_000_000);
    const block = weakeningBlock(files({ path: huge }), looseWith({ absentOnNew: [huge], absentOnNewCount: 1 }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(Math.max(...block.map((line) => line.length))).toBeLessThanOrEqual(310);
  });
  it("keeps a join between a number and a word: nothing prints NaN or Infinity for a count that is not a number", () => {
    const text = weakeningBlock([], packWith({ absentOnNew: ["a"], absentOnNewCount: 1 })).join("\n");
    expect(text).not.toMatch(/NaN|Infinity/u);
    void ZWJ;
  });
});

describe("the description carries the flags at the top of Rovara's block", () => {
  const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const workflow = () => WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-13T12:00:00.000Z", definitionVersion: "1.1.0" }),
    stage: "PULL_REQUEST", state: "READY", candidate,
    checkPolicy: { required: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/app", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-11-13T12:00:00.000Z", results: [{ checkId: "unit", status: "PASS" }] },
    reviews: (["CRITIC", "SECURITY"] as const).map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: "2026-11-13T12:00:00.000Z" })),
  });
  const lines = (changed: ChangedFileEntry[], extra: Record<string, unknown> = {}) => rovaraStatusLines(workflow(), { changedFiles: { files: changed, complete: true }, ...extra }, () => ["- no findings"]);
  it("shows the flags before 'What changed' when an instruction file and a snapshot changed", () => {
    const body = lines([{ repository: "app", path: "CLAUDE.md", added: 1, removed: 0 }, { repository: "app", path: "a/__snapshots__/x.snap", added: 1, removed: 1, snapshotChanged: true }]);
    expect(body[0]).toBe(WEAKENING_HEADING);
    expect(body.indexOf(WEAKENING_HEADING)).toBeLessThan(body.indexOf("## What changed"));
    expect(body.join("\n")).toContain("- Rovara instruction files changed (a flag, not an approval): CLAUDE.md");
    expect(body.join("\n")).toContain("- Snapshot files changed: a/__snapshots__/x.snap");
  });
  it("starts with 'What changed' exactly as before when nothing is flagged", () => {
    expect(lines([{ repository: "app", path: "src/a.ts", added: 1, removed: 0 }])[0]).toBe("## What changed");
  });
  it("shows the tests that ran before and not now from the pack, only when the pack is for this code", () => {
    const pack = packWith({ absentOnNew: ["t.py::gone"], absentOnNewCount: 1 });
    const proof = { evidence: { pack: { ...pack, candidateDigest: candidate.digest }, mode: "summary" as const } };
    expect(lines([], { proof }).join("\n")).toContain("- 1 test ran before and not now: t.py::gone");
    expect(lines([], { proof: { evidence: { pack, mode: "summary" as const } } }).join("\n")).not.toContain("ran before and not now");
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
  it("an option is an ignore option only when it ends there: --ignore-path, --ignore-scripts and --ignore-unknown are not", () => {
    for (const line of ["\teslint --ignore-path .gitignore .", "\tnpm ci --ignore-scripts", "\tprettier --ignore-unknown --check ."]) expect(flagsOf("Makefile", [line]).testsExcluded, line).toBeUndefined();
    for (const line of ["\tpytest --ignore tests/slow", "\tpytest --ignore=tests/slow", "\tvitest --exclude src/a", "\tpytest --deselect=a::b", "\tjest --ignore-glob=*.x"]) expect(flagsOf("Makefile", [line]).testsExcluded, line).toBe(true);
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
  it("is silent only when at least one check was compared", () => {
    expect(notComparedReason(proofOf({ weakening: [compared] }), DIGEST)).toBeUndefined();
    expect(weakeningBlock([], undefined, { testProof: proofOf({ weakening: [compared] }), candidateDigest: DIGEST })).toEqual([]);
  });
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
    for (const times of [2_000, 8_000, 16_000]) {
      const hostile = unit.repeat(times);
      for (const tail of ["x", "snapshotz/x", "fixturez/x", ".snapz"]) {
        const started = Date.now();
        isSnapshotPath(hostile + tail); isFixturePath(hostile + tail); isTestConfigPath(hostile + tail); isInstructionFilePath(hostile + tail); isCiExecutedPath(hostile + tail);
        expect(Date.now() - started, `${unit} x${String(times)} ${tail}`).toBeLessThan(200);
      }
    }
  });
  it("a test folder above is still what decides snapshots/, golden/ and fixtures/", () => {
    expect(isSnapshotPath("a/tests/b/c/snapshots/d")).toBe(true);
    expect(isSnapshotPath("a/b/snapshots/tests/d")).toBe(false);
    expect(isSnapshotPath("tests/snapshots")).toBe(false);
    expect(isFixturePath("tests/x/fixtures/y.json")).toBe(true);
    expect(isFixturePath("fixtures/tests/y.json")).toBe(false);
    expect(isSnapshotPath("a/Foo.verified.txt")).toBe(true);
    expect(isSnapshotPath("a/Foo.verified")).toBe(false);
  });
});

describe("N5: every check that was not compared is named, even when another was", () => {
  const proofOf = (over: Record<string, unknown>) => ({ schemaVersion: 1 as const, candidateDigest: DIGEST, status: "checked" as const, note: "completed" as const, changedTests: { added: 1, changed: 0, deleted: 0 }, durationMs: 1, ...over }) as never;
  const item = (checkId: string, label: string) => ({ checkId, label, granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" });
  const compared = { checkId: "readiness:0", skippedBefore: 0, skippedAfter: 0, absentOnNew: [], absentOnNewCount: 0 };
  it("a check that was not compared gets its own line, with its name, next to a check that was", () => {
    const proof = proofOf({ items: [item("readiness:0", "unit"), item("readiness:1", "integration")], weakening: [compared], weakeningNotCompared: [{ checkId: "readiness:1", reason: "original_run_truncated" }] });
    expect(weakeningBlock([], undefined, { testProof: proof, candidateDigest: DIGEST })).toEqual([WEAKENING_HEADING, "- Test weakening: could not compare integration (the run on the original code looks cut short)", ""]);
  });
  it("when no check was compared, each one is still named, not one reason for all", () => {
    const proof = proofOf({ items: [item("readiness:0", "unit"), item("readiness:1", "integration")], weakeningNotCompared: [{ checkId: "readiness:0", reason: "no_report" }, { checkId: "readiness:1", reason: "original_run_truncated" }] });
    expect(weakeningBlock([], undefined, { testProof: proof, candidateDigest: DIGEST })).toEqual([
      WEAKENING_HEADING, "- Test weakening: could not compare unit (a test report was not available from both runs)", "- Test weakening: could not compare integration (the run on the original code looks cut short)", "",
    ]);
  });
  it("names each such check, bounded, with the rest counted", () => {
    const many = Array.from({ length: 8 }, (_unused, n) => ({ checkId: `readiness:${String(n + 1)}`, reason: "no_report" }));
    const lines = weakeningBlock([], undefined, { testProof: proofOf({ weakening: [compared], weakeningNotCompared: many }), candidateDigest: DIGEST });
    expect(lines.filter((line) => line.startsWith("- Test weakening: could not compare"))).toHaveLength(6);
    expect(lines.at(-2)).toBe("- Test weakening: could not compare 3 more checks");
  });
  it("makes a check's name inert", () => {
    const proof = proofOf({ items: [item("readiness:1", "[x](https://evil.example) @everyone")], weakening: [compared], weakeningNotCompared: [{ checkId: "readiness:1", reason: "no_report" }] });
    const text = weakeningBlock([], undefined, { testProof: proof, candidateDigest: DIGEST }).join("\n");
    expect(text).not.toMatch(/\]\(|(^|[^\u200d])@\w/u);
  });
  it("nothing is said when every check was compared", () => {
    expect(weakeningBlock([], undefined, { testProof: proofOf({ weakening: [compared] }), candidateDigest: DIGEST })).toEqual([]);
  });
});
