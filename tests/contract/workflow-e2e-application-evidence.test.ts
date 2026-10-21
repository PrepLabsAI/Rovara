import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES, WorkerInvocationSchema, type E2EApplicationExecutionAdmission } from "@agentx/contracts";
import { createDockerApplicationHost, type DockerApplicationHost } from "../../packages/verifier/src/host/docker-application-host.js";
import { encodeE2EApplicationExecutionAdmission } from "../../packages/verifier/src/application-scenarios.js";
import { executeWorkflowE2EChecks } from "../../packages/worker/src/workflow-e2e-checks.js";
import { DIAGNOSTICS_NOTICE, fitGroupEvidence, groupEvidenceShare, type GroupEvidenceCandidate, type OperatorEvidence as WorkerOperatorEvidence } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import type { CandidateGit } from "../../packages/worker/src/e2e-candidate-source.js";
import type { WorkflowE2EApplicationRuntime } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { createApplicationEvidenceFixture } from "../support/e2e-application-evidence-fixture.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { startApplicationRound } from "../support/e2e-application-round-harness.js";
import { FakeDockerCli, writeExecutorOutput } from "../support/fake-docker-cli.js";

// Task 3.6: what the group evidence keeps of a run's raw output, and what it drops when the cap is tight. The captures are the operator's; the verdict inputs are never traded for them.
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const PASSWORD = "planted-Password-7f3a91c2d4e8b0aa";
const screenshot = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 0x41)]);
const secondScreenshot = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 0x42)]);
const captureFiles = [
  { name: "case-0-screenshot.jpg", sha256: sha(screenshot), bytes: new Uint8Array(screenshot) },
  { name: "case-1-screenshot.jpg", sha256: sha(secondScreenshot), bytes: new Uint8Array(secondScreenshot) },
];
const captureArtifacts = [
  { caseId: "case-a", kind: "screenshot", sha256: sha(screenshot), bytes: screenshot.byteLength },
  { caseId: "case-b", kind: "screenshot", sha256: sha(secondScreenshot), bytes: secondScreenshot.byteLength },
];
const observation = { ref: { artifactId: "ev-1-0001-abcdef012345", sha256: sha(Buffer.from('{"o":1}')), byteLength: 7, mediaType: "application/json" }, bytes: new Uint8Array(Buffer.from('{"o":1}')) };
const executorEvidence = (overrides: object = {}) => ({ executorLogHead: new Uint8Array(Buffer.from("2026-10-20T00:00:00.000Z waiting for the application\n")),
  captures: { artifacts: captureArtifacts, files: captureFiles }, ...overrides });

type Assembled = Record<string, unknown>;
const baseRun = (extra: Assembled = {}): Assembled => ({ protocol: "e2e-actual-application-run/v1", cleanupConfirmed: true, cleanupServerListening: false,
  supervisorReadback: { marker: "assembled", evidence: [observation] },
  shards: [{ shardId: "shard-a", launchId: "00000000-0000-4000-8000-000000000001", rawReportBytes: new Uint8Array(Buffer.from('{"run":{"status":"failed"}}')), runStderrBytes: new Uint8Array() }],
  executorEvidence: executorEvidence(), ...extra });

/** A host whose run finished cleanly and whose readback is `run`: allocate, execute and close succeed at once. */
function standInHost(run: Assembled): DockerApplicationHost {
  const at = new Date().toISOString();
  return { allocate: async () => ({ leaseId: "stand-in", close: async () => ({ confirmed: true }),
    execute: async () => ({ process: { exitCode: 0, timedOut: false, aborted: false }, rawReport: null, observedUpstreamRunId: null, coverageByCase: new Map(), artifacts: [], modelReceiptIds: [],
      startedAt: at, finishedAt: at, cleanup: "confirmed" as const }) }),
  readActualRun: async () => run as never, readCollectionInputs: async () => ({ marker: "collection-inputs" }) as never,
  readDiagnostics: () => ({ appLogTail: "", buildLogTail: "", executorLogTail: "" }), readBuildResult: () => null };
}

