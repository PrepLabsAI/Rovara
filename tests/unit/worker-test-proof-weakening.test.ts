// TE-B3: the run on the original code is also the "before" of the tests the change did NOT touch. Real git repositories; the "test runner" writes a JSON report whose tests depend on a settings file the candidate changed
// (a non-test file, so the original code's run sees the old settings), which is how a change makes tests skip or vanish without touching a test file.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestProofSchema, TestProofWriteSchema, type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
import type { CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { runTestProof, serializeTestProof } from "../../packages/worker/src/verification/test-proof.js";
import { FAKE_TEST_COMMAND, fakeTestRunner, passedEntry, repositoryWithCandidate } from "../support/test-proof-fixture.js";

const DIGEST = "e".repeat(64);
const COMMAND: ProjectCommand = { ...FAKE_TEST_COMMAND, args: ["test", "--", "--reporter=json", "--outputFile=report.json"] };
const OLD_TESTS = "an old test file\n";

/** What the settings say the suite runs: `all` runs a, b and c; `weak` skips b and drops c. Tests of src/bug.test.ts come from the fake runner. */
const REPORTS: Record<string, Array<[string, "passed" | "skipped"]>> = {
  all: [["a", "passed"], ["b", "passed"], ["c", "passed"]],
  weak: [["a", "passed"], ["b", "skipped"]],
  nothing: [],
};

function runnerOver(directory: string, options: { writeReport?: boolean; outcome?: (mode: string) => { exitCode: number | null; timedOut: boolean } } = {}): CheckRunners {
  const base = fakeTestRunner(directory);
  return {
    ...base,
    runProjectCommand: async (given, signal) => {
      const run = await base.runProjectCommand(given, signal);
      const mode = (await readFile(join(directory, "settings.txt"), "utf8")).trim();
      const forced = options.outcome?.(mode);
      if (options.writeReport !== false) {
        const results = [
          { name: join(directory, "src/bug.test.ts"), assertionResults: [{ fullName: "bug is fixed", status: run.exitCode === 0 ? "passed" : "failed", failureMessages: [run.stdout] }] },
          { name: join(directory, "src/old.test.ts"), assertionResults: (REPORTS[mode] ?? []).map(([name, status]) => ({ fullName: name, status, failureMessages: [] })) },
        ];
        await writeFile(join(directory, "report.json"), JSON.stringify({ testResults: results }));
      }
      return forced === undefined ? run : { ...run, ...forced, stdout: run.stdout, stderr: "" };
    },
  };
}

describe("TE-B3 weakening facts from the run on the original code", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  async function repository(candidateMode: string) {
    const made = await repositoryWithCandidate(
      { "src/bug.ts": "export const value = 1;\n", "src/old.test.ts": OLD_TESTS, "settings.txt": "all\n" },
      { "src/bug.ts": "export const value = 2;\n", "src/bug.test.ts": 'import { value } from "./bug.js";\nexpect(value).toBe(2);\n', "settings.txt": `${candidateMode}\n` });
    cleanup.push(made.directory);
    return made;
  }
  /** The candidate's own run of the check (it wrote its report before the proof starts). */
  const prime = (_made: Awaited<ReturnType<typeof repository>>, runners: CheckRunners) => runners.runProjectCommand(COMMAND, new AbortController().signal);
  const optionsFor = (made: Awaited<ReturnType<typeof repository>>, runners: CheckRunners, newEntries: CheckEntry[] = [passedEntry()]) => ({
    plan: { source: "project" as const, readiness: [COMMAND], projectBefore: ["unknown" as const] }, newEntries, runners,
    repositories: [{ repositoryId: "app", directory: made.directory, startCommit: made.startCommit, candidateTreeSha: made.candidateTreeSha }],
    candidateDigest: DIGEST, rootPath: made.directory, signal: new AbortController().signal, budgetMs: 60_000,
  });

  it("says how many untouched tests were skipped before and now, and names the tests that ran before and are gone", async () => {
    const made = await repository("weak");
    const runner = runnerOver(made.directory);
    await prime(made, runner);
    const proof = await runTestProof(optionsFor(made, runner));
    expect(TestProofWriteSchema.parse(proof).weakening).toEqual([{ checkId: "readiness:0", skippedBefore: 0, skippedAfter: 1, absentOnNew: ["src/old.test.ts::c"], absentOnNewCount: 1 }]);
    // The candidate is back as it was.
    expect((await readFile(join(made.directory, "settings.txt"), "utf8")).trim()).toBe("weak");
  });

  it("says nothing is missing and nothing more is skipped when the suites are the same", async () => {
    const made = await repository("all");
    const runner = runnerOver(made.directory);
    await prime(made, runner);
    const proof = await runTestProof(optionsFor(made, runner));
    expect(proof.weakening).toEqual([{ checkId: "readiness:0", skippedBefore: 0, skippedAfter: 0, absentOnNew: [], absentOnNewCount: 0 }]);
  });

  it("does not count a test that the original code's run did not reach: a run that timed out leaves a partial report", async () => {
    const made = await repository("weak");
    const partial = runnerOver(made.directory, { outcome: (mode) => (mode === "all" ? { exitCode: null, timedOut: true } : { exitCode: 0, timedOut: false }) });
    await prime(made, partial);
    vi.useFakeTimers({ toFake: ["Date"] });
    const proof = await runTestProof({ ...optionsFor(made, partial), budgetMs: 10 * 60_000 });
    expect(proof.weakening).toBeUndefined();
    expect(proof.weakeningNotCompared).toEqual([{ checkId: "readiness:0", reason: "original_run_incomplete" }]);
  });

  it("makes no claim without a report of its own from the original code's run, or from this code's run", async () => {
    const made = await repository("weak");
    // The original code's run wrote no report (the proof removes the candidate's before that run, so a stale one is never read as its result).
    const stale = runnerOver(made.directory, { writeReport: false });
    await writeFile(join(made.directory, "report.json"), JSON.stringify({ testResults: [{ name: join(made.directory, "src/old.test.ts"), assertionResults: [{ fullName: "a", status: "passed", failureMessages: [] }] }] }));
    const none = await runTestProof(optionsFor(made, stale));
    expect(none.weakening).toBeUndefined();
    expect(none.weakeningNotCompared).toEqual([{ checkId: "readiness:0", reason: "no_report" }]);
  });

  // L3: the original code's run wrote a report, but the very bytes this code's run wrote (it did not write one of its own): that says nothing about the original code.
  it("makes no claim from a report whose bytes are the candidate's own (the same-bytes guard)", async () => {
    const made = await repository("weak");
    const constant: CheckRunners = {
      ...fakeTestRunner(made.directory),
      runProjectCommand: async () => {
        await writeFile(join(made.directory, "report.json"), JSON.stringify({ testResults: [{ name: join(made.directory, "src/old.test.ts"), assertionResults: [{ fullName: "a", status: "passed", failureMessages: [] }, { fullName: "gone", status: "passed", failureMessages: [] }] }] }));
        return { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" };
      },
    };
    await prime(made, constant);
    // A runner that ignores the settings gives the same report on both runs: nothing differs, so nothing is claimed, and the check is said not to be compared.
    const proof = await runTestProof(optionsFor(made, constant));
    expect(proof.weakening).toBeUndefined();
    expect(proof.weakeningNotCompared).toEqual([{ checkId: "readiness:0", reason: "no_report" }]);
  });

  it("names every absent test in the count, keeps at most 100 names, and the saved proof stays under its size limit", async () => {
    const made = await repository("nothing");
    // The original code's run reports 300 tests; this code's run reports none of them.
    const many: CheckRunners = {
      ...fakeTestRunner(made.directory),
      runProjectCommand: async () => {
        const mode = (await readFile(join(made.directory, "settings.txt"), "utf8")).trim();
        const results = mode === "nothing" ? [] : [{ name: join(made.directory, "src/old.test.ts"), assertionResults: Array.from({ length: 300 }, (_unused, n) => ({ fullName: `t${String(n)} ${"x".repeat(400)}`, status: "passed", failureMessages: [] })) }];
        await writeFile(join(made.directory, "report.json"), JSON.stringify({ testResults: [{ name: join(made.directory, "src/bug.test.ts"), assertionResults: [{ fullName: "bug is fixed", status: "passed", failureMessages: [] }] }, ...results] }));
        return { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" };
      },
    };
    // The report of this code's run is on disk before the proof starts (the evidence step's own run wrote it); the proof reads it first.
    await many.runProjectCommand(COMMAND, new AbortController().signal);
    const proof = await runTestProof(optionsFor(made, many));
    const item = proof.weakening?.[0];
    expect(item?.absentOnNewCount).toBe(300);
    expect(item?.absentOnNew).toHaveLength(100);
    expect(Buffer.byteLength(serializeTestProof(proof))).toBeLessThanOrEqual(200 * 1024);
    expect(TestProofSchema.safeParse(JSON.parse(serializeTestProof(proof))).success).toBe(true);
  });

  // ---- H2: the usual test-first case must not produce a claim
  const check = async (made: Awaited<ReturnType<typeof repository>>, runners: CheckRunners, command: ProjectCommand = COMMAND) => {
    await runners.runProjectCommand(command, new AbortController().signal);
    return runTestProof({ ...optionsFor(made, runners), plan: { source: "project" as const, readiness: [command], projectBefore: ["unknown" as const] } });
  };

  it("pytest-style: the new test file fails to collect on the original code and nothing runs there: no skip rise, no absent test, and the check is said not to be compared", async () => {
    const made = await repository("all");
    // This code's run: the old tests (two skipped) and the new ones. The original code's run (the source file still has `= 1`): only the collection error of the new test file, as pytest aborts the whole run.
    const base = fakeTestRunner(made.directory);
    const collecting: CheckRunners = { ...base, runProjectCommand: async (given, signal) => {
      const source = await readFile(join(made.directory, "src/bug.ts"), "utf8");
      const run = await base.runProjectCommand(given, signal);
      const results = source.includes("= 1;")
        ? [{ name: join(made.directory, "src/bug.test.ts"), status: "failed", message: "ERROR collecting", assertionResults: [] }]
        : [
          { name: join(made.directory, "src/bug.test.ts"), assertionResults: [{ fullName: "bug is fixed", status: "passed", failureMessages: [] }] },
          { name: join(made.directory, "src/old.test.ts"), assertionResults: [{ fullName: "a", status: "passed" }, { fullName: "b", status: "skipped" }, { fullName: "c", status: "skipped" }].map((entry) => ({ ...entry, failureMessages: [] })) },
        ];
      await writeFile(join(made.directory, "report.json"), JSON.stringify({ testResults: results }));
      return run;
    } };
    const proof = await check(made, collecting);
    expect(proof.weakening).toBeUndefined();
    expect(proof.weakeningNotCompared).toEqual([{ checkId: "readiness:0", reason: "original_run_truncated" }]);
  });

  it("jest-style: the new test file fails to load on the original code and the rest ran: the error entry is not a test that went missing, and the change's own tests are not compared", async () => {
    const made = await repository("all");
    const runners = fakeTestRunner(made.directory);
    const mixed: CheckRunners = { ...runners, runProjectCommand: async (given, signal) => {
      const source = await readFile(join(made.directory, "src/bug.ts"), "utf8");
      const run = await runners.runProjectCommand(given, signal);
      const suites = [{ name: join(made.directory, "src/old.test.ts"), assertionResults: ["a", "b", "c"].map((fullName) => ({ fullName, status: "passed", failureMessages: [] })) }];
      const bug = source.includes("= 1;")
        ? [{ name: join(made.directory, "src/bug.test.ts"), status: "failed", message: "Test suite failed to run", assertionResults: [] }]
        // A test of the change's own file that the original run had under another name is not "missing" either.
        : [{ name: join(made.directory, "src/bug.test.ts"), assertionResults: [{ fullName: "renamed", status: "passed", failureMessages: [] }] }];
      await writeFile(join(made.directory, "report.json"), JSON.stringify({ testResults: [...suites, ...bug] }));
      return run;
    } };
    const proof = await check(made, mixed);
    expect(proof.weakening).toEqual([{ checkId: "readiness:0", skippedBefore: 0, skippedAfter: 0, absentOnNew: [], absentOnNewCount: 0 }]);
  });

  it("a changed test file's old test that is not in this code's report is not 'missing' (the original run shows the change's own files)", async () => {
    const made = await repository("all");
    const runners = fakeTestRunner(made.directory);
    const proof = await check(made, { ...runners, runProjectCommand: async (given, signal) => {
      const source = await readFile(join(made.directory, "src/bug.ts"), "utf8");
      const run = await runners.runProjectCommand(given, signal);
      const bug = [{ name: join(made.directory, "src/bug.test.ts"), assertionResults: [{ fullName: source.includes("= 1;") ? "old name" : "new name", status: "passed", failureMessages: [] }] }];
      await writeFile(join(made.directory, "report.json"), JSON.stringify({ testResults: [{ name: join(made.directory, "src/old.test.ts"), assertionResults: ["a", "b", "c"].map((fullName) => ({ fullName, status: "passed", failureMessages: [] })) }, ...bug] }));
      return run;
    } });
    expect(proof.weakening?.[0]).toMatchObject({ absentOnNew: [], absentOnNewCount: 0 });
  });

  it.each(["-x", "--exitfirst", "--maxfail=1", "--bail", "-xvs"])("a command with %s stops at its first failure: no skip rise and no missing test is claimed from its original run", async (flag) => {
    const made = await repository("weak");
    const command: ProjectCommand = { ...COMMAND, args: [...COMMAND.args, flag] };
    // The original run (settings "all") would show tests the candidate's does not, and a skip count that differs; with a stop-at-first-failure option that is only where the run stopped.
    const runners = runnerOver(made.directory);
    const proof = await check(made, runners, command);
    expect(proof.weakening).toBeUndefined();
    expect(proof.weakeningNotCompared).toEqual([{ checkId: "readiness:0", reason: "original_run_truncated" }]);
  });

  it("an original run with far fewer untouched tests than this code's run is not compared", async () => {
    const made = await repository("all");
    const runners = fakeTestRunner(made.directory);
    const few: CheckRunners = { ...runners, runProjectCommand: async (given, signal) => {
      const source = await readFile(join(made.directory, "src/bug.ts"), "utf8");
      const run = await runners.runProjectCommand(given, signal);
      const names = source.includes("= 1;") ? ["a"] : Array.from({ length: 20 }, (_unused, n) => `t${String(n)}`);
      await writeFile(join(made.directory, "report.json"), JSON.stringify({ testResults: [{ name: join(made.directory, "src/old.test.ts"), assertionResults: names.map((fullName) => ({ fullName, status: "passed", failureMessages: [] })) }] }));
      return run;
    } };
    const proof = await check(made, few);
    expect(proof.weakeningNotCompared).toEqual([{ checkId: "readiness:0", reason: "original_run_truncated" }]);
  });
});
