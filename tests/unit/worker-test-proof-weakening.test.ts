// TE-B3: the run on the original code is also the "before" of the tests the change did NOT touch. Real git repositories; the "test runner" writes a JSON report whose tests depend on a settings file the candidate changed
// (a non-test file, so the original code's run sees the old settings), which is how a change makes tests skip or vanish without touching a test file.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestProofSchema, type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
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
    expect(TestProofSchema.parse(proof).weakening).toEqual([{ checkId: "readiness:0", skippedBefore: 0, skippedAfter: 1, absentOnNew: ["src/old.test.ts::c"], absentOnNewCount: 1 }]);
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
  });

  it("makes no claim without a report of its own from the original code's run, or from this code's run", async () => {
    const made = await repository("weak");
    // The original code's run wrote no report (the proof removes the candidate's before that run, so a stale one is never read as its result).
    const stale = runnerOver(made.directory, { writeReport: false });
    await writeFile(join(made.directory, "report.json"), JSON.stringify({ testResults: [{ name: join(made.directory, "src/old.test.ts"), assertionResults: [{ fullName: "a", status: "passed", failureMessages: [] }] }] }));
    expect((await runTestProof(optionsFor(made, stale))).weakening).toBeUndefined();
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
});