async function setup(options: { assembled?: Assembled; admission?: E2EApplicationExecutionAdmission; standIn?: boolean;
  /** Holds one group back (its collection inputs are not read) until the promise settles, and tells the test when a group's evidence is saved. */
  hold?: { groupIndex: number; until: Promise<unknown> }; onSave?: (groupRunId: string | undefined) => void } = {}) {
  const fake = new FakeDockerCli();
  const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", taskId: TASK_ID });
  const admission: E2EApplicationExecutionAdmission = options.admission ?? fixture.plan.admission;
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
    options.onSave?.(groupRunId);
    return { key: `workflow-e2e-${groupRunId === undefined ? "evidence" : "group-evidence"}/sha256/${digest}.json`, sha256: digest };
  });
  const runRoot = await temp("evidence-run-root-");
  const evidenceRoot = await temp("evidence-evidence-");
  const repositoryRoot = await temp("evidence-repository-");
  const git: CandidateGit = { treeOf: vi.fn(async () => admission.candidateTreeSha),
    materializeInto: vi.fn<CandidateGit["materializeInto"]>(async (_root, _commitSha, destination) => {
      for (const source of admission.sourceSnapshot.sources) {
        const path = join(destination, String(source.path));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(source.bytesBase64, "base64"));
      }
      return [];
    }) };
  const createHost = vi.fn((input: Parameters<WorkflowE2EApplicationRuntime["createHost"]>[0]): DockerApplicationHost => {
    // A round of several applications has groups the docker host (one application per group) cannot run, so its groups run on a stand-in that answers as a finished run.
    const host = options.standIn === true ? standInHost(options.assembled ?? baseRun()) : createDockerApplicationHost({ ...input, docker: fake,
      executorImage: "rovara-executor:test", buildImage: "node:build-test", runRoot, now: () => Date.now(), appPollMs: 10, deadlineGraceMs: 60,
      assemble: (() => options.assembled ?? baseRun()) as never, assembleCollectionInputs: (() => ({ marker: "collection-inputs" })) as never });
    const held = options.hold !== undefined && admission.groups[options.hold.groupIndex]!.outerBinding.groupId === input.groupId;
    return held ? { ...host, readCollectionInputs: async (signal: AbortSignal) => { await options.hold!.until; return host.readCollectionInputs(signal); } } : host;
  });
  type Qualification = { status: "PASS" | "FAILED" | "UNKNOWN"; reason: string; runId: string | null; rawReportSha256: string | null; result: null };
  const qualified = (status: Qualification["status"] = "FAILED"): Qualification => ({ status, reason: "x", runId: null, rawReportSha256: null, result: null });
  const collect = vi.fn<(input: unknown) => { collection: unknown; oracle: unknown; unavailableReason: string | null; qualification: Qualification | null }>(
    () => ({ collection: { marker: "wire-collection" }, oracle: {}, unavailableReason: null, qualification: qualified() }));
  const application = { runRoot, createHost, git, collect } as unknown as WorkflowE2EApplicationRuntime;
  const run = () => executeWorkflowE2EChecks({ invocation, readAdmission, saveEvidence, sourceRoot: "/workspace/runtime", evidenceRoot,
    candidateRepositoryRoot: () => repositoryRoot, application });
  const runId = admission.groups[0]!.outerBinding.runId; const groupId = admission.groups[0]!.outerBinding.groupId;
  fake.onExecutor = (outDir: string) => {
    const group = admission.groups.find((item) => outDir.includes(item.outerBinding.runId)) ?? admission.groups[0]!;
    writeExecutorOutput(outDir, { exitCode: 0, reason: null, runId: group.outerBinding.runId, groupId: group.outerBinding.groupId });
  };
  return { fake, saved, collect, run, runId, groupId, admission, qualified };
}

