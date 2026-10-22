import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { canonicalJson } from "@agentx/contracts";
import { createCompiledApiApplicationFixture, createCompiledTwoShardApiApplicationFixture } from "../support/e2e-application-fixture.js";
import { e2eAgentValueKeyId, e2eModelRouteRevision } from "@agentx/contracts";
import { scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { agentCaseDirectoryName } from "../../packages/verifier/src/executor/evidence-paths.js";
import type { E2EApplicationReport } from "../../packages/verifier/src/application-report-schema.js";

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
  steps: [{ index: 0, declaredStepIndex: 0, kind: "navigate", actionDigest: sha, observationId: "observation-a", at, outcome: "completed", evidenceRefs: [], agentOperationRefs: [] }],
  assertions: [{ index: 0, digest: sha, observedAt: at, observationId: "observation-a", value: true, evidenceRef: null, outcome: "passed", reason: "observed", producer }],
  terminal: { kind: "completed", lastDeclaredStepIndex: 0, failedAssertionIndex: null, at, reason: "complete" }, modelReceipts: [],
  artifacts: [], coverage: { observedScope: "runtime", subject: "candidate", executedCandidateParts: ["app-a"], realComponentIds: [],
    mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [] }, cleanup: "confirmed" };
const bytes = (value: string) => { const body = Buffer.from(value); return { bytesBase64: body.toString("base64"), byteLength: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") }; };
const processRecord = (stdout: ReturnType<typeof bytes>, stderr: ReturnType<typeof bytes>) => ({ status: 0, signal: null,
  startedAt: at, finishedAt: "2026-10-17T12:00:01.000Z", timedOut: false, aborted: false,
  stdoutSha256: stdout.sha256, stderrSha256: stderr.sha256, stdoutBytes: stdout.byteLength, stderrBytes: stderr.byteLength });
function collection(overrides: Record<string, unknown> = {}) {
  const publicList = bytes(JSON.stringify({ pairs: [], targets: [], unmatched: [] }));
  const report = bytes("{}"); const stderr = bytes("");
  const proofBytes = Buffer.from("{}");
  const proof = { ref: { artifactId: "proof-stub", sha256: createHash("sha256").update(proofBytes).digest("hex"), byteLength: proofBytes.byteLength, mediaType: "application/json" },
    bytesBase64: proofBytes.toString("base64") };
  return { protocol: "e2e-application-collection/v1", shards: [{ shardId: "shard-a", launchId: uuidA, launchConfigDigest: sha,
    fixedAssetDigests: { reporter: sha }, publicList: { pairs: [], targets: [], unmatched: [] }, publicListBytes: publicList, listStderr: stderr,
    rawReport: report, runStderr: stderr, runStartCapture: bytes(JSON.stringify({ schemaVersion: "e2e-run-start-capture/v1", challenge: uuidA, runId: uuidB, seq: 1, at })),
    runStart: { schemaVersion: "e2e-run-start-capture/v1", challenge: uuidA, runId: uuidB, seq: 1, at },
    listProcess: processRecord(publicList, stderr), runProcess: processRecord(report, stderr) }], applicationCaptures: [capture], supervisorReceiptRefs: [], mockConsumptions: [],
    declaredMockComponentIds: [], supervisorReadback: { schemaVersion: "e2e-application-supervisor-readback/v1", receipt: proof, evidence: [] },
    receivedAt: at, cleanup: "confirmed", ...overrides };
}

describe("application collection contracts", () => {
  it("accepts a protected pending-to-ready probe sequence and rejects a foreign probe identity", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    const contracts = await import("@agentx/contracts");
    const frame = (artifactId: string, value: unknown) => {
      const body = Buffer.from(canonicalJson(value));
      return { ref: { artifactId, sha256: createHash("sha256").update(body).digest("hex"), byteLength: body.byteLength, mediaType: "application/json" }, bytes: body };
    };
    const assertion = contracts.E2EAssertionSchema.parse({ kind: "state", probeId: "probe-a", equals: 42, pollTimeoutMs: 1_000 });
    const schema = frame("probe-schema", { type: "integer" }); const pending = frame("probe-pending", 0); const ready = frame("probe-ready", 42);
    const pendingSample = { observedAt: "2026-10-17T12:00:00.000Z", valueRef: pending.ref, disposition: "pending" as const };
    const readySample = { observedAt: "2026-10-17T12:00:00.100Z", valueRef: ready.ref, disposition: "ready" as const };
    const producerIdentity = { producerId: "installed-web", receiptId: "receipt-a", lifecycleId: "lifecycle-a", operationId: uuidB,
      operationFence: 1, runtimeManifestDigest: sha, transportCorrelationId: producer.transportCorrelationId };
    const observation = module.E2EApplicationAssertionObservationSchema.parse({ schemaVersion: "e2e-application-assertion-observation/v1", kind: "state",
      caseId: "case-a", assertionIndex: 0, assertionDigest: sha, observationId: "state-observation", lifecycleId: "lifecycle-a",
      observedAt: "2026-10-17T12:00:00.100Z", producer: producerIdentity, subject: capture.subject, accountContextId: "account-a",
      accountContextDigest: sha, sessionRef: "session-a", accountIdDigest: sha, probeId: "probe-a", probeAssetRef: schema.ref,
      samples: [pendingSample, readySample] });
    if (observation.kind !== "state") throw new Error("state observation fixture did not parse as state evidence");
    const proofBytes = new Map([schema, pending, ready].map((item) => [item.ref.artifactId, item]));
    const assetBinding = { caseId: "case-a", assertionIndex: 0, kind: "state-probe" as const, id: "probe-a", manifestDigest: sha, ref: schema.ref };
    expect(module.evaluateE2EApplicationAssertionObservation({ assertion, observation, proofBytes, assetBinding }))
      .toEqual({ supported: true, passed: true, value: 42 });
    expect(module.evaluateE2EApplicationAssertionObservation({ assertion, observation: { ...observation, probeId: "foreign-probe" }, proofBytes, assetBinding }).supported).toBe(false);
    expect(module.evaluateE2EApplicationAssertionObservation({ assertion, observation: { ...observation,
      samples: [pendingSample, { ...readySample, disposition: "failed" as const }] }, proofBytes, assetBinding }).supported).toBe(false);
  });

  it("reconciles model counters with SDK calls, retained receipts, null routes, and original round ceilings", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    const step = { id: "agent-step", index: 0, kind: "agent" as const, api: "agent.run", label: "agent",
      source: { file: ".agentx/e2e/generated-application.test.ts", line: 1, column: 1 }, status: "passed" as const,
      startedAt: at, durationMs: 1, events: [], artifacts: [],
      metrics: { modelCalls: 2, actionSteps: 1, observationBytes: 0, contextBytes: 0, ledgerBytes: 0 },
      model: { provider: "fixture", model: "fixture-model", endpoint: "fixture", adapterVersion: "v1", policyVersion: "p1", calls: 2,
        tokenAccounting: "provider" as const, peakTokensPerCall: 10, inputTokens: 10, outputTokens: 5 } };
    const common = { steps: [step], usage: { modelTokens: 15, maxModelCallsInStep: 2 }, maxModelRequests: 1,
      maxInputTokens: 100, maxOutputTokens: 100 };
    expect(module.e2eApplicationModelUseWithinRound({ ...common, modelRoutePresent: true, actualReceiptCount: 1 })).toBe(false);
    expect(module.e2eApplicationModelUseWithinRound({ ...common, modelRoutePresent: false, actualReceiptCount: 2 })).toBe(false);
    expect(module.e2eApplicationModelUseWithinRound({ ...common, maxModelRequests: 2, modelRoutePresent: true, actualReceiptCount: 2 })).toBe(true);
  });

  it("reconciles heterogeneous shard usage by the pinned report sum and max rules", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    const usage = (modelTokens: number, maxModelCallsInStep: number, maxActionStepsInStep: number) => ({
      discoveredResults: 1, maxAgentContextBytes: 8, maxLedgerBytes: 4, maxObservationBytes: 16, artifactBytes: 0,
      downloads: 0, events: 2, modelTokens, maxModelCallsInStep, maxActionStepsInStep,
    });
    expect(module.e2eApplicationAggregateRunUsage([usage(1, 1, 1), usage(2, 1, 3)])).toEqual({
      discoveredResults: 2, maxAgentContextBytes: 8, maxLedgerBytes: 4, maxObservationBytes: 16, artifactBytes: 0,
      downloads: 0, events: 4, modelTokens: 3, maxModelCallsInStep: 1, maxActionStepsInStep: 3,
    });
    expect(module.e2eApplicationAggregateRunUsage([{ ...usage(0, 0, 0), estimatedCostUsd: 0.125 },
      { ...usage(0, 0, 0), estimatedCostUsd: 0.375 }])?.estimatedCostUsd).toBe(0.5);
    expect(module.e2eApplicationAggregateRunUsage([usage(1, 1, 1), { ...usage(2, 1, 3), futureCounter: 1 }])).toBeNull();
  });

  it("matches repeated same-kind SDK operations to distinct causal events without relying on array order", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    const groups = [
      [{ operationKind: "request" as const, outcome: "completed" as const, startedAt: "2026-10-17T12:00:00.100Z", finishedAt: "2026-10-17T12:00:00.200Z" }],
      [{ operationKind: "request" as const, outcome: "completed" as const, startedAt: "2026-10-17T12:00:00.300Z", finishedAt: "2026-10-17T12:00:00.400Z" }],
    ];
    const events = [
      { kind: "engine" as const, name: "request", startedAt: "2026-10-17T12:00:00.290Z", durationMs: 120, status: "passed" as const, bytes: 0 },
      { kind: "engine" as const, name: "request", startedAt: "2026-10-17T12:00:00.090Z", durationMs: 120, status: "passed" as const, bytes: 0 },
    ];
    expect(module.e2eApplicationAgentActionEventGroupsMatch(groups, events)).toBe(true);
    expect(module.e2eApplicationAgentActionEventGroupsMatch(groups, [events[0]!])).toBe(false);
  });

  it("retains governed-model receipt projections and their original source refs in the raw closure", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    const frame = (artifactId: string, value: unknown) => {
      const body = Buffer.from(canonicalJson(value));
      return { ref: { artifactId, sha256: createHash("sha256").update(body).digest("hex"), byteLength: body.byteLength, mediaType: "application/json" }, bytes: body };
    };
    const context = { bindingDigest: sha, compiledInventoryDigest: "b".repeat(64), preparedEnvironmentDigest: "c".repeat(64),
      candidateDigest: "d".repeat(64), roundId: uuidB, runId: capture.runId, groupId: "group-a", lifecycleId: capture.lifecycleId,
      observedAt: at, producer };
    const source = frame("model-source-receipt", { schemaVersion: "offline-original-model-source/v1", note: "conformance bytes only" });
    const row = { caseId: capture.caseId, declaredStepIndex: 0, requestId: "model-request-a", receiptId: "model-receipt-a" };
    const projection = frame("model-projection", { schemaVersion: "e2e-application-governed-model-receipt/v1", ...row,
      bindingDigest: sha, routeId: "fixture-route", routeRevision: "fixture-route-r1", requestDigest: "1".repeat(64),
      generationDigest: "2".repeat(64), authoritySnapshotDigest: "3".repeat(64), sourceReceiptRef: source.ref, recordedAt: at });
    const modelCapture = { ...capture, modelReceipts: [{ ...row, receiptRef: projection.ref }] };
    const captureFrame = frame("model-case-capture", modelCapture);
    const cleanup = frame("model-cleanup", { schemaVersion: "e2e-application-owned-cleanup/v1", context, phase: "after-owned-close",
      cleanup: "confirmed", confirmed: true, serverListening: false, ownedResourceInventoryDigest: "f".repeat(64), ownedCleanupReceiptRefs: [] });
    const sourceReceipt = frame("model-supervisor-source", { schemaVersion: "offline-supervisor-source/v1" });
    const supervisorReceipt = frame("model-supervisor-receipt", { schemaVersion: "e2e-application-supervisor-receipt/v1", context,
      launches: [{ shardId: "shard-a", launchId: uuidA, upstreamRunId: uuidA }],
      caseCaptures: [{ caseId: capture.caseId, shardId: "shard-a", ref: captureFrame.ref }], mockConsumptions: [], cleanupRef: cleanup.ref,
      additionalSupervisorReceiptRefs: [sourceReceipt.ref] });
    const readback = { schemaVersion: "e2e-application-supervisor-readback/v1" as const, receipt: supervisorReceipt,
      evidence: [captureFrame, cleanup, source, projection, sourceReceipt].sort((left, right) => left.ref.artifactId.localeCompare(right.ref.artifactId)) };
    const validated = module.readE2EApplicationSupervisorProof({ readback, expected: { bindingDigest: context.bindingDigest,
      compiledInventoryDigest: context.compiledInventoryDigest, preparedEnvironmentDigest: context.preparedEnvironmentDigest,
      candidateDigest: context.candidateDigest, roundId: context.roundId, runId: context.runId, groupId: context.groupId,
      mockManifestDigest: "e".repeat(64), caseCount: 1, expectedSupervisorReceiptRefs: [sourceReceipt.ref], ownedResourceInventoryDigest: "f".repeat(64),
      launches: [{ shardId: "shard-a", launchId: uuidA, upstreamRunId: uuidA }] }, applicationCaptures: [modelCapture], supervisorReceiptRefs: [supervisorReceipt.ref, sourceReceipt.ref],
      cleanupConfirmed: true, cleanupServerListening: false });
    expect(validated.captures[0]?.modelReceipts).toEqual([{ ...row, receiptRef: projection.ref }]);
    const missingSourceReadback = { ...readback, evidence: readback.evidence.filter((item) => item.ref.artifactId !== source.ref.artifactId) };
    expect(() => module.readE2EApplicationSupervisorProof({ readback: missingSourceReadback, expected: { bindingDigest: context.bindingDigest,
      compiledInventoryDigest: context.compiledInventoryDigest, preparedEnvironmentDigest: context.preparedEnvironmentDigest,
      candidateDigest: context.candidateDigest, roundId: context.roundId, runId: context.runId, groupId: context.groupId,
      mockManifestDigest: "e".repeat(64), caseCount: 1, expectedSupervisorReceiptRefs: [sourceReceipt.ref], ownedResourceInventoryDigest: "f".repeat(64),
      launches: [{ shardId: "shard-a", launchId: uuidA, upstreamRunId: uuidA }] }, applicationCaptures: [modelCapture],
      supervisorReceiptRefs: [supervisorReceipt.ref, sourceReceipt.ref], cleanupConfirmed: true, cleanupServerListening: false })).toThrow(/missing or conflicting raw evidence/u);
  });

  it("binds raw supervisor receipts, captures, mock request and response bytes, and post-close cleanup", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    const context = { bindingDigest: sha, compiledInventoryDigest: "b".repeat(64), preparedEnvironmentDigest: "c".repeat(64),
      candidateDigest: "d".repeat(64), roundId: uuidB, runId: capture.runId, groupId: "group-a", lifecycleId: capture.lifecycleId,
      observedAt: at, producer };
    const captureWithMockCoverage = { ...capture, coverage: { ...capture.coverage, mockedComponentIds: ["mock-a"], observedMockedComponentIds: ["mock-a"] } };
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
    const expectedMockClaim = { ...mockClaim, requestRef: request.ref, responseRef: response.ref };
    const evidence = [rawCapture, mock, cleanup, request, response, sourceReceipt].sort((a, b) => a.ref.artifactId.localeCompare(b.ref.artifactId));
    const proof = { schemaVersion: "e2e-application-supervisor-readback/v1" as const, receipt, evidence };
    const validated = module.readE2EApplicationSupervisorProof({ readback: proof, expected: { bindingDigest: sha,
      compiledInventoryDigest: context.compiledInventoryDigest, preparedEnvironmentDigest: context.preparedEnvironmentDigest,
      candidateDigest: context.candidateDigest, roundId: uuidB, runId: capture.runId, groupId: "group-a", mockManifestDigest: "e".repeat(64),
      caseCount: 1, expectedSupervisorReceiptRefs: [sourceReceipt.ref], ownedResourceInventoryDigest: "f".repeat(64),
      launches: [{ shardId: "shard-a", launchId: uuidA, upstreamRunId: uuidA }] }, applicationCaptures: [captureWithMockCoverage],
      supervisorReceiptRefs: [receipt.ref, sourceReceipt.ref], cleanupConfirmed: true, cleanupServerListening: false });
    expect(validated.captures).toHaveLength(1);
    expect(validated.mockConsumptions).toEqual([expectedMockClaim]);
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
      const expected = { transportId, transportCorrelationId: correlation, bindingDigest, compiledInventoryDigest, caseCount: 1,
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
      responseSha256: sha, observedAt: at,
      requestRef: { artifactId: "request-a", sha256: sha, byteLength: 0, mediaType: "application/json" },
      responseRef: { artifactId: "response-a", sha256: sha, byteLength: 0, mediaType: "application/json" } };
    const valid = collection({ mockConsumptions: [consumption], declaredMockComponentIds: ["mock-a"] });
    expect(module.E2EApplicationCollectionSchema.safeParse(valid).success).toBe(true);
    expect(module.E2EApplicationCollectionSchema.safeParse({ ...valid, mockConsumptions: [consumption, consumption] }).success).toBe(false);
  });

  it("collects one source-derived API case with real report, process, capture, and post-close proof bindings", async () => {
    const { collectE2EApplicationRun } = await import("../../packages/verifier/src/application-collection.js");
    const { qualifyE2EApplicationCollection, E2EApplicationCaseCaptureSchema, E2EApplicationObservationBindingSchema } =
      await import("../../packages/verifier/src/application-result-adapter.js");
    const { expectedE2EApplicationReporterDigest } = await import("../../packages/verifier/src/application-runtime-assets.js");
    const fixture = createCompiledApiApplicationFixture({ now: new Date(Date.now() - 10_000).toISOString(), withApiMock: true });
    const { compiled, binding, round } = fixture;
    const shard = compiled.shards[0]!; const tuple = shard.selection.tuples[0]!; const expected = compiled.expectedCases[0]!;
    const launchId = uuidA; const upstreamRunId = "a0000000-0000-7000-8000-000000000011";
    const admissionAt = Date.parse(round.admittedAt);
    const timeAt = (offsetMs: number) => new Date(admissionAt + offsetMs).toISOString();
    const listStarted = timeAt(100); const listFinished = timeAt(200);
    const processStarted = timeAt(300); const startAt = timeAt(400);
    const reportStarted = timeAt(500); const reportFinished = timeAt(600);
    const processFinished = timeAt(700);
    const textBytes = (value: string) => Buffer.from(value);
    const hashBytes = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    const frame = (artifactId: string, value: unknown) => {
      const body = Buffer.from(canonicalJson(value));
      return { ref: { artifactId, sha256: hashBytes(body), byteLength: body.byteLength, mediaType: "application/json" }, bytes: body };
    };
    const app = compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs[0]!;
    const mockSpec = compiled.group.mocks[0]!;
    const applicationBinding = compiled.applicationBindings.get(app.applicationId)!;
    const runtime = compiled.runtimeBindings.get(app.runtimeProfileId)!;
    const context = { bindingDigest: hashBytes(Buffer.from(canonicalJson(binding))), compiledInventoryDigest: compiled.inventory.digest,
      preparedEnvironmentDigest: compiled.preparedEnvironmentDigest, candidateDigest: binding.candidateDigest, roundId: binding.roundId,
      runId: binding.runId, groupId: binding.groupId, lifecycleId: "owned-api-lifecycle", observedAt: processFinished,
      producer: { producerId: "synthetic-api-supervisor", receiptId: "supervisor-receipt", lifecycleId: "owned-api-lifecycle",
        operationId: binding.operationId, operationFence: binding.operationFence, runtimeManifestDigest: runtime.manifestDigest,
        transportCorrelationId: "33333333-3333-4333-8333-333333333333" } };
    const responseBody = frame("http-response-body", { healthy: true });
    const observationValue = { schemaVersion: "e2e-application-assertion-observation/v1", kind: "http-status" as const,
      caseId: expected.caseId, assertionIndex: 0, assertionDigest: expected.assertionDigests[0], observationId: "http-response-1",
      lifecycleId: context.lifecycleId, observedAt: reportStarted, producer: context.producer,
      subject: { kind: "service", processId: "owned-api-process", origin: compiled.originByApplicationId[0]!.origin },
      accountContextId: expected.accountContextId, accountContextDigest: expected.accountContextDigest,
      sessionRef: "api-session-1", accountIdDigest: sha, requestId: "health", responseId: "response-1",
      method: "GET", path: "/health", origin: compiled.originByApplicationId[0]!.origin, status: 200, bodyRef: responseBody.ref, connectionRef: null };
    const evidence = frame("http-observation", observationValue);
    const captureValue = E2EApplicationCaseCaptureSchema.parse({ schemaVersion: "e2e-application-case-capture/v1", caseId: expected.caseId, upstreamRunId, shardId: shard.shardId,
      roundId: binding.roundId, runId: binding.runId, groupId: binding.groupId, candidateDigest: binding.candidateDigest,
      applicationId: app.applicationId, buildManifestDigest: applicationBinding.build.manifestDigest, runtimeManifestDigest: runtime.manifestDigest,
      executionDescriptorDigest: expected.executionDescriptorDigest, accountContextId: expected.accountContextId,
      accountContextDigest: expected.accountContextDigest, observedAt: reportStarted, lifecycleId: context.lifecycleId,
        subject: { kind: "service", processId: "owned-api-process", origin: compiled.originByApplicationId[0]!.origin }, producer: context.producer,
      steps: [{ index: 0, declaredStepIndex: 0, kind: "request", actionDigest: hashBytes(Buffer.from(canonicalJson(compiled.bundle.scenarios[0]!.steps[0]))),
        observationId: "http-response-1", at: reportStarted, outcome: "completed", evidenceRefs: [evidence.ref], agentOperationRefs: [] }],
      assertions: [{ index: 0, digest: expected.assertionDigests[0], observedAt: reportStarted, observationId: "http-response-1", value: 200,
        evidenceRef: evidence.ref, outcome: "passed", reason: "observed HTTP 200 from owned API service", producer: context.producer }],
      terminal: { kind: "completed" as const, lastDeclaredStepIndex: 0, failedAssertionIndex: null, at: reportFinished, reason: "complete" }, modelReceipts: [],
      artifacts: [], coverage: { observedScope: "runtime", subject: "candidate", executedCandidateParts: [app.applicationId], realComponentIds: [],
        mockedComponentIds: [mockSpec.componentId], observedMockedComponentIds: [mockSpec.componentId], unexercisedBehaviors: [] }, cleanup: "confirmed" });
    const captureFrame = frame("case-capture", captureValue);
    const cleanupFrame = frame("owned-cleanup", { schemaVersion: "e2e-application-owned-cleanup/v1", context, phase: "after-owned-close",
      cleanup: "confirmed", confirmed: true, serverListening: false, ownedResourceInventoryDigest: sha, ownedCleanupReceiptRefs: [] });
    const sourceReceipt = frame("source-ingress-receipt", { schemaVersion: "test-source-ingress/v1", source: "offline-conformance" });
    const identitySourceReceipt = frame("identity-source-receipt", { schemaVersion: "conformance-account-source/v1", source: "offline fixture only" });
    const subjectIdentitySourceReceipt = frame("subject-identity-source-receipt", { schemaVersion: "conformance-subject-source/v1", source: "offline fixture only" });
    const identityReceipt = frame("identity-receipt", { schemaVersion: "e2e-application-account-identity/v1", caseId: expected.caseId,
      bindingDigest: hashBytes(Buffer.from(canonicalJson(binding))), upstreamRunId, lifecycleId: context.lifecycleId,
      producer: context.producer, observedAt: processStarted, sourceReceiptRef: identitySourceReceipt.ref, accountRef: compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs[0],
      sessionRef: "api-session-1", accountIdDigest: sha });
    const subjectIdentityReceipt = frame("subject-identity-receipt", { schemaVersion: "e2e-application-subject-identity/v1", caseId: expected.caseId,
      bindingDigest: hashBytes(Buffer.from(canonicalJson(binding))), upstreamRunId, lifecycleId: context.lifecycleId,
      producer: context.producer, observedAt: processStarted, sourceReceiptRef: subjectIdentitySourceReceipt.ref, subject: captureValue.subject });
    const mockRequest = frame("mock-request", { requestId: "health", componentId: mockSpec.componentId, caseId: expected.caseId,
      method: "GET", path: "/health", input: { kind: "success" } });
    const mockResponse = frame("mock-response", { responseId: "mock-response-1", requestId: "health", status: 200, body: { healthy: true } });
    const mockConsumption = frame("mock-consumption", { schemaVersion: "e2e-application-mock-consumption/v1", context,
      caseId: expected.caseId, shardId: shard.shardId, upstreamRunId, rows: [{ caseId: expected.caseId, componentId: mockSpec.componentId,
        runId: binding.runId, mockManifestDigest: binding.mockManifestDigest, lifecycleId: context.lifecycleId, producer: context.producer,
        requestId: "health", responseId: "mock-response-1", requestSha256: mockRequest.ref.sha256, responseSha256: mockResponse.ref.sha256,
        observedAt: reportStarted, requestRef: mockRequest.ref, responseRef: mockResponse.ref }] });
    const expectedSupervisorRefs = [identityReceipt.ref, identitySourceReceipt.ref, subjectIdentityReceipt.ref, subjectIdentitySourceReceipt.ref, sourceReceipt.ref]
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    const launches = [{ shardId: shard.shardId, launchId, upstreamRunId }];
    const receiptValue = { schemaVersion: "e2e-application-supervisor-receipt/v1", context, launches,
      caseCaptures: [{ caseId: expected.caseId, shardId: shard.shardId, ref: captureFrame.ref }],
      cleanupRef: cleanupFrame.ref, additionalSupervisorReceiptRefs: expectedSupervisorRefs,
      mockConsumptions: [{ caseId: expected.caseId, shardId: shard.shardId, ref: mockConsumption.ref }] };
    const receipt = frame("supervisor-top-receipt", receiptValue);
    const readback = { schemaVersion: "e2e-application-supervisor-readback/v1" as const, receipt,
      evidence: [captureFrame, cleanupFrame, sourceReceipt, evidence, responseBody, identityReceipt, identitySourceReceipt, subjectIdentityReceipt,
        subjectIdentitySourceReceipt, mockConsumption, mockRequest, mockResponse]
        .sort((left, right) => left.ref.artifactId.localeCompare(right.ref.artifactId)) };
    const publicList = { pairs: [{ id: tuple.upstreamResultId, file: ".agentx/e2e/generated-application.test.ts", title: tuple.title,
      titlePath: [tuple.title], kind: "test", sessions: [], target: tuple.targetName, agent: "default", disposition: "run", tags: [], source: tuple.source }],
      targets: [tuple.targetId], unmatched: [] };
    const listBytes = textBytes(JSON.stringify({ pairs: publicList.pairs })); const stderrBytes = Buffer.alloc(0);
    const runStart = { schemaVersion: "e2e-run-start-capture/v1", challenge: launchId, runId: upstreamRunId, seq: 1, at: startAt };
    const runStartBytes = textBytes(`${JSON.stringify(runStart)}\n`);
    const report: E2EApplicationReport = { schemaVersion: "report-1", run: { id: upstreamRunId, specVersion: "0.1", runner: { name: "e2e", version: "0.20.0" },
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
      applicationCaptures: [captureValue], supervisorReceiptRefs: [receipt.ref, ...expectedSupervisorRefs]
        .sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
      declaredMockComponentIds: [mockSpec.componentId], selected: 1, filtered: 0,
      supervisorReadback: readback, cleanupConfirmed: true, cleanupServerListening: false, evidenceDirectory: "/offline-fixture" };
    const accountRef = compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs[0]!;
    const selectedArtifact = applicationBinding.artifacts[0]!;
    const observationBinding = E2EApplicationObservationBindingSchema.parse({ caseId: expected.caseId, subject: captureValue.subject, caseProducer: context.producer,
      assertionProducers: [{ assertionIndex: 0, producer: context.producer }], accountRef, sessionRef: "api-session-1", accountIdDigest: sha,
      identityReceiptRef: identityReceipt.ref, subjectIdentityReceiptRef: subjectIdentityReceipt.ref,
      selectedArtifact, connection: null });
    const result = collectE2EApplicationRun({ actual, compiled, binding, round,
      environment: { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" },
      usage: report.run.usage as Record<string, number>, limits: report.run.limits, expectedSupervisorReceiptRefs: expectedSupervisorRefs, ownedResourceInventoryDigest: sha,
      observationBindings: [observationBinding], assertionAssets: [], governedModelReceipts: null, ownedClosedAt: processFinished });
    expect(result.unavailableReason).toBeNull();
    expect(result.qualification).toMatchObject({ status: "PASS", runId: binding.runId, result: { qualification: "exploratory", status: "passed" } });
    expect(result.collection?.applicationCaptures).toHaveLength(1);
    expect(result.collection?.supervisorReadback.receipt.ref).toEqual(receipt.ref);
    expect(result.collection?.supervisorReadback.evidence.map((item) => item.ref.artifactId)).toContain(evidence.ref.artifactId);
    expect(qualifyE2EApplicationCollection(result.oracle!, result.collection!).status).toBe("PASS");

    const mockRowsChanged = structuredClone(result.collection!);
    mockRowsChanged.mockConsumptions[0]!.producer.transportCorrelationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    expect(qualifyE2EApplicationCollection(result.oracle!, mockRowsChanged).status).toBe("UNKNOWN");
    const protectedOnlyReceipt = frame("supervisor-top-receipt-with-protected-identities", { ...receiptValue,
      additionalSupervisorReceiptRefs: [sourceReceipt.ref] });
    const protectedOnlyExpectedRefs = [sourceReceipt.ref];
    const projectionOnlyCollection = structuredClone(result.collection!);
    projectionOnlyCollection.supervisorReadback.receipt = { ref: protectedOnlyReceipt.ref,
      bytesBase64: protectedOnlyReceipt.bytes.toString("base64") };
    projectionOnlyCollection.supervisorReceiptRefs = [protectedOnlyReceipt.ref, ...protectedOnlyExpectedRefs]
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    const projectionOnlyOracle = { ...result.oracle!, expectedSupervisorReceiptRefs: protectedOnlyExpectedRefs };
    const projectionOnlyResult = qualifyE2EApplicationCollection(projectionOnlyOracle, projectionOnlyCollection);
    expect(projectionOnlyResult.status, projectionOnlyResult.reason).toBe("PASS");
    const missingIdentitySources = structuredClone(projectionOnlyCollection);
    missingIdentitySources.supervisorReadback.evidence = missingIdentitySources.supervisorReadback.evidence
      .filter((item) => item.ref.artifactId !== identitySourceReceipt.ref.artifactId && item.ref.artifactId !== subjectIdentitySourceReceipt.ref.artifactId);
    expect(qualifyE2EApplicationCollection(projectionOnlyOracle, missingIdentitySources).status).toBe("UNKNOWN");

    const recollect = (options: { capture?: typeof captureValue; reportValue?: typeof report; processStatus?: number; timeShiftMs?: number;
      observation?: typeof evidence; mockInputValue?: unknown; mockResponseBody?: unknown; mockRequestId?: string;
      mockResponseStatus?: number;
      usage?: Readonly<Record<string, number>> } = {}) => {
      const shift = options.timeShiftMs ?? 0;
      const shifted = (value: string) => new Date(Date.parse(value) + shift).toISOString();
      const candidateCapture = structuredClone(options.capture ?? captureValue);
      const candidateReport = structuredClone(options.reportValue ?? report);
      if (shift !== 0) {
        candidateCapture.observedAt = shifted(candidateCapture.observedAt);
        candidateCapture.steps = candidateCapture.steps.map((step) => ({ ...step, at: shifted(step.at) }));
        candidateCapture.assertions = candidateCapture.assertions.map((assertion) => ({ ...assertion, observedAt: shifted(assertion.observedAt) }));
        candidateReport.run.startedAt = shifted(candidateReport.run.startedAt);
        if (typeof candidateReport.run.finishedAt !== "string") throw new Error("fixture report is missing its finish time");
        candidateReport.run.finishedAt = shifted(candidateReport.run.finishedAt);
        candidateReport.run.results[0]!.attempts[0]!.startedAt = shifted(candidateReport.run.results[0]!.attempts[0]!.startedAt);
        candidateReport.run.results[0]!.attempts[0]!.steps[0]!.startedAt = shifted(candidateReport.run.results[0]!.attempts[0]!.steps[0]!.startedAt);
      }
      const captureProof = frame("case-capture", candidateCapture);
      const mockRequestId = options.mockRequestId ?? "health";
      const candidateMockRequest = frame("mock-request", { requestId: mockRequestId, componentId: mockSpec.componentId, caseId: expected.caseId,
        method: "GET", path: "/health", input: { kind: options.mockInputValue ?? "success" } });
      const candidateMockResponse = frame("mock-response", { responseId: "mock-response-1", requestId: mockRequestId, status: options.mockResponseStatus ?? 200,
        body: options.mockResponseBody ?? { healthy: true } });
      const candidateMockConsumption = frame("mock-consumption", { schemaVersion: "e2e-application-mock-consumption/v1", context,
        caseId: expected.caseId, shardId: shard.shardId, upstreamRunId, rows: [{ caseId: expected.caseId, componentId: mockSpec.componentId,
          runId: binding.runId, mockManifestDigest: binding.mockManifestDigest, lifecycleId: context.lifecycleId, producer: context.producer,
          requestId: mockRequestId, responseId: "mock-response-1", requestSha256: candidateMockRequest.ref.sha256, responseSha256: candidateMockResponse.ref.sha256,
          observedAt: reportStarted, requestRef: candidateMockRequest.ref, responseRef: candidateMockResponse.ref }] });
      const receiptProof = frame("supervisor-top-receipt", { ...receiptValue,
        caseCaptures: [{ caseId: expected.caseId, shardId: shard.shardId, ref: captureProof.ref }],
        mockConsumptions: [{ caseId: expected.caseId, shardId: shard.shardId, ref: candidateMockConsumption.ref }] });
      const variantReadback = { ...readback, receipt: receiptProof,
        evidence: [captureProof, cleanupFrame, sourceReceipt, options.observation ?? evidence, responseBody, identityReceipt, identitySourceReceipt,
          subjectIdentityReceipt, subjectIdentitySourceReceipt, candidateMockConsumption, candidateMockRequest, candidateMockResponse]
          .sort((left, right) => left.ref.artifactId.localeCompare(right.ref.artifactId)) };
      const reportBytes = textBytes(JSON.stringify(candidateReport));
      const variantActual = { ...actual, applicationCaptures: [candidateCapture], supervisorReadback: variantReadback,
        supervisorReceiptRefs: [receiptProof.ref, ...expectedSupervisorRefs]
          .sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
        shards: [{ ...actual.shards[0]!, rawReportBytes: reportBytes,
          runStartCapture: { ...runStart, at: shifted(runStart.at) },
          runStartCaptureBytes: textBytes(`${JSON.stringify({ ...runStart, at: shifted(runStart.at) })}\n`),
          listProcess: processRecord(0, shifted(listStarted), shifted(listFinished), listBytes),
          runProcess: processRecord(options.processStatus ?? 0, shifted(processStarted), shifted(processFinished), reportBytes) }] };
      return collectE2EApplicationRun({ actual: variantActual, compiled, binding, round,
        environment: { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" },
        usage: (options.usage ?? report.run.usage) as Record<string, number>, limits: report.run.limits, expectedSupervisorReceiptRefs: expectedSupervisorRefs, ownedResourceInventoryDigest: sha,
        observationBindings: [observationBinding], assertionAssets: [], governedModelReceipts: null, ownedClosedAt: processFinished });
    };

    {
      const wrongBytes = frame("http-observation", { ...observationValue, status: 500 });
      const copiedSuccess = structuredClone(captureValue);
      copiedSuccess.steps[0]!.evidenceRefs = [wrongBytes.ref];
      copiedSuccess.assertions[0]!.evidenceRef = wrongBytes.ref;
      const resultWithContradictoryBytes = recollect({ capture: copiedSuccess, observation: wrongBytes });
      expect(resultWithContradictoryBytes.qualification?.status).toBe("UNKNOWN");
      expect(recollect({ mockResponseBody: { healthy: false } }).qualification?.status).toBe("UNKNOWN");
      expect(recollect({ mockInputValue: "refusal" }).qualification?.status).toBe("UNKNOWN");
      expect(recollect({ mockInputValue: "refusal", mockResponseStatus: 403,
        mockResponseBody: { error: "refused" } }).qualification?.status).toBe("UNKNOWN");
      expect(recollect({ mockRequestId: "foreign-request" }).qualification?.status).toBe("UNKNOWN");
      const foreignOrigin = frame("foreign-http-observation", { ...observationValue, origin: "https://foreign.test" });
      const foreignOriginCapture = structuredClone(captureValue);
      foreignOriginCapture.steps[0]!.evidenceRefs = [foreignOrigin.ref];
      foreignOriginCapture.assertions[0]!.evidenceRef = foreignOrigin.ref;
      expect(recollect({ capture: foreignOriginCapture, observation: foreignOrigin }).qualification?.status).toBe("UNKNOWN");

      const observedFailure = structuredClone(captureValue);
      observedFailure.assertions[0]!.value = 500;
      observedFailure.assertions[0]!.outcome = "failed";
      observedFailure.assertions[0]!.reason = "observed HTTP status differs from the approved assertion";
      observedFailure.steps[0]!.evidenceRefs = [wrongBytes.ref];
      observedFailure.assertions[0]!.evidenceRef = wrongBytes.ref;
      observedFailure.terminal = { kind: "assertion-failed", lastDeclaredStepIndex: 0, failedAssertionIndex: 0,
        at: reportFinished, reason: "approved assertion observed a failure" };
      observedFailure.coverage.unexercisedBehaviors = [expected.assertionDigests[0]!];
      const failedReport = structuredClone(report);
      failedReport.run.status = "failed";
      failedReport.run.exitCode = 1;
      failedReport.run.summary.passed = 0;
      failedReport.run.summary.failed = 1;
      failedReport.run.results[0]!.status = "failed";
      failedReport.run.results[0]!.attempts[0]!.status = "failed";
      failedReport.run.results[0]!.attempts[0]!.error = { category: "test", code: "ASSERTION_FAILED",
        message: "expected status 200 but observed 500", retryable: false, phase: "body" };
      failedReport.run.results[0]!.attempts[0]!.steps[0]!.status = "failed";
      const observedFailureResult = recollect({ capture: observedFailure, reportValue: failedReport, processStatus: 1,
        observation: wrongBytes });
      expect(observedFailureResult.unavailableReason).toBeNull();
      expect(observedFailureResult.qualification?.status).toBe("FAILED");
      expect(recollect({ capture: observedFailure, reportValue: failedReport, processStatus: 1,
        observation: wrongBytes, mockResponseBody: { healthy: false } }).qualification?.status).toBe("UNKNOWN");
      expect(recollect({ capture: observedFailure, reportValue: failedReport, processStatus: 1,
        observation: wrongBytes, mockRequestId: "foreign-request" }).qualification?.status).toBe("UNKNOWN");
      const unauthorizedFailure = structuredClone(observedFailure);
      unauthorizedFailure.steps[0]!.actionDigest = "d".repeat(64);
      expect(recollect({ capture: unauthorizedFailure, reportValue: failedReport, processStatus: 1,
        observation: wrongBytes }).qualification?.status).toBe("UNKNOWN");
    }

    {
      const foreignRunner = structuredClone(report);
      foreignRunner.run.runner = { name: "foreign-runner", version: "99.0.0" };
      const foreignProject = structuredClone(report);
      foreignProject.run.project.id = "foreign-project";
      const foreignEnvironment = structuredClone(report);
      foreignEnvironment.run.environment = { ci: false, trustNoticeShown: true, os: "windows 99", arch: "arm64", runtime: "node v99" };
      const foreignSource = structuredClone(report);
      foreignSource.run.results[0]!.file = "alien.test.ts";
      foreignSource.run.results[0]!.source = { file: "alien.test.ts", line: 999, column: 42 };
      foreignSource.run.results[0]!.declarationIndex = 99;
      foreignSource.run.results[0]!.titlePath = ["alien case"];
      foreignSource.run.results[0]!.selected = false;
      for (const invalidReport of [foreignRunner, foreignProject, foreignEnvironment, foreignSource]) {
        expect(recollect({ reportValue: invalidReport }).qualification?.status).toBe("UNKNOWN");
      }
      const invalidTime = structuredClone(report);
      invalidTime.run.startedAt = "not-a-time";
      invalidTime.run.finishedAt = "not-a-time";
      expect(recollect({ reportValue: invalidTime }).qualification?.status).toBe("UNKNOWN");
      expect(recollect({ timeShiftMs: -1_000 }).qualification?.status).toBe("UNKNOWN");
      const nullRouteUsage = structuredClone(report);
      nullRouteUsage.run.usage.modelTokens = 9_999;
      nullRouteUsage.run.usage.maxModelCallsInStep = 8;
      expect(recollect({ reportValue: nullRouteUsage }).qualification?.status).toBe("UNKNOWN");
      expect(recollect({ reportValue: nullRouteUsage, usage: nullRouteUsage.run.usage as Record<string, number> }).qualification?.status).toBe("UNKNOWN");
      const infrastructureError = structuredClone(report);
      infrastructureError.run.status = "error";
      infrastructureError.run.exitCode = 1;
      infrastructureError.run.errors = [{ category: "infrastructure", code: "BROKEN", message: "runner failed", retryable: false, phase: "launch" }];
      infrastructureError.run.summary.passed = 0;
      infrastructureError.run.summary.failed = 0;
      infrastructureError.run.summary.interrupted = 1;
      infrastructureError.run.summary.executed = 0;
      infrastructureError.run.results[0]!.attempts[0]!.cleanup = "failed";
      expect(recollect({ reportValue: infrastructureError, processStatus: 1 }).qualification?.status).toBe("UNKNOWN");
    }

    {
      const repeated = structuredClone(captureValue);
      repeated.steps = Array.from({ length: round.limits.maxActionsPerCase + 1 }, (_, index) => ({ ...captureValue.steps[0]!, index }));
      expect(recollect({ capture: repeated }).qualification?.status).toBe("UNKNOWN");

      const foreignAssertionProducer = structuredClone(captureValue);
      foreignAssertionProducer.assertions[0]!.producer = { ...context.producer, operationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", operationFence: 999 };
      expect(recollect({ capture: foreignAssertionProducer }).qualification?.status).toBe("UNKNOWN");

      const foreignService = structuredClone(captureValue);
      foreignService.subject = captureValue.subject.kind === "mobile"
        ? { ...captureValue.subject, leaseId: "unrelated-lease" }
        : { ...captureValue.subject, processId: "unrelated-process" };
      expect(recollect({ capture: foreignService }).qualification?.status).toBe("UNKNOWN");

      const falseExternal = structuredClone(captureValue);
      falseExternal.coverage = { ...captureValue.coverage, observedScope: "external-live", realComponentIds: ["unobserved-component"] };
      expect(recollect({ capture: falseExternal }).qualification?.status).toBe("UNKNOWN");

      const contradictoryFailure = structuredClone(captureValue);
      contradictoryFailure.subject = captureValue.subject.kind === "mobile"
        ? { ...captureValue.subject, leaseId: "foreign-failed-lease" }
        : { ...captureValue.subject, processId: "foreign-failed-service" };
      contradictoryFailure.assertions[0]!.outcome = "failed";
      contradictoryFailure.assertions[0]!.reason = "claimed response mismatch";
      const failedReport = structuredClone(report);
      failedReport.run.status = "failed";
      failedReport.run.exitCode = 1;
      failedReport.run.summary.passed = 0;
      failedReport.run.summary.failed = 1;
      failedReport.run.results[0]!.status = "failed";
      failedReport.run.results[0]!.attempts[0]!.status = "failed";
      failedReport.run.results[0]!.attempts[0]!.steps[0]!.status = "failed";
      expect(recollect({ capture: contradictoryFailure, reportValue: failedReport, processStatus: 1 }).qualification?.status).toBe("UNKNOWN");
    }

    const foreignOriginReport = JSON.parse(JSON.stringify(report)) as { run: { targets: Array<Record<string, unknown>> } };
    foreignOriginReport.run.targets[0]!.baseOrigin = "https://foreign.test";
    const foreignOriginBytes = textBytes(JSON.stringify(foreignOriginReport));
    const originalShard = actual.shards[0]!;
    const foreignOriginActual = { ...actual, shards: [{ ...originalShard, rawReportBytes: foreignOriginBytes,
      runProcess: processRecord(0, processStarted, processFinished, foreignOriginBytes) }] };
    const foreignOriginResult = collectE2EApplicationRun({ actual: foreignOriginActual, compiled, binding, round,
      environment: { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" },
      usage: report.run.usage as Record<string, number>, limits: report.run.limits, expectedSupervisorReceiptRefs: expectedSupervisorRefs, ownedResourceInventoryDigest: sha,
      observationBindings: [observationBinding], assertionAssets: [], governedModelReceipts: null, ownedClosedAt: processFinished });
    expect(foreignOriginResult.qualification?.status).toBe("UNKNOWN");
    expect(foreignOriginResult.unavailableReason).toMatch(/origin differs/u);
  });

  it("keeps a real failed prefix FAILED when a future agent was never run", async () => {
    const { collectE2EApplicationRun } = await import("../../packages/verifier/src/application-collection.js");
    const { E2EApplicationCaseCaptureSchema, E2EApplicationObservationBindingSchema } =
      await import("../../packages/verifier/src/application-result-adapter.js");
    const { expectedE2EApplicationReporterDigest } = await import("../../packages/verifier/src/application-runtime-assets.js");
    const fixture = createCompiledApiApplicationFixture({ now: new Date(Date.now() - 10_000).toISOString(),
      modelRoute: { routeId: "future-agent-route", routeRevision: "future-agent-r1" }, agentAfterRequest: true });
    const { compiled, binding, round } = fixture;
    const shard = compiled.shards[0]!; const tuple = shard.selection.tuples[0]!; const expected = compiled.expectedCases[0]!;
    const app = compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs[0]!;
    const applicationBinding = compiled.applicationBindings.get(app.applicationId)!;
    const runtime = compiled.runtimeBindings.get(app.runtimeProfileId)!;
    const upstreamRunId = "a0000000-0000-7000-8000-000000000021"; const launchId = uuidA;
    const start = Date.parse(round.admittedAt); const timeAt = (ms: number) => new Date(start + ms).toISOString();
    const processStarted = timeAt(100); const listStarted = timeAt(50); const listFinished = timeAt(80);
    const startAt = timeAt(150); const reportStarted = timeAt(200); const reportFinished = timeAt(300); const processFinished = timeAt(350);
    const hashBytes = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    const frame = (artifactId: string, value: unknown) => {
      const body = Buffer.from(canonicalJson(value));
      return { ref: { artifactId, sha256: hashBytes(body), byteLength: body.byteLength, mediaType: "application/json" }, bytes: body };
    };
    const context = { bindingDigest: hashBytes(Buffer.from(canonicalJson(binding))), compiledInventoryDigest: compiled.inventory.digest,
      preparedEnvironmentDigest: compiled.preparedEnvironmentDigest, candidateDigest: binding.candidateDigest, roundId: binding.roundId,
      runId: binding.runId, groupId: binding.groupId, lifecycleId: "future-agent-lifecycle", observedAt: processFinished,
      producer: { producerId: "synthetic-api-supervisor", receiptId: "future-agent-supervisor-receipt", lifecycleId: "future-agent-lifecycle",
        operationId: binding.operationId, operationFence: binding.operationFence, runtimeManifestDigest: runtime.manifestDigest,
        transportCorrelationId: "33333333-3333-4333-8333-333333333334" } };
    const responseBody = frame("future-agent-response-body", { error: "failed" });
    const subject = { kind: "service" as const, processId: "future-agent-owned-service", origin: compiled.originByApplicationId[0]!.origin };
    const observation = frame("future-agent-http-observation", { schemaVersion: "e2e-application-assertion-observation/v1", kind: "http-status",
      caseId: expected.caseId, assertionIndex: 0, assertionDigest: expected.assertionDigests[0], observationId: "future-agent-http-1",
      lifecycleId: context.lifecycleId, observedAt: reportStarted, producer: context.producer, subject,
      accountContextId: expected.accountContextId, accountContextDigest: expected.accountContextDigest,
      sessionRef: "future-agent-session", accountIdDigest: sha, requestId: "health", responseId: "future-agent-response",
      method: "GET", path: "/health", origin: subject.origin, status: 500, bodyRef: responseBody.ref, connectionRef: null });
    const scenario = compiled.bundle.scenarios.find((item) => item.scenarioId === expected.scenarioId)!;
    const captureValue = E2EApplicationCaseCaptureSchema.parse({ schemaVersion: "e2e-application-case-capture/v1", caseId: expected.caseId,
      upstreamRunId, shardId: shard.shardId, roundId: binding.roundId, runId: binding.runId, groupId: binding.groupId,
      candidateDigest: binding.candidateDigest, applicationId: app.applicationId, buildManifestDigest: applicationBinding.build.manifestDigest,
      runtimeManifestDigest: runtime.manifestDigest, executionDescriptorDigest: expected.executionDescriptorDigest,
      accountContextId: expected.accountContextId, accountContextDigest: expected.accountContextDigest, observedAt: reportStarted,
      lifecycleId: context.lifecycleId, subject, producer: context.producer,
      steps: [{ index: 0, declaredStepIndex: 0, kind: "request", actionDigest: hashBytes(Buffer.from(canonicalJson(scenario.steps[0]))),
        observationId: "future-agent-http-1", at: reportStarted, outcome: "completed", evidenceRefs: [observation.ref], agentOperationRefs: [] }],
      assertions: [{ index: 0, digest: expected.assertionDigests[0], observedAt: reportStarted, observationId: "future-agent-http-1", value: 500,
        evidenceRef: observation.ref, outcome: "failed", reason: "the approved HTTP status assertion observed 500", producer: context.producer }],
      terminal: { kind: "assertion-failed", lastDeclaredStepIndex: 0, failedAssertionIndex: 0, at: reportFinished, reason: "assertion failed" },
      modelReceipts: [], artifacts: [], coverage: { observedScope: "runtime", subject: "candidate", executedCandidateParts: [app.applicationId],
        realComponentIds: [], mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [expected.assertionDigests[0]] }, cleanup: "confirmed" });
    const captureFrame = frame("future-agent-case-capture", captureValue);
    const cleanup = frame("future-agent-owned-cleanup", { schemaVersion: "e2e-application-owned-cleanup/v1", context, phase: "after-owned-close",
      cleanup: "confirmed", confirmed: true, serverListening: false, ownedResourceInventoryDigest: sha, ownedCleanupReceiptRefs: [] });
    const identitySource = frame("future-agent-identity-source", { schemaVersion: "fixture-source/v1" });
    const subjectSource = frame("future-agent-subject-source", { schemaVersion: "fixture-subject-source/v1" });
    const identity = frame("future-agent-identity", { schemaVersion: "e2e-application-account-identity/v1", caseId: expected.caseId,
      bindingDigest: context.bindingDigest, upstreamRunId, lifecycleId: context.lifecycleId, producer: context.producer, observedAt: processStarted,
      sourceReceiptRef: identitySource.ref, accountRef: compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs[0],
      sessionRef: "future-agent-session", accountIdDigest: sha });
    const subjectIdentity = frame("future-agent-subject-identity", { schemaVersion: "e2e-application-subject-identity/v1", caseId: expected.caseId,
      bindingDigest: context.bindingDigest, upstreamRunId, lifecycleId: context.lifecycleId, producer: context.producer, observedAt: processStarted,
      sourceReceiptRef: subjectSource.ref, subject });
    const source = frame("future-agent-source-ingress", { schemaVersion: "fixture-source-ingress/v1" });
    const expectedSupervisorRefs = [identity.ref, identitySource.ref, subjectIdentity.ref, subjectSource.ref, source.ref]
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    const receipt = frame("future-agent-supervisor-receipt", { schemaVersion: "e2e-application-supervisor-receipt/v1", context,
      launches: [{ shardId: shard.shardId, launchId, upstreamRunId }], caseCaptures: [{ caseId: expected.caseId, shardId: shard.shardId, ref: captureFrame.ref }],
      cleanupRef: cleanup.ref, additionalSupervisorReceiptRefs: expectedSupervisorRefs, mockConsumptions: [] });
    const readback = { schemaVersion: "e2e-application-supervisor-readback/v1" as const, receipt,
      evidence: [responseBody, observation, captureFrame, cleanup, identitySource, identity, subjectSource, subjectIdentity, source]
        .sort((left, right) => left.ref.artifactId.localeCompare(right.ref.artifactId)) };
    const publicList = { pairs: [{ id: tuple.upstreamResultId, file: tuple.source.file, title: tuple.title, titlePath: [tuple.title], kind: "test",
      sessions: [], target: tuple.targetName, agent: "default", disposition: "run", tags: [], source: tuple.source }], targets: [tuple.targetId], unmatched: [] };
    const listBytes = Buffer.from(JSON.stringify({ pairs: publicList.pairs })); const empty = Buffer.alloc(0);
    const runStart = { schemaVersion: "e2e-run-start-capture/v1", challenge: launchId, runId: upstreamRunId, seq: 1, at: startAt };
    const failedReport: E2EApplicationReport = { schemaVersion: "report-1", run: { id: upstreamRunId, specVersion: "0.1", runner: { name: "e2e", version: "0.20.0" },
      status: "failed", exitCode: 1, startedAt: reportStarted, finishedAt: reportFinished, project: { id: "rovara-application-e2e", configDigest: shard.expectedConfigDigest },
      environment: { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" },
      targets: [{ id: tuple.targetId, index: 0, platform: "api", environment: "test", engine: { name: "none", version: "unversioned", spiVersion: 1 },
        capabilities: [], artifactCapabilities: [], stateCapability: false }], serialGroups: [],
      results: [{ id: tuple.upstreamResultId, testId: tuple.upstreamTestId, kind: "test", declarationIndex: 0, titlePath: [tuple.title],
        file: tuple.source.file, source: tuple.source, targetId: tuple.targetId, platform: "api", agent: "default", repeat: 0, tags: [], selected: true,
        status: "failed", attempts: [{ id: upstreamRunId, index: 0, status: "failed", startedAt: reportStarted, durationMs: 10, artifacts: [], appLog: [],
          secondaryErrors: [], cleanup: "complete", error: { category: "test", code: "ASSERTION_FAILED", message: "expected 200, got 500", retryable: false, phase: "body" },
          steps: [{ id: "assertion-step", index: 0, kind: "assertion", api: "assert.http-status", label: "health status", source: tuple.source,
            status: "failed", startedAt: reportStarted, durationMs: 1, events: [], artifacts: [] }] }] }], errors: [],
      summary: { discovered: 1, selected: 1, executed: 1, passed: 0, failed: 1, interrupted: 0, flaky: 0, skipped: 0 },
      limits: { maxAgentContextBytes: 1024, maxLedgerBytes: 1024, maxObservationBytes: 1024, maxEventsPerStep: 1000, maxModelTokensPerCall: 1024 },
      usage: { discoveredResults: 1, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0,
        modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 } } };
    const reportBytes = Buffer.from(JSON.stringify(failedReport));
    const proc = (status: number, began: string, ended: string, stdout: Uint8Array) => ({ status, signal: null, startedAt: began, finishedAt: ended,
      timedOut: false, aborted: false, stdoutSha256: hashBytes(stdout), stderrSha256: hashBytes(empty), stdoutBytes: stdout.byteLength, stderrBytes: 0 });
    const actual = { protocol: "e2e-actual-application-run/v1" as const,
      runnerToolchain: { execPath: process.execPath, version: process.version as "v22.23.2", platform: process.platform as "darwin" | "linux" | "win32", arch: process.arch as "arm64" | "x64" },
      shards: [{ shardId: shard.shardId, launchId, launchConfigDigest: shard.expectedConfigDigest,
        fixedAssetDigests: { compilerInventory: shard.inventory.digest, reporter: expectedE2EApplicationReporterDigest(launchId) }, publicList,
        listStdoutBytes: listBytes, listStderrBytes: empty, rawReportBytes: reportBytes, runStderrBytes: empty,
        runStartCaptureBytes: Buffer.from(`${JSON.stringify(runStart)}\n`), runStartCapture: runStart,
        listProcess: proc(0, listStarted, listFinished, listBytes), runProcess: proc(1, processStarted, processFinished, reportBytes) }],
      applicationCaptures: [captureValue], supervisorReceiptRefs: [receipt.ref, ...expectedSupervisorRefs].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
      declaredMockComponentIds: [], selected: 1, filtered: 0, supervisorReadback: readback, cleanupConfirmed: true, cleanupServerListening: false,
      evidenceDirectory: "/offline-future-agent-fixture" };
    const observationBinding = E2EApplicationObservationBindingSchema.parse({ caseId: expected.caseId, subject, caseProducer: context.producer,
      assertionProducers: [{ assertionIndex: 0, producer: context.producer }], accountRef: compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs[0],
      sessionRef: "future-agent-session", accountIdDigest: sha, identityReceiptRef: identity.ref, subjectIdentityReceiptRef: subjectIdentity.ref,
      selectedArtifact: applicationBinding.artifacts[0], connection: null });
    // The group has an agent step, so its worker hands over its model evidence; the agent step was never reached, so there are no receipts and no ledger (Task 4.4a).
    const noModelUse = { schemaVersion: "rovara-agent-model-evidence/v1" as const, route: null, valueKey: "ab".repeat(32), receipts: [],
      channel: { droppedRequests: 0, unscopedRequests: 0, overrun: false, evidenceErrors: 0 }, ledgers: [], transcriptDigests: [] };
    const options = { actual, compiled, binding, round, environment: failedReport.run.environment, usage: failedReport.run.usage, limits: failedReport.run.limits,
      expectedSupervisorReceiptRefs: expectedSupervisorRefs, ownedResourceInventoryDigest: sha, observationBindings: [observationBinding],
      assertionAssets: [], governedModelReceipts: [] as const, agentModel: noModelUse, ownedClosedAt: processFinished };
    const result = collectE2EApplicationRun(options as never);
    expect(result.qualification?.status).toBe("FAILED");
    expect(result.unavailableReason).toBeNull();
    // Without the worker's model evidence the same run is UNKNOWN, with the code for it: a group with an agent step always carries some.
    const withoutEvidence = collectE2EApplicationRun({ ...options, agentModel: undefined } as never);
    expect(withoutEvidence.qualification?.status).toBe("UNKNOWN");
    expect(withoutEvidence.unavailableReason).toMatch(/^model-receipts-mismatch:/u);

    const futureSdkUse = structuredClone(failedReport);
    futureSdkUse.run.results[0]!.attempts[0]!.steps.push({ id: "unexecuted-agent", index: 1, kind: "agent", api: "agent.run", label: "future agent",
      source: tuple.source, status: "passed", startedAt: reportStarted, durationMs: 1, events: [], artifacts: [],
      metrics: { modelCalls: 1, actionSteps: 0, observationBytes: 0, contextBytes: 0, ledgerBytes: 0 },
      model: { provider: "fixture", model: "fixture-model", endpoint: "fixture", adapterVersion: "v1", policyVersion: "p1", calls: 1,
        tokenAccounting: "provider", peakTokensPerCall: 1, inputTokens: 1, outputTokens: 0 } });
    futureSdkUse.run.usage.modelTokens = 1;
    futureSdkUse.run.usage.maxModelCallsInStep = 1;
    const alteredBytes = Buffer.from(JSON.stringify(futureSdkUse));
    const alteredActual = { ...actual, shards: [{ ...actual.shards[0]!, rawReportBytes: alteredBytes,
      runProcess: proc(1, processStarted, processFinished, alteredBytes) }] };
    const futureUseResult = collectE2EApplicationRun({ ...options, actual: alteredActual } as never);
    expect(futureUseResult.qualification?.status).toBe("UNKNOWN");
    expect(futureUseResult.unavailableReason).toMatch(/model counters differ/u);
  });

  it("qualifies heterogeneous model use across raw admitted shards and rejects whole-group overspend", async () => {
    const { collectE2EApplicationRun } = await import("../../packages/verifier/src/application-collection.js");
    const { E2EApplicationCaseCaptureSchema, E2EApplicationObservationBindingSchema } =
      await import("../../packages/verifier/src/application-result-adapter.js");
    const { expectedE2EApplicationReporterDigest } = await import("../../packages/verifier/src/application-runtime-assets.js");
    const scriptedRoute = scriptedE2ERouteDefinition();
    const routeRevision = e2eModelRouteRevision(scriptedRoute);
    const fixture = createCompiledTwoShardApiApplicationFixture({ modelRoute: { routeId: scriptedRoute.routeId, routeRevision } });
    const { compiled, binding, round } = fixture;
    const hashBytes = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    const frame = (artifactId: string, value: unknown) => {
      const body = Buffer.from(canonicalJson(value));
      return { ref: { artifactId, sha256: hashBytes(body), byteLength: body.byteLength, mediaType: "application/json" }, bytes: body };
    };
    const timeAt = (offset: number) => new Date(Date.parse(round.admittedAt) + offset).toISOString();
    const reportEnvironment = { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" };
    const reportLimits = { maxAgentContextBytes: 1024, maxLedgerBytes: 1024, maxObservationBytes: 1024, maxEventsPerStep: 1000, maxModelTokensPerCall: 1024 };
    const aggregateUsage = { discoveredResults: 2, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0,
      artifactBytes: 0, downloads: 0, events: 0, modelTokens: 1, maxModelCallsInStep: 1, maxActionStepsInStep: 0 };
    // What the worker hands over about the group's agent steps (Task 4.4a): `callsByShard[i]` ok receipts for shard i's case, and the ledger of each case's concluded step.
    const valueKey = "ab".repeat(32);
    const agentEvidence = (callsByShard: readonly [number, number]) => {
      const receipts: Array<Record<string, unknown>> = []; const ledgers: Array<Record<string, unknown>> = [];
      compiled.shards.forEach((shard, index) => {
        const expected = compiled.expectedCases.find((item) => item.targetId === shard.targetId)!;
        const step = compiled.bundle.scenarios.find((item) => item.scenarioId === expected.scenarioId)!.steps[0] as { kind: "agent"; goal: string };
        const own = Array.from({ length: callsByShard[index]! }, (_, call) => ({ receiptId: `two-shard-receipt-${index + 1}-${call}`, runId: binding.runId, caseId: expected.caseId,
          stepIndex: 0, callIndex: call, routeId: scriptedRoute.routeId, routeRevision, provider: scriptedRoute.provider, modelId: scriptedRoute.modelId, startedAt: timeAt(250 + index * 100 + call),
          inputTokens: 1, outputTokens: 0, latencyMs: 1, servedModelId: null, servedUpstream: null, promptSha256: hashBytes(Buffer.from(`prompt-${index}-${call}`)),
          responseSha256: hashBytes(Buffer.from(`response-${index}-${call}`)), outcome: "ok" }));
        receipts.push(...own);
        const ledger = { schemaVersion: "rovara-agent-actions/v1", runId: binding.runId, caseId: expected.caseId, valueKeyId: e2eAgentValueKeyId(valueKey),
          steps: [{ stepIndex: 0, goalDigest: hashBytes(Buffer.from(step.goal)), verdict: "concluded", actions: [], stopCode: null, receiptIds: own.map((item) => item.receiptId) }] };
        const bytes = Buffer.from(JSON.stringify(ledger));
        ledgers.push({ caseDirectory: agentCaseDirectoryName(expected.caseId), bytesBase64: bytes.toString("base64"), sha256: hashBytes(bytes) });
      });
      return { schemaVersion: "rovara-agent-model-evidence/v1" as const, route: scriptedRoute, valueKey, receipts, channel: { droppedRequests: 0, unscopedRequests: 0, overrun: false, evidenceErrors: 0 },
        ledgers, transcriptDigests: receipts.map((item) => ({ receiptId: item.receiptId, promptSha256: item.promptSha256, responseSha256: item.responseSha256, omitted: null })) };
    };

    const buildActual = (callsByShard: readonly [number, number]) => {
      const shardRows: Array<Record<string, unknown>> = [];
      const captures: Array<Record<string, unknown>> = [];
      const evidence: Array<{ ref: { artifactId: string; sha256: string; byteLength: number; mediaType: string }; bytes: Buffer }> = [];
      const expectedRefs: Array<{ artifactId: string; sha256: string; byteLength: number; mediaType: string }> = [];
      const bindings: Array<Record<string, unknown>> = [];
      const launches: Array<{ shardId: string; launchId: string; upstreamRunId: string }> = [];
      const captureEntries: Array<{ caseId: string; shardId: string; ref: ReturnType<typeof frame>["ref"] }> = [];
      const groupLifecycleId = "two-shard-group-lifecycle";

      for (let index = 0; index < 2; index++) {
        const shard = compiled.shards[index]!; const tuple = shard.selection.tuples[0]!; const expected = compiled.expectedCases.find((item) => item.targetId === shard.targetId)!;
        const runtimeRef = compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs.find((item) => item.targetId === shard.targetId)!;
        const app = compiled.applicationBindings.get(runtimeRef.applicationId)!; const runtime = compiled.runtimeBindings.get(runtimeRef.runtimeProfileId)!;
        const scenario = compiled.bundle.scenarios.find((item) => item.scenarioId === expected.scenarioId)!;
        const launchId = index === 0 ? uuidA : "55555555-5555-4555-8555-555555555555";
        const upstreamRunId = index === 0 ? "a0000000-0000-7000-8000-000000000041" : "a0000000-0000-7000-8000-000000000042";
        const processStarted = timeAt(100 + index * 100); const listStarted = timeAt(50 + index * 100); const listFinished = timeAt(80 + index * 100);
        const runStarted = timeAt(150 + index * 100); const reportStarted = timeAt(200 + index * 100);
        const reportFinished = timeAt(300 + index * 100); const processFinished = timeAt(350 + index * 100);
        const lifecycleId = groupLifecycleId;
        const producer = { producerId: "synthetic-two-shard-supervisor", receiptId: `two-shard-receipt-${index + 1}`, lifecycleId,
          operationId: binding.operationId, operationFence: binding.operationFence, runtimeManifestDigest: runtime.manifestDigest,
          transportCorrelationId: index === 0 ? "33333333-3333-4333-8333-333333333341" : "33333333-3333-4333-8333-333333333342" };
        const context = { bindingDigest: hashBytes(Buffer.from(canonicalJson(binding))), compiledInventoryDigest: compiled.inventory.digest,
          preparedEnvironmentDigest: compiled.preparedEnvironmentDigest, candidateDigest: binding.candidateDigest, roundId: binding.roundId,
          runId: binding.runId, groupId: binding.groupId, lifecycleId, observedAt: processFinished, producer };
        const subject = { kind: "service" as const, processId: `two-shard-service-${index + 1}`,
          origin: compiled.originByApplicationId.find((item) => item.applicationId === runtimeRef.applicationId)!.origin };
        const responseBody = frame(`two-shard-response-body-${index + 1}`, { healthy: true });
        const observation = frame(`two-shard-observation-${index + 1}`, { schemaVersion: "e2e-application-assertion-observation/v1", kind: "http-status",
          caseId: expected.caseId, assertionIndex: 0, assertionDigest: expected.assertionDigests[0], observationId: `two-shard-http-${index + 1}`,
          lifecycleId, observedAt: reportStarted, producer, subject, accountContextId: expected.accountContextId,
          accountContextDigest: expected.accountContextDigest, sessionRef: `two-shard-session-${index + 1}`, accountIdDigest: sha,
          requestId: `health-${index + 1}`, responseId: `two-shard-response-${index + 1}`, method: "GET", path: "/health", origin: subject.origin,
          status: 200, bodyRef: responseBody.ref, connectionRef: null });

        const captureValue = E2EApplicationCaseCaptureSchema.parse({ schemaVersion: "e2e-application-case-capture/v1", caseId: expected.caseId,
          upstreamRunId, shardId: shard.shardId, roundId: binding.roundId, runId: binding.runId, groupId: binding.groupId,
          candidateDigest: binding.candidateDigest, applicationId: runtimeRef.applicationId, buildManifestDigest: app.build.manifestDigest,
          runtimeManifestDigest: runtime.manifestDigest, executionDescriptorDigest: expected.executionDescriptorDigest,
          accountContextId: expected.accountContextId, accountContextDigest: expected.accountContextDigest, observedAt: reportStarted,
          lifecycleId, subject, producer,
          steps: scenario.steps.map((step, stepIndex) => ({ index: stepIndex, declaredStepIndex: stepIndex, kind: step.kind,
            actionDigest: hashBytes(Buffer.from(canonicalJson(step))), observationId: `two-shard-step-${index + 1}-${stepIndex}`,
            at: reportStarted, outcome: "completed", evidenceRefs: [], agentOperationRefs: [] })),
          assertions: [{ index: 0, digest: expected.assertionDigests[0], observedAt: reportStarted, observationId: `two-shard-http-${index + 1}`,
            value: 200, evidenceRef: observation.ref, outcome: "passed", reason: "observed HTTP 200", producer }],
          terminal: { kind: "completed", lastDeclaredStepIndex: scenario.steps.length - 1, failedAssertionIndex: null, at: reportFinished, reason: "complete" },
          modelReceipts: [], artifacts: [], coverage: { observedScope: "runtime", subject: "candidate",
            executedCandidateParts: [runtimeRef.applicationId], realComponentIds: [], mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [] },
          cleanup: "confirmed" });
        const captureFrame = frame(`two-shard-capture-${index + 1}`, captureValue);
        captureEntries.push({ caseId: expected.caseId, shardId: shard.shardId, ref: captureFrame.ref });
        const identitySource = frame(`two-shard-identity-source-${index + 1}`, { schemaVersion: "offline-account-source/v1" });
        const subjectSource = frame(`two-shard-subject-source-${index + 1}`, { schemaVersion: "offline-subject-source/v1" });
        const identity = frame(`two-shard-identity-${index + 1}`, { schemaVersion: "e2e-application-account-identity/v1", caseId: expected.caseId,
          bindingDigest: context.bindingDigest, upstreamRunId, lifecycleId, producer, observedAt: processStarted, sourceReceiptRef: identitySource.ref,
          accountRef: compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs.find((item) => item.applicationId === runtimeRef.applicationId),
          sessionRef: `two-shard-session-${index + 1}`, accountIdDigest: sha });
        const subjectIdentity = frame(`two-shard-subject-identity-${index + 1}`, { schemaVersion: "e2e-application-subject-identity/v1", caseId: expected.caseId,
          bindingDigest: context.bindingDigest, upstreamRunId, lifecycleId, producer, observedAt: processStarted,
          sourceReceiptRef: subjectSource.ref, subject });
        const source = frame(`two-shard-source-ingress-${index + 1}`, { schemaVersion: "offline-source-ingress/v1", shard: index + 1 });
        const additionalRefs = [identity.ref, identitySource.ref, subjectIdentity.ref, subjectSource.ref, source.ref]
          .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
        expectedRefs.push(...additionalRefs);
        captures.push(captureValue); launches.push({ shardId: shard.shardId, launchId, upstreamRunId });
        evidence.push(responseBody, observation, captureFrame, identitySource, subjectSource, identity, subjectIdentity, source);
        const publicList = { pairs: [{ id: tuple.upstreamResultId, file: tuple.source.file, title: tuple.title, titlePath: [tuple.title], kind: "test",
          sessions: [], target: tuple.targetName, agent: "default", disposition: "run", tags: [], source: tuple.source }], targets: [tuple.targetId], unmatched: [] };
        const listBytes = Buffer.from(JSON.stringify({ pairs: publicList.pairs })); const empty = Buffer.alloc(0);
        const runStart = { schemaVersion: "e2e-run-start-capture/v1", challenge: launchId, runId: upstreamRunId, seq: 1, at: runStarted };
        const modelCalls = callsByShard[index]!;
        const usage = { discoveredResults: 1, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0,
          downloads: 0, events: 0, modelTokens: modelCalls, maxModelCallsInStep: modelCalls, maxActionStepsInStep: 0 };
        const agentReportStep = { id: `agent-step-${index + 1}`, index: 0, kind: "agent" as const, api: "agent.run", label: "approved agent",
          source: tuple.source, status: "passed" as const, startedAt: reportStarted, durationMs: 1, events: [], artifacts: [],
          metrics: { modelCalls, actionSteps: 0, observationBytes: 0, contextBytes: 0, ledgerBytes: 0 },
          ...(modelCalls > 0 ? { model: { provider: "fixture", model: "fixture-model", endpoint: "fixture", adapterVersion: "v1", policyVersion: "p1",
            calls: modelCalls, tokenAccounting: "provider" as const, peakTokensPerCall: 1, inputTokens: modelCalls, outputTokens: 0 } } : {}) };
        const report: E2EApplicationReport = { schemaVersion: "report-1", run: { id: upstreamRunId, specVersion: "0.1", runner: { name: "e2e", version: "0.20.0" },
          status: "passed", exitCode: 0, startedAt: reportStarted, finishedAt: reportFinished,
          project: { id: "rovara-application-e2e", configDigest: shard.expectedConfigDigest }, environment: reportEnvironment,
          targets: [{ id: tuple.targetId, index: 0, platform: "api", environment: "test", engine: { name: "none", version: "unversioned", spiVersion: 1 },
            capabilities: [], artifactCapabilities: [], stateCapability: false }], serialGroups: [],
          results: [{ id: tuple.upstreamResultId, testId: tuple.upstreamTestId, kind: "test", declarationIndex: 0, titlePath: [tuple.title],
            file: tuple.source.file, source: tuple.source, targetId: tuple.targetId, platform: "api", agent: "default", repeat: 0, tags: [], selected: true,
            status: "passed", attempts: [{ id: upstreamRunId, index: 0, status: "passed", startedAt: reportStarted, durationMs: 10,
              artifacts: [], appLog: [], secondaryErrors: [], cleanup: "complete", steps: [agentReportStep,
                { id: `assertion-step-${index + 1}`, index: 1, kind: "assertion", api: "assert.http-status", label: "health status", source: tuple.source,
                  status: "passed", startedAt: reportStarted, durationMs: 1, events: [], artifacts: [] }] }] }], errors: [],
          summary: { discovered: 1, selected: 1, executed: 1, passed: 1, failed: 0, interrupted: 0, flaky: 0, skipped: 0 }, limits: reportLimits, usage } };
        const reportBytes = Buffer.from(JSON.stringify(report));
        const proc = (began: string, ended: string, stdout: Uint8Array) => ({ status: 0, signal: null, startedAt: began, finishedAt: ended,
          timedOut: false, aborted: false, stdoutSha256: hashBytes(stdout), stderrSha256: hashBytes(empty), stdoutBytes: stdout.byteLength, stderrBytes: 0 });
        const runStartBytes = Buffer.from(`${JSON.stringify(runStart)}\n`);
        shardRows.push({ shardId: shard.shardId, launchId, launchConfigDigest: shard.expectedConfigDigest,
          fixedAssetDigests: { compilerInventory: shard.inventory.digest, reporter: expectedE2EApplicationReporterDigest(launchId) }, publicList,
          listStdoutBytes: listBytes, listStderrBytes: empty, rawReportBytes: reportBytes, runStderrBytes: empty,
          runStartCaptureBytes: runStartBytes, runStartCapture: runStart, listProcess: proc(listStarted, listFinished, listBytes),
          runProcess: proc(processStarted, processFinished, reportBytes) });
        const accountRef = compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs.find((item) => item.applicationId === runtimeRef.applicationId)!;
        const observationBinding = E2EApplicationObservationBindingSchema.parse({ caseId: expected.caseId, subject, caseProducer: producer,
          assertionProducers: [{ assertionIndex: 0, producer }], accountRef, sessionRef: `two-shard-session-${index + 1}`, accountIdDigest: sha,
          identityReceiptRef: identity.ref, subjectIdentityReceiptRef: subjectIdentity.ref, selectedArtifact: app.artifacts[0], connection: null });
        bindings.push(observationBinding);
      }
      const groupContext = { bindingDigest: hashBytes(Buffer.from(canonicalJson(binding))), compiledInventoryDigest: compiled.inventory.digest,
        preparedEnvironmentDigest: compiled.preparedEnvironmentDigest, candidateDigest: binding.candidateDigest, roundId: binding.roundId,
        runId: binding.runId, groupId: binding.groupId, lifecycleId: groupLifecycleId, observedAt: timeAt(900),
        producer: { producerId: "synthetic-group-supervisor", receiptId: "two-shard-group-receipt", lifecycleId: groupLifecycleId,
          operationId: binding.operationId, operationFence: binding.operationFence,
          runtimeManifestDigest: compiled.runtimeBindings.values().next().value!.manifestDigest,
          transportCorrelationId: "33333333-3333-4333-8333-333333333343" } };
      const cleanup = frame("two-shard-group-cleanup", { schemaVersion: "e2e-application-owned-cleanup/v1", context: groupContext,
        phase: "after-owned-close", cleanup: "confirmed", confirmed: true, serverListening: false,
        ownedResourceInventoryDigest: sha, ownedCleanupReceiptRefs: [] });
      const receipt = frame("two-shard-group-supervisor", { schemaVersion: "e2e-application-supervisor-receipt/v1",
        context: groupContext, launches: [...launches].sort((left, right) => left.shardId.localeCompare(right.shardId)),
        caseCaptures: [...captureEntries].sort((left, right) => left.caseId.localeCompare(right.caseId)), mockConsumptions: [],
        cleanupRef: cleanup.ref, additionalSupervisorReceiptRefs: [...expectedRefs].sort((left, right) => left.artifactId.localeCompare(right.artifactId)) });
      evidence.push(cleanup);
      const supervisorReadback = { schemaVersion: "e2e-application-supervisor-readback/v1" as const, receipt,
        evidence: evidence.sort((left, right) => left.ref.artifactId.localeCompare(right.ref.artifactId)) };
      return { shardRows, captures, evidence, launches, expectedRefs: [...expectedRefs].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
        bindings, supervisorReadback, receipt };
    };

    // Complete the per-case supervisor inventory in a single parent receipt, retaining both original shard launches.
    // The builder is intentionally source-derived and labels all producer bytes as synthetic conformance.
    const positive = buildActual([1, 0]);
    expect(compiled.shards).toHaveLength(2);
    const actual = { protocol: "e2e-actual-application-run/v1" as const,
      runnerToolchain: { execPath: process.execPath, version: process.version as "v22.23.2", platform: process.platform as "darwin" | "linux" | "win32", arch: process.arch as "arm64" | "x64" },
      shards: positive.shardRows, applicationCaptures: positive.captures, supervisorReceiptRefs: [positive.receipt.ref, ...positive.expectedRefs]
        .sort((left, right) => left.artifactId.localeCompare(right.artifactId)), declaredMockComponentIds: [], selected: 2, filtered: 0,
      supervisorReadback: positive.supervisorReadback, cleanupConfirmed: true, cleanupServerListening: false,
      evidenceDirectory: "/offline-two-shard-fixture" };
    const options = { actual, compiled, binding, round, environment: reportEnvironment, usage: aggregateUsage,
      limits: reportLimits, expectedSupervisorReceiptRefs: positive.expectedRefs, ownedResourceInventoryDigest: sha,
      observationBindings: positive.bindings, assertionAssets: [], governedModelReceipts: [], agentModel: agentEvidence([1, 0]), ownedClosedAt: timeAt(900) };
    const qualified = collectE2EApplicationRun(options as never);
    expect(qualified.collection).not.toBeNull();
    expect(qualified.oracle?.usage).toEqual(aggregateUsage);
    // One shard made a call and the other none: the receipts are the report's, shard by shard, and the group passes.
    expect(qualified.qualification?.status, qualified.unavailableReason ?? "").toBe("PASS");
    expect(qualified.qualification?.result?.modelReceiptIds).toEqual(["two-shard-receipt-1-0"]);

    const overspent = buildActual([1, 1]);
    const overspentUsage = { ...aggregateUsage, modelTokens: 2, maxModelCallsInStep: 1 };
    const overspentActual = { ...actual, shards: overspent.shardRows, applicationCaptures: overspent.captures,
      supervisorReceiptRefs: [overspent.receipt.ref, ...overspent.expectedRefs].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
      supervisorReadback: overspent.supervisorReadback };
    const overspentResult = collectE2EApplicationRun({ ...options, actual: overspentActual, usage: overspentUsage,
      expectedSupervisorReceiptRefs: overspent.expectedRefs, observationBindings: overspent.bindings, agentModel: agentEvidence([1, 1]) } as never);
    expect(overspentResult.qualification?.status).toBe("UNKNOWN");
    expect(overspentResult.unavailableReason).toMatch(/^model-receipts-mismatch: group model SDK calls or token use differ .* exceed original round limits/u);
    // The receipts must also be the report's: one receipt too few for the calls the shards report is a mismatch, not an underspend.
    const missing = collectE2EApplicationRun({ ...options, agentModel: agentEvidence([0, 0]) } as never);
    expect(missing.qualification?.status).toBe("UNKNOWN");
    expect(missing.unavailableReason).toMatch(/^model-receipts-mismatch:/u);
  });
});
