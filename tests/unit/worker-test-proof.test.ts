// TESTPROOF: AgentX shows the original code with the agent's new or changed tests kept, runs the same project checks there, and says
// whether each new test really fails without the change. Real git repositories in temp directories; the "test runner" is a fake that reads
// the workspace files it finds (tests/support/test-proof-fixture.ts), so a run on the original code really sees the original code.
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestProofSchema, type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
import { CheckNotRunError, type CheckPlan } from "../../packages/worker/src/verification/checks.js";
import { AgentFilesRestoreError, gitOriginalCode, ORIGINAL_CODE_REF } from "../../packages/worker/src/verification/original-code.js";
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
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function repository(start: Record<string, string>, candidate: Record<string, string | null>) {
    const made = await repositoryWithCandidate(start, candidate);
    cleanup.push(made.directory);
    return made;
  }

  const plan: CheckPlan = { source: "project", readiness: [FAKE_TEST_COMMAND], projectBefore: ["unknown"] };
  function proofOptions(made: Awaited<ReturnType<typeof repository>>, extra: Partial<Parameters<typeof runTestProof>[0]> & { calls?: ProjectCommand[] } = {}) {
    const calls = extra.calls ?? [];
    const { calls: _calls, ...rest } = extra;
    return {
      plan, newEntries: [passedEntry()] as CheckEntry[], runners: fakeTestRunner(made.directory, calls),
      repositories: [{ repositoryId: "app", directory: made.directory, startCommit: made.startCommit, candidateTreeSha: made.candidateTreeSha }],
      candidateDigest: DIGEST, rootPath: made.directory, signal: new AbortController().signal, budgetMs: 60_000, ...rest,
    };
  }

  // 1
  it("shows the original src/ with the candidate's new, changed and deleted test files, then restores the candidate exactly", async () => {
    const made = await repository(
      { "src/bug.ts": SOURCE_1, "src/changed.test.ts": "old test\n", "src/gone.test.ts": "the agent deletes this test\n", "src/keep.ts": "keep\n" },
      { "src/bug.ts": SOURCE_2, "src/bug.test.ts": TEST_EXPECTS(2), "src/changed.test.ts": "new test\n", "src/gone.test.ts": null, "src/keep.ts": "keep, edited\n" });
    const statusBefore = git(made.directory, "status", "--porcelain", "--untracked-files=all");
    const seen = await gitOriginalCode([{ directory: made.directory, commit: made.startCommit, overlay: ["src/bug.test.ts", "src/changed.test.ts", "src/gone.test.ts"] }]).run(async () => ({
      source: await readFile(join(made.directory, "src/bug.ts"), "utf8"),
      keep: await readFile(join(made.directory, "src/keep.ts"), "utf8"),
      added: await readFile(join(made.directory, "src/bug.test.ts"), "utf8").catch(() => undefined),
      changed: await readFile(join(made.directory, "src/changed.test.ts"), "utf8"),
      deleted: await exists(join(made.directory, "src/gone.test.ts")),
    }));
    expect(seen).toEqual({ source: SOURCE_1, keep: "keep\n", added: TEST_EXPECTS(2), changed: "new test\n", deleted: false });
    // Back to the candidate, exactly: every file, the status, HEAD, and no private ref left.
    expect(await readFile(join(made.directory, "src/bug.ts"), "utf8")).toBe(SOURCE_2);
    expect(await readFile(join(made.directory, "src/keep.ts"), "utf8")).toBe("keep, edited\n");
    expect(await exists(join(made.directory, "src/gone.test.ts"))).toBe(false);
    expect(git(made.directory, "status", "--porcelain", "--untracked-files=all")).toBe(statusBefore);
    expect(git(made.directory, "rev-parse", "HEAD")).toBe(made.candidateCommit);
    expect(() => git(made.directory, "rev-parse", "--verify", "--quiet", ORIGINAL_CODE_REF)).toThrow();
  });

  // 2
  it("classes a new test that fails by assertion on the original code and passes now as proving the change", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, { "src/bug.ts": SOURCE_2, "src/bug.test.ts": TEST_EXPECTS(2) });
    const proof = await runTestProof(proofOptions(made));
    expect(TestProofSchema.parse(proof)).toMatchObject({ status: "checked", note: "completed", candidateDigest: DIGEST, changedTests: { added: 1, changed: 0, deleted: 0 } });
    expect(proof.items).toEqual([expect.objectContaining({ checkId: "readiness:0", granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" })]);
    expect(await readFile(join(made.directory, "src/bug.ts"), "utf8")).toBe(SOURCE_2);
  });

  // 3
  it("classes a new test that also passes on the original code as not proving the change, and leaves the checks it was given untouched", async () => {
    const made = await repository({ "src/bug.ts": SOURCE_1 }, { "src/bug.ts": "export const value = 1; // refactored\n", "src/bug.test.ts": TEST_EXPECTS(1) });
    const entries = [passedEntry()];
    const before = JSON.stringify(entries);
    const proof = await runTestProof(proofOptions(made, { newEntries: entries }));
    expect(proof.items).toEqual([expect.objectContaining({ verdict: "does_not_prove", reason: "passed_on_old" })]);
    expect(JSON.stringify(entries)).toBe(before);
  });

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
    const made = await repository({ "src/bug.ts": SOURCE_1 }, { "src/bug.ts": SOURCE_2, "src/bug.test.ts": TEST_EXPECTS(2) });
    const slow = { ...fakeTestRunner(made.directory), runProjectCommand: async () => ({ exitCode: null, timedOut: true, stdout: "", stderr: "" }) };
    const timedOut = await runTestProof(proofOptions(made, { runners: slow }));
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
