import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2E_HARD_LIMITS, WorkerInvocationSchema, canonicalJson, e2eModelRouteRevision, type E2EApplicationExecutionAdmission, type E2EModelDayBudgetRequest } from "@agentx/contracts";
import { createDockerApplicationHost, DEFAULT_DEADLINE_GRACE_MS, STALE_RUN_SWEEP_AGE_MS, type DockerApplicationHost } from "../../packages/verifier/src/host/docker-application-host.js";
import { encodeE2EApplicationExecutionAdmission } from "../../packages/verifier/src/application-scenarios.js";
import { executeWorkflowE2EChecks } from "../../packages/worker/src/workflow-e2e-checks.js";
import { DIAGNOSTICS_NOTICE, createEvidenceBudget } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES, E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES } from "@agentx/contracts";
import type { CandidateGit } from "../../packages/worker/src/e2e-candidate-source.js";
import type { WorkflowE2EApplicationRuntime } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { createE2EModelChannelClient } from "../../packages/verifier/src/executor/model-channel.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { FakeDockerCli, writeExecutorOutput } from "../support/fake-docker-cli.js";

const TASK_ID = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const assembledRun = { protocol: "e2e-actual-application-run/v1", cleanupConfirmed: true, cleanupServerListening: false, supervisorReadback: { marker: "assembled" } };
const collectionInputs = { marker: "collection-inputs" };

