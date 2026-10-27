// TESTPROOF review round 1: stale report files, checks that are not tests, mixed repositories, the budget floor, the size of test-proof.json,
// and the kinds of file the overlay must keep (an executable, a symlink, a file turned into a directory and back).
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestProofSchema, type CheckEntry, type ProjectCommand, type TestProof } from "../../packages/contracts/src/index.js";
import type { CheckPlan, CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { gitOriginalCode } from "../../packages/worker/src/verification/original-code.js";
import { runTestProof, serializeTestProof } from "../../packages/worker/src/verification/test-proof.js";
import { FAKE_TEST_COMMAND, fakeTestRunner, git, passedEntry, repositoryWithCandidate } from "../support/test-proof-fixture.js";

const SOURCE_1 = "export const value = 1;\n";
const SOURCE_2 = "export const value = 2;\n";
const TEST_EXPECTS = (n: number) => `import { value } from "./bug.js";\nexpect(value).toBe(${n});\n`;
const DIGEST = "d".repeat(64);
const REPORT_COMMAND: ProjectCommand = { ...FAKE_TEST_COMMAND, args: ["test", "--", "--reporter=json", "--outputFile=report.json"] };
const ALL_PASSED_REPORT = (directory: string) => JSON.stringify({ testResults: [{ name: join(directory, "src/bug.test.ts"), assertionResults: [{ fullName: "bug is fixed", status: "passed", failureMessages: [] }] }] });

describe("TESTPROOF review fixes", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  async function repository(start: Record<string, string>, candidate: Record<string, string | null>, prepare?: (directory: string) => Promise<void>) {
    const made = await repositoryWithCandidate(start, candidate, prepare);
    cleanup.push(made.directory);
    return made;
  }
  const planOf = (...commands: ProjectCommand[]): CheckPlan => ({ source: "project", readiness: commands, projectBefore: commands.map(() => "unknown" as const) });
  function options(made: Awaited<ReturnType<typeof repository>>, extra: Partial<Parameters<typeof runTestProof>[0]> = {}): Parameters<typeof runTestProof>[0] {
    return {
      plan: planOf(FAKE_TEST_COMMAND), newEntries: [passedEntry()] as CheckEntry[], runners: fakeTestRunner(made.directory),
      repositories: [{ repositoryId: "app", directory: made.directory, startCommit: made.startCommit, candidateTreeSha: made.candidateTreeSha }],
      candidateDigest: DIGEST, rootPath: made.directory, signal: new AbortController().signal, budgetMs: 600_000, ...extra,
    };
  }
  const fixed = { "src/bug.ts": SOURCE_2, "src/bug.test.ts": TEST_EXPECTS(2) };

  // 1
  it("never reads a stale report: an ignored report the old run did not write gives the check's own verdict, not does_not_prove", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1, ".gitignore": "report.json\n" }, fixed);
    await writeFile(join(made.directory, "report.json"), ALL_PASSED_REPORT(made.directory));
    const base = fakeTestRunner(made.directory);
    // The old run fails and, unlike the new one, writes no report.
    const proof = await runTestProof(options(made, { plan: planOf(REPORT_COMMAND), runners: base }));
    expect(proof.items).toEqual([expect.objectContaining({ granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" })]);
    // The candidate's report is back as the new run left it.
    expect(await readFile(join(made.directory, "report.json"), "utf8")).toBe(ALL_PASSED_REPORT(made.directory));
  });

  it("falls back to the check when a report says every test passed but the check failed", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1, ".gitignore": "report.json\n" }, fixed);
    await writeFile(join(made.directory, "report.json"), ALL_PASSED_REPORT(made.directory));
    const base = fakeTestRunner(made.directory);
    const runner: CheckRunners = { ...base, runProjectCommand: async (command, signal) => {
      const run = await base.runProjectCommand(command, signal);
      await writeFile(join(made.directory, "report.json"), ALL_PASSED_REPORT(made.directory).replace("bug is fixed", "bug is fixed ")); // different bytes, same verdicts
      return run;
    } };
    const proof = await runTestProof(options(made, { plan: planOf(REPORT_COMMAND), runners: runner }));
    expect(proof.items).toEqual([expect.objectContaining({ granularity: "check", verdict: "proves_change" })]);
  });

  it("falls back to the check when the old run left the very report the new run wrote", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1, ".gitignore": "report.json\n" }, fixed);
    await writeFile(join(made.directory, "report.json"), ALL_PASSED_REPORT(made.directory));
    const base = fakeTestRunner(made.directory);
    const runner: CheckRunners = { ...base, runProjectCommand: async (command, signal) => {
      const run = await base.runProjectCommand(command, signal);
      await writeFile(join(made.directory, "report.json"), ALL_PASSED_REPORT(made.directory));
      return run;
    } };
    const proof = await runTestProof(options(made, { plan: planOf(REPORT_COMMAND), runners: runner }));
    expect(proof.items).toEqual([expect.objectContaining({ granularity: "check", verdict: "proves_change" })]);
  });

  // 6
  it("puts an ignored report file back as the new run left it, and never writes through a symlink that leaves the workspace", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1, ".gitignore": "report.json\nlink.json\n" }, fixed);
    const newReport = ALL_PASSED_REPORT(made.directory);
    await writeFile(join(made.directory, "report.json"), newReport);
    const base = fakeTestRunner(made.directory);
    const overwriting: CheckRunners = { ...base, runProjectCommand: async (command, signal) => {
      const run = await base.runProjectCommand(command, signal);
      await writeFile(join(made.directory, "report.json"), JSON.stringify({ testResults: [] }));
      return run;
    } };
    await runTestProof(options(made, { plan: planOf(REPORT_COMMAND), runners: overwriting }));
    expect(await readFile(join(made.directory, "report.json"), "utf8")).toBe(newReport);

    const outside = join(realpathSync(mkdtempSync(join(tmpdir(), "agentx-outside-"))), "elsewhere.json");
    cleanup.push(join(outside, ".."));
    await writeFile(outside, newReport);
    await symlink(outside, join(made.directory, "link.json"));
    const viaLink: ProjectCommand = { ...FAKE_TEST_COMMAND, args: ["test", "--", "--reporter=json", "--outputFile=link.json"] };
    // The old run (the failing one) writes its own report through the link; AgentX must neither read it as a report nor write the new text back through it.
    const writer: CheckRunners = { ...base, runProjectCommand: async (command, signal) => {
      const run = await base.runProjectCommand(command, signal);
      if (run.exitCode !== 0) await writeFile(join(made.directory, "link.json"), "written by the old run\n");
      return run;
    } };
    const proof = await runTestProof(options(made, { plan: planOf(viaLink), runners: writer }));
    expect(proof.items).toEqual([expect.objectContaining({ granularity: "check", verdict: "proves_change" })]);
    expect(await readFile(outside, "utf8")).toBe("written by the old run\n");
    expect((await lstat(join(made.directory, "link.json"))).isSymbolicLink()).toBe(true);
  });

  // 2
  it("gives no verdict to a check that is not a test runner, and does not run it on the original code", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, fixed);
    const lint: ProjectCommand = { cwd: ".", executable: "npm", args: ["run", "lint"], timeoutSeconds: 60 };
    const calls: ProjectCommand[] = [];
    const proof = await runTestProof(options(made, {
      plan: planOf(FAKE_TEST_COMMAND, lint), runners: fakeTestRunner(made.directory, calls),
      newEntries: [passedEntry(), { ...passedEntry("readiness:1", "npm run lint"), output: "lint clean" }],
    }));
    expect(calls).toHaveLength(1);
    expect(proof.items).toHaveLength(2);
    expect(proof.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: "readiness:1", verdict: "not_applicable", reason: "not_a_test_check" }),
      expect.objectContaining({ checkId: "readiness:0", verdict: "proves_change" }),
    ]));
  });

  it("treats a check whose output names a changed test file as a test check", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, fixed);
    const custom: ProjectCommand = { cwd: ".", executable: "./scripts/verify.sh", args: [], timeoutSeconds: 60 };
    const calls: ProjectCommand[] = [];
    const proof = await runTestProof(options(made, {
      plan: planOf(custom), runners: fakeTestRunner(made.directory, calls),
      newEntries: [{ ...passedEntry("readiness:0", "verify"), output: "ran src/bug.test.ts ok" }],
    }));
    expect(calls).toHaveLength(1);
    expect(proof.items).toEqual([expect.objectContaining({ verdict: "proves_change" })]);
  });

  // 4
  it("runs nothing when any repository has no usable start commit", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, fixed);
    const calls: ProjectCommand[] = [];
    const proof = await runTestProof(options(made, {
      runners: fakeTestRunner(made.directory, calls),
      repositories: [
        { repositoryId: "app", directory: made.directory, startCommit: made.startCommit, candidateTreeSha: made.candidateTreeSha },
        { repositoryId: "other", directory: made.directory, startCommit: "main", candidateTreeSha: made.candidateTreeSha },
      ],
    }));
    expect(calls).toEqual([]);
    expect(proof).toMatchObject({ status: "not_checked", note: "original_code_unavailable" });
  });

  // 11
  it("does not start the run with less than a minute of budget left", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, fixed);
    const calls: ProjectCommand[] = [];
    const proof = await runTestProof(options(made, { runners: fakeTestRunner(made.directory, calls), budgetMs: 59_000 }));
    expect(calls).toEqual([]);
    expect(proof).toMatchObject({ status: "not_checked", note: "budget" });
    expect(proof.items).toEqual([expect.objectContaining({ verdict: "not_checked", reason: "budget" })]);
  });

  // 8
  it("keeps one summary item per check instead of dropping them when there are more than 200 tests", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1, ".gitignore": "report.json\n" }, fixed);
    const tests = (status: string) => Array.from({ length: 250 }, (_, index) => ({ fullName: `t${index}`, status, failureMessages: status === "failed" ? ["AssertionError: expected 1 to be 2"] : [] }));
    const report = (status: string) => JSON.stringify({ testResults: [{ name: join(made.directory, "src/bug.test.ts"), assertionResults: tests(status) }] });
    await writeFile(join(made.directory, "report.json"), report("passed"));
    const base = fakeTestRunner(made.directory);
    const runner: CheckRunners = { ...base, runProjectCommand: async (command, signal) => {
      const run = await base.runProjectCommand(command, signal);
      await writeFile(join(made.directory, "report.json"), report(run.exitCode === 0 ? "passed" : "failed"));
      return run;
    } };
    const proof = await runTestProof(options(made, { plan: planOf(REPORT_COMMAND), runners: runner }));
    expect(proof.items).toEqual([expect.objectContaining({ checkId: "readiness:0", granularity: "check", verdict: "proves_change" })]);
  });

  // 9
  it("keeps test-proof.json under the broker's 256 KiB read limit with 200 items with long labels, and it still parses", () => {
    const item = (index: number): TestProof["items"][number] => ({
      checkId: `readiness:${index % 64}`, label: "x".repeat(1_024), granularity: "test", test: "y".repeat(300), verdict: "proves_change", reason: "assertion_failed_on_old",
    });
    const proof: TestProof = { schemaVersion: 1, candidateDigest: DIGEST, status: "checked", note: "completed", changedTests: { added: 200, changed: 0, deleted: 0 }, items: Array.from({ length: 200 }, (_, index) => item(index)), durationMs: 5 };
    expect(JSON.stringify(proof).length).toBeGreaterThan(256 * 1024);
    const text = serializeTestProof(proof);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200 * 1024);
    const parsed = TestProofSchema.parse(JSON.parse(text));
    expect(parsed.candidateDigest).toBe(DIGEST);
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items.every((entry) => entry.verdict === "proves_change")).toBe(true);
  });

  // 12
  it("keeps an executable and a symlink in the overlay, and restores them", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, { ...fixed, "src/run.test.sh": "#!/bin/sh\nexit 0\n" }, async (directory) => {
      await chmod(join(directory, "src/run.test.sh"), 0o755);
      await symlink("bug.test.ts", join(directory, "src/link.test.ts"));
    });
    const seen = await gitOriginalCode([{ directory: made.directory, commit: made.startCommit, overlay: ["src/run.test.sh", "src/link.test.ts", "src/bug.test.ts"] }]).run(async () => ({
      mode: (await lstat(join(made.directory, "src/run.test.sh"))).mode & 0o111,
      link: await readlink(join(made.directory, "src/link.test.ts")),
    }));
    expect(seen.mode).not.toBe(0);
    expect(seen.link).toBe("bug.test.ts");
    expect((await lstat(join(made.directory, "src/run.test.sh"))).mode & 0o111).not.toBe(0);
    expect((await lstat(join(made.directory, "src/link.test.ts"))).isSymbolicLink()).toBe(true);
    expect(git(made.directory, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("handles a test file the candidate replaced by a directory, and a test directory it replaced by a file", async () => {
    const made = await repository(
      { "src/bug.ts": SOURCE_1, "src/a.test.ts": "was a file\n", "src/b.test.ts/inner.test.ts": "was a directory\n" },
      { ...fixed, "src/a.test.ts": null, "src/b.test.ts/inner.test.ts": null },
      async (directory) => {
        await mkdir(join(directory, "src/a.test.ts"), { recursive: true });
        await writeFile(join(directory, "src/a.test.ts/inner.test.ts"), "now a directory\n");
        await rm(join(directory, "src/b.test.ts"), { recursive: true, force: true });
        await writeFile(join(directory, "src/b.test.ts"), "now a file\n");
      });
    const overlay = ["src/a.test.ts", "src/a.test.ts/inner.test.ts", "src/b.test.ts", "src/b.test.ts/inner.test.ts", "src/bug.test.ts"];
    const seen = await gitOriginalCode([{ directory: made.directory, commit: made.startCommit, overlay }]).run(async () => ({
      a: await readFile(join(made.directory, "src/a.test.ts/inner.test.ts"), "utf8"),
      b: await readFile(join(made.directory, "src/b.test.ts"), "utf8"),
    }));
    expect(seen).toEqual({ a: "now a directory\n", b: "now a file\n" });
    expect(git(made.directory, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(await readFile(join(made.directory, "src/a.test.ts/inner.test.ts"), "utf8")).toBe("now a directory\n");
  });

  it("shows the original code in every repository at once, and restores them all", async () => {
    const first = await repository({ "src/bug.ts": SOURCE_1 }, fixed);
    const second = await repository({ "src/bug.ts": SOURCE_1 }, fixed);
    const base = fakeTestRunner(first.directory);
    const seen: string[][] = [];
    const runner: CheckRunners = { ...base, runProjectCommand: async (command, signal) => {
      seen.push([await readFile(join(first.directory, "src/bug.ts"), "utf8"), await readFile(join(second.directory, "src/bug.ts"), "utf8"), await readFile(join(second.directory, "src/bug.test.ts"), "utf8")]);
      return base.runProjectCommand(command, signal);
    } };
    const proof = await runTestProof(options(first, { runners: runner, repositories: [
      { repositoryId: "one", directory: first.directory, startCommit: first.startCommit, candidateTreeSha: first.candidateTreeSha },
      { repositoryId: "two", directory: second.directory, startCommit: second.startCommit, candidateTreeSha: second.candidateTreeSha },
    ] }));
    expect(seen.at(-1)).toEqual([SOURCE_1, SOURCE_1, TEST_EXPECTS(2)]);
    expect(proof.changedTests.added).toBe(2);
    expect(await readFile(join(first.directory, "src/bug.ts"), "utf8")).toBe(SOURCE_2);
    expect(await readFile(join(second.directory, "src/bug.ts"), "utf8")).toBe(SOURCE_2);
    expect(git(second.directory, "status", "--porcelain")).toBe("");
  });

  // review round 2
  it("shows the original code in a repository with no changed test too, so old and new code are never mixed", async () => {
    const withTest = await repository({ "src/bug.ts": SOURCE_1 }, { "src/bug.test.ts": 'import { value } from "./bug.js";\nexpect(value).toBe(2);\n' });
    const otherRepo = await repository({ "src/bug.ts": SOURCE_1 }, { "src/bug.ts": SOURCE_2 });
    // The new test (repository one) passes only with the change made in repository two.
    const runner: CheckRunners = { ...fakeTestRunner(withTest.directory), runProjectCommand: async () => {
      const value = (await readFile(join(otherRepo.directory, "src/bug.ts"), "utf8")).includes("= 2") ? 2 : 1;
      return value === 2 ? { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" } : { exitCode: 1, timedOut: false, stdout: "AssertionError: expected 1 to be 2", stderr: "" };
    } };
    const proof = await runTestProof(options(withTest, { runners: runner, repositories: [
      { repositoryId: "one", directory: withTest.directory, startCommit: withTest.startCommit, candidateTreeSha: withTest.candidateTreeSha },
      { repositoryId: "two", directory: otherRepo.directory, startCommit: otherRepo.startCommit, candidateTreeSha: otherRepo.candidateTreeSha },
    ] }));
    expect(proof.items).toEqual([expect.objectContaining({ verdict: "proves_change" })]);
    expect(await readFile(join(otherRepo.directory, "src/bug.ts"), "utf8")).toBe(SOURCE_2);
  });

  it("does not take a lint check for a test check because its output names a changed test file's basename", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, fixed);
    const lint: ProjectCommand = { cwd: ".", executable: "npm", args: ["run", "lint"], timeoutSeconds: 60 };
    const calls: ProjectCommand[] = [];
    const proof = await runTestProof(options(made, {
      plan: planOf(lint), runners: fakeTestRunner(made.directory, calls),
      newEntries: [{ ...passedEntry("readiness:0", "npm run lint"), output: "lint: ignoring bug.test.ts" }],
    }));
    expect(calls).toEqual([]);
    expect(proof.items).toEqual([expect.objectContaining({ verdict: "not_applicable" })]);
  });
});
