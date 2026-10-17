import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { canonicalJson } from "@agentx/contracts";
import { createCompiledApiApplicationFixture } from "../support/e2e-application-fixture.js";

const sha = "a".repeat(64);
const uuidA = "11111111-1111-4111-8111-111111111111";
const uuidB = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-17T12:00:00.000Z";
const pinnedToolchain = { execPath: process.execPath, version: process.version as "v22.23.2",
  platform: process.platform as "darwin" | "linux" | "win32", arch: process.arch as "arm64" | "x64" };
const producer = { producerId: "installed-web", receiptId: "receipt-a", lifecycleId: "lifecycle-a", operationId: uuidB,
  operationFence: 1, runtimeManifestDigest: sha, transportCorrelationId: "33333333-3333-4333-8333-333333333333" };
const capture = { schemaVersion: "e2e-application-case-capture/v1", caseId: "case-a", upstreamRunId: uuidA, shardId: "shard-a",
  roundId: uuidB, runId: "44444444-4444-4444-8444-444444444444", groupId: "group-a", candidateDigest: sha, applicationId: "app-a",
  buildManifestDigest: sha, runtimeManifestDigest: sha, executionDescriptorDigest: sha, accountContextId: "account-a", accountContextDigest: sha,
  observedAt: at, lifecycleId: "lifecycle-a", subject: { kind: "service", processId: "owned-service-1", origin: "https://app.test" }, producer,
  steps: [{ index: 0, declaredStepIndex: 0, kind: "navigate", actionDigest: sha, observationId: "observation-a", at, outcome: "completed", evidenceRefs: [] }],
  assertions: [{ index: 0, digest: sha, observedAt: at, observationId: "observation-a", value: true, evidenceRef: null, outcome: "passed", reason: "observed", producer }],
  artifacts: [], coverage: { observedScope: "runtime", subject: "candidate", executedCandidateParts: ["app-a"], realComponentIds: [],
    mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [] }, cleanup: "confirmed" };
