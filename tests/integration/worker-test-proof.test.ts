// TESTPROOF through the worker's CHECKS path: a verification retry runs the selected project checks on the candidate, then (when tests
// changed) once more on the original code with the new tests kept. test-proof.json is the only new output; the checks.json artifact,
// the CHECKS result and its status are what they are today. Fake runners over a real git workspace; offline.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckReportSchema, TestProofSchema, createCandidateManifest, type ProjectCommand, type WorkerInvocation } from "../../packages/contracts/src/index.js";
import type { WorkerArtifact } from "../../packages/worker/src/artifacts.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import { AgentFilesRestoreError } from "../../packages/worker/src/verification/original-code.js";
import { runTaskInvocation, type TaskInvocationResult } from "../../packages/worker/src/run-task.js";
import { projectCheckKey } from "../../packages/worker/src/verification/check-history.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL } from "../support/faux-model.js";
import { fakeTestRunner, git } from "../support/test-proof-fixture.js";

const check: ProjectCommand = { cwd: "app", executable: "npm", args: ["test"], timeoutSeconds: 60 };

/** A workspace root whose manifest names one committed repository `app` (src/bug.ts = 1), with `files` then written on top, uncommitted. */
async function workspace(files: Record<string, string>): Promise<string> {
  const rootPath = await createFixtureDirectory("agentx-testproof-run-");
  const repository = join(rootPath, "app");
  await mkdir(join(rootPath, ".agentx"), { recursive: true });
  await mkdir(join(repository, "src"), { recursive: true });
  await writeFile(join(repository, "src/bug.ts"), "export const value = 1;\n");
  git(repository, "init", "-q", "-b", "main");
  git(repository, "add", "-A");
  git(repository, "commit", "-q", "-m", "fixture");
  const resolvedCommit = git(repository, "rev-parse", "HEAD");
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "proof", projectRevision: 1, repositories: [{ name: "app", path: "app", defaultBranch: "main", resolvedCommit, resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
    completedSetupSteps: [], readinessResults: [], readinessCommandKeys: [projectCheckKey(check)], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
  }));
  for (const [path, content] of Object.entries(files)) await writeFile(join(repository, path), content);
  return rootPath;
}

async function checksRun(rootPath: string, extra: { runProjectCommand?: ProjectCommand[]; fixedOutput?: string; testProofOriginalCode?: Parameters<typeof runTaskInvocation>[1]["testProofOriginalCode"] } = {}) {
  const invocation: Extract<WorkerInvocation, { kind: "task" }> = {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "check it", readiness: [check], workflowMode: "CHECKS" },
  };
  const events: WorkerEvent[] = [];
  const artifacts: WorkerArtifact[] = [];
  const calls: ProjectCommand[] = extra.runProjectCommand ?? [];
  const result: TaskInvocationResult = await runTaskInvocation(invocation, {
    rootPath, model: FAUX_MODEL, checkRunners: fakeTestRunner(rootPath, calls, undefined, extra.fixedOutput),
    ...(extra.testProofOriginalCode === undefined ? {} : { testProofOriginalCode: extra.testProofOriginalCode }),
    eventSink: async (batch) => { events.push(...batch); },
    artifactSink: async (artifact) => { artifacts.push(artifact); },
  });
  return { result, events, artifacts, calls };
}