async function setup(options: { deadlineMs?: number; treeSha?: string; fake?: FakeDockerCli; assembled?: object;
  /** Task 4.3a: pins this route in the policy and the admission; with `agent`, the case also has an AI navigation step. */
  route?: { routeId: string; routeRevision: string }; agent?: boolean;
  /** What the invocation's reference says besides the admission it names (agentSteps, purpose, base commit, attempt). */
  reference?: Record<string, unknown>;
  /** Marks the admission itself as a baseline round (re-signed), as the broker's baseline admission is. */
  baseline?: boolean } = {}) {
  const fake = options.fake ?? new FakeDockerCli();
  const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", taskId: TASK_ID, ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.route === undefined ? {} : { modelRoute: options.route }),
    ...(options.agent === true ? { accountScenarios: [{ accountProfileId: "orders-owner", scenario: (targetId: string) => ({ scenarioId: "agent-export", requirementId: "orders-export", requestedTargetIds: [targetId], required: true,
      accountProfileId: "orders-owner", minimumEvidence: "runtime" as const, requiredRealComponentIds: [], steps: [{ kind: "agent" as const, goal: "Export the orders as a CSV file", maxActions: 4 }],
      assertions: [{ kind: "csv" as const, downloadName: "orders.csv", columns: ["id", "total"], rows: [["1", "10"]] }] }) }] } : {}) });
  const signed = options.baseline === true
    ? (() => { const { admissionDigest: _digest, ...body } = fixture.plan.admission; void _digest; const withBaseline = { ...body, baseline: { purpose: "baseline" as const, baseCommitSha: fixture.plan.admission.candidateCommitSha, attempt: 1 } };
      return { ...withBaseline, admissionDigest: sha(Buffer.from(canonicalJson(withBaseline), "utf8")) } as unknown as E2EApplicationExecutionAdmission; })()
    : fixture.plan.admission;
  const admission: E2EApplicationExecutionAdmission = signed;
  const admissionBytes = Buffer.from(encodeE2EApplicationExecutionAdmission(admission), "utf8");
  const admissionSha = sha(admissionBytes);
  const invocation = WorkerInvocationSchema.parse({
    protocolVersion: 1, kind: "task", operationId: admission.operationId, workspaceId: "22222222-2222-4222-8222-222222222222", fence: admission.operationFence,
    projectRevision: 1, callbackCapability: "c".repeat(32),
    payload: { conversationId: "33333333-3333-4333-8333-333333333333", prompt: "Run the approved E2E checks.", workflowMode: "CHECKS",
      readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 }],
      workflowE2EAdmission: { schemaVersion: 1, kind: "application", taskId: admission.taskId, workflowRevision: admission.workflowRevision, candidateDigest: admission.candidateDigest,
        roundId: admission.round.roundId, groupRunIds: admission.groups.map((group) => group.outerBinding.runId),
        admissionRef: { key: `workflow-e2e-admissions/sha256/${admissionSha}.json`, sha256: admissionSha, byteLength: admissionBytes.byteLength },
        ...(options.agent === true ? { agentSteps: true } : {}), ...options.reference } },
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
  // A unix socket path is short (about 100 bytes), so a round with a model channel runs in a short root.
  const runRoot = options.route === undefined ? await temp("application-run-root-") : await realpath(await mkdtemp(join("/tmp", "rr-")));
  if (options.route !== undefined) roots.push(runRoot);
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
      appPollMs: 10, deadlineGraceMs: 60, assemble: (() => options.assembled ?? assembledRun) as never, assembleCollectionInputs: (() => collectionInputs) as never });
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
  const run = (extra: { signal?: AbortSignal; deadlineAt?: number; candidateRepositoryRoot?: (repositoryId: string) => string | undefined; application?: WorkflowE2EApplicationRuntime | (() => WorkflowE2EApplicationRuntime);
    modelBudget?: Parameters<typeof executeWorkflowE2EChecks>[0]["modelBudget"]; modelChannel?: Parameters<typeof executeWorkflowE2EChecks>[0]["modelChannel"] } = {}) => executeWorkflowE2EChecks({
    invocation, readAdmission, saveEvidence, sourceRoot: "/workspace/runtime", evidenceRoot, candidateRepositoryRoot: extra.candidateRepositoryRoot ?? (() => repositoryRoot),
    application: extra.application ?? application, ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    ...(extra.deadlineAt === undefined ? {} : { deadlineAt: extra.deadlineAt }),
    ...(extra.modelBudget === undefined ? {} : { modelBudget: extra.modelBudget }), ...(extra.modelChannel === undefined ? {} : { modelChannel: extra.modelChannel }),
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

const withoutKind = (reference: object | undefined) => Object.fromEntries(Object.entries(reference ?? {}).filter(([key]) => key !== "kind"));

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

  describe("evidence when a group ends without a qualification", () => {
    const shardRun = (shardId: string, report: Buffer) => ({ shardId, launchId: randomUUID(), rawReportBytes: new Uint8Array(report), runStderrBytes: new Uint8Array(Buffer.from("stderr")) });
    const diagnosticsOf = (s: Awaited<ReturnType<typeof setup>>) => evidenceOf(s.saved, s.runId).groupRun.diagnostics as { notice?: string; shardReports?: Array<{ shardId: string; byteLength: number; truncated: boolean; rawReportBase64: string }> };

    it("keeps each shard's raw report, base64 and bounded, when the collector throws", async () => {
      const first = Buffer.from(JSON.stringify({ run: { status: "passed" } }));
      const second = Buffer.alloc(300_000, "r");
      const s = await setup({ assembled: { ...assembledRun, shards: [shardRun("shard-a", first), shardRun("shard-b", second)] } });
      s.fake.onExecutor = s.okOutput;
      s.collect.mockImplementationOnce(() => { throw new Error("report digest does not match"); });
      await s.run();
      expect(evidenceOf(s.saved, s.runId).groupRun).toMatchObject({ actual: null, collection: { status: "UNKNOWN", reason: "report digest does not match" } });
      const reports = diagnosticsOf(s).shardReports!;
      expect(reports.map((report) => report.shardId)).toEqual(["shard-a", "shard-b"]);
      expect(Buffer.from(reports[0]!.rawReportBase64, "base64").equals(first)).toBe(true);
      expect(reports[0]).toMatchObject({ byteLength: first.byteLength, truncated: false });
      // The report is kept as far as a bound, never whole: the head of the bytes, with its true length and that it was cut.
      expect(reports[1]).toMatchObject({ byteLength: second.byteLength, truncated: true });
      const kept = Buffer.from(reports[1]!.rawReportBase64, "base64");
      expect(kept.byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(kept.byteLength).toBeGreaterThan(0);
      expect(kept.equals(second.subarray(0, kept.byteLength))).toBe(true);
    });

    it("labels the diagnostics as the application's own output, for operators only, and keeps at most eight shards", async () => {
      const shards = Array.from({ length: 10 }, (_, index) => shardRun(`shard-${index}`, Buffer.from(`report-${index}`)));
      const s = await setup({ assembled: { ...assembledRun, shards } });
      s.fake.onExecutor = s.okOutput;
      s.collect.mockImplementationOnce(() => { throw new Error("report digest does not match"); });
      await s.run();
      const diagnostics = diagnosticsOf(s);
      expect(diagnostics.notice).toBe(DIAGNOSTICS_NOTICE);
      expect(DIAGNOSTICS_NOTICE).toMatch(/application's own output/);
      expect(DIAGNOSTICS_NOTICE).toMatch(/operator/);
      expect(diagnostics.shardReports).toHaveLength(8);
    });

    it("keeps them too when the collector answers unavailable, and keeps nothing for a group that was qualified", async () => {
      const report = Buffer.from("raw-report");
      const unavailable = await setup({ assembled: { ...assembledRun, shards: [shardRun("shard-a", report)] } });
      unavailable.fake.onExecutor = unavailable.okOutput;
      unavailable.collect.mockReturnValueOnce({ collection: null, oracle: null, qualification: null, unavailableReason: "report digest does not match" });
      await unavailable.run();
      expect(diagnosticsOf(unavailable).shardReports).toHaveLength(1);
      const qualified = await setup({ assembled: { ...assembledRun, shards: [shardRun("shard-a", report)] } });
      qualified.fake.onExecutor = qualified.okOutput;
      await qualified.run();
      expect(evidenceOf(qualified.saved, qualified.runId).groupRun.diagnostics).toBeNull();
    });
  });

  it("never constructs the docker host for a portable admission", async () => {
    const s = await setup();
    // Structurally the first thing a portable admission is: it passes the shared checks, then fails inside the portable path, never in the application one.
    const portableBytes = Buffer.from(JSON.stringify({ schemaVersion: "workflow-e2e-admission/v1", taskId: s.admission.taskId, operationId: s.admission.operationId,
      operationFence: s.admission.operationFence, workflowRevision: s.admission.workflowRevision, candidateDigest: s.admission.candidateDigest, round: {} }), "utf8");
    const portableSha = sha(portableBytes);
    const portableRead = vi.fn(async () => ({ totalBytes: portableBytes.byteLength, chunkBase64: portableBytes.toString("base64"), sha256: portableSha }));
    const invocation = WorkerInvocationSchema.parse({ ...s.invocation, payload: { ...s.invocation.payload, workflowE2EAdmission: { ...withoutKind(s.invocation.payload.workflowE2EAdmission),
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

  describe("the reference's kind against the admission it names", () => {
    const runtimeOf = (s: Awaited<ReturnType<typeof setup>>) => ({ runRoot: s.runRoot, createHost: s.createHost, git: { treeOf: s.treeOf, materializeInto: s.materializeInto } });
    const execute = (s: Awaited<ReturnType<typeof setup>>, invocation: unknown, readAdmission: Awaited<ReturnType<typeof setup>>["readAdmission"]) => executeWorkflowE2EChecks({ invocation, readAdmission,
      saveEvidence: s.saveEvidence, sourceRoot: "/workspace/runtime", evidenceRoot: "/evidence", application: runtimeOf(s), candidateRepositoryRoot: () => s.repositoryRoot } as Parameters<typeof executeWorkflowE2EChecks>[0]);

    it("refuses an application admission whose reference does not say it is one, before anything runs", async () => {
      const s = await setup();
      const unmarked = WorkerInvocationSchema.parse({ ...s.invocation, payload: { ...s.invocation.payload, workflowE2EAdmission: withoutKind(s.invocation.payload.workflowE2EAdmission) } });
      await expect(execute(s, unmarked, s.readAdmission)).rejects.toThrow(/reference kind/);
      expect(s.treeOf).not.toHaveBeenCalled();
      expect(s.createHost).not.toHaveBeenCalled();
      expect(s.saveEvidence).not.toHaveBeenCalled();
    });

    it("refuses a portable admission whose reference says it is an application one, before anything runs", async () => {
      const s = await setup();
      const portableBytes = Buffer.from(JSON.stringify({ schemaVersion: "workflow-e2e-admission/v1", taskId: s.admission.taskId }), "utf8");
      const portableSha = sha(portableBytes);
      const marked = WorkerInvocationSchema.parse({ ...s.invocation, payload: { ...s.invocation.payload, workflowE2EAdmission: { ...s.invocation.payload.workflowE2EAdmission,
        admissionRef: { key: `workflow-e2e-admissions/sha256/${portableSha}.json`, sha256: portableSha, byteLength: portableBytes.byteLength } } } });
      const read = vi.fn(async () => ({ totalBytes: portableBytes.byteLength, chunkBase64: portableBytes.toString("base64"), sha256: portableSha }));
      await expect(execute(s, marked, read)).rejects.toThrow(/reference kind/);
      expect(s.createHost).not.toHaveBeenCalled();
      expect(s.saveEvidence).not.toHaveBeenCalled();
    });
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

// Task 4.3a, test case 10 (Rulings DB-1, DB-5, DD): which groups get a model channel, what the reference may say, and a route that is not the worker's.
describe("workflow E2E application rounds: the model channel", () => {
  const SCRIPTED = { routeId: "rovara-scripted/v1", routeRevision: e2eModelRouteRevision(scriptedE2ERouteDefinition()) };
  const STALE = { routeId: "rovara-e2e-default", routeRevision: "r1-0123456789ab" };
  const scriptedEnvironment = { ROVARA_E2E_SCRIPTED_MODEL: "1" };
  const budgetEvents = () => { const sent: E2EModelDayBudgetRequest[] = [];
    const post = vi.fn(async (body: E2EModelDayBudgetRequest) => { sent.push(body); return { schemaVersion: "rovara-e2e-model-budget/v1", reservationId: body.reservationId,
      status: body.stage === "reserve" ? "reserved" : body.stage === "settle" ? "settled" : "released" }; });
    return { sent, post }; };
  const modelDirOf = (s: { runRoot: string; runId: string }) => join(s.runRoot, s.runId, "model");

  it("gives a group with no agent step no channel and no socket, even though the admission names a route and the worker could open one (Ruling DB-1)", async () => {
    const budget = budgetEvents();
    const opened = vi.fn();
    const s = await setup({ route: SCRIPTED });
    s.fake.onExecutor = s.okOutput;
    expect(s.admission.modelRoute).toEqual(SCRIPTED);
    await s.run({ modelBudget: budget.post, modelChannel: { environment: scriptedEnvironment, invoke: async () => { opened(); throw new Error("not called"); } } });
    expect(s.createHost).toHaveBeenCalledTimes(1);
    expect(s.createHost.mock.calls[0]![0]).not.toHaveProperty("modelChannel");
    expect(budget.post).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(s.fake.argsFor("executor").join(" ")).not.toMatch(/model/i);
  });

  it("the reference's agentSteps must be exactly 'some group has an agent step': an agent admission whose reference omits it, and a plain one whose reference claims it, are refused before anything starts", async () => {
    const withAgent = await setup({ route: SCRIPTED, agent: true, reference: { agentSteps: undefined } });
    await expect(withAgent.run({ modelBudget: budgetEvents().post, modelChannel: { environment: scriptedEnvironment } })).rejects.toThrow(/agentSteps flag does not match/);
    expect(withAgent.createHost).not.toHaveBeenCalled();
    expect(withAgent.fake.calls).toEqual([]);
    const plain = await setup({ route: SCRIPTED, reference: { agentSteps: true } });
    await expect(plain.run({ modelBudget: budgetEvents().post, modelChannel: { environment: scriptedEnvironment } })).rejects.toThrow(/agentSteps flag does not match/);
    expect(plain.createHost).not.toHaveBeenCalled();
    // The positive control: the flag and the admission agree, and the round runs.
    const agreed = await setup({ route: SCRIPTED, agent: true });
    agreed.fake.onExecutor = agreed.okOutput;
    await expect(agreed.run({ modelBudget: budgetEvents().post, modelChannel: { environment: scriptedEnvironment, invoke: async () => { throw new Error("not called"); } } })).resolves.toMatchObject({ processStatus: "SUCCEEDED" });
  });

  it("refuses a baseline round that carries AI navigation steps or says it does (a baseline never runs them)", async () => {
    const base = { purpose: "baseline", attempt: 1 };
    const claimed = await setup({ route: SCRIPTED, agent: true, baseline: true, reference: { ...base, baseCommitSha: createOrdersExecutorPlan({ probe: "web-csv-positive-v1" }).plan.admission.candidateCommitSha } });
    await expect(claimed.run({ modelBudget: budgetEvents().post, modelChannel: { environment: scriptedEnvironment } })).rejects.toThrow(/baseline round carries AI navigation steps/);
    expect(claimed.createHost).not.toHaveBeenCalled();
    expect(claimed.fake.calls).toEqual([]);
    // The same baseline without agent steps and without the flag runs (the positive control).
    const plain = await setup({ baseline: true, reference: { ...base, baseCommitSha: createOrdersExecutorPlan({ probe: "web-csv-positive-v1" }).plan.admission.candidateCommitSha } });
    plain.fake.onExecutor = plain.okOutput;
    await expect(plain.run()).resolves.toMatchObject({ processStatus: "SUCCEEDED" });
  });

  it("makes a group UNKNOWN model-route-changed-reapprove, and starts no host, socket or container for it, when its route is not the one this worker derives", async () => {
    const budget = budgetEvents();
    const s = await setup({ route: STALE, agent: true });
    s.fake.onExecutor = s.okOutput;
    const result = await s.run({ modelBudget: budget.post, modelChannel: { environment: { AGENTX_MODEL_PROVIDER: "anthropic", AGENTX_ANTHROPIC_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/key-AbCdEf", AWS_REGION: "us-east-1" } } });
    expect(result.processStatus).toBe("FAILED");
    expect(s.createHost).not.toHaveBeenCalled();
    expect(s.fake.calls).toEqual([]);
    expect(budget.post).not.toHaveBeenCalled();
    expect(existsSync(modelDirOf(s))).toBe(false);
    const group = evidenceOf(s.saved, s.runId);
    expect(group.groupRun).toMatchObject({ kind: "application", binding: { runId: s.runId }, collection: { status: "UNKNOWN", reason: "model-route-changed-reapprove" },
      unavailableReason: "model-route-changed-reapprove", actual: null });
    expect(await readdir(s.runRoot)).toEqual([]);
  });

  it("makes a group UNKNOWN agent-route-not-approved when the worker has no model channel dependencies or a route it cannot make, and a scripted route outside CI the same", async () => {
    for (const modelChannel of [undefined, { environment: { AGENTX_MODEL_PROVIDER: "anthropic" } }, { environment: {} }]) {
      const s = await setup({ route: modelChannel === undefined || "AGENTX_MODEL_PROVIDER" in modelChannel.environment ? STALE : SCRIPTED, agent: true });
      const result = await s.run(modelChannel === undefined ? {} : { modelBudget: budgetEvents().post, modelChannel });
      expect(result.processStatus).toBe("FAILED");
      expect(s.createHost).not.toHaveBeenCalled();
      expect(evidenceOf(s.saved, s.runId).groupRun).toMatchObject({ collection: { status: "UNKNOWN", reason: "agent-route-not-approved" } });
    }
  });

  it("opens the channel for a group with an agent step before its executor starts: the executor sees a listening socket, the day is charged through the broker, and the socket is gone after", async () => {
    const budget = budgetEvents();
    const closed: Array<{ groupRunId: string; receipts: number; outcomes: Record<string, number> }> = [];
    const s = await setup({ route: SCRIPTED, agent: true });
    let seen: { isSocket: boolean; mounted: boolean; answer: unknown } | undefined;
    s.fake.onExecutor = async (outDir, args) => {
      const socketPath = join(s.runRoot, s.runId, "model", "model.sock");
      const client = createE2EModelChannelClient({ socketPath, runId: s.runId });
      const caseId = s.fixture.compiled.expectedCases[0]!.caseId;
      await client.beginStep({ caseId, stepIndex: 0 });
      const answer = await client.generate({ caseId, stepIndex: 0, callIndex: 0, call: { prompt: [{ role: "system", content: "You drive a web application." }, { role: "user", content: [{ type: "text", text: "Goal: Export the orders as a CSV file\n#n1 button \"Download orders\"" }] }],
        tools: [{ type: "function", name: "complete_step", inputSchema: { type: "object", properties: { status: { type: "string" }, summary: { type: "string" } } } }] } });
      await client.endStep({ caseId, stepIndex: 0 });
      seen = { isSocket: statSync(socketPath).isSocket(), mounted: args.includes(`${socketPath}:/run/rovara/model.sock`), answer };
      s.okOutput(outDir);
    };
    await s.run({ modelBudget: budget.post, modelChannel: { environment: scriptedEnvironment, policyScope: "standard", onClosed: (summary) => closed.push(summary),
      invoke: async () => ({ servedModelId: "rovara-scripted-v1", content: [{ type: "tool-call", toolCallId: "t1", toolName: "complete_step", input: JSON.stringify({ status: "passed", summary: "ok" }) }],
        finishReason: { unified: "tool-calls", raw: "scripted" }, usage: { inputTokens: 300, outputTokens: 20 } }) } });
    expect(seen).toMatchObject({ isSocket: true, mounted: true });
    expect((seen!.answer as { result: { status: string; code?: string; message?: string } }).result, JSON.stringify(seen!.answer)).toMatchObject({ status: "ok" });
    expect(budget.sent.map((body) => body.stage)).toEqual(["reserve", "settle"]);
    expect(budget.sent[0]).toMatchObject({ stage: "reserve", groupRunId: s.runId });
    expect(budget.sent[1]).toMatchObject({ stage: "settle", reservationId: budget.sent[0]!.reservationId, actualInputTokens: 300 });
    expect(closed).toEqual([{ groupRunId: s.runId, receipts: 1, outcomes: { ok: 1 } }]);
    expect(existsSync(join(s.runRoot, s.runId))).toBe(false);
  });

  it("closes the channel when the executor throws, and the socket is gone", async () => {
    const closed: unknown[] = [];
    const s = await setup({ route: SCRIPTED, agent: true });
    s.fake.onExecutor = () => { throw new Error("the executor blew up"); };
    const result = await s.run({ modelBudget: budgetEvents().post, modelChannel: { environment: scriptedEnvironment, onClosed: (summary) => closed.push(summary), invoke: async () => { throw new Error("not called"); } } });
    expect(result.processStatus).toBe("FAILED");
    expect(closed).toHaveLength(1);
    expect(existsSync(join(s.runRoot, s.runId))).toBe(false);
  });

  it("the worker logs only counts when a channel closes: never a prompt, an answer or a credential", async () => {
    const lines: string[] = [];
    let groupRunId: string | undefined;
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const s = await setup({ route: SCRIPTED, agent: true });
      groupRunId = s.runId;
      s.fake.onExecutor = s.okOutput;
      await s.run({ modelBudget: budgetEvents().post, modelChannel: { environment: scriptedEnvironment, invoke: async () => { throw new Error("not called"); } } });
    } finally { log.mockRestore(); }
    const closedLine = lines.find((line) => line.includes("workflow.e2e_model_channel_closed"));
    expect(JSON.parse(closedLine!)).toEqual({ component: "worker", event: "workflow.e2e_model_channel_closed", groupRunId, receipts: 0, outcomes: {},
      droppedRequests: 0, unscopedRequests: 0, overrun: false, evidenceErrors: 0 });
  });
});
