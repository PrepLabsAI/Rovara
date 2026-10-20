import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCandidateManifest, type E2EWorkflowAdmissionRef, type WorkerInvocation } from "../../packages/contracts/src/index.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import * as e2eChecks from "../../packages/worker/src/workflow-e2e-checks.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL } from "../support/faux-model.js";

// A CHECKS round runs the project's selected checks and, when the broker admitted one, the E2E round. A round whose admission is an application admission (browser or API
// scenarios, nothing portable) is valid with no project check at all; a portable round, and a CHECKS run with no admission, still need at least one.
vi.mock("../../packages/worker/src/workflow-e2e-checks.js", async (importOriginal) => {
  const original: typeof e2eChecks = await importOriginal();
  return { ...original, executeWorkflowE2EChecks: vi.fn(original.executeWorkflowE2EChecks) };
});

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function workspace() {
  const rootPath = await createFixtureDirectory("agentx-checks-none-");
  await mkdir(join(rootPath, ".agentx"));
  const repository = join(rootPath, "app");
  await mkdir(repository);
  await writeFile(join(repository, "README.md"), "fixture\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", repository]);
  git("add", ".");
  git("commit", "-qm", "fixture");
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "p", projectRevision: 1,
    repositories: [{ name: "app", path: "app", defaultBranch: "main", resolvedCommit: git("rev-parse", "HEAD"), resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
    completedSetupSteps: [], readinessResults: [], readinessCommandKeys: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
  return rootPath;
}

async function run(options: { admissionSchema?: string }) {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: options.admissionSchema }));
  const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const reference: E2EWorkflowAdmissionRef = { schemaVersion: 1, taskId: randomUUID(), workflowRevision: 3, candidateDigest: candidate.digest, roundId: randomUUID(), groupRunIds: [randomUUID()],
    admissionRef: { key: `workflow-e2e-admissions/sha256/${sha(bytes)}.json`, sha256: sha(bytes), byteLength: bytes.byteLength } };
  const invocation: Extract<WorkerInvocation, { kind: "task" }> = { protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "check it", workflowMode: "CHECKS", readiness: [],
      ...(options.admissionSchema === undefined ? {} : { workflowE2EAdmission: reference }) } };
  const events: WorkerEvent[] = [];
  let reads = 0;
  const execute = vi.mocked(e2eChecks.executeWorkflowE2EChecks);
  execute.mockClear();
  execute.mockResolvedValueOnce({ evidenceRef: { key: "workflow-e2e-evidence/sha256/x.json", sha256: "e".repeat(64) }, candidateDigest: reference.candidateDigest, roundId: reference.roundId, processStatus: "SUCCEEDED" });
  let result: Awaited<ReturnType<typeof runTaskInvocation>> | undefined;
  let failure: unknown;
  try {
    result = await runTaskInvocation(invocation, { rootPath: await workspace(), model: FAUX_MODEL,
      eventSink: async (batch) => { events.push(...batch); }, artifactSink: async () => undefined,
      workflowE2EAdmissionReader: async (_ref, offset) => { reads += 1; return { totalBytes: bytes.byteLength, chunkBase64: bytes.subarray(offset).toString("base64"), sha256: sha(bytes) }; },
      workflowE2EEvidenceSink: async () => ({ key: "k", sha256: "e".repeat(64) }), workflowE2EEvidenceRoot: await createFixtureDirectory("agentx-checks-none-evidence-") });
  } catch (error) { failure = error; }
  return { result, failure, events, reads, execute };
}

describe("a CHECKS run with no project check", () => {
  it("runs an application-only round", async () => {
    const outcome = await run({ admissionSchema: "workflow-e2e-application-admission/v1" });
    expect(outcome.failure).toBeUndefined();
    expect(outcome.execute).toHaveBeenCalledTimes(1);
    expect(outcome.result).toMatchObject({ workflowMode: "CHECKS", checks: { status: "not_verified", source: "none" }, workflowE2EEvidenceRef: { key: "workflow-e2e-evidence/sha256/x.json" } });
  });

  it("still refuses a portable round, before it runs anything", async () => {
    const outcome = await run({ admissionSchema: "workflow-e2e-admission/v1" });
    expect(String(outcome.failure)).toMatch(/verification retry requires at least one selected project check/);
    expect(outcome.execute).not.toHaveBeenCalled();
  });

  it("still refuses a run that carries no admission, before it reads or runs anything", async () => {
    const outcome = await run({});
    expect(String(outcome.failure)).toMatch(/verification retry requires at least one selected project check/);
    expect(outcome.execute).not.toHaveBeenCalled();
    expect(outcome.reads).toBe(0);
    expect(outcome.events).toEqual([]);
  });

  it("refuses an admission it cannot recognise as an application admission", async () => {
    const outcome = await run({ admissionSchema: "something-else/v1" });
    expect(String(outcome.failure)).toMatch(/verification retry requires at least one selected project check/);
    expect(outcome.execute).not.toHaveBeenCalled();
  });
});
