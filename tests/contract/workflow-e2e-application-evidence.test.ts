import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES, WorkerInvocationSchema, type E2EApplicationExecutionAdmission } from "@agentx/contracts";
import { createDockerApplicationHost, type DockerApplicationHost } from "../../packages/verifier/src/host/docker-application-host.js";
import { encodeE2EApplicationExecutionAdmission } from "../../packages/verifier/src/application-scenarios.js";
import { executeWorkflowE2EChecks } from "../../packages/worker/src/workflow-e2e-checks.js";
import { DIAGNOSTICS_NOTICE } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import type { CandidateGit } from "../../packages/worker/src/e2e-candidate-source.js";
import type { WorkflowE2EApplicationRuntime } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { createApplicationEvidenceFixture } from "../support/e2e-application-evidence-fixture.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { FakeDockerCli, writeExecutorOutput } from "../support/fake-docker-cli.js";

// Task 3.6: what the group evidence keeps of a run's raw output, and what it drops when the cap is tight. The captures are the operator's; the verdict inputs are never traded for them.
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const PASSWORD = "planted-Password-7f3a91c2d4e8b0aa";
const screenshot = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 0x41)]);
const traceZip = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(3000, 0x42)]);
const captureFiles = [
  { name: "case-0-screenshot.jpg", sha256: sha(screenshot), bytes: new Uint8Array(screenshot) },
  { name: "case-0-trace.zip", sha256: sha(traceZip), bytes: new Uint8Array(traceZip) },
];
const captureArtifacts = [
  { caseId: "case-a", kind: "screenshot", sha256: sha(screenshot), bytes: screenshot.byteLength },
  { caseId: "case-a", kind: "trace", sha256: sha(traceZip), bytes: traceZip.byteLength },
];
const observation = { ref: { artifactId: "ev-1-0001-abcdef012345", sha256: sha(Buffer.from('{"o":1}')), byteLength: 7, mediaType: "application/json" }, bytes: new Uint8Array(Buffer.from('{"o":1}')) };
const executorEvidence = (overrides: object = {}) => ({ executorLogHead: new Uint8Array(Buffer.from("2026-10-20T00:00:00.000Z waiting for the application\n")),
  captures: { artifacts: captureArtifacts, files: captureFiles }, ...overrides });

type Assembled = Record<string, unknown>;
const baseRun = (extra: Assembled = {}): Assembled => ({ protocol: "e2e-actual-application-run/v1", cleanupConfirmed: true, cleanupServerListening: false,
  supervisorReadback: { marker: "assembled", evidence: [observation] },
  shards: [{ shardId: "shard-a", launchId: "00000000-0000-4000-8000-000000000001", rawReportBytes: new Uint8Array(Buffer.from('{"run":{"status":"failed"}}')), runStderrBytes: new Uint8Array() }],
  executorEvidence: executorEvidence(), ...extra });

async function setup(options: { assembled?: Assembled } = {}) {
  const fake = new FakeDockerCli();
  const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", taskId: TASK_ID });
  const admission: E2EApplicationExecutionAdmission = fixture.plan.admission;
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
  const saved: Array<{ bytes: Buffer; groupRunId: string | undefined; maxBytes: number }> = [];
  const saveEvidence = vi.fn(async (bytes: Uint8Array, digest: string, maxBytes: number, groupRunId?: string) => {
    saved.push({ bytes: Buffer.from(bytes), groupRunId, maxBytes });
    return { key: `workflow-e2e-${groupRunId === undefined ? "evidence" : "group-evidence"}/sha256/${digest}.json`, sha256: digest };
  });
  const runRoot = await temp("evidence-run-root-");
  const evidenceRoot = await temp("evidence-evidence-");
  const repositoryRoot = await temp("evidence-repository-");
  const git: CandidateGit = { treeOf: vi.fn(async () => admission.candidateTreeSha),
    materializeInto: vi.fn(async (_root, _commitSha, destination) => {
      for (const source of admission.sourceSnapshot.sources) {
        const path = join(destination, source.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(source.bytesBase64, "base64"));
      }
      return [];
    }) };
  const createHost = vi.fn((input: Parameters<WorkflowE2EApplicationRuntime["createHost"]>[0]): DockerApplicationHost => createDockerApplicationHost({ ...input, docker: fake,
    executorImage: "rovara-executor:test", buildImage: "node:build-test", runRoot, now: () => Date.now(), appPollMs: 10, deadlineGraceMs: 60,
    assemble: (() => options.assembled ?? baseRun()) as never, assembleCollectionInputs: (() => ({ marker: "collection-inputs" })) as never }));
  type Qualification = { status: "PASS" | "FAILED" | "UNKNOWN"; reason: string; runId: string | null; rawReportSha256: string | null; result: null };
  const qualified = (status: Qualification["status"] = "FAILED"): Qualification => ({ status, reason: "x", runId: null, rawReportSha256: null, result: null });
  const collect = vi.fn<(input: unknown) => { collection: unknown; oracle: unknown; unavailableReason: string | null; qualification: Qualification | null }>(
    () => ({ collection: { marker: "wire-collection" }, oracle: {}, unavailableReason: null, qualification: qualified() }));
  const application = { runRoot, createHost, git, collect } as unknown as WorkflowE2EApplicationRuntime;
  const run = () => executeWorkflowE2EChecks({ invocation, readAdmission, saveEvidence, sourceRoot: "/workspace/runtime", evidenceRoot,
    candidateRepositoryRoot: () => repositoryRoot, application });
  const runId = admission.groups[0]!.outerBinding.runId; const groupId = admission.groups[0]!.outerBinding.groupId;
  fake.onExecutor = (outDir: string) => writeExecutorOutput(outDir, { exitCode: 0, reason: null, runId, groupId });
  return { fake, saved, collect, run, runId, qualified };
}

