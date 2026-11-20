// TESTPROOF: AgentX shows the original code with the agent's new or changed tests kept, runs the same project checks there, and says
// whether each new test really fails without the change. Real git repositories in temp directories; the "test runner" is a fake that reads
// the workspace files it finds (tests/support/test-proof-fixture.ts), so a run on the original code really sees the original code.
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
import { CheckNotRunError, type CheckPlan } from "../../packages/worker/src/verification/checks.js";
import { RunnerKillUnconfirmedError } from "../../packages/worker/src/collected-process.js";
import { AgentFilesRestoreError, isUnconfirmedStop, ORIGINAL_CODE_REF } from "../../packages/worker/src/verification/original-code.js";
import { runTestProof } from "../../packages/worker/src/verification/test-proof.js";
import { FAKE_TEST_COMMAND, fakeTestRunner, git, passedEntry, repositoryWithCandidate } from "../support/test-proof-fixture.js";

const SOURCE_1 = "export const value = 1;\n";
const SOURCE_2 = "export const value = 2;\n";
const TEST_EXPECTS = (n: number) => `import { value } from "./bug.js";\nexpect(value).toBe(${n});\n`;
const DIGEST = "d".repeat(64);
const exists = (path: string) => stat(path).then(() => true, () => false);

describe("TESTPROOF", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function repository(start: Record<string, string>, candidate: Record<string, string | null>, prepare?: (directory: string) => Promise<void>) {
    const made = await repositoryWithCandidate(start, candidate, prepare);
    cleanup.push(made.directory);
    return made;
  }

  const plan: CheckPlan = { source: "project", readiness: [FAKE_TEST_COMMAND], projectBefore: ["unknown"] };
  function proofOptions(made: Awaited<ReturnType<typeof repository>>, extra: Partial<Parameters<typeof runTestProof>[0]> & { calls?: ProjectCommand[] } = {}) {
    const calls = extra.calls ?? [];
    const rest: Partial<Parameters<typeof runTestProof>[0]> = { ...extra };
    delete (rest as { calls?: unknown }).calls;
    return {
      plan, newEntries: [passedEntry()] as CheckEntry[], runners: fakeTestRunner(made.directory, calls),
      repositories: [{ repositoryId: "app", directory: made.directory, startCommit: made.startCommit, candidateTreeSha: made.candidateTreeSha }],
      candidateDigest: DIGEST, rootPath: made.directory, signal: new AbortController().signal, budgetMs: 60_000, ...rest,
    };
  }

  // 4
  it("classes a new test that cannot load on the original code (a missing export) as could not run, never as proving", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, { "src/bug.ts": `${SOURCE_1}export const fixed = 2;\n`, "src/bug.test.ts": `import { fixed } from "./bug.js";\nexpect(fixed).toBe(2);\n` });
    const proof = await runTestProof(proofOptions(made));
    expect(proof.items).toEqual([expect.objectContaining({ verdict: "could_not_run_on_old", reason: "load_failure_on_old" })]);
  });

  // 5
  it("runs nothing and records a note when the candidate adds or changes no test file", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1, "src/bug.test.ts": TEST_EXPECTS(1) }, { "src/bug.ts": "export const value = 1; // refactored\n", "src/bug.test.ts": null });
    const calls: ProjectCommand[] = [];
    const proof = await runTestProof(proofOptions(made, { calls }));
    expect(calls).toEqual([]);
    expect(proof).toMatchObject({ status: "no_changed_tests", note: "no_changed_tests", items: [], changedTests: { added: 0, changed: 0, deleted: 1 } });
  });

  // 6
  it("says not checked when the run on the original code times out or is stopped, and restores the candidate", async () => {
    // runChecks cuts a check's timeout to the budget left, and calls a timeout "budget" (not "timed_out") when it did. With a real clock one elapsed millisecond between
    // the start of the round and the start of the check was enough to make the 60 s command's timeout look cut by the 60 s budget, and a slow runner lost that race. A
    // clock that stands still makes the full budget available to the check, so only its own timeout can stop it. (Only Date is faked: git and the file system run on.)
    vi.useFakeTimers({ toFake: ["Date"] });
    const made = await repository({ "src/bug.ts": SOURCE_1 }, { "src/bug.ts": SOURCE_2, "src/bug.test.ts": TEST_EXPECTS(2) });
    const slow = { ...fakeTestRunner(made.directory), runProjectCommand: async () => ({ exitCode: null, timedOut: true, stdout: "", stderr: "" }) };
    // A budget well above the check's own 60 s timeout, so the time the run takes never caps the check and the stub's timeout reads as its own.
    const timedOut = await runTestProof(proofOptions(made, { runners: slow, budgetMs: 10 * 60_000 }));
    expect(timedOut.items).toEqual([expect.objectContaining({ verdict: "not_checked", reason: "timed_out" })]);
    expect(await readFile(join(made.directory, "src/bug.ts"), "utf8")).toBe(SOURCE_2);
    const stop = new AbortController();
    const stopped = await runTestProof(proofOptions(made, { runners: { ...slow, runProjectCommand: async () => { stop.abort(); throw new Error("aborted"); } }, signal: stop.signal }));
    expect(stopped).toMatchObject({ status: "not_checked", note: "stopped" });
    expect(stopped.items.every((item) => item.verdict === "not_checked")).toBe(true);
    expect(await readFile(join(made.directory, "src/bug.ts"), "utf8")).toBe(SOURCE_2);
  });

  // 7
  it("still fails the task when the agent's files cannot be restored after the run on the original code", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, { "src/bug.ts": SOURCE_2, "src/bug.test.ts": TEST_EXPECTS(2) });
    const failing = { run: async () => { throw new AgentFilesRestoreError("could not restore"); } };
    await expect(runTestProof(proofOptions(made, { originalCode: () => failing }))).rejects.toBeInstanceOf(AgentFilesRestoreError);
    // Any other failure to show the original code is only "not checked".
    const broken = { run: async () => { throw new Error("git failed"); } };
    const proof = await runTestProof(proofOptions(made, { originalCode: () => broken }));
    expect(proof).toMatchObject({ status: "not_checked", note: "original_code_unavailable" });
  });

  it("a stop that could not be confirmed fails the task and touches nothing afterwards: the agent's files are not restored over a command that may still be writing (FIX-RUNNER-ABORT-JOIN)", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, { "src/bug.ts": SOURCE_2, "src/bug.test.ts": TEST_EXPECTS(2) });
    const command: ProjectCommand = { ...FAKE_TEST_COMMAND, args: ["test", "--", "--reporter=json", "--outputFile=report.json"] };
    // The report the candidate's checks wrote: it is taken away before the run on the original code, and normally put back after it.
    await writeFile(join(made.directory, "report.json"), JSON.stringify({ testResults: [] }));
    const stuck = { ...fakeTestRunner(made.directory), runProjectCommand: async () => { throw new RunnerKillUnconfirmedError({ kind: "local" }); } };
    const failure = await runTestProof(proofOptions(made, { runners: stuck, plan: { source: "project", readiness: [command], projectBefore: ["unknown"] } })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentFilesRestoreError);
    expect(isUnconfirmedStop(failure)).toBe(true);
    // Still the original code: no restore ran. The agent's files are kept under the private ref for recoverAgentFiles, as for any failed restore.
    expect(await readFile(join(made.directory, "src/bug.ts"), "utf8")).toBe(SOURCE_1);
    // And the report file was not written back either: a command that may still be running would overwrite it.
    expect(await exists(join(made.directory, "report.json"))).toBe(false);
    expect(git(made.directory, "rev-parse", "--verify", ORIGINAL_CODE_REF)).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("does not run a check on the original code that did not pass on the new code", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, { "src/bug.ts": SOURCE_2, "src/bug.test.ts": TEST_EXPECTS(2) });
    const calls: ProjectCommand[] = [];
    const proof = await runTestProof(proofOptions(made, { calls, newEntries: [{ ...passedEntry(), after: "failed", exitCode: 1 }] }));
    expect(calls).toEqual([]);
    expect(proof.note).toBe("no_passing_checks");
  });

  it("is refused by the runner for a command it will not run: that check is not checked, not a failure", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, { "src/bug.ts": SOURCE_2, "src/bug.test.ts": TEST_EXPECTS(2) });
    const refusing = { ...fakeTestRunner(made.directory), runProjectCommand: async () => { throw new CheckNotRunError("refused"); } };
    const proof = await runTestProof(proofOptions(made, { runners: refusing }));
    expect(proof.items).toEqual([expect.objectContaining({ verdict: "not_checked", reason: "infrastructure" })]);
  });
});
