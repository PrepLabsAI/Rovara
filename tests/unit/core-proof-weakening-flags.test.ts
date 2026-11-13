// TE-B3 (O39): no test is weakened silently. Flags for a reviewer, words only: Rovara instruction files and files CI runs at the top of the description, tests that ran before and not now, more skips, changed snapshots,
// fixtures and test configuration. Each flag has a fixture, the path through the real reader / risk / pull request body, and the untrusted-text cases (names come from a repository).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EvidencePackSchema, type EvidencePack, type VerificationReport } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { parseChangedFiles } from "../../packages/broker/src/core/proof/changed-files.js";
import { assessRisk, type RiskFile } from "../../packages/broker/src/core/proof/risk.js";
import { WEAKENING_HEADING, weakeningBlock, weakeningFactsOf } from "../../packages/broker/src/core/proof/weakening-flags.js";
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
    expect(parseChangedFiles(text).files.map((file) => [file.path, file.snapshotChanged])).toEqual([["AGENTS.md", undefined], ["tests/__snapshots__/new.snap", true]]);
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
    for (const script of ['"test": "vitest"', '"pretest": "x"', '"test:unit": "x"', '"ci": "x"', '"coverage": "x"', '"verify": "x"', '"check": "x"']) expect(flagsOf("package.json", [`    ${script},`]).testCommandChanged, script).toBe(true);
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
    for (const path of ["Makefile", "tests/conftest.py", "pytest.ini", ".coveragerc", "jest.config.ts"]) expect(riskOf([f(path)]).reasons.join("\n"), path).toMatch(/^Changes CI configuration/mu);
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
