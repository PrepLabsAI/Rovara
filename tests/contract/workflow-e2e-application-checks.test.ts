import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2E_HARD_LIMITS, WorkerInvocationSchema, type E2EApplicationExecutionAdmission } from "@agentx/contracts";
import { createDockerApplicationHost, DEFAULT_DEADLINE_GRACE_MS, STALE_RUN_SWEEP_AGE_MS, type DockerApplicationHost } from "../../packages/verifier/src/host/docker-application-host.js";
import { encodeE2EApplicationExecutionAdmission } from "../../packages/verifier/src/application-scenarios.js";
import { executeWorkflowE2EChecks } from "../../packages/worker/src/workflow-e2e-checks.js";
import { createEvidenceBudget } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES, E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES } from "@agentx/contracts";
import type { CandidateGit } from "../../packages/worker/src/e2e-candidate-source.js";
import type { WorkflowE2EApplicationRuntime } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { FakeDockerCli, writeExecutorOutput } from "../support/fake-docker-cli.js";

const TASK_ID = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const assembledRun = { protocol: "e2e-actual-application-run/v1", cleanupConfirmed: true, cleanupServerListening: false, supervisorReadback: { marker: "assembled" } };
const collectionInputs = { marker: "collection-inputs" };

async function setup(options: { deadlineMs?: number; treeSha?: string; fake?: FakeDockerCli } = {}) {
  const fake = options.fake ?? new FakeDockerCli();
  const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", taskId: TASK_ID, ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }) });
  const admission: E2EApplicationExecutionAdmission = fixture.plan.admission;
  const admissionBytes = Buffer.from(encodeE2EApplicationExecutionAdmission(admission), "utf8");
  const admissionSha = sha(admissionBytes);
  const invocation = WorkerInvocationSchema.parse({
    protocolVersion: 1, kind: "task", operationId: admission.operationId, workspaceId: "22222222-2222-4222-8222-222222222222", fence: admission.operationFence,
    projectRevision: 1, callbackCapability: "c".repeat(32),
    payload: { conversationId: "33333333-3333-4333-8333-333333333333", prompt: "Run the approved E2E checks.", workflowMode: "CHECKS",
      readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 }],
      workflowE2EAdmission: { schemaVersion: 1, taskId: admission.taskId, workflowRevision: admission.workflowRevision, candidateDigest: admission.candidateDigest,
        roundId: admission.round.roundId, groupRunIds: admission.groups.map((group) => group.outerBinding.runId),
        admissionRef: { key: `workflow-e2e-admissions/sha256/${admissionSha}.json`, sha256: admissionSha, byteLength: admissionBytes.byteLength } } },
  });
  if (invocation.kind !== "task") throw new Error("fixture invocation must be a task");
  const readAdmission = vi.fn(async (offset: number) => {
    const chunk = admissionBytes.subarray(offset, offset + 64 * 1024);
    return { totalBytes: admissionBytes.byteLength, chunkBase64: chunk.toString("base64"), sha256: admissionSha };
  });
  const saved: Array<{ bytes: Buffer; groupRunId: string | undefined; maxBytes: number }> = [];
  const saveEvidence = vi.fn(async (bytes: Uint8Array, digest: string, maxBytes: number, groupRunId?: string) => {
    saved.push({ bytes: Buffer.from(bytes), groupRunId, maxBytes });
    return { key: `workflow-e2e-${groupRunId === undefined ? "evidence" : "group-evidence"}/sha256/${digest}.json`, sha256: digest };
  });
  const runRoot = await temp("application-run-root-");
  const evidenceRoot = await temp("application-evidence-");
  const repositoryRoot = await temp("candidate-repository-");
  const calls: string[] = [];
  const treeOf = vi.fn<CandidateGit["treeOf"]>(async () => options.treeSha ?? admission.candidateTreeSha);
  const materializeInto = vi.fn<CandidateGit["materializeInto"]>(async (_root, _commitSha, destination) => {
    for (const source of admission.sourceSnapshot.sources) {
      const path = join(destination, source.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(source.bytesBase64, "base64"));
    }
    return [];
  });
  const git: CandidateGit = { treeOf, materializeInto };
  const hosts: DockerApplicationHost[] = [];
  const createHost = vi.fn((input: Parameters<WorkflowE2EApplicationRuntime["createHost"]>[0]) => {
    const host = createDockerApplicationHost({ ...input, docker: fake, executorImage: "rovara-executor:test", buildImage: "node:build-test", runRoot, now: () => Date.now(),
      appPollMs: 10, deadlineGraceMs: 60, assemble: (() => assembledRun) as never, assembleCollectionInputs: (() => collectionInputs) as never });
    const spied: DockerApplicationHost = { ...host, allocate: async (runInput, signal) => {
      calls.push("allocate");
      const lease = await host.allocate(runInput, signal);
      return { ...lease,
        execute: (executeSignal) => { calls.push("execute"); return lease.execute(executeSignal); },
        close: (closeSignal) => { calls.push("close"); return lease.close(closeSignal); } };
    } };
    hosts.push(spied);
    return spied;
  });
  type Collected = { collection: unknown; oracle: unknown; unavailableReason: string | null;
    qualification: { status: "PASS" | "FAILED" | "UNKNOWN"; reason: string; runId: string | null; rawReportSha256: string | null; result: null } | null };
  const collect = vi.fn<(input: unknown) => Collected>(() => ({ collection: { marker: "wire-collection" }, oracle: {}, unavailableReason: null,
    qualification: { status: "PASS", reason: "all cases passed", runId: null, rawReportSha256: null, result: null } }));
  const application = { runRoot, createHost, git, collect } as unknown as WorkflowE2EApplicationRuntime;
  const run = (extra: { signal?: AbortSignal; deadlineAt?: number; candidateRepositoryRoot?: (repositoryId: string) => string | undefined; application?: WorkflowE2EApplicationRuntime | (() => WorkflowE2EApplicationRuntime) } = {}) => executeWorkflowE2EChecks({
    invocation, readAdmission, saveEvidence, sourceRoot: "/workspace/runtime", evidenceRoot, candidateRepositoryRoot: extra.candidateRepositoryRoot ?? (() => repositoryRoot),
    application: extra.application ?? application, ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    ...(extra.deadlineAt === undefined ? {} : { deadlineAt: extra.deadlineAt }),
  });
  const runId = admission.groups[0]!.outerBinding.runId;
  const groupId = admission.groups[0]!.outerBinding.groupId;
  const okOutput = (outDir: string) => writeExecutorOutput(outDir, { exitCode: 0, reason: null, runId, groupId });
  return { fake, fixture, admission, invocation, saved, saveEvidence, readAdmission, runRoot, repositoryRoot, calls, treeOf, materializeInto, createHost, collect, run, runId, groupId, okOutput };
}

