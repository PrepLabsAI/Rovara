import { createHash } from "node:crypto";
import { canonicalJson, type E2ERound, type E2ERunBinding } from "@agentx/contracts";
import { createE2ECollectionOracleFromCompiledSuite, parseE2EReport, qualifyE2ECollection, type E2ECollection, type E2ECollectionOracle, type E2EStructuralQualification } from "./result-adapter.js";
import type { E2ECompiledSuite } from "./scenarios.js";
import type { E2EActualCliRun } from "./runtime-cli.js";
import type { E2ESelectionPacket } from "./selection.js";

export type E2EActualCollectionResult = Readonly<{
  collection: E2ECollection | null;
  oracle: E2ECollectionOracle | null;
  qualification: E2EStructuralQualification | null;
  unavailableReason: string | null;
}>;

/** Build the structural collector input only from actual CLI, reporter, candidate-process, and host-oracle evidence. */
export function collectE2EActualCliRun(input: Readonly<{
  actual: E2EActualCliRun;
  compiled: E2ECompiledSuite;
  binding: E2ERunBinding;
  round: E2ERound;
  selection: E2ESelectionPacket;
  sourceDigest: string;
  semanticApprovalDigests: ReadonlyMap<string, string>;
  hostRequestIds: ReadonlyMap<string, string>;
  declaredMockComponentIds: readonly string[];
  environment: E2ECollectionOracle["environment"];
  usage: E2ECollectionOracle["usage"];
  limits: E2ECollectionOracle["limits"];
}>): E2EActualCollectionResult {
  const unavailable = (reason: string): E2EActualCollectionResult => ({ collection: null, oracle: null, qualification: null, unavailableReason: reason });
  const captured = input.actual.runStartCapture;
  if (captured.status !== "valid") return unavailable(`independent run-start capture is ${captured.status}`);
  const parsed = parseE2EReport(input.actual.rawReportBytes);
  if (parsed.kind !== "parsed") return unavailable(parsed.reason);
  if (parsed.report.run.id !== captured.capture.runId) return unavailable("independent reporter UUID does not equal the parsed report run UUID");

  const oracle = createE2ECollectionOracleFromCompiledSuite({
    compiled: input.compiled,
    binding: input.binding,
    round: input.round,
    selection: input.selection,
    sourceDigest: input.sourceDigest,
    launchConfigDigest: input.actual.launchConfigDigest,
    semanticApprovalDigests: input.semanticApprovalDigests,
    hostRequestIds: input.hostRequestIds,
    declaredMockComponentIds: input.declaredMockComponentIds,
    fixedAssetDigests: input.actual.fixedAssetDigests,
    environment: input.environment,
    usage: input.usage,
    limits: input.limits,
  });
  const caseById = new Map(oracle.cases.map((item) => [item.caseId, item]));
  const expectedById = new Map(input.binding.expectedCases.map((item) => [item.caseId, item]));
  const observations: E2ECollection["observations"][number][] = [];
  const receipts: E2ECollection["receipts"][number][] = [];
  for (const capture of input.actual.candidateCaptures) {
    const caseId = typeof capture.caseId === "string" ? capture.caseId : "";
    const oracleCase = caseById.get(caseId);
    const expected = expectedById.get(caseId);
    const hostRequestId = input.hostRequestIds.get(caseId);
    const captureData = capture.capture as Record<string, unknown> | undefined;
    const execution = capture.receipt as Record<string, unknown> | undefined;
    if (!oracleCase || !expected || !hostRequestId || !captureData || !execution || typeof captureData.requestFrameBase64 !== "string" || typeof captureData.stdoutFrameBase64 !== "string" || typeof captureData.stderrFrameBase64 !== "string" || typeof capture.wireId !== "string" || typeof execution.recordRef !== "string" || execution.cleanup !== "confirmed") return unavailable("actual candidate observation is incomplete or not tied to its compiled case");
    const requestBytes = Buffer.from(captureData.requestFrameBase64, "base64");
    const responseBytes = Buffer.from(captureData.stdoutFrameBase64, "base64");
    const lastOutput = (captureData.times as Record<string, unknown> | undefined)?.lastOutput;
    const wallMs = lastOutput && typeof lastOutput === "object" ? (lastOutput as Record<string, unknown>).wallMs : undefined;
    if (typeof wallMs !== "number" || !Number.isFinite(wallMs)) return unavailable("actual candidate observation has no bounded host-clock output timestamp");
    const observedAt = new Date(wallMs).toISOString();
    const lifecycleId = execution.recordRef;
    const cleanup = "complete" as const;
    const coverage = { observedScope: "mock-contract" as const, subject: "candidate" as const, executedCandidateParts: ["registered-source-module-response"], realComponentIds: [], mockedComponentIds: [...input.declaredMockComponentIds].sort(), observedMockedComponentIds: [], unexercisedBehaviors: [] };
    observations.push({ caseId, requestId: hostRequestId, requestBytes: new Uint8Array(requestBytes), responseBytes: new Uint8Array(responseBytes), observedAt, lifecycleId, cleanup, coverage });
    const requestSha256 = createHash("sha256").update(requestBytes).digest("hex");
    const responseSha256 = createHash("sha256").update(responseBytes).digest("hex");
    const hostReceipts = input.actual.assertionReceipts.filter((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).caseId === caseId) as Array<Record<string, unknown>>;
    for (const row of hostReceipts) {
      if (typeof row.assertionIndex !== "number" || typeof row.assertionDigest !== "string" || row.responseSha256 !== responseSha256 || row.outcome !== "passed" && row.outcome !== "failed") return unavailable("host assertion receipt does not bind the exact captured response bytes");
      receipts.push({ runId: input.binding.runId, roundId: input.binding.roundId, groupId: input.binding.groupId, caseId, upstreamRunId: captured.capture.runId, candidateDigest: input.binding.candidateDigest, sourceDigest: input.sourceDigest, bundleDigest: input.binding.bundleDigest, compilerCaseIdentity: oracleCase.compilerCaseIdentity, registrationKey: oracleCase.registrationKey, semanticApprovalDigest: oracleCase.semanticApprovalDigest, executionDescriptorDigest: expected.executionDescriptorDigest, accountIdDigest: oracleCase.accountIdDigest, assertionIndex: row.assertionIndex, assertionDigest: row.assertionDigest, requestId: hostRequestId, requestSha256, responseSha256, observedAt, lifecycleId, cleanup, outcome: row.outcome });
    }
  }
  const process = input.actual.runProcess;
  const collection: E2ECollection = {
    rawReportBytes: new Uint8Array(input.actual.rawReportBytes),
    runStart: { runId: captured.capture.runId, sequence: captured.capture.seq, launchId: captured.capture.challenge, capturedAt: captured.capture.at },
    process: { exitCode: process.status, signal: process.signal, startedAt: process.startedAt, finishedAt: process.finishedAt, drained: process.stdoutBytes <= 4 * 1024 * 1024 && process.stderrBytes <= 4 * 1024 * 1024, aborted: process.aborted, timedOut: process.timedOut },
    configDigest: input.actual.launchConfigDigest,
    fixedAssetDigests: input.actual.fixedAssetDigests,
    publicList: input.actual.publicList,
    receivedAt: new Date().toISOString(),
    observations,
    receipts,
  };
  return { collection, oracle, qualification: qualifyE2ECollection(oracle, collection), unavailableReason: null };
}

export function e2eSnapshotSourceDigest(compiled: E2ECompiledSuite, sourceRows: readonly { path: string; sha256: string }[]): string {
  if (sourceRows.length === 0 || sourceRows.some((item) => !item.path || !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error("source digest requires a complete verified source inventory");
  return createHash("sha256").update(canonicalJson({ schemaVersion: "e2e-runtime-source-inventory/v1", sourceRows, compilerInventoryDigest: compiled.inventory.digest })).digest("hex");
}