const bytes = (value: string) => { const body = Buffer.from(value); return { bytesBase64: body.toString("base64"), byteLength: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") }; };
const processRecord = (stdout: ReturnType<typeof bytes>, stderr: ReturnType<typeof bytes>) => ({ status: 0, signal: null,
  startedAt: at, finishedAt: "2026-10-17T12:00:01.000Z", timedOut: false, aborted: false,
  stdoutSha256: stdout.sha256, stderrSha256: stderr.sha256, stdoutBytes: stdout.byteLength, stderrBytes: stderr.byteLength });
function collection(overrides: Record<string, unknown> = {}) {
  const publicList = bytes(JSON.stringify({ pairs: [], targets: [], unmatched: [] }));
  const report = bytes("{}"); const stderr = bytes("");
  return { protocol: "e2e-application-collection/v1", shards: [{ shardId: "shard-a", launchId: uuidA, launchConfigDigest: sha,
    fixedAssetDigests: { reporter: sha }, publicList: { pairs: [], targets: [], unmatched: [] }, publicListBytes: publicList,
    rawReport: report, runStderr: stderr, runStartCapture: bytes(JSON.stringify({ schemaVersion: "e2e-run-start-capture/v1", challenge: uuidA, runId: uuidB, seq: 1, at })),
    runStart: { schemaVersion: "e2e-run-start-capture/v1", challenge: uuidA, runId: uuidB, seq: 1, at },
    listProcess: processRecord(publicList, stderr), runProcess: processRecord(report, stderr) }], applicationCaptures: [capture], supervisorReceiptRefs: [], mockConsumptions: [],
    declaredMockComponentIds: [], receivedAt: at, cleanup: "confirmed", ...overrides };
}

describe("application collection contracts", () => {
  it("binds raw supervisor receipts, captures, mock request and response bytes, and post-close cleanup", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    const context = { bindingDigest: sha, compiledInventoryDigest: "b".repeat(64), preparedEnvironmentDigest: "c".repeat(64),
      candidateDigest: "d".repeat(64), roundId: uuidB, runId: capture.runId, groupId: "group-a", lifecycleId: capture.lifecycleId,
      observedAt: at, producer };
    const captureWithMockCoverage = { ...capture, coverage: { ...capture.coverage, mockedComponentIds: ["mock-a"] } };
    const frame = (artifactId: string, value: unknown) => {
      const body = Buffer.from(canonicalJson(value));
      return { ref: { artifactId, sha256: createHash("sha256").update(body).digest("hex"), byteLength: body.byteLength, mediaType: "application/json" }, bytes: body };
    };
    const rawCapture = frame("capture-a", captureWithMockCoverage);
    const request = frame("request-a", { action: "get" });
    const response = frame("response-a", { status: 200 });
    const mock = frame("mock-a", { schemaVersion: "e2e-application-mock-consumption/v1", context, caseId: "case-a", shardId: "shard-a",
      upstreamRunId: uuidA, rows: [{ caseId: "case-a", componentId: "mock-a", runId: capture.runId, mockManifestDigest: "e".repeat(64),
        lifecycleId: capture.lifecycleId, producer, requestId: "request-id-a", responseId: "response-id-a",
        requestSha256: request.ref.sha256, responseSha256: response.ref.sha256, observedAt: at,
        requestRef: request.ref, responseRef: response.ref }] });
    const cleanup = frame("cleanup-a", { schemaVersion: "e2e-application-owned-cleanup/v1", context, phase: "after-owned-close",
      cleanup: "confirmed", confirmed: true, serverListening: false, ownedResourceInventoryDigest: "f".repeat(64), ownedCleanupReceiptRefs: [] });
    const sourceReceipt = frame("source-a", { schemaVersion: "test-source-receipt/v1", source: "synthetic-conformance" });
    const receipt = frame("receipt-a", { schemaVersion: "e2e-application-supervisor-receipt/v1", context,
      launches: [{ shardId: "shard-a", launchId: uuidA, upstreamRunId: uuidA }],
      caseCaptures: [{ caseId: "case-a", shardId: "shard-a", ref: rawCapture.ref }],
      mockConsumptions: [{ caseId: "case-a", shardId: "shard-a", ref: mock.ref }], cleanupRef: cleanup.ref, additionalSupervisorReceiptRefs: [sourceReceipt.ref] });
    const mockClaim = { caseId: "case-a", componentId: "mock-a", runId: capture.runId, mockManifestDigest: "e".repeat(64),
      lifecycleId: capture.lifecycleId, producer, requestId: "request-id-a", responseId: "response-id-a",
      requestSha256: request.ref.sha256, responseSha256: response.ref.sha256, observedAt: at };
    const evidence = [rawCapture, mock, cleanup, request, response, sourceReceipt].sort((a, b) => a.ref.artifactId.localeCompare(b.ref.artifactId));
    const proof = { schemaVersion: "e2e-application-supervisor-readback/v1" as const, receipt, evidence };
    const validated = module.readE2EApplicationSupervisorProof({ readback: proof, expected: { bindingDigest: sha,
      compiledInventoryDigest: context.compiledInventoryDigest, preparedEnvironmentDigest: context.preparedEnvironmentDigest,
      candidateDigest: context.candidateDigest, roundId: uuidB, runId: capture.runId, groupId: "group-a", mockManifestDigest: "e".repeat(64),
      caseCount: 1, expectedSupervisorReceiptRefs: [sourceReceipt.ref], ownedResourceInventoryDigest: "f".repeat(64),
      launches: [{ shardId: "shard-a", launchId: uuidA, upstreamRunId: uuidA }] }, applicationCaptures: [captureWithMockCoverage],
      supervisorReceiptRefs: [receipt.ref, sourceReceipt.ref], cleanupConfirmed: true, cleanupServerListening: false });
    expect(validated.captures).toHaveLength(1);
    expect(validated.mockConsumptions).toEqual([mockClaim]);
    expect(validated.cleanup.confirmed).toBe(true);
    expect(() => module.readE2EApplicationSupervisorProof({ readback: { ...proof, evidence: evidence.map((item) => item.ref.artifactId === "capture-a"
      ? { ...item, bytes: Buffer.from("forged") } : item) },
      expected: { bindingDigest: sha, compiledInventoryDigest: context.compiledInventoryDigest, preparedEnvironmentDigest: context.preparedEnvironmentDigest,
        candidateDigest: context.candidateDigest, roundId: uuidB, runId: capture.runId, groupId: "group-a", mockManifestDigest: "e".repeat(64),
        caseCount: 1, expectedSupervisorReceiptRefs: [sourceReceipt.ref], ownedResourceInventoryDigest: "f".repeat(64),
        launches: [{ shardId: "shard-a", launchId: uuidA, upstreamRunId: uuidA }] }, applicationCaptures: [captureWithMockCoverage],
      supervisorReceiptRefs: [receipt.ref, sourceReceipt.ref], cleanupConfirmed: true, cleanupServerListening: false })).toThrow();
    expect(() => module.readE2EApplicationSupervisorProof({ readback: proof, expected: { bindingDigest: sha,
      compiledInventoryDigest: context.compiledInventoryDigest, preparedEnvironmentDigest: context.preparedEnvironmentDigest,
      candidateDigest: context.candidateDigest, roundId: uuidB, runId: capture.runId, groupId: "group-a", mockManifestDigest: "e".repeat(64),
      caseCount: 1, expectedSupervisorReceiptRefs: [], ownedResourceInventoryDigest: "f".repeat(64),
      launches: [{ shardId: "shard-a", launchId: uuidA, upstreamRunId: uuidA }] }, applicationCaptures: [captureWithMockCoverage],
      supervisorReceiptRefs: [receipt.ref, sourceReceipt.ref], cleanupConfirmed: true, cleanupServerListening: false })).toThrow();
    expect(() => module.readE2EApplicationSupervisorProof({ readback: proof, expected: { bindingDigest: sha,
      compiledInventoryDigest: context.compiledInventoryDigest, preparedEnvironmentDigest: context.preparedEnvironmentDigest,
      candidateDigest: context.candidateDigest, roundId: uuidB, runId: capture.runId, groupId: "group-a", mockManifestDigest: "e".repeat(64),
      caseCount: 1, expectedSupervisorReceiptRefs: [sourceReceipt.ref], ownedResourceInventoryDigest: "a".repeat(64),
      launches: [{ shardId: "shard-a", launchId: uuidA, upstreamRunId: uuidA }] }, applicationCaptures: [captureWithMockCoverage],
      supervisorReceiptRefs: [receipt.ref, sourceReceipt.ref], cleanupConfirmed: true, cleanupServerListening: false })).toThrow();
  });

  it("reads a fixed installed spool only after construction, with exact assignment identity and canonical raw bytes", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const { createE2EApplicationSupervisorReadbackClientForConformance,
      createE2EApplicationSupervisorReadbackClientForConformanceWithHooks } = await import("../../packages/verifier/src/application-runtime-cli.js");
    const root = await mkdtemp(join(process.cwd(), ".application-spool-fixture-"));
    try {
      const packageRoot = join(root, "package"); const assetDir = join(packageRoot, "assets", "application-runtime-v1");
      const assignmentRoot = join(root, "assigned-spools");
      await mkdir(assetDir, { recursive: true, mode: 0o700 }); await mkdir(assignmentRoot, { mode: 0o700 });
      const descriptor = { entryPointId: "installed-local", entryPointManifestDigest: sha };
      const transportId = "private-channel-a"; const correlation = "33333333-3333-4333-8333-333333333333";
      await writeFile(join(assetDir, "supervisor-spools.json"), canonicalJson({ schemaVersion: "e2e-application-supervisor-spools/v1",
        entries: [{ profileId: "profile-a", descriptor, transportId, assignmentRoot, ownerUid: process.getuid!() }] }), { mode: 0o600 });
      const client = await createE2EApplicationSupervisorReadbackClientForConformance({ packageRoot, profileId: "profile-a", descriptor });
      await expect(createE2EApplicationSupervisorReadbackClientForConformance({ packageRoot, profileId: "foreign-profile", descriptor })).rejects.toThrow();
      // Client construction consumes only installed mapping configuration; assignment and payload are created afterward.
      const launches = [{ shardId: "shard-a", launchId: uuidA, upstreamRunId: uuidB }];
      const bindingDigest = "b".repeat(64); const compiledInventoryDigest = "c".repeat(64); const preparedEnvironmentDigest = "d".repeat(64);
      const corrRoot = join(assignmentRoot, correlation); const spoolDir = join(corrRoot, ".agentx", "e2e");
      await mkdir(spoolDir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      const assignment = { schemaVersion: "e2e-application-supervisor-readback-assignment/v1",
        profileId: "profile-a", descriptor, transportId, transportCorrelationId: correlation, bindingDigest, compiledInventoryDigest,
        preparedEnvironmentDigest, launches, maxWireBytes: 1_000_000, closedAt: new Date(now - 1_000).toISOString(),
        harvestDeadlineAt: new Date(now + 20_000).toISOString() };
      await writeFile(join(corrRoot, "assignment.json"), canonicalJson(assignment), { mode: 0o600 });
      const frame = (artifactId: string, value: unknown) => {
        const body = Buffer.from(canonicalJson(value));
        return { ref: { artifactId, sha256: createHash("sha256").update(body).digest("hex"), byteLength: body.byteLength, mediaType: "application/json" }, bytes: body };
      };
      const context = { bindingDigest, compiledInventoryDigest, preparedEnvironmentDigest, candidateDigest: "e".repeat(64), roundId: uuidA,
        runId: uuidB, groupId: "group-a", lifecycleId: "lifecycle-a", observedAt: at,
        producer: { producerId: "installed-test", receiptId: "receipt-a", lifecycleId: "lifecycle-a", operationId: uuidA,
          operationFence: 1, runtimeManifestDigest: sha, transportCorrelationId: correlation } };
      const cleanup = frame("cleanup-frame", { schemaVersion: "e2e-application-owned-cleanup/v1", context, phase: "after-owned-close",
        cleanup: "confirmed", confirmed: true, serverListening: false, ownedResourceInventoryDigest: "f".repeat(64), ownedCleanupReceiptRefs: [] });
      const source = frame("source-frame", { schemaVersion: "test-source-receipt/v1" });
      const receiptValue = { schemaVersion: "e2e-application-supervisor-receipt/v1", context, launches, caseCaptures: [], mockConsumptions: [],
        cleanupRef: cleanup.ref, additionalSupervisorReceiptRefs: [source.ref] };
      const receiptBytes = Buffer.from(canonicalJson(receiptValue));
      const ref = { artifactId: "supervisor-receipt", sha256: createHash("sha256").update(receiptBytes).digest("hex"), byteLength: receiptBytes.byteLength, mediaType: "application/json" };
      const evidence = [cleanup, source].sort((a, b) => a.ref.artifactId.localeCompare(b.ref.artifactId)).map((item) => ({ ref: item.ref, bytesBase64: item.bytes.toString("base64") }));
      await writeFile(join(spoolDir, "supervisor-readback.json"), canonicalJson({ schemaVersion: "e2e-application-supervisor-readback/v1",
        receipt: { ref, bytesBase64: receiptBytes.toString("base64") }, evidence }), { mode: 0o600 });
      const expected = { transportId, transportCorrelationId: correlation, bindingDigest, compiledInventoryDigest,
        preparedEnvironmentDigest, launches, maxWireBytes: 1_000_000 };
      expect((globalThis as Record<PropertyKey, unknown>)[Symbol.for("agentx.e2e.application.cli-host.v1")]).toBeUndefined();
      const result = await client.read(expected, new AbortController().signal);
      expect(result.receipt.ref).toEqual(ref);
      expect(Buffer.from(result.receipt.bytes).toString("utf8")).toBe(canonicalJson(receiptValue));
      await expect(client.read({ ...expected, transportId: "foreign-channel" }, new AbortController().signal)).rejects.toThrow();
      const assignmentPath = join(corrRoot, "assignment.json");
      await writeFile(assignmentPath, canonicalJson({ ...assignment, harvestDeadlineAt: new Date(Date.parse(assignment.closedAt) + 30_001).toISOString() }), { mode: 0o600 });
      await expect(client.read(expected, new AbortController().signal)).rejects.toThrow();
      await writeFile(assignmentPath, canonicalJson({ ...assignment, closedAt: new Date(Date.now() - 31_000).toISOString(),
        harvestDeadlineAt: new Date(Date.now() - 1_000).toISOString() }), { mode: 0o600 });
      await expect(client.read(expected, new AbortController().signal)).rejects.toThrow();
      await writeFile(assignmentPath, canonicalJson(assignment), { mode: 0o600 });
      const spoolPath = join(spoolDir, "supervisor-readback.json"); const realSpoolPath = join(spoolDir, "supervisor-readback.real.json");
      await rename(spoolPath, realSpoolPath); await symlink(realSpoolPath, spoolPath);
      await expect(client.read(expected, new AbortController().signal)).rejects.toThrow();
      await rm(spoolPath); await rename(realSpoolPath, spoolPath);
      const hugeSource = frame("source-frame", { schemaVersion: "test-source-receipt/v1", padding: "x".repeat(9 * 1024 * 1024) });
      const hugeReceipt = { ...receiptValue, additionalSupervisorReceiptRefs: [hugeSource.ref] };
      const hugeReceiptBytes = Buffer.from(canonicalJson(hugeReceipt));
      const hugeTopRef = { artifactId: "supervisor-receipt", sha256: createHash("sha256").update(hugeReceiptBytes).digest("hex"), byteLength: hugeReceiptBytes.byteLength, mediaType: "application/json" };
      const hugeEvidence = [cleanup, hugeSource].sort((a, b) => a.ref.artifactId.localeCompare(b.ref.artifactId)).map((item) => ({ ref: item.ref, bytesBase64: item.bytes.toString("base64") }));
      await writeFile(join(corrRoot, "assignment.json"), canonicalJson({ schemaVersion: "e2e-application-supervisor-readback-assignment/v1",
        profileId: "profile-a", descriptor, transportId, transportCorrelationId: correlation, bindingDigest, compiledInventoryDigest,
        preparedEnvironmentDigest, launches, maxWireBytes: 26_214_400, closedAt: new Date(Date.now() - 1_000).toISOString(),
        harvestDeadlineAt: new Date(Date.now() + 20_000).toISOString() }), { mode: 0o600 });
      await writeFile(join(spoolDir, "supervisor-readback.json"), canonicalJson({ schemaVersion: "e2e-application-supervisor-readback/v1",
        receipt: { ref: hugeTopRef, bytesBase64: hugeReceiptBytes.toString("base64") }, evidence: hugeEvidence }), { mode: 0o600 });
      const aborting = new AbortController();
      const abortClient = await createE2EApplicationSupervisorReadbackClientForConformanceWithHooks({ packageRoot, profileId: "profile-a", descriptor,
        onSpoolStream: () => setTimeout(() => aborting.abort(new Error("fixture cancellation")), 0) });
      const pending = abortClient.read({ ...expected, maxWireBytes: 26_214_400 }, aborting.signal);
      await expect(pending).rejects.toThrow();
      await writeFile(join(spoolDir, "supervisor-readback.json"), "{}", { mode: 0o600 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("accepts bounded first-party capture structure without turning claimed provenance into authentication", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js").catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    expect(module.E2EApplicationCaseCaptureSchema.safeParse(capture).success).toBe(true);
    expect(module.E2EApplicationCaseCaptureSchema.safeParse({ ...capture, authenticated: true }).success).toBe(false);
  });

  it("accounts for extra shard reports in the private transfer ceiling and rejects excess inventories", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js").catch(() => null);
    const legacy = await import("../../packages/verifier/src/result-adapter.js");
    expect(module).not.toBeNull();
    if (!module) return;
    const oneShard = module.e2eApplicationPrivateTransferMaxBytes(2, 1);
    expect(oneShard).toBe(legacy.e2ePrivateTransferMaxBytes(2, 1));
    expect(module.e2eApplicationPrivateTransferMaxBytes(2, 2)).toBe(oneShard
      + Math.ceil((legacy.E2E_REPORT_MAX_BYTES + legacy.E2E_APP_RPC_FRAME_MAX_BYTES) * 4 / 3));
    expect(() => module.e2eApplicationPrivateTransferMaxBytes(65, 1)).toThrow();
    expect(() => module.e2eApplicationPrivateTransferMaxBytes(1, 4)).toThrow();
  });

  it("rejects capture index gaps and unbounded or caller-authored provenance flags", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    expect(module.E2EApplicationCaseCaptureSchema.safeParse({ ...capture, steps: [{ ...capture.steps[0], index: 1 }] }).success).toBe(false);
    expect(module.E2EApplicationCaseCaptureSchema.safeParse({ ...capture, authenticated: true }).success).toBe(false);
    expect(module.E2EApplicationCaseCaptureSchema.safeParse({ ...capture, subject: { kind: "service", processId: "p1", origin: "https://*.test" } }).success).toBe(false);
  });

  it("binds every private byte buffer to its exact process receipt and strict challenge row", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    const valid = collection();
    expect(module.E2EApplicationCollectionSchema.safeParse(valid).success).toBe(true);
    const shard = valid.shards[0]!;
    expect(module.E2EApplicationCollectionSchema.safeParse({ ...valid, shards: [{ ...shard, runProcess: { ...shard.runProcess, stdoutSha256: "b".repeat(64) } }] }).success).toBe(false);
    expect(module.E2EApplicationCollectionSchema.safeParse({ ...valid, shards: [{ ...shard,
      runStart: { ...shard.runStart, untrusted: true } }] }).success).toBe(false);
    expect(module.E2EApplicationCollectionSchema.safeParse({ ...valid, shards: [{ ...shard,
      rawReport: { ...shard.rawReport, bytesBase64: "e30g" } }] }).success).toBe(false);
  });

  it("preserves uniquely identified mock request and response consumption rows", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    const consumption = { caseId: "case-a", componentId: "mock-a", runId: capture.runId, mockManifestDigest: sha,
      lifecycleId: capture.lifecycleId, producer, requestId: "request-a", responseId: "response-a", requestSha256: sha,
      responseSha256: sha, observedAt: at };
    const valid = collection({ mockConsumptions: [consumption], declaredMockComponentIds: ["mock-a"] });
    expect(module.E2EApplicationCollectionSchema.safeParse(valid).success).toBe(true);
    expect(module.E2EApplicationCollectionSchema.safeParse({ ...valid, mockConsumptions: [consumption, consumption] }).success).toBe(false);
  });

  it("collects one source-derived API case with real report, process, capture, and post-close proof bindings", async () => {
    const { collectE2EApplicationRun } = await import("../../packages/verifier/src/application-collection.js");
    const { expectedE2EApplicationReporterDigest } = await import("../../packages/verifier/src/application-runtime-assets.js");
    const fixture = createCompiledApiApplicationFixture();
    const { compiled, binding, round } = fixture;
    const shard = compiled.shards[0]!; const tuple = shard.selection.tuples[0]!; const expected = compiled.expectedCases[0]!;
    const launchId = uuidA; const upstreamRunId = "a0000000-0000-7000-8000-000000000011";
    const listStarted = "2026-10-17T12:00:00.100Z"; const listFinished = "2026-10-17T12:00:00.200Z";
    const processStarted = "2026-10-17T12:00:00.300Z"; const startAt = "2026-10-17T12:00:00.400Z";
    const reportStarted = "2026-10-17T12:00:00.500Z"; const reportFinished = "2026-10-17T12:00:00.600Z";
    const processFinished = "2026-10-17T12:00:00.700Z";
    const textBytes = (value: string) => Buffer.from(value);
    const hashBytes = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    const frame = (artifactId: string, value: unknown) => {
      const body = Buffer.from(canonicalJson(value));
      return { ref: { artifactId, sha256: hashBytes(body), byteLength: body.byteLength, mediaType: "application/json" }, bytes: body };
    };
    const app = compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs[0]!;
    const applicationBinding = compiled.applicationBindings.get(app.applicationId)!;
    const runtime = compiled.runtimeBindings.get(app.runtimeProfileId)!;
    const context = { bindingDigest: hashBytes(Buffer.from(canonicalJson(binding))), compiledInventoryDigest: compiled.inventory.digest,
      preparedEnvironmentDigest: compiled.preparedEnvironmentDigest, candidateDigest: binding.candidateDigest, roundId: binding.roundId,
      runId: binding.runId, groupId: binding.groupId, lifecycleId: "owned-api-lifecycle", observedAt: reportStarted,
      producer: { producerId: "synthetic-api-supervisor", receiptId: "supervisor-receipt", lifecycleId: "owned-api-lifecycle",
        operationId: binding.operationId, operationFence: binding.operationFence, runtimeManifestDigest: runtime.manifestDigest,
        transportCorrelationId: "33333333-3333-4333-8333-333333333333" } };
    const evidence = frame("http-observation", { method: "GET", path: "/health", status: 200 });
    const captureValue = { schemaVersion: "e2e-application-case-capture/v1", caseId: expected.caseId, upstreamRunId, shardId: shard.shardId,
      roundId: binding.roundId, runId: binding.runId, groupId: binding.groupId, candidateDigest: binding.candidateDigest,
      applicationId: app.applicationId, buildManifestDigest: applicationBinding.build.manifestDigest, runtimeManifestDigest: runtime.manifestDigest,
      executionDescriptorDigest: expected.executionDescriptorDigest, accountContextId: expected.accountContextId,
      accountContextDigest: expected.accountContextDigest, observedAt: reportStarted, lifecycleId: context.lifecycleId,
      subject: { kind: "service", processId: "owned-api-process", origin: "https://service.test" }, producer: context.producer,
      steps: [{ index: 0, declaredStepIndex: 0, kind: "request", actionDigest: hashBytes(Buffer.from(canonicalJson(compiled.bundle.scenarios[0]!.steps[0]))),
        observationId: "http-response-1", at: reportStarted, outcome: "completed", evidenceRefs: [evidence.ref] }],
      assertions: [{ index: 0, digest: expected.assertionDigests[0], observedAt: reportStarted, observationId: "http-response-1", value: 200,
        evidenceRef: evidence.ref, outcome: "passed", reason: "observed HTTP 200 from owned API service", producer: context.producer }],
      artifacts: [], coverage: { observedScope: "runtime", subject: "candidate", executedCandidateParts: [app.applicationId], realComponentIds: [],
        mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [] }, cleanup: "confirmed" };
    const captureFrame = frame("case-capture", captureValue);
    const cleanupFrame = frame("owned-cleanup", { schemaVersion: "e2e-application-owned-cleanup/v1", context, phase: "after-owned-close",
      cleanup: "confirmed", confirmed: true, serverListening: false, ownedResourceInventoryDigest: sha, ownedCleanupReceiptRefs: [] });
    const sourceReceipt = frame("source-ingress-receipt", { schemaVersion: "test-source-ingress/v1", source: "offline-conformance" });
    const launches = [{ shardId: shard.shardId, launchId, upstreamRunId }];
    const receiptValue = { schemaVersion: "e2e-application-supervisor-receipt/v1", context, launches,
      caseCaptures: [{ caseId: expected.caseId, shardId: shard.shardId, ref: captureFrame.ref }], mockConsumptions: [],
      cleanupRef: cleanupFrame.ref, additionalSupervisorReceiptRefs: [sourceReceipt.ref] };
    const receipt = frame("supervisor-top-receipt", receiptValue);
    const readback = { schemaVersion: "e2e-application-supervisor-readback/v1" as const, receipt,
      evidence: [captureFrame, cleanupFrame, sourceReceipt, evidence].sort((left, right) => left.ref.artifactId.localeCompare(right.ref.artifactId)) };
    const publicList = { pairs: [{ id: tuple.upstreamResultId, file: ".agentx/e2e/generated-application.test.ts", title: tuple.title,
      titlePath: [tuple.title], kind: "test", sessions: [], target: tuple.targetName, agent: "default", disposition: "run", tags: [], source: tuple.source }],
      targets: [tuple.targetId], unmatched: [] };
    const listBytes = textBytes(JSON.stringify(publicList)); const stderrBytes = Buffer.alloc(0);
    const runStart = { schemaVersion: "e2e-run-start-capture/v1", challenge: launchId, runId: upstreamRunId, seq: 1, at: startAt };
    const runStartBytes = textBytes(`${JSON.stringify(runStart)}\n`);
    const report = { schemaVersion: "report-1", run: { id: upstreamRunId, specVersion: "0.1", runner: { name: "e2e", version: "0.20.0" },
      status: "passed", exitCode: 0, startedAt: reportStarted, finishedAt: reportFinished, project: { id: "rovara-application-e2e", configDigest: shard.expectedConfigDigest },
      environment: { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" },
      targets: [{ id: tuple.targetId, index: 0, platform: "api", environment: "test",
        engine: { name: "none", version: "unversioned", spiVersion: 1 }, capabilities: [], artifactCapabilities: [], stateCapability: false }],
      serialGroups: [], results: [{ id: tuple.upstreamResultId, testId: tuple.upstreamTestId, kind: "test", declarationIndex: 0,
        titlePath: [tuple.title], file: ".agentx/e2e/generated-application.test.ts", source: tuple.source, targetId: tuple.targetId, platform: "api",
        agent: "default", repeat: 0, tags: [], selected: true, status: "passed", attempts: [{ id: upstreamRunId, index: 0, status: "passed",
          startedAt: reportStarted, durationMs: 10, artifacts: [], appLog: [], secondaryErrors: [], cleanup: "complete",
          steps: [{ id: "assertion-step", index: 0, kind: "assertion", api: "assert.http-status", label: "health status",
            source: tuple.source, status: "passed", startedAt: reportStarted, durationMs: 1, events: [], artifacts: [] }] }] }],
      errors: [], summary: { discovered: 1, selected: 1, executed: 1, passed: 1, failed: 0, interrupted: 0, flaky: 0, skipped: 0 },
      limits: { maxAgentContextBytes: 1024, maxLedgerBytes: 1024, maxObservationBytes: 1024, maxEventsPerStep: 1000, maxModelTokensPerCall: 1024 },
      usage: { discoveredResults: 1, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0,
        events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 } } };
    const reportBytes = textBytes(JSON.stringify(report));
    const processRecord = (status: number, startedAt: string, finishedAt: string, stdout: Uint8Array) => ({ status, signal: null,
      startedAt, finishedAt, timedOut: false, aborted: false, stdoutSha256: hashBytes(stdout), stderrSha256: hashBytes(stderrBytes),
      stdoutBytes: stdout.byteLength, stderrBytes: 0 });
    const actual = { protocol: "e2e-actual-application-run/v1" as const, runnerToolchain: pinnedToolchain,
      shards: [{ shardId: shard.shardId, launchId, launchConfigDigest: shard.expectedConfigDigest,
        fixedAssetDigests: { compilerInventory: shard.inventory.digest, reporter: expectedE2EApplicationReporterDigest(launchId) }, publicList,
        listStdoutBytes: listBytes, listStderrBytes: stderrBytes, rawReportBytes: reportBytes, runStderrBytes: stderrBytes,
        runStartCaptureBytes: runStartBytes, runStartCapture: runStart,
        listProcess: processRecord(0, listStarted, listFinished, listBytes), runProcess: processRecord(0, processStarted, processFinished, reportBytes) }],
      applicationCaptures: [captureValue], supervisorReceiptRefs: [receipt.ref, sourceReceipt.ref].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
      declaredMockComponentIds: [], selected: 1, filtered: 0,
      supervisorReadback: readback, cleanupConfirmed: true, cleanupServerListening: false, evidenceDirectory: "/offline-fixture" };
    const result = collectE2EApplicationRun({ actual: actual as never, compiled, binding, round,
      environment: { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" },
      usage: {}, limits: {}, expectedSupervisorReceiptRefs: [sourceReceipt.ref], ownedResourceInventoryDigest: sha });
    expect(result.unavailableReason).toBeNull();
    expect(result.qualification).toMatchObject({ status: "PASS", runId: binding.runId, result: { qualification: "exploratory", status: "passed" } });
    expect(result.collection?.applicationCaptures).toHaveLength(1);

    const foreignOriginReport = JSON.parse(JSON.stringify(report)) as { run: { targets: Array<Record<string, unknown>> } };
    foreignOriginReport.run.targets[0]!.baseOrigin = "https://foreign.test";
    const foreignOriginBytes = textBytes(JSON.stringify(foreignOriginReport));
    const originalShard = actual.shards[0]!;
    const foreignOriginActual = { ...actual, shards: [{ ...originalShard, rawReportBytes: foreignOriginBytes,
      runProcess: processRecord(0, processStarted, processFinished, foreignOriginBytes) }] };
    const foreignOriginResult = collectE2EApplicationRun({ actual: foreignOriginActual as never, compiled, binding, round,
      environment: { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" },
      usage: {}, limits: {}, expectedSupervisorReceiptRefs: [sourceReceipt.ref], ownedResourceInventoryDigest: sha });
    expect(foreignOriginResult.qualification?.status).toBe("UNKNOWN");
    expect(foreignOriginResult.unavailableReason).toMatch(/origin differs/u);
  });
});