type OperatorEvidence = { notice: string; rawReportIn: string | null; observationsIn: string | null; observations: Array<{ artifactId: string; sha256: string; byteLength: number; mediaType: string; contentBase64: string | null }>;
  executorLogHead: string | null; captures: { artifacts: Array<Record<string, unknown>>; files: Array<{ name: string; sha256: string; bytes: number; base64: string }> } | null };
const groupOf = (s: Awaited<ReturnType<typeof setup>>) => (JSON.parse(s.saved.find((item) => item.groupRunId === s.runId)!.bytes.toString("utf8")) as { groupRun: unknown }).groupRun as
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
    expect(group.operatorEvidence!.captures!.files.map((file) => [file.name, file.sha256, file.bytes, Buffer.from(file.base64, "base64").equals(file.name.startsWith("case-0") ? screenshot : secondScreenshot)]))
      .toEqual([["case-0-screenshot.jpg", sha(screenshot), screenshot.byteLength, true], ["case-1-screenshot.jpg", sha(secondScreenshot), secondScreenshot.byteLength, true]]);
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
    const anything: unknown = expect.anything();
    expect(group.actual).toMatchObject({ collection: { shards: [{ rawReport: anything }], supervisorReadback: anything } });
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
    const dropped = [{ caseId: "case-a", kind: "screenshot", sha256: sha(screenshot), bytes: screenshot.byteLength, omitted: "credential-match" }];
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
  const capturesOf = (sizes: number[]) => {
    const files = sizes.map((size, index) => { const bytes = Buffer.alloc(size, 0x43 + index);
      return { name: `case-${index}-screenshot.jpg`, sha256: sha(bytes), bytes: new Uint8Array(bytes) }; });
    const artifacts = sizes.map((size, index) => ({ caseId: `case-${"abcdefg"[index]}`, kind: "screenshot", sha256: files[index]!.sha256, bytes: size }));
    return { files, artifacts };
  };

  it("sheds captures one file at a time, the largest first, recording each as budget, and leaves the verdict and its inputs untouched", async () => {
    const { limit, room, baseBytes } = await measure();
    expect(limit).toBeLessThanOrEqual(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES);
    // Three screenshots (base64: about 134,000, 534,000 and 267,000): with 800,000 bytes of room beyond the plain evidence the 400,000-byte one goes first, and then it fits.
    const captures = capturesOf([100_000, 400_000, 200_000]);
    const collection = { marker: "x".repeat(room - baseBytes - 800_000) };
    const s = await setup({ assembled: baseRun({ executorEvidence: executorEvidence({ captures }) }) });
    s.collect.mockReturnValue({ collection, oracle: {}, unavailableReason: null, qualification: s.qualified("FAILED") });
    await s.run();
    const group = groupOf(s);
    expect(group.operatorEvidence!.captures!.files.map((file) => file.name)).toEqual(["case-0-screenshot.jpg", "case-2-screenshot.jpg"]);
    expect(group.operatorEvidence!.captures!.artifacts).toEqual([captures.artifacts[0], { ...captures.artifacts[1], omitted: "budget" }, captures.artifacts[2]]);
    expect(group.collection).toMatchObject({ status: "FAILED" });
    expect(group.unavailableReason).toBeNull();
    expect(group.actual).toMatchObject({ collection });
  });

  it("drops every capture before it drops any verdict input", async () => {
    const { limit, room, baseBytes } = await measure();
    const captures = capturesOf([600_000]);
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
    const captures = capturesOf([100_000, 200_000]);
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
// Every group is held to a fixed share of the aggregate that is known before any group runs, so each group can upload the moment it finishes (the broker's 30 s post-close
// harvest window is measured to the start of that upload) and no group's captures can take another group's room.
describe("a group's fixed share of the aggregate", () => {
  const MiB = 1024 * 1024;
  /** What the worker computes up front: the aggregate is the 24 MiB ceiling or the sum of the group ceilings, whichever is less. */
  const sharesOf = (groupLimits: number[]) => {
    const aggregateLimit = Math.min(24 * MiB, groupLimits.reduce((sum, limit) => sum + limit, 0));
    return { aggregateLimit, shares: groupLimits.map((groupLimit) => groupEvidenceShare({ groupLimit, groupLimits, aggregateLimit })) };
  };

  it("is proportional to the group's own ceiling, so an 8 MiB group next to a 1 MiB group keeps about 7 MiB for its verdict inputs, as the base did", () => {
    const { shares } = sharesOf([8 * MiB, 1 * MiB]);
    expect(shares[0]).toBe(Math.floor(8 * MiB * (9 * MiB - MiB) / (9 * MiB)));
    expect(shares[0]!).toBeGreaterThan(7 * MiB);
    expect(shares[1]!).toBeLessThanOrEqual(1 * MiB);
    expect(shares[1]!).toBe(Math.floor(1 * MiB * (9 * MiB - MiB) / (9 * MiB)));
  });

  it("is the whole ceiling for a group that has the aggregate to itself or enough room, and never more than its ceiling", () => {
    expect(sharesOf([3 * MiB]).shares).toEqual([2 * MiB]);
    expect(sharesOf([8 * MiB]).shares).toEqual([7 * MiB]);
    for (const limits of [[8 * MiB, 8 * MiB], [8 * MiB, 3 * MiB, 1 * MiB], [8 * MiB, 8 * MiB, 8 * MiB, 8 * MiB]]) {
      const { shares } = sharesOf(limits);
      shares.forEach((share, index) => expect(share).toBeLessThanOrEqual(limits[index]!));
    }
  });

  it("gives four groups at the cap an equal part of what the aggregate holds beside its envelope", () => {
    const { aggregateLimit, shares } = sharesOf([8 * MiB, 8 * MiB, 8 * MiB, 8 * MiB]);
    expect(aggregateLimit).toBe(24 * MiB);
    expect(shares).toEqual([5.75 * MiB, 5.75 * MiB, 5.75 * MiB, 5.75 * MiB].map(Math.floor));
  });

  it("always sums to the aggregate less its envelope, or less, whatever the groups' ceilings are", () => {
    const cases = [[8 * MiB], [8 * MiB, 1 * MiB], [8 * MiB, 8 * MiB], [8 * MiB, 8 * MiB, 8 * MiB], [8 * MiB, 8 * MiB, 8 * MiB, 8 * MiB], [5_000_001, 7_777_777, 3_333_333, 8 * MiB],
      [1, 2, 3], [8 * MiB, 8 * MiB, 8 * MiB, 1 * MiB]];
    for (const limits of cases) {
      const { aggregateLimit, shares } = sharesOf(limits);
      expect(shares.reduce((sum, share) => sum + share, 0), JSON.stringify(limits)).toBeLessThanOrEqual(Math.max(0, aggregateLimit - MiB));
      shares.forEach((share) => expect(share).toBeGreaterThanOrEqual(0));
    }
  });
});

describe("fitting one group into its share", () => {
  const operator = (files: number[], observations: number[] = [], log: string | null = "log"): WorkerOperatorEvidence => {
    const stored = files.map((size, index) => ({ name: `case-${index}-screenshot.jpg`, sha256: String(index).repeat(64).slice(0, 64), bytes: size, base64: "A".repeat(Math.ceil(size / 3) * 4) }));
    return { notice: "n", rawReportIn: "diagnostics.shardReports", observationsIn: observations.length > 0 ? "operatorEvidence.observations" : null,
      observations: observations.map((size, index) => ({ artifactId: `o${index}`, sha256: String(index).repeat(64).slice(0, 64), byteLength: size, mediaType: "application/json", contentBase64: "B".repeat(Math.ceil(size / 3) * 4) })),
      executorLogHead: log, captures: { artifacts: stored.map((file, index) => ({ caseId: `case-${index}`, kind: "screenshot" as const, sha256: file.sha256, bytes: file.bytes })), files: stored } };
  };
  const candidate = (verdict: number, share: number, whole: WorkerOperatorEvidence | null): GroupEvidenceCandidate => ({ limit: share, whole,
    build: (op) => Buffer.from(JSON.stringify({ verdict: "v".repeat(verdict), operatorEvidence: op })) });
  const plain = (verdict: number) => candidate(verdict, 0, null).build(null).byteLength;

  it("keeps everything when it fits", () => {
    const whole = operator([1000, 2000], [500]);
    const fitted = fitGroupEvidence(candidate(10_000, 1_000_000, whole))!;
    expect(fitted.operator).toEqual(whole);
  });

  it("sheds capture files first, one at a time, the largest first, and each stays listed as budget", () => {
    const whole = operator([100_000, 400_000, 200_000], [1000]);
    const roomFor = (extra: number) => plain(50_000) + extra;
    const one = fitGroupEvidence(candidate(50_000, roomFor(800_000), whole))!;
    expect(one.operator!.captures!.files.map((file) => file.name)).toEqual(["case-0-screenshot.jpg", "case-2-screenshot.jpg"]);
    expect(one.operator!.captures!.artifacts.map((entry) => entry.omitted)).toEqual([undefined, "budget", undefined]);
    expect(one.operator!.observations[0]!.contentBase64).not.toBeNull();
    const two = fitGroupEvidence(candidate(50_000, roomFor(400_000), whole))!;
    expect(two.operator!.captures!.files.map((file) => file.name)).toEqual(["case-0-screenshot.jpg"]);
    expect(two.evidence.byteLength).toBeLessThanOrEqual(roomFor(400_000));
  });

  it("then sheds the copied observations' bytes largest first, then the log head, then all operator evidence; never the verdict inputs", () => {
    const whole = operator([], [100_000, 300_000, 200_000], "h".repeat(300));
    const room = (extra: number) => plain(50_000) + extra;
    const build = (op: WorkerOperatorEvidence | null) => candidate(50_000, 0, whole).build(op);
    const dropped = (count: number): WorkerOperatorEvidence => ({ ...whole, observations: whole.observations.map((item, index) => ({ ...item, contentBase64: [1, 2, 0].indexOf(index) < count ? null : item.contentBase64 })) });
    // Remaining base64: 400,004 with the largest dropped, 133,336 with the two largest dropped.
    const first = fitGroupEvidence(candidate(50_000, room(450_000), whole))!;
    expect(first.operator!.observations.map((item) => item.contentBase64 === null)).toEqual([false, true, false]);
    const second = fitGroupEvidence(candidate(50_000, room(250_000), whole))!;
    expect(second.operator!.observations.map((item) => item.contentBase64 === null)).toEqual([false, true, true]);
    // The log head goes only when every observation's bytes are already gone and it still does not fit.
    const noLog = build({ ...dropped(3), executorLogHead: null }).byteLength;
    const third = fitGroupEvidence(candidate(50_000, noLog, whole))!;
    expect(third.operator!.observations.every((item) => item.contentBase64 === null)).toBe(true);
    expect(third.operator!.executorLogHead).toBeNull();
    const last = fitGroupEvidence(candidate(50_000, noLog - 1, whole))!;
    expect(last.operator).toBeNull();
    expect(last.evidence.byteLength).toBe(plain(50_000));
  });

  it("works out the size of each shed step from the known lengths: it serializes the envelope a few times, not once per file or observation", () => {
    const whole = operator(Array.from({ length: 48 }, (_, index) => 20_000 + index * 1_000), Array.from({ length: 30 }, (_, index) => 300 + index * 10), "h".repeat(500));
    let calls = 0;
    const counting = (verdict: number, share: number): GroupEvidenceCandidate => ({ limit: share, whole, build: (op) => { calls += 1; return candidate(verdict, 0, null).build(op); } });
    // Room for the verdict inputs and a handful of the smallest files only: dozens of files and every observation have to go.
    const share = plain(50_000) + 150_000;
    const fitted = fitGroupEvidence(counting(50_000, share))!;
    expect(fitted.evidence.byteLength).toBeLessThanOrEqual(share);
    expect(fitted.operator!.captures!.files.length).toBeGreaterThan(0);
    expect(fitted.operator!.captures!.files.length).toBeLessThan(48);
    expect(calls).toBeLessThanOrEqual(4);
    // And the answer is the one that shedding step by step, with the envelope serialized each time, gives.
    const stepwise = (() => {
      const names = [...whole.captures!.files].sort((a, b) => (b.bytes - a.bytes) || b.name.localeCompare(a.name)).map((file) => file.name);
      for (let dropped = 0; dropped <= names.length; dropped += 1) {
        const gone = new Set(names.slice(0, dropped));
        const shaped: WorkerOperatorEvidence = { ...whole, captures: { artifacts: whole.captures!.artifacts.map((entry) => (whole.captures!.files.some((file) => file.sha256 === entry.sha256 && !gone.has(file.name)) ? entry : { ...entry, omitted: "budget" as const })),
          files: whole.captures!.files.filter((file) => !gone.has(file.name)) } };
        if (candidate(50_000, 0, null).build(shaped).byteLength <= share) return shaped;
      }
      return null;
    })();
    expect(stepwise).not.toBeNull();
    expect(fitted.operator!.captures!.files.map((file) => file.name)).toEqual(stepwise!.captures!.files.map((file) => file.name));
    expect(fitted.operator!.observations).toEqual(whole.observations);
  });

  it("answers the same through observations and the log head as stepwise shedding does, for many observations", () => {
    const whole = operator([], Array.from({ length: 40 }, (_, index) => 3_000 + index * 777), "h".repeat(2000));
    const full = candidate(50_000, 0, null).build(whole).byteLength;
    let calls = 0;
    for (const share of [plain(50_000) + 20_000, plain(50_000) + 60_000, full - 10, full + 1, plain(50_000) + 9_000]) {
      calls = 0;
      const fitted = fitGroupEvidence({ limit: share, whole, build: (op) => { calls += 1; return candidate(50_000, 0, null).build(op); } })!;
      expect(fitted.evidence.byteLength).toBeLessThanOrEqual(share);
      expect(calls).toBeLessThanOrEqual(4);
      const nulls = fitted.operator === null ? 0 : fitted.operator.observations.filter((item) => item.contentBase64 === null).length;
      // Whatever was shed was shed largest first: the kept observations are never larger than a dropped one.
      if (fitted.operator !== null && nulls > 0 && nulls < 40) {
        const keptMax = Math.max(...fitted.operator.observations.filter((item) => item.contentBase64 !== null).map((item) => item.byteLength));
        const droppedMin = Math.min(...fitted.operator.observations.filter((item) => item.contentBase64 === null).map((item) => item.byteLength));
        expect(keptMax).toBeLessThanOrEqual(droppedMin);
      }
    }
  });

  it("refuses a group whose verdict inputs alone do not fit its share, and nothing else", () => {
    expect(fitGroupEvidence(candidate(900_000, plain(500_000), operator([1000])))).toBeNull();
    expect(fitGroupEvidence(candidate(500_000, plain(500_000), operator([1000])))).not.toBeNull();
  });
});

describe("several groups in one round", () => {
  const MiB = 1024 * 1024;
  type Held = { release(): void; promise: Promise<void> };
  const gate = (): Held => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { release, promise }; };
  const timeout = <T,>(promise: Promise<T>, what: string) => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), 25_000))]);
  const shot = (size: number, fill: number) => { const bytes = Buffer.alloc(size, fill); return { name: "case-0-screenshot.jpg", sha256: sha(bytes), bytes: new Uint8Array(bytes), entry: { caseId: "case-a", kind: "screenshot", sha256: sha(bytes), bytes: size } }; };

  it("uploads each group's evidence the moment that group finishes, not when the slowest group does", async () => {
    const round = await startApplicationRound({ applications: 4 });
    const second = gate();
    let firstSaved: (() => void) | undefined;
    const firstUploaded = new Promise<void>((resolve) => { firstSaved = resolve; });
    const s = await setup({ admission: round.admission, standIn: true, hold: { groupIndex: 1, until: second.promise }, onSave: (groupRunId) => {
      if (groupRunId === round.admission.groups[0]!.outerBinding.runId) { firstSaved?.(); }
    } });
    // The second group cannot finish until the first group's evidence has been saved: a worker that held every group's evidence until the end would wait for ever.
    void firstUploaded.then(() => second.release());
    await timeout(s.run(), "the first group was not uploaded before the second finished");
    expect(s.saved.map((item) => item.groupRunId)).toEqual([round.admission.groups[0]!.outerBinding.runId, round.admission.groups[1]!.outerBinding.runId, undefined]);
  }, 40_000);

  it("keeps a group whose verdict inputs fit its share qualified-eligible whatever another group carries, and makes only the group that does not fit UNKNOWN 'evidence too large'", async () => {
    const round = await startApplicationRound({ applications: 4 });
    const s = await setup({ admission: round.admission, standIn: true, assembled: baseRun({ executorEvidence: executorEvidence({ captures: { artifacts: [shot(400_000, 1).entry], files: [shot(400_000, 1)].map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) } }) }) });
    const [first, second] = round.admission.groups.map((group) => group.outerBinding.runId) as [string, string];
    const huge = { marker: "x".repeat(9 * MiB) };
    s.collect.mockImplementation((request) => {
      const runIdOf = (request as { binding: { runId: string } }).binding.runId;
      return { collection: runIdOf === second ? huge : { marker: "small" }, oracle: {}, unavailableReason: null, qualification: s.qualified("PASS") };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try { await s.run(); } finally { log.mockRestore(); }
    const groupRunOf = (runId: string) => (JSON.parse(s.saved.find((item) => item.groupRunId === runId)!.bytes.toString("utf8")) as { groupRun: { collection: { status: string; reason: string }; actual: unknown; operatorEvidence: { captures: { files: unknown[] } | null } | null } }).groupRun;
    expect(groupRunOf(first).collection.status).toBe("PASS");
    expect(groupRunOf(first).actual).not.toBeNull();
    expect(groupRunOf(first).operatorEvidence!.captures!.files).toHaveLength(1);
    expect(groupRunOf(second).collection).toMatchObject({ status: "UNKNOWN", reason: "evidence too large" });
    expect(groupRunOf(second).actual).toBeNull();
    // Each stored group evidence stays within its share, so the two together and the aggregate's envelope stay within the aggregate.
    const total = s.saved.filter((item) => item.groupRunId !== undefined).reduce((sum, item) => sum + item.bytes.byteLength, 0);
    expect(total).toBeLessThanOrEqual(24 * MiB - MiB);
  }, 60_000);
});

describe("no stored byte carries a credential", () => {
  it("never stores a password, whatever else the captures hold, when the host has already held back the file that carried it", async () => {
    // The host's snapshot excludes a capture file that carries the run's credential; what reaches the worker is the listing with the drop recorded.
    const clean = [{ caseId: "case-a", kind: "screenshot", sha256: sha(Buffer.from(PASSWORD)), bytes: PASSWORD.length, omitted: "credential-match" }];
    const s = await setup({ assembled: baseRun({ executorEvidence: executorEvidence({ captures: { artifacts: clean, files: [] } }) }) });
    await s.run();
    for (const item of s.saved) expect(item.bytes.toString("utf8")).not.toContain(PASSWORD);
  });
});