describe("TESTPROOF in the CHECKS run", () => {
  // 9
  it("writes test-proof.json for a new test that proves the change and leaves checks.json and the CHECKS result as they are", async () => {
    const rootPath = await workspace({ "src/bug.ts": "export const value = 2;\n", "src/bug.test.ts": 'import { value } from "./bug.js";\nexpect(value).toBe(2);\n' });
    const run = await checksRun(rootPath);

    // Today's outputs: the check ran on the candidate, passed, and the result says verified; checks.json parses strictly as a CheckReport.
    const checksJson = run.artifacts.find((artifact) => artifact.name === "checks.json")!;
    const report = CheckReportSchema.parse(JSON.parse(checksJson.content));
    expect(report).toMatchObject({ status: "verified", source: "project", checks: [expect.objectContaining({ after: "passed", exitCode: 0 })] });
    expect(run.result).toMatchObject({ workflowMode: "CHECKS", checks: { status: "verified", source: "project" } });
    expect(Object.keys(run.result).sort()).toEqual(["checks", "conversationId", "reopened", "workflowCandidateRepositories", "workflowCheckCandidateRepositories", "workflowMode"]);
    expect(run.result.workflowCandidateRepositories).toEqual(run.result.workflowCheckCandidateRepositories);

    // The new output: bound to the candidate the broker will compute, and it says the test proves the change.
    const proofArtifact = run.artifacts.find((artifact) => artifact.name === "test-proof.json")!;
    expect(proofArtifact.mediaType).toMatch(/^application\/json/);
    const proof = TestProofSchema.parse(JSON.parse(proofArtifact.content));
    expect(proof.candidateDigest).toBe(createCandidateManifest(run.result.workflowCheckCandidateRepositories!).digest);
    expect(proof.items).toEqual([expect.objectContaining({ verdict: "proves_change" })]);
    // Two runs of the check: on the candidate, then on the original code with the new test kept; the workspace is the candidate again.
    expect(run.calls).toHaveLength(2);
    expect(await readFile(join(rootPath, "app/src/bug.ts"), "utf8")).toBe("export const value = 2;\n");
  });

  it("makes no second run and no failure of the CHECKS result when no test changed", async () => {
    const rootPath = await workspace({ "src/bug.ts": "export const value = 3; // no test\n" });
    const run = await checksRun(rootPath);
    expect(run.calls).toHaveLength(1);
    expect(run.result.checks).toMatchObject({ status: "verified" });
    const proof = TestProofSchema.parse(JSON.parse(run.artifacts.find((artifact) => artifact.name === "test-proof.json")!.content));
    expect(proof).toMatchObject({ status: "no_changed_tests", items: [] });
  });

  it("keeps the CHECKS result verified when the new test also passes on the original code", async () => {
    const rootPath = await workspace({ "src/bug.ts": "export const value = 1; // refactor\n", "src/bug.test.ts": 'import { value } from "./bug.js";\nexpect(value).toBe(1);\n' });
    const run = await checksRun(rootPath);
    expect(run.result.checks).toMatchObject({ status: "verified" });
    const proof = TestProofSchema.parse(JSON.parse(run.artifacts.find((artifact) => artifact.name === "test-proof.json")!.content));
    expect(proof.items).toEqual([expect.objectContaining({ verdict: "does_not_prove" })]);
  });

  // 7
  it("fails the task when the agent's files cannot be restored after the run on the original code", async () => {
    const rootPath = await workspace({ "src/bug.ts": "export const value = 2;\n", "src/bug.test.ts": 'import { value } from "./bug.js";\nexpect(value).toBe(2);\n' });
    await expect(checksRun(rootPath, { testProofOriginalCode: () => ({ run: async () => { throw new AgentFilesRestoreError("could not restore"); } }) })).rejects.toBeInstanceOf(AgentFilesRestoreError);
  });

  // 13
  it("says in a progress line that no test changed", async () => {
    const run = await checksRun(await workspace({ "src/bug.ts": "export const value = 3; // no test\n" }));
    const messages = run.events.filter((event) => event.type === "progress").map((event) => JSON.stringify(event.data ?? event));
    expect(messages.some((message) => message.includes("no new or changed tests"))).toBe(true);
  });

  // 12
  it("leaves checks.json byte-identical, durations aside, with and without the proof", async () => {
    const files = { "src/bug.ts": "export const value = 2;\n" };
    const withTest = await checksRun(await workspace({ ...files, "src/bug.test.ts": 'import { value } from "./bug.js";\nexpect(value).toBe(2);\n' }), { fixedOutput: "ok\n" });
    const without = await checksRun(await workspace(files), { fixedOutput: "ok\n" });
    expect(withTest.artifacts.some((artifact) => artifact.name === "test-proof.json")).toBe(true);
    const normalised = (run: typeof withTest) => run.artifacts.find((artifact) => artifact.name === "checks.json")!.content.replace(/"durationMs":\d+/g, '"durationMs":0');
    expect(normalised(withTest)).toBe(normalised(without));
  });
});