type SavedEvidence = { schemaVersion: string; round: unknown; groupRun: Record<string, unknown>; groupRuns?: unknown;
  payload: { kind: string; groupRuns: Array<{ collection: { status: string } }> } };
const evidenceOf = (saved: Array<{ bytes: Buffer; groupRunId: string | undefined }>, groupRunId?: string) =>
  JSON.parse(saved.find((item) => item.groupRunId === groupRunId)!.bytes.toString("utf8")) as SavedEvidence;

describe("workflow E2E application rounds", () => {
  it("runs an application admission through the docker host once per group and uploads application evidence", async () => {
    const s = await setup();
    s.fake.onExecutor = s.okOutput;
    const result = await s.run();

    expect(s.createHost).toHaveBeenCalledTimes(1);
    expect(s.calls).toEqual(["allocate", "execute", "close"]);
    expect(s.treeOf).toHaveBeenCalledWith(s.repositoryRoot, s.admission.candidateCommitSha, expect.anything());
    expect(s.materializeInto).toHaveBeenCalledWith(s.repositoryRoot, s.admission.candidateCommitSha, expect.stringContaining(s.runRoot), expect.anything());
    // The staged candidate is private to the round and gone afterwards, and the host removed every labeled resource.
    expect(await readdir(s.runRoot)).toEqual([]);
    expect(s.fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);

    const group = evidenceOf(s.saved, s.runId);
    expect(group).toMatchObject({ schemaVersion: "workflow-e2e-group-evidence/v1", taskId: TASK_ID, candidateDigest: s.admission.candidateDigest });
    expect(group.round).toEqual(JSON.parse(JSON.stringify(s.admission.round)));
    expect(group.groupRun).toMatchObject({ kind: "application", binding: { runId: s.runId, groupId: s.groupId }, collection: { status: "PASS" },
      actual: { collection: { marker: "wire-collection" }, collectionInputs }, unavailableReason: null });
    const aggregate = evidenceOf(s.saved);
    expect(aggregate).toMatchObject({ schemaVersion: "workflow-e2e-evidence/v1", payload: { kind: "application" }, candidateDigest: s.admission.candidateDigest });
    expect(aggregate.groupRuns).toBeUndefined();
    expect(aggregate.payload.groupRuns).toEqual([group.groupRun]);
    expect(result).toMatchObject({ roundId: s.admission.round.roundId, candidateDigest: s.admission.candidateDigest, processStatus: "SUCCEEDED" });
    expect(result.evidenceRef.key).toMatch(/^workflow-e2e-evidence\/sha256\//);
  });

  it("uploads UNKNOWN with the reason 'evidence too large', never the evidence, for a group whose evidence is over the group ceiling, and logs the sizes", async () => {
    const s = await setup();
    s.fake.onExecutor = s.okOutput;
    s.collect.mockReturnValue({ collection: { marker: "x".repeat(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES + 1024) }, oracle: {}, unavailableReason: null,
      qualification: { status: "PASS", reason: "all cases passed", runId: null, rawReportSha256: null, result: null } });
    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { logged.push(String(line)); });
    let result: Awaited<ReturnType<typeof s.run>>;
    try { result = await s.run(); } finally { log.mockRestore(); }
    // Nothing over the ceiling reaches the broker, and the group is UNKNOWN for a reason that names the cause.
    for (const item of s.saved) expect(item.bytes.byteLength).toBeLessThanOrEqual(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES);
    const group = evidenceOf(s.saved, s.runId);
    expect(group.groupRun).toMatchObject({ kind: "application", collection: { status: "UNKNOWN", reason: "evidence too large" }, unavailableReason: "evidence too large", actual: null, diagnostics: null });
    expect(JSON.stringify(group)).not.toContain('"PASS"');
    expect(evidenceOf(s.saved).payload.groupRuns).toEqual([group.groupRun]);
    expect(result.processStatus).toBe("FAILED");
    const entry = logged.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } }).find((item) => item?.event === "workflow.e2e_evidence_too_large");
    expect(entry).toMatchObject({ component: "worker", groupRunId: s.runId, limitBytes: E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES });
    expect(Number(entry?.evidenceBytes)).toBeGreaterThan(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES);
  });

  it("also makes UNKNOWN a group whose evidence is under the group ceiling but would not leave the aggregate room for itself", async () => {
    const s = await setup();
    s.fake.onExecutor = s.okOutput;
    // One group, so the aggregate ceiling is the group's; evidence just under it, with the aggregate's own envelope to fit beside it, cannot be accepted.
    s.collect.mockReturnValue({ collection: { marker: "x".repeat(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES - 256 * 1024) }, oracle: {}, unavailableReason: null,
      qualification: { status: "PASS", reason: "all cases passed", runId: null, rawReportSha256: null, result: null } });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try { await s.run(); } finally { log.mockRestore(); }
    expect(evidenceOf(s.saved, s.runId).groupRun).toMatchObject({ unavailableReason: "evidence too large", actual: null });
    for (const item of s.saved) expect(item.bytes.byteLength).toBeLessThan(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES - 512 * 1024);
  });

  it("keeps the sum of what the groups upload within the aggregate ceiling: a group that would not fit is the one made UNKNOWN", () => {
    const budget = createEvidenceBudget(24 * 1024 * 1024);
    expect(E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES).toBe(24 * 1024 * 1024);
    const eight = 8 * 1024 * 1024;
    // Three groups of just under the group ceiling fit; the fourth would not, and the room kept for the aggregate's own envelope is not spent.
    expect([1, 2, 3].map(() => budget.reserve(eight - 1024))).toEqual([true, true, true]);
    expect(budget.reserve(eight - 1024)).toBe(false);
    expect(budget.reserve(1024)).toBe(true);
    expect(budget.remaining()).toBeGreaterThanOrEqual(0);
  });

  it("refuses a tree that is not the admitted one before it touches docker or the staging area", async () => {
    const s = await setup({ treeSha: "f".repeat(40) });
    await expect(s.run()).rejects.toThrow("candidate tree does not match admission");
    expect(s.treeOf).toHaveBeenCalledTimes(1);
    expect(s.materializeInto).not.toHaveBeenCalled();
    expect(s.createHost).not.toHaveBeenCalled();
    expect(s.fake.calls).toEqual([]);
    expect(await readdir(s.runRoot)).toEqual([]);
    expect(s.saveEvidence).not.toHaveBeenCalled();
  });

  it("rejects the cancellation and still closes the host when the operation is aborted mid-execute", async () => {
    const s = await setup();
    s.fake.hangOn("executor");
    const controller = new AbortController();
    const running = s.run({ signal: controller.signal });
    const outcome = expect(running).rejects.toThrow("operation cancelled mid-execute");
    await s.fake.executorStarted;
    controller.abort(new Error("operation cancelled mid-execute"));
    await outcome;
    expect(s.calls).toEqual(["allocate", "execute", "close"]);
    expect(s.fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
    expect(await readdir(s.runRoot)).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  it("uploads UNKNOWN, never PASS, for a group that ran out of time", async () => {
    const s = await setup({ deadlineMs: 1_500 });
    s.fake.hangOn("executor");
    const result = await s.run();

    expect(s.calls).toEqual(["allocate", "execute", "close"]);
    expect(s.collect).not.toHaveBeenCalled();
    const group = evidenceOf(s.saved, s.runId);
    expect(group.groupRun).toMatchObject({ kind: "application", unavailableReason: "deadline-exceeded", actual: null,
      collection: { status: "UNKNOWN", reason: "deadline-exceeded" } });
    expect(JSON.stringify(group)).not.toContain("\"PASS\"");
    expect(evidenceOf(s.saved).payload.groupRuns[0]?.collection.status).toBe("UNKNOWN");
    expect(result.processStatus).toBe("FAILED");
    expect(s.fake.liveResources(`rovara.run=${s.runId}`)).toEqual([]);
  }, 20_000);

  it("never reports PASS for a run whose collector produced no qualification", async () => {
    const s = await setup();
    s.fake.onExecutor = s.okOutput;
    s.collect.mockReturnValueOnce({ collection: null, oracle: null, qualification: null, unavailableReason: "report digest does not match" });
    await s.run();
    expect(evidenceOf(s.saved, s.runId).groupRun).toMatchObject({ actual: null, collection: { status: "UNKNOWN", reason: "report digest does not match" } });
  });

  it("never constructs the docker host for a portable admission", async () => {
    const s = await setup();
    // Structurally the first thing a portable admission is: it passes the shared checks, then fails inside the portable path, never in the application one.
    const portableBytes = Buffer.from(JSON.stringify({ schemaVersion: "workflow-e2e-admission/v1", taskId: s.admission.taskId, operationId: s.admission.operationId,
      operationFence: s.admission.operationFence, workflowRevision: s.admission.workflowRevision, candidateDigest: s.admission.candidateDigest, round: {} }), "utf8");
    const portableSha = sha(portableBytes);
    const portableRead = vi.fn(async () => ({ totalBytes: portableBytes.byteLength, chunkBase64: portableBytes.toString("base64"), sha256: portableSha }));
    const invocation = WorkerInvocationSchema.parse({ ...s.invocation, payload: { ...s.invocation.payload, workflowE2EAdmission: { ...s.invocation.payload.workflowE2EAdmission,
      admissionRef: { key: `workflow-e2e-admissions/sha256/${portableSha}.json`, sha256: portableSha, byteLength: portableBytes.byteLength } } } });
    const construct = vi.fn(() => { throw new Error("the docker host must not be constructed"); });
    const touched = vi.fn(() => { throw new Error("portable admission must not touch the application runtime"); });
    const eager = { runRoot: s.runRoot, createHost: construct, git: { treeOf: touched, materializeInto: touched } } as unknown as WorkflowE2EApplicationRuntime;
    const lazy = vi.fn(() => eager);
    for (const application of [eager, lazy]) {
      const failure = await executeWorkflowE2EChecks({ invocation, readAdmission: portableRead, saveEvidence: s.saveEvidence, sourceRoot: "/workspace/runtime",
        evidenceRoot: "/evidence", application, candidateRepositoryRoot: touched } as Parameters<typeof executeWorkflowE2EChecks>[0]).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toMatch(/application/i);
    }
    expect(portableRead).toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
    expect(touched).not.toHaveBeenCalled();
    expect(lazy).not.toHaveBeenCalled();
    expect(s.saveEvidence).not.toHaveBeenCalled();
  });

  it("fails closed when no application runtime is configured, without falling back to the portable path", async () => {
    const s = await setup();
    await expect(executeWorkflowE2EChecks({ invocation: s.invocation, readAdmission: s.readAdmission, saveEvidence: s.saveEvidence, sourceRoot: "/workspace/runtime",
      evidenceRoot: "/evidence" })).rejects.toThrow(/application runtime/);
    expect(s.saveEvidence).not.toHaveBeenCalled();
    expect(s.fake.calls).toEqual([]);
  });

  it("refuses an admission that is not the signed invocation's, before anything runs", async () => {
    const s = await setup();
    const other = WorkerInvocationSchema.parse({ ...s.invocation, payload: { ...s.invocation.payload, workflowE2EAdmission: { ...s.invocation.payload.workflowE2EAdmission, groupRunIds: [randomUUID()] } } });
    await expect(executeWorkflowE2EChecks({ invocation: other, readAdmission: s.readAdmission, saveEvidence: s.saveEvidence, sourceRoot: "/workspace/runtime",
      evidenceRoot: "/evidence", application: { runRoot: s.runRoot, createHost: s.createHost, git: { treeOf: s.treeOf, materializeInto: s.materializeInto } },
      candidateRepositoryRoot: () => s.repositoryRoot } as Parameters<typeof executeWorkflowE2EChecks>[0])).rejects.toThrow(/signed CHECKS invocation/);
    expect(s.treeOf).not.toHaveBeenCalled();
    expect(s.createHost).not.toHaveBeenCalled();
  });

  it("refuses a staged tree that differs from the approved build source manifest", async () => {
    const s = await setup();
    s.materializeInto.mockImplementationOnce(async (_root: string, _sha: string, destination: string) => {
      for (const source of s.admission.sourceSnapshot.sources) {
        await mkdir(dirname(join(destination, source.path)), { recursive: true });
        await writeFile(join(destination, source.path), Buffer.from(source.bytesBase64, "base64"));
      }
      await writeFile(join(destination, "extra.js"), "process.exit(0)");
      return [];
    });
    await expect(s.run()).rejects.toThrow(/approved build source/);
    expect(s.createHost).not.toHaveBeenCalled();
    expect(s.fake.calls).toEqual([]);
    expect(await readdir(s.runRoot)).toEqual([]);
  });

  it("keeps every group deadline strictly below the stale-run sweep age", async () => {
    const s = await setup();
    for (const group of s.admission.groups) {
      const binding = group.outerBinding;
      expect(Date.parse(binding.deadlineAt) - Date.parse(binding.admittedAt)).toBeLessThan(STALE_RUN_SWEEP_AGE_MS);
    }
    // No admissible round can outlive the sweep: the hard run limit, plus the host's grace past a deadline, is itself below the sweep age.
    expect(E2E_HARD_LIMITS.runTimeoutMs + DEFAULT_DEADLINE_GRACE_MS).toBeLessThan(STALE_RUN_SWEEP_AGE_MS);
    expect(s.admission.policy.limits.runTimeoutMs).toBeLessThanOrEqual(E2E_HARD_LIMITS.runTimeoutMs);
  });

  it("refuses, instead of using the worker's own directory, when the admitted repository is not on this worker", async () => {
    const s = await setup();
    const asked: string[] = [];
    await expect(s.run({ candidateRepositoryRoot: (repositoryId) => { asked.push(repositoryId); return undefined; } })).rejects.toThrow("native E2E application candidate repository is not on this worker");
    expect(asked).toEqual([s.admission.sourceSnapshot.candidate.repositories[0]!.repositoryId]);
    expect(s.treeOf).not.toHaveBeenCalled();
    expect(s.createHost).not.toHaveBeenCalled();
    expect(s.fake.calls).toEqual([]);
    // Nor does a worker that offers no repository lookup at all fall back to its runtime root.
    await expect(executeWorkflowE2EChecks({ invocation: s.invocation, readAdmission: s.readAdmission, saveEvidence: s.saveEvidence, sourceRoot: "/workspace/runtime",
      evidenceRoot: "/evidence", application: { runRoot: s.runRoot, createHost: s.createHost, git: { treeOf: s.treeOf, materializeInto: s.materializeInto } },
    })).rejects.toThrow("candidate repository is not on this worker");
    expect(s.treeOf).not.toHaveBeenCalled();
  });

  it("retries a round whose staging directory a crash left behind", async () => {
    const s = await setup();
    s.fake.onExecutor = s.okOutput;
    const leftover = join(s.runRoot, `candidate-${s.admission.round.roundId}`);
    await mkdir(join(leftover, "src"), { recursive: true });
    await writeFile(join(leftover, "src", "stale.js"), "from the crashed attempt");
    await s.run();
    expect(s.calls).toEqual(["allocate", "execute", "close"]);
    expect(await readdir(s.runRoot)).toEqual([]);
  });

  it("refuses a round whose deadline is further away than the hard run limit, whatever its admittedAt says", async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse(s.admission.round.admittedAt) - E2E_HARD_LIMITS.runTimeoutMs);
      await expect(s.run()).rejects.toThrow(/hard run limit/);
    } finally { vi.useRealTimers(); }
    expect(s.treeOf).not.toHaveBeenCalled();
    expect(s.createHost).not.toHaveBeenCalled();
  });
});