type OperatorEvidence = { notice: string; rawReportIn: string | null; observationsIn: string | null; observations: Array<{ artifactId: string; sha256: string; byteLength: number; mediaType: string; contentBase64: string | null }>;
  executorLogHead: string | null; captures: { artifacts: Array<Record<string, unknown>>; files: Array<{ name: string; sha256: string; bytes: number; base64: string }> } | null };
const groupOf = (s: Awaited<ReturnType<typeof setup>>) => JSON.parse(s.saved.find((item) => item.groupRunId === s.runId)!.bytes.toString("utf8")).groupRun as
  { operatorEvidence: OperatorEvidence | null; diagnostics: { shardReports?: unknown[] } | null; actual: unknown; collection: { status: string; reason: string }; unavailableReason: string | null };

describe("raw evidence and captures in group evidence", () => {
  it("keeps the executor log head and the captures for a FAILED group, next to its verdict inputs", async () => {
    const s = await setup();
    await s.run();
    const group = groupOf(s);
    expect(group.collection.status).toBe("FAILED");
    expect(group.actual).toMatchObject({ collection: { marker: "wire-collection" } });
    expect(group.operatorEvidence).toMatchObject({ notice: DIAGNOSTICS_NOTICE, rawReportIn: "collection", observationsIn: "collection", observations: [] });
    expect(group.operatorEvidence!.executorLogHead).toContain("waiting for the application");
    expect(group.operatorEvidence!.captures!.artifacts).toEqual(captureArtifacts);
    expect(group.operatorEvidence!.captures!.files.map((file) => [file.name, file.sha256, file.bytes, Buffer.from(file.base64, "base64").equals(file.name.endsWith(".jpg") ? screenshot : traceZip)]))
      .toEqual([["case-0-screenshot.jpg", sha(screenshot), screenshot.byteLength, true], ["case-0-trace.zip", sha(traceZip), traceZip.byteLength, true]]);
    expect(group.diagnostics).toBeNull();
  });

  it("keeps the executor log head and the captures for a PASS group too (the log is raw evidence whatever the verdict)", async () => {
    const s = await setup();
    s.collect.mockReturnValue({ collection: { marker: "wire-collection" }, oracle: {}, unavailableReason: null, qualification: s.qualified("PASS") });
    await s.run();
    expect(groupOf(s).operatorEvidence!.executorLogHead).toContain("waiting for the application");
  });

  it("a qualified group's evidence contains report.json and the observations themselves, as the collector's own result", async () => {
    // The real collector's output for a real run: the raw report bytes and the supervisor readback that holds every observation.
    const fixture = await createApplicationEvidenceFixture({ probe: "api-egress-denial-v1", observed: { kind: "http-status", status: 200 } });
    const collected = (fixture.groupRun.actual as { collection: { shards: Array<{ rawReport: { bytesBase64: string } }>; supervisorReadback: { evidence: Array<{ ref: { artifactId: string }; bytesBase64: string }> } } }).collection;
    expect(collected.shards).toHaveLength(1);
    expect(collected.shards[0]!.rawReport.bytesBase64).toBe(Buffer.from(fixture.reportBytes).toString("base64"));
    expect(collected.supervisorReadback.evidence.length).toBeGreaterThan(0);
    expect(collected.supervisorReadback.evidence.every((item) => item.bytesBase64.length > 0)).toBe(true);
    // The worker names where that evidence is, and does not copy it a second time.
    const s = await setup();
    s.collect.mockReturnValue({ collection: fixture.collected.collection, oracle: {}, unavailableReason: null, qualification: s.qualified("PASS") });
    await s.run();
    const group = groupOf(s);
    expect(group.operatorEvidence).toMatchObject({ rawReportIn: "collection", observationsIn: "collection", observations: [] });
    expect(group.actual).toMatchObject({ collection: { shards: [{ rawReport: expect.anything() }], supervisorReadback: expect.anything() } });
  });

  it("copies the observations itself for a group that never reached a qualification, and points at diagnostics for its raw report", async () => {
    const s = await setup();
    s.collect.mockImplementationOnce(() => { throw new Error("report digest does not match"); });
    await s.run();
    const group = groupOf(s);
    expect(group.collection).toMatchObject({ status: "UNKNOWN", reason: "report digest does not match" });
    expect(group.diagnostics!.shardReports).toHaveLength(1);
    expect(group.operatorEvidence).toMatchObject({ rawReportIn: "diagnostics.shardReports", observationsIn: "operatorEvidence.observations" });
    expect(group.operatorEvidence!.observations).toEqual([{ artifactId: observation.ref.artifactId, sha256: observation.ref.sha256, byteLength: 7, mediaType: "application/json",
      contentBase64: Buffer.from('{"o":1}').toString("base64") }]);
    // Not a second copy of the raw report: that is in diagnostics.shardReports alone.
    expect(JSON.stringify(group.operatorEvidence)).not.toContain(Buffer.from('{"run":{"status":"failed"}}').toString("base64"));
  });

  it("keeps no operator evidence for a run that produced none (a fake host with no executor output)", async () => {
    const s = await setup({ assembled: { protocol: "e2e-actual-application-run/v1", cleanupConfirmed: true, cleanupServerListening: false, supervisorReadback: { marker: "assembled" } } });
    await s.run();
    expect(groupOf(s).operatorEvidence).toBeNull();
  });

  it("keeps no file for a capture the executor dropped, and lists the drop", async () => {
    const dropped = [{ caseId: "case-a", kind: "trace", sha256: sha(traceZip), bytes: traceZip.byteLength, omitted: "credential-match" }];
    const s = await setup({ assembled: baseRun({ executorEvidence: executorEvidence({ captures: { artifacts: dropped, files: [] } }) }) });
    await s.run();
    expect(groupOf(s).operatorEvidence!.captures).toEqual({ artifacts: dropped, files: [] });
  });

  it("holds the executor log head to 64 KiB", async () => {
    const s = await setup({ assembled: baseRun({ executorEvidence: executorEvidence({ executorLogHead: new Uint8Array(Buffer.alloc(200_000, 0x61)) }) }) });
    await s.run();
    expect(Buffer.byteLength(groupOf(s).operatorEvidence!.executorLogHead!)).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("when the group cap is tight, the capture goes and the verdict inputs stay", () => {
  /** What a group may hold: its ceiling less the room the aggregate keeps for its own envelope, and how much the plain evidence of an empty-capture run already takes. */
  async function measure() {
    const probe = await setup({ assembled: baseRun({ executorEvidence: executorEvidence({ captures: null }) }) });
    await probe.run();
    const saved = probe.saved.find((item) => item.groupRunId === probe.runId)!;
    return { limit: saved.maxBytes, room: saved.maxBytes - 1024 * 1024, baseBytes: saved.bytes.byteLength };
  }
  const capturesOf = (items: Array<{ kind: "screenshot" | "trace"; size: number }>) => {
    const files = items.map((item) => { const bytes = Buffer.alloc(item.size, item.kind === "trace" ? 0x44 : 0x43);
      return { name: `case-0-${item.kind}.${item.kind === "trace" ? "zip" : "jpg"}`, sha256: sha(bytes), bytes: new Uint8Array(bytes) }; });
    const artifacts = items.map((item, index) => ({ caseId: "case-a", kind: item.kind, sha256: files[index]!.sha256, bytes: item.size }));
    return { files, artifacts };
  };

  it("drops the trace first, then the screenshots, recording each as budget, and leaves the verdict and its inputs untouched", async () => {
    const { limit, room, baseBytes } = await measure();
    expect(limit).toBeLessThanOrEqual(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES);
    const captures = capturesOf([{ kind: "screenshot", size: 400_000 }, { kind: "trace", size: 900_000 }]);
    // 700,000 bytes of room beyond the plain evidence: the screenshot (about 534,000 as base64) fits, the screenshot and the trace together (about 1,734,000) do not.
    const collection = { marker: "x".repeat(room - baseBytes - 700_000) };
    const s = await setup({ assembled: baseRun({ executorEvidence: executorEvidence({ captures }) }) });
    s.collect.mockReturnValue({ collection, oracle: {}, unavailableReason: null, qualification: s.qualified("FAILED") });
    await s.run();
    const group = groupOf(s);
    expect(group.operatorEvidence!.captures!.files.map((file) => file.name)).toEqual(["case-0-screenshot.jpg"]);
    expect(group.operatorEvidence!.captures!.artifacts).toEqual([captures.artifacts[0], { ...captures.artifacts[1], omitted: "budget" }]);
    expect(group.collection).toMatchObject({ status: "FAILED" });
    expect(group.unavailableReason).toBeNull();
    expect(group.actual).toMatchObject({ collection });
  });

  it("drops every capture before it drops any verdict input", async () => {
    const { limit, room, baseBytes } = await measure();
    const captures = capturesOf([{ kind: "screenshot", size: 600_000 }]);
    const collection = { marker: "x".repeat(room - baseBytes - 300_000) };
    const s = await setup({ assembled: baseRun({ executorEvidence: executorEvidence({ captures }) }) });
    s.collect.mockReturnValue({ collection, oracle: {}, unavailableReason: null, qualification: s.qualified("FAILED") });
    await s.run();
    const group = groupOf(s);
    expect(group.operatorEvidence!.captures).toEqual({ artifacts: [{ ...captures.artifacts[0], omitted: "budget" }], files: [] });
    expect(group.actual).toMatchObject({ collection });
    expect(group.collection).toMatchObject({ status: "FAILED" });
    expect(group.unavailableReason).toBeNull();
    expect(s.saved.find((item) => item.groupRunId === s.runId)!.bytes.byteLength).toBeLessThanOrEqual(limit - 1024 * 1024);
  });

  it("keeps the captures when they fit", async () => {
    const { room, baseBytes } = await measure();
    const captures = capturesOf([{ kind: "screenshot", size: 100_000 }, { kind: "trace", size: 200_000 }]);
    const s = await setup({ assembled: baseRun({ executorEvidence: executorEvidence({ captures }) }) });
    s.collect.mockReturnValue({ collection: { marker: "x".repeat(room - baseBytes - 900_000) }, oracle: {}, unavailableReason: null, qualification: s.qualified("FAILED") });
    await s.run();
    expect(groupOf(s).operatorEvidence!.captures).toEqual({ artifacts: captures.artifacts, files: captures.files.map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes.byteLength,
      base64: Buffer.from(file.bytes).toString("base64") })) });
  });

  it("only when the verdict inputs alone are over the cap is the group UNKNOWN 'evidence too large' (unchanged)", async () => {
    const { limit } = await measure();
    const s = await setup();
    s.collect.mockReturnValue({ collection: { marker: "x".repeat(limit + 1024) }, oracle: {}, unavailableReason: null, qualification: s.qualified("PASS") });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try { await s.run(); } finally { log.mockRestore(); }
    const group = groupOf(s);
    expect(group).toMatchObject({ unavailableReason: "evidence too large", actual: null });
    expect(group.operatorEvidence).toBeNull();
  });
});

describe("no stored byte carries a credential", () => {
  it("never stores a password, whatever else the captures hold, when the host has already held back the file that carried it", async () => {
    // The host's snapshot excludes a capture file that carries the run's credential; what reaches the worker is the listing with the drop recorded.
    const clean = [{ caseId: "case-a", kind: "trace", sha256: sha(Buffer.from(PASSWORD)), bytes: PASSWORD.length, omitted: "credential-match" }];
    const s = await setup({ assembled: baseRun({ executorEvidence: executorEvidence({ captures: { artifacts: clean, files: [] } }) }) });
    await s.run();
    for (const item of s.saved) expect(item.bytes.toString("utf8")).not.toContain(PASSWORD);
  });
});
