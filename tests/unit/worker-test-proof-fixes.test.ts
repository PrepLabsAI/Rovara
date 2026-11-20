// TESTPROOF review round 1: stale report files, checks that are not tests, mixed repositories, the budget floor, the size of test-proof.json,
// and the kinds of file the overlay must keep (an executable, a symlink, a file turned into a directory and back).
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
import type { CheckPlan, CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { gitOriginalCode } from "../../packages/worker/src/verification/original-code.js";
import { runTestProof } from "../../packages/worker/src/verification/test-proof.js";
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
