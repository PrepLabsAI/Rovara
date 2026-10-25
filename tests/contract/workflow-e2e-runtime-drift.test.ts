import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerInvocationSchema, type E2EApplicationExecutionAdmission } from "@agentx/contracts";
import type { DockerApplicationHost } from "../../packages/verifier/src/host/docker-application-host.js";
import { encodeE2EApplicationExecutionAdmission } from "../../packages/verifier/src/application-scenarios.js";
import { e2eCompiledRuntime, validateE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { executeWorkflowE2EChecks } from "../../packages/worker/src/workflow-e2e-checks.js";
import type { CandidateGit } from "../../packages/worker/src/e2e-candidate-source.js";
import type { WorkflowE2EApplicationRuntime } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { createWorkflowE2EApplicationRuntime } from "../../packages/worker/src/workflow-e2e-application-runtime.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";

// HARDEN-C I-4 (DRIFTFAILFAST): a runner whose kernel changed after its runtime was qualified refuses a round at its start, with a fixed code, instead of running it and reading UNKNOWN.
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A host that must never be built for a drifted runner; for the control run it answers as a finished run. */
function standInHost(): DockerApplicationHost {
  const at = new Date().toISOString();
  return { allocate: async () => ({ leaseId: "stand-in", close: async () => ({ confirmed: true }),
    execute: async () => ({ process: { exitCode: 0, timedOut: false, aborted: false }, rawReport: null, observedUpstreamRunId: null, coverageByCase: new Map(), artifacts: [], modelReceiptIds: [],
      startedAt: at, finishedAt: at, cleanup: "confirmed" as const }) }),
  readActualRun: async () => ({ protocol: "e2e-actual-application-run/v1", cleanupConfirmed: true, cleanupServerListening: false, supervisorReadback: { marker: "assembled" }, shards: [] }) as never,
  readCollectionInputs: async () => ({ marker: "collection-inputs" }) as never,
  readDiagnostics: () => ({ appLogTail: "", buildLogTail: "", executorLogTail: "" }), readBuildResult: () => null };
}

async function setup(hostEnvironment: WorkflowE2EApplicationRuntime["hostEnvironment"]) {
  const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", taskId: TASK_ID });
  const admission: E2EApplicationExecutionAdmission = fixture.plan.admission;
  const admitted = e2eCompiledRuntime(validateE2EApplicationExecutionAdmission(admission).applicationSuites[0]!)!.runnerEnvironment as { os: string; arch: string };
  const admissionBytes = Buffer.from(encodeE2EApplicationExecutionAdmission(admission), "utf8");
  const admissionSha = sha(admissionBytes);
  const invocation = WorkerInvocationSchema.parse({
    protocolVersion: 1, kind: "task", operationId: admission.operationId, workspaceId: "22222222-2222-4222-8222-222222222222", fence: admission.operationFence,
    projectRevision: 1, callbackCapability: "c".repeat(32),
    payload: { conversationId: "33333333-3333-4333-8333-333333333333", prompt: "Run the approved E2E checks.", workflowMode: "CHECKS",
      readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 }],
      workflowE2EAdmission: { schemaVersion: 1, kind: "application", taskId: admission.taskId, workflowRevision: admission.workflowRevision, candidateDigest: admission.candidateDigest,
        roundId: admission.round.roundId, groupRunIds: admission.groups.map((group) => group.outerBinding.runId),
        admissionRef: { key: `workflow-e2e-admissions/sha256/${admissionSha}.json`, sha256: admissionSha, byteLength: admissionBytes.byteLength } } },
  });
  if (invocation.kind !== "task") throw new Error("fixture invocation must be a task");
  const readAdmission = vi.fn(async (offset: number) => ({ totalBytes: admissionBytes.byteLength, chunkBase64: admissionBytes.subarray(offset, offset + 64 * 1024).toString("base64"), sha256: admissionSha }));
  const saved: Array<{ bytes: Buffer; groupRunId: string | undefined }> = [];
  const saveEvidence = vi.fn(async (bytes: Uint8Array, digest: string, _maxBytes: number, groupRunId?: string) => {
    saved.push({ bytes: Buffer.from(bytes), groupRunId });
    return { key: `workflow-e2e-${groupRunId === undefined ? "evidence" : "group-evidence"}/sha256/${digest}.json`, sha256: digest };
  });
  const runRoot = await temp("drift-run-root-");
  const evidenceRoot = await temp("drift-evidence-");
  const repositoryRoot = await temp("drift-repository-");
  const git: CandidateGit = { treeOf: vi.fn(async () => admission.candidateTreeSha),
    materializeInto: vi.fn<CandidateGit["materializeInto"]>(async (_root, _commitSha, destination) => {
      for (const source of admission.sourceSnapshot.sources) {
        const path = join(destination, String(source.path));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(source.bytesBase64, "base64"));
      }
      return [];
    }) };
  const createHost = vi.fn((): DockerApplicationHost => standInHost());
  const collect = vi.fn(() => ({ collection: { marker: "wire-collection" }, oracle: {}, unavailableReason: null,
    qualification: { status: "PASS" as const, reason: "x", runId: null, rawReportSha256: null, result: null } }));
  const application = { runRoot, createHost, git, collect, ...(hostEnvironment === undefined ? {} : { hostEnvironment }) } as unknown as WorkflowE2EApplicationRuntime;
  const run = () => executeWorkflowE2EChecks({ invocation, readAdmission, saveEvidence, sourceRoot: "/workspace/runtime", evidenceRoot,
    candidateRepositoryRoot: () => repositoryRoot, application });
  return { admitted, admission, run, saved, createHost, collect };
}

const groupEvidence = (s: Awaited<ReturnType<typeof setup>>) => s.saved.filter((item) => item.groupRunId !== undefined)
  .map((item) => (JSON.parse(item.bytes.toString("utf8")) as { groupRun: { unavailableReason: string | null; collection: { status: string; reason: string }; actual: unknown } }).groupRun);

describe("a runner whose environment drifted from the admitted runtime refuses the round at its start", () => {
  it("builds no host and ran nothing: every group is UNKNOWN with the fixed code runtime-environment-drifted, and the round did not succeed", async () => {
    const s = await setup(() => ({ os: "linux 6.18.99-999.999.amzn2023.aarch64", arch: "arm64" }));
    const result = await s.run();
    expect(s.createHost).not.toHaveBeenCalled();
    expect(s.collect).not.toHaveBeenCalled();
    const groups = groupEvidence(s);
    expect(groups).toHaveLength(s.admission.groups.length);
    for (const group of groups) {
      expect(group.unavailableReason).toBe("runtime-environment-drifted");
      expect(group.collection).toEqual({ status: "UNKNOWN", reason: "runtime-environment-drifted" });
      expect(group.actual).toBeNull();
    }
    expect(result.processStatus).toBe("FAILED");
  });

  it("refuses on another architecture too, and when the probe cannot answer (fail closed)", async () => {
    const { admitted } = await setup(undefined);
    for (const probe of [() => ({ os: admitted.os, arch: "x64" }), () => { throw new Error("os.release failed"); }]) {
      const again = await setup(probe);
      await again.run();
      expect(again.createHost).not.toHaveBeenCalled();
      expect(groupEvidence(again).every((group) => group.unavailableReason === "runtime-environment-drifted")).toBe(true);
    }
  });

  it("positive control: the same round on a runner that matches its admitted runtime runs as before", async () => {
    const probe = await setup(undefined);
    const s = await setup(() => ({ os: probe.admitted.os, arch: probe.admitted.arch }));
    const result = await s.run();
    expect(s.createHost).toHaveBeenCalledTimes(s.admission.groups.length);
    expect(groupEvidence(s).some((group) => group.unavailableReason === "runtime-environment-drifted")).toBe(false);
    expect(result.processStatus).toBeDefined();
  });

  it("the production runtime always carries the probe, and it reads this host's platform, kernel release and architecture", () => {
    const runtime = createWorkflowE2EApplicationRuntime({ EXECUTOR_IMAGE: "123456789012.dkr.ecr.us-east-1.amazonaws.com/rovara-executor@sha256:" + "a".repeat(64) },
      { platform: "linux", arch: "arm64", release: () => "6.18.56-125.164.amzn2023.aarch64" });
    expect(runtime.hostEnvironment?.()).toEqual({ os: "linux 6.18.56-125.164.amzn2023.aarch64", arch: "arm64" });
  });
});
